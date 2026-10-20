import { startBackend, type BackendHandle } from "../backend/server";
import { createNativeRuntimeStartup } from "../backend/native-runtime-startup";
import { configurePromptPaths } from "../core/prompts";
import { RuntimeClient, type RuntimeClientOptions } from "../providers/runtime";
import type { BackendSecrets } from "../shared/backend-process";
import { AppError } from "../shared/errors";
import { ActivitySchema } from "../shared/cli-contracts";
import type { LogInput } from "../shared/logging";
import type { AppBackend, AppBackendStart } from "./service-contracts";
import { requestBackend } from "./backend-request";

export interface InProcessBackend extends AppBackend {
  hasActiveWork(): boolean;
  requestShutdown(force: boolean): Promise<boolean>;
}

/** Same backend and credential acknowledgments as the utility process, without Electron. */
export function createInProcessBackend(options: {
  runtime: RuntimeClientOptions;
  log?: (input: Omit<LogInput, "component">) => void;
}): InProcessBackend {
  let handle: BackendHandle | null = null;
  let runtime: RuntimeClient | null = null;
  let secrets: BackendSecrets = { exaApiKey: null, perplexityApiKey: null, providerCredentials: {} };
  let starting: Promise<void> | null = null;
  let stopping: Promise<void> | null = null;
  let credentialTail = Promise.resolve();
  let preparing = Promise.resolve();

  async function launch(input: AppBackendStart): Promise<void> {
    secrets = structuredClone(input.secrets);
    runtime = new RuntimeClient(options.runtime);
    const nativeStartup = createNativeRuntimeStartup(runtime, () => secrets.providerCredentials,
      (_providerId, error) => options.log?.({ level: "error", event: "native-runtime-credential-restore-failed", error }));
    const persistProviderCredential = (providerId: string, credential: string): Promise<void> => {
      const operation = credentialTail.then(async () => {
        // The service checks revocation again immediately before the encrypted write.
        await input.persistProviderCredential(providerId, credential);
        secrets = { ...secrets, providerCredentials: { ...secrets.providerCredentials, [providerId]: credential } };
      });
      credentialTail = operation.catch(() => undefined);
      return operation;
    };
    configurePromptPaths({ bundledDir: input.paths.bundledPromptsDir, overrideDir: input.paths.promptOverridesDir });
    try {
      handle = await startBackend({
        ...input.paths,
        appVersion: input.appVersion,
        validateAutomaticSecrets: input.validateAutomaticSecrets ?? false,
        getSecrets: () => secrets,
        nativeRuntime: runtime,
        nativeRuntimeStatus: nativeStartup.status,
        prepareNativeRuntime: nativeStartup.prepare,
        modelClients: { "openai-subscription": runtime },
        persistProviderCredential,
        forgetProviderCredential(providerId) {
          const providerCredentials = { ...secrets.providerCredentials };
          delete providerCredentials[providerId];
          secrets = { ...secrets, providerCredentials };
        },
        ...(options.log ? { log: options.log } : {}),
      }, input.publishEvent);
      preparing = nativeStartup.prepare()
        .catch((error: unknown) => options.log?.({ level: "error", event: "native-runtime-startup-failed", error }))
        .finally(() => handle?.providersChanged());
    } catch (error) {
      await runtime.close();
      runtime = null;
      throw error;
    }
  }

  async function request(path: string, init?: RequestInit): Promise<unknown> {
    if (!handle) throw new AppError("backend_unavailable");
    return requestBackend(handle, path, init);
  }

  return {
    async start(input) {
      if (stopping) await stopping;
      if (handle) return;
      starting ??= launch(input).finally(() => { starting = null; });
      return starting;
    },
    isReady: () => handle !== null && stopping === null,
    request,
    async updateSecrets(next, onlyWhenIdle = false) {
      if (!handle || stopping) throw new AppError("backend_unavailable");
      if (onlyWhenIdle && !handle.beginSearchKeyUpdate()) {
        throw new AppError("conflict", "Search keys can't change while research is running. Wait for it to finish or cancel it, then try again.");
      }
      secrets = structuredClone(next);
      handle.secretsChanged();
    },
    async finishSearchKeyUpdate(previous) {
      if (!handle || stopping) throw new AppError("backend_unavailable");
      if (handle.finishSearchKeyUpdate() && previous) {
        secrets = structuredClone(previous);
        handle.secretsChanged();
      }
    },
    hasActiveWork: () => Boolean(starting || handle?.hasActiveWork()),
    async requestShutdown(force) {
      if (!handle) return !starting;
      if (!force) return !handle.hasActiveWork();
      const activity = ActivitySchema.parse(await request("/app/stop-all", { method: "POST", body: "{}" }));
      return !activity.active;
    },
    stop() {
      stopping ??= (async () => {
        await starting?.catch(() => undefined);
        try {
          await preparing;
          if (handle) await handle.close();
          else await runtime?.close();
        } finally {
          // Keep encryption alive until every acknowledged credential write has settled.
          await credentialTail;
          handle = null;
          runtime = null;
        }
      })().then(() => {
        // RETRY_CONNECTION stops and starts this same adapter. A failed close stays
        // rejected instead of allowing another database to open after uncertain cleanup.
        stopping = null;
      });
      return stopping;
    },
  };
}
