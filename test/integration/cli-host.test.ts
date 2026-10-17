import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { acquireOwnerLock, canonicalizeDataDir, readOwnerMetadata } from "../../src/app/owner";
import { startOwnerTransport } from "../../src/app/owner-transport";
import { resolveProfile } from "../../src/app/profile";
import { createInProcessBackend } from "../../src/app/in-process-backend";
import { connectOwner, readHostStatus, startDetachedHost, stopHost } from "../../src/cli/connect";
import { runHost, type HostFactory } from "../../src/cli/host";
import { OwnerTransportError } from "../../src/shared/owner-contracts";
import { ValidationStateSchema } from "../../src/shared/ipc";

const version = "test-1";
const fixturePath = resolve(import.meta.dir, "../fixtures/cli-host-child.ts");
const profiles: string[] = [];
const children: ChildProcess[] = [];
const ownedPids = new Set<number>();
const StatusSchema = z.object({
  runs: z.array(z.object({ id: z.string(), state: z.string(), steps: z.number() })),
  owners: z.array(z.object({ pid: z.number() })),
});

function profile() {
  const directory = mkdtempSync(join(tmpdir(), "scraply-cli-host-"));
  profiles.push(directory);
  return directory;
}

function startChild(mode: "host" | "start", directory: string, childVersion = version, idleMs = 600_000) {
  const child = spawn(process.execPath, ["--no-env-file", "run", fixturePath, mode, directory, childVersion, String(idleMs)], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, EXA_API_KEY: "", PERPLEXITY_API_KEY: "" },
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", chunk => { stdout += String(chunk); });
  child.stderr?.on("data", chunk => { stderr += String(chunk); });
  const exited = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", code => resolveExit({ code, stdout, stderr }));
  });
  return { child, exited };
}

async function eventually<T>(read: () => Promise<T | null>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  do {
    const result = await read();
    if (result !== null) return result;
    await delay(20);
  } while (Date.now() < deadline);
  throw new Error("Fixture condition did not arrive before deadline.");
}

async function running(directory: string, ownerVersion = version) {
  return eventually(async () => {
    const health = await readHostStatus({ profileDir: directory, version: ownerVersion, timeoutMs: 500 });
    if (health) ownedPids.add(health.pid);
    return health;
  });
}

async function attach(directory: string, ownerVersion = version) {
  return connectOwner({ profileDir: directory, version: ownerVersion, timeoutMs: 5_000,
    launchHost: () => { startChild("host", directory, ownerVersion); } });
}

