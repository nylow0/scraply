import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectNativeRuntime, startBackend, type BackendHandle } from "../../src/backend/server";
import { DatabaseClient } from "../../src/db/client";
import type { RuntimeClient } from "../../src/providers/runtime";
import { ProviderFailure } from "../../src/providers/structured";

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
  loggedIn = false;
  completeCalls = 0;
  cancelCalls = 0;
  logoutCalls = 0;
  cancelError: Error | null = null;
  refreshError: Error | null = null;
  refreshCalls = 0;
  modelCalls = 0;
  modelFailures: Error[] = [];
  loginStartCalls = 0;
  refreshBarrier: Promise<void> | null = null;
  modelBarrier: Promise<void> | null = null;
  private enterRefresh!: () => void;
  private enterModels!: () => void;
  readonly refreshEntered = new Promise<void>((resolve) => { this.enterRefresh = resolve; });
  readonly modelEntered = new Promise<void>((resolve) => { this.enterModels = resolve; });

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
    return method === "device"
      ? { loginId: "login-1", providerId, method, verificationUrl: "https://example.test/device", userCode: "ABCD-1234" }
      : { loginId: "login-1", providerId, method: "browser" as const, authorizationUrl: "https://example.test/login", callbackPort: 3849 };
  }
  async completeLogin(_loginId: string, persist: (providerId: string, credential: string) => Promise<void>) {
    this.completeCalls += 1;
    this.loggedIn = true;
    await persist("openai-subscription", "rotated-credential");
    return credentialResult();
  }
  async cancelLogin() {
    this.cancelCalls += 1;
    if (this.cancelError) throw this.cancelError;
  }
  async refreshAccount(_providerId: string, persist: (providerId: string, credential: string) => Promise<void>) {
    this.refreshCalls += 1;
    this.enterRefresh();
    await this.refreshBarrier;
    if (this.refreshError) throw this.refreshError;
    await persist("openai-subscription", "rotated-credential");
    return credentialResult();
  }
  async logout() { this.logoutCalls += 1; this.loggedIn = false; }
  async close() {}
}

function credentialResult() {
  return {
    account: { providerId: "openai-subscription", email: "dany@example.test", plan: "plus" },
    credential: "rotated-credential",
    persistence: { providerId: "openai-subscription", sessionId: "session-1", rotationId: "rotation-1" },
  };
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
