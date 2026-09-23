import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "../db/client";
import { CostLedgerRepository } from "../db/repositories/cost-ledger";
import { GenerationAttemptRepository } from "../db/repositories/generation-attempts";
import { ResearchRunRepository } from "../db/repositories/research-runs";
import { WorkflowV2Repository } from "../db/repositories/workflow-v2";
import { WorkflowConflictError, WorkflowRepository, type IdeaTurn, type WorkflowSession } from "../db/repositories/workflows";
import { ProviderFailure, type GenerationAttemptMetadata, type StructuredModelClient } from "../providers/structured";
import { canonicalJson, sha256 } from "../shared/content-identity";
import { AppError } from "../shared/errors";
import { RunConfigSchema, type ModelRef } from "../shared/schemas";
import {
  GetIdeaConversationRequestSchema, IdeaConversationSchema, SubmitIdeaTurnRequestSchema,
  SubmitIdeaTurnResultSchema, WorkflowSummarySchema,
  type IdeaConversation, type SubmitIdeaTurnRequest, type WorkflowSummary,
} from "../shared/workflow-contracts";
import { generateIdeaFollowUp, prepareIdeaFollowUp, type IdeaFollowUpInput, type PreparedIdeaFollowUp } from "./idea-conversation";

interface SolutionRow {
  id: string;
  problem_id: string;
  research_run_id: string;
  thread_id: string;
  workflow_version: number;
  config_json: string;
  mechanism: string;
  description: string;
  key_assumption: string | null;
  why_current_approach_may_suffice: string | null;
  respects_off_limits: number;
  respects_off_limits_why: string;
  supporting_evidence_ids_json: string | null;
  contrary_evidence_ids_json: string | null;
  unknowns_json: string | null;
  startup_opportunity_json: string | null;
}

interface PendingDispatch {
  sessionId: string;
  turnId: string;
  runId: string;
  workItemId: string;
  budgetEntryId: string;
  attemptId: string;
  problemId: string;
  prepared: PreparedIdeaFollowUp;
  modelClient: StructuredModelClient;
  costReservationId?: string;
}

export interface IdeaConversationServiceOptions {
  db: DatabaseClient;
  modelClient: (model: ModelRef, projectId: string) => StructuredModelClient;
  modelAvailable: (model: ModelRef, effort: string) => boolean;
  onProgress: (sessionId: string) => void;
  onError?: (error: unknown) => void;
}

/** Follow-up admission, provider work, and version commits share one durable path. */
export class IdeaConversationService {
  private readonly workflows: WorkflowRepository;
  private readonly stages: WorkflowV2Repository;
  private readonly attempts: GenerationAttemptRepository;
  private readonly costs: CostLedgerRepository;
  private readonly runs: ResearchRunRepository;
  private readonly dispatching = new Set<string>();

  constructor(private readonly options: IdeaConversationServiceOptions) {
    this.workflows = new WorkflowRepository(options.db);
    this.stages = new WorkflowV2Repository(options.db);
    this.attempts = new GenerationAttemptRepository(options.db);
    this.costs = new CostLedgerRepository(options.db);
    this.runs = new ResearchRunRepository(options.db);
  }

