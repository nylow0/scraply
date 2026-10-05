import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ResearchEngine } from "../../src/core/research-engine";
import { configurePromptPaths } from "../../src/core/prompts";
import { WorkflowExecution } from "../../src/core/workflow-execution";
import { WorkflowCoordinator } from "../../src/core/workflow-coordinator";
import { WorkflowModelScheduler } from "../../src/core/workflow-scheduler";
import { DatabaseClient } from "../../src/db/client";
import { CostLedgerRepository } from "../../src/db/repositories/cost-ledger";
import { DiscoveryRepository } from "../../src/db/repositories/discovery";
import { ResearchFrameRepository } from "../../src/db/repositories/research-frames";
import { ResearchRunRepository } from "../../src/db/repositories/research-runs";
import { WorkflowRepository } from "../../src/db/repositories/workflows";
import { ProviderFailure, type GenerationAttemptMetadata, type StructuredModelClient, type StructuredStageRequest } from "../../src/providers/structured";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";
import type { ResearchFrame } from "../../src/shared/research-frame";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(1);
  expect(predicate()).toBe(true);
}

const model = { providerId: "fixture", modelId: "fixture" };
const schema = z.object({ answer: z.string() }).strict();
type Boundary = "task" | "area" | "research";

// A saved coordinator task and real engine instrumentation share the same scheduler as concurrent area stages.
// The private seam isolates queue admission from unrelated search and model output quality.
async function fixture(options: { calls: number; enforced?: boolean; boundary?: Boundary; capacity?: number; schemaFailure?: boolean; publicHarvest?: boolean; preallocatedFollowUp?: boolean; nativeRepair?: boolean }) {
  const directory = mkdtempSync(join(tmpdir(), "scraply-dispatch-budget-"));
  configurePromptPaths({ bundledDir: join(process.cwd(), "prompts"), overrideDir: join(directory, "prompts") });
  const db = new DatabaseClient(join(directory, "test.db"));
  const repository = new WorkflowRepository(db);
  const runs = new ResearchRunRepository(db);
  const scheduler = new WorkflowModelScheduler(options.capacity ?? 1);
  const now = new Date().toISOString();
  const config = { ...DEFAULT_RUN_CONFIG, model, workflowVersion: 2 as const, discoveryDepth: "quick" as const };
  const scope = { title: "Filing", audience: "Owners", domain: "Invoices", observations: "Weekly delays", offLimits: [] };
  db.db.prepare("INSERT INTO threads (id,title,status,created_at,updated_at) VALUES ('project','Filing','researching',?,?)").run(now, now);
  const session = db.immediateTransaction(() => repository.createSession({ id: "session", threadId: "project", purpose: "discovery", mode: "babysit",
    remainingMs: 60 * 60_000, contract: { contractVersion: 1, purpose: "discovery", mode: "babysit", brief: "Research filing",
      scope, runConfig: config,
      ideas: { model, reasoningEffort: "medium" }, targets: { kind: "per-problem", ideaCount: 1 },
      limits: { enforced: options.enforced ?? true, maxMinutes: 60, maxModelCalls: options.calls, maxSearches: 10 },
      instructions: {}, resolvedInstructions: { research: "", ideas: "", review: "" }, instructionHashes: { research: "r", ideas: "i", review: "v" } } }));
  const { runId } = runs.create("project", config, null, randomUUID(), { sessionId: session.id, purpose: "discovery" });
  db.immediateTransaction(() => {
    const task = repository.createWorkItem({ sessionId: session.id, kind: "discovery", scopeKey: "initial", state: "ready", input: {} });
    repository.updateWorkItem(task.id, "running", { outputRefs: { runId } });
    repository.reserveBudget({ sessionId: session.id, workItemId: task.id, kind: "model-call", operationKey: "models", reservedUnits: options.calls });
    if (options.publicHarvest) repository.reserveBudget({ sessionId: session.id, workItemId: task.id, kind: "search", operationKey: "searches", reservedUnits: 10 });
  });
  const wires: string[] = [];
  const failures: string[] = [];
  const terminalGate = deferred();
  const attempt = (): GenerationAttemptMetadata => ({ attempt: "initial", outcome: "completed", providerCompletion: "confirmed", model,
    usage: { status: "known", value: { inputTokens: 40, outputTokens: 2, totalTokens: 42 } },
    cost: { status: "reported", value: { amount: 0, currency: "USD" } }, latencyMs: 1 });
  const base: StructuredModelClient = { async structuredCompletion<T>(request: StructuredStageRequest<T>) {
    request.onDispatched?.();
    // Mirrors NativeRuntime: the synchronous callback can reject admission before the wire write.
    wires.push(request.stage);
    request.onAccepted?.({});
    if (options.schemaFailure && request.stage === "factor-harvest:area-a:first" && wires.filter(stage => stage === request.stage).length === 1) {
      throw new ProviderFailure("schema", "Fixture schema mismatch", false, { attempts: [{ ...attempt(), outcome: "failed" }] });
    }
    await terminalGate.promise;
    const repaired = options.nativeRepair && request.repairPolicy === "one_retry";
    if (repaired) wires.push(request.stage); // Native repair is a second provider call behind the same wire admission.
    const attempts: GenerationAttemptMetadata[] = repaired
      ? [{ ...attempt(), outcome: "failed" }, { ...attempt(), attempt: "schema_repair" }] : [attempt()];
    const count = (request.workOrder.inputs as { routing?: { queryCount?: number } } | undefined)?.routing?.queryCount ?? 3;
    const output = options.publicHarvest ? request.stage.startsWith("query-plan")
      ? { queries: Array.from({ length: count }, (_, index) => ({ query: `Owner filing question ${index}`,
        intent: "current-alternative", uncertainty: "How much owner time is used", intendedSourceType: "Owner accounts" })) }
      : { factors: [] } : { answer: "saved evidence" };
    return { output: request.schema.parse(output), metadata: {
      model, prompt: { id: "fixture", sha256: "a".repeat(64) },
      usage: repaired ? { status: "known" as const, value: { inputTokens: 80, outputTokens: 4, totalTokens: 84 } } : attempt().usage,
      latencyMs: 1,
      repairCount: repaired ? 1 : 0, providerRequestIds: [], attempts,
    } };
  } };
  const engine = new ResearchEngine({ db, modelClients: { fixture: base }, ...(!options.nativeRepair ? { modelScheduler: scheduler } : {}),
    ...(options.publicHarvest ? { searchClients: { exa: { provider: "exa" as const,
      async validateKey() { return { valid: true }; }, async search() {
        return Array.from({ length: 12 }, (_, index) => ({ id: `source-${index}`, url: `https://owner-${index}.example/filing`,
          title: "Owner account", text: "Owners spend an hour filing every week. ".repeat(170).slice(0, 6_000) }));
      } } } } : {}),
    onEvent(event) { if (event.type === "run-failed") failures.push(event.error); queueMicrotask(() => coordinator.handleRunEvent(event)); } });
  const active = { runId, threadId: "project", problemId: null, config, abortController: new AbortController(), startedAt: Date.now(),
    projectedCodexCalls: 100, projectedSearches: 0,
    followUpModelReservation: options.preallocatedFollowUp ? new CostLedgerRepository(db).reserve(runId, "evidence-follow-up", "fixture", "fixture", 0) : null,
    followUpSearchReservation: null,
    generationProvenance: new Map<string, string>(),
    ...(options.boundary === "area" ? { areaBudget: { areaId: "area-a", maxModelCalls: 1, maxSearches: 10 } } : {}),
    ...(options.boundary === "research" ? { researchAllowance: { maxModelCalls: 1, maxSearches: 10 } } : {}),
  };
  const client = (engine as unknown as { instrumentedModel: (run: typeof active) => StructuredModelClient }).instrumentedModel(active);
  const coordinator = new WorkflowCoordinator({ db, engine: () => engine, listProblems: () => [], onProgress() {},
    capabilities: async () => ({ nativeConnected: true, searchReady: { exa: true, perplexity: false },
      modelOptions: [{ ...model, displayName: "Fixture", defaultReasoningEffort: "medium", reasoningEfforts: [{ id: "medium", description: "Default" }] }] }) });
  const blockers = Array.from({ length: options.capacity ?? 1 }, () => deferred());
  const blocked = Promise.all(blockers.map(gate => scheduler.schedule("other-project", async () => gate.promise)));
  await until(() => scheduler.activeCallCount === blockers.length);
  const request = (name: string, repairPolicy: "disabled" | "one_retry" = "disabled"): StructuredStageRequest<z.infer<typeof schema>> => ({
    generationId: randomUUID(), stage: `factor-harvest:area-a:${name}`, model, reasoningEffort: "medium", repairPolicy,
    workOrder: { stage: "factor-harvest", instruction: name, goal: "Read saved evidence", definitionOfDone: ["One answer"] },
    evidence: [], schema, jsonSchema: { type: "object" }, signal: active.abortController.signal,
  });
  const start = (name: string, repairPolicy?: "disabled" | "one_retry") => client.structuredCompletion(request(name, repairPolicy))
    .then(value => ({ status: "fulfilled" as const, value }), (error: unknown) => ({ status: "rejected" as const, error }));
  return { db, scheduler, wires, failures, terminalGate, start, runId, coordinator, engine, config, scope,
    ledger: new CostLedgerRepository(db),
    releaseQueue() { for (const gate of blockers) gate.resolve(); },
    settle() {
      runs.finish(runId, "failed", "Fixture stages settled");
      coordinator.handleRunEvent({ type: "run-failed", threadId: "project", runId, error: "Fixture stages settled" });
      return coordinator.summary(session.id);
    },
    async close() {
      active.abortController.abort();
      for (const gate of blockers) gate.resolve();
      terminalGate.resolve();
      await blocked;
      await until(() => scheduler.activeCallCount === 0);
      await engine.shutdown(); db.close();
      try { rmSync(directory, { recursive: true, force: true }); }
      catch { /* Bun may briefly hold SQLite WAL files on Windows. */ }
    },
  };
}