afterEach(async () => {
  for (const directory of profiles) {
    try {
      const health = await readHostStatus({ profileDir: directory, version, timeoutMs: 500 });
      await stopHost({ profileDir: directory, version: health?.version ?? version, timeoutMs: 1_000, force: true });
    }
    catch { /* A crash or mismatch test may already have stopped this owner. */ }
    const remainingOwner = await readHostStatus({ profileDir: directory, version, timeoutMs: 500 }).catch(() => null);
    if (remainingOwner && ownedPids.has(remainingOwner.pid)) process.kill(remainingOwner.pid);
  }
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null && !child.killed) child.kill();
  ownedPids.clear();
  await delay(75);
  for (const directory of profiles.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("logical profiles preserve existing nested desktop paths and explicit overrides", async () => {
  const fakeAppData = profile();
  const installed = await resolveProfile({ environment: { APPDATA: fakeAppData }, assetRoot: fakeAppData });
  expect(installed.profileDir).toBe(await canonicalizeDataDir(join(fakeAppData, "scraply")));
  expect(installed.dataDir).toBe(join(installed.profileDir, "scraply"));
  expect(installed.dbPath).toBe(join(installed.profileDir, "scraply", "scraply.db"));
  expect(installed.credentialsPath).toBe(join(installed.profileDir, "secrets.bin"));
  expect(installed.localStatePath).toBe(join(installed.profileDir, "Local State"));
  expect(installed.promptOverridesDir).toBe(join(installed.dataDir, "prompts"));
  const explicit = profile();
  const selected = await resolveProfile({ dataDir: explicit, environment: { SCRAPLY_DATA_DIR: "ignored" }, assetRoot: fakeAppData });
  expect(selected.profileDir).toBe(await canonicalizeDataDir(explicit));
  expect((await resolveProfile({ environment: { SCRAPLY_DATA_DIR: explicit }, assetRoot: fakeAppData })).profileDir).toBe(selected.profileDir);
  expect(existsSync(installed.dbPath)).toBe(false);
});

test("two real host processes racing a canonical profile open SQLite only once", async () => {
  const directory = profile();
  const first = startChild("host", directory);
  const second = startChild("host", join(directory, "..", directory.split(/[\\/]/).at(-1)!));
  const health = await running(directory);
  const loser = await Promise.race([first.exited, second.exited]);
  expect(loser.code).toBe(4);
  expect(JSON.parse(loser.stdout)).toMatchObject({ state: "failed", error: { code: "OWNER_BUSY" }, exitCode: 4 });
  expect(loser.stderr).toBe("");
  const client = await attach(directory);
  const status = StatusSchema.parse(await client.invoke("fixture:status"));
  expect(status.owners).toEqual([{ pid: health.pid }]);
  expect(status.runs).toEqual([]);
}, 15_000);

test("a detached client exits while its run keeps advancing; watch detach leaves it running", async () => {
  const directory = profile();
  const starter = startChild("start", directory);
  const result = await starter.exited;
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  const health = await running(directory);
  expect(health.pid).not.toBe(starter.child.pid);
  const client = await attach(directory);
  const before = StatusSchema.parse(await client.invoke("fixture:status"));
  const watcher = await client.subscribe(() => undefined);
  await delay(80);
  watcher.close();
  await watcher.done;
  const after = StatusSchema.parse(await client.invoke("fixture:status"));
  expect(after.runs[0]?.state).toBe("running");
  expect(after.runs[0]!.steps).toBeGreaterThan(before.runs[0]!.steps);
  expect(await stopHost({ profileDir: directory, version, timeoutMs: 2_000 })).toEqual({ stopped: false });
  expect(await stopHost({ profileDir: directory, version, force: true, timeoutMs: 2_000 })).toEqual({ stopped: true });
  const reopened = await attach(directory);
  await running(directory);
  expect(StatusSchema.parse(await reopened.invoke("fixture:status")).runs[0]?.state).toBe("paused");
}, 15_000);

test("idle timer respects backend activity and an attached desktop event stream", async () => {
  const directory = profile();
  const child = startChild("host", directory, version, 160);
  await running(directory);
  const client = await attach(directory);
  const desktopStream = await client.subscribe(() => undefined);
  await delay(350);
  expect((await client.health()).kind).toBe("cli");
  await client.invoke("fixture:start");
  desktopStream.close();
  await desktopStream.done;
  await delay(350);
  expect(StatusSchema.parse(await client.invoke("fixture:status")).runs[0]?.state).toBe("running");
  await client.invoke("fixture:finish");
  expect((await child.exited).code).toBe(0);
  expect(await readHostStatus({ profileDir: directory, version })).toBeNull();
  const lock = await acquireOwnerLock(directory);
  expect(lock).not.toBeNull();
  await lock?.release();
}, 15_000);

test("active incompatible CLI fails with exact install version; idle incompatible CLI is replaced", async () => {
  const directory = profile();
  startChild("host", directory, "old-test");
  const oldHealth = await running(directory, "old-test");
  const oldClient = await attach(directory, "old-test");
  await oldClient.invoke("fixture:start");
  const incompatible = () => connectOwner({ profileDir: directory, version, timeoutMs: 4_000,
    launchHost: () => { startChild("host", directory); } });
  const failure = await incompatible().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(OwnerTransportError);
  expect(failure).toMatchObject({ code: "OWNER_VERSION_MISMATCH", recovery: { requiredVersion: "old-test" } });
  expect((failure as Error).message).toContain("Install Scraply old-test");
  await oldClient.invoke("fixture:finish");
  const replacement = await incompatible();
  const newHealth = await replacement.health();
  ownedPids.add(newHealth.pid);
  expect(newHealth.pid).not.toBe(oldHealth.pid);
  expect(newHealth.version).toBe(version);
  expect(StatusSchema.parse(await replacement.invoke("fixture:status")).owners).toHaveLength(2);
}, 15_000);

test("fatal host death recovers interrupted saved work without replay", async () => {
  const directory = profile();
  const first = startChild("host", directory);
  await running(directory);
  const client = await attach(directory);
  await client.invoke("fixture:start");
  await delay(80);
  first.child.kill("SIGKILL");
  await first.exited;
  const replacement = await attach(directory);
  await running(directory);
  const before = StatusSchema.parse(await replacement.invoke("fixture:status"));
  await delay(100);
  const after = StatusSchema.parse(await replacement.invoke("fixture:status"));
  expect(before.runs[0]?.state).toBe("interrupted");
  expect(after.runs).toEqual(before.runs);
}, 15_000);

for (const reply of ["unauthorized", "invalid-json", "wrong-identity"] as const) {
  test(`crash recovery proves ownership and replaces a stale descriptor with ${reply} on its reused port`, async () => {
    const directory = profile();
    const original = startChild("host", directory);
    const health = await running(directory);
    const stale = await readOwnerMetadata(directory);
    if (!stale) throw new Error("Missing synthetic descriptor.");
    original.child.kill("SIGKILL");
    await original.exited;
    const unrelated = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.setHeader("x-scraply-version", version);
      if (reply === "unauthorized") {
        response.writeHead(401);
        response.end(JSON.stringify({ ok: false, error: { code: "unauthorized", message: "Synthetic unrelated service." } }));
      } else if (reply === "invalid-json") response.end("synthetic invalid JSON");
      else response.end(JSON.stringify({ ok: true, data: { ...health, pid: health.pid + 1 } }));
    });
    await new Promise<void>((resolveListen, reject) => {
      unrelated.once("error", reject);
      unrelated.listen(stale.port, "127.0.0.1", resolveListen);
    });
    try {
      const lock = await acquireOwnerLock(directory);
      expect(lock).not.toBeNull();
      await lock?.release();
      expect(await readHostStatus({ profileDir: directory, version })).toBeNull();
      let launches = 0;
      const client = await connectOwner({ profileDir: directory, version, timeoutMs: 5_000,
        launchHost() { launches++; startChild("host", directory); } });
      const replacement = await client.health();
      ownedPids.add(replacement.pid);
      expect(replacement.pid).not.toBe(health.pid);
      expect(replacement.port).not.toBe(stale.port);
      expect(launches).toBe(1);
      expect(StatusSchema.parse(await client.invoke("fixture:status")).owners).toHaveLength(2);
    } finally {
      await new Promise<void>((resolveClose, reject) => {
        unrelated.close(error => error ? reject(error) : resolveClose());
        unrelated.closeAllConnections();
      });
    }
  }, 15_000);
}

