import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { ResearchEngine } from "../../src/core/research-engine";
import { configurePromptPaths } from "../../src/core/prompts";
import { DatabaseClient } from "../../src/db/client";
import { CostLedgerRepository } from "../../src/db/repositories/cost-ledger";
import { ResearchRunRepository } from "../../src/db/repositories/research-runs";
import { WorkflowExecution } from "../../src/core/workflow-execution";
import { UnknownSearchCompletionError, unknownSearchAttempts } from "../../src/core/workflow-search-attempts";
import type { Source } from "../../src/shared/schemas";
import type { GenerationAcceptanceMetadata, StructuredModelClient } from "../../src/providers/structured";
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
