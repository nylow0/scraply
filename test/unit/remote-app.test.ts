import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRemoteApp } from "../../src/main/remote-app";
import { selectDesktopProfile, configureCredentialProfile } from "../../src/main/credential-profile";
import { IPC_CHANNELS, WorkspaceStateSchema } from "../../src/shared/ipc";
import { APP_CHANNELS, ExecuteOperationRequestSchema } from "../../src/shared/cli-contracts";
import { OwnerTransportError } from "../../src/shared/owner-contracts";
import { WorkflowAdmissionReceiptSchema } from "../../src/shared/workflow-contracts";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function directory() { const path = mkdtempSync(join(tmpdir(), "scraply-remote-app-")); directories.push(path); return path; }
function harness(options: { browserDev?: boolean } = {}) {
  const calls: Array<{ channel: string; payload: unknown }> = [];
  const urls: string[] = [];
  const paths: string[] = [];
  const dialogs: unknown[] = [];
  let target: string | null = null;
  let handler: (channel: string, payload: unknown) => Promise<unknown> = async () => undefined;
  const app = createRemoteApp({ ...options,
    async invoke(channel, payload) { calls.push({ channel, payload }); return handler(channel, payload); },
    async openExternal(url) { urls.push(url); }, async revealPath(path) { paths.push(path); },
    async chooseExportTarget(request) { dialogs.push(request); return target; },
  });
  return { app, calls, urls, paths, dialogs,
    handle(value: typeof handler) { handler = value; }, target(value: string | null) { target = value; },
  };
}

test("desktop login opens only caller browser and keeps existing browser/device result shapes", async () => {
  const h = harness();
  h.handle(async () => ({ loginId: "synthetic-login", providerId: "openai-subscription", method: "browser",
    authorizationUrl: "https://example.com/authorize", callbackPort: 7890 }));
  expect(await h.app.invoke(IPC_CHANNELS.NATIVE_LOGIN_START, [{ providerId: "openai-subscription", method: "browser" }])).toEqual({
    loginId: "synthetic-login", providerId: "openai-subscription", method: "browser",
  });
  expect(h.urls).toEqual(["https://example.com/authorize"]);
  h.handle(async () => ({ loginId: "synthetic-device", providerId: "openai-subscription", method: "device",
    verificationUrl: "https://example.com/device", userCode: "SYNTHETIC" }));
  expect(await h.app.invoke(IPC_CHANNELS.NATIVE_LOGIN_START, [{ providerId: "openai-subscription", method: "device" }])).toEqual({
    loginId: "synthetic-device", providerId: "openai-subscription", method: "device", verificationUrl: "https://example.com/device", userCode: "SYNTHETIC",
  });
  h.handle(async () => ({ loginId: "synthetic-login", providerId: "openai-subscription", method: "pkce", authorizationUrl: "http://127.0.0.1/private" }));
  await expect(h.app.invoke(IPC_CHANNELS.NATIVE_LOGIN_START, [{ providerId: "openai-subscription", method: "browser" }])).rejects.toMatchObject({ code: "validation_error" });
  expect(h.urls).toHaveLength(2);
});

test("external links validate locally and folder effects use the caller's Electron adapter", async () => {
  const h = harness();
  await h.app.invoke(IPC_CHANNELS.OPEN_EXTERNAL_URL, [{ url: "https://example.com/source" }]);
  expect(h.calls).toEqual([]);
  expect(h.urls).toEqual(["https://example.com/source"]);
  await expect(h.app.invoke(IPC_CHANNELS.OPEN_EXTERNAL_URL, [{ url: "file:///private" }])).rejects.toMatchObject({ code: "validation_error" });
  h.handle(async () => ({ path: "synthetic-data" }));
  await h.app.invoke(IPC_CHANNELS.OPEN_DATA_FOLDER);
  expect(h.paths).toEqual(["synthetic-data"]);
  h.handle(async () => ({ path: 42 }));
  await expect(h.app.invoke(IPC_CHANNELS.OPEN_LOGS_FOLDER)).rejects.toThrow();
  expect(h.paths).toHaveLength(1);
});

