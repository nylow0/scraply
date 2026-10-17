import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { startBackend, type BackendHandle } from "../../src/backend/server";
import { configurePromptPaths } from "../../src/core/prompts";
import { prepareWorkflowSearch, recordWorkflowSearchDispatched, recordWorkflowSearchTerminal } from "../../src/core/workflow-search-attempts";
import { workflowSearchKey } from "../../src/shared/content-identity";
import { DatabaseClient } from "../../src/db/client";
import { ThreadRepository } from "../../src/db/repositories/threads";
import { WorkflowRepository } from "../../src/db/repositories/workflows";
import { ProviderFailure, type StructuredModelClient } from "../../src/providers/structured";
import { ApiResponseSchema, IPC_CHANNELS, type ResearchEvent } from "../../src/shared/ipc";
import { DEFAULT_RUN_CONFIG, type ModelOption } from "../../src/shared/schemas";
import {
  APP_CHANNELS, ActivitySchema, CreateProjectResultSchema, ExecuteOperationResultSchema, ListProjectsResultSchema,
  ListRunsResultSchema, OperationProposalSchema, PreviewOperationRequestSchema, ProviderStatusResultSchema, ProjectDetailSchema, ResolveEntityResultSchema,
  isBillableOperation, isBoxedOperation, operationRegistry, parseOperationResult,
} from "../../src/shared/cli-contracts";
import { LaunchSettingsSchema } from "../../src/shared/launch-settings";
import { PreviewWorkflowResultSchema, WorkflowLaunchContractSchema } from "../../src/shared/workflow-contracts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const scope = { title: "Synthetic ferry schedules", audience: "Ferry dispatchers", domain: "Shift schedules",
  observations: "An invented scheduling case", offLimits: ["Passenger profiling"] };

async function fixture(options: { blockedTitle?: boolean; seed?: (db: DatabaseClient) => void } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "scraply-cli-service-"));
  const dbPath = join(directory, "scraply.db");
  const events: ResearchEvent[] = [];
  const calls = { models: 0, searches: 0, probes: 0 };
  const errors: string[] = [];
  let models: ModelOption[] = [{ ...DEFAULT_RUN_CONFIG.model, displayName: "Synthetic model", defaultReasoningEffort: "medium",
    reasoningEfforts: [{ id: "medium", description: "Medium" }, { id: "high", description: "High" }] }];
  const client: StructuredModelClient = { async structuredCompletion(request) {
    calls.models += 1;
    if (options.blockedTitle) await new Promise<void>((_resolve, reject) => {
      const fail = () => reject(new ProviderFailure("cancelled", "Synthetic title stopped", false));
      if (request.signal?.aborted) fail();
      else request.signal?.addEventListener("abort", fail, { once: true });
    });
    return { output: request.schema.parse({ title: "Synthetic ferry shift planning" }), metadata: {
      model: request.model, usage: { status: "unknown" }, latencyMs: 0, repairCount: 0, providerRequestIds: [], attempts: [],
    } };
  } };
  if (options.seed) {
    const db = new DatabaseClient(dbPath);
    try { options.seed(db); } finally { db.close(); }
  }
  let handle: BackendHandle;
  async function start() {
    configurePromptPaths({ bundledDir: join(process.cwd(), "prompts"), overrideDir: join(directory, "prompts") });
    handle = await startBackend({ dataDir: directory, dbPath, bundledPromptsDir: join(process.cwd(), "prompts"),
      promptOverridesDir: join(directory, "prompts"), appVersion: "test", validateAutomaticSecrets: false,
      getSecrets: () => ({ exaApiKey: "synthetic-search-key", perplexityApiKey: "synthetic-second-key" }),
      log: (entry) => { if (entry.error) errors.push(String(entry.error)); },
      modelClients: { "openai-subscription": client },
      searchClients: { exa: { provider: "exa", async validateKey() { calls.probes += 1; return { valid: true }; },
        async search() { calls.searches += 1; return []; } } },
      providerValidation: {
        inspectNative: async () => ({ available: true, connected: true, accounts: [], models }),
        validateExa: async () => { calls.probes += 1; return { valid: false, error: "Synthetic rejected key" }; },
        validatePerplexity: async () => { calls.probes += 1; return { valid: true }; },
      },
    }, (event) => events.push(event));
  }
  await start();
  cleanups.push(async () => { await handle.close(); rmSync(directory, { recursive: true, force: true }); });
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
      method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${handle.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: ApiResponseSchema(z.unknown()).parse(await response.json()) };
  };
  const data = async (path: string, body?: unknown) => {
    const result = await request(path, body);
    if (!result.body.ok) throw new Error(`${path}: ${result.body.error.code}: ${result.body.error.message}; ${errors.join("; ")}`);
    return result.body.data;
  };
  const edit = <T>(operation: (db: DatabaseClient) => T) => {
    const db = new DatabaseClient(dbPath);
    try { return operation(db); } finally { db.close(); }
  };
  const create = async (title = scope.title) => CreateProjectResultSchema.parse(await data("/threads", { title })).thread.id;
  const project = async (threadId: string) => ProjectDetailSchema.parse(await data(`/app/projects/${encodeURIComponent(threadId)}`));
  const titleOperation = (threadId: string) => ({ channel: APP_CHANNELS.GENERATE_PROJECT_TITLE,
    payload: { threadId, context: scope.domain, model: DEFAULT_RUN_CONFIG.model, reasoningEffort: "medium" } });
  const preview = async (operation: unknown) => OperationProposalSchema.parse(await data("/app/operations/preview", operation));
  return { request, data, create, edit, project, preview, titleOperation, calls, events, dbPath,
    async restart() { await handle.close(); await start(); },
    changeModels(next: ModelOption[]) { models = next; handle.providersChanged(); },
    reserveKeyUpdate() { return handle.beginSearchKeyUpdate(); }, releaseKeyUpdate() { return handle.finishSearchKeyUpdate(); },
  };
}

