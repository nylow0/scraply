import { randomUUID } from "node:crypto";
import { canonicalJson, sha256 } from "../../shared/content-identity";
import type { RunConfig } from "../../shared/schemas";
import type { DatabaseClient } from "../client";

export type WorkflowPurpose = "discovery" | "known-problem" | "research-followup" | "idea-turn";
export type WorkflowMode = "babysit" | "vibe";
export type WorkflowState = "running" | "waiting-for-review" | "pause-requested" | "stop-requested" | "paused" | "finished";
export type WorkflowOutcome = "target-met" | "partial" | "no-qualifying-ideas" | "failed" | "cancelled" | "needs-attention";
export type WorkItemState = "planned" | "ready" | "running" | "succeeded" | "failed" | "cancelled" | "skipped" | "unknown";
export type BudgetState = "reserved" | "spent" | "uncertain" | "released";
export type IdeaTurnState = "pending" | "completed" | "failed" | "unknown" | "cancelled";

export class WorkflowConflictError extends Error {
  readonly code: "REVISION_CONFLICT" | "IDEMPOTENCY_CONFLICT" | "INVALID_REFERENCE" | "PROJECT_BUSY";

  constructor(code: WorkflowConflictError["code"], message: string) {
    super(message);
    this.name = "WorkflowConflictError";
    this.code = code;
  }
}

export interface WorkflowSession {
  id: string;
  threadId: string;
  purpose: WorkflowPurpose;
  mode: WorkflowMode;
  contract: unknown;
  contractSha256: string;
  state: WorkflowState;
  outcome: WorkflowOutcome | null;
  revision: number;
  activeSnapshotId: string | null;
  remainingMs: number;
  additionalModelCalls: number;
  additionalSearches: number;
  additionalMinutes: number;
  runningSince: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface WorkflowCommand {
  id: string;
  threadId: string;
  sessionId: string;
  clientCommandId: string;
  payloadSha256: string;
  result: unknown;
  createdAt: string;
}

export interface WorkflowWorkItem {
  id: string;
  sessionId: string;
  parentItemId: string | null;
  kind: string;
  scopeKey: string;
  ordinal: number;
  dependencies: string[];
  input: unknown;
  inputSha256: string;
  state: WorkItemState;
  outputRefs: unknown | null;
  error: unknown | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface WorkflowBudgetEntry {
  id: string;
  sessionId: string;
  workItemId: string;
  operationKey: string;
  kind: "model-call" | "search";
  reservedUnits: number;
  settledUnits: number | null;
  state: BudgetState;
  generationAttemptId: string | null;
  opportunityAttemptId: string | null;
  createdAt: string;
  settledAt: string | null;
}

export interface WorkflowBudgetTotals {
  modelCalls: { reserved: number; spent: number; uncertain: number; released: number };
  searches: { reserved: number; spent: number; uncertain: number; released: number };
}

export interface SnapshotOriginEntry {
  originalId: string;
  originalRunId: string;
  contentSha256: string;
}

export interface SnapshotOriginMap {
  sources: Record<string, SnapshotOriginEntry[]>;
  factors: Record<string, SnapshotOriginEntry>;
  problems: Record<string, SnapshotOriginEntry>;
}

export interface EvidenceSnapshot {
  id: string;
  sessionId: string;
  parentSnapshotId: string | null;
  materializationRunId: string;
  selection: { problemIds: string[]; [key: string]: unknown };
  originMap: SnapshotOriginMap;
  contentSha256: string;
  createdByCommandId: string | null;
  createdAt: string;
}

export interface IdeaTurn {
  id: string;
  rootSolutionId: string;
  branchId: string;
  branchSequence: number;
  parentTurnId: string | null;
  baseSolutionId: string;
  evidenceSnapshotId: string | null;
  sessionId: string;
  clientMessageId: string;
  intent: "explain" | "explore-directions" | "rethink";
  userText: string;
  context: unknown;
  contextSha256: string;
  state: IdeaTurnState;
  assistant: unknown | null;
  stageResultId: string | null;
  generatedSolutionId: string | null;
  error: unknown | null;
  createdAt: string;
  completedAt: string | null;
}

export interface SolutionLineage {
  solutionId: string;
  rootSolutionId: string;
  parentSolutionId: string | null;
  versionNumber: number;
  turnId: string | null;
  evidenceSnapshotId: string | null;
  changeSummary: string;
  createdAt: string;
}

interface SessionRow {
  id: string; thread_id: string; purpose: WorkflowPurpose; mode: WorkflowMode;
  contract_json: string; contract_sha256: string; state: WorkflowState;
  outcome: WorkflowOutcome | null; revision: number; active_snapshot_id: string | null;
  remaining_ms: number; additional_model_calls: number; additional_searches: number;
  additional_minutes: number; running_since: string | null; started_at: string; finished_at: string | null;
}
interface CommandRow {
  id: string; thread_id: string; session_id: string; client_command_id: string;
  payload_sha256: string; result_json: string; created_at: string;
}
interface WorkItemRow {
  id: string; session_id: string; parent_item_id: string | null; kind: string; scope_key: string;
  ordinal: number; dependencies_json: string; input_json: string; input_sha256: string;
  state: WorkItemState; output_refs_json: string | null; error_json: string | null;
  created_at: string; finished_at: string | null;
}
interface BudgetRow {
  id: string; session_id: string; work_item_id: string; operation_key: string;
  kind: "model-call" | "search"; reserved_units: number; settled_units: number | null;
  state: BudgetState; generation_attempt_id: string | null; opportunity_attempt_id: string | null;
  created_at: string; settled_at: string | null;
}
interface SnapshotRow {
  id: string; session_id: string; parent_snapshot_id: string | null; materialization_run_id: string;
  selection_json: string; origin_map_json: string; content_sha256: string;
  created_by_command_id: string | null; created_at: string;
}
interface IdeaTurnRow {
  id: string; root_solution_id: string; branch_id: string; branch_sequence: number;
  parent_turn_id: string | null; base_solution_id: string; evidence_snapshot_id: string | null;
  session_id: string; client_message_id: string; intent: IdeaTurn["intent"]; user_text: string;
  context_json: string; context_sha256: string; state: IdeaTurnState; assistant_json: string | null;
  stage_result_id: string | null; generated_solution_id: string | null; error_json: string | null;
  created_at: string; completed_at: string | null;
}
interface LineageRow {
  solution_id: string; root_solution_id: string; parent_solution_id: string | null;
  version_number: number; turn_id: string | null; evidence_snapshot_id: string | null;
  change_summary: string; created_at: string;
}

const terminalWorkItemStates = new Set<WorkItemState>(["succeeded", "failed", "cancelled", "skipped", "unknown"]);
const workItemTransitions: Record<WorkItemState, WorkItemState[]> = {
  planned: ["ready", "cancelled", "skipped"],
  ready: ["running", "cancelled", "skipped"],
  running: ["succeeded", "failed", "cancelled", "unknown"],
  succeeded: [], failed: [], cancelled: [], skipped: [], unknown: [],
};

/** Mutations join a caller-owned immediate transaction; no transaction spans provider work. */
export class WorkflowRepository {
  constructor(private readonly client: DatabaseClient) {}

  createSession(input: {
    id?: string; threadId: string; purpose: WorkflowPurpose; mode: WorkflowMode;
    contract: unknown; remainingMs: number; startedAt?: string;
  }): WorkflowSession {
    this.client.requireImmediateTransaction();
    if (!Number.isSafeInteger(input.remainingMs) || input.remainingMs < 0) throw new Error("Invalid time allowance");
    const id = input.id ?? randomUUID();
    const startedAt = input.startedAt ?? new Date().toISOString();
    const contractJson = canonicalJson(input.contract);
    this.client.db.prepare(`
      INSERT INTO workflow_sessions (
        id, thread_id, purpose, mode, contract_json, contract_sha256, state,
        remaining_ms, running_since, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)
    `).run(id, input.threadId, input.purpose, input.mode, contractJson, sha256(contractJson), input.remainingMs, startedAt, startedAt);
    return this.requireSession(id);
  }