  getConversation(input: unknown): IdeaConversation {
    const request = GetIdeaConversationRequestSchema.parse(input);
    const requested = this.solution(request.ideaId);
    if (!requested) throw new AppError("not_found", "Idea not found.");
    const rootSolutionId = this.workflows.getSolutionLineage(requested.id)?.rootSolutionId ?? requested.id;
    const lineage = this.workflows.listSolutionVersions(rootSolutionId);
    const versions = lineage.length ? lineage : [{
      solutionId: rootSolutionId, rootSolutionId, parentSolutionId: null, versionNumber: 1,
      turnId: null, evidenceSnapshotId: null, changeSummary: "Original idea", createdAt: "",
    }];
    const rows = versions.map((version) => this.solution(version.solutionId));
    if (rows.some((row) => !row || row.thread_id !== requested.thread_id)) {
      throw new AppError("INVALID_REFERENCE", "An idea version belongs to another project.");
    }
    const versionRows = rows as SolutionRow[];
    const reviewed = new Set(versionRows.filter((row) => this.hasCurrentReview(row)).map((row) => row.id));
    const selectedVersionId = this.workflows.getSelectedVersion(rootSolutionId) ?? rootSolutionId;
    const page = this.workflows.listIdeaTurns(rootSolutionId, request.branchId, request.cursor, 31);
    const shown = page.slice(0, 30);
    const branches = this.options.db.db.prepare(`
      SELECT branch_id, COUNT(*) AS turn_count,
        (SELECT inner_turn.id FROM idea_turns inner_turn
         WHERE inner_turn.root_solution_id = outer_turn.root_solution_id
           AND inner_turn.branch_id = outer_turn.branch_id
         ORDER BY inner_turn.branch_sequence DESC LIMIT 1) AS head_turn_id
      FROM idea_turns outer_turn WHERE root_solution_id = ?
      GROUP BY branch_id ORDER BY MIN(created_at), branch_id
    `).all(rootSolutionId) as Array<{ branch_id: string; turn_count: number; head_turn_id: string | null }>;
    const projectedVersions = versions.map((version, index) => {
      const row = versionRows[index]!;
      const original = this.savedModel(row);
      return {
        solutionId: version.solutionId, parentSolutionId: version.parentSolutionId,
        versionNumber: version.versionNumber, evidenceSnapshotId: version.evidenceSnapshotId,
        changeSummary: version.parentSolutionId ? version.changeSummary : null,
        mechanism: row.mechanism, description: row.description,
        reviewFreshness: reviewed.has(row.id) ? "current" as const
          : version.parentSolutionId && reviewed.size > 0 ? "stale" as const : "unreviewed" as const,
        model: original.model, reasoningEffort: original.reasoningEffort,
      };
    });
    const selected = projectedVersions.find((version) => version.solutionId === selectedVersionId);
    return IdeaConversationSchema.parse({
      rootSolutionId, selectedVersionId,
      defaultModel: selected?.model ?? projectedVersions[0]?.model ?? null,
      versions: projectedVersions,
      branches: branches.map((branch) => ({ branchId: branch.branch_id, headTurnId: branch.head_turn_id, turnCount: branch.turn_count })),
      turns: shown.map((turn) => this.projectTurn(turn)),
      nextCursor: page.length > 30 ? shown.at(-1)?.id ?? null : null,
    });
  }

  selectVersion(threadId: string, rootSolutionId: string, solutionId: string): void {
    const root = this.solution(rootSolutionId);
    if (!root || root.thread_id !== threadId) throw new AppError("INVALID_REFERENCE");
    try {
      this.options.db.immediateTransaction(() => this.workflows.setSelectedVersion(rootSolutionId, solutionId));
    } catch (error) {
      if (error instanceof WorkflowConflictError) throw new AppError(error.code, error.message);
      throw error;
    }
  }

  /** Run once at backend startup. Never re-dispatch an unfinished provider request. */
  reconcileInterrupted(): string[] {
    const pending = this.options.db.db.prepare(`
      SELECT it.id AS turn_id, it.session_id, rr.id AS run_id,
        wi.id AS work_item_id, be.id AS budget_id, be.reserved_units,
        ga.id AS attempt_id, ga.status AS attempt_status
      FROM idea_turns it
      JOIN workflow_sessions ws ON ws.id = it.session_id
      JOIN research_runs rr ON rr.workflow_session_id = ws.id AND rr.purpose = 'idea-turn'
      JOIN workflow_work_items wi ON wi.session_id = ws.id AND wi.kind = 'idea-follow-up'
      JOIN workflow_budget_entries be ON be.work_item_id = wi.id AND be.kind = 'model-call'
      LEFT JOIN generation_attempts ga ON ga.research_run_id = rr.id AND ga.work_item_id = wi.id
      WHERE it.state = 'pending' AND ws.state != 'finished'
    `).all() as Array<{ turn_id: string; session_id: string; run_id: string; work_item_id: string;
      budget_id: string; reserved_units: number; attempt_id: string | null; attempt_status: string | null }>;
    const settled: string[] = [];
    for (const item of pending) {
      if (this.dispatching.has(item.turn_id)) continue;
      const safe = item.attempt_status === "prepared" || item.attempt_status === null;
      const message = safe
        ? "The app stopped before this model request was sent. Send a new turn to retry."
        : "The app stopped while the model request was in flight. Its completion is unknown.";
      try {
        const reservation = this.options.db.db.prepare(`
          SELECT id FROM cost_ledger WHERE generation_attempt_id = ? AND status = 'reserved'
        `).get(item.attempt_id) as { id: string } | undefined;
        if (reservation) {
          if (safe) this.costs.release(reservation.id);
          else this.costs.settleUncertain(item.run_id, message);
        }
      } catch (error) {
        this.options.onError?.(error);
      }
      this.options.db.immediateTransaction(() => {
        const turn = this.workflows.getIdeaTurn(item.turn_id);
        if (turn?.state !== "pending") return;
        if (item.attempt_id && ["prepared", "dispatched", "accepted"].includes(item.attempt_status ?? "")) {
          this.attempts.recordTerminal(item.attempt_id, { status: "interrupted",
            terminalKind: safe ? "never-dispatched" : "unknown-completion",
            errorCode: "interrupted", errorMessage: message });
        }
        this.workflows.completeIdeaTurn(item.turn_id, { state: safe ? "failed" : "unknown",
          error: { code: "interrupted", message } });
        this.workflows.updateWorkItem(item.work_item_id, safe ? "failed" : "unknown", { error: { message } });
        this.workflows.settleBudget(item.budget_id, safe
          ? { state: "released", settledUnits: 0 }
          : { state: "uncertain", settledUnits: item.reserved_units,
              ...(item.attempt_id ? { generationAttemptId: item.attempt_id } : {}) });
        this.runs.finish(item.run_id, "failed", message);
        const session = this.workflows.getSession(item.session_id)!;
        this.workflows.updateSession(session.id, session.revision, { state: "finished",
          outcome: safe ? "failed" : "needs-attention", remainingMs: this.remainingMs(session), runningSince: null });
      });
      settled.push(item.session_id);
      this.options.onProgress(item.session_id);
    }
    return settled;
  }

