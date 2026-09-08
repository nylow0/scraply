import type { DatabaseClient } from "./client";

/** Preserve every historical column, index and trigger while widening the v2 option limit. */
export function migrateSolutionLimit(client: DatabaseClient): void {
  const table = client.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'solutions'").get() as { sql: string };
  const objects = client.db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name = 'solutions' AND type IN ('index', 'trigger') AND sql IS NOT NULL").all() as Array<{ sql: string }>;
  const constraint = "option_position BETWEEN 0 AND 2";
  if (!table.sql.includes(constraint)) throw new Error("Unexpected saved solution position constraint");
  const sql = table.sql.replace(/^CREATE TABLE (?:"solutions"|solutions)\s*\(/, "CREATE TABLE solutions_v21 (")
    .replace(constraint, "option_position BETWEEN 0 AND 19");
  if (!sql.startsWith("CREATE TABLE solutions_v21 (")) throw new Error("Unexpected saved solutions table definition");
  client.db.exec(sql);
  client.db.exec("INSERT INTO solutions_v21 SELECT * FROM solutions; DROP TABLE solutions; ALTER TABLE solutions_v21 RENAME TO solutions;");
  for (const object of objects) client.db.exec(object.sql);
}
