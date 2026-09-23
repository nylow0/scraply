import type { DatabaseClient } from "../db/client";
import { DiscoveryRepository } from "../db/repositories/discovery";
import { OpportunityRepository } from "../db/repositories/opportunities";
import { WorkflowRepository, type WorkflowSession, type WorkflowWorkItem } from "../db/repositories/workflows";
import { canonicalJson, sha256 } from "../shared/content-identity";
import { AppError } from "../shared/errors";
import type { ProblemCandidate, ResearchEvent } from "../shared/ipc";
import { ReasoningEffortSchema, RunConfigSchema } from "../shared/schemas";
import {
  CommandWorkflowRequestSchema, PreviewWorkflowRequestSchema, StartWorkflowRequestSchema,
  WorkflowLaunchContractSchema, WorkflowSummarySchema, WorkflowDetailSchema,
  type WorkflowAction, type WorkflowAdmissionReceipt, type WorkflowDetail, type WorkflowLaunchContract,
  type WorkflowSummary,
} from "../shared/workflow-contracts";
import { discoveryRunProjection } from "../shared/discovery-projection";
import type { ResearchEngine } from "./research-engine";
import { previewLaunch, verifyLaunchPreview, type WorkflowCapabilities } from "./workflow-preflight";
import { selectVibeProblems } from "./vibe-selection";
import { allocateIdeaTargets, planIdeaFill } from "./opportunity-planning";
import { loadManagedCoverageGaps, markManagedCoverageGapCovered, runManagedCoverageMap } from "./managed-coverage-map";
import { loadManagedCoverageSearchSources, runManagedCoverageSearch } from "./managed-coverage-search";
import { materializeResearchSnapshot } from "./research-revisions";
import { DEFAULT_OPPORTUNITY_EXPLORATION_CONFIG, OpportunityExplorationConfigSchema } from "../shared/opportunity-exploration";

export interface WorkflowCoordinatorOptions {
  db: DatabaseClient;
  engine: () => ResearchEngine;
  capabilities: () => Promise<WorkflowCapabilities>;
  listProblems: (threadId: string, discoveryRunId: string) => ProblemCandidate[];
  onProgress: (summary: WorkflowSummary, changedTaskIds: string[]) => void;
  onError?: (error: unknown) => void;
  researchService?: {
    admitRequest: (sessionId: string, expectedRevision: number, action: Extract<WorkflowAction, { type: "request-research" }>) => { workItemId: string; session: WorkflowSession };
    continueFinishedSession: (sessionId: string, expectedRevision: number, action: Extract<WorkflowAction, { type: "request-research" }>) => { workItemId: string; session: WorkflowSession };
    dispatchReady: (sessionId: string) => Promise<void>;
    resumeRequest?: (sessionId: string, runId: string) => Promise<void>;
    cancelRequestRun?: (runId: string) => Promise<void>;
    handleRunEvent: (event: ResearchEvent) => Promise<void>;
    applyResearch: (sessionId: string, expectedRevision: number, action: Extract<WorkflowAction, { type: "apply-research" }>) => { session: WorkflowSession };
  };
  ideaService?: {
    getConversation: (input: unknown) => unknown;
    submitTurn: (input: unknown) => Promise<unknown>;
    summary: (sessionId: string) => WorkflowSummary;
    selectVersion?: (threadId: string, rootSolutionId: string, solutionId: string) => void;
  };
}

/** The coordinator admits work before dispatch and advances only from committed run events. */
export class WorkflowCoordinator {
  private readonly repository: WorkflowRepository;
  private readonly dispatching = new Set<string>();
  private readonly coverageControllers = new Map<string, AbortController>();

  constructor(private readonly options: WorkflowCoordinatorOptions) {
    this.repository = new WorkflowRepository(options.db);
  }

  /** Startup recovery never redispatches a call whose completion is uncertain. */
  reconcileInterrupted(): void {
    const rows = this.options.db.db.prepare(`SELECT id FROM workflow_sessions
      WHERE state IN ('running','pause-requested','stop-requested') ORDER BY started_at`)
      .all() as Array<{ id: string }>;
    for (const row of rows) {
      const session = this.repository.getSession(row.id);
      if (!session || session.purpose === "idea-turn") continue;
      const running = this.repository.listWorkItems(session.id).find((item) => item.state === "running");
      if (running && ["coverage-map", "coverage-search"].includes(running.kind)) {
        const attempt = this.coverageAttempt(running.id);
        if (session.state === "stop-requested") {
          this.options.db.immediateTransaction(() => {
            this.repository.updateWorkItem(running.id, "cancelled", { outputRefs: running.outputRefs,
              error: { message: "Stopped while checking a coverage gap." } });
            this.settleTaskBudget(running.id, attempt?.dispatched_at ? "uncertain" : "released", 0, attempt?.id);
            this.repository.updateSession(session.id, session.revision, {
              state: "finished", outcome: "cancelled", remainingMs: remainingMs(session),
            });
          });
          this.progress(session.id, [running.id]);
          continue;
        }
        if (!attempt || attempt.status === "prepared" || attempt.status === "completed") {
          this.options.db.immediateTransaction(() => this.repository.returnCoverageTaskToReady(running.id));
        } else {
          const unknown = attempt.status === "dispatched" || attempt.status === "unknown-dispatch";
          this.options.db.immediateTransaction(() => {
            this.repository.updateWorkItem(running.id, unknown ? "unknown" : "failed", {
              outputRefs: { attemptId: attempt.id },
              error: { message: unknown
                ? "Coverage work may have completed while the app was closed. Review it before retrying."
                : "Coverage work failed before dispatch." },
            });
            this.settleTaskBudget(running.id, unknown ? "uncertain" : "released", 0, attempt.id);
            this.repository.updateSession(session.id, session.revision, {
              state: "finished", outcome: unknown ? "needs-attention" : "partial", remainingMs: remainingMs(session),
            });
          });
          this.progress(session.id, [running.id]);
          continue;
        }
      }
      if (running && !["coverage-map", "coverage-search"].includes(running.kind) && !runIdFromItem(running)) {
        const unlinked = this.options.db.db.prepare(`SELECT run.id, run.status FROM research_runs run
          WHERE run.workflow_session_id = ? AND run.created_at >= ?
            AND NOT EXISTS (SELECT 1 FROM workflow_work_items item
              WHERE item.session_id = ? AND json_extract(item.output_refs_json, '$.runId') = run.id)
          ORDER BY run.created_at, run.id`)
          .all(session.id, running.createdAt, session.id) as Array<{ id: string; status: string }>;
        if (unlinked.length === 1 && ["queued", "running"].includes(unlinked[0]!.status)) {
          this.options.db.immediateTransaction(() => this.repository.linkRunToRunningWorkItem(running.id, unlinked[0]!.id));
        } else if (unlinked.length > 0) {
          this.options.db.immediateTransaction(() => {
            this.repository.updateWorkItem(running.id, "unknown", {
              error: { message: "A research run was saved without a task link. Review it before retrying." },
            });
            this.settleTaskBudget(running.id, "uncertain", 0);
            this.repository.updateSession(session.id, session.revision, {
              state: "finished", outcome: "needs-attention", remainingMs: remainingMs(session),
            });
          });
          this.progress(session.id, [running.id]);
          continue;
        } else if (session.state !== "stop-requested") {
          this.options.db.immediateTransaction(() => this.repository.returnUndispatchedWorkItemToReady(running.id));
        }
      }
      const linkedRunning = this.repository.getWorkItem(running?.id ?? "");
      if (linkedRunning?.state === "running") {
        const runId = runIdFromItem(linkedRunning);
        if (runId && this.hasUnknownAttempt(runId)) {
          this.options.db.immediateTransaction(() => {
            this.repository.updateWorkItem(linkedRunning.id, "unknown", {
              outputRefs: linkedRunning.outputRefs, error: { message: "A provider call may have completed while the app was closed." },
            });
            this.settleTaskBudget(linkedRunning.id, "uncertain", this.providerAttemptCount(runId));
            this.repository.updateSession(session.id, session.revision, {
              state: "finished", outcome: "needs-attention", remainingMs: remainingMs(session),
            });
          });
          this.progress(session.id, [linkedRunning.id]);
          continue;
        }
      }
      if (session.state === "stop-requested") {
        this.options.db.immediateTransaction(() => {
          const pending = this.repository.listWorkItems(session.id).filter((item) => item.state === "running" || item.state === "ready");
          for (const item of pending) {
            const runId = runIdFromItem(item);
            this.repository.updateWorkItem(item.id, item.state === "running" ? "cancelled" : "skipped", {
              ...(runId ? { outputRefs: item.outputRefs } : {}), error: { message: "Stopped before the app restarted." },
            });
            this.settleTaskBudget(item.id, runId ? "spent" : "released", runId ? this.providerAttemptCount(runId) : 0);
            if (runId) this.options.db.db.prepare(`UPDATE research_runs SET status = 'cancelled', cancelled = 1,
              interrupted = 0, updated_at = ? WHERE id = ? AND status IN ('queued','running')`)
              .run(new Date().toISOString(), runId);
          }
          this.repository.updateSession(session.id, session.revision, {
            state: "finished", outcome: "cancelled", remainingMs: remainingMs(session),
          });
        });
        this.progress(session.id, []);
        continue;
      }
      this.options.db.immediateTransaction(() => {
        this.repository.updateSession(session.id, session.revision, {
          state: "paused", remainingMs: remainingMs(session), runningSince: null,
        });
      });
      this.progress(session.id, []);
    }
  }

  async preview(input: unknown) {
    const request = PreviewWorkflowRequestSchema.parse(input);
    const capabilities = await this.options.capabilities();
    if (request.type === "launch") {
      this.requireThread(request.threadId);
      const preview = previewLaunch(request.draft, capabilities);
      return {
        type: "launch" as const,
        proposal: preview.contract,
        previewHash: preview.previewHash,
        capabilityFingerprint: preview.capabilityFingerprint,
        minimumWork: preview.minimumWork,
        upperLimits: preview.contract.limits,
        fieldErrors: preview.fieldErrors,
        expiresAt: preview.expiresAt,
      };
    }
    const session = this.requireSession(request.sessionId, request.threadId);
    if (session.revision !== request.expectedRevision) throw new AppError("REVISION_CONFLICT");
    if (session.state === "finished") throw new AppError("REVISION_CONFLICT", "Start a new session to continue completed work.");
    const contract = WorkflowLaunchContractSchema.parse(session.contract);
    const proposal = request.extension;
    const upperLimits = {
      maxMinutes: Math.min(240, contract.limits.maxMinutes + session.additionalMinutes + proposal.additionalMinutes),
      maxModelCalls: contract.limits.maxModelCalls + session.additionalModelCalls + proposal.additionalModelCalls,
      maxSearches: contract.limits.maxSearches + session.additionalSearches + proposal.additionalSearches,
    };
    const capabilityFingerprint = capabilityHash(capabilities);
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    return {
      type: "budget-extension" as const,
      proposal,
      previewHash: sha256(canonicalJson({ sessionId: session.id, revision: session.revision, proposal, capabilityFingerprint, expiresAt })),
      capabilityFingerprint,
      minimumWork: { modelCalls: 0, searches: 0 },
      upperLimits,
      fieldErrors: upperLimits.maxMinutes < contract.limits.maxMinutes + session.additionalMinutes + proposal.additionalMinutes
        ? [{ path: ["extension", "additionalMinutes"], code: "BUDGET_TOO_SMALL", message: "The total time limit cannot exceed 240 minutes." }]
        : [],
      expiresAt,
    };
  }

