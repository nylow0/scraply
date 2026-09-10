import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { BROWSER_DEV_ORIGIN } from "./browser-dev-proxy";

const root = resolve(import.meta.dir, "..");
const stateDirectory = resolve(root, "build/browser-dev");
const statePath = resolve(stateDirectory, "server.json");
const logPath = resolve(stateDirectory, "server.log");
const StateSchema = z.object({ token: z.string().length(48), sessionId: z.string().uuid(), port: z.number().int().positive() });
type State = z.infer<typeof StateSchema>;

function readState(): State | undefined {
  if (!existsSync(statePath)) return undefined;
  try {
    const parsed = StateSchema.safeParse(JSON.parse(readFileSync(statePath, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch (error) {
    // Truncated launch metadata can be regenerated; file-access failures still matter.
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function isRunning(state: State): Promise<boolean> {
  try {
    const response = await fetch(`${BROWSER_DEV_ORIGIN}/__scraply_dev/health`, { signal: AbortSignal.timeout(1000) });
    const value: unknown = await response.json();
    return response.ok && z.object({ sessionId: z.literal(state.sessionId) }).safeParse(value).success;
  } catch {
    return false;
  }
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cannot allocate the dev host port");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function stop(state: State): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${state.port}/shutdown`, {
    method: "POST",
    headers: { authorization: `Bearer ${state.token}`, "x-scraply-control": state.token },
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error("The saved dev server refused the stop request");
  for (let attempt = 0; attempt < 40; attempt++) {
    if (!await isRunning(state)) return;
    await delay(250);
  }
  throw new Error("The dev server did not stop within 10 seconds");
}

async function serve(): Promise<void> {
  const state = readState();
  if (!state) throw new Error("Missing browser dev state; use bun run dev");
  // Electron stays windowless. It retains the production database and credential services.
  const environment = {
    ...process.env,
    SCRAPLY_BROWSER_DEV: "1",
    VITE_SCRAPLY_BROWSER_DEV: "1",
    SCRAPLY_BROWSER_TOKEN: state.token,
    SCRAPLY_BROWSER_SESSION: state.sessionId,
    SCRAPLY_BROWSER_PORT: String(state.port),
    SCRAPLY_AGENT_PATH: process.env.SCRAPLY_AGENT_PATH ?? resolve(root, "build/runtime/scraply-agent.exe"),
    SCRAPLY_AGENT_LOCK_PATH: process.env.SCRAPLY_AGENT_LOCK_PATH ?? resolve(root, "build/runtime/scraply-agent.lock.json"),
  };
  const dataDirectory = resolve(process.env.SCRAPLY_DEV_DATA_DIR ?? resolve(root, ".scraply/browser-dev"));
  const child = spawn("bun", ["run", "dev:electron", "--watch", "--", `--user-data-dir=${dataDirectory}`], {
    cwd: root, env: environment, windowsHide: true, stdio: "inherit",
  });
  child.on("error", error => { console.error(error.message); process.exitCode = 1; });
  child.on("exit", code => { process.exitCode = code ?? 1; });
}

async function start(): Promise<void> {
  const previous = readState();
  if (previous && await isRunning(previous)) {
    console.log(`Scraply is running: ${BROWSER_DEV_ORIGIN}`);
    return;
  }
  for (const file of ["node_modules/electron/path.txt", "node_modules/electron/dist/electron.exe"]) {
    if (!existsSync(resolve(root, file))) throw new Error("Electron is missing. Run bun install, then bunx --no-install install-electron.");
  }
  for (const file of [process.env.SCRAPLY_AGENT_PATH ?? resolve(root, "build/runtime/scraply-agent.exe"), process.env.SCRAPLY_AGENT_LOCK_PATH ?? resolve(root, "build/runtime/scraply-agent.lock.json")]) {
    if (!existsSync(file)) throw new Error("Native runtime is missing. Run bun run prepare:runtime once, or configure SCRAPLY_AGENT_PATH and SCRAPLY_AGENT_LOCK_PATH.");
  }
  // Refuse an occupied UI port before starting another host or overwriting its state.
  const probe = createServer();
  await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(5173, "127.0.0.1", resolve); });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const state: State = { token: randomBytes(24).toString("hex"), sessionId: randomUUID(), port: await unusedPort() };
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
  const log = openSync(logPath, "w");
  const child = spawn(process.execPath, [import.meta.filename, "serve"], {
    cwd: root, env: process.env, detached: true, windowsHide: true, stdio: ["ignore", log, log],
  });
  closeSync(log);
  child.unref();
  for (let attempt = 0; attempt < 90; attempt++) {
    if (await isRunning(state)) {
      console.log(`Scraply is running: ${BROWSER_DEV_ORIGIN}\nStop: bun run dev:stop\nLogs: ${logPath}`);
      return;
    }
    await delay(250);
  }
  await stop(state).catch(() => undefined);
  throw new Error(`Browser dev did not become ready. See ${logPath}`);
}

try {
  const command = process.argv[2] ?? "start";
  if (command === "serve") await serve();
  else if (command === "start") await start();
  else if (command === "stop") {
    const state = readState();
    if (!state || !await isRunning(state)) console.log("This checkout's dev server is not running.");
    else { await stop(state); console.log("Scraply dev server stopped."); }
  } else throw new Error(`Unknown dev command: ${command}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
