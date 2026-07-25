import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseClient } from "../../src/db/client";
import { MIGRATIONS } from "../../src/db/migrations";
import { openDatabase, type SqlDatabase } from "../../src/db/sqlite";

function createDatabaseAtVersion(path: string, version = 3): SqlDatabase {
  const db = openDatabase(path);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE schema_migrations (
      id INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  for (const migration of MIGRATIONS.filter((item) => item.id <= version)) {
    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
        .run(migration.id, "2026-07-01T00:00:00.000Z");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return db;
}

function insertIdea(db: SqlDatabase, ideaId: string): void {
  db.prepare(`
    INSERT INTO ideas (id, thread_id, title, description, bucket, scores_json, supporting_claim_ids_json, created_at)
    VALUES (?, 'thread-1', ?, 'Description', 'strong-fit', '{}', '[]', '2026-07-01T00:00:00.000Z')
  `).run(ideaId, ideaId);
}

describe("rating migration", () => {
  test("reconciles legacy history while preserving a newer current rating", () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-migration-"));
    const dbPath = join(dir, "scraply.db");
    const legacy = createDatabaseAtVersion(dbPath);
    legacy.prepare(`
      INSERT INTO threads (id, title, status, created_at, updated_at)
      VALUES ('thread-1', 'Migration', 'ideas-ready', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
    `).run();
    insertIdea(legacy, "idea-1");
    insertIdea(legacy, "idea-2");
    legacy.prepare("INSERT INTO ratings (idea_id, rating, notes, created_at) VALUES (?, ?, ?, ?)")
      .run("idea-1", 3, "first", "2026-07-01T01:00:00.000Z");
    legacy.prepare("INSERT INTO ratings (idea_id, rating, notes, created_at) VALUES (?, ?, ?, ?)")
      .run("idea-1", 5, "latest legacy", "2026-07-01T02:00:00.000Z");
    legacy.prepare("INSERT INTO ratings (idea_id, rating, notes, created_at) VALUES (?, ?, ?, ?)")
      .run("idea-2", 1, null, "2026-07-01T03:00:00.000Z");
    legacy.prepare("INSERT INTO idea_ratings (idea_id, rating, notes, updated_at) VALUES (?, ?, ?, ?)")
      .run("idea-1", 4, "newer current", "2026-07-01T04:00:00.000Z");
    legacy.prepare("INSERT INTO rating_history (idea_id, rating, notes, created_at) VALUES (?, ?, ?, ?)")
      .run("idea-1", 3, "first", "2026-07-01T01:00:00.000Z");
    legacy.close();

    const migrated = new DatabaseClient(dbPath);
    expect(migrated.db.prepare("SELECT rating, notes FROM idea_ratings WHERE idea_id = 'idea-1'").get())
      .toEqual({ rating: 4, notes: "newer current" });
    expect(migrated.db.prepare("SELECT rating, notes FROM idea_ratings WHERE idea_id = 'idea-2'").get())
      .toEqual({ rating: 1, notes: null });
    expect((migrated.db.prepare("SELECT COUNT(*) AS count FROM rating_history").get() as { count: number }).count).toBe(3);
    expect(migrated.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    migrated.close();

    const reopened = new DatabaseClient(dbPath);
    expect((reopened.db.prepare("SELECT COUNT(*) AS count FROM rating_history").get() as { count: number }).count).toBe(3);
    expect(reopened.db.prepare("SELECT id FROM schema_migrations ORDER BY id").all())
      .toEqual(MIGRATIONS.map((migration) => ({ id: migration.id })));
    reopened.close();
  });

  test("rejects invalid legacy ratings without marking the migration applied", () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-migration-invalid-"));
    const dbPath = join(dir, "scraply.db");
    const db = createDatabaseAtVersion(dbPath);
    db.prepare(`
      INSERT INTO threads (id, title, status, created_at, updated_at)
      VALUES ('thread-1', 'Migration', 'ideas-ready', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
    `).run();
    insertIdea(db, "idea-1");
    db.prepare("INSERT INTO ratings (idea_id, rating, notes, created_at) VALUES ('idea-1', 6, NULL, '2026-07-01T01:00:00.000Z')")
      .run();

    db.close();

    expect(() => new DatabaseClient(dbPath)).toThrow("Legacy ratings require repair before migration");

    const reopened = openDatabase(dbPath);
    expect(reopened.prepare("SELECT id FROM schema_migrations WHERE id = 4").get()).toBeNull();
    expect((reopened.prepare("SELECT COUNT(*) AS count FROM rating_history").get() as { count: number }).count).toBe(0);
    reopened.close();
  });
});

describe("job event cleanup migration", () => {
  test("removes orphaned audit rows and keeps future thread deletion clean", () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-job-events-"));
    const dbPath = join(dir, "scraply.db");
    const legacy = createDatabaseAtVersion(dbPath, 4);
    legacy.prepare(`
      INSERT INTO job_events (run_id, thread_id, type, payload_json, created_at)
      VALUES ('missing-run', 'missing-thread', 'orphan', '{}', '2026-07-01T00:00:00.000Z')
    `).run();
    legacy.close();

    const migrated = new DatabaseClient(dbPath);
    expect((migrated.db.prepare("SELECT COUNT(*) AS count FROM job_events").get() as { count: number }).count).toBe(0);
    migrated.db.prepare(`
      INSERT INTO threads (id, title, status, created_at, updated_at)
      VALUES ('thread-events', 'Events', 'intake', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
    `).run();
    migrated.db.prepare(`
      INSERT INTO job_events (run_id, thread_id, type, payload_json, created_at)
      VALUES (NULL, 'thread-events', 'thread-event', '{}', '2026-07-01T00:00:00.000Z')
    `).run();
    migrated.db.prepare("DELETE FROM threads WHERE id = 'thread-events'").run();
    expect((migrated.db.prepare("SELECT COUNT(*) AS count FROM job_events").get() as { count: number }).count).toBe(0);
    migrated.close();
  });
});
