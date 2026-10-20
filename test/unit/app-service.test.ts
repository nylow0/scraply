import { describe, expect, spyOn, test } from "bun:test";
import { createAppService } from "../../src/app/service";
import { createBackendClient } from "../../src/app/backend-client";
import type { AppBackend, AppBackendStart, BackendClientOptions } from "../../src/app/service-contracts";
import type { BackendSecrets, MainToBackendMessage } from "../../src/shared/backend-process";
import { IPC_CHANNELS } from "../../src/shared/ipc";
import { AppError } from "../../src/shared/errors";
import { APP_CHANNELS, OperationProposalSchema, SearchKeyCredentialReferenceSchema } from "../../src/shared/cli-contracts";

const paths = { dataDir: "synthetic", dbPath: "synthetic/db", logsDir: "synthetic/logs", bundledPromptsDir: "prompts", promptOverridesDir: "synthetic/prompts" };
const emptySecrets = (): BackendSecrets => ({ exaApiKey: null, perplexityApiKey: null, providerCredentials: {} });
const validation = { setupComplete: true, exa: { valid: true }, perplexity: { valid: true },
  native: { available: true, connected: true, accounts: [], version: "synthetic-v1" } };
const idleActivity = { active: false, engineActive: false, activeRunIds: [], workflows: [], activeModelCalls: 0,
  pendingModelCalls: 0, activeProjectIds: [], pendingPosts: 0, stopping: false, searchKeyUpdatePending: false };
const launch = { loginId: "synthetic-login", providerId: "openai-subscription", method: "browser", authorizationUrl: "https://example.com/authorize", callbackPort: 6789 };

function harness() {
  const requests: string[] = [];
  const updates: Array<{ secrets: BackendSecrets; onlyWhenIdle: boolean }> = [];
  const finishes: Array<BackendSecrets | undefined> = [];
  const saved: BackendSecrets[] = [];
  const startInputs: AppBackendStart[] = [];
  let ready = false;
  let starts = 0;
  let loadFailure = false;
  let saveFailure = false;
  let reserveFailure = false;
  let stored = emptySecrets();
  let request: (path: string, init?: RequestInit) => Promise<unknown> = async (path) => {
    if (path === "/search-keys/preflight") return { valid: true };
    if (path === "/validation") return validation;
    if (path === "/app/provider-status") return validation;
    if (path === "/app/activity") return idleActivity;
    if (path === "/native/login/start") return launch;
    return { synthetic: true };
  };
  const backend: AppBackend = {
    async start(input) { ready = true; starts += 1; startInputs.push(input); },
    isReady: () => ready,
    async request(path, init) { requests.push(path); return request(path, init); },
    async updateSecrets(secrets, onlyWhenIdle = false) {
      if (reserveFailure) throw new AppError("conflict", "Synthetic active research");
      updates.push({ secrets: structuredClone(secrets), onlyWhenIdle });
    },
    async finishSearchKeyUpdate(previous) { finishes.push(previous); },
    stop() { ready = false; },
  };
  const store = {
    load() { if (loadFailure) throw new Error("Synthetic unreadable storage"); return structuredClone(stored); },
    async save(next: BackendSecrets, beforeWrite?: () => void) {
      beforeWrite?.();
      if (saveFailure) throw new Error("Synthetic write failure");
      saved.push(structuredClone(next));
      stored = structuredClone(next);
      return structuredClone(next);
    },
  };
  const service = createAppService({ paths, appVersion: "test", credentialStore: store, backend, automaticSecrets: { environment: { EXA_API_KEY: "", PERPLEXITY_API_KEY: "" } } });
  return {
    service, backend, store, requests, updates, finishes, saved, startInputs,
    get starts() { return starts; },
    request(value: typeof request) { request = value; },
    failLoad(value: boolean) { loadFailure = value; },
    failSave(value: boolean) { saveFailure = value; },
    failReservation(value: boolean) { reserveFailure = value; },
  };
}

