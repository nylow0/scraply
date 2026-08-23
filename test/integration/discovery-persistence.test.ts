import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseClient } from "../../src/db/client";
import { DiscoveryRepository } from "../../src/db/repositories/discovery";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";

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

describe("discovery persistence", () => {
  test("persists the Stage 1 graph and cascades it with the run", () => {
    const { client, runId } = setup();
    const repository = new DiscoveryRepository(client);
    repository.persistScope(runId, {
      title: "Operations",
      audience: "Operators",
      domain: "Compliance",
      observations: "Manual work repeats",
      offLimits: [],
    });
    repository.persistFactors(runId, [source("source-1")], [{
      id: "factor-1",
      subject: "Operators",
      behavior: "repeat filings",
      quote: "Operators repeat filings.",
      sourceId: "source-1",
      harvestMode: "domain",
      modelConfidence: 0.8,
    }]);
    repository.persistProblems(runId, [], [{
      id: "problem-1",
      statement: "Operators repeat the same filing.",
      whyItPersists: "Systems are disconnected.",
      affected: "Operators",
      scaleEstimate: "Recurring",
      scaleBasisFactorId: "factor-1",
      factorIds: ["factor-1"],
      verdict: "confirmed",
      verdictReason: "Contrary evidence did not kill it.",
      verdictSourceIds: ["source-1"],
    }]);

    expect(count(client, "scopes")).toBe(1);
    expect(count(client, "factors")).toBe(1);
    expect(count(client, "problems")).toBe(1);
    expect(count(client, "problem_factors")).toBe(1);
    expect(client.db.prepare(`
      SELECT problem_id, source_id, research_run_id, position FROM problem_verdict_sources
    `).all()).toEqual([{
      problem_id: "problem-1", source_id: "source-1", research_run_id: runId, position: 0,
    }]);
    expect(client.db.prepare("SELECT verdict_source_ids_json FROM problems WHERE id = 'problem-1'").get())
      .toEqual({ verdict_source_ids_json: "[]" });
    expect(client.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

    client.db.prepare("DELETE FROM research_runs WHERE id = ?").run(runId);
    expect(count(client, "scopes")).toBe(0);
    expect(count(client, "factors")).toBe(0);
    expect(count(client, "problems")).toBe(0);
    expect(count(client, "problem_verdict_sources")).toBe(0);
    client.close();
  });

  test("rolls back every Stage 1 row when a factor cannot be persisted", () => {
    const { client, runId } = setup();
    const repository = new DiscoveryRepository(client);
    expect(() => repository.persistFactors(runId, [source("source-1")], [{
      id: "factor-1",
      subject: "Operators",
      behavior: "repeat filings",
      quote: "Operators repeat filings.",
      sourceId: "missing-source",
      harvestMode: "domain",
      modelConfidence: 0.8,
    }])).toThrow();
    expect(count(client, "sources")).toBe(0);
    expect(count(client, "factors")).toBe(0);
    client.close();
  });

  test("atomically rolls back a known-problem root when graph persistence fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "scraply-known-root-"));
    tempDirectories.push(directory);
    const client = new DatabaseClient(join(directory, "scraply.db"));
    const now = new Date().toISOString();
    client.db.prepare("INSERT INTO threads (id, title, status, created_at, updated_at) VALUES ('thread-1', 'Known', 'configuring', ?, ?)").run(now, now);
    client.db.exec(`
      CREATE TRIGGER reject_known_problem BEFORE INSERT ON problems
      BEGIN SELECT RAISE(ABORT, 'simulated problem write failure'); END;
    `);
    const repository = new DiscoveryRepository(client);
    expect(() => repository.createKnownProblemRoot("thread-1", {
      title: "Known", audience: "Operators", domain: "Operations", observations: "Manual work", offLimits: [],
    }, "Operators lose time to manual work.", { ...DEFAULT_RUN_CONFIG, researchMode: "known-problem", knownProblem: "Operators lose time to manual work." })).toThrow("simulated problem write failure");
    expect(count(client, "research_runs")).toBe(0);
    expect(count(client, "scopes")).toBe(0);
    expect(count(client, "problems")).toBe(0);
    client.close();
  });
});

function setup(): { client: DatabaseClient; runId: string } {
  const directory = mkdtempSync(join(tmpdir(), "scraply-discovery-"));
  tempDirectories.push(directory);
  const client = new DatabaseClient(join(directory, "scraply.db"));
  const now = new Date().toISOString();
  client.db.prepare(`
    INSERT INTO threads (id, title, status, created_at, updated_at)
    VALUES ('thread-1', 'Discovery', 'discovery-running', ?, ?)
  `).run(now, now);
  client.db.prepare(`
    INSERT INTO research_runs (id, thread_id, status, config_json, created_at, updated_at)
    VALUES ('run-1', 'thread-1', 'running', '{}', ?, ?)
  `).run(now, now);
  return { client, runId: "run-1" };
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
    retrievedAt: "2026-08-04T00:00:00.000Z",
  };
}

function count(client: DatabaseClient, table: string): number {
  return (client.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}
