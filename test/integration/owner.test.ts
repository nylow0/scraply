import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { acquireOwnerLock, canonicalizeDataDir, readOwnerMetadata } from "../../src/app/owner";
import { createOwnerClient, startOwnerTransport } from "../../src/app/owner-transport";
import { writePrivateFileAtomically } from "../../src/app/private-file";
import { AppError } from "../../src/shared/errors";
import { type ResearchEvent } from "../../src/shared/ipc";
import { type OwnerKind, type OwnerMetadata, OwnerTransportError } from "../../src/shared/owner-contracts";

const directories: string[] = [];
const cleanup: Array<() => void | Promise<void>> = [];
const buildDirectory = mkdtempSync(join(tmpdir(), "scraply-owner-fixture-"));
let nodeFixture: string;
beforeAll(async () => {
  const result = await Bun.build({ entrypoints: [join(import.meta.dir, "../fixtures/owner-child.ts")], target: "node", outdir: buildDirectory, naming: "owner-child.mjs" });
  if (!result.success || !result.outputs[0]) throw new Error("Synthetic owner fixture did not compile.");
  nodeFixture = result.outputs[0].path;
});
afterAll(() => rmSync(buildDirectory, { recursive: true, force: true }));
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function directory() {
  const path = mkdtempSync(join(tmpdir(), "scraply-owner-test-"));
  directories.push(path);
  return path;
}

async function eventually(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error("Synthetic owner condition timed out."); await delay(10); }
}

async function childOwner(dataDir: string, runtime: "bun" | "node", mode = "hold", version = "0.0.0-test", kind = "cli") {
  const command = runtime === "bun" ? process.execPath : "node";
  const args = runtime === "bun" ? ["--no-env-file", join(import.meta.dir, "../fixtures/owner-child.ts")] : [nodeFixture];
  const child = spawn(command, [...args, dataDir, mode, version, kind], { stdio: "pipe", windowsHide: true,
    env: { ...process.env, EXA_API_KEY: "", PERPLEXITY_API_KEY: "" } });
  let exited = false;
  child.once("exit", () => { exited = true; });
  const finished = once(child, "close");
  cleanup.push(async () => { if (!exited) child.kill(); await finished; });
  const state = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Synthetic owner startup timed out.")), 8_000);
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (!output.includes("\n")) return;
      clearTimeout(timer);
      const parsed: unknown = JSON.parse(output.split("\n")[0]!);
      if (!parsed || typeof parsed !== "object" || !("state" in parsed) || typeof parsed.state !== "string") reject(new Error("Invalid fixture state."));
      else resolve(parsed.state);
    });
    child.once("error", () => { clearTimeout(timer); reject(new Error("Synthetic owner could not start.")); });
    child.once("close", () => { clearTimeout(timer); if (!output.includes("\n")) reject(new Error("Synthetic owner stopped before startup.")); });
  });
  return { child, state, finished };
}

