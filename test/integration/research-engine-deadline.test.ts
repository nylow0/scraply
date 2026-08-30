import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResearchEngine } from "../../src/core/research-engine";
import { discoveryRunProjection } from "../../src/core/discovery";
import { DatabaseClient } from "../../src/db/client";
import { CostLedgerRepository } from "../../src/db/repositories/cost-ledger";
import { DiscoveryRepository } from "../../src/db/repositories/discovery";
import { ResearchRunRepository } from "../../src/db/repositories/research-runs";
import type { ExaClient } from "../../src/providers/exa";
import type { StructuredModelClient } from "../../src/providers/structured";
import type { ResearchEvent } from "../../src/shared/ipc";
import type { RunConfig } from "../../src/shared/schemas";

const tempDirectories: string[] = [];

afterEach(() => {
  while (tempDirectories.length > 0) {
    try {
      rmSync(tempDirectories.pop()!, { recursive: true, force: true });
    } catch {
      // Bun can retain a SQLite WAL handle until the test process exits on Windows.
    }
  }
});

describe("research engine deadlines", () => {
  test("does not regenerate a resumed discovery when every candidate already failed the evidence gate", async () => {
    const { db, directory, runId } = createPersistedDiscoveryRun();
    tempDirectories.push(directory);
    const now = new Date().toISOString();
    db.db.prepare(`
      INSERT INTO rejected_problem_candidates (id, discovery_run_id, statement, reason, created_at)
      VALUES ('rejected-1', ?, 'One-source candidate', 'Cited factors span one source hostname; two are required.', ?)
    `).run(runId, now);
    let modelCalls = 0;
    const modelClient: StructuredModelClient = {
      async structuredCompletion() {
        modelCalls += 1;
        throw new Error("A persisted evidence-gate result must not be regenerated");
      },
    };
    const exa = { search: async () => { throw new Error("A persisted evidence-gate result must not be searched again"); } } as unknown as ExaClient;

    try {
      const engine = new ResearchEngine({ db, modelClients: { codex: modelClient }, searchClients: { exa }, onEvent: () => undefined });
      await engine.resumeRun(runId);
      await waitFor(() => !engine.getActiveRunIds().has(runId));

      expect(db.db.prepare("SELECT status FROM research_runs WHERE id = ?").get(runId)).toEqual({ status: "completed" });
      expect(modelCalls).toBe(0);
      expect(db.db.prepare("SELECT statement FROM rejected_problem_candidates WHERE discovery_run_id = ?").all(runId))
        .toEqual([{ statement: "One-source candidate" }]);
    } finally {
      db.close();
    }
  });

  test("resumes a two-hour-old run with a fresh attempt deadline", async () => {
    const { db, directory, runId, config } = createPersistedDiscoveryRun();
    tempDirectories.push(directory);
    const events: ResearchEvent[] = [];
    let modelCalls = 0;
    const selectedModels: string[] = [];
    const modelClient: StructuredModelClient = {
      async structuredCompletion(model, _system, _user, schema) {
        modelCalls += 1;
        selectedModels.push(model);
        await new Promise((resolve) => setTimeout(resolve, 20));
        return schema.parse({ problems: [] });
      },
    };
    const exa = { search: async () => { throw new Error("Persisted factors should skip Stage 1"); } } as unknown as ExaClient;

    try {
      const engine = new ResearchEngine({ db, modelClients: { codex: modelClient }, searchClients: { exa }, onEvent: (event) => events.push(event) });
      await engine.resumeRun(runId);
      await waitFor(() => !engine.getActiveRunIds().has(runId));

      // A deadline measured from created_at rather than from this attempt expired 115 minutes ago,
      // so the run could only reach 'completed' if resume scheduled a fresh one.
      const run = db.db.prepare("SELECT status FROM research_runs WHERE id = ?").get(runId) as { status: string };
      expect(run.status).toBe("completed");
      expect(modelCalls).toBe(1);
      expect(selectedModels).toEqual([config.model]);
      expect(events.some((event) => event.type === "run-resumed" && event.runId === runId)).toBe(true);
      expect(events.some((event) => event.type === "run-completed" && event.runId === runId)).toBe(true);
    } finally {
      db.close();
    }
  });

  test("keeps committed provider calls in the runaway backstop after resume", async () => {
    const { db, directory, runId, config } = createPersistedDiscoveryRun();
    tempDirectories.push(directory);
    const callCeiling = discoveryRunProjection(config.discoveryDepth).modelCalls * 3;
    const ledger = new CostLedgerRepository(db);
    const now = new Date().toISOString();
    const insert = db.db.prepare(`
      INSERT INTO cost_ledger (
        id, research_run_id, operation, provider, model, reservation_usd,
        committed_usd, status, created_at, updated_at
      ) VALUES (?, ?, 'structured-completion', 'codex', ?, 0, 0, 'committed', ?, ?)
    `);
    for (let index = 0; index < callCeiling; index += 1) insert.run(`committed-${index}`, runId, config.model, now, now);
    const orphaned = ledger.reserve(runId, "structured-completion", "codex", config.model, 0);
    let modelCalls = 0;
    const modelClient: StructuredModelClient = {
      async structuredCompletion(_model, _system, _user, schema) {
        modelCalls += 1;
        return schema.parse({ problems: [] });
      },
    };
    const exa = { search: async () => [] } as unknown as ExaClient;

    try {
      const engine = new ResearchEngine({ db, modelClients: { codex: modelClient }, searchClients: { exa }, onEvent: () => undefined });
      await engine.resumeRun(runId);
      await waitFor(() => !engine.getActiveRunIds().has(runId));

      const run = db.db.prepare("SELECT status, completion_reason FROM research_runs WHERE id = ?").get(runId) as {
        status: string;
        completion_reason: string | null;
      };
      expect(run.status).toBe("failed");
      expect(run.completion_reason).toContain("Runaway backstop triggered for codex");
      expect(modelCalls).toBe(0);
      expect(ledger.countProviderCalls(runId, "codex")).toBe(callCeiling);
      expect(db.db.prepare("SELECT id FROM cost_ledger WHERE id = ?").get(orphaned.id)).toBeNull();
    } finally {
      db.close();
    }
  });

  test("fails and releases a run when its provider never settles", async () => {
    const directory = mkdtempSync(join(tmpdir(), "scraply-deadline-"));
    tempDirectories.push(directory);
    const db = new DatabaseClient(join(directory, "scraply.db"));
    const events: ResearchEvent[] = [];
    const neverSettles = <T>(): Promise<T> => new Promise(() => undefined);
    const modelClient: StructuredModelClient = {
      structuredCompletion: () => neverSettles(),
    };
    const exa = { search: () => neverSettles() } as unknown as ExaClient;

    try {
      const now = new Date().toISOString();
      db.db.prepare(`
        INSERT INTO threads (id, title, status, created_at, updated_at)
        VALUES ('thread-1', 'Deadline', 'configuring', ?, ?)
      `).run(now, now);
      const config: RunConfig = {
        searchProvider: "exa",
        model: "test-model",
        reasoningEffort: "medium",
        discoveryDepth: "quick",
        maxRunMinutes: 0.001,
        researchMode: "explore-market",
        knownProblem: "",
      };
      const engine = new ResearchEngine({ db, modelClients: { codex: modelClient }, searchClients: { exa }, onEvent: (event) => events.push(event) });
      const runId = await engine.startDiscovery("thread-1", {
        title: "Deadline",
        audience: "Operators",
        domain: "Operations",
        observations: "Provider calls can hang",
        offLimits: [],
      }, config);

      await waitFor(() => !engine.getActiveRunIds().has(runId));

      const run = db.db.prepare("SELECT status, cancelled, completion_reason FROM research_runs WHERE id = ?")
        .get(runId) as { status: string; cancelled: number; completion_reason: string | null };
      const thread = db.db.prepare("SELECT status FROM threads WHERE id = 'thread-1'").get() as { status: string };
      expect(run).toEqual({
        status: "failed",
        cancelled: 0,
        completion_reason: "Run attempt exceeded its hang-detection deadline",
      });
      expect(thread.status).toBe("failed");
      expect(db.db.prepare("SELECT status FROM cost_ledger WHERE research_run_id = ?").all(runId))
        .toEqual([{ status: "committed" }]);
      expect(events.filter((event) => event.type === "run-failed")).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("waits for aborted provider work before shutdown returns", async () => {
    const directory = mkdtempSync(join(tmpdir(), "scraply-shutdown-"));
    tempDirectories.push(directory);
    const db = new DatabaseClient(join(directory, "scraply.db"));
    let providerStarted = false;
    let providerSettled = false;
    const modelClient: StructuredModelClient = {
      structuredCompletion: (_model, _system, _user, _schema, _jsonSchema, options) => new Promise((_resolve, reject) => {
        providerStarted = true;
        const abort = () => {
          providerSettled = true;
          reject(options?.signal?.reason ?? new Error("cancelled"));
        };
        if (options?.signal?.aborted) abort();
        else options?.signal?.addEventListener("abort", abort, { once: true });
      }),
    };
    const exa = { search: async () => [] } as unknown as ExaClient;

    try {
      const now = new Date().toISOString();
      db.db.prepare(`
        INSERT INTO threads (id, title, status, created_at, updated_at)
        VALUES ('thread-shutdown', 'Shutdown', 'configuring', ?, ?)
      `).run(now, now);
      const engine = new ResearchEngine({ db, modelClients: { codex: modelClient }, searchClients: { exa }, onEvent: () => undefined });
      const runId = await engine.startDiscovery("thread-shutdown", {
        title: "Shutdown", audience: "Operators", domain: "Operations", observations: "", offLimits: [],
      }, {
        model: "test-model", reasoningEffort: "medium", discoveryDepth: "quick", maxRunMinutes: 90, searchProvider: "exa",
        researchMode: "explore-market", knownProblem: "",
      });
      await waitFor(() => providerStarted);

      await engine.shutdown();

      expect(providerSettled).toBe(true);
      expect(engine.getActiveRunIds().size).toBe(0);
      expect(db.db.prepare("SELECT status FROM research_runs WHERE id = ?").get(runId)).toEqual({ status: "cancelled" });
    } finally {
      db.close();
    }
  });

  test("routes discovery and metering through the provider saved on the run", async () => {
    const directory = mkdtempSync(join(tmpdir(), "scraply-search-provider-"));
    tempDirectories.push(directory);
    const db = new DatabaseClient(join(directory, "scraply.db"));
    let perplexitySearches = 0;
    const modelClient: StructuredModelClient = {
      async structuredCompletion(_model, _system, _user, schema) {
        for (const payload of [
          { queries: ["query one", "query two", "query three"] },
          { factors: [] },
          { problems: [] },
        ]) {
          const parsed = schema.safeParse(payload);
          if (parsed.success) return parsed.data;
        }
        throw new Error("Unexpected discovery schema");
      },
    };
    const exa = {
      provider: "exa" as const,
      validateKey: async () => ({ valid: true as const }),
      search: async () => { throw new Error("Exa must not receive a Perplexity run"); },
    };
    const perplexity = {
      provider: "perplexity" as const,
      validateKey: async () => ({ valid: true as const }),
      search: async () => { perplexitySearches += 1; return []; },
    };

    try {
      const now = new Date().toISOString();
      db.db.prepare("INSERT INTO threads (id, title, status, created_at, updated_at) VALUES ('thread-provider', 'Provider', 'configuring', ?, ?)")
        .run(now, now);
      const engine = new ResearchEngine({
        db,
        modelClients: { codex: modelClient },
        searchClients: { exa, perplexity },
        onEvent: () => undefined,
      });
      const runId = await engine.startDiscovery("thread-provider", {
        title: "Provider", audience: "Operators", domain: "Operations", observations: "", offLimits: [],
      }, {
        model: "test-model", reasoningEffort: "medium", discoveryDepth: "quick", maxRunMinutes: 90,
        searchProvider: "perplexity", researchMode: "explore-market", knownProblem: "",
      });
      await waitFor(() => !engine.getActiveRunIds().has(runId));

      expect(perplexitySearches).toBe(6);
      expect(db.db.prepare("SELECT status FROM research_runs WHERE id = ?").get(runId)).toEqual({ status: "completed" });
      expect(db.db.prepare("SELECT provider, reservation_usd, committed_usd, status FROM cost_ledger WHERE research_run_id = ? AND operation = 'search' ORDER BY created_at, id").all(runId))
        .toEqual(Array.from({ length: 6 }, () => ({ provider: "perplexity", reservation_usd: 0.005, committed_usd: 0.005, status: "committed" })));
    } finally {
      db.close();
    }
  });
});

function createPersistedDiscoveryRun(): {
  db: DatabaseClient;
  directory: string;
  runId: string;
  config: RunConfig;
} {
  const directory = mkdtempSync(join(tmpdir(), "scraply-resume-"));
  const db = new DatabaseClient(join(directory, "scraply.db"));
  const now = new Date().toISOString();
  db.db.prepare(`
    INSERT INTO threads (id, title, status, created_at, updated_at)
    VALUES ('thread-1', 'Resume', 'discovery-running', ?, ?)
  `).run(now, now);
  const config: RunConfig = { model: "test-model", reasoningEffort: "medium", discoveryDepth: "quick", maxRunMinutes: 5, searchProvider: "exa", researchMode: "explore-market", knownProblem: "" };
  const runId = new ResearchRunRepository(db).create("thread-1", config).runId;
  const discovery = new DiscoveryRepository(db);
  discovery.persistScope(runId, {
    title: "Resume",
    audience: "Operators",
    domain: "Operations",
    observations: "Manual work repeats",
    offLimits: [],
  });
  discovery.persistFactors(runId, [{
    id: "source-1",
    providerSourceId: "provider-source-1",
    canonicalUrl: "https://example.test/source-1",
    title: "Source 1",
    retrievedText: "Operators repeat manual work every week.",
    author: null,
    publishedAt: null,
    contentHash: "source-1-hash",
    retrievedAt: now,
  }], [{
    id: "factor-1",
    subject: "Operators",
    behavior: "repeat manual work",
    quote: "repeat manual work every week",
    sourceId: "source-1",
    harvestMode: "domain",
    modelConfidence: 0.8,
  }]);
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString();
  db.db.prepare("UPDATE research_runs SET created_at = ?, updated_at = ? WHERE id = ?").run(twoHoursAgo, twoHoursAgo, runId);
  return { db, directory, runId, config };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const expiresAt = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= expiresAt) throw new Error("Timed out waiting for the run deadline");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
