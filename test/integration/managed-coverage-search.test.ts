import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManagedCoverageSearchSources, runManagedCoverageSearch } from "../../src/core/managed-coverage-search";
import { markManagedCoverageGapCovered } from "../../src/core/managed-coverage-map";
import { DatabaseClient } from "../../src/db/client";
import { OpportunityExplorationRepository } from "../../src/db/repositories/opportunity-exploration";
import { WorkflowRepository } from "../../src/db/repositories/workflows";
import type { SearchClient } from "../../src/providers/search";
import type { Source } from "../../src/shared/schemas";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(candidateOrigin: "evidence-only" | "exploratory-allowed" = "evidence-only") {
  const directory = mkdtempSync(join(tmpdir(), "scraply-managed-gap-search-"));
  directories.push(directory);
  const db = new DatabaseClient(join(directory, "scraply.db"));
  const now = new Date().toISOString();
  db.db.prepare("INSERT INTO threads (id,title,status,created_at,updated_at) VALUES ('thread','Project','configuring',?,?)")
    .run(now, now);
  db.immediateTransaction(() => {
    const workflows = new WorkflowRepository(db);
    workflows.createSession({ id: "session", threadId: "thread", purpose: "discovery", mode: "vibe",
      contract: {}, remainingMs: 60_000 });
    workflows.createWorkItem({ id: "search-item", sessionId: "session", kind: "coverage-search",
      scopeKey: "gap-search:gap", state: "ready", input: { gapId: "gap" } });
    workflows.updateWorkItem("search-item", "running");
    new OpportunityExplorationRepository(db).saveGap("thread", {
      id: "gap", name: "Buyer evidence", description: "Find direct buyer accounts.",
      dimension: "evidence", evidenceNeeded: "Independent buyer accounts of delays",
      searchQuery: "repair shop approval delay interviews", mapExhausted: true,
      candidateOrigin, status: "search-needed", createdAt: now, updatedAt: now,
    }, "session", candidateOrigin === "exploratory-allowed");
  });
  return { db, input: { db, threadId: "thread", sessionId: "session", workItemId: "search-item",
    gapId: "gap", searchProvider: "exa" as const, signal: new AbortController().signal } };
}

function source(id: string): Source {
  return { id, url: `https://example.test/${id}`, title: `Source ${id}`, text: `Buyer account ${id}` };
}

test("managed gap search saves bounded evidence, marks the gap ready, and replays without a provider call", async () => {
  const { db, input } = fixture();
  let calls = 0;
  let dispatches = 0;
  const searchClient: SearchClient = {
    provider: "exa", validateKey: async () => ({ valid: true }),
    async search(query, options) {
      calls += 1;
      expect(query).toBe("repair shop approval delay interviews");
      expect(options).toMatchObject({ numResults: 5, maxCharacters: 4_000, timeoutMs: 45_000 });
      expect(options?.signal).toBeDefined();
      return [{ ...source("one"), title: "T".repeat(600), author: "A".repeat(250),
        publishedDate: "D".repeat(120) }, source("one"), source("two"), source("three"),
      source("four"), source("five")];
    },
  };
  try {
    const first = await runManagedCoverageSearch({ ...input, searchClient, onDispatched: () => { dispatches += 1; } });
    expect(first).toMatchObject({ replayed: false, noEvidenceReason: null });
    expect(first.sources.map((item) => item.id)).toEqual(["one", "two", "three", "four", "five"]);
    expect(first.sources[0]).toMatchObject({ title: "T".repeat(500), author: "A".repeat(200),
      publishedDate: "D".repeat(100) });
    expect(loadManagedCoverageSearchSources(db, "thread", "session", "gap")).toEqual(first.sources);
    const repository = new OpportunityExplorationRepository(db);
    expect(repository.listGaps("thread", "session")[0]?.status).toBe("ready");
    expect(repository.find("thread")).toBeNull();
    expect(db.db.prepare("SELECT status, session_id, work_item_id FROM opportunity_exploration_attempts WHERE id = ?")
      .get(first.attemptId)).toEqual({ status: "completed", session_id: "session", work_item_id: "search-item" });
    expect(dispatches).toBe(1);

    db.immediateTransaction(() => markManagedCoverageGapCovered(db, "thread", "session", "gap"));
    db.immediateTransaction(() => repository.saveGap("thread", {
      ...repository.listGaps("thread", "session")[0]!, searchQuery: "updated query after checkpoint",
      updatedAt: new Date().toISOString(),
    }, "session"));
    const replayed = await runManagedCoverageSearch({ ...input, onDispatched: () => { dispatches += 1; } });
    expect(replayed).toMatchObject({ attemptId: first.attemptId, replayed: true, sources: first.sources });
    expect(repository.listGaps("thread", "session")[0]?.status).toBe("covered");
    expect(calls).toBe(1);
    expect(dispatches).toBe(1);
  } finally { db.close(); }
});

test("an allowed exploratory gap can become ready after a completed search", async () => {
  const { db, input } = fixture("exploratory-allowed");
  const searchClient: SearchClient = {
    provider: "exa", validateKey: async () => ({ valid: true }),
    search: async () => [source("buyer-account")],
  };
  try {
    const result = await runManagedCoverageSearch({ ...input, searchClient });
    expect(result.sources).toHaveLength(1);
    expect(new OpportunityExplorationRepository(db).listGaps("thread", "session")[0])
      .toMatchObject({ candidateOrigin: "exploratory-allowed", status: "ready" });
  } finally { db.close(); }
});

test("empty evidence is a completed no-evidence result and cannot make a gap ready", async () => {
  const { db, input } = fixture();
  const searchClient: SearchClient = {
    provider: "exa", validateKey: async () => ({ valid: true }),
    search: async () => [],
  };
  try {
    const result = await runManagedCoverageSearch({ ...input, searchClient });
    expect(result.sources).toEqual([]);
    expect(result.noEvidenceReason).toContain("No usable evidence");
    expect(loadManagedCoverageSearchSources(db, "thread", "session", "gap")).toEqual([]);
    expect(new OpportunityExplorationRepository(db).listGaps("thread", "session")[0]?.status).toBe("exhausted");
    expect(new OpportunityExplorationRepository(db).completedAttempt("thread", "gap-search:gap", "session")?.result)
      .toMatchObject({ sources: [], noEvidenceReason: result.noEvidenceReason });
  } finally { db.close(); }
});

test("a dispatched search with uncertain completion is never replayed", async () => {
  const { db, input } = fixture();
  let calls = 0;
  const searchClient: SearchClient = {
    provider: "exa", validateKey: async () => ({ valid: true }),
    async search() { calls += 1; throw new Error("connection lost"); },
  };
  try {
    await expect(runManagedCoverageSearch({ ...input, searchClient })).rejects.toThrow("connection lost");
    expect(db.db.prepare("SELECT status FROM opportunity_exploration_attempts WHERE session_id = 'session'").get())
      .toEqual({ status: "unknown-dispatch" });
    await expect(runManagedCoverageSearch({ ...input, searchClient })).rejects.toThrow("will not be replayed automatically");
    expect(calls).toBe(1);
  } finally { db.close(); }
});