  async start(input: unknown): Promise<WorkflowAdmissionReceipt> {
    const request = StartWorkflowRequestSchema.parse(input);
    const previous = this.repository.getCommand(request.threadId, request.clientCommandId);
    if (previous) return this.replay(previous.payloadSha256, previous.result, request);
    this.requireThread(request.threadId);
    const capabilities = await this.options.capabilities();
    if (!verifyLaunchPreview(request, capabilities)) throw new AppError("PREVIEW_STALE");
    const contract = WorkflowLaunchContractSchema.parse(request.contract);
    const fresh = previewLaunch(draftFromContract(contract), capabilities, new Date(Date.parse(request.previewExpiresAt) - 10 * 60_000));
    if (fresh.fieldErrors.length > 0) {
      const first = fresh.fieldErrors[0]!;
      throw new AppError(first.code === "BUDGET_TOO_SMALL" ? "BUDGET_TOO_SMALL" : "MODEL_UNAVAILABLE", first.message,
        undefined, undefined, { fieldErrors: fresh.fieldErrors });
    }
    this.requireProjectIdle(request.threadId);
    let initialTaskId = "";
    const receipt = this.options.db.immediateTransaction(() => {
      const session = this.repository.createSession({
        threadId: request.threadId, purpose: contract.purpose, mode: contract.mode,
        contract, remainingMs: contract.limits.maxMinutes * 60_000,
      });
      const familyBaseline = contract.targets.kind === "project"
        ? this.projectFamilyProgress(session.id, session.threadId, []).baseline : null;
      const initial = this.repository.createWorkItem({
        sessionId: session.id, kind: contract.purpose === "known-problem" ? "known-problem" : "discovery",
        scopeKey: "initial-research", input: { brief: contract.brief, purpose: contract.purpose,
          ...(familyBaseline ? { familyBaseline } : {}) }, state: "ready",
      });
      initialTaskId = initial.id;
      const projection = contract.purpose === "discovery"
        ? discoveryRunProjection(contract.runConfig.discoveryDepth)
        : { modelCalls: 0, searches: 0 };
      if (projection.modelCalls) this.repository.reserveBudget({ sessionId: session.id, workItemId: initial.id,
        operationKey: `research-model:${initial.id}`, kind: "model-call", reservedUnits: projection.modelCalls * 2 });
      if (projection.searches) this.repository.reserveBudget({ sessionId: session.id, workItemId: initial.id,
        operationKey: `research-search:${initial.id}`, kind: "search", reservedUnits: projection.searches });
      const result = this.receipt(session.id);
      this.repository.recordCommand({ threadId: request.threadId, sessionId: session.id,
        clientCommandId: request.clientCommandId, payload: request, result });
      return result;
    });
    this.progress(receipt.sessionId, [initialTaskId]);
    void this.dispatchInitial(receipt.sessionId, initialTaskId).catch((error) => this.failDispatch(receipt.sessionId, initialTaskId, error));
    return receipt;
  }

  get(sessionId: string, cursor?: string): WorkflowDetail {
    const session = this.repository.getSession(sessionId);
    if (!session) throw new AppError("not_found", "Workflow session not found.");
    const items = this.repository.listWorkItems(sessionId);
    const offset = cursor ? Number(cursor) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new AppError("validation_error", "Invalid task cursor.");
    const page = items.slice(offset, offset + 30);
    return WorkflowDetailSchema.parse({
      summary: this.summary(sessionId),
      tasks: page.map((item) => ({
        id: item.id, parentItemId: item.parentItemId, kind: item.kind, scopeKey: item.scopeKey,
        state: item.state, question: questionFromItem(item),
        error: errorFromItem(item), createdAt: item.createdAt, finishedAt: item.finishedAt,
        ...((item.state === "failed" || item.state === "unknown") && terminalAttemptId(this.options.db, item)
          ? { terminalAttemptId: terminalAttemptId(this.options.db, item)! } : {}),
      })),
      nextCursor: offset + page.length < items.length ? String(offset + page.length) : null,
    });
  }

  findActiveSummary(threadId: string): WorkflowSummary | null {
    const row = this.options.db.db.prepare(`
      SELECT id FROM workflow_sessions WHERE thread_id = ? AND purpose != 'idea-turn'
      ORDER BY started_at DESC, rowid DESC LIMIT 1
    `).get(threadId) as { id: string } | undefined;
    return row ? this.summary(row.id) : null;
  }

  summary(sessionId: string): WorkflowSummary {
    const session = this.repository.getSession(sessionId);
    if (!session) throw new AppError("not_found", "Workflow session not found.");
    if (session.purpose === "idea-turn" && this.options.ideaService) return this.options.ideaService.summary(sessionId);
    const contract = WorkflowLaunchContractSchema.parse(session.contract);
    const items = this.repository.listWorkItems(sessionId);
    const entries = this.repository.listBudgetEntries(sessionId);
    const selectedProblemIds = session.activeSnapshotId
      ? this.repository.getSnapshot(session.activeSnapshotId)?.selection.problemIds ?? []
      : [];
    const generationItems = items.filter((item) => item.kind === "generate-ideas");
    const initialInput = generationItems.find((item) => fillRoundFromItem(item) === 0)?.input as {
      targetKind?: "per-problem" | "project"; requestedTarget?: number;
    } | undefined;
    const targetKind = initialInput?.targetKind ?? contract.targets.kind;
    const requested = generationItems.length > 0
      ? targetKind === "project"
        ? initialInput?.requestedTarget ?? contract.targets.distinctBusinessCount ?? contract.targets.ideaCount
        : generationItems.filter((item) => fillRoundFromItem(item) === 0).reduce((count, item) => count + requestedFromItem(item), 0)
      : contract.targets.kind === "project"
        ? contract.targets.distinctBusinessCount ?? contract.targets.ideaCount
        : contract.targets.ideaCount * Math.max(1, selectedProblemIds.length);
    const creditedPerProblem = selectedProblemIds.reduce((sum, problemId) => {
      const assigned = generationItems.filter((item) => fillRoundFromItem(item) === 0 && problemIdFromItem(item) === problemId)
        .reduce((count, item) => count + requestedFromItem(item), 0);
      const reviewed = new Set(generationItems.filter((item) => problemIdFromItem(item) === problemId)
        .flatMap((item) => outputSolutionIds(item))).size;
      return sum + Math.min(assigned, reviewed);
    }, 0);
    const proposed = generationItems.flatMap((item) => proposedSolutionIds(item));
    const attempted = proposed.length;
    const reviews = generationItems.flatMap((item) => {
      const review = reviewFromItem(this.options.db, item);
      return review ? [review] : [];
    });
    const families = targetKind === "project" ? this.projectFamilyProgress(session.id, session.threadId, generationItems) : null;
    const existing = families?.existing ?? 0;
    const addedBySession = families?.added ?? creditedPerProblem;
    const total = families?.total ?? creditedPerProblem;
    const credited = total;
    const duplicate = reviews.reduce((count, review) => count + review.decisions.filter((decision) => decision.status === "duplicate" || decision.status === "variant").length, 0);
    const unresolvedReviews = reviews.reduce((count, review) => count + review.decisions.filter((decision) => decision.status === "unresolved").length, 0);
    const unresolved = generationItems.filter((item) => item.state === "unknown").length;
    const failed = items.filter((item) => item.state === "failed").length;
    const counts = {
      requested, attempted, validated: reviews.reduce((count, review) => count + review.decisions.length, 0), accepted: credited, duplicate, unresolved: unresolved + unresolvedReviews, failed,
      missing: Math.max(0, requested - credited), existing, addedBySession, total,
    };
    const limits = {
      maxMinutes: Math.min(240, contract.limits.maxMinutes + session.additionalMinutes),
      maxModelCalls: contract.limits.maxModelCalls + session.additionalModelCalls,
      maxSearches: contract.limits.maxSearches + session.additionalSearches,
    };
    const budgetStatus = (kind: "model-call" | "search", limit: number) => {
      const matching = entries.filter((entry) => entry.kind === kind);
      return {
        limit,
        spent: matching.filter((entry) => entry.state === "spent").reduce((total, entry) => total + (entry.settledUnits ?? 0), 0),
        reserved: matching.filter((entry) => entry.state === "reserved").reduce((total, entry) => total + entry.reservedUnits, 0),
        uncertain: matching.filter((entry) => entry.state === "uncertain").reduce((total, entry) => total + entry.reservedUnits, 0),
      };
    };
    const current = items.find((item) => item.state === "running") ?? items.find((item) => item.state === "ready") ?? null;
    return WorkflowSummarySchema.parse({
      sessionId: session.id, threadId: session.threadId, purpose: session.purpose, mode: session.mode, targetKind,
      state: session.state, outcome: session.outcome, revision: session.revision,
      activeSnapshotId: session.activeSnapshotId, selectedProblemIds, counts, limits,
      budget: {
        modelCalls: budgetStatus("model-call", limits.maxModelCalls),
        searches: budgetStatus("search", limits.maxSearches),
        remainingMs: remainingMs(session),
      },
      currentStage: current?.kind ?? null,
      stopReason: session.outcome ? terminalReason(items, session) : null,
      startedAt: session.startedAt, finishedAt: session.finishedAt,
    });
  }

  private receipt(sessionId: string): WorkflowAdmissionReceipt {
    const summary = this.summary(sessionId);
    return { sessionId, revision: summary.revision, summary };
  }

  private projectFamilyProgress(sessionId: string, threadId: string, generationItems: WorkflowWorkItem[]): {
    existing: number; added: number; total: number;
    baseline: { acceptedFamilyCount: number; acceptedFamilyIds: string[]; candidateInventoryIds: string[]; existingCount: number };
  } {
    const baseline = this.repository.listWorkItems(sessionId)
      .map((item) => (item.input as { familyBaseline?: unknown }).familyBaseline)
      .find((value): value is { acceptedFamilyCount: number; acceptedFamilyIds: string[];
        candidateInventoryIds: string[]; existingCount: number } =>
        typeof value === "object" && value !== null
        && typeof (value as { existingCount?: unknown }).existingCount === "number"
        && Array.isArray((value as { acceptedFamilyIds?: unknown }).acceptedFamilyIds)
        && Array.isArray((value as { candidateInventoryIds?: unknown }).candidateInventoryIds));
    const view = new OpportunityRepository(this.options.db).familyView(threadId);
    const counted = view.families.filter((family) => family.counted);
    // Any saved membership decision supersedes an older review checkpoint, including
    // a later deactivation or uncertain decision that removes a family from the total.
    const coveredOptionIds = new Set([
      ...view.families.flatMap((family) => family.members.map((member) => member.optionId)),
      ...view.unresolved.map((entry) => entry.membership.optionId),
    ]);
    const previousRows = this.options.db.db.prepare(`SELECT stage.context_json FROM stage_results stage
      JOIN research_runs run ON run.id = stage.research_run_id
      WHERE run.thread_id = ? AND run.workflow_session_id IS NOT ? AND stage.stage_id = 'solution-set-review'`)
      .all(threadId, sessionId) as Array<{ context_json: string }>;
    const previousAccepted = new Set<string>();
    for (const row of previousRows) {
      const context = JSON.parse(row.context_json) as { solutionSetReview?: { acceptedSolutionIds?: unknown } };
      for (const id of Array.isArray(context.solutionSetReview?.acceptedSolutionIds)
        ? context.solutionSetReview.acceptedSolutionIds : []) {
        if (typeof id !== "string" || coveredOptionIds.has(id)) continue;
        const solution = this.options.db.db.prepare("SELECT startup_opportunity_json FROM solutions WHERE id = ?")
          .get(id) as { startup_opportunity_json: string | null } | undefined;
        if (!solution?.startup_opportunity_json) continue;
        const startup = JSON.parse(solution.startup_opportunity_json) as { opportunityType?: unknown };
        if (startup.opportunityType === "startup-opportunity") previousAccepted.add(id);
      }
    }
    const currentAccepted = new Set(generationItems.flatMap((item) => outputSolutionIds(item)));
    const currentUnmapped = [...currentAccepted].filter((id) => !coveredOptionIds.has(id) && !previousAccepted.has(id));
    const existing = baseline?.existingCount ?? counted.length + previousAccepted.size;
    const addedFamilies = counted.filter((family) => !baseline?.acceptedFamilyIds.includes(family.id)
      && family.members.some((member) => currentAccepted.has(member.optionId)));
    const candidateInventoryIds = [...new Set([
      ...view.unreviewedOptionIds,
      ...view.families.flatMap((family) => family.members.map((member) => member.optionId)),
      ...view.unresolved.map((entry) => entry.membership.optionId),
      ...previousAccepted,
    ])].sort();
    return {
      existing, added: addedFamilies.length + currentUnmapped.length,
      total: counted.length + previousAccepted.size + currentUnmapped.length,
      baseline: baseline ?? { acceptedFamilyCount: counted.length, acceptedFamilyIds: counted.map((family) => family.id),
        candidateInventoryIds, existingCount: existing },
    };
  }

