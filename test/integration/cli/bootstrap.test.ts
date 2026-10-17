import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { acquireOwnerLock, readOwnerMetadata } from "../../../src/app/owner";
import { MIGRATIONS } from "../../../src/db/migrations";

const windowsTest = process.platform === "win32" && process.arch === "x64" ? test : test.skip;
const checkout = resolve(import.meta.dir, "../../..");
const entry = join(checkout, "src/cli/main.ts");
const directories: string[] = [];
const failures = z.object({ ok: z.literal(false), error: z.object({
  code: z.string(), message: z.string(), recovery: z.record(z.unknown()).optional(),
}) });

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function profile() {
  const directory = mkdtempSync(join(tmpdir(), "scraply-cli-bootstrap-"));
  directories.push(directory);
  return directory;
}

async function projectList(directory: string, extraEnvironment: NodeJS.ProcessEnv = {}) {
  const started = Date.now();
  const child = spawn(process.execPath, ["--no-env-file", "run", entry, "project", "list", "--json", "--data-dir", directory, "--timeout", "15000"], {
    cwd: checkout, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, SCRAPLY_DEV_SHARED_CREDENTIALS: "0", SCRAPLY_DEV_DATA_DIR: directory,
      SCRAPLY_DATA_DIR: directory, EXA_API_KEY: "", PERPLEXITY_API_KEY: "", ...extraEnvironment },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += String(chunk); });
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  const result = await new Promise<{ code: number | null; durationMs: number }>((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Source CLI did not report its bootstrap failure within 12 seconds."));
    }, 12_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); resolveExit({ code, durationMs: Date.now() - started }); });
  });
  expect(result.code).toBe(1);
  expect(result.durationMs).toBeLessThan(10_000);
  expect(stderr).toBe("");
  expect(stdout).not.toContain(directory);
  expect(stdout).not.toContain("synthetic-private-bootstrap-marker");
  expect(stdout).not.toContain('"token"');
  const response = failures.parse(JSON.parse(stdout));
  expect(response.error.code).not.toMatch(/TIMEOUT/);
  expect(await readOwnerMetadata(directory)).toBeNull();
  const lock = await acquireOwnerLock(directory);
  expect(lock).not.toBeNull();
  await lock?.release();
  return response.error;
}

function syntheticRuntime(directory: string, wrongHash = false) {
  const runtimeDirectory = join(directory, "synthetic-runtime");
  mkdirSync(runtimeDirectory);
  const executablePath = join(runtimeDirectory, "scraply-agent.exe");
  const lockPath = join(runtimeDirectory, "scraply-agent.lock.json");
  // This inert file is never executed. Schema refusal occurs before runtime
  // prepare; the hash-mismatch case stops verification before spawning anything.
  const contents = "synthetic-private-bootstrap-marker";
  writeFileSync(executablePath, contents);
  writeFileSync(lockPath, JSON.stringify({
    schemaVersion: 1, platform: "windows-x64", executable: "scraply-agent.exe", version: "0.1.0",
    protocolVersions: ["1.2"], sourceCommit: "a".repeat(40),
    sha256: wrongHash ? "0".repeat(64) : createHash("sha256").update(contents).digest("hex"), sizeBytes: Buffer.byteLength(contents),
  }));
  return { SCRAPLY_AGENT_PATH: executablePath, SCRAPLY_AGENT_LOCK_PATH: lockPath };
}

windowsTest("the real source CLI promptly preserves malformed Local State failure and leaves saved bytes untouched", async () => {
  const directory = profile();
  const statePath = join(directory, "Local State");
  const invalid = '{"synthetic-private-bootstrap-marker":';
  writeFileSync(statePath, invalid);
  const error = await projectList(directory);
  expect(error.code).toBe("secure_storage_unavailable");
  expect(error.message).toContain("left untouched");
  expect(readFileSync(statePath, "utf8")).toBe(invalid);
  expect(existsSync(join(directory, "secrets.bin"))).toBe(false);
  expect(existsSync(join(directory, "scraply", "scraply.db"))).toBe(false);
}, 15_000);

windowsTest("the real source CLI preserves future-schema update recovery without changing stored rows", async () => {
  const directory = profile();
  const dataDirectory = join(directory, "scraply");
  mkdirSync(dataDirectory);
  const dbPath = join(dataDirectory, "scraply.db");
  const futureVersion = Math.max(...MIGRATIONS.map(migration => migration.id)) + 1;
  const db = new Database(dbPath);
  db.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  db.query("INSERT INTO schema_migrations VALUES (?, 'synthetic timestamp')").run(futureVersion);
  db.close();
  const original = readFileSync(dbPath);
  const error = await projectList(directory, syntheticRuntime(directory));
  expect(error.code).toBe("conflict");
  expect(error.recovery).toMatchObject({ action: "update", schemaVersion: futureVersion });
  expect(error.message).toContain("Update both Scraply distributions");
  expect(readFileSync(dbPath).equals(original)).toBe(true);
  expect(existsSync(join(directory, "secrets.bin"))).toBe(false);
}, 15_000);

windowsTest("the real source CLI reports missing runtime configuration before opening a database", async () => {
  const directory = profile();
  const error = await projectList(directory, {
    SCRAPLY_AGENT_PATH: join(directory, "missing-runtime.exe"), SCRAPLY_AGENT_LOCK_PATH: join(directory, "missing-runtime.lock.json"),
  });
  expect(error.code).toBe("backend_unavailable");
  expect(error.recovery).toMatchObject({ action: "repair-runtime" });
  expect(existsSync(join(directory, "scraply", "scraply.db"))).toBe(false);
  expect(existsSync(join(directory, "secrets.bin"))).toBe(false);
}, 15_000);

windowsTest("the real source CLI reports failed runtime verification before publishing owner readiness", async () => {
  const directory = profile();
  const error = await projectList(directory, syntheticRuntime(directory, true));
  expect(error.code).toBe("backend_unavailable");
  expect(error.recovery).toMatchObject({ action: "repair-runtime" });
  expect(error.message).toContain("verified runtime");
  expect(existsSync(join(directory, "secrets.bin"))).toBe(false);
}, 15_000);