test("non-default and archived project reads preserve selection, timestamps and invalidation count", async () => {
  const host = await fixture();
  const archived = await host.create("Synthetic archived harbor");
  await host.data("/scope", { threadId: archived, scope });
  await host.data("/threads/archive", { threadId: archived, archived: true });
  const active = await host.create("Synthetic active harbor");
  const before = host.edit((db) => ({ active: db.getSetting("active_thread_id"),
    rows: db.db.prepare("SELECT * FROM threads ORDER BY id").all(), settings: db.db.prepare("SELECT * FROM settings ORDER BY key").all() }));
  const notifications = host.events.length;
  expect(ListProjectsResultSchema.parse(await host.data("/app/projects")).projects.map((item) => item.id)).toEqual([active]);
  expect(ListProjectsResultSchema.parse(await host.data("/app/projects?archived=true")).projects).toHaveLength(2);
  expect((await host.project(archived)).workspace.activeThreadId).toBe(archived);
  expect((await host.project(scope.title)).thread.id).toBe(archived);
  expect((await host.project(archived.slice(0, 12))).thread.archivedAt).not.toBeNull();
  await host.data("/app/runs");
  await host.data("/app/provider-status");
  await host.data("/app/resolve", { kind: "project", reference: archived.slice(0, 12) });
  expect(host.edit((db) => ({ active: db.getSetting("active_thread_id"), rows: db.db.prepare("SELECT * FROM threads ORDER BY id").all(),
    settings: db.db.prepare("SELECT * FROM settings ORDER BY key").all() }))).toEqual(before);
  expect(host.events).toHaveLength(notifications);
  expect(host.calls).toEqual({ models: 0, searches: 0, probes: 0 });
});

