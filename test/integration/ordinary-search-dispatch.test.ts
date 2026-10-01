import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResearchEngine } from "../../src/core/research-engine";
import { WorkflowCoordinator } from "../../src/core/workflow-coordinator";
import { WorkflowExecution } from "../../src/core/workflow-execution";
import { getRunTrace, getRunTraceStep } from "../../src/core/run-trace";
import { prepareWorkflowSearch, recordWorkflowSearchDispatched, recordWorkflowSearchTerminal,
  unknownSearchAttempts, UnknownSearchCompletionError, workflowSearchDispatchUsage } from "../../src/core/workflow-search-attempts";
import { DatabaseClient } from "../../src/db/client";
import { CostLedgerRepository, type CostReservation } from "../../src/db/repositories/cost-ledger";
import { WorkflowRepository } from "../../src/db/repositories/workflows";
import type { SearchClient } from "../../src/providers/search";
import { configurePromptPaths } from "../../src/core/prompts";
import { DEFAULT_RUN_CONFIG, type Source } from "../../src/shared/schemas";
import type { ResearchEvent } from "../../src/shared/ipc";
import { workflowSearchKey } from "../../src/shared/content-identity";

const fixtures: Array<{ db: DatabaseClient; directory: string }> = [];
afterEach(() => {
  for (const { db, directory } of fixtures.splice(0)) {
    db.close();
    try { rmSync(directory, { recursive: true, force: true }); }
    catch { /* SQLite can retain the WAL handle briefly on Windows. */ }
  }
});

type Admission = "task" | "area" | "request" | "ready";
function fixture(admission?: Admission, providerSearch?: () => Promise<Source[]>, onEvent?: (event: ResearchEvent, controller: AbortController) => void) {
  configurePromptPaths({ bundledDir: join(process.cwd(), "prompts"), overrideDir: null });
  const directory = mkdtempSync(join(tmpdir(), "scraply-search-dispatch-"));
  const db = new DatabaseClient(join(directory, "search.db"));
  fixtures.push({ db, directory });
  const now = new Date().toISOString();
  const config = { ...DEFAULT_RUN_CONFIG, searchProvider: "exa" as const, budgetLimit: 10 };
  db.db.prepare("INSERT INTO threads (id,title,status,created_at,updated_at) VALUES ('project','Search','configuring',?,?)").run(now, now);
  const workflows = new WorkflowRepository(db);
  const task = db.immediateTransaction(() => {
    workflows.createSession({ id: "session", threadId: "project", purpose: "discovery", mode: "babysit",
      contract: { limits: { enforced: true } }, remainingMs: 60_000 });
    const task = workflows.createWorkItem({ id: "task", sessionId: "session", kind: "discovery", scopeKey: "initial", input: {}, state: "ready" });
    workflows.updateWorkItem(task.id, "running", { outputRefs: { runId: "run" } });
    if (admission !== "task") workflows.reserveBudget({ sessionId: "session", workItemId: task.id,
      operationKey: "searches", kind: "search", reservedUnits: 2 });
    return task;
  });
  db.db.prepare(`INSERT INTO research_runs (id,thread_id,status,config_json,workflow_version,purpose,workflow_session_id,
    budget_limit,created_at,updated_at) VALUES ('run','project','running',?,2,'discovery','session',10,?,?)`).run(JSON.stringify(config), now, now);
  let dispatches = 0;
  const client: SearchClient = { provider: "exa", validateKey: async () => ({ valid: true }),
    async search() { dispatches++; return providerSearch ? providerSearch() : []; } };
  const controller = new AbortController();
  const active = { runId: "run", threadId: "project", problemId: null, config, abortController: controller,
    startedAt: Date.now(), projectedCodexCalls: 2, projectedSearches: 2,
    followUpModelReservation: null, followUpSearchReservation: null as CostReservation | null, generationProvenance: new Map<string, string>(),
    areaBudget: { areaId: "area", maxModelCalls: 2, maxSearches: admission === "area" ? 0 : 2, pendingSearches: 0 },
    ...(admission === "request" ? { researchAllowance: { maxModelCalls: 2, maxSearches: 0 } } : {}) };
  const engine = new ResearchEngine({ db, searchClients: admission === "ready" ? {} : { exa: client },
    onEvent: event => onEvent?.(event, controller) });
  // Exercise the real admission and cost ledger, without starting any model workflow.
  const access = engine as unknown as { activeRuns: Map<string, typeof active>;
    instrumentedSearch(run: typeof active): Pick<SearchClient, "provider" | "providerForRoute" | "search" | "searchWithDispatch"> };
  access.activeRuns.set(active.runId, active);
  const execution = new WorkflowExecution(db, active.runId);
  const instrumented = access.instrumentedSearch(active);
  const search = execution.search(instrumented);
  const coordinator = new WorkflowCoordinator({ db, engine: () => engine,
    capabilities: async () => ({ nativeConnected: false, searchReady: { exa: false, perplexity: false }, modelOptions: [] }),
    listProblems: () => [], onProgress: () => {} });
  const accounting = coordinator as unknown as { searchAttemptCount(runId: string): number;
    settleTaskBudget(taskId: string, state: "spent", attempts: number): void };
  const settle = () => db.immediateTransaction(() => accounting.settleTaskBudget(task.id, "spent", 0));
  return { db, directory, workflows, active, controller, execution, search, instrumented, dispatches: () => dispatches,
    physicalCount: () => accounting.searchAttemptCount(active.runId), settle };
}

