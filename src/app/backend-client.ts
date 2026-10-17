import { randomUUID } from "node:crypto";
import { BackendReadySchema, type BackendReady } from "../shared/ipc";
import { AppError } from "../shared/errors";
import type { BackendSecrets } from "../shared/backend-process";
import type { AppBackend, AppBackendStart, BackendClientOptions } from "./service-contracts";
import { requestBackend } from "./backend-request";

/** HTTP and acknowledged secret updates shared by message-based backend hosts. */
export function createBackendClient(options: BackendClientOptions): AppBackend {
  let ready: BackendReady | null = null;
  let starting: Promise<void> | null = null;
  let stopping: Promise<void> | null = null;
  let startupFailure: string | null = null;
  let generation = 0;
  const pendingUpdates = new Map<string, {
    resolve(): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  function unavailable(message: string): void {
    ready = null;
    startupFailure = message;
    for (const pending of pendingUpdates.values()) {
      clearTimeout(pending.timer);
      pending.reject(new AppError("backend_unavailable", message));
    }
    pendingUpdates.clear();
  }

  function secretsUpdated(requestId: string, error?: string): void {
    const pending = pendingUpdates.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingUpdates.delete(requestId);
    if (error) pending.reject(new AppError("conflict", error));
    else pending.resolve();
  }

  async function acknowledgedUpdate(
    message: { type: "update-secrets"; secrets: BackendSecrets; onlyWhenIdle: boolean }
      | { type: "finish-search-key-update"; secrets?: BackendSecrets },
    timeoutMessage: string,
  ): Promise<void> {
    if (!ready || !options.hasProcess()) {
      if (message.type === "update-secrets" && options.externalSecretsNoop && !options.hasProcess()) return;
      throw new AppError("backend_unavailable", startupFailure ?? "The local backend is unavailable.");
    }
    const requestId = randomUUID();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingUpdates.delete(requestId);
        reject(new AppError("backend_unavailable", timeoutMessage));
      }, 5_000);
      pendingUpdates.set(requestId, { resolve, reject, timer });
      try { options.postMessage({ ...message, requestId }); }
      catch (error) {
        clearTimeout(timer);
        pendingUpdates.delete(requestId);
        reject(error);
      }
    });
  }

  return {
    async start(input: AppBackendStart): Promise<void> {
      if (ready) return;
      if (!starting) {
        const currentGeneration = ++generation;
        // A failed launch or process error can leave a handle alive. Close it before
        // another backend opens SQLite, and ignore its later exit notification.
        let failed = false;
        const hooks = {
          secretsUpdated,
          unavailable(message: string) {
            if (currentGeneration === generation) {
              failed = true;
              unavailable(message);
            }
          },
        };
        starting = Promise.resolve().then(async () => {
          if (stopping) await stopping;
          if (options.hasProcess()) await options.stop();
          if (currentGeneration !== generation) throw new AppError("backend_unavailable");
          return options.launch(input, hooks);
        })
          .then((value) => {
            if (currentGeneration !== generation || failed) throw new AppError("backend_unavailable", startupFailure ?? undefined);
            ready = BackendReadySchema.parse(value);
            startupFailure = null;
          })
          .catch((error: unknown) => {
            if (currentGeneration === generation) {
              unavailable(error instanceof Error ? error.message : "The local backend failed to start.");
            }
            throw error;
          })
          .finally(() => {
            if (currentGeneration === generation) starting = null;
          });
      }
      return starting;
    },
    isReady: () => ready !== null,
    async request(path, init) {
      if (!ready) throw new AppError("backend_unavailable", startupFailure ?? "The local backend is unavailable.");
      // The external e2e fixture has no native process to retry, matching the desktop seam.
      if (options.externalSecretsNoop && !options.hasProcess() && path === "/native/retry") return undefined;
      return requestBackend(ready, path, init);
    },
    updateSecrets(secrets, onlyWhenIdle = false) {
      return acknowledgedUpdate({ type: "update-secrets", secrets, onlyWhenIdle },
        "The local backend did not acknowledge the credential update.");
    },
    finishSearchKeyUpdate(previousSecrets) {
      return acknowledgedUpdate({ type: "finish-search-key-update", ...(previousSecrets ? { secrets: previousSecrets } : {}) },
        "The local backend did not finish the search key update.");
    },
    stop() {
      generation += 1;
      starting = null;
      unavailable("The local backend stopped.");
      stopping ??= Promise.resolve().then(() => options.stop()).finally(() => { stopping = null; });
      return stopping;
    },
  };
}
