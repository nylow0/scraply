import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { writeFileAtomically } from "./atomic-file";
import { CliError } from "./output";

/**
 * The encrypted `secrets.bin` that holds search keys and model-account credentials, in the
 * format the desktop app wrote, so existing keys and sign-ins carry over. Saves merge field by
 * field under a cross-process lock and refuse to overwrite a value another process changed.
 */
const StoredSecretsSchema = z.object({
  exaApiKey: z.string().nullable().default(null),
  perplexityApiKey: z.string().nullable().default(null),
  providerCredentials: z.record(z.string()).default({}),
});
export type StoredSecrets = z.infer<typeof StoredSecretsSchema>;

export interface Encryption {
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
  throw new CliError("CREDENTIALS_BUSY", "Credential storage is busy. Try again.");
}

export function createCredentialStore(path: string, encryption: Encryption) {
  let baseline: StoredSecrets | undefined;
  let pendingSave: Promise<void> = Promise.resolve();
  function read(): StoredSecrets {
    if (!encryption.isEncryptionAvailable()) throw new CliError("CREDENTIALS_UNAVAILABLE", "Encrypted credential storage is unavailable on this machine.");
    if (!existsSync(path)) return StoredSecretsSchema.parse({});
    try {
      return StoredSecretsSchema.parse(JSON.parse(encryption.decryptString(readFileSync(path))));
    } catch {
      throw new CliError("CREDENTIALS_UNREADABLE", "Saved credentials could not be read. The encrypted file has been left untouched. Set EXA_API_KEY or PERPLEXITY_API_KEY instead.");
    }
  }

  return {
    load(): StoredSecrets {
      baseline = read();
      return structuredClone(baseline);
    },
    async save(next: StoredSecrets, beforeWrite?: () => void): Promise<StoredSecrets> {
      if (!baseline) throw new Error("Load credential storage before saving");
      const requestedBaseline = structuredClone(baseline);
      const candidate = StoredSecretsSchema.parse(next);
      const operation = pendingSave.then(async () => {
        if (!baseline) throw new Error("Load credential storage before saving");
        const previous = structuredClone(baseline);
        const local = structuredClone(previous);
        mkdirSync(dirname(path), { recursive: true });
        const unlock = await lockStore(path);
        try {
          beforeWrite?.();
          const current = read();
          let changed = false;
          const conflict = () => {
            throw new CliError("CREDENTIALS_CONFLICT", "Credentials changed in another Scraply process. Run the command again.");
          };
          for (const key of ["exaApiKey", "perplexityApiKey"] as const) {
            if (candidate[key] === requestedBaseline[key]) continue;
            if (current[key] !== requestedBaseline[key] && current[key] !== candidate[key]) conflict();
            current[key] = candidate[key];
            local[key] = candidate[key];
            changed = true;
          }
          for (const provider of new Set([...Object.keys(requestedBaseline.providerCredentials), ...Object.keys(candidate.providerCredentials)])) {
            const requestedValue = requestedBaseline.providerCredentials[provider];
            const nextValue = candidate.providerCredentials[provider];
            if (nextValue === requestedValue) continue;
            const currentValue = current.providerCredentials[provider];
            if (currentValue !== requestedValue && currentValue !== nextValue) conflict();
            if (nextValue === undefined) {
              delete current.providerCredentials[provider];
              delete local.providerCredentials[provider];
            } else {
              current.providerCredentials[provider] = nextValue;
              local.providerCredentials[provider] = nextValue;
            }
            changed = true;
          }
          if (changed) writeFileAtomically(path, encryption.encryptString(JSON.stringify(current)));
          // Retain every local change while leaving unrelated cross-process fields out
          // of the baseline, so stale callers cannot overwrite them later.
          baseline = local;
          return structuredClone(local);
        } finally {
          await unlock();
        }
      });
      pendingSave = operation.then(() => undefined, () => undefined);
      return operation;
    },
  };
}
