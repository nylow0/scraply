import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createAppService } from "../../src/app/service";
import type { AppBackend } from "../../src/app/service-contracts";
import { inspectNativeRuntime, startBackend, type BackendHandle } from "../../src/backend/server";
import { DatabaseClient } from "../../src/db/client";
import { createCredentialStore } from "../../src/main/credential-store";
import type { RuntimeClient } from "../../src/providers/runtime";
import { ProviderFailure } from "../../src/providers/structured";
import { IPC_CHANNELS, NativeLoginLaunchSchema, WorkspaceStateSchema } from "../../src/shared/ipc";
import { startNativeWorkflowBackend } from "../fixtures/native-workflow-backend";

const directories: string[] = [];
const handles: BackendHandle[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  for (const directory of directories.splice(0)) {
    try { rmSync(directory, { recursive: true, force: true }); }
    catch { /* Bun can retain a SQLite handle briefly on Windows. */ }
  }
});

describe("native account safety", () => {
  test("returns settled native capabilities after cancelling and replacing an expired session without search probes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "scraply-native-cancel-status-"));
    directories.push(directory);
    const probes: unknown[] = [];
    const handle = await startNativeWorkflowBackend(directory, {
      mode: "workflow-auth", authRecovery: true, onProviderProbe: probe => { probes.push(probe); },
    });
    handles.push(handle);
    // Establish the expired session through fixture validation. All later reads and
    // account actions must leave the configured search key unprobed.
    await fetch(`http://127.0.0.1:${handle.port}/validation`, {
      headers: { authorization: `Bearer ${handle.token}` },
    });
    const probeCount = probes.length;
    expect(probeCount).toBeGreaterThan(0);
    const started = await request(handle, "/native/login/start", { providerId: "openai-subscription", method: "device" });
    expect(started.status).toBe(200);
    const login = NativeLoginLaunchSchema.parse(started.data);
    expect((await request(handle, "/native/login/complete", { loginId: login.loginId })).data).toEqual({ pending: true });
    const cancelled = await request(handle, "/native/login/cancel", { loginId: login.loginId, providerId: "openai-subscription" });
    expect(cancelled.status).toBe(200);
    const signedOut = WorkspaceStateSchema.parse(cancelled.data);
    expect(signedOut.validation.native).toMatchObject({ available: true, connected: false, accounts: [] });
    expect(signedOut.validation.native.error).toBeUndefined();
    const readWorkspace = async () => {
      const response = await fetch(`http://127.0.0.1:${handle.port}/workspace`, {
        headers: { authorization: `Bearer ${handle.token}` },
      });
      const payload = await response.json() as { data: unknown };
      return WorkspaceStateSchema.parse(payload.data);
    };
    expect((await readWorkspace()).validation.native).toEqual(signedOut.validation.native);
    const replacement = await request(handle, "/native/login/start", { providerId: "openai-subscription", method: "browser" });
    const completed = await request(handle, "/native/login/complete", { loginId: NativeLoginLaunchSchema.parse(replacement.data).loginId });
    expect(completed.status).toBe(200);
    const connected = z.object({ pending: z.literal(false), workspace: WorkspaceStateSchema }).parse(completed.data).workspace;
    expect(connected.validation.native).toMatchObject({ available: true, connected: true });
    expect(connected.models).toContainEqual({ providerId: "openai-subscription", modelId: "gpt-fixture" });
    expect((await readWorkspace()).models).toEqual(connected.models);
    expect(probes).toHaveLength(probeCount);
  });

  test.each(["cancel-first", "complete-first"] as const)("cancels a consumed worker login during model inspection with %s settlement", async (order) => {
    const item = await nativeLoginService();
    const catalog = barrier();
    item.runtime.modelBarrier = catalog.waiting;
    const logout = barrier();
    const settled: string[] = [];
    let completion: Promise<unknown> | undefined;
    let cancellation: Promise<unknown> | undefined;
    try {
      const login = NativeLoginLaunchSchema.parse(await item.service.invoke(IPC_CHANNELS.NATIVE_LOGIN_START, [{ providerId: "openai-subscription", method: "browser" }]));
      completion = item.service.invoke(IPC_CHANNELS.NATIVE_LOGIN_COMPLETE, [{ loginId: login.loginId }])
        .then(result => { settled.push("complete"); return result; });
      await item.runtime.modelEntered;
      expect(item.runtime.pendingLogins.has(login.loginId)).toBe(false);
      expect(item.store.load().providerCredentials?.[login.providerId]).toBe("rotated-credential");
      if (order === "complete-first") item.runtime.logoutBarrier = logout.waiting;
      const cancelStartedAt = Date.now();
      cancellation = item.service.invoke(IPC_CHANNELS.NATIVE_LOGIN_CANCEL, [{ loginId: login.loginId, providerId: login.providerId }])
        .then(result => { settled.push("cancel"); return result; });
      await Promise.race([item.runtime.logoutEntered, cancellation]);
      expect(item.runtime.cancelCalls).toBe(1);
      expect(item.runtime.logoutCalls).toBe(1);
      if (order === "cancel-first") {
        expect(WorkspaceStateSchema.parse(await cancellation).validation.native).toMatchObject({ available: true, connected: false });
        expect(Date.now() - cancelStartedAt).toBeLessThan(2_000);
        catalog.release();
        const result = z.object({ pending: z.literal(false), workspace: WorkspaceStateSchema }).parse(await completion);
        expect(result.workspace.validation.native.connected).toBe(false);
        expect(settled).toEqual(["cancel", "complete"]);
      } else {
        catalog.release();
        const result = z.object({ pending: z.literal(false), workspace: WorkspaceStateSchema }).parse(await completion);
        expect(result.workspace.validation.native.connected).toBe(false);
        const duringLogout = WorkspaceStateSchema.parse(await item.service.invoke(IPC_CHANNELS.GET_WORKSPACE));
        expect(duringLogout.validation.native.connected).toBe(false);
        expect(duringLogout.models).toEqual([]);
        logout.release();
        expect(WorkspaceStateSchema.parse(await cancellation).validation.native).toMatchObject({ available: true, connected: false });
        expect(settled).toEqual(["complete", "cancel"]);
      }
      expect(item.runtime.loggedIn).toBe(false);
      expect(item.store.load().providerCredentials?.[login.providerId]).toBeUndefined();
      expect(WorkspaceStateSchema.parse(await item.service.invoke(IPC_CHANNELS.GET_WORKSPACE)).validation.native.connected).toBe(false);
      expect(item.probes).toEqual({ exa: 0, perplexity: 0 });
      // The held catalog is the only model request. Cancellation and passive reads add none.
      expect(item.runtime.modelCalls).toBe(1);
      expect(item.runtime.refreshCalls).toBe(0);
    } finally {
      catalog.release(); logout.release();
      await Promise.allSettled([completion, cancellation]);
    }
  });

  test("revokes the current login while the completion response is in flight", async () => {
    const item = await nativeLoginService();
    item.transport.holdCompletionResponse = true;
    let completion: Promise<unknown> | undefined;
    try {
      const login = NativeLoginLaunchSchema.parse(await item.service.invoke(IPC_CHANNELS.NATIVE_LOGIN_START, [{ providerId: "openai-subscription", method: "browser" }]));
      completion = item.service.invoke(IPC_CHANNELS.NATIVE_LOGIN_COMPLETE, [{ loginId: login.loginId }]);
      await item.responseEntered.waiting;
      expect(item.runtime.pendingLogins.has(login.loginId)).toBe(false);
      const startedAt = Date.now();
      const cancelled = WorkspaceStateSchema.parse(await item.service.invoke(IPC_CHANNELS.NATIVE_LOGIN_CANCEL, [{ loginId: login.loginId, providerId: login.providerId }]));
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(cancelled.validation.native).toMatchObject({ available: true, connected: false });
      expect(item.runtime.cancelCalls).toBe(1);
      expect(item.runtime.logoutCalls).toBe(1);
      item.responseGate.release();
      // The already-formed completion response can be stale. It must not republish
      // its capabilities or credential after the renderer discards that response.
      await completion;
      expect(item.runtime.loggedIn).toBe(false);
      expect(item.store.load().providerCredentials?.[login.providerId]).toBeUndefined();
      expect(WorkspaceStateSchema.parse(await item.service.invoke(IPC_CHANNELS.GET_WORKSPACE)).validation.native.connected).toBe(false);
      expect(item.probes).toEqual({ exa: 0, perplexity: 0 });
      expect(item.runtime.modelCalls).toBe(1);
    } finally {
      item.responseGate.release();
      await Promise.allSettled([completion]);
    }
  });

  test("an obsolete cancel preserves the replacement runtime session and saved credential", async () => {
    const item = await nativeLoginService();
    const first = NativeLoginLaunchSchema.parse(await item.service.invoke(IPC_CHANNELS.NATIVE_LOGIN_START, [{ providerId: "openai-subscription", method: "browser" }]));
    await item.service.invoke(IPC_CHANNELS.NATIVE_LOGIN_COMPLETE, [{ loginId: first.loginId }]);
    const replacement = NativeLoginLaunchSchema.parse(await item.service.invoke(IPC_CHANNELS.NATIVE_LOGIN_START, [{ providerId: "openai-subscription", method: "browser" }]));
    await item.service.invoke(IPC_CHANNELS.NATIVE_LOGIN_COMPLETE, [{ loginId: replacement.loginId }]);
    expect(replacement.loginId).not.toBe(first.loginId);
    const obsoleteCancel = { loginId: first.loginId, providerId: first.providerId };
    // Exercise the backend guard independently of the service's pre-write guard.
    const direct = WorkspaceStateSchema.parse(await item.backend.request("/native/login/cancel", {
      method: "POST", body: JSON.stringify(obsoleteCancel),
    }));
    expect(direct.validation.native.connected).toBe(true);
    await expect(item.service.invoke(IPC_CHANNELS.NATIVE_LOGIN_COMPLETE, [{ loginId: first.loginId }])).rejects.toMatchObject({ code: "conflict" });
    await item.service.invoke(IPC_CHANNELS.NATIVE_LOGIN_CANCEL, [obsoleteCancel]);
    expect(item.runtime.loggedIn).toBe(true);
    expect(item.runtime.cancelCalls).toBe(0);
    expect(item.runtime.logoutCalls).toBe(0);
    expect(item.store.load().providerCredentials?.[replacement.providerId]).toBe("rotated-credential");
    expect(WorkspaceStateSchema.parse(await item.service.invoke(IPC_CHANNELS.GET_WORKSPACE)).validation.native.connected).toBe(true);
    await item.service.persistProviderCredential(replacement.providerId, "synthetic-current-session-rotation");
    expect(item.store.load().providerCredentials?.[replacement.providerId]).toBe("synthetic-current-session-rotation");
    expect(item.probes).toEqual({ exa: 0, perplexity: 0 });
  });

  test("retries failed encrypted cancellation removal without restoring runtime access", async () => {
    const item = await nativeLoginService();
    const login = NativeLoginLaunchSchema.parse(await item.service.invoke(IPC_CHANNELS.NATIVE_LOGIN_START, [{ providerId: "openai-subscription", method: "browser" }]));
    await item.service.invoke(IPC_CHANNELS.NATIVE_LOGIN_COMPLETE, [{ loginId: login.loginId }]);
    item.failEncryptedWrites(true);
    await expect(item.service.invoke(IPC_CHANNELS.NATIVE_LOGIN_CANCEL, [{ loginId: login.loginId, providerId: login.providerId }]))
      .rejects.toThrow("Synthetic encrypted write failure");
    expect(item.store.load().providerCredentials?.[login.providerId]).toBe("rotated-credential");
    expect(item.service.getSecrets().providerCredentials?.[login.providerId]).toBeUndefined();
    expect(item.runtime.loggedIn).toBe(false);
    expect(item.runtime.logoutCalls).toBe(1);
    await expect(item.service.persistProviderCredential(login.providerId, "synthetic-late-rotation")).rejects.toThrow("signed out");

    item.failEncryptedWrites(false);
    const cancelled = WorkspaceStateSchema.parse(await item.service.invoke(IPC_CHANNELS.NATIVE_LOGIN_CANCEL, [{ loginId: login.loginId, providerId: login.providerId }]));
    expect(cancelled.validation.native).toMatchObject({ available: true, connected: false });
    expect(item.store.load().providerCredentials?.[login.providerId]).toBeUndefined();
    expect(item.runtime.loggedIn).toBe(false);
    expect(item.runtime.logoutCalls).toBe(1);
    expect(item.probes).toEqual({ exa: 0, perplexity: 0 });
  });

  test("refreshes an expired native session once before publishing provider validation", async () => {
    const runtime = new FakeRuntime();
    runtime.loggedIn = true;
    runtime.modelFailures.push(new ProviderFailure("auth", "provider request failed with HTTP 401", false, { runtimeCode: "authentication_failed" }));
    const persisted: string[] = [];
    const handle = await backend(runtime, async (_providerId: string, credential: string) => { persisted.push(credential); });

    const response = await fetch(`http://127.0.0.1:${handle.port}/validation`, {
      headers: { authorization: `Bearer ${handle.token}` },
    });
    const validation = await response.json() as { data: { native: { available: boolean; connected: boolean; error?: string }; setupComplete: boolean } };

    expect(validation.data.native).toMatchObject({ available: true, connected: true });
    expect(validation.data.native.error).toBeUndefined();
    expect(runtime.refreshCalls).toBe(1);
    // Startup validation performs the failed call plus its retry; the explicit
    // validation request may perform one cached-follow-up inspection.
    expect(runtime.modelCalls).toBe(3);
    expect(persisted).toEqual(["rotated-credential"]);
  });

  test("keeps saved credentials when an explicit refresh fails transiently", async () => {
    const runtime = new FakeRuntime();
    runtime.loggedIn = true;
    runtime.refreshError = new ProviderFailure("unavailable", "provider request could not be completed", true, { runtimeCode: "provider_unavailable" });
    let forgotten = 0;
    const handle = await backend(runtime, async () => undefined, () => { forgotten += 1; });

    const response = await request(handle, "/native/account/refresh", { providerId: "openai-subscription" });

    expect(response.status).toBe(500);
    expect(forgotten).toBe(0);
    expect(runtime.loggedIn).toBe(true);
  });

  test("logs out an automatically rotated session when encrypted persistence fails", async () => {
    const runtime = new FakeRuntime();
    runtime.loggedIn = true;
    runtime.modelFailures.push(new ProviderFailure("auth", "provider request failed with HTTP 401", false, { runtimeCode: "authentication_failed" }));
    let forgotten = 0;
    const handle = await backend(runtime, async () => { throw new Error("encrypted store unavailable"); }, () => { forgotten += 1; });

    const response = await fetch(`http://127.0.0.1:${handle.port}/validation`, {
      headers: { authorization: `Bearer ${handle.token}` },
    });
    const validation = await response.json() as { data: { native: { available: boolean; connected: boolean } } };

    expect(validation.data.native).toMatchObject({ available: true, connected: false });
    expect(runtime.refreshCalls).toBe(1);
    expect(runtime.logoutCalls).toBe(1);
    expect(forgotten).toBe(0);
    expect(runtime.loggedIn).toBe(false);
  });

  test("invalidates a permanently expired session after one bounded catalog recovery", async () => {
    const runtime = new FakeRuntime();
    runtime.loggedIn = true;
    runtime.modelFailures.push(
      new ProviderFailure("auth", "provider request failed with HTTP 401", false, { runtimeCode: "authentication_failed" }),
      new ProviderFailure("auth", "provider request failed with HTTP 401", false, { runtimeCode: "authentication_failed" }),
    );
    let forgotten = 0;
    const validation = await inspectNativeRuntime(
      runtime as unknown as RuntimeClient,
      undefined,
      { ready: true },
      async (providerId) => {
        try { return await runtime.refreshAccount(providerId, async () => undefined); }
        catch (error) {
          await runtime.logout();
          forgotten += 1;
          throw error;
        }
      },
      async () => {
        await runtime.logout();
        forgotten += 1;
      },
    );

    expect(validation).toMatchObject({ available: true, connected: false, error: "OpenAI rejected this session. Sign in again." });
    expect(runtime.refreshCalls).toBe(1);
    expect(runtime.logoutCalls).toBe(1);
    expect(forgotten).toBe(1);
  });

  test("serializes login behind an in-flight automatic refresh", async () => {
    const runtime = new FakeRuntime();
    runtime.loggedIn = true;
    runtime.modelFailures.push(new ProviderFailure("auth", "provider request failed with HTTP 401", false, { runtimeCode: "authentication_failed" }));
    let releaseRefresh!: () => void;
    runtime.refreshBarrier = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const handle = await backend(runtime);
    await runtime.refreshEntered;

    const login = request(handle, "/native/login/start", { providerId: "openai-subscription", method: "browser" });
    await Promise.resolve();
    expect(runtime.loginStartCalls).toBe(0);
    releaseRefresh();
    expect((await login).status).toBe(200);
    expect(runtime.loginStartCalls).toBe(1);
  });

  test("does not refresh a stale catalog failure after a newer login starts", async () => {
    const runtime = new FakeRuntime();
    runtime.loggedIn = true;
    runtime.modelFailures.push(new ProviderFailure("auth", "provider request failed with HTTP 401", false, { runtimeCode: "authentication_failed" }));
    let releaseModels!: () => void;
    runtime.modelBarrier = new Promise<void>((resolve) => { releaseModels = resolve; });
    const handle = await backend(runtime);
    await runtime.modelEntered;

    const login = await request(handle, "/native/login/start", { providerId: "openai-subscription", method: "browser" });
    expect(login.status).toBe(200);
    releaseModels();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runtime.refreshCalls).toBe(0);
    expect(runtime.logoutCalls).toBe(0);
  });
  test("returns device-code details and makes cancellation win over stale completion", async () => {
    const runtime = new FakeRuntime();
    const handle = await backend(runtime);
    const started = await request(handle, "/native/login/start", { providerId: "openai-subscription", method: "device" });
    expect(started.status).toBe(200);
    expect(started.data).toMatchObject({
      loginId: "login-1",
      method: "device",
      verificationUrl: "https://example.test/device",
      userCode: "ABCD-1234",
    });

    expect((await request(handle, "/native/login/cancel", {
      loginId: "login-1",
      providerId: "openai-subscription",
    })).status).toBe(200);
    const stale = await request(handle, "/native/login/complete", { loginId: "login-1" });
    expect(stale.status).toBe(409);
    expect(runtime.completeCalls).toBe(0);
    expect(runtime.cancelCalls).toBe(1);
    expect(runtime.logoutCalls).toBe(1);
  });

  test.each([
    { name: "plain cancel error", cancelError: new Error("login operation was not found"), logoutError: null, forgetFails: false },
    { name: "different structured cancel error", cancelError: new ProviderFailure("failed", "login operation was not found", false, { runtimeCode: "provider_unavailable" }), logoutError: null, forgetFails: false },
    { name: "logout error", cancelError: null, logoutError: new ProviderFailure("unavailable", "Synthetic logout failure", true, { runtimeCode: "provider_unavailable" }), forgetFails: false },
    { name: "credential revocation error", cancelError: null, logoutError: null, forgetFails: true },
  ])("does not hide a $name when cancelling a consumed worker login", async ({ cancelError, logoutError, forgetFails }) => {
    const runtime = new FakeRuntime();
    runtime.cancelError = cancelError;
    runtime.logoutError = logoutError;
    let forgotten = 0;
    const handle = await backend(runtime, async () => undefined, () => {
      forgotten += 1;
      if (forgetFails) throw new Error("Synthetic credential revocation failure");
    });
    await request(handle, "/native/login/start", { providerId: "openai-subscription", method: "browser" });
    const completed = await request(handle, "/native/login/complete", { loginId: "login-1" });
    expect(completed.status).toBe(200);
    expect(runtime.pendingLogins.has("login-1")).toBe(false);

    const response = await request(handle, "/native/login/cancel", { loginId: "login-1", providerId: "openai-subscription" });
    expect(response.status).toBe(500);
    expect(response.error).toBeDefined();
    expect(runtime.cancelCalls).toBe(1);
    expect(runtime.logoutCalls).toBe(1);
    expect(forgotten).toBe(1);
    expect(runtime.loggedIn).toBe(logoutError !== null);
  });

  test("logs the runtime account out when encrypted login persistence fails", async () => {
    const runtime = new FakeRuntime();
    const handle = await backend(runtime, async () => { throw new Error("encrypted store unavailable"); });
    await request(handle, "/native/login/start", { providerId: "openai-subscription", method: "browser" });
    const completed = await request(handle, "/native/login/complete", { loginId: "login-1" });

    expect(completed.status).toBe(500);
    expect(runtime.logoutCalls).toBe(1);
    expect(runtime.loggedIn).toBe(false);
  });

  test("logs the runtime account out when encrypted refresh persistence fails", async () => {
    const runtime = new FakeRuntime();
    runtime.loggedIn = true;
    const handle = await backend(runtime, async () => { throw new Error("encrypted store unavailable"); });
    const refreshed = await request(handle, "/native/account/refresh", { providerId: "openai-subscription" });

    expect(refreshed.status).toBe(500);
    expect(runtime.logoutCalls).toBe(1);
    expect(runtime.loggedIn).toBe(false);
  });

  test("revokes the runtime account when cancellation cleanup fails during logout", async () => {
    const runtime = new FakeRuntime();
    runtime.loggedIn = true;
    runtime.cancelError = new Error("login cancellation failed");
    const handle = await backend(runtime);
    await request(handle, "/native/login/start", { providerId: "openai-subscription", method: "browser" });

    const response = await request(handle, "/native/logout", { providerId: "openai-subscription" });

    expect(response.status).toBe(500);
    expect(runtime.cancelCalls).toBe(1);
    expect(runtime.logoutCalls).toBe(1);
    expect(runtime.loggedIn).toBe(false);
  });

  test("returns saved workspace data without waiting for provider startup", async () => {
    const directory = mkdtempSync(join(tmpdir(), "scraply-workspace-startup-"));
    directories.push(directory);
    const dbPath = join(directory, "scraply.db");
    const db = new DatabaseClient(dbPath);
    const now = new Date().toISOString();
    db.db.prepare("INSERT INTO threads (id, title, status, created_at, updated_at) VALUES ('saved-thread', 'Saved work', 'configuring', ?, ?)")
      .run(now, now);
    db.close();
    const handle = await startBackend({
      dataDir: directory,
      dbPath,
      bundledPromptsDir: join(process.cwd(), "prompts"),
      promptOverridesDir: join(directory, "prompts"),
      appVersion: "test",
      getSecrets: () => ({ exaApiKey: null }),
      nativeRuntimeError: "Native runtime package is missing",
    }, () => undefined);
    handles.push(handle);

    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${handle.port}/workspace`, {
      headers: { authorization: `Bearer ${handle.token}` },
    });
    const body = await response.json() as { data: { threads: Array<{ id: string; title: string }> } };
    expect(Date.now() - started).toBeLessThan(500);
    expect(body.data.threads).toContainEqual(expect.objectContaining({ id: "saved-thread", title: "Saved work" }));
  });
});

class FakeRuntime {
  reasoningSummaries = true;
  maxConcurrentModelCalls = 1;
  setReasoningSummaries(enabled: boolean) { this.reasoningSummaries = enabled; }
  setMaxConcurrentGenerations(limit: number) { this.maxConcurrentModelCalls = limit; }
  loggedIn = false;
  completeCalls = 0;
  cancelCalls = 0;
  logoutCalls = 0;
  readonly pendingLogins = new Set<string>();
  cancelError: Error | null = null;
  logoutError: Error | null = null;
  refreshError: Error | null = null;
  refreshCalls = 0;
  modelCalls = 0;
  modelFailures: Error[] = [];
  loginStartCalls = 0;
  refreshBarrier: Promise<void> | null = null;
  modelBarrier: Promise<void> | null = null;
  logoutBarrier: Promise<void> | null = null;
  private enterRefresh!: () => void;
  private enterModels!: () => void;
  private enterLogout!: () => void;
  readonly refreshEntered = new Promise<void>((resolve) => { this.enterRefresh = resolve; });
  readonly modelEntered = new Promise<void>((resolve) => { this.enterModels = resolve; });
  readonly logoutEntered = new Promise<void>((resolve) => { this.enterLogout = resolve; });

  async start() { return { runtime: { version: "0.1.0" } }; }
  async listAccounts() {
    return this.loggedIn ? [{ providerId: "openai-subscription", email: "dany@example.test", plan: "plus" }] : [];
  }
  async listModels() {
    this.modelCalls += 1;
    this.enterModels();
    await this.modelBarrier;
    const failure = this.modelFailures.shift();
    if (failure) throw failure;
    return [{ identity: { providerId: "openai-subscription", modelId: "gpt-test" }, displayName: "GPT Test", supportsStructuredOutput: true }];
  }
  async startLogin(providerId: string, method: "browser" | "device" | "pkce") {
    this.loginStartCalls += 1;
    const loginId = `login-${this.loginStartCalls}`;
    this.pendingLogins.add(loginId);
    return method === "device"
      ? { loginId, providerId, method, verificationUrl: "https://example.test/device", userCode: "ABCD-1234" }
      : { loginId, providerId, method: "browser" as const, authorizationUrl: "https://example.test/login", callbackPort: 3849 };
  }
  async completeLogin(loginId: string, persist: (providerId: string, credential: string) => Promise<void>) {
    this.completeCalls += 1;
    // The worker consumes a finished login before returning its credential.
    if (!this.pendingLogins.delete(loginId)) {
      throw new ProviderFailure("failed", "login operation was not found", false, { runtimeCode: "login_not_found" });
    }
    this.loggedIn = true;
    await persist("openai-subscription", "rotated-credential");
    return credentialResult();
  }
  async cancelLogin(loginId: string) {
    this.cancelCalls += 1;
    if (this.cancelError) throw this.cancelError;
    if (!this.pendingLogins.delete(loginId)) {
      throw new ProviderFailure("failed", "login operation was not found", false, { runtimeCode: "login_not_found" });
    }
  }
  async refreshAccount(_providerId: string, persist: (providerId: string, credential: string) => Promise<void>) {
    this.refreshCalls += 1;
    this.enterRefresh();
    await this.refreshBarrier;
    if (this.refreshError) throw this.refreshError;
    await persist("openai-subscription", "rotated-credential");
    return credentialResult();
  }
  async logout() {
    this.logoutCalls += 1;
    this.enterLogout();
    await this.logoutBarrier;
    if (this.logoutError) throw this.logoutError;
    this.loggedIn = false;
  }
  async close() {}
}

function credentialResult() {
  return {
    account: { providerId: "openai-subscription", email: "dany@example.test", plan: "plus" },
    credential: "rotated-credential",
    persistence: { providerId: "openai-subscription", sessionId: "session-1", rotationId: "rotation-1" },
  };
}

function barrier() {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  return { waiting, release };
}

async function nativeLoginService() {
  const directory = mkdtempSync(join(process.cwd(), "build", "native-account-race-"));
  directories.push(directory);
  const runtime = new FakeRuntime();
  let rejectEncryption = false;
  const store = createCredentialStore(join(directory, "synthetic-secrets.bin"), {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      if (rejectEncryption) throw new Error("Synthetic encrypted write failure");
      return Buffer.from(value, "utf8");
    },
    decryptString: value => value.toString("utf8"),
  });
  store.load();
  await store.save({ exaApiKey: "synthetic-exa-key", perplexityApiKey: "synthetic-perplexity-key", providerCredentials: {} });
  let handle: BackendHandle | undefined;
  const probes = { exa: 0, perplexity: 0 };
  const transport = { holdCompletionResponse: false };
  const responseEntered = barrier();
  const responseGate = barrier();
  const appBackend: AppBackend = {
    async start(input) {
      if (handle) return;
      handle = await startBackend({ ...input.paths, appVersion: "test", validateAutomaticSecrets: false,
        getSecrets: () => service.getSecrets(), nativeRuntime: runtime as unknown as RuntimeClient,
        nativeRuntimeStatus: () => ({ ready: true }), persistProviderCredential: input.persistProviderCredential,
        providerValidation: {
          validateExa: async () => { probes.exa += 1; return { valid: true }; },
          validatePerplexity: async () => { probes.perplexity += 1; return { valid: true }; },
        },
      }, () => undefined);
      handles.push(handle);
    },
    isReady: () => handle !== undefined,
    async request(path, init) {
      if (!handle) throw new Error("Synthetic backend has not started");
      const response = await fetch(`http://127.0.0.1:${handle.port}${path}`, { ...init,
        headers: { authorization: `Bearer ${handle.token}`, "content-type": "application/json" } });
      const body = z.object({ data: z.unknown().optional(), error: z.object({ message: z.string() }).optional() }).parse(await response.json());
      if (!response.ok) throw new Error(body.error?.message ?? "Synthetic backend request failed");
      if (transport.holdCompletionResponse && path === "/native/login/complete"
        && z.object({ pending: z.literal(false) }).safeParse(body.data).success) {
        // Hold only the return transport, after the actual backend has formed its response.
        responseEntered.release();
        await responseGate.waiting;
      }
      return body.data;
    },
    async updateSecrets() {}, async finishSearchKeyUpdate() {}, stop() {},
  };
  const service = createAppService({ backend: appBackend, appVersion: "test", credentialStore: store,
    paths: { dataDir: directory, dbPath: join(directory, "scraply.db"), logsDir: join(directory, "logs"),
      bundledPromptsDir: join(process.cwd(), "prompts"), promptOverridesDir: join(directory, "prompts") },
    automaticSecrets: { environment: { EXA_API_KEY: "", PERPLEXITY_API_KEY: "" } },
  });
  await service.start({ validateAutomaticSecrets: false });
  return { service, backend: appBackend, store, runtime, probes, transport, responseEntered, responseGate,
    failEncryptedWrites(value: boolean) { rejectEncryption = value; } };
}

async function backend(
  runtime: FakeRuntime,
  persist: (providerId: string, credential: string) => Promise<void> = async () => undefined,
  forgetProviderCredential: (providerId: string) => void = () => undefined,
): Promise<BackendHandle> {
  const directory = mkdtempSync(join(tmpdir(), "scraply-native-account-"));
  directories.push(directory);
  const handle = await startBackend({
    dataDir: directory,
    dbPath: join(directory, "scraply.db"),
    bundledPromptsDir: join(process.cwd(), "prompts"),
    promptOverridesDir: join(directory, "prompts"),
    appVersion: "test",
    getSecrets: () => ({ exaApiKey: null }),
    nativeRuntime: runtime as unknown as RuntimeClient,
    nativeRuntimeStatus: () => ({ ready: true }),
    persistProviderCredential: persist,
    forgetProviderCredential,
  }, () => undefined);
  handles.push(handle);
  return handle;
}

async function request(handle: BackendHandle, path: string, body: unknown) {
  const response = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${handle.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as { data?: unknown; error?: { message: string } };
  return { status: response.status, data: payload.data, error: payload.error };
}
