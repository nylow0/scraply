import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureAreaInvestigatorWorkItems, ensureEvidenceCheckWorkItem, runManagedInvestigatorSearch } from "../../src/core/evidence-investigators";
import { DatabaseClient } from "../../src/db/client";
import { WorkflowRepository } from "../../src/db/repositories/workflows";
import { OpportunityExplorationRepository } from "../../src/db/repositories/opportunity-exploration";
import type { SearchOptions, SearchProvider } from "../../src/providers/search";
import { chooseSearchProvider } from "../../src/providers/source-routes";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "scraply-investigator-search-"));
  directories.push(directory);
  const path = join(directory, "scraply.db");
  const db = new DatabaseClient(path);
  const now = new Date().toISOString();
  db.db.prepare("INSERT INTO threads (id,title,status,created_at,updated_at) VALUES ('thread','Project','configuring',?,?)").run(now, now);
  db.immediateTransaction(() => {
    const repository = new WorkflowRepository(db);
    repository.createSession({ id: "session", threadId: "thread", purpose: "discovery", mode: "vibe", contract: {}, remainingMs: 60_000 });
    repository.createWorkItem({ id: "item", sessionId: "session", kind: "evidence-check", scopeKey: "candidate", input: {}, state: "ready" });
    repository.updateWorkItem("item", "running");
  });
  const input = { db, threadId: "thread", sessionId: "session", workItemId: "item", searchProvider: "exa" as const,
    request: { key: "close:problem:round-1:gap-1", query: "bank-feed duplicate entries experience", route: "community" as const,
      evidenceNeeded: "A second independent bookkeeper" }, signal: new AbortController().signal };
  return { db, input, path };
}

test("a completed investigator search survives database restart and an unavailable provider", async () => {
  const item = fixture();
  let calls = 0;
  const first = await runManagedInvestigatorSearch({ ...item.input, searchClient: { provider: "exa", async search(_query, options) {
    calls++;
    expect(options).toMatchObject({ numResults: 5, maxCharacters: 4_000 });
    return [{ id: "actor", url: "https://forum.example.test/actor", title: "Firsthand account", text: "I fix duplicated entries each month." }];
  } } });
  item.db.close();
  const restarted = new DatabaseClient(item.path);
  try {
    const replayed = await runManagedInvestigatorSearch({ ...item.input, db: restarted });
    expect(replayed).toEqual({ ...first, replayed: true });
    expect(calls).toBe(1);
  } finally { restarted.close(); }
});

test("an uncertain investigator dispatch remains blocked after restart and is never automatically resent", async () => {
  const item = fixture();
  let calls = 0;
  const client = { provider: "exa" as const, async search() { calls++; throw new Error("Connection lost after dispatch"); } };
  await expect(runManagedInvestigatorSearch({ ...item.input, searchClient: client })).rejects.toThrow("Connection lost");
  item.db.close();
  const restarted = new DatabaseClient(item.path);
  try {
    await expect(runManagedInvestigatorSearch({ ...item.input, db: restarted, searchClient: client })).rejects.toThrow("will not be replayed automatically");
    expect(calls).toBe(1);
    expect(restarted.db.prepare("SELECT status FROM opportunity_exploration_attempts WHERE session_id = 'session'").get())
      .toEqual({ status: "unknown-dispatch" });
  } finally { restarted.close(); }
});

test("a prepared request can wait for its provider but cannot silently change query identity", async () => {
  const item = fixture();
  try {
    await expect(runManagedInvestigatorSearch(item.input)).rejects.toThrow("unavailable");
    await expect(runManagedInvestigatorSearch({ ...item.input, request: { ...item.input.request, query: "different query" } })).rejects.toThrow("identity changed");
    expect(item.db.db.prepare("SELECT status FROM opportunity_exploration_attempts WHERE session_id = 'session'").get())
      .toEqual({ status: "prepared" });
  } finally { item.db.close(); }
});

test("area investigators and their evidence children preserve task ownership across restart", () => {
  const item = fixture();
  const area = { id: "close", name: "Monthly close", affectedPeople: "Bookkeepers", whyRelevant: "Duplicate entries",
    venues: [{ name: "Forum", kind: "community" as const }], exampleProblems: [], included: true, priority: 1 };
  const first = ensureAreaInvestigatorWorkItems(item.db, "session", "item", area);
  const candidate = ensureEvidenceCheckWorkItem(item.db, "session", first.parent.id, area.id, "candidate");
  item.db.close();
  const restarted = new DatabaseClient(item.path);
  try {
    const again = ensureAreaInvestigatorWorkItems(restarted, "session", "item", area);
    expect(again).toEqual(first);
    expect(ensureEvidenceCheckWorkItem(restarted, "session", again.parent.id, area.id, "candidate")).toEqual(candidate);
    const children = new WorkflowRepository(restarted).listWorkItems("session").filter(task => task.parentItemId === first.parent.id);
    expect(children.map(task => task.kind).sort()).toEqual(["area-candidates", "area-research", "evidence-check"]);
  } finally { restarted.close(); }
});