test("research export chooses/writes locally and cancellation writes no files", async () => {
  const path = directory();
  const h = harness();
  h.handle(async () => ({ files: [{ filename: "../synthetic/research.json", content: '{"saved":true}' }] }));
  expect(await h.app.invoke(IPC_CHANNELS.EXPORT_RESEARCH, [{ threadId: "synthetic-project" }])).toEqual({ cancelled: true });
  expect(h.dialogs).toEqual([{ kind: "research", filename: "..-synthetic-research.json" }]);
  const target = join(path, "chosen.json");
  expect(existsSync(target)).toBe(false);
  h.target(target);
  expect(await h.app.invoke(IPC_CHANNELS.EXPORT_RESEARCH, [{ threadId: "synthetic-project" }])).toEqual({ cancelled: false, file: target });
  expect(readFileSync(target, "utf8")).toBe('{"saved":true}');
  h.handle(async () => ({ files: [] }));
  await expect(h.app.invoke(IPC_CHANNELS.EXPORT_RESEARCH, [{ threadId: "synthetic-project" }])).rejects.toMatchObject({ code: "validation_error" });
});

test("idea exports preserve existing files, sanitize portable names and preserve browser download contents", async () => {
  const path = directory();
  const h = harness();
  h.target(path);
  writeFileSync(join(path, "idea.md"), "previous synthetic export");
  h.handle(async () => ({ files: [{ filename: "idea.md", content: "new synthetic export" }, { filename: "../escape.md", content: "contained" }] }));
  expect(await h.app.invoke(IPC_CHANNELS.EXPORT_IDEAS, [{ threadId: "synthetic-project", format: "markdown" }])).toEqual({
    cancelled: false, directory: path, files: ["idea-2.md", "..-escape.md"],
  });
  expect(readFileSync(join(path, "idea.md"), "utf8")).toBe("previous synthetic export");
  expect(readFileSync(join(path, "idea-2.md"), "utf8")).toBe("new synthetic export");
  const browser = harness({ browserDev: true });
  browser.handle(async () => ({ files: [{ filename: "first.json", content: '[{"idea":"one"}]' }, { filename: "second.json", content: '{"idea":"two"}' }] }));
  expect(await browser.app.invoke(IPC_CHANNELS.EXPORT_IDEAS, [{ threadId: "synthetic-project", format: "json" }])).toEqual({
    downloads: [{ filename: "scraply-ideas-synthetic-project.json", content: JSON.stringify([{ idea: "one" }, { idea: "two" }], null, 2) }],
  });
  browser.handle(async () => ({ filename: "synthetic-workshop-ideas.md", files: [{ filename: "one.md", content: "Synthetic idea" }] }));
  expect(await browser.app.invoke(IPC_CHANNELS.EXPORT_IDEAS, [{ threadId: "synthetic-project", format: "markdown" }])).toEqual({
    downloads: [{ filename: "synthetic-workshop-ideas.md", content: "Synthetic idea\n" }],
  });
  expect(browser.dialogs).toEqual([]);
  browser.handle(async () => ({ files: [{ filename: "saved-research.json", content: "{}" }] }));
  expect(await browser.app.invoke(IPC_CHANNELS.EXPORT_RESEARCH, [{ threadId: "synthetic-project" }])).toEqual({ downloads: [{ filename: "saved-research.json", content: "{}" }] });
});

test("GUI billable actions preview then execute the exact proposal once", async () => {
  const h = harness();
  const payload = { context: "Synthetic warehouse approvals", model: { providerId: "openai-subscription", modelId: "synthetic-model" }, reasoningEffort: "high" };
  const proposal = { operation: { channel: IPC_CHANNELS.GENERATE_TITLE, payload }, previewHash: "synthetic-proof", expiresAt: new Date(Date.now() + 60_000).toISOString(),
    capabilityFingerprint: "synthetic-capabilities", stateFingerprint: "synthetic-state", summary: "Generate synthetic title", billing: "billable" };
  h.handle(async channel => channel === APP_CHANNELS.PREVIEW_OPERATION ? proposal : { channel: IPC_CHANNELS.GENERATE_TITLE, result: { title: "Synthetic warehouse approvals" } });
  expect(await h.app.invoke(IPC_CHANNELS.GENERATE_TITLE, [payload])).toEqual({ title: "Synthetic warehouse approvals" });
  expect(h.calls).toEqual([{ channel: APP_CHANNELS.PREVIEW_OPERATION, payload: proposal.operation }, { channel: APP_CHANNELS.EXECUTE_OPERATION, payload: { proposal } }]);
  h.calls.length = 0;
  h.handle(async channel => {
    if (channel === APP_CHANNELS.PREVIEW_OPERATION) return proposal;
    throw new OwnerTransportError({ code: "OWNER_UNAVAILABLE", message: "Synthetic response lost after admission." });
  });
  await expect(h.app.invoke(IPC_CHANNELS.GENERATE_TITLE, [payload])).rejects.toMatchObject({ code: "backend_unavailable" });
  expect(h.calls.map(call => call.channel)).toEqual([APP_CHANNELS.PREVIEW_OPERATION, APP_CHANNELS.EXECUTE_OPERATION]);
});

