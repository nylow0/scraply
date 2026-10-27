import { dlopen, ptr, read, type Pointer } from "bun:ffi";
import { createDecipheriv } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CliError } from "./output";

/**
 * Search keys for the CLI. `EXA_API_KEY` and `PERPLEXITY_API_KEY` win; otherwise the keys saved
 * by the desktop app are decrypted read-only from `secrets.bin` in its profile folder. That file
 * is Electron `safeStorage` output: "v10", a 12-byte nonce, AES-256-GCM ciphertext, and a 16-byte
 * tag, with the AES key DPAPI-wrapped in the profile's `Local State`. Nothing is ever written.
 */

export type SearchProvider = "exa" | "perplexity";

const SecretsSchema = z.object({ exaApiKey: z.string().nullish(), perplexityApiKey: z.string().nullish() }).passthrough();
const LocalStateSchema = z.object({ os_crypt: z.object({ encrypted_key: z.string() }).passthrough() }).passthrough();

function dpapiUnprotect(data: Buffer): Buffer {
  const kernel = dlopen("kernel32.dll", { LocalFree: { args: ["ptr"], returns: "ptr" } });
  const crypt = dlopen("crypt32.dll", {
    CryptUnprotectData: { args: ["ptr", "ptr", "ptr", "ptr", "ptr", "u32", "ptr"], returns: "i32" },
  });
  try {
    // Win64 DATA_BLOB: a DWORD length, four bytes of padding, then an eight-byte pointer.
    const input = Buffer.alloc(16);
    input.writeUInt32LE(data.length, 0);
    input.writeBigUInt64LE(BigInt(ptr(data)), 8);
    const output = Buffer.alloc(16);
    // CRYPTPROTECT_UI_FORBIDDEN: an unattended CLI must never open a prompt.
    if (!crypt.symbols.CryptUnprotectData(input, null, null, null, null, 1, output)) throw new Error("DPAPI failed");
    const address = Number(output.readBigUInt64LE(8)) as Pointer;
    try {
      const length = output.readUInt32LE(0);
      if (!address || length === 0 || length > 1024 * 1024) throw new Error("Invalid DPAPI output");
      // Copy byte by byte; an external Buffer over memory freed below would outlive it.
      const copy = Buffer.alloc(length);
      for (let index = 0; index < length; index++) copy[index] = read.u8(address, index);
      return copy;
    } finally {
      if (address) kernel.symbols.LocalFree(address);
    }
  } finally {
    crypt.close();
    kernel.close();
  }
}

function readSavedKeys(profileDir: string) {
  const secretsPath = join(profileDir, "secrets.bin");
  if (process.platform !== "win32" || !existsSync(secretsPath)) return {};
  try {
    const state = LocalStateSchema.parse(JSON.parse(readFileSync(join(profileDir, "Local State"), "utf8")));
    const wrapped = Buffer.from(state.os_crypt.encrypted_key, "base64");
    if (wrapped.subarray(0, 5).toString() !== "DPAPI") throw new Error("Unknown key format");
    const key = dpapiUnprotect(wrapped.subarray(5));
    try {
      const sealed = readFileSync(secretsPath);
      if (sealed.subarray(0, 3).toString() !== "v10" || sealed.length < 31) throw new Error("Unknown secrets format");
      const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(3, 15));
      decipher.setAuthTag(sealed.subarray(-16));
      const plain = Buffer.concat([decipher.update(sealed.subarray(15, -16)), decipher.final()]);
      return SecretsSchema.parse(JSON.parse(plain.toString("utf8")));
    } finally {
      key.fill(0);
    }
  } catch {
    // Never attach the cause: crypto and JSON errors can contain secret material.
    throw new CliError("CREDENTIALS_UNREADABLE", "The saved search keys could not be read. Set EXA_API_KEY or PERPLEXITY_API_KEY instead.");
  }
}

/** Resolve one provider's key, or say exactly how to provide it. */
export function searchKey(provider: SearchProvider, profileDir: string, env: Record<string, string | undefined> = process.env): string {
  const fromEnv = (provider === "exa" ? env.EXA_API_KEY : env.PERPLEXITY_API_KEY)?.trim();
  if (fromEnv) return fromEnv;
  const saved = readSavedKeys(profileDir);
  const key = (provider === "exa" ? saved.exaApiKey : saved.perplexityApiKey)?.trim();
  if (!key) throw new CliError("NO_KEY", `No ${provider} key. Set ${provider === "exa" ? "EXA_API_KEY" : "PERPLEXITY_API_KEY"} or save one in the Scraply app.`);
  return key;
}

/** Which providers have a key, without exposing any of them. */
export function availableProviders(profileDir: string, env: Record<string, string | undefined> = process.env): SearchProvider[] {
  return (["exa", "perplexity"] as const).filter(provider => {
    try { return Boolean(searchKey(provider, profileDir, env)); } catch { return false; }
  });
}
