import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { MIGRATIONS } from "./migrations";
import { openDatabase, type SqlDatabase } from "./sqlite";

export class DatabaseClient {
  readonly db: SqlDatabase;
  preMigrationBackupPath: string | null = null;
  private transactionActive = false;

  constructor(private readonly dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = openDatabase(dbPath);
    try {
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  migrate(): void {
    // Read the old schema before even creating schema_migrations. A WAL-aware SQLite
    // snapshot is required before the product-rework migrations touch saved data.
    const existingTables = this.db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `).all() as { name: string }[];
    const hasMigrationTable = existingTables.some((row) => row.name === "schema_migrations");
    const applied = new Set(hasMigrationTable
      ? this.db.prepare("SELECT id FROM schema_migrations").all().map((row) => (row as { id: number }).id)
      : []);
    const pendingProductMigrations = MIGRATIONS.filter((migration) =>
      migration.id >= 30 && migration.id <= 33 && !applied.has(migration.id));
    if (existingTables.length > 0 && pendingProductMigrations.length > 0) {
      this.preMigrationBackupPath = this.createPreMigrationBackup(Math.max(0, ...applied));
      console.info(`Pre-migration database backup: ${this.preMigrationBackupPath}`);
    }
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.id)) continue;
      const rebuild = "rebuildReferencedTable" in migration && migration.rebuildReferencedTable;
      // SQLite requires this before BEGIN. Preserve child rows and references while
      // replacing their parent, then validate the entire graph before committing.
      if (rebuild) this.db.exec("PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = ON;");
      this.db.exec("BEGIN");
      this.transactionActive = true;
      try {
        if (migration.sql) this.db.exec(migration.sql);
        if ("afterSql" in migration) migration.afterSql(this);
        if (rebuild && this.db.prepare("PRAGMA foreign_key_check").all().length > 0) {
          throw new Error(`Migration ${migration.id} would break saved research references`);
        }
        this.db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(
          migration.id,
          new Date().toISOString(),
        );
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      } finally {
        this.transactionActive = false;
        if (rebuild) this.db.exec("PRAGMA legacy_alter_table = OFF; PRAGMA foreign_keys = ON;");
      }
    }
    if (this.preMigrationBackupPath) {
      this.setMeta("last_pre_migration_backup_path", this.preMigrationBackupPath);
    }
  }

  private createPreMigrationBackup(startingVersion: number): string {
    const stamp = new Date().toISOString().replace(/[^0-9]/g, "");
    const backupPath = resolve(`${this.dbPath}.pre-migration-v${startingVersion}-${stamp}-${randomUUID()}.db`);
    const synchronous = this.db.prepare("PRAGMA synchronous").get() as { synchronous: number };
    try {
      // FULL asks SQLite to sync the VACUUM INTO output before the upgrade begins.
      this.db.exec("PRAGMA synchronous = FULL;");
      this.db.prepare("VACUUM INTO ?").run(backupPath);
      const backup = openDatabase(backupPath);
      try {
        const check = backup.prepare("PRAGMA quick_check").get() as { quick_check: string };
        if (check.quick_check !== "ok") throw new Error("Backup failed SQLite quick_check");
      } finally {
        backup.close();
      }
      return backupPath;
    } catch (error) {
      rmSync(backupPath, { force: true });
      throw new Error(`Database upgrade stopped because its backup failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.db.exec(`PRAGMA synchronous = ${synchronous.synchronous};`);
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