  private replay(expectedHash: string, result: unknown, payload: unknown): WorkflowAdmissionReceipt {
    if (expectedHash !== sha256(canonicalJson(payload))) throw new AppError("IDEMPOTENCY_CONFLICT");
    const saved = result as WorkflowAdmissionReceipt;
    return { ...saved, summary: this.summary(saved.sessionId) };
  }

  private requireThread(threadId: string): void {
    const row = this.options.db.db.prepare("SELECT id FROM threads WHERE id = ?").get(threadId);
    if (!row) throw new AppError("not_found", "Project not found.");
  }

  private requireSession(sessionId: string, threadId: string): WorkflowSession {
    const session = this.repository.getSession(sessionId);
    if (!session || session.threadId !== threadId) throw new AppError("INVALID_REFERENCE");
    return session;
  }

  private requireProjectIdle(threadId: string): void {
    const activeSession = this.options.db.db.prepare("SELECT id FROM workflow_sessions WHERE thread_id = ? AND state != 'finished' LIMIT 1").get(threadId);
    const activeRun = this.options.db.db.prepare("SELECT id FROM research_runs WHERE thread_id = ? AND status IN ('queued','running') LIMIT 1").get(threadId);
    if (activeSession || activeRun) throw new AppError("PROJECT_BUSY");
  }

  private progress(sessionId: string, changedTaskIds: string[]): void {
    this.options.onProgress(this.summary(sessionId), changedTaskIds);
  }

  async command(input: unknown): Promise<WorkflowAdmissionReceipt> {
    const request = CommandWorkflowRequestSchema.parse(input);
    const previous = this.repository.getCommand(request.threadId, request.clientCommandId);
    if (previous) return this.replay(previous.payloadSha256, previous.result, request);
    const session = this.requireSession(request.sessionId, request.threadId);
    if (session.revision !== request.expectedRevision) throw new AppError("REVISION_CONFLICT");
    const action = request.action;
    if (action.type === "retry-task") return this.retryTask({ ...request, action });
    if (action.type === "generate-ideas" || action.type === "request-research") {
      await this.assertModelAvailable(action.model, action.reasoningEffort);
    }
    if (action.type === "generate-ideas" && action.reviewModel) {
      await this.assertModelAvailable(action.reviewModel, action.reviewReasoningEffort ?? action.reasoningEffort);
    }
    if (action.type === "extend-budget") {
      const capabilities = await this.options.capabilities();
      if (action.capabilityFingerprint !== capabilityHash(capabilities)) throw new AppError("PREVIEW_STALE");
    }
    let changedTaskIds: string[] = [];
    let startResearch = false;
    let dispatchIdeas = false;
    let planIdeas = false;
    let initialTaskId: string | null = null;
    let resumeRunId: string | null = null;
    let resumeResearchRunId: string | null = null;
    let resumeCompletedRun: ResearchEvent | null = null;
    let cancelRunId: string | null = null;
    let cancelResearchRun = false;
    let cancelCoverageTaskId: string | null = null;
    const receipt = this.options.db.immediateTransaction(() => {
      const current = this.requireSession(request.sessionId, request.threadId);
      if (current.revision !== request.expectedRevision) throw new AppError("REVISION_CONFLICT");
      let receiptSessionId = current.id;
      switch (action.type) {
        case "request-research": {
          if (!this.options.researchService) throw new AppError("conflict", "Research requests are unavailable.");
          const admitted = current.state === "finished"
            ? this.options.researchService.continueFinishedSession(current.id, current.revision, action)
            : this.options.researchService.admitRequest(current.id, current.revision, action);
          receiptSessionId = admitted.session.id;
          changedTaskIds = [admitted.workItemId];
          startResearch = true;
          break;
        }
        case "apply-research": {
          if (!this.options.researchService) throw new AppError("conflict", "Research selection is unavailable.");
          this.options.researchService.applyResearch(current.id, current.revision, action);
          break;
        }
        case "generate-ideas": {
          if (current.state !== "waiting-for-review") throw new AppError("conflict", "Review research before generating ideas.");
          const snapshot = this.repository.getSnapshot(action.snapshotId);
          if (!snapshot || snapshot.sessionId !== current.id || snapshot.id !== current.activeSnapshotId) throw new AppError("INVALID_REFERENCE");
          if (action.problemIds.some((id) => !snapshot.selection.problemIds.includes(id)) || new Set(action.problemIds).size !== action.problemIds.length) {
            throw new AppError("INVALID_REFERENCE", "A selected problem is absent from the active evidence snapshot.");
          }
          const materialized = materializeResearchSnapshot(this.options.db, {
            threadId: current.threadId, baseRunId: snapshot.materializationRunId,
            sourceProblemIds: action.problemIds, sessionId: current.id,
          });
          const selected = this.repository.createSnapshot({
            sessionId: current.id, parentSnapshotId: snapshot.id,
            materializationRunId: materialized.runId,
            selection: { problemIds: materialized.problemIds }, originMap: materialized.originMap,
          });
          const updated = this.repository.updateSession(current.id, current.revision, {
            state: "running", activeSnapshotId: selected.id, runningSince: new Date().toISOString(),
          });
          changedTaskIds = this.admitGenerationTasks(updated, selected.id, materialized.problemIds, action);
          dispatchIdeas = true;
          break;
        }
        case "pause": {
          if (current.state !== "running") throw new AppError("conflict", "Only a running workflow can pause.");
          this.repository.updateSession(current.id, current.revision, { state: "pause-requested" });
          break;
        }
        case "resume": {
          if (current.state !== "paused") throw new AppError("conflict", "Only a safely paused workflow can resume.");
          if (this.repository.listWorkItems(current.id).some((item) => item.state === "unknown")) throw new AppError("UNKNOWN_COMPLETION");
          const items = this.repository.listWorkItems(current.id);
          const running = items.find((item) => item.state === "running");
          const readyInitial = items.find((item) => (item.kind === "discovery" || item.kind === "known-problem") && item.state === "ready");
          const readyResearch = items.some((item) => item.kind === "research-request" && item.state === "ready");
          const readyCoverage = items.some((item) => ["coverage-map", "coverage-search"].includes(item.kind) && item.state === "ready");
          const existingIdeas = items.some((item) => item.kind === "generate-ideas");
          const contract = WorkflowLaunchContractSchema.parse(current.contract);
          if (running) {
            const runId = runIdFromItem(running);
            if (!runId) throw new AppError("UNKNOWN_COMPLETION", "The running task has no saved run to resume.");
            const saved = this.options.db.db.prepare("SELECT status, problem_id FROM research_runs WHERE id = ?")
              .get(runId) as { status: string; problem_id: string | null } | undefined;
            if (!saved) throw new AppError("INVALID_REFERENCE");
            if (saved.status === "completed") {
              resumeCompletedRun = { type: "run-completed", runId, threadId: current.threadId, problemId: saved.problem_id };
            } else if (saved.status === "running" || saved.status === "queued") {
              if (running.kind === "research-request") resumeResearchRunId = runId;
              else resumeRunId = runId;
            } else throw new AppError("UNKNOWN_COMPLETION", "Review the saved task before continuing.");
            this.repository.updateSession(current.id, current.revision, { state: "running", runningSince: new Date().toISOString() });
          } else if (readyInitial) {
            initialTaskId = readyInitial.id;
            this.repository.updateSession(current.id, current.revision, { state: "running", runningSince: new Date().toISOString() });
          } else if (readyResearch) {
            startResearch = true;
            this.repository.updateSession(current.id, current.revision, { state: "running", runningSince: new Date().toISOString() });
          } else if (readyCoverage) {
            dispatchIdeas = true;
            this.repository.updateSession(current.id, current.revision, { state: "running", runningSince: new Date().toISOString() });
          } else if (!existingIdeas && contract.mode === "babysit") {
            this.repository.updateSession(current.id, current.revision, { state: "waiting-for-review", runningSince: null });
          } else {
            this.repository.updateSession(current.id, current.revision, { state: "running", runningSince: new Date().toISOString() });
            if (existingIdeas) dispatchIdeas = true;
            else planIdeas = true;
          }
          break;
        }
        case "stop": {
          if (current.state === "finished") throw new AppError("conflict", "This workflow already finished.");
          const runningItem = this.repository.listWorkItems(current.id).find((item) => item.state === "running");
          cancelRunId = runningItem ? runIdFromItem(runningItem) : null;
          cancelResearchRun = runningItem?.kind === "research-request";
          cancelCoverageTaskId = runningItem && ["coverage-map", "coverage-search"].includes(runningItem.kind) ? runningItem.id : null;
          if (runningItem) this.repository.updateSession(current.id, current.revision, { state: "stop-requested" });
          else {
            for (const item of this.repository.listWorkItems(current.id).filter((candidate) => candidate.state === "ready" || candidate.state === "running")) {
              this.repository.updateWorkItem(item.id, item.state === "running" ? "cancelled" : "skipped", {
                error: { message: "Stopped by the user." },
              });
              this.settleTaskBudget(item.id, "released", 0);
              changedTaskIds.push(item.id);
            }
            this.repository.updateSession(current.id, current.revision, {
              state: "finished", outcome: "cancelled", remainingMs: remainingMs(current),
            });
          }
          break;
        }
        case "extend-budget": {
          if (current.state === "finished") throw new AppError("REVISION_CONFLICT", "Start a new session to continue completed work.");
          const expires = Date.parse(action.previewExpiresAt);
          if (!Number.isFinite(expires) || Date.now() > expires || expires - Date.now() > 10 * 60_000) throw new AppError("PREVIEW_STALE");
          const expectedHash = sha256(canonicalJson({ sessionId: current.id, revision: current.revision,
            proposal: action.extension, capabilityFingerprint: action.capabilityFingerprint, expiresAt: action.previewExpiresAt }));
          if (expectedHash !== action.previewHash) throw new AppError("PREVIEW_STALE");
          const contract = WorkflowLaunchContractSchema.parse(current.contract);
          if (contract.limits.maxMinutes + current.additionalMinutes + action.extension.additionalMinutes > 240) {
            throw new AppError("BUDGET_TOO_SMALL", "The total time limit cannot exceed 240 minutes.");
          }
          this.repository.extendLimits(current.id, current.revision, {
            modelCalls: action.extension.additionalModelCalls,
            searches: action.extension.additionalSearches,
            minutes: action.extension.additionalMinutes,
          });
          break;
        }
        case "select-version": {
          if (!this.options.ideaService?.selectVersion) throw new AppError("conflict", "Idea versions are unavailable.");
          this.options.ideaService.selectVersion(current.threadId, action.rootSolutionId, action.solutionId);
          this.repository.updateSession(current.id, current.revision, {});
          break;
        }
      }
      const result = this.receipt(receiptSessionId);
      this.repository.recordCommand({ threadId: current.threadId, sessionId: receiptSessionId,
        clientCommandId: request.clientCommandId, payload: request, result });
      return result;
    });
    this.progress(receipt.sessionId, changedTaskIds);
    if (cancelCoverageTaskId) this.coverageControllers.get(cancelCoverageTaskId)?.abort(new Error("Stopped by the user"));
    if (startResearch) void this.options.researchService!.dispatchReady(receipt.sessionId).catch((error) => this.options.onError?.(error));
    if (dispatchIdeas) {
      void this.dispatchNextGeneration(receipt.sessionId);
    }
    if (planIdeas) this.planGeneration(receipt.sessionId);
    if (initialTaskId) void this.dispatchInitial(receipt.sessionId, initialTaskId)
      .catch((error) => this.failDispatch(receipt.sessionId, initialTaskId!, error));
    if (resumeRunId) {
      const runId = resumeRunId;
      void this.options.engine().resumeRun(runId).catch((error) => this.options.onError?.(error));
    }
    if (resumeResearchRunId && this.options.researchService?.resumeRequest) {
      const runId = resumeResearchRunId;
      void this.options.researchService.resumeRequest(receipt.sessionId, runId)
        .catch((error) => this.options.onError?.(error));
    }
    if (resumeCompletedRun) this.handleRunEvent(resumeCompletedRun);
    if (cancelRunId) {
      if (cancelResearchRun && this.options.researchService?.cancelRequestRun) {
        void this.options.researchService.cancelRequestRun(cancelRunId).catch((error) => this.options.onError?.(error));
      }
      else this.options.engine().cancelRun(cancelRunId);
    }
    return receipt;
  }

