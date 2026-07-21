import { startBackend, type BackendContext } from "./server";
import { configurePromptPaths } from "../core/prompts";

interface UtilityMessage {
  type: "start";
  dataDir: string;
  dbPath: string;
  bundledPromptsDir: string;
  promptOverridesDir: string;
  opencodeApiKey: string | null;
  exaApiKey: string | null;
}

let secrets = { opencodeApiKey: null as string | null, exaApiKey: null as string | null };

process.parentPort?.on("message", async (event) => {
  const message = event.data as UtilityMessage;
  if (message.type !== "start") return;

  secrets = {
    opencodeApiKey: message.opencodeApiKey,
    exaApiKey: message.exaApiKey,
  };

  const context: BackendContext = {
    dataDir: message.dataDir,
    dbPath: message.dbPath,
    bundledPromptsDir: message.bundledPromptsDir,
    promptOverridesDir: message.promptOverridesDir,
    getSecrets: () => secrets,
  };

  configurePromptPaths({ bundledDir: context.bundledPromptsDir, overrideDir: context.promptOverridesDir });

  const handle = await startBackend(context, (researchEvent) => {
    process.parentPort?.postMessage({ type: "event", event: researchEvent });
  });

  process.parentPort?.postMessage({
    type: "ready",
    port: handle.port,
    token: handle.token,
  });

  process.parentPort?.on("message", (updateEvent) => {
    const update = updateEvent.data as { type: "update-secrets"; opencodeApiKey: string; exaApiKey: string };
    if (update.type === "update-secrets") {
      secrets = { opencodeApiKey: update.opencodeApiKey, exaApiKey: update.exaApiKey };
      handle.secretsChanged();
    }
  });
});
