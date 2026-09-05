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
    for (const name of ["threads", "messages", "run_configs", "research_runs", "job_events", "sources", "cost_ledger", "generation_attempts", "scopes", "factors", "problems", "problem_factors", "problem_verdict_sources", "rejected_problem_candidates", "solutions", "outcomes", "risks", "mitigations", "risk_mitigations", "stage_results", "decision_analyses"]) expect(tables).toContain(name);
    for (const name of ["intake_answers", "briefs", "stream_runs", "claims", "claim_evidence", "ideas", "reports", "branch_contexts", "ratings", "idea_ratings", "rating_history"]) expect(tables).not.toContain(name);
    expect(client.db.prepare("SELECT MAX(id) AS id FROM schema_migrations").get()).toEqual({ id: 16 });
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
    legacy.prepare("INSERT INTO sources (id,research_run_id,canonical_url,title,retrieved_text,content_hash,retrieved_at) VALUES ('source-1','run-1','https://example.test/source-1','Source','Evidence','hash-1',?)").run(now);
    legacy.prepare("INSERT INTO problems (id,discovery_run_id,statement,why_it_persists,affected,scale_estimate,verdict,verdict_reason,verdict_source_ids_json,created_at) VALUES ('problem-1','run-1','Problem','','','','confirmed','',?,?)")
      .run(JSON.stringify(["source-1", "missing-source", "source-1"]), now);
    legacy.prepare("INSERT INTO problems (id,discovery_run_id,statement,why_it_persists,affected,scale_estimate,verdict,verdict_reason,verdict_source_ids_json,created_at) VALUES ('problem-malformed','run-1','Malformed legacy evidence','','','','confirmed','','{',?)")
      .run(now);
    legacy.prepare(`INSERT INTO research_runs (id, thread_id, problem_id, status, config_json, spend_estimate, round, cancelled, created_at, updated_at, budget_limit, reserved_cost, committed_cost, selected_stream_ids_json) VALUES ('run-dev','thread-1','problem-1','completed','{}',0,0,0,?,?,0,0,0,'[]')`).run(now, now);
    legacy.prepare("INSERT INTO job_events (run_id,thread_id,type,payload_json,created_at) VALUES ('run-1','thread-1','run-progress',?,?)")
      .run(JSON.stringify({ type: "run-progress", runId: "run-1", threadId: "thread-1", message: "Legacy progress" }), now);
    legacy.prepare("INSERT INTO job_events (run_id,thread_id,type,payload_json,created_at) VALUES ('run-dev','thread-1','run-started',?,?)")
      .run(JSON.stringify({ type: "run-started", runId: "run-dev", threadId: "thread-1", problemId: "problem-1" }), now);
    legacy.close();

    const migrated = new DatabaseClient(dbPath);
    expect(migrated.db.prepare("SELECT statement FROM problems WHERE id = 'problem-1'").get()).toEqual({ statement: "Problem" });
    expect(migrated.db.prepare("SELECT DISTINCT verdict_source_ids_json FROM problems").all())
      .toEqual([{ verdict_source_ids_json: "[]" }]);
    expect(migrated.db.prepare("SELECT problem_id, source_id, research_run_id, position FROM problem_verdict_sources").all())
      .toEqual([{ problem_id: "problem-1", source_id: "source-1", research_run_id: "run-1", position: 0 }]);
    expect(migrated.db.prepare("SELECT run_id, thread_id, problem_id, payload_json FROM job_events ORDER BY id").all())
      .toEqual([{
        run_id: "run-1",
        thread_id: "thread-1",
        problem_id: null,
        payload_json: JSON.stringify({ type: "run-progress", message: "Legacy progress" }),
      }, {
        run_id: "run-dev",
        thread_id: "thread-1",
        problem_id: "problem-1",
        payload_json: JSON.stringify({ type: "run-started" }),
      }]);
    expect(migrated.db.prepare("SELECT id FROM messages ORDER BY id").all()).toEqual([{ id: "event-message" }]);
    expect(migrated.db.prepare("SELECT status FROM threads WHERE id = 'thread-1'").get()).toEqual({ status: "configuring" });
    const runColumns = (migrated.db.prepare("PRAGMA table_info(research_runs)").all() as Array<{ name: string }>).map((row) => row.name);
    expect(runColumns).not.toContain("brief_json"); expect(runColumns).not.toContain("selected_stream_ids_json"); expect(runColumns).not.toContain("round");
    const threadColumns = (migrated.db.prepare("PRAGMA table_info(threads)").all() as Array<{ name: string }>).map((row) => row.name);
    expect(threadColumns).not.toContain("parent_thread_id");
    migrated.db.prepare("DELETE FROM sources WHERE id = 'source-1'").run();
    expect(migrated.db.prepare("SELECT COUNT(*) AS count FROM problem_verdict_sources").get()).toEqual({ count: 0 });
    migrated.db.prepare("DELETE FROM problems WHERE id = 'problem-1'").run();
    expect(migrated.db.prepare("SELECT COUNT(*) AS count FROM job_events WHERE problem_id = 'problem-1'").get()).toEqual({ count: 0 });
    expect(migrated.db.prepare("SELECT COUNT(*) AS count FROM research_runs WHERE id = 'run-dev'").get()).toEqual({ count: 0 });
    migrated.db.prepare("DELETE FROM threads WHERE id = 'thread-1'").run();
    expect(migrated.db.prepare("SELECT COUNT(*) AS count FROM job_events").get()).toEqual({ count: 0 });
    migrated.close();
  });

  test("replaces the legacy 5.2 default in saved run configurations", () => {
    const dbPath = pathForTest();
    const legacy = new Database(dbPath);
    legacy.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (const migration of MIGRATIONS.filter((item) => item.id <= 9)) {
      legacy.exec(migration.sql);
      legacy.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
        .run(migration.id, "2026-08-12T00:00:00.000Z");
    }
    const now = "2026-08-12T00:00:00.000Z";
    legacy.prepare("INSERT INTO threads (id, title, status, created_at, updated_at) VALUES ('thread-1','Legacy model','configuring',?,?)").run(now, now);
    legacy.prepare("INSERT INTO run_configs (id, thread_id, config_json, created_at) VALUES ('config-1','thread-1',?,?)")
      .run(JSON.stringify({ model: "gpt-5.2-codex", discoveryDepth: "standard", maxRunMinutes: 90 }), now);
    legacy.close();

    const migrated = new DatabaseClient(dbPath);
    const row = migrated.db.prepare("SELECT config_json FROM run_configs WHERE id = 'config-1'").get() as { config_json: string };
    expect(JSON.parse(row.config_json)).toMatchObject({
      configVersion: 2,
      model: { providerId: "legacy-codex-cli", modelId: "gpt-5.6-luna" },
    });
    migrated.close();
  });
});