  async submitTurn(input: unknown) {
    const request = SubmitIdeaTurnRequestSchema.parse(input);
    const prior = this.workflows.getCommand(request.threadId, request.clientMessageId);
    if (prior) return this.replay(prior.payloadSha256, prior.result, request);
    if (!this.options.modelAvailable(request.model, request.reasoningEffort)) throw new AppError("MODEL_UNAVAILABLE");
    const root = this.solution(request.rootSolutionId);
    const base = this.solution(request.baseSolutionId);
    if (!root || !base || root.thread_id !== request.threadId || base.thread_id !== request.threadId) {
      throw new AppError("INVALID_REFERENCE", "The selected idea is outside this project.");
    }
    if (root.workflow_version !== 2 || base.workflow_version !== 2) {
      throw new AppError("INVALID_REFERENCE", "This saved idea uses an older workflow and remains available for reading.");
    }
    const baseLineage = this.workflows.getSolutionLineage(base.id);
    if (base.id !== root.id && baseLineage?.rootSolutionId !== root.id) {
      throw new AppError("INVALID_REFERENCE", "The selected version belongs to another idea.");
    }
    const branch = this.resolveBranch(request);
    const contextInput = this.contextInput(request, base, branch.parentTurnId);
    const prepared = prepareIdeaFollowUp(contextInput);
    const modelClient = this.options.modelClient(request.model, request.threadId);
    let pending: PendingDispatch;
    let receipt: ReturnType<IdeaConversationService["receipt"]>;
    try {
      ({ pending, receipt } = this.options.db.immediateTransaction(() => {
        const existing = this.workflows.getCommand(request.threadId, request.clientMessageId);
        if (existing) throw new WorkflowConflictError("IDEMPOTENCY_CONFLICT", "The command was admitted concurrently");
        this.requireProjectIdle(request.threadId);
        this.assertBranchHead(request, branch.branchId, branch.parentTurnId);
        if (!this.workflows.getSolutionLineage(root.id)) {
          this.workflows.createSolutionLineage({ solutionId: root.id, rootSolutionId: root.id, changeSummary: "Original idea" });
        }
        const limits = { maxMinutes: request.allowance.maxMinutes, maxModelCalls: request.allowance.maxModelCalls, maxSearches: 0 };
        const session = this.workflows.createSession({
          threadId: request.threadId, purpose: "idea-turn", mode: "babysit",
          contract: { kind: "idea-turn", rootSolutionId: root.id, baseSolutionId: base.id,
            targetKind: "per-problem", limits,
            model: request.model, reasoningEffort: request.reasoningEffort, effectiveContextSha256: sha256(canonicalJson(prepared.effectiveContext)) },
          remainingMs: request.allowance.maxMinutes * 60_000,
        });
        const workItem = this.workflows.createWorkItem({
          sessionId: session.id, kind: "idea-follow-up", scopeKey: `idea-turn:${request.clientMessageId}`,
          input: { rootSolutionId: root.id, baseSolutionId: base.id, intent: request.intent,
            contextSha256: sha256(canonicalJson(prepared.effectiveContext)) }, state: "ready",
        });
        const budget = this.workflows.reserveBudget({
          sessionId: session.id, workItemId: workItem.id, operationKey: `idea-follow-up:${workItem.id}`,
          kind: "model-call", reservedUnits: request.allowance.maxModelCalls,
        });
        const childConfig = RunConfigSchema.parse({ ...RunConfigSchema.parse(JSON.parse(base.config_json)),
          workflowVersion: 2, model: request.model, reasoningEffort: request.reasoningEffort, ideaCount: 1 });
        const child = this.workflows.createRunWithinTransaction({
          threadId: request.threadId, sessionId: session.id, problemId: base.problem_id,
          purpose: "idea-turn", config: childConfig,
          ...(request.evidenceSnapshotId ? { evidenceSnapshotId: request.evidenceSnapshotId } : {}),
        });
        const turn = this.workflows.createIdeaTurn({
          rootSolutionId: root.id, branchId: branch.branchId, parentTurnId: branch.parentTurnId,
          baseSolutionId: base.id, evidenceSnapshotId: request.evidenceSnapshotId ?? null,
          sessionId: session.id, clientMessageId: request.clientMessageId,
          intent: request.intent, userText: request.text.trim(), context: prepared.effectiveContext,
        });
        const attempt = this.attempts.prepare(child.runId, prepared.request, modelClient.preparedIdentity?.());
        this.options.db.db.prepare("UPDATE generation_attempts SET work_item_id = ? WHERE id = ?")
          .run(workItem.id, attempt.id);
        const result = this.receipt(session.id, turn.id);
        this.workflows.recordCommand({ threadId: request.threadId, sessionId: session.id,
          clientCommandId: request.clientMessageId, payload: request, result });
        this.workflows.updateWorkItem(workItem.id, "running");
        return { receipt: result, pending: { sessionId: session.id, turnId: turn.id,
          runId: child.runId, workItemId: workItem.id, budgetEntryId: budget.id,
          attemptId: attempt.id, problemId: base.problem_id, prepared, modelClient } };
      }));
    } catch (error) {
      if (error instanceof WorkflowConflictError) throw new AppError(error.code, error.message);
      throw error;
    }
    try {
      this.options.onProgress(pending.sessionId);
    } finally {
      void this.dispatch(pending).catch((error) => this.options.onError?.(error));
    }
    return SubmitIdeaTurnResultSchema.parse(receipt);
  }

