import { dlopen, ptr, read, type Pointer } from "bun:ffi";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomically } from "./atomic-file";
import { createCredentialStore, type Encryption } from "./credential-store";
import { CliError } from "./output";

/**
 * Search keys and model-account credentials for the CLI, kept in `secrets.bin` in the Scraply
 * profile folder (`%APPDATA%\scraply`). The file uses Electron `safeStorage`'s Windows format, so
 * keys and sign-ins saved by the old desktop app keep working: "v10", a 12-byte nonce, AES-256-GCM
 * ciphertext, and a 16-byte tag, with the AES key DPAPI-wrapped in the profile's `Local State`.
 * `EXA_API_KEY` and `PERPLEXITY_API_KEY` override the saved search keys.
 */

export type SearchProvider = "exa" | "perplexity";

const LocalStateSchema = z.object({ os_crypt: z.object({ encrypted_key: z.string() }).passthrough() }).passthrough();
const DPAPI_PREFIX = "DPAPI";
const VERSION_PREFIX = "v10";

/** Run CryptProtectData or CryptUnprotectData for the current Windows user. */
function dpapi(operation: "CryptProtectData" | "CryptUnprotectData", data: Buffer): Buffer {
  const kernel = dlopen("kernel32.dll", { LocalFree: { args: ["ptr"], returns: "ptr" } });
  const crypt = dlopen("crypt32.dll", {
    CryptProtectData: { args: ["ptr", "ptr", "ptr", "ptr", "ptr", "u32", "ptr"], returns: "i32" },
    CryptUnprotectData: { args: ["ptr", "ptr", "ptr", "ptr", "ptr", "u32", "ptr"], returns: "i32" },
  });
  try {
    // Win64 DATA_BLOB: a DWORD length, four bytes of padding, then an eight-byte pointer.
    const input = Buffer.alloc(16);
    input.writeUInt32LE(data.length, 0);
    input.writeBigUInt64LE(BigInt(ptr(data)), 8);
    const output = Buffer.alloc(16);
    // CRYPTPROTECT_UI_FORBIDDEN: an unattended CLI must never open a prompt.
    if (!crypt.symbols[operation](input, null, null, null, null, 1, output)) throw new Error("DPAPI failed");
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

/** The profile's AES key, created with a new `Local State` when the profile has none yet. */
function profileKey(profileDir: string, create: boolean): Buffer | null {
  const statePath = join(profileDir, "Local State");
  if (existsSync(statePath)) {
    const wrapped = Buffer.from(LocalStateSchema.parse(JSON.parse(readFileSync(statePath, "utf8"))).os_crypt.encrypted_key, "base64");
    if (wrapped.subarray(0, DPAPI_PREFIX.length).toString() !== DPAPI_PREFIX) throw new Error("Unknown key format");
    return dpapi("CryptUnprotectData", wrapped.subarray(DPAPI_PREFIX.length));
  }
  if (!create) return null;
  const key = randomBytes(32);
  const wrapped = Buffer.concat([Buffer.from(DPAPI_PREFIX), dpapi("CryptProtectData", key)]);
  mkdirSync(profileDir, { recursive: true });
  writeFileAtomically(statePath, Buffer.from(JSON.stringify({ os_crypt: { encrypted_key: wrapped.toString("base64") } })));
  return key;
}

/** safeStorage-compatible encryption for one profile. The key is read once and kept for this process. */
function profileEncryption(profileDir: string): Encryption {
  let key: Buffer | null | undefined;
  const loadKey = (create: boolean) => {
    if (key === undefined || (key === null && create)) {
      try { key = profileKey(profileDir, create); }
      // Never attach the cause: crypto and JSON errors can contain secret material.
      catch { throw new CliError("CREDENTIALS_UNREADABLE", "The profile's encryption key could not be read. Set EXA_API_KEY or PERPLEXITY_API_KEY instead."); }
    }
    return key;
  };
  return {
    isEncryptionAvailable: () => process.platform === "win32",
    encryptString(value) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", loadKey(true)!, nonce);
      const sealed = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([Buffer.from(VERSION_PREFIX), nonce, sealed, cipher.getAuthTag()]);
    },
    decryptString(value) {
      const current = loadKey(false);
      if (!current || value.subarray(0, VERSION_PREFIX.length).toString() !== VERSION_PREFIX || value.length < 31) throw new Error("Unknown secrets format");
      const decipher = createDecipheriv("aes-256-gcm", current, value.subarray(3, 15));
      decipher.setAuthTag(value.subarray(-16));
      return Buffer.concat([decipher.update(value.subarray(15, -16)), decipher.final()]).toString("utf8");
    },
  };
}

export type SecretStore = ReturnType<typeof openSecrets>;

/** The profile's credential store. Saving merges with concurrent writers and never loses their changes. */
export function openSecrets(profileDir: string) {
  return createCredentialStore(join(profileDir, "secrets.bin"), profileEncryption(profileDir));
}

/** Resolve one provider's search key, or say exactly how to provide it. */
export function searchKey(provider: SearchProvider, profileDir: string, env: Record<string, string | undefined> = process.env): string {
  const fromEnv = (provider === "exa" ? env.EXA_API_KEY : env.PERPLEXITY_API_KEY)?.trim();
  if (fromEnv) return fromEnv;
  const saved = openSecrets(profileDir).load();
  const key = (provider === "exa" ? saved.exaApiKey : saved.perplexityApiKey)?.trim();
  if (!key) throw new CliError("NO_KEY", `No ${provider} key. Set ${provider === "exa" ? "EXA_API_KEY" : "PERPLEXITY_API_KEY"} or run: scraply key set ${provider}`);
  return key;
}

/** Which providers have a key, without exposing any of them. */
export function availableProviders(profileDir: string, env: Record<string, string | undefined> = process.env): SearchProvider[] {
  return (["exa", "perplexity"] as const).filter(provider => {
    try { return Boolean(searchKey(provider, profileDir, env)); } catch { return false; }
  });
}