async function fixture(options: { kind?: OwnerKind; version?: string; maxBodyBytes?: number } = {}) {
  const dataDir = directory();
  const lock = await acquireOwnerLock(dataDir);
  if (!lock) throw new Error("Synthetic owner unexpectedly occupied.");
  cleanup.push(() => lock.release());
  const listeners = new Set<(event: ResearchEvent) => void>();
  const calls: Array<{ channel: string; payload: unknown; interactive: boolean }> = [];
  let active = false;
  let hold: Promise<void> | undefined;
  let stopBarrier: Promise<void> | undefined;
  let stopChecks = 0;
  const transport = await startOwnerTransport({
    lock, kind: options.kind ?? "cli", version: options.version ?? "0.0.0-test",
    ...(options.maxBodyBytes ? { maxBodyBytes: options.maxBodyBytes } : {}),
    async invoke(channel, payload, invocation) {
      calls.push({ channel, payload, interactive: invocation.interactive });
      if (channel === "fixture:error") throw new AppError("conflict", "Synthetic conflict.");
      if (channel === "fixture:secret-error") throw new Error("synthetic-secret-not-for-output");
      if (hold) await hold;
      return payload ?? { accepted: true };
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async requestShutdown({ force }) { stopChecks++; if (stopBarrier) await stopBarrier; if (active && !force) return false; if (force) active = false; return true; },
  });
  cleanup.push(() => transport.close());
  const client = createOwnerClient(transport.metadata, transport.metadata.version, { timeoutMs: 2_000 });
  return { dataDir, lock, transport, client, calls, listeners,
    emit(event: ResearchEvent) { for (const listener of listeners) listener(event); },
    setActive(value: boolean) { active = value; },
    setHold(value: Promise<void> | undefined) { hold = value; },
    setStopBarrier(value: Promise<void>) { stopBarrier = value; },
    get stopChecks() { return stopChecks; },
  };
}

function raw(metadata: OwnerMetadata, path: string, options: RequestInit = {}) {
  return fetch(`http://127.0.0.1:${metadata.port}${path}`, { ...options, headers: {
    Authorization: `Bearer ${metadata.token}`, "x-scraply-version": metadata.version, ...options.headers,
  }, signal: AbortSignal.timeout(3_000) });
}

test("Bun and Node exclude canonical aliases, release on crash, and ignore stale descriptors", async () => {
  const dataDir = directory();
  const alias = `${dataDir}-junction`;
  symlinkSync(dataDir, alias, process.platform === "win32" ? "junction" : "dir");
  cleanup.push(() => rmdirSync(alias));
  expect(await canonicalizeDataDir(alias)).toBe(await canonicalizeDataDir(dataDir));
  expect(await canonicalizeDataDir(relative(process.cwd(), dataDir))).toBe(await canonicalizeDataDir(dataDir));
  for (const runtime of ["bun", "node"] as const) {
    const owner = await childOwner(dataDir, runtime);
    expect(owner.state).toBe("ready");
    const stale = await readOwnerMetadata(dataDir);
    expect(stale).not.toBeNull();
    const cases = [alias, dataDir, ...(process.platform === "win32" ? [dataDir.toUpperCase()] : [])];
    for (const contender of ["bun", "node"] as const) {
      for (const path of cases) {
        const probe = await childOwner(path, contender, "probe");
        expect(probe.state).toBe("blocked");
        expect((await probe.finished)[0]).toBe(4);
      }
    }
    owner.child.kill();
    await owner.finished;
    expect(await readOwnerMetadata(dataDir)).toEqual(stale);
    await expect(createOwnerClient(stale!, "0.0.0-test", { timeoutMs: 500 }).health()).rejects.toBeInstanceOf(OwnerTransportError);
    const replacement = await childOwner(alias, runtime, "hold", "0.0.0-next");
    expect(replacement.state).toBe("ready");
    const current = await readOwnerMetadata(dataDir);
    expect(current?.token).not.toBe(stale?.token);
    expect(await createOwnerClient(current!, "0.0.0-next").health()).toMatchObject({ version: "0.0.0-next" });
    replacement.child.stdin.end("stop\n");
    // Start competing while the old process is closing its transport/pipe.
    // A transitional bind failure must never be treated as permission to open
    // data, and must allow a later actual lock acquisition after release.
    let takeover = await acquireOwnerLock(dataDir);
    const takeoverDeadline = Date.now() + 2_000;
    while (!takeover) {
      if (Date.now() > takeoverDeadline) throw new Error("Synthetic lock takeover timed out.");
      await delay(1);
      takeover = await acquireOwnerLock(dataDir);
    }
    const acquired = takeover;
    cleanup.push(() => acquired.release());
    expect((await replacement.finished)[0]).toBe(0);
    expect(await readOwnerMetadata(dataDir)).toBeNull();
    await takeover.release();
  }
}, 30_000);

test("atomic binary writes and replacement retain a protected current-user-only Windows DACL", () => {
  const dataDir = directory();
  const path = join(dataDir, "owner.json");
  writeFileSync(path, "previous-public-fixture");
  writePrivateFileAtomically(path, new Uint8Array([0, 128, 255, 10]));
  expect([...readFileSync(path)]).toEqual([0, 128, 255, 10]);
  writePrivateFileAtomically(path, "replacement");
  expect(readFileSync(path, "utf8")).toBe("replacement");
  expect(readdirSync(dataDir)).toEqual(["owner.json"]);
  if (process.platform === "win32") {
    const script = `$ErrorActionPreference='Stop'; $acl=[IO.File]::GetAccessControl($env:SCRAPLY_ACL_TEST); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $rules=$acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]); if(-not $acl.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].IdentityReference -ne $sid -or $rules[0].AccessControlType -ne 'Allow' -or $rules[0].IsInherited -or $acl.GetOwner([Security.Principal.SecurityIdentifier]) -ne $sid){exit 1}; 'private'`;
    const check = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      env: { ...process.env, SCRAPLY_ACL_TEST: path }, encoding: "utf8", windowsHide: true, timeout: 10_000,
    });
    expect(check.status).toBe(0);
    expect(check.stdout.trim()).toBe("private");
  }
}, 15_000);

