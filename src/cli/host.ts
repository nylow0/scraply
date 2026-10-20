import { acquireOwnerLock } from "../app/owner";
import { resolveProfile, sourceCli, type AppProfile } from "../app/profile";
import { startOwnerTransport, type OwnerTransport } from "../app/owner-transport";
import type { ResearchEvent } from "../shared/ipc";
import { AppError, toErrorPayload } from "../shared/errors";
import { OwnerErrorSchema, OwnerTransportError, type OwnerMetadata } from "../shared/owner-contracts";
import { z } from "zod";

export const HOST_BOOTSTRAP_MAX_BYTES = 4_096;
export const HostBootstrapResultSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ready") }).strict(),
  z.object({ state: z.literal("failed"), error: OwnerErrorSchema, exitCode: z.union([z.literal(1), z.literal(4)]) }).strict(),
]);

export interface HostApplication {
  start(): Promise<void>;
  invoke(channel: string, payload: unknown): Promise<unknown>;
  hasActiveWork(): boolean;
  requestShutdown(force: boolean): Promise<boolean>;
  stop(): Promise<void>;
}

export type HostFactory = (
  profile: AppProfile, version: string, publishEvent: (event: ResearchEvent) => void,
) => HostApplication | Promise<HostApplication>;

export interface CliHost {
  metadata: OwnerMetadata;
  closed: Promise<void>;
  stop(force?: boolean): Promise<boolean>;
}

/** Called only under the canonical owner mutex, before credentials or SQLite. */
export async function assertNoLegacyDesktop(profileDir: string, version: string): Promise<void> {
  const { detectLegacyDesktop } = await import("./legacy-desktop");
  if (detectLegacyDesktop(profileDir).running) {
    throw new OwnerTransportError({
      code: "OWNER_LEGACY_DESKTOP",
      message: "An older Scraply desktop owns this profile. Close it or update the desktop before using the CLI.",
      recovery: { action: "close-or-update-desktop", requiredVersion: version },
    }, 409);
  }
}

async function createHostApplication(
  profile: AppProfile, version: string, publishEvent: (event: ResearchEvent) => void,
): Promise<HostApplication> {
  await assertNoLegacyDesktop(profile.profileDir, version);
  const { createWindowsEncryption } = await import("./oscrypt");
  const encryption = createWindowsEncryption(profile.profileDir);
  try {
    const { createCredentialStore } = await import("../main/credential-store");
    const { createFileLogger } = await import("../main/logging");
    const { createAppService } = await import("../app/service");
    const { createInProcessBackend } = await import("../app/in-process-backend");
    const { resolveRuntimeLaunch } = await import("../shared/runtime-artifact");
    const { dirname } = await import("node:path");
    let launch: ReturnType<typeof resolveRuntimeLaunch>;
    try {
      launch = resolveRuntimeLaunch({ packaged: !sourceCli, resourcesPath: dirname(process.execPath) });
      if (!launch) throw new Error("No configured runtime");
    } catch {
      throw new AppError("backend_unavailable", "The native runtime is missing or invalid. Prepare the source runtime or reinstall the CLI bundle.",
        503, undefined, { action: "repair-runtime" });
    }
    const logger = createFileLogger({
      logsDir: profile.logsDir, appVersion: version,
      getSecrets: () => [...service.secretValues(), process.env.EXA_API_KEY ?? "", process.env.PERPLEXITY_API_KEY ?? ""],
    });
    const backend = createInProcessBackend({
      runtime: { ...launch, appVersion: version },
      log: input => logger.log({ component: "backend", ...input }),
    });
    const service = createAppService({
      paths: profile, appVersion: version,
      credentialStore: createCredentialStore(profile.credentialsPath, encryption),
      backend, publishEvent,
    });
    const app = service;
    return {
      async start() {
        try {
          await app.start({ validateAutomaticSecrets: false });
          // Readiness includes verified worker initialization. This existing route
          // prepares account/status only, with no search or workflow admission.
          try { await backend.request("/native/retry", { method: "POST", body: "{}" }); }
          catch {
            throw new AppError("backend_unavailable", "The native runtime could not initialize. Repair or reinstall the verified runtime before retrying.",
              503, undefined, { action: "repair-runtime" });
          }
        }
        catch (error) {
          logger.log({ component: "cli", level: "error", event: "host-startup-failed", error });
          throw error;
        }
      },
      invoke: app.invokeRemote,
      hasActiveWork: backend.hasActiveWork,
      requestShutdown: backend.requestShutdown,
      async stop() {
        try { await app.stop(); }
        finally { encryption.dispose(); }
      },
    };
  } catch (error) {
    encryption.dispose();
    throw error;
  }
}