const parameters = { route: "community" as const, numResults: 1 };
const query = "Owner filing reports";
const input = { key: workflowSearchKey(query, parameters, "exa"), query, parameters, provider: "exa" as const };
function receipts(db: DatabaseClient) {
  return db.db.prepare("SELECT snapshot_key, value_json FROM workflow_snapshots WHERE snapshot_key LIKE 'search-attempt:%' ORDER BY rowid")
    .all() as Array<{ snapshot_key: string; value_json: string }>;
}

for (const admission of ["task", "area", "request", "ready"] as const) {
  test(`${admission} rejection before provider dispatch spends no search and is not unknown`, async () => {
    const f = fixture(admission);
    const error = await f.search.search("Owner filing reports", { route: "community", provider: "exa" }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(f.dispatches()).toBe(0);
    expect(f.physicalCount()).toBe(0);
    const trace = getRunTrace(f.db, "run");
    expect(trace.metrics.searches).toBe(0);
    expect(trace.warnings.some(warning => warning.includes("unknown provider completion"))).toBe(false);
    expect(trace.steps.find(step => step.kind === "search")?.status).toBe("never-dispatched");
    expect(unknownSearchAttempts(f.db, "run")).toEqual([]);
    f.settle();
    expect(f.workflows.listBudgetEntries("session").reduce((sum, entry) => sum + (entry.settledUnits ?? 0), 0)).toBe(0);
    expect(f.db.db.prepare("SELECT * FROM cost_ledger").all()).toEqual([]);
  });
}

test("dispatch-proof persistence failure releases the reservation and leaves an immutable undispatched receipt", async () => {
  const f = fixture();
  f.db.db.exec(`CREATE TRIGGER reject_dispatch BEFORE INSERT ON workflow_snapshots
    WHEN NEW.snapshot_key LIKE 'search-dispatched:%' BEGIN SELECT RAISE(ABORT, 'Dispatch storage unavailable'); END`);
  const error = await f.search.search(query, parameters).catch((error: unknown) => error);
  expect(error).toMatchObject({ message: "Dispatch storage unavailable" });
  expect(f.dispatches()).toBe(0);
  expect(f.active.areaBudget.pendingSearches).toBe(0);
  expect(f.db.db.prepare("SELECT * FROM cost_ledger").all()).toEqual([]);
  expect(f.db.db.prepare("SELECT reserved_cost, committed_cost FROM research_runs WHERE id='run'").get())
    .toEqual({ reserved_cost: 0, committed_cost: 0 });
  expect(f.physicalCount()).toBe(0);
  expect(unknownSearchAttempts(f.db, "run")).toEqual([]);
  const old = receipts(f.db);
  const trace = getRunTrace(f.db, "run");
  const step = trace.steps.find(step => step.kind === "search")!;
  const detail = getRunTraceStep(f.db, "run", step.id);
  expect(detail.step.status).toBe("never-dispatched");
  expect(detail.events.some(event => event.type === "search-interrupted")).toBe(false);
  expect(detail.events.find(event => event.type === "search-never-dispatched")?.payload)
    .toMatchObject({ message: "Dispatch storage unavailable" });
  f.db.db.exec("DROP TRIGGER reject_dispatch");
  await new WorkflowExecution(f.db, "run").search(f.instrumented).search(query, parameters);
  expect(receipts(f.db)[0]).toEqual(old[0]);
  expect(f.dispatches()).toBe(1);
  expect(f.physicalCount()).toBe(1);
  expect(getRunTrace(f.db, "run").metrics.searches).toBe(1);
  f.settle();
  expect(f.workflows.getBudgetTotals("session").searches.spent).toBe(1);
});

test("abort after reservation but before dispatch releases cost and pending area units", async () => {
  const f = fixture(undefined, undefined, (event, controller) => {
    if (event.type === "run-progress" && event.message.startsWith("Searching ")) controller.abort(new Error("Stopped before dispatch"));
  });
  const error = await f.search.search(query, { ...parameters, signal: f.controller.signal }).catch((error: unknown) => error);
  expect(error).toMatchObject({ message: "Stopped before dispatch" });
  expect(f.dispatches()).toBe(0);
  expect(f.active.areaBudget.pendingSearches).toBe(0);
  expect(f.db.db.prepare("SELECT * FROM cost_ledger").all()).toEqual([]);
  expect(f.physicalCount()).toBe(0);
  expect(getRunTrace(f.db, "run").warnings.some(warning => warning.includes("unknown provider completion"))).toBe(false);
  expect(unknownSearchAttempts(f.db, "run")).toEqual([]);
});

test("parallel identical requests share one physical dispatch and saved result without changing identity", async () => {
  let resolve: (sources: Source[]) => void = () => { throw new Error("Provider did not start"); };
  const waiting = new Promise<Source[]>(done => { resolve = done; });
  const f = fixture(undefined, () => waiting);
  const first = f.search.search(query, parameters);
  const second = new WorkflowExecution(f.db, "run").search(f.instrumented).search(query.toUpperCase(), parameters);
  expect(f.dispatches()).toBe(1);
  expect(f.active.areaBudget.pendingSearches).toBe(1);
  expect(f.physicalCount()).toBe(1);
  const prepared = JSON.parse(receipts(f.db)[0]!.value_json) as { id: string };
  expect(JSON.parse((f.db.db.prepare("SELECT usage_json FROM cost_ledger").get() as { usage_json: string }).usage_json))
    .toEqual({ searchDispatch: { version: 1, attemptId: prepared.id } });
  const source = { id: "provider-source-exact-id", url: "https://reddit.com/r/example", title: "Report", text: "Saved owner report" };
  resolve([source]);
  expect(await Promise.all([first, second])).toEqual([[source], [source]]);
  const savedReceipts = receipts(f.db);
  expect(savedReceipts).toHaveLength(1);
  expect(JSON.parse(savedReceipts[0]!.value_json)).toMatchObject({ key: input.key, query, parameters, dispatchProofVersion: 1 });
  expect(await new WorkflowExecution(f.db, "run").search(f.instrumented).search(query, parameters)).toEqual([source]);
  expect(receipts(f.db)).toEqual(savedReceipts);
  expect(f.dispatches()).toBe(1);
  expect(f.active.areaBudget.pendingSearches).toBe(0);
  const detail = getRunTraceStep(f.db, "run", getRunTrace(f.db, "run").steps.find(step => step.kind === "search")!.id);
  expect(detail.output).toEqual([source]);
  expect(detail.events.some(event => event.type === "search-dispatched")).toBe(true);
  f.settle();
  expect(f.workflows.getBudgetTotals("session").searches.spent).toBe(1);
});

test("a different concurrent query rejected by the area cap does not add a second physical call", async () => {
  let resolve: (sources: Source[]) => void = () => {};
  const waiting = new Promise<Source[]>(done => { resolve = done; });
  const f = fixture(undefined, () => waiting);
  f.active.areaBudget.maxSearches = 1;
  const first = f.search.search(query, parameters);
  const error = await f.search.search("Another owner report", parameters).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  expect(f.dispatches()).toBe(1);
  expect(f.physicalCount()).toBe(1);
  expect(f.active.areaBudget.pendingSearches).toBe(1);
  resolve([]);
  await first;
  expect(f.active.areaBudget.pendingSearches).toBe(0);
  expect(getRunTrace(f.db, "run").metrics.searches).toBe(1);
  f.settle();
  expect(f.workflows.getBudgetTotals("session").searches.spent).toBe(1);
});

test("provider failure after durable dispatch remains counted and visible with its UUID", async () => {
  const f = fixture(undefined, async () => { throw new Error("Provider rejected request"); });
  const error = await f.search.search(query, parameters).catch((error: unknown) => error);
  expect(error).toMatchObject({ message: "Provider rejected request" });
  expect(f.dispatches()).toBe(1);
  expect(f.physicalCount()).toBe(1);
  expect(f.active.areaBudget.pendingSearches).toBe(0);
  expect(getRunTrace(f.db, "run").steps.find(step => step.kind === "search")?.status).toBe("failed");
  f.settle();
  expect(f.workflows.getBudgetTotals("session").searches.spent).toBe(1);
});

test("abort after provider invocation preserves one cancelled physical search even when the provider finishes later", async () => {
  let resolve: (sources: Source[]) => void = () => {};
  const waiting = new Promise<Source[]>(done => { resolve = done; });
  const f = fixture(undefined, () => waiting);
  const pending = f.search.search(query, { ...parameters, signal: f.controller.signal });
  f.controller.abort(new Error("Stopped after dispatch"));
  expect(f.dispatches()).toBe(1);
  expect(f.physicalCount()).toBe(1);
  resolve([]);
  expect(await pending.catch((error: unknown) => error)).toMatchObject({ message: "Stopped after dispatch" });
  expect(f.active.areaBudget.pendingSearches).toBe(0);
  expect(getRunTrace(f.db, "run").steps.find(step => step.kind === "search")?.status).toBe("cancelled");
  expect(f.physicalCount()).toBe(1);
  f.settle();
  expect(f.workflows.getBudgetTotals("session").searches.spent).toBe(1);
});

test("paid-result persistence failure keeps exact unknown dispatch and prevents replay before acknowledgment", async () => {
  const f = fixture();
  f.db.db.exec(`CREATE TRIGGER reject_result BEFORE INSERT ON workflow_snapshots
    WHEN NEW.snapshot_key LIKE 'search:%' BEGIN SELECT RAISE(ABORT, 'Result storage unavailable'); END`);
  expect(await f.search.search(query, parameters).catch((error: unknown) => error)).toMatchObject({ message: "Result storage unavailable" });
  const old = f.db.db.prepare("SELECT * FROM workflow_snapshots ORDER BY rowid").all();
  const unknown = unknownSearchAttempts(f.db, "run");
  expect(unknown).toHaveLength(1);
  expect(f.dispatches()).toBe(1);
  expect(f.physicalCount()).toBe(1);
  const blocked = await new WorkflowExecution(f.db, "run").search(f.instrumented).search(query, parameters).catch((error: unknown) => error);
  expect(blocked).toBeInstanceOf(UnknownSearchCompletionError);
  expect(f.dispatches()).toBe(1);
  expect(f.db.db.prepare("SELECT * FROM workflow_snapshots ORDER BY rowid").all()).toEqual(old);
  expect(getRunTrace(f.db, "run").warnings).toContain("Some recorded search attempts have unknown provider completion. They are included in the search count.");
  f.db.db.exec("DROP TRIGGER reject_result");
  await new WorkflowExecution(f.db, "run", [unknown[0]!.id]).search(f.instrumented).search(query, parameters);
  expect(f.dispatches()).toBe(2);
  expect(f.physicalCount()).toBe(2);
  expect(getRunTrace(f.db, "run").steps.filter(step => step.kind === "search").map(step => step.status)).toEqual(["unknown-dispatch", "completed"]);
});

for (const status of ["prepared", "failed", "cancelled", "completed", "unknown"] as const) {
  test(`new ${status} receipt uses explicit dispatch proof; legacy receipt remains conservative and unchanged`, () => {
    const f = fixture();
    const marked = prepareWorkflowSearch(f.db, "run", { ...input, dispatchProofVersion: 1 }, []);
    if (status !== "prepared") recordWorkflowSearchDispatched(f.db, "run", marked.id);
    if (status !== "unknown" && status !== "prepared") recordWorkflowSearchTerminal(f.db, "run", marked.id, status);
    const legacy = prepareWorkflowSearch(f.db, "run", { ...input, query: "Old report", key: workflowSearchKey("Old report", parameters, "exa") }, []);
    const oldRows = f.db.db.prepare("SELECT * FROM workflow_snapshots ORDER BY rowid").all();
    expect(f.physicalCount()).toBe(status === "prepared" ? 1 : 2);
    const unknown = unknownSearchAttempts(f.db, "run");
    expect(unknown.map(attempt => attempt.id)).toEqual(status === "unknown" ? [marked.id, legacy.id] : [legacy.id]);
    const trace = getRunTrace(f.db, "run");
    expect(trace.metrics.searches).toBe(status === "prepared" ? 1 : 2);
    expect(trace.steps.find(step => step.id === `search-attempt:${marked.id}`)?.status)
      .toBe(status === "prepared" ? "never-dispatched" : status === "unknown" ? "unknown-dispatch" : status);
    expect(getRunTraceStep(f.db, "run", `search-attempt:${legacy.id}`).inputs).toEqual(legacy);
    expect(f.db.db.prepare("SELECT * FROM workflow_snapshots ORDER BY rowid").all()).toEqual(oldRows);
  });
}

test("a prepared receipt left before dispatch can resume without acknowledging a nonexistent provider call", async () => {
  const f = fixture();
  const prepared = prepareWorkflowSearch(f.db, "run", { ...input, dispatchProofVersion: 1 }, []);
  const old = receipts(f.db);
  expect(unknownSearchAttempts(f.db, "run")).toEqual([]);
  expect(getRunTrace(f.db, "run").warnings.some(warning => warning.includes("unknown provider completion"))).toBe(false);
  expect(getRunTraceStep(f.db, "run", `search-attempt:${prepared.id}`).events.some(event => event.type === "search-interrupted")).toBe(false);
  await new WorkflowExecution(f.db, "run").search(f.instrumented).search(query, parameters);
  expect(f.dispatches()).toBe(1);
  expect(f.physicalCount()).toBe(1);
  expect(receipts(f.db)[0]).toEqual(old[0]);
});

for (const dispatched of [false, true]) {
  test(`restart ${dispatched ? "retains uncertain dispatched" : "releases never-dispatched"} cost using its atomically saved receipt link`, () => {
    const f = fixture();
    const prepared = prepareWorkflowSearch(f.db, "run", { ...input, dispatchProofVersion: 1 }, []);
    const ledger = new CostLedgerRepository(f.db);
    const reservation = ledger.reserve("run", "search", "exa", null, 0.02, undefined,
      { searchDispatch: { version: 1, attemptId: prepared.id }, areaId: "area" });
    if (dispatched) recordWorkflowSearchDispatched(f.db, "run", prepared.id);
    const saved = f.db.db.prepare("SELECT * FROM workflow_snapshots ORDER BY rowid").all();
    f.db.close();
    const reopened = new DatabaseClient(join(f.directory, "search.db"));
    fixtures.find(item => item.directory === f.directory)!.db = reopened;
    new CostLedgerRepository(reopened).settleUncertain("run", "Restart before terminal");
    expect(reopened.db.prepare("SELECT * FROM workflow_snapshots ORDER BY rowid").all()).toEqual(saved);
    expect(workflowSearchDispatchUsage(reopened, "run")).toEqual({ attemptCount: dispatched ? 1 : 0, unknownCount: dispatched ? 1 : 0 });
    expect(getRunTrace(reopened, "run").metrics.searches).toBe(dispatched ? 1 : 0);
    const row = reopened.db.prepare("SELECT status, usage_json FROM cost_ledger WHERE id=?").get(reservation.id) as { status: string; usage_json: string } | undefined;
    if (dispatched) {
      expect(row?.status).toBe("committed");
      expect(JSON.parse(row!.usage_json)).toEqual({ areaId: "area", searchDispatch: { version: 1, attemptId: prepared.id },
        uncertain: true, reason: "Restart before terminal" });
      expect(unknownSearchAttempts(reopened, "run").map(attempt => attempt.id)).toEqual([prepared.id]);
    } else {
      expect(row).toBeNull();
      expect(unknownSearchAttempts(reopened, "run")).toEqual([]);
    }
    expect(reopened.db.prepare("SELECT reserved_cost FROM research_runs WHERE id='run'").get()).toEqual({ reserved_cost: 0 });
  });
}

test("restart cannot release legacy, malformed, mismatched, or foreign-version reservation metadata", () => {
  const f = fixture();
  const prepared = prepareWorkflowSearch(f.db, "run", { ...input, dispatchProofVersion: 1 }, []);
  const legacy = prepareWorkflowSearch(f.db, "run", { ...input, query: "Legacy report", key: workflowSearchKey("Legacy report", parameters, "exa") }, []);
  const ledger = new CostLedgerRepository(f.db);
  const cases = [undefined, { searchDispatch: { version: 1, attemptId: legacy.id } },
    { searchDispatch: { version: 2, attemptId: prepared.id } },
    { searchDispatch: { version: 1, attemptId: "00000000-0000-4000-8000-000000000099" } },
    { searchDispatch: { version: 1, attemptId: prepared.id, foreign: true } }];
  for (const usage of cases) ledger.reserve("run", "search", "exa", null, 0.02, undefined, usage);
  const malformed = ledger.reserve("run", "search", "exa", null, 0.02);
  f.db.db.prepare("UPDATE cost_ledger SET usage_json='invalid json' WHERE id=?").run(malformed.id);
  ledger.settleUncertain("run", "Restart");
  const rows = f.db.db.prepare("SELECT status FROM cost_ledger").all();
  expect(rows).toHaveLength(cases.length + 1);
  expect(rows.every(row => (row as { status: string }).status === "committed")).toBe(true);
  expect(f.physicalCount()).toBe(cases.length + 1);
});

test("a malformed partial receipt cannot prove that its linked reservation was never dispatched", () => {
  const f = fixture();
  const prepared = prepareWorkflowSearch(f.db, "run", { ...input, dispatchProofVersion: 1 }, []);
  const ledger = new CostLedgerRepository(f.db);
  const reservation = ledger.reserve("run", "search", "exa", null, 0.02, undefined,
    { searchDispatch: { version: 1, attemptId: prepared.id } });
  f.db.db.prepare("UPDATE workflow_snapshots SET value_json=? WHERE snapshot_key LIKE 'search-attempt:%'")
    .run(JSON.stringify({ id: prepared.id, dispatchProofVersion: 1 }));
  ledger.settleUncertain("run", "Restart");
  expect(f.db.db.prepare("SELECT status FROM cost_ledger WHERE id=?").get(reservation.id)).toEqual({ status: "committed" });
});

test("a preallocated follow-up allowance releases on dispatch-proof failure and otherwise retains conservative unlinked recovery", async () => {
  const f = fixture();
  const ledger = new CostLedgerRepository(f.db);
  f.active.followUpSearchReservation = ledger.reserve("run", "evidence-follow-up-search", "exa", null, 0.02);
  f.db.db.exec(`CREATE TRIGGER reject_follow_up_dispatch BEFORE INSERT ON workflow_snapshots
    WHEN NEW.snapshot_key LIKE 'search-dispatched:%' BEGIN SELECT RAISE(ABORT, 'Dispatch storage unavailable'); END`);
  expect(await f.search.search(query, parameters).catch((error: unknown) => error)).toMatchObject({ message: "Dispatch storage unavailable" });
  expect(f.dispatches()).toBe(0);
  expect(f.active.followUpSearchReservation).toBeNull();
  expect(f.active.areaBudget.pendingSearches).toBe(0);
  expect(f.db.db.prepare("SELECT * FROM cost_ledger").all()).toEqual([]);
  const unused = ledger.reserve("run", "evidence-follow-up-search", "exa", null, 0.02);
  ledger.settleUncertain("run", "Legacy allowance has no receipt linkage");
  expect(f.db.db.prepare("SELECT status FROM cost_ledger WHERE id=?").get(unused.id)).toEqual({ status: "committed" });
});