test("authenticated handlers enforce noninteractive calls, preserve app errors, and sanitize unknown errors", async () => {
  const { client, calls, dataDir, transport } = await fixture();
  expect(await readOwnerMetadata(dataDir)).toEqual(transport.metadata);
  expect(await client.invoke("fixture:echo", { synthetic: true })).toEqual({ synthetic: true });
  expect(calls).toEqual([{ channel: "fixture:echo", payload: { synthetic: true }, interactive: false }]);
  await expect(client.invoke("fixture:error")).rejects.toMatchObject({ code: "conflict", message: "Synthetic conflict." });
  await expect(client.invoke("fixture:secret-error")).rejects.toMatchObject({ code: "internal_error", message: "Something went wrong. Please try again." });
  await expect(createOwnerClient({ ...transport.metadata, pid: transport.metadata.pid + 1 }, transport.metadata.version).health()).rejects.toMatchObject({ code: "OWNER_IDENTITY_MISMATCH" });
});

test("missing and invalid tokens, browser origins and forged hosts cannot invoke handlers", async () => {
  const { transport, calls } = await fixture();
  for (const headers of [{ Authorization: "" }, { Authorization: "Bearer invalid" }, { Origin: "https://example.test" }, { Origin: "null" }, { Host: "example.test" }, { "Sec-Fetch-Site": "cross-site" }]) {
    const response = await raw(transport.metadata, "/invoke", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: '{"channel":"fixture:echo"}' });
    expect([401, 403]).toContain(response.status);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  }
  expect(calls).toHaveLength(0);
  expect((await raw(transport.metadata, "/invoke", { method: "OPTIONS" })).status).toBe(404);
});

test("bounded JSON rejects oversized, malformed and wrong-content-type requests before handler entry", async () => {
  const { transport, calls } = await fixture({ maxBodyBytes: 128 });
  for (const [body, contentType, status] of [[JSON.stringify({ channel: "fixture:echo", payload: "x".repeat(200) }), "application/json", 413], ["{", "application/json", 400], ['{"channel":"fixture:echo"}', "text/plain", 415]] as const) {
    const response = await raw(transport.metadata, "/invoke", { method: "POST", headers: { "Content-Type": contentType }, body });
    expect(response.status).toBe(status);
  }
  expect(calls).toHaveLength(0);
});

test("version mismatch allows health and idle CLI replacement, and blocks invokes, events and force", async () => {
  const { transport, calls } = await fixture({ version: "0.0.0-owner" });
  const client = createOwnerClient(transport.metadata, "0.0.0-client");
  expect(await client.health()).toMatchObject({ kind: "cli", version: "0.0.0-owner" });
  for (const operation of [() => client.invoke("fixture:echo"), () => client.subscribe(() => undefined), () => client.stop({ force: true })]) {
    await expect(operation()).rejects.toMatchObject({ code: "OWNER_VERSION_MISMATCH", recovery: { requiredVersion: "0.0.0-owner", clientVersion: "0.0.0-client" } });
  }
  for (const path of ["/invoke", "/events"]) {
    const response = await raw(transport.metadata, path, { method: path === "/invoke" ? "POST" : "GET", headers: { "x-scraply-version": "0.0.0-client" } });
    expect(response.status).toBe(409);
  }
  expect(calls).toHaveLength(0);
  expect(await client.stop()).toEqual({ stopped: true });
  expect(transport.activity.stopping).toBe(true);
});

test("desktop owner never accepts remote shutdown", async () => {
  const state = await fixture({ kind: "desktop" });
  const { client, transport } = state;
  expect(await client.stop()).toEqual({ stopped: false });
  expect(await client.stop({ force: true })).toEqual({ stopped: false });
  expect(transport.activity.stopping).toBe(false);
  expect(state.stopChecks).toBe(0);
});

test("live validated SSE detaches on close or abort, and idle stop refuses an open stream", async () => {
  const state = await fixture();
  const events: ResearchEvent[] = [];
  const subscription = await state.client.subscribe(event => events.push(event));
  cleanup.push(() => subscription.close());
  const event: ResearchEvent = { type: "run-started", runId: "synthetic-run", threadId: "synthetic-project", problemId: null };
  state.emit(event);
  await eventually(() => events.length === 1);
  expect(events).toEqual([event]);
  const invalidation: ResearchEvent = { type: "app-state-changed", threadId: "synthetic-project" };
  state.emit(invalidation);
  await eventually(() => events.length === 2);
  expect(events[1]).toEqual(invalidation);
  expect(await state.client.stop()).toEqual({ stopped: false });
  expect(state.stopChecks).toBe(0);
  subscription.close();
  await subscription.done;
  await eventually(() => state.transport.activity.streams === 0);
  const controller = new AbortController();
  const second = await state.client.subscribe(() => undefined, { signal: controller.signal });
  controller.abort();
  await second.done;
  await eventually(() => state.transport.activity.streams === 0);
  expect(state.calls).toHaveLength(0);
  expect(await state.client.stop()).toEqual({ stopped: true });
});

