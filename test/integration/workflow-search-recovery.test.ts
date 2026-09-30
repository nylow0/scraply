import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResearchEngine } from "../../src/core/research-engine";
import { WorkflowCoordinator } from "../../src/core/workflow-coordinator";
import { prepareWorkflowSearch, unknownSearchAttempts } from "../../src/core/workflow-search-attempts";
import { DatabaseClient } from "../../src/db/client";
import { WorkflowRepository } from "../../src/db/repositories/workflows";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";
import { workflowSearchKey } from "../../src/shared/content-identity";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "scraply-search-recovery-")); directories.push(directory);
  const db = new DatabaseClient(join(directory, "test.db"));
  const now = new Date().toISOString();
  db.db.prepare("INSERT INTO threads (id,title,status,created_at,updated_at) VALUES ('project','Search recovery','researching',?,?)").run(now, now);
  const repository = new WorkflowRepository(db);
  const scope = { title: "Filing", audience: "Small teams", domain: "Invoices", observations: "Repeated entries", offLimits: [] };
  const model = { providerId: "fixture", modelId: "fixture-model" };
  const config = { ...DEFAULT_RUN_CONFIG, model };
  const session = db.immediateTransaction(() => repository.createSession({ id: "session", threadId: "project", purpose: "discovery", mode: "babysit", remainingMs: 60 * 60_000,
    contract: { contractVersion: 1, purpose: "discovery", mode: "babysit", brief: "Research filing", scope, runConfig: config,
      targets: { kind: "per-problem", ideaCount: 1 }, limits: { enforced: false, maxMinutes: 60, maxModelCalls: 30, maxSearches: 20 }, instructions: {},
      resolvedInstructions: { research: "", ideas: "", review: "" }, instructionHashes: { research: "r", ideas: "i", review: "v" } } }));
  db.immediateTransaction(() => {
    db.db.prepare(`INSERT INTO research_runs (id,thread_id,status,config_json,workflow_version,workflow_session_id,purpose,interrupted,created_at,updated_at)
      VALUES ('run','project','running',?,2,'session','discovery',1,?,?)`).run(JSON.stringify(config), now, now);
    const task = repository.createWorkItem({ id: "task", sessionId: session.id, kind: "discovery", scopeKey: "initial", state: "ready", input: {} });
    repository.reserveBudget({ sessionId: session.id, workItemId: task.id, operationKey: "search-task", kind: "search", reservedUnits: 10 });
    repository.updateWorkItem(task.id, "running", { outputRefs: { runId: "run" } });
  });
  const parameters = { maxResults: 2, sourceIntent: "firsthand", language: "en" };
  const query = "invoice filing experience";
  const input = { key: workflowSearchKey(query, parameters), query, parameters, provider: "exa" as const };
  const attempt = prepareWorkflowSearch(db, "run", input, []);
  const dispatches: Array<{ runId: string; attemptIds: readonly string[] }> = [];
  const engine = { resumeRun: async (runId: string, attemptIds: readonly string[]) => {
    dispatches.push({ runId, attemptIds });
    prepareWorkflowSearch(db, runId, input, attemptIds);
  } };
  const coordinator = new WorkflowCoordinator({ db, engine: () => engine as unknown as ResearchEngine,
    capabilities: async () => ({ nativeConnected: true, searchReady: { exa: true, perplexity: false },
      modelOptions: [{ ...model, displayName: "Fixture", defaultReasoningEffort: "medium", reasoningEfforts: [{ id: "medium", description: "Default" }] }] }),
    listProblems: () => [], onProgress: () => {} });
  return { db, repository, coordinator, attempt, dispatches };
}

test("startup stops an uncertain search and exposes its UUID without dispatching", () => {
  const f = fixture();
  try {
    f.coordinator.reconcileInterrupted();
    const detail = f.coordinator.get("session");
    expect(detail.summary).toMatchObject({ state: "finished", outcome: "needs-attention" });
    expect(detail.summary.budget.searches.uncertain).toBe(10);
    expect(detail.tasks[0]).toMatchObject({ state: "unknown", terminalAttemptId: f.attempt.id, terminalAttemptKind: "search" });
    expect(f.dispatches).toEqual([]);
    expect(f.repository.hasUnknownProviderCompletion("run")).toBe(true);
    expect(f.db.db.prepare("SELECT status FROM research_runs WHERE id = 'run'").get()).toEqual({ status: "failed" });
  } finally { f.db.close(); }
});

test("explicit search retry reuses the guided run and retains each dispatch receipt", async () => {
  const f = fixture();
  try {
    f.coordinator.reconcileInterrupted();
    const request = { threadId: "project", sessionId: "session", clientCommandId: "retry-search", expectedRevision: f.coordinator.summary("session").revision,
      action: { type: "retry-task" as const, taskId: "task", expectedTerminalAttemptId: f.attempt.id } };
    await expect(f.coordinator.command(request)).rejects.toMatchObject({ code: "UNKNOWN_COMPLETION" });
    expect(f.dispatches).toEqual([]);
    const acknowledged = { ...request, action: { ...request.action, acknowledgeUnknownCompletion: true } };
    const receipt = await f.coordinator.command(acknowledged);
    expect(receipt.sessionId).toBe("session");
    expect(f.dispatches).toEqual([{ runId: "run", attemptIds: [f.attempt.id] }]);
    expect((await f.coordinator.command(acknowledged)).sessionId).toBe("session");
    expect(f.dispatches).toHaveLength(1);
    const rows = f.db.db.prepare("SELECT snapshot_key FROM workflow_snapshots WHERE research_run_id = 'run' ORDER BY rowid").all() as Array<{ snapshot_key: string }>;
    expect(rows.filter(row => row.snapshot_key.startsWith("search-attempt:"))).toHaveLength(2);
    expect(rows).toContainEqual({ snapshot_key: `search-acknowledged:${f.attempt.id}` });
    const next = unknownSearchAttempts(f.db, "run");
    expect(next).toHaveLength(1);
    expect(next[0]!.id).not.toBe(f.attempt.id);
    expect(f.db.db.prepare("SELECT COUNT(*) AS count FROM research_runs").get()).toEqual({ count: 1 });
    expect(f.db.db.prepare("SELECT COUNT(*) AS count FROM generation_attempts").get()).toEqual({ count: 0 });
  } finally { f.db.close(); }
});
