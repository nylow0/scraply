// Writes one run's full trace as JSON for an agent to read: the lead funnel, model calls per stage, searches,
// timings, interruptions and warnings, plus the details of every step.
//
//   bun scripts/trace.ts <session ID> [--db <path to scraply.db>] [--out <directory>]
//
// Copy the session ID from "Run details" in the app. The database opens read-only, so it is safe to point at
// the installed app's data (the default) while the app is running. Nothing is sent to a provider.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getRunTrace, getRunTraceStep } from "../src/core/run-trace";

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args.splice(index, 2)[1] : undefined;
};
const databasePath = resolve(option("--db") ?? join(process.env.APPDATA ?? "", "scraply", "scraply", "scraply.db"));
const outputDirectory = resolve(option("--out") ?? "build/trace");
const sessionId = args[0];
if (!sessionId) {
  console.error("Usage: bun scripts/trace.ts <session ID> [--db <path to scraply.db>] [--out <directory>]");
  process.exit(1);
}
if (!existsSync(databasePath)) {
  console.error(`No database at ${databasePath}. Pass --db with the path to scraply.db.`);
  process.exit(1);
}

const client = { db: new Database(databasePath, { readonly: true }) };
try {
  // A trace covers every run of the session; any one of its runs identifies it. A run ID works too, for runs without a session.
  const run = client.db.prepare(`SELECT id FROM research_runs WHERE workflow_session_id = ? OR id = ?
    ORDER BY created_at, rowid LIMIT 1`).get(sessionId, sessionId) as { id: string } | null;
  if (!run) {
    console.error(`No run found for session ${sessionId} in ${databasePath}.`);
    process.exit(1);
  }
  const trace = getRunTrace(client, run.id);
  const steps = trace.steps.map((step) => getRunTraceStep(client, run.id, step.id));
  mkdirSync(outputDirectory, { recursive: true });
  const outputPath = join(outputDirectory, `${sessionId}.json`);
  writeFileSync(outputPath, JSON.stringify({ trace, steps }, null, 2));
  const funnel = trace.metrics.candidateFunnel;
  console.log(`${outputPath}\n${trace.metrics.modelCalls} model calls, ${trace.metrics.searches} searches, `
    + `${funnel.total} leads, ${funnel.confirmed} problems, ${trace.steps.length} steps.`);
} finally {
  client.db.close();
}
