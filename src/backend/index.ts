import { startBackend, type BackendContext, type BackendHandle } from "./server";
import { configurePromptPaths } from "../core/prompts";
import { MainToBackendMessageSchema, type BackendSecrets, type BackendToMainMessage } from "../shared/backend-process";
import { RuntimeClient } from "../providers/runtime";
import { randomUUID } from "node:crypto";
import { createNativeRuntimeStartup } from "./native-runtime-startup";

let secrets: BackendSecrets = { exaApiKey: null, perplexityApiKey: null, providerCredentials: {} };
let handle: BackendHandle | null = null;
let starting = false;
const pendingCredentialWrites = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

function post(message: BackendToMainMessage): void {
  process.parentPort?.postMessage(message);
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The local backend failed to start.";
}

function serializeError(error: unknown) {
  if (!(error instanceof Error)) return undefined;
  return {
    name: error.name,
    message: error.message,
    ...(error.stack ? { stack: error.stack } : {}),
  };
}

function postProcessError(event: string, error: unknown): void {
  const serialized = serializeError(error);
  post({
    type: "log",
    level: "error",
    event,
    message: failureMessage(error),
    ...(serialized ? { error: serialized } : {}),
  });
}

process.on("uncaughtExceptionMonitor", (error) => postProcessError("backend-uncaught-exception", error));
process.on("unhandledRejection", (error) => postProcessError("backend-unhandled-rejection", error));

process.parentPort?.on("message", async (event) => {
  const parsed = MainToBackendMessageSchema.safeParse(event.data);
  if (!parsed.success) return;
  const message = parsed.data;

  if (message.type === "provider-credential-persisted") {
    const pending = pendingCredentialWrites.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingCredentialWrites.delete(message.requestId);
    if (message.ok) pending.resolve();
    else pending.reject(new Error(message.error ?? "Credential persistence failed"));
    return;
  }

  if (message.type === "update-secrets") {
    if (!handle) return;
    secrets = message.secrets;
    handle.secretsChanged();
    post({ type: "secrets-updated", requestId: message.requestId });
    return;
  }

  if (handle || starting) return;
  starting = true;
  secrets = message.secrets;
  const nativeRuntime = message.runtime ? new RuntimeClient({
    ...message.runtime,
    appVersion: message.appVersion,
  }) : undefined;
  const nativeStartup = nativeRuntime ? createNativeRuntimeStartup(
    nativeRuntime,
    () => secrets.providerCredentials,
    (providerId, error) => postProcessError(`native-runtime-credential-restore-failed:${providerId}`, error),
  ) : undefined;
  const persistProviderCredential = async (providerId: string, credential: string): Promise<void> => {
    const requestId = randomUUID();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingCredentialWrites.delete(requestId);
        reject(new Error("Main process did not acknowledge encrypted credential persistence"));
      }, 10_000);
      pendingCredentialWrites.set(requestId, { resolve, reject, timer });
      post({ type: "persist-provider-credential", requestId, providerId, credential });
    });
    secrets = { ...secrets, providerCredentials: { ...secrets.providerCredentials, [providerId]: credential } };
  };
  const forgetProviderCredential = (providerId: string) => {
    const { [providerId]: _removed, ...providerCredentials } = secrets.providerCredentials;
    secrets = { ...secrets, providerCredentials };
  };
  const context: BackendContext = {
    dataDir: message.dataDir,
    dbPath: message.dbPath,
    bundledPromptsDir: message.bundledPromptsDir,
    promptOverridesDir: message.promptOverridesDir,
    appVersion: message.appVersion,
    getSecrets: () => secrets,
    ...(message.runtimeError ? { nativeRuntimeError: message.runtimeError } : {}),
    ...(nativeRuntime ? {
      nativeRuntime,
      nativeRuntimeStatus: nativeStartup!.status,
      prepareNativeRuntime: nativeStartup!.prepare,
      modelClients: { "openai-subscription": nativeRuntime, openrouter: nativeRuntime },
      persistProviderCredential,
      forgetProviderCredential,
    } : {}),
    log: (input) => {
      const error = serializeError(input.error);
      post({
        type: "log",
        level: input.level,
        event: input.event,
        ...(input.message ? { message: input.message } : {}),
        ...(input.context ? { context: input.context } : {}),
        ...(error ? { error } : {}),
      });
    },
  };

  try {
    configurePromptPaths({ bundledDir: context.bundledPromptsDir, overrideDir: context.promptOverridesDir });
    handle = await startBackend(context, (researchEvent) => {
      post({ type: "event", event: researchEvent });
    });
    post({ type: "ready", port: handle.port, token: handle.token });
    if (nativeRuntime) {
      void nativeStartup!.prepare()
        .catch((error) => postProcessError("native-runtime-startup-failed", error))
        .finally(() => handle?.providersChanged());
    }
  } catch (error) {
    post({ type: "startup-failed", message: failureMessage(error) });
    setImmediate(() => process.exit(1));
  } finally {
    starting = false;
  }
});
