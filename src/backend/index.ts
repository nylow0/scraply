import { startBackend, type BackendContext, type BackendHandle } from "./server";
import { configurePromptPaths } from "../core/prompts";
import { MainToBackendMessageSchema, type BackendSecrets, type BackendToMainMessage } from "../shared/backend-process";

let secrets: BackendSecrets = { exaApiKey: null, perplexityApiKey: null };
let handle: BackendHandle | null = null;

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

  if (message.type === "update-secrets") {
    if (!handle) return;
    secrets = message.secrets;
    handle.secretsChanged();
    post({ type: "secrets-updated", requestId: message.requestId });
    return;
  }

  if (handle) return;
  secrets = message.secrets;
  const context: BackendContext = {
    dataDir: message.dataDir,
    dbPath: message.dbPath,
    bundledPromptsDir: message.bundledPromptsDir,
    promptOverridesDir: message.promptOverridesDir,
    appVersion: message.appVersion,
    getSecrets: () => secrets,
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
  } catch (error) {
    post({ type: "startup-failed", message: failureMessage(error) });
    setImmediate(() => process.exit(1));
  }
});
