import { BackendUtilityMessageSchema } from "../shared/ipc";
import { startBackend, type BackendContext } from "./server";

let secrets = { opencodeApiKey: null as string | null, exaApiKey: null as string | null };
let backendStarted = false;
let invalidateValidation: (() => void) | null = null;

function applySecrets(opencodeApiKey: string | null, exaApiKey: string | null): void {
  secrets = {
    opencodeApiKey: opencodeApiKey?.trim() || null,
    exaApiKey: exaApiKey?.trim() || null,
  };
  invalidateValidation?.();
}

process.parentPort?.on("message", async (event) => {
  const parsed = BackendUtilityMessageSchema.safeParse(event.data);
  if (!parsed.success) {
    process.parentPort?.postMessage({
      type: "error",
      message: "Invalid utility process message",
    });
    return;
  }
  const message = parsed.data;

  if (message.type === "update-secrets") {
    applySecrets(message.opencodeApiKey, message.exaApiKey);
    return;
  }

  if (backendStarted) return;
  backendStarted = true;

  try {
    applySecrets(message.opencodeApiKey, message.exaApiKey);

    const context: BackendContext = {
      dataDir: message.dataDir,
      dbPath: message.dbPath,
      getSecrets: () => secrets,
    };

    const handle = await startBackend(context, (researchEvent) => {
      process.parentPort?.postMessage({ type: "event", event: researchEvent });
    });
    invalidateValidation = handle.invalidateValidation;

    process.parentPort?.postMessage({
      type: "ready",
      port: handle.port,
      token: handle.token,
    });
  } catch (error) {
    process.parentPort?.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : "Backend failed to start",
    });
  }
});
