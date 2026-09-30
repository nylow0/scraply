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
import { GenerationAttemptRepository } from "../../src/db/repositories/generation-attempts";
import { OpportunityExplorationRepository } from "../../src/db/repositories/opportunity-exploration";
import { runManagedInvestigatorSearch } from "../../src/core/evidence-investigators";
import { startBackend } from "../../src/backend/server";
import { WorkspaceStateSchema } from "../../src/shared/ipc";
import { z } from "zod";
import { randomUUID } from "node:crypto";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture(searchCount = 1, options: { kind?: "discovery" | "generate-ideas"; enforced?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "scraply-search-recovery-")); directories.push(directory);
  const db = new DatabaseClient(join(directory, "test.db"));
  const now = new Date().toISOString();
  db.db.prepare("INSERT INTO threads (id,title,status,created_at,updated_at) VALUES ('project','Search recovery','discovery-running',?,?)").run(now, now);
  const repository = new WorkflowRepository(db);
  const scope = { title: "Filing", audience: "Small teams", domain: "Invoices", observations: "Repeated entries", offLimits: [] };
  const model = { providerId: "fixture", modelId: "fixture-model" };
  const config = { ...DEFAULT_RUN_CONFIG, model };
  const session = db.immediateTransaction(() => repository.createSession({ id: "session", threadId: "project", purpose: "discovery", mode: "babysit", remainingMs: 60 * 60_000,
    contract: { contractVersion: 1, purpose: "discovery", mode: "babysit", brief: "Research filing", scope, runConfig: config,
      targets: { kind: "per-problem", ideaCount: 1 }, limits: { enforced: options.enforced ?? false, maxMinutes: 60, maxModelCalls: 30, maxSearches: 20 }, instructions: {},
      resolvedInstructions: { research: "", ideas: "", review: "" }, instructionHashes: { research: "r", ideas: "i", review: "v" } } }));
  db.immediateTransaction(() => {
    db.db.prepare(`INSERT INTO research_runs (id,thread_id,status,config_json,workflow_version,workflow_session_id,purpose,interrupted,created_at,updated_at)
      VALUES ('run','project','running',?,2,'session','discovery',1,?,?)`).run(JSON.stringify(config), now, now);
    const task = repository.createWorkItem({ id: "task", sessionId: session.id, kind: options.kind ?? "discovery", scopeKey: "initial", state: "ready", input: {} });
    repository.reserveBudget({ sessionId: session.id, workItemId: task.id, operationKey: "search-task", kind: "search", reservedUnits: 10 });
    repository.updateWorkItem(task.id, "running", { outputRefs: { runId: "run" } });
  });
  const parameters = { maxResults: 2, sourceIntent: "firsthand", language: "en" };
  const query = "invoice filing experience";
  const input = { key: workflowSearchKey(query, parameters), query, parameters, provider: "exa" as const };
  const inputs = Array.from({ length: searchCount }, (_, index) => {
    const question = index === 0 ? query : `${query} ${index + 1}`;
    return { ...input, query: question, key: workflowSearchKey(question, parameters) };
  });
  const attempts = inputs.map(item => prepareWorkflowSearch(db, "run", item, []));
  const attempt = attempts[0]!;
  const dispatches: Array<{ runId: string; attemptIds: readonly string[] }> = [];
  const engine = { resumeRun: async (runId: string, attemptIds: readonly string[]) => {
    dispatches.push({ runId, attemptIds });
    for (const item of inputs) prepareWorkflowSearch(db, runId, item, attemptIds);
  } };
  const coordinator = new WorkflowCoordinator({ db, engine: () => engine as unknown as ResearchEngine,
    capabilities: async () => ({ nativeConnected: true, searchReady: { exa: true, perplexity: false },
      modelOptions: [{ ...model, displayName: "Fixture", defaultReasoningEffort: "medium", reasoningEfforts: [{ id: "medium", description: "Default" }] }] }),
    listProblems: () => [], onProgress: () => {} });
  return { db, repository, coordinator, attempt, attempts, dispatches, engine, directory };
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