describe("portable app service", () => {
  test.each(["complete", "cancel"] as const)("matching sign-in cancellation overlaps completion and holds key exclusion until %s settles last", async last => {
    const h = harness();
    let enterComplete!: () => void; let releaseComplete!: () => void;
    let enterCancel!: () => void; let releaseCancel!: () => void;
    const completeEntered = new Promise<void>(resolve => { enterComplete = resolve; });
    const completeWaiting = new Promise<void>(resolve => { releaseComplete = resolve; });
    const cancelEntered = new Promise<void>(resolve => { enterCancel = resolve; });
    const cancelWaiting = new Promise<void>(resolve => { releaseCancel = resolve; });
    h.request(async path => {
      if (path === "/native/login/start") return launch;
      if (path === "/native/login/complete") { enterComplete(); await completeWaiting; return { pending: true }; }
      if (path === "/native/login/cancel") { enterCancel(); await cancelWaiting; return { synthetic: true }; }
      return path === "/validation" ? validation : { valid: true };
    });
    await h.service.invoke(IPC_CHANNELS.NATIVE_LOGIN_START, [{ providerId: launch.providerId, method: "browser" }]);
    const completing = h.service.invoke(IPC_CHANNELS.NATIVE_LOGIN_COMPLETE, [{ loginId: launch.loginId }]);
    await completeEntered;
    await expect(h.service.invoke(IPC_CHANNELS.NATIVE_LOGIN_CANCEL, [{ providerId: launch.providerId, loginId: "different-login" }]))
      .rejects.toMatchObject({ code: "conflict" });
    const cancelling = h.service.invoke(IPC_CHANNELS.NATIVE_LOGIN_CANCEL, [{ providerId: launch.providerId, loginId: launch.loginId }]);
    try {
      expect(await Promise.race([cancelEntered.then(() => true), cancelling.then(() => false, () => false)])).toBe(true);
      for (const [channel, payload] of [
        [IPC_CHANNELS.NATIVE_LOGIN_START, { providerId: launch.providerId, method: "browser" }],
        [IPC_CHANNELS.NATIVE_LOGIN_COMPLETE, { loginId: launch.loginId }],
        [IPC_CHANNELS.NATIVE_LOGIN_CANCEL, { providerId: launch.providerId, loginId: launch.loginId }],
        [IPC_CHANNELS.NATIVE_ACCOUNT_REFRESH, { providerId: launch.providerId }],
        [IPC_CHANNELS.NATIVE_LOGOUT, { providerId: launch.providerId }],
        [IPC_CHANNELS.RETRY_CONNECTION, {}],
      ] as const) {
        await expect(h.service.invoke(channel, [payload])).rejects.toMatchObject({ code: "conflict" });
      }
      expect(await h.service.invoke(IPC_CHANNELS.SAVE_SEARCH_KEY, [{ provider: "exa", apiKey: "synthetic-blocked-key" }]))
        .toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await h.service.invoke(IPC_CHANNELS.REMOVE_SEARCH_KEY, [{ provider: "exa" }]))
        .toMatchObject({ ok: false, error: { code: "conflict" } });
      if (last === "complete") { releaseCancel(); await cancelling; }
      else { releaseComplete(); await completing; }
      expect(await h.service.invoke(IPC_CHANNELS.SAVE_SEARCH_KEY, [{ provider: "exa", apiKey: "synthetic-still-blocked-key" }]))
        .toMatchObject({ ok: false, error: { code: "conflict" } });
      await expect(h.service.invoke(IPC_CHANNELS.NATIVE_LOGIN_CANCEL, [{ providerId: launch.providerId, loginId: launch.loginId }]))
        .rejects.toMatchObject({ code: "conflict" });
      expect(h.requests).toEqual(["/native/login/start", "/native/login/complete", "/native/login/cancel"]);
    } finally {
      releaseComplete(); releaseCancel();
      await Promise.allSettled([completing, cancelling]);
    }
    expect(await h.service.invoke(IPC_CHANNELS.SAVE_SEARCH_KEY, [{ provider: "exa", apiKey: "synthetic-after-cancel-key" }]))
      .toMatchObject({ ok: true });
  });

  test("all user account mutations reject during a key probe before disk or revocation changes", async () => {
    const h = harness();
    let entered!: () => void; let release!: () => void;
    const probing = new Promise<void>(resolve => { entered = resolve; });
    const waiting = new Promise<void>(resolve => { release = resolve; });
    h.request(async path => {
      if (path === "/search-keys/preflight") { entered(); await waiting; return { valid: true }; }
      return path === "/validation" ? validation : { synthetic: true };
    });
    await h.service.persistProviderCredential("openai-subscription", "synthetic-original-account");
    const pending = h.service.invoke(IPC_CHANNELS.SAVE_SEARCH_KEY, [{ provider: "exa", apiKey: "synthetic-concurrent-key" }]);
    try {
      await probing;
      for (const [channel, payload] of [
        [IPC_CHANNELS.NATIVE_LOGIN_START, { providerId: "openai-subscription", method: "browser" }],
        [IPC_CHANNELS.NATIVE_LOGIN_COMPLETE, { loginId: "synthetic-login" }],
        [IPC_CHANNELS.NATIVE_LOGIN_CANCEL, { providerId: "openai-subscription", loginId: "synthetic-login" }],
        [IPC_CHANNELS.NATIVE_ACCOUNT_REFRESH, { providerId: "openai-subscription" }],
        [IPC_CHANNELS.NATIVE_LOGOUT, { providerId: "openai-subscription" }],
        [IPC_CHANNELS.RETRY_CONNECTION, {}],
      ] as const) {
        await expect(h.service.invoke(channel, [payload])).rejects.toMatchObject({ code: "conflict" });
      }
      expect(h.saved).toHaveLength(1);
      expect(h.requests).toEqual(["/search-keys/preflight"]);
      await h.service.persistProviderCredential("openai-subscription", "synthetic-rotated-account");
    } finally { release(); }
    expect(await pending).toMatchObject({ ok: true });
    expect(h.service.getSecrets().providerCredentials).toEqual({ "openai-subscription": "synthetic-rotated-account" });
  });

  test("an already admitted logout prevents a key mutation from starting a probe", async () => {
    const h = harness();
    let entered!: () => void; let release!: () => void;
    const revoking = new Promise<void>(resolve => { entered = resolve; });
    const waiting = new Promise<void>(resolve => { release = resolve; });
    h.request(async path => { if (path === "/native/logout") { entered(); await waiting; } return { synthetic: true }; });
    await h.service.persistProviderCredential("openai-subscription", "synthetic-original-account");
    const logout = h.service.invoke(IPC_CHANNELS.NATIVE_LOGOUT, [{ providerId: "openai-subscription" }]);
    try {
      await revoking;
      expect(await h.service.invoke(IPC_CHANNELS.SAVE_SEARCH_KEY, [{ provider: "exa", apiKey: "synthetic-rejected-key" }]))
        .toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(h.requests).toEqual(["/native/logout"]);
    } finally { release(); }
    await logout;
    expect(h.service.getSecrets().providerCredentials).toEqual({});
  });

  test("lazy backend errors retain newer-schema code, status, reference and update recovery", async () => {
    const h = harness();
    const failure = new AppError("conflict", "This database needs a newer Scraply version.", 409, "synthetic-schema-reference",
      { action: "update", schemaVersion: 999999, version: "9.9.9" });
    h.backend.start = async () => { throw failure; };
    await expect(h.service.invokeRemote(IPC_CHANNELS.GET_WORKSPACE)).rejects.toBe(failure);
    expect(h.requests).toEqual([]);
  });

  test("CLI startup defers automatic key validation while explicit validation and GUI startup keep their behavior", async () => {
    const h = harness();
    const service = createAppService({ paths, appVersion: "test", backend: h.backend, credentialStore: h.store,
      automaticSecrets: { environment: { EXA_API_KEY: "synthetic-env-key", PERPLEXITY_API_KEY: "" } },
    });
    await service.start({ validateAutomaticSecrets: false });
    expect(h.requests).toEqual([]); expect(h.saved).toEqual([]);
    expect(h.startInputs[0]?.validateAutomaticSecrets).toBe(false);
    expect(h.startInputs[0]?.secrets.exaApiKey).toBe("synthetic-env-key");
    await service.invoke(IPC_CHANNELS.GET_WORKSPACE);
    expect(h.requests).toEqual(["/workspace"]);
    await service.invoke(IPC_CHANNELS.GET_VALIDATION);
    expect(h.requests).toEqual(["/workspace", "/validation"]);
    expect(h.saved).toEqual([]);
    await service.start();
    expect(h.requests).toEqual(["/workspace", "/validation", "/validation"]);
    expect(h.saved).toHaveLength(1);
    expect(h.startInputs.at(-1)?.validateAutomaticSecrets).toBe(true);
  });

  test("logger secretValues never initializes or decrypts credentials for an attached client", () => {
    const h = harness();
    let reads = 0;
    const service = createAppService({ paths, appVersion: "test", backend: h.backend,
      credentialStore: { ...h.store, load() { reads += 1; throw new Error("Synthetic unavailable encryption"); } },
      automaticSecrets: { environment: { EXA_API_KEY: "", PERPLEXITY_API_KEY: "" } },
    });
    expect(service.secretValues()).toEqual([]);
    expect(reads).toBe(0);
    service.initialize();
    expect(reads).toBe(1);
  });

  test("covers every request channel and loads credentials without starting work", () => {
    const h = harness();
    // These two channels are outbound local menu/event notifications, never requests.
    const notifications: string[] = [IPC_CHANNELS.APP_COMMAND, IPC_CHANNELS.BACKEND_EVENT];
    expect([...h.service.handlers.keys()].sort()).toEqual([
      ...Object.values(IPC_CHANNELS).filter(channel => !notifications.includes(channel)), ...Object.values(APP_CHANNELS),
    ].sort());
    h.service.initialize(); h.service.initialize();
    expect(h.starts).toBe(0);
    expect(h.requests).toEqual([]);
    expect(h.saved).toEqual([]);
  });

  test("preserves boxed workflow errors and plain legacy errors without dispatching invalid input", async () => {
    const h = harness();
    expect(await h.service.invoke(IPC_CHANNELS.START_WORKFLOW, [{}])).toMatchObject({ ok: false, error: { code: "validation_error" } });
    await expect(h.service.invoke(IPC_CHANNELS.SELECT_THREAD, [{}])).rejects.toThrow();
    await expect(h.service.invoke("synthetic:missing")).rejects.toMatchObject({ code: "not_found" });
    expect(h.requests).toEqual([]);
    h.request(async () => { throw new AppError("conflict", "Synthetic conflict"); });
    await expect(h.service.invoke(IPC_CHANNELS.GET_WORKSPACE)).rejects.toMatchObject({ code: "conflict" });
  });

  test("remote invocation returns login URLs and paths without opening local UI", async () => {
    const h = harness();
    const opened: string[] = [];
    const service = createAppService({ paths, appVersion: "test", credentialStore: h.store, backend: h.backend,
      automaticSecrets: { environment: { EXA_API_KEY: "", PERPLEXITY_API_KEY: "" } },
      async openExternal(url) { opened.push(url); }, async revealPath(path) { opened.push(path); },
    });
    expect(await service.invoke(IPC_CHANNELS.NATIVE_LOGIN_START, [{ providerId: "openai-subscription", method: "browser" }])).toEqual(launch);
    expect(await service.invoke(IPC_CHANNELS.OPEN_DATA_FOLDER)).toEqual({ path: paths.dataDir });
    expect(await service.invoke(IPC_CHANNELS.OPEN_EXTERNAL_URL, [{ url: "https://example.com" }])).toEqual({ url: "https://example.com/" });
    expect(opened).toEqual([]);
    const local = service.createHandlers({ openBrowser: true, revealPaths: true });
    expect(await local.get(IPC_CHANNELS.NATIVE_LOGIN_START)?.({ providerId: "openai-subscription", method: "browser" })).toEqual({ loginId: launch.loginId, providerId: launch.providerId, method: "browser" });
    await local.get(IPC_CHANNELS.OPEN_DATA_FOLDER)?.();
    expect(opened).toEqual([launch.authorizationUrl, paths.dataDir]);
    await expect(service.invoke(IPC_CHANNELS.OPEN_EXTERNAL_URL, [{ url: "http://localhost" }])).rejects.toMatchObject({ code: "validation_error" });
  });

  test.each(["exa", "perplexity"] as const)("saves and removes %s keys inside the idle reservation", async provider => {
    const h = harness();
    expect(await h.service.invoke(IPC_CHANNELS.SAVE_SEARCH_KEY, [{ provider, apiKey: "synthetic-search-key" }])).toEqual({ ok: true, data: { synthetic: true } });
    expect(h.requests).toEqual(["/search-keys/preflight", "/validation", "/workspace"]);
    expect(h.updates[0]?.onlyWhenIdle).toBe(true);
    expect(h.saved).toHaveLength(1);
    expect(h.finishes).toEqual([undefined]);
    expect(await h.service.invoke(IPC_CHANNELS.REMOVE_SEARCH_KEY, [{ provider }])).toMatchObject({ ok: true });
    expect(h.service.getSecrets()[provider === "exa" ? "exaApiKey" : "perplexityApiKey"]).toBeNull();
    expect(h.requests.filter(path => path === "/validation")).toHaveLength(1);
  });

  test("rejected keys and active-work conflicts leave storage unchanged", async () => {
    const h = harness();
    h.request(async () => ({ valid: false, error: "Synthetic rejected key" }));
    expect(await h.service.invoke(IPC_CHANNELS.SAVE_SEARCH_KEY, [{ provider: "exa", apiKey: "synthetic-key" }])).toMatchObject({ ok: false, error: { code: "validation_error" } });
    expect(h.updates).toEqual([]); expect(h.saved).toEqual([]);
    h.request(async () => ({ valid: true })); h.failReservation(true);
    expect(await h.service.invoke(IPC_CHANNELS.REMOVE_SEARCH_KEY, [{ provider: "exa" }])).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(h.saved).toEqual([]);
  });

  test("a failed encrypted write restores backend secrets and releases the reservation", async () => {
    const h = harness(); h.failSave(true);
    expect(await h.service.invoke(IPC_CHANNELS.SAVE_SEARCH_KEY, [{ provider: "exa", apiKey: "synthetic-key" }])).toMatchObject({ ok: false });
    expect(h.finishes).toEqual([emptySecrets()]);
    expect(h.service.getSecrets()).toEqual(emptySecrets());
    h.failSave(false);
    expect(await h.service.invoke(IPC_CHANNELS.SAVE_SEARCH_KEY, [{ provider: "exa", apiKey: "synthetic-key" }])).toMatchObject({ ok: true });
  });

  test("overlapping key mutations fail before a second preflight or encrypted write", async () => {
    const h = harness();
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    h.request(async path => {
      if (path === "/search-keys/preflight") { await waiting; return { valid: true }; }
      return path === "/validation" ? validation : { synthetic: true };
    });
    const first = h.service.invoke(IPC_CHANNELS.SAVE_SEARCH_KEY, [{ provider: "exa", apiKey: "synthetic-key" }]);
    expect(await h.service.invoke(IPC_CHANNELS.REMOVE_SEARCH_KEY, [{ provider: "perplexity" }])).toMatchObject({ ok: false, error: { code: "conflict" } });
    release();
    expect(await first).toMatchObject({ ok: true });
    expect(h.requests.filter(path => path === "/search-keys/preflight")).toHaveLength(1);
    expect(h.saved).toHaveLength(1);
  });

  test("environment overrides block key edits before a preflight or write", async () => {
    const h = harness();
    const service = createAppService({ paths, appVersion: "test", credentialStore: h.store, backend: h.backend,
      automaticSecrets: { environment: { EXA_API_KEY: "synthetic-env-key", PERPLEXITY_API_KEY: "" } },
    });
    expect(service.getSecrets().exaApiKey).toBe("synthetic-env-key");
    expect(await service.invoke(IPC_CHANNELS.REMOVE_SEARCH_KEY, [{ provider: "exa" }])).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(h.requests).toEqual([]); expect(h.saved).toEqual([]);
  });

  test("retry reloads failed credentials and restores the native connection", async () => {
    const h = harness(); h.failLoad(true);
    await expect(h.service.start()).rejects.toThrow("Synthetic unreadable storage");
    expect(h.starts).toBe(0);
    h.failLoad(false);
    await h.service.invoke(IPC_CHANNELS.RETRY_CONNECTION);
    expect(h.requests).toEqual(["/validation", "/native/retry"]);
    expect(h.saved).toHaveLength(1);
  });

  test.each([IPC_CHANNELS.NATIVE_LOGOUT, IPC_CHANNELS.NATIVE_LOGIN_CANCEL])("%s revokes runtime access even after persistence failure and blocks late saves", async channel => {
    const h = harness(); h.service.initialize();
    await h.service.invoke(IPC_CHANNELS.NATIVE_LOGIN_START, [{ providerId: "openai-subscription", method: "browser" }]);
    await h.service.persistProviderCredential("openai-subscription", "synthetic-credential");
    h.failSave(true);
    const input = channel === IPC_CHANNELS.NATIVE_LOGOUT ? { providerId: "openai-subscription" }
      : { providerId: "openai-subscription", loginId: "synthetic-login" };
    await expect(h.service.invoke(channel, [input])).rejects.toThrow("Synthetic write failure");
    expect(h.requests).toContain(channel === IPC_CHANNELS.NATIVE_LOGOUT ? "/native/logout" : "/native/login/cancel");
    expect(h.service.getSecrets().providerCredentials).toEqual({});
    await expect(h.service.persistProviderCredential("openai-subscription", "synthetic-late-credential")).rejects.toThrow("signed out");
    h.failSave(false);
    await h.service.invoke(IPC_CHANNELS.NATIVE_LOGIN_START, [{ providerId: "openai-subscription", method: "browser" }]);
    await h.service.persistProviderCredential("openai-subscription", "synthetic-new-credential");
    expect(h.service.getSecrets().providerCredentials["openai-subscription"]).toBe("synthetic-new-credential");
  });
});

