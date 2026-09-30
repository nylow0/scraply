import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { ApiResponseSchema, IPC_CHANNELS, WorkspaceStateSchema } from "../src/shared/ipc";
import {
  PreviewWorkflowResultSchema, WorkflowAdmissionReceiptSchema, WorkflowDetailSchema,
  WorkflowLaunchContractSchema, WorkflowLaunchDraftSchema,
} from "../src/shared/workflow-contracts";

// The installed database is only read. Live verification creates one development project,
// preserves the failed research settings, and never retries a lost provider completion.
const { values } = parseArgs({ options: {
  live: { type: "boolean", default: false },
  prepare: { type: "boolean", default: false },
  attempt: { type: "string" },
  origin: { type: "string", default: "http://127.0.0.1:5178" },
  "source-db": { type: "string" },
  "dev-db": { type: "string" },
  "timeout-minutes": { type: "string", default: "120" },
  mode: { type: "string", default: "controlled" },
  monitor: { type: "string" },
  help: { type: "boolean", default: false },
} });

if (values.help) {
  console.log("bun scripts/verify-research-stream.ts [--attempt ID] [--prepare | --live | --monitor SESSION_ID] [--timeout-minutes 120] [--mode controlled|original]");
  console.log("Without --prepare, --live or --monitor: inspect saved failure metadata, with no app writes or provider calls.");
  console.log("--prepare: create/save development scope and settings, without preview or provider dispatch. Launch using the browser UI.");
  console.log("--live: launch one new development research project. Controlled stops before paid idea generation; original preserves Vibe.");
  process.exit(0);
}

const root = resolve(import.meta.dir, "..");
const installedPath = values["source-db"] ?? join(process.env.APPDATA ?? "", "scraply", "scraply", "scraply.db");
const devPath = values["dev-db"] ?? join(root, ".scraply", "browser-dev", "scraply", "scraply.db");
const origin = new URL(values.origin);
const timeoutMinutes = Number(values["timeout-minutes"]);
if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.pathname !== "/" || origin.search || origin.hash) {
  throw new Error("Use the local browser development origin at http://127.0.0.1:PORT.");
}
if (!Number.isFinite(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 240) throw new Error("timeout-minutes must be between 1 and 240.");
if (values.mode !== "controlled" && values.mode !== "original") throw new Error("mode must be controlled or original.");
if ([values.live, values.prepare, Boolean(values.monitor)].filter(Boolean).length > 1) throw new Error("Choose --prepare, --live or --monitor.");

const SavedFailureSchema = z.object({
  id: z.string(), research_run_id: z.string(), stage_key: z.string(), status: z.string(),
  created_at: z.string(), updated_at: z.string(), request_json: z.string(), contract_json: z.string(),
});
const sourceDb = new Database(installedPath, { readonly: true });
let saved: z.infer<typeof SavedFailureSchema>;
try {
  const query = `SELECT attempt.id, attempt.research_run_id, attempt.stage_key, attempt.status,
    attempt.created_at, attempt.updated_at, attempt.request_json, session.contract_json
    FROM generation_attempts attempt JOIN research_runs run ON run.id = attempt.research_run_id
    JOIN workflow_sessions session ON session.id = run.workflow_session_id
    WHERE attempt.stage_key LIKE 'factor-harvest:%' AND attempt.status IN ('failed', 'interrupted')
    ${values.attempt ? "AND attempt.id = ?" : ""} ORDER BY attempt.created_at DESC LIMIT 1`;
  const statement = sourceDb.query(query);
  saved = SavedFailureSchema.parse(values.attempt ? statement.get(values.attempt) : statement.get());
} finally {
  sourceDb.close();
}
const contract = WorkflowLaunchContractSchema.parse(JSON.parse(saved.contract_json));
const RequestSchema = z.object({
  model: z.object({ providerId: z.string(), modelId: z.string() }), reasoningEffort: z.string(),
  workOrder: z.object({ inputs: z.object({ routing: z.object({ factorLimit: z.number() }) }) }),
  evidence: z.array(z.object({ content: z.object({ sources: z.array(z.unknown()) }).passthrough() })),
});
const request = RequestSchema.parse(JSON.parse(saved.request_json));
const fingerprint = createHash("sha256").update(JSON.stringify({
  brief: contract.brief, scope: contract.scope, runConfig: contract.runConfig,
  researchInstruction: contract.instructions.research ?? "",
})).digest("hex");
console.log(JSON.stringify({ type: "saved-failure", attemptId: saved.id, runId: saved.research_run_id,
  model: request.model, reasoningEffort: request.reasoningEffort, depth: contract.runConfig.discoveryDepth,
  searchProvider: contract.runConfig.searchProvider, originalMode: contract.mode, researchFingerprint: fingerprint,
  sourceCount: request.evidence[0]?.content.sources.length,
  packetCharacters: JSON.stringify(request.evidence[0]?.content).length,
  factorLimit: request.workOrder.inputs.routing.factorLimit,
  elapsedMs: Date.parse(saved.updated_at) - Date.parse(saved.created_at),
}));
if (!values.live && !values.prepare && !values.monitor) process.exit(0);

if (!existsSync(devPath) || realpathSync(devPath).toLowerCase() === realpathSync(installedPath).toLowerCase()) {
  throw new Error("A separate development database is required. Start bun run dev first.");
}

async function invoke<T extends z.ZodType>(channel: string, schema: T, payload?: unknown): Promise<z.infer<T>> {
  const response = await fetch(new URL("/__scraply_dev/invoke", origin), {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin.origin },
    body: JSON.stringify({ channel, args: payload === undefined ? [] : [payload] }),
    signal: AbortSignal.timeout(15_000),
  });
  const envelope = z.object({ data: z.unknown().optional(), error: z.string().optional() }).parse(await response.json());
  if (!response.ok) throw new Error(envelope.error ?? `Development request failed, HTTP ${response.status}.`);
  return schema.parse(envelope.data);
}

