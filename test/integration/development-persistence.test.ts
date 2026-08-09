import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseClient } from "../../src/db/client";
import { DevelopmentRepository } from "../../src/db/repositories/development";
import { DiscoveryRepository } from "../../src/db/repositories/discovery";

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    try {
      rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
    } catch {
      // Windows can retain a SQLite WAL handle briefly.
    }
  }
});

describe("development persistence", () => {
  test("loads selected discovery context and persists the complete graph transactionally", () => {
    const client = setup();
    const repository = new DevelopmentRepository(client);
    const context = repository.loadContext("problem-1");
    expect(context?.scope.title).toBe("Claims");
    expect(context?.problem.factorIds).toEqual(["factor-1"]);
    expect(context?.factors[0]?.quote).toBe("Sellers repeat claims.");

    const solution = {
      id: "solution-1",
      problemId: "problem-1",
      mechanism: "Reconcile state",
      description: "Check state before submitting.",
      respectsOffLimits: true,
      respectsOffLimitsWhy: "No prohibited action.",
      outcomes: [],
      risks: [],
      mitigations: [],
    };
    repository.persistSolutions("development-1", "problem-1", [solution]);
    repository.persistOutcomes("development-1", [{
      id: "outcome-1",
      solutionId: "solution-1",
      description: "Retries fall.",
      direction: "positive",
      affects: "Sellers",
      addressesCore: true,
    }]);
    repository.persistRiskAnalysis("development-1", "solution-1", [{
      id: "risk-1",
      solutionId: "solution-1",
      description: "Access disappears.",
      likelihood: "possible",
      impact: "project ends",
      sortKey: 8,
    }], [{
      id: "mitigation-1",
      solutionId: "solution-1",
      riskIds: ["risk-1"],
      approach: "Keep exports",
      cost: "Two days",
      failsIf: "Exports disappear",
    }]);

    expect(count(client, "solutions")).toBe(1);
    expect(count(client, "outcomes")).toBe(1);
    expect(count(client, "risks")).toBe(1);
    expect(count(client, "mitigations")).toBe(1);
    expect(count(client, "risk_mitigations")).toBe(1);
    expect(client.db.prepare("SELECT research_run_id FROM solutions WHERE id = 'solution-1'").get())
      .toEqual({ research_run_id: "development-1" });
    expect(client.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    client.close();
  });

  test("rolls back risks and mitigations when a link targets another solution", () => {
    const client = setup();
    const repository = new DevelopmentRepository(client);
    repository.persistSolutions("development-1", "problem-1", [{
      id: "solution-1",
      problemId: "problem-1",
      mechanism: "Reconcile state",
      description: "Check state.",
      respectsOffLimits: true,
      respectsOffLimitsWhy: "Allowed.",
      outcomes: [],
      risks: [],
      mitigations: [],
    }]);
    expect(() => repository.persistRiskAnalysis("development-1", "solution-1", [{
      id: "risk-1",
      solutionId: "solution-1",
      description: "Access disappears.",
      likelihood: "possible",
      impact: "project ends",
      sortKey: 8,
    }], [{
      id: "mitigation-1",
      solutionId: "another-solution",
      riskIds: ["risk-1"],
      approach: "Keep exports",
      cost: "Two days",
      failsIf: "Exports disappear",
    }])).toThrow();
    expect(count(client, "risks")).toBe(0);
    expect(count(client, "mitigations")).toBe(0);
    client.close();
  });

  test("keeps repeated runs separate and rejects cross-run child writes", () => {
    const client = setup();
    const repository = new DevelopmentRepository(client);
    repository.persistSolutions("development-1", "problem-1", [solution("solution-1")]);
    repository.persistSolutions("development-2", "problem-1", [solution("solution-2")]);
    repository.persistOutcomes("development-1", [{
      id: "outcome-1",
      solutionId: "solution-1",
      description: "First run outcome",
      direction: "positive",
      affects: "Sellers",
      addressesCore: true,
    }]);

    expect(() => repository.persistOutcomes("development-2", [{
      id: "outcome-cross-run",
      solutionId: "solution-1",
      description: "Wrong run",
      direction: "negative",
      affects: "Sellers",
      addressesCore: false,
    }])).toThrow("does not belong to research run development-2");
    expect(client.db.prepare(`
      SELECT s.id, COUNT(o.id) AS outcome_count
      FROM solutions s
      LEFT JOIN outcomes o ON o.solution_id = s.id
      WHERE s.research_run_id = ?
      GROUP BY s.id
    `).all("development-1")).toEqual([{ id: "solution-1", outcome_count: 1 }]);
    expect(client.db.prepare(`
      SELECT s.id, COUNT(o.id) AS outcome_count
      FROM solutions s
      LEFT JOIN outcomes o ON o.solution_id = s.id
      WHERE s.research_run_id = ?
      GROUP BY s.id
    `).all("development-2")).toEqual([{ id: "solution-2", outcome_count: 0 }]);
    expect(count(client, "outcomes")).toBe(1);
    client.db.prepare("DELETE FROM research_runs WHERE id = 'development-1'").run();
    expect(client.db.prepare("SELECT id FROM solutions ORDER BY id").all()).toEqual([{ id: "solution-2" }]);
    expect(count(client, "outcomes")).toBe(0);
    client.close();
  });
});

function setup(): DatabaseClient {
  const directory = mkdtempSync(join(tmpdir(), "scraply-development-"));
  temporaryDirectories.push(directory);
  const client = new DatabaseClient(join(directory, "scraply.db"));
  const now = new Date().toISOString();
  client.db.prepare(`
    INSERT INTO threads (id, title, status, created_at, updated_at)
    VALUES ('thread-1', 'Claims', 'research-running', ?, ?)
  `).run(now, now);
  client.db.prepare(`
    INSERT INTO research_runs (id, thread_id, status, config_json, created_at, updated_at)
    VALUES ('run-1', 'thread-1', 'completed', '{}', ?, ?)
  `).run(now, now);
  const discovery = new DiscoveryRepository(client);
  discovery.persistScope("run-1", {
    title: "Claims",
    audience: "Sellers",
    domain: "Operations",
    observations: "Repeated claims",
    offLimits: [],
  });
  discovery.persistFactors("run-1", [{
    id: "source-1",
    providerSourceId: "source-1",
    canonicalUrl: "https://example.test/source-1",
    title: "Source",
    retrievedText: "Sellers repeat claims.",
    author: null,
    publishedAt: null,
    contentHash: "hash-1",
    retrievedAt: now,
  }], [{
    id: "factor-1",
    subject: "Sellers",
    behavior: "repeat claims",
    quote: "Sellers repeat claims.",
    sourceId: "source-1",
    harvestMode: "audience",
    modelConfidence: 0.8,
  }]);
  discovery.persistProblems("run-1", [], [{
    id: "problem-1",
    statement: "Claims repeat.",
    whyItPersists: "State is fragmented.",
    affected: "Sellers",
    scaleEstimate: "Weekly",
    scaleBasisFactorId: "factor-1",
    factorIds: ["factor-1"],
    verdict: "confirmed",
    verdictReason: "Evidence survived.",
    verdictSourceIds: [],
  }]);
  client.db.prepare(`
    INSERT INTO research_runs (id, thread_id, status, config_json, problem_id, created_at, updated_at)
    VALUES (?, 'thread-1', 'completed', '{}', 'problem-1', ?, ?)
  `).run("development-1", now, now);
  client.db.prepare(`
    INSERT INTO research_runs (id, thread_id, status, config_json, problem_id, created_at, updated_at)
    VALUES (?, 'thread-1', 'completed', '{}', 'problem-1', ?, ?)
  `).run("development-2", now, now);
  return client;
}

function solution(id: string) {
  return {
    id,
    problemId: "problem-1",
    mechanism: "Reconcile state",
    description: "Check state before submitting.",
    respectsOffLimits: true,
    respectsOffLimitsWhy: "No prohibited action.",
    outcomes: [],
    risks: [],
    mitigations: [],
  };
}

function count(client: DatabaseClient, table: string): number {
  return (client.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}
