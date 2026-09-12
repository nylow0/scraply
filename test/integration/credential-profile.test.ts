import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test.skipIf(process.platform !== "win32")("Electron shares the installed encryption context, round-trips a refresh, and isolates account tests", async () => {
  const root = mkdtempSync(join(tmpdir(), "scraply-credential-profile-"));
  try {
    const compiled = await Bun.build({
      entrypoints: [join(import.meta.dir, "../fixtures/credential-profile-electron.ts")],
      target: "node", external: ["electron"], format: "cjs", outdir: root, naming: "fixture.cjs",
    });
    expect(compiled.success).toBe(true);
    for (const mode of ["seed", "shared", "desktop", "isolated", "e2e"]) {
      const child = Bun.spawn([
        resolve(import.meta.dir, "../../node_modules/electron/dist/electron.exe"), compiled.outputs[0]!.path, root, mode,
      ], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
      const timeout = setTimeout(() => child.kill(), 15_000);
      try {
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ]);
        expect(exitCode, stderr).toBe(0);
        expect(stdout).toContain(`credential-profile:${mode}:passed`);
      } finally { clearTimeout(timeout); child.kill(); }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
