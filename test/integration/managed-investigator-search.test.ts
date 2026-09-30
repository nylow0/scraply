import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureAreaInvestigatorWorkItems, ensureEvidenceCheckWorkItem, runManagedInvestigatorSearch } from "../../src/core/evidence-investigators";
import { DatabaseClient } from "../../src/db/client";
import { WorkflowRepository } from "../../src/db/repositories/workflows";

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