test("failed health cannot launch a second owner while the actual lock remains held", async () => {
  const directory = profile();
  const lock = await acquireOwnerLock(directory);
  if (!lock) throw new Error("Missing isolated lock.");
  const owner = await startOwnerTransport({ lock, kind: "cli", version,
    invoke: async () => null, subscribe: () => () => undefined, requestShutdown: () => false });
  await owner.close();
  const unrelated = createServer((_request, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: { code: "unauthorized", message: "Synthetic unrelated service." } }));
  });
  await new Promise<void>((resolveListen, reject) => {
    unrelated.once("error", reject);
    unrelated.listen(owner.metadata.port, "127.0.0.1", resolveListen);
  });
  try {
    let launches = 0;
    await expect(connectOwner({ profileDir: directory, version, timeoutMs: 250,
      launchHost() { launches++; } })).rejects.toMatchObject({ code: "OWNER_TIMEOUT" });
    expect(launches).toBe(0);
    expect(existsSync(join(directory, "scraply", "scraply.db"))).toBe(false);
  } finally {
    await new Promise<void>((resolveClose, reject) => {
      unrelated.close(error => error ? reject(error) : resolveClose());
      unrelated.closeAllConnections();
    });
    await lock.release();
  }
});

for (const mode of ["fail-known", "fail-unknown"] as const) {
  test(`a detached ${mode} startup returns one sanitized failure without restarting`, async () => {
    const directory = profile();
    let launches = 0;
    const started = Date.now();
    const failure = await connectOwner({ profileDir: directory, version, timeoutMs: 10_000,
      async launchHost() {
        launches++;
        await startDetachedHost({ executablePath: process.execPath,
          args: ["--no-env-file", "run", fixturePath, mode, directory, version],
          environment: { ...process.env, EXA_API_KEY: "", PERPLEXITY_API_KEY: "" }, timeoutMs: 5_000 });
      },
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: mode === "fail-known" ? "secure_storage_unavailable" : "internal_error" });
    expect(String(failure)).not.toContain("synthetic-private-marker");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(launches).toBe(1);
    expect(readFileSync(join(directory, "startup-attempts.txt"), "utf8")).toBe("attempt\n");
    expect(await readHostStatus({ profileDir: directory, version })).toBeNull();
    const lock = await acquireOwnerLock(directory);
    expect(lock).not.toBeNull();
    await lock?.release();
  });
}