test("unexpected SSE disconnect rejects without reconnecting or cancelling the workflow", async () => {
  const state = await fixture();
  let disconnects = 0;
  const subscription = await state.client.subscribe(() => undefined, { onDisconnect() { disconnects++; } });
  await state.transport.close();
  await expect(subscription.done).rejects.toMatchObject({ code: "OWNER_DISCONNECTED" });
  expect(disconnects).toBe(1);
  expect(state.calls).toHaveLength(0);
});

test("shutdown refuses active work and inflight invocations; force delegates normal cancellation", async () => {
  const state = await fixture();
  state.setActive(true);
  expect(await state.client.stop()).toEqual({ stopped: false });
  expect(state.transport.activity.stopping).toBe(false);
  let release!: () => void;
  state.setHold(new Promise<void>(resolve => { release = resolve; }));
  const invocation = state.client.invoke("fixture:hold");
  await eventually(() => state.transport.activity.inflight === 1);
  expect(await state.client.stop()).toEqual({ stopped: false });
  release();
  await invocation;
  state.setHold(undefined);
  expect(await state.client.stop({ force: true })).toEqual({ stopped: true });
});

test("shutdown atomically gates new admission while the caller checks active work", async () => {
  const state = await fixture();
  let release!: () => void;
  state.setStopBarrier(new Promise<void>(resolve => { release = resolve; }));
  const stopping = state.client.stop();
  await eventually(() => state.stopChecks === 1);
  await expect(state.client.invoke("fixture:must-not-start")).rejects.toMatchObject({ code: "OWNER_STOPPING" });
  await expect(state.client.subscribe(() => undefined)).rejects.toMatchObject({ code: "OWNER_STOPPING" });
  expect(state.calls).toHaveLength(0);
  release();
  expect(await stopping).toEqual({ stopped: true });
});

test("separate Node owner delivers authenticated live events to Bun client", async () => {
  const dataDir = directory();
  const owner = await childOwner(dataDir, "node", "hold", "0.0.0-node", "desktop");
  expect(owner.state).toBe("ready");
  const metadata = await readOwnerMetadata(dataDir);
  const client = createOwnerClient(metadata!, "0.0.0-node");
  const events: ResearchEvent[] = [];
  const subscription = await client.subscribe(event => events.push(event));
  cleanup.push(() => subscription.close());
  const event = { type: "run-cancelled", runId: "synthetic-run", threadId: "synthetic-project" } as const;
  expect(await client.invoke("fixture:emit", event)).toEqual({ emitted: true });
  await eventually(() => events.length === 1);
  expect(events).toEqual([event]);
  subscription.close();
  await subscription.done;
  owner.child.stdin.end("stop\n");
  expect((await owner.finished)[0]).toBe(0);
});

test("a lost invocation response is never replayed, and the SSE client rejects invalid shared events", async () => {
  let invocations = 0;
  let eventConnections = 0;
  let stall = false;
  let stallHealth = false;
  const server = createServer((req, res) => {
    res.setHeader("x-scraply-version", "0.0.0-synthetic");
    const identity = { pid: metadata.pid, port: metadata.port, kind: metadata.kind, version: metadata.version };
    if (req.url === "/health") {
      if (stallHealth) return;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, data: identity }));
    } else if (req.url === "/invoke") {
      invocations++;
      res.destroy();
    } else {
      eventConnections++;
      if (stall) return;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`event: owner\ndata: ${JSON.stringify(identity)}\n\n`);
      res.write('data: {"type":"unrecognized-synthetic-event"}\n\n');
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic transport did not bind.");
  const metadata: OwnerMetadata = { pid: process.pid, port: address.port, kind: "cli", version: "0.0.0-synthetic", token: "a".repeat(64) };
  const client = createOwnerClient(metadata, metadata.version, { timeoutMs: 1_000 });
  await expect(client.invoke("fixture:mutate", undefined, { timeoutMs: null })).rejects.toMatchObject({ code: "OWNER_UNAVAILABLE" });
  expect(invocations).toBe(1);
  const events: ResearchEvent[] = [];
  const subscription = await client.subscribe(event => events.push(event));
  await expect(subscription.done).rejects.toBeInstanceOf(Error);
  expect(events).toHaveLength(0);
  expect(eventConnections).toBe(1);
  stall = true;
  const shortClient = createOwnerClient(metadata, metadata.version, { timeoutMs: 100 });
  await expect(shortClient.subscribe(() => undefined)).rejects.toMatchObject({ code: "OWNER_TIMEOUT" });
  const controller = new AbortController();
  const pending = client.subscribe(() => undefined, { signal: controller.signal });
  // Wait for the real connection, then abort before any event headers arrive.
  await eventually(() => eventConnections === 3);
  controller.abort();
  await expect(pending).rejects.toBeInstanceOf(Error);
  stallHealth = true;
  await expect(shortClient.invoke("fixture:must-not-start", undefined, { timeoutMs: null })).rejects.toMatchObject({ code: "OWNER_TIMEOUT" });
  expect(invocations).toBe(1);
});