test("search key confirmation uses an opaque candidate and never copies the key into execution proof", async () => {
  const h = harness();
  const key = "synthetic-private-candidate-key";
  const proposal = { operation: { channel: IPC_CHANNELS.SAVE_SEARCH_KEY, payload: { provider: "exa", credentialRef: "00000000-0000-4000-8000-000000000001" } },
    previewHash: "synthetic-proof", expiresAt: new Date(Date.now() + 60_000).toISOString(), capabilityFingerprint: "synthetic-capabilities",
    stateFingerprint: "synthetic-state", summary: "Check and save synthetic key", billing: "billable" };
  const workspace = WorkspaceStateSchema.parse({
    validation: { exa: { valid: true, maskedKey: "••••-key" }, perplexity: { valid: false }, native: { available: false, connected: false, accounts: [] }, setupComplete: false },
    threads: [], activeThreadId: null, messages: [], scope: null, runConfig: null, models: [], modelOptions: [],
    modelCatalog: { models: [], favorites: [] }, presets: [], problemCandidates: [], rejectedProblemCandidates: [], solutions: [],
    latestResearchRun: null, pendingRuns: [], researchRequests: [], researchFindings: [],
  });
  h.handle(async channel => channel === APP_CHANNELS.PREVIEW_OPERATION ? proposal : { channel: IPC_CHANNELS.SAVE_SEARCH_KEY, result: workspace });
  expect(await h.app.invoke(IPC_CHANNELS.SAVE_SEARCH_KEY, [{ provider: "exa", apiKey: key }])).toEqual({ ok: true, data: workspace });
  expect(JSON.stringify(h.calls[1])).not.toContain(key);
  h.calls.length = 0;
  h.handle(async channel => {
    if (channel === APP_CHANNELS.PREVIEW_OPERATION) return proposal;
    throw new OwnerTransportError({ code: "conflict", message: "Synthetic active-work refusal" }, 409);
  });
  expect(await h.app.invoke(IPC_CHANNELS.SAVE_SEARCH_KEY, [{ provider: "exa", apiKey: key }])).toEqual({
    ok: false, error: { code: "conflict", message: "Synthetic active-work refusal" },
  });
  expect(h.calls).toEqual([{ channel: APP_CHANNELS.PREVIEW_OPERATION, payload: { channel: IPC_CHANNELS.SAVE_SEARCH_KEY, payload: { provider: "exa", apiKey: key } } },
    { channel: APP_CHANNELS.EXECUTE_OPERATION, payload: { proposal } }]);
  expect(JSON.stringify(h.calls[1])).not.toContain(key);
  h.calls.length = 0;
  h.handle(async () => ({ ...proposal, operation: { ...proposal.operation, payload: { provider: "perplexity", credentialRef: "00000000-0000-4000-8000-000000000001" } } }));
  expect(await h.app.invoke(IPC_CHANNELS.SAVE_SEARCH_KEY, [{ provider: "exa", apiKey: key }])).toMatchObject({ ok: false, error: { code: "validation_error" } });
  expect(h.calls.map(call => call.channel)).toEqual([APP_CHANNELS.PREVIEW_OPERATION]);
});

