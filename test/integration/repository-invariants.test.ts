import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseClient } from "../../src/db/client";
import { BudgetExceededError, CostLedgerRepository } from "../../src/db/repositories/cost-ledger";
import { DiscoveryRepository } from "../../src/db/repositories/discovery";
import { ThreadRepository } from "../../src/db/repositories/threads";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    try {
      rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
    } catch {
      // Bun can retain a SQLite WAL handle until the test process exits on Windows.
    }
  }
});

describe("repository invariants", () => {
  test("rolls back the thread if its default configuration cannot be created", () => {
    const client = database();
    client.db.exec(`
      CREATE TRIGGER reject_run_config BEFORE INSERT ON run_configs
      BEGIN SELECT RAISE(ABORT, 'simulated configuration failure'); END;
    `);

    expect(() => new ThreadRepository(client).createThread("Atomic thread"))
      .toThrow("simulated configuration failure");
    expect(client.db.prepare("SELECT COUNT(*) AS count FROM threads").get()).toEqual({ count: 0 });
    client.close();
  });

  test("rejects discovery links to factors and sources from another run", () => {
    const client = database();
    createThreadAndRun(client, "thread-1", "run-1");
    createThreadAndRun(client, "thread-2", "run-2");
    const repository = new DiscoveryRepository(client);
    repository.persistFactors("run-1", [source("source-1")], [factor("factor-1", "source-1")]);

    expect(() => repository.persistFactors("run-2", [], [factor("factor-2", "source-1")]))
      .toThrow("Source source-1 does not belong to research run run-2");
    expect(() => repository.persistProblems("run-2", [], [{
      id: "problem-2",
      statement: "Cross-run problem",
      whyItPersists: "Invalid evidence link",
      affected: "Operators",
      scaleEstimate: "Unknown",
      scaleBasisFactorId: "factor-1",
      factorIds: ["factor-1"],
      verdict: "confirmed",
      verdictReason: "Invalid evidence link",
      verdictSourceIds: ["source-1"],
    }])).toThrow("Factor factor-1 does not belong to research run run-2");
    expect(() => repository.persistProblems("run-2", [], [{
      id: "problem-3",
      statement: "Cross-run verdict source",
      whyItPersists: "Invalid verdict evidence link",
      affected: "Operators",
      scaleEstimate: "Unknown",
      scaleBasisFactorId: null,
      factorIds: [],
      verdict: "confirmed",
      verdictReason: "Invalid verdict evidence link",
      verdictSourceIds: ["source-1"],
    }])).toThrow("Source source-1 does not belong to research run run-2");

    expect(client.db.prepare("SELECT COUNT(*) AS count FROM problems").get()).toEqual({ count: 0 });
    client.close();
  });

  test("enforces normalized verdict-source ownership even for direct SQL writes", () => {
    const client = database();
    createThreadAndRun(client, "thread-1", "run-1");
    createThreadAndRun(client, "thread-2", "run-2");
    const repository = new DiscoveryRepository(client);
    repository.persistFactors("run-1", [source("source-1")], []);
    repository.persistProblems("run-2", [], [{
      id: "problem-2",
      statement: "Run two problem",
      whyItPersists: "Persistence",
      affected: "Operators",
      scaleEstimate: "Unknown",
      scaleBasisFactorId: null,
      factorIds: [],
      verdict: "confirmed",
      verdictReason: "Confirmed independently",
      verdictSourceIds: [],
    }]);

    expect(() => client.db.prepare(`
      INSERT INTO problem_verdict_sources (problem_id, source_id, research_run_id, position)
      VALUES ('problem-2', 'source-1', 'run-2', 0)
    `).run()).toThrow();
    expect(() => client.db.prepare(`
      INSERT INTO problems (
        id, discovery_run_id, statement, why_it_persists, affected, scale_estimate,
        verdict, verdict_reason, verdict_source_ids_json, created_at
      ) VALUES ('problem-json', 'run-2', 'Legacy JSON', '', '', '', 'confirmed', '', '["source-1"]', ?)
    `).run(new Date().toISOString())).toThrow("problem verdict sources must use problem_verdict_sources");
    expect(client.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    client.close();
  });

  test("normalizes job-event entity IDs and rejects cross-thread direct SQL", () => {
    const client = database();
    createThreadAndRun(client, "thread-1", "run-1");
    createThreadAndRun(client, "thread-2", "run-2");
    const repository = new DiscoveryRepository(client);
    repository.persistProblems("run-1", [], [problem("problem-1")]);
    repository.persistProblems("run-2", [], [problem("problem-2")]);
    client.db.prepare("UPDATE research_runs SET problem_id = 'problem-1' WHERE id = 'run-1'").run();
    client.db.prepare("UPDATE research_runs SET problem_id = 'problem-2' WHERE id = 'run-2'").run();
    const now = new Date().toISOString();
    const insert = client.db.prepare(`
      INSERT INTO job_events (run_id, thread_id, type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    insert.run("run-1", "thread-1", "run-started", JSON.stringify({
      type: "run-started",
      runId: "run-1",
      threadId: "thread-1",
      problemId: "problem-1",
    }), now);
    expect(client.db.prepare("SELECT run_id, thread_id, problem_id, payload_json FROM job_events").get())
      .toEqual({
        run_id: "run-1",
        thread_id: "thread-1",
        problem_id: "problem-1",
        payload_json: JSON.stringify({ type: "run-started" }),
      });

    expect(() => insert.run("run-1", "thread-2", "run-progress", JSON.stringify({
      type: "run-progress", runId: "run-1", threadId: "thread-2", message: "Wrong thread",
    }), now)).toThrow();
    expect(() => insert.run("run-1", "thread-1", "run-progress", JSON.stringify({
      type: "run-progress", runId: "run-2", threadId: "thread-1", message: "Wrong run",
    }), now)).toThrow("job event payload entity IDs do not match relational columns");
    expect(() => insert.run("run-1", "thread-1", "run-started", JSON.stringify({
      type: "run-started", runId: "run-1", threadId: "thread-1", problemId: "problem-2",
    }), now)).toThrow("job event payload entity IDs do not match relational columns");
    expect(client.db.prepare("SELECT COUNT(*) AS count FROM job_events").get()).toEqual({ count: 1 });
    client.close();
  });

  test("does not reserve provider spend after a run has finished", () => {
    const client = database();
    createThreadAndRun(client, "thread-1", "run-1", "completed");

    expect(() => new CostLedgerRepository(client).reserve("run-1", "search", "exa", null, 0.05))
      .toThrow("Research run cannot accept new paid operations");
    expect(client.db.prepare("SELECT COUNT(*) AS count FROM cost_ledger").get()).toEqual({ count: 0 });
    client.close();
  });

  test("accounts reservations, commits, releases, and budget failures atomically", () => {
    const client = database();
    createThreadAndRun(client, "thread-1", "run-1");
    const ledger = new CostLedgerRepository(client);

    const committed = ledger.reserve("run-1", "search", "exa", null, 0.25);
    const released = ledger.reserve("run-1", "search", "exa", null, 0.1);
    ledger.commit(committed.id, 0.2, { requests: 1 });
    ledger.commit(committed.id, 0.2, { requests: 1 });
    ledger.release(released.id);

    expect(client.db.prepare(`
      SELECT reserved_cost, committed_cost, spend_estimate FROM research_runs WHERE id = 'run-1'
    `).get()).toEqual({ reserved_cost: 0, committed_cost: 0.2, spend_estimate: 0.2 });
    expect(client.db.prepare("SELECT status, committed_usd, usage_json FROM cost_ledger").all()).toEqual([{
      status: "committed",
      committed_usd: 0.2,
      usage_json: '{"requests":1}',
    }]);
    expect(() => ledger.reserve("run-1", "search", "exa", null, 1_000))
      .toThrow(BudgetExceededError);
    client.close();
  });
});

function database(): DatabaseClient {
  const directory = mkdtempSync(join(tmpdir(), "scraply-repository-invariants-"));
  temporaryDirectories.push(directory);
  return new DatabaseClient(join(directory, "scraply.db"));
}

function createThreadAndRun(
  client: DatabaseClient,
  threadId: string,
  runId: string,
  status = "running",
): void {
  const now = new Date().toISOString();
  client.db.prepare("INSERT INTO threads (id, title, status, created_at, updated_at) VALUES (?, ?, 'configuring', ?, ?)")
    .run(threadId, threadId, now, now);
  client.db.prepare(`
    INSERT INTO research_runs (
      id, thread_id, status, config_json, budget_limit, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 1000, ?, ?)
  `).run(runId, threadId, status, JSON.stringify(DEFAULT_RUN_CONFIG), now, now);
}

function source(id: string) {
  return {
    id,
    providerSourceId: id,
    canonicalUrl: `https://example.test/${id}`,
    title: id,
    retrievedText: "Operators repeat filings.",
    author: null,
    publishedAt: null,
    contentHash: `hash-${id}`,
    retrievedAt: "2026-08-23T00:00:00.000Z",
  };
}

function factor(id: string, sourceId: string) {
  return {
    id,
    subject: "Operators",
    behavior: "repeat filings",
    quote: "Operators repeat filings.",
    sourceId,
    harvestMode: "domain" as const,
    modelConfidence: 0.8,
  };
}

function problem(id: string) {
  return {
    id,
    statement: `${id} statement`,
    whyItPersists: "Persistence",
    affected: "Operators",
    scaleEstimate: "Unknown",
    scaleBasisFactorId: null,
    factorIds: [],
    verdict: "confirmed" as const,
    verdictReason: "Confirmed independently",
    verdictSourceIds: [],
  };
}