test("transport close drains an accepted invocation before ownership can be released", async () => {
  const state = await fixture();
  let release!: () => void;
  state.setHold(new Promise<void>(resolve => { release = resolve; }));
  const invocation = state.client.invoke("fixture:hold", { persisted: true });
  await eventually(() => state.calls.length === 1);
  const closing = state.transport.close();
  expect(state.transport.activity.stopping).toBe(true);
  expect(await acquireOwnerLock(state.dataDir)).toBeNull();
  release();
  expect(await invocation).toEqual({ persisted: true });
  await closing;
  expect(await acquireOwnerLock(state.dataDir)).toBeNull();
  await state.lock.release();
  const next = await acquireOwnerLock(state.dataDir);
  expect(next).not.toBeNull();
  await next?.release();
});

test("an invocation timeout reports unknown completion without cancelling or replaying accepted work", async () => {
  const state = await fixture();
  let release!: () => void;
  state.setHold(new Promise<void>(resolve => { release = resolve; }));
  cleanup.push(() => release());
  const client = createOwnerClient(state.transport.metadata, state.transport.metadata.version, { timeoutMs: 100 });
  try {
    await expect(client.invoke("fixture:slow")).rejects.toMatchObject({ code: "OWNER_TIMEOUT", status: 504 });
    expect(state.calls).toHaveLength(1);
    expect(state.transport.activity.inflight).toBe(1);
  } finally { release(); }
  await eventually(() => state.transport.activity.inflight === 0);
  expect(state.calls).toHaveLength(1);
});

test("an unbounded invocation waits beyond discovery timeout and returns the completed result", async () => {
  const state = await fixture();
  let release!: () => void;
  state.setHold(new Promise<void>(resolve => { release = resolve; }));
  cleanup.push(() => release());
  const client = createOwnerClient(state.transport.metadata, state.transport.metadata.version, { timeoutMs: 100 });
  let settled = false;
  const pending = client.invoke("fixture:generate-title", { title: "Synthetic title" }, { timeoutMs: null });
  void pending.then(() => { settled = true; }, () => { settled = true; });
  try {
    await eventually(() => state.calls.length === 1);
    await delay(250);
    expect(settled).toBe(false);
    expect(state.transport.activity.inflight).toBe(1);
  } finally { release(); }
  expect(await pending).toEqual({ title: "Synthetic title" });
  expect(state.calls).toHaveLength(1);
});

test("per-invocation timeout overrides and abort still detach without replaying or cancelling work", async () => {
  const state = await fixture();
  for (const timeoutMs of [50, null] as const) {
    let release!: () => void;
    state.setHold(new Promise<void>(resolve => { release = resolve; }));
    cleanup.push(() => release());
    const controller = new AbortController();
    const subscription = timeoutMs === null ? await state.client.subscribe(() => undefined, { signal: controller.signal }) : undefined;
    const previousCalls = state.calls.length;
    const pending = state.client.invoke("fixture:slow", undefined, { timeoutMs, signal: controller.signal });
    const failure = pending.then(() => undefined, (error: unknown) => error);
    try {
      await eventually(() => state.calls.length === previousCalls + 1);
      if (timeoutMs === null) controller.abort();
      expect(await failure).toMatchObject({ code: timeoutMs === null ? "OWNER_UNAVAILABLE" : "OWNER_TIMEOUT" });
      await subscription?.done;
      expect(state.transport.activity.inflight).toBe(1);
    } finally { release(); }
    await eventually(() => state.transport.activity.inflight === 0);
    expect(state.calls).toHaveLength(previousCalls + 1);
  }
});