  summary(sessionId: string): WorkflowSummary {
    const session = this.workflows.getSession(sessionId);
    if (!session || session.purpose !== "idea-turn") throw new AppError("not_found", "Idea turn session not found.");
    const contract = session.contract as { targetKind?: "per-problem" | "project";
      limits: { maxMinutes: number; maxModelCalls: number; maxSearches: number } };
    const items = this.workflows.listWorkItems(sessionId);
    const entries = this.workflows.listBudgetEntries(sessionId);
    const turn = this.options.db.db.prepare("SELECT state, generated_solution_id FROM idea_turns WHERE session_id = ?")
      .get(sessionId) as { state: IdeaTurn["state"]; generated_solution_id: string | null } | undefined;
    const budget = (kind: "model-call" | "search", limit: number) => {
      const rows = entries.filter((entry) => entry.kind === kind);
      return { limit,
        spent: rows.filter((entry) => entry.state === "spent").reduce((sum, entry) => sum + (entry.settledUnits ?? 0), 0),
        reserved: rows.filter((entry) => entry.state === "reserved").reduce((sum, entry) => sum + entry.reservedUnits, 0),
        uncertain: rows.filter((entry) => entry.state === "uncertain").reduce((sum, entry) => sum + entry.reservedUnits, 0),
      };
    };
    const completed = turn?.state === "completed" ? 1 : 0;
    const created = turn?.generated_solution_id ? 1 : 0;
    return WorkflowSummarySchema.parse({
      sessionId, threadId: session.threadId, purpose: session.purpose, mode: session.mode,
      targetKind: contract.targetKind ?? "per-problem",
      state: session.state, outcome: session.outcome, revision: session.revision,
      activeSnapshotId: session.activeSnapshotId, selectedProblemIds: [],
      counts: { requested: 1, attempted: items[0]?.state === "ready" ? 0 : 1,
        validated: completed, accepted: created, duplicate: 0,
        unresolved: turn?.state === "unknown" ? 1 : 0, failed: turn?.state === "failed" ? 1 : 0,
        missing: completed ? 0 : 1, existing: 0, addedBySession: created, total: created },
      limits: contract.limits,
      budget: { modelCalls: budget("model-call", contract.limits.maxModelCalls),
        searches: budget("search", 0), remainingMs: this.remainingMs(session) },
      currentStage: items.find((item) => item.state === "running" || item.state === "ready")?.kind ?? null,
      stopReason: session.outcome ? errorMessage(items.find((item) => item.error)?.error) : null,
      startedAt: session.startedAt, finishedAt: session.finishedAt,
    });
  }

