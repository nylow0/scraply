import { mkdirSync } from "node:fs";
import { resolveCredentialStoreLocation } from "./credential-store";

export function configureCredentialProfile(
  app: Pick<Electron.App, "getPath" | "setPath" | "isPackaged">,
  environment: NodeJS.ProcessEnv,
) {
  const projectProfile = app.getPath("userData");
  const { credentialsPath, sessionDataPath } = resolveCredentialStoreLocation({
    appData: app.getPath("appData"), userData: projectProfile,
    development: !app.isPackaged, e2e: environment.SCRAPLY_E2E === "1",
    isolatedDevelopment: environment.SCRAPLY_DEV_SHARED_CREDENTIALS === "0",
  });
  if (sessionDataPath) {
    // Electron 42 reads the DPAPI-protected key from sessionData/Local State before ready.
    // Keep userData unchanged so project storage and the single-instance lock stay separate.
    mkdirSync(sessionDataPath, { recursive: true });
    app.setPath("sessionData", sessionDataPath);
  }
  return { projectProfile, credentialsPath };
}
