import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { ResearchEngine } from "../../src/core/research-engine";
import { configurePromptPaths } from "../../src/core/prompts";
import { DatabaseClient } from "../../src/db/client";
import { ResearchRunRepository } from "../../src/db/repositories/research-runs";
import { WorkflowExecution } from "../../src/core/workflow-execution";
import type { Source } from "../../src/shared/schemas";
import type { GenerationAcceptanceMetadata, StructuredModelClient } from "../../src/providers/structured";
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

test("a cancelled search cannot save over its replacement's checkpoint", async () => {
  const db = database();
  try {
    const runId = new ResearchRunRepository(db).create("thread", config).runId;
    const pending: Array<(sources: Source[]) => void> = [];
    const search = new WorkflowExecution(db, runId).search({ provider: "exa", search: () => new Promise(resolve => pending.push(resolve)) });
    const abort = new AbortController();
    const old = search.search("parts", { signal: abort.signal });
    abort.abort();
    const resumed = search.search("parts");
    const source = { id: "new", url: "https://source.example/parts", title: "Parts", text: "New evidence" };
    pending[0]!([{ ...source, id: "old" }]);
    await expect(old).rejects.toThrow();
    pending[1]!([source]);
    expect(await resumed).toEqual([source]);
    expect(await search.search("parts")).toEqual([source]);
  } finally { db.close(); }
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
        queries: [1, 2, 3].map(index => ({ query: `${request.stage} query ${index}`, uncertainty: "How often parts arrive late", intendedSourceType: "Delivery records" })),
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
    expect(searches).toBe(6);
    expect(peakConcurrent).toBe(provider === "exa" ? 2 : 1);
  } finally {
    await engine.shutdown();
    db.close();
  }
});