  private receipt(sessionId: string, turnId: string) {
    const summary = this.summary(sessionId);
    return { sessionId, turnId, revision: summary.revision, summary };
  }

  private replay(hash: string, value: unknown, request: SubmitIdeaTurnRequest) {
    if (hash !== sha256(canonicalJson(request))) throw new AppError("IDEMPOTENCY_CONFLICT");
    const saved = SubmitIdeaTurnResultSchema.parse(value);
    return { ...saved, summary: this.summary(saved.sessionId) };
  }

  private solution(id: string): SolutionRow | null {
    return this.options.db.db.prepare(`
      SELECT s.*, rr.thread_id, rr.config_json, rr.workflow_version
      FROM solutions s JOIN research_runs rr ON rr.id = s.research_run_id WHERE s.id = ?
    `).get(id) as SolutionRow | undefined ?? null;
  }

  private requireProjectIdle(threadId: string): void {
    const session = this.workflows.getActiveSession(threadId);
    const run = this.options.db.db.prepare("SELECT 1 FROM research_runs WHERE thread_id = ? AND status IN ('queued', 'running') LIMIT 1")
      .get(threadId);
    if (session || run) throw new AppError("PROJECT_BUSY");
  }

  private resolveBranch(request: SubmitIdeaTurnRequest): { branchId: string; parentTurnId: string | null } {
    if (request.branchFromEarlier) {
      if (request.branchId || !request.parentTurnId || request.expectedHeadTurnId) {
        throw new AppError("validation_error", "Choose an earlier turn to start a new branch.");
      }
      return { branchId: randomUUID(), parentTurnId: request.parentTurnId };
    }
    if (!request.branchId && (request.parentTurnId || request.expectedHeadTurnId)) {
      throw new AppError("validation_error", "A continuing reply needs its branch ID.");
    }
    return { branchId: request.branchId ?? randomUUID(), parentTurnId: request.parentTurnId };
  }

  private assertBranchHead(request: SubmitIdeaTurnRequest, branchId: string, parentTurnId: string | null): void {
    const head = this.options.db.db.prepare(`
      SELECT id FROM idea_turns WHERE root_solution_id = ? AND branch_id = ?
      ORDER BY branch_sequence DESC LIMIT 1
    `).get(request.rootSolutionId, branchId) as { id: string } | undefined;
    if ((head?.id ?? null) !== request.expectedHeadTurnId || (head?.id ?? null) !== (request.branchFromEarlier ? null : parentTurnId)) {
      throw new AppError("REVISION_CONFLICT", "Conversation branch changed. Reload before replying.");
    }
    if (parentTurnId) {
      const parent = this.workflows.getIdeaTurn(parentTurnId);
      if (!parent || parent.rootSolutionId !== request.rootSolutionId) throw new AppError("INVALID_REFERENCE");
    }
  }

