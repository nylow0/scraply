import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MIGRATIONS } from "./migrations";
import { openDatabase, type SqlDatabase } from "./sqlite";

export class DatabaseClient {
  readonly db: SqlDatabase;
  private transactionActive = false;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = openDatabase(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    try {
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const applied = new Set(
      this.db.prepare("SELECT id FROM schema_migrations").all().map((row) => (row as { id: number }).id),
    );
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.id)) continue;
      this.db.exec("BEGIN");
      try {
        this.db.exec(migration.sql);
        this.db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(
          migration.id,
          new Date().toISOString(),
        );
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM app_meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, new Date().toISOString());
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, new Date().toISOString());
  }

  immediateTransaction<T>(
    operation: () => T & (T extends PromiseLike<unknown> ? never : unknown),
  ): T {
    if (this.transactionActive) throw new Error("Nested immediate transactions are not supported");
    if (operation.constructor.name === "AsyncFunction") {
      throw new Error("DatabaseClient.immediateTransaction callback must be synchronous");
    }
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionActive = true;
    try {
      const result = operation();
      if (isPromiseLike(result)) {
        throw new Error("DatabaseClient.immediateTransaction callback must be synchronous");
      }
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.transactionActive = false;
    }
  }

  requireImmediateTransaction(): void {
    if (!this.transactionActive) {
      throw new Error("This mutation requires a caller-owned immediate transaction");
    }
  }

  close(): void {
    this.db.close();
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object"
    && value !== null
    && "then" in value
    && typeof value.then === "function";
}
