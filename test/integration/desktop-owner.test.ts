import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { createDesktopOwner } from "../../src/main/desktop-owner";
import { acquireOwnerLock, readOwnerMetadata } from "../../src/app/owner";
import { createOwnerClient, startOwnerTransport } from "../../src/app/owner-transport";
import { connectOwner } from "../../src/cli/connect";
import { APP_CHANNELS } from "../../src/shared/cli-contracts";
import { IPC_CHANNELS, type ResearchEvent } from "../../src/shared/ipc";

const version = "desktop-test";
const cleanup: Array<() => void | Promise<void>> = [];
const directories: string[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function profile() {
  const path = mkdtempSync(join(tmpdir(), "scraply-desktop-owner-"));
  directories.push(path);
  return path;
}
async function eventually<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error("Synthetic desktop condition timed out.");
    await delay(20);
  }
}
async function child(profileDir: string, mode: "desktop" | "cli", childVersion = version, idleMs = 600_000) {
  const processHandle = spawn(process.execPath, ["--no-env-file", "run", join(import.meta.dir, "../fixtures/desktop-owner-child.ts"),
    profileDir, mode, childVersion, String(idleMs)], {
    stdio: "pipe", windowsHide: true, env: { ...process.env, EXA_API_KEY: "", PERPLEXITY_API_KEY: "" },
  });
  const messages: unknown[] = [];
  let errorText = "";
  let exited = false;
  const lines = createInterface({ input: processHandle.stdout });
  lines.on("line", line => { messages.push(JSON.parse(line)); });
  processHandle.stderr.on("data", chunk => { errorText += String(chunk); });
  const exit = new Promise<number | null>((resolve, reject) => {
    processHandle.once("error", reject);
    processHandle.once("close", code => { exited = true; resolve(code); });
  });
  cleanup.push(async () => { if (!exited) processHandle.kill(); await exit; lines.close(); });
  await eventually(() => {
    if (exited) throw new Error(`Synthetic desktop child exited: ${errorText.slice(-500)}`);
    return messages.some(value => z.object({ ready: z.literal(true) }).safeParse(value).success);
  }, Boolean);
  let sequence = 0;
  async function invoke(channel: string, payload?: unknown) {
    const id = ++sequence;
    processHandle.stdin.write(`${JSON.stringify({ id, channel, ...(payload === undefined ? {} : { payload }) })}\n`);
    const response = await eventually(() => messages.find(value => z.object({ id: z.literal(id) }).safeParse(value).success), value => value !== undefined);
    return z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), data: z.unknown() }),
      z.object({ ok: z.literal(false), error: z.string() })]).parse(response);
  }
  return { processHandle, messages, exit, invoke,
    async status() {
      const response = await invoke("fixture:status");
      if (!response.ok) throw new Error(response.error);
      return z.object({ kind: z.string(), factories: z.number(), credentialReads: z.number() }).parse(response.data);
    },
    async close() { processHandle.stdin.write("close\n"); return exit; },
  };
}
async function client(profileDir: string, clientVersion = version) {
  const metadata = await readOwnerMetadata(profileDir);
  if (!metadata) throw new Error("Missing synthetic descriptor.");
  return createOwnerClient(metadata, clientVersion, { timeoutMs: 3_000 });
}

test("CLI attaches to desktop service and both clients observe real persisted project changes", async () => {
  const directory = profile();
  const desktop = await child(directory, "desktop");
  const cli = await connectOwner({ profileDir: directory, version,
    launchHost() { throw new Error("Existing desktop must not launch CLI host."); } });
  const initialEvents = desktop.messages.filter(value => z.object({ event: z.object({ type: z.literal("app-state-changed") }) }).safeParse(value).success).length;
  const created = z.object({ thread: z.object({ id: z.string() }) }).parse(await cli.invoke(IPC_CHANNELS.CREATE_THREAD, { title: "Synthetic kiln scheduling" }));
  expect(await desktop.status()).toEqual({ kind: "desktop", factories: 1, credentialReads: 1 });
  const workspace = await desktop.invoke(IPC_CHANNELS.GET_WORKSPACE);
  expect(JSON.stringify(workspace)).toContain("Synthetic kiln scheduling");
  await eventually(() => desktop.messages.filter(value => z.object({ event: z.object({ type: z.literal("app-state-changed") }) }).safeParse(value).success).length, count => count > initialEvents);
  expect((await desktop.invoke(IPC_CHANNELS.ARCHIVE_THREAD, { threadId: created.thread.id, archived: true })).ok).toBe(true);
  expect(await cli.invoke(APP_CHANNELS.LIST_PROJECTS, { archived: true })).toMatchObject({ projects: [{ id: created.thread.id, archivedAt: expect.any(String) }] });
  await expect(cli.invoke(IPC_CHANNELS.START_RESEARCH, { threadId: created.thread.id })).rejects.toMatchObject({ code: "conflict" });
  expect(await cli.stop({ force: true })).toEqual({ stopped: false });
  expect(await desktop.close()).toBe(0);
}, 30_000);

