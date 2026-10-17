import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createAppService } from "../../src/app/service";
import { createBackendClient } from "../../src/app/backend-client";
import type { AppBackend, AppServicePaths } from "../../src/app/service-contracts";
import { createCredentialStore } from "../../src/main/credential-store";
import { startBackend, type BackendHandle } from "../../src/backend/server";
import { DatabaseClient } from "../../src/db/client";
import { IPC_CHANNELS, WorkspaceStateSchema } from "../../src/shared/ipc";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";
import { APP_CHANNELS, ExecuteOperationResultSchema, OperationProposalSchema } from "../../src/shared/cli-contracts";
import type { BackendSecrets } from "../../src/shared/backend-process";
import { AppError } from "../../src/shared/errors";

const directories: string[] = [];
const backends = new Set<BackendHandle>();
afterEach(async () => {
  for (const handle of backends) await handle.close();
  backends.clear();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function isolatedPaths(): AppServicePaths {
  const dataDir = mkdtempSync(join(tmpdir(), "scraply-service-")); directories.push(dataDir);
  return { dataDir, dbPath: join(dataDir, "scraply.db"), logsDir: join(dataDir, "logs"),
    bundledPromptsDir: join(process.cwd(), "prompts"), promptOverridesDir: join(dataDir, "prompts") };
}

function syntheticStore(paths: AppServicePaths, rejectWriteKey?: string) {
  // A synthetic test codec exercises the real store without reading Windows accounts.
  return createCredentialStore(join(paths.dataDir, "synthetic-secrets.bin"), {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      if (rejectWriteKey && value.includes(JSON.stringify(rejectWriteKey))) throw new Error("Synthetic encrypted write failure");
      return Buffer.from(value, "utf8");
    },
    decryptString: value => value.toString("utf8"),
  });
}

async function openService(paths: AppServicePaths) {
  const handle = await startBackend({ ...paths, appVersion: "test", getSecrets: () => ({ exaApiKey: null, perplexityApiKey: null }),
    providerValidation: { inspectNative: async () => ({ available: false, connected: false, accounts: [], models: [], error: "Synthetic offline runtime" }) },
  }, () => undefined);
  backends.add(handle);
  // Exercise the existing external-backend e2e seam with real HTTP and SQLite, no worker/providers.
  const backend = createBackendClient({ async launch() { return handle; }, postMessage() { throw new Error("No utility process in this fixture"); },
    hasProcess: () => false, stop() {}, externalSecretsNoop: true });
  const service = createAppService({ paths, appVersion: "test", credentialStore: syntheticStore(paths), backend,
    automaticSecrets: { environment: { EXA_API_KEY: "", PERPLEXITY_API_KEY: "" } },
    async chooseExportTarget(request) { return request.kind === "research" ? join(paths.dataDir, request.filename) : paths.dataDir; },
  });
  return { service, async close() { await service.stop(); await handle.close(); backends.delete(handle); } };
}

async function countedService(options: {
  initial?: BackendSecrets; environment?: NodeJS.ProcessEnv; rejectProbe?: boolean; rejectWriteKey?: string;
} = {}) {
  const paths = isolatedPaths();
  const store = syntheticStore(paths, options.rejectWriteKey);
  store.load();
  if (options.initial) await store.save(options.initial);
  let secrets: BackendSecrets = { exaApiKey: null, perplexityApiKey: null, providerCredentials: {} };
  let handle: BackendHandle | undefined;
  let probeHook: (() => Promise<void>) | undefined;
  const probes = { exa: 0, perplexity: 0 };
  const client = createBackendClient({
    async launch(input) {
      secrets = structuredClone(input.secrets);
      handle = await startBackend({ ...paths, appVersion: "test", getSecrets: () => secrets,
        validateAutomaticSecrets: input.validateAutomaticSecrets ?? true,
        async prepareNativeRuntime() {},
        providerValidation: {
          inspectNative: async () => ({ available: true, connected: true, accounts: [{ providerId: "openai-subscription" }], models: [] }),
          async validateExa() { probes.exa += 1; await probeHook?.(); return { valid: !options.rejectProbe, error: "Synthetic rejected key" }; },
          async validatePerplexity() { probes.perplexity += 1; await probeHook?.(); return { valid: !options.rejectProbe, error: "Synthetic rejected key" }; },
        },
      }, input.publishEvent);
      backends.add(handle);
      return handle;
    },
    postMessage() { throw new Error("No utility process in this fixture"); }, hasProcess: () => false, stop() {},
  });
  const backend: AppBackend = {
    start: client.start, isReady: client.isReady, request: client.request,
    async updateSecrets(next, onlyWhenIdle = false) {
      if (!handle) throw new AppError("backend_unavailable");
      if (onlyWhenIdle && !handle.beginSearchKeyUpdate()) throw new AppError("conflict", "Synthetic active research");
      secrets = structuredClone(next);
      handle.secretsChanged();
    },
    async finishSearchKeyUpdate(previous) {
      if (!handle) throw new AppError("backend_unavailable");
      if (handle.finishSearchKeyUpdate() && previous) { secrets = structuredClone(previous); handle.secretsChanged(); }
    },
    async stop() {
      await client.stop();
      if (handle) { await handle.close(); backends.delete(handle); handle = undefined; }
    },
  };
  const service = createAppService({ paths, appVersion: "test", credentialStore: store, backend,
    automaticSecrets: { environment: options.environment ?? { EXA_API_KEY: "", PERPLEXITY_API_KEY: "" } } });
  await service.start({ validateAutomaticSecrets: false });
  return { service, paths, probes, onProbe(hook: () => Promise<void>) { probeHook = hook; },
    backend,
    reserve() { return handle?.beginSearchKeyUpdate(); }, release() { handle?.finishSearchKeyUpdate(); },
    backendSecrets: () => structuredClone(secrets),
    async rotateCredential(credential: string) {
      await service.persistProviderCredential("openai-subscription", credential);
      // Match the backend's acknowledgment: accept the rotation only after encrypted persistence.
      secrets = { ...secrets, providerCredentials: { ...secrets.providerCredentials, "openai-subscription": credential } };
    },
  };
}

function gate() {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  return { waiting, release };
}

describe("credential changes during provider probes", () => {
  test("cancelling an in-flight sign-in revokes real-store credentials before a late completion can persist", async () => {
    const initial: BackendSecrets = { exaApiKey: "synthetic-exa", perplexityApiKey: "synthetic-perplexity",
      providerCredentials: { "openai-subscription": "synthetic-original-account" } };
    const host = await countedService({ initial });
    const completeEntered = gate(); const completeRelease = gate(); const cancelEntered = gate();
    const request = host.backend.request;
    host.backend.request = async (path, init) => {
      if (path === "/native/login/start") return {
        loginId: "synthetic-login", providerId: "openai-subscription", method: "browser",
        authorizationUrl: "https://example.test/login", callbackPort: 3849,
      };
      if (path === "/native/login/complete") {
        completeEntered.release();
        await completeRelease.waiting;
        await host.rotateCredential("synthetic-late-completed-account");
        return { pending: false };
      }
      if (path === "/native/login/cancel") {
        cancelEntered.release();
        await host.backend.updateSecrets(host.service.getSecrets());
        return { synthetic: true };
      }
      return request(path, init);
    };
    await host.service.invoke(IPC_CHANNELS.NATIVE_LOGIN_START, [{ providerId: "openai-subscription", method: "browser" }]);
    const completing = host.service.invoke(IPC_CHANNELS.NATIVE_LOGIN_COMPLETE, [{ loginId: "synthetic-login" }]);
    const completed = completing.then(() => ({ ok: true as const }), error => ({ ok: false as const, error: String(error) }));
    await completeEntered.waiting;
    const cancelling = host.service.invoke(IPC_CHANNELS.NATIVE_LOGIN_CANCEL, [{ providerId: "openai-subscription", loginId: "synthetic-login" }]);
    try {
      expect(await Promise.race([cancelEntered.waiting.then(() => true), cancelling.then(() => false, () => false)])).toBe(true);
      await cancelling;
      const expected = { ...initial, providerCredentials: {} };
      expect(syntheticStore(host.paths).load()).toEqual(expected);
      expect(host.service.getSecrets()).toEqual(expected);
      expect(host.backendSecrets()).toEqual(expected);
      await expect(host.rotateCredential("synthetic-late-background-rotation")).rejects.toThrow("signed out");
      completeRelease.release();
      expect(await completed).toMatchObject({ ok: false, error: expect.stringContaining("signed out") });
      expect(syntheticStore(host.paths).load()).toEqual(expected);
      expect(host.service.getSecrets()).toEqual(expected);
      expect(host.backendSecrets()).toEqual(expected);
      expect(host.probes).toEqual({ exa: 0, perplexity: 0 });
    } finally {
      completeRelease.release();
      await Promise.allSettled([completing, cancelling]);
    }
  });

  const initial: BackendSecrets = { exaApiKey: "synthetic-original-exa", perplexityApiKey: "synthetic-original-perplexity",
    providerCredentials: { "openai-subscription": "synthetic-original-account" } };

  test.each(["confirmed", "GUI"] as const)("%s key save retains a rotation acknowledged while its probe was gated", async mode => {
    const host = await countedService({ initial });
    const entered = gate(); const release = gate();
    const apiKey = "synthetic-concurrent-exa";
    host.onProbe(async () => { entered.release(); await release.waiting; });
    const proposal = mode === "confirmed" ? OperationProposalSchema.parse(await host.service.invokeRemote(APP_CHANNELS.PREVIEW_OPERATION,
      { channel: IPC_CHANNELS.SAVE_SEARCH_KEY, payload: { provider: "exa", apiKey } })) : null;
    const pending = proposal ? host.service.invokeRemote(APP_CHANNELS.EXECUTE_OPERATION, { proposal })
      : host.service.invoke(IPC_CHANNELS.SAVE_SEARCH_KEY, [{ provider: "exa", apiKey }]);
    try {
      await entered.waiting;
      await host.rotateCredential("synthetic-rotated-account");
      expect(syntheticStore(host.paths).load().providerCredentials["openai-subscription"]).toBe("synthetic-rotated-account");
      expect(host.backendSecrets().providerCredentials["openai-subscription"]).toBe("synthetic-rotated-account");
    } finally { release.release(); }
    await pending;
    const expected = { ...initial, exaApiKey: apiKey, providerCredentials: { "openai-subscription": "synthetic-rotated-account" } };
    expect(syntheticStore(host.paths).load()).toEqual(expected);
    expect(host.service.getSecrets()).toEqual(expected);
    expect(host.backendSecrets()).toEqual(expected);
    await host.service.stop();
  });

  test("logout during a confirmed probe rejects before revocation or disk changes", async () => {
    const host = await countedService({ initial });
    const entered = gate(); const release = gate();
    host.onProbe(async () => { entered.release(); await release.waiting; });
    const proposal = OperationProposalSchema.parse(await host.service.invokeRemote(APP_CHANNELS.PREVIEW_OPERATION,
      { channel: IPC_CHANNELS.SAVE_SEARCH_KEY, payload: { provider: "exa", apiKey: "synthetic-after-rejected-logout" } }));
    const pending = host.service.invokeRemote(APP_CHANNELS.EXECUTE_OPERATION, { proposal });
    try {
      await entered.waiting;
      await expect(host.service.invokeRemote(IPC_CHANNELS.NATIVE_LOGOUT, { providerId: "openai-subscription" })).rejects.toMatchObject({ code: "conflict" });
      expect(syntheticStore(host.paths).load()).toEqual(initial);
      expect(host.service.getSecrets()).toEqual(initial);
      expect(host.backendSecrets()).toEqual(initial);
      // A rejected logout must not block a legitimate background rotation, either.
      await host.rotateCredential("synthetic-rotation-after-rejected-logout");
    } finally { release.release(); }
    await pending;
    const expected = { ...initial, exaApiKey: "synthetic-after-rejected-logout",
      providerCredentials: { "openai-subscription": "synthetic-rotation-after-rejected-logout" } };
    expect(syntheticStore(host.paths).load()).toEqual(expected);
    expect(host.backendSecrets()).toEqual(expected);
    await host.service.stop();
  });

  test.each(["probe", "write"] as const)("failed key %s rolls back keys while retaining the acknowledged rotation", async failure => {
    const apiKey = "synthetic-rejected-concurrent-exa";
    const host = await countedService({ initial, rejectProbe: failure === "probe", ...(failure === "write" ? { rejectWriteKey: apiKey } : {}) });
    const entered = gate(); const release = gate();
    host.onProbe(async () => { entered.release(); await release.waiting; });
    const proposal = OperationProposalSchema.parse(await host.service.invokeRemote(APP_CHANNELS.PREVIEW_OPERATION,
      { channel: IPC_CHANNELS.SAVE_SEARCH_KEY, payload: { provider: "exa", apiKey } }));
    const pending = host.service.invokeRemote(APP_CHANNELS.EXECUTE_OPERATION, { proposal });
    try {
      await entered.waiting;
      await host.rotateCredential("synthetic-rotation-before-rejection");
    } finally { release.release(); }
    await expect(pending).rejects.toThrow();
    const expected = { ...initial, providerCredentials: { "openai-subscription": "synthetic-rotation-before-rejection" } };
    expect(syntheticStore(host.paths).load()).toEqual(expected);
    expect(host.service.getSecrets()).toEqual(expected);
    expect(host.backendSecrets()).toEqual(expected);
    expect(await host.service.invokeRemote(APP_CHANNELS.GET_ACTIVITY)).toMatchObject({ searchKeyUpdatePending: false });
    expect(host.probes).toEqual({ exa: 1, perplexity: 0 });
    await host.service.stop();
  });

  test.each([false, true])("retry preserves rotations through validation and rollback, rejected=%s", async rejectProbe => {
    const host = await countedService({ initial, rejectProbe });
    const entered = gate(); const release = gate();
    host.onProbe(async () => { entered.release(); await release.waiting; });
    const pending = host.service.invoke(IPC_CHANNELS.RETRY_CONNECTION);
    try {
      await entered.waiting;
      await expect(host.service.invokeRemote(IPC_CHANNELS.NATIVE_LOGOUT, { providerId: "openai-subscription" })).rejects.toMatchObject({ code: "conflict" });
      await host.rotateCredential("synthetic-rotation-during-retry");
    } finally { release.release(); }
    await pending;
    const expected = { ...initial, providerCredentials: { "openai-subscription": "synthetic-rotation-during-retry" } };
    expect(syntheticStore(host.paths).load()).toEqual(expected);
    expect(host.service.getSecrets()).toEqual(expected);
    expect(host.backendSecrets()).toEqual(expected);
    expect(host.probes).toEqual({ exa: 1, perplexity: 1 });
    await host.service.stop();
  });

  test("removal commits before a queued rotation and preserves both changes", async () => {
    const host = await countedService({ initial });
    const entered = gate(); const release = gate();
    const update = host.backend.updateSecrets;
    host.backend.updateSecrets = async (candidate, onlyWhenIdle) => {
      if (onlyWhenIdle) { entered.release(); await release.waiting; }
      return update(candidate, onlyWhenIdle);
    };
    const removal = host.service.invoke(IPC_CHANNELS.REMOVE_SEARCH_KEY, [{ provider: "exa" }]);
    await entered.waiting;
    let acknowledged = false;
    const rotation = host.rotateCredential("synthetic-rotation-during-removal").then(() => { acknowledged = true; });
    try {
      await Promise.resolve();
      expect(acknowledged).toBe(false);
      await expect(host.service.invokeRemote(IPC_CHANNELS.NATIVE_LOGOUT, { providerId: "openai-subscription" })).rejects.toMatchObject({ code: "conflict" });
    } finally { release.release(); }
    expect(await removal).toMatchObject({ ok: true });
    await rotation;
    const expected = { ...initial, exaApiKey: null, providerCredentials: { "openai-subscription": "synthetic-rotation-during-removal" } };
    expect(syntheticStore(host.paths).load()).toEqual(expected);
    expect(host.service.getSecrets()).toEqual(expected);
    expect(host.backendSecrets()).toEqual(expected);
    expect(host.probes).toEqual({ exa: 0, perplexity: 0 });
    await host.service.stop();
  });

  test("GUI startup key persistence retains a rotation acknowledged during validation", async () => {
    const host = await countedService({ initial, environment: { EXA_API_KEY: "synthetic-startup-exa", PERPLEXITY_API_KEY: "" } });
    const entered = gate(); const release = gate();
    host.onProbe(async () => { entered.release(); await release.waiting; });
    const startup = host.service.start();
    try {
      await entered.waiting;
      await host.rotateCredential("synthetic-rotation-during-startup");
      await expect(host.service.invokeRemote(IPC_CHANNELS.NATIVE_LOGOUT, { providerId: "openai-subscription" })).rejects.toMatchObject({ code: "conflict" });
    } finally { release.release(); }
    await startup;
    const expected = { ...initial, exaApiKey: "synthetic-startup-exa",
      providerCredentials: { "openai-subscription": "synthetic-rotation-during-startup" } };
    expect(syntheticStore(host.paths).load()).toEqual(expected);
    expect(host.service.getSecrets()).toEqual(expected);
    expect(host.backendSecrets()).toEqual(expected);
    expect(host.probes).toEqual({ exa: 1, perplexity: 1 });
    await host.service.stop();
  });
});

describe("confirmed provider probes", () => {
  const initial: BackendSecrets = { exaApiKey: "synthetic-old-exa", perplexityApiKey: "synthetic-saved-perplexity", providerCredentials: {} };

  test("startup, passive reads and unconfirmed validation make zero search calls; confirmed checks run once", async () => {
    const host = await countedService({ initial });
    const { service, probes } = host;
    const status = z.object({ exa: z.object({ valid: z.boolean() }), perplexity: z.object({ valid: z.boolean() }) })
      .parse(await service.invokeRemote(APP_CHANNELS.GET_PROVIDER_STATUS));
    expect(status.exa.valid).toBe(false); expect(status.perplexity.valid).toBe(false);
    await service.invokeRemote(IPC_CHANNELS.GET_WORKSPACE);
    for (const channel of [IPC_CHANNELS.GET_VALIDATION, IPC_CHANNELS.RETRY_CONNECTION]) {
      await expect(service.invokeRemote(channel, {})).rejects.toMatchObject({ code: "conflict" });
    }
    expect(probes).toEqual({ exa: 0, perplexity: 0 });
    const proposal = OperationProposalSchema.parse(await service.invokeRemote(APP_CHANNELS.PREVIEW_OPERATION,
      { channel: IPC_CHANNELS.GET_VALIDATION, payload: {} }));
    expect(probes).toEqual({ exa: 0, perplexity: 0 });
    const checked = ExecuteOperationResultSchema.parse(await service.invokeRemote(APP_CHANNELS.EXECUTE_OPERATION, { proposal }));
    expect(checked.channel).toBe(IPC_CHANNELS.GET_VALIDATION);
    expect(probes).toEqual({ exa: 1, perplexity: 1 });
    await expect(service.invokeRemote(APP_CHANNELS.EXECUTE_OPERATION, { proposal })).rejects.toMatchObject({ code: "PREVIEW_STALE" });
    expect(probes).toEqual({ exa: 1, perplexity: 1 });
    const retry = OperationProposalSchema.parse(await service.invokeRemote(APP_CHANNELS.PREVIEW_OPERATION,
      { channel: IPC_CHANNELS.RETRY_CONNECTION, payload: {} }));
    expect(probes).toEqual({ exa: 1, perplexity: 1 });
    await service.invokeRemote(APP_CHANNELS.EXECUTE_OPERATION, { proposal: retry });
    expect(probes).toEqual({ exa: 2, perplexity: 2 });
    await service.invokeRemote(APP_CHANNELS.GET_PROVIDER_STATUS);
    expect(probes).toEqual({ exa: 2, perplexity: 2 });
    // The existing local GUI handler still performs its explicit checks without a remote proof.
    await service.invoke(IPC_CHANNELS.GET_VALIDATION);
    expect(probes).toEqual({ exa: 3, perplexity: 3 });
    await service.stop();
  });

  test.each(["exa", "perplexity"] as const)("confirmed %s key save probes only its target under reservation and removal makes no probes", async provider => {
    const host = await countedService({ initial });
    const apiKey = `synthetic-new-${provider}-private`;
    await expect(host.service.invokeRemote(IPC_CHANNELS.SAVE_SEARCH_KEY, { provider, apiKey })).rejects.toMatchObject({ code: "conflict" });
    const proposal = OperationProposalSchema.parse(await host.service.invokeRemote(APP_CHANNELS.PREVIEW_OPERATION,
      { channel: IPC_CHANNELS.SAVE_SEARCH_KEY, payload: { provider, apiKey } }));
    expect(JSON.stringify(proposal)).not.toContain(apiKey);
    expect(host.probes).toEqual({ exa: 0, perplexity: 0 });
    expect(syntheticStore(host.paths).load()).toEqual(initial);
    host.onProbe(async () => {
      await expect(host.service.invoke(IPC_CHANNELS.CREATE_THREAD, [{ title: "Synthetic blocked mutation" }])).rejects.toMatchObject({ code: "conflict" });
    });
    const executed = ExecuteOperationResultSchema.parse(await host.service.invokeRemote(APP_CHANNELS.EXECUTE_OPERATION, { proposal }));
    expect(executed.channel).toBe(IPC_CHANNELS.SAVE_SEARCH_KEY);
    const workspace = WorkspaceStateSchema.parse(executed.result);
    const status = z.object({ valid: z.boolean(), checked: z.boolean().optional() }).parse(workspace.validation[provider]);
    if (status.valid) expect(status.checked).toBe(true);
    expect(host.probes).toEqual(provider === "exa" ? { exa: 1, perplexity: 0 } : { exa: 0, perplexity: 1 });
    expect(syntheticStore(host.paths).load()[provider === "exa" ? "exaApiKey" : "perplexityApiKey"]).toBe(apiKey);
    await expect(host.service.invokeRemote(APP_CHANNELS.EXECUTE_OPERATION, { proposal })).rejects.toMatchObject({ code: "PREVIEW_STALE" });
    const removed = await host.service.invokeRemote(IPC_CHANNELS.REMOVE_SEARCH_KEY, { provider });
    expect(removed).toMatchObject({ ok: true });
    expect(syntheticStore(host.paths).load()[provider === "exa" ? "exaApiKey" : "perplexityApiKey"]).toBeNull();
    expect(host.probes).toEqual(provider === "exa" ? { exa: 1, perplexity: 0 } : { exa: 0, perplexity: 1 });
    await host.service.stop();
  });

  test("environment and active-work conflicts reject key previews without any search", async () => {
    const host = await countedService({ environment: { EXA_API_KEY: "synthetic-env-exa", PERPLEXITY_API_KEY: "" } });
    await expect(host.service.invokeRemote(APP_CHANNELS.PREVIEW_OPERATION,
      { channel: IPC_CHANNELS.SAVE_SEARCH_KEY, payload: { provider: "exa", apiKey: "synthetic-replacement" } })).rejects.toMatchObject({ code: "conflict" });
    expect(host.reserve()).toBe(true);
    try {
      await expect(host.service.invokeRemote(APP_CHANNELS.PREVIEW_OPERATION,
        { channel: IPC_CHANNELS.SAVE_SEARCH_KEY, payload: { provider: "perplexity", apiKey: "synthetic-replacement" } })).rejects.toMatchObject({ code: "conflict" });
    } finally { host.release(); }
    expect(host.probes).toEqual({ exa: 0, perplexity: 0 });
    await host.service.stop();
  });

  test("lazy newer-schema guard reaches the remote caller with its update recovery intact", async () => {
    const paths = isolatedPaths();
    const db = new DatabaseClient(paths.dbPath);
    db.db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(999999, new Date().toISOString());
    db.setMeta("schema_app_version", "9.9.9");
    db.close();
    const backend = createBackendClient({
      async launch() {
        const handle = await startBackend({ ...paths, appVersion: "test", getSecrets: () => ({ exaApiKey: null }),
          validateAutomaticSecrets: false }, () => undefined);
        backends.add(handle); return handle;
      },
      postMessage() {}, hasProcess: () => false, stop() {},
    });
    const service = createAppService({ paths, appVersion: "test", credentialStore: syntheticStore(paths), backend,
      automaticSecrets: { environment: { EXA_API_KEY: "", PERPLEXITY_API_KEY: "" } } });
    await expect(service.invokeRemote(IPC_CHANNELS.GET_WORKSPACE)).rejects.toMatchObject({ code: "conflict", status: 409,
      recovery: { action: "update", schemaVersion: 999999, version: "9.9.9" } });
    await service.stop();
  });
});

describe("app service workflows", () => {
  test("CLI startup defers search checks until explicit validation against the real backend", async () => {
    const paths = isolatedPaths();
    let validations = 0;
    const backend = createBackendClient({
      async launch(input) {
        const handle = await startBackend({ ...paths, appVersion: "test", getSecrets: () => input.secrets,
          ...(input.validateAutomaticSecrets === undefined ? {} : { validateAutomaticSecrets: input.validateAutomaticSecrets }),
          providerValidation: {
            inspectNative: async () => ({ available: false, connected: false, accounts: [], models: [] }),
            async validateExa() { validations += 1; return { valid: false, error: "Synthetic rejected key" }; },
          },
        }, input.publishEvent);
        backends.add(handle);
        return handle;
      },
      postMessage() { throw new Error("No utility process in this fixture"); }, hasProcess: () => false, stop() {},
    });
    const service = createAppService({ paths, appVersion: "test", credentialStore: syntheticStore(paths), backend,
      automaticSecrets: { environment: { EXA_API_KEY: "synthetic-startup-key", PERPLEXITY_API_KEY: "" } },
    });
    await service.start({ validateAutomaticSecrets: false });
    await service.invoke(IPC_CHANNELS.GET_WORKSPACE);
    expect(validations).toBe(0);
    expect(await service.invoke(IPC_CHANNELS.GET_VALIDATION)).toMatchObject({ exa: { valid: false, error: "Synthetic rejected key" } });
    expect(validations).toBe(1);
    await service.stop();
  });

  test("logout rejects a credential queued before revocation and leaves reopened storage signed out", async () => {
    const paths = isolatedPaths();
    const backend: AppBackend = { async start() {}, isReady: () => true, async request() { return {}; },
      async updateSecrets() {}, async finishSearchKeyUpdate() {}, stop() {},
    };
    const service = createAppService({ paths, appVersion: "test", credentialStore: syntheticStore(paths), backend,
      automaticSecrets: { environment: { EXA_API_KEY: "", PERPLEXITY_API_KEY: "" } },
    });
    service.initialize();
    const queued = service.persistProviderCredential("openai-subscription", "synthetic-stale-credential");
    const logout = service.invoke(IPC_CHANNELS.NATIVE_LOGOUT, [{ providerId: "openai-subscription" }]);
    await expect(queued).rejects.toThrow("signed out");
    await logout;
    expect(service.getSecrets().providerCredentials).toEqual({});
    expect(syntheticStore(paths).load().providerCredentials).toEqual({});
  });

  test("persists projects and exports saved v1 research through the same handler map after reopening", async () => {
    const paths = isolatedPaths();
    let host = await openService(paths);
    const created = z.object({ thread: z.object({ id: z.string() }) }).parse(await host.service.handlers.get(IPC_CHANNELS.CREATE_THREAD)?.({ title: "Synthetic harbor repairs" }));
    const threadId = created.thread.id;
    await host.service.invoke(IPC_CHANNELS.SAVE_SCOPE, [{ threadId, scope: {
      title: "Synthetic harbor repairs", audience: "Synthetic repair teams", domain: "Scheduling", observations: "Invented test case", offLimits: [],
    } }]);
    await host.service.invoke(IPC_CHANNELS.ARCHIVE_THREAD, [{ threadId, archived: true }]);
    await host.service.invoke(IPC_CHANNELS.ARCHIVE_THREAD, [{ threadId, archived: false }]);
    await host.service.invoke(IPC_CHANNELS.SELECT_THREAD, [{ threadId }]);
    await expect(host.service.invoke(IPC_CHANNELS.EXPORT_RESEARCH, [{ threadId }])).rejects.toMatchObject({ code: "conflict" });
    // No native runtime exists in the external e2e seam; retry still succeeds as before extraction.
    await host.service.invoke(IPC_CHANNELS.RETRY_CONNECTION);
    await host.close();

    const db = new DatabaseClient(paths.dbPath);
    try {
      const now = new Date().toISOString();
      db.db.prepare(`INSERT INTO research_runs (id, thread_id, status, config_json, workflow_version, created_at, updated_at)
        VALUES (?, ?, 'completed', ?, 1, ?, ?)`).run("synthetic-saved-v1", threadId, JSON.stringify({ ...DEFAULT_RUN_CONFIG, workflowVersion: 1 }), now, now);
    } finally { db.close(); }

    host = await openService(paths);
    const workspace = WorkspaceStateSchema.parse(await host.service.invoke(IPC_CHANNELS.GET_WORKSPACE));
    expect(workspace.activeThreadId).toBe(threadId);
    expect(workspace.scope?.title).toBe("Synthetic harbor repairs");
    expect(workspace.threads.some(thread => thread.id === threadId)).toBe(true);
    const exported = z.object({ files: z.array(z.object({ filename: z.string(), content: z.string() })) }).parse(await host.service.invoke(IPC_CHANNELS.EXPORT_RESEARCH, [{ threadId }]));
    const file = exported.files[0];
    if (!file) throw new Error("Missing saved research export");
    expect(JSON.parse(file.content)).toMatchObject({ schemaVersion: 1, thread: { id: threadId }, researchRun: { id: "synthetic-saved-v1", status: "completed" }, sources: [] });
    const local = host.service.createHandlers({ exportTarget: "dialog" });
    const written = z.object({ cancelled: z.literal(false), file: z.string() }).parse(await local.get(IPC_CHANNELS.EXPORT_RESEARCH)?.({ threadId }));
    expect(JSON.parse(readFileSync(written.file, "utf8"))).toMatchObject({ researchRun: { id: "synthetic-saved-v1" } });
    const download = z.object({ downloads: z.array(z.object({ filename: z.string(), content: z.string() })) }).parse(await host.service.invoke(IPC_CHANNELS.EXPORT_RESEARCH, [{ threadId }], { exportTarget: "download" }));
    expect(download.downloads[0]?.filename).toBe(file.filename);
    await host.close();
  });

  test("returns remote export files without dialogs and preserves browser bundling and desktop unique filenames", async () => {
    const paths = isolatedPaths();
    const files = [{ filename: "synthetic.md", content: "# First idea\n" }, { filename: "synthetic.md", content: "# Second idea\n" }];
    let choices = 0;
    let cancelled = false;
    const backend: AppBackend = { async start() {}, isReady: () => true,
      async request() { return { filename: "synthetic-ideas.md", files }; },
      async updateSecrets() {}, async finishSearchKeyUpdate() {}, stop() {},
    };
    const service = createAppService({ paths, appVersion: "test", credentialStore: syntheticStore(paths), backend,
      automaticSecrets: { environment: { EXA_API_KEY: "", PERPLEXITY_API_KEY: "" } },
      async chooseExportTarget() { choices += 1; return cancelled ? null : paths.dataDir; },
    });
    expect(await service.invoke(IPC_CHANNELS.EXPORT_IDEAS, [{ threadId: "synthetic-thread", format: "markdown" }])).toEqual({ filename: "synthetic-ideas.md", files });
    expect(choices).toBe(0);
    expect(await service.invoke(IPC_CHANNELS.EXPORT_IDEAS, [{ threadId: "synthetic-thread", format: "markdown" }], { exportTarget: "download" }))
      .toEqual({ downloads: [{ filename: "synthetic-ideas.md", content: "# First idea\n\n---\n\n# Second idea\n" }] });
    writeFileSync(join(paths.dataDir, "synthetic.md"), "Existing file", "utf8");
    expect(await service.invoke(IPC_CHANNELS.EXPORT_IDEAS, [{ threadId: "synthetic-thread", format: "markdown" }], { exportTarget: "dialog" }))
      .toEqual({ cancelled: false, directory: paths.dataDir, files: ["synthetic-2.md", "synthetic-3.md"] });
    expect(readFileSync(join(paths.dataDir, "synthetic.md"), "utf8")).toBe("Existing file");
    expect(readFileSync(join(paths.dataDir, "synthetic-3.md"), "utf8")).toBe("# Second idea\n");
    cancelled = true;
    expect(await service.invoke(IPC_CHANNELS.EXPORT_IDEAS, [{ threadId: "synthetic-thread" }], { exportTarget: "dialog" })).toEqual({ cancelled: true, files: [] });
    files.splice(0, files.length, { filename: "synthetic.json", content: '[{"title":"Synthetic first"}]' }, { filename: "second.json", content: '{"title":"Synthetic second"}' });
    const json = z.object({ downloads: z.array(z.object({ content: z.string() })) }).parse(await service.invoke(IPC_CHANNELS.EXPORT_IDEAS, [{ threadId: "synthetic-thread", format: "json" }], { exportTarget: "download" }));
    expect(JSON.parse(json.downloads[0]!.content)).toEqual([{ title: "Synthetic first" }, { title: "Synthetic second" }]);
  });
});