test("parallel lost searches each require acknowledgment before any replacement dispatch", async () => {
  const f = fixture(2);
  try {
    f.coordinator.reconcileInterrupted();
    const last = f.attempts[1]!;
    const command = { threadId: "project", sessionId: "session", clientCommandId: "acknowledge-last-search", expectedRevision: f.coordinator.summary("session").revision,
      action: { type: "retry-task" as const, taskId: "task", expectedTerminalAttemptId: last.id, acknowledgeUnknownCompletion: true } };
    const first = await f.coordinator.command(command);
    expect(first.summary.state).toBe("finished");
    expect(f.dispatches).toEqual([]);
    expect(f.coordinator.get("session").tasks[0]?.terminalAttemptId).toBe(f.attempt.id);
    await expect(f.coordinator.command({ ...command, clientCommandId: "reacknowledge-old-search" })).rejects.toMatchObject({ code: "INVALID_REFERENCE" });
    await f.coordinator.command({ ...command, clientCommandId: "acknowledge-first-search", expectedRevision: first.revision,
      action: { ...command.action, expectedTerminalAttemptId: f.attempt.id } });
    expect(f.dispatches).toHaveLength(1);
    expect([...f.dispatches[0]!.attemptIds].sort()).toEqual(f.attempts.map(item => item.id).sort());
    expect((f.db.db.prepare("SELECT COUNT(*) AS count FROM workflow_snapshots WHERE research_run_id = 'run' AND snapshot_key LIKE 'search-attempt:%'").get() as { count: number }).count).toBe(4);
    expect(unknownSearchAttempts(f.db, "run")).toHaveLength(2);
  } finally { f.db.close(); }
});

test("parallel lost model streams are acknowledged individually before any research resumes", async () => {
  const f = fixture(0);
  try {
    const attempts = new GenerationAttemptRepository(f.db);
    const saved = ["first-area", "second-area"].map(stage => {
      const attempt = attempts.prepare("run", { generationId: randomUUID(), stage, model: { providerId: "fixture", modelId: "fixture-model" }, reasoningEffort: "medium",
        workOrder: { stage, instruction: "Read saved sources", goal: "Find observations", inputs: {}, definitionOfDone: [], constraints: [] },
        evidence: [], schema: z.object({}), jsonSchema: { type: "object" }, repairPolicy: "disabled", signal: new AbortController().signal });
      attempts.markDispatched(attempt.id); return attempt;
    });
    f.coordinator.reconcileInterrupted();
    expect(f.coordinator.get("session").tasks[0]).toMatchObject({ terminalAttemptId: saved[1]!.id, terminalAttemptKind: "model" });
    const command = { threadId: "project", sessionId: "session", clientCommandId: "acknowledge-second-model", expectedRevision: f.coordinator.summary("session").revision,
      action: { type: "retry-task" as const, taskId: "task", expectedTerminalAttemptId: saved[1]!.id, acknowledgeUnknownCompletion: true } };
    const first = await f.coordinator.command(command);
    expect(first.summary.state).toBe("finished");
    expect(f.dispatches).toEqual([]);
    expect(f.coordinator.get("session").tasks[0]?.terminalAttemptId).toBe(saved[0]!.id);
    expect(f.repository.acknowledgedAttemptIds("run")).toEqual([saved[1]!.id]);
    await f.coordinator.command({ ...command, clientCommandId: "acknowledge-first-model", expectedRevision: first.revision,
      action: { ...command.action, expectedTerminalAttemptId: saved[0]!.id } });
    expect(f.dispatches).toHaveLength(1);
    expect([...f.dispatches[0]!.attemptIds].sort()).toEqual(saved.map(attempt => attempt.id).sort());
    expect(f.db.db.prepare("SELECT COUNT(*) AS count FROM generation_attempts WHERE status = 'dispatched'").get()).toEqual({ count: 2 });
  } finally { f.db.close(); }
});

