import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { renderDevelopmentMarkdown } from "../src/core/development-markdown";
import { runPersistedDevelopment } from "../src/core/development";
import { configurePromptPaths } from "../src/core/prompts";
import { DatabaseClient } from "../src/db/client";
import { DevelopmentRepository } from "../src/db/repositories/development";
import { CodexClient } from "../src/providers/codex";

const [databaseArgument, problemId, outputArgument] = process.argv.slice(2);
if (!databaseArgument || !problemId) {
  throw new Error("Usage: bun run phase2:gate -- <phase1-gate.sqlite> <problem-id> [output-directory]");
}
if (process.env.SCRAPLY_PHASE2_GATE_AUTHORIZED !== "1") {
  throw new Error("Live provider use is disabled. Set SCRAPLY_PHASE2_GATE_AUTHORIZED=1 after approving the selected problem.");
}

const databasePath = resolve(databaseArgument);
const outputDirectory = resolve(outputArgument ?? join(dirname(databasePath), `phase2-gate-${timestamp()}`));
const model = process.env.SCRAPLY_CODEX_MODEL ?? "gpt-5.6-luna";
const appData = process.env.APPDATA;
if (!appData) throw new Error("APPDATA is required to resolve Scraply's prompt cache");

await mkdir(outputDirectory, { recursive: true });
configurePromptPaths({
  bundledDir: resolve("prompts"),
  overrideDir: join(appData, "scraply", "scraply", "prompts"),
});

const database = new DatabaseClient(databasePath);
const repository = new DevelopmentRepository(database);
const runId = crypto.randomUUID();
try {
  createDevelopmentRun(database, runId, problemId, model);
  const result = await runPersistedDevelopment(problemId, {
    repository,
    researchRunId: runId,
    modelClient: new CodexClient(),
    model,
    onProgress: (message) => console.log(message),
  });
  await writeFile(join(outputDirectory, "idea-chain.md"), renderDevelopmentMarkdown(result), "utf8");
  await writeFile(join(outputDirectory, "metrics.json"), JSON.stringify({
    researchRunId: runId,
    model,
    problemId,
    modelCalls: result.modelCalls,
    solutionCount: result.solutions.length,
    outcomeCount: result.solutions.reduce((sum, solution) => sum + solution.outcomes.length, 0),
    riskCount: result.solutions.reduce((sum, solution) => sum + solution.risks.length, 0),
    mitigationCount: result.solutions.reduce((sum, solution) => sum + solution.mitigations.length, 0),
  }, null, 2), "utf8");
  finishRun(database, runId, "completed");
  console.log(`Phase 2 artifacts written to ${outputDirectory}`);
} catch (error) {
  finishRun(database, runId, "failed");
  throw error;
} finally {
  database.close();
}

function createDevelopmentRun(client: DatabaseClient, runId: string, selectedProblemId: string, selectedModel: string): void {
  const row = client.db.prepare(`
    SELECT rr.thread_id
    FROM problems p
    JOIN research_runs rr ON rr.id = p.discovery_run_id
    WHERE p.id = ?
  `).get(selectedProblemId) as { thread_id: string } | undefined;
  if (!row) throw new Error(`Problem not found: ${selectedProblemId}`);
  releaseInterruptedRuns(client, row.thread_id);
  const now = new Date().toISOString();
  client.db.prepare(`
    INSERT INTO research_runs (id, thread_id, status, config_json, problem_id, created_at, updated_at)
    VALUES (?, ?, 'running', ?, ?, ?, ?)
  `).run(runId, row.thread_id, JSON.stringify({ model: selectedModel }), selectedProblemId, now, now);
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