test("passive provider status stays unchecked, service proofs stay private, and reserved validation probes exactly one candidate", async () => {
  const host = await fixture();
  const status = ProviderStatusResultSchema.parse(await host.data("/app/provider-status"));
  expect(status.exa).toMatchObject({ configured: true, checked: false, valid: false, checking: false, error: "Exa key has not been checked" });
  expect(status.perplexity.valid).toBe(false);
  const raw = { channel: IPC_CHANNELS.SAVE_SEARCH_KEY, payload: { provider: "exa", apiKey: "synthetic-private-candidate" } };
  expect(PreviewOperationRequestSchema.parse(raw)).toEqual(raw);
  expect(() => OperationProposalSchema.parse({ operation: raw, previewHash: "hash", capabilityFingerprint: "capability",
    stateFingerprint: "state", expiresAt: "2099-01-01T00:00:00.000Z", summary: "Private key change", billing: "billable" })).toThrow();
  expect((await host.request("/app/operations/preview", { channel: IPC_CHANNELS.GET_VALIDATION, payload: {} })).body)
    .toMatchObject({ ok: false, error: { code: "validation_error" } });
  expect((await host.request("/search-keys/validate-reserved", { provider: "exa", apiKey: "synthetic-private-candidate" })).body.ok).toBe(false);
  expect(host.calls.probes).toBe(0);
  expect(host.reserveKeyUpdate()).toBe(true);
  expect(await host.data("/search-keys/validate-reserved", { provider: "exa", apiKey: "synthetic-private-candidate" }))
    .toMatchObject({ valid: false, error: "Synthetic rejected key" });
  expect(host.calls.probes).toBe(1);
  expect((await host.request("/search-keys/preflight", { provider: "exa", apiKey: "synthetic-another-candidate" })).body.ok).toBe(false);
  expect(host.calls.probes).toBe(1);
  host.releaseKeyUpdate();
  await host.data("/validation"); // The trusted owner's explicit, approved connection probe path.
  const checked = ProviderStatusResultSchema.parse(await host.data("/app/provider-status"));
  expect(checked.exa).toMatchObject({ configured: true, checked: true, valid: false, checking: false });
  expect(checked.perplexity).toMatchObject({ configured: true, checked: true, valid: true, checking: false });
  expect(host.calls.probes).toBe(3);
});

test("launch choices survive backend restart and unavailable saved models remain visible", async () => {
  const host = await fixture();
  const threadId = await host.create();
  await host.data("/scope", { threadId, scope });
  const initial = await host.project(threadId);
  expect(initial.launchSettings.ideas?.model).toEqual(DEFAULT_RUN_CONFIG.model);
  const settings = LaunchSettingsSchema.parse({ ...initial.launchSettings, mode: "vibe", automaticProblemCap: 2,
    ideas: { model: { providerId: "openai-subscription", modelId: "synthetic-retired-model" }, reasoningEffort: "high",
      reviewModel: DEFAULT_RUN_CONFIG.model, reviewReasoningEffort: "medium" },
    limits: { enforced: false, maxMinutes: 23, maxModelCalls: 41, maxSearches: 17 },
    instructions: { research: "Inspect synthetic shift records", ideas: "Prefer a small tool", review: "Check evidence" },
  });
  await host.data("/app/launch-settings", { threadId, settings });
  await host.restart();
  const reopened = await host.project(threadId);
  expect(reopened.launchSettings).toEqual(settings);
  expect(reopened.draft?.ideas).toEqual(settings.ideas);
  expect(reopened.draft?.targets.automaticProblemCap).toBe(2);
  const preview = PreviewWorkflowResultSchema.parse(await host.data("/workflows/preview", { type: "launch", threadId, draft: reopened.draft }));
  expect(preview.fieldErrors.some((error) => error.code === "MODEL_UNAVAILABLE")).toBe(true);
  expect((await host.project(threadId)).launchSettings).toEqual(settings);
  expect(host.calls).toEqual({ models: 0, searches: 0, probes: 0 });
});

test("free mutations invalidate attached clients and an unfinished brief remains readable", async () => {
  const host = await fixture();
  const threadId = await host.create();
  expect(host.events).toContainEqual({ type: "app-state-changed" });
  for (const [route, payload] of [
    ["/scope", { threadId, scope: { ...scope, domain: "", observations: "" } }],
    ["/run-config", { threadId, config: DEFAULT_RUN_CONFIG }],
    ["/threads/archive", { threadId, archived: true }],
    ["/threads/archive", { threadId, archived: false }],
    ["/threads/select", { threadId }],
  ] as const) {
    const count = host.events.length;
    await host.data(route, payload);
    expect(host.events.slice(count)).toEqual([{ type: "app-state-changed", threadId }]);
  }
  const project = await host.project(threadId);
  expect(project.workspace.scope?.domain).toBe("");
  expect(project.draft).toBeNull();
  expect(host.calls).toEqual({ models: 0, searches: 0, probes: 0 });
});

