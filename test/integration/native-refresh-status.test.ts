import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { requestBackend } from "../../src/app/backend-request";
import { createInProcessBackend } from "../../src/app/in-process-backend";
import { resolveProfile } from "../../src/app/profile";
import { createAppService } from "../../src/app/service";
import { startBackend } from "../../src/backend/server";
import { runCli } from "../../src/cli/main";
import { createCredentialStore } from "../../src/main/credential-store";
import { APP_CHANNELS, ProviderStatusResultSchema } from "../../src/shared/cli-contracts";
import { IPC_CHANNELS, WorkspaceStateSchema } from "../../src/shared/ipc";
import { createFixtureEncryption } from "../fixtures/credential-store-encryption";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const CliEnvelopeSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.unknown() }),
]);
const connectedNative = { available: true, connected: true,
  accounts: [{ providerId: "openai-subscription", accountId: "synthetic-account" }] };
const nativeModel = { providerId: "openai-subscription", modelId: "gpt-fixture" };

// Run real CLI handlers, service, HTTP backend, and worker protocol. Only external
// search HTTP and the worker executable are synthetic, with no real profile access.
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "scraply-native-action-status-"));
  const profile = await resolveProfile({ dataDir: directory });
  mkdirSync(profile.dataDir, { recursive: true });
  const capture = join(directory, "operations.txt");
  const probes: Array<{ provider: string; query: string }> = [];
  const originalFetch = globalThis.fetch;
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname === "127.0.0.1") return originalFetch(input, init);
    const provider = url.hostname === "api.exa.ai" ? "exa" : url.hostname === "api.perplexity.ai" ? "perplexity" : undefined;
    if (!provider) throw new Error(`Unexpected external destination: ${url.hostname}`);
    const body = z.object({ query: z.string() }).parse(JSON.parse(String(init?.body)));
    probes.push({ provider, query: body.query });
    return Response.json({ results: [] });
  }, { preconnect: originalFetch.preconnect }));
  const store = createCredentialStore(profile.credentialsPath, createFixtureEncryption(Buffer.alloc(32, 7)));
  store.load();
  await store.save({ exaApiKey: "synthetic-status-exa", perplexityApiKey: "synthetic-status-perplexity",
    providerCredentials: { "openai-subscription": "synthetic-status-account" } });
  const backend = createInProcessBackend({ runtime: {
    executablePath: process.execPath, argumentPrefix: ["--no-env-file", "run", resolve("test/fixtures/runtime-child.cjs")],
    artifact: { version: "0.1.0", sourceCommit: "ab9fcfc859ee19fff8dfd4c05c854ab5d145baf8",
      sha256: createHash("sha256").update(readFileSync(process.execPath)).digest("hex") },
    appVersion: "0.3.0-test", controlTimeoutMs: 5_000, terminalGraceMs: 500,
    environment: { ...process.env, EXA_API_KEY: "", PERPLEXITY_API_KEY: "", SCRAPLY_RUNTIME_CHILD_MODE: "workflow",
      SCRAPLY_RUNTIME_OPERATIONS_CAPTURE: capture },
  } });
  const service = createAppService({ paths: profile, appVersion: "0.3.0-test", backend, credentialStore: store,
    automaticSecrets: { environment: { EXA_API_KEY: "", PERPLEXITY_API_KEY: "" } } });
  cleanups.push(async () => {
    try { await service.stop(); }
    finally { fetchSpy.mockRestore(); rmSync(directory, { recursive: true, force: true }); }
  });
  await service.start({ validateAutomaticSecrets: false });
  const deadline = Date.now() + 5_000;
  let status = ProviderStatusResultSchema.parse(await service.invokeRemote(APP_CHANNELS.GET_PROVIDER_STATUS));
  while (!status.native.connected && Date.now() < deadline) {
    await delay(10);
    status = ProviderStatusResultSchema.parse(await service.invokeRemote(APP_CHANNELS.GET_PROVIDER_STATUS));
  }
  expect(status.native).toMatchObject(connectedNative);
  expect(probes).toEqual([]);
  const cli = async (args: string[]) => {
    let stdout = "";
    const code = await runCli([...args, "--json", "--data-dir", directory, "--timeout", "5000"], {
      invoke: (channel, payload) => service.invokeRemote(channel, payload),
      system: async action => { expect(action).toBe("host-status"); return { owner: null }; },
      stdout: text => { stdout += text; }, stderr: text => { throw new Error(text); }, isTTY: false,
    });
    const response = CliEnvelopeSchema.parse(JSON.parse(stdout));
    expect({ code, ok: response.ok }).toEqual({ code: 0, ok: true });
    if (!response.ok) throw new Error(JSON.stringify(response.error));
    return response.data;
  };
  return { cli, service, store, probes,
    operations: () => existsSync(capture) ? readFileSync(capture, "utf8").trim().split(/\r?\n/) : [] };
}