describe("service-owned provider billing", () => {
  test.each([IPC_CHANNELS.GET_VALIDATION, IPC_CHANNELS.RETRY_CONNECTION, IPC_CHANNELS.SAVE_SEARCH_KEY])("remote %s cannot probe without confirmation", async channel => {
    const h = harness();
    await expect(h.service.invokeRemote(channel, channel === IPC_CHANNELS.SAVE_SEARCH_KEY
      ? { provider: "exa", apiKey: "synthetic-private-key" } : {})).rejects.toMatchObject({ code: "conflict", recovery: { action: "preview", channel } });
    expect(h.requests).toEqual([]); expect(h.updates).toEqual([]); expect(h.saved).toEqual([]);
  });

  test("key previews contain only an opaque reference and replacement invalidates the old candidate", async () => {
    const h = harness();
    const preview = async (apiKey: string) => OperationProposalSchema.parse(await h.service.invokeRemote(APP_CHANNELS.PREVIEW_OPERATION,
      { channel: IPC_CHANNELS.SAVE_SEARCH_KEY, payload: { provider: "exa", apiKey } }));
    const first = await preview("synthetic-private-key-first");
    expect(SearchKeyCredentialReferenceSchema.parse(first.operation.payload).provider).toBe("exa");
    expect(JSON.stringify(first)).not.toContain("synthetic-private-key-first");
    expect(JSON.stringify(first)).not.toContain("apiKey");
    const replacement = await preview("synthetic-private-key-second");
    expect(JSON.stringify(replacement)).not.toContain("synthetic-private-key-second");
    await expect(h.service.invokeRemote(APP_CHANNELS.EXECUTE_OPERATION, { proposal: first })).rejects.toMatchObject({ code: "PREVIEW_STALE" });
    expect(h.requests.every(path => ["/app/provider-status", "/app/activity"].includes(path))).toBe(true);
    expect(h.saved).toEqual([]);
    await h.service.stop();
  });

  test("validation proposals use the existing expiry/signature and are consumed once", async () => {
    const h = harness();
    const proposal = OperationProposalSchema.parse(await h.service.invokeRemote(APP_CHANNELS.PREVIEW_OPERATION,
      { channel: IPC_CHANNELS.GET_VALIDATION, payload: {} }));
    expect(h.requests).toEqual(["/app/provider-status"]);
    await expect(h.service.invokeRemote(APP_CHANNELS.EXECUTE_OPERATION, { proposal: { ...proposal, summary: "tampered" } })).rejects.toMatchObject({ code: "PREVIEW_STALE" });
    expect(await h.service.invokeRemote(APP_CHANNELS.EXECUTE_OPERATION, { proposal })).toEqual({ channel: IPC_CHANNELS.GET_VALIDATION, result: validation });
    await expect(h.service.invokeRemote(APP_CHANNELS.EXECUTE_OPERATION, { proposal })).rejects.toMatchObject({ code: "PREVIEW_STALE" });
    expect(h.requests.filter(path => path === "/validation")).toHaveLength(1);
  });

  test("expired key proof cannot probe or write", async () => {
    const h = harness();
    const proposal = OperationProposalSchema.parse(await h.service.invokeRemote(APP_CHANNELS.PREVIEW_OPERATION,
      { channel: IPC_CHANNELS.SAVE_SEARCH_KEY, payload: { provider: "exa", apiKey: "synthetic-expiring-key" } }));
    const clock = spyOn(Date, "now").mockReturnValue(Date.parse(proposal.expiresAt) + 1);
    try {
      await expect(h.service.invokeRemote(APP_CHANNELS.EXECUTE_OPERATION, { proposal })).rejects.toMatchObject({ code: "PREVIEW_STALE" });
      expect(h.requests.every(path => ["/app/provider-status", "/app/activity"].includes(path))).toBe(true);
      expect(h.saved).toEqual([]);
    } finally { clock.mockRestore(); await h.service.stop(); }
  });

  test("credential and capability changes invalidate consent before a provider call", async () => {
    const h = harness();
    const proposal = OperationProposalSchema.parse(await h.service.invokeRemote(APP_CHANNELS.PREVIEW_OPERATION,
      { channel: IPC_CHANNELS.GET_VALIDATION, payload: {} }));
    await h.service.persistProviderCredential("openai-subscription", "synthetic-rotated-credential");
    await expect(h.service.invokeRemote(APP_CHANNELS.EXECUTE_OPERATION, { proposal })).rejects.toMatchObject({ code: "PREVIEW_STALE" });
    const fresh = OperationProposalSchema.parse(await h.service.invokeRemote(APP_CHANNELS.PREVIEW_OPERATION,
      { channel: IPC_CHANNELS.GET_VALIDATION, payload: {} }));
    h.request(async () => ({ ...validation, native: { ...validation.native, version: "synthetic-v2" } }));
    await expect(h.service.invokeRemote(APP_CHANNELS.EXECUTE_OPERATION, { proposal: fresh })).rejects.toMatchObject({ code: "PREVIEW_STALE" });
    expect(h.requests.filter(path => path === "/validation")).toEqual([]);
  });

  test("environment-owned and active-run key conflicts surface before any probe or write", async () => {
    const h = harness();
    const service = createAppService({ paths, appVersion: "test", credentialStore: h.store, backend: h.backend,
      automaticSecrets: { environment: { EXA_API_KEY: "synthetic-env-key", PERPLEXITY_API_KEY: "" } } });
    await expect(service.invokeRemote(APP_CHANNELS.PREVIEW_OPERATION, { channel: IPC_CHANNELS.SAVE_SEARCH_KEY,
      payload: { provider: "exa", apiKey: "synthetic-replacement" } })).rejects.toMatchObject({ code: "conflict" });
    h.request(async path => path === "/app/provider-status" ? validation : { ...idleActivity, active: true });
    await expect(h.service.invokeRemote(APP_CHANNELS.PREVIEW_OPERATION, { channel: IPC_CHANNELS.SAVE_SEARCH_KEY,
      payload: { provider: "exa", apiKey: "synthetic-replacement" } })).rejects.toMatchObject({ code: "conflict" });
    expect(h.requests.every(path => ["/app/provider-status", "/app/activity"].includes(path))).toBe(true);
    expect(h.updates).toEqual([]); expect(h.saved).toEqual([]);
  });

  test("rejected candidate is consumed, redacted and rolled back without saving", async () => {
    const h = harness();
    const apiKey = "synthetic-rejected-private-key";
    h.request(async path => {
      if (path === "/app/provider-status") return validation;
      if (path === "/app/activity") return idleActivity;
      return { valid: false, error: `Synthetic rejection of ${apiKey}` };
    });
    const proposal = OperationProposalSchema.parse(await h.service.invokeRemote(APP_CHANNELS.PREVIEW_OPERATION,
      { channel: IPC_CHANNELS.SAVE_SEARCH_KEY, payload: { provider: "exa", apiKey } }));
    let failure: unknown;
    try { await h.service.invokeRemote(APP_CHANNELS.EXECUTE_OPERATION, { proposal }); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AppError);
    expect(String(failure)).not.toContain(apiKey);
    expect(String(failure)).toContain("[redacted]");
    expect(h.saved).toEqual([]); expect(h.finishes).toEqual([emptySecrets()]);
    await expect(h.service.invokeRemote(APP_CHANNELS.EXECUTE_OPERATION, { proposal })).rejects.toMatchObject({ code: "PREVIEW_STALE" });
    expect(h.requests.filter(path => path === "/search-keys/validate-reserved")).toHaveLength(1);
  });
});