  private async retryTask(request: {
    threadId: string; sessionId: string; clientCommandId: string; expectedRevision: number;
    action: Extract<WorkflowAction, { type: "retry-task" }>;
  }): Promise<WorkflowAdmissionReceipt> {
    const previous = this.repository.getCommand(request.threadId, request.clientCommandId);
    if (previous) return this.replay(previous.payloadSha256, previous.result, request);
    const original = this.requireSession(request.sessionId, request.threadId);
    if (original.revision !== request.expectedRevision) throw new AppError("REVISION_CONFLICT");
    if (original.state !== "finished") throw new AppError("conflict", "Retry a settled task after its session ends.");
    const task = this.repository.getWorkItem(request.action.taskId);
    if (!task || task.sessionId !== original.id || !["discovery", "known-problem", "generate-ideas"].includes(task.kind)
      || (task.state !== "failed" && task.state !== "unknown")) throw new AppError("INVALID_REFERENCE");
    const runId = runIdFromItem(task);
    if (!runId) throw new AppError("UNKNOWN_COMPLETION", "This task has no saved provider attempt to classify.");
    const attempt = this.options.db.db.prepare(`SELECT id, status, terminal_kind, error_code FROM generation_attempts
      WHERE id = ? AND research_run_id = ?`).get(request.action.expectedTerminalAttemptId, runId) as {
        id: string; status: string; terminal_kind: string | null; error_code: string | null;
      } | undefined;
    if (!attempt) throw new AppError("INVALID_REFERENCE", "The terminal attempt does not belong to this task.");
    const ambiguous = task.state === "unknown" || ["dispatched", "accepted"].includes(attempt.status)
      || (attempt.status === "interrupted" && attempt.terminal_kind !== "never-dispatched");
    if (ambiguous && !request.action.acknowledgeUnknownCompletion) throw new AppError("UNKNOWN_COMPLETION");
    const safeTransient = attempt.terminal_kind === "never-dispatched"
      || (attempt.status === "failed" && ["timeout", "rate-limit", "unavailable"].includes(attempt.error_code ?? ""));
    if (!ambiguous && !safeTransient) throw new AppError("conflict", "Only a classified transient failure can retry.");
    const priorRetry = this.options.db.db.prepare(`SELECT 1 FROM workflow_work_items item
      JOIN workflow_sessions session ON session.id = item.session_id
      WHERE session.thread_id = ? AND json_extract(item.input_json, '$.retryOfTaskId') = ? LIMIT 1`)
      .get(request.threadId, task.id);
    if (priorRetry || (task.input as { retryOfTaskId?: unknown }).retryOfTaskId) {
      throw new AppError("conflict", "This task already used its one retry.");
    }
    const contract = WorkflowLaunchContractSchema.parse(original.contract);
    const originalItems = this.repository.listWorkItems(original.id);
    const generationItems = originalItems.filter((item) => item.kind === "generate-ideas");
    const pendingGeneration = task.kind === "generate-ideas"
      ? generationItems.filter((item) => item.id === task.id || item.state === "ready" || isDeferredAfterFailure(item))
      : [];
    const modelCalls = this.availableBudget(original, "model-call");
    const searches = this.availableBudget(original, "search");
    const projection = task.kind === "discovery" ? discoveryRunProjection(contract.runConfig.discoveryDepth) : { modelCalls: 0, searches: 0 };
    const runCalls = task.kind === "generate-ideas" ? 4 * pendingGeneration.length : projection.modelCalls * 2;
    const minimumCalls = task.kind === "generate-ideas" ? runCalls : runCalls + 4;
    if (modelCalls < minimumCalls || searches < projection.searches || remainingMs(original) < 5 * 60_000) {
      throw new AppError("BUDGET_TOO_SMALL", "The original session has too little reserved time or capacity for a retry.");
    }
    const input = task.input as { model?: { providerId: string; modelId: string }; reasoningEffort?: string };
    await this.assertModelAvailable(input.model ?? contract.runConfig.model, input.reasoningEffort ?? contract.runConfig.reasoningEffort);
    this.requireProjectIdle(request.threadId);
    const receipt = this.options.db.immediateTransaction(() => {
      const retryContract = WorkflowLaunchContractSchema.parse({
        ...contract, limits: {
          maxMinutes: Math.max(5, Math.min(240, Math.floor(remainingMs(original) / 60_000))),
          maxModelCalls: modelCalls, maxSearches: searches,
        },
      });
      const session = this.repository.createSession({
        threadId: original.threadId, purpose: original.purpose, mode: original.mode,
        contract: retryContract, remainingMs: retryContract.limits.maxMinutes * 60_000,
      });
      const retryInput: unknown = { ...(task.input as Record<string, unknown>), retryOfTaskId: task.id };
      if (task.kind === "generate-ideas") {
        const source = original.activeSnapshotId ? this.repository.getSnapshot(original.activeSnapshotId) : null;
        if (!source) throw new AppError("INVALID_REFERENCE", "The original evidence snapshot is missing.");
        const copied = materializeResearchSnapshot(this.options.db, {
          threadId: original.threadId, baseRunId: source.materializationRunId,
          sourceProblemIds: source.selection.problemIds, sessionId: session.id,
        });
        const snapshot = this.repository.createSnapshot({
          sessionId: session.id, parentSnapshotId: source.id, materializationRunId: copied.runId,
          selection: { problemIds: copied.problemIds }, originMap: copied.originMap,
        });
        this.repository.updateSession(session.id, session.revision, { activeSnapshotId: snapshot.id });
        for (const prior of generationItems) {
          if (prior.state !== "succeeded" && !pendingGeneration.some((candidate) => candidate.id === prior.id)) continue;
          const sourceProblemId = problemIdFromItem(prior);
          const index = sourceProblemId ? source.selection.problemIds.indexOf(sourceProblemId) : -1;
          if (index < 0) throw new AppError("INVALID_REFERENCE");
          const familyBaseline = retryContract.targets.kind === "project"
            ? this.projectFamilyProgress(session.id, session.threadId, []).baseline : null;
          const carriedInput = { ...(prior.input as Record<string, unknown>), snapshotId: snapshot.id,
            problemId: copied.problemIds[index],
            ...(familyBaseline ? { familyBaseline } : {}),
            ...(prior.id === task.id ? { retryOfTaskId: prior.id } : { continuationOfTaskId: prior.id }) };
          const carried = this.repository.createWorkItem({
            sessionId: session.id, kind: "generate-ideas", scopeKey: `continued:${prior.id}`,
            ordinal: prior.ordinal, state: "ready", input: carriedInput,
          });
          if (prior.state === "succeeded") {
            this.repository.updateWorkItem(carried.id, "running");
            this.repository.updateWorkItem(carried.id, "succeeded", {
              ...(prior.outputRefs === null ? {} : { outputRefs: prior.outputRefs }),
            });
          } else {
            this.repository.reserveBudget({ sessionId: session.id, workItemId: carried.id,
              operationKey: `continued-model:${carried.id}`, kind: "model-call", reservedUnits: 4 });
          }
        }
      } else {
        const retry = this.repository.createWorkItem({
          sessionId: session.id, kind: task.kind, scopeKey: `retry:${task.id}`, state: "ready",
          input: retryInput,
        });
        if (runCalls) this.repository.reserveBudget({ sessionId: session.id, workItemId: retry.id,
          operationKey: `retry-model:${retry.id}`, kind: "model-call", reservedUnits: runCalls });
        if (projection.searches) this.repository.reserveBudget({ sessionId: session.id, workItemId: retry.id,
          operationKey: `retry-search:${retry.id}`, kind: "search", reservedUnits: projection.searches });
      }
      const result = this.receipt(session.id);
      this.repository.recordCommand({ threadId: request.threadId, sessionId: session.id,
        clientCommandId: request.clientCommandId, payload: request, result });
      return result;
    });
    this.progress(receipt.sessionId, this.repository.listWorkItems(receipt.sessionId).map((item) => item.id));
    const retry = this.repository.listWorkItems(receipt.sessionId).find((item) => item.state === "ready");
    if (retry?.kind === "generate-ideas") void this.dispatchNextGeneration(receipt.sessionId);
    else if (retry) void this.dispatchInitial(receipt.sessionId, retry.id)
      .catch((error) => this.failDispatch(receipt.sessionId, retry.id, error));
    return receipt;
  }

  getConversation(input: unknown): unknown {
    if (!this.options.ideaService) throw new AppError("conflict", "Idea conversations are unavailable.");
    return this.options.ideaService.getConversation(input);
  }

  submitTurn(input: unknown): Promise<unknown> {
    if (!this.options.ideaService) throw new AppError("conflict", "Idea conversations are unavailable.");
    return this.options.ideaService.submitTurn(input);
  }

  private async assertModelAvailable(model: { providerId: string; modelId: string }, effort: string): Promise<void> {
    const capabilities = await this.options.capabilities();
    const available = capabilities.modelOptions.find((option) => option.providerId === model.providerId && option.modelId === model.modelId);
    if (!capabilities.nativeConnected || !available || !available.reasoningEfforts.some((option) => option.id === effort)) {
      throw new AppError("MODEL_UNAVAILABLE", "The selected model or reasoning effort is no longer available.");
    }
  }

  private async dispatchInitial(sessionId: string, taskId: string): Promise<void> {
    if (this.dispatching.has(taskId)) return;
    this.dispatching.add(taskId);
    try {
      const session = this.repository.getSession(sessionId);
      if (!session || session.state !== "running") return;
      const contract = WorkflowLaunchContractSchema.parse(session.contract);
      if (contract.purpose === "known-problem") {
        const root = new DiscoveryRepository(this.options.db).createKnownProblemRoot(
          session.threadId, contract.scope, contract.runConfig.knownProblem,
          RunConfigSchema.parse(contract.runConfig), { sessionId, purpose: "known-problem" },
        );
        this.options.db.immediateTransaction(() => {
          const materialized = materializeResearchSnapshot(this.options.db, {
            threadId: session.threadId, baseRunId: root.runId, sourceProblemIds: [root.problemId], sessionId,
          });
          const snapshot = this.repository.createSnapshot({
            sessionId, materializationRunId: materialized.runId,
            selection: { problemIds: materialized.problemIds }, originMap: materialized.originMap,
          });
          this.repository.updateWorkItem(taskId, "running", { outputRefs: { runId: root.runId } });
          this.repository.updateWorkItem(taskId, "succeeded", { outputRefs: { runId: root.runId, snapshotId: snapshot.id } });
          this.repository.updateSession(sessionId, session.revision, {
            activeSnapshotId: snapshot.id,
            state: contract.mode === "vibe" ? "running" : "waiting-for-review",
            remainingMs: remainingMs(session), runningSince: contract.mode === "vibe" ? new Date().toISOString() : null,
          });
        });
        this.progress(sessionId, [taskId]);
        if (contract.mode === "vibe") this.planGeneration(sessionId);
        return;
      }
      this.options.db.immediateTransaction(() => this.repository.updateWorkItem(taskId, "running"));
      this.progress(sessionId, [taskId]);
      await this.options.engine().startDiscovery(
        session.threadId, contract.scope, RunConfigSchema.parse({
          ...contract.runConfig,
          maxRunMinutes: Math.min(contract.runConfig.maxRunMinutes, contract.limits.maxMinutes),
        }),
        { sessionId, purpose: contract.purpose,
          onRunCreated: (runId) => this.linkDispatchedRun(sessionId, taskId, runId) },
      );
    } finally {
      this.dispatching.delete(taskId);
    }
  }

