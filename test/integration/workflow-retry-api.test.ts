import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBackend, type BackendContext, type BackendHandle } from "../../src/backend/server";
import { DatabaseClient } from "../../src/db/client";
import { WorkflowRepository } from "../../src/db/repositories/workflows";
import { materializeResearchSnapshot } from "../../src/core/research-revisions";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";
import {
  PreviewWorkflowResultSchema, WorkflowAdmissionReceiptSchema, WorkflowDetailSchema, WorkflowLaunchContractSchema,
} from "../../src/shared/workflow-contracts";

const handles: BackendHandle[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const errors: string[] = [];

function context(directory: string): BackendContext {
  return {
    dataDir: directory,
    dbPath: join(directory, "scraply.db"),
    bundledPromptsDir: join(process.cwd(), "prompts"),
    promptOverridesDir: join(directory, "prompts"),
    appVersion: "test",
    getSecrets: () => ({ exaApiKey: null }),
    log: (entry) => { if (entry.error) errors.push(String(entry.error)); },
    providerValidation: { inspectNative: async () => ({
      available: true, connected: true, accounts: [{ providerId: "openai-subscription" }],
      models: [{
        providerId: "openai-subscription", modelId: "gpt-6-sol", displayName: "Test model",
        defaultReasoningEffort: "medium", reasoningEfforts: [{ id: "medium", description: "Medium" }],
      }],
    }) },
  };
}

async function openBackend(directory: string) {
  const handle = await startBackend(context(directory), () => {});
  handles.push(handle);
  const request = (path: string, body?: unknown) => fetch(`http://127.0.0.1:${handle.port}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${handle.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { handle, request };
}

async function closeBackend(handle: BackendHandle) {
  await handle.close();
  handles.splice(handles.indexOf(handle), 1);
}

function draft() {
  return {
    contractVersion: 1,
    purpose: "known-problem",
    mode: "babysit",
    brief: "Find ways for repair shops to approve parts purchases.",
    scope: { title: "Repair approvals", audience: "Repair shops", domain: "Parts purchasing", observations: "", offLimits: [] },
    runConfig: { ...DEFAULT_RUN_CONFIG, researchMode: "known-problem", knownProblem: "Parts approvals delay repairs." },
    ideas: { model: DEFAULT_RUN_CONFIG.model, reasoningEffort: "medium" },
    targets: { kind: "per-problem", ideaCount: 2 },
    limits: { maxMinutes: 90, maxModelCalls: 8, maxSearches: 0 },
    instructions: {},
  };
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "scraply-workflow-retry-"));
  directories.push(directory);
  const backend = await openBackend(directory);
  const created = await backend.request("/threads", {});
  expect(created.status).toBe(200);
  const threadId = (await created.json() as { data: { thread: { id: string } } }).data.thread.id;
  const previewResponse = await backend.request("/workflows/preview", { type: "launch", threadId, draft: draft() });
  expect(previewResponse.status).toBe(200);
  const preview = PreviewWorkflowResultSchema.parse((await previewResponse.json() as { data: unknown }).data);
  const contract = WorkflowLaunchContractSchema.parse(preview.proposal);
  return { directory, threadId, contract, ...backend };
}

type SavedState = "failed" | "unknown" | "running";

function saveAttemptFixture(input: {
  directory: string; threadId: string; contract: ReturnType<typeof WorkflowLaunchContractSchema.parse>;
  taskState: SavedState; attemptStatus: "failed" | "accepted"; errorCode?: string;
}) {
  const client = new DatabaseClient(join(input.directory, "scraply.db"));
  const workflows = new WorkflowRepository(client);
  const now = new Date().toISOString();
  const session = client.immediateTransaction(() => workflows.createSession({
    threadId: input.threadId, purpose: input.contract.purpose, mode: input.contract.mode,
    contract: input.contract, remainingMs: input.contract.limits.maxMinutes * 60_000,
  }));
  const runId = `run-${input.taskState}-${input.attemptStatus}`;
  const taskId = `task-${input.taskState}-${input.attemptStatus}`;
  const attemptId = `attempt-${input.taskState}-${input.attemptStatus}`;
  client.immediateTransaction(() => {
    const task = workflows.createWorkItem({
      id: taskId, sessionId: session.id, kind: "known-problem", scopeKey: "initial", state: "ready",
      input: { model: DEFAULT_RUN_CONFIG.model, reasoningEffort: "medium" },
    });
    const reservation = workflows.reserveBudget({
      sessionId: session.id, workItemId: task.id, operationKey: `initial:${task.id}`,
      kind: "model-call", reservedUnits: 2,
    });
    client.db.prepare(`INSERT INTO research_runs
      (id, thread_id, status, config_json, workflow_version, workflow_session_id, purpose, created_at, updated_at)
      VALUES (?, ?, ?, ?, 2, ?, 'known-problem', ?, ?)`)
      .run(runId, input.threadId, input.taskState === "running" ? "running" : "failed",
        JSON.stringify(DEFAULT_RUN_CONFIG), session.id, now, now);
    client.db.prepare(`INSERT INTO generation_attempts
      (id, generation_id, research_run_id, stage_key, provider_id, model_id, reasoning_effort,
        status, request_json, wire_request_sha256, request_sha256, work_order_sha256,
        inputs_sha256, evidence_sha256, schema_sha256, terminal_kind, error_code, created_at, updated_at)
      VALUES (?, ?, ?, 'discovery', 'openai-subscription', 'gpt-6-sol', 'medium',
        ?, '{}', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(attemptId, `generation-${attemptId}`, runId, input.attemptStatus,
        ...Array(6).fill("0".repeat(64)), input.attemptStatus === "failed" ? "provider-error" : null,
        input.errorCode ?? null, now, now);
    workflows.updateWorkItem(task.id, "running", { outputRefs: { runId } });
    if (input.taskState !== "running") {
      workflows.updateWorkItem(task.id, input.taskState, { outputRefs: { runId }, error: { message: "Provider attempt stopped" } });
      workflows.settleBudget(reservation.id, {
        state: input.taskState === "unknown" ? "uncertain" : "spent",
        settledUnits: input.taskState === "unknown" ? 2 : 1,
      });
      workflows.updateSession(session.id, session.revision, {
        state: "finished", outcome: input.taskState === "unknown" ? "needs-attention" : "partial",
      });
    }
  });
  const revision = workflows.getSession(session.id)!.revision;
  client.close();
  return { sessionId: session.id, taskId, attemptId, runId, revision };
}

test("a classified transient failure retries once in a bounded continuation and replays its command", async () => {
  const { directory, threadId, contract, request } = await fixture();
  const saved = saveAttemptFixture({ directory, threadId, contract, taskState: "failed", attemptStatus: "failed", errorCode: "timeout" });
  const before = await request(`/workflows/${saved.sessionId}`);
  expect(before.status).toBe(200);
  const detail = WorkflowDetailSchema.parse((await before.json() as { data: unknown }).data);
  expect(detail.tasks[0]?.terminalAttemptId).toBe(saved.attemptId);
  const command = {
    threadId, sessionId: saved.sessionId, clientCommandId: "retry-safe-once", expectedRevision: saved.revision,
    action: { type: "retry-task", taskId: saved.taskId, expectedTerminalAttemptId: saved.attemptId },
  };
  const first = await request("/workflows/command", command);
  if (first.status !== 200) throw new Error(`Retry returned ${first.status}: ${await first.text()}; ${errors.join("; ")}`);
  expect(first.status).toBe(200);
  const receipt = WorkflowAdmissionReceiptSchema.parse((await first.json() as { data: unknown }).data);
  expect(receipt.sessionId).not.toBe(saved.sessionId);
  expect(receipt.summary.budget.modelCalls.limit).toBeLessThanOrEqual(contract.limits.maxModelCalls);
  expect(receipt.summary.budget.searches.limit).toBeLessThanOrEqual(contract.limits.maxSearches);

  const replay = await request("/workflows/command", command);
  expect(replay.status).toBe(200);
  expect(WorkflowAdmissionReceiptSchema.parse((await replay.json() as { data: unknown }).data).sessionId).toBe(receipt.sessionId);
  const changed = await request("/workflows/command", {
    ...command, action: { ...command.action, acknowledgeUnknownCompletion: true },
  });
  expect(changed.status).toBe(409);
  expect((await changed.json() as { error: { code: string } }).error.code).toBe("IDEMPOTENCY_CONFLICT");
  const second = await request("/workflows/command", { ...command, clientCommandId: "retry-safe-twice" });
  expect(second.status).toBe(409);
  expect((await second.json() as { error: { code: string } }).error.code).toBe("conflict");
  const client = new DatabaseClient(join(directory, "scraply.db"));
  expect((client.db.prepare("SELECT COUNT(*) AS count FROM workflow_sessions WHERE thread_id = ?")
    .get(threadId) as { count: number }).count).toBe(2);
  expect((client.db.prepare("SELECT COUNT(*) AS count FROM workflow_work_items WHERE session_id = ? AND scope_key = ?")
    .get(receipt.sessionId, `retry:${saved.taskId}`) as { count: number }).count).toBe(1);
  client.close();
});

test("generation retry carries accepted and deferred batches into one target", async () => {
  const { directory, threadId, contract, request } = await fixture();
  const client = new DatabaseClient(join(directory, "scraply.db"));
  const workflows = new WorkflowRepository(client);
  const now = new Date().toISOString();
  const sourceConfig = JSON.stringify(DEFAULT_RUN_CONFIG);
  client.db.prepare(`INSERT INTO research_runs (id, thread_id, status, config_json, workflow_version, created_at, updated_at)
    VALUES ('retry-source', ?, 'completed', ?, 2, ?, ?)`).run(threadId, sourceConfig, now, now);
  client.db.prepare(`INSERT INTO scopes (id, research_run_id, title, audience, domain, observations, off_limits_json, created_at, updated_at)
    VALUES ('retry-scope', 'retry-source', 'Synthetic continuation', '', '', '', '[]', ?, ?)`).run(now, now);
  client.db.prepare(`INSERT INTO problems (id, discovery_run_id, statement, why_it_persists,
    affected, scale_estimate, verdict, verdict_reason, verdict_source_ids_json, created_at)
    VALUES ('retry-problem', 'retry-source', 'One synthetic problem', '', '', '', 'confirmed', '', '[]', ?)`)
    .run(now);
  const continuationContract = WorkflowLaunchContractSchema.parse({ ...contract,
    targets: { kind: "per-problem", ideaCount: 3 }, limits: { ...contract.limits, maxModelCalls: 12 } });
  const session = client.immediateTransaction(() => workflows.createSession({
    threadId, purpose: continuationContract.purpose, mode: continuationContract.mode,
    contract: continuationContract, remainingMs: continuationContract.limits.maxMinutes * 60_000,
  }));
  const failed = client.immediateTransaction(() => {
    const materialized = materializeResearchSnapshot(client, {
      threadId, baseRunId: "retry-source", sourceProblemIds: ["retry-problem"], sessionId: session.id,
    });
    const snapshot = workflows.createSnapshot({ sessionId: session.id,
      materializationRunId: materialized.runId,
      selection: { problemIds: materialized.problemIds }, originMap: materialized.originMap });
    workflows.updateSession(session.id, session.revision, { activeSnapshotId: snapshot.id });
    const items = Array.from({ length: 3 }, (_, index) => {
      const item = workflows.createWorkItem({ sessionId: session.id, kind: "generate-ideas",
        scopeKey: `batch:${index}`, ordinal: index, state: "ready",
        input: { problemId: materialized.problemIds[0], snapshotId: snapshot.id, quota: 1,
          fillRound: 0, targetKind: "per-problem", requestedTarget: 3,
          model: DEFAULT_RUN_CONFIG.model, reasoningEffort: "medium",
          reviewModel: DEFAULT_RUN_CONFIG.model, reviewReasoningEffort: "medium" },
      });
      const reservation = workflows.reserveBudget({ sessionId: session.id, workItemId: item.id,
        operationKey: `batch:${item.id}`, kind: "model-call", reservedUnits: 4 });
      return { item, reservation };
    });
    workflows.updateWorkItem(items[0]!.item.id, "running");
    workflows.updateWorkItem(items[0]!.item.id, "succeeded", {
      outputRefs: { runId: "prior-success", solutionIds: ["accepted-before-retry"], proposedSolutionIds: ["accepted-before-retry"] },
    });
    workflows.settleBudget(items[0]!.reservation.id, { state: "spent", settledUnits: 1 });
    client.db.prepare(`INSERT INTO research_runs
      (id, thread_id, status, config_json, problem_id, workflow_version, workflow_session_id, purpose, created_at, updated_at)
      VALUES ('retry-failed-run', ?, 'failed', ?, ?, 2, ?, 'idea-batch', ?, ?)`)
      .run(threadId, sourceConfig, materialized.problemIds[0], session.id, now, now);
    client.db.prepare(`INSERT INTO generation_attempts
      (id, generation_id, research_run_id, stage_key, provider_id, model_id, reasoning_effort,
        status, request_json, wire_request_sha256, request_sha256, work_order_sha256,
        inputs_sha256, evidence_sha256, schema_sha256, terminal_kind, error_code, created_at, updated_at)
      VALUES ('retry-failed-attempt', 'retry-failed-generation', 'retry-failed-run', 'ideas',
        'openai-subscription', 'gpt-6-sol', 'medium', 'failed', '{}', ?, ?, ?, ?, ?, ?,
        'provider-error', 'timeout', ?, ?)`).run(...Array(6).fill("0".repeat(64)), now, now);
    workflows.updateWorkItem(items[1]!.item.id, "running", { outputRefs: { runId: "retry-failed-run" } });
    workflows.updateWorkItem(items[1]!.item.id, "failed", {
      outputRefs: { runId: "retry-failed-run" }, error: { message: "Timed out" },
    });
    workflows.settleBudget(items[1]!.reservation.id, { state: "spent", settledUnits: 1 });
    workflows.updateWorkItem(items[2]!.item.id, "skipped", {
      error: { reason: "upstream-failed", message: "Deferred after a failed task." },
    });
    workflows.settleBudget(items[2]!.reservation.id, { state: "released", settledUnits: 0 });
    workflows.updateSession(session.id, workflows.getSession(session.id)!.revision, { state: "finished", outcome: "partial" });
    return items[1]!.item.id;
  });
  const revision = workflows.getSession(session.id)!.revision;
  client.close();

  const response = await request("/workflows/command", {
    threadId, sessionId: session.id, clientCommandId: "retry-carries-all-batches", expectedRevision: revision,
    action: { type: "retry-task", taskId: failed, expectedTerminalAttemptId: "retry-failed-attempt" },
  });
  if (response.status !== 200) throw new Error(`Continuation returned ${response.status}: ${await response.text()}`);
  const receipt = WorkflowAdmissionReceiptSchema.parse((await response.json() as { data: unknown }).data);
  expect(receipt.sessionId).not.toBe(session.id);
  expect(receipt.summary.counts).toMatchObject({ requested: 3, accepted: 1, missing: 2 });
  const reopened = new DatabaseClient(join(directory, "scraply.db"));
  const carried = new WorkflowRepository(reopened).listWorkItems(receipt.sessionId);
  reopened.close();
  expect(carried).toHaveLength(3);
  expect(carried.filter((item) => item.state === "succeeded")).toHaveLength(1);
  expect(carried.filter((item) => (item.input as { retryOfTaskId?: string }).retryOfTaskId === failed)).toHaveLength(1);
  expect(carried.filter((item) => (item.input as { continuationOfTaskId?: string }).continuationOfTaskId)).toHaveLength(2);
});

test("an uncertain provider outcome requires explicit acknowledgment before a retry", async () => {
  const { directory, threadId, contract, request } = await fixture();
  const saved = saveAttemptFixture({ directory, threadId, contract, taskState: "unknown", attemptStatus: "accepted" });
  const command = {
    threadId, sessionId: saved.sessionId, clientCommandId: "retry-unknown", expectedRevision: saved.revision,
    action: { type: "retry-task", taskId: saved.taskId, expectedTerminalAttemptId: saved.attemptId },
  };
  const blocked = await request("/workflows/command", command);
  expect(blocked.status).toBe(409);
  expect((await blocked.json() as { error: { code: string } }).error.code).toBe("UNKNOWN_COMPLETION");
  const client = new DatabaseClient(join(directory, "scraply.db"));
  expect((client.db.prepare("SELECT COUNT(*) AS count FROM workflow_sessions WHERE thread_id = ?")
    .get(threadId) as { count: number }).count).toBe(1);
  client.close();
  const acknowledged = await request("/workflows/command", {
    ...command, action: { ...command.action, acknowledgeUnknownCompletion: true },
  });
  if (acknowledged.status !== 200) throw new Error(`Acknowledged retry returned ${acknowledged.status}: ${await acknowledged.text()}; ${errors.join("; ")}`);
  expect(acknowledged.status).toBe(200);
  expect(WorkflowAdmissionReceiptSchema.parse((await acknowledged.json() as { data: unknown }).data).sessionId).not.toBe(saved.sessionId);
});

test("startup marks an interrupted dispatched task uncertain without silently dispatching it", async () => {
  const { directory, threadId, contract, handle } = await fixture();
  const saved = saveAttemptFixture({ directory, threadId, contract, taskState: "running", attemptStatus: "accepted" });
  await closeBackend(handle);
  const reopened = await openBackend(directory);
  const response = await reopened.request(`/workflows/${saved.sessionId}`);
  expect(response.status).toBe(200);
  const detail = WorkflowDetailSchema.parse((await response.json() as { data: unknown }).data);
  expect(detail.summary.state).toBe("finished");
  expect(detail.summary.outcome).toBe("needs-attention");
  expect(detail.tasks[0]?.state).toBe("unknown");
  expect(detail.tasks[0]?.terminalAttemptId).toBe(saved.attemptId);
  const client = new DatabaseClient(join(directory, "scraply.db"));
  expect((client.db.prepare("SELECT status FROM generation_attempts WHERE id = ?")
    .get(saved.attemptId) as { status: string }).status).toBe("interrupted");
  expect((client.db.prepare("SELECT state FROM workflow_budget_entries WHERE work_item_id = ?")
    .get(saved.taskId) as { state: string }).state).toBe("uncertain");
  expect((client.db.prepare("SELECT COUNT(*) AS count FROM research_runs WHERE thread_id = ?")
    .get(threadId) as { count: number }).count).toBe(1);
  client.close();
  await closeBackend(reopened.handle);
  const reopenedAgain = await openBackend(directory);
  const repeated = WorkflowDetailSchema.parse((await (await reopenedAgain.request(`/workflows/${saved.sessionId}`)).json() as { data: unknown }).data);
  expect(repeated.summary.state).toBe("finished");
  expect(repeated.tasks[0]?.state).toBe("unknown");
  const verify = new DatabaseClient(join(directory, "scraply.db"));
  expect((verify.db.prepare("SELECT COUNT(*) AS count FROM research_runs WHERE thread_id = ?")
    .get(threadId) as { count: number }).count).toBe(1);
  verify.close();
});