test("preview admits no work; exact paid title proposal applies once and preserves scope/status", async () => {
  const host = await fixture();
  const threadId = await host.create();
  await host.data("/scope", { threadId, scope });
  host.edit((db) => db.db.prepare("UPDATE threads SET status = 'problems-ready' WHERE id = ?").run(threadId));
  const before = await host.project(threadId);
  const count = host.events.length;
  const proposal = await host.preview(host.titleOperation(threadId));
  expect(proposal.summary).toContain("paid model or search calls");
  expect(Date.parse(proposal.expiresAt) - Date.now()).toBeLessThanOrEqual(600_000);
  expect(await host.project(threadId)).toEqual(before);
  expect(host.events).toHaveLength(count);
  expect(host.calls).toEqual({ models: 0, searches: 0, probes: 0 });
  const result = ExecuteOperationResultSchema.parse(await host.data("/app/operations/execute", { proposal }));
  expect(result).toMatchObject({ channel: APP_CHANNELS.GENERATE_PROJECT_TITLE, result: { title: "Synthetic ferry shift planning", threadId } });
  const after = await host.project(threadId);
  expect(after.thread.title).toBe("Synthetic ferry shift planning");
  expect(after.thread.status).toBe("problems-ready");
  expect(after.workspace.scope).toEqual({ ...scope, title: "Synthetic ferry shift planning" });
  expect(host.calls.models).toBe(1);
  expect(host.events.slice(count)).toContainEqual({ type: "app-state-changed", threadId });
  expect((await host.request("/app/operations/execute", { proposal })).body).toMatchObject({ ok: false, error: { code: "PREVIEW_STALE" } });
  expect(host.calls.models).toBe(1);
});

test("owner proof rejects changed action, expiry, project revision and capabilities before dispatch", async () => {
  const host = await fixture();
  const threadId = await host.create();
  await host.data("/scope", { threadId, scope });
  const proposal = await host.preview(host.titleOperation(threadId));
  for (const changed of [
    { ...proposal, operation: { ...proposal.operation, payload: { ...host.titleOperation(threadId).payload, context: "Different paid operation" } } },
    { ...proposal, expiresAt: "2000-01-01T00:00:00.000Z" },
  ]) expect((await host.request("/app/operations/execute", { proposal: changed })).body).toMatchObject({ ok: false, error: { code: "PREVIEW_STALE" } });
  await host.data("/run-config", { threadId, config: { ...DEFAULT_RUN_CONFIG, reasoningEffort: "high" } });
  expect((await host.request("/app/operations/execute", { proposal })).body).toMatchObject({ ok: false, error: { code: "PREVIEW_STALE" } });
  const changedCapabilities = await host.preview(host.titleOperation(threadId));
  host.changeModels([]);
  expect((await host.request("/app/operations/execute", { proposal: changedCapabilities })).body).toMatchObject({ ok: false, error: { code: "PREVIEW_STALE" } });
  expect(host.calls).toEqual({ models: 0, searches: 0, probes: 0 });
});

test("concurrent executions of the same consent cannot dispatch twice, and restart invalidates unused proof", async () => {
  const host = await fixture();
  const threadId = await host.create();
  await host.data("/scope", { threadId, scope });
  const proposal = await host.preview(host.titleOperation(threadId));
  const responses = await Promise.all([host.request("/app/operations/execute", { proposal }), host.request("/app/operations/execute", { proposal })]);
  expect(responses.filter((response) => response.body.ok)).toHaveLength(1);
  expect(host.calls.models).toBe(1);
  const unused = await host.preview(host.titleOperation(threadId));
  await host.restart();
  expect((await host.request("/app/operations/execute", { proposal: unused })).body).toMatchObject({ ok: false, error: { code: "PREVIEW_STALE" } });
  expect(host.calls.models).toBe(1);
});

