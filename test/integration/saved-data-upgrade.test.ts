import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { DatabaseClient } from "../../src/db/client";
import { OpportunityExplorationRepository } from "../../src/db/repositories/opportunity-exploration";
import { OpportunityRepository } from "../../src/db/repositories/opportunities";
import type { SqlDatabase } from "../../src/db/sqlite";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function savedFixture(): string | null {
  const explicit = process.env.SCRAPLY_SAVED_DB_FIXTURE;
  if (explicit) return explicit;
  const directory = join(process.cwd(), ".scraply", "browser-dev", "scraply");
  if (!existsSync(directory)) return null;
  const backups = readdirSync(directory)
    .filter((name) => /^scraply\.db\.pre-migration-v(?:29|30|31|32)-.*\.db$/.test(name))
    .sort();
  return backups.length ? join(directory, backups[backups.length - 1]!) : null;
}

const fixture = savedFixture();
const savedDataTest = fixture ? test : test.skip;

const preservedTables = [
  "threads", "research_runs", "sources", "factors", "problems", "solutions",
  "stage_results", "generation_attempts", "cost_ledger",
  "opportunity_families", "opportunity_explorations", "opportunity_coverage_gaps",
  "opportunity_exploration_batches", "opportunity_exploration_attempts",
] as const;

function fingerprintRows(db: Pick<SqlDatabase, "prepare">, columnsByTable: Map<string, string[]>): Record<string, string> {
  return Object.fromEntries(preservedTables.map((table) => {
    const columns = columnsByTable.get(table);
    if (!columns) throw new Error(`Missing source table ${table}`);
    const projection = columns.map((column) => `"${column.replaceAll('"', '""')}"`).join(", ");
    const rows = db.prepare(`SELECT ${projection} FROM ${table}`).all();
    const encoded = rows.map((row) => JSON.stringify(row)).sort();
    return [table, createHash("sha256").update(JSON.stringify(encoded)).digest("hex")];
  }));
}

function exportFingerprints(db: SqlDatabase): Record<string, string> {
  const client = {
    db,
    getSetting(key: string): string | null {
      const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
      return row?.value ?? null;
    },
  } as DatabaseClient;
  const review = new OpportunityRepository(client);
  const exploration = new OpportunityExplorationRepository(client);
  const reviewedThreads = db.prepare("SELECT DISTINCT thread_id FROM opportunity_review_calls ORDER BY thread_id")
    .all() as { thread_id: string }[];
  const exploredThreads = db.prepare("SELECT thread_id FROM opportunity_explorations ORDER BY thread_id")
    .all() as { thread_id: string }[];
  const outputs = [
    ...reviewedThreads.map(({ thread_id }) => ["review", thread_id, review.exportReview(thread_id)]),
    ...exploredThreads.map(({ thread_id }) => ["exploration", thread_id, exploration.exportExploration(thread_id)]),
  ];
  return Object.fromEntries(outputs.map(([kind, threadId, output]) => [
    `${kind}:${threadId}`,
    createHash("sha256").update(JSON.stringify(output)).digest("hex"),
  ]));
}

savedDataTest("a saved development database upgrades from a copy without changing records or exports", () => {
  if (!fixture) throw new Error("Saved database fixture missing");
  const directory = mkdtempSync(join(tmpdir(), "scraply-saved-upgrade-"));
  directories.push(directory);
  const copyPath = join(directory, "scraply.db");
  copyFileSync(fixture, copyPath);
  const original = new Database(fixture, { readonly: true });
  const version = original.prepare("SELECT MAX(id) AS id FROM schema_migrations").get() as { id: number };
  if (version.id >= 33) throw new Error("Saved fixture is already at the latest migration");
  const columnsByTable = new Map(preservedTables.map((table) => [
    table,
    (original.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name),
  ]));
  const beforeRows = fingerprintRows(original, columnsByTable);
  const beforeExports = exportFingerprints(original as unknown as SqlDatabase);
  expect((original.prepare("SELECT COUNT(*) AS count FROM threads").get() as { count: number }).count).toBeGreaterThan(0);
  const sourceCount = (original.prepare("SELECT COUNT(*) AS count FROM sources").get() as { count: number }).count;
  const solutionCount = (original.prepare("SELECT COUNT(*) AS count FROM solutions").get() as { count: number }).count;
  expect(sourceCount + solutionCount).toBeGreaterThan(0);
  expect(Object.keys(beforeExports).length).toBeGreaterThan(0);
  original.close();

  const upgraded = new DatabaseClient(copyPath);
  const backupPath = upgraded.preMigrationBackupPath;
  if (!backupPath) throw new Error("Saved-data upgrade did not create a backup");
  expect(existsSync(backupPath)).toBe(true);
  expect(upgraded.getMeta("last_pre_migration_backup_path")).toBe(backupPath);
  expect(fingerprintRows(upgraded.db, columnsByTable)).toEqual(beforeRows);
  expect(exportFingerprints(upgraded.db)).toEqual(beforeExports);
  expect(upgraded.db.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
  expect(upgraded.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  upgraded.close();

  const reopened = new DatabaseClient(copyPath);
  expect(reopened.preMigrationBackupPath).toBeNull();
  expect(fingerprintRows(reopened.db, columnsByTable)).toEqual(beforeRows);
  expect(exportFingerprints(reopened.db)).toEqual(beforeExports);
  reopened.close();
});
