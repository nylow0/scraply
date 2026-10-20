import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { acquireOwnerLock, canonicalizeDataDir, readOwnerMetadata } from "../app/owner";
import { sourceCli } from "../app/profile";
import { createOwnerClient } from "../app/owner-transport";
import { OwnerTransportError, ownerVersionError, type OwnerHealth } from "../shared/owner-contracts";
import { HostBootstrapResultSchema, HOST_BOOTSTRAP_MAX_BYTES } from "./host";

export type OwnerClient = ReturnType<typeof createOwnerClient>;
export interface OwnerConnectionOptions {
  profileDir: string;
  version: string;
  timeoutMs?: number;
}

function deadlineFor(timeoutMs = 30_000): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("The connection timeout must be a positive finite duration.");
  return Date.now() + timeoutMs;
}

function remaining(deadline: number): number {
  const duration = deadline - Date.now();
  if (duration <= 0) throw new OwnerTransportError({ code: "OWNER_TIMEOUT", message: "Timed out waiting for the Scraply owner. Inspect host status before retrying." }, 504);
  return duration;
}

async function discover(profileDir: string, version: string, deadline: number): Promise<{
  client: OwnerClient; health: OwnerHealth;
} | null> {
  const metadata = await readOwnerMetadata(profileDir);
  if (!metadata) return null;
  const client = createOwnerClient(metadata, version, { timeoutMs: Math.min(1_000, remaining(deadline)) });
  try {
    const health = await client.health();
    remaining(deadline);
    return { client: createOwnerClient(metadata, version, { timeoutMs: remaining(deadline) }), health };
  } catch {
    if (Date.now() >= deadline) remaining(deadline);
    // A stale port may now belong to an unrelated service. Auth, malformed
    // protocol and identity failures all mean discovery did not find an owner.
    // Only acquiring the real mutex below can permit a replacement launch.
    return null;
  }
}

/** Explicit runner for production and synthetic child commands. Never selected from an environment override. */
export async function startDetachedHost(options: {
  executablePath: string;
  args: readonly string[];
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<void> {
  await new Promise<void>((resolveLaunch, reject) => {
    const child = spawn(options.executablePath, [...options.args], {
      detached: true, windowsHide: true, stdio: ["ignore", "pipe", "ignore"], env: options.environment,
    });
    const output = child.stdout;
    let bytes = 0;
    const chunks: Buffer[] = [];
    let settled = false;
    function finish(error?: unknown) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      output.removeAllListeners();
      output.destroy();
      child.unref();
      if (error) reject(error);
      else resolveLaunch();
    }
    const failedChannel = () => new OwnerTransportError({ code: "OWNER_START_FAILED", message: "The CLI host ended startup without a valid bootstrap result. Inspect its private logs before retrying." });
    const timer = setTimeout(() => finish(new OwnerTransportError({ code: "OWNER_TIMEOUT", message: "Timed out waiting for the CLI host to initialize. Inspect host status before retrying." }, 504)), options.timeoutMs);
    child.once("error", () => finish(new OwnerTransportError({ code: "OWNER_START_FAILED", message: "The detached Scraply host could not be launched." })));
    output.on("error", () => finish(failedChannel()));
    output.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > HOST_BOOTSTRAP_MAX_BYTES) { finish(failedChannel()); return; }
      chunks.push(Buffer.from(chunk));
      const frame = Buffer.concat(chunks);
      const newline = frame.indexOf(10);
      if (newline < 0) return;
      if (newline !== frame.length - 1) { finish(failedChannel()); return; }
      let value: unknown;
      try { value = JSON.parse(frame.toString("utf8")); }
      catch { finish(failedChannel()); return; }
      const result = HostBootstrapResultSchema.safeParse(value);
      if (!result.success) { finish(failedChannel()); return; }
      if (result.data.state === "ready" || result.data.error.code === "OWNER_BUSY") { finish(); return; }
      finish(new OwnerTransportError(result.data.error, result.data.exitCode === 4 ? 409 : 503));
    });
    // Standard stdout may keep its OS handle open after end() in Bun. Consume
    // one bounded JSONL result, then close our pipe before detaching the child.
    output.once("end", () => finish(failedChannel()));
    output.once("close", () => finish(failedChannel()));
  });
}

/** Launch only the current distribution. No shell, runtime PATH lookup or mock environment switch. */
async function launchDetachedHost(profileDir: string, timeoutMs: number): Promise<void> {
  const args = sourceCli
    ? ["--no-env-file", "run", resolve(import.meta.dir, "main.ts"), "__host", "--data-dir", profileDir]
    : ["__host", "--data-dir", profileDir];
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  await startDetachedHost({ executablePath: process.execPath, args, environment, timeoutMs });
}

/** Attach or start. Discovery retries only health/publication, never an app invocation. */
export async function connectOwner(options: OwnerConnectionOptions & {
  launchHost?: (profileDir: string) => void | Promise<void>;
}): Promise<OwnerClient> {
  const deadline = deadlineFor(options.timeoutMs);
  const profileDir = await canonicalizeDataDir(options.profileDir);
  let launched = false;
  let replacing = false;
  for (;;) {
    remaining(deadline);
    const owner = await discover(profileDir, options.version, deadline);
    if (owner) {
      if (owner.health.version === options.version) return owner.client;
      if (owner.health.kind === "desktop") throw ownerVersionError(owner.health, options.version);
      if (!replacing) {
        if (!(await owner.client.stop()).stopped) throw ownerVersionError(owner.health, options.version);
        replacing = true;
      }
    } else if (!launched) {
      // A failed health request does not prove the old owner released SQLite.
      // Wait for the real mutex, and never retain it while launching the host.
      const lock = await acquireOwnerLock(profileDir);
      if (!lock) { await delay(Math.min(50, remaining(deadline))); continue; }
      try {
        if (!options.launchHost) {
          const { assertNoLegacyDesktop } = await import("./host");
          await assertNoLegacyDesktop(profileDir, options.version);
        }
      } finally {
        await lock.release();
      }
      if (options.launchHost) await options.launchHost(profileDir);
      else await launchDetachedHost(profileDir, remaining(deadline));
      launched = true;
    }
    await delay(Math.min(50, remaining(deadline)));
  }
}

/** Read-only owner status; this path never starts a backend. */
export async function readHostStatus(options: OwnerConnectionOptions): Promise<OwnerHealth | null> {
  const owner = await discover(options.profileDir, options.version, deadlineFor(options.timeoutMs));
  return owner?.health ?? null;
}

/** Stop an existing owner and wait for its actual lock release. Never auto-start. */
export async function stopHost(options: OwnerConnectionOptions & { force?: boolean }): Promise<{ stopped: boolean }> {
  const deadline = deadlineFor(options.timeoutMs);
  const owner = await discover(options.profileDir, options.version, deadline);
  if (!owner) throw new OwnerTransportError({ code: "OWNER_NOT_RUNNING", message: "No Scraply owner is running for this profile." }, 409);
  if (owner.health.version !== options.version && (owner.health.kind === "desktop" || options.force)) {
    throw ownerVersionError(owner.health, options.version);
  }
  const result = await owner.client.stop({ force: options.force ?? false });
  if (!result.stopped) return result;
  for (;;) {
    remaining(deadline);
    const lock = await acquireOwnerLock(options.profileDir);
    if (lock) { await lock.release(); return result; }
    await delay(Math.min(50, remaining(deadline)));
  }
}