test("a bounded novelty search retry preserves its old UUID and charges only replacement work", async () => {
  const f = fixture(0, { kind: "generate-ideas", enforced: true });
  try {
    const models = new GenerationAttemptRepository(f.db);
    const completed = ["ideas", "preliminary-review", "classification"].map(stage => {
      const attempt = models.prepare("run", { generationId: randomUUID(), stage, model: { providerId: "fixture", modelId: "fixture-model" }, reasoningEffort: "medium",
        workOrder: { stage, instruction: "Read saved evidence", goal: "Review an idea", inputs: {}, definitionOfDone: [], constraints: [] },
        evidence: [], schema: z.object({}), jsonSchema: { type: "object" }, repairPolicy: "disabled", signal: new AbortController().signal });
      models.markDispatched(attempt.id);
      models.recordTerminal(attempt.id, { status: "completed", terminalKind: "completed", output: {} });
      return attempt;
    });
    const child = f.db.immediateTransaction(() => f.repository.createWorkItem({ sessionId: "session", parentItemId: "task",
      kind: "evidence-check", scopeKey: "novelty", state: "ready", input: {} }));
    const input = { db: f.db, threadId: "project", sessionId: "session", workItemId: child.id, searchProvider: "exa" as const,
      request: { key: "novelty:candidate", query: "invoice filing existing products", route: "alternatives" as const, evidenceNeeded: "Compare the proposed product" },
      signal: new AbortController().signal };
    await expect(runManagedInvestigatorSearch({ ...input, searchClient: { provider: "exa", async search() {
      throw new Error("Result lost after dispatch");
    } } })).rejects.toThrow("Result lost after dispatch");
    const original = new OpportunityExplorationRepository(f.db).loadAttempt("project", "investigator-search:novelty:candidate", "session")!;
    f.coordinator.reconcileInterrupted();
    expect(f.coordinator.get("session").tasks.find(task => task.id === "task"))
      .toMatchObject({ terminalAttemptId: original.attemptId, terminalAttemptKind: "search", state: "unknown" });
    let replacements = 0;
    let completeResume: () => void = () => undefined;
    const resumed = new Promise<void>(resolve => { completeResume = resolve; });
    f.engine.resumeRun = async (runId, attemptIds) => {
      f.dispatches.push({ runId, attemptIds });
      await runManagedInvestigatorSearch({ ...input, acknowledgedAttemptIds: attemptIds,
        searchClient: { provider: "exa", async search() { replacements++; return []; } } });
      const final = models.prepare(runId, { generationId: randomUUID(), stage: "final-review", model: { providerId: "fixture", modelId: "fixture-model" }, reasoningEffort: "medium",
        workOrder: { stage: "final-review", instruction: "Review saved classified ideas", goal: "Decide", inputs: {}, definitionOfDone: [], constraints: [] },
        evidence: [], schema: z.object({}), jsonSchema: { type: "object" }, repairPolicy: "disabled", signal: new AbortController().signal });
      models.markDispatched(final.id);
      models.recordTerminal(final.id, { status: "completed", terminalKind: "completed", output: {} });
      completeResume();
    };
    const command = { threadId: "project", sessionId: "session", clientCommandId: "retry-novelty-search", expectedRevision: f.coordinator.summary("session").revision,
      action: { type: "retry-task" as const, taskId: "task", expectedTerminalAttemptId: original.attemptId, acknowledgeUnknownCompletion: true } };
    await expect(f.coordinator.command({ ...command, clientCommandId: "unrelated-model", action: { ...command.action, expectedTerminalAttemptId: completed[0]!.id } }))
      .rejects.toMatchObject({ code: "INVALID_REFERENCE" });
    expect(replacements).toBe(0);
    const receipt = await f.coordinator.command(command);
    expect(receipt.sessionId).toBe("session");
    await resumed;
    expect(replacements).toBe(1);
    expect(f.repository.acknowledgedAttemptIds("run")).toEqual([original.attemptId]);
    expect(new OpportunityExplorationRepository(f.db).loadAttempt("project", "investigator-search:novelty:candidate", "session"))
      .toEqual(original);
    expect(f.repository.countInvestigatorSearches("run")).toBe(2);
    expect(f.repository.hasUnknownProviderCompletion("run")).toBe(false);
    const baseline = f.db.db.prepare("SELECT value_json FROM workflow_snapshots WHERE research_run_id = 'run' AND snapshot_key LIKE 'task-budget-retry-baseline:%'").get() as { value_json: string };
    expect(JSON.parse(baseline.value_json)).toEqual({ modelCalls: 3, searches: 0, searchAttempts: 1 });
    f.coordinator.handleRunEvent({ type: "run-completed", threadId: "project", runId: "run", problemId: null });
    expect(f.coordinator.summary("session").budget.modelCalls.spent).toBe(1);
    expect(f.coordinator.summary("session").budget.searches).toMatchObject({ uncertain: 10, spent: 1 });
    expect(f.db.db.prepare("SELECT COUNT(*) AS count FROM research_runs").get()).toEqual({ count: 1 });
  } finally { f.db.close(); }
});

