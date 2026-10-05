import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizeRunUsage } from "../../src/backend/run-usage";
import { configurePromptPaths } from "../../src/core/prompts";
import { ResearchEngine } from "../../src/core/research-engine";
import { materializeResearchSnapshot } from "../../src/core/research-revisions";
import { WorkflowCoordinator } from "../../src/core/workflow-coordinator";
import { WorkflowModelScheduler } from "../../src/core/workflow-scheduler";
import { DatabaseClient } from "../../src/db/client";
import { DiscoveryRepository } from "../../src/db/repositories/discovery";
import { WorkflowRepository } from "../../src/db/repositories/workflows";
import { ProviderFailure, type StructuredModelClient, type StructuredStageRequest } from "../../src/providers/structured";
import { sha256 } from "../../src/shared/content-identity";
import { ProblemCandidateSchema, type ResearchEvent } from "../../src/shared/ipc";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    try { rmSync(directory, { recursive: true, force: true }); }
    catch { /* Bun can retain a SQLite WAL handle briefly on Windows. */ }
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(1);
  expect(predicate()).toBe(true);
}

type WriterTerminal = "cancelled" | "unknown" | "process-lost" | "completed";
const model = { providerId: "fixture", modelId: "fixture-model" };

// Real scheduling, engine, coordinator and accounting. Provider terminals wait until the test releases them.
async function fixture(problemCount = 1, capacity = 1) {
  const directory = mkdtempSync(join(tmpdir(), "scraply-stop-accounting-"));
  directories.push(directory);
  configurePromptPaths({ bundledDir: join(process.cwd(), "prompts"), overrideDir: join(directory, "prompts") });
  const db = new DatabaseClient(join(directory, "test.db"));
  const repository = new WorkflowRepository(db);
  const scheduler = new WorkflowModelScheduler(capacity);
  const now = new Date().toISOString();
  const config = { ...DEFAULT_RUN_CONFIG, model, workflowVersion: 2 as const, ideaCount: 1, explorationPurpose: "general-solutions" as const };
  const scope = { title: "Filing", audience: "Shop owners", domain: "Invoices", observations: "Weekly delays", offLimits: [] };
  db.db.prepare("INSERT INTO threads (id,title,status,created_at,updated_at) VALUES ('project','Filing','researching',?,?)").run(now, now);
  const session = db.immediateTransaction(() => repository.createSession({ id: "session", threadId: "project", purpose: "discovery", mode: "babysit",
    remainingMs: 60 * 60_000, contract: { contractVersion: 1, ideaWorkflowVersion: 2, purpose: "discovery", mode: "babysit", brief: "Research filing", scope,
      runConfig: config, ideas: { model, reasoningEffort: "medium" }, targets: { kind: "per-problem", ideaCount: 1 },
      limits: { enforced: false, maxMinutes: 60, maxModelCalls: 100, maxSearches: 50 }, instructions: {},
      resolvedInstructions: { research: "", ideas: "", review: "" }, instructionHashes: { research: "r", ideas: "i", review: "v" } } }));
  db.db.prepare(`INSERT INTO research_runs (id,thread_id,status,config_json,workflow_version,workflow_session_id,purpose,created_at,updated_at)
    VALUES ('source','project','completed',?,2,'session','discovery',?,?)`).run(JSON.stringify(config), now, now);
  const discovery = new DiscoveryRepository(db);
  discovery.persistScope("source", scope);
  const quote = "I repeat filing every week.";
  const factor = { id: "factor", sourceId: "source-quote", subject: "Shop owner", behavior: "Repeats filing", quote, harvestMode: "domain" as const,
    modelConfidence: 0.8, sourceRole: "firsthand" as const, audienceFit: "intended-buyer" as const, independentSourceKey: "shop-owner" };
  discovery.persistFactors("source", [{ id: "source-quote", providerSourceId: null, canonicalUrl: "https://owners.example/filing", title: "Owner account",
    retrievedText: quote, author: null, publishedAt: null, contentHash: sha256(quote), retrievedAt: now }], [{ ...factor, supportsDemand: false }]);
  const problemIds = Array.from({ length: problemCount }, (_, index) => `problem-${index + 1}`);
  const problem = (id: string, index: number) => ({ id, statement: `Owners repeat filing step ${index + 1}`, whyItPersists: "Disconnected tools",
    affected: "Shop owners", scaleEstimate: "Weekly", verdict: "confirmed" as const, verdictReason: "Owner account",
    intendedBuyerEvidenceFactorIds: ["factor"], evidenceGap: null });
  discovery.persistProblems("source", [], problemIds.map((id, index) => ({ ...problem(id, index), scaleBasisFactorId: "factor", factorIds: ["factor"],
    verdictSourceIds: ["source-quote"] })));
  const candidates = problemIds.map((id, index) => ProblemCandidateSchema.parse({ ...problem(id, index), selected: false, briefFit: "direct",
    contraryEvidence: "resolved", singleHarvestModeWarning: false, developmentCompleted: false,
    factors: [{ ...factor, sourceTitle: "Owner account", sourceUrl: "https://owners.example/filing" }] }));
  const gates = problemIds.map(() => deferred<WriterTerminal>());
  const calls: string[] = [];
  const signals: AbortSignal[] = [];
  const client: StructuredModelClient = { async structuredCompletion<T>(request: StructuredStageRequest<T>) {
    calls.push(request.stage);
    if (request.stage !== "solutions") throw new Error("Stopped writers must never start a ranker");
    const index = signals.length;
    signals.push(request.signal!);
    request.onDispatched?.(); request.onAccepted?.({});
    const terminal = await gates[index]!.promise;
    if (terminal === "process-lost") throw new ProviderFailure("interrupted", "Fixture lost its runtime process", false);
    const attempt = { attempt: "initial" as const, outcome: terminal === "completed" ? "completed" as const : "cancelled" as const,
      providerCompletion: terminal === "unknown" ? "unknown" as const : "confirmed" as const, model,
      usage: terminal === "unknown" ? { status: "unknown" as const } : { status: "known" as const, value: { inputTokens: 40, outputTokens: 2, totalTokens: 42 } },
      cost: { status: "not_reported" as const }, latencyMs: 5 };
    if (terminal !== "completed") throw new ProviderFailure(terminal === "unknown" ? "interrupted" : "cancelled", "Fixture cancellation terminal", false, { attempts: [attempt] });
    const output = { options: [{ mechanism: "Filing helper", description: "A filing checklist", keyAssumption: "Owners try it",
      whyCurrentApproachMaySuffice: "Manual work may do", supportingEvidenceIds: [], contraryEvidenceIds: [], unknowns: ["Frequency"],
      respectsOffLimits: true, respectsOffLimitsWhy: "Within limits" }] };
    return { output: request.schema.parse(output), metadata: { model, prompt: { id: "fixture", sha256: "a".repeat(64) },
      usage: attempt.usage, latencyMs: 5, repairCount: 0, providerRequestIds: [], attempts: [attempt] } };
  } };
  const events: ResearchEvent[] = [];
  const engine = new ResearchEngine({ db, modelScheduler: scheduler, modelClients: { fixture: client }, onEvent(event) {
    events.push(event);
    void Promise.resolve().then(() => coordinator.handleRunEvent(event));
  } });
  const coordinator = new WorkflowCoordinator({ db, engine: () => engine, listProblems: () => candidates, onProgress() {},
    capabilities: async () => ({ nativeConnected: true, searchReady: { exa: true, perplexity: false },
      modelOptions: [{ ...model, displayName: "Fixture", defaultReasoningEffort: "medium", reasoningEfforts: [{ id: "medium", description: "Default" }] }] }) });
  const snapshot = db.immediateTransaction(() => {
    const copied = materializeResearchSnapshot(db, { threadId: "project", baseRunId: "source", sourceProblemIds: problemIds, sessionId: session.id });
    const saved = repository.createSnapshot({ sessionId: session.id, materializationRunId: copied.runId, selection: { problemIds: copied.problemIds }, originMap: copied.originMap });
    repository.updateSession(session.id, session.revision, { state: "waiting-for-review", activeSnapshotId: saved.id, runningSince: null });
    return saved;
  });
  await coordinator.command({ threadId: "project", sessionId: session.id, clientCommandId: "generate", expectedRevision: coordinator.summary(session.id).revision,
    action: { type: "generate-ideas", snapshotId: snapshot.id, problemIds: snapshot.selection.problemIds, model, reasoningEffort: "medium", target: { kind: "per-problem", count: 1 } } });
  await until(() => signals.length === Math.min(problemCount, capacity));
  const state = () => repository.getSession(session.id)!;
  const tasks = () => repository.listWorkItems(session.id).filter(item => item.kind === "generate-ideas");
  const usage = () => summarizeRunUsage(db.db.prepare(`SELECT status, terminal_kind, provider_id, model_id, attempt_metadata_json, usage_json
    FROM generation_attempts ORDER BY created_at,rowid`).all() as Parameters<typeof summarizeRunUsage>[0]);
  return { db, repository, scheduler, engine, calls, signals, gates, events, state, tasks, usage,
    async stop() {
      await coordinator.command({ threadId: "project", sessionId: session.id, clientCommandId: "stop", expectedRevision: state().revision, action: { type: "stop" } });
      await Bun.sleep(1);
    },
    async close() {
      for (const gate of gates) gate.resolve("cancelled");
      await engine.shutdown();
      db.close();
    },
  };
}