  private linkDispatchedRun(sessionId: string, taskId: string, runId: string): boolean {
    let shouldBegin = false;
    this.options.db.immediateTransaction(() => {
      const session = this.repository.getSession(sessionId);
      const item = this.repository.getWorkItem(taskId);
      if (!session || !item || session.state === "finished" || item.state !== "running") return;
      this.repository.linkRunToRunningWorkItem(taskId, runId);
      shouldBegin = session.state !== "stop-requested";
    });
    this.progress(sessionId, [taskId]);
    return shouldBegin;
  }

  private failDispatch(sessionId: string, taskId: string, error: unknown): void {
    this.options.onError?.(error);
    const session = this.repository.getSession(sessionId);
    const item = this.repository.getWorkItem(taskId);
    if (!session || !item || session.state === "finished") return;
    const skipped = this.options.db.immediateTransaction(() => {
      const current = this.repository.getWorkItem(taskId);
      if (current?.state === "ready") this.repository.updateWorkItem(taskId, "running");
      if (current?.state === "ready" || current?.state === "running") {
        this.repository.updateWorkItem(taskId, "failed", { error: { message: safeError(error) } });
      }
      this.settleTaskBudget(taskId, "released", 0);
      const skippedIds = this.skipReadyTasks(sessionId, "upstream-failed");
      this.repository.updateSession(sessionId, session.revision, { state: "finished", outcome: "failed", remainingMs: remainingMs(session) });
      return skippedIds;
    });
    this.progress(sessionId, [taskId, ...skipped]);
  }

  private skipReadyTasks(sessionId: string, reason: "upstream-failed" | "session-stopped"): string[] {
    const ready = this.repository.listWorkItems(sessionId).filter((item) => item.state === "ready");
    for (const item of ready) {
      this.repository.updateWorkItem(item.id, "skipped", {
        error: { reason, message: reason === "upstream-failed" ? "Deferred after a failed task." : "Stopped by the user." },
      });
      this.settleTaskBudget(item.id, "released", 0);
    }
    return ready.map((item) => item.id);
  }

  handleRunEvent(event: ResearchEvent): void {
    if (event.type === "run-progress") {
      const session = this.repository.findSessionByRunId(event.runId);
      if (session && session.state !== "finished") {
        void this.options.researchService?.handleRunEvent(event).catch((error) => this.options.onError?.(error));
      }
      return;
    }
    if (event.type !== "run-completed" && event.type !== "run-failed" && event.type !== "run-cancelled") return;
    const session = this.repository.findSessionByRunId(event.runId);
    if (!session || session.state === "finished") return;
    const item = this.repository.listWorkItems(session.id).find((candidate) => runIdFromItem(candidate) === event.runId);
    if (!item || item.state !== "running") return;
    if (item.kind === "research-request") {
      void this.options.researchService?.handleRunEvent(event).catch((error) => this.options.onError?.(error));
      return;
    }
    if (event.type === "run-completed") {
      if (item.kind === "discovery") this.completeDiscovery(session, item, event.runId);
      else if (item.kind === "generate-ideas") this.completeGeneration(session, item, event.runId);
      return;
    }
    const unknown = this.hasUnknownAttempt(event.runId);
    const skipped = this.options.db.immediateTransaction(() => {
      this.repository.updateWorkItem(item.id, unknown ? "unknown" : event.type === "run-cancelled" ? "cancelled" : "failed", {
        outputRefs: { runId: event.runId },
        error: { message: unknown ? "A dispatched provider result has no confirmed terminal record." : event.type === "run-failed" ? event.error : "Stopped by the user." },
      });
      this.settleTaskBudget(item.id, unknown ? "uncertain" : "spent", this.providerAttemptCount(event.runId));
      const skippedIds = this.skipReadyTasks(session.id, event.type === "run-cancelled" ? "session-stopped" : "upstream-failed");
      const outcome = unknown ? "needs-attention" : event.type === "run-cancelled" ? "cancelled" : "partial";
      this.repository.updateSession(session.id, session.revision, { state: "finished", outcome, remainingMs: remainingMs(session) });
      return skippedIds;
    });
    this.progress(session.id, [item.id, ...skipped]);
  }

  private completeDiscovery(session: WorkflowSession, item: WorkflowWorkItem, runId: string): void {
    const contract = WorkflowLaunchContractSchema.parse(session.contract);
    const candidates = this.options.listProblems(session.threadId, runId);
    const selection = contract.mode === "vibe"
      ? selectVibeProblems({ candidates, purpose: "discovery",
        ...(contract.targets.automaticProblemCap ? { maxProblems: contract.targets.automaticProblemCap } : {}) })
      : null;
    const sourceIds = selection ? selection.selectedProblemIds : candidates.map((candidate) => candidate.id);
    const stopped = session.state === "stop-requested";
    this.options.db.immediateTransaction(() => {
      this.repository.updateWorkItem(item.id, "succeeded", {
        outputRefs: { runId, ...(selection ? { selection } : {}) },
      });
      this.settleTaskBudget(item.id, "spent", this.providerAttemptCount(runId));
      if (sourceIds.length === 0) {
        const state = stopped || contract.mode === "vibe"
          ? "finished" : session.state === "pause-requested" ? "paused" : "waiting-for-review";
        this.repository.updateSession(session.id, session.revision, {
          state, ...(state === "finished" ? { outcome: stopped ? "cancelled" as const : "no-qualifying-ideas" as const } : {}),
          remainingMs: remainingMs(session),
        });
      } else {
        const materialized = materializeResearchSnapshot(this.options.db, {
          threadId: session.threadId, baseRunId: runId, sourceProblemIds: sourceIds, sessionId: session.id,
        });
        const snapshot = this.repository.createSnapshot({
          sessionId: session.id, materializationRunId: materialized.runId,
          selection: { problemIds: materialized.problemIds, ...(selection ? { decisions: selection.decisions } : {}) },
          originMap: materialized.originMap,
        });
        const state = stopped ? "finished"
          : session.state === "pause-requested" ? "paused" : contract.mode === "vibe" ? "running" : "waiting-for-review";
        this.repository.updateSession(session.id, session.revision, {
          state, ...(stopped ? { outcome: "cancelled" as const } : {}),
          activeSnapshotId: snapshot.id, remainingMs: remainingMs(session),
          runningSince: state === "running" ? new Date().toISOString() : null,
        });
      }
    });
    this.progress(session.id, [item.id]);
    if (contract.mode === "vibe" && sourceIds.length > 0 && !stopped && session.state !== "pause-requested") this.planGeneration(session.id);
    else if (contract.mode === "babysit" && this.options.researchService && !stopped && session.state !== "pause-requested") {
      void this.options.researchService.dispatchReady(session.id).catch((error) => this.options.onError?.(error));
    }
  }

  private planGeneration(sessionId: string, selection?: { snapshotId: string; problemIds: string[]; model: WorkflowAction & { type: "generate-ideas" } }): void {
    const created = this.options.db.immediateTransaction(() => {
      const current = this.repository.getSession(sessionId);
      if (!current || current.state !== "running") return [];
      const snapshotId = selection?.snapshotId ?? current.activeSnapshotId;
      const snapshot = snapshotId ? this.repository.getSnapshot(snapshotId) : null;
      if (!snapshot || snapshot.sessionId !== sessionId) throw new AppError("INVALID_REFERENCE");
      const problemIds = selection?.problemIds ?? snapshot.selection.problemIds;
      const tasks = this.admitGenerationTasks(current, snapshotId!, problemIds, selection?.model);
      this.repository.updateSession(sessionId, current.revision, { state: "running", runningSince: new Date().toISOString() });
      return tasks;
    });
    this.progress(sessionId, created);
    void this.dispatchNextGeneration(sessionId);
  }

  private admitGenerationTasks(
    session: WorkflowSession, snapshotId: string, problemIds: string[], ideaChoice?: Extract<WorkflowAction, { type: "generate-ideas" }>,
  ): string[] {
    const sessionId = session.id;
    const contract = WorkflowLaunchContractSchema.parse(session.contract);
    const snapshot = this.repository.getSnapshot(snapshotId);
    if (!snapshot || snapshot.sessionId !== sessionId) throw new AppError("INVALID_REFERENCE", "Selected research snapshot is unavailable.");
    const model = ideaChoice?.model ?? contract.ideas?.model;
    const reasoningEffort = ideaChoice?.reasoningEffort ?? contract.ideas?.reasoningEffort;
    const reviewModel = ideaChoice?.reviewModel ?? contract.ideas?.reviewModel ?? model;
    const reviewReasoningEffort = ideaChoice?.reviewReasoningEffort ?? contract.ideas?.reviewReasoningEffort ?? reasoningEffort;
    if (!model || !reasoningEffort) throw new AppError("MODEL_UNAVAILABLE", "Choose an ideas model before generating.");
    const targetKind = ideaChoice?.target.kind ?? contract.targets.kind;
    const requestedPerProblem = ideaChoice?.target.kind === "per-problem" ? ideaChoice.target.count : contract.targets.ideaCount;
    const target = targetKind === "project"
      ? ideaChoice?.target.count ?? contract.targets.distinctBusinessCount ?? contract.targets.ideaCount
      : problemIds.length * requestedPerProblem;
    const existingFamilies = targetKind === "project"
      ? this.projectFamilyProgress(session.id, session.threadId, []).total : 0;
    const remainingTarget = Math.max(0, target - existingFamilies);
    const allocations = targetKind === "project"
      ? remainingTarget === 0 ? { allocations: [], unassignedCount: 0, reason: null }
        : allocateIdeaTargets({ problemIds, target: remainingTarget, maxPerProblem: 20 })
      : { allocations: problemIds.map((problemId) => ({ problemId, quota: requestedPerProblem })), unassignedCount: 0, reason: null };
    const created: string[] = [];
    const available = this.availableBudget(session, "model-call");
    const required = allocations.allocations.reduce((total, item) => total + Math.ceil(item.quota / 5) * 4, 0);
    if (required > available) throw new AppError("BUDGET_TOO_SMALL", `Reserve at least ${required} model calls for generation and independent review.`);
    let ordinal = this.repository.listWorkItems(sessionId).length;
    for (const allocation of allocations.allocations) {
      for (let remaining = allocation.quota, batch = 0; remaining > 0; batch += 1) {
        const quota = Math.min(5, remaining);
        remaining -= quota;
        const item = this.repository.createWorkItem({
          sessionId, kind: "generate-ideas", scopeKey: `ideas:${snapshotId}:${allocation.problemId}:${batch}`,
          ordinal: ordinal++, state: "ready",
          input: { problemId: allocation.problemId, snapshotId, quota, model, reasoningEffort,
            reviewModel, reviewReasoningEffort, fillRound: 0, batch, targetKind, requestedTarget: target },
        });
        this.repository.reserveBudget({ sessionId, workItemId: item.id, operationKey: `ideas:${item.id}`,
          kind: "model-call", reservedUnits: 4 });
        created.push(item.id);
      }
    }
    return created;
  }

