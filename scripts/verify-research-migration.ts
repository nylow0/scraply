import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DatabaseClient } from "../src/db/client";

const TABLES = ["research_runs", "sources", "factors", "problems", "solutions", "stage_results", "generation_attempts", "decision_analyses"] as const;
const SAVED_TABLES = ["stage_results", "generation_attempts", "decision_analyses"] as const;

/** Hash saved requests and results, not newly added optional domain columns. */
function snapshot(db: Database | DatabaseClient["db"]) {
  const counts = Object.fromEntries(TABLES.map((table) => [table,
    (db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count]));
  const hashes = Object.fromEntries(SAVED_TABLES.map((table) => {
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
    return [table, createHash("sha256").update(JSON.stringify(rows)).digest("hex")];
  }));
  return { counts, hashes };
}

export function verifyResearchMigration(input: string, copy: string) {
  const inputPath = resolve(input);
  const copyPath = resolve(copy);
  if (inputPath.toLocaleLowerCase("en") === copyPath.toLocaleLowerCase("en")) throw new Error("Verification requires a separate database copy");
  mkdirSync(dirname(copyPath), { recursive: true });
  const original = new Database(inputPath, { readonly: true });
  let before: ReturnType<typeof snapshot>;
  try {
    before = snapshot(original);
    // VACUUM INTO takes a consistent snapshot including committed WAL data.
    original.query("VACUUM INTO ?").run(copyPath);
  } finally { original.close(); }
  const migrated = new DatabaseClient(copyPath);
  try {
    const after = snapshot(migrated.db);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Migration changed saved row counts or result hashes");
    const foreignKeys = migrated.db.prepare("PRAGMA foreign_key_check").all();
    const integrity = migrated.db.prepare("PRAGMA quick_check").get() as { quick_check: string };
    if (foreignKeys.length > 0 || integrity.quick_check !== "ok") throw new Error("Migrated copy failed SQLite integrity checks");
    return { sourceBytes: Bun.file(inputPath).size, before, after, integrity: "ok", foreignKeyErrors: 0 };
  } finally { migrated.close(); }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { input: { type: "string" }, copy: { type: "string" }, report: { type: "string" } } });
  if (!values.input || !values.copy || !values.report) throw new Error("Use --input <existing.db> --copy <new.db> --report <report.json>");
  const report = verifyResearchMigration(values.input, values.copy);
  mkdirSync(dirname(resolve(values.report)), { recursive: true });
  writeFileSync(values.report, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ verified: true, sourceBytes: report.sourceBytes, counts: report.after.counts, report: resolve(values.report) }));
}
