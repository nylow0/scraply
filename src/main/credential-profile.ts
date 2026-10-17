import { mkdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { resolveCredentialStoreLocation } from "./credential-store";

/** Select the logical root before Chromium session storage or credentials are configured. */
export function selectDesktopProfile(
  app: Pick<Electron.App, "getPath" | "setPath" | "isPackaged">,
  environment: NodeJS.ProcessEnv,
  argv: string[],
) {
  let dataDir: string | undefined;
  let chromiumDir: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    const flag = argument.split("=", 1)[0];
    if (flag !== "--data-dir" && flag !== "--user-data-dir") continue;
    const value = argument === flag ? argv[++index] : argument.slice(flag.length + 1);
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a profile directory.`);
    if (flag === "--data-dir") dataDir = value;
    else chromiumDir = value;
  }
  // Explicit switches beat inherited environment so an isolated e2e/dev launch
  // cannot accidentally select another profile through SCRAPLY_DATA_DIR.
  const supplied = dataDir ?? chromiumDir ?? environment.SCRAPLY_DATA_DIR;
  if (supplied !== undefined && !supplied.trim()) throw new Error("The profile directory must not be empty.");
  const selected = supplied ?? app.getPath("userData");
  mkdirSync(resolve(selected), { recursive: true });
  const canonical = realpathSync.native(resolve(selected));
  const profileDir = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  app.setPath("userData", profileDir);
  // Keep the existing shared-credential dev policy for Chromium's old switch.
  return { profileDir, explicit: dataDir !== undefined || (chromiumDir === undefined && environment.SCRAPLY_DATA_DIR !== undefined) };
}

export function configureCredentialProfile(
  app: Pick<Electron.App, "getPath" | "setPath" | "isPackaged">,
  environment: NodeJS.ProcessEnv,
  options: { explicitProfile?: boolean } = {},
) {
  const projectProfile = app.getPath("userData");
  const { credentialsPath, sessionDataPath } = resolveCredentialStoreLocation({
    appData: app.getPath("appData"), userData: projectProfile,
    development: !app.isPackaged, e2e: environment.SCRAPLY_E2E === "1",
    isolatedDevelopment: options.explicitProfile === true || environment.SCRAPLY_DEV_SHARED_CREDENTIALS === "0",
  });
  if (sessionDataPath || options.explicitProfile) {
    // Electron 42 reads the DPAPI-protected key from sessionData/Local State before ready.
    // Keep userData unchanged so project storage and the single-instance lock stay separate.
    const encryptionProfile = sessionDataPath ?? projectProfile;
    mkdirSync(encryptionProfile, { recursive: true });
    app.setPath("sessionData", encryptionProfile);
  }
  return { projectProfile, credentialsPath };
}