  private coverageAttempt(workItemId: string): { id: string; status: string; dispatched_at: string | null } | null {
    return this.options.db.db.prepare(`SELECT id, status, dispatched_at FROM opportunity_exploration_attempts
      WHERE work_item_id = ? ORDER BY prepared_at DESC, id DESC LIMIT 1`)
      .get(workItemId) as { id: string; status: string; dispatched_at: string | null } | undefined ?? null;
  }

  private async dispatchCoverageMap(sessionId: string, item: WorkflowWorkItem): Promise<void> {
    if (this.dispatching.has(item.id)) return;
    const session = this.repository.getSession(sessionId);
    if (!session || session.state !== "running") return;
    const contract = WorkflowLaunchContractSchema.parse(session.contract);
    const input = item.input as { round: 1 | 2; model: WorkflowLaunchContract["runConfig"]["model"];
      reasoningEffort: string };
    const target = contract.targets.distinctBusinessCount ?? contract.targets.ideaCount;
    const explorationConfig = contract.runConfig.opportunityExploration ?? OpportunityExplorationConfigSchema.parse({
      ...DEFAULT_OPPORTUNITY_EXPLORATION_CONFIG,
      targetFamilies: Math.max(2, target), maxRawCandidates: Math.min(60, 2 * Math.max(2, target)),
      maxModelCalls: Math.min(40, contract.limits.maxModelCalls + session.additionalModelCalls),
      maxSearches: Math.min(20, contract.limits.maxSearches + session.additionalSearches),
    });
    this.dispatching.add(item.id);
    const controller = new AbortController();
    this.coverageControllers.set(item.id, controller);
    try {
      this.options.db.immediateTransaction(() => this.repository.updateWorkItem(item.id, "running"));
      this.progress(sessionId, [item.id]);
      const result = await runManagedCoverageMap({
        db: this.options.db, threadId: session.threadId, sessionId, workItemId: item.id, round: input.round,
        explorationConfig,
        ...(this.coverageAttempt(item.id)?.status === "completed" ? {}
          : { modelClient: this.options.engine().scheduledWorkflowModelClient(session.threadId, input.model) }),
        model: input.model, reasoningEffort: ReasoningEffortSchema.parse(input.reasoningEffort), signal: controller.signal,
        onDispatched: (attemptId) => {
          this.options.db.immediateTransaction(() => this.repository.linkCoverageAttemptToRunningWorkItem(item.id, attemptId));
          this.progress(sessionId, [item.id]);
        },
      });
      const current = this.repository.getSession(sessionId);
      if (!current || current.state === "finished") return;
      this.options.db.immediateTransaction(() => {
        this.repository.updateWorkItem(item.id, "succeeded", { outputRefs: {
          attemptId: result.attemptId, gapIds: result.gaps.map((gap) => gap.id),
          noUsefulGapReason: result.noUsefulGapReason,
        } });
        this.settleTaskBudget(item.id, "spent", 1, result.attemptId);
        this.repository.updateSession(sessionId, current.revision, {
          state: current.state === "stop-requested" ? "finished" : current.state === "pause-requested" ? "paused" : "running",
          ...(current.state === "stop-requested" ? { outcome: "cancelled" as const } : {}),
          remainingMs: remainingMs(current),
          runningSince: current.state === "running" ? new Date().toISOString() : null,
        });
      });
      this.progress(sessionId, [item.id]);
      if (current.state === "running") this.finishCollection(sessionId);
    } catch (error) {
      this.options.onError?.(error);
      const current = this.repository.getSession(sessionId);
      const saved = this.repository.getWorkItem(item.id);
      if (!current || current.state === "finished" || saved?.state !== "running") return;
      const attempt = this.coverageAttempt(item.id);
      const unknown = attempt?.status === "dispatched" || attempt?.status === "unknown-dispatch";
      const spent = Boolean(attempt?.dispatched_at);
      this.options.db.immediateTransaction(() => {
        this.repository.updateWorkItem(item.id, current.state === "stop-requested" ? "cancelled" : unknown ? "unknown" : "failed", {
          outputRefs: attempt ? { attemptId: attempt.id } : null,
          error: { message: unknown ? "Coverage mapping may have completed without a saved result. Review it before retrying."
            : safeError(error) },
        });
        this.settleTaskBudget(item.id, unknown ? "uncertain" : spent ? "spent" : "released", spent ? 1 : 0, attempt?.id);
        this.repository.updateSession(sessionId, current.revision, {
          state: "finished", outcome: current.state === "stop-requested" ? "cancelled" : unknown ? "needs-attention" : "partial",
          remainingMs: remainingMs(current),
        });
      });
      this.progress(sessionId, [item.id]);
    } finally {
      this.coverageControllers.delete(item.id);
      this.dispatching.delete(item.id);
    }
  }

  private async dispatchCoverageSearch(sessionId: string, item: WorkflowWorkItem): Promise<void> {
    if (this.dispatching.has(item.id)) return;
    const session = this.repository.getSession(sessionId);
    if (!session || session.state !== "running") return;
    const contract = WorkflowLaunchContractSchema.parse(session.contract);
    const input = item.input as { gapId: string };
    this.dispatching.add(item.id);
    const controller = new AbortController();
    this.coverageControllers.set(item.id, controller);
    try {
      this.options.db.immediateTransaction(() => this.repository.updateWorkItem(item.id, "running"));
      this.progress(sessionId, [item.id]);
      const result = await runManagedCoverageSearch({
        db: this.options.db, threadId: session.threadId, sessionId, workItemId: item.id,
        gapId: input.gapId, searchProvider: contract.runConfig.searchProvider,
        ...(this.coverageAttempt(item.id)?.status === "completed" ? {}
          : { searchClient: this.options.engine().workflowSearchClient(contract.runConfig.searchProvider) }),
        signal: controller.signal,
        onDispatched: (attemptId) => {
          this.options.db.immediateTransaction(() => this.repository.linkCoverageAttemptToRunningWorkItem(item.id, attemptId));
          this.progress(sessionId, [item.id]);
        },
      });
      const current = this.repository.getSession(sessionId);
      if (!current || current.state === "finished") return;
      this.options.db.immediateTransaction(() => {
        this.repository.updateWorkItem(item.id, "succeeded", { outputRefs: {
          attemptId: result.attemptId, sourceIds: result.sources.map((source) => source.id),
          noEvidenceReason: result.noEvidenceReason,
        } });
        this.settleTaskBudget(item.id, "spent", 1, result.attemptId);
        this.repository.updateSession(sessionId, current.revision, {
          state: current.state === "stop-requested" ? "finished" : current.state === "pause-requested" ? "paused" : "running",
          ...(current.state === "stop-requested" ? { outcome: "cancelled" as const } : {}),
          remainingMs: remainingMs(current),
          runningSince: current.state === "running" ? new Date().toISOString() : null,
        });
      });
      this.progress(sessionId, [item.id]);
      if (current.state === "running") this.finishCollection(sessionId);
    } catch (error) {
      this.options.onError?.(error);
      const current = this.repository.getSession(sessionId);
      const saved = this.repository.getWorkItem(item.id);
      if (!current || current.state === "finished" || saved?.state !== "running") return;
      const attempt = this.coverageAttempt(item.id);
      const unknown = attempt?.status === "dispatched" || attempt?.status === "unknown-dispatch";
      const spent = Boolean(attempt?.dispatched_at);
      this.options.db.immediateTransaction(() => {
        this.repository.updateWorkItem(item.id, current.state === "stop-requested" ? "cancelled" : unknown ? "unknown" : "failed", {
          outputRefs: attempt ? { attemptId: attempt.id } : null,
          error: { message: unknown ? "Evidence search may have completed without a saved result. Review it before retrying."
            : safeError(error) },
        });
        this.settleTaskBudget(item.id, unknown ? "uncertain" : spent ? "spent" : "released", spent ? 1 : 0, attempt?.id);
        this.repository.updateSession(sessionId, current.revision, {
          state: "finished", outcome: current.state === "stop-requested" ? "cancelled" : unknown ? "needs-attention" : "partial",
          remainingMs: remainingMs(current),
        });
      });
      this.progress(sessionId, [item.id]);
    } finally {
      this.coverageControllers.delete(item.id);
      this.dispatching.delete(item.id);
    }
  }

  private async dispatchNextGeneration(sessionId: string): Promise<void> {
    const session = this.repository.getSession(sessionId);
    if (!session || session.state !== "running") return;
    const running = this.repository.listWorkItems(sessionId).some((item) => item.kind === "generate-ideas" && item.state === "running");
    if (running) return;
    const progress = this.summary(sessionId);
    if (progress.targetKind === "project" && progress.counts.accepted >= progress.counts.requested) {
      const skipped = this.options.db.immediateTransaction(() => {
        const ready = this.repository.listWorkItems(sessionId).filter((item) =>
          ["generate-ideas", "coverage-map", "coverage-search"].includes(item.kind) && item.state === "ready");
        for (const item of ready) {
          this.repository.updateWorkItem(item.id, "skipped", { error: { message: "The project family target is already met." } });
          this.settleTaskBudget(item.id, "released", 0);
        }
        return ready.map((item) => item.id);
      });
      if (skipped.length) this.progress(sessionId, skipped);
      this.finishCollection(sessionId);
      return;
    }
    if (remainingMs(session) < 5 * 60_000) {
      const skipped = this.options.db.immediateTransaction(() => {
        const ready = this.repository.listWorkItems(sessionId).filter((item) =>
          ["generate-ideas", "coverage-map", "coverage-search"].includes(item.kind) && item.state === "ready");
        for (const item of ready) {
          this.repository.updateWorkItem(item.id, "skipped", { error: { message: "The remaining time is too short for another generation run." } });
          this.settleTaskBudget(item.id, "released", 0);
        }
        return ready.map((item) => item.id);
      });
      if (skipped.length) this.progress(sessionId, skipped);
      this.finishCollection(sessionId);
      return;
    }
    const coverage = this.repository.listWorkItems(sessionId).find((item) =>
      ["coverage-map", "coverage-search"].includes(item.kind) && (item.state === "ready" || item.state === "running"));
    if (coverage) {
      if (coverage.state === "ready") {
        if (coverage.kind === "coverage-map") void this.dispatchCoverageMap(sessionId, coverage);
        else void this.dispatchCoverageSearch(sessionId, coverage);
      }
      return;
    }
    const item = this.repository.listWorkItems(sessionId).find((candidate) => candidate.kind === "generate-ideas" && candidate.state === "ready");
    if (!item) { this.finishCollection(sessionId); return; }
    if (this.dispatching.has(item.id)) return;
    this.dispatching.add(item.id);
    const input = item.input as { problemId: string; snapshotId: string; quota: number; model: WorkflowLaunchContract["runConfig"]["model"]; reasoningEffort: string };
    const contract = WorkflowLaunchContractSchema.parse(session.contract);
    const config = RunConfigSchema.parse({ ...contract.runConfig, model: input.model, reasoningEffort: input.reasoningEffort,
      ideaCount: input.quota, maxRunMinutes: Math.min(contract.runConfig.maxRunMinutes, Math.floor(remainingMs(session) / 60_000)),
      opportunityExploration: contract.targets.kind === "project" ? contract.runConfig.opportunityExploration : undefined });
    try {
      this.options.db.immediateTransaction(() => this.repository.updateWorkItem(item.id, "running"));
      this.progress(sessionId, [item.id]);
      await this.options.engine().startSelectedProblem(session.threadId, input.problemId, config, {
        sessionId, purpose: session.purpose, evidenceSnapshotId: input.snapshotId,
        onRunCreated: (runId) => this.linkDispatchedRun(sessionId, item.id, runId),
      });
    } catch (error) {
      this.failDispatch(sessionId, item.id, error);
    } finally {
      this.dispatching.delete(item.id);
    }
  }