  private contextInput(request: SubmitIdeaTurnRequest, base: SolutionRow, parentTurnId: string | null): IdeaFollowUpInput {
    const problem = this.options.db.db.prepare(`
      SELECT p.statement, p.why_it_persists, p.affected, p.verdict, s.off_limits_json
      FROM problems p JOIN scopes s ON s.research_run_id = p.discovery_run_id WHERE p.id = ?
    `).get(base.problem_id);
    if (!problem) throw new AppError("INVALID_REFERENCE", "The saved problem is missing.");
    const stage = this.options.db.db.prepare(`
      SELECT prompt_text FROM stage_results WHERE research_run_id = ?
        AND stage_id IN ('solutions', 'idea-follow-up') ORDER BY completed_at DESC LIMIT 1
    `).get(base.research_run_id) as { prompt_text: string } | undefined;
    const sourceIds = [
      ...parseIds(base.supporting_evidence_ids_json), ...parseIds(base.contrary_evidence_ids_json),
    ];
    const evidence = this.loadEvidence(base.thread_id, request.evidenceSnapshotId ?? null, sourceIds);
    const history: IdeaFollowUpInput["history"] = [];
    const seen = new Set<string>();
    let current = parentTurnId;
    while (current && history.length < 30 && !seen.has(current)) {
      seen.add(current);
      const turn = this.workflows.getIdeaTurn(current);
      if (!turn || turn.rootSolutionId !== request.rootSolutionId) throw new AppError("INVALID_REFERENCE");
      const assistant = turn.assistant as { text?: unknown } | null;
      history.unshift({ id: turn.id, userText: turn.userText,
        assistantText: typeof assistant?.text === "string" ? assistant.text : null });
      current = turn.parentTurnId;
    }
    return {
      rootSolutionId: request.rootSolutionId, baseSolutionId: base.id,
      evidenceSnapshotId: request.evidenceSnapshotId ?? null,
      intent: request.intent, userText: request.text,
      idea: { mechanism: base.mechanism, description: base.description,
        keyAssumption: base.key_assumption, whyCurrentApproachMaySuffice: base.why_current_approach_may_suffice,
        respectsOffLimits: Boolean(base.respects_off_limits), respectsOffLimitsWhy: base.respects_off_limits_why,
        supportingEvidenceIds: parseIds(base.supporting_evidence_ids_json),
        contraryEvidenceIds: parseIds(base.contrary_evidence_ids_json),
        unknowns: parseIds(base.unknowns_json),
        startupOpportunity: base.startup_opportunity_json ? JSON.parse(base.startup_opportunity_json) : null },
      problem, savedInstructions: stage?.prompt_text ?? "Saved generation instructions are unavailable.",
      evidence, history, model: request.model, reasoningEffort: request.reasoningEffort,
      allowance: { maxModelCalls: request.allowance.maxModelCalls as 1 | 2, maxMinutes: request.allowance.maxMinutes },
    };
  }

  private loadEvidence(threadId: string, snapshotId: string | null, preferredIds: string[]) {
    let sourceIds = [...new Set(preferredIds)];
    if (snapshotId) {
      const snapshot = this.workflows.getSnapshot(snapshotId);
      const session = snapshot && this.workflows.getSession(snapshot.sessionId);
      if (!snapshot || session?.threadId !== threadId) throw new AppError("INVALID_REFERENCE", "Evidence snapshot belongs to another project.");
      const rows = this.options.db.db.prepare("SELECT id FROM sources WHERE research_run_id = ? ORDER BY retrieved_at, id")
        .all(snapshot.materializationRunId) as Array<{ id: string }>;
      const membership = new Set(rows.map((row) => row.id));
      sourceIds = [...sourceIds.filter((id) => membership.has(id)), ...rows.map((row) => row.id).filter((id) => !sourceIds.includes(id))];
    }
    return sourceIds.slice(0, 12).flatMap((sourceId) => {
      const row = this.options.db.db.prepare(`
        SELECT s.id, s.title, s.canonical_url, s.retrieved_text
        FROM sources s JOIN research_runs rr ON rr.id = s.research_run_id
        WHERE s.id = ? AND rr.thread_id = ?
      `).get(sourceId, threadId) as { id: string; title: string; canonical_url: string; retrieved_text: string } | undefined;
      return row ? [{ sourceId: row.id, content: { title: row.title, url: row.canonical_url, text: row.retrieved_text } }] : [];
    });
  }

  private savedModel(row: SolutionRow): { model: ModelRef | null; reasoningEffort: string | null } {
    const stage = this.options.db.db.prepare(`
      SELECT effective_request_json FROM stage_results WHERE research_run_id = ?
        AND stage_id IN ('solutions', 'idea-follow-up') ORDER BY completed_at DESC LIMIT 1
    `).get(row.research_run_id) as { effective_request_json: string } | undefined;
    if (stage) {
      const saved = JSON.parse(stage.effective_request_json) as { request?: { model?: ModelRef; reasoningEffort?: string } };
      if (saved.request?.model) return { model: saved.request.model, reasoningEffort: saved.request.reasoningEffort ?? null };
    }
    const config = RunConfigSchema.safeParse(JSON.parse(row.config_json));
    return config.success ? { model: config.data.model, reasoningEffort: config.data.reasoningEffort } : { model: null, reasoningEffort: null };
  }

  private hasCurrentReview(row: SolutionRow): boolean {
    return Boolean(this.options.db.db.prepare(`
      SELECT 1 FROM stage_results WHERE research_run_id = ? AND selection_key = ?
        AND stage_id IN ('risk-evaluation', 'decision-analysis') LIMIT 1
    `).get(row.research_run_id, row.id));
  }