test("desktop attaches to CLI without credentials/backend and its SSE keeps an idle host alive", async () => {
  const directory = profile();
  const cli = await child(directory, "cli", version, 2_000);
  const desktop = await child(directory, "desktop");
  expect(await desktop.status()).toEqual({ kind: "remote", factories: 0, credentialReads: 0 });
  const owner = await client(directory);
  const initialEvents = desktop.messages.filter(value => z.object({ event: z.object({ type: z.literal("app-state-changed") }) }).safeParse(value).success).length;
  await owner.invoke(IPC_CHANNELS.CREATE_THREAD, { title: "Synthetic orchard routing" });
  await eventually(() => desktop.messages.filter(value => z.object({ event: z.object({ type: z.literal("app-state-changed") }) }).safeParse(value).success).length, count => count > initialEvents);
  expect(JSON.stringify(await desktop.invoke(IPC_CHANNELS.GET_WORKSPACE))).toContain("Synthetic orchard routing");
  expect((await desktop.invoke(IPC_CHANNELS.CREATE_THREAD, { title: "Synthetic quarry shifts" })).ok).toBe(true);
  expect(JSON.stringify(await owner.invoke(APP_CHANNELS.LIST_PROJECTS))).toContain("Synthetic quarry shifts");
  await delay(2_200);
  expect((await owner.health()).kind).toBe("cli");
  expect(await desktop.status()).toEqual({ kind: "remote", factories: 0, credentialReads: 0 });
  expect(await desktop.close()).toBe(0);
  expect(await cli.exit).toBe(0);
}, 30_000);

test("a lost mutation response is not replayed when desktop acquires ownership after CLI crash", async () => {
  const directory = profile();
  const cli = await child(directory, "cli");
  const desktop = await child(directory, "desktop");
  expect((await desktop.invoke(IPC_CHANNELS.CREATE_THREAD, { title: "Synthetic interrupted reply" })).ok).toBe(false);
  expect(await cli.exit).toBe(71);
  await eventually(() => desktop.status(), value => value.kind === "desktop");
  expect(await desktop.status()).toEqual({ kind: "desktop", factories: 1, credentialReads: 1 });
  const owner = await client(directory);
  const projects = z.object({ projects: z.array(z.object({ title: z.string() })) }).parse(await owner.invoke(APP_CHANNELS.LIST_PROJECTS));
  expect(projects.projects.filter(project => project.title === "Synthetic interrupted reply")).toHaveLength(1);
  expect(await owner.invoke(APP_CHANNELS.LIST_RUNS)).toEqual({ runs: [] });
  expect(await desktop.close()).toBe(0);
}, 30_000);

test("exact version conflicts never call desktop factory; idle old CLI replacement waits for ownership", async () => {
  const directory = profile();
  const oldDesktop = await child(directory, "desktop", "old-version");
  let factoryCalls = 0;
  const contender = createDesktopOwner({ profileDir: directory, version, publishEvent() {},
    async createApplication() { factoryCalls++; throw new Error("Must not construct on version conflict."); } });
  cleanup.push(() => contender.close());
  await expect(contender.start()).rejects.toMatchObject({ code: "OWNER_VERSION_MISMATCH", recovery: { ownerKind: "desktop", ownerVersion: "old-version" } });
  expect(factoryCalls).toBe(0);
  expect(await oldDesktop.close()).toBe(0);
  const oldCli = await child(directory, "cli", "old-version");
  const occupied = await (await client(directory, "old-version")).subscribe(() => undefined);
  const blocked = createDesktopOwner({ profileDir: directory, version, publishEvent() {},
    async createApplication() { factoryCalls++; throw new Error("Must not replace an attached old CLI."); } });
  cleanup.push(() => blocked.close());
  await expect(blocked.start()).rejects.toMatchObject({ code: "OWNER_VERSION_MISMATCH" });
  expect(factoryCalls).toBe(0);
  occupied.close();
  await occupied.done;
  const desktop = await child(directory, "desktop");
  expect(await oldCli.exit).toBe(0);
  expect(await desktop.status()).toEqual({ kind: "desktop", factories: 1, credentialReads: 1 });
  expect((await readOwnerMetadata(directory))?.kind).toBe("desktop");
  expect(await desktop.close()).toBe(0);
}, 30_000);

