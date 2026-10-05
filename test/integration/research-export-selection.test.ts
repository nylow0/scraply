import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBackend, type BackendHandle } from "../../src/backend/server";
import { materializeResearchSnapshot } from "../../src/core/research-revisions";
import { DatabaseClient } from "../../src/db/client";
import { WorkflowRepository } from "../../src/db/repositories/workflows";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";

const handles: BackendHandle[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const contract = {
  contractVersion: 1, purpose: "discovery", mode: "babysit", brief: "Research filing",
  scope: { title: "Filing", audience: "Owners", domain: "Invoices", observations: "Repeated entries", offLimits: [] },
  runConfig: DEFAULT_RUN_CONFIG, targets: { kind: "per-problem", ideaCount: 1 },
  limits: { maxMinutes: 60, maxModelCalls: 30, maxSearches: 20 }, instructions: {},
  resolvedInstructions: { research: "", ideas: "", review: "" }, instructionHashes: { research: "r", ideas: "i", review: "v" },
};

function saveRun(db: DatabaseClient, id: string, status: "completed" | "failed" | "cancelled", day: number) {
  const now = `2026-01-${String(day).padStart(2, "0")}T00:00:00.000Z`;
  db.db.prepare(`INSERT INTO research_runs (id,thread_id,status,config_json,purpose,created_at,updated_at)
    VALUES (?,'project',?,?,'discovery',?,?)`).run(id, status, JSON.stringify(DEFAULT_RUN_CONFIG), now, now);
  db.db.prepare(`INSERT INTO scopes (id,research_run_id,title,audience,domain,observations,off_limits_json,created_at,updated_at)
    VALUES (?,?,'Filing','Owners','Invoices','Repeated entries','[]',?,?)`).run(`scope-${id}`, id, now, now);
  db.db.prepare(`INSERT INTO sources (id,research_run_id,canonical_url,title,retrieved_text,content_hash,retrieved_at)
    VALUES (?,?,?,'Saved owner report',?,'hash',?)`).run(`source-${id}`, id, `https://example.test/${id}`, `Saved evidence for ${id}`, now);
  if (id !== "preparation") db.db.prepare(`INSERT INTO problems (id,discovery_run_id,statement,why_it_persists,affected,scale_estimate,verdict,
    verdict_reason,verdict_source_ids_json,created_at) VALUES (?,?,?,'Disconnected tools','Owners','Unknown','confirmed','Saved evidence','[]',?)`)
      .run(`problem-${id}`, id, `Finding from ${id}`, now);
}

function markPreparation(db: DatabaseClient, kind: "marker" | "work-item") {
  if (kind === "marker") db.db.prepare("INSERT INTO workflow_snapshots VALUES ('preparation','workflow-kind',?)")
    .run(JSON.stringify({ kind: "prepare-frame", knownProblem: false }));
  else db.immediateTransaction(() => {
    const workflows = new WorkflowRepository(db);
    const session = workflows.createSession({ id: "preparation-session", threadId: "project", purpose: "discovery", mode: "babysit",
      contract, remainingMs: 60_000 });
    db.db.prepare("UPDATE research_runs SET workflow_session_id=? WHERE id='preparation'").run(session.id);
    const work = workflows.createWorkItem({ sessionId: session.id, kind: "prepare-frame", scopeKey: "preparation", input: {}, state: "ready" });
    workflows.updateWorkItem(work.id, "running");
    workflows.updateWorkItem(work.id, "succeeded", { outputRefs: { runId: "preparation" } });
    workflows.updateSession(session.id, session.revision, { state: "finished", outcome: "partial" });
  });
}

async function exportResearch(seed: (db: DatabaseClient) => void) {
  const directory = mkdtempSync(join(tmpdir(), "scraply-export-selection-")); directories.push(directory);
  const dbPath = join(directory, "test.db");
  const db = new DatabaseClient(dbPath);
  const now = new Date().toISOString();
  db.db.prepare("INSERT INTO threads (id,title,status,created_at,updated_at) VALUES ('project','Filing','problems-ready',?,?)").run(now, now);
  try { seed(db); } finally { db.close(); }
  const handle = await startBackend({ dataDir: directory, dbPath, bundledPromptsDir: join(process.cwd(), "prompts"),
    promptOverridesDir: join(directory, "prompts"), appVersion: "test", getSecrets: () => ({ exaApiKey: null }) }, () => {});
  handles.push(handle);
  const response = await fetch(`http://127.0.0.1:${handle.port}/research/export`, { method: "POST",
    headers: { authorization: `Bearer ${handle.token}`, "content-type": "application/json" }, body: JSON.stringify({ threadId: "project" }) });
  expect(response.status).toBe(200);
  const bundle = (await response.json() as { data: { content: string } }).data;
  return JSON.parse(bundle.content) as { researchRun: { id: string; status: string }; sources: Array<{ id: string; text: string }>;
    problems: Array<{ id: string }> };
}

for (const identification of ["marker", "work-item"] as const) {
  for (const status of ["failed", "cancelled"] as const) {
    test(`exports ${status} discovery evidence after ${identification} frame preparation`, async () => {
      const exported = await exportResearch(db => {
        saveRun(db, "preparation", "completed", 2);
        markPreparation(db, identification);
        saveRun(db, "partial-discovery", status, 3);
      });
      expect(exported.researchRun).toEqual(expect.objectContaining({ id: "partial-discovery", status }));
      expect(exported.sources).toEqual([expect.objectContaining({ id: "source-partial-discovery", text: "Saved evidence for partial-discovery" })]);
      expect(exported.problems.map(problem => problem.id)).toEqual(["problem-partial-discovery"]);
    });
  }
}

test("export prefers prior completed legacy discovery over newer preparation and failed work", async () => {
  const exported = await exportResearch(db => {
    saveRun(db, "completed-discovery", "completed", 1);
    saveRun(db, "preparation", "completed", 2);
    markPreparation(db, "marker");
    saveRun(db, "partial-discovery", "failed", 3);
  });
  expect(exported.researchRun.id).toBe("completed-discovery");
  expect(exported.sources.map(source => source.id)).toEqual(["source-completed-discovery"]);
});

test("preparation-only project retains its persisted export fallback", async () => {
  const exported = await exportResearch(db => {
    saveRun(db, "preparation", "completed", 2);
    markPreparation(db, "marker");
  });
  expect(exported.researchRun.id).toBe("preparation");
  expect(exported.sources.map(source => source.id)).toEqual(["source-preparation"]);
});

test("malformed historical workflow-kind does not disqualify completed discovery", async () => {
  const exported = await exportResearch(db => {
    saveRun(db, "completed-discovery", "completed", 1);
    db.db.exec("PRAGMA ignore_check_constraints = ON");
    try { db.db.prepare("INSERT INTO workflow_snapshots VALUES ('completed-discovery','workflow-kind','{')").run(); }
    finally { db.db.exec("PRAGMA ignore_check_constraints = OFF"); }
    saveRun(db, "partial-discovery", "failed", 3);
  });
  expect(exported.researchRun.id).toBe("completed-discovery");
});

test("explicit active snapshot wins over completed discovery and preparation", async () => {
  let materializationRunId = "";
  const exported = await exportResearch(db => {
    saveRun(db, "snapshot-source", "completed", 1);
    saveRun(db, "completed-discovery", "completed", 2);
    saveRun(db, "preparation", "completed", 3);
    markPreparation(db, "marker");
    const workflows = new WorkflowRepository(db);
    db.immediateTransaction(() => {
      const session = workflows.createSession({ id: "active-session", threadId: "project", purpose: "discovery", mode: "babysit",
        contract, remainingMs: 60_000 });
      const materialized = materializeResearchSnapshot(db, { threadId: "project", baseRunId: "snapshot-source",
        sourceProblemIds: ["problem-snapshot-source"], sessionId: session.id });
      materializationRunId = materialized.runId;
      const snapshot = workflows.createSnapshot({ sessionId: session.id, materializationRunId: materialized.runId,
        selection: { problemIds: materialized.problemIds, sourceProblemIds: ["problem-snapshot-source"] }, originMap: materialized.originMap });
      workflows.updateSession(session.id, session.revision, { state: "waiting-for-review", activeSnapshotId: snapshot.id });
    });
  });
  expect(exported.researchRun.id).toBe(materializationRunId);
  expect(exported.problems).toHaveLength(1);
});