test.each([1, 2])("queued concurrent stages dispatch only the one remaining enforced task call (capacity %s)", async capacity => {
  const f = await fixture({ calls: 1, capacity });
  try {
    const first = f.start("first");
    const second = f.start("second");
    await until(() => f.scheduler.pendingCallCount === 2);
    expect(f.wires).toEqual([]);
    expect(f.ledger.countProviderCalls(f.runId, "fixture")).toBe(0);
    expect(f.db.db.prepare("SELECT status FROM generation_attempts").all()).toEqual([{ status: "prepared" }, { status: "prepared" }]);
    f.releaseQueue();
    await until(() => f.wires.length >= 1);
    f.terminalGate.resolve();
    const outcomes = await Promise.all([first, second]);
    expect(f.wires).toEqual(["factor-harvest:area-a:first"]);
    expect(outcomes.map(outcome => outcome.status)).toEqual(["fulfilled", "rejected"]);
    expect(f.ledger.countProviderCalls(f.runId, "fixture")).toBe(1);
    expect(f.db.db.prepare("SELECT terminal_kind FROM generation_attempts WHERE stage_key LIKE '%second'").get()).toEqual({ terminal_kind: "never-dispatched" });
    expect(f.settle().budget.modelCalls).toMatchObject({ spent: 1, reserved: 0, uncertain: 0 });
  } finally { await f.close(); }
});