  private completeGeneration(session: WorkflowSession, item: WorkflowWorkItem, runId: string): void {
    const allSolutions = (this.options.db.db.prepare("SELECT id FROM solutions WHERE research_run_id = ? ORDER BY created_at,id")
      .all(runId) as Array<{ id: string }>).map((row) => row.id);
    const review = readSolutionSetReview(this.options.db, runId);
    const reviewed = review?.acceptedSolutionIds.filter((id) => allSolutions.includes(id)) ?? [];
    this.options.db.immediateTransaction(() => {
      if (review && WorkflowLaunchContractSchema.parse(session.contract).runConfig.explorationPurpose === "startup-opportunities") {
        new OpportunityRepository(this.options.db).materializeSolutionSetReviews(session.threadId);
        const angle = (item.input as { generationAngle?: { gapId?: unknown } }).generationAngle;
        if (typeof angle?.gapId === "string" && loadManagedCoverageGaps(this.options.db, session.threadId, session.id)
          .some((gap) => gap.id === angle.gapId)) {
          markManagedCoverageGapCovered(this.options.db, session.threadId, session.id, angle.gapId);
        }
      }
      this.repository.updateWorkItem(item.id, review ? "succeeded" : "failed", {
        outputRefs: { runId, solutionIds: reviewed, proposedSolutionIds: allSolutions },
        ...(review ? {} : { error: { message: "Solution collection review was not saved." } }),
      });
      this.settleTaskBudget(item.id, "spent", this.providerAttemptCount(runId));
      this.repository.updateSession(session.id, session.revision, {
        remainingMs: remainingMs(session), runningSince: new Date().toISOString(),
      });
    });
    this.progress(session.id, [item.id]);
    const current = this.repository.getSession(session.id)!;
    if (current.state === "pause-requested") {
      this.options.db.immediateTransaction(() => this.repository.updateSession(session.id, current.revision, { state: "paused", remainingMs: remainingMs(current) }));
      this.progress(session.id, []);
      return;
    }
    if (current.state === "stop-requested") {
      this.options.db.immediateTransaction(() => this.repository.updateSession(session.id, current.revision, { state: "finished", outcome: "cancelled", remainingMs: remainingMs(current) }));
      this.progress(session.id, []);
      return;
    }
    void this.dispatchNextGeneration(session.id);
  }

  private finishCollection(sessionId: string): void {
    const session = this.repository.getSession(sessionId);
    if (!session || session.state !== "running") return;
    const summary = this.summary(sessionId);
    const items = this.repository.listWorkItems(sessionId);
    if (items.some((item) => item.kind === "research-request" && item.state === "ready") && this.options.researchService) {
      void this.options.researchService.dispatchReady(sessionId).catch((error) => this.options.onError?.(error));
      return;
    }
    const activeCoverage = items.find((item) => ["coverage-map", "coverage-search"].includes(item.kind)
      && (item.state === "ready" || item.state === "running"));
    if (activeCoverage && summary.counts.accepted < summary.counts.requested) {
      if (activeCoverage.state === "ready") void this.dispatchNextGeneration(sessionId);
      return;
    }
    const generationItems = items.filter((item) => item.kind === "generate-ideas");
    let collectionStop: { code: string; reason: string } | null = null;
    if (summary.counts.accepted < summary.counts.requested
      && !generationItems.some((item) => item.state === "failed" || item.state === "unknown")) {
      const completedRounds = [...new Set(generationItems.map(fillRoundFromItem).filter((round) => round > 0))];
      const lastRound = completedRounds.length ? Math.max(...completedRounds) : null;
      const lastRoundItems = lastRound === null ? [] : generationItems.filter((item) => fillRoundFromItem(item) === lastRound);
      const lastRoundInput = lastRoundItems[0]?.input as { acceptedBefore?: number } | undefined;
      const lastGain = lastRound === null ? null : typeof lastRoundInput?.acceptedBefore === "number"
        ? Math.max(0, summary.counts.accepted - lastRoundInput.acceptedBefore)
        : lastRoundItems.reduce((count, item) => count + outputSolutionIds(item).length, 0);
      const snapshot = session.activeSnapshotId ? this.repository.getSnapshot(session.activeSnapshotId) : null;
      const problemIds = snapshot?.selection.problemIds ?? [];
      const contract = WorkflowLaunchContractSchema.parse(session.contract);
      const targetKind = (generationItems.find((item) => fillRoundFromItem(item) === 0)?.input as { targetKind?: "per-problem" | "project" } | undefined)?.targetKind
        ?? contract.targets.kind;
      const byAccepted = (problemId: string) => new Set(generationItems.filter((item) => problemIdFromItem(item) === problemId)
        .flatMap((item) => outputSolutionIds(item))).size;
      const targetFor = (problemId: string) => generationItems.filter((item) => fillRoundFromItem(item) === 0 && problemIdFromItem(item) === problemId)
        .reduce((count, item) => count + requestedFromItem(item), 0);
      const eligibleProblems = problemIds.filter((problemId) =>
        (targetKind === "project" || byAccepted(problemId) < targetFor(problemId))
        && generationItems.filter((item) => problemIdFromItem(item) === problemId)
          .reduce((count, item) => count + requestedFromItem(item), 0) < 2 * targetFor(problemId))
        .sort((a, b) => targetKind === "project"
          ? byAccepted(a) - byAccepted(b)
          : (targetFor(b) - byAccepted(b)) - (targetFor(a) - byAccepted(a)));
      const coverageGaps = targetKind === "project"
        ? loadManagedCoverageGaps(this.options.db, session.threadId, sessionId) : [];
      const usedGapIds = new Set(generationItems.flatMap((item) => {
        const angle = (item.input as { generationAngle?: { gapId?: unknown } }).generationAngle;
        return typeof angle?.gapId === "string" ? [angle.gapId] : [];
      }));
      const readyGaps = coverageGaps.filter((gap) => gap.status === "ready" && !usedGapIds.has(gap.id)
        && (gap.mapExhausted || (gap.dimension !== "buyer" && gap.dimension !== "workflow")));
      const namedGaps = targetKind === "project" ? readyGaps.map((gap) => gap.id) : eligibleProblems;
      const fillInput = {
        acceptedDistinct: summary.counts.accepted, target: summary.counts.requested,
        rawCandidateCap: 2 * summary.counts.requested, rawCandidatesUsed: summary.counts.attempted,
        fillRoundsUsed: completedRounds.length, lastRoundAcceptedGain: lastGain,
        remainingModelCalls: Math.floor(this.availableBudget(session, "model-call") / 2),
        remainingMs: remainingMs(session) - 5 * 60_000,
      };
      const gate = planIdeaFill({ ...fillInput, namedGapIds: namedGaps.length ? namedGaps : ["coverage-pending"] });
      const mapRound = Math.min(2, completedRounds.length + 1) as 1 | 2;
      const mappedThisRound = items.find((item) => item.kind === "coverage-map" &&
        (item.input as { round?: unknown }).round === mapRound);
      if (targetKind === "project" && gate.kind === "generate" && namedGaps.length === 0 && eligibleProblems.length > 0) {
        const evidenceGap = coverageGaps.find((gap) => gap.status === "search-needed" && !usedGapIds.has(gap.id));
        if (evidenceGap) {
          const priorSearch = items.find((item) => item.kind === "coverage-search"
            && (item.input as { gapId?: unknown }).gapId === evidenceGap.id);
          const managedSearchLimit = contract.runConfig.opportunityExploration?.maxSearches ?? contract.limits.maxSearches;
          const managedSearchesUsed = items.filter((item) => item.kind === "coverage-search" && item.state !== "skipped").length;
          if (priorSearch) {
            collectionStop = { code: "evidence-needed", reason: `The bounded search for "${evidenceGap.name}" did not make the gap ready for generation.` };
          } else if (this.availableBudget(session, "search") < 1 || managedSearchesUsed >= managedSearchLimit) {
            collectionStop = { code: "search-budget", reason: `Coverage gap "${evidenceGap.name}" needs evidence: ${evidenceGap.evidenceNeeded?.replace(/[.!?]+$/, "")}. No search remains in this run.` };
          } else {
            const search = this.options.db.immediateTransaction(() => {
              const created = this.repository.createWorkItem({
                sessionId, kind: "coverage-search", scopeKey: `coverage-search:${evidenceGap.id}`,
                ordinal: items.length, state: "ready", input: { gapId: evidenceGap.id },
              });
              this.repository.reserveBudget({ sessionId, workItemId: created.id, operationKey: `coverage-search:${created.id}`,
                kind: "search", reservedUnits: 1 });
              this.repository.updateSession(sessionId, session.revision, { remainingMs: remainingMs(session), runningSince: new Date().toISOString() });
              return created;
            });
            this.progress(sessionId, [search.id]);
            void this.dispatchCoverageSearch(sessionId, search);
            return;
          }
        } else if (mappedThisRound) {
          const output = mappedThisRound.outputRefs as { noUsefulGapReason?: unknown } | null;
          const searchStop = items.find((item) => item.kind === "coverage-search"
            && typeof (item.outputRefs as { noEvidenceReason?: unknown } | null)?.noEvidenceReason === "string");
          const searchOutput = searchStop?.outputRefs as { noEvidenceReason?: string } | null;
          collectionStop = { code: "no-useful-gap", reason: typeof output?.noUsefulGapReason === "string"
            ? output.noUsefulGapReason : searchOutput?.noEvidenceReason
              ?? "The saved inventory has no further concrete buyer or workflow gap for a fill batch." };
        } else if (this.availableBudget(session, "model-call") < 5) {
          collectionStop = { code: "model-budget", reason: "A targeted fill needs one coverage map call and four reserved generation and review calls." };
        } else {
          const first = generationItems.find((item) => fillRoundFromItem(item) === 0);
          const firstInput = first?.input as { model?: WorkflowLaunchContract["runConfig"]["model"]; reasoningEffort?: string } | undefined;
          const map = this.options.db.immediateTransaction(() => {
            const created = this.repository.createWorkItem({
              sessionId, kind: "coverage-map", scopeKey: `coverage-map:${mapRound}`,
              ordinal: items.length, state: "ready", input: { round: mapRound,
                model: firstInput?.model ?? contract.ideas?.model ?? contract.runConfig.model,
                reasoningEffort: firstInput?.reasoningEffort ?? contract.ideas?.reasoningEffort ?? contract.runConfig.reasoningEffort,
              },
            });
            this.repository.reserveBudget({ sessionId, workItemId: created.id, operationKey: `coverage-map:${created.id}`,
              kind: "model-call", reservedUnits: 1 });
            this.repository.updateSession(sessionId, session.revision, { remainingMs: remainingMs(session), runningSince: new Date().toISOString() });
            return created;
          });
          this.progress(sessionId, [map.id]);
          void this.dispatchCoverageMap(sessionId, map);
          return;
        }
      }
      const fill = planIdeaFill({ ...fillInput, namedGapIds: namedGaps });
      if (!collectionStop && fill.kind === "generate" && snapshot && this.availableBudget(session, "model-call") >= 4) {
        const quota = targetKind === "project" ? fill.quota
          : Math.min(fill.quota, targetFor(fill.gapId) - byAccepted(fill.gapId));
        if (quota <= 0) throw new Error("Fill selected a problem without an unmet target.");
        const problemId = targetKind === "project" ? eligibleProblems[0] : fill.gapId;
        const gap = targetKind === "project" ? readyGaps.find((candidate) => candidate.id === fill.gapId) : null;
        if (!problemId || (targetKind === "project" && !gap)) throw new Error("Fill has no selected problem or saved coverage gap.");
        const first = generationItems.find((item) => fillRoundFromItem(item) === 0);
        const firstInput = first?.input as { model?: WorkflowLaunchContract["runConfig"]["model"]; reasoningEffort?: string;
          reviewModel?: WorkflowLaunchContract["runConfig"]["model"]; reviewReasoningEffort?: string } | undefined;
        const item = this.options.db.immediateTransaction(() => {
          const created = this.repository.createWorkItem({
            sessionId, parentItemId: generationItems.at(-1)?.id ?? null, kind: "generate-ideas",
            scopeKey: `fill:${snapshot.id}:${fill.round}:${fill.gapId}`,
            ordinal: items.length, state: "ready",
            input: {
              problemId, snapshotId: snapshot.id, quota, fillRound: fill.round,
              ...(gap ? { generationAngle: { gapId: gap.id, name: gap.name, angle: gap.description },
                generationEvidence: loadManagedCoverageSearchSources(this.options.db, session.threadId, sessionId, gap.id),
                acceptedBefore: summary.counts.accepted } : {}),
              model: firstInput?.model ?? contract.ideas?.model ?? contract.runConfig.model,
              reasoningEffort: firstInput?.reasoningEffort ?? contract.ideas?.reasoningEffort ?? contract.runConfig.reasoningEffort,
              reviewModel: firstInput?.reviewModel ?? contract.ideas?.reviewModel ?? contract.ideas?.model ?? contract.runConfig.model,
              reviewReasoningEffort: firstInput?.reviewReasoningEffort ?? contract.ideas?.reviewReasoningEffort ?? contract.ideas?.reasoningEffort ?? contract.runConfig.reasoningEffort,
            },
          });
          this.repository.reserveBudget({ sessionId, workItemId: created.id, operationKey: `ideas:${created.id}`,
            kind: "model-call", reservedUnits: 4 });
          this.repository.updateSession(sessionId, session.revision, {
            remainingMs: remainingMs(session), runningSince: new Date().toISOString(),
          });
          return created;
        });
        this.progress(sessionId, [item.id]);
        void this.dispatchNextGeneration(sessionId);
        return;
      }
      if (!collectionStop && fill.kind === "terminal") collectionStop = { code: fill.stop, reason: fill.reason };
    }
    const outcome = generationItems.some((item) => item.state === "unknown") ? "needs-attention"
      : summary.counts.accepted >= summary.counts.requested ? "target-met"
      : generationItems.some((item) => item.state === "failed") ? "partial"
      : summary.counts.accepted === 0 ? "no-qualifying-ideas" : "partial";
    this.options.db.immediateTransaction(() => {
      if (collectionStop && generationItems.length > 0) {
        const stop = this.repository.createWorkItem({ sessionId, kind: "collection-stop",
          scopeKey: "collection-stop", ordinal: items.length, state: "ready", input: {} });
        this.repository.updateWorkItem(stop.id, "running");
        this.repository.updateWorkItem(stop.id, "succeeded", { outputRefs: {
          ...collectionStop, shortfall: summary.counts.missing, targetKind: summary.targetKind,
        } });
      }
      this.repository.updateSession(sessionId, session.revision, {
        state: "finished", outcome, remainingMs: remainingMs(session),
      });
    });
    this.progress(sessionId, []);
  }

