import { createHash, randomUUID } from "node:crypto";
import type { DatabaseClient } from "../db/client";
import { CostLedgerRepository, type CostReservation } from "../db/repositories/cost-ledger";
import { DiscoveryRepository } from "../db/repositories/discovery";
import { EvidenceFollowUpRepository } from "../db/repositories/evidence-follow-ups";
import { GenerationAttemptRepository } from "../db/repositories/generation-attempts";
import { FocusedExperimentRepository } from "../db/repositories/focused-experiments";
import { ResearchRunRepository } from "../db/repositories/research-runs";
import { OpportunityRepository, recoverInterruptedOpportunityReviews } from "../db/repositories/opportunities";
import { OpportunityExplorationRepository } from "../db/repositories/opportunity-exploration";
import { WorkflowV2Repository } from "../db/repositories/workflow-v2";
import type { SearchClient, SearchOptions, SearchProvider } from "../providers/search";
import { ProviderFailure, type GenerationMetadata, type StructuredModelClient, type StructuredStageRequest } from "../providers/structured";
import { AppError } from "../shared/errors";
import { assertFocusedDemandTestSemantics } from "../shared/focused-experiment";
import { deriveJsonSchema } from "../shared/json-schema";
import type { ResearchEvent } from "../shared/ipc";
import { opportunityCounts } from "../shared/opportunity-review";
import {
  type OpportunityBudgetExtension,
  type OpportunityBudgetExtensionPreview,
  OpportunityCoverageMapOutputSchema,
  OpportunityExpansionOutputSchema,
  type OpportunityCoverageGap,
  type OpportunityExpansionOutput,
  type OpportunityExplorationConfig,
  type OpportunityExplorationProgress,
} from "../shared/opportunity-exploration";
import { DEFAULT_IDEA_COUNT, RunConfigSchema, SourceSchema, sameModelRef, type ModelRef, type ReasoningEffort, type RunConfig, type Source } from "../shared/schemas";
import { ScopeSchema, WorkflowV2CompatibleDecisionAnalysisOutputSchema, WorkflowV2RiskEvaluationOutputSchema, WorkflowV2RiskReassessmentOutputSchema, type Scope } from "../shared/structured-output-schemas";
import { analyzeSelectedOption, evaluateSelectedOptionRisk, produceDevelopmentOptions, reassessSelectedOption, reassessSelectedOptionRisk, type WorkflowV2EvidenceItem } from "./development";
import { discoverProblems, discoveryRunProjection, harvestEvidenceFollowUp, harvestFactors, type HarvestResult } from "./discovery";
import { runFocusedExperimentFlow } from "./experiment-review";
import { planOpportunityStep, previewOpportunityBudgetExtension } from "./opportunity-planning";
import { reviewSavedOpportunities as runOpportunityReview } from "./opportunity-review";
import { WorkflowExecution } from "./workflow-execution";
import type { WorkflowV2StageId } from "./stages";

export interface ResearchEngineOptions {
  db: DatabaseClient;
  modelClients?: Partial<Record<string, StructuredModelClient>>;
  searchClients?: Partial<Record<SearchProvider, SearchClient>>;
  onEvent: (event: ResearchEvent) => void;
}

interface ActiveRun {
  runId: string;
  threadId: string;
  problemId: string | null;
  config: RunConfig;
  abortController: AbortController;
  startedAt: number;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  projectedCodexCalls: number;
  projectedSearches: number;
  workflow?: WorkflowExecution;
  followUpModelReservation: CostReservation | null;
  followUpSearchReservation: CostReservation | null;
  generationProvenance: Map<string, string>;
  stage?: RuntimeStage;
  modelState?: "waiting" | "dispatched" | "accepted" | null;
}

interface OpportunityTask {
  kind: "review" | "exploration" | "experiment";
  controller: AbortController;
  promise: Promise<void>;
}

class OpportunityBudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpportunityBudgetExceededError";
  }
}

export function recoverInterruptedEvidenceFollowUps(db: DatabaseClient): string[] {
  const followUps = new EvidenceFollowUpRepository(db);
  const ledger = new CostLedgerRepository(db);
  const runIds = followUps.interruptedRunIds();
  for (const runId of runIds) {
    const unusedModelAllowances = db.db.prepare(`
      SELECT id FROM cost_ledger
      WHERE research_run_id = ? AND operation = 'evidence-follow-up'
        AND status = 'reserved' AND generation_attempt_id IS NULL
    `).all(runId) as Array<{ id: string }>;
    for (const allowance of unusedModelAllowances) ledger.release(allowance.id);
    ledger.settleUncertain(runId, "The app restarted during an evidence follow-up provider operation");
  }
  return db.immediateTransaction(() => {
    followUps.failInterruptedReassessments("The app restarted during reassessment. Retry it after reviewing the saved follow-up.");
    return followUps.failInterrupted("The app restarted during this follow-up. It was not replayed.");
  });
}

export class ResearchEngine {
  private readonly activeRuns = new Map<string, ActiveRun>();
  // A cancelled execution can still be unwinding when its replacement starts.
  private readonly executions = new Set<Promise<void>>();
  private readonly executionsByRun = new Map<string, Promise<void>>();
  private readonly runs: ResearchRunRepository;
  private readonly ledger: CostLedgerRepository;
  private readonly generationAttempts: GenerationAttemptRepository;
  private readonly followUps: EvidenceFollowUpRepository;
  private readonly discovery: DiscoveryRepository;
  private readonly opportunityTasks = new Map<string, OpportunityTask>();
  private readonly opportunityErrors = new Map<string, string>();

  constructor(private readonly options: ResearchEngineOptions) {
    this.runs = new ResearchRunRepository(options.db);
    this.ledger = new CostLedgerRepository(options.db);
    this.generationAttempts = new GenerationAttemptRepository(options.db);
    this.followUps = new EvidenceFollowUpRepository(options.db);
    this.discovery = new DiscoveryRepository(options.db);
    recoverInterruptedEvidenceFollowUps(options.db);
    recoverInterruptedOpportunityReviews(options.db);
    options.db.immediateTransaction(() =>
      new OpportunityExplorationRepository(options.db).recoverInterruptedExplorations());
  }

  getActiveRunIds(): ReadonlySet<string> { return new Set(this.activeRuns.keys()); }

  async shutdown(): Promise<void> {
    for (const runId of this.getActiveRunIds()) {
      try { this.cancelRun(runId); } catch { /* the run ended before shutdown reached it */ }
    }
    for (const task of this.opportunityTasks.values()) task.controller.abort(new Error("App is shutting down"));
    await Promise.allSettled([...this.executions.values()]);
    await Promise.allSettled([...this.opportunityTasks.values()].map((task) => task.promise));
  }

  async startDiscovery(threadId: string, scope: Scope, config: RunConfig): Promise<string> {
    config = { ...config, workflowVersion: 2 };
    const parsedScope = ScopeSchema.parse(scope);
    const created = this.runs.create(threadId, config, null);
    if (!created.created) return created.runId;
    this.discovery.persistScope(created.runId, parsedScope);
    this.begin(created.runId, threadId, null, config);
    return created.runId;
  }

  async startKnownProblem(threadId: string, scope: Scope, problemStatement: string, config: RunConfig): Promise<string> {
    config = { ...config, workflowVersion: 2 };
    const parsedScope = ScopeSchema.parse(scope);
    const statement = problemStatement.trim();
    if (!statement) throw new AppError("validation_error", "Problem statement is required.");
    const root = this.discovery.createKnownProblemRoot(threadId, parsedScope, statement, config);
    return this.startProblem(threadId, root.problemId, config);
  }

  async startNextSelected(threadId: string, config: RunConfig): Promise<string | null> {
    const problem = this.options.db.db.prepare(`
      SELECT p.id
      FROM problems p
      WHERE p.selected_at IS NOT NULL
        AND p.discovery_run_id = (
          SELECT id FROM research_runs WHERE thread_id = ? AND problem_id IS NULL AND status = 'completed'
          ORDER BY created_at DESC, rowid DESC LIMIT 1
        )
        AND NOT EXISTS (
          SELECT 1 FROM research_runs rr WHERE rr.problem_id = p.id AND rr.status = 'completed'
        )
      ORDER BY p.created_at, p.id LIMIT 1
    `).get(threadId) as { id: string } | undefined;
    if (!problem) {
      this.updateThread(threadId, "solutions-ready");
      if (config.opportunityExploration && !this.opportunityTasks.has(threadId)) {
        const existing = new OpportunityExplorationRepository(this.options.db).find(threadId);
        if (!existing || !["target-reached", "useful-partial", "budget-exhausted", "paused", "failed"].includes(existing.status)) {
          await this.startOpportunityExploration(threadId, config.model, config.reasoningEffort);
        }
      }
      return null;
    }
    return this.startProblem(threadId, problem.id, config);
  }

  private startProblem(threadId: string, problemId: string, config: RunConfig): string {
    config = { ...config, workflowVersion: 2 };
    const created = this.runs.create(threadId, config, problemId);
    if (created.created) this.begin(created.runId, threadId, problemId, config);
    return created.runId;
  }

