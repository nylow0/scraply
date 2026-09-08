import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

const RuntimeLockSchema = z.object({
  schemaVersion: z.literal(1),
  platform: z.literal("windows-x64"),
  executable: z.literal("scraply-agent.exe"),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  protocolVersions: z.array(z.literal("1.1")).min(1),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().positive().max(20 * 1024 * 1024),
}).passthrough();

export interface RuntimeLaunchConfig {
  executablePath: string;
  artifact: {
    version: string;
    sourceCommit: string;
    sha256: string;
  };
}

export function resolveRuntimeLaunch(options: {
  packaged: boolean;
  resourcesPath: string;
  environment?: NodeJS.ProcessEnv;
}): RuntimeLaunchConfig | undefined {
  const environment = options.environment ?? process.env;
  const runtimeDir = options.packaged ? join(options.resourcesPath, "runtime") : null;
  const executablePath = runtimeDir
    ? join(runtimeDir, "scraply-agent.exe")
    : environment.SCRAPLY_AGENT_PATH ? resolve(environment.SCRAPLY_AGENT_PATH) : null;
  const lockPath = runtimeDir
    ? join(runtimeDir, "scraply-agent.lock.json")
    : environment.SCRAPLY_AGENT_LOCK_PATH ? resolve(environment.SCRAPLY_AGENT_LOCK_PATH) : null;
  if (!executablePath && !lockPath) return undefined;
  if (!executablePath || !lockPath || !existsSync(executablePath) || !existsSync(lockPath)) {
    throw new Error("Native runtime executable and lock must both exist at the configured paths");
  }
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("This native runtime artifact requires Windows x64");
  const lock = RuntimeLockSchema.parse(JSON.parse(readFileSync(lockPath, "utf8")));
  return {
    executablePath,
    artifact: { version: lock.version, sourceCommit: lock.sourceCommit, sha256: lock.sha256 },
  };
}