test("Stop waits for confirmed writer cancellation and keeps its known usage without starting the ranker", async () => {
  const f = await fixture();
  try {
    await f.stop();
    expect(f.state().state).toBe("stop-requested");
    expect(f.events.filter(event => event.type === "run-cancelled")).toEqual([]);
    expect(f.scheduler.activeCallCount).toBe(1);
    expect(f.engine.getActiveRunIds().size).toBe(0);
    expect(f.engine.hasActiveWork()).toBe(true);
    f.gates[0]!.resolve("cancelled");
    await until(() => f.state().state === "finished");
    expect(f.state().outcome).toBe("cancelled");
    expect(f.tasks().map(item => item.state)).toEqual(["cancelled"]);
    expect(f.calls).toEqual(["solutions"]);
    expect(f.usage()).toMatchObject({ attemptCount: 1, unknownAttemptCount: 0, tokens: { total: { known: 42, unknownAttempts: 0 } } });
    expect(f.repository.getBudgetTotals("session").modelCalls).toMatchObject({ spent: 1, reserved: 0, uncertain: 0 });
    expect(f.db.db.prepare("SELECT status FROM generation_attempts").all()).toEqual([{ status: "cancelled" }]);
    expect(f.db.db.prepare("SELECT COUNT(*) AS count FROM solutions").get()).toEqual({ count: 0 });
    expect(f.scheduler.activeCallCount).toBe(0);
    await until(() => !f.engine.hasActiveWork());
  } finally { await f.close(); }
});