  async resumeRun(runId: string): Promise<void> {
    if (this.activeRuns.has(runId)) return;
    const row = this.options.db.db.prepare(`SELECT thread_id, status, config_json, problem_id FROM research_runs WHERE id = ?`)
      .get(runId) as { thread_id: string; status: string; config_json: string; problem_id: string | null } | undefined;
    const config = row ? RunConfigSchema.parse(JSON.parse(row.config_json)) : null;
    if (config && config.workflowVersion !== 2) {
      throw new AppError("conflict", "Legacy generation has been retired. Your saved results are preserved. Start a new run to use the current prompts.");
    }
    if (!row || !config || !["queued", "running", ...(config.workflowVersion === 2 ? ["failed", "cancelled"] : [])].includes(row.status)) {
      throw new AppError("conflict", "This research run has already ended and cannot be resumed.");
    }
    const resumeSafety = this.generationAttempts.getResumeSafety(runId);
    if (!resumeSafety.canResume) {
      this.ledger.settleUncertain(runId, "A dispatched generation lost its terminal result during restart");
      throw new AppError("conflict", `${resumeSafety.resumeBlockedReason} Cancel this run and start a new one to avoid an automatic duplicate charge.`);
    }
    this.assertThreadIdle(row.thread_id, runId);
    this.ledger.settleUncertain(runId, "The app restarted before an operation reached a durable result");
    this.options.db.db.prepare("UPDATE research_runs SET status = 'running', cancelled = 0, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), runId);
    this.options.db.db.prepare("UPDATE research_runs SET interrupted = 0 WHERE id = ?").run(runId);
    let resumedOpportunityInitialization = false;
    if (row.problem_id && config.opportunityExploration) {
      const exploration = new OpportunityExplorationRepository(this.options.db);
      const progress = exploration.find(row.thread_id);
      const resumesInitialOpportunityGeneration = progress
        && (
          (progress.status === "failed" && progress.stopReason?.startsWith("Initial opportunity generation failed:"))
          || (progress.status === "paused" && progress.stopReason?.startsWith("The app restarted while opportunity exploration was active."))
        );
      if (resumesInitialOpportunityGeneration) {
        this.options.db.immediateTransaction(() => exploration.setStatus(row.thread_id, "mapping-coverage", null));
        resumedOpportunityInitialization = true;
      }
    }
    this.begin(runId, row.thread_id, row.problem_id, config, true);
    if (resumedOpportunityInitialization) {
      this.emit({ type: "opportunity-progress", threadId: row.thread_id, status: "mapping-coverage" });
    }
  }

  async selectOption(threadId: string, runId: string, solutionId: string): Promise<void> {
    const row = this.options.db.db.prepare("SELECT thread_id, problem_id, config_json, awaiting_selection FROM research_runs WHERE id = ? AND workflow_version = 2")
      .get(runId) as { thread_id: string; problem_id: string; config_json: string; awaiting_selection: number } | undefined;
    if (!row || row.thread_id !== threadId) throw new AppError("not_found", "Option run does not belong to this project.");
    if (this.activeRuns.has(runId)) return;
    if (!row.awaiting_selection) throw new AppError("conflict", "This run is not awaiting an option selection.");
    this.assertThreadIdle(threadId, runId);
    const workflow = new WorkflowExecution(this.options.db, runId);
    this.options.db.immediateTransaction(() => {
      workflow.repository.selectSolution(runId, solutionId);
      this.options.db.db.prepare("UPDATE research_runs SET status = 'running', awaiting_selection = 0, interrupted = 0 WHERE id = ?").run(runId);
    });
    this.begin(runId, threadId, row.problem_id, RunConfigSchema.parse(JSON.parse(row.config_json)), true);
  }

  getOpportunityExploration(threadId: string): OpportunityExplorationProgress | null {
    return new OpportunityExplorationRepository(this.options.db).find(threadId);
  }

  getOpportunityReviewStatus(threadId: string): {
    running: boolean;
    kind: "review" | "exploration" | "experiment" | null;
    error: string | null;
  } {
    const task = this.opportunityTasks.get(threadId);
    return {
      running: Boolean(task),
      kind: task?.kind ?? null,
      error: this.opportunityErrors.get(threadId) ?? null,
    };
  }

  assertOpportunityEditingAllowed(threadId: string): void {
    if (this.opportunityTasks.has(threadId)) {
      throw new AppError("conflict", "Wait for the current opportunity review or exploration stage before editing families.");
    }
    const activeReview = this.options.db.db.prepare(`
      SELECT 1 FROM opportunity_review_calls
      WHERE thread_id = ? AND status IN ('dispatched', 'accepted') LIMIT 1
    `).get(threadId);
    if (activeReview) throw new AppError("conflict", "An opportunity comparison is still in progress.");
  }

  async reviewSavedOpportunities(threadId: string, model: ModelRef, reasoningEffort: ReasoningEffort, allowAmbiguousRetry = false): Promise<void> {
    this.requireThread(threadId);
    this.launchOpportunityTask(threadId, "review", async (signal) => {
      await runOpportunityReview({
        db: this.options.db,
        threadId,
        allowAmbiguousRetry,
        modelClient: this.requireModelClient(model),
        model,
        reasoningEffort,
        signal,
      });
    });
  }

  async startOpportunityExploration(threadId: string, model: ModelRef, reasoningEffort: ReasoningEffort): Promise<OpportunityExplorationProgress> {
    const config = this.savedOpportunityConfig(threadId);
    const repository = new OpportunityExplorationRepository(this.options.db);
    this.options.db.immediateTransaction(() => repository.create(threadId, config));
    this.syncOpportunityInventory(threadId);
    this.launchOpportunityTask(threadId, "exploration", (signal) =>
      this.executeOpportunityExploration(threadId, model, reasoningEffort, signal));
    return repository.require(threadId);
  }

  async resumeOpportunityExploration(threadId: string, model: ModelRef, reasoningEffort: ReasoningEffort): Promise<OpportunityExplorationProgress> {
    const config = this.savedRunConfig(threadId);
    if (!config.opportunityExploration) throw new AppError("conflict", "This project has no opportunity exploration target.");
    const repository = new OpportunityExplorationRepository(this.options.db);
    const progress = repository.require(threadId);
    const remainingMs = config.maxRunMinutes * 60_000 - (Date.now() - Date.parse(progress.startedAt));
    if (remainingMs <= 0) {
      throw new OpportunityBudgetExceededError(`The ${config.maxRunMinutes}-minute project time budget is exhausted.`);
    }
    if (progress.status !== "paused" && progress.status !== "failed" && progress.status !== "budget-exhausted" && progress.status !== "useful-partial") {
      throw new AppError("conflict", "Opportunity exploration is not paused or stopped.");
    }
    this.options.db.immediateTransaction(() => {
      repository.markInterruptedDispatchesUnknown(threadId);
      repository.setStatus(threadId, "mapping-coverage", null);
    });
    this.launchOpportunityTask(threadId, "exploration", (signal) =>
      this.executeOpportunityExploration(threadId, model, reasoningEffort, signal));
    return repository.require(threadId);
  }

  pauseOpportunityExploration(threadId: string): OpportunityExplorationProgress {
    const repository = new OpportunityExplorationRepository(this.options.db);
    repository.require(threadId);
    this.options.db.immediateTransaction(() => repository.setStatus(
      threadId,
      "paused",
      "Paused by the user. Saved families, reviewed batches, and used budget are retained.",
    ));
    const task = this.opportunityTasks.get(threadId);
    if (task?.kind === "exploration") task.controller.abort(new Error("Paused by user"));
    return repository.require(threadId);
  }

  previewOpportunityBudgetExtension(
    threadId: string,
    extension: OpportunityBudgetExtension,
  ): OpportunityBudgetExtensionPreview {
    return previewOpportunityBudgetExtension(new OpportunityExplorationRepository(this.options.db).require(threadId), extension);
  }

  applyOpportunityBudgetExtension(
    threadId: string,
    preview: OpportunityBudgetExtensionPreview,
  ): OpportunityExplorationProgress {
    this.assertOpportunityEditingAllowed(threadId);
    const repository = new OpportunityExplorationRepository(this.options.db);
    const progress = this.options.db.immediateTransaction(() => repository.applyBudgetExtension(threadId, preview));
    const config = this.savedRunConfig(threadId);
    this.launchOpportunityTask(threadId, "exploration", (signal) =>
      this.executeOpportunityExploration(threadId, config.model, config.reasoningEffort, signal));
    return progress;
  }

  async requestFocusedExperiment(threadId: string, runId: string, solutionId: string): Promise<void> {
    this.assertOpportunityEditingAllowed(threadId);
    const row = this.options.db.db.prepare(`
      SELECT thread_id, problem_id, config_json FROM research_runs
      WHERE id = ? AND workflow_version = 2 AND status = 'completed'
    `).get(runId) as { thread_id: string; problem_id: string; config_json: string } | undefined;
    if (!row || row.thread_id !== threadId) throw new AppError("not_found", "Completed option run not found.");
    const workflow = new WorkflowExecution(this.options.db, runId);
    const option = workflow.selectedOption(row.problem_id);
    if (!option || option.id !== solutionId) throw new AppError("not_found", "Selected option not found in this run.");
    const risk = workflow.repository.findStageResult(runId, "risk-evaluation", solutionId);
    if (!risk) throw new AppError("conflict", "Run the independent risk review before planning a focused experiment.");
    const config = RunConfigSchema.parse(JSON.parse(row.config_json));
    const repository = new FocusedExperimentRepository(this.options.db);
    const shortDemandTest = repository.findDemandTest(runId, solutionId);
    const safety = this.generationAttempts.getResumeSafety(runId);
    if (!safety.canResume) throw new AppError("conflict", safety.resumeBlockedReason ?? "A previous provider request has an unknown result.");
    this.launchOpportunityTask(threadId, "experiment", async (_signal, controller) => {
      this.assertThreadIdle(threadId, runId);
      this.options.db.db.prepare("UPDATE research_runs SET status = 'running', cancelled = 0, updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), runId);
      const active: ActiveRun = {
        runId,
        threadId,
        problemId: row.problem_id,
        config,
        abortController: controller,
        startedAt: Date.now(),
        projectedCodexCalls: this.ledger.countProviderCalls(runId, config.model.providerId) + 4,
        projectedSearches: 0,
        workflow,
        followUpModelReservation: null,
        followUpSearchReservation: null,
        generationProvenance: new Map(),
      };
      this.activeRuns.set(runId, active);
      active.deadlineTimer = setTimeout(() => {
        controller.abort(new Error("Focused experiment planning exceeded the run deadline"));
      }, config.maxRunMinutes * 60_000);
      try {
        await runFocusedExperimentFlow({
          researchRunId: runId,
          context: workflow.developmentContext(row.problem_id),
          selectedOption: option,
          riskEvaluation: WorkflowV2RiskEvaluationOutputSchema.parse(risk.output),
          ...(shortDemandTest ? { shortDemandTest } : {}),
        }, {
          repository,
          modelClient: this.instrumentedModel(active),
          generationModel: config.model,
          reviewModel: config.model,
          generationReasoningEffort: config.reasoningEffort,
          reviewReasoningEffort: config.reasoningEffort,
          signal: controller.signal,
          onStage: () => this.progress(active, "Planning and reviewing one focused experiment", "analyzing-option"),
        });
      } finally {
        if (active.deadlineTimer) clearTimeout(active.deadlineTimer);
        if (this.activeRuns.get(runId) === active) this.activeRuns.delete(runId);
        this.options.db.db.prepare("UPDATE research_runs SET status = 'completed', cancelled = 0, updated_at = ? WHERE id = ?")
          .run(new Date().toISOString(), runId);
        this.updateThread(threadId, "solutions-ready");
      }
    });
  }

  private launchOpportunityTask(
    threadId: string,
    kind: OpportunityTask["kind"],
    worker: (signal: AbortSignal, controller: AbortController) => Promise<void>,
  ): void {
    this.assertOpportunityEditingAllowed(threadId);
    const controller = new AbortController();
    this.opportunityErrors.delete(threadId);
    const promise = Promise.resolve()
      .then(() => worker(controller.signal, controller))
      .then(() => {
        const status = kind === "review"
          ? "reviewing-saved" as const
          : kind === "experiment"
            ? "planning-experiment" as const
            : new OpportunityExplorationRepository(this.options.db).find(threadId)?.status ?? "failed";
        this.emit({ type: "opportunity-progress", threadId, status });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Opportunity work failed.";
        const exploration = new OpportunityExplorationRepository(this.options.db).find(threadId);
        if (controller.signal.aborted && exploration?.status === "paused") {
          this.emit({ type: "opportunity-progress", threadId, status: "paused" });
          return;
        }
        this.opportunityErrors.set(threadId, message);
        if (kind === "exploration" && exploration) {
          const status = error instanceof OpportunityBudgetExceededError ? "budget-exhausted" : "failed";
          this.options.db.immediateTransaction(() =>
            new OpportunityExplorationRepository(this.options.db).setStatus(threadId, status, message));
        }
        const finalStatus = new OpportunityExplorationRepository(this.options.db).find(threadId)?.status;
        this.emit({
          type: "opportunity-progress",
          threadId,
          status: finalStatus ?? (kind === "experiment" ? "planning-experiment" : "reviewing-saved"),
          error: message,
        });
      })
      .finally(() => {
        if (this.opportunityTasks.get(threadId)?.controller === controller) this.opportunityTasks.delete(threadId);
      });
    const task: OpportunityTask = { kind, controller, promise };
    this.opportunityTasks.set(threadId, task);
    this.emit({
      type: "opportunity-progress",
      threadId,
      status: kind === "review" ? "reviewing-saved" : kind === "experiment" ? "planning-experiment" : "mapping-coverage",
    });
  }

  private async executeOpportunityExploration(
    threadId: string,
    model: ModelRef,
    reasoningEffort: ReasoningEffort,
    signal: AbortSignal,
  ): Promise<void> {
    const repository = new OpportunityExplorationRepository(this.options.db);
    try {
      await runOpportunityReview({
        db: this.options.db,
        threadId,
        modelClient: this.budgetedOpportunityModel(threadId, model, signal),
        model,
        reasoningEffort,
        signal,
      });
      signal.throwIfAborted();
    } finally {
      this.syncOpportunityInventory(threadId);
    }
    const searchedSources = new Map<string, Source[]>();
    while (true) {
      signal.throwIfAborted();
      const progress = repository.require(threadId);
      const runConfig = this.savedRunConfig(threadId);
      const recoverableBatch = progress.batches.find((batch) => ["planned", "generating"].includes(batch.status));
      if (recoverableBatch) {
        const gap = progress.gaps.find((item) => item.id === recoverableBatch.coverageGapId);
        if (!gap) throw new Error(`Opportunity batch ${recoverableBatch.ordinal} has no saved coverage gap.`);
        this.options.db.immediateTransaction(() => {
          repository.updateBatch({ threadId, batchId: recoverableBatch.id, status: "generating" });
          repository.setStatus(threadId, "generating-batch", null);
          repository.setActiveGap(threadId, gap.id);
        });
        try {
          const sources = searchedSources.get(gap.id) ?? this.savedGapSearchSources(threadId, gap.id);
          const expansion = await this.generateOpportunityBatch(
            threadId, recoverableBatch.id, gap, recoverableBatch.requestedCandidates,
            sources, model, reasoningEffort, signal,
          );
          this.persistOpportunityExpansion(threadId, recoverableBatch.id, gap, expansion, sources, runConfig);
        } catch (error) {
          const attempt = this.options.db.db.prepare(`
            SELECT status FROM opportunity_exploration_attempts
            WHERE thread_id = ? AND stage_key = ?
          `).get(threadId, `gap-generation:${recoverableBatch.id}`) as { status: string } | undefined;
          this.options.db.immediateTransaction(() => repository.updateBatch({
            threadId,
            batchId: recoverableBatch.id,
            status: attempt?.status === "completed" || attempt?.status === "prepared" ? "generating" : "unknown-dispatch",
          }));
          throw error;
        }
        continue;
      }
      const decision = planOpportunityStep({
        progress,
        maxRunMinutes: runConfig.maxRunMinutes,
        elapsedMinutes: (Date.now() - Date.parse(progress.startedAt)) / 60_000,
      });
      if (decision.kind === "terminal") {
        this.options.db.immediateTransaction(() => repository.setStatus(threadId, decision.status, decision.reason));
        return;
      }
      if (decision.kind === "map-coverage") {
        const mapped = await this.mapOpportunityCoverage(threadId, model, reasoningEffort, signal);
        if (mapped === 0) return;
        continue;
      }
      if (decision.kind === "search-gap") {
        const sources = await this.searchOpportunityGap(threadId, decision.gap, signal);
        searchedSources.set(decision.gap.id, sources);
        const now = new Date().toISOString();
        this.options.db.immediateTransaction(() => repository.saveGap(threadId, {
          ...decision.gap,
          status: sources.length > 0 ? "ready" : "exhausted",
          updatedAt: now,
        }));
        continue;
      }
      if (decision.kind === "generate-batch") {
        const batch = this.options.db.immediateTransaction(() => repository.planBatch({
          threadId,
          coverageGapId: decision.gap.id,
          requestedCandidates: decision.candidateCount,
          acceptedFamiliesBefore: progress.counts.acceptedFamilies,
        }));
        this.options.db.immediateTransaction(() => {
          repository.updateBatch({ threadId, batchId: batch.id, status: "generating" });
          repository.setStatus(threadId, "generating-batch", null);
          repository.setActiveGap(threadId, decision.gap.id);
        });
        try {
          const sources = searchedSources.get(decision.gap.id) ?? this.savedGapSearchSources(threadId, decision.gap.id);
          const expansion = await this.generateOpportunityBatch(
            threadId, batch.id, decision.gap, decision.candidateCount, sources, model, reasoningEffort, signal,
          );
          this.persistOpportunityExpansion(threadId, batch.id, decision.gap, expansion, sources, runConfig);
        } catch (error) {
          const attempt = this.options.db.db.prepare(`
            SELECT status FROM opportunity_exploration_attempts
            WHERE thread_id = ? AND stage_key = ?
          `).get(threadId, `gap-generation:${batch.id}`) as { status: string } | undefined;
          this.options.db.immediateTransaction(() => repository.updateBatch({
            threadId,
            batchId: batch.id,
            status: attempt?.status === "completed" || attempt?.status === "prepared" ? "generating" : "unknown-dispatch",
          }));
          throw error;
        }
        continue;
      }
      if (decision.kind === "review-batch") {
        const batch = repository.require(threadId).batches.find((item) => item.id === decision.batchId);
        if (!batch) throw new Error("Opportunity review batch is missing.");
        this.options.db.immediateTransaction(() => repository.updateBatch({
          threadId,
          batchId: batch.id,
          status: "reviewing",
        }));
        try {
          await runOpportunityReview({
            db: this.options.db,
            threadId,
            modelClient: this.budgetedOpportunityModel(threadId, model, signal),
            model,
            reasoningEffort,
            signal,
          });
        } finally {
          this.syncOpportunityInventory(threadId);
        }
        const reviewed = repository.require(threadId);
        const gap = reviewed.gaps.find((item) => item.id === batch.coverageGapId);
        this.options.db.immediateTransaction(() => {
          repository.updateBatch({
            threadId,
            batchId: batch.id,
            status: "reviewed",
            acceptedFamiliesAfter: reviewed.counts.acceptedFamilies,
          });
          if (gap) repository.saveGap(threadId, { ...gap, status: "covered", updatedAt: new Date().toISOString() });
          repository.setActiveGap(threadId, null);
          repository.setStatus(threadId, "mapping-coverage", null);
        });
        continue;
      }
      throw new Error(decision.reason);
    }
  }

  private async mapOpportunityCoverage(
    threadId: string,
    model: ModelRef,
    reasoningEffort: ReasoningEffort,
    signal: AbortSignal,
  ): Promise<number> {
    const repository = new OpportunityExplorationRepository(this.options.db);
    const progress = repository.require(threadId);
    if (progress.usage.expansionRounds >= progress.config.maxExpansionRounds) {
      throw new OpportunityBudgetExceededError(`The expansion limit of ${progress.config.maxExpansionRounds} rounds is exhausted.`);
    }
    const round = progress.usage.expansionRounds + 1;
    const stageKey = `coverage-map:${round}`;
    const saved = repository.completedAttemptResult(threadId, stageKey);
    const output = saved
      ? OpportunityCoverageMapOutputSchema.parse(saved)
      : await this.runOpportunityCoverageCall(threadId, stageKey, round, model, reasoningEffort, signal);
    if (output.gaps.length === 0) {
      this.options.db.immediateTransaction(() => repository.setStatus(
        threadId,
        "useful-partial",
        output.noUsefulGapReason ?? `${progress.counts.acceptedFamilies} accepted families were saved, and no bounded coverage gap remained.`,
      ));
      return 0;
    }
    const now = new Date().toISOString();
    this.options.db.immediateTransaction(() => {
      for (const gap of output.gaps) {
        if (gap.candidateOrigin === "exploratory-allowed" && !progress.config.allowExploratoryProblems) {
          throw new Error(`Coverage mapper requested exploratory hypotheses for "${gap.name}" without project permission.`);
        }
        repository.saveGap(threadId, {
          id: randomUUID(),
          ...gap,
          status: gap.evidenceNeeded || gap.searchQuery ? "search-needed" : "ready",
          createdAt: now,
          updatedAt: now,
        });
      }
      repository.addUsage(threadId, { expansionRounds: 1 });
    });
    return output.gaps.length;
  }

  private async runOpportunityCoverageCall(
    threadId: string,
    stageKey: string,
    round: number,
    model: ModelRef,
    reasoningEffort: ReasoningEffort,
    signal: AbortSignal,
  ) {
    const repository = new OpportunityExplorationRepository(this.options.db);
    const view = new OpportunityRepository(this.options.db).familyView(threadId);
    const context = this.opportunityMapContext(threadId);
    const instruction = "Name only concrete buyer, workflow, trigger, problem, or evidence gaps in the saved startup inventory. New buyers or workflows are allowed only after the supplied map is exhausted. Ask for one bounded search query when evidence is required. Return no gap rather than generic 'more ideas'. Exploratory hypotheses are allowed only when the project flag says so.";
    const attempt = this.options.db.immediateTransaction(() => repository.prepareAttempt(threadId, {
      stageKey,
      stageName: "coverage-map",
      input: { round, view, context, config: repository.require(threadId).config },
      model: { ...model, reasoningEffort },
      promptVersion: "opportunity-coverage-v1",
      promptText: instruction,
    }));
    if (attempt.kind === "unknown-dispatch") throw new Error("Coverage mapping may have completed before its result was saved. It will not be replayed automatically.");
    if (attempt.kind === "completed") return OpportunityCoverageMapOutputSchema.parse(attempt.result);
    if (attempt.kind !== "prepared") throw new Error("Coverage mapping attempt was not prepared.");
    try {
      const result = await this.budgetedOpportunityModel(threadId, model, signal).structuredCompletion({
        generationId: randomUUID(),
        stage: stageKey,
        model,
        reasoningEffort,
        workOrder: {
          stage: stageKey,
          instruction,
          goal: "Name the next bounded opportunity coverage gaps, or state why no useful gap remains.",
          inputs: { round, allowExploratoryProblems: repository.require(threadId).config.allowExploratoryProblems },
          definitionOfDone: ["Each gap is specific enough to guide one batch.", "Every evidence request has one bounded search query."],
          constraints: ["Do not invent evidence or request generic ideation."],
        },
        evidence: [{ sourceId: "scraply:opportunity-inventory", content: { view, context } }],
        schema: OpportunityCoverageMapOutputSchema,
        jsonSchema: deriveJsonSchema(OpportunityCoverageMapOutputSchema),
        repairPolicy: "disabled",
        deadlineMs: 120_000,
        signal,
        onDispatched: () => this.options.db.immediateTransaction(() => repository.markAttemptDispatched(threadId, attempt.attemptId, "none")),
      });
      this.options.db.immediateTransaction(() => repository.completeAttempt(threadId, attempt.attemptId, result.output));
      return OpportunityCoverageMapOutputSchema.parse(result.output);
    } catch (error) {
      this.options.db.immediateTransaction(() => repository.failAttempt(threadId, attempt.attemptId, errorMessage(error), false));
      throw error;
    }
  }

  private async searchOpportunityGap(
    threadId: string,
    gap: OpportunityCoverageGap,
    signal: AbortSignal,
  ): Promise<Source[]> {
    if (!gap.searchQuery || !gap.evidenceNeeded) throw new Error(`Coverage gap "${gap.name}" has no bounded evidence request.`);
    const repository = new OpportunityExplorationRepository(this.options.db);
    const stageKey = `gap-search:${gap.id}`;
    const saved = repository.completedAttemptResult(threadId, stageKey);
    if (saved) return this.usableOpportunitySearchSources(threadId, SourceSchema.array().parse(saved));
    const config = this.savedRunConfig(threadId);
    const search = this.options.searchClients?.[config.searchProvider];
    if (!search) throw new Error(`Search provider ${config.searchProvider} is unavailable.`);
    const attempt = this.options.db.immediateTransaction(() => repository.prepareAttempt(threadId, {
      stageKey,
      stageName: "gap-search",
      input: { gapId: gap.id, evidenceNeeded: gap.evidenceNeeded, query: gap.searchQuery, numResults: 5 },
      model: { providerId: config.searchProvider, modelId: "search", reasoningEffort: "bounded" },
      promptVersion: "opportunity-gap-search-v1",
      promptText: gap.searchQuery!,
    }));
    if (attempt.kind === "unknown-dispatch") throw new Error(`Search for "${gap.name}" may have completed before its result was saved. It will not be replayed automatically.`);
    if (attempt.kind === "completed") return SourceSchema.array().parse(attempt.result);
    if (attempt.kind !== "prepared") throw new Error("Gap search attempt was not prepared.");
    const progress = repository.require(threadId);
    const remainingMs = config.maxRunMinutes * 60_000 - (Date.now() - Date.parse(progress.startedAt));
    if (remainingMs <= 0) {
      throw new OpportunityBudgetExceededError(`The ${config.maxRunMinutes}-minute project time budget is exhausted.`);
    }
    if (progress.usage.searches >= progress.config.maxSearches) {
      throw new OpportunityBudgetExceededError(`The search limit of ${progress.config.maxSearches} is exhausted.`);
    }
    try {
      this.options.db.immediateTransaction(() => repository.markAttemptDispatched(threadId, attempt.attemptId, "search"));
      const result = SourceSchema.array().parse(await search.search(gap.searchQuery, {
        numResults: 5,
        maxCharacters: 4_000,
        signal,
        timeoutMs: Math.min(45_000, Math.max(1_000, Math.floor(remainingMs))),
      }));
      this.options.db.immediateTransaction(() => repository.completeAttempt(threadId, attempt.attemptId, result));
      return this.usableOpportunitySearchSources(threadId, result);
    } catch (error) {
      this.options.db.immediateTransaction(() => repository.failAttempt(threadId, attempt.attemptId, errorMessage(error), false));
      throw error;
    }
  }

  private savedGapSearchSources(threadId: string, gapId: string): Source[] {
    const saved = new OpportunityExplorationRepository(this.options.db).completedAttemptResult(threadId, `gap-search:${gapId}`);
    return saved ? this.usableOpportunitySearchSources(threadId, SourceSchema.array().parse(saved)) : [];
  }

  private usableOpportunitySearchSources(threadId: string, sources: Source[]): Source[] {
    const root = this.options.db.db.prepare(`
      SELECT id FROM research_runs
      WHERE thread_id = ? AND problem_id IS NULL AND status = 'completed'
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(threadId) as { id: string } | undefined;
    if (!root) return [];
    return sources.filter((source) => {
      const existing = this.options.db.db.prepare("SELECT research_run_id FROM sources WHERE id = ?")
        .get(source.id) as { research_run_id: string } | undefined;
      return !existing || existing.research_run_id === root.id;
    });
  }

  private async generateOpportunityBatch(
    threadId: string,
    batchId: string,
    gap: OpportunityCoverageGap,
    candidateCount: number,
    searchedSources: Source[],
    model: ModelRef,
    reasoningEffort: ReasoningEffort,
    signal: AbortSignal,
  ): Promise<PersistableOpportunityExpansion> {
    const repository = new OpportunityExplorationRepository(this.options.db);
    const stageKey = `gap-generation:${batchId}`;
    const saved = repository.completedAttemptResult(threadId, stageKey);
    if (saved) return parseSavedExpansion(saved);
    const evidence = this.opportunityExpansionEvidence(threadId, searchedSources);
    const view = new OpportunityRepository(this.options.db).familyView(threadId);
    const instruction = "Generate one small batch for the named coverage gap. Every option must be a distinct startup opportunity with a paying customer, smallest sellable workflow, and one structured focusedDemandTest for the most decision-relevant demand assumption. Do not repeat accepted families. Preserve weak evidence as uncertainty. Reference only supplied evidence IDs. An evidence-backed new problem must name nonempty problemHypothesis.evidenceIds that directly support the problem. When exploratory mode is used, every evidence-ID list must be empty and the gap assessment must remain a hypothesis.";
    const attempt = this.options.db.immediateTransaction(() => repository.prepareAttempt(threadId, {
      stageKey,
      stageName: "gap-generation",
      input: { batchId, gap, candidateCount, acceptedFamilies: view.families, evidenceIds: evidence.map((item) => item.sourceId) },
      model: { ...model, reasoningEffort },
      promptVersion: "opportunity-expansion-v1",
      promptText: instruction,
    }));
    if (attempt.kind === "unknown-dispatch") throw new Error(`Batch for "${gap.name}" may have completed before its result was saved. It will not be replayed automatically.`);
    if (attempt.kind === "completed") return parseSavedExpansion(attempt.result);
    if (attempt.kind !== "prepared") throw new Error("Opportunity generation attempt was not prepared.");
    try {
      const result = await this.budgetedOpportunityModel(threadId, model, signal).structuredCompletion({
        generationId: randomUUID(),
        stage: stageKey,
        model,
        reasoningEffort,
        workOrder: {
          stage: stageKey,
          instruction,
          goal: `Generate up to ${candidateCount} startup candidates for the named gap "${gap.name}".`,
          inputs: { gap, candidateCount, allowedEvidenceIds: evidence.map((item) => item.sourceId) },
          definitionOfDone: ["Return fewer candidates rather than padding.", "Keep problem evidence and exploratory origin explicit.", "Give every option a stable short demand test with an explicit selection reason and decision impact."],
          constraints: ["Do not invent evidence or repeat an accepted family."],
        },
        evidence: [
          { sourceId: "scraply:accepted-opportunity-families", content: view.families },
          ...evidence,
        ],
        schema: OpportunityExpansionOutputSchema,
        jsonSchema: deriveJsonSchema(OpportunityExpansionOutputSchema),
        repairPolicy: "disabled",
        deadlineMs: 180_000,
        signal,
        onDispatched: () => this.options.db.immediateTransaction(() => repository.markAttemptDispatched(threadId, attempt.attemptId, "none")),
      });
      const parsed = OpportunityExpansionOutputSchema.parse(result.output);
      for (const option of parsed.options) assertFocusedDemandTestSemantics(option.focusedDemandTest);
      if (parsed.options.length > candidateCount) throw new Error("Opportunity expansion returned more candidates than requested.");
      const problemSupported = validateExpansionEvidence(parsed, evidence.map((item) => item.sourceId), gap);
      const acceptedOutput = problemSupported ? parsed : { ...parsed, options: [] };
      const candidateIds = acceptedOutput.options.map(() => randomUUID());
      const savedResult = problemSupported
        ? { output: acceptedOutput, candidateIds }
        : {
            output: acceptedOutput,
            candidateIds,
            rejectedOutput: parsed,
            rejectionReason: "The evidence-only expansion did not cite supplied evidence for its new problem hypothesis.",
          };
      this.options.db.immediateTransaction(() => repository.completeAttempt(threadId, attempt.attemptId, savedResult));
      return withExpansionIds(acceptedOutput, candidateIds);
    } catch (error) {
      this.options.db.immediateTransaction(() => repository.failAttempt(threadId, attempt.attemptId, errorMessage(error), false));
      throw error;
    }
  }

  private persistOpportunityExpansion(
    threadId: string,
    batchId: string,
    gap: OpportunityCoverageGap,
    expansion: PersistableOpportunityExpansion,
    searchedSources: Source[],
    baseConfig: RunConfig,
  ): void {
    const candidateIds = expansion.options.map((option) => option.id);
    const existingCandidates = candidateIds.length === 0
      ? 0
      : (this.options.db.db.prepare(`
          SELECT COUNT(*) AS count FROM solutions
          WHERE id IN (${candidateIds.map(() => "?").join(",")})
        `).get(...candidateIds) as { count: number }).count;
    if (existingCandidates !== 0 && existingCandidates !== candidateIds.length) {
      throw new Error("Opportunity batch persistence is incomplete and cannot be replayed safely.");
    }
    if (candidateIds.length === 0 || existingCandidates === candidateIds.length) {
      this.options.db.immediateTransaction(() => {
        const repository = new OpportunityExplorationRepository(this.options.db);
        repository.updateBatch({ threadId, batchId, status: "awaiting-review", savedCandidateIds: candidateIds });
        repository.setStatus(threadId, "reviewing-batch", null);
      });
      return;
    }
    const root = this.options.db.db.prepare(`
      SELECT id FROM research_runs
      WHERE thread_id = ? AND problem_id IS NULL AND status = 'completed'
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(threadId) as { id: string } | undefined;
    if (!root) throw new Error("Opportunity expansion needs a completed project problem map.");
    const problemId = randomUUID();
    const runId = randomUUID();
    const now = new Date().toISOString();
    const repository = new OpportunityExplorationRepository(this.options.db);
    this.options.db.immediateTransaction(() => {
      const linkedSourceIds: string[] = [];
      for (const source of searchedSources) {
        const existing = this.options.db.db.prepare(`
          SELECT src.research_run_id FROM sources src
          JOIN research_runs rr ON rr.id = src.research_run_id
          WHERE src.id = ? AND rr.thread_id = ?
        `).get(source.id, threadId) as { research_run_id: string } | undefined;
        if (!existing) {
          this.options.db.db.prepare(`
            INSERT INTO sources (
              id, research_run_id, provider_source_id, canonical_url, title, retrieved_text,
              author, published_at, content_hash, retrieved_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            source.id, root.id, source.id, source.url, source.title, source.text,
            source.author ?? null, source.publishedDate ?? null,
            createHash("sha256").update(source.text).digest("hex"), now,
          );
          linkedSourceIds.push(source.id);
        } else if (existing.research_run_id === root.id) {
          linkedSourceIds.push(source.id);
        }
      }
      for (const sourceId of expansion.problemHypothesis.evidenceIds) {
        const source = this.options.db.db.prepare(`
          SELECT src.id, src.research_run_id FROM sources src
          JOIN research_runs rr ON rr.id = src.research_run_id
          WHERE src.id = ? AND rr.thread_id = ?
        `).get(sourceId, threadId) as { id: string; research_run_id: string } | undefined;
        if (source?.research_run_id === root.id && !linkedSourceIds.includes(source.id)) linkedSourceIds.push(source.id);
      }
      this.options.db.db.prepare(`
        INSERT INTO problems (
          id, discovery_run_id, statement, why_it_persists, affected, scale_estimate,
          scale_basis_factor_id, verdict, verdict_reason, verdict_source_ids_json,
          intended_buyer_evidence_factor_ids_json, evidence_gap, selected_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'insufficient-evidence', ?, '[]', '[]', ?, ?, ?)
      `).run(
        problemId, root.id, expansion.problemHypothesis.statement, expansion.problemHypothesis.whyItPersists,
        expansion.problemHypothesis.affected, expansion.problemHypothesis.scaleEstimate,
        gap.candidateOrigin === "exploratory-allowed"
          ? "Exploratory hypothesis generated under the project's explicit exploratory mode."
          : "Expansion evidence has not established customer demand.",
        expansion.problemHypothesis.evidenceGap ?? gap.evidenceNeeded, now, now,
      );
      const insertVerdictSource = this.options.db.db.prepare(`
        INSERT INTO problem_verdict_sources (problem_id, source_id, research_run_id, position)
        VALUES (?, ?, ?, ?)
      `);
      linkedSourceIds.forEach((sourceId, index) => insertVerdictSource.run(problemId, sourceId, root.id, index));
      const runConfig = RunConfigSchema.parse({ ...baseConfig, workflowVersion: 2, ideaCount: expansion.options.length });
      this.options.db.db.prepare(`
        INSERT INTO research_runs (
          id, thread_id, status, config_json, cancelled, completion_reason, problem_id,
          budget_limit, created_at, updated_at, workflow_version, awaiting_selection
        ) VALUES (?, ?, 'completed', ?, 0, ?, ?, 1000, ?, ?, 2, 1)
      `).run(runId, threadId, JSON.stringify(runConfig), `Opportunity expansion for ${gap.name}`, problemId, now, now);
      new WorkflowV2Repository(this.options.db).saveSolutionOptions(runId, problemId, expansion.options.map((option) => {
        const { focusedDemandTest, ...savedOption } = option;
        void focusedDemandTest;
        return savedOption;
      }));
      new FocusedExperimentRepository(this.options.db).saveDemandTests(runId, expansion.options.map((option) => ({
        solutionId: option.id,
        test: option.focusedDemandTest,
      })));
      for (const option of expansion.options) {
        const evidenceIds = [...new Set([
          ...expansion.problemHypothesis.evidenceIds,
          ...option.supportingEvidenceIds,
          ...option.contraryEvidenceIds,
        ])];
        repository.saveCandidateOrigin({
          threadId,
          candidateId: option.id,
          batchId,
          origin: gap.candidateOrigin === "exploratory-allowed"
            ? {
                kind: "exploratory-hypothesis",
                coverageGapId: gap.id,
                evidenceIds: [],
                disclosure: "Generated under the project's explicit exploratory mode without supporting evidence.",
              }
            : { kind: "problem-evidence", problemId, evidenceIds, evidenceGap: expansion.problemHypothesis.evidenceGap ?? gap.evidenceNeeded },
        });
      }
      repository.addUsage(threadId, { rawCandidates: expansion.options.length });
      repository.updateBatch({ threadId, batchId, status: "awaiting-review", savedCandidateIds: candidateIds });
      repository.setStatus(threadId, "reviewing-batch", null);
    });
  }

  private opportunityMapContext(threadId: string): unknown {
    const problems = this.options.db.db.prepare(`
      SELECT p.id, p.statement, p.affected, p.verdict, p.verdict_reason, p.evidence_gap
      FROM problems p JOIN research_runs rr ON rr.id = p.discovery_run_id
      WHERE rr.thread_id = ? ORDER BY p.created_at, p.id LIMIT 60
    `).all(threadId);
    const scope = this.options.db.db.prepare(`
      SELECT s.title, s.audience, s.domain, s.observations, s.off_limits_json
      FROM scopes s JOIN research_runs rr ON rr.id = s.research_run_id
      WHERE rr.thread_id = ? ORDER BY rr.created_at DESC LIMIT 1
    `).get(threadId);
    return { scope, problems };
  }

  private opportunityExpansionEvidence(threadId: string, searchedSources: Source[]): Array<{ sourceId: string; content: unknown }> {
    const savedRows = this.options.db.db.prepare(`
      SELECT DISTINCT src.id, src.title, src.canonical_url, src.retrieved_text
      FROM sources src
      JOIN research_runs rr ON rr.id = src.research_run_id
      WHERE rr.id = (
        SELECT id FROM research_runs
        WHERE thread_id = ? AND problem_id IS NULL AND status = 'completed'
        ORDER BY created_at DESC, rowid DESC LIMIT 1
      ) ORDER BY src.retrieved_at DESC LIMIT 20
    `).all(threadId) as Array<{ id: string; title: string; canonical_url: string; retrieved_text: string }>;
    const saved = savedRows.map((row) => ({
      sourceId: row.id,
      content: { title: row.title, url: row.canonical_url, text: row.retrieved_text.slice(0, 2_000) },
    }));
    const searched = searchedSources.map((source) => ({
      sourceId: source.id,
      content: { title: source.title, url: source.url, text: source.text.slice(0, 2_000) },
    }));
    return [...new Map([...searched, ...saved].map((item) => [item.sourceId, item])).values()];
  }

  private syncOpportunityInventory(threadId: string): void {
    const repository = new OpportunityExplorationRepository(this.options.db);
    const families = new OpportunityRepository(this.options.db).familyView(threadId);
    const origins = this.opportunityOrigins(threadId);
    this.options.db.immediateTransaction(() => {
      repository.saveCounts(threadId, opportunityCounts(families));
      let addedOrigins = 0;
      for (const origin of origins) {
        if (repository.candidateOrigin(threadId, origin.candidateId)) continue;
        repository.saveCandidateOrigin({ threadId, candidateId: origin.candidateId, batchId: null, origin: origin.origin });
        addedOrigins += 1;
      }
      if (addedOrigins > 0) repository.addUsage(threadId, { rawCandidates: addedOrigins });
    });
  }

  private budgetedOpportunityModel(threadId: string, model: ModelRef, signal: AbortSignal): StructuredModelClient {
    const client = this.requireModelClient(model);
    return {
      ...(client.prepareIdentity ? { prepareIdentity: client.prepareIdentity.bind(client) } : {}),
      ...(client.preparedIdentity ? { preparedIdentity: client.preparedIdentity.bind(client) } : {}),
      structuredCompletion: async <T>(request: StructuredStageRequest<T>) => {
        signal.throwIfAborted();
        const repository = new OpportunityExplorationRepository(this.options.db);
        const before = repository.require(threadId);
        const remainingMs = this.savedRunConfig(threadId).maxRunMinutes * 60_000
          - (Date.now() - Date.parse(before.startedAt));
        if (remainingMs <= 0) {
          throw new OpportunityBudgetExceededError(
            `The ${this.savedRunConfig(threadId).maxRunMinutes}-minute project time budget is exhausted.`,
          );
        }
        if (before.usage.modelCalls >= before.config.maxModelCalls) {
          throw new OpportunityBudgetExceededError(
            `The model-call limit of ${before.config.maxModelCalls} is exhausted. ${before.counts.acceptedFamilies} accepted families remain saved.`,
          );
        }
        let counted = false;
        const countDispatch = () => {
          if (counted) return;
          this.options.db.immediateTransaction(() => {
            const latest = repository.require(threadId);
            if (latest.usage.modelCalls >= latest.config.maxModelCalls) {
              throw new OpportunityBudgetExceededError(`The model-call limit of ${latest.config.maxModelCalls} is exhausted.`);
            }
            repository.addUsage(threadId, { modelCalls: 1 });
          });
          counted = true;
          request.onDispatched?.();
        };
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(new Error("Opportunity project time budget expired.")), remainingMs);
        try {
          const result = await client.structuredCompletion<T>({
            ...request,
            repairPolicy: "disabled",
            signal: AbortSignal.any([signal, timeout.signal]),
            onDispatched: countDispatch,
          });
          if (!counted) countDispatch();
          return result;
        } finally {
          clearTimeout(timer);
        }
      },
    };
  }

  private opportunityRunModel(active: ActiveRun, threadId: string): StructuredModelClient {
    return {
      structuredCompletion: async <T>(request: StructuredStageRequest<T>) => {
        const repository = new OpportunityExplorationRepository(this.options.db);
        const startedAt = Date.parse(repository.require(threadId).startedAt);
        const remainingMs = active.config.maxRunMinutes * 60_000 - (Date.now() - startedAt);
        const client = this.instrumentedModel(active, () => {
          const latest = repository.require(threadId);
          const remainingAtDispatch = active.config.maxRunMinutes * 60_000 - (Date.now() - startedAt);
          if (remainingAtDispatch <= 0) {
            throw new OpportunityBudgetExceededError(`The ${active.config.maxRunMinutes}-minute project time budget is exhausted.`);
          }
          if (latest.usage.modelCalls >= latest.config.maxModelCalls) {
            throw new OpportunityBudgetExceededError(`The model-call limit of ${latest.config.maxModelCalls} is exhausted.`);
          }
        });
        let counted = false;
        const originalDispatched = request.onDispatched;
        const timeout = new AbortController();
        const timer = remainingMs > 0
          ? setTimeout(() => timeout.abort(new Error("Opportunity project time budget expired.")), remainingMs)
          : null;
        try {
          return await client.structuredCompletion<T>({
            ...request,
            repairPolicy: "disabled",
            signal: timer
              ? AbortSignal.any([request.signal ?? active.abortController.signal, timeout.signal])
              : request.signal ?? active.abortController.signal,
            onDispatched: () => {
              if (!counted) {
                this.options.db.immediateTransaction(() => {
                  repository.addUsage(threadId, { modelCalls: 1 });
                });
                counted = true;
              }
              originalDispatched?.();
            },
          });
        } finally {
          if (timer) clearTimeout(timer);
        }
      },
    };
  }

  private savedOpportunityConfig(threadId: string): OpportunityExplorationConfig {
    const config = this.savedRunConfig(threadId);
    if (!config.opportunityExploration) {
      throw new AppError("conflict", "Enable a distinct startup family target in this project's setup before starting exploration.");
    }
    return config.opportunityExploration;
  }

  private savedRunConfig(threadId: string): RunConfig {
    const row = this.options.db.db.prepare(`
      SELECT config_json FROM run_configs WHERE thread_id = ? AND preset_name IS NULL
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(threadId) as { config_json: string } | undefined;
    const config = row ? RunConfigSchema.parse(JSON.parse(row.config_json)) : null;
    if (!config) throw new AppError("conflict", "Project run settings are missing.");
    return config;
  }

  private requireModelClient(model: ModelRef): StructuredModelClient {
    const client = this.options.modelClients?.[model.providerId];
    if (!client) throw new AppError("conflict", `Model provider ${model.providerId} is unavailable.`);
    return client;
  }

  private requireThread(threadId: string): void {
    if (!this.options.db.db.prepare("SELECT 1 FROM threads WHERE id = ?").get(threadId)) {
      throw new AppError("not_found", "Project not found.");
    }
  }

  private opportunityOrigins(threadId: string): Array<{
    candidateId: string;
    origin: {
      kind: "problem-evidence";
      problemId: string;
      evidenceIds: string[];
      evidenceGap: string | null;
    };
  }> {
    const rows = this.options.db.db.prepare(`
      SELECT s.id, s.problem_id, s.supporting_evidence_ids_json, s.contrary_evidence_ids_json, p.evidence_gap
      FROM solutions s
      JOIN research_runs rr ON rr.id = s.research_run_id
      JOIN problems p ON p.id = s.problem_id
      WHERE rr.thread_id = ?
      ORDER BY s.created_at, s.id
    `).all(threadId) as Array<{
      id: string;
      problem_id: string;
      supporting_evidence_ids_json: string;
      contrary_evidence_ids_json: string;
      evidence_gap: string | null;
    }>;
    return rows.map((row) => ({
      candidateId: row.id,
      origin: {
        kind: "problem-evidence" as const,
        problemId: row.problem_id,
        evidenceIds: [...new Set([
          ...parseStringArray(row.supporting_evidence_ids_json),
          ...parseStringArray(row.contrary_evidence_ids_json),
        ])],
        evidenceGap: row.evidence_gap,
      },
    }));
  }

  async requestEvidenceFollowUp(threadId: string, runId: string, question: string): Promise<void> {
    if (this.activeRuns.has(runId)) throw new AppError("conflict", "This research run is already active.");
    const row = this.options.db.db.prepare(`
      SELECT rr.thread_id, rr.problem_id, rr.config_json, s.id AS solution_id
      FROM research_runs rr
      JOIN solutions s ON s.research_run_id = rr.id AND s.selected_at IS NOT NULL
      WHERE rr.id = ? AND rr.workflow_version = 2 AND rr.status = 'completed'
    `).get(runId) as {
      thread_id: string;
      problem_id: string;
      config_json: string;
      solution_id: string;
    } | undefined;
    if (!row || row.thread_id !== threadId) throw new AppError("not_found", "Completed v2 analysis run not found.");
    const config = RunConfigSchema.parse(JSON.parse(row.config_json));
    if (config.workflowVersion !== 2) throw new AppError("conflict", "The saved run configuration is not workflow v2.");
    this.assertThreadIdle(threadId, runId);
    this.options.db.immediateTransaction(() => {
      try {
        this.followUps.request(runId, row.solution_id, question);
      } catch (error) {
        throw new AppError("conflict", error instanceof Error ? error.message : "Evidence follow-up cannot be requested.");
      }
      this.options.db.db.prepare("UPDATE research_runs SET status = 'running', cancelled = 0, updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), runId);
    });
    const active: ActiveRun = {
      runId,
      threadId,
      problemId: row.problem_id,
      config,
      abortController: new AbortController(),
      startedAt: Date.now(),
      projectedCodexCalls: this.ledger.countProviderCalls(runId, config.model.providerId) + 1,
      projectedSearches: 1,
      workflow: new WorkflowExecution(this.options.db, runId),
      followUpModelReservation: null,
      followUpSearchReservation: null,
      generationProvenance: new Map(),
    };
    this.activeRuns.set(runId, active);
    this.scheduleDeadline(active);
    this.emit({ type: "run-resumed", runId, threadId });
    const execution = this.executeEvidenceFollowUp(active)
      .catch((error) => this.failEvidenceFollowUp(active, error))
      .finally(() => {
        this.executions.delete(execution);
        if (this.executionsByRun.get(runId) === execution) this.executionsByRun.delete(runId);
      });
    this.executions.add(execution);
    this.executionsByRun.set(runId, execution);
  }

  private assertThreadIdle(threadId: string, exceptRunId: string): void {
    const other = this.options.db.db.prepare("SELECT id FROM research_runs WHERE thread_id = ? AND id != ? AND status IN ('queued','running')")
      .get(threadId, exceptRunId);
    if (other) throw new AppError("conflict", "This project already has another active run.");
  }

  cancelRun(runId: string): void {
    this.cancelRunInternal(runId, true);
  }

  async requestEvidenceReassessment(threadId: string, runId: string): Promise<void> {
    if (this.activeRuns.has(runId)) throw new AppError("conflict", "This research run is already active.");
    const row = this.options.db.db.prepare("SELECT thread_id, problem_id, config_json FROM research_runs WHERE id = ? AND workflow_version = 2 AND status = 'completed'")
      .get(runId) as { thread_id: string; problem_id: string; config_json: string } | undefined;
    if (!row || row.thread_id !== threadId) throw new AppError("not_found", "Completed v2 analysis run not found.");
    const safety = this.generationAttempts.getResumeSafety(runId);
    if (!safety.canResume) throw new AppError("conflict", `${safety.resumeBlockedReason} Cancel this run and start a new one to avoid an automatic duplicate charge.`);
    this.assertThreadIdle(threadId, runId);
    try { this.options.db.immediateTransaction(() => this.followUps.beginReassessment(runId)); }
    catch (error) { throw new AppError("conflict", error instanceof Error ? error.message : "Evidence reassessment cannot be started."); }
    this.options.db.db.prepare("UPDATE research_runs SET status = 'running', cancelled = 0, updated_at = ? WHERE id = ?").run(new Date().toISOString(), runId);
    const config = RunConfigSchema.parse(JSON.parse(row.config_json));
    const completedCalls = this.ledger.countProviderCalls(runId, config.model.providerId);
    const active: ActiveRun = { runId, threadId, problemId: row.problem_id, config, abortController: new AbortController(), startedAt: Date.now(),
      projectedCodexCalls: completedCalls + 2, projectedSearches: 0, workflow: new WorkflowExecution(this.options.db, runId), followUpModelReservation: null, followUpSearchReservation: null,
      generationProvenance: new Map() };
    this.activeRuns.set(runId, active);
    this.scheduleDeadline(active);
    this.emit({ type: "run-resumed", runId, threadId });
    const execution = this.executeEvidenceReassessment(active).catch((error) => this.failEvidenceReassessment(active, error)).finally(() => {
      this.executions.delete(execution);
      if (this.executionsByRun.get(runId) === execution) this.executionsByRun.delete(runId);
    });
    this.executions.add(execution);
    this.executionsByRun.set(runId, execution);
  }

  private cancelRunInternal(runId: string, emitTerminalEvent: boolean): { threadId: string } {
    const row = this.options.db.db.prepare("SELECT thread_id, status FROM research_runs WHERE id = ?").get(runId) as
      { thread_id: string; status: string } | undefined;
    if (!row) throw new AppError("not_found", "Research run not found.");
    if (!["queued", "running"].includes(row.status)) throw new AppError("conflict", "This research run has already ended.");
    const active = this.activeRuns.get(runId);
    const followUp = this.followUps.find(runId);
    if (active) {
      if (active.deadlineTimer) clearTimeout(active.deadlineTimer);
      active.abortController.abort(new Error("Cancelled by user"));
      if (active.followUpModelReservation) {
        this.ledger.release(active.followUpModelReservation.id);
        active.followUpModelReservation = null;
      }
      this.activeRuns.delete(runId);
    }
    this.ledger.settleUncertain(runId, "Run cancelled while operations were in flight");
    const opportunityTask = this.opportunityTasks.get(row.thread_id);
    if (opportunityTask?.kind === "experiment") {
      this.options.db.db.prepare("UPDATE research_runs SET status = 'completed', cancelled = 0, updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), runId);
      this.updateThread(row.thread_id, "solutions-ready");
      if (emitTerminalEvent) this.emit({ type: "run-cancelled", runId, threadId: row.thread_id });
      return { threadId: row.thread_id };
    }
    if (followUp && ["requested", "running"].includes(followUp.status)) {
      this.options.db.immediateTransaction(() => {
        this.followUps.fail(runId, "Cancelled by user");
        this.options.db.db.prepare(`
          UPDATE research_runs SET status = 'completed', completion_reason = ?, cancelled = 0, updated_at = ? WHERE id = ?
        `).run("Analysis completed; evidence follow-up cancelled", new Date().toISOString(), runId);
      });
      this.updateThread(row.thread_id, "solutions-ready");
      if (emitTerminalEvent) this.emit({ type: "run-cancelled", runId, threadId: row.thread_id });
      return { threadId: row.thread_id };
    }
    if (followUp?.reassessmentStatus === "running") {
      this.options.db.immediateTransaction(() => {
        this.followUps.failReassessment(runId, "Cancelled by user");
        this.options.db.db.prepare("UPDATE research_runs SET status = 'completed', completion_reason = ?, cancelled = 0, updated_at = ? WHERE id = ?")
          .run("Analysis completed; evidence reassessment cancelled", new Date().toISOString(), runId);
      });
      this.updateThread(row.thread_id, "solutions-ready");
      if (emitTerminalEvent) this.emit({ type: "run-cancelled", runId, threadId: row.thread_id });
      return { threadId: row.thread_id };
    }
    this.runs.cancel(runId);
    this.updateThread(row.thread_id, "failed");
    if (emitTerminalEvent) this.emit({ type: "run-cancelled", runId, threadId: row.thread_id });
    return { threadId: row.thread_id };
  }

  async cancelRunAndWait(runId: string): Promise<void> {
    const { threadId } = this.cancelRunInternal(runId, false);
    const execution = this.executionsByRun.get(runId);
    if (execution) await execution;
    this.emit({ type: "run-cancelled", runId, threadId });
  }

  private begin(runId: string, threadId: string, problemId: string | null, config: RunConfig, resumed = false): void {
    if (config.workflowVersion !== 2) throw new AppError("conflict", "Legacy generation has been retired. Start a new run to use the current prompts.");
    const projection = problemId
      ? { modelCalls: 3, searches: 0 }
      : discoveryRunProjection(config.discoveryDepth);
    const active: ActiveRun = {
      runId, threadId, problemId, config, abortController: new AbortController(), startedAt: Date.now(),
      projectedCodexCalls: projection.modelCalls, projectedSearches: projection.searches,
      followUpModelReservation: null, followUpSearchReservation: null,
      generationProvenance: new Map(),
    };
    this.activeRuns.set(runId, active);
    this.scheduleDeadline(active);
    this.updateThread(threadId, problemId ? "development-running" : "discovery-running");
    this.emit(resumed
      ? { type: "run-resumed", runId, threadId }
      : { type: "run-started", runId, threadId, problemId });
    const execution = this.execute(active)
      .catch((error) => this.fail(active, error))
      .finally(() => {
        this.executions.delete(execution);
        if (this.executionsByRun.get(runId) === execution) this.executionsByRun.delete(runId);
      });
    this.executions.add(execution);
    this.executionsByRun.set(runId, execution);
  }

  private async execute(active: ActiveRun): Promise<void> {
    active.workflow = new WorkflowExecution(this.options.db, active.runId);
    if (active.problemId) await this.executeDevelopment(active);
    else await this.executeDiscovery(active);
    if (active.abortController.signal.aborted || this.activeRuns.get(active.runId) !== active) return;
    this.runs.finish(active.runId, "completed");
    if (active.deadlineTimer) clearTimeout(active.deadlineTimer);
    this.activeRuns.delete(active.runId);
    this.emit({ type: "run-completed", runId: active.runId, threadId: active.threadId, problemId: active.problemId });
    if (!active.problemId) { this.updateThread(active.threadId, "problems-ready"); return; }
    if (active.workflow) {
      const waiting = this.options.db.db.prepare("SELECT awaiting_selection FROM research_runs WHERE id = ?").get(active.runId) as { awaiting_selection: number };
      const selected = this.options.db.db.prepare("SELECT 1 FROM solutions WHERE research_run_id = ? AND selected_at IS NOT NULL LIMIT 1").get(active.runId);
      if (!waiting.awaiting_selection && selected) {
        this.updateThread(active.threadId, "solutions-ready");
        return;
      }
    }
    // This run is already completed and out of activeRuns, so fail() would no-op; a queue handoff
    // that throws has to move the thread off development-running here or it stays stuck there.
    try { await this.startNextSelected(active.threadId, active.config); }
    catch (error) {
      const message = error instanceof Error ? error.message : "Could not start the next selected problem";
      this.updateThread(active.threadId, "failed");
      this.emit({ type: "run-failed", runId: active.runId, threadId: active.threadId, error: message });
    }
  }

  private async executeDiscovery(active: ActiveRun): Promise<void> {
    const scopeRow = this.options.db.db.prepare("SELECT title, audience, domain, observations, off_limits_json, risk_evaluation_criteria FROM scopes WHERE research_run_id = ?")
      .get(active.runId) as { title: string; audience: string; domain: string; observations: string; off_limits_json: string; risk_evaluation_criteria: string } | undefined;
    if (!scopeRow) throw new Error("Discovery scope is missing");
    const scope = ScopeSchema.parse({
      title: scopeRow.title,
      audience: scopeRow.audience,
      domain: scopeRow.domain,
      observations: scopeRow.observations,
      offLimits: JSON.parse(scopeRow.off_limits_json),
      ...(scopeRow.risk_evaluation_criteria ? { riskEvaluationCriteria: scopeRow.risk_evaluation_criteria } : {}),
    });
    const deps = this.dependencies(active);
    if (active.workflow) {
      const workflow = active.workflow;
      if (workflow.read("discovery-completed")) return;
      let harvest = workflow.read<HarvestResult>("harvest");
      if (!harvest) {
        harvest = await harvestFactors(scope, { ...deps, idFactory: workflow.idFactory("harvest"), random: () => 0.5 });
        harvest = { ...harvest, factors: workflow.withFactorUncertainty(harvest.factors) };
        const snapshot = harvest;
        this.discovery.persistFactors(active.runId, harvest.sources, harvest.factors, () => {
          workflow.save("harvest", snapshot);
        });
      }
      this.progress(active, `${harvest.factors.length} observations from ${harvest.sources.length} sources`);
      const result = await discoverProblems(scope, harvest.factors, harvest.sources, { ...deps, idFactory: workflow.idFactory("problems") });
      this.discovery.persistProblems(active.runId, result.killSources, result.problems, result.blockedCandidates, () => {
        workflow.save("discovery-completed", result);
      });
      this.progress(active, `${result.problems.length} problems ready for your review`);
      return;
    }
    throw new AppError("conflict", "Legacy generation has been retired. Start a new run to use the current prompts.");
  }

  private async executeDevelopment(active: ActiveRun): Promise<void> {
    if (active.workflow) {
      const workflow = active.workflow;
      const context = workflow.developmentContext(active.problemId!);
      const opportunityConfig = active.config.opportunityExploration;
      if (opportunityConfig) {
        const exploration = new OpportunityExplorationRepository(this.options.db);
        if (!exploration.find(active.threadId)) {
          this.options.db.immediateTransaction(() => exploration.create(active.threadId, opportunityConfig));
        }
      }
      const opportunityProgress = opportunityConfig
        ? new OpportunityExplorationRepository(this.options.db).require(active.threadId)
        : null;
      const existingProjectOptions = opportunityConfig
        ? (this.options.db.db.prepare(`
            SELECT COUNT(*) AS count FROM solutions s
            JOIN research_runs rr ON rr.id = s.research_run_id WHERE rr.thread_id = ?
          `).get(active.threadId) as { count: number }).count
        : 0;
      const opportunityBatchSize = opportunityConfig
        ? ["target-reached", "useful-partial", "budget-exhausted", "paused", "failed"].includes(opportunityProgress!.status)
          ? 0
          : Math.min(
              opportunityConfig.batchSize,
              active.config.ideaCount ?? DEFAULT_IDEA_COUNT,
              Math.max(0, opportunityConfig.maxRawCandidates - existingProjectOptions),
            )
        : null;
      const deps = {
        modelClient: this.instrumentedModel(active),
        model: active.config.model,
        ideaCount: opportunityBatchSize ?? active.config.ideaCount,
        explorationPurpose: active.config.explorationPurpose,
        focusedExperiments: workflow.hasFocusedExperiments(),
        reasoningEffort: active.config.reasoningEffort, signal: active.abortController.signal,
        resolvePrompt: workflow.resolvePrompt,
      };
      const generationDeps = opportunityConfig
        ? { ...deps, modelClient: this.opportunityRunModel(active, active.threadId) }
        : deps;
      const savedSolutions = workflow.repository.findStageResult(active.runId, "solutions");
      const savedExpansion = this.options.db.db.prepare(`
        SELECT 1
        FROM solutions solution
        JOIN opportunity_candidate_origins origin ON origin.candidate_id = solution.id
        JOIN opportunity_exploration_attempts attempt
          ON attempt.thread_id = origin.thread_id
         AND attempt.stage_key = 'gap-generation:' || origin.batch_id
         AND attempt.status = 'completed'
        WHERE solution.research_run_id = ?
        LIMIT 1
      `).get(active.runId);
      if (savedSolutions) {
        workflow.repository.getStageResumeState({
          researchRunId: active.runId,
          stageId: "solutions",
          context,
          identity: {
            promptSha256: savedSolutions.prompt.resolvedSha256,
            // Source enums belong to this request. Saved revision-1 output is
            // validated on read; never replace its schema with today's prompt constraints.
            schema: savedSolutions.schema,
            inputs: savedSolutions.inputs,
            evidence: savedSolutions.evidence,
          },
        });
      } else if (!savedExpansion) {
        if (opportunityBatchSize !== null && opportunityBatchSize <= 0) {
          this.progress(active, "The project raw-candidate limit is exhausted. No new initial problem batch was dispatched.");
          return;
        }
        this.progress(active, `Generating up to ${opportunityBatchSize ?? active.config.ideaCount ?? DEFAULT_IDEA_COUNT} ideas`, "generating-options");
      const result = await produceDevelopmentOptions(context, generationDeps);
      active.abortController.signal.throwIfAborted();
      this.options.db.immediateTransaction(() => {
          workflow.repository.saveSolutionOptions(active.runId, active.problemId!, result.options.map((option) => {
            const { problemId, focusedDemandTest, ...persistedOption } = option;
            void problemId;
            void focusedDemandTest;
            return persistedOption;
          }));
          new FocusedExperimentRepository(this.options.db).saveDemandTests(active.runId, result.options.flatMap((option) =>
            option.focusedDemandTest ? [{ solutionId: option.id, test: option.focusedDemandTest }] : []));
          workflow.commitStage("solutions", result.request, result.resolvedPrompt, result.metadata,
            { options: result.options.map(({ id, problemId, focusedDemandTest, ...option }) => {
              void id; void problemId; void focusedDemandTest; return option;
            }) }, context);
        });
        if (opportunityConfig) {
          this.syncOpportunityInventory(active.threadId);
          try {
            await runOpportunityReview({
              db: this.options.db,
              threadId: active.threadId,
              modelClient: this.opportunityRunModel(active, active.threadId),
              model: active.config.model,
              reasoningEffort: active.config.reasoningEffort,
              signal: active.abortController.signal,
            });
          } catch (error) {
            if (!(error instanceof OpportunityBudgetExceededError)) throw error;
            this.options.db.immediateTransaction(() => new OpportunityExplorationRepository(this.options.db).setStatus(
              active.threadId,
              "budget-exhausted",
              error.message,
            ));
          }
          this.syncOpportunityInventory(active.threadId);
        }
      }
      const option = workflow.selectedOption(active.problemId!);
      if (!option) {
        const count = this.options.db.db.prepare("SELECT COUNT(*) AS count FROM solutions WHERE research_run_id = ?").get(active.runId) as { count: number };
        this.options.db.db.prepare("UPDATE research_runs SET awaiting_selection = ? WHERE id = ?").run(count.count > 0 ? 1 : 0, active.runId);
        this.progress(active, count.count ? "Options saved. Choose one to analyze." : "No useful new option was proposed. Review the problem or keep the current approach.");
        return;
      }
      const savedAnalysis = workflow.repository.findStageResult(active.runId, "decision-analysis", option.id);
      if (savedAnalysis) {
        workflow.repository.getStageResumeState({
          researchRunId: active.runId,
          stageId: "decision-analysis",
          selectionId: option.id,
          context,
          identity: {
            promptSha256: savedAnalysis.prompt.resolvedSha256,
            schema: savedAnalysis.schema,
            inputs: savedAnalysis.inputs,
            evidence: savedAnalysis.evidence,
          },
        });
        return;
      }
      let riskEvaluation;
      if (workflow.hasRiskEvaluator()) {
        const saved = workflow.repository.findStageResult(active.runId, "risk-evaluation", option.id);
        if (saved) {
          workflow.repository.getStageResumeState({
            researchRunId: active.runId, stageId: "risk-evaluation", selectionId: option.id, context,
            identity: {
              promptSha256: workflow.resolvePrompt("risk-evaluation").resolvedSha256,
              schema: saved.schema, inputs: saved.inputs, evidence: saved.evidence,
            },
          });
          riskEvaluation = WorkflowV2RiskEvaluationOutputSchema.parse(saved.output);
        } else {
          this.progress(active, "Risk evaluator: reviewing the selected idea against your criteria", "evaluating-risk");
          const result = await evaluateSelectedOptionRisk(context, option, deps);
          active.abortController.signal.throwIfAborted();
          this.options.db.immediateTransaction(() => workflow.commitStage(
            "risk-evaluation", result.request, result.resolvedPrompt, result.metadata, result.evaluation, context, option.id,
          ));
          riskEvaluation = result.evaluation;
        }
      }
      const focusedExperimentRepository = new FocusedExperimentRepository(this.options.db);
      const shortDemandTest = focusedExperimentRepository.findDemandTest(active.runId, option.id);
      const focusedExperiment = riskEvaluation && workflow.hasFocusedExperiments()
        ? await runFocusedExperimentFlow({
            researchRunId: active.runId,
            context,
            selectedOption: option,
            riskEvaluation,
            ...(shortDemandTest ? { shortDemandTest } : {}),
          }, {
            repository: focusedExperimentRepository,
            modelClient: this.instrumentedModel(active),
            generationModel: active.config.model,
            reviewModel: active.config.model,
            generationReasoningEffort: active.config.reasoningEffort,
            reviewReasoningEffort: active.config.reasoningEffort,
            signal: active.abortController.signal,
            onStage: () => this.progress(active, "Reviewing one focused experiment", "analyzing-option"),
          })
        : null;
      this.progress(active, "Analyzing the selected option and its next experiment", "analyzing-option");
      const result = await analyzeSelectedOption(context, option, deps, riskEvaluation, focusedExperiment?.record.plan);
      active.abortController.signal.throwIfAborted();
      this.options.db.immediateTransaction(() => {
        const checkpoint = workflow.commitStage("decision-analysis", result.request, result.resolvedPrompt,
          result.metadata, result.analysis, context, option.id);
        workflow.repository.saveDecisionAnalysis({ researchRunId: active.runId, solutionId: option.id,
          stageResultId: checkpoint.id, analysis: result.analysis });
      });
      this.progress(active, "Analysis saved. Record your decision and the observed test result when available.");
      return;
    }
    throw new AppError("conflict", "Legacy generation has been retired. Start a new run to use the current prompts.");
  }

  private dependencies(active: ActiveRun) {
    const workflow = active.workflow;
    if (!workflow) throw new Error("The current workflow must be initialized before research starts");
    const modelClient = this.instrumentedModel(active);
    const search = this.instrumentedSearch(active);
    return {
      modelClient: workflow.discoveryClient(modelClient),
      search: workflow.search(search),
      model: active.config.model,
      reasoningEffort: active.config.reasoningEffort,
      depth: active.config.discoveryDepth,
      signal: active.abortController.signal,
      onProjection: (message: string) => this.progress(active, message),
      workflowVersion: 2 as const,
      prompt: (name: string) => workflow.resolvePrompt(name as WorkflowV2StageId).text,
      // "web" is unrestricted, including community sites; only "communities" adds a domain filter.
      audienceSearch: { includeDomains: active.config.audienceSourcePolicy === "communities" ? ["reddit.com", "news.ycombinator.com"] : [] },
    };
  }

  private instrumentedModel(active: ActiveRun, beforeUncachedDispatch?: () => void): StructuredModelClient {
    const client = this.options.modelClients?.[active.config.model.providerId];
    if (!client) throw new Error(`Model provider ${active.config.model.providerId} is unavailable`);
    return {
      structuredCompletion: async <T>(request: StructuredStageRequest<T>) => {
        active.abortController.signal.throwIfAborted();
        const stage = runtimeStage(request.stage);
        this.progress(active, "Waiting for model availability", stage, "waiting");
        if (!sameModelRef(request.model, active.config.model)) throw new Error("Stage model does not match the active run configuration");
        const providerId = active.config.model.providerId;
        const preparedIdentity = client.prepareIdentity
          ? await client.prepareIdentity()
          : client.preparedIdentity?.();
        active.abortController.signal.throwIfAborted();
        const reusable = this.generationAttempts.findCompleted(active.runId, request, preparedIdentity);
        if (reusable) {
          active.generationProvenance.set(request.generationId, reusable.generationId);
          return { output: reusable.output, metadata: reusable.metadata as GenerationMetadata };
        }
        beforeUncachedDispatch?.();
        this.enforceRunawayBackstop(active, providerId, active.projectedCodexCalls);
        const attempt = this.generationAttempts.prepare(active.runId, request, preparedIdentity);
        let reservation: ReturnType<CostLedgerRepository["reserve"]> | null = null;
        let accepted = false;
        let dispatched = false;
        let terminalRecorded = false;
        try {
          if (active.followUpModelReservation) {
            reservation = active.followUpModelReservation;
            active.followUpModelReservation = null;
            this.ledger.attachGenerationAttempt(reservation.id, attempt.id);
          }
          const result = await client.structuredCompletion<T>({
            ...request,
            onDispatched: () => {
              reservation ??= this.ledger.reserve(active.runId, "structured-completion", providerId, active.config.model.modelId, 0, attempt.id);
              dispatched = true;
              this.generationAttempts.markDispatched(attempt.id);
              if (this.activeRuns.get(active.runId) === active) this.progress(active, "Model request dispatched", stage, "dispatched");
              request.onDispatched?.();
            },
            onAccepted: (metadata) => {
              accepted = true;
              this.generationAttempts.markAccepted(attempt.id, metadata);
              if (this.activeRuns.get(active.runId) === active) this.progress(active, "Model request accepted", stage, "accepted");
              request.onAccepted?.(metadata);
            },
          });
          if (!reservation) {
            reservation = this.ledger.reserve(active.runId, "structured-completion", providerId, active.config.model.modelId, 0, attempt.id);
            dispatched = true;
            this.generationAttempts.markDispatched(attempt.id);
          }
          this.generationAttempts.recordTerminal(attempt.id, {
            status: "completed",
            terminalKind: "completed",
            output: result.output,
            attemptMetadata: result.metadata,
            usage: result.metadata.attempts.map((item) => item.usage ?? null),
            ...(reportedCost(result.metadata) === null ? {} : { reportedCostUsd: reportedCost(result.metadata)! }),
          });
          terminalRecorded = true;
          if (!reservation) throw new Error("Model completed without a recorded dispatch");
          this.ledger.commit(reservation.id, reportedCost(result.metadata), { generation: result.metadata });
          if (this.activeRuns.get(active.runId) === active) this.progress(active, "Model call completed", stage, null);
          return result;
        } catch (error) {
          const failedAttempts = error instanceof ProviderFailure ? error.attempts : undefined;
          const failedCostUsd = failedAttempts ? reportedAttemptCost(failedAttempts) : null;
          if (!reservation && failedAttempts?.length) {
            reservation = this.ledger.reserve(active.runId, "structured-completion", providerId, active.config.model.modelId, 0, attempt.id);
            dispatched = true;
            this.generationAttempts.markDispatched(attempt.id);
          }
          if (!terminalRecorded) {
            const code = error instanceof ProviderFailure ? error.code : "failed";
            this.generationAttempts.recordTerminal(attempt.id, {
              status: code === "cancelled" ? "cancelled" : code === "interrupted" ? "interrupted" : "failed",
              terminalKind: dispatched || accepted || failedAttempts?.length ? code : "never-dispatched",
              errorCode: code,
              errorMessage: error instanceof Error ? error.message : "Model generation failed",
              ...(failedAttempts ? {
                attemptMetadata: { attempts: failedAttempts },
                usage: failedAttempts.map((item) => item.usage),
              } : {}),
              ...(failedCostUsd === null ? {} : { reportedCostUsd: failedCostUsd }),
            });
          }
          if (reservation && (accepted || dispatched || failedAttempts?.length)) {
            this.ledger.commit(reservation.id, failedCostUsd, {
              ...(failedAttempts ? { attempts: failedAttempts } : {}),
              ...(failedCostUsd === null ? { uncertain: true, reason: "Generation ended without an explicit USD cost" } : {}),
            });
          }
          else if (reservation) this.ledger.release(reservation.id);
          throw error;
        }
      },
    };
  }

  private instrumentedSearch(active: ActiveRun): Pick<SearchClient, "provider" | "search"> {
    const provider = active.config.searchProvider;
    const client = this.options.searchClients?.[provider];
    return {
      provider,
      search: async (query: string, options?: SearchOptions) => {
        active.abortController.signal.throwIfAborted();
        if (!client) throw new AppError("conflict", `Connect ${provider === "exa" ? "Exa" : "Perplexity"} before discovering problems.`);
        this.enforceRunawayBackstop(active, provider, active.projectedSearches);
        const reservation = active.followUpSearchReservation
          ?? this.ledger.reserve(active.runId, "search", provider, null, provider === "exa" ? 0.02 : 0.005);
        active.followUpSearchReservation = null;
        try { return await client.search(query, options); }
        finally {
          if (this.activeRuns.get(active.runId) === active) {
            this.ledger.commit(reservation.id, reservation.reservedUsd);
            this.progress(active, `Search: ${query}`);
          }
        }
      },
    };
  }

  private enforceRunawayBackstop(active: ActiveRun, provider: string, projection: number): void {
    const count = this.ledger.countProviderCalls(active.runId, provider);
    if (count >= Math.max(6, projection * 3)) throw new Error(`Runaway backstop triggered for ${provider}; the run exceeded 3× its projected calls.`);
  }

  private progress(active: ActiveRun, message: string, stage?: RuntimeStage, modelState?: "waiting" | "dispatched" | "accepted" | null): void {
    if (stage) active.stage = stage;
    if (modelState !== undefined) active.modelState = modelState;
    const codexCalls = this.ledger.countProviderCalls(active.runId, active.config.model.providerId);
    const searches = this.ledger.countProviderCalls(active.runId, active.config.searchProvider);
    const details = { message, codexCalls, searches, ...(active.stage ? { stage: active.stage } : {}),
      modelState: active.modelState ?? null, elapsedMs: Math.max(0, Date.now() - active.startedAt),
      operationStartedAt: new Date(active.startedAt).toISOString(), operationElapsedMs: Math.max(0, Date.now() - active.startedAt),
      lastSuccessfulCheckpoint: this.lastSuccessfulCheckpoint(active.runId) };
    this.logJob(active.runId, active.threadId, "run-progress", details);
    this.emit({ type: "run-progress", runId: active.runId, threadId: active.threadId, ...details });
  }

  private lastSuccessfulCheckpoint(runId: string): string | null {
    const row = this.options.db.db.prepare(`SELECT stage_id FROM stage_results WHERE research_run_id = ? ORDER BY completed_at DESC, rowid DESC LIMIT 1`)
      .get(runId) as { stage_id: string } | undefined;
    return row?.stage_id ?? null;
  }

  private fail(active: ActiveRun, error: unknown, status?: "failed" | "cancelled"): void {
    if (this.activeRuns.get(active.runId) !== active) return;
    if (active.deadlineTimer) clearTimeout(active.deadlineTimer);
    this.activeRuns.delete(active.runId);
    const message = error instanceof Error ? error.message : "Research failed";
    this.ledger.settleUncertain(active.runId, message);
    this.runs.finish(active.runId, status ?? (active.abortController.signal.aborted ? "cancelled" : "failed"), message);
    this.updateThread(active.threadId, "failed");
    this.emit({ type: "run-failed", runId: active.runId, threadId: active.threadId, error: message });
    if (active.problemId && active.config.opportunityExploration && !active.abortController.signal.aborted) {
      const exploration = new OpportunityExplorationRepository(this.options.db);
      const progress = exploration.find(active.threadId);
      if (progress && !["target-reached", "useful-partial", "budget-exhausted", "paused", "failed"].includes(progress.status)) {
        const stopReason = `Initial opportunity generation failed: ${message}`;
        this.options.db.immediateTransaction(() => exploration.setStatus(active.threadId, "failed", stopReason));
        this.emit({ type: "opportunity-progress", threadId: active.threadId, status: "failed", error: stopReason });
      }
    }
  }

  private scheduleDeadline(active: ActiveRun): void {
    active.deadlineTimer = setTimeout(() => {
      if (this.activeRuns.get(active.runId) !== active) return;
      const error = new Error("Run attempt exceeded its hang-detection deadline");
      active.abortController.abort(error);
      const followUp = this.followUps.find(active.runId);
      if (followUp && ["requested", "running"].includes(followUp.status)) this.failEvidenceFollowUp(active, error);
      else if (followUp?.reassessmentStatus === "running") this.failEvidenceReassessment(active, error);
      else this.fail(active, error, "failed");
    }, active.config.maxRunMinutes * 60_000);
  }

  private updateThread(threadId: string, status: string): void {
    this.options.db.db.prepare("UPDATE threads SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), threadId);
  }
  private emit(event: ResearchEvent): void {
    this.logJob("runId" in event ? event.runId : null, event.threadId, event.type, event);
    this.options.onEvent(event);
  }
  private logJob(runId: string | null, threadId: string | null, type: string, payload: Record<string, unknown>): void {
    this.options.db.db.prepare("INSERT INTO job_events (run_id, thread_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(runId, threadId, type, JSON.stringify(payload), new Date().toISOString());
  }

  private async executeEvidenceFollowUp(active: ActiveRun): Promise<void> {
    const row = this.options.db.db.prepare(`
      SELECT s.title, s.audience, s.domain, s.observations, s.off_limits_json, s.risk_evaluation_criteria
      FROM problems p JOIN scopes s ON s.research_run_id = p.discovery_run_id
      WHERE p.id = ?
    `).get(active.problemId) as {
      title: string;
      audience: string;
      domain: string;
      observations: string;
      off_limits_json: string;
      risk_evaluation_criteria: string;
    } | undefined;
    const followUp = this.followUps.find(active.runId);
    if (!row || !followUp) throw new Error("Evidence follow-up context is missing");
    const scope = ScopeSchema.parse({
      title: row.title,
      audience: row.audience,
      domain: row.domain,
      observations: row.observations,
      offLimits: JSON.parse(row.off_limits_json),
      ...(row.risk_evaluation_criteria ? { riskEvaluationCriteria: row.risk_evaluation_criteria } : {}),
    });
    const providerId = active.config.model.providerId;
    this.enforceRunawayBackstop(active, providerId, 1);
    this.enforceRunawayBackstop(active, active.config.searchProvider, 1);
    active.followUpModelReservation = this.ledger.reserve(
      active.runId, "evidence-follow-up", providerId, active.config.model.modelId, 0,
    );
    try {
      active.followUpSearchReservation = this.ledger.reserve(
        active.runId,
        "evidence-follow-up-search",
        active.config.searchProvider,
        null,
        active.config.searchProvider === "exa" ? 0.02 : 0.005,
      );
    } catch (error) {
      this.ledger.release(active.followUpModelReservation.id);
      active.followUpModelReservation = null;
      throw error;
    }
    this.options.db.immediateTransaction(() => this.followUps.markRunning(active.runId));
    this.progress(active, `Investigating one question: ${followUp.question}`);
    const result = await harvestEvidenceFollowUp(scope, followUp.question, {
      ...this.dependencies(active),
      depth: active.config.discoveryDepth,
      idFactory: active.workflow!.idFactory("evidence-follow-up"),
    });
    active.abortController.signal.throwIfAborted();
    if (active.followUpModelReservation) {
      this.ledger.release(active.followUpModelReservation.id);
      active.followUpModelReservation = null;
    }
    const factors = active.workflow!.withFactorUncertainty(result.factors);
    this.discovery.persistFactors(active.runId, result.sources, factors, () => {
      this.followUps.complete(
        active.runId,
        result.sources.map((source) => source.id),
        factors.map((factor) => factor.id),
      );
    });
    this.runs.finish(active.runId, "completed", "Evidence follow-up completed");
    if (active.deadlineTimer) clearTimeout(active.deadlineTimer);
    this.activeRuns.delete(active.runId);
    this.progress(active, `${result.factors.length} quote-verified follow-up observations saved`);
    this.updateThread(active.threadId, "solutions-ready");
    this.emit({ type: "run-completed", runId: active.runId, threadId: active.threadId, problemId: active.problemId });
  }

  private failEvidenceFollowUp(active: ActiveRun, error: unknown): void {
    const saved = this.followUps.find(active.runId);
    if (!saved || ["completed", "failed"].includes(saved.status)) return;
    if (active.deadlineTimer) clearTimeout(active.deadlineTimer);
    this.activeRuns.delete(active.runId);
    if (active.followUpModelReservation) this.ledger.release(active.followUpModelReservation.id);
    if (active.followUpSearchReservation) this.ledger.release(active.followUpSearchReservation.id);
    this.ledger.settleUncertain(active.runId, "Evidence follow-up ended while a provider operation was in flight");
    const message = error instanceof Error ? error.message : "Evidence follow-up failed";
    this.options.db.immediateTransaction(() => {
      this.followUps.fail(active.runId, message);
      this.options.db.db.prepare(`
        UPDATE research_runs SET status = 'completed', completion_reason = ?, updated_at = ? WHERE id = ?
      `).run("Analysis completed; evidence follow-up failed", new Date().toISOString(), active.runId);
    });
    this.updateThread(active.threadId, "solutions-ready");
    this.emit({ type: "run-failed", runId: active.runId, threadId: active.threadId, error: message });
  }

  private async executeEvidenceReassessment(active: ActiveRun): Promise<void> {
    const workflow = active.workflow!;
    const followUp = this.followUps.find(active.runId);
    if (!followUp || followUp.status !== "completed") throw new Error("Evidence reassessment requires a completed follow-up");
    const option = workflow.selectedOption(active.problemId!);
    if (!option || option.id !== followUp.solutionId) throw new Error("The selected option for this follow-up is missing");
    const originalRiskStage = workflow.repository.findStageResult(active.runId, "risk-evaluation", option.id);
    const originalAnalysisStage = workflow.repository.findStageResult(active.runId, "decision-analysis", option.id);
    if (!originalRiskStage || !originalAnalysisStage) throw new Error("The original analysis checkpoints are missing");
    const originalRisk = WorkflowV2RiskEvaluationOutputSchema.parse(originalRiskStage.output);
    const originalAnalysis = WorkflowV2CompatibleDecisionAnalysisOutputSchema.parse(originalAnalysisStage.output);
    const followUpEvidence = this.evidenceFollowUpItems(followUp);
    const context = workflow.developmentContext(active.problemId!);
    const evidenceRevision = createHash("sha256").update(JSON.stringify(followUpEvidence)).digest("hex").slice(0, 16);
    const selectionId = `${option.id}:evidence-reassessment:v2:${evidenceRevision}`;
    const deps = { modelClient: this.instrumentedModel(active), model: active.config.model, reasoningEffort: active.config.reasoningEffort,
      signal: active.abortController.signal, resolvePrompt: workflow.resolvePrompt };
    this.progress(active, "Reassessing risks using the completed evidence follow-up", "evaluating-risk");
    const savedRisk = workflow.repository.findStageResult(active.runId, "risk-evaluation", selectionId);
    const riskResult = savedRisk ? { reassessment: WorkflowV2RiskReassessmentOutputSchema.parse(savedRisk.output), request: null, resolvedPrompt: null, metadata: null }
      : await reassessSelectedOptionRisk(context, option, originalRisk, followUpEvidence, deps);
    active.abortController.signal.throwIfAborted();
    if (riskResult.request && riskResult.resolvedPrompt && riskResult.metadata) this.options.db.immediateTransaction(() => workflow.commitStage(
      "risk-evaluation", riskResult.request!, riskResult.resolvedPrompt!, riskResult.metadata!, riskResult.reassessment, context, selectionId,
    ));
    this.progress(active, "Reassessing the option and its next experiment", "analyzing-option");
    const analysisResult = await reassessSelectedOption(context, option, originalAnalysis, originalRisk, riskResult.reassessment, followUpEvidence, deps);
    active.abortController.signal.throwIfAborted();
    this.options.db.immediateTransaction(() => {
      workflow.commitStage("decision-analysis", analysisResult.request, analysisResult.resolvedPrompt, analysisResult.metadata, analysisResult.analysis, context, selectionId);
      this.followUps.completeReassessment({ researchRunId: active.runId, riskReassessment: riskResult.reassessment, analysis: analysisResult.analysis,
        riskGenerationId: riskResult.request
          ? this.generationIdFor(active, riskResult.request.generationId)
          : this.reassessmentRiskGenerationId(active.runId),
        analysisGenerationId: this.generationIdFor(active, analysisResult.request.generationId) });
    });
    this.runs.finish(active.runId, "completed", "Evidence reassessment completed");
    if (active.deadlineTimer) clearTimeout(active.deadlineTimer);
    this.activeRuns.delete(active.runId);
    this.updateThread(active.threadId, "solutions-ready");
    this.emit({ type: "run-completed", runId: active.runId, threadId: active.threadId, problemId: active.problemId });
  }

  private reassessmentRiskGenerationId(runId: string): string {
    const row = this.options.db.db.prepare(`SELECT generation_id FROM generation_attempts WHERE research_run_id = ? AND stage_key = 'risk-evaluation'
      AND status = 'completed' AND json_extract(request_json, '$.workOrder.inputs.reassessment') = 1 ORDER BY terminal_at DESC LIMIT 1`)
      .get(runId) as { generation_id: string } | undefined;
    if (!row) throw new Error("Saved risk reassessment generation provenance is missing");
    return row.generation_id;
  }

  private generationIdFor(active: ActiveRun, requestedGenerationId: string): string {
    return active.generationProvenance.get(requestedGenerationId) ?? requestedGenerationId;
  }

  private evidenceFollowUpItems(followUp: ReturnType<EvidenceFollowUpRepository["find"]> & {}): WorkflowV2EvidenceItem[] {
    const sourceIds = followUp.sourceIds;
    const factorIds = followUp.factorIds;
    const sources = sourceIds.length ? this.options.db.db.prepare(`SELECT id, title, canonical_url AS url FROM sources WHERE id IN (${sourceIds.map(() => "?").join(",")})`).all(...sourceIds) : [];
    const factors = factorIds.length ? this.options.db.db.prepare(`SELECT id, source_id AS sourceId, subject, behavior, quote,
      model_confidence AS modelConfidence, uncertainty, source_role AS sourceRole, audience_fit AS audienceFit,
      independent_source_key AS independentSourceKey, supports_demand AS supportsDemand,
      demand_evidence_uncertainty AS demandEvidenceUncertainty
      FROM factors WHERE id IN (${factorIds.map(() => "?").join(",")})`).all(...factorIds) : [];
    const sentinel = { sourceId: "scraply:evidence-follow-up-outcome", content: { question: followUp.question, status: "completed",
      searchedSourceCount: sourceIds.length, quoteVerifiedObservationCount: factorIds.length,
      conclusion: factorIds.length === 0 ? "The follow-up found no new quote-verified support." : "Only the quote-verified observations below are new evidence." } };
    return [sentinel, ...factors.map((factor) => {
      const saved = factor as Record<string, unknown> & { id: string; sourceId: string };
      const sourceId = saved.sourceId;
      return { sourceId: `scraply:evidence-follow-up-factor:${saved.id}`, content: {
        factor: { ...saved, supportsDemand: Boolean(saved.supportsDemand) },
        source: sources.find((item) => (item as { id: string }).id === sourceId) ?? { id: sourceId },
      } };
    })];
  }

  private failEvidenceReassessment(active: ActiveRun, error: unknown): void {
    if (this.activeRuns.get(active.runId) !== active) return;
    if (active.deadlineTimer) clearTimeout(active.deadlineTimer);
    this.activeRuns.delete(active.runId);
    const message = error instanceof Error ? error.message : "Evidence reassessment failed";
    this.ledger.settleUncertain(active.runId, message);
    const followUp = this.followUps.find(active.runId);
    if (followUp?.reassessmentStatus === "running") this.options.db.immediateTransaction(() => this.followUps.failReassessment(active.runId, message));
    this.runs.finish(active.runId, "completed", "Evidence reassessment failed");
    this.updateThread(active.threadId, "solutions-ready");
    this.emit({ type: "run-failed", runId: active.runId, threadId: active.threadId, error: message });
  }
}

type RuntimeStage =
  | "queued" | "searching" | "extracting" | "synthesizing-problems"
  | "generating-options" | "awaiting-option-selection" | "evaluating-risk"
  | "analyzing-option" | "evidence-follow-up" | "completed" | "failed" | "cancelled";

function runtimeStage(stageKey: string): RuntimeStage {
  const stage = stageKey.split(":")[0];
  if (stage === "query-plan") return "searching";
  if (stage === "factor-harvest") return "extracting";
  if (stage === "problem-candidates" || stage === "problem-kill") return "synthesizing-problems";
  if (stage === "solutions") return "generating-options";
  if (stage === "risk-evaluation") return "evaluating-risk";
  if (stage === "decision-analysis") return "analyzing-option";
  return "queued";
}

function reportedCost(metadata: GenerationMetadata): number | null {
  return reportedAttemptCost(metadata.attempts);
}

function reportedAttemptCost(attempts: GenerationMetadata["attempts"]): number | null {
  if (attempts.length === 0 || attempts.some((attempt) => attempt.cost.status !== "reported")) return null;
  const reported = attempts.map((attempt) => {
    if (attempt.cost.status !== "reported") throw new Error("Unreachable attempt cost state");
    return attempt.cost.value;
  });
  if (reported.some((cost) => cost.currency?.toUpperCase() !== "USD")) return null;
  return reported.reduce((total, cost) => total + cost.amount, 0);
}

function parseStringArray(json: string): string[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("Saved option evidence IDs are invalid.");
  }
  return parsed;
}

type PersistableOpportunityExpansion = Omit<OpportunityExpansionOutput, "options"> & {
  options: Array<OpportunityExpansionOutput["options"][number] & { id: string }>;
};

function parseSavedExpansion(value: unknown): PersistableOpportunityExpansion {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Saved opportunity expansion is invalid.");
  const record = value as Record<string, unknown>;
  const output = OpportunityExpansionOutputSchema.parse(record.output);
  if (!Array.isArray(record.candidateIds) || record.candidateIds.some((id) => typeof id !== "string")) {
    throw new Error("Saved opportunity expansion candidate IDs are invalid.");
  }
  return withExpansionIds(output, record.candidateIds as string[]);
}

function withExpansionIds(output: OpportunityExpansionOutput, ids: string[]): PersistableOpportunityExpansion {
  if (output.options.length !== ids.length) throw new Error("Opportunity expansion candidate IDs do not match its options.");
  return { ...output, options: output.options.map((option, index) => ({ ...option, id: ids[index]! })) };
}

function validateExpansionEvidence(
  expansion: OpportunityExpansionOutput,
  allowedEvidenceIds: string[],
  gap: OpportunityCoverageGap,
): boolean {
  const allowed = new Set(allowedEvidenceIds);
  if (expansion.problemHypothesis.evidenceIds.some((id) => !allowed.has(id))) {
    throw new Error("Opportunity problem hypothesis referenced evidence that was not supplied.");
  }
  if (gap.candidateOrigin === "exploratory-allowed" && expansion.problemHypothesis.evidenceIds.length > 0) {
    throw new Error("Exploratory problem hypotheses cannot claim supporting evidence.");
  }
  for (const option of expansion.options) {
    const referenced = [
      ...option.supportingEvidenceIds,
      ...option.contraryEvidenceIds,
      ...option.startupOpportunity.gapAssessment.evidenceIds,
    ];
    if (referenced.some((id) => !allowed.has(id))) throw new Error("Opportunity expansion referenced evidence that was not supplied.");
    if (gap.candidateOrigin === "exploratory-allowed") {
      if (referenced.length > 0 || option.startupOpportunity.gapAssessment.kind !== "hypothesis") {
        throw new Error("Exploratory opportunity candidates cannot claim supporting evidence.");
      }
    }
  }
  return gap.candidateOrigin === "exploratory-allowed" || expansion.problemHypothesis.evidenceIds.length > 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