  private projectTurn(turn: IdeaTurn): IdeaConversation["turns"][number] {
    const saved = turn.context as { model?: ModelRef; reasoningEffort?: string };
    const assistant = turn.assistant as { reply?: string; citedEvidenceIds?: string[]; assumptions?: string[]; changeSummary?: string | null } | null;
    return {
      id: turn.id, branchId: turn.branchId, branchSequence: turn.branchSequence,
      parentTurnId: turn.parentTurnId, baseSolutionId: turn.baseSolutionId,
      intent: turn.intent, userText: turn.userText, state: turn.state,
      model: saved.model ?? { providerId: "unknown", modelId: "unknown" },
      reasoningEffort: saved.reasoningEffort ?? "unknown",
      assistant: assistant ? { text: assistant.reply ?? "", citedEvidenceIds: assistant.citedEvidenceIds ?? [],
        assumptions: assistant.assumptions ?? [], changeSummary: assistant.changeSummary ?? null,
        generatedSolutionId: turn.generatedSolutionId } : null,
      error: errorMessage(turn.error), createdAt: turn.createdAt, completedAt: turn.completedAt,
    };
  }

  private remainingMs(session: WorkflowSession): number {
    const elapsed = session.runningSince ? Math.max(0, Date.now() - Date.parse(session.runningSince)) : 0;
    return Math.max(0, session.remainingMs - elapsed);
  }

  private async dispatch(pending: PendingDispatch): Promise<void> {
    if (this.dispatching.has(pending.turnId)) return;
    this.dispatching.add(pending.turnId);
    let dispatched = false;
    let providerCompleted = false;
    const request = pending.prepared.request;
    request.onDispatched = () => { this.attempts.markDispatched(pending.attemptId); dispatched = true; };
    request.onAccepted = (identity) => { this.attempts.markAccepted(pending.attemptId, identity); dispatched = true; };
    try {
      const reservation = this.costs.reserve(pending.runId, "idea-follow-up", request.model.providerId,
        request.model.modelId, 1_000, pending.attemptId);
      pending.costReservationId = reservation.id;
      await generateIdeaFollowUp(pending.prepared, pending.modelClient, async (result) => {
        providerCompleted = true;
        const runtimePrompt = result.metadata.prompt;
        if (!runtimePrompt) throw new ProviderFailure("schema", "The provider did not identify the effective prompt", false,
          { attempts: result.metadata.attempts });
        try {
          this.costs.commit(reservation.id, reportedCost(result.metadata.attempts), { usage: result.metadata.usage });
        } catch (error) {
          this.costs.settleUncertain(pending.runId, "Provider cost could not be settled exactly");
          this.options.onError?.(error);
        }
        this.options.db.immediateTransaction(() => {
          this.attempts.recordTerminal(pending.attemptId, { status: "completed", terminalKind: "completed",
            output: result.output, attemptMetadata: result.metadata, usage: result.metadata.usage });
          const stage = this.stages.saveStageResult({
            researchRunId: pending.runId, stageId: "idea-follow-up", selectionId: pending.turnId,
            context: result.effectiveContext, output: result.output, prompt: result.prompt,
            schema: result.request.jsonSchema, inputs: result.request.workOrder.inputs,
            evidence: result.request.evidence.map((item) => ({ sourceId: item.sourceId, content: item.content ?? null })), runtimePrompt,
            effectiveRequest: result.effectiveContext,
          });
          let generatedSolutionId: string | undefined;
          if (result.output.candidate) {
            generatedSolutionId = randomUUID();
            this.stages.saveSolutionOptions(pending.runId, pending.problemId,
              [{ ...result.output.candidate, id: generatedSolutionId }]);
            this.workflows.createSolutionLineage({
              solutionId: generatedSolutionId, rootSolutionId: result.context.rootSolutionId,
              parentSolutionId: result.context.baseSolutionId, turnId: pending.turnId,
              evidenceSnapshotId: result.context.evidenceSnapshotId,
              changeSummary: result.output.changeSummary!,
            });
            this.workflows.setSelectedVersion(result.context.rootSolutionId, generatedSolutionId);
          }
          this.workflows.completeIdeaTurn(pending.turnId, { state: "completed", stageResultId: stage.id,
            assistant: result.output, ...(generatedSolutionId ? { generatedSolutionId } : {}) });
          this.workflows.updateWorkItem(pending.workItemId, "succeeded",
            { outputRefs: { stageResultId: stage.id, ...(generatedSolutionId ? { generatedSolutionId } : {}) } });
          this.workflows.settleBudget(pending.budgetEntryId, { state: "spent",
            settledUnits: Math.min(result.metadata.attempts.length || 1, result.request.repairPolicy === "one_retry" ? 2 : 1),
            generationAttemptId: pending.attemptId });
          this.runs.finish(pending.runId, "completed");
          const session = this.workflows.getSession(pending.sessionId)!;
          this.workflows.updateSession(session.id, session.revision, { state: "finished", outcome: "target-met",
            remainingMs: this.remainingMs(session), runningSince: null });
        });
      });
    } catch (cause) {
      if (pending.costReservationId) {
        const attempts = cause instanceof ProviderFailure ? cause.attempts ?? [] : [];
        const uncertain = (dispatched || providerCompleted) && (attempts.length === 0 || attempts.some((attempt) => attempt.providerCompletion === "unknown"));
        try {
          if (uncertain) this.costs.settleUncertain(pending.runId, "Idea follow-up completion was not confirmed");
          else if (dispatched || providerCompleted) this.costs.commit(pending.costReservationId, reportedCost(attempts), { failure: true });
          else this.costs.release(pending.costReservationId);
        } catch (error) {
          this.options.onError?.(error);
        }
      }
      this.finishFailure(pending, cause, dispatched || providerCompleted);
    } finally {
      this.dispatching.delete(pending.turnId);
      this.options.onProgress(pending.sessionId);
    }
  }