test("passive status stays free while explicit validation and retry use confirmed service proposals", async () => {
  const h = harness();
  const status = { exa: { valid: false, checking: true }, perplexity: { valid: false },
    native: { available: false, connected: false, accounts: [] }, setupComplete: false };
  h.handle(async (channel, payload) => {
    if (channel === APP_CHANNELS.GET_PROVIDER_STATUS) return status;
    if (channel === APP_CHANNELS.PREVIEW_OPERATION) return {
      operation: payload, previewHash: "synthetic-proof", expiresAt: new Date(Date.now() + 60_000).toISOString(),
      capabilityFingerprint: "synthetic-capabilities", stateFingerprint: "synthetic-state", summary: "Check synthetic connection", billing: "billable",
    };
    const { proposal } = ExecuteOperationRequestSchema.parse(payload);
    return { channel: proposal.operation.channel, result: proposal.operation.channel === IPC_CHANNELS.RETRY_CONNECTION ? null : status };
  });
  expect(await h.app.invoke(APP_CHANNELS.GET_PROVIDER_STATUS)).toEqual(status);
  expect(h.calls.map(call => call.channel)).toEqual([APP_CHANNELS.GET_PROVIDER_STATUS]);
  h.calls.length = 0;
  expect(await h.app.invoke(IPC_CHANNELS.GET_VALIDATION)).toEqual(status);
  expect(h.calls.map(call => call.channel)).toEqual([APP_CHANNELS.PREVIEW_OPERATION, APP_CHANNELS.EXECUTE_OPERATION]);
  h.calls.length = 0;
  expect(await h.app.invoke(IPC_CHANNELS.RETRY_CONNECTION)).toBeNull();
  expect(h.calls.map(call => call.channel)).toEqual([APP_CHANNELS.PREVIEW_OPERATION, APP_CHANNELS.EXECUTE_OPERATION]);
});

test("legacy boxed errors survive transport and malformed request/results fail closed", async () => {
  const h = harness();
  const failure = { ok: false, error: { code: "MODEL_UNAVAILABLE", message: "Synthetic saved model unavailable", recovery: { action: "choose-model" } } };
  h.handle(async () => failure);
  expect(await h.app.invoke(IPC_CHANNELS.GET_WORKFLOW, [{ sessionId: "synthetic-session" }])).toEqual(failure);
  h.handle(async () => { throw new OwnerTransportError({ code: "conflict", message: "Synthetic key write conflict" }, 409); });
  expect(await h.app.invoke(IPC_CHANNELS.SAVE_SEARCH_KEY, [{ provider: "exa", apiKey: "synthetic-key" }])).toEqual({ ok: false, error: { code: "conflict", message: "Synthetic key write conflict" } });
  h.handle(async () => ({ ok: true, data: { invalid: true } }));
  expect(await h.app.invoke(IPC_CHANNELS.GET_WORKFLOW, [{ sessionId: "synthetic-session" }])).toMatchObject({ ok: false, error: { code: "validation_error" } });
  const before = h.calls.length;
  expect(await h.app.invoke(IPC_CHANNELS.GET_WORKFLOW, [{ wrong: "synthetic-session" }])).toMatchObject({ ok: false, error: { code: "validation_error" } });
  expect(h.calls).toHaveLength(before);
  await expect(h.app.invoke("unknown-channel")).rejects.toMatchObject({ code: "validation_error" });
});