test("disconnect cannot grant ownership while the old pipe is held", async () => {
  const directory = profile();
  const lock = await acquireOwnerLock(directory);
  if (!lock) throw new Error("Synthetic profile busy.");
  cleanup.push(() => lock.release());
  const transport = await startOwnerTransport({ lock, kind: "cli", version, async invoke() { return {}; }, subscribe() { return () => undefined; }, requestShutdown: () => false });
  cleanup.push(() => transport.close());
  let factoryCalls = 0;
  const events: ResearchEvent[] = [];
  const desktop = createDesktopOwner({ profileDir: directory, version, publishEvent(event) { events.push(event); },
    retryDelayMs: 20,
    async createApplication() { factoryCalls++; return { async invoke() { return {}; }, async stop() {}, secretValues: () => [] }; },
  });
  cleanup.push(() => desktop.close());
  await desktop.start();
  await transport.close();
  await delay(250);
  expect(factoryCalls).toBe(0);
  expect(events.some(event => event.type === "app-state-changed")).toBe(true);
  await lock.release();
  await eventually(() => desktop.kind, kind => kind === "desktop");
  expect(factoryCalls).toBe(1);
  await desktop.close();
}, 15_000);

test("closing an attached desktop during reconnect prevents a later factory call", async () => {
  const directory = profile();
  const lock = await acquireOwnerLock(directory);
  if (!lock) throw new Error("Synthetic profile busy.");
  cleanup.push(() => lock.release());
  const transport = await startOwnerTransport({ lock, kind: "cli", version, async invoke() { return {}; }, subscribe() { return () => undefined; }, requestShutdown: () => false });
  cleanup.push(() => transport.close());
  let factoryCalls = 0;
  const desktop = createDesktopOwner({ profileDir: directory, version, publishEvent() {}, retryDelayMs: 20,
    async createApplication() { factoryCalls++; throw new Error("Closed desktop must never construct credentials/backend."); },
  });
  cleanup.push(() => desktop.close());
  await desktop.start();
  await transport.close();
  await eventually(() => desktop.kind, kind => kind === "disconnected");
  await desktop.close();
  await lock.release();
  await delay(100);
  expect(factoryCalls).toBe(0);
  const available = await acquireOwnerLock(directory);
  expect(available).not.toBeNull();
  await available?.release();
}, 15_000);

test("closing an attached desktop detaches its pending request without cancelling or replaying owner work", async () => {
  const directory = profile();
  const lock = await acquireOwnerLock(directory);
  if (!lock) throw new Error("Synthetic profile busy.");
  cleanup.push(() => lock.release());
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let admissions = 0;
  let completions = 0;
  const transport = await startOwnerTransport({
    lock, kind: "cli", version,
    async invoke() { admissions++; await barrier; completions++; return {}; },
    subscribe() { return () => undefined; }, requestShutdown: () => false,
  });
  cleanup.push(() => transport.close());
  const desktop = createDesktopOwner({ profileDir: directory, version, publishEvent() {},
    async createApplication() { throw new Error("Must stay attached."); },
  });
  cleanup.push(() => desktop.close());
  await desktop.start();
  const request = desktop.invoke(IPC_CHANNELS.GET_ADVANCED_SETTINGS);
  const settled = request.then(() => ({ ok: true }), (error: unknown) => ({ ok: false, error }));
  await eventually(() => admissions, count => count === 1);
  await desktop.close();
  expect(await settled).toMatchObject({ ok: false, error: { code: "OWNER_UNAVAILABLE" } });
  expect(completions).toBe(0);
  expect(await acquireOwnerLock(directory)).toBeNull();
  release();
  await eventually(() => completions, count => count === 1);
  expect(admissions).toBe(1);
}, 15_000);

test("close gates reconnect and holds ownership through accepted requests and application drain", async () => {
  const directory = profile();
  let releaseInvoke!: () => void;
  let releaseStop!: () => void;
  let invoked = false;
  let stopped = false;
  const invocation = new Promise<void>(resolve => { releaseInvoke = resolve; });
  const stopping = new Promise<void>(resolve => { releaseStop = resolve; });
  const desktop = createDesktopOwner({ profileDir: directory, version, publishEvent() {},
    async createApplication() { return {
      async invoke() { invoked = true; await invocation; return {}; },
      async stop() { stopped = true; await stopping; }, secretValues: () => [],
    }; },
  });
  cleanup.push(() => desktop.close());
  await desktop.start();
  const request = desktop.invoke(IPC_CHANNELS.GET_WORKSPACE);
  await eventually(() => invoked, Boolean);
  const closing = desktop.close();
  await expect(desktop.invoke(IPC_CHANNELS.RETRY_CONNECTION)).rejects.toMatchObject({ code: "backend_unavailable" });
  expect(await acquireOwnerLock(directory)).toBeNull();
  releaseInvoke();
  await request;
  await eventually(() => stopped, Boolean);
  expect(await acquireOwnerLock(directory)).toBeNull();
  releaseStop();
  await closing;
  const acquired = await acquireOwnerLock(directory);
  expect(acquired).not.toBeNull();
  await acquired?.release();
}, 15_000);
