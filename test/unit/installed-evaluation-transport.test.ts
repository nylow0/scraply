import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { connectInstalledDriver, installedDriverEndpoint, installedDriverEnvironment, installedPackageIdentity } from "../../scripts/eval-installed-driver";
import { installedEvaluationInvoke, prepareInstalledEvaluationProfile } from "../../scripts/eval-research";
import { ApiResponseSchema, IPC_CHANNELS } from "../../src/shared/ipc";

function temporaryDirectory() {
  const root = join(import.meta.dir, "../../build");
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, "installed-eval-test-"));
}

describe("installed evaluation transport", () => {
  test("copies encrypted credentials once without copying projects or overwriting rotated evaluation credentials", () => {
    const root = temporaryDirectory();
    const source = join(root, "installed");
    const profile = join(root, "profile");
    mkdirSync(source);
    writeFileSync(join(source, "secrets.bin"), "encrypted-fixture");
    writeFileSync(join(source, "Local State"), "encryption-context-fixture");
    writeFileSync(join(source, "real-projects.db"), "private-project-fixture");
    try {
      expect(prepareInstalledEvaluationProfile(source, profile)).toBe(source);
      expect(readFileSync(join(profile, "secrets.bin"), "utf8")).toBe("encrypted-fixture");
      writeFileSync(join(profile, "secrets.bin"), "rotated-disposable-fixture");
      prepareInstalledEvaluationProfile(source, profile);
      expect(readFileSync(join(profile, "secrets.bin"), "utf8")).toBe("rotated-disposable-fixture");
      expect(readFileSync(join(source, "secrets.bin"), "utf8")).toBe("encrypted-fixture");
      expect(() => readFileSync(join(profile, "real-projects.db"))).toThrow();
      expect(() => prepareInstalledEvaluationProfile(source, source)).toThrow("outside");
      expect(() => prepareInstalledEvaluationProfile(source, join(source, "child"))).toThrow("outside");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("binds the installed executable, ASAR and bundled runtime to the clean package source", () => {
    const root = temporaryDirectory();
    const resources = join(root, "resources");
    mkdirSync(join(resources, "runtime"), { recursive: true });
    const executable = join(root, "Scraply.exe");
    const manifest = join(root, "manifest.json");
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    writeFileSync(executable, "installed-executable-fixture");
    writeFileSync(join(resources, "app.asar"), "installed-app-fixture");
    writeFileSync(join(resources, "runtime/scraply-agent.exe"), "installed-runtime-fixture");
    writeFileSync(manifest, JSON.stringify({ schemaVersion: 2, appVersion: "fixture", sourceSha: "frozen-source", dirty: false,
      artifacts: [{ name: "unpacked", sha256: hash("installed-executable-fixture") }, { name: "app-asar", sha256: hash("installed-app-fixture") }],
      runtime: { executable: { sha256: hash("installed-runtime-fixture") } } }));
    try {
      expect(installedPackageIdentity(executable, manifest)).toMatchObject({ appVersion: "fixture", packageSourceSha: "frozen-source",
        executableSha256: hash("installed-executable-fixture"), asarSha256: hash("installed-app-fixture") });
      writeFileSync(join(resources, "app.asar"), "different-app-fixture");
      expect(() => installedPackageIdentity(executable, manifest)).toThrow("does not match");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("uses production resources and inherited auth roots without account or mock overrides", () => {
    expect(installedDriverEnvironment({ PATH: "fixture-path", CODEX_HOME: "shared-auth-root", EXA_API_KEY: "synthetic-key",
      ELECTRON_RUN_AS_NODE: "1", SCRAPLY_E2E: "1", SCRAPLY_E2E_BACKEND_URL: "http://fixture", SCRAPLY_AGENT_PATH: "fixture-worker" }))
      .toEqual({ PATH: "fixture-path", CODEX_HOME: "shared-auth-root" });
  });

  test("wraps preload results at the existing CLI boundary and refuses account mutation channels", async () => {
    const requests: string[] = [];
    const invoke = installedEvaluationInvoke({ async invoke(method) { requests.push(method); return { sessionId: "saved-session" }; } });
    expect(await invoke(IPC_CHANNELS.GET_WORKFLOW, ApiResponseSchema(z.object({ sessionId: z.string() })), { sessionId: "saved-session" }))
      .toEqual({ ok: true, data: { sessionId: "saved-session" } });
    await expect(invoke(IPC_CHANNELS.NATIVE_LOGOUT, z.unknown(), {})).rejects.toThrow("unavailable");
    expect(requests).toEqual(["getWorkflow"]);
  });

  test("a lost admission receipt is not resent, and a new observer reconnects only to read", async () => {
    const root = temporaryDirectory();
    const endpoint = installedDriverEndpoint(root);
    const requests: string[] = [];
    const server = createServer(socket => {
      createInterface({ input: socket }).on("line", line => {
        const request = z.object({ id: z.string(), method: z.string() }).parse(JSON.parse(line));
        requests.push(request.method);
        if (request.method === "startWorkflow") { socket.end(); return; }
        const response = JSON.stringify({ id: request.id, ok: true, data: { sessionId: "already-admitted" } });
        socket.write(response.slice(0, 12));
        socket.write(`${response.slice(12)}\n`);
      });
    });
    await new Promise<void>((resolveServer, reject) => { server.once("error", reject); server.listen(endpoint, resolveServer); });
    try {
      const first = await connectInstalledDriver(endpoint);
      await expect(first.invoke("startWorkflow", {})).rejects.toThrow("must not be replayed");
      first.disconnect();
      const next = await connectInstalledDriver(endpoint);
      try { expect(await next.invoke("getWorkflow", { sessionId: "already-admitted" })).toEqual({ sessionId: "already-admitted" }); }
      finally { next.disconnect(); }
      expect(requests).toEqual(["startWorkflow", "getWorkflow"]);
    } finally {
      await new Promise<void>((resolveServer, reject) => server.close(error => error ? reject(error) : resolveServer()));
      rmSync(root, { recursive: true, force: true });
    }
  });
});