for (const mode of ["oversized", "trailing", "silent"] as const) {
  test(`the private bootstrap pipe rejects a ${mode} result without echoing its bytes`, async () => {
    const directory = profile();
    const failure = await startDetachedHost({ executablePath: process.execPath,
      args: ["--no-env-file", "run", fixturePath, mode, directory, version],
      environment: { ...process.env, EXA_API_KEY: "", PERPLEXITY_API_KEY: "" }, timeoutMs: 5_000,
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "OWNER_START_FAILED" });
    expect(String(failure)).not.toContain("synthetic-private-marker");
  });
}

test("a bootstrap deadline detaches without terminating the host that is still initializing", async () => {
  const directory = profile();
  await expect(startDetachedHost({ executablePath: process.execPath,
    args: ["--no-env-file", "run", fixturePath, "slow", directory, version],
    environment: { ...process.env, EXA_API_KEY: "", PERPLEXITY_API_KEY: "" }, timeoutMs: 40,
  })).rejects.toMatchObject({ code: "OWNER_TIMEOUT" });
  await running(directory);
  const client = await attach(directory);
  expect(StatusSchema.parse(await client.invoke("fixture:status")).runs).toEqual([]);
});

test("status and stop never bootstrap a missing host; startup is bounded without data access", async () => {
  const directory = profile();
  expect(await readHostStatus({ profileDir: directory, version })).toBeNull();
  await expect(stopHost({ profileDir: directory, version })).rejects.toMatchObject({ code: "OWNER_NOT_RUNNING" });
  let launches = 0;
  await expect(connectOwner({ profileDir: directory, version, timeoutMs: 120,
    launchHost: () => { launches++; } })).rejects.toMatchObject({ code: "OWNER_TIMEOUT" });
  expect(launches).toBe(1);
  expect(existsSync(join(directory, "scraply", "scraply.db"))).toBe(false);
  expect(existsSync(join(directory, "secrets.bin"))).toBe(false);
});

test("a client waits for a starting owner to publish instead of spawning another host", async () => {
  const directory = profile();
  const lock = await acquireOwnerLock(directory);
  if (!lock) throw new Error("Missing isolated lock.");
  let launches = 0;
  const connecting = connectOwner({ profileDir: directory, version, timeoutMs: 2_000,
    launchHost: () => { launches++; } });
  let transport: Awaited<ReturnType<typeof startOwnerTransport>> | undefined;
  try {
    await delay(100);
    expect(launches).toBe(0);
    transport = await startOwnerTransport({ lock, kind: "cli", version,
      invoke: async () => null, subscribe: () => () => undefined, requestShutdown: () => false });
    expect((await (await connecting).health()).pid).toBe(process.pid);
    expect(launches).toBe(0);
  } finally {
    await transport?.close();
    await lock.release();
    await connecting.catch(() => undefined);
  }
});

test("desktop mismatch never starts a second host or stops the desktop owner", async () => {
  const directory = profile();
  const lock = await acquireOwnerLock(directory);
  if (!lock) throw new Error("Missing isolated lock.");
  let shutdowns = 0;
  const desktop = await startOwnerTransport({ lock, kind: "desktop", version: "desktop-test",
    invoke: async () => null, subscribe: () => () => undefined,
    requestShutdown() { shutdowns++; return false; } });
  try {
    await expect(connectOwner({ profileDir: directory, version, launchHost: () => { throw new Error("Must not launch."); } }))
      .rejects.toMatchObject({ code: "OWNER_VERSION_MISMATCH", recovery: { ownerKind: "desktop", requiredVersion: "desktop-test" } });
    expect(shutdowns).toBe(0);
  } finally { await desktop.close(); await lock.release(); }
});