test.each(["unknown", "process-lost"] as const)("Stop keeps a genuinely %s completion reviewable", async terminal => {
  const f = await fixture();
  try {
    await f.stop();
    expect(f.state().state).toBe("stop-requested");
    f.gates[0]!.resolve(terminal);
    await until(() => f.state().state === "finished");
    expect(f.state().outcome).toBe("needs-attention");
    expect(f.tasks().map(item => item.state)).toEqual(["unknown"]);
    expect(f.usage()).toMatchObject({ attemptCount: 1, unknownAttemptCount: 1 });
    expect(f.calls).toEqual(["solutions"]);
    expect(f.repository.getBudgetTotals("session").modelCalls).toMatchObject({ spent: 0, reserved: 0, uncertain: 2 });
    expect(f.scheduler.activeCallCount).toBe(0);
  } finally { await f.close(); }
});

test("parallel Stop waits for both active writers while the queued sibling never reaches the provider", async () => {
  const f = await fixture(3, 2);
  try {
    await until(() => f.scheduler.pendingCallCount === 1);
    await f.stop();
    expect(f.signals.every(signal => signal.aborted)).toBe(true);
    await until(() => f.tasks().some(item => item.state === "cancelled"));
    expect(f.state().state).toBe("stop-requested");
    expect(f.scheduler.activeCallCount).toBe(2);
    expect(f.scheduler.pendingCallCount).toBe(0);
    f.gates[0]!.resolve("cancelled");
    await until(() => f.scheduler.activeCallCount === 1);
    expect(f.state().state).toBe("stop-requested");
    f.gates[1]!.resolve("cancelled");
    await until(() => f.state().state === "finished");
    expect(f.state().outcome).toBe("cancelled");
    expect(f.tasks().map(item => item.state)).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(f.calls).toEqual(["solutions", "solutions"]);
    expect(f.usage()).toMatchObject({ attemptCount: 2, unknownAttemptCount: 0, tokens: { total: { known: 84, unknownAttempts: 0 } } });
    expect(f.repository.getBudgetTotals("session").modelCalls).toMatchObject({ spent: 2, reserved: 0, uncertain: 0 });
    expect(f.db.db.prepare("SELECT COUNT(*) AS count FROM cost_ledger").get()).toEqual({ count: 2 });
    expect(f.scheduler.activeCallCount).toBe(0);
  } finally { await f.close(); }
});

test("a completed response racing Stop retains receipt usage but saves no ideas or ranking", async () => {
  const f = await fixture();
  try {
    await f.stop();
    f.gates[0]!.resolve("completed");
    await until(() => f.state().state === "finished");
    expect(f.state().outcome).toBe("cancelled");
    expect(f.usage()).toMatchObject({ attemptCount: 1, unknownAttemptCount: 0, tokens: { total: { known: 42, unknownAttempts: 0 } } });
    expect(f.calls).toEqual(["solutions"]);
    expect(f.db.db.prepare("SELECT COUNT(*) AS count FROM solutions").get()).toEqual({ count: 0 });
    expect(f.db.db.prepare("SELECT COUNT(*) AS count FROM stage_results").get()).toEqual({ count: 0 });
    expect(f.repository.getBudgetTotals("session").modelCalls).toMatchObject({ spent: 1, reserved: 0, uncertain: 0 });
  } finally { await f.close(); }
});
