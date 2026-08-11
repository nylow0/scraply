import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { DatabaseClient } from "../../src/db/client";
import { MIGRATIONS } from "../../src/db/migrations";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { rmSync(dir, { recursive: true, force: true }); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1))); }
    }
  }
});
function pathForTest() { const dir = mkdtempSync(join(tmpdir(), "scraply-migration-")); dirs.push(dir); return join(dir, "scraply.db"); }
function tableNames(db: Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
}

describe("destructive graph cutover", () => {
  test("creates only the surviving runtime and graph tables on a fresh database", () => {
    const client = new DatabaseClient(pathForTest());
    const tables = tableNames(client.db as unknown as Database);
    for (const name of ["threads", "messages", "run_configs", "research_runs", "sources", "cost_ledger", "scopes", "factors", "problems", "problem_factors", "solutions", "outcomes", "risks", "mitigations", "risk_mitigations"]) expect(tables).toContain(name);
    for (const name of ["intake_answers", "briefs", "stream_runs", "claims", "claim_evidence", "ideas", "reports", "branch_contexts", "ratings", "idea_ratings", "rating_history"]) expect(tables).not.toContain(name);
    expect(client.db.prepare("SELECT MAX(id) AS id FROM schema_migrations").get()).toEqual({ id: 9 });
    client.close();
  });

  test("upgrades an installed Phase 2 database without deleting the new graph", () => {
    const dbPath = pathForTest();
    const legacy = new Database(dbPath);
    legacy.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (const migration of MIGRATIONS.filter((item) => item.id <= 8)) {
      legacy.exec("BEGIN");
      try { legacy.exec(migration.sql); legacy.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(migration.id, "2026-08-01T00:00:00.000Z"); legacy.exec("COMMIT"); }
      catch (error) { legacy.exec("ROLLBACK"); throw error; }
    }
    const now = "2026-08-01T00:00:00.000Z";
    legacy.prepare("INSERT INTO threads (id, title, status, created_at, updated_at) VALUES ('thread-1','Legacy','ideas-ready',?,?)").run(now, now);
    legacy.prepare("INSERT INTO messages (id, thread_id, role, content, created_at) VALUES ('report-message','thread-1','report','old',?)").run(now);
    legacy.prepare("INSERT INTO messages (id, thread_id, role, content, created_at) VALUES ('event-message','thread-1','event','keep',?)").run(now);
    legacy.prepare(`INSERT INTO research_runs (id, thread_id, status, config_json, spend_estimate, round, cancelled, created_at, updated_at, budget_limit, reserved_cost, committed_cost, selected_stream_ids_json) VALUES ('run-1','thread-1','completed','{}',0,0,0,?,?,0,0,0,'[]')`).run(now, now);
    legacy.prepare("INSERT INTO scopes (id,research_run_id,title,audience,domain,observations,off_limits_json,created_at,updated_at) VALUES ('scope-1','run-1','Title','Audience','Domain','','[]',?,?)").run(now, now);
    legacy.prepare("INSERT INTO problems (id,discovery_run_id,statement,why_it_persists,affected,scale_estimate,verdict,verdict_reason,verdict_source_ids_json,created_at) VALUES ('problem-1','run-1','Problem','','','','confirmed','','[]',?)").run(now);
    legacy.close();

    const migrated = new DatabaseClient(dbPath);
    expect(migrated.db.prepare("SELECT statement FROM problems WHERE id = 'problem-1'").get()).toEqual({ statement: "Problem" });
    expect(migrated.db.prepare("SELECT id FROM messages ORDER BY id").all()).toEqual([{ id: "event-message" }]);
    expect(migrated.db.prepare("SELECT status FROM threads WHERE id = 'thread-1'").get()).toEqual({ status: "configuring" });
    const runColumns = (migrated.db.prepare("PRAGMA table_info(research_runs)").all() as Array<{ name: string }>).map((row) => row.name);
    expect(runColumns).not.toContain("brief_json"); expect(runColumns).not.toContain("selected_stream_ids_json"); expect(runColumns).not.toContain("round");
    const threadColumns = (migrated.db.prepare("PRAGMA table_info(threads)").all() as Array<{ name: string }>).map((row) => row.name);
    expect(threadColumns).not.toContain("parent_thread_id");
    migrated.close();
  });
});