/** Only __host uses stdout as a private startup pipe. It carries no logs or owner credentials. */
export async function runHostCommand(options: Omit<Parameters<typeof runHost>[0], "profileDir"> & {
  profileDir?: string;
}): Promise<0 | 1 | 4> {
  // Existing migration diagnostics use console.info. Reserve stdout exclusively
  // for the bootstrap result so a checked upgrade cannot corrupt this channel.
  const originalLog = console.log;
  const originalInfo = console.info;
  console.log = console.error;
  console.info = console.error;
  // A client may exit while startup is finishing. A broken bootstrap pipe must
  // not crash the detached owner or cancel work admitted by another client.
  const ignoreClosedPipe = () => undefined;
  process.stdout.on("error", ignoreClosedPipe);
  async function publish(result: z.infer<typeof HostBootstrapResultSchema>): Promise<void> {
    const fallback = `${JSON.stringify({ state: "failed", error: { code: "internal_error", message: "The CLI host could not initialize. Inspect its private logs before retrying." }, exitCode: 1 })}\n`;
    let message = fallback;
    const checked = HostBootstrapResultSchema.safeParse(result);
    if (checked.success) {
      try {
        const encoded = `${JSON.stringify(checked.data)}\n`;
        if (Buffer.byteLength(encoded) <= HOST_BOOTSTRAP_MAX_BYTES) message = encoded;
      } catch { /* Exception recovery data must never break the bounded result channel. */ }
    }
    await new Promise<void>(resolveResult => {
      const finished = () => { process.stdout.off("error", finished); resolveResult(); };
      process.stdout.once("error", finished);
      process.stdout.end(message, finished);
    });
  }
  let host: CliHost;
  try {
    const profileDir = options.profileDir ?? (await resolveProfile()).profileDir;
    host = await runHost({ ...options, profileDir });
  } catch (error) {
    const payload = error instanceof OwnerTransportError
      ? { code: error.code, message: error.message, ...(error.recovery ? { recovery: error.recovery } : {}) }
      : toErrorPayload(error).error;
    // AppError messages are trusted application text. Never serialize unknown
    // exceptions, stacks, provider replies, or arbitrary exception properties.
    const exitCode = error instanceof OwnerTransportError ? 4 : 1;
    await publish({ state: "failed", error: payload, exitCode });
    process.stdout.off("error", ignoreClosedPipe);
    console.log = originalLog;
    console.info = originalInfo;
    return exitCode;
  }
  await publish({ state: "ready" });
  try { await host.closed; return 0; }
  catch { return 1; }
  finally {
    process.stdout.off("error", ignoreClosedPipe);
    console.log = originalLog;
    console.info = originalInfo;
  }
}

/** The entry point waits on closed. Test runners can explicitly supply a synthetic factory. */
export async function runHost(options: {
  profileDir: string;
  version: string;
  idleTimeoutMs?: number;
  idlePollMs?: number;
  factory?: HostFactory;
  installSignalHandlers?: boolean;
}): Promise<CliHost> {
  const idleTimeoutMs = options.idleTimeoutMs ?? 10 * 60_000;
  const idlePollMs = options.idlePollMs ?? Math.min(10_000, idleTimeoutMs);
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0 || !Number.isFinite(idlePollMs) || idlePollMs <= 0) {
    throw new Error("Host idle intervals must be positive finite durations.");
  }
  const profile = await resolveProfile({ dataDir: options.profileDir });
  const lock = await acquireOwnerLock(profile.profileDir);
  if (!lock) throw new OwnerTransportError({ code: "OWNER_BUSY", message: "Another Scraply owner is starting or already owns this profile." }, 409);
  let application: HostApplication | undefined;
  let transport: OwnerTransport | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let shutdown: Promise<void> | undefined;
  let lastBusyAt = Date.now();
  let resolveClosed!: () => void;
  let rejectClosed!: (error: unknown) => void;
  const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
  // Keep a cleanup rejection handled even before the entry point receives the handle.
  void closed.catch(() => undefined);
  const listeners = new Set<(event: ResearchEvent) => void>();

  function cleanup(): Promise<void> {
    shutdown ??= (async () => {
      clearInterval(interval);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      // Gate admission first, then cancel backend work while accepted requests drain.
      // A pending model request may need stop() to settle; retain ownership through both.
      await Promise.all([transport?.close(), application?.stop()]);
      listeners.clear();
      await lock!.release();
    })();
    void shutdown.then(resolveClosed, error => {
      rejectClosed(error);
      if (options.installSignalHandlers !== false) {
        // If cleanup cannot confirm SQLite closed, exit with the mutex held.
        // Windows releases it on death and the next owner records interrupted work.
        process.stderr.write("Scraply host could not finish cleanup. Saved work will recover as interrupted.\n");
        setImmediate(() => process.exit(1));
      }
    });
    return shutdown;
  }

  function onSignal(): void {
    // Normal signals close the owner, with backend shutdown retaining interrupted work.
    void cleanup().catch(() => { process.exitCode = 1; });
  }

  try {
    application = await (options.factory ?? createHostApplication)(profile, options.version, event => {
      lastBusyAt = Date.now();
      for (const listener of listeners) listener(event);
    });
    await application.start();
    const app = application;
    transport = await startOwnerTransport({
      lock, kind: "cli", version: options.version,
      invoke: (channel, payload) => app.invoke(channel, payload),
      subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      async requestShutdown({ force }) {
        if (!await app.requestShutdown(force)) return false;
        // Let the HTTP stop response flush before transport cleanup closes connections.
        setImmediate(() => { void cleanup().catch(() => { process.exitCode = 1; }); });
        return true;
      },
    });
    const owner = transport;
    lastBusyAt = Date.now();
    let checkingIdle = false;
    interval = setInterval(() => {
      if (checkingIdle || shutdown) return;
      const activity = owner.activity;
      if (activity.inflight || activity.streams || app.hasActiveWork()) { lastBusyAt = Date.now(); return; }
      if (activity.stopping || Date.now() - Math.max(lastBusyAt, activity.lastActivityAt) < idleTimeoutMs) return;
      checkingIdle = true;
      void owner.requestStop(false)
        .catch(() => { /* A later idle tick can retry a refused stop without replaying work. */ })
        .finally(() => { checkingIdle = false; });
    }, idlePollMs);
    if (options.installSignalHandlers !== false) {
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
    }
    return {
      metadata: owner.metadata, closed,
      async stop(force = false) { return (await owner.requestStop(force)).stopped; },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