let sessionId = values.monitor;
if (!sessionId) {
  const before = await invoke(IPC_CHANNELS.GET_WORKSPACE, WorkspaceStateSchema);
  if (before.activeWorkflow && before.activeWorkflow.state !== "finished" && before.activeWorkflow.state !== "waiting-for-review") {
    throw new Error("The development project already has an active workflow. Do not start another paid verification concurrently.");
  }
  if (!before.validation.native.connected || !before.validation[contract.runConfig.searchProvider].valid) {
    throw new Error("Connect the existing OpenAI account and selected search provider in development before verification.");
  }
  const created = await invoke(IPC_CHANNELS.CREATE_THREAD, z.object({ workspace: WorkspaceStateSchema }), {
    title: `Stream verification ${new Date().toISOString()}`,
  });
  const threadId = created.workspace.activeThreadId;
  if (!threadId) throw new Error("New development project was not selected.");
  await invoke(IPC_CHANNELS.SAVE_SCOPE, WorkspaceStateSchema, { threadId, scope: contract.scope });
  await invoke(IPC_CHANNELS.SAVE_RUN_CONFIG, WorkspaceStateSchema, { threadId, config: contract.runConfig });
  if (values.prepare) {
    console.log(JSON.stringify({ type: "prepared", threadId, browserUrl: origin.origin,
      model: contract.runConfig.model, reasoningEffort: contract.runConfig.reasoningEffort,
      depth: contract.runConfig.discoveryDepth, searchProvider: contract.runConfig.searchProvider,
      researchFingerprint: fingerprint, researchInstructionCharacters: (contract.instructions.research ?? "").length,
      launchModeToSelect: values.mode === "controlled" ? "Controlled" : contract.mode === "vibe" ? "Vibe" : "Controlled",
      monitorCommand: "bun scripts/verify-research-stream.ts --monitor SESSION_ID",
    }));
    process.exit(0);
  }
  const draft = WorkflowLaunchDraftSchema.parse({ contractVersion: contract.contractVersion,
    purpose: contract.purpose, mode: values.mode === "controlled" ? "babysit" : contract.mode,
    brief: contract.brief, scope: contract.scope, runConfig: contract.runConfig,
    ...(contract.ideas ? { ideas: contract.ideas } : {}), targets: contract.targets,
    limits: contract.limits, instructions: contract.instructions,
  });
  const preview = await invoke(IPC_CHANNELS.PREVIEW_WORKFLOW, ApiResponseSchema(PreviewWorkflowResultSchema), {
    type: "launch", threadId, draft,
  });
  if (!preview.ok) throw new Error(`Preview rejected: ${preview.error.code}.`);
  if (preview.data.fieldErrors.length) throw new Error(`Preview has ${preview.data.fieldErrors.length} field errors.`);
  const receipt = await invoke(IPC_CHANNELS.START_WORKFLOW, ApiResponseSchema(WorkflowAdmissionReceiptSchema), {
    threadId, clientCommandId: randomUUID(), contract: preview.data.proposal,
    previewHash: preview.data.previewHash, capabilityFingerprint: preview.data.capabilityFingerprint,
    previewExpiresAt: preview.data.expiresAt,
  });
  if (!receipt.ok) throw new Error(`Launch rejected: ${receipt.error.code}.`);
  sessionId = receipt.data.sessionId;
  console.log(JSON.stringify({ type: "launched", threadId, sessionId, mode: draft.mode,
    origin: origin.origin, timeoutMinutes, stopCondition: draft.mode === "babysit" ? "completed discovery ready for review" : "finished original workflow" }));
}

