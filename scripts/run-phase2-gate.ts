import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { renderDevelopmentMarkdown } from "../src/core/development-markdown";
import { runPersistedDevelopment } from "../src/core/development";
import { configurePromptPaths } from "../src/core/prompts";
import { DatabaseClient } from "../src/db/client";
import { DevelopmentRepository } from "../src/db/repositories/development";
import { CodexClient } from "../src/providers/codex";
import { DEFAULT_RUN_CONFIG, RunConfigSchema } from "../src/shared/schemas";
import {
  CountingModelClient,
  phase2ObjectiveChecks,
  renderPhase2Review,
  resetPromptCache,
} from "./gate-support";

const [databaseArgument, problemId, outputArgument] = process.argv.slice(2);
if (!databaseArgument || !problemId) {
  throw new Error("Usage: bun run phase2:gate -- <phase1-gate.sqlite> <problem-id> [output-directory]");
}
if (process.env.SCRAPLY_PHASE2_GATE_AUTHORIZED !== "1") {
  throw new Error(
    "Live provider use is disabled. This gate permanently deletes every prompt override in"
    + " %APPDATA%/scraply/scraply/prompts before it runs; set SCRAPLY_PHASE2_GATE_AUTHORIZED=1 after approving the selected problem.",
  );
}

const databasePath = resolve(databaseArgument);
const outputDirectory = resolve(outputArgument ?? join(dirname(databasePath), `phase2-gate-${timestamp()}`));
const model = process.env.SCRAPLY_CODEX_MODEL ?? DEFAULT_RUN_CONFIG.model;
const appData = process.env.APPDATA;
if (!appData) throw new Error("APPDATA is required to resolve Scraply's prompt cache");

await mkdir(outputDirectory, { recursive: true });
const promptCache = await resetPromptCache(appData);
configurePromptPaths({ bundledDir: resolve("prompts"), overrideDir: promptCache });
console.log(`Prompt cache cleared: ${promptCache}`);

const database = new DatabaseClient(databasePath);
const repository = new DevelopmentRepository(database);
const runId = crypto.randomUUID();
/** A tripped checkbox is a gate verdict, not a run failure; the run row must keep saying which one happened. */
let gateFailure: string | null = null;
try {
  createDevelopmentRun(database, runId, problemId, model);
  const modelClient = new CountingModelClient(new CodexClient());
  const result = await runPersistedDevelopment(problemId, {
    repository,
    researchRunId: runId,
    modelClient,
    model,
    onProgress: (message) => console.log(message),
  });
  const markdown = renderDevelopmentMarkdown(result);
  const checks = phase2ObjectiveChecks(result, markdown);
  if (modelClient.calls !== result.modelCalls) {
    throw new Error(`Call accounting mismatch: wrapper counted ${modelClient.calls}, result counted ${result.modelCalls}`);
  }
  await writeFile(join(outputDirectory, "idea-chain.md"), markdown, "utf8");
  await writeFile(join(outputDirectory, "gate-review.md"), renderPhase2Review(checks), "utf8");
  await writeFile(join(outputDirectory, "metrics.json"), JSON.stringify({
    researchRunId: runId,
    model,
    problemId,
    modelCalls: {
      actual: result.modelCalls,
      projectedBeforeRetries: checks.expectedModelCallsWithoutRetries,
      inferredSchemaRetries: checks.inferredSchemaRetries,
    },
    solutionCount: result.solutions.length,
    outcomeCount: result.solutions.reduce((sum, solution) => sum + solution.outcomes.length, 0),
    riskCount: result.solutions.reduce((sum, solution) => sum + solution.risks.length, 0),
    mitigationCount: result.solutions.reduce((sum, solution) => sum + solution.mitigations.length, 0),
    artifactWordCount: markdown.trim().split(/\s+/).length,
    objectiveChecks: checks,
  }, null, 2), "utf8");
  finishRun(database, runId, "completed");
  console.log(`Phase 2 artifacts written to ${outputDirectory}`);
  console.log(`Measured per-problem provider use: ${result.modelCalls} model calls`);
  console.log("PASS/FAIL still requires the human reviews listed in gate-review.md.");
  if (!checks.objectiveChecksPassed) {
    gateFailure = "Phase 2 automated evidence checks failed; inspect gate-review.md and idea-chain.md.";
  }
} catch (error) {
  finishRun(database, runId, "failed");
  throw error;
} finally {
  database.close();
}

if (gateFailure) throw new Error(gateFailure);

function createDevelopmentRun(client: DatabaseClient, runId: string, selectedProblemId: string, selectedModel: string): void {
  const row = client.db.prepare(`
    SELECT rr.thread_id, rr.config_json
    FROM problems p
    JOIN research_runs rr ON rr.id = p.discovery_run_id
    WHERE p.id = ?
  `).get(selectedProblemId) as { thread_id: string; config_json: string } | undefined;
  if (!row) throw new Error(`Problem not found: ${selectedProblemId}`);
  releaseInterruptedRuns(client, row.thread_id);
  const now = new Date().toISOString();
  const config = { ...RunConfigSchema.parse(JSON.parse(row.config_json)), model: selectedModel };
  client.db.prepare(`
    INSERT INTO research_runs (id, thread_id, status, config_json, problem_id, created_at, updated_at)
    VALUES (?, ?, 'running', ?, ?, ?, ?)
  `).run(
    runId,
    row.thread_id,
    JSON.stringify(config),
    selectedProblemId,
    now,
    now,
  );
}

/**
 * One active run per thread is a UNIQUE index, and phase 2 must attach to the problem's existing
 * thread. A gate killed mid-run leaves 'running' behind and would block every later run on that
 * thread, so the abandoned rows are closed out here rather than colliding on INSERT.
 */
function releaseInterruptedRuns(client: DatabaseClient, threadId: string): void {
  const stale = client.db.prepare(`
    SELECT id FROM research_runs WHERE thread_id = ? AND status IN ('queued', 'running')
  `).all(threadId) as { id: string }[];
  if (stale.length === 0) return;
  client.db.prepare(`
    UPDATE research_runs
    SET status = 'failed', updated_at = ?
    WHERE thread_id = ? AND status IN ('queued', 'running')
  `).run(new Date().toISOString(), threadId);
  console.log(`Marked ${stale.length} interrupted run(s) failed: ${stale.map((run) => run.id).join(", ")}`);
}

function finishRun(client: DatabaseClient, runId: string, status: "completed" | "failed"): void {
  client.db.prepare(`UPDATE research_runs SET status = ?, updated_at = ? WHERE id = ?`).run(
    status,
    new Date().toISOString(),
    runId,
  );
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
