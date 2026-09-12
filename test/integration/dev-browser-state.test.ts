import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");

// Exercise the real CLI against disposable launch state, never the user's running server.
test.each([undefined, "", '{"token":', "{}"])("dev commands tolerate unusable launch state: %j", async (contents) => {
  const fixture = mkdtempSync(join(root, "build/dev-state-test-"));
  try {
    mkdirSync(join(fixture, "scripts"));
    mkdirSync(join(fixture, "build/browser-dev"), { recursive: true });
    for (const script of ["dev-browser.ts", "browser-dev-proxy.ts"]) {
      copyFileSync(join(root, "scripts", script), join(fixture, "scripts", script));
    }
    if (contents !== undefined) writeFileSync(join(fixture, "build/browser-dev/server.json"), contents);
    const run = async (command: string) => {
      const process = Bun.spawn([Bun.which("bun")!, join(fixture, "scripts/dev-browser.ts"), command], {
        cwd: fixture, stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
      ]);
      return { stdout, stderr, exitCode };
    };
    const stopped = await run("stop");
    expect(stopped.exitCode).toBe(0);
    expect(stopped.stdout).toContain("dev server is not running");
    expect(stopped.stderr).toBe("");
    // Without an Electron binary, startup should reach the dependency check,
    // not abort while decoding the old state file.
    const started = await run("start");
    expect(started.exitCode).toBe(1);
    expect(started.stderr).toContain("Electron is missing");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
