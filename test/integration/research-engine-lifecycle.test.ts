import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { ResearchEngine } from "../../src/core/research-engine";
import { configurePromptPaths } from "../../src/core/prompts";
import { DatabaseClient } from "../../src/db/client";
import { CostLedgerRepository } from "../../src/db/repositories/cost-ledger";
import { ResearchRunRepository } from "../../src/db/repositories/research-runs";
import { GenerationAttemptRepository } from "../../src/db/repositories/generation-attempts";
import { ResearchFrameRepository } from "../../src/db/repositories/research-frames";
import { WorkflowRepository } from "../../src/db/repositories/workflows";
import { streamRestarts, WorkflowExecution } from "../../src/core/workflow-execution";
import { UnknownSearchCompletionError, unknownSearchAttempts } from "../../src/core/workflow-search-attempts";
import type { Source } from "../../src/shared/schemas";
import { ProviderFailure, type GenerationAcceptanceMetadata, type StructuredModelClient } from "../../src/providers/structured";
import type { ResearchFrame } from "../../src/shared/research-frame";
import type { SearchOptions } from "../../src/providers/search";
import { RunConfigSchema } from "../../src/shared/schemas";
import { join } from "node:path";

const config = RunConfigSchema.parse({
  configVersion: 2, workflowVersion: 2, searchProvider: "exa",
  model: { providerId: "fixture", modelId: "fixture" },
  reasoningEffort: "low", discoveryDepth: "quick", maxRunMinutes: 5,
});
const scope = { title: "Parts", audience: "Repair shops", domain: "Parts", observations: "", offLimits: [] };
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    try { rmSync(directory, { recursive: true, force: true }); }
    catch { /* SQLite may retain WAL handles briefly on Windows. */ }
  }
});

function database() {
  configurePromptPaths({ bundledDir: join(process.cwd(), "prompts"), overrideDir: null });
  const directory = mkdtempSync(join(tmpdir(), "scraply-lifecycle-"));
  directories.push(directory);
  const db = new DatabaseClient(join(directory, "test.db"));
  const now = new Date().toISOString();
  db.db.prepare("INSERT INTO threads (id,title,status,created_at,updated_at) VALUES ('thread','Parts','configuring',?,?)").run(now, now);
  return db;
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}

test.each(["old-first", "replacement-first"] as const)("a cancelled search cannot save over its replacement's checkpoint (%s)", async settlement => {
  const db = database();
  try {
    const runId = new ResearchRunRepository(db).create("thread", config).runId;
    const pending: Array<(sources: Source[]) => void> = [];
    const client = { provider: "exa" as const, search: () => new Promise<Source[]>(resolve => pending.push(resolve)) };
    const search = new WorkflowExecution(db, runId).search(client);
    const abort = new AbortController();
    const old = search.search("parts", { signal: abort.signal });
    const oldOutcome = old.then(sources => ({ sources }), (error: unknown) => ({ error }));
    expect(pending).toHaveLength(1);
    abort.abort();
    const resumed = search.search("parts");
    expect(pending).toHaveLength(2);
    const source = { id: "new", url: "https://source.example/parts", title: "Parts", text: "New evidence" };
    if (settlement === "old-first") {
      pending[0]!([{ ...source, id: "old" }]);
      expect(await oldOutcome).toMatchObject({ error: { name: "AbortError" } });
    }
    // The old operation's finally must not remove the live replacement and allow a third paid dispatch.
    const joined = search.search("parts");
    expect(pending).toHaveLength(2);
    pending[1]!([source]);
    expect(await resumed).toEqual([source]);
    expect(await joined).toEqual([source]);
    if (settlement === "replacement-first") {
      // Resolve the canceled provider after the replacement's result is already durable.
      pending[0]!([{ ...source, id: "old" }]);
      expect(await oldOutcome).toMatchObject({ error: { name: "AbortError" } });
    }
    expect(await search.search("parts")).toEqual([source]);
    expect(pending).toHaveLength(2);
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM workflow_snapshots WHERE research_run_id = ? AND snapshot_key LIKE 'search-attempt:%'").get(runId))
      .toEqual({ count: 2 });
  } finally { db.close(); }
});