test("session revision and historical run IDs are resolved by the owner without selecting projects", async () => {
  const host = await fixture();
  const threadId = await host.create();
  await host.data("/scope", { threadId, scope });
  const draft = (await host.project(threadId)).draft;
  const preview = PreviewWorkflowResultSchema.parse(await host.data("/workflows/preview", { type: "launch", threadId, draft }));
  const contract = WorkflowLaunchContractSchema.parse(preview.proposal);
  host.edit((db) => db.immediateTransaction(() => {
    const repository = new WorkflowRepository(db);
    const session = repository.createSession({ id: "synthetic-session-001", threadId, purpose: "discovery", mode: "vibe", contract, remainingMs: 60_000 });
    repository.updateSession(session.id, session.revision, { state: "paused", runningSince: null });
    repository.createWorkItem({ id: "synthetic-task-001", sessionId: session.id, kind: "research-request", scopeKey: "synthetic-request", input: {} });
    const now = new Date().toISOString();
    db.db.prepare(`INSERT INTO research_runs (id,thread_id,status,config_json,workflow_session_id,created_at,updated_at)
      VALUES ('synthetic-run-001',?,'completed',?,?,?,?)`).run(threadId, JSON.stringify(DEFAULT_RUN_CONFIG), session.id, now, now);
    db.db.prepare(`INSERT INTO rejected_problem_candidates (id,discovery_run_id,statement,reason,created_at)
      VALUES ('synthetic-rejected-001','synthetic-run-001','Synthetic scheduling delay','Insufficient direct accounts',?)`).run(now);
  }));
  const runs = ListRunsResultSchema.parse(await host.data("/app/runs"));
  expect(runs.runs).toContainEqual(expect.objectContaining({ kind: "workflow", id: "synthetic-session-001", researchRunIds: ["synthetic-run-001"] }));
  expect(runs.runs).toContainEqual(expect.objectContaining({ kind: "research", runId: "synthetic-run-001", sessionId: "synthetic-session-001", status: "completed" }));
  const searchAttemptId = host.edit((db) => {
    const query = "Synthetic ferry schedule audit";
    const attempt = prepareWorkflowSearch(db, "synthetic-run-001", {
      query, parameters: {}, key: workflowSearchKey(query, {}, "exa"), provider: "exa", dispatchProofVersion: 1,
    }, []);
    recordWorkflowSearchDispatched(db, "synthetic-run-001", attempt.id);
    recordWorkflowSearchTerminal(db, "synthetic-run-001", attempt.id, "failed", "Synthetic provider failure");
    return attempt.id;
  });
  expect(ResolveEntityResultSchema.parse(await host.data("/app/resolve", {
    kind: "attempt", reference: searchAttemptId.slice(0, 12), threadId,
  })).id).toBe(searchAttemptId);
  for (const [kind, reference, id] of [
    ["run", "synthetic-run-", "synthetic-run-001"], ["workflow", "synthetic-session-", "synthetic-session-001"],
    ["task", "synthetic-task-", "synthetic-task-001"], ["request", "synthetic-task-", "synthetic-task-001"],
    ["problem", "synthetic-rejected-", "synthetic-rejected-001"],
  ]) expect(ResolveEntityResultSchema.parse(await host.data("/app/resolve", { kind, reference, threadId })).id).toBe(id!);
  const session = runs.runs.find((run) => run.kind === "workflow")!;
  if (session.kind !== "workflow") throw new Error("Missing synthetic workflow");
  const operation = { channel: IPC_CHANNELS.COMMAND_WORKFLOW, payload: { threadId, sessionId: session.id,
    clientCommandId: "synthetic-resume-command", expectedRevision: session.revision, action: { type: "resume" } } };
  const proposal = await host.preview(operation);
  host.edit((db) => db.db.prepare("UPDATE workflow_sessions SET revision = revision + 1 WHERE id = ?").run(session.id));
  expect((await host.request("/app/operations/execute", { proposal })).body).toMatchObject({ ok: false, error: { code: "PREVIEW_STALE" } });
  expect((await host.request("/scope", { threadId, scope })).body).toMatchObject({ ok: false, error: { code: "PROJECT_BUSY" } });
  expect(host.calls).toEqual({ models: 0, searches: 0, probes: 0 });
});

