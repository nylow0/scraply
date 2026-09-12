import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createCredentialStore } from "../../src/main/credential-store";

// Only synthetic test credentials are accepted by this worker.
const [path, encodedKey, field, value] = process.argv.slice(2);
if (!path || !encodedKey || !field || !value) throw new Error("Missing fixture arguments");
const key = Buffer.from(encodedKey, "base64");
const store = createCredentialStore(path, {
  isEncryptionAvailable: () => true,
  encryptString(value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  },
  decryptString(value) {
    const cipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
    cipher.setAuthTag(value.subarray(12, 28));
    return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString("utf8");
  },
});
const secrets = store.load();
const go = new Promise<void>(resolve => process.stdin.once("data", () => resolve()));
console.log("ready");
await go;
if (field === "exaApiKey") secrets.exaApiKey = value;
else secrets.providerCredentials.openai = value;
await store.save(secrets, () => {
  // Hold the lock long enough for the other process to contend for it.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
});
process.stdin.destroy();
