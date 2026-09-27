import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { startBackend } from "../../src/backend/server";
import { DatabaseClient } from "../../src/db/client";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";

// Run with `bun test/performance/backend-export.bench.ts` from the checkout root.
const directory = join(process.cwd(), "build", "backend-export-bench");
mkdirSync(directory, { recursive: true });
const dbPath = join(directory, "scraply.db");
rmSync(dbPath, { force: true });

const db = new DatabaseClient(dbPath);
const stamp = "2026-01-01T00:00:00.000Z";
const config = JSON.stringify(DEFAULT_RUN_CONFIG);
const runCount = Number(process.env.SCRAPLY_BENCH_RUNS ?? 60);
const attemptMetadata = JSON.stringify({ attempts: [{
  attempt: "initial", model: DEFAULT_RUN_CONFIG.model,
  usage: { status: "known", value: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } },
  cost: { status: "not_reported" }, latencyMs: 100,
}] });
db.immediateTransaction(() => {
  db.db.prepare("INSERT INTO threads(id,title,status,created_at,updated_at) VALUES ('project','Export benchmark','solutions-ready',?,?)").run(stamp, stamp);
  const insertRun = db.db.prepare(`INSERT INTO research_runs(id,thread_id,problem_id,status,config_json,workflow_version,created_at,updated_at)
    VALUES (?, 'project', ?, 'completed', ?, 2, ?, ?)`);
  const insertProblem = db.db.prepare(`INSERT INTO problems(id,discovery_run_id,statement,why_it_persists,affected,scale_estimate,
    verdict,verdict_reason,verdict_source_ids_json,selected_at,created_at)
    VALUES (?, 'discovery', ?, '', '', '', 'confirmed', '', '[]', ?, ?)`);
  const insertSolution = db.db.prepare(`INSERT INTO solutions(id,problem_id,research_run_id,mechanism,description,
    respects_off_limits,respects_off_limits_why,created_at)
    VALUES (?, ?, ?, ?, 'Saved option', 1, 'Within scope', ?)`);
  const insertAttempt = db.db.prepare(`INSERT INTO generation_attempts(id,generation_id,research_run_id,stage_key,provider_id,
    model_id,reasoning_effort,status,request_json,wire_request_sha256,request_sha256,work_order_sha256,inputs_sha256,
    evidence_sha256,schema_sha256,attempt_metadata_json,created_at,updated_at,terminal_at)
    VALUES (?, ?, ?, 'problem-candidates', 'openai-subscription', 'gpt-benchmark', 'medium', 'completed', '{}',
      'wire', 'request', 'work', 'inputs', 'evidence', 'schema', ?, ?, ?, ?)`);
  insertRun.run("discovery", null, config, stamp, stamp);
  for (let index = 0; index < runCount; index += 1) {
    const problemId = `problem-${index}`;
    const runId = `run-${index}`;
    insertProblem.run(problemId, `Problem ${index}`, stamp, stamp);
    insertRun.run(runId, problemId, config, stamp, stamp);
    for (let option = 0; option < 2; option += 1) {
      const id = `solution-${index}-${option}`;
      insertSolution.run(id, problemId, runId, `Option ${index}-${option}`, stamp);
    }
    insertAttempt.run(`attempt-${index}`, `generation-${index}`, runId, attemptMetadata, stamp, stamp, stamp);
  }
});
db.close();

const backend = await startBackend({
  dataDir: directory, dbPath, bundledPromptsDir: join(process.cwd(), "prompts"),
  promptOverridesDir: join(directory, "prompts"), appVersion: "benchmark",
  getSecrets: () => ({ exaApiKey: null }),
}, () => undefined);
try {
  for (const [route, body] of [
    ["/research/export", { threadId: "project" }],
    ["/ideas/export", { threadId: "project", format: "json" }],
  ] as const) {
    const samples: number[] = [];
    let digest = "";
    for (let index = 0; index < 9; index += 1) {
      const start = performance.now();
      const response = await fetch(`http://127.0.0.1:${backend.port}${route}`, {
        method: "POST", headers: { authorization: `Bearer ${backend.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json() as { data?: { content?: string; files?: Array<{ filename: string; content: string }> }; error?: unknown };
      if (!response.ok || !payload.data) throw new Error(JSON.stringify(payload.error));
      const elapsed = performance.now() - start;
      if (index > 0) samples.push(elapsed);
      const content = route === "/research/export"
        ? JSON.stringify({ ...JSON.parse(payload.data.content!), exportedAt: undefined })
        : JSON.stringify(payload.data.files);
      digest = createHash("sha256").update(content).digest("hex");
    }
    samples.sort((a, b) => a - b);
    console.log(JSON.stringify({ route, savedRuns: runCount, ideas: runCount * 2, runs: samples.length, medianMs: samples[3], p90Ms: samples[7], sha256: digest }));
  }
} finally {
  await backend.close();
}
