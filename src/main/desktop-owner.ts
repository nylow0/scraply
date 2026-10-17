import { setTimeout as delay } from "node:timers/promises";
import { acquireOwnerLock, readOwnerMetadata, type OwnerLock } from "../app/owner";
import { createOwnerClient, startOwnerTransport, type OwnerSubscription, type OwnerTransport } from "../app/owner-transport";
import { AppError } from "../shared/errors";
import { ResearchEventSchema, type ResearchEvent } from "../shared/ipc";
import { OwnerTransportError, ownerVersionError } from "../shared/owner-contracts";

export interface DesktopApplication {
  // interactive=false must use the service's validated, noninteractive invokeRemote.
  invoke(channel: string, payload: unknown, interactive: boolean): Promise<unknown>;
  stop(): Promise<void>;
  secretValues(): string[];
}

/** Only this factory may construct credentials or a backend, after the real lock is held. */
export function createDesktopOwner(options: {
  profileDir: string;
  version: string;
  createApplication(publish: (event: ResearchEvent) => void): Promise<DesktopApplication>;
  publishEvent(event: ResearchEvent): void;
  onDisconnect?(error: unknown): void;
  discoveryTimeoutMs?: number;
  retryDelayMs?: number;
}) {
  let closing = false;
  let application: DesktopApplication | undefined;
  let lock: OwnerLock | undefined;
  let transport: OwnerTransport | undefined;
  let client: ReturnType<typeof createOwnerClient> | undefined;
  let stream: OwnerSubscription | undefined;
  let connecting: Promise<void> | undefined;
  let shutdown: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  const listeners = new Set<(event: ResearchEvent) => void>();
  const abort = new AbortController();

  function publish(raw: ResearchEvent) {
    const event = ResearchEventSchema.parse(raw);
    options.publishEvent(event);
    for (const listener of listeners) listener(event);
  }

  function assertOpen() {
    if (closing) throw new AppError("backend_unavailable", "Scraply is closing.");
  }

  async function connect() {
    const deadline = Date.now() + (options.discoveryTimeoutMs ?? 15_000);
    let lastFailure: unknown;
    while (!closing && Date.now() < deadline) {
      const acquired = await acquireOwnerLock(options.profileDir);
      if (closing) { await acquired?.release(); return; }
      if (acquired) {
        lock = acquired;
        // No credential read, backend construction or recovery precedes this point.
        application = await options.createApplication(publish);
        const local = application;
        assertOpen();
        transport = await startOwnerTransport({
          lock: acquired, kind: "desktop", version: options.version,
          async invoke(channel, payload) {
            assertOpen();
            return track(local.invoke(channel, payload, false));
          },
          subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
          requestShutdown: () => false,
        });
        publish({ type: "app-state-changed" });
        return;
      }
      try {
        const metadata = await readOwnerMetadata(options.profileDir);
        if (metadata) {
          const attached = createOwnerClient(metadata, options.version, { timeoutMs: 2_000 });
          const health = await attached.health();
          assertOpen();
          if (health.version !== options.version) {
            if (health.kind !== "cli" || !(await attached.stop()).stopped) throw ownerVersionError(health, options.version);
            // A stop response is not ownership. Only the next successful pipe bind is.
          } else {
            let disconnected = false;
            const subscription = await attached.subscribe(publish, {
              signal: abort.signal,
              onDisconnect(error) {
                disconnected = true;
                if (closing || client !== attached) return;
                client = undefined;
                stream = undefined;
                options.onDisconnect?.(error);
                publish({ type: "app-state-changed" });
                // Let the initial handshake promise settle before reconnecting.
                setTimeout(() => {
                  if (!closing) void ensureConnected().catch(failure => options.onDisconnect?.(failure));
                }, 0);
              },
            });
            if (closing) { subscription.close(); return; }
            if (disconnected) { subscription.close(); continue; }
            client = attached;
            stream = subscription;
            publish({ type: "app-state-changed" });
            return;
          }
        }
      } catch (error) {
        if (error instanceof OwnerTransportError && error.code === "OWNER_VERSION_MISMATCH") throw error;
        lastFailure = error;
      }
      await delay(options.retryDelayMs ?? 100, undefined, { signal: abort.signal }).catch(() => undefined);
    }
    if (!closing) throw lastFailure ?? new OwnerTransportError({
      code: "OWNER_UNAVAILABLE", message: "Scraply's profile owner did not become available. Close it or retry the connection.",
    });
  }

  function track<T>(promise: Promise<T>): Promise<T> {
    pending.add(promise);
    void promise.finally(() => { pending.delete(promise); }).catch(() => undefined);
    return promise;
  }

  function ensureConnected(): Promise<void> {
    assertOpen();
    if (application || client) return Promise.resolve();
    if (!connecting) {
      connecting = connect().finally(() => { connecting = undefined; });
    }
    return connecting;
  }

  return {
    start: ensureConnected,
    get kind(): "desktop" | "remote" | "disconnected" { return application ? "desktop" : client ? "remote" : "disconnected"; },
    secretValues(): string[] { return application?.secretValues() ?? []; },
    async invoke(channel: string, payload?: unknown, interactive = true): Promise<unknown> {
      assertOpen();
      await ensureConnected();
      assertOpen();
      if (application) return track(application.invoke(channel, payload, interactive));
      if (!client) throw new AppError("backend_unavailable", "Scraply's profile owner disconnected. Retry after reconnection.");
      // Never replay a request, including one whose owner dies after admission.
      return track(client.invoke(channel, payload, { timeoutMs: null, signal: abort.signal }));
    },
    close(): Promise<void> {
      shutdown ??= (async () => {
        closing = true;
        abort.abort();
        stream?.close();
        client = undefined;
        await connecting?.catch(() => undefined);
        await transport?.close();
        await Promise.allSettled([...pending]);
        await application?.stop();
        listeners.clear();
        await lock?.release();
      })();
      return shutdown;
    },
  };
}