test.each([
  { available: { exa: true, perplexity: true }, route: "community" as const, expected: "exa" },
  { available: { exa: true, perplexity: true }, route: "alternatives" as const, expected: "perplexity" },
  { available: { exa: true, perplexity: false }, route: "alternatives" as const, expected: "exa" },
  { available: { exa: false, perplexity: true }, route: "community" as const, expected: "perplexity" },
])("auto investigator routing freezes its actual provider and route parameters (%s)", async entry => {
  const item = fixture();
  try {
    const request = { ...item.input.request, route: entry.route };
    const sourceRouting = { languages: ["uk"], region: "ua", now: new Date("2026-10-01T00:00:00.000Z"),
      venues: [{ name: "Owners", kind: "community" as const, domain: "owners.example.org" }] };
    const client = { provider: (entry.available.exa ? "exa" : "perplexity") as SearchProvider,
      providerForRoute: () => chooseSearchProvider("auto", entry.available, request.route),
      async search(_query: string, options?: SearchOptions) {
        expect(options).toMatchObject({ route: entry.route, provider: entry.expected, userLocation: "UA" });
        if (entry.route === "community") expect(options).toMatchObject({ languages: ["en", "uk"],
          startPublishedDate: "2023-10-01T00:00:00.000Z", includeDomains: expect.arrayContaining(["owners.example.org", "reddit.com"]) });
        return [{ id: "farm", url: "https://worldmetrics.org/bakery-statistics", title: "Unsupported statistics", text: "A claim" },
          { id: "owner", url: "https://owners.example.org/report", title: "Owner account", text: "I repeat filing." }];
      } };
    const result = await runManagedInvestigatorSearch({ ...item.input, request, searchProvider: "auto", searchClient: client, sourceRouting });
    expect(result.sources.map(source => source.id)).toEqual(["owner"]);
    const saved = new OpportunityExplorationRepository(item.db).loadAttempt("thread", `investigator-search:${request.key}`, "session")!;
    expect(saved.model).toMatchObject({ providerId: entry.expected });
    expect(saved.input).toMatchObject({ request, parameters: { route: entry.route, provider: entry.expected } });
    const replay = await runManagedInvestigatorSearch({ ...item.input, request, searchProvider: "auto",
      sourceRouting: { ...sourceRouting, now: new Date("2030-01-01") } });
    expect(replay).toEqual({ ...result, replayed: true });
  } finally { item.db.close(); }
});

test("zero-yield route changes produce a different actual provider request", async () => {
  const item = fixture();
  const routes: string[] = [];
  try {
    const client = { provider: "exa" as const, providerForRoute: () => "exa" as const,
      async search(_query: string, options?: SearchOptions) {
        routes.push(options?.route ?? "missing");
        expect(options?.includeDomains).toEqual(options?.route === "community"
          ? ["reddit.com", "stackexchange.com", "stackoverflow.com", "news.ycombinator.com"] : ["github.com", "gitlab.com"]);
        return [];
      } };
    await runManagedInvestigatorSearch({ ...item.input, searchProvider: "auto", searchClient: client });
    await runManagedInvestigatorSearch({ ...item.input, searchProvider: "auto", searchClient: client,
      request: { ...item.input.request, key: "close:problem:round-2:gap-1", route: "issue-tracker" } });
    expect(routes).toEqual(["community", "issue-tracker"]);
  } finally { item.db.close(); }
});

test.each([false, true])("only an exact acknowledged lost managed search permits an immutable deterministic retry (legacy failed: %s)", async legacyFailed => {
  const item = fixture();
  let calls = 0;
  const client = { provider: "exa" as const, async search() {
    calls++;
    if (calls < 3) throw new Error("Lost response after dispatch");
    return [{ id: "owner", url: "https://owners.example.org/report", title: "Owner account", text: "I repeat filing." }];
  } };
  try {
    await expect(runManagedInvestigatorSearch({ ...item.input, searchClient: client })).rejects.toThrow("Lost response");
    const repo = new OpportunityExplorationRepository(item.db);
    const originalKey = `investigator-search:${item.input.request.key}`;
    if (legacyFailed) item.db.db.prepare("UPDATE opportunity_exploration_attempts SET status = 'failed' WHERE stage_key = ?").run(originalKey);
    const original = repo.loadAttempt("thread", originalKey, "session")!;
    await expect(runManagedInvestigatorSearch({ ...item.input, searchClient: client, acknowledgedAttemptIds: ["unrelated"] }))
      .rejects.toThrow("will not be replayed automatically");
    await expect(runManagedInvestigatorSearch({ ...item.input, searchClient: client, acknowledgedAttemptIds: [original.attemptId],
      request: { ...item.input.request, query: "Changed while retrying" } })).rejects.toThrow("identity changed");
    expect(calls).toBe(1);
    await expect(runManagedInvestigatorSearch({ ...item.input, searchClient: client, acknowledgedAttemptIds: [original.attemptId] }))
      .rejects.toThrow("Lost response");
    const retry = repo.loadAttempt("thread", `${originalKey}:retry:${original.attemptId}`, "session")!;
    await expect(runManagedInvestigatorSearch({ ...item.input, searchClient: client, acknowledgedAttemptIds: [original.attemptId] }))
      .rejects.toThrow("will not be replayed automatically");
    expect(calls).toBe(2);
    const acknowledgements = [original.attemptId, retry.attemptId];
    const completed = await runManagedInvestigatorSearch({ ...item.input, searchClient: client, acknowledgedAttemptIds: acknowledgements });
    expect(calls).toBe(3);
    expect(repo.loadAttempt("thread", originalKey, "session")).toEqual(original);
    expect(repo.loadAttempt("thread", `${originalKey}:retry:${original.attemptId}`, "session")).toEqual(retry);
    const replay = await runManagedInvestigatorSearch({ ...item.input, acknowledgedAttemptIds: acknowledgements });
    expect(replay).toEqual({ ...completed, replayed: true });
    expect(calls).toBe(3);
  } finally { item.db.close(); }
});