  getSession(id: string): WorkflowSession | null {
    const row = this.client.db.prepare("SELECT * FROM workflow_sessions WHERE id = ?").get(id) as SessionRow | undefined;
    return row ? decodeSession(row) : null;
  }

  getActiveSession(threadId: string): WorkflowSession | null {
    const row = this.client.db.prepare(`
      SELECT * FROM workflow_sessions WHERE thread_id = ? AND state != 'finished'
    `).get(threadId) as SessionRow | undefined;
    return row ? decodeSession(row) : null;
  }

  findSessionByRunId(runId: string): WorkflowSession | null {
    const row = this.client.db.prepare(`
      SELECT ws.* FROM workflow_sessions ws JOIN research_runs rr
        ON rr.workflow_session_id = ws.id WHERE rr.id = ?
    `).get(runId) as SessionRow | undefined;
    return row ? decodeSession(row) : null;
  }

  createRunWithinTransaction(input: {
    id?: string; threadId: string; sessionId: string;
    problemId?: string | null;
    purpose: "discovery" | "known-problem" | "idea-batch" | "research-followup" | "idea-turn";
    config: RunConfig; evidenceSnapshotId?: string | null; idempotencyKey?: string;
  }): { runId: string; created: boolean } {
    this.client.requireImmediateTransaction();
    const session = this.requireSession(input.sessionId);
    if (session.threadId !== input.threadId) {
      throw new WorkflowConflictError("INVALID_REFERENCE", "Workflow session belongs to another project");
    }
    if (session.state === "finished") throw new WorkflowConflictError("REVISION_CONFLICT", "Workflow session is finished");
    if ((input.config.workflowVersion ?? 1) !== 2) throw new Error("New workflow runs require workflow v2");
    if (input.evidenceSnapshotId) this.assertSnapshotInThread(input.evidenceSnapshotId, input.threadId);
    if (input.problemId) {
      const problem = this.client.db.prepare(`
        SELECT rr.thread_id FROM problems p JOIN research_runs rr ON rr.id = p.discovery_run_id
        WHERE p.id = ?
      `).get(input.problemId) as { thread_id: string } | undefined;
      if (!problem || problem.thread_id !== input.threadId) {
        throw new WorkflowConflictError("INVALID_REFERENCE", "Problem belongs to another project");
      }
    }
    const idempotencyKey = input.idempotencyKey ?? randomUUID();
    const configJson = JSON.stringify(input.config);
    const prior = this.client.db.prepare(`
      SELECT id, workflow_session_id, problem_id, config_json, purpose, evidence_snapshot_id
      FROM research_runs WHERE thread_id = ? AND idempotency_key = ?
    `).get(input.threadId, idempotencyKey) as {
      id: string; workflow_session_id: string | null; problem_id: string | null;
      config_json: string; purpose: string | null; evidence_snapshot_id: string | null;
    } | undefined;
    if (prior) {
      if (prior.workflow_session_id !== input.sessionId || prior.problem_id !== (input.problemId ?? null)
        || prior.config_json !== configJson || prior.purpose !== input.purpose
        || prior.evidence_snapshot_id !== (input.evidenceSnapshotId ?? null)) {
        throw new WorkflowConflictError("IDEMPOTENCY_CONFLICT", "Run idempotency key names another request");
      }
      return { runId: prior.id, created: false };
    }
    const active = this.client.db.prepare(`
      SELECT id FROM research_runs WHERE thread_id = ? AND status IN ('queued', 'running') LIMIT 1
    `).get(input.threadId) as { id: string } | undefined;
    if (active) throw new WorkflowConflictError("PROJECT_BUSY", "This project already has an active research run");
    const runId = input.id ?? randomUUID();
    const createdAt = new Date().toISOString();
    this.client.db.prepare(`
      INSERT INTO research_runs (
        id, thread_id, status, config_json, idempotency_key, cancelled,
        budget_limit, reserved_cost, committed_cost, problem_id, created_at, updated_at,
        workflow_version, workflow_session_id, purpose, evidence_snapshot_id
      ) VALUES (?, ?, 'running', ?, ?, 0, 1000, 0, 0, ?, ?, ?, 2, ?, ?, ?)
    `).run(runId, input.threadId, configJson, idempotencyKey, input.problemId ?? null,
      createdAt, createdAt, input.sessionId, input.purpose, input.evidenceSnapshotId ?? null);
    return { runId, created: true };
  }

  updateSession(id: string, expectedRevision: number, patch: {
    state?: WorkflowState;
    outcome?: WorkflowOutcome | null;
    activeSnapshotId?: string | null;
    remainingMs?: number;
    runningSince?: string | null;
    finishedAt?: string | null;
  }): WorkflowSession {
    this.client.requireImmediateTransaction();
    const current = this.requireSession(id);
    if (current.revision !== expectedRevision) throw new WorkflowConflictError("REVISION_CONFLICT", "Workflow revision changed");
    const state = patch.state ?? current.state;
    const outcome = patch.outcome === undefined ? current.outcome : patch.outcome;
    const activeSnapshotId = patch.activeSnapshotId === undefined ? current.activeSnapshotId : patch.activeSnapshotId;
    const remainingMs = patch.remainingMs ?? current.remainingMs;
    const runningSince = patch.runningSince === undefined
      ? (state === "running" || state === "pause-requested" || state === "stop-requested" ? current.runningSince ?? new Date().toISOString() : null)
      : patch.runningSince;
    const finishedAt = patch.finishedAt === undefined
      ? (state === "finished" ? current.finishedAt ?? new Date().toISOString() : null)
      : patch.finishedAt;
    if (!Number.isSafeInteger(remainingMs) || remainingMs < 0) throw new Error("Invalid remaining time");
    if (current.state === "finished") throw new WorkflowConflictError("REVISION_CONFLICT", "Finished workflow cannot change");
    if ((state === "finished") !== (outcome !== null)) throw new Error("Finished workflow requires an outcome");
    const changed = this.client.db.prepare(`
      UPDATE workflow_sessions SET state = ?, outcome = ?, active_snapshot_id = ?,
        remaining_ms = ?, running_since = ?, finished_at = ?, revision = revision + 1
      WHERE id = ? AND revision = ?
    `).run(state, outcome, activeSnapshotId, remainingMs, runningSince, finishedAt, id, expectedRevision);
    void changed;
    return this.requireSession(id);
  }

  extendLimits(id: string, expectedRevision: number, extension: {
    modelCalls: number; searches: number; minutes: number;
  }): WorkflowSession {
    this.client.requireImmediateTransaction();
    const current = this.requireSession(id);
    if (current.revision !== expectedRevision) throw new WorkflowConflictError("REVISION_CONFLICT", "Workflow revision changed");
    if (current.state === "finished") throw new WorkflowConflictError("REVISION_CONFLICT", "Finished workflow cannot extend");
    for (const value of [extension.modelCalls, extension.searches, extension.minutes]) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid budget extension");
    }
    if (extension.modelCalls + extension.searches + extension.minutes === 0) throw new Error("Empty budget extension");
    if (!Number.isSafeInteger(current.remainingMs + extension.minutes * 60_000)) {
      throw new Error("Time extension exceeds supported range");
    }
    this.client.db.prepare(`
      UPDATE workflow_sessions SET additional_model_calls = additional_model_calls + ?,
        additional_searches = additional_searches + ?, additional_minutes = additional_minutes + ?,
        remaining_ms = remaining_ms + ?, revision = revision + 1
      WHERE id = ? AND revision = ?
    `).run(extension.modelCalls, extension.searches, extension.minutes,
      extension.minutes * 60_000, id, expectedRevision);
    return this.requireSession(id);
  }