test("a reopened execution requires the interrupted search's exact UUID before replacement dispatch", async () => {
  const db = database();
  let reopened: DatabaseClient | undefined;
  try {
    const runId = new ResearchRunRepository(db).create("thread", config).runId;
    const pending: Array<(sources: Source[]) => void> = [];
    const client = { provider: "exa" as const, search: () => new Promise<Source[]>(resolve => pending.push(resolve)) };
    const abort = new AbortController();
    const old = new WorkflowExecution(db, runId).search(client).search("parts", { signal: abort.signal });
    const oldOutcome = old.then(sources => ({ sources }), (error: unknown) => ({ error }));
    const original = unknownSearchAttempts(db, runId)[0]!;
    const path = (db.db.prepare("PRAGMA database_list").get() as { file: string }).file;
    reopened = new DatabaseClient(path);
    await expect(new WorkflowExecution(reopened, runId).search(client).search("parts")).rejects.toBeInstanceOf(UnknownSearchCompletionError);
    await expect(new WorkflowExecution(reopened, runId, ["unrelated-attempt"]).search(client).search("parts"))
      .rejects.toBeInstanceOf(UnknownSearchCompletionError);
    expect(pending).toHaveLength(1);
    const replacement = new WorkflowExecution(reopened, runId, [original.id]).search(client);
    const resumed = replacement.search("parts");
    expect(pending).toHaveLength(2);
    abort.abort();
    const source = { id: "new", url: "https://source.example/parts", title: "Parts", text: "Replacement evidence" };
    pending[1]!([source]);
    expect(await resumed).toEqual([source]);
    pending[0]!([{ ...source, id: "old" }]);
    expect(await oldOutcome).toMatchObject({ error: { name: "AbortError" } });
    expect(await replacement.search("parts")).toEqual([source]);
    expect(pending).toHaveLength(2);
    expect(reopened.db.prepare("SELECT COUNT(*) AS count FROM workflow_snapshots WHERE research_run_id = ? AND snapshot_key LIKE 'search-attempt:%'").get(runId))
      .toEqual({ count: 2 });
    expect(reopened.db.prepare("SELECT snapshot_key FROM workflow_snapshots WHERE research_run_id = ? AND snapshot_key = ?")
      .get(runId, `search-acknowledged:${original.id}`)).toEqual({ snapshot_key: `search-acknowledged:${original.id}` });
  } finally { reopened?.close(); db.close(); }
});

