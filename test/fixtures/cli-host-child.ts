import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { connectOwner, startDetachedHost } from "../../src/cli/connect";
import { runHostCommand, type HostFactory } from "../../src/cli/host";
import { OwnerTransportError } from "../../src/shared/owner-contracts";
import { AppError } from "../../src/shared/errors";

// Explicit fixture entry point. Production main never imports or selects this factory.
const [mode, profileDir, version = "test-1", idle = "600000"] = process.argv.slice(2);
if (!profileDir || !["host", "start", "fail-known", "fail-unknown", "oversized", "trailing", "silent", "slow"].includes(mode ?? "")) throw new Error("Fixture needs a mode and an isolated profile.");

const RunSchema = z.object({ id: z.string(), state: z.string(), steps: z.number() });
const fixtureFactory: HostFactory = (profile, _version, publishEvent) => {
  let db: Database | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  const database = () => {
    if (!db) throw new Error("Fixture is not started.");
    return db;
  };
  const active = () => Boolean(database().query("SELECT 1 FROM runs WHERE state = 'running' LIMIT 1").get());
  return {
    async start() {
      mkdirSync(profile.dataDir, { recursive: true });
      db = new Database(profile.dbPath);
      db.exec("CREATE TABLE IF NOT EXISTS owners (pid INTEGER); CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, state TEXT, steps INTEGER)");
      db.query("INSERT INTO owners VALUES (?)").run(process.pid);
      db.exec("UPDATE runs SET state = 'interrupted' WHERE state = 'running'");
      ticker = setInterval(() => {
        database().exec("UPDATE runs SET steps = steps + 1 WHERE state = 'running'");
        for (const row of database().query("SELECT * FROM runs WHERE state = 'running'").all()) {
          const run = RunSchema.parse(row);
          publishEvent({ type: "run-progress", runId: run.id, threadId: "synthetic-project", message: `Step ${run.steps}`, codexCalls: 0, searches: 0 });
        }
      }, 25);
    },
    async invoke(channel) {
      if (channel === "fixture:start") database().query("INSERT INTO runs VALUES ('synthetic-run', 'running', 0)").run();
      else if (channel === "fixture:finish") database().exec("UPDATE runs SET state = 'completed' WHERE state = 'running'");
      else if (channel !== "fixture:status") throw new Error("Unknown fixture command.");
      return {
        runs: z.array(RunSchema).parse(database().query("SELECT * FROM runs").all()),
        owners: database().query("SELECT pid FROM owners").all(),
      };
    },
    hasActiveWork: active,
    async requestShutdown(force) {
      if (active() && !force) return false;
      if (force) database().exec("UPDATE runs SET state = 'paused' WHERE state = 'running'");
      return true;
    },
    async stop() { clearInterval(ticker); db?.close(); db = undefined; },
  };
};

try {
  if (mode === "oversized") {
    process.stdout.end("x".repeat(8_192));
  } else if (mode === "trailing") {
    process.stdout.end('{"state":"ready"}\n{"unexpected":"synthetic-private-marker"}\n');
  } else if (mode === "silent") {
    process.stdout.end();
  } else if (mode !== "start") {
    process.exitCode = await runHostCommand({
      profileDir, version, idleTimeoutMs: Number(idle), idlePollMs: 20,
      async factory(...args) {
        if (mode === "fail-known" || mode === "fail-unknown") {
          appendFileSync(join(profileDir, "startup-attempts.txt"), "attempt\n");
          if (mode === "fail-known") throw new AppError("secure_storage_unavailable", "Synthetic credential initialization failed.");
          throw new Error("synthetic-private-marker must never cross the bootstrap channel");
        }
        if (mode === "slow") await delay(250);
        return fixtureFactory(...args);
      },
    });
  } else {
    const client = await connectOwner({
      profileDir, version,
      async launchHost(directory) {
        await startDetachedHost({
          executablePath: process.execPath,
          args: ["--no-env-file", "run", resolve(import.meta.path), "host", directory, version, idle],
          environment: { ...process.env, EXA_API_KEY: "", PERPLEXITY_API_KEY: "" }, timeoutMs: 5_000,
        });
      },
    });
    await client.invoke("fixture:start");
    console.log(JSON.stringify(await client.health()));
  }
} catch (error) {
  console.error(error instanceof OwnerTransportError ? error.code : "FIXTURE_FAILED");
  process.exitCode = error instanceof OwnerTransportError && error.code === "OWNER_BUSY" ? 4 : 1;
}
