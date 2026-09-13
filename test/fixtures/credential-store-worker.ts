import { createCredentialStore } from "../../src/main/credential-store";
import { createFixtureEncryption } from "./credential-store-encryption";

// Only synthetic test credentials are accepted by this worker.
const [path, encodedKey, field, value] = process.argv.slice(2);
if (!path || !encodedKey || !field || !value) throw new Error("Missing fixture arguments");
const key = Buffer.from(encodedKey, "base64");
const store = createCredentialStore(path, createFixtureEncryption(key));
const secrets = store.load();
const startSignal = new Promise<void>(resolve => process.stdin.once("data", () => resolve()));
console.log("ready");
await startSignal;
if (field === "exaApiKey") secrets.exaApiKey = value;
else secrets.providerCredentials.openai = value;
await store.save(secrets, () => {
  // Hold the lock long enough for the other process to contend for it.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
});
process.stdin.destroy();