describe("message backend client", () => {
  test("replaces a failed process before starting another and ignores its stale exit", async () => {
    let currentHooks: Parameters<BackendClientOptions["launch"]>[1] | undefined;
    let running = false;
    const actions: string[] = [];
    const backend = createBackendClient({
      async launch(_input, hooks) { currentHooks = hooks; running = true; actions.push("launch"); return { port: 1, token: "synthetic" }; },
      postMessage() {}, hasProcess: () => running,
      stop() { running = false; actions.push("stop"); },
    });
    const input: AppBackendStart = { paths, appVersion: "test", secrets: emptySecrets(), async persistProviderCredential() {}, publishEvent() {} };
    await backend.start(input);
    const staleHooks = currentHooks;
    staleHooks?.unavailable("Synthetic process error");
    await backend.start(input);
    expect(actions).toEqual(["launch", "stop", "launch"]);
    staleHooks?.unavailable("Synthetic stale exit");
    expect(backend.isReady()).toBe(true);
    await backend.stop();
  });

  test("waits for process exit before replacement or completed shutdown", async () => {
    let releaseExit: (() => void) | undefined;
    let hooks: Parameters<BackendClientOptions["launch"]>[1] | undefined;
    let running = false;
    let launches = 0;
    const backend = createBackendClient({
      async launch(_input, callbacks) {
        hooks = callbacks; running = true; launches += 1;
        return { port: 1, token: "synthetic" };
      },
      postMessage() {}, hasProcess: () => running,
      async stop() {
        await new Promise<void>(resolve => { releaseExit = resolve; });
        running = false;
      },
    });
    const input: AppBackendStart = { paths, appVersion: "test", secrets: emptySecrets(), async persistProviderCredential() {}, publishEvent() {} };
    await backend.start(input);
    hooks?.unavailable("Synthetic process failure");
    const replacement = backend.start(input);
    await Promise.resolve();
    expect(launches).toBe(1);
    expect(running).toBe(true);
    releaseExit?.();
    await replacement;
    expect(launches).toBe(2);
    let stopped = false;
    const shutdown = Promise.resolve(backend.stop()).then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(running).toBe(true);
    releaseExit?.();
    await shutdown;
    expect(running).toBe(false);
  });

  test("acknowledges secret updates, preserves conflicts and rejects pending work on backend exit", async () => {
    let hooks: Parameters<BackendClientOptions["launch"]>[1] | undefined;
    const messages: MainToBackendMessage[] = [];
    let launches = 0;
    const backend = createBackendClient({
      async launch(_input, callbacks) { launches += 1; hooks = callbacks; return { port: 1, token: "synthetic" }; },
      postMessage(message) { messages.push(message); }, hasProcess: () => true, stop() {},
    });
    const input: AppBackendStart = { paths, appVersion: "test", secrets: emptySecrets(), async persistProviderCredential() {}, publishEvent() {} };
    await Promise.all([backend.start(input), backend.start(input)]);
    expect(launches).toBe(1);
    const updating = backend.updateSecrets(emptySecrets(), true);
    const first = messages[0];
    if (first?.type !== "update-secrets") throw new Error("Missing update");
    hooks?.secretsUpdated(first.requestId, "Synthetic active work");
    await expect(updating).rejects.toMatchObject({ code: "conflict" });
    const finishing = backend.finishSearchKeyUpdate();
    const second = messages[1];
    if (second?.type !== "finish-search-key-update") throw new Error("Missing finish");
    hooks?.secretsUpdated(second.requestId);
    await finishing;
    const pending = backend.updateSecrets(emptySecrets());
    hooks?.unavailable("Synthetic backend exit");
    await expect(pending).rejects.toMatchObject({ code: "backend_unavailable" });
    expect(backend.isReady()).toBe(false);
  });
});
