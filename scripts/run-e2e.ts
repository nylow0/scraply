import { existsSync } from "node:fs";
import { join } from "node:path";

const target = process.argv[2];
if (target !== "production" && target !== "installed") {
  throw new Error("Usage: bun scripts/run-e2e.ts <production|installed>");
}

const root = process.cwd();
const executablePath = target === "production"
  ? join(root, "release", "win-unpacked", "Scraply.exe")
  : join(process.env.LOCALAPPDATA ?? "", "Programs", "Scraply", "Scraply.exe");
if (!existsSync(executablePath)) throw new Error(`Scraply executable not found: ${executablePath}`);

const env: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);
env.SCRAPLY_E2E_EXECUTABLE = executablePath;
env.SCRAPLY_E2E_SKIP_REAL_BACKEND = "1";

const child = Bun.spawn(["bunx", "playwright", "test"], {
  cwd: root,
  env,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await child.exited);
