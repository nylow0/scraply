import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ResearchEngine } from "../../src/core/research-engine";
import { WorkflowExecution } from "../../src/core/workflow-execution";
import { discoveryRunProjection } from "../../src/core/discovery";
import { DatabaseClient } from "../../src/db/client";
import { CostLedgerRepository } from "../../src/db/repositories/cost-ledger";
import { DiscoveryRepository } from "../../src/db/repositories/discovery";
import { DevelopmentRepository } from "../../src/db/repositories/development";
import { GenerationAttemptRepository } from "../../src/db/repositories/generation-attempts";
import { ResearchRunRepository } from "../../src/db/repositories/research-runs";
import type { ExaClient } from "../../src/providers/exa";
import { ProviderFailure, type StructuredModelClient, type StructuredStageRequest } from "../../src/providers/structured";
import type { ResearchEvent } from "../../src/shared/ipc";
import type { RunConfig } from "../../src/shared/schemas";

const tempDirectories: string[] = [];
const TEST_PROVIDER = "test-provider";
const TEST_MODEL = { providerId: TEST_PROVIDER, modelId: "test-model" } as const;

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
  test("persists every failed repair attempt before failing the run", async () => {
    const directory = mkdtempSync(join(tmpdir(), "scraply-failed-repair-"));
    tempDirectories.push(directory);
    const db = new DatabaseClient(join(directory, "scraply.db"));
    const now = new Date().toISOString();
    db.db.prepare("INSERT INTO threads (id, title, status, created_at, updated_at) VALUES ('thread-1', 'Repair', 'configuring', ?, ?)")
      .run(now, now);
    const config: RunConfig = {
      configVersion: 2, workflowVersion: 2, searchProvider: "exa", model: TEST_MODEL, reasoningEffort: "medium",
      discoveryDepth: "quick", maxRunMinutes: 1, researchMode: "known-problem", knownProblem: "Parts arrive late.",
    };
    const attempts = [
      {
        attempt: "initial" as const, outcome: "failed" as const, providerCompletion: "confirmed" as const,
        model: TEST_MODEL, usage: { status: "known" as const, value: { inputTokens: 20, outputTokens: 4, totalTokens: 24 } },
        cost: { status: "not_reported" as const }, latencyMs: 20, providerRequestId: "provider-initial",
      },
      {
        attempt: "schema_repair" as const, outcome: "failed" as const, providerCompletion: "unknown" as const,
        model: TEST_MODEL, usage: { status: "unknown" as const }, cost: { status: "unknown" as const }, latencyMs: 5,
      },
    ];
    const identity = {
      protocolVersion: "1.1", runtimeVersion: "0.1.0", runtimeSourceSha: "a".repeat(40), runtimeExecutableSha256: "b".repeat(64),
      compilerPrompt: { id: "scraply.stage-worker.v1", sha256: "c".repeat(64) },
    };
    const modelClient: StructuredModelClient = {
      preparedIdentity: () => identity,
      async structuredCompletion(request) {
        request.onDispatched?.();
        request.onAccepted?.(identity);
        throw new ProviderFailure("schema", "Schema repair failed", false, { attempts });
      },
    };

    try {
      const engine = new ResearchEngine({ db, modelClients: { [TEST_PROVIDER]: modelClient }, onEvent: () => undefined });
      const runId = await engine.startKnownProblem("thread-1", {
        title: "Parts", audience: "Repair shops", domain: "Delivery", observations: "", offLimits: [],
      }, config.knownProblem, config);
      await waitFor(() => !engine.getActiveRunIds().has(runId));

      const generation = db.db.prepare("SELECT status, attempt_metadata_json, usage_json, reported_cost_usd FROM generation_attempts WHERE research_run_id = ?")
        .get(runId) as { status: string; attempt_metadata_json: string; usage_json: string; reported_cost_usd: number | null };
      expect(generation.status).toBe("failed");
      expect(JSON.parse(generation.attempt_metadata_json)).toEqual({ attempts });
      expect(JSON.parse(generation.usage_json)).toEqual(attempts.map((attempt) => attempt.usage));
      expect(generation.reported_cost_usd).toBeNull();
      expect(db.db.prepare("SELECT status, committed_usd FROM cost_ledger WHERE research_run_id = ?").get(runId))
        .toEqual({ status: "committed", committed_usd: null });
    } finally { db.close(); }
  });

  test("does not regenerate a resumed discovery when every candidate already failed the evidence gate", async () => {
    const { db, directory, runId } = createPersistedDiscoveryRun();
    tempDirectories.push(directory);
    const now = new Date().toISOString();
    db.db.prepare(`
      INSERT INTO rejected_problem_candidates (id, discovery_run_id, statement, reason, created_at)
      VALUES ('rejected-1', ?, 'One-source candidate', 'Cited factors span one source hostname; two are required.', ?)
    `).run(runId, now);
    new WorkflowExecution(db, runId).save("discovery-completed", { problems: [], blockedCandidates: [], killSources: [] });
    let modelCalls = 0;
    const modelClient: StructuredModelClient = {
      async structuredCompletion() {
        modelCalls += 1;
        throw new Error("A persisted evidence-gate result must not be regenerated");
      },
    };
    const exa = { search: async () => { throw new Error("A persisted evidence-gate result must not be searched again"); } } as unknown as ExaClient;

    try {
      const engine = new ResearchEngine({ db, modelClients: { [TEST_PROVIDER]: modelClient }, searchClients: { exa }, onEvent: () => undefined });
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
    const selectedModels: Array<{ providerId: string; modelId: string }> = [];
    const modelClient: StructuredModelClient = {
      async structuredCompletion(request) {
        modelCalls += 1;
        selectedModels.push(request.model);
        await new Promise((resolve) => setTimeout(resolve, 20));
        return result(request, { problems: [] });
      },
    };
    const exa = { search: async () => { throw new Error("Persisted factors should skip Stage 1"); } } as unknown as ExaClient;

    try {
      const engine = new ResearchEngine({ db, modelClients: { [TEST_PROVIDER]: modelClient }, searchClients: { exa }, onEvent: (event) => events.push(event) });
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
      ) VALUES (?, ?, 'structured-completion', ?, ?, 0, 0, 'committed', ?, ?)
    `);
    for (let index = 0; index < callCeiling; index += 1) insert.run(`committed-${index}`, runId, TEST_PROVIDER, config.model.modelId, now, now);
    const orphaned = ledger.reserve(runId, "structured-completion", TEST_PROVIDER, config.model.modelId, 0);
    let modelCalls = 0;
    const modelClient: StructuredModelClient = {
      async structuredCompletion(request) {
        modelCalls += 1;
        return result(request, { problems: [] });
      },
    };
    const exa = { search: async () => [] } as unknown as ExaClient;

    try {
      const engine = new ResearchEngine({ db, modelClients: { [TEST_PROVIDER]: modelClient }, searchClients: { exa }, onEvent: () => undefined });
      await engine.resumeRun(runId);
      await waitFor(() => !engine.getActiveRunIds().has(runId));

      const run = db.db.prepare("SELECT status, completion_reason FROM research_runs WHERE id = ?").get(runId) as {
        status: string;
        completion_reason: string | null;
      };
      expect(run.status).toBe("failed");
      expect(run.completion_reason).toContain(`Runaway backstop triggered for ${TEST_PROVIDER}`);
      expect(modelCalls).toBe(0);
      expect(ledger.countProviderCalls(runId, TEST_PROVIDER)).toBe(callCeiling + 1);
      expect(db.db.prepare("SELECT status, committed_usd FROM cost_ledger WHERE id = ?").get(orphaned.id))
        .toEqual({ status: "committed", committed_usd: null });
    } finally {
      db.close();
    }
  });

  test("does not replay a request that was sent before acceptance was durably observed", async () => {
    const { db, directory, runId, config } = createPersistedDiscoveryRun();
    tempDirectories.push(directory);
    const attempts = new GenerationAttemptRepository(db);
    const request: StructuredStageRequest<{ answer: string }> = {
      generationId: "sent-generation",
      stage: "fixture",
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      deadlineMs: 1_000,
      repairPolicy: "one_retry",
      workOrder: { stage: "fixture", instruction: "Answer.", goal: "Exercise resume safety.", definitionOfDone: ["One answer"] },
      evidence: [],
      schema: z.object({ answer: z.string() }).strict(),
      jsonSchema: { type: "object" },
    };
    const attempt = attempts.prepare(runId, request);
    const ledger = new CostLedgerRepository(db);
    const reservation = ledger.reserve(runId, "structured-completion", config.model.providerId, config.model.modelId, 0, attempt.id);
    attempts.markDispatched(attempt.id);
    attempts.interruptInFlight("simulated process loss");
    let modelCalls = 0;
    const engine = new ResearchEngine({
      db,
      modelClients: { [TEST_PROVIDER]: { async structuredCompletion() { modelCalls += 1; throw new Error("must not replay"); } } },
      onEvent: () => undefined,
    });

    await expect(engine.resumeRun(runId)).rejects.toThrow("may have completed");
    expect(modelCalls).toBe(0);
    expect(db.db.prepare("SELECT status, terminal_kind FROM generation_attempts WHERE id = ?").get(attempt.id))
      .toEqual({ status: "interrupted", terminal_kind: "process-lost" });
    expect(db.db.prepare("SELECT status, committed_usd FROM cost_ledger WHERE id = ?").get(reservation.id))
      .toEqual({ status: "committed", committed_usd: null });
    db.close();
  });

  test("retains partial development rows and fails closed instead of deleting and replaying", async () => {
    const { db, directory, runId: discoveryRunId, config } = createPersistedDiscoveryRun();
    tempDirectories.push(directory);
    const now = new Date().toISOString();
    db.db.prepare("UPDATE research_runs SET status = 'completed' WHERE id = ?").run(discoveryRunId);
    db.db.prepare(`
      INSERT INTO problems (
        id, discovery_run_id, statement, why_it_persists, affected, scale_estimate,
        verdict, verdict_reason, verdict_source_ids_json, selected_at, created_at
      ) VALUES ('problem-partial', ?, 'Parts arrive late', '', '', '', 'user-asserted', 'Selected by user', '[]', ?, ?)
    `).run(discoveryRunId, now, now);
    const developmentRunId = new ResearchRunRepository(db).create("thread-1", config, "problem-partial").runId;
    new DevelopmentRepository(db).persistSolutions(developmentRunId, "problem-partial", [{
      id: "saved-solution",
      problemId: "problem-partial",
      mechanism: "Retained mechanism",
      description: "This partial result must remain on disk.",
      respectsOffLimits: true,
      respectsOffLimitsWhy: "No restricted action.",
      outcomes: [], risks: [], mitigations: [],
    }]);
    let modelCalls = 0;
    const engine = new ResearchEngine({
      db,
      modelClients: { [TEST_PROVIDER]: { async structuredCompletion() { modelCalls += 1; throw new Error("must not replay"); } } },
      onEvent: () => undefined,
    });

    db.db.prepare("UPDATE research_runs SET workflow_version = 1, config_json = ? WHERE id = ?").run(JSON.stringify({ ...config, workflowVersion: 1 }), developmentRunId);
    await expect(engine.resumeRun(developmentRunId)).rejects.toThrow("Legacy generation has been retired");
    expect(modelCalls).toBe(0);
    expect(db.db.prepare("SELECT id, mechanism FROM solutions WHERE research_run_id = ?").all(developmentRunId))
      .toEqual([{ id: "saved-solution", mechanism: "Retained mechanism" }]);
    expect(db.db.prepare("SELECT status, completion_reason FROM research_runs WHERE id = ?").get(developmentRunId))
      .toEqual(expect.objectContaining({ status: "running", completion_reason: null }));
    db.close();
  });

  test("fails without reserving spend when its provider never dispatches", async () => {
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
        configVersion: 2, workflowVersion: 2,
        searchProvider: "exa",
        model: TEST_MODEL,
        reasoningEffort: "medium",
        discoveryDepth: "quick",
        maxRunMinutes: 0.001,
        researchMode: "explore-market",
        knownProblem: "",
      };
      const engine = new ResearchEngine({ db, modelClients: { [TEST_PROVIDER]: modelClient }, searchClients: { exa }, onEvent: (event) => events.push(event) });
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
      expect(db.db.prepare("SELECT status FROM cost_ledger WHERE research_run_id = ?").all(runId)).toEqual([]);
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
      structuredCompletion: (request) => new Promise((_resolve, reject) => {
        providerStarted = true;
        const abort = () => {
          providerSettled = true;
          reject(request.signal?.reason ?? new Error("cancelled"));
        };
        if (request.signal?.aborted) abort();
        else request.signal?.addEventListener("abort", abort, { once: true });
      }),
    };
    const exa = { search: async () => [] } as unknown as ExaClient;

    try {
      const now = new Date().toISOString();
      db.db.prepare(`
        INSERT INTO threads (id, title, status, created_at, updated_at)
        VALUES ('thread-shutdown', 'Shutdown', 'configuring', ?, ?)
      `).run(now, now);
      const engine = new ResearchEngine({ db, modelClients: { [TEST_PROVIDER]: modelClient }, searchClients: { exa }, onEvent: () => undefined });
      const runId = await engine.startDiscovery("thread-shutdown", {
        title: "Shutdown", audience: "Operators", domain: "Operations", observations: "", offLimits: [],
      }, {
        configVersion: 2, workflowVersion: 2, model: TEST_MODEL, reasoningEffort: "medium", discoveryDepth: "quick", maxRunMinutes: 90, searchProvider: "exa",
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
      async structuredCompletion(request) {
        for (const payload of [
          { queries: ["query one", "query two", "query three"].map(query => ({ query, uncertainty: "Frequency", intendedSourceType: "Records" })) },
          { factors: [] },
          { problems: [] },
        ]) {
          const parsed = request.schema.safeParse(payload);
          if (parsed.success) return { output: parsed.data, metadata: metadata(request.model) };
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
        modelClients: { [TEST_PROVIDER]: modelClient },
        searchClients: { exa, perplexity },
        onEvent: () => undefined,
      });
      const runId = await engine.startDiscovery("thread-provider", {
        title: "Provider", audience: "Operators", domain: "Operations", observations: "", offLimits: [],
      }, {
        configVersion: 2, workflowVersion: 2, model: TEST_MODEL, reasoningEffort: "medium", discoveryDepth: "quick", maxRunMinutes: 90,
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
  const config: RunConfig = { configVersion: 2, workflowVersion: 2, model: TEST_MODEL, reasoningEffort: "medium", discoveryDepth: "quick", maxRunMinutes: 5, searchProvider: "exa", researchMode: "explore-market", knownProblem: "" };
  const runId = new ResearchRunRepository(db).create("thread-1", config).runId;
  const discovery = new DiscoveryRepository(db);
  discovery.persistScope(runId, {
    title: "Resume",
    audience: "Operators",
    domain: "Operations",
    observations: "Manual work repeats",
    offLimits: [],
  });
  const source = {
    id: "source-1",
    providerSourceId: "provider-source-1",
    canonicalUrl: "https://example.test/source-1",
    title: "Source 1",
    retrievedText: "Operators repeat manual work every week.",
    author: null,
    publishedAt: null,
    contentHash: "source-1-hash",
    retrievedAt: now,
    url: "https://example.test/source-1",
  };
  const factor = {
    id: "factor-1",
    subject: "Operators",
    behavior: "repeat manual work",
    quote: "repeat manual work every week",
    sourceId: "source-1",
    harvestMode: "domain" as const,
    modelConfidence: 0.8,
    source,
  };
  discovery.persistFactors(runId, [source], [factor]);
  new WorkflowExecution(db, runId).save("harvest", { sources: [source], factors: [factor], rejections: [], metrics: {} });
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString();
  db.db.prepare("UPDATE research_runs SET created_at = ?, updated_at = ? WHERE id = ?").run(twoHoursAgo, twoHoursAgo, runId);
  return { db, directory, runId, config };
}

function result<T>(request: StructuredStageRequest<T>, value: unknown) {
  return { output: request.schema.parse(value), metadata: metadata(request.model) };
}

function metadata(model: { providerId: string; modelId: string }) {
  return { model, prompt: { id: "fixture", sha256: "a".repeat(64) }, usage: { status: "unknown" as const }, latencyMs: 1, repairCount: 0, providerRequestIds: [], attempts: [] };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const expiresAt = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= expiresAt) throw new Error("Timed out waiting for the run deadline");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
