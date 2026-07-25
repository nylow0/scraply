import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = process.cwd();
const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
const portablePath = join(root, "release", `Scraply ${version}.exe`);
if (!existsSync(portablePath)) throw new Error(`Portable executable not found: ${portablePath}`);

const userDataDir = mkdtempSync(join(tmpdir(), "scraply-portable-smoke-"));
const expectedFiles = [
  join(userDataDir, "scraply", "scraply.db"),
  join(userDataDir, "scraply", "logs", "scraply.log"),
];

const child = Bun.spawn([portablePath, `--user-data-dir=${userDataDir}`], {
  cwd: root,
  env: { ...process.env, SCRAPLY_E2E: "1", ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
  stdout: "ignore",
  stderr: "ignore",
});

async function stop(): Promise<void> {
  Bun.spawnSync(["taskkill", "/PID", String(child.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
  await child.exited.catch(() => undefined);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(userDataDir, { recursive: true, force: true });
      return;
    } catch {
      await Bun.sleep(200);
    }
  }
}

try {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (expectedFiles.every((path) => existsSync(path))) {
      console.log(`Portable Scraply ${version} started and initialised its data directory.`);
      await stop();
      process.exit(0);
    }
    if (child.exitCode !== null) throw new Error(`Portable Scraply exited early with code ${child.exitCode}.`);
    await Bun.sleep(500);
  }
  throw new Error(`Portable Scraply did not create ${expectedFiles.filter((path) => !existsSync(path)).join(", ")} within 60s.`);
} catch (error) {
  await stop();
  throw error;
}