const db = new Database(devPath, { readonly: true });
const AttemptSchema = z.object({ stage_key: z.string(), status: z.string(), elapsedMs: z.number().nullable() });
const session = z.object({ contract_json: z.string() }).parse(db.query("SELECT contract_json FROM workflow_sessions WHERE id = ?").get(sessionId));
const liveContract = WorkflowLaunchContractSchema.parse(JSON.parse(session.contract_json));
const liveFingerprint = createHash("sha256").update(JSON.stringify({
  brief: liveContract.brief, scope: liveContract.scope, runConfig: liveContract.runConfig,
  researchInstruction: liveContract.instructions.research ?? "",
})).digest("hex");
if (liveFingerprint !== fingerprint) throw new Error("The monitored workflow does not match the saved failing research settings.");
let previousStatus = "";
let completed = false;
let stopAfterTimeout = false;
// A saved run can resume hours later. Bound this observation, not the original
// launch, and keep monitor-only invocations from cancelling someone else's work.
const verificationStartedAt = Date.now();
try {
  for (;;) {
    const result = await invoke(IPC_CHANNELS.GET_WORKFLOW, ApiResponseSchema(WorkflowDetailSchema), { sessionId });
    if (!result.ok) throw new Error(`Workflow read rejected: ${result.error.code}.`);
    const detail = result.data;
    const attempts = AttemptSchema.array().parse(db.query(`SELECT attempt.stage_key, attempt.status,
      CAST((julianday(attempt.updated_at) - julianday(attempt.created_at)) * 86400000 AS INTEGER) AS elapsedMs
      FROM generation_attempts attempt JOIN research_runs run ON run.id = attempt.research_run_id
      WHERE run.workflow_session_id = ? ORDER BY attempt.created_at`).all(sessionId));
    // An acknowledged retry preserves uncertain history. Verify the latest work for each
    // stage while reporting those historical attempts instead of treating them as erased.
    const latestStages = new Map(attempts.map(attempt => [attempt.stage_key, attempt]));
    const harvests = [...latestStages.values()].filter(attempt => attempt.stage_key.startsWith("factor-harvest:"));
    const historicalUnknownAttempts = attempts.filter(attempt => attempt.status === "interrupted").length;
    const status = { state: detail.summary.state, outcome: detail.summary.outcome,
      stage: detail.summary.currentStage, completedHarvests: harvests.filter(attempt => attempt.status === "completed").length,
      modelCalls: detail.summary.budget.modelCalls.spent, searches: detail.summary.budget.searches.spent,
      historicalUnknownAttempts,
      attemptStates: attempts.map(attempt => ({ stage: attempt.stage_key.split(":")[0], status: attempt.status, elapsedMs: attempt.elapsedMs })),
    };
    const serialized = JSON.stringify(status);
    if (serialized !== previousStatus) {
      console.log(JSON.stringify({ type: "progress", sessionId, ...status }));
      previousStatus = serialized;
    }
    const discovery = detail.tasks.find(task => task.kind === "discovery");
    if (detail.summary.state === "finished" || detail.summary.state === "waiting-for-review") {
      if (discovery?.state !== "succeeded" || harvests.length === 0 || harvests.some(attempt => attempt.status !== "completed")) {
        throw new Error(`Research did not complete: outcome ${detail.summary.outcome}, discovery ${discovery?.state}. No automatic retry.`);
      }
      if (liveContract.mode === "vibe" && detail.summary.outcome !== "target-met" && detail.summary.outcome !== "no-qualifying-ideas" && detail.summary.outcome !== "partial") {
        throw new Error(`Original workflow failed after research: ${detail.summary.outcome}.`);
      }
      const workspace = await invoke(IPC_CHANNELS.GET_WORKSPACE, WorkspaceStateSchema);
      if (workspace.activeThreadId !== detail.summary.threadId || workspace.activeWorkflow?.sessionId !== sessionId) {
        throw new Error("Completed research is not the active development workspace for browser verification.");
      }
      // Refetch the persisted detail rather than accepting the first terminal event alone.
      const reopened = await invoke(IPC_CHANNELS.GET_WORKFLOW, ApiResponseSchema(WorkflowDetailSchema), { sessionId });
      if (!reopened.ok || reopened.data.summary.state !== detail.summary.state) throw new Error("Saved workflow state changed after completion.");
      completed = true;
      console.log(JSON.stringify({ type: "passed", sessionId, threadId: detail.summary.threadId,
        model: liveContract.runConfig.model, reasoningEffort: liveContract.runConfig.reasoningEffort,
        completedHarvests: status.completedHarvests, modelCalls: status.modelCalls, searches: status.searches,
        historicalUnknownAttempts,
        problemCandidates: workspace.problemCandidates.length, rejectedCandidates: workspace.rejectedProblemCandidates.length,
        persistedState: reopened.data.summary.state, browserUrl: origin.origin,
      }));
      break;
    }
    if (Date.now() - verificationStartedAt > timeoutMinutes * 60_000) {
      stopAfterTimeout = values.live;
      throw new Error(`Verification exceeded ${timeoutMinutes} minutes; ${stopAfterTimeout
        ? "stopping this development workflow" : "the monitored workflow remains running"}.`);
    }
    await delay(5_000);
  }
} finally {
  db.close();
  if (!completed && stopAfterTimeout) {
    const latest = await invoke(IPC_CHANNELS.GET_WORKFLOW, ApiResponseSchema(WorkflowDetailSchema), { sessionId });
    if (latest.ok && latest.data.summary.state !== "finished" && latest.data.summary.state !== "waiting-for-review") {
      const stopped = await invoke(IPC_CHANNELS.COMMAND_WORKFLOW, ApiResponseSchema(WorkflowAdmissionReceiptSchema), {
        threadId: latest.data.summary.threadId, sessionId, clientCommandId: randomUUID(),
        expectedRevision: latest.data.summary.revision, action: { type: "stop" },
      });
      if (!stopped.ok) console.error(`Could not stop development verification: ${stopped.error.code}.`);
    }
  }
}
