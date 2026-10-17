import { dlopen, ptr, read, type Pointer } from "bun:ffi";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { writePrivateFileAtomically } from "../app/private-file";
import { AppError } from "../shared/errors";

const LocalState = z.object({
  os_crypt: z.object({ encrypted_key: z.string().optional() }).passthrough().optional(),
}).passthrough();
const keyPrefix = Buffer.from("DPAPI");
const stringPrefix = Buffer.from("v10");
const unavailableMessage = "Windows credential encryption could not be initialized. Saved credentials and Local State have been left untouched.";

// Win64 DATA_BLOB is a DWORD length, four padding bytes, and an eight-byte pointer.
// Keep the DLLs open only while loading or creating the profile's AES key.
function loadKey(profileDirectory: string) {
  const kernel = dlopen("kernel32.dll", { LocalFree: { args: ["ptr"], returns: "ptr" } });
  try {
    const crypt = dlopen("crypt32.dll", {
      CryptProtectData: { args: ["ptr", "ptr", "ptr", "ptr", "ptr", "u32", "ptr"], returns: "i32" },
      CryptUnprotectData: { args: ["ptr", "ptr", "ptr", "ptr", "ptr", "u32", "ptr"], returns: "i32" },
    });
    try {
      function dpapi(data: Buffer, protect: boolean) {
        const input = Buffer.alloc(16);
        input.writeUInt32LE(data.length, 0);
        input.writeBigUInt64LE(BigInt(ptr(data)), 8);
        const output = Buffer.alloc(16);
        const operation = protect ? crypt.symbols.CryptProtectData : crypt.symbols.CryptUnprotectData;
        // CRYPTPROTECT_UI_FORBIDDEN prevents an unattended CLI from opening a prompt.
        if (!operation(input, null, null, null, null, 1, output)) throw new Error("DPAPI failed");
        const address = Number(output.readBigUInt64LE(8)) as Pointer;
        try {
          const length = output.readUInt32LE(0);
          if (!address || length === 0 || length > 1024 * 1024) throw new Error("Invalid DPAPI output");
          // Do not expose the soon-freed allocation as an external Buffer. That
          // crashes compiled Bun 1.3.13 during later asynchronous named-pipe I/O.
          const copy = Buffer.alloc(length);
          for (let index = 0; index < length; index++) copy[index] = read.u8(address, index);
          return copy;
        } finally {
          if (address) kernel.symbols.LocalFree(address);
        }
      }

      const statePath = join(profileDirectory, "Local State");
      const state = existsSync(statePath)
        ? LocalState.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(statePath))))
        : LocalState.parse({});
      const encoded = state.os_crypt?.encrypted_key;
      let key: Buffer;
      if (encoded !== undefined) {
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error("Invalid key encoding");
        const wrapped = Buffer.from(encoded, "base64");
        if (wrapped.toString("base64") !== encoded || wrapped.length <= keyPrefix.length || !wrapped.subarray(0, 5).equals(keyPrefix)) {
          throw new Error("Invalid key format");
        }
        key = dpapi(wrapped.subarray(5), false);
        if (key.length !== 32) {
          key.fill(0);
          throw new Error("Invalid key length");
        }
      } else {
        // A missing key must never turn an existing encrypted store into a new vault.
        if (existsSync(join(profileDirectory, "secrets.bin"))) throw new Error("Saved credentials have no key");
        key = randomBytes(32);
        try {
          const encrypted_key = Buffer.concat([keyPrefix, dpapi(key, true)]).toString("base64");
          state.os_crypt = { ...state.os_crypt, encrypted_key };
          mkdirSync(profileDirectory, { recursive: true });
          writePrivateFileAtomically(statePath, Buffer.from(JSON.stringify(state)));
        } catch (error) {
          key.fill(0);
          throw error;
        }
      }
      return key;
    } finally { crypt.close(); }
  } finally { kernel.close(); }
}

/** Call only after exclusive profile ownership and the legacy-desktop check. */
export function createWindowsEncryption(profileDirectory: string) {
  let key: Buffer;
  try {
    if (process.platform !== "win32" || process.arch !== "x64" || !profileDirectory || profileDirectory.includes("\0")) throw new Error("Unsupported profile");
    key = loadKey(resolve(profileDirectory));
  } catch {
    // Do not attach the original exception: JSON, crypto, and I/O errors can contain data.
    throw new AppError("secure_storage_unavailable", unavailableMessage);
  }
  let disposed = false;
  return {
    isEncryptionAvailable() { return !disposed; },
    encryptString(value: string) {
      try {
        if (disposed) throw new Error("Disposed");
        const plaintext = Buffer.from(value, "utf8");
        try {
          if (new TextDecoder("utf-8", { fatal: true }).decode(plaintext) !== value) throw new Error("Invalid string encoding");
          const nonce = randomBytes(12);
          const cipher = createCipheriv("aes-256-gcm", key, nonce);
          return Buffer.concat([stringPrefix, nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
        } finally { plaintext.fill(0); }
      } catch {
        throw new AppError("secure_storage_unavailable", "Credentials could not be encrypted.");
      }
    },
    decryptString(value: Buffer) {
      try {
        if (disposed || value.length < 31 || !value.subarray(0, 3).equals(stringPrefix)) throw new Error("Invalid encrypted string");
        const cipher = createDecipheriv("aes-256-gcm", key, value.subarray(3, 15));
        cipher.setAuthTag(value.subarray(-16));
        const plaintext = cipher.update(value.subarray(15, -16));
        try {
          // GCM emits its plaintext in update; final authenticates it before decode.
          cipher.final();
          return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
        }
        finally { plaintext.fill(0); }
      } catch {
        throw new AppError("secure_storage_unavailable", "Saved credentials could not be decrypted. The encrypted file has been left untouched.");
      }
    },
    dispose() {
      if (disposed) return;
      key.fill(0);
      disposed = true;
    },
  };
}