  private finishFailure(pending: PendingDispatch, cause: unknown, dispatched: boolean): void {
    const providerFailure = cause instanceof ProviderFailure ? cause : null;
    const attempts = providerFailure?.attempts ?? [];
    const unknown = dispatched && (attempts.length === 0 || attempts.some((attempt) => attempt.providerCompletion === "unknown"));
    const cancelled = providerFailure?.code === "cancelled";
    const safeMessage = cause instanceof Error ? cause.message : "The follow-up failed.";
    this.options.db.immediateTransaction(() => {
      const turn = this.workflows.getIdeaTurn(pending.turnId);
      if (turn?.state !== "pending") return;
      this.attempts.recordTerminal(pending.attemptId, { status: unknown ? "interrupted" : cancelled ? "cancelled" : "failed",
        terminalKind: unknown ? "unknown-completion" : dispatched ? "known-failure" : "never-dispatched",
        errorCode: providerFailure?.code ?? "failed", errorMessage: safeMessage,
        attemptMetadata: attempts });
      this.workflows.completeIdeaTurn(pending.turnId, { state: unknown ? "unknown" : cancelled ? "cancelled" : "failed",
        error: { code: providerFailure?.code ?? "failed", message: safeMessage } });
      this.workflows.updateWorkItem(pending.workItemId, unknown ? "unknown" : cancelled ? "cancelled" : "failed",
        { error: { message: safeMessage } });
      this.workflows.settleBudget(pending.budgetEntryId, unknown
        ? { state: "uncertain", settledUnits: pending.prepared.request.repairPolicy === "one_retry" ? 2 : 1,
            generationAttemptId: pending.attemptId }
        : dispatched
          ? { state: "spent", settledUnits: Math.min(attempts.length || 1, pending.prepared.request.repairPolicy === "one_retry" ? 2 : 1),
              generationAttemptId: pending.attemptId }
          : { state: "released", settledUnits: 0 });
      this.runs.finish(pending.runId, cancelled ? "cancelled" : "failed", safeMessage);
      const session = this.workflows.getSession(pending.sessionId)!;
      this.workflows.updateSession(session.id, session.revision, { state: "finished",
        outcome: unknown ? "needs-attention" : cancelled ? "cancelled" : "failed",
        remainingMs: this.remainingMs(session), runningSince: null });
    });
  }
}

function parseIds(value: string | null): string[] {
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function errorMessage(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "message" in value && typeof value.message === "string") return value.message;
  return null;
}

function reportedCost(attempts: GenerationAttemptMetadata[]): number | null {
  if (!attempts.length || attempts.some((attempt) => attempt.cost.status !== "reported"
    || (attempt.cost.value.currency && attempt.cost.value.currency !== "USD"))) return null;
  return attempts.reduce((sum, attempt) => sum + (attempt.cost.status === "reported" ? attempt.cost.value.amount : 0), 0);
}