test("public resume respects a saved enforced allowance when its real harvest reads source batches concurrently", async () => {
  const f = await fixture({ calls: 2, capacity: 2, publicHarvest: true });
  try {
    new DiscoveryRepository(f.db).persistScope(f.runId, f.scope);
    const frame: ResearchFrame = { goal: "Reduce owner filing time", goalKind: "process-improvement", contextFacts: [],
      successCriteria: [{ id: "time", name: "Less filing time", weight: "must", howJudged: "Observe owner filing time", basis: "brief" }],
      constraints: [], languages: ["en"], exclusions: [], openQuestions: [],
      areas: [{ id: "filing", name: "Filing", whyRelevant: "Owner filing work", affectedPeople: "Owners",
        venues: [{ name: "Owner accounts", kind: "community" }], exampleProblems: [], included: true, priority: 1 }] };
    const frames = new ResearchFrameRepository(f.db);
    const saved = frames.createDraft({ threadId: "project", runId: f.runId, frame, sources: [], knownProblem: false });
    frames.approve(saved.id, "project", frame);
    const workflow = new WorkflowExecution(f.db, f.runId);
    workflow.save("frame-workflow", { version: 1 });
    workflow.save("frame-source-venues", { compatibility: "preserve-saved-routing" });
    workflow.save("frame-scan:filing", { areaId: "filing", qualifyingFacts: 0, sources: [], factors: [] });
    workflow.save("frame-selected-areas", frame.areas);
    workflow.save("area:filing:allowance", { areaId: "filing", maxModelCalls: 2, maxSearches: 10 });
    await f.engine.resumeRun(f.runId);
    await until(() => f.scheduler.pendingCallCount === 1 || !f.engine.hasActiveWork());
    expect(f.db.db.prepare("SELECT completion_reason FROM research_runs WHERE id = ?").get(f.runId)).toEqual({ completion_reason: null });
    f.releaseQueue(); f.terminalGate.resolve();
    await until(() => !f.engine.hasActiveWork());
    expect(f.failures).toEqual([]);
    expect(f.wires.filter(stage => stage.startsWith("query-plan"))).toHaveLength(1);
    expect(f.wires.filter(stage => stage.startsWith("factor-harvest"))).toHaveLength(1);
    expect(f.wires).toHaveLength(2);
    expect(f.coordinator.summary("session").budget.modelCalls).toMatchObject({ spent: 2, reserved: 0, uncertain: 0 });
  } finally { await f.close(); }
});