test("startup exposes pending development handoffs without automatic generation or probes", async () => {
  const host = await fixture({ seed(db) {
    const threads = new ThreadRepository(db);
    const thread = threads.createThread("Synthetic handoff project");
    threads.saveScope(thread.id, scope);
    const now = new Date().toISOString();
    const config = JSON.stringify(DEFAULT_RUN_CONFIG);
    db.db.prepare(`INSERT INTO research_runs (id,thread_id,status,config_json,created_at,updated_at)
      VALUES ('synthetic-discovery',?,'completed',?,?,?)`).run(thread.id, config, now, now);
    for (const id of ["synthetic-problem-first", "synthetic-problem-next"]) db.db.prepare(`INSERT INTO problems
      (id,discovery_run_id,statement,why_it_persists,affected,scale_estimate,verdict,verdict_reason,verdict_source_ids_json,selected_at,created_at)
      VALUES (?,'synthetic-discovery','Synthetic delay','','','','user-asserted','Synthetic selection','[]',?,?)`).run(id, now, now);
    db.db.prepare(`INSERT INTO research_runs (id,thread_id,problem_id,status,config_json,created_at,updated_at)
      VALUES ('synthetic-developed-first',?,'synthetic-problem-first','completed',?,?,?)`).run(thread.id, config, now, now);
    threads.updateThreadStatus(thread.id, "development-running");
    db.setSetting("active_thread_id", thread.id);
  } });
  const projects = ListProjectsResultSchema.parse(await host.data("/app/projects"));
  const threadId = projects.projects[0]!.id;
  expect((await host.project(threadId)).resumableDevelopment).toBe(true);
  await host.restart();
  expect((await host.project(threadId)).resumableDevelopment).toBe(true);
  expect(ListRunsResultSchema.parse(await host.data("/app/runs")).runs).toHaveLength(2);
  expect(host.calls).toEqual({ models: 0, searches: 0, probes: 0 });
});

test("activity includes title generation and key reservations; stop-all cancels and awaits the title", async () => {
  const host = await fixture({ blockedTitle: true });
  const threadId = await host.create();
  await host.data("/scope", { threadId, scope });
  const proposal = await host.preview(host.titleOperation(threadId));
  const execution = host.request("/app/operations/execute", { proposal });
  const deadline = Date.now() + 3_000;
  let activity = ActivitySchema.parse(await host.data("/app/activity"));
  while (!activity.activeModelCalls) {
    if (Date.now() > deadline) throw new Error("Synthetic title was not dispatched");
    await new Promise((resolve) => setTimeout(resolve, 10));
    activity = ActivitySchema.parse(await host.data("/app/activity"));
  }
  expect(activity).toMatchObject({ active: true, activeModelCalls: 1 });
  expect(activity.pendingPosts).toBeGreaterThan(0);
  expect((await host.request("/run-config", { threadId, config: DEFAULT_RUN_CONFIG })).body).toMatchObject({ ok: false, error: { code: "PROJECT_BUSY" } });
  const stopped = ActivitySchema.parse(await host.data("/app/stop-all", {}));
  expect(stopped.active).toBe(false);
  expect((await execution).body.ok).toBe(false);
  expect((await host.project(threadId)).thread.title).toBe(scope.title);
  expect(host.reserveKeyUpdate()).toBe(true);
  expect(ActivitySchema.parse(await host.data("/app/activity"))).toMatchObject({ active: true, searchKeyUpdatePending: true });
  host.releaseKeyUpdate();
  expect(ActivitySchema.parse(await host.data("/app/activity")).active).toBe(false);
});

test("registry classifies every invoke and service envelopes and export bundles stay distinct", () => {
  const excluded = [IPC_CHANNELS.BACKEND_EVENT, IPC_CHANNELS.APP_COMMAND]; // Push-only events and window-menu navigation.
  expect(Object.values(IPC_CHANNELS).filter((channel) => !excluded.includes(channel as typeof excluded[number]) && !operationRegistry[channel])).toEqual([]);
  expect(isBillableOperation(IPC_CHANNELS.SELECT_OPTION, { threadId: "project", runId: "run", solutionId: "idea" })).toBe(true);
  expect(isBoxedOperation(IPC_CHANNELS.PREVIEW_WORKFLOW)).toBe(true);
  expect(isBoxedOperation(APP_CHANNELS.GET_PROJECT)).toBe(false);
  expect(() => isBillableOperation(APP_CHANNELS.EXECUTE_OPERATION, {})).toThrow();
  expect(parseOperationResult(IPC_CHANNELS.EXPORT_RESEARCH, { files: [{ filename: "synthetic.json", content: "{}" }] }))
    .toEqual({ files: [{ filename: "synthetic.json", content: "{}" }] });
});
