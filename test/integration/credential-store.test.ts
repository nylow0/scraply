import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createCredentialStore, resolveCredentialStoreLocation } from "../../src/main/credential-store";
import { createFixtureEncryption } from "../fixtures/credential-store-encryption";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "scraply-credentials-"));
  directories.push(directory);
  const path = join(directory, "secrets.bin");
  // Exercise encrypted file I/O without accessing the Windows account's actual vault.
  const key = randomBytes(32);
  const encryption = createFixtureEncryption(key);
  return { path, key, encryption, open: () => createCredentialStore(path, encryption) };
}

test("credential store location shares the installed profile only during normal development", () => {
  const options = { appData: "roaming", userData: "dev-projects", development: true, e2e: false, isolatedDevelopment: false };
  expect(resolveCredentialStoreLocation(options)).toEqual({
    credentialsPath: join("roaming", "scraply", "secrets.bin"),
    sessionDataPath: join("roaming", "scraply"),
  });
  expect(resolveCredentialStoreLocation({ ...options, development: false, userData: join("roaming", "scraply") })).toEqual({
    credentialsPath: join("roaming", "scraply", "secrets.bin"), sessionDataPath: null,
  });
  for (const override of [{ e2e: true }, { isolatedDevelopment: true }, { development: false }]) {
    expect(resolveCredentialStoreLocation({ ...options, ...override })).toEqual({
      credentialsPath: join("dev-projects", "secrets.bin"), sessionDataPath: null,
    });
  }
});

test("reads the existing installed format and preserves unrelated concurrent key and account changes", async () => {
  const { path, encryption, open } = fixture();
  writeFileSync(path, encryption.encryptString(JSON.stringify({ exaApiKey: "original-key", providerCredentials: { openai: "original-account" } })));
  const desktop = open();
  const dev = open();
  const desktopSecrets = desktop.load();
  const devSecrets = dev.load();
  expect(devSecrets).toEqual(desktopSecrets);
  const rotated = { ...desktopSecrets, providerCredentials: { openai: "rotated-account" } };
  const newKey = { ...devSecrets, exaApiKey: "replacement-key" };
  await desktop.save(rotated);
  await dev.save(newKey);
  // A second write from the older runtime view must also preserve the other process's fields.
  await dev.save({ ...newKey, perplexityApiKey: "another-key" });
  expect(open().load()).toEqual({ exaApiKey: "replacement-key", perplexityApiKey: "another-key", providerCredentials: { openai: "rotated-account" } });
  expect(readFileSync(path).includes(Buffer.from("rotated-account"))).toBe(false);
});

test("separate Node processes serialize simultaneous credential writes", async () => {
  const { path, key, open } = fixture();
  const compiled = await Bun.build({
    entrypoints: [join(import.meta.dir, "../fixtures/credential-store-worker.ts")], target: "node",
    outdir: dirname(path), naming: "worker.mjs",
  });
  expect(compiled.success).toBe(true);
  // Electron uses Node, not Bun's Windows named-pipe implementation.
  const workers = ["exaApiKey", "openai"].map(field => Bun.spawn([
    "node", compiled.outputs[0]!.path, path, key.toString("base64"), field, `test-${field}`,
  ], { stdin: "pipe", stdout: "pipe", stderr: "pipe" }));
  try {
    await Promise.all(workers.map(async worker => {
      const reader = worker.stdout.getReader();
      const output = await reader.read();
      reader.releaseLock();
      expect(new TextDecoder().decode(output.value)).toContain("ready");
    }));
    for (const worker of workers) { worker.stdin.write("go"); worker.stdin.end(); }
    for (const worker of workers) {
      expect(await new Response(worker.stderr).text()).toBe("");
      expect(await worker.exited).toBe(0);
    }
    expect(open().load()).toEqual({ exaApiKey: "test-exaApiKey", perplexityApiKey: null, providerCredentials: { openai: "test-openai" } });
  } finally {
    for (const worker of workers) worker.kill();
  }
}, 10_000);

test("a stale instance cannot resurrect a logged-out account or replace a newer login", async () => {
  const { open } = fixture();
  const initial = open();
  await initial.save({ ...initial.load(), providerCredentials: { openai: "signed-in" } });
  const desktop = open();
  const dev = open();
  const current = desktop.load();
  const stale = dev.load();
  await desktop.save({ ...current, providerCredentials: {} });
  await expect(dev.save({ ...stale, providerCredentials: { openai: "late-refresh" } })).rejects.toThrow("Restart this instance");
  expect(open().load().providerCredentials).toEqual({});
  await desktop.save({ ...current, providerCredentials: { openai: "different-login" } });
  await expect(dev.save({ ...stale, providerCredentials: {} })).rejects.toThrow("Restart this instance");
  expect(open().load().providerCredentials).toEqual({ openai: "different-login" });
});

test("corruption and unavailable encryption fail without replacing saved credentials", async () => {
  const { path, encryption, open } = fixture();
  const store = open();
  const empty = store.load();
  writeFileSync(path, "damaged encrypted file");
  expect(() => open().load()).toThrow("left untouched");
  await expect(store.save({ ...empty, exaApiKey: "new-key" })).rejects.toThrow("left untouched");
  const unavailable = createCredentialStore(path, { ...encryption, isEncryptionAvailable: () => false });
  expect(() => unavailable.load()).toThrow();
  expect(readFileSync(path, "utf8")).toBe("damaged encrypted file");
});

test("logout while a credential write waits prevents that write and releases the mutex", async () => {
  const { open } = fixture();
  const store = open();
  const empty = store.load();
  await expect(store.save({ ...empty, providerCredentials: { openai: "late" } }, () => {
    throw new Error("already signed out");
  })).rejects.toThrow("already signed out");
  await store.save({ ...empty, exaApiKey: "valid-key" });
  expect(open().load().providerCredentials).toEqual({});
});
