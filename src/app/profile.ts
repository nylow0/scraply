import { dirname, join, resolve } from "node:path";
import { canonicalizeDataDir } from "./owner";
import type { AppServicePaths } from "./service-contracts";

export interface AppProfile extends AppServicePaths {
  profileDir: string;
  credentialsPath: string;
  localStatePath: string;
}

// Bun embeds source modules at this virtual root in compiled executables.
export const sourceCli = !/^(?:[A-Za-z]:)?[\\/]\$bunfs[\\/]|^[A-Za-z]:[\\/]~BUN[\\/]/i.test(import.meta.dir);

/** The profile owns credentials and the lock; dataDir preserves the installed desktop's nested data. */
export async function resolveProfile(options: {
  dataDir?: string;
  environment?: NodeJS.ProcessEnv;
  assetRoot?: string;
} = {}): Promise<AppProfile> {
  const environment = options.environment ?? process.env;
  const explicit = options.dataDir ?? environment.SCRAPLY_DATA_DIR;
  if (explicit !== undefined && !explicit.trim()) throw new Error("The profile directory must not be empty.");
  if (!explicit && !environment.APPDATA) throw new Error("APPDATA is unavailable. Supply --data-dir explicitly.");
  const profileDir = await canonicalizeDataDir(explicit ?? join(environment.APPDATA!, "scraply"));
  const dataDir = join(profileDir, "scraply");
  const assetRoot = options.assetRoot ?? (sourceCli ? resolve(import.meta.dir, "../..") : dirname(process.execPath));
  return {
    profileDir,
    dataDir,
    dbPath: join(dataDir, "scraply.db"),
    logsDir: join(dataDir, "logs"),
    bundledPromptsDir: join(assetRoot, "prompts"),
    promptOverridesDir: join(dataDir, "prompts"),
    credentialsPath: join(profileDir, "secrets.bin"),
    localStatePath: join(profileDir, "Local State"),
  };
}