function deferredIdentity() {
  let resolve!: (value: GenerationAcceptanceMetadata) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<GenerationAcceptanceMetadata>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test.each(["resolve", "reject"] as const)("cancel/resume survives old identity initialization %s", async (settlement) => {
  const db = database();
  const identities: ReturnType<typeof deferredIdentity>[] = [];
  let dispatched = 0;
  const client: StructuredModelClient = {
    prepareIdentity() {
      const identity = deferredIdentity();
      identities.push(identity);
      return identity.promise;
    },
    async structuredCompletion(request) {
      dispatched++;
      request.onDispatched?.();
      request.onAccepted?.({});
      return { output: request.schema.parse({ options: [] }), metadata: {
        model: config.model, prompt: { id: "fixture", sha256: "a".repeat(64) },
        usage: { status: "unknown" }, latencyMs: 0, repairCount: 0, providerRequestIds: [], attempts: [],
      } };
    },
  };
  const engine = new ResearchEngine({ db, modelClients: { fixture: client }, onEvent() {} });
  try {
    const runId = await engine.startKnownProblem("thread", scope, "Parts arrive late", config);
    await until(() => identities.length === 1);
    engine.cancelRun(runId);
    await engine.resumeRun(runId);
    await until(() => identities.length === 2);
    if (settlement === "resolve") identities[0]!.resolve({});
    else identities[0]!.reject(new Error("Old initialization failed"));
    await Bun.sleep(30);
    expect(engine.getActiveRunIds().has(runId)).toBe(true);
    expect(dispatched).toBe(0);
    expect(db.db.prepare("SELECT status FROM research_runs WHERE id = ?").get(runId)).toEqual({ status: "running" });
    identities[1]!.resolve({});
    await until(() => !engine.getActiveRunIds().has(runId));
    expect(dispatched).toBe(1);
    expect(db.db.prepare("SELECT status FROM research_runs WHERE id = ?").get(runId)).toEqual({ status: "completed" });
  } finally {
    for (const identity of identities) identity.reject(new Error("Test cleanup"));
    await engine.shutdown();
    db.close();
  }
});

test.each([{ drops: 1, unrelated: false }, { drops: 1, unrelated: true }, { drops: 3, unrelated: true }])(
  "research acknowledges exact drops after rate-limit replacement and keeps other areas running (%s)", async ({ drops, unrelated }) => {
    const db = database();
    const pauses = streamRestarts.pausesMs;
    streamRestarts.pausesMs = [1, 1];
    const runConfig = { ...config, discoveryDepth: "standard" as const };
    const frame: ResearchFrame = { goal: "Reduce late parts", goalKind: "process-improvement", contextFacts: [],
      successCriteria: [{ id: "timely", name: "Parts arrive on time", weight: "must", howJudged: "Check delivery records", basis: "brief" }],
      constraints: [], languages: ["en"], exclusions: [], openQuestions: [],
      areas: ["ordering", "delivery"].map((id, index) => ({ id, name: id, affectedPeople: "Repair shops", whyRelevant: "Late parts",
        venues: [{ name: "Shop reports", kind: "publication" }], exampleProblems: [], included: true, priority: index + 1 })) };
    const frameRun = new ResearchRunRepository(db).create("thread", runConfig).runId;
    const frames = new ResearchFrameRepository(db);
    const draft = frames.createDraft({ threadId: "thread", runId: frameRun, knownProblem: false, frame, sources: [] });
    frames.approve(draft.id, "thread", draft.draft);
    db.db.prepare("UPDATE research_runs SET status = 'completed' WHERE id = ?").run(frameRun);
    const workflows = new WorkflowRepository(db);
    const item = db.immediateTransaction(() => {
      workflows.createSession({ id: "retry-session", threadId: "thread", purpose: "discovery", mode: "babysit", remainingMs: 300_000,
        contract: { contractVersion: 1, frameWorkflowVersion: 1, purpose: "discovery", mode: "babysit", brief: "Reduce late parts", scope,
          runConfig, targets: { kind: "project", ideaCount: 1 }, limits: { enforced: false, maxMinutes: 5, maxModelCalls: 100, maxSearches: 100 },
          instructions: {}, resolvedInstructions: { research: "", ideas: "", review: "" }, instructionHashes: { research: "r", ideas: "i", review: "v" } } });
      return workflows.createWorkItem({ sessionId: "retry-session", kind: "discovery", scopeKey: "discovery", state: "ready", input: {} });
    });
    const calls: Array<{ stage: string; generationId: string }> = [];
    const errors: string[] = [];
    let targetCalls = 0;
    let unrelatedAttemptId: string | undefined;
    const client: StructuredModelClient = { async structuredCompletion(request) {
      calls.push({ stage: request.stage, generationId: request.generationId });
      if (request.stage === "area-gap:ordering") {
        targetCalls++;
        if (targetCalls === 1) throw new ProviderFailure("rate-limit", "Rate limit reached", true);
        const dropped = new ProviderFailure("interrupted", "Stream dropped", false, { attempts: [{
          attempt: "initial", outcome: "failed", providerCompletion: "unknown", model: config.model,
          usage: { status: "unknown" }, cost: { status: "unknown" }, latencyMs: 1,
        }] });
        if (unrelated && !unrelatedAttemptId) {
          const owner = db.db.prepare("SELECT research_run_id FROM generation_attempts WHERE generation_id = ?").get(request.generationId) as { research_run_id: string };
          const attempts = new GenerationAttemptRepository(db);
          const other = attempts.prepare(owner.research_run_id, { ...request, generationId: "unrelated-generation", stage: "unrelated-probe" });
          attempts.markDispatched(other.id);
          attempts.recordTerminal(other.id, { status: "interrupted", terminalKind: "interrupted", attemptMetadata: { attempts: dropped.attempts } });
          unrelatedAttemptId = other.id;
        }
        if (targetCalls <= drops + 1) {
          request.onDispatched?.(); request.onAccepted?.({});
          throw dropped;
        }
      }
      request.onDispatched?.(); request.onAccepted?.({});
      const stage = request.stage.split(":")[0];
      const inputs = request.workOrder.inputs as { routing: { queryCount?: number } };
      const packet = request.evidence[0]?.content as { sources?: Array<{ id: string }> } | undefined;
      const output = stage === "query-plan" ? { queries: Array.from({ length: inputs.routing.queryCount ?? 1 }, (_, index) => ({
        query: `${request.stage} parts ${index}`, intent: "firsthand-experience", uncertainty: "Delivery frequency", intendedSourceType: "Shop reports" })) }
        : stage === "factor-harvest" ? { factors: packet!.sources!.map(source => ({ sourceId: source.id, subject: "Repair shop",
          behavior: "Waits for parts", quote: "Parts arrive late.", modelConfidence: 0.8, uncertainty: "Frequency unknown",
          sourceRole: "firsthand", audienceFit: "intended-buyer", independentSourceKey: source.id, supportsDemand: false, demandEvidenceUncertainty: "Payment unknown" })) }
        : stage === "area-ranking" ? { areas: frame.areas.map((area, index) => ({ areaId: area.id, rank: index + 1,
          reason: "Shop reports", evidenceStrength: "strong", fit: "meets" })) }
        : stage === "problem-candidates" ? { problems: [] }
        : stage === "area-gap" ? { reason: "No additional evidence gap", gaps: [] } : null;
      if (!output) throw new Error(`Unexpected stage ${request.stage}`);
      return { output: request.schema.parse(output), metadata: { model: config.model, prompt: { id: "fixture", sha256: "a".repeat(64) },
        usage: { status: "unknown" }, latencyMs: 0, repairCount: 0, providerRequestIds: [], attempts: [] } };
    } };
    const engine = new ResearchEngine({ db, modelClients: { fixture: client }, rateLimitPausesMs: [1, 1],
      searchClients: { exa: { provider: "exa", async validateKey() { return { valid: true }; }, async search(query) {
        return [{ id: query, url: `https://shops.example/${encodeURIComponent(query)}`, title: "Shop report", text: "Parts arrive late." }];
      } } }, onEvent(event) { if (event.type === "run-failed") errors.push(event.error); } });
    try {
      const runId = await engine.startDiscovery("thread", scope, runConfig, { sessionId: "retry-session", frameId: draft.id, purpose: "discovery",
        onRunCreated(id) { db.immediateTransaction(() => workflows.updateWorkItem(item.id, "running", { outputRefs: { runId: id } })); return true; } });
      await until(() => !engine.getActiveRunIds().has(runId));
      expect(errors).toEqual([]);
      expect(db.db.prepare("SELECT status FROM research_runs WHERE id = ?").get(runId)).toEqual({ status: "completed" });
      const lost = db.db.prepare(`SELECT id, generation_id AS generationId, usage_json AS usage FROM generation_attempts
        WHERE research_run_id = ? AND stage_key = 'area-gap:ordering' AND status = 'interrupted' ORDER BY rowid`)
        .all(runId) as Array<{ id: string; generationId: string; usage: string }>;
      const audits = db.db.prepare(`SELECT snapshot_key AS key, value_json AS value FROM workflow_snapshots
        WHERE research_run_id = ? AND snapshot_key LIKE 'acknowledged-retry:stream-restart:%' ORDER BY rowid`)
        .all(runId) as Array<{ key: string; value: string }>;
      expect(lost).toHaveLength(drops);
      expect(audits).toEqual(lost.slice(0, 2).map(attempt => ({ key: `acknowledged-retry:stream-restart:${attempt.generationId}`,
        value: JSON.stringify({ attemptIds: [attempt.id] }) })));
      expect(lost.map(attempt => JSON.parse(attempt.usage))).toEqual(Array.from({ length: drops }, () => [{ status: "unknown" }]));
      expect(targetCalls).toBe(drops === 1 ? 3 : 4);
      expect(calls.filter(call => call.stage === "area-gap:delivery")).toHaveLength(1);
      expect(new CostLedgerRepository(db).countProviderCalls(runId, "fixture")).toBe(calls.length - 1);
      if (unrelated) {
        expect(workflows.acknowledgedAttemptIds(runId)).not.toContain(unrelatedAttemptId!);
        expect(workflows.hasUnknownProviderCompletion(runId)).toBe(true);
      } else expect(workflows.hasUnknownProviderCompletion(runId)).toBe(false);
      if (drops === 3) {
        expect(audits.flatMap(row => JSON.parse(row.value).attemptIds)).not.toContain(lost[2]!.id);
        // Stopping an area records its abandonment separately from authorizing a stream restart.
        expect(new WorkflowExecution(db, runId).read<{ reason: string }>("research-target-outcome")!.reason)
          .toContain("Research in ordering stopped early because a model call failed");
      }
    } finally {
      streamRestarts.pausesMs = pauses;
      await engine.shutdown();
      db.close();
    }
  },
);

test.each(["exa", "perplexity"] as const)("%s discovery retains provider concurrency through engine instrumentation", async (provider) => {
  const db = database();
  let searches = 0;
  let concurrent = 0;
  let peakConcurrent = 0;
  const client: StructuredModelClient = {
    async structuredCompletion(request) {
      const stage = request.stage.split(":")[0];
      const output = stage === "query-plan" ? {
        queries: [1, 2, 3].map(index => ({ query: `${request.stage} query ${index}`,
          intent: ["firsthand-experience", "measured-behavior", "current-alternative"][index - 1],
          uncertainty: "How often parts arrive late", intendedSourceType: "Delivery records" })),
      } : stage === "factor-harvest" ? { factors: [] } : { problems: [] };
      request.onDispatched?.();
      request.onAccepted?.({});
      return { output: request.schema.parse(output), metadata: {
        model: config.model, prompt: { id: "fixture", sha256: "a".repeat(64) },
        usage: { status: "unknown" }, latencyMs: 0, repairCount: 0, providerRequestIds: [], attempts: [],
      } };
    },
  };
  const engine = new ResearchEngine({ db, modelClients: { fixture: client },
    searchClients: { [provider]: { provider, async validateKey() { return { valid: true }; }, async search() {
      const id = ++searches;
      concurrent++;
      peakConcurrent = Math.max(peakConcurrent, concurrent);
      await Bun.sleep(20);
      concurrent--;
      return [{ id: `source-${id}`, url: `https://source${id}.example/parts`, title: "Parts", text: "Parts arrive late." }];
    } } }, onEvent() {} });
  try {
    const runId = await engine.startDiscovery("thread", scope, { ...config, searchProvider: provider });
    await until(() => !engine.getActiveRunIds().has(runId));
    expect(db.db.prepare("SELECT status FROM research_runs WHERE id = ?").get(runId)).toEqual({ status: "completed" });
    expect(searches).toBe(8);
    expect(peakConcurrent).toBe(provider === "exa" ? 2 : 1);
  } finally {
    await engine.shutdown();
    db.close();
  }
});

test.each([true, false])("automatic discovery accounts for both providers with Exa readiness %s", async (exaReady) => {
  const db = database();
  const calls = { exa: 0, perplexity: 0 };
  const routes: Array<{ provider: string; route?: string }> = [];
  const client: StructuredModelClient = {
    async structuredCompletion(request) {
      const stage = request.stage.split(":")[0];
      const output = stage === "query-plan" ? {
        queries: ["firsthand-experience", "measured-behavior", "current-alternative"].map(intent => ({
          query: `${request.stage} ${intent}`, intent,
          uncertainty: "Delivery behavior", intendedSourceType: "Delivery reports",
        })),
      } : stage === "factor-harvest" ? { factors: [] } : { problems: [] };
      request.onDispatched?.();
      request.onAccepted?.({});
      return { output: request.schema.parse(output), metadata: {
        model: config.model, prompt: { id: "fixture", sha256: "a".repeat(64) },
        usage: { status: "unknown" }, latencyMs: 0, repairCount: 0, providerRequestIds: [], attempts: [],
      } };
    },
  };
  const searchClients = Object.fromEntries((["exa", "perplexity"] as const).map(provider => [provider, {
    provider, async validateKey() { return { valid: true }; }, async search(_query: string, options?: SearchOptions) {
      calls[provider] += 1;
      routes.push({ provider, ...(options?.route ? { route: options.route } : {}) });
      return [];
    },
  }]));
  const engine = new ResearchEngine({ db, modelClients: { fixture: client }, searchClients,
    searchReady: () => ({ exa: exaReady, perplexity: true }), onEvent() {} });
  try {
    const runId = await engine.startDiscovery("thread", scope, { ...config, searchProvider: "auto" });
    await until(() => !engine.getActiveRunIds().has(runId));
    expect(db.db.prepare("SELECT status FROM research_runs WHERE id = ?").get(runId)).toEqual({ status: "completed" });
    expect(calls).toEqual(exaReady ? { exa: 4, perplexity: 4 } : { exa: 0, perplexity: 8 });
    expect(routes.filter(route => route.route === "community").map(route => route.provider)).toEqual([exaReady ? "exa" : "perplexity", exaReady ? "exa" : "perplexity"]);
    const ledger = new CostLedgerRepository(db);
    expect(ledger.countProviderCalls(runId, "exa")).toBe(calls.exa);
    expect(ledger.countProviderCalls(runId, "perplexity")).toBe(calls.perplexity);
  } finally {
    await engine.shutdown();
    db.close();
  }
});