test("attached workflow commands keep exactly one renderer envelope and reject a changed proposal before admission", async () => {
  const h = harness();
  const payload = { threadId: "synthetic-project", sessionId: "synthetic-session", clientCommandId: "synthetic-command", expectedRevision: 1, action: { type: "resume" } };
  const proposal = { operation: { channel: IPC_CHANNELS.COMMAND_WORKFLOW, payload }, previewHash: "synthetic-proof", expiresAt: new Date(Date.now() + 60_000).toISOString(),
    capabilityFingerprint: "synthetic-capabilities", stateFingerprint: "synthetic-state", summary: "Resume synthetic run", billing: "billable" };
  const budget = { limit: 10, spent: 0, reserved: 0, uncertain: 0 };
  const receipt = WorkflowAdmissionReceiptSchema.parse({ sessionId: "synthetic-session", revision: 2, summary: {
    sessionId: "synthetic-session", threadId: "synthetic-project", purpose: "discovery", mode: "babysit", targetKind: "per-problem",
    state: "running", outcome: null, revision: 2, activeSnapshotId: null, selectedProblemIds: [],
    counts: { requested: 1, attempted: 0, validated: 0, accepted: 0, duplicate: 0, unresolved: 0, failed: 0, missing: 1, existing: 0, addedBySession: 0, total: 0 },
    limits: { maxMinutes: 1, maxModelCalls: 10, maxSearches: 0 }, budget: { modelCalls: budget, searches: budget, remainingMs: 60_000 },
    currentStage: null, stopReason: null, startedAt: new Date().toISOString(), finishedAt: null,
  } });
  h.handle(async channel => channel === APP_CHANNELS.PREVIEW_OPERATION ? proposal : { channel: IPC_CHANNELS.COMMAND_WORKFLOW, result: receipt });
  expect(await h.app.invoke(IPC_CHANNELS.COMMAND_WORKFLOW, [payload])).toEqual({ ok: true, data: receipt });
  const pause = { ...payload, action: { type: "pause" } };
  h.calls.length = 0;
  h.handle(async () => ({ ok: true, data: receipt }));
  expect(await h.app.invoke(IPC_CHANNELS.COMMAND_WORKFLOW, [pause])).toEqual({ ok: true, data: receipt });
  expect(h.calls).toEqual([{ channel: IPC_CHANNELS.COMMAND_WORKFLOW, payload: pause }]);
  h.calls.length = 0;
  h.handle(async () => ({ ...proposal, operation: { ...proposal.operation, payload: { ...payload, expectedRevision: 2 } } }));
  expect(await h.app.invoke(IPC_CHANNELS.COMMAND_WORKFLOW, [payload])).toMatchObject({ ok: false, error: { code: "validation_error" } });
  expect(h.calls.map(call => call.channel)).toEqual([APP_CHANNELS.PREVIEW_OPERATION]);
});

test("explicit desktop profile selection precedes credential/session paths and preserves isolated tests", () => {
  const root = directory();
  const paths = { userData: join(root, "chromium-profile"), appData: root, sessionData: join(root, "chromium-profile") };
  const app = { isPackaged: false,
    getPath(name: "userData" | "appData" | "sessionData") { return paths[name]; },
    setPath(name: "userData" | "sessionData", value: string) { paths[name] = value; },
  };
  const explicit = join(root, "explicit-cli-root");
  const selected = selectDesktopProfile(app, { SCRAPLY_DATA_DIR: join(root, "environment-root") }, ["--data-dir", explicit]);
  expect(selected.explicit).toBe(true);
  const configured = configureCredentialProfile(app, { SCRAPLY_DEV_SHARED_CREDENTIALS: "1" }, { explicitProfile: selected.explicit });
  expect(configured.projectProfile).toBe(selected.profileDir);
  expect(configured.credentialsPath).toBe(join(selected.profileDir, "secrets.bin"));
  expect(configured.credentialsPath).not.toBe(join(root, "scraply", "secrets.bin"));
  expect(paths.sessionData).toBe(selected.profileDir);
  expect(() => selectDesktopProfile(app, {}, ["--data-dir"])).toThrow("requires");
  expect(() => selectDesktopProfile(app, { SCRAPLY_DATA_DIR: "" }, [])).toThrow("empty");
  const retained = selectDesktopProfile(app, {}, []);
  expect(retained).toEqual({ profileDir: selected.profileDir, explicit: false });
  const chromium = selectDesktopProfile(app, { SCRAPLY_DATA_DIR: join(root, "environment-root") }, [`--user-data-dir=${join(root, "isolated-chromium")}`]);
  expect(chromium.profileDir).toBe(join(root, "isolated-chromium").toLowerCase());
  expect(chromium.explicit).toBe(false);
  const environment = selectDesktopProfile(app, { SCRAPLY_DATA_DIR: join(root, "environment-root") }, []);
  expect(environment.profileDir).toBe(join(root, "environment-root").toLowerCase());
  expect(environment.explicit).toBe(true);
  const isolated = configureCredentialProfile(app, { SCRAPLY_E2E: "1" });
  expect(isolated.credentialsPath).toBe(join(environment.profileDir, "secrets.bin"));
});