test.each(["area", "research"] as const)("queued stages recheck the remaining %s allowance at physical dispatch", async boundary => {
  const f = await fixture({ calls: 3, boundary });
  try {
    const requests = [f.start("first"), f.start("second")];
    await until(() => f.scheduler.pendingCallCount === 2);
    f.releaseQueue(); f.terminalGate.resolve();
    const outcomes = await Promise.all(requests);
    expect(f.wires).toHaveLength(1);
    expect(outcomes.map(outcome => outcome.status)).toEqual(["fulfilled", "rejected"]);
    expect(f.ledger.countProviderCalls(f.runId, "fixture")).toBe(1);
    expect(f.settle().budget.modelCalls).toMatchObject({ spent: 1, reserved: 0, uncertain: 0 });
  } finally { await f.close(); }
});

test("guidance-only estimates allow both queued stages and charge only physical requests", async () => {
  const f = await fixture({ calls: 1, enforced: false });
  try {
    const requests = [f.start("first"), f.start("second")];
    await until(() => f.scheduler.pendingCallCount === 2);
    expect(f.ledger.countProviderCalls(f.runId, "fixture")).toBe(0);
    f.releaseQueue(); f.terminalGate.resolve();
    expect((await Promise.all(requests)).map(outcome => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(f.wires).toHaveLength(2);
    expect(f.settle().budget.modelCalls).toMatchObject({ spent: 2, reserved: 0, uncertain: 0 });
  } finally { await f.close(); }
});

test("a schema repair cannot overtake the remaining allowance and its first receipt stays charged", async () => {
  const f = await fixture({ calls: 2, schemaFailure: true });
  try {
    const requests = [f.start("first", "one_retry"), f.start("second")];
    await until(() => f.scheduler.pendingCallCount === 2);
    f.releaseQueue(); f.terminalGate.resolve();
    const outcomes = await Promise.all(requests);
    expect(f.wires).toEqual(["factor-harvest:area-a:first", "factor-harvest:area-a:second"]);
    expect(outcomes.map(outcome => outcome.status)).toEqual(["rejected", "fulfilled"]);
    expect(f.ledger.countProviderCalls(f.runId, "fixture")).toBe(2);
    const receipt = f.db.db.prepare("SELECT attempt_metadata_json, usage_json FROM generation_attempts WHERE stage_key LIKE '%first'").get() as {
      attempt_metadata_json: string; usage_json: string;
    };
    expect(JSON.parse(receipt.attempt_metadata_json).attempts).toHaveLength(1);
    expect(JSON.parse(receipt.usage_json)).toEqual([{ status: "known", value: { inputTokens: 40, outputTokens: 2, totalTokens: 42 } }]);
    expect(f.settle().budget.modelCalls).toMatchObject({ spent: 2, reserved: 0, uncertain: 0 });
  } finally { await f.close(); }
});

test("an in-flight repair holds its second physical allowance before terminal metadata is aggregated", async () => {
  const f = await fixture({ calls: 2, schemaFailure: true });
  try {
    const repaired = f.start("first", "one_retry");
    await until(() => f.scheduler.pendingCallCount === 1);
    f.releaseQueue();
    await until(() => f.wires.length === 2);
    const other = f.start("second");
    expect(await other).toMatchObject({ status: "rejected", error: { code: "BUDGET_TOO_SMALL" } });
    expect(f.wires).toEqual(["factor-harvest:area-a:first", "factor-harvest:area-a:first"]);
    f.terminalGate.resolve();
    expect(await repaired).toMatchObject({ status: "fulfilled", value: { metadata: { attempts: expect.any(Array), repairCount: 1 } } });
    expect(f.ledger.countProviderCalls(f.runId, "fixture")).toBe(2);
    expect(f.settle().budget.modelCalls).toMatchObject({ spent: 2, reserved: 0, uncertain: 0 });
  } finally { await f.close(); }
});

test("a preallocated evidence follow-up reservation does not compete with its own physical dispatch", async () => {
  const f = await fixture({ calls: 3, boundary: "research", preallocatedFollowUp: true });
  try {
    const request = f.start("first");
    await until(() => f.scheduler.pendingCallCount === 1);
    f.releaseQueue(); f.terminalGate.resolve();
    expect(await request).toMatchObject({ status: "fulfilled" });
    expect(f.wires).toHaveLength(1);
    expect(f.ledger.countProviderCalls(f.runId, "fixture")).toBe(1);
    expect(f.settle().budget.modelCalls).toMatchObject({ spent: 1, reserved: 0, uncertain: 0 });
  } finally { await f.close(); }
});

test("an unscheduled native schema retry claims two calls while its single dispatch is still in flight", async () => {
  const f = await fixture({ calls: 2, nativeRepair: true });
  try {
    const repaired = f.start("first", "one_retry");
    await until(() => f.wires.length === 1);
    expect(f.ledger.countProviderCalls(f.runId, "fixture")).toBe(1);
    expect(await f.start("second")).toMatchObject({ status: "rejected", error: { code: "BUDGET_TOO_SMALL" } });
    f.terminalGate.resolve();
    expect(await repaired).toMatchObject({ status: "fulfilled", value: { metadata: { repairCount: 1, attempts: [
      { attempt: "initial" }, { attempt: "schema_repair" },
    ] } } });
    expect(f.wires).toEqual(["factor-harvest:area-a:first", "factor-harvest:area-a:first"]);
    expect(f.ledger.countProviderCalls(f.runId, "fixture")).toBe(2);
    expect(f.settle().budget.modelCalls).toMatchObject({ spent: 2, reserved: 0, uncertain: 0 });
  } finally { await f.close(); }
});
