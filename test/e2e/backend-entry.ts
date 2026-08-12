import { startBackend, type BackendContext, type BackendHandle } from "../../src/backend/server";
import { configurePromptPaths } from "../../src/core/prompts";
import { MainToBackendMessageSchema, type BackendSecrets, type BackendToMainMessage } from "../../src/shared/backend-process";

let secrets: BackendSecrets = { exaApiKey: null };
let handle: BackendHandle | null = null;

function post(message: BackendToMainMessage): void {
  process.parentPort?.postMessage(message);
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The E2E backend failed to start.";
}

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
    providerValidation: {
      probeCodex: async () => ({ detected: true, compatible: true, version: "codex-e2e" }),
      listCodexModels: async () => [{ id: "gpt-5.6-luna", displayName: "GPT-5.6-Luna", defaultReasoningEffort: "medium", reasoningEfforts: [{ id: "medium", description: "Balanced reasoning" }] }],
      validateExa: async (apiKey) => apiKey === "invalid-e2e-key"
        ? { valid: false, error: "Deterministic invalid Exa key" }
        : { valid: true },
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