  private providerAttemptCount(runId: string): number {
    const rows = this.options.db.db.prepare(`SELECT attempt_metadata_json FROM generation_attempts WHERE research_run_id = ?`)
      .all(runId) as Array<{ attempt_metadata_json: string | null }>;
    return rows.reduce((sum, row) => {
      if (!row.attempt_metadata_json) return sum;
      const metadata = JSON.parse(row.attempt_metadata_json) as { attempts?: unknown[] };
      return sum + (metadata.attempts?.length ?? 0);
    }, 0);
  }

  private hasUnknownAttempt(runId: string): boolean {
    const row = this.options.db.db.prepare(`SELECT 1 FROM generation_attempts
      WHERE research_run_id = ? AND (
        status IN ('dispatched','accepted')
        OR (status = 'interrupted' AND terminal_kind IS NOT 'never-dispatched')
      ) LIMIT 1`).get(runId);
    return Boolean(row);
  }

  private settleTaskBudget(taskId: string, state: "spent" | "uncertain" | "released", attempts: number,
    opportunityAttemptId?: string): void {
    const item = this.repository.getWorkItem(taskId);
    if (!item) return;
    const entries = this.repository.listBudgetEntries(item.sessionId)
      .filter((row) => row.workItemId === taskId && row.state === "reserved");
    for (const kind of ["model-call", "search"] as const) {
      const matching = entries.filter((entry) => entry.kind === kind);
      let actual = state === "spent"
        ? kind === "model-call" ? item.kind === "coverage-search" ? 0 : attempts
          : item.kind === "coverage-search" ? attempts : this.searchAttemptCount(runIdFromItem(item))
        : 0;
      for (const entry of matching) {
        const settledUnits = state === "uncertain" ? entry.reservedUnits
          : state === "released" ? 0 : Math.min(entry.reservedUnits, actual);
        this.repository.settleBudget(entry.id, { state, settledUnits,
          ...(opportunityAttemptId ? { opportunityAttemptId } : {}),
        });
        if (state === "spent") actual -= settledUnits;
      }
      if (state === "spent" && actual > 0) {
        const overrun = this.repository.reserveBudget({
          sessionId: item.sessionId, workItemId: taskId,
          operationKey: `observed-overrun:${taskId}:${kind}`,
          kind, reservedUnits: actual,
        });
        this.repository.settleBudget(overrun.id, { state: "spent", settledUnits: actual });
        this.options.onError?.(new Error(`Workflow task ${taskId} used ${actual} unreserved ${kind} unit(s).`));
      }
    }
  }

  private searchAttemptCount(runId: string | null): number {
    if (!runId) return 0;
    const row = this.options.db.db.prepare(`SELECT COUNT(*) AS count FROM cost_ledger
      WHERE research_run_id = ? AND operation = 'search' AND status = 'committed'`).get(runId) as { count: number };
    return row.count;
  }

  private availableBudget(session: WorkflowSession, kind: "model-call" | "search"): number {
    const contract = WorkflowLaunchContractSchema.parse(session.contract);
    const limit = kind === "model-call"
      ? contract.limits.maxModelCalls + session.additionalModelCalls
      : contract.limits.maxSearches + session.additionalSearches;
    const used = this.repository.listBudgetEntries(session.id).filter((entry) => entry.kind === kind)
      .reduce((sum, entry) => sum + (entry.state === "reserved" || entry.state === "uncertain" ? entry.reservedUnits : entry.settledUnits ?? 0), 0);
    return Math.max(0, limit - used);
  }
}

function draftFromContract(contract: WorkflowLaunchContract) {
  const { resolvedInstructions: _resolved, instructionHashes: _hashes, ...draft } = contract;
  void _resolved; void _hashes;
  return draft;
}

function capabilityHash(capabilities: WorkflowCapabilities): string {
  return sha256(canonicalJson({
    nativeConnected: capabilities.nativeConnected, searchReady: capabilities.searchReady,
    models: capabilities.modelOptions.map((model) => ({ id: `${model.providerId}:${model.modelId}`,
      defaultEffort: model.defaultReasoningEffort, efforts: model.reasoningEfforts.map((effort) => effort.id).sort() }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  }));
}

function remainingMs(session: WorkflowSession): number {
  return Math.max(0, session.remainingMs - (session.runningSince ? Date.now() - Date.parse(session.runningSince) : 0));
}

function questionFromItem(item: WorkflowWorkItem): string | undefined {
  const input = item.input as { question?: unknown };
  return typeof input.question === "string" ? input.question : undefined;
}

function errorFromItem(item: WorkflowWorkItem): string | null {
  if (item.error === null) return null;
  const error = item.error as { message?: unknown };
  return typeof error.message === "string" ? error.message : "This task failed.";
}

function outputSolutionIds(item: WorkflowWorkItem): string[] {
  const output = item.outputRefs as { solutionIds?: unknown } | null;
  return Array.isArray(output?.solutionIds) ? output.solutionIds.filter((id): id is string => typeof id === "string") : [];
}

function proposedSolutionIds(item: WorkflowWorkItem): string[] {
  const output = item.outputRefs as { proposedSolutionIds?: unknown } | null;
  return Array.isArray(output?.proposedSolutionIds)
    ? output.proposedSolutionIds.filter((id): id is string => typeof id === "string") : [];
}

function fillRoundFromItem(item: WorkflowWorkItem): number {
  const input = item.input as { fillRound?: unknown };
  return typeof input.fillRound === "number" && Number.isSafeInteger(input.fillRound) ? input.fillRound : 0;
}

function problemIdFromItem(item: WorkflowWorkItem): string | null {
  const input = item.input as { problemId?: unknown };
  return typeof input.problemId === "string" ? input.problemId : null;
}

function isDeferredAfterFailure(item: WorkflowWorkItem): boolean {
  return item.state === "skipped" && (item.error as { reason?: unknown } | null)?.reason === "upstream-failed";
}

interface SavedSolutionSetReview {
  acceptedSolutionIds: string[];
  decisions: Array<{ candidateId: string; status: string; reason: string }>;
  addedDistinctCount: number;
  acceptedDistinctCount: number;
  coverageErrors: string[];
}

function readSolutionSetReview(db: DatabaseClient, runId: string): SavedSolutionSetReview | null {
  const stage = db.db.prepare(`SELECT context_json FROM stage_results
    WHERE research_run_id = ? AND stage_id = 'solution-set-review' ORDER BY completed_at DESC LIMIT 1`)
    .get(runId) as { context_json: string } | undefined;
  if (!stage) return null;
  const context = JSON.parse(stage.context_json) as { solutionSetReview?: SavedSolutionSetReview };
  const review = context.solutionSetReview;
  return review && Array.isArray(review.acceptedSolutionIds) && Array.isArray(review.decisions)
    && Number.isSafeInteger(review.addedDistinctCount) && Number.isSafeInteger(review.acceptedDistinctCount)
    ? review : null;
}

function reviewFromItem(db: DatabaseClient, item: WorkflowWorkItem): SavedSolutionSetReview | null {
  const runId = runIdFromItem(item);
  return runId ? readSolutionSetReview(db, runId) : null;
}

function terminalAttemptId(db: DatabaseClient, item: WorkflowWorkItem): string | null {
  const runId = runIdFromItem(item);
  if (!runId) return null;
  const row = db.db.prepare(`SELECT id FROM generation_attempts WHERE research_run_id = ?
    ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(runId) as { id: string } | undefined;
  return row?.id ?? null;
}

function requestedFromItem(item: WorkflowWorkItem): number {
  const input = item.input as { quota?: unknown };
  return typeof input.quota === "number" && Number.isSafeInteger(input.quota) ? input.quota : 0;
}

function terminalReason(items: WorkflowWorkItem[], session: WorkflowSession): string {
  const failure = items.find((item) => item.state === "failed" || item.state === "unknown");
  if (failure) return errorFromItem(failure) ?? "A provider result could not be confirmed.";
  const collection = items.find((item) => item.kind === "collection-stop");
  const stop = collection?.outputRefs as { shortfall?: unknown; targetKind?: unknown; reason?: unknown } | null;
  if (typeof stop?.reason === "string" && typeof stop.shortfall === "number") {
    const unit = stop.targetKind === "project" ? "business families" : "ideas";
    return `Short by ${stop.shortfall} distinct ${unit}. ${stop.reason}`;
  }
  if (session.outcome === "no-qualifying-ideas") return "No problem had enough saved evidence for unattended generation.";
  if (session.outcome === "cancelled") return "Stopped by the user. Completed work remains saved.";
  if (session.outcome === "partial") return "The saved limit was reached before the requested distinct count.";
  return "The workflow finished.";
}

function runIdFromItem(item: WorkflowWorkItem): string | null {
  const output = item.outputRefs as { runId?: unknown } | null;
  return typeof output?.runId === "string" ? output.runId : null;
}

function safeError(error: unknown): string {
  return error instanceof AppError ? error.message : "The next task could not start. Completed work remains saved.";
}
