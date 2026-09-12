import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { BackendSecrets } from "../shared/backend-process";
import { AppError } from "../shared/errors";
import { writeFileAtomically } from "./atomic-file";

const StoredSecretsSchema = z.object({
  exaApiKey: z.string().nullable().default(null),
  perplexityApiKey: z.string().nullable().default(null),
  providerCredentials: z.record(z.string()).default({}),
});

export function credentialStorePath(options: {
  appData: string; userData: string; development: boolean; e2e: boolean; isolatedDevelopment: boolean;
}): string {
  // Keep the installed file and format. Explicit test profiles never share real credentials.
  const directory = options.development && !options.e2e && !options.isolatedDevelopment
    ? join(options.appData, "scraply") : options.userData;
  return join(directory, "secrets.bin");
}

interface Encryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

// Binding owns the mutex. Windows releases named pipes even if the process crashes;
// no credentials travel through the pipe and no stale lock file needs deleting.
async function lockStore(path: string): Promise<() => Promise<void>> {
  const normalized = process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  const id = createHash("sha256").update(normalized).digest("hex").slice(0, 32);
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\scraply-credentials-${id}`
    : process.platform === "linux" ? `\0scraply-credentials-${id}` : join(tmpdir(), `scraply-${id}.sock`);
  for (let attempt = 0; attempt < 100; attempt++) {
    const server = createServer(socket => socket.destroy());
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ path: endpoint, exclusive: true }, resolve);
      });
      return () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EADDRINUSE") throw error;
      await delay(20);
    }
  }
  throw new AppError("internal_error", "Credential storage is busy. Try again.");
}

export function createCredentialStore(path: string, encryption: Encryption) {
  let baseline: BackendSecrets | undefined;
  function read(): BackendSecrets {
    if (!encryption.isEncryptionAvailable()) throw new AppError("secure_storage_unavailable");
    if (!existsSync(path)) return StoredSecretsSchema.parse({});
    try {
      return StoredSecretsSchema.parse(JSON.parse(encryption.decryptString(readFileSync(path))));
    } catch {
      throw new AppError("internal_error", "Saved credentials could not be read. The encrypted file has been left untouched.");
    }
  }

  return {
    load(): BackendSecrets {
      baseline = read();
      return structuredClone(baseline);
    },
    async save(next: BackendSecrets, beforeWrite?: () => void): Promise<void> {
      if (!baseline) throw new Error("Load credential storage before saving");
      const previous = structuredClone(baseline);
      const candidate = StoredSecretsSchema.parse(next);
      mkdirSync(dirname(path), { recursive: true });
      const unlock = await lockStore(path);
      try {
        beforeWrite?.();
        const current = read();
        let changed = false;
        const conflict = () => {
          throw new AppError("internal_error", "Credentials changed in another Scraply instance. Restart this instance before changing the account or keys.");
        };
        for (const key of ["exaApiKey", "perplexityApiKey"] as const) {
          if (candidate[key] === previous[key]) continue;
          if (current[key] !== previous[key] && current[key] !== candidate[key]) conflict();
          current[key] = candidate[key];
          changed = true;
        }
        for (const provider of new Set([...Object.keys(previous.providerCredentials), ...Object.keys(candidate.providerCredentials)])) {
          const oldValue = previous.providerCredentials[provider];
          const nextValue = candidate.providerCredentials[provider];
          if (nextValue === oldValue) continue;
          const currentValue = current.providerCredentials[provider];
          if (currentValue !== oldValue && currentValue !== nextValue) conflict();
          if (nextValue === undefined) delete current.providerCredentials[provider];
          else current.providerCredentials[provider] = nextValue;
          changed = true;
        }
        if (changed) writeFileAtomically(path, encryption.encryptString(JSON.stringify(current)));
        // Keep this instance's view, so a later save doesn't undo fields merged from another instance.
        baseline = candidate;
      } finally {
        await unlock();
      }
    },
  };
}