test.each([0, 1])("workspace usage reports managed and %s base unknown searches without adding model or token attempts", async baseCount => {
  const f = fixture(baseCount);
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined;
  try {
    const attempts = new OpportunityExplorationRepository(f.db);
    f.db.immediateTransaction(() => {
      const child = f.repository.createWorkItem({ sessionId: "session", parentItemId: "task", kind: "evidence-check",
        scopeKey: "candidate-gap", state: "ready", input: {} });
      const search = attempts.prepareAttempt("project", { stageKey: "investigator-search:gap", stageName: "investigator-search", input: {},
        model: { providerId: "exa", modelId: "search", reasoningEffort: "bounded" }, promptVersion: "1", promptText: "Find an owner", workItemId: child.id }, "session");
      if (search.kind !== "prepared") throw new Error("Expected prepared fixture search");
      attempts.markAttemptDispatched("project", search.attemptId, "none", "session");
    });
    f.coordinator.reconcileInterrupted();
    const errors: string[] = [];
    backend = await startBackend({ dataDir: f.directory, dbPath: join(f.directory, "test.db"), bundledPromptsDir: join(process.cwd(), "prompts"),
      promptOverridesDir: join(f.directory, "prompts"), appVersion: "test", getSecrets: () => ({ exaApiKey: null }),
      log: entry => { if (entry.error) errors.push(String(entry.error)); } }, () => {});
    const selected = await fetch(`http://127.0.0.1:${backend.port}/threads/select`, { method: "POST",
      headers: { authorization: `Bearer ${backend.token}`, "content-type": "application/json" }, body: JSON.stringify({ threadId: "project" }) });
    if (selected.status !== 200) throw new Error(`${await selected.text()}; ${errors.join("; ")}`);
    expect(selected.status).toBe(200);
    const response = await fetch(`http://127.0.0.1:${backend.port}/workspace`, { headers: { authorization: `Bearer ${backend.token}` } });
    expect(response.status).toBe(200);
    const workspace = WorkspaceStateSchema.parse((await response.json() as { data: unknown }).data);
    expect(workspace.latestResearchRun?.usage).toMatchObject({ searchAttemptCount: baseCount + 1, unknownSearchCount: baseCount + 1,
      attemptCount: 0, unknownAttemptCount: 0, tokens: { total: { unknownAttempts: 0 } }, repairCount: { known: 0, unknownAttempts: 0 } });
    expect(workspace.latestResearchRun?.canResume).toBe(false);
    expect(f.dispatches).toEqual([]);
  } finally { await backend?.close(); f.db.close(); }
});