  getCommand(threadId: string, clientCommandId: string): WorkflowCommand | null {
    const row = this.client.db.prepare(`
      SELECT * FROM workflow_commands WHERE thread_id = ? AND client_command_id = ?
    `).get(threadId, clientCommandId) as CommandRow | undefined;
    return row ? decodeCommand(row) : null;
  }

  recordCommand(input: {
    id?: string; threadId: string; sessionId: string; clientCommandId: string;
    payload: unknown; result: unknown;
  }): { command: WorkflowCommand; created: boolean } {
    this.client.requireImmediateTransaction();
    const payloadSha256 = sha256(canonicalJson(input.payload));
    const existing = this.getCommand(input.threadId, input.clientCommandId);
    if (existing) {
      if (existing.payloadSha256 !== payloadSha256 || existing.sessionId !== input.sessionId) {
        throw new WorkflowConflictError("IDEMPOTENCY_CONFLICT", "Command ID already names a different request");
      }
      return { command: existing, created: false };
    }
    const id = input.id ?? randomUUID();
    this.client.db.prepare(`
      INSERT INTO workflow_commands
        (id, thread_id, session_id, client_command_id, payload_sha256, result_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.threadId, input.sessionId, input.clientCommandId,
      payloadSha256, canonicalJson(input.result), new Date().toISOString());
    return { command: this.getCommand(input.threadId, input.clientCommandId)!, created: true };
  }

  createWorkItem(input: {
    id?: string; sessionId: string; parentItemId?: string | null; kind: string;
    scopeKey: string; ordinal?: number; dependencies?: string[]; input: unknown;
    state?: "planned" | "ready";
  }): WorkflowWorkItem {
    this.client.requireImmediateTransaction();
    this.requireSession(input.sessionId);
    const id = input.id ?? randomUUID();
    const dependencies = input.dependencies ?? [];
    if (!input.kind.trim() || !input.scopeKey.trim()) throw new Error("Work item kind and scope key are required");
    if (!Number.isSafeInteger(input.ordinal ?? 0) || (input.ordinal ?? 0) < 0) throw new Error("Invalid work item ordinal");
    if (new Set(dependencies).size !== dependencies.length || dependencies.includes(id)) {
      throw new WorkflowConflictError("INVALID_REFERENCE", "Work item dependencies must be unique and acyclic");
    }
    for (const dependencyId of dependencies) this.requireWorkItemInSession(dependencyId, input.sessionId);
    if (input.parentItemId) this.requireWorkItemInSession(input.parentItemId, input.sessionId);
    if (input.state === "ready" && dependencies.some((dependencyId) => this.requireWorkItem(dependencyId).state !== "succeeded")) {
      throw new Error("Ready work item has unfinished dependencies");
    }
    const inputJson = canonicalJson(input.input);
    this.client.db.prepare(`
      INSERT INTO workflow_work_items (
        id, session_id, parent_item_id, kind, scope_key, ordinal, dependencies_json,
        input_json, input_sha256, state, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.sessionId, input.parentItemId ?? null, input.kind, input.scopeKey,
      input.ordinal ?? 0, canonicalJson(dependencies), inputJson, sha256(inputJson),
      input.state ?? "planned", new Date().toISOString());
    return this.requireWorkItem(id);
  }

  getWorkItem(id: string): WorkflowWorkItem | null {
    const row = this.client.db.prepare("SELECT * FROM workflow_work_items WHERE id = ?").get(id) as WorkItemRow | undefined;
    return row ? decodeWorkItem(row) : null;
  }

  listWorkItems(sessionId: string): WorkflowWorkItem[] {
    const rows = this.client.db.prepare(`
      SELECT * FROM workflow_work_items WHERE session_id = ? ORDER BY ordinal, created_at, id
    `).all(sessionId) as WorkItemRow[];
    return rows.map(decodeWorkItem);
  }

  updateWorkItem(id: string, state: WorkItemState, details: {
    outputRefs?: unknown; error?: unknown;
  } = {}): WorkflowWorkItem {
    this.client.requireImmediateTransaction();
    const item = this.requireWorkItem(id);
    if (!workItemTransitions[item.state].includes(state)) throw new Error("Invalid work item transition");
    if (state === "ready" && item.dependencies.some((dependencyId) => this.requireWorkItem(dependencyId).state !== "succeeded")) {
      throw new Error("Work item dependencies have not succeeded");
    }
    this.client.db.prepare(`
      UPDATE workflow_work_items
      SET state = ?, output_refs_json = ?, error_json = ?, finished_at = ? WHERE id = ?
    `).run(state, details.outputRefs === undefined ? null : canonicalJson(details.outputRefs),
      details.error === undefined ? null : canonicalJson(details.error),
      terminalWorkItemStates.has(state) ? new Date().toISOString() : null, id);
    return this.requireWorkItem(id);
  }

  linkRunToRunningWorkItem(id: string, runId: string): WorkflowWorkItem {
    this.client.requireImmediateTransaction();
    const item = this.requireWorkItem(id);
    if (item.state !== "running" || item.outputRefs !== null) {
      throw new WorkflowConflictError("REVISION_CONFLICT", "The task is no longer waiting for a run link");
    }
    this.client.db.prepare("UPDATE workflow_work_items SET output_refs_json = ? WHERE id = ?")
      .run(canonicalJson({ runId }), id);
    return this.requireWorkItem(id);
  }

  linkCoverageAttemptToRunningWorkItem(id: string, attemptId: string): WorkflowWorkItem {
    this.client.requireImmediateTransaction();
    const item = this.requireWorkItem(id);
    if (!["coverage-map", "coverage-search"].includes(item.kind) || item.state !== "running" || item.outputRefs !== null) {
      throw new WorkflowConflictError("REVISION_CONFLICT", "The coverage task is no longer waiting for an attempt link");
    }
    this.client.db.prepare("UPDATE workflow_work_items SET output_refs_json = ? WHERE id = ?")
      .run(canonicalJson({ attemptId }), id);
    return this.requireWorkItem(id);
  }

  returnCoverageTaskToReady(id: string): WorkflowWorkItem {
    this.client.requireImmediateTransaction();
    const item = this.requireWorkItem(id);
    if (!["coverage-map", "coverage-search"].includes(item.kind) || item.state !== "running") {
      throw new WorkflowConflictError("REVISION_CONFLICT", "Only a running coverage task can return to the queue");
    }
    this.client.db.prepare("UPDATE workflow_work_items SET state = 'ready' WHERE id = ?").run(id);
    return this.requireWorkItem(id);
  }

  returnUndispatchedWorkItemToReady(id: string): WorkflowWorkItem {
    this.client.requireImmediateTransaction();
    const item = this.requireWorkItem(id);
    if (item.state !== "running" || item.outputRefs !== null) {
      throw new WorkflowConflictError("REVISION_CONFLICT", "Only a running task without a run can be returned to the queue");
    }
    this.client.db.prepare("UPDATE workflow_work_items SET state = 'ready' WHERE id = ?").run(id);
    return this.requireWorkItem(id);
  }

  reserveBudget(input: {
    id?: string; sessionId: string; workItemId: string; operationKey: string;
    kind: "model-call" | "search"; reservedUnits: number;
  }): WorkflowBudgetEntry {
    this.client.requireImmediateTransaction();
    this.requireWorkItemInSession(input.workItemId, input.sessionId);
    if (!Number.isSafeInteger(input.reservedUnits) || input.reservedUnits <= 0) throw new Error("Invalid reservation");
    const id = input.id ?? randomUUID();
    this.client.db.prepare(`
      INSERT INTO workflow_budget_entries
        (id, session_id, work_item_id, operation_key, kind, reserved_units, state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?)
    `).run(id, input.sessionId, input.workItemId, input.operationKey,
      input.kind, input.reservedUnits, new Date().toISOString());
    return this.requireBudgetEntry(id);
  }

  getBudgetEntry(id: string): WorkflowBudgetEntry | null {
    const row = this.client.db.prepare("SELECT * FROM workflow_budget_entries WHERE id = ?").get(id) as BudgetRow | undefined;
    return row ? decodeBudget(row) : null;
  }

  listBudgetEntries(sessionId: string): WorkflowBudgetEntry[] {
    const rows = this.client.db.prepare(`
      SELECT * FROM workflow_budget_entries WHERE session_id = ? ORDER BY created_at, id
    `).all(sessionId) as BudgetRow[];
    return rows.map(decodeBudget);
  }

  getBudgetTotals(sessionId: string): WorkflowBudgetTotals {
    const totals: WorkflowBudgetTotals = {
      modelCalls: { reserved: 0, spent: 0, uncertain: 0, released: 0 },
      searches: { reserved: 0, spent: 0, uncertain: 0, released: 0 },
    };
    for (const entry of this.listBudgetEntries(sessionId)) {
      const category = entry.kind === "model-call" ? totals.modelCalls : totals.searches;
      category[entry.state] += entry.state === "reserved"
        ? entry.reservedUnits : entry.settledUnits ?? 0;
    }
    return totals;
  }

  settleBudget(id: string, input: {
    state: Exclude<BudgetState, "reserved">; settledUnits: number;
    generationAttemptId?: string; opportunityAttemptId?: string;
  }): WorkflowBudgetEntry {
    this.client.requireImmediateTransaction();
    const entry = this.requireBudgetEntry(id);
    if (entry.state !== "reserved") throw new Error("Budget entry is already settled");
    if (!Number.isSafeInteger(input.settledUnits) || input.settledUnits < 0 || input.settledUnits > entry.reservedUnits) {
      throw new Error("Invalid settled units");
    }
    if (input.state === "uncertain" && input.settledUnits !== entry.reservedUnits) {
      throw new Error("Unknown completion consumes the full reservation");
    }
    if (input.state === "released" && input.settledUnits !== 0) throw new Error("Released reservation spends no units");
    if (input.generationAttemptId && input.opportunityAttemptId) throw new Error("A budget entry has at most one attempt");
    this.assertAttemptReference(entry, input);
    this.client.db.prepare(`
      UPDATE workflow_budget_entries SET state = ?, settled_units = ?,
        generation_attempt_id = ?, opportunity_attempt_id = ?, settled_at = ? WHERE id = ?
    `).run(input.state, input.settledUnits, input.generationAttemptId ?? null,
      input.opportunityAttemptId ?? null, new Date().toISOString(), id);
    return this.requireBudgetEntry(id);
  }

  private assertAttemptReference(entry: WorkflowBudgetEntry, input: {
    generationAttemptId?: string; opportunityAttemptId?: string;
  }): void {
    if (input.generationAttemptId) {
      const attempt = this.client.db.prepare(`
        SELECT ga.work_item_id, rr.workflow_session_id FROM generation_attempts ga
        JOIN research_runs rr ON rr.id = ga.research_run_id WHERE ga.id = ?
      `).get(input.generationAttemptId) as { work_item_id: string | null; workflow_session_id: string | null } | undefined;
      if (!attempt || attempt.work_item_id !== entry.workItemId || attempt.workflow_session_id !== entry.sessionId) {
        throw new WorkflowConflictError("INVALID_REFERENCE", "Generation attempt belongs to another work item");
      }
    }
    if (input.opportunityAttemptId) {
      const attempt = this.client.db.prepare(`
        SELECT oa.work_item_id, ws.id AS session_id FROM opportunity_exploration_attempts oa
        JOIN workflow_sessions ws ON ws.thread_id = oa.thread_id AND ws.id = oa.session_id
        WHERE ws.id = ? AND oa.id = ?
      `).get(entry.sessionId, input.opportunityAttemptId) as { work_item_id: string | null; session_id: string } | undefined;
      if (!attempt || attempt.work_item_id !== entry.workItemId) {
        throw new WorkflowConflictError("INVALID_REFERENCE", "Opportunity attempt belongs to another work item");
      }
    }
  }

  createSnapshot(input: {
    id?: string; sessionId: string; parentSnapshotId?: string | null;
    materializationRunId: string; selection: EvidenceSnapshot["selection"];
    originMap: SnapshotOriginMap; createdByCommandId?: string | null;
  }): EvidenceSnapshot {
    this.client.requireImmediateTransaction();
    const session = this.requireSession(input.sessionId);
    const run = this.client.db.prepare(`
      SELECT thread_id, workflow_session_id, status FROM research_runs WHERE id = ?
    `).get(input.materializationRunId) as {
      thread_id: string; workflow_session_id: string | null; status: string;
    } | undefined;
    if (!run || run.thread_id !== session.threadId || run.workflow_session_id !== session.id || run.status !== "completed") {
      throw new WorkflowConflictError("INVALID_REFERENCE", "Materialization run belongs to another session or is incomplete");
    }
    if (input.parentSnapshotId) {
      const parent = this.getSnapshot(input.parentSnapshotId);
      if (!parent) throw new WorkflowConflictError("INVALID_REFERENCE", "Parent snapshot is missing");
      this.assertSnapshotInThread(parent.id, session.threadId);
    }
    if (input.createdByCommandId) {
      const command = this.client.db.prepare("SELECT session_id FROM workflow_commands WHERE id = ?")
        .get(input.createdByCommandId) as { session_id: string } | undefined;
      if (!command || command.session_id !== session.id) {
        throw new WorkflowConflictError("INVALID_REFERENCE", "Snapshot command belongs to another session");
      }
    }
    if (!Array.isArray(input.selection.problemIds) || !input.selection.problemIds.length
      || new Set(input.selection.problemIds).size !== input.selection.problemIds.length) {
      throw new Error("Snapshot requires distinct selected problem IDs");
    }
    for (const problemId of input.selection.problemIds) {
      const problem = this.client.db.prepare("SELECT 1 FROM problems WHERE id = ? AND discovery_run_id = ?")
        .get(problemId, input.materializationRunId);
      if (!problem) throw new WorkflowConflictError("INVALID_REFERENCE", "Selected problem is outside the materialized run");
    }
    if (new Set(input.selection.problemIds).size !== Object.keys(input.originMap.problems).length
      || input.selection.problemIds.some((id) => !(id in input.originMap.problems))) {
      throw new Error("Selected problems must match materialized problem origins");
    }
    this.verifyOriginMap(session.threadId, input.materializationRunId, input.originMap);
    const selectionJson = canonicalJson(input.selection);
    const originMapJson = canonicalJson(input.originMap);
    const id = input.id ?? randomUUID();
    this.client.db.prepare(`
      INSERT INTO evidence_snapshots (
        id, session_id, parent_snapshot_id, materialization_run_id,
        selection_json, origin_map_json, content_sha256, created_by_command_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.sessionId, input.parentSnapshotId ?? null, input.materializationRunId,
      selectionJson, originMapJson, sha256(canonicalJson({ selection: input.selection, originMap: input.originMap })),
      input.createdByCommandId ?? null, new Date().toISOString());
    return this.requireSnapshot(id);
  }

  getSnapshot(id: string): EvidenceSnapshot | null {
    const row = this.client.db.prepare("SELECT * FROM evidence_snapshots WHERE id = ?").get(id) as SnapshotRow | undefined;
    return row ? decodeSnapshot(row) : null;
  }

  listSnapshots(sessionId: string): EvidenceSnapshot[] {
    const rows = this.client.db.prepare(`
      SELECT * FROM evidence_snapshots WHERE session_id = ? ORDER BY created_at, id
    `).all(sessionId) as SnapshotRow[];
    return rows.map(decodeSnapshot);
  }

  private verifyOriginMap(threadId: string, materializationRunId: string, map: SnapshotOriginMap): void {
    if (!map || !map.sources || !map.factors || !map.problems) throw new Error("Incomplete snapshot origin map");
    const assertMappedRows = (table: "sources" | "factors" | "problems", runColumn: "research_run_id" | "discovery_run_id", mapped: Record<string, unknown>) => {
      const rows = this.client.db.prepare(`SELECT id FROM ${table} WHERE ${runColumn} = ?`)
        .all(materializationRunId) as { id: string }[];
      if (rows.length !== Object.keys(mapped).length || rows.some((row) => !(row.id in mapped))) {
        throw new Error(`Every materialized ${table} row needs an origin`);
      }
    };
    assertMappedRows("sources", "research_run_id", map.sources);
    assertMappedRows("factors", "research_run_id", map.factors);
    assertMappedRows("problems", "discovery_run_id", map.problems);
    const verifyRun = (runId: string) => {
      const run = this.client.db.prepare("SELECT thread_id FROM research_runs WHERE id = ?")
        .get(runId) as { thread_id: string } | undefined;
      if (!run || run.thread_id !== threadId) {
        throw new WorkflowConflictError("INVALID_REFERENCE", "Origin belongs to another project");
      }
    };
    for (const [copiedId, origins] of Object.entries(map.sources)) {
      const copy = this.client.db.prepare("SELECT content_hash FROM sources WHERE id = ? AND research_run_id = ?")
        .get(copiedId, materializationRunId) as { content_hash: string } | undefined;
      if (!copy || !Array.isArray(origins) || origins.length === 0) throw new Error("Invalid copied source origin");
      for (const origin of origins) {
        verifyRun(origin.originalRunId);
        const original = this.client.db.prepare(`
          SELECT content_hash, retrieved_text FROM sources WHERE id = ? AND research_run_id = ?
        `).get(origin.originalId, origin.originalRunId) as {
          content_hash: string; retrieved_text: string;
        } | undefined;
        if (!original || sha256(original.retrieved_text) !== original.content_hash
          || original.content_hash !== origin.contentSha256 || copy.content_hash !== original.content_hash) {
          throw new WorkflowConflictError("INVALID_REFERENCE", "Source origin hash changed");
        }
      }
    }
    for (const [copiedId, origin] of Object.entries(map.factors)) {
      if (!this.client.db.prepare("SELECT 1 FROM factors WHERE id = ? AND research_run_id = ?")
        .get(copiedId, materializationRunId)) throw new Error("Copied factor is missing");
      verifyRun(origin.originalRunId);
      const original = this.client.db.prepare(`
        SELECT * FROM factors WHERE id = ? AND research_run_id = ?
      `).get(origin.originalId, origin.originalRunId) as Record<string, unknown> | undefined;
      if (!original || factorOriginHash(original) !== origin.contentSha256) {
        throw new WorkflowConflictError("INVALID_REFERENCE", "Factor origin hash changed");
      }
    }
    for (const [copiedId, origin] of Object.entries(map.problems)) {
      if (!this.client.db.prepare("SELECT 1 FROM problems WHERE id = ? AND discovery_run_id = ?")
        .get(copiedId, materializationRunId)) throw new Error("Copied problem is missing");
      verifyRun(origin.originalRunId);
      const original = this.client.db.prepare(`
        SELECT * FROM problems WHERE id = ? AND discovery_run_id = ?
      `).get(origin.originalId, origin.originalRunId) as Record<string, unknown> | undefined;
      if (!original || problemOriginHash(this.client, original) !== origin.contentSha256) {
        throw new WorkflowConflictError("INVALID_REFERENCE", "Problem origin hash changed");
      }
    }
    for (const problemId of Object.keys(map.problems)) {
      if (!this.client.db.prepare("SELECT 1 FROM problems WHERE id = ? AND discovery_run_id = ?")
        .get(problemId, materializationRunId)) throw new Error("Origin map names a missing problem");
    }
  }

  private requireSnapshot(id: string): EvidenceSnapshot {
    const snapshot = this.getSnapshot(id);
    if (!snapshot) throw new WorkflowConflictError("INVALID_REFERENCE", "Evidence snapshot not found");
    return snapshot;
  }

  createIdeaTurn(input: {
    id?: string; rootSolutionId: string; branchId: string; parentTurnId?: string | null;
    baseSolutionId: string; evidenceSnapshotId?: string | null; sessionId: string;
    clientMessageId: string; intent: IdeaTurn["intent"]; userText: string; context: unknown;
  }): IdeaTurn {
    this.client.requireImmediateTransaction();
    const session = this.requireSession(input.sessionId);
    if (session.purpose !== "idea-turn") throw new Error("Idea turn requires an idea-turn session");
    this.assertSolutionsInThread(session.threadId, input.rootSolutionId, input.baseSolutionId);
    if (input.evidenceSnapshotId) this.assertSnapshotInThread(input.evidenceSnapshotId, session.threadId);
    const rootEntry = this.getSolutionLineage(input.rootSolutionId);
    if (rootEntry && (rootEntry.rootSolutionId !== input.rootSolutionId || rootEntry.versionNumber !== 1)) {
      throw new WorkflowConflictError("INVALID_REFERENCE", "Root solution is not a lineage root");
    }
    const baseLineage = this.getSolutionLineage(input.baseSolutionId);
    if (baseLineage && baseLineage.rootSolutionId !== input.rootSolutionId) {
      throw new WorkflowConflictError("INVALID_REFERENCE", "Base version belongs to another root");
    }
    if (!baseLineage && input.baseSolutionId !== input.rootSolutionId) {
      throw new WorkflowConflictError("INVALID_REFERENCE", "Base solution is outside the version chain");
    }
    const branchHead = this.client.db.prepare(`
      SELECT id, branch_sequence FROM idea_turns
      WHERE root_solution_id = ? AND branch_id = ? ORDER BY branch_sequence DESC LIMIT 1
    `).get(input.rootSolutionId, input.branchId) as { id: string; branch_sequence: number } | undefined;
    if (branchHead) {
      if (input.parentTurnId !== branchHead.id) {
        throw new WorkflowConflictError("REVISION_CONFLICT", "Conversation branch head changed");
      }
    } else if (input.parentTurnId) {
      const parent = this.getIdeaTurn(input.parentTurnId);
      if (!parent || parent.rootSolutionId !== input.rootSolutionId) {
        throw new WorkflowConflictError("INVALID_REFERENCE", "Parent turn belongs to another idea");
      }
    }
    const id = input.id ?? randomUUID();
    const contextJson = canonicalJson(input.context);
    this.client.db.prepare(`
      INSERT INTO idea_turns (
        id, root_solution_id, branch_id, branch_sequence, parent_turn_id,
        base_solution_id, evidence_snapshot_id, session_id, client_message_id,
        intent, user_text, context_json, context_sha256, state, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(id, input.rootSolutionId, input.branchId, (branchHead?.branch_sequence ?? 0) + 1,
      input.parentTurnId ?? null, input.baseSolutionId, input.evidenceSnapshotId ?? null,
      input.sessionId, input.clientMessageId, input.intent, input.userText,
      contextJson, sha256(contextJson), new Date().toISOString());
    return this.requireIdeaTurn(id);
  }

  getIdeaTurn(id: string): IdeaTurn | null {
    const row = this.client.db.prepare("SELECT * FROM idea_turns WHERE id = ?").get(id) as IdeaTurnRow | undefined;
    return row ? decodeIdeaTurn(row) : null;
  }

  getIdeaTurnByMessage(rootSolutionId: string, clientMessageId: string): IdeaTurn | null {
    const row = this.client.db.prepare(`
      SELECT * FROM idea_turns WHERE root_solution_id = ? AND client_message_id = ?
    `).get(rootSolutionId, clientMessageId) as IdeaTurnRow | undefined;
    return row ? decodeIdeaTurn(row) : null;
  }

  getBranchHead(rootSolutionId: string, branchId: string): IdeaTurn | null {
    const row = this.client.db.prepare(`
      SELECT * FROM idea_turns WHERE root_solution_id = ? AND branch_id = ?
      ORDER BY branch_sequence DESC LIMIT 1
    `).get(rootSolutionId, branchId) as IdeaTurnRow | undefined;
    return row ? decodeIdeaTurn(row) : null;
  }

  listIdeaTurns(rootSolutionId: string, branchId?: string, cursorId?: string, limit = 30): IdeaTurn[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid conversation page size");
    const cursor = cursorId ? this.getIdeaTurn(cursorId) : null;
    if (cursorId && (!cursor || cursor.rootSolutionId !== rootSolutionId
      || (branchId !== undefined && cursor.branchId !== branchId))) {
      throw new WorkflowConflictError("INVALID_REFERENCE", "Conversation cursor belongs to another branch");
    }
    const rows = branchId
      ? this.client.db.prepare(`
        SELECT * FROM idea_turns WHERE root_solution_id = ? AND branch_id = ? AND branch_sequence > ?
        ORDER BY branch_sequence LIMIT ?
      `).all(rootSolutionId, branchId, cursor?.branchSequence ?? 0, limit) as IdeaTurnRow[]
      : this.client.db.prepare(`
        SELECT * FROM idea_turns WHERE root_solution_id = ?
          AND (? IS NULL OR created_at > ? OR (created_at = ? AND id > ?))
        ORDER BY created_at, id LIMIT ?
      `).all(rootSolutionId, cursor?.createdAt ?? null, cursor?.createdAt ?? null,
        cursor?.createdAt ?? null, cursor?.id ?? null, limit) as IdeaTurnRow[];
    return rows.map(decodeIdeaTurn);
  }

  completeIdeaTurn(id: string, input: {
    state: Exclude<IdeaTurnState, "pending">;
    assistant?: unknown;
    stageResultId?: string;
    generatedSolutionId?: string;
    error?: unknown;
  }): IdeaTurn {
    this.client.requireImmediateTransaction();
    const turn = this.requireIdeaTurn(id);
    if (turn.state !== "pending") throw new WorkflowConflictError("REVISION_CONFLICT", "Idea turn already has a terminal result");
    const session = this.requireSession(turn.sessionId);
    if (input.state === "completed" && input.assistant === undefined) throw new Error("Completed turn needs an assistant result");
    if (input.state !== "completed" && input.generatedSolutionId) throw new Error("Only a completed rethink can create a version");
    if (input.generatedSolutionId && turn.intent !== "rethink") throw new Error("Only rethink creates a version");
    if (input.stageResultId) {
      const stage = this.client.db.prepare(`
        SELECT rr.thread_id, rr.workflow_session_id, sr.stage_id FROM stage_results sr
        JOIN research_runs rr ON rr.id = sr.research_run_id WHERE sr.id = ?
      `).get(input.stageResultId) as {
        thread_id: string; workflow_session_id: string | null; stage_id: string;
      } | undefined;
      if (!stage || stage.thread_id !== session.threadId
        || stage.workflow_session_id !== turn.sessionId || stage.stage_id !== "idea-follow-up") {
        throw new WorkflowConflictError("INVALID_REFERENCE", "Follow-up stage belongs to another turn session");
      }
    }
    if (input.generatedSolutionId) {
      this.assertSolutionsInThread(session.threadId, turn.rootSolutionId, input.generatedSolutionId);
      const lineage = this.getSolutionLineage(input.generatedSolutionId);
      if (!lineage || lineage.turnId !== id || lineage.rootSolutionId !== turn.rootSolutionId) {
        throw new WorkflowConflictError("INVALID_REFERENCE", "Generated solution needs matching lineage");
      }
    }
    this.client.db.prepare(`
      UPDATE idea_turns SET state = ?, assistant_json = ?, stage_result_id = ?,
        generated_solution_id = ?, error_json = ?, completed_at = ? WHERE id = ? AND state = 'pending'
    `).run(input.state, input.assistant === undefined ? null : canonicalJson(input.assistant),
      input.stageResultId ?? null, input.generatedSolutionId ?? null,
      input.error === undefined ? null : canonicalJson(input.error), new Date().toISOString(), id);
    return this.requireIdeaTurn(id);
  }

  getSolutionLineage(solutionId: string): SolutionLineage | null {
    const row = this.client.db.prepare("SELECT * FROM solution_lineage WHERE solution_id = ?")
      .get(solutionId) as LineageRow | undefined;
    return row ? decodeLineage(row) : null;
  }

  listSolutionVersions(rootSolutionId: string): SolutionLineage[] {
    const rows = this.client.db.prepare(`
      SELECT * FROM solution_lineage WHERE root_solution_id = ? ORDER BY version_number
    `).all(rootSolutionId) as LineageRow[];
    return rows.map(decodeLineage);
  }

  createSolutionLineage(input: {
    solutionId: string; rootSolutionId: string; parentSolutionId?: string | null;
    turnId?: string | null; evidenceSnapshotId?: string | null; changeSummary: string;
  }): SolutionLineage {
    this.client.requireImmediateTransaction();
    const rootThreadId = this.solutionThreadId(input.rootSolutionId);
    this.assertSolutionsInThread(rootThreadId, input.solutionId);
    if (input.evidenceSnapshotId) this.assertSnapshotInThread(input.evidenceSnapshotId, rootThreadId);
    const existing = this.getSolutionLineage(input.solutionId);
    if (existing) throw new WorkflowConflictError("INVALID_REFERENCE", "Solution already has lineage");
    const isRoot = input.solutionId === input.rootSolutionId;
    if (isRoot && (input.parentSolutionId || input.turnId)) throw new Error("Root version cannot have a parent or turn");
    if (!isRoot && (!input.parentSolutionId || !input.turnId)) throw new Error("New version needs a parent and turn");
    let versionNumber = 1;
    if (!isRoot) {
      const root = this.getSolutionLineage(input.rootSolutionId);
      const parent = this.getSolutionLineage(input.parentSolutionId!);
      if (!root || root.versionNumber !== 1 || !parent || parent.rootSolutionId !== input.rootSolutionId) {
        throw new WorkflowConflictError("INVALID_REFERENCE", "Version parent is outside the root chain");
      }
      const turn = this.requireIdeaTurn(input.turnId!);
      if (turn.rootSolutionId !== input.rootSolutionId || turn.baseSolutionId !== input.parentSolutionId
        || turn.intent !== "rethink" || turn.state !== "pending") {
        throw new WorkflowConflictError("INVALID_REFERENCE", "Rethink turn does not match version parent");
      }
      if ((input.evidenceSnapshotId ?? null) !== turn.evidenceSnapshotId) {
        throw new WorkflowConflictError("INVALID_REFERENCE", "Version evidence does not match its turn");
      }
      const run = this.client.db.prepare(`
        SELECT rr.workflow_session_id FROM solutions s
        JOIN research_runs rr ON rr.id = s.research_run_id WHERE s.id = ?
      `).get(input.solutionId) as { workflow_session_id: string | null } | undefined;
      if (!run || run.workflow_session_id !== turn.sessionId) {
        throw new WorkflowConflictError("INVALID_REFERENCE", "New version belongs to another turn session");
      }
      const max = this.client.db.prepare(`
        SELECT MAX(version_number) AS value FROM solution_lineage WHERE root_solution_id = ?
      `).get(input.rootSolutionId) as { value: number };
      versionNumber = max.value + 1;
    }
    this.client.db.prepare(`
      INSERT INTO solution_lineage (
        solution_id, root_solution_id, parent_solution_id, version_number,
        turn_id, evidence_snapshot_id, change_summary, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.solutionId, input.rootSolutionId, input.parentSolutionId ?? null,
      versionNumber, input.turnId ?? null, input.evidenceSnapshotId ?? null,
      input.changeSummary, new Date().toISOString());
    return this.getSolutionLineage(input.solutionId)!;
  }

  getSelectedVersion(rootSolutionId: string): string | null {
    const row = this.client.db.prepare(`
      SELECT selected_solution_id FROM workflow_solution_preferences WHERE root_solution_id = ?
    `).get(rootSolutionId) as { selected_solution_id: string } | undefined;
    return row?.selected_solution_id ?? null;
  }

  setSelectedVersion(rootSolutionId: string, solutionId: string): void {
    this.client.requireImmediateTransaction();
    const version = this.getSolutionLineage(solutionId);
    if (!version || version.rootSolutionId !== rootSolutionId) {
      throw new WorkflowConflictError("INVALID_REFERENCE", "Selected version belongs to another idea");
    }
    this.client.db.prepare(`
      INSERT INTO workflow_solution_preferences (root_solution_id, selected_solution_id, updated_at)
      VALUES (?, ?, ?) ON CONFLICT(root_solution_id) DO UPDATE
      SET selected_solution_id = excluded.selected_solution_id, updated_at = excluded.updated_at
    `).run(rootSolutionId, solutionId, new Date().toISOString());
  }

  /** Remove new metadata before the existing explicit project-delete transaction removes graph rows. */
  deleteProjectMetadata(threadId: string): void {
    this.client.requireImmediateTransaction();
    const sessionIds = (this.client.db.prepare("SELECT id FROM workflow_sessions WHERE thread_id = ?")
      .all(threadId) as { id: string }[]).map((row) => row.id);
    if (sessionIds.length === 0) return;
    this.client.db.prepare(`
      DELETE FROM workflow_solution_preferences WHERE root_solution_id IN (
        SELECT s.id FROM solutions s JOIN research_runs rr ON rr.id = s.research_run_id
        WHERE rr.thread_id = ?
      )
    `).run(threadId);
    this.client.db.prepare(`
      DELETE FROM solution_lineage WHERE solution_id IN (
        SELECT s.id FROM solutions s JOIN research_runs rr ON rr.id = s.research_run_id
        WHERE rr.thread_id = ?
      )
    `).run(threadId);
    this.deleteLeaves("idea_turns", "parent_turn_id", "root_solution_id", `
      SELECT s.id FROM solutions s JOIN research_runs rr ON rr.id = s.research_run_id
      WHERE rr.thread_id = ?
    `, threadId);
    this.client.db.prepare("UPDATE workflow_sessions SET active_snapshot_id = NULL WHERE thread_id = ?")
      .run(threadId);
    this.client.db.prepare("UPDATE research_runs SET evidence_snapshot_id = NULL WHERE thread_id = ?")
      .run(threadId);
    this.deleteLeaves("evidence_snapshots", "parent_snapshot_id", "session_id", `
      SELECT id FROM workflow_sessions WHERE thread_id = ?
    `, threadId);
    this.client.db.prepare(`
      DELETE FROM workflow_budget_entries WHERE session_id IN (
        SELECT id FROM workflow_sessions WHERE thread_id = ?
      )
    `).run(threadId);
    this.client.db.prepare(`
      DELETE FROM opportunity_exploration_attempts WHERE session_id IN (
        SELECT id FROM workflow_sessions WHERE thread_id = ?
      )
    `).run(threadId);
    this.client.db.prepare(`
      DELETE FROM opportunity_exploration_batches WHERE session_id IN (
        SELECT id FROM workflow_sessions WHERE thread_id = ?
      )
    `).run(threadId);
    this.client.db.prepare(`
      DELETE FROM opportunity_coverage_gaps WHERE session_id IN (
        SELECT id FROM workflow_sessions WHERE thread_id = ?
      )
    `).run(threadId);
    this.deleteLeaves("workflow_work_items", "parent_item_id", "session_id", `
      SELECT id FROM workflow_sessions WHERE thread_id = ?
    `, threadId);
    this.client.db.prepare("DELETE FROM workflow_commands WHERE thread_id = ?").run(threadId);
    this.client.db.prepare("DELETE FROM workflow_sessions WHERE thread_id = ?").run(threadId);
  }

  private deleteLeaves(
    table: "idea_turns" | "evidence_snapshots" | "workflow_work_items",
    parentColumn: "parent_turn_id" | "parent_snapshot_id" | "parent_item_id",
    ownerColumn: "root_solution_id" | "session_id",
    ownerQuery: string,
    threadId: string,
  ): void {
    for (;;) {
      const row = this.client.db.prepare(`
        SELECT current.id FROM ${table} current
        WHERE current.${ownerColumn} IN (${ownerQuery})
          AND NOT EXISTS (SELECT 1 FROM ${table} child WHERE child.${parentColumn} = current.id)
        LIMIT 1
      `).get(threadId) as { id: string } | undefined;
      if (!row) {
        const remaining = this.client.db.prepare(`
          SELECT 1 FROM ${table} WHERE ${ownerColumn} IN (${ownerQuery}) LIMIT 1
        `).get(threadId);
        if (remaining) throw new Error(`Cannot delete cyclic ${table} metadata`);
        return;
      }
      this.client.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(row.id);
    }
  }

  private solutionThreadId(solutionId: string): string {
    const row = this.client.db.prepare(`
      SELECT rr.thread_id FROM solutions s JOIN research_runs rr ON rr.id = s.research_run_id
      WHERE s.id = ?
    `).get(solutionId) as { thread_id: string } | undefined;
    if (!row) throw new WorkflowConflictError("INVALID_REFERENCE", "Solution not found in a project");
    return row.thread_id;
  }

  private assertSolutionsInThread(threadId: string, ...solutionIds: string[]): void {
    for (const solutionId of solutionIds) {
      if (this.solutionThreadId(solutionId) !== threadId) {
        throw new WorkflowConflictError("INVALID_REFERENCE", "Solution belongs to another project");
      }
    }
  }

  private assertSnapshotInThread(snapshotId: string, threadId: string): void {
    const row = this.client.db.prepare(`
      SELECT ws.thread_id FROM evidence_snapshots es
      JOIN workflow_sessions ws ON ws.id = es.session_id WHERE es.id = ?
    `).get(snapshotId) as { thread_id: string } | undefined;
    if (!row || row.thread_id !== threadId) {
      throw new WorkflowConflictError("INVALID_REFERENCE", "Evidence snapshot belongs to another project");
    }
  }

  private requireIdeaTurn(id: string): IdeaTurn {
    const turn = this.getIdeaTurn(id);
    if (!turn) throw new WorkflowConflictError("INVALID_REFERENCE", "Idea turn not found");
    return turn;
  }

  private requireSession(id: string): WorkflowSession {
    const session = this.getSession(id);
    if (!session) throw new WorkflowConflictError("INVALID_REFERENCE", "Workflow session not found");
    return session;
  }

  private requireWorkItem(id: string): WorkflowWorkItem {
    const item = this.getWorkItem(id);
    if (!item) throw new WorkflowConflictError("INVALID_REFERENCE", "Work item not found");
    return item;
  }

  private requireWorkItemInSession(id: string, sessionId: string): WorkflowWorkItem {
    const item = this.requireWorkItem(id);
    if (item.sessionId !== sessionId) throw new WorkflowConflictError("INVALID_REFERENCE", "Work item belongs to another session");
    return item;
  }

  private requireBudgetEntry(id: string): WorkflowBudgetEntry {
    const entry = this.getBudgetEntry(id);
    if (!entry) throw new WorkflowConflictError("INVALID_REFERENCE", "Budget entry not found");
    return entry;
  }
}

function decodeSession(row: SessionRow): WorkflowSession {
  if (sha256(row.contract_json) !== row.contract_sha256) throw new Error("Stored workflow contract hash mismatch");
  return {
    id: row.id, threadId: row.thread_id, purpose: row.purpose, mode: row.mode,
    contract: JSON.parse(row.contract_json), contractSha256: row.contract_sha256,
    state: row.state, outcome: row.outcome, revision: row.revision,
    activeSnapshotId: row.active_snapshot_id, remainingMs: row.remaining_ms,
    additionalModelCalls: row.additional_model_calls, additionalSearches: row.additional_searches,
    additionalMinutes: row.additional_minutes,
    runningSince: row.running_since, startedAt: row.started_at, finishedAt: row.finished_at,
  };
}

function decodeCommand(row: CommandRow): WorkflowCommand {
  return {
    id: row.id, threadId: row.thread_id, sessionId: row.session_id,
    clientCommandId: row.client_command_id, payloadSha256: row.payload_sha256,
    result: JSON.parse(row.result_json), createdAt: row.created_at,
  };
}

function decodeWorkItem(row: WorkItemRow): WorkflowWorkItem {
  if (sha256(row.input_json) !== row.input_sha256) throw new Error("Stored work item input hash mismatch");
  return {
    id: row.id, sessionId: row.session_id, parentItemId: row.parent_item_id,
    kind: row.kind, scopeKey: row.scope_key, ordinal: row.ordinal,
    dependencies: JSON.parse(row.dependencies_json) as string[], input: JSON.parse(row.input_json),
    inputSha256: row.input_sha256, state: row.state,
    outputRefs: row.output_refs_json === null ? null : JSON.parse(row.output_refs_json),
    error: row.error_json === null ? null : JSON.parse(row.error_json),
    createdAt: row.created_at, finishedAt: row.finished_at,
  };
}

function decodeBudget(row: BudgetRow): WorkflowBudgetEntry {
  return {
    id: row.id, sessionId: row.session_id, workItemId: row.work_item_id,
    operationKey: row.operation_key, kind: row.kind, reservedUnits: row.reserved_units,
    settledUnits: row.settled_units, state: row.state,
    generationAttemptId: row.generation_attempt_id, opportunityAttemptId: row.opportunity_attempt_id,
    createdAt: row.created_at, settledAt: row.settled_at,
  };
}

function decodeSnapshot(row: SnapshotRow): EvidenceSnapshot {
  const selection = JSON.parse(row.selection_json) as EvidenceSnapshot["selection"];
  const originMap = JSON.parse(row.origin_map_json) as SnapshotOriginMap;
  if (sha256(canonicalJson({ selection, originMap })) !== row.content_sha256) {
    throw new Error("Stored evidence snapshot hash mismatch");
  }
  return {
    id: row.id, sessionId: row.session_id, parentSnapshotId: row.parent_snapshot_id,
    materializationRunId: row.materialization_run_id, selection, originMap,
    contentSha256: row.content_sha256, createdByCommandId: row.created_by_command_id,
    createdAt: row.created_at,
  };
}

function decodeIdeaTurn(row: IdeaTurnRow): IdeaTurn {
  if (sha256(row.context_json) !== row.context_sha256) throw new Error("Stored idea turn context hash mismatch");
  return {
    id: row.id, rootSolutionId: row.root_solution_id, branchId: row.branch_id,
    branchSequence: row.branch_sequence, parentTurnId: row.parent_turn_id,
    baseSolutionId: row.base_solution_id, evidenceSnapshotId: row.evidence_snapshot_id,
    sessionId: row.session_id, clientMessageId: row.client_message_id,
    intent: row.intent, userText: row.user_text, context: JSON.parse(row.context_json),
    contextSha256: row.context_sha256, state: row.state,
    assistant: row.assistant_json === null ? null : JSON.parse(row.assistant_json),
    stageResultId: row.stage_result_id, generatedSolutionId: row.generated_solution_id,
    error: row.error_json === null ? null : JSON.parse(row.error_json),
    createdAt: row.created_at, completedAt: row.completed_at,
  };
}

function decodeLineage(row: LineageRow): SolutionLineage {
  return {
    solutionId: row.solution_id, rootSolutionId: row.root_solution_id,
    parentSolutionId: row.parent_solution_id, versionNumber: row.version_number,
    turnId: row.turn_id, evidenceSnapshotId: row.evidence_snapshot_id,
    changeSummary: row.change_summary, createdAt: row.created_at,
  };
}

function factorOriginHash(row: Record<string, unknown>): string {
  return sha256(canonicalJson({
    subject: row.subject, behavior: row.behavior, quote: row.quote,
    sourceId: row.source_id, modelConfidence: row.model_confidence,
    uncertainty: row.uncertainty, sourceRole: row.source_role,
    audienceFit: row.audience_fit, independentSourceKey: row.independent_source_key,
    supportsDemand: row.supports_demand, demandEvidenceUncertainty: row.demand_evidence_uncertainty,
  }));
}

function problemOriginHash(client: DatabaseClient, row: Record<string, unknown>): string {
  const id = row.id as string;
  const factorIds = (client.db.prepare("SELECT factor_id FROM problem_factors WHERE problem_id = ? ORDER BY rowid")
    .all(id) as { factor_id: string }[]).map((item) => item.factor_id);
  if (row.scale_basis_factor_id) factorIds.push(row.scale_basis_factor_id as string);
  const buyerFactorIds = parseStoredIdArray(row.intended_buyer_evidence_factor_ids_json);
  factorIds.push(...buyerFactorIds);
  const distinctFactorIds = [...new Set(factorIds)];
  const sourceIds = (client.db.prepare(`
    SELECT source_id FROM problem_verdict_sources WHERE problem_id = ? ORDER BY position
  `).all(id) as { source_id: string }[]).map((item) => item.source_id);
  for (const factorId of distinctFactorIds) {
    const factor = client.db.prepare("SELECT source_id FROM factors WHERE id = ? AND research_run_id = ?")
      .get(factorId, row.discovery_run_id) as { source_id: string } | undefined;
    if (!factor) throw new WorkflowConflictError("INVALID_REFERENCE", "Original problem factor is missing");
    sourceIds.push(factor.source_id);
  }
  return sha256(canonicalJson({
    statement: row.statement, whyItPersists: row.why_it_persists,
    affected: row.affected, scaleEstimate: row.scale_estimate,
    scaleBasisFactorId: row.scale_basis_factor_id, verdict: row.verdict,
    verdictReason: row.verdict_reason, verdictSourceIds: sourceIds,
    factorIds: distinctFactorIds, intendedBuyerEvidenceFactorIds: buyerFactorIds,
    evidenceGap: row.evidence_gap, briefFit: row.brief_fit,
    contraryEvidence: row.contrary_evidence, workflowKey: row.workflow_key,
  }));
}

function parseStoredIdArray(value: unknown): string[] {
  if (typeof value !== "string") throw new Error("Stored evidence IDs are invalid");
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("Stored evidence IDs are invalid");
  }
  return parsed;
}