test("account refresh returns connected native identity and models after saving rotation, without search probes", async () => {
  const item = await fixture();
  const refreshed = WorkspaceStateSchema.parse(await item.cli(["account", "refresh"]));
  expect(item.store.load().providerCredentials["openai-subscription"]).toBe("connected-credential");
  expect(item.operations()).toContain("credential.session.persisted");
  expect(item.operations()).not.toContain("generation.start");
  expect(item.probes).toEqual([]);
  expect(refreshed.validation.native).toMatchObject(connectedNative);
  expect(refreshed.validation.native.error).toBeUndefined();
  expect(refreshed.models).toContainEqual(nativeModel);
  const saved = WorkspaceStateSchema.parse(await item.service.invokeRemote(IPC_CHANNELS.GET_WORKSPACE));
  expect(saved.validation.native).toEqual(refreshed.validation.native);
  expect(saved.models).toEqual(refreshed.models);
});

test("doctor retry returns connected native identity after one probe per configured search provider", async () => {
  const item = await fixture();
  const checked = z.object({ validation: ProviderStatusResultSchema }).parse(await item.cli(["doctor", "--retry", "--yes"]));
  expect(item.probes).toEqual([
    { provider: "exa", query: "test connectivity" },
    { provider: "perplexity", query: "test connectivity" },
  ]);
  expect(item.store.load().providerCredentials["openai-subscription"]).toBe("synthetic-status-account");
  expect(item.operations()).not.toContain("generation.start");
  expect(checked.validation.native).toMatchObject(connectedNative);
  expect(checked.validation.native.error).toBeUndefined();
  const saved = WorkspaceStateSchema.parse(await item.service.invokeRemote(IPC_CHANNELS.GET_WORKSPACE));
  expect(saved.validation.native).toEqual(checked.validation.native);
  expect(saved.models).toContainEqual(nativeModel);
});

test("logout returns available signed-out native status without search probes or retaining the credential", async () => {
  const item = await fixture();
  const signedOut = WorkspaceStateSchema.parse(await item.cli(["logout"]));
  expect(item.store.load().providerCredentials["openai-subscription"]).toBeUndefined();
  expect(item.operations()).toContain("account.logout");
  expect(item.operations()).not.toContain("generation.start");
  expect(item.probes).toEqual([]);
  expect(signedOut.validation.native).toMatchObject({ available: true, connected: false, accounts: [] });
  expect(signedOut.validation.native.error).toBeUndefined();
  expect(signedOut.models).toEqual([]);
  const saved = WorkspaceStateSchema.parse(await item.service.invokeRemote(IPC_CHANNELS.GET_WORKSPACE));
  expect(saved.validation.native).toEqual(signedOut.validation.native);
  expect(saved.models).toEqual([]);
});

test("native retry inspects current account capabilities even without a runtime preparation callback", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scraply-native-retry-optional-"));
  let connected = false;
  let probes = 0;
  const handle = await startBackend({
    dataDir: directory, dbPath: join(directory, "scraply.db"), appVersion: "test",
    bundledPromptsDir: resolve("prompts"), promptOverridesDir: join(directory, "prompts"),
    getSecrets: () => ({ exaApiKey: "synthetic-status-exa" }),
    providerValidation: {
      inspectNative: async () => ({ available: true, connected,
        accounts: connected ? connectedNative.accounts : [],
        models: connected ? [{ ...nativeModel, displayName: "Synthetic model", defaultReasoningEffort: "medium",
          reasoningEfforts: [{ id: "medium", description: "Medium" }] }] : [] }),
      validateExa: async () => { probes += 1; return { valid: true }; },
    },
  }, () => undefined);
  cleanups.push(async () => { await handle.close(); rmSync(directory, { recursive: true, force: true }); });
  await requestBackend(handle, "/validation");
  expect(probes).toBe(1);
  connected = true;
  const retried = WorkspaceStateSchema.parse(await requestBackend(handle, "/native/retry", { method: "POST", body: "{}" }));
  expect(retried.validation.native).toMatchObject(connectedNative);
  expect(retried.models).toContainEqual(nativeModel);
  expect(probes).toBe(1);
});