test("host cleanup stops transport before backend and releases the owner lock last", async () => {
  const directory = profile();
  let releaseStop!: () => void;
  const stopping = new Promise<void>(resolveStop => { releaseStop = resolveStop; });
  const factory: HostFactory = () => ({
    start: async () => undefined, invoke: async () => null, hasActiveWork: () => false,
    requestShutdown: async () => true, stop: () => stopping,
  });
  const host = await runHost({ profileDir: directory, version, factory, installSignalHandlers: false });
  expect(await host.stop()).toBe(true);
  try {
    await eventually(async () => await readHostStatus({ profileDir: directory, version, timeoutMs: 100 }) === null ? true : null);
    expect(await acquireOwnerLock(directory)).toBeNull();
    // Publication is retained until backend/credential cleanup completes.
    expect(JSON.parse(readFileSync(join(directory, "owner.json"), "utf8"))).toMatchObject({ pid: process.pid });
  } finally { releaseStop(); await host.closed; }
  const lock = await acquireOwnerLock(directory);
  expect(lock).not.toBeNull();
  await lock?.release();
});

test("in-process backend restores and acknowledges account rotation, and reserves key writes through rollback", async () => {
  const directory = profile();
  const paths = await resolveProfile({ dataDir: directory });
  const capture = join(directory, "fixture-operations.txt");
  const persisted: string[] = [];
  const initialSecrets = { exaApiKey: null, perplexityApiKey: null, providerCredentials: { "openai-subscription": "synthetic-credential" } };
  const backend = createInProcessBackend({ runtime: {
    executablePath: process.execPath,
    argumentPrefix: [resolve(import.meta.dir, "../fixtures/runtime-child.cjs")],
    artifact: { version: "0.1.0", sourceCommit: "ab9fcfc859ee19fff8dfd4c05c854ab5d145baf8",
      sha256: createHash("sha256").update(readFileSync(process.execPath)).digest("hex") },
    appVersion: version, controlTimeoutMs: 250, terminalGraceMs: 250,
    environment: { ...process.env, EXA_API_KEY: "", PERPLEXITY_API_KEY: "", SCRAPLY_RUNTIME_CHILD_MODE: "workflow",
      SCRAPLY_RUNTIME_OPERATIONS_CAPTURE: capture },
  } });
  const input = { paths, appVersion: version, secrets: initialSecrets,
    publishEvent: () => undefined,
    async persistProviderCredential(_providerId: string, credential: string) { await delay(5); persisted.push(credential); },
  };
  try {
    await backend.start(input);
    await eventually(async () => {
      const validation = ValidationStateSchema.parse(await backend.request("/validation"));
      return validation.native.connected ? true : null;
    });
    await backend.request("/native/account/refresh", { method: "POST", body: JSON.stringify({ providerId: "openai-subscription" }) });
    expect(persisted).toContain("connected-credential");
    await backend.updateSecrets(initialSecrets, true);
    await expect(backend.request("/threads", { method: "POST", body: JSON.stringify({ title: "Synthetic key reservation" }) }))
      .rejects.toMatchObject({ code: "conflict" });
    await backend.finishSearchKeyUpdate(initialSecrets);
    const created = await backend.request("/threads", { method: "POST", body: JSON.stringify({ title: "Synthetic key reservation" }) });
    expect(created).toMatchObject({ thread: { title: "Synthetic key reservation" } });
    expect(existsSync(paths.dbPath)).toBe(true);
    expect(await backend.requestShutdown(false)).toBe(true);
    expect(await backend.requestShutdown(true)).toBe(true);
    await backend.stop();
    expect(backend.isReady()).toBe(false);
    await backend.start(input);
    expect(backend.isReady()).toBe(true);
    const reopened = z.object({ projects: z.array(z.object({ title: z.string() })) }).parse(await backend.request("/app/projects"));
    expect(reopened.projects.map(project => project.title)).toEqual(["Synthetic key reservation"]);
  } finally { await backend.stop(); }
  const operations = readFileSync(capture, "utf8").trim().split(/\r?\n/);
  expect(operations).toContain("credential.session.set");
  expect(operations).toContain("credential.session.persisted");
  expect(operations).toContain("runtime.shutdown");
  expect(operations).not.toContain("generation.start");
}, 15_000);
