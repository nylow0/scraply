import { createHash, randomUUID } from "node:crypto";
import type { DatabaseClient } from "../db/client";
import { CostLedgerRepository, type CostReservation } from "../db/repositories/cost-ledger";
import { DiscoveryRepository } from "../db/repositories/discovery";
import { EvidenceFollowUpRepository } from "../db/repositories/evidence-follow-ups";
import { GenerationAttemptRepository } from "../db/repositories/generation-attempts";
import { FocusedExperimentRepository } from "../db/repositories/focused-experiments";
import { ResearchRunRepository, type ResearchRunWorkflowLink } from "../db/repositories/research-runs";
import { OpportunityRepository } from "../db/repositories/opportunities";
import { OpportunityExplorationRepository } from "../db/repositories/opportunity-exploration";
import { WorkflowV2Repository } from "../db/repositories/workflow-v2";
import { WorkflowRepository } from "../db/repositories/workflows";
import { ResearchFrameRepository } from "../db/repositories/research-frames";
import type { SearchClient, SearchOptions, SearchProvider, SearchProviderChoice } from "../providers/search";
import { chooseSearchProvider, filterRoutedSources } from "../providers/source-routes";
import { validateResearchVenues, type ResearchVenueResolver, type VenueVerificationResult } from "../providers/venue-validation";
import { ProviderFailure, type GenerationMetadata, type StructuredModelClient, type StructuredStageRequest } from "../providers/structured";
import { AppError } from "../shared/errors";
import { WorkflowLaunchContractSchema } from "../shared/workflow-contracts";
import { framedDiscoveryProjection } from "../shared/discovery-projection";
import { ResearchFrameSchema, scopeResearchArea, type ResearchFrame, type ResearchArea } from "../shared/research-frame";
import { RESEARCH_TARGETS, candidateAssessmentProjection, InvestigatorSearchRouteSchema, researchTargetProgress } from "../shared/evidence-investigators";
import { assertCriteriaFit, frameNeedsNoveltySearch } from "../shared/solution-goal-fit";
import { assertFocusedDemandTestSemantics } from "../shared/focused-experiment";
import { deriveJsonSchema } from "../shared/json-schema";
import type { ResearchEvent } from "../shared/ipc";
import { opportunityCounts } from "../shared/opportunity-review";
import { researchSearchAllocation, type ResearchAngleSourceClass } from "../shared/research-revisions";
import {
  type OpportunityBudgetExtension,
  type OpportunityBudgetExtensionPreview,
  OpportunityCoverageMapOutputSchema,
  type OpportunityCoverageGap,
  type OpportunityExpansionOutput,
  type OpportunityExplorationConfig,
  type OpportunityExplorationProgress,
} from "../shared/opportunity-exploration";
import { DEFAULT_IDEA_COUNT, ModelRefSchema, ReasoningEffortSchema, RunConfigSchema, SourceSchema, sameModelRef, type ModelRef, type ReasoningEffort, type RunConfig, type Source } from "../shared/schemas";
import { ScopeSchema, SavedProblemCandidateSchema, WorkflowV2CompatibleDecisionAnalysisOutputSchema, WorkflowV2GoalSolutionOptionSchema, WorkflowV2RiskEvaluationOutputSchema, WorkflowV2RiskReassessmentOutputSchema, WorkflowV2SolutionOptionSchema, WorkflowV2SolutionsOutputSchema, WorkflowV2StartupSolutionOptionSchema, type Scope } from "../shared/structured-output-schemas";
import { analyzeSelectedOption, developmentStageEvidence, evaluateSelectedOptionRisk, produceDevelopmentOptions, reassessSelectedOption, reassessSelectedOptionRisk, WorkflowGenerationAngleSchema, WorkflowGenerationEvidenceSchema, type WorkflowV2DevelopmentContext, type WorkflowV2EvidenceItem } from "./development";
import { DEFAULT_PROBLEM_CANDIDATE_LIMIT, DISCOVERY_DEPTHS, discoverProblems, discoveryRunProjection, harvestEvidenceFollowUp, harvestFactors, normalizeSearchQuery,
  type HarvestMode, type HarvestResult, type PlannedQuery, type DiscoveryProblem, type HarvestedFactor, type HarvestedSource,
  qualifiesAsProblemObservation, quoteAppearsVerbatim, safeCanonicalizeUrl, type ProblemDiscoveryResult, type DiscoveryDependencies } from "./discovery";
import { assessNotAssessedCandidate, ensureAreaInvestigatorWorkItems, ensureEvidenceCheckWorkItem,
  enforceConfirmationRule, runAreaGapInvestigation, runCandidateEvidenceInvestigator, runManagedInvestigatorSearch,
  type InvestigatorDependencies } from "./evidence-investigators";
import { ensureSolutionNoveltyEvidence } from "./solution-novelty";
import { opportunityExpansionContract, parseOpportunityExpansionOutput } from "./opportunity-expansion-contract";
import { generateResearchFrame } from "./research-frame";
import { rankScannedAreas, scanResearchArea, type AreaScan } from "./frame-discovery";
import { runFocusedExperimentFlow } from "./experiment-review";
import { planOpportunityStep, previewOpportunityBudgetExtension } from "./opportunity-planning";
import { reviewSavedOpportunities as runOpportunityReview } from "./opportunity-review";
import { classifySolutionSetReview, prepareSolutionSetReview, reviewSolutionSet, type SolutionSetItem, type SolutionSetReviewOutput } from "./solution-set-review";
import { scheduledModelClient } from "./scheduled-model-client";
import type { WorkflowModelScheduler } from "./workflow-scheduler";
import { WorkflowExecution } from "./workflow-execution";
import type { WorkflowV2StageId } from "./stages";

export interface ResearchEngineOptions {
  db: DatabaseClient;
  modelClients?: Partial<Record<string, StructuredModelClient>>;
  modelScheduler?: WorkflowModelScheduler;
  searchClients?: Partial<Record<SearchProvider, SearchClient>>;
  searchReady?: () => Partial<Record<SearchProvider, boolean>>;
  venueResolver?: ResearchVenueResolver;
  onEvent: (event: ResearchEvent) => void;
}

interface ActiveRun {
  runId: string;
  threadId: string;
  problemId: string | null;
  config: RunConfig;
  abortController: AbortController;
  startedAt: number;
  projectedCodexCalls: number;
  projectedSearches: number;
  researchAllowance?: { maxModelCalls: number; maxSearches: number };
  researchRequest?: { sessionId: string; workItemId: string };
  workflow?: WorkflowExecution;
  acknowledgedAttemptIds?: readonly string[];
  followUpModelReservation: CostReservation | null;
  followUpSearchReservation: CostReservation | null;
  generationProvenance: Map<string, string>;
  stage?: RuntimeStage;
  modelState?: "waiting" | "dispatched" | "accepted" | null;
  areaBudget?: { areaId: string; maxModelCalls: number; maxSearches: number; pendingSearches?: number };
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
  private readonly opportunities: OpportunityRepository;
  private readonly opportunityTasks = new Map<string, OpportunityTask>();
  private readonly opportunityErrors = new Map<string, string>();

  constructor(private readonly options: ResearchEngineOptions) {
    this.runs = new ResearchRunRepository(options.db);
    this.ledger = new CostLedgerRepository(options.db);
    this.generationAttempts = new GenerationAttemptRepository(options.db);
    this.followUps = new EvidenceFollowUpRepository(options.db);
    this.discovery = new DiscoveryRepository(options.db);
    this.opportunities = new OpportunityRepository(options.db);
    recoverInterruptedEvidenceFollowUps(options.db);
    this.opportunities.recoverInFlightReviewCalls();
    options.db.immediateTransaction(() =>
      new OpportunityExplorationRepository(options.db).recoverInterruptedExplorations());
  }

  getActiveRunIds(): ReadonlySet<string> { return new Set(this.activeRuns.keys()); }

  hasActiveWork(): boolean { return this.activeRuns.size > 0 || this.opportunityTasks.size > 0; }

  /** Session work outside a research run shares the same per-project model scheduler. */
  scheduledWorkflowModelClient(threadId: string, model: ModelRef): StructuredModelClient {
    const client = this.options.modelClients?.[model.providerId];
    if (!client) throw new AppError("conflict", `Model provider ${model.providerId} is unavailable`);
    return this.options.modelScheduler
      ? scheduledModelClient(client, this.options.modelScheduler, threadId) : client;
  }

  workflowSearchClient(choice: SearchProviderChoice): SearchClient {
    const readiness = this.options.searchReady?.();
    const provider = chooseSearchProvider(choice, {
      exa: Boolean(this.options.searchClients?.exa) && readiness?.exa !== false,
      perplexity: Boolean(this.options.searchClients?.perplexity) && readiness?.perplexity !== false,
    });
    const client = this.options.searchClients?.[provider];
    if (!client) throw new AppError("conflict", `Search provider ${provider} is unavailable`);
    return client;
  }

  async shutdown(): Promise<void> {
    for (const runId of this.getActiveRunIds()) {
      try { this.cancelRun(runId); } catch { /* the run ended before shutdown reached it */ }
    }
    for (const task of this.opportunityTasks.values()) task.controller.abort(new Error("App is shutting down"));
    await Promise.allSettled([...this.executions.values()]);
    await Promise.allSettled([...this.opportunityTasks.values()].map((task) => task.promise));
  }

  async startDiscovery(threadId: string, scope: Scope, config: RunConfig, workflow?: ResearchRunWorkflowLink): Promise<string> {
    config = { ...config, workflowVersion: 2 };
    const parsedScope = ScopeSchema.parse(scope);
    const created = this.runs.create(threadId, config, null, undefined, workflow);
    if (!created.created) return created.runId;
    this.discovery.persistScope(created.runId, parsedScope);
    if (workflow?.frameId) {
      new ResearchFrameRepository(this.options.db).bindRun(created.runId, threadId, workflow.frameId);
      this.options.db.db.prepare("INSERT INTO workflow_snapshots VALUES (?, 'frame-workflow', ?)").run(created.runId, JSON.stringify({ version: 1 }));
    }
    if (!this.admitWorkflowRun(created.runId, threadId, workflow)) return created.runId;
    this.begin(created.runId, threadId, null, config);
    return created.runId;
  }

  /** Frame preparation is a normal checkpointed run, linked before any provider call. */
  async startResearchFrame(threadId: string, scope: Scope, config: RunConfig, workflow: ResearchRunWorkflowLink,
    regeneration?: { frameId: string; edited: ResearchFrame }): Promise<string> {
    config = { ...config, workflowVersion: 2 };
    const created = this.runs.create(threadId, config, null, undefined, workflow);
    if (!created.created) return created.runId;
    this.discovery.persistScope(created.runId, ScopeSchema.parse(scope));
    this.options.db.db.prepare("INSERT INTO workflow_snapshots VALUES (?, 'workflow-kind', ?)").run(created.runId,
      JSON.stringify({ kind: "prepare-frame", knownProblem: config.researchMode === "known-problem", ...(regeneration ? { regeneration } : {}) }));
    if (!this.admitWorkflowRun(created.runId, threadId, workflow)) return created.runId;
    this.begin(created.runId, threadId, null, config);
    return created.runId;
  }

  async startKnownProblem(threadId: string, scope: Scope, problemStatement: string, config: RunConfig, workflow?: ResearchRunWorkflowLink): Promise<string> {
    config = { ...config, workflowVersion: 2 };
    const parsedScope = ScopeSchema.parse(scope);
    const statement = problemStatement.trim();
    if (!statement) throw new AppError("validation_error", "Problem statement is required.");
    const root = this.discovery.createKnownProblemRoot(threadId, parsedScope, statement, config, workflow);
    return this.startProblem(threadId, root.problemId, config, workflow);
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

  /** New workflow sessions select an exact saved problem instead of relying on the latest discovery run. */
  async startSelectedProblem(threadId: string, problemId: string, config: RunConfig, workflow?: ResearchRunWorkflowLink): Promise<string> {
    const owner = this.options.db.db.prepare(`
      SELECT 1 FROM problems p
      JOIN research_runs discovery ON discovery.id = p.discovery_run_id
      WHERE p.id = ? AND discovery.thread_id = ? AND discovery.status = 'completed'
    `).get(problemId, threadId);
    if (!owner) throw new AppError("not_found", "Selected problem does not belong to this project.");
    return this.startProblem(threadId, problemId, config, workflow);
  }

  private startProblem(threadId: string, problemId: string, config: RunConfig, workflow?: ResearchRunWorkflowLink): string {
    config = { ...config, workflowVersion: 2 };
    const created = this.runs.create(threadId, config, problemId, undefined, workflow);
    if (created.created) {
      const frames = new ResearchFrameRepository(this.options.db);
      const frame = workflow?.frameId ? frames.get(workflow.frameId) : frames.latestApproved(threadId);
      if (frame?.approved) {
        frames.bindRun(created.runId, threadId, frame.id);
        this.options.db.db.prepare("INSERT INTO workflow_snapshots VALUES (?, 'goal-fit', ?)").run(created.runId, JSON.stringify({ version: 1 }));
        this.options.db.db.prepare("INSERT INTO workflow_snapshots VALUES (?, 'goal-fit-frame', ?)")
          .run(created.runId, JSON.stringify({ frameId: frame.id, frame: frame.approved }));
      }
    }
    if (created.created && this.admitWorkflowRun(created.runId, threadId, workflow)) {
      this.begin(created.runId, threadId, problemId, config);
    }
    return created.runId;
  }

  /** A user-requested assessment preserves the saved candidate and copies its evidence into a new run. */
  async startCandidateAssessment(threadId: string, sourceRunId: string, candidateId: string, config: RunConfig,
    workflow: ResearchRunWorkflowLink): Promise<string> {
    const row = this.options.db.db.prepare(`SELECT candidate.candidate_json FROM rejected_problem_candidates candidate
      JOIN research_runs run ON run.id = candidate.discovery_run_id
      WHERE candidate.id = ? AND candidate.discovery_run_id = ? AND run.thread_id = ?
        AND candidate.disposition = 'not-assessed'`).get(candidateId, sourceRunId, threadId) as { candidate_json: string | null } | undefined;
    if (!row?.candidate_json) throw new AppError("not_found", "This saved candidate is unavailable or has no complete evidence record.");
    const candidate = SavedProblemCandidateSchema.parse(JSON.parse(row.candidate_json));
    const scope = this.readScope(sourceRunId);
    config = { ...config, workflowVersion: 2 };
    const created = this.runs.create(threadId, config, null, undefined, workflow);
    if (!created.created) return created.runId;
    this.discovery.persistScope(created.runId, scope);
    this.options.db.db.prepare("INSERT INTO workflow_snapshots VALUES (?, 'workflow-kind', ?)")
      .run(created.runId, JSON.stringify({ kind: "candidate-assessment", sourceRunId, candidateId, candidate }));
    const frames = new ResearchFrameRepository(this.options.db);
    // New admissions explicitly freeze an approved frame or a scope-derived fallback; older pending requests retain their source run's frame.
    const frame = workflow.frameId === undefined ? frames.forRun(sourceRunId) : workflow.frameId ? frames.get(workflow.frameId) : null;
    if (frame?.approved) new ResearchFrameRepository(this.options.db).bindRun(created.runId, threadId, frame.id);
    if (this.admitWorkflowRun(created.runId, threadId, workflow)) this.begin(created.runId, threadId, null, config);
    return created.runId;
  }

  private readScope(runId: string): Scope {
    const row = this.options.db.db.prepare(`SELECT title,audience,domain,observations,off_limits_json,risk_evaluation_criteria
      FROM scopes WHERE research_run_id = ?`).get(runId) as {
      title: string; audience: string; domain: string; observations: string; off_limits_json: string; risk_evaluation_criteria: string;
    } | undefined;
    if (!row) throw new AppError("not_found", "The saved research scope is missing.");
    return ScopeSchema.parse({ title: row.title, audience: row.audience, domain: row.domain, observations: row.observations,
      offLimits: JSON.parse(row.off_limits_json), ...(row.risk_evaluation_criteria ? { riskEvaluationCriteria: row.risk_evaluation_criteria } : {}) });
  }

  private persistFrameSources(runId: string, sources: Source[]): void {
    const now = new Date().toISOString();
    const records = sources.filter(source => !this.options.db.db.prepare("SELECT 1 FROM sources WHERE id = ?").get(source.id))
      .map(source => ({ id: source.id, providerSourceId: source.id, canonicalUrl: source.url, url: source.url,
        title: source.title, retrievedText: source.text, author: source.author ?? null, publishedAt: source.publishedDate ?? null,
        contentHash: createHash("sha256").update(source.text).digest("hex"), retrievedAt: now }));
    if (records.length) this.discovery.persistFactors(runId, records, []);
  }

  private admitWorkflowRun(runId: string, threadId: string, workflow?: ResearchRunWorkflowLink): boolean {
    try {
      if (workflow?.onRunCreated?.(runId) !== false) return true;
      this.runs.finish(runId, "cancelled", "Stopped before provider dispatch.");
      this.emit({ type: "run-cancelled", runId, threadId });
      return false;
    } catch (error) {
      this.runs.finish(runId, "failed", error instanceof Error ? error.message : "Unable to start workflow run.");
      throw error;
    }
  }

  // Restart and explicit recovery honor saved acknowledgements; completed discovery also needs a reassessment policy.
  async resumeRun(runId: string, acknowledgedAttemptIds: readonly string[] = [], reassessProblems = false): Promise<void> {
    if (this.activeRuns.has(runId)) return;
    const row = this.options.db.db.prepare(`SELECT thread_id, status, config_json, problem_id FROM research_runs WHERE id = ?`)
      .get(runId) as { thread_id: string; status: string; config_json: string; problem_id: string | null } | undefined;
    const config = row ? RunConfigSchema.parse(JSON.parse(row.config_json)) : null;
    if (config && config.workflowVersion !== 2) {
      throw new AppError("conflict", "Legacy generation has been retired. Your saved results are preserved. Start a new run to use the current prompts.");
    }
    const completedAssessment = reassessProblems && row?.status === "completed" && !row.problem_id
      && this.options.db.db.prepare(`SELECT 1 FROM scopes scope JOIN workflow_snapshots snapshot ON snapshot.research_run_id = scope.research_run_id
        WHERE scope.research_run_id = ? AND trim(scope.audience) = '' AND snapshot.snapshot_key = 'problem-audience-assessment'
          AND json_extract(snapshot.value_json, '$.version') = 1
          AND NOT EXISTS(SELECT 1 FROM workflow_snapshots WHERE research_run_id = scope.research_run_id AND snapshot_key = 'discovery-completed:audience-v1')`)
        .get(runId);
    if (!row || !config || (!completedAssessment && !["queued", "running", ...(config.workflowVersion === 2 ? ["failed", "cancelled"] : [])].includes(row.status))) {
      throw new AppError("conflict", "This research run has already ended and cannot be resumed.");
    }
    const acknowledged = [...new Set([...new WorkflowRepository(this.options.db).acknowledgedAttemptIds(runId), ...acknowledgedAttemptIds])];
    if (new WorkflowRepository(this.options.db).unknownInvestigatorSearches(runId, acknowledged).length) {
      this.ledger.settleUncertain(runId, "A dispatched investigator search lost its terminal result during restart");
      throw new AppError("conflict", "A previous investigator search may have completed before its result was saved. Review this request before explicitly retrying it.");
    }
    const resumeSafety = this.generationAttempts.getResumeSafety(runId, acknowledged);
    if (!resumeSafety.canResume) {
      this.ledger.settleUncertain(runId, "A dispatched generation lost its terminal result during restart");
      throw new AppError("conflict", `${resumeSafety.resumeBlockedReason} Review this request before explicitly retrying it.`);
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
    this.begin(runId, row.thread_id, row.problem_id, config, true, acknowledged);
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
    const view = this.opportunities.familyView(threadId);
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
    const search = this.workflowSearchClient(config.searchProvider);
    if (!search) throw new Error(`Search provider ${config.searchProvider} is unavailable.`);
    const attempt = this.options.db.immediateTransaction(() => repository.prepareAttempt(threadId, {
      stageKey,
      stageName: "gap-search",
      input: { gapId: gap.id, evidenceNeeded: gap.evidenceNeeded, query: gap.searchQuery, numResults: 5 },
      model: { providerId: search.provider, modelId: "search", reasoningEffort: "bounded" },
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
    const existingAttempt = repository.loadAttempt(threadId, stageKey);
    const frozenInput = existingAttempt?.input as { frame?: ResearchFrame; frameId?: string; schemaRevision?: number } | undefined;
    const approved = existingAttempt ? null : new ResearchFrameRepository(this.options.db).latestApproved(threadId);
    const expansionContract = opportunityExpansionContract(frozenInput?.frame ?? approved?.approved ?? undefined);
    const frameId = frozenInput?.frameId ?? approved?.id;
    const evidence = this.opportunityExpansionEvidence(threadId, searchedSources);
    const view = this.opportunities.familyView(threadId);
    const instruction = ["Generate one small batch for the named coverage gap. Every option must be a distinct startup opportunity with a paying customer, smallest sellable workflow, and one structured focusedDemandTest for the most decision-relevant demand assumption. Do not repeat accepted families. Preserve weak evidence as uncertainty. Reference only supplied evidence IDs. An evidence-backed new problem must name nonempty problemHypothesis.evidenceIds that directly support the problem. When exploratory mode is used, every evidence-ID list must be empty and the gap assessment must remain a hypothesis.", expansionContract.instruction].filter(Boolean).join("\n\n");
    const attempt = this.options.db.immediateTransaction(() => repository.prepareAttempt(threadId, {
      stageKey,
      stageName: "gap-generation",
      input: { batchId, gap, candidateCount, acceptedFamilies: view.families, evidenceIds: evidence.map((item) => item.sourceId),
        schemaRevision: expansionContract.schemaRevision, ...(expansionContract.frame ? { frame: expansionContract.frame, frameId } : {}) },
      model: { ...model, reasoningEffort },
      promptVersion: expansionContract.promptVersion,
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
          inputs: { gap, candidateCount, allowedEvidenceIds: evidence.map((item) => item.sourceId),
            ...(expansionContract.frame ? { frame: expansionContract.frame } : {}) },
          definitionOfDone: ["Return fewer candidates rather than padding.", "Keep problem evidence and exploratory origin explicit.", "Give every option a stable short demand test with an explicit selection reason and decision impact."],
          constraints: ["Do not invent evidence or repeat an accepted family."],
        },
        evidence: [
          { sourceId: "scraply:accepted-opportunity-families", content: view.families },
          ...evidence,
        ],
        schema: expansionContract.schema,
        jsonSchema: deriveJsonSchema(expansionContract.schema),
        repairPolicy: "disabled",
        signal,
        onDispatched: () => this.options.db.immediateTransaction(() => repository.markAttemptDispatched(threadId, attempt.attemptId, "none")),
      });
      const parsed = parseOpportunityExpansionOutput(result.output, { schemaRevision: expansionContract.schemaRevision,
        ...(expansionContract.frame ? { frame: expansionContract.frame } : {}), evidenceSourceIds: evidence.map(item => item.sourceId) });
      for (const option of parsed.options) assertFocusedDemandTestSemantics(option.focusedDemandTest);
      if (parsed.options.length > candidateCount) throw new Error("Opportunity expansion returned more candidates than requested.");
      const problemSupported = validateExpansionEvidence(parsed, evidence.map((item) => item.sourceId), gap);
      const acceptedOutput = problemSupported ? parsed : { ...parsed, options: [] };
      const candidateIds = acceptedOutput.options.map(() => randomUUID());
      const savedResult = { ...(problemSupported
        ? { output: acceptedOutput, candidateIds }
        : {
            output: acceptedOutput,
            candidateIds,
            rejectedOutput: parsed,
            rejectionReason: "The evidence-only expansion did not cite supplied evidence for its new problem hypothesis.",
          }), schemaRevision: expansionContract.schemaRevision,
        ...(expansionContract.frame ? { frame: expansionContract.frame, frameId } : {}), evidenceSourceIds: evidence.map(item => item.sourceId) };
      this.options.db.immediateTransaction(() => repository.completeAttempt(threadId, attempt.attemptId, savedResult));
      return { ...withExpansionIds(acceptedOutput, candidateIds),
        ...(expansionContract.frame ? { frame: expansionContract.frame, ...(frameId ? { frameId } : {}) } : {}) };
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
      if (expansion.frameId && expansion.frame) {
        new ResearchFrameRepository(this.options.db).bindRun(runId, threadId, expansion.frameId);
        new WorkflowExecution(this.options.db, runId).save("goal-fit", { version: 1 });
        new WorkflowExecution(this.options.db, runId).save("goal-fit-frame", { frameId: expansion.frameId, frame: expansion.frame });
      }
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
    const families = this.opportunities.familyView(threadId);
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
    if (this.usesWorkGuidance(active.runId)) return this.instrumentedModel(active);
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
    if (!safety.canResume) throw new AppError("conflict", `${safety.resumeBlockedReason} Review this request before explicitly retrying it.`);
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

  private begin(runId: string, threadId: string, problemId: string | null, config: RunConfig, resumed = false,
    acknowledgedAttemptIds: readonly string[] = []): void {
    if (config.workflowVersion !== 2) throw new AppError("conflict", "Legacy generation has been retired. Start a new run to use the current prompts.");
    const selected = problemId && this.options.db.db.prepare(`SELECT 1 FROM solutions
      WHERE research_run_id = ? AND selected_at IS NOT NULL LIMIT 1`).get(runId);
    const kindRow = this.options.db.db.prepare("SELECT value_json FROM workflow_snapshots WHERE research_run_id = ? AND snapshot_key = 'workflow-kind'")
      .get(runId) as { value_json: string } | undefined;
    const savedKind = kindRow ? JSON.parse(kindRow.value_json) as { kind: string; knownProblem: boolean; regeneration?: unknown } : null;
    const framed = this.options.db.db.prepare("SELECT 1 FROM workflow_snapshots WHERE research_run_id = ? AND snapshot_key = 'frame-workflow'").get(runId);
    const boundFrame = new ResearchFrameRepository(this.options.db).forRun(runId)?.approved;
    const routedSearches = Boolean(this.options.db.db.prepare("SELECT 1 FROM workflow_snapshots WHERE research_run_id = ? AND snapshot_key = 'source-routes'").get(runId));
    const projection = savedKind?.kind === "prepare-frame"
      ? { modelCalls: savedKind.regeneration || savedKind.knownProblem ? 1 : 2, searches: savedKind.regeneration || savedKind.knownProblem ? 0 : 5 }
      : savedKind?.kind === "candidate-assessment" ? candidateAssessmentProjection(config.discoveryDepth)
      : problemId
      ? { modelCalls: selected ? this.ledger.countProviderCalls(runId, config.model.providerId) + 4 : 3, searches: 0 }
      : framed ? framedDiscoveryProjection(config.discoveryDepth, boundFrame?.languages.length ?? 3)
        : discoveryRunProjection(config.discoveryDepth, routedSearches ? undefined : DEFAULT_PROBLEM_CANDIDATE_LIMIT, 1, routedSearches);
    const active: ActiveRun = {
      runId, threadId, problemId, config, abortController: new AbortController(), startedAt: Date.now(),
      projectedCodexCalls: projection.modelCalls, projectedSearches: projection.searches,
      followUpModelReservation: null, followUpSearchReservation: null,
      generationProvenance: new Map(),
      acknowledgedAttemptIds,
    };
    const request = this.options.db.db.prepare(`
      SELECT wi.id, wi.session_id,
             json_extract(wi.input_json, '$.action.allowance.maxModelCalls') AS max_model_calls,
             json_extract(wi.input_json, '$.action.allowance.maxSearches') AS max_searches
      FROM workflow_work_items wi
      WHERE wi.kind = 'research-request'
        AND json_extract(wi.output_refs_json, '$.runId') = ?
      LIMIT 1
    `).get(runId) as { id: string; session_id: string; max_model_calls: number; max_searches: number } | undefined;
    if (request) active.researchAllowance = {
      maxModelCalls: request.max_model_calls, maxSearches: request.max_searches,
    };
    if (request) active.researchRequest = { sessionId: request.session_id, workItemId: request.id };
    this.activeRuns.set(runId, active);
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
    active.workflow = new WorkflowExecution(this.options.db, active.runId, active.acknowledgedAttemptIds);
    if (active.workflow.read<{ kind: string }>("workflow-kind")?.kind === "prepare-frame") await this.executeFrame(active);
    else if (active.workflow.read<{ kind: string }>("workflow-kind")?.kind === "candidate-assessment") await this.executeCandidateAssessment(active);
    else if (active.problemId) await this.executeDevelopment(active);
    else await this.executeDiscovery(active);
    if (active.abortController.signal.aborted || this.activeRuns.get(active.runId) !== active) return;
    const targetOutcome = active.workflow.read<{ outcome: string; reason: string }>("research-target-outcome")
      ?? active.workflow.read<{ outcome: string; reason: string }>("generation-partial-outcome");
    this.runs.finish(active.runId, "completed", targetOutcome?.outcome === "partial" ? targetOutcome.reason : undefined);
    this.activeRuns.delete(active.runId);
    this.emit({ type: "run-completed", runId: active.runId, threadId: active.threadId, problemId: active.problemId });
    if (!active.problemId) { this.updateThread(active.threadId, "problems-ready"); return; }
    // A workflow session advances from its explicit snapshot and task list. The legacy
    // latest-discovery handoff below remains only for runs created before that contract.
    const session = this.options.db.db.prepare("SELECT workflow_session_id FROM research_runs WHERE id = ?")
      .get(active.runId) as { workflow_session_id: string | null };
    if (session.workflow_session_id) {
      this.updateThread(active.threadId, "solutions-ready");
      return;
    }
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
    const boundFrame = new ResearchFrameRepository(this.options.db).forRun(active.runId)?.approved;
    if (boundFrame) await this.validateFrameSourceVenues(active, boundFrame);
    const deps = this.dependencies(active);
    if (active.workflow) {
      const workflow = active.workflow;
      if (workflow.read("frame-workflow")) {
        await this.executeFramedDiscovery(active, scope);
        return;
      }
      const completionKey = !scope.audience.trim() && workflow.read<{ version: number }>("problem-audience-assessment")?.version === 1
        ? "discovery-completed:audience-v1" : "discovery-completed";
      if (workflow.read(completionKey)) return;
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
        workflow.save(completionKey, result);
      });
      this.progress(active, `${result.problems.length} problems ready for your review`);
      return;
    }
    throw new AppError("conflict", "Legacy generation has been retired. Start a new run to use the current prompts.");
  }

  private async executeFrame(active: ActiveRun): Promise<void> {
    const workflow = active.workflow!;
    if (new ResearchFrameRepository(this.options.db).forRun(active.runId)) return;
    const kind = workflow.read<{ knownProblem: boolean; regeneration?: { frameId: string; edited: ResearchFrame } }>("workflow-kind")!;
    const scopeRow = this.options.db.db.prepare(`SELECT title, audience, domain, observations,
      off_limits_json, risk_evaluation_criteria FROM scopes WHERE research_run_id = ?`).get(active.runId) as {
        title: string; audience: string; domain: string; observations: string; off_limits_json: string; risk_evaluation_criteria: string;
      };
    const scope = ScopeSchema.parse({ title: scopeRow.title, audience: scopeRow.audience, domain: scopeRow.domain,
      observations: scopeRow.observations, offLimits: JSON.parse(scopeRow.off_limits_json),
      ...(scopeRow.risk_evaluation_criteria ? { riskEvaluationCriteria: scopeRow.risk_evaluation_criteria } : {}) });
    const frames = new ResearchFrameRepository(this.options.db);
    const previous = kind.regeneration ? frames.get(kind.regeneration.frameId) : null;
    if (kind.regeneration && (!previous || previous.threadId !== active.threadId)) throw new AppError("INVALID_REFERENCE");
    if (previous) workflow.save("frame-context-sources", previous.sources);
    const result = await generateResearchFrame(scope, kind.knownProblem, { ...this.dependencies(active), workflow,
      knownProblemStatement: active.config.knownProblem,
      onProgress: message => this.progress(active, message) }, kind.regeneration && previous
        ? { version: previous.version + 1, edited: kind.regeneration.edited } : undefined);
    this.persistFrameSources(active.runId, result.sources);
    frames.createDraft({ threadId: active.threadId, runId: active.runId, knownProblem: kind.knownProblem, ...result });
  }

  private async executeCandidateAssessment(active: ActiveRun): Promise<void> {
    const workflow = active.workflow!;
    const kind = workflow.read<{ sourceRunId: string; candidateId: string; candidate: unknown }>("workflow-kind")!;
    if (workflow.read("candidate-assessment-result")) return;
    const original = SavedProblemCandidateSchema.parse(kind.candidate);
    const scope = this.readScope(active.runId);
    const sourceArea = this.options.db.db.prepare(`SELECT area_id FROM factors WHERE research_run_id = ? AND id = ?`)
      .get(kind.sourceRunId, original.factorIds[0] ?? "") as { area_id: string | null } | undefined;
    const bound = new ResearchFrameRepository(this.options.db).forRun(active.runId);
    const approved = bound?.approved;
    const area: ResearchArea = approved?.areas.find(item => item.id === sourceArea?.area_id) ?? {
      id: sourceArea?.area_id ?? "saved-candidate", name: "Saved candidate evidence", whyRelevant: original.statement,
      affectedPeople: original.affected, venues: [{ name: "Open web", kind: "publication" }], exampleProblems: [original.statement], included: true, priority: 1,
    };
    const frame = approved ?? ResearchFrameSchema.parse({ goal: scope.title || original.statement, goalKind: "other",
      contextFacts: [], successCriteria: [{ id: "saved-scope", name: "Fit the saved research scope", weight: "must",
        howJudged: "Use the original scope and quoted observations to assess this candidate", basis: "brief" }],
      constraints: scope.offLimits.map(text => ({ text, kind: "scope", basis: "brief" })),
      languages: ["en"], areas: [area], exclusions: scope.offLimits, openQuestions: [] });
    if (!workflow.read("candidate-assessment-frame")) workflow.save("candidate-assessment-frame", { frame, provenance: approved && bound
      ? { kind: "approved-frame", frameId: bound.id, frameVersion: bound.version, sourceRunId: kind.sourceRunId, candidateId: kind.candidateId }
      : { kind: "reconstructed-from-saved-scope", sourceRunId: kind.sourceRunId, candidateId: kind.candidateId,
        note: "Reconstructed for this assessment from the saved scope and candidate. It is not an approved project frame." } });
    const evidenceKey = "candidate-assessment-evidence";
    let copied = workflow.read<{ candidate: typeof original; sources: HarvestedSource[]; factors: HarvestedFactor[] }>(evidenceKey);
    if (!copied) {
      const idFor = (id: string) => createHash("sha256").update(`${active.runId}:saved-candidate:${id}`).digest("hex").slice(0, 24);
      const sources = new Map<string, HarvestedSource>();
      const factors: HarvestedFactor[] = original.factorIds.map(id => {
        const row = this.options.db.db.prepare(`SELECT factor.*, source.provider_source_id, source.canonical_url,
          source.title, source.retrieved_text, source.author, source.published_at, source.content_hash, source.retrieved_at
          FROM factors factor JOIN sources source ON source.id = factor.source_id AND source.research_run_id = factor.research_run_id
          WHERE factor.id = ? AND factor.research_run_id = ?`).get(id, kind.sourceRunId) as {
          id: string; source_id: string; subject: string; behavior: string; quote: string; harvest_mode: "domain" | "audience";
          model_confidence: number; uncertainty: string | null; source_role: NonNullable<HarvestedFactor["sourceRole"]>;
          audience_fit: NonNullable<HarvestedFactor["audienceFit"]>; independent_source_key: string | null;
          supports_demand: number; demand_evidence_uncertainty: string | null;
          provider_source_id: string | null; canonical_url: string; title: string; retrieved_text: string;
          author: string | null; published_at: string | null; content_hash: string; retrieved_at: string;
        } | undefined;
        if (!row) throw new AppError("conflict", "A saved candidate factor or its quoted source is missing. The candidate was retained unchanged.");
        const source: HarvestedSource = { id: idFor(row.source_id), providerSourceId: row.provider_source_id,
          canonicalUrl: row.canonical_url, url: row.canonical_url, title: row.title, retrievedText: row.retrieved_text,
          author: row.author, publishedAt: row.published_at, contentHash: row.content_hash, retrievedAt: row.retrieved_at };
        sources.set(source.id, source);
        return { id: idFor(row.id), sourceId: source.id, source, subject: row.subject, behavior: row.behavior, quote: row.quote,
          harvestMode: row.harvest_mode, modelConfidence: row.model_confidence, uncertainty: row.uncertainty,
          sourceRole: row.source_role, audienceFit: row.audience_fit, independentSourceKey: row.independent_source_key,
          supportsDemand: Boolean(row.supports_demand), demandEvidenceUncertainty: row.demand_evidence_uncertainty };
      });
      copied = { candidate: { ...original, factorIds: original.factorIds.map(idFor),
        scaleBasisFactorId: original.scaleBasisFactorId === null ? null : idFor(original.scaleBasisFactorId),
        ...("intendedBuyerEvidenceFactorIds" in original ? { intendedBuyerEvidenceFactorIds: original.intendedBuyerEvidenceFactorIds.map(idFor) } : {}) },
        factors, sources: [...sources.values()] };
      this.discovery.persistFactors(active.runId, copied.sources, copied.factors, () => {
        this.assignArea("factors", copied!.factors.map(factor => factor.id), area.id);
        workflow.save(evidenceKey, copied);
      });
    }
    const owner = this.workflowRunOwner(active);
    await this.validateFrameSourceVenues(active, frame);
    const lane = ensureAreaInvestigatorWorkItems(this.options.db, owner.sessionId, owner.workItemId, area);
    this.startInvestigatorItem(lane.parent.id); this.startInvestigatorItem(lane.candidates.id);
    this.skipInvestigatorItem(lane.research.id, "Uses the saved candidate and its original evidence without resynthesis.");
    const problemId = createHash("sha256").update(`${active.runId}:${kind.candidateId}`).digest("hex").slice(0, 24);
    const check = ensureEvidenceCheckWorkItem(this.options.db, owner.sessionId, lane.candidates.id, area.id, problemId);
    this.startInvestigatorItem(check.id);
    const result = await assessNotAssessedCandidate({ ...this.investigatorDependencies(active, scope, frame, area, lane.parent.id,
      { ...this.areaDependencies(active, frame, area), stageScope: `area-${sha256Area(area.id)}` }),
      candidateId: problemId, candidate: copied.candidate, factors: copied.factors, existingSources: copied.sources });
    if (result.assessed) {
      this.persistAreaEvidence(active, area.id, result.sources, result.factors);
      this.discovery.persistProblems(active.runId, [], result.dropped ? [] : [result.problem], result.dropped
        ? [{ statement: result.problem.statement, reason: result.stopReason, disposition: "blocked", candidate: copied.candidate }] : [], () => {
          this.assignArea("problems", result.dropped ? [] : [problemId], area.id);
          workflow.save("candidate-assessment-result", { assessed: true, candidateId: kind.candidateId, sourceRunId: kind.sourceRunId,
            verdict: result.problem.verdict, dropped: result.dropped, stopReason: result.stopReason });
        });
      const view = this.investigatorView(area, "Assessment complete", { problems: result.dropped ? [] : [result.problem],
        blockedCandidates: result.dropped ? [{ statement: result.problem.statement, reason: result.stopReason, disposition: "blocked" }] : [] });
      this.finishInvestigatorItem(check.id, { verdict: result.problem.verdict, dropped: result.dropped, rounds: result.rounds });
      this.finishInvestigatorItem(lane.candidates.id); this.finishInvestigatorItem(lane.parent.id, { investigator: view });
    } else {
      workflow.save("candidate-assessment-result", { assessed: false, candidateId: kind.candidateId,
        sourceRunId: kind.sourceRunId, stopReason: result.stopReason });
      this.finishInvestigatorItem(check.id, { assessed: false, stopReason: result.stopReason });
      this.finishInvestigatorItem(lane.candidates.id); this.finishInvestigatorItem(lane.parent.id, { investigator: this.investigatorView(area, result.stopReason, null) });
    }
  }

  private async executeFramedDiscovery(active: ActiveRun, scope: Scope): Promise<void> {
    const workflow = active.workflow!;
    if (workflow.read("discovery-completed")) return;
    const saved = new ResearchFrameRepository(this.options.db).forRun(active.runId);
    const frame = saved?.approved;
    if (!frame || saved.knownProblem) throw new AppError("INVALID_REFERENCE", "An approved discovery frame is required.");
    this.seedFrameDiscoverySources(active.runId, saved.sources);
    await this.validateFrameSourceVenues(active, frame);
    const scans: AreaScan[] = [];
    for (const area of frame.areas.filter(area => area.included)) {
      active.abortController.signal.throwIfAborted();
      const key = `frame-scan:${area.id}`;
      let scan = workflow.read<AreaScan>(key);
      if (!scan) {
        scan = await scanResearchArea(scope, frame, area, { ...this.areaDependencies(active, frame, area), depth: "quick", repairPolicy: "disabled",
          stageScope: `scan-${sha256Area(area.id)}`, idFactory: workflow.idFactory(key), random: () => 0.5 });
        const validated = this.reconcileAreaEvidence(active.runId, scan.sources, workflow.withFactorUncertainty(scan.factors));
        scan = { ...scan, ...validated, qualifyingFacts: validated.factors.filter(qualifiesAsProblemObservation).length };
        const completed = scan;
        this.discovery.persistFactors(active.runId, scan.sources, scan.factors, () => {
          this.assignArea("factors", scan!.factors.map(factor => factor.id), area.id);
          workflow.save(key, completed);
        });
      }
      scans.push(scan);
    }
    const selected = await rankScannedAreas(frame, scans, active.config.discoveryDepth,
      { ...this.dependencies(active), workflow, onProgress: message => this.progress(active, message) });
    workflow.save("frame-selected-areas", selected);
    const owner = this.workflowRunOwner(active);
    const lanes = new Map(selected.map(area => [area.id, ensureAreaInvestigatorWorkItems(this.options.db,
      owner.sessionId, owner.workItemId, area)]));
    for (const area of selected) {
      const parent = lanes.get(area.id)!.parent;
      if (parent.state === "planned") this.updateInvestigatorLane(parent.id, area, "Queued", null);
    }
    const session = new WorkflowRepository(this.options.db).getSession(owner.sessionId)!;
    const contract = WorkflowLaunchContractSchema.parse(session.contract);
    const target = contract.targets.research ?? RESEARCH_TARGETS[active.config.discoveryDepth];
    const settledProblems = new Map<string, DiscoveryProblem & { areaId: string }>();
    for (const area of selected) for (const problem of workflow.read<ProblemDiscoveryResult>(`area:${area.id}:investigation-completed`)?.problems ?? []) {
      settledProblems.set(problem.id, { ...problem, areaId: area.id });
    }
    const targetStop = () => researchTargetProgress(target, [...settledProblems.values()]).outcome === "target-met"
      ? "The declared research target was met. Further evidence gaps and rounds were skipped." : null;
    const results: Array<{ areaId: string; result: ProblemDiscoveryResult }> = [];
    const partialReasons = new Map<string, string>();
    const maxModelCalls = Math.floor((this.remainingWorkflowTaskCalls(active, "model-call") ?? Infinity) / Math.max(1, selected.length));
    const maxSearches = Math.floor((this.remainingWorkflowTaskCalls(active, "search") ?? Infinity) / Math.max(1, selected.length));
    const rootActive = active;
    const investigateArea = async (area: ResearchArea): Promise<{ areaId: string; result: ProblemDiscoveryResult } | null> => {
      // Provider scheduling remains global; mutable allowances and progress belong to one area.
      const active: ActiveRun = { ...rootActive };
      const key = `area:${area.id}`;
      const scoped = scopeResearchArea(scope, area, frame);
      const dependencies = { ...this.areaDependencies(active, frame, area), repairPolicy: "disabled" as const, stageScope: `area-${sha256Area(area.id)}` };
      const lane = lanes.get(area.id)!;
      const alreadyInvestigated = workflow.read<ProblemDiscoveryResult>(`${key}:investigation-completed`);
      if (alreadyInvestigated) {
        return { areaId: area.id, result: alreadyInvestigated };
      }
      if (targetStop()) { partialReasons.set(area.id, targetStop()!); return null; }
      this.startInvestigatorItem(lane.parent.id);
      this.startInvestigatorItem(lane.research.id);
      this.updateInvestigatorLane(lane.parent.id, area, "Planning and reading sources", null);
      if (contract.limits.enforced !== false) {
        let allowance = workflow.read<NonNullable<ActiveRun["areaBudget"]>>(`${key}:allowance`);
        if (!allowance) {
          allowance = { areaId: area.id, maxModelCalls, maxSearches };
          workflow.save(`${key}:allowance`, allowance);
        }
        active.areaBudget = allowance;
      }
      let harvest = workflow.read<HarvestResult>(`${key}:harvest`);
      if (!harvest) {
        this.progress(active, `Investigating ${area.name}`);
        try {
          harvest = await harvestFactors(scoped, { ...dependencies, idFactory: workflow.idFactory(`${key}:harvest`), random: () => 0.5 });
        } catch (error) {
          if (!(error instanceof AppError) || error.code !== "BUDGET_TOO_SMALL") throw error;
          const partialReason = `The allowance ended while researching ${area.name}. Completed calls remain saved.`;
          partialReasons.set(area.id, partialReason);
          this.finishInvestigatorItem(lane.research.id, { stopReason: partialReason });
          this.finishInvestigatorItem(lane.parent.id, { stopReason: partialReason,
            investigator: this.investigatorView(area, "Allowance exhausted", null) });
          return null;
        }
        harvest = { ...harvest, ...this.reconcileAreaEvidence(active.runId, harvest.sources, workflow.withFactorUncertainty(harvest.factors)) };
        const completed = harvest;
        this.discovery.persistFactors(active.runId, harvest.sources, harvest.factors, () => {
          this.assignArea("factors", completed.factors.map(factor => factor.id), area.id);
          workflow.save(`${key}:harvest`, completed);
        });
      }
      this.finishInvestigatorItem(lane.research.id, { factorCount: harvest.factors.length });
      this.startInvestigatorItem(lane.candidates.id);
      this.updateInvestigatorLane(lane.parent.id, area, "Synthesizing and assessing candidates", null);
      let result = workflow.read<ProblemDiscoveryResult>(`${key}:problems`);
      if (!result) {
        try {
          result = await discoverProblems(scoped, harvest.factors, harvest.sources, {
            ...dependencies, idFactory: workflow.idFactory(`${key}:problems`),
          });
        } catch (error) {
          if (!(error instanceof AppError) || error.code !== "BUDGET_TOO_SMALL") throw error;
          const partialReason = `The allowance ended before candidates in ${area.name} could be fully assessed. Completed evidence remains saved.`;
          partialReasons.set(area.id, partialReason);
          this.finishInvestigatorItem(lane.candidates.id, { stopReason: partialReason });
          this.finishInvestigatorItem(lane.parent.id, { stopReason: partialReason,
            investigator: this.investigatorView(area, "Allowance exhausted", null) });
          return null;
        }
        workflow.save(`${key}:problems`, result);
      }
      if (result.partialReason) partialReasons.set(area.id, result.partialReason);
      const finalKey = `${key}:investigation-completed`;
      let investigated = workflow.read<ProblemDiscoveryResult>(finalKey);
      if (!investigated) {
        // Contrary sources must exist before a follow-up factor can cite one.
        result = this.reconcileProblemEvidence(active.runId, result);
        this.persistAreaEvidence(active, area.id, result.killSources, []);
        const investigator = { ...this.investigatorDependencies(active, scoped, frame, area, lane.parent.id, dependencies), stopRequested: targetStop };
        const finalProblems: DiscoveryProblem[] = [];
        const blocked = [...result.blockedCandidates];
        const retainUninvestigated = (problem: DiscoveryProblem, selectionId: string) => {
          const output = workflow.repository.findStageResult(active.runId, "problem-candidates", selectionId)?.output as { problems: unknown[] } | undefined;
          const candidate = output?.problems.map(value => SavedProblemCandidateSchema.parse(value))
            .find(candidate => candidate.statement.trim() === problem.statement);
          blocked.push({ statement: problem.statement, reason: targetStop()!, disposition: "not-assessed",
            ...(candidate ? { candidate } : {}) });
        };
        const investigate = async (problem: DiscoveryProblem, sources: HarvestedSource[]) => {
          const check = ensureEvidenceCheckWorkItem(this.options.db, owner.sessionId, lane.parent.id, area.id, problem.id);
          this.startInvestigatorItem(check.id);
          const rawOutcome = await runCandidateEvidenceInvestigator({ ...investigator, problem, existingSources: sources });
          const reconciled = this.reconcileProblemEvidence(active.runId, { problems: [rawOutcome.problem], killSources: rawOutcome.sources,
            blockedCandidates: [], factorUtilizationRate: 0 });
          const outcome = { ...rawOutcome, problem: reconciled.problems[0]!, sources: reconciled.killSources,
            factors: this.reconcileAreaEvidence(active.runId, rawOutcome.sources, rawOutcome.factors).factors };
          this.persistAreaEvidence(active, area.id, outcome.sources, outcome.factors);
          if (outcome.dropped) blocked.push({ statement: outcome.problem.statement,
            reason: `Dropped during evidence investigation: ${outcome.stopReason}`, disposition: "blocked" });
          else { finalProblems.push(outcome.problem); settledProblems.set(outcome.problem.id, { ...outcome.problem, areaId: area.id }); }
          this.finishInvestigatorItem(check.id, { problemId: problem.id, dropped: outcome.dropped, verdict: outcome.problem.verdict,
            rounds: outcome.rounds, stopReason: outcome.stopReason });
          this.updateInvestigatorLane(lane.parent.id, area, "Checking evidence gaps", { problems: finalProblems, blockedCandidates: blocked });
        };
        for (const problem of result.problems) {
          if (targetStop()) retainUninvestigated(problem, dependencies.stageScope);
          else await investigate(problem, [...harvest.sources, ...result.killSources]);
        }
        const rawGap = await runAreaGapInvestigation({ ...investigator,
          completedResearch: { problems: finalProblems, blockedCandidates: blocked, factors: harvest.factors },
          existingSources: [...harvest.sources, ...result.killSources] });
        const gap = { ...rawGap, ...this.reconcileAreaEvidence(active.runId, rawGap.sources, rawGap.factors) };
        this.persistAreaEvidence(active, area.id, gap.sources, gap.factors);
        if (gap.partial) partialReasons.set(area.id, gap.stopReason);
        if (gap.factors.length > 0 && !targetStop() && this.investigatorBudgetAvailable(active, 1, 0)) {
          const rawGapResult = await discoverProblems(scoped, [...harvest.factors, ...gap.factors],
            [...harvest.sources, ...result.killSources, ...gap.sources], { ...dependencies, repairPolicy: "disabled",
              stageScope: `area-${sha256Area(area.id)}:gap`,
              candidateLimit: Math.max(0, (dependencies.candidateLimit ?? (workflow.rankProblemCandidates
                ? DISCOVERY_DEPTHS[active.config.discoveryDepth].candidateLimit : DEFAULT_PROBLEM_CANDIDATE_LIMIT)) - result.problems.length),
              idFactory: workflow.idFactory(`${key}:gap-problems`) });
          const gapResult = this.reconcileProblemEvidence(active.runId, rawGapResult);
          this.persistAreaEvidence(active, area.id, gapResult.killSources, []);
          blocked.push(...gapResult.blockedCandidates);
          for (const problem of gapResult.problems) {
            if (finalProblems.some(existing => existing.statement.trim().toLowerCase() === problem.statement.trim().toLowerCase())) {
              blocked.push({ statement: problem.statement, reason: "The area gap repeated an already assessed candidate.", disposition: "blocked" });
            } else if (targetStop()) retainUninvestigated(problem, `${dependencies.stageScope}:gap`);
            else await investigate(problem, [...harvest.sources, ...result.killSources, ...gap.sources, ...gapResult.killSources]);
          }
        }
        investigated = { ...result, problems: finalProblems, blockedCandidates: blocked, killSources: [] };
        workflow.save(finalKey, investigated);
      }
      this.finishInvestigatorItem(lane.candidates.id, { problemIds: investigated.problems.map(problem => problem.id) });
      this.finishInvestigatorItem(lane.parent.id, { investigator: this.investigatorView(area, "Finished", investigated) });
      return { areaId: area.id, result: investigated };
    };
    const settled = await Promise.allSettled(selected.map(investigateArea));
    for (const [index, result] of settled.entries()) {
      if (result.status === "fulfilled" && result.value) results.push(result.value);
      if (result.status === "rejected") this.settleInvestigatorFailure(active, lanes.get(selected[index]!.id)!.parent.id, result.reason);
    }
    const failed = settled.find(result => result.status === "rejected");
    const partialReason = selected.map(area => partialReasons.get(area.id)).find(reason => reason !== undefined);
    const skippedAreas = selected.filter(area => !results.some(result => result.areaId === area.id));
    for (const area of skippedAreas) {
      const lane = lanes.get(area.id)!;
      for (const item of [lane.research, lane.candidates, lane.parent]) this.skipInvestigatorItem(item.id,
        partialReasons.get(area.id) ?? "This area ended without a completed investigation. Its saved evidence remains available.");
    }
    const problems = results.flatMap(item => item.result.problems);
    const targetProgress = researchTargetProgress(target, results.flatMap(item => item.result.problems.map(problem => ({ ...problem, areaId: item.areaId }))));
    if (!failed) workflow.save("research-target-outcome", { target, ...targetProgress, skippedAreaIds: skippedAreas.map(area => area.id),
      reason: partialReason ?? (targetProgress.outcome === "target-met" ? "The declared confirmed-problem and area target was met."
        : `Research finished with ${targetProgress.confirmedProblems} confirmed problem(s) across ${targetProgress.areas} area(s). The declared target remains incomplete.`) });
    this.discovery.persistProblems(active.runId, [], problems,
      results.flatMap(item => item.result.blockedCandidates), () => {
        for (const item of results) this.assignArea("problems", item.result.problems.map(problem => problem.id), item.areaId);
        if (!failed) workflow.save("discovery-completed", { areas: results.map(item => item.areaId), problemIds: problems.map(problem => problem.id) });
      });
    if (failed?.status === "rejected") throw failed.reason;
    this.progress(active, `${problems.length} problems across ${selected.length} investigated areas ready for review`);
  }

  private workflowRunOwner(active: ActiveRun): { sessionId: string; workItemId: string } {
    const row = this.options.db.db.prepare(`SELECT item.session_id AS sessionId, item.id AS workItemId
      FROM workflow_work_items item JOIN research_runs run ON run.workflow_session_id = item.session_id
      WHERE run.id = ? AND json_extract(item.output_refs_json, '$.runId') = run.id
      ORDER BY item.created_at LIMIT 1`).get(active.runId) as { sessionId: string; workItemId: string } | undefined;
    if (!row) throw new AppError("INVALID_REFERENCE", "This bounded research assignment has no admitted task.");
    return row;
  }

  private investigatorDependencies(active: ActiveRun, scope: Scope, frame: ResearchFrame, area: ResearchArea,
    workItemId: string, dependencies: DiscoveryDependencies): InvestigatorDependencies {
    const owner = this.workflowRunOwner(active);
    return { runId: active.runId, scope, frame, area, dependencies: { ...dependencies, repairPolicy: "disabled" },
      checkpoints: active.workflow!,
      budgetAvailable: (modelCalls, searches) => this.investigatorBudgetAvailable(active, modelCalls, searches),
      savedSearchRoute: key => {
        const saved = new OpportunityExplorationRepository(this.options.db).loadAttempt(active.threadId, `investigator-search:${key}`, owner.sessionId);
        return saved ? InvestigatorSearchRouteSchema.parse((saved.input as { request: { route: unknown } }).request.route) : undefined;
      },
      durableSearch: async request => {
        const result = await runManagedInvestigatorSearch({ db: this.options.db, threadId: active.threadId,
          sessionId: owner.sessionId, workItemId, request, searchProvider: active.config.searchProvider,
          searchClient: this.instrumentedSearch(active), sourceRouting: { ...dependencies.sourceRouting,
            goalKind: frame.goalKind, languages: frame.languages },
          ...(active.acknowledgedAttemptIds ? { acknowledgedAttemptIds: active.acknowledgedAttemptIds } : {}),
          signal: active.abortController.signal });
        return result.sources;
      },
      onStep: step => { this.progress(active, step.message); this.updateInvestigatorLane(workItemId, area, step.message, null, true); },
    };
  }

  private investigatorBudgetAvailable(active: ActiveRun, modelCalls: number, searches: number): boolean {
    const availableModels = modelCalls > 0 ? this.remainingWorkflowTaskCalls(active, "model-call") ?? Infinity : Infinity;
    const availableSearches = searches > 0 ? this.remainingWorkflowTaskCalls(active, "search") ?? Infinity : Infinity;
    const allowance = active.areaBudget;
    if (availableModels < modelCalls || availableSearches < searches) return false;
    if (!allowance) return true;
    const modelsUsed = this.options.db.db.prepare(`SELECT coalesce(sum(CASE
      WHEN attempt_metadata_json IS NOT NULL AND json_type(attempt_metadata_json,'$.attempts') = 'array'
        THEN max(1,json_array_length(attempt_metadata_json,'$.attempts'))
      WHEN status <> 'prepared' AND terminal_kind IS NOT 'never-dispatched' THEN 1 ELSE 0 END),0) AS count
      FROM generation_attempts WHERE research_run_id = ? AND
        (instr(stage_key,?) > 0 OR instr(stage_key,?) > 0 OR stage_key = ?)`)
      .get(active.runId, `area-${sha256Area(allowance.areaId)}`, `:${allowance.areaId}:`, `area-gap:${allowance.areaId}`) as { count: number };
    const searchesUsed = this.options.db.db.prepare(`SELECT count(*) AS count FROM cost_ledger WHERE research_run_id = ?
      AND operation = 'search' AND status = 'committed' AND json_extract(usage_json,'$.areaId') = ?`)
      .get(active.runId, allowance.areaId) as { count: number };
    return modelsUsed.count + modelCalls <= allowance.maxModelCalls
      && searchesUsed.count + (allowance.pendingSearches ?? 0) + searches <= allowance.maxSearches;
  }

  private persistAreaEvidence(active: ActiveRun, areaId: string, sources: HarvestedSource[], factors: HarvestedFactor[]): void {
    const sourceIds = new Set((this.options.db.db.prepare("SELECT id FROM sources WHERE research_run_id = ?").all(active.runId) as Array<{ id: string }>).map(row => row.id));
    const factorIds = new Set((this.options.db.db.prepare("SELECT id FROM factors WHERE research_run_id = ?").all(active.runId) as Array<{ id: string }>).map(row => row.id));
    this.discovery.persistFactors(active.runId, sources.filter(source => !sourceIds.has(source.id)), factors.filter(factor => !factorIds.has(factor.id)),
      () => this.assignArea("factors", factors.map(factor => factor.id), areaId));
  }

  private savedRunSources(runId: string): HarvestedSource[] {
    return (this.options.db.db.prepare(`SELECT id, provider_source_id AS providerSourceId, canonical_url AS canonicalUrl,
      canonical_url AS url, title, retrieved_text AS retrievedText, author, published_at AS publishedAt,
      content_hash AS contentHash, retrieved_at AS retrievedAt FROM sources WHERE research_run_id = ?`).all(runId) as HarvestedSource[]);
  }

  private async validateFrameSourceVenues(active: ActiveRun, frame: ResearchFrame): Promise<void> {
    const workflow = active.workflow!;
    if (!workflow.read("source-routes") || workflow.read("frame-source-venues")) return;
    const started = this.options.db.db.prepare(`SELECT 1 FROM stage_results WHERE research_run_id = ?
      AND stage_id IN ('query-plan','factor-harvest','problem-candidates','problem-kill') LIMIT 1`).get(active.runId);
    if (started) {
      workflow.save("frame-source-venues", { compatibility: "preserve-saved-routing" });
      return;
    }
    const result = await validateResearchVenues(frame.areas.flatMap(area => area.venues), {
      signal: active.abortController.signal,
      ...(this.options.venueResolver ? { resolve: this.options.venueResolver } : {}),
      retrievedSources: new ResearchFrameRepository(this.options.db).forRun(active.runId)?.sources ?? [],
    });
    workflow.save("frame-source-venues", { ...result, validated: true, version: 2 });
    for (const unresolved of result.unresolved) this.progress(active,
      `Source venue ${unresolved.venue.name} was left unverified. ${unresolved.reason}`);
  }

  private areaDependencies(active: ActiveRun, frame: ResearchFrame, area: ResearchArea) {
    const dependencies = this.dependencies(active);
    const validation = active.workflow!.read<VenueVerificationResult & { validated?: boolean }>("frame-source-venues");
    // Earlier verification receipts allowed DNS alone. Only saved retrieved proof can expand routes.
    const provenDomains = new Set(validation?.proofs?.filter(proof => proof.method === "saved-source" && proof.sourceUrl).map(proof => proof.domain));
    return { ...dependencies, frame, area, sourceRouting: { ...dependencies.sourceRouting,
      ...(validation?.validated ? { venues: validation.verified.filter(verified => provenDomains.has(verified.domain ?? "") && area.venues.some(venue =>
        venue.name === verified.name && venue.kind === verified.kind && venue.domain?.toLowerCase() === verified.domain)),
        ...(area.region ? { region: area.region } : {}) } : {}),
    } };
  }

  /** Frames retain their original citation IDs; copied observations must belong to this research run. */
  private seedFrameDiscoverySources(runId: string, sources: Source[]): void {
    const known = new Map(this.savedRunSources(runId).map(source => [source.canonicalUrl, source]));
    const copied: HarvestedSource[] = [];
    for (const source of sources) {
      const canonicalUrl = safeCanonicalizeUrl(source.url);
      if (!canonicalUrl || known.has(canonicalUrl)) continue;
      const record: HarvestedSource = { id: createHash("sha256").update(`${runId}:frame-context:${source.id}`).digest("hex").slice(0, 24),
        providerSourceId: source.id, canonicalUrl, url: canonicalUrl, title: source.title, retrievedText: source.text,
        author: source.author ?? null, publishedAt: source.publishedDate ?? null,
        contentHash: createHash("sha256").update(source.text).digest("hex"), retrievedAt: new Date().toISOString() };
      known.set(canonicalUrl, record);
      copied.push(record);
    }
    if (copied.length) this.discovery.persistFactors(runId, copied, []);
  }

  /** Parallel lanes may rediscover a URL before another lane saves it. Resolve again at persistence. */
  private reconcileAreaEvidence(runId: string, sources: HarvestedSource[], factors: HarvestedFactor[]) {
    const known = new Map(this.savedRunSources(runId).map(source => [source.canonicalUrl, source]));
    const resolved: HarvestedSource[] = [];
    for (const source of [...sources, ...factors.map(factor => factor.source)]) {
      const existing = known.get(source.canonicalUrl);
      const saved = existing ?? source;
      if (!existing) known.set(source.canonicalUrl, saved);
      if (!resolved.some(item => item.id === saved.id)) resolved.push(saved);
    }
    return { sources: resolved, factors: factors.flatMap(factor => {
      const source = known.get(factor.source.canonicalUrl)!;
      // A later retrieval cannot replace the text cited by an earlier saved observation.
      if (!quoteAppearsVerbatim(source.retrievedText, factor.quote)) return [];
      return [{ ...factor, sourceId: source.id, source }];
    }) };
  }

  private reconcileProblemEvidence(runId: string, result: ProblemDiscoveryResult): ProblemDiscoveryResult {
    const originalSources = [...result.killSources, ...result.problems.flatMap(problem => problem.factors.map(factor => factor.source))];
    const evidence = this.reconcileAreaEvidence(runId, originalSources, result.problems.flatMap(problem => problem.factors));
    const sourceByUrl = new Map(evidence.sources.map(source => [source.canonicalUrl, source]));
    const sourceIds = new Map(originalSources.map(source => [source.id, sourceByUrl.get(source.canonicalUrl)!.id]));
    const factorsById = new Map(evidence.factors.map(factor => [factor.id, factor]));
    return { ...result, killSources: [...new Map(result.killSources.map(source => {
      const saved = sourceByUrl.get(source.canonicalUrl)!;
      return [saved.id, saved] as const;
    })).values()], problems: result.problems.map(problem => {
      const factors = problem.factors.flatMap(factor => factorsById.get(factor.id) ? [factorsById.get(factor.id)!] : []);
      const factorIds = new Set(factors.map(factor => factor.id));
      return enforceConfirmationRule({ ...problem, factors, factorIds: [...factorIds],
        scaleBasisFactorId: factorIds.has(problem.scaleBasisFactorId ?? "") ? problem.scaleBasisFactorId : null,
        ...(problem.intendedBuyerEvidenceFactorIds ? { intendedBuyerEvidenceFactorIds: problem.intendedBuyerEvidenceFactorIds.filter(id => factorIds.has(id)) } : {}),
        ...(problem.factorAssessments ? { factorAssessments: problem.factorAssessments.filter(assessment => factorIds.has(assessment.factorId)) } : {}),
        verdictSourceIds: [...new Set(problem.verdictSourceIds.map(id => sourceIds.get(id) ?? id))] });
    }) };
  }

  private startInvestigatorItem(id: string): void {
    this.options.db.immediateTransaction(() => {
      const repository = new WorkflowRepository(this.options.db);
      let item = repository.getWorkItem(id)!;
      if (item.state === "planned") item = repository.updateWorkItem(id, "ready", { outputRefs: item.outputRefs });
      if (item.state === "ready") repository.updateWorkItem(id, "running", { outputRefs: item.outputRefs });
    });
  }

  private finishInvestigatorItem(id: string, outputRefs: unknown = {}): void {
    this.options.db.immediateTransaction(() => {
      const repository = new WorkflowRepository(this.options.db);
      if (repository.getWorkItem(id)?.state === "running") repository.updateWorkItem(id, "succeeded", { outputRefs });
    });
  }

  private settleInvestigatorFailure(active: ActiveRun, parentId: string, error: unknown): void {
    this.options.db.immediateTransaction(() => {
      const repository = new WorkflowRepository(this.options.db);
      const items = repository.listWorkItems(this.workflowRunOwner(active).sessionId);
      const owned = new Set([parentId]);
      for (const item of items) if (item.parentItemId && owned.has(item.parentItemId)) owned.add(item.id);
      const state = active.abortController.signal.aborted ? "cancelled"
        : repository.hasUnknownProviderCompletion(active.runId) ? "unknown" : "failed";
      const message = errorMessage(error);
      for (const item of items.filter(item => owned.has(item.id))) {
        if (item.state === "running") repository.updateWorkItem(item.id, state, { outputRefs: item.outputRefs, error: { message } });
        else if (item.state === "planned" || item.state === "ready") repository.updateWorkItem(item.id, "skipped", {
          outputRefs: item.outputRefs, error: { message: `Area investigation stopped. ${message}` } });
      }
    });
  }

  private skipInvestigatorItem(id: string, reason: string): void {
    this.options.db.immediateTransaction(() => {
      const repository = new WorkflowRepository(this.options.db);
      const item = repository.getWorkItem(id);
      if (item?.state === "planned" || item?.state === "ready") repository.updateWorkItem(id, "skipped", {
        outputRefs: item.outputRefs, error: { message: reason } });
    });
  }

  private investigatorView(area: ResearchArea, currentStep: string,
    result: Pick<ProblemDiscoveryResult, "problems" | "blockedCandidates"> | null) {
    return { areaId: area.id, areaName: area.name, currentStep,
      confirmedCount: result ? result.problems.filter(problem => problem.verdict === "confirmed").length : null,
      insufficientCount: result ? result.problems.filter(problem => problem.verdict === "insufficient-evidence").length : null,
      droppedCount: result ? result.blockedCandidates.filter(candidate => candidate.disposition !== "not-assessed").length : null };
  }

  private updateInvestigatorLane(id: string, area: ResearchArea, currentStep: string,
    result: Pick<ProblemDiscoveryResult, "problems" | "blockedCandidates"> | null, preserveCounts = false): void {
    this.options.db.immediateTransaction(() => {
      const row = this.options.db.db.prepare("SELECT output_refs_json FROM workflow_work_items WHERE id = ?")
        .get(id) as { output_refs_json: string | null } | undefined;
      if (!row) return;
      const previous = (row.output_refs_json ? JSON.parse(row.output_refs_json) as { investigator?: Record<string, unknown> } | null : null) ?? {};
      const investigator = preserveCounts && previous.investigator ? { ...previous.investigator, currentStep }
        : this.investigatorView(area, currentStep, result);
      this.options.db.db.prepare("UPDATE workflow_work_items SET output_refs_json = ? WHERE id = ?")
        .run(JSON.stringify({ ...previous, investigator }), id);
    });
  }

  private assignArea(table: "factors" | "problems", ids: readonly string[], areaId: string): void {
    const update = this.options.db.db.prepare(`UPDATE ${table} SET area_id = ? WHERE id = ?`);
    for (const id of ids) update.run(areaId, id);
  }

  private async executeDevelopment(active: ActiveRun): Promise<void> {
    if (active.workflow) {
      const workflow = active.workflow;
      let context = workflow.developmentContext(active.problemId!);
      if (workflow.read<{ version: number }>("goal-fit")?.version === 1) {
        const frozen = workflow.read<{ frame: ResearchFrame }>("goal-fit-frame");
        if (!frozen) throw new Error("This goal-aware generation has no frozen approved frame.");
        const frame = new ResearchFrameRepository(this.options.db).forRun(active.runId);
        this.persistFrameSources(active.runId, frame?.sources ?? []);
        const frameEvidence = (frame?.sources ?? []).map(source => ({ sourceId: source.id, content: source }));
        context = { ...context, frame: frozen.frame, generationEvidence: [
          ...(context.generationEvidence ?? []), ...frameEvidence.filter(item =>
            ![...context.supportingEvidence, ...context.contraryEvidence, ...(context.generationEvidence ?? [])]
              .some(existing => existing.sourceId === item.sourceId)),
        ] };
      }
      const sessionRow = this.options.db.db.prepare("SELECT workflow_session_id FROM research_runs WHERE id = ?")
        .get(active.runId) as { workflow_session_id: string | null };
      const isWorkflowSession = Boolean(sessionRow.workflow_session_id);
      const generationTask = sessionRow.workflow_session_id
        ? this.options.db.db.prepare(`SELECT input_json FROM workflow_work_items
          WHERE session_id = ? AND kind = 'generate-ideas'
            AND json_extract(output_refs_json, '$.runId') = ? LIMIT 1`)
          .get(sessionRow.workflow_session_id, active.runId) as { input_json: string } | undefined
        : undefined;
      const savedAngle = generationTask
        ? (JSON.parse(generationTask.input_json) as { generationAngle?: unknown }).generationAngle : undefined;
      const generationAngle = savedAngle === undefined ? undefined : WorkflowGenerationAngleSchema.parse(savedAngle);
      const savedEvidence = generationTask
        ? (JSON.parse(generationTask.input_json) as { generationEvidence?: unknown }).generationEvidence : undefined;
      if (savedEvidence !== undefined) {
        const generationEvidence = this.materializeGenerationEvidence(active.runId,
          WorkflowGenerationEvidenceSchema.parse(savedEvidence));
        const alreadySupplied = new Set([...context.supportingEvidence, ...context.contraryEvidence]
          .map((item) => item.sourceId));
        context = { ...context, generationEvidence: [...(context.generationEvidence ?? []),
          ...generationEvidence.filter((item) => !alreadySupplied.has(item.sourceId)
            && !context.generationEvidence?.some(existing => existing.sourceId === item.sourceId))] };
      }
      // Session-scoped collections use the bounded reviewer for both practical and startup targets.
      const opportunityConfig = isWorkflowSession || context.frame && context.frame.goalKind !== "market-opportunity"
        ? undefined : active.config.opportunityExploration;
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
        ideaCount: isWorkflowSession
          ? Math.min(active.config.ideaCount ?? DEFAULT_IDEA_COUNT, 5)
          : opportunityBatchSize ?? active.config.ideaCount,
        explorationPurpose: active.config.explorationPurpose,
        focusedExperiments: workflow.hasFocusedExperiments(),
        ...(generationAngle ? { generationAngle } : {}),
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
        this.progress(active, `Generating up to ${deps.ideaCount ?? DEFAULT_IDEA_COUNT} ideas`, "generating-options");
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
            }) }, context, null, result.schemaRevision);
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
      if (isWorkflowSession && sessionRow.workflow_session_id) {
        await this.reviewPracticalSolutions(active, workflow, context, sessionRow.workflow_session_id);
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

  private materializeGenerationEvidence(runId: string, sources: Source[]): WorkflowV2EvidenceItem[] {
    const seenUrls = new Set<string>();
    return this.options.db.immediateTransaction(() => sources.flatMap((source) => {
      if (seenUrls.has(source.url)) return [];
      seenUrls.add(source.url);
      const contentHash = createHash("sha256").update(source.text).digest("hex");
      let saved = this.options.db.db.prepare(`SELECT id, provider_source_id, canonical_url, title,
        retrieved_text, author, published_at, content_hash FROM sources
        WHERE research_run_id = ? AND canonical_url = ? ORDER BY rowid LIMIT 1`)
        .get(runId, source.url) as {
          id: string; provider_source_id: string | null; canonical_url: string; title: string;
          retrieved_text: string; author: string | null; published_at: string | null; content_hash: string;
        } | undefined;
      if (!saved) {
        const id = randomUUID();
        this.options.db.db.prepare(`INSERT INTO sources
          (id, research_run_id, provider_source_id, canonical_url, title, retrieved_text,
            author, published_at, content_hash, retrieved_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, runId, source.id, source.url, source.title, source.text,
            source.author ?? null, source.publishedDate ?? null, contentHash, new Date().toISOString());
        saved = {
          id, provider_source_id: source.id, canonical_url: source.url, title: source.title,
          retrieved_text: source.text, author: source.author ?? null,
          published_at: source.publishedDate ?? null, content_hash: contentHash,
        };
      }
      return [{
        sourceId: saved.id,
        content: {
          url: saved.canonical_url, title: saved.title, text: saved.retrieved_text,
          providerSourceId: saved.provider_source_id,
          searchSourceId: source.id,
          ...(saved.content_hash !== contentHash ? { searchExcerptOmitted: "A saved source at this URL already exists in the immutable run." } : {}),
          ...(saved.author ? { author: saved.author } : {}),
          ...(saved.published_at ? { publishedDate: saved.published_at } : {}),
        },
      }];
    }));
  }

  private async reviewPracticalSolutions(
    active: ActiveRun,
    workflow: WorkflowExecution,
    context: WorkflowV2DevelopmentContext,
    sessionId: string,
  ): Promise<void> {
    const solutionsStage = workflow.repository.findStageResult(active.runId, "solutions");
    if (!solutionsStage) throw new Error("Practical solutions have no saved generation checkpoint");
    const options = WorkflowV2SolutionsOutputSchema.parse(solutionsStage.output).options;
    const rows = this.options.db.db.prepare(`
      SELECT id, option_position FROM solutions WHERE research_run_id = ? ORDER BY option_position
    `).all(active.runId) as Array<{ id: string; option_position: number }>;
    if (rows.length !== options.length) throw new Error("Saved practical solutions do not match their generation checkpoint");
    if (rows.length === 0) return;
    const candidates: SolutionSetItem[] = rows.map((row) => {
      const option = options[row.option_position];
      if (!option) throw new Error(`Saved practical solution ${row.id} has no checkpoint option`);
      return { id: row.id, option };
    });
    const contractRow = this.options.db.db.prepare("SELECT contract_json FROM workflow_sessions WHERE id = ?")
      .get(sessionId) as { contract_json: string } | undefined;
    if (!contractRow) throw new Error("The practical solution session is missing");
    const contract = WorkflowLaunchContractSchema.parse(JSON.parse(contractRow.contract_json));
    const generationItem = this.options.db.db.prepare(`SELECT input_json FROM workflow_work_items
      WHERE kind = 'generate-ideas' AND session_id = ?
        AND json_extract(output_refs_json, '$.runId') = ? LIMIT 1`)
      .get(sessionId, active.runId) as { input_json: string } | undefined;
    const generationInput = generationItem ? JSON.parse(generationItem.input_json) as {
      reviewModel?: unknown; reviewReasoningEffort?: unknown;
    } : null;
    const reviewModel = ModelRefSchema.parse(generationInput?.reviewModel ?? contract.ideas?.reviewModel ?? active.config.model);
    const reviewReasoningEffort = ReasoningEffortSchema.parse(
      generationInput?.reviewReasoningEffort ?? contract.ideas?.reviewReasoningEffort ?? active.config.reasoningEffort,
    );
    const inventory = this.loadPracticalInventory(active, sessionId);
    const prepare = (evidence: WorkflowV2EvidenceItem[]) => prepareSolutionSetReview({
      candidates,
      existingSolutions: inventory.accepted,
      otherExistingSolutions: inventory.other,
      omittedSolutionIds: inventory.omittedSolutionIds,
      acceptedInventoryCount: inventory.acceptedCount,
      problem: context.problem,
      projectConstraints: context.scope,
      savedInstructions: contract.instructions.review ?? "",
      ...(active.config.explorationPurpose ? { explorationPurpose: active.config.explorationPurpose } : {}),
      startupOnly: active.config.explorationPurpose === "startup-opportunities",
      ...(context.frame ? { frame: context.frame } : {}),
      evidence,
      model: reviewModel,
      reasoningEffort: reviewReasoningEffort,
      signal: active.abortController.signal,
      resolvePrompt: workflow.resolvePrompt,
    });
    let prepared = prepare(developmentStageEvidence(context).slice(1));
    const applyNoveltyRequirement = (classification: ReturnType<typeof classifySolutionSetReview>) => {
      if (!context.frame || !frameNeedsNoveltySearch(context.frame)) return classification;
      const decisions = classification.decisions.map(decision => decision.status === "accepted"
        && !workflow.read(`solution-novelty:${decision.candidateId}`) ? { ...decision, status: "unresolved" as const,
          reason: `${decision.reason} ${workflow.read<{ reason: string }>(`solution-novelty:${decision.candidateId}:unavailable`)?.reason
            ?? "The required existing-tools search has not completed for this candidate."}` } : decision);
      const addedDistinctCount = decisions.filter(decision => decision.status === "accepted").length;
      return { ...classification, decisions, addedDistinctCount, acceptedDistinctCount: prepared.acceptedInventoryCount + addedDistinctCount };
    };
    const persistFits = (output: SolutionSetReviewOutput, evidenceSourceIds: readonly string[]) => {
      if (!context.frame) return;
      for (const candidate of candidates) {
        const assessments = output.assessments.filter(assessment => assessment.candidateId === candidate.id);
        const fit = assessments.length === 1 ? assessments[0]?.criteriaFit : undefined;
        if (!fit) continue;
        try { assertCriteriaFit(fit, context.frame, evidenceSourceIds); } catch { continue; }
        workflow.repository.saveReviewedCriteriaFit(active.runId, candidate.id, fit, context.frame, evidenceSourceIds);
      }
    };
    const reviewContext = (classification: ReturnType<typeof classifySolutionSetReview>) => ({
      developmentContext: context,
      solutionSetReview: {
        decisions: classification.decisions,
        acceptedSolutionIds: classification.decisions
          .filter((decision) => decision.status === "accepted")
          .map((decision) => decision.candidateId),
        addedDistinctCount: classification.addedDistinctCount,
        acceptedDistinctCount: classification.acceptedDistinctCount,
        coverageErrors: classification.coverageErrors,
        omittedSolutionIds: prepared.omittedSolutionIds,
      },
    });
    const savedReview = workflow.repository.findStageResult(active.runId, "solution-set-review", active.problemId);
    if (savedReview) {
      const classification = applyNoveltyRequirement(classifySolutionSetReview(candidates, prepared.existingSolutions,
        savedReview.evidence.map(item => item.sourceId), savedReview.output, {
          otherExistingSolutions: prepared.otherExistingSolutions,
          omittedSolutionIds: prepared.omittedSolutionIds,
          acceptedInventoryCount: prepared.acceptedInventoryCount,
          startupOnly: prepared.startupOnly,
          ...(context.frame ? { frame: context.frame } : {}),
        }));
      workflow.repository.getStageResumeState({
        researchRunId: active.runId, stageId: "solution-set-review", selectionId: active.problemId,
        context: reviewContext(classification),
        identity: {
          promptSha256: savedReview.prompt.resolvedSha256,
          schema: savedReview.schema,
          inputs: savedReview.inputs,
          evidence: savedReview.evidence,
        },
      });
      return;
    }
    if (context.frame && frameNeedsNoveltySearch(context.frame)) {
      const preliminaryId = `preliminary:${active.problemId}`;
      const savedPreliminary = workflow.repository.findStageResult(active.runId, "solution-set-review", preliminaryId);
      let preliminary;
      if (savedPreliminary) {
        preliminary = classifySolutionSetReview(candidates, prepared.existingSolutions, prepared.evidenceSourceIds, savedPreliminary.output, {
          otherExistingSolutions: prepared.otherExistingSolutions, omittedSolutionIds: prepared.omittedSolutionIds,
          acceptedInventoryCount: prepared.acceptedInventoryCount, startupOnly: prepared.startupOnly, frame: context.frame,
        });
      } else {
        const request = { ...prepared.request, stage: "solution-set-review:preliminary",
          workOrder: { ...prepared.request.workOrder, stage: "solution-set-review:preliminary" } };
        preliminary = await reviewSolutionSet({ ...prepared, request }, this.instrumentedModel(active, undefined, reviewModel), completed => {
          this.options.db.immediateTransaction(() => workflow.commitStage("solution-set-review", completed.request,
            completed.prompt, completed.metadata, completed.output, reviewContext(completed), preliminaryId, completed.schemaRevision));
        });
      }
      if (!preliminary.decisions.some(decision => decision.status === "accepted")) {
        const checkpoint = workflow.repository.findStageResult(active.runId, "solution-set-review", preliminaryId)!;
        this.options.db.immediateTransaction(() => {
          persistFits(prepared.request.schema.parse(checkpoint.output), prepared.evidenceSourceIds);
          workflow.repository.saveStageResult({ researchRunId: active.runId, stageId: "solution-set-review", selectionId: active.problemId,
            schemaRevision: checkpoint.schemaRevision, context: reviewContext(preliminary), output: checkpoint.output,
            prompt: checkpoint.prompt, schema: checkpoint.schema, inputs: checkpoint.inputs, evidence: checkpoint.evidence,
            runtimePrompt: checkpoint.runtimePrompt, effectiveRequest: checkpoint.effectiveRequest });
        });
        return;
      }
      const noveltyEvidence: WorkflowV2EvidenceItem[] = [];
      const unavailableNoveltyChecks: Array<{ candidateId: string; reason: string }> = [];
      for (const candidate of candidates.filter(item => preliminary.decisions.some(decision =>
        decision.candidateId === item.id && decision.status === "accepted"))) {
        const owner = this.workflowRunOwner(active);
        const attempts = new OpportunityExplorationRepository(this.options.db);
        const key = `solution-novelty:${candidate.id}`;
        const unavailable = workflow.read<{ reason: string }>(`${key}:unavailable`);
        if (unavailable) { unavailableNoveltyChecks.push({ candidateId: candidate.id, reason: unavailable.reason }); continue; }
        let unavailableReason: string | null = null;
        let sources: Source[];
        try { sources = await ensureSolutionNoveltyEvidence(context.frame, candidate, {
          loadCompleted: value => {
            const saved = workflow.read<unknown>(value);
            if (saved !== undefined && saved !== null) return WorkflowGenerationEvidenceSchema.parse(saved);
            const attempt = attempts.loadAttempt(active.threadId, `investigator-search:${value}`, owner.sessionId);
            if (attempt?.status !== "completed") return undefined;
            const sources = WorkflowGenerationEvidenceSchema.parse((attempt.result as { sources: unknown }).sources);
            workflow.save(value, sources);
            return sources;
          },
          wasStarted: value => {
            const attempt = attempts.loadAttempt(active.threadId, `investigator-search:${value}`, owner.sessionId);
            return Boolean(attempt && (attempt.status === "dispatched" || attempt.status === "unknown-dispatch")
              && !active.acknowledgedAttemptIds?.includes(attempt.attemptId));
          },
          reserveSearch: () => {
            const readiness = this.options.searchReady?.();
            const available = { exa: Boolean(this.options.searchClients?.exa) && readiness?.exa !== false,
              perplexity: Boolean(this.options.searchClients?.perplexity) && readiness?.perplexity !== false };
            if (active.config.searchProvider === "auto" ? !available.exa && !available.perplexity : !available[active.config.searchProvider]) {
              unavailableReason = "The required existing-tools search was unavailable because no connected search provider could run it. Novelty remains unresolved.";
              throw new AppError("conflict", unavailableReason);
            }
            try {
              if ((this.remainingWorkflowTaskCalls(active, "search") ?? Infinity) < 1) throw new AppError("BUDGET_TOO_SMALL");
            } catch (error) {
              if (!(error instanceof AppError) || error.code !== "BUDGET_TOO_SMALL") throw error;
              unavailableReason = "The required existing-tools search was skipped because this task has no remaining search allowance. Novelty remains unresolved.";
              throw error;
            }
          },
          markStarted: (value, query) => workflow.save(`${value}:request`, { query }),
          search: async query => (await runManagedInvestigatorSearch({ db: this.options.db, threadId: active.threadId,
            sessionId: owner.sessionId, workItemId: owner.workItemId,
            request: { key, query, evidenceNeeded: "Existing tools and alternatives for the approved novelty criterion", route: "alternatives" },
            searchProvider: active.config.searchProvider, searchClient: this.instrumentedSearch(active),
            sourceRouting: { goalKind: context.frame!.goalKind, languages: context.frame!.languages,
              legacyPublicationDomainCategory: workflow.read<{ version: number }>("source-routes")?.version !== 2,
              now: new Date(workflow.read<string>("source-route-start")!) },
            ...(active.acknowledgedAttemptIds ? { acknowledgedAttemptIds: active.acknowledgedAttemptIds } : {}), signal: active.abortController.signal })).sources,
          saveCompleted: (value, query, evidence) => { workflow.save(value, evidence); workflow.save(`${value}:completed`, { query, sourceIds: evidence.map(source => source.id) }); },
        }); } catch (error) {
          if (!unavailableReason) throw error;
          workflow.save(`${key}:unavailable`, { reason: unavailableReason });
          unavailableNoveltyChecks.push({ candidateId: candidate.id, reason: unavailableReason });
          this.progress(active, unavailableReason);
          continue;
        }
        noveltyEvidence.push(...this.materializeGenerationEvidence(active.runId, sources));
      }
      prepared = prepare([...new Map([...developmentStageEvidence(context).slice(1), ...noveltyEvidence]
        .map(item => [item.sourceId, item])).values()]);
      if (unavailableNoveltyChecks.length) {
        workflow.save("generation-partial-outcome", { outcome: "partial", reason: unavailableNoveltyChecks.map(item => item.reason).join(" ") });
        prepared = { ...prepared, request: { ...prepared.request, workOrder: { ...prepared.request.workOrder,
          inputs: { ...(prepared.request.workOrder.inputs as Record<string, unknown>), unavailableNoveltyChecks } } } };
        if ((this.remainingWorkflowTaskCalls(active, "model-call") ?? Infinity) < 1) {
          const checkpoint = workflow.repository.findStageResult(active.runId, "solution-set-review", preliminaryId)!;
          this.options.db.immediateTransaction(() => {
            persistFits(prepared.request.schema.parse(checkpoint.output), checkpoint.evidence.map(item => item.sourceId));
            workflow.repository.saveStageResult({ researchRunId: active.runId, stageId: "solution-set-review", selectionId: active.problemId,
              schemaRevision: checkpoint.schemaRevision, context: reviewContext(applyNoveltyRequirement(preliminary)), output: checkpoint.output,
              prompt: checkpoint.prompt, schema: checkpoint.schema, inputs: checkpoint.inputs, evidence: checkpoint.evidence,
              runtimePrompt: checkpoint.runtimePrompt, effectiveRequest: checkpoint.effectiveRequest });
          });
          return;
        }
      }
    }
    const resume = workflow.repository.getStageResumeState({
      researchRunId: active.runId, stageId: "solution-set-review", selectionId: active.problemId,
      context, identity: { promptSha256: prepared.prompt.resolvedSha256, schema: prepared.request.jsonSchema,
        inputs: prepared.request.workOrder.inputs,
        evidence: prepared.request.evidence.map(item => ({ sourceId: item.sourceId, content: item.content })) },
    });
    if (resume.kind === "unknown-completion") {
      throw new Error("A solution review may have completed before interruption. Review the saved attempt before retrying.");
    }
    this.progress(active, `Reviewing ${candidates.length} idea${candidates.length === 1 ? "" : "s"}`, "generating-options");
    await reviewSolutionSet(prepared, this.instrumentedModel(active, undefined, reviewModel), (completed) => {
      active.abortController.signal.throwIfAborted();
      const classification = applyNoveltyRequirement(completed);
      this.options.db.immediateTransaction(() => {
        persistFits(completed.output, completed.evidenceSourceIds);
        workflow.commitStage("solution-set-review", completed.request, completed.prompt, completed.metadata,
          completed.output, reviewContext(classification), active.problemId, completed.schemaRevision);
      });
    });
  }

  private loadPracticalInventory(active: ActiveRun, sessionId: string): {
    accepted: SolutionSetItem[];
    other: SolutionSetItem[];
    omittedSolutionIds: string[];
    acceptedCount: number;
  } {
    const baseline = active.config.explorationPurpose === "startup-opportunities"
      ? new WorkflowRepository(this.options.db).listWorkItems(sessionId)
        .map((item) => (item.input as { familyBaseline?: { candidateInventoryIds?: unknown } }).familyBaseline)
        .find((value) => Array.isArray(value?.candidateInventoryIds))
      : undefined;
    const launchCandidates = Array.isArray(baseline?.candidateInventoryIds)
      ? new Set(baseline.candidateInventoryIds.filter((id: unknown): id is string => typeof id === "string"))
      : null;
    const countedRepresentatives = active.config.explorationPurpose === "startup-opportunities"
      ? new Set(this.opportunities.familyView(active.threadId).families
        .filter((family) => family.counted).map((family) => family.representativeOptionId))
      : new Set<string>();
    const reviewRows = this.options.db.db.prepare(`
      SELECT stage.context_json FROM stage_results stage
      JOIN research_runs previous ON previous.id = stage.research_run_id
      WHERE previous.thread_id = ? AND previous.rowid < (SELECT rowid FROM research_runs WHERE id = ?)
        AND stage.stage_id = 'solution-set-review' AND stage.selection_key NOT LIKE 'preliminary:%'
    `).all(active.threadId, active.runId) as Array<{ context_json: string }>;
    const acceptedIds = new Set<string>();
    for (const row of reviewRows) {
      const value = JSON.parse(row.context_json) as { solutionSetReview?: { acceptedSolutionIds?: unknown } };
      const ids = value.solutionSetReview?.acceptedSolutionIds;
      if (Array.isArray(ids)) {
        for (const id of ids) if (typeof id === "string") acceptedIds.add(id);
      }
    }
    const rows = this.options.db.db.prepare(`
      SELECT solution.id, previous.rowid AS run_rowid, previous.workflow_session_id,
        solution.mechanism, solution.description, solution.respects_off_limits,
        solution.respects_off_limits_why, solution.key_assumption,
        solution.why_current_approach_may_suffice, solution.supporting_evidence_ids_json,
        solution.contrary_evidence_ids_json, solution.unknowns_json,
        solution.startup_opportunity_json, solution.bigger_problem_json, solution.slice_json,
        solution.criteria_fit_json, solution.first_test_json
      FROM solutions solution JOIN research_runs previous ON previous.id = solution.research_run_id
      WHERE previous.thread_id = ? AND previous.id <> ?
      ORDER BY previous.rowid DESC, solution.option_position, solution.id
    `).all(active.threadId, active.runId) as Array<{
      id: string; run_rowid: number; workflow_session_id: string | null;
      mechanism: string; description: string; respects_off_limits: number;
      respects_off_limits_why: string; key_assumption: string | null;
      why_current_approach_may_suffice: string | null;
      supporting_evidence_ids_json: string | null; contrary_evidence_ids_json: string | null;
      unknowns_json: string | null; startup_opportunity_json: string | null;
      bigger_problem_json: string | null; slice_json: string | null; criteria_fit_json: string | null; first_test_json: string | null;
    }>;
    const currentRun = this.options.db.db.prepare("SELECT rowid AS run_rowid FROM research_runs WHERE id = ?")
      .get(active.runId) as { run_rowid: number };
    // Keep launch candidates fixed, while including this session's additions and live accepted family roots.
    const visibleRows = rows.filter((row) => countedRepresentatives.has(row.id)
      || (row.run_rowid < currentRun.run_rowid
        && (!launchCandidates || launchCandidates.has(row.id) || row.workflow_session_id === sessionId)));
    if (active.config.explorationPurpose === "startup-opportunities") {
      const priorIds = new Set(visibleRows.map((row) => row.id));
      // Keep the legacy family's chosen option as the accepted root in the new review.
      for (const id of countedRepresentatives) if (priorIds.has(id)) acceptedIds.add(id);
    }
    const parseStrings = (json: string | null): string[] => {
      if (!json) return [];
      const value = JSON.parse(json) as unknown;
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    };
    const items: SolutionSetItem[] = visibleRows.map((row) => {
      const option = {
        mechanism: row.mechanism.trim() || "Older saved mechanism",
        description: row.description.trim() || "No older description was recorded.",
        keyAssumption: row.key_assumption?.trim() || "Not recorded in the older solution.",
        whyCurrentApproachMaySuffice: row.why_current_approach_may_suffice?.trim() || "Not recorded in the older solution.",
        supportingEvidenceIds: parseStrings(row.supporting_evidence_ids_json),
        contraryEvidenceIds: parseStrings(row.contrary_evidence_ids_json),
        unknowns: parseStrings(row.unknowns_json),
        respectsOffLimits: Boolean(row.respects_off_limits),
        respectsOffLimitsWhy: row.respects_off_limits_why.trim() || "Not recorded in the older solution.",
      };
      return {
        id: row.id,
        option: row.criteria_fit_json
          ? WorkflowV2GoalSolutionOptionSchema.parse({ ...option,
            biggerProblem: JSON.parse(row.bigger_problem_json ?? "null") as unknown,
            slice: JSON.parse(row.slice_json ?? "null") as unknown,
            criteriaFit: JSON.parse(row.criteria_fit_json) as unknown,
            firstTest: JSON.parse(row.first_test_json ?? "null") as unknown,
            ...(row.startup_opportunity_json ? { startupOpportunity: JSON.parse(row.startup_opportunity_json) as unknown } : {}) })
          : row.startup_opportunity_json
          ? WorkflowV2StartupSolutionOptionSchema.parse({ ...option,
            startupOpportunity: JSON.parse(row.startup_opportunity_json) as unknown })
          : WorkflowV2SolutionOptionSchema.parse(option),
      };
    });
    const ordered = [
      ...items.filter((item) => acceptedIds.has(item.id)),
      ...items.filter((item) => !acceptedIds.has(item.id)),
    ];
    const accepted: SolutionSetItem[] = [];
    const other: SolutionSetItem[] = [];
    const omittedSolutionIds: string[] = [];
    let characters = 0;
    for (const item of ordered) {
      const size = JSON.stringify(item).length;
      if (accepted.length + other.length >= 64 || characters + size > 60_000) {
        omittedSolutionIds.push(item.id);
        continue;
      }
      characters += size;
      (acceptedIds.has(item.id) ? accepted : other).push(item);
    }
    return {
      accepted, other, omittedSolutionIds,
      acceptedCount: items.filter((item) => acceptedIds.has(item.id)).length,
    };
  }

  private dependencies(active: ActiveRun) {
    const workflow = active.workflow;
    if (!workflow) throw new Error("The current workflow must be initialized before research starts");
    const modelClient = this.instrumentedModel(active);
    const search = this.instrumentedSearch(active);
    const frame = new ResearchFrameRepository(this.options.db).forRun(active.runId)?.approved;
    const allocation = active.researchAllowance
      ? researchSearchAllocation(active.researchAllowance.maxSearches,
        workflow.rankProblemCandidates ? active.config.discoveryDepth : "standard", Boolean(workflow.read("source-routes")), frame?.languages.length ?? 1) : null;
    if (!workflow.read("source-routes") && !workflow.read("source-routing-legacy-notice")) {
      workflow.save("source-routing-legacy-notice", { previousPolicy: active.config.audienceSourcePolicy ?? "web" });
      this.progress(active, "This saved run now routes new searches by evidence intent. Completed searches and planner outputs are reused.");
    }
    return {
      modelClient: workflow.discoveryClient(modelClient),
      search: workflow.search(search),
      existingSources: () => this.savedRunSources(active.runId),
      existingFactors: () => this.options.db.db.prepare(`SELECT factor.source_role AS sourceRole,
        source.canonical_url AS url FROM factors factor JOIN sources source ON source.id = factor.source_id
        WHERE factor.research_run_id = ?`).all(active.runId).map(row => {
          const factor = row as { sourceRole: string; url: string };
          return { sourceRole: factor.sourceRole, source: { url: factor.url } };
        }),
      model: active.config.model,
      reasoningEffort: active.config.reasoningEffort,
      depth: active.config.discoveryDepth,
      ...(workflow.read("source-routes") && frame ? { frame } : {}),
      guided: this.usesWorkGuidance(active.runId),
      smallHarvestBatches: workflow.smallHarvestBatches,
      rankCandidates: workflow.rankProblemCandidates,
      ...(!workflow.rankProblemCandidates ? { candidateLimit: DEFAULT_PROBLEM_CANDIDATE_LIMIT } : {}),
      assessProblemAudience: workflow.read<{ version: number }>("problem-audience-assessment")?.version === 1,
      ...(allocation ? {
        candidateLimit: allocation.candidateLimit,
        queryCountByMode: { domain: allocation.domainQueries, audience: allocation.audienceQueries },
        searchConcurrency: 1,
        researchAngles: this.researchAngleItems(active).filter((item) => item.state !== "skipped").map((item) => {
          const input = item.input as { name: string; sourceClass: ResearchAngleSourceClass };
          return { name: input.name, sourceClass: input.sourceClass };
        }),
        onPlannedQueries: (mode: HarvestMode, queries: PlannedQuery[]) => this.assignResearchAngleQueries(active, mode, queries),
        onQueryResult: (mode: HarvestMode, query: PlannedQuery, sources: Source[] | null, error?: unknown) =>
          this.finishResearchAngleQuery(active, mode, query, sources, error),
      } : {}),
      signal: active.abortController.signal,
      onProjection: (message: string) => this.progress(active, message),
      workflowVersion: 2 as const,
      prompt: (name: string) => workflow.resolvePrompt(name as WorkflowV2StageId).text,
      sourceRouting: {
        now: new Date(workflow.read<string>("source-route-start")!),
        preserveHistoricalSources: !workflow.read("source-routes"),
        // A run's routing contract also fixes the canonical identity of each paid search.
        legacyPublicationDomainCategory: workflow.read<{ version: number }>("source-routes")?.version !== 2,
        ...(workflow.read("source-routes") && frame ? { goalKind: frame.goalKind, languages: frame.languages } : {}),
      },
      // Old planner stage inputs must remain identical so its completed output can be reused.
      ...(!workflow.read("source-routes") ? {
        audienceSearch: { includeDomains: active.config.audienceSourcePolicy === "communities" ? ["reddit.com", "news.ycombinator.com"] : [] },
      } : {}),
    };
  }

  private researchAngleItems(active: ActiveRun) {
    if (!active.researchRequest) return [];
    return new WorkflowRepository(this.options.db).listWorkItems(active.researchRequest.sessionId)
      .filter((item) => item.kind === "research-angle" && item.parentItemId === active.researchRequest?.workItemId);
  }

  private assignResearchAngleQueries(active: ActiveRun, mode: HarvestMode, queries: PlannedQuery[]): void {
    if (!active.researchRequest || queries.length === 0) return;
    const workflows = new WorkflowRepository(this.options.db);
    const preferred = mode === "domain"
      ? new Set<ResearchAngleSourceClass>(["current-alternative", "contrary-evidence", "measured-behavior"])
      : new Set<ResearchAngleSourceClass>(["firsthand-experience", "buying-signal", "measured-behavior"]);
    const items = this.researchAngleItems(active);
    const used = new Set(items.flatMap((item) => {
      const output = item.outputRefs as { query?: string } | null;
      return output?.query ? [normalizeSearchQuery(output.query)] : [];
    }));
    const changed: string[] = [];
    this.options.db.immediateTransaction(() => {
      for (const item of items) {
        if (item.state !== "ready") continue;
        const input = item.input as { sourceClass: ResearchAngleSourceClass };
        if (!preferred.has(input.sourceClass)) continue;
        const match = queries.find((query) => query.intent === input.sourceClass
          && !used.has(normalizeSearchQuery(query.query)));
        if (!match) continue;
        used.add(normalizeSearchQuery(match.query));
        workflows.updateWorkItem(item.id, "running", {
          outputRefs: { runId: active.runId, query: match.query, intent: match.intent, mode },
        });
        changed.push(item.id);
      }
    });
    if (changed.length) this.progress(active, `Researching ${changed.length} named angle${changed.length === 1 ? "" : "s"}`, "searching");
  }

  private finishResearchAngleQuery(
    active: ActiveRun, mode: HarvestMode, query: PlannedQuery, sources: Source[] | null, error?: unknown,
  ): void {
    if (!active.researchRequest) return;
    const item = this.researchAngleItems(active).find((candidate) => {
      const output = candidate.outputRefs as { query?: string; mode?: string } | null;
      return candidate.state === "running" && output?.mode === mode
        && output.query && normalizeSearchQuery(output.query) === normalizeSearchQuery(query.query);
    });
    if (!item) return;
    const linkedSources = sources ? [...new Map(sources.map((source) =>
      [source.url, { title: source.title, url: source.url }])).values()] : [];
    const sourceCount = linkedSources.length;
    this.options.db.immediateTransaction(() => new WorkflowRepository(this.options.db).updateWorkItem(
      item.id, error ? "failed" : "succeeded", {
        outputRefs: { ...(item.outputRefs as object), sourceCount, sources: linkedSources,
          ...(error ? { gap: error instanceof Error ? error.message : "The search failed." }
            : sourceCount === 0 ? { gap: "No source was returned for this angle." } : {}),
        },
      },
    ));
    this.progress(active, error ? "A named research angle failed" : "A named research angle finished", "searching");
  }

  private instrumentedModel(active: ActiveRun, beforeUncachedDispatch?: () => void, stageModel = active.config.model): StructuredModelClient {
    const baseClient = this.options.modelClients?.[stageModel.providerId];
    if (!baseClient) throw new Error(`Model provider ${stageModel.providerId} is unavailable`);
    const session = this.options.db.db.prepare("SELECT workflow_session_id FROM research_runs WHERE id = ?")
      .get(active.runId) as { workflow_session_id: string | null } | undefined;
    const client = session?.workflow_session_id && this.options.modelScheduler
      ? scheduledModelClient(baseClient, this.options.modelScheduler, active.threadId) : baseClient;
    return {
      structuredCompletion: async <T>(request: StructuredStageRequest<T>) => {
        active.abortController.signal.throwIfAborted();
        const stage = runtimeStage(request.stage);
        this.progress(active, "Waiting for model availability", stage, "waiting");
        if (!sameModelRef(request.model, stageModel)) throw new Error("Stage model does not match the selected stage model");
        const providerId = stageModel.providerId;
        const preparedIdentity = client.prepareIdentity
          ? await client.prepareIdentity()
          : client.preparedIdentity?.();
        active.abortController.signal.throwIfAborted();
        const disabledRepairRequest = { ...request, repairPolicy: "disabled" as const };
        const reusable = this.generationAttempts.findCompleted(active.runId, request, preparedIdentity)
          ?? (request.repairPolicy === "disabled" ? null
            : this.generationAttempts.findCompleted(active.runId, disabledRepairRequest, preparedIdentity));
        if (reusable) {
          active.generationProvenance.set(request.generationId, reusable.generationId);
          return { output: reusable.output, metadata: reusable.metadata as GenerationMetadata };
        }
        beforeUncachedDispatch?.();
        const remainingTaskCalls = this.remainingWorkflowTaskCalls(active, "model-call");
        if (remainingTaskCalls !== null && remainingTaskCalls < 1) {
          throw new AppError("BUDGET_TOO_SMALL", "This workflow task used its model-call reservation.");
        }
        if (active.areaBudget && !this.investigatorBudgetAvailable(active, 1, 0)) {
          throw new AppError("BUDGET_TOO_SMALL", "This research area used its saved model-call allowance.");
        }
        if (active.researchAllowance
          && this.ledger.countProviderCalls(active.runId, providerId) >= active.researchAllowance.maxModelCalls) {
          throw new AppError("BUDGET_TOO_SMALL", "This research request used its model-call allowance.");
        }
        this.enforceRunawayBackstop(active, providerId, active.projectedCodexCalls);
        const boundedRequest = remainingTaskCalls === 1 ? disabledRepairRequest : request;
        const attempt = this.generationAttempts.prepare(active.runId, boundedRequest, preparedIdentity);
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
            ...boundedRequest,
            onDispatched: () => {
              reservation ??= this.ledger.reserve(active.runId, "structured-completion", providerId, stageModel.modelId, 0, attempt.id);
              dispatched = true;
              this.generationAttempts.markDispatched(attempt.id);
              if (this.activeRuns.get(active.runId)?.abortController === active.abortController) this.progress(active, "Model request dispatched", stage, "dispatched");
              request.onDispatched?.();
            },
            onAccepted: (metadata) => {
              accepted = true;
              this.generationAttempts.markAccepted(attempt.id, metadata);
              if (this.activeRuns.get(active.runId)?.abortController === active.abortController) this.progress(active, "Model request accepted", stage, "accepted");
              request.onAccepted?.(metadata);
            },
            onSchemaInvalid: (failure) => {
              this.generationAttempts.recordSchemaInvalidOutput(attempt.id, failure);
              request.onSchemaInvalid?.(failure);
            },
          });
          if (!reservation) {
            reservation = this.ledger.reserve(active.runId, "structured-completion", providerId, stageModel.modelId, 0, attempt.id);
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
          if (this.activeRuns.get(active.runId)?.abortController === active.abortController) this.progress(active, "Model call completed", stage, null);
          return result;
        } catch (error) {
          const failedAttempts = error instanceof ProviderFailure ? error.attempts : undefined;
          const unretained = error instanceof ProviderFailure ? error.unretainedSchemaFailure : undefined;
          const failedCostUsd = failedAttempts ? reportedAttemptCost(failedAttempts) : null;
          if (!reservation && failedAttempts?.length) {
            reservation = this.ledger.reserve(active.runId, "structured-completion", providerId, stageModel.modelId, 0, attempt.id);
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
              ...(unretained ? { output: unretained.output } : {}),
              ...(failedAttempts ? {
                attemptMetadata: { attempts: failedAttempts, ...(unretained ? { unretainedSchemaFailure: {
                  generationId: unretained.generationId, issues: unretained.issues,
                } } : {}) },
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

  private instrumentedSearch(active: ActiveRun): Pick<SearchClient, "provider" | "search" | "providerForRoute" | "searchWithDispatch"> {
    const readiness = this.options.searchReady?.();
    const available = {
      exa: Boolean(this.options.searchClients?.exa) && readiness?.exa !== false,
      perplexity: Boolean(this.options.searchClients?.perplexity) && readiness?.perplexity !== false,
    };
    const defaultProvider = active.config.searchProvider === "auto"
      ? available.exa || available.perplexity ? chooseSearchProvider("auto", available) : "exa" : active.config.searchProvider;
    const dispatch = async (query: string, options?: SearchOptions, onDispatched?: () => void, preparedAttemptId?: string) => {
      const provider = options?.provider ?? chooseSearchProvider(active.config.searchProvider, available, options?.route);
      const client = this.options.searchClients?.[provider];
      active.abortController.signal.throwIfAborted();
      if (!client) throw new AppError("conflict", `Connect ${provider === "exa" ? "Exa" : "Perplexity"} before discovering problems.`);
      const remainingTaskSearches = this.remainingWorkflowTaskCalls(active, "search");
      if (remainingTaskSearches !== null && remainingTaskSearches < 1) {
        throw new AppError("BUDGET_TOO_SMALL", "This workflow task used its search reservation.");
      }
      if (active.areaBudget && !this.investigatorBudgetAvailable(active, 0, 1)) {
        throw new AppError("BUDGET_TOO_SMALL", "This research area used its saved search allowance.");
      }
      if (active.researchAllowance
        && this.ledger.countProviderCalls(active.runId, "exa") + this.ledger.countProviderCalls(active.runId, "perplexity") >= active.researchAllowance.maxSearches) {
        throw new AppError("BUDGET_TOO_SMALL", "This research request used its search allowance.");
      }
      this.enforceRunawayBackstop(active, provider, active.projectedSearches);
      const reservation = active.followUpSearchReservation
        ?? this.ledger.reserve(active.runId, "search", provider, null, provider === "exa" ? 0.02 : 0.005, undefined,
          preparedAttemptId ? { searchDispatch: { version: 1, attemptId: preparedAttemptId } } : undefined);
      active.followUpSearchReservation = null;
      if (active.areaBudget) active.areaBudget.pendingSearches = (active.areaBudget.pendingSearches ?? 0) + 1;
      let providerInvoked = false;
      try {
        this.progress(active, `Searching ${provider === "exa" ? "Exa" : "Perplexity"}: ${query}`, "searching", null);
        if (provider === "perplexity" && options?.category) this.progress(active,
          `${options.route ?? "Search"} uses Perplexity without Exa's ${options.category} category; domain and date filters still apply.`, "searching", null);
        if (provider === "exa" && options?.languages?.some((language) => language !== "en")) this.progress(active,
          "Exa has no language filter. This leg relies on the language of its query.", "searching", null);
        active.abortController.signal.throwIfAborted();
        options?.signal?.throwIfAborted();
        onDispatched?.();
        providerInvoked = true;
        const sources = filterRoutedSources(await client.search(query, options), options);
        if (this.activeRuns.get(active.runId)?.abortController === active.abortController) this.progress(active,
          `Found ${sources.length} ${sources.length === 1 ? "source" : "sources"} for: ${query}`, "searching", null);
        return sources;
      } catch (error) {
        if (this.activeRuns.get(active.runId)?.abortController === active.abortController) this.progress(active,
          `${active.abortController.signal.aborted ? "Cancelled search" : "Search failed"}: ${query}`, "searching", null);
        throw error;
      }
      finally {
        if (active.areaBudget) active.areaBudget.pendingSearches = Math.max(0, (active.areaBudget.pendingSearches ?? 0) - 1);
        if (!providerInvoked) this.ledger.release(reservation.id);
        else if (this.activeRuns.get(active.runId)?.abortController === active.abortController) {
          this.ledger.commit(reservation.id, reservation.reservedUsd, {
            ...(active.areaBudget ? { areaId: active.areaBudget.areaId } : {}),
            ...(preparedAttemptId ? { searchDispatch: { version: 1, attemptId: preparedAttemptId } } : {}),
          });
        }
      }
    };
    return {
      provider: defaultProvider,
      providerForRoute: (route) => chooseSearchProvider(active.config.searchProvider, available, route),
      search: dispatch,
      searchWithDispatch: dispatch,
    };
  }

  /** Bounded tasks spend saved reservations; explicit retries count work after their admission baseline. */
  private remainingWorkflowTaskCalls(active: ActiveRun, kind: "model-call" | "search"): number | null {
    if (this.usesWorkGuidance(active.runId)) return null;
    const linked = this.options.db.db.prepare(`SELECT workflow_session_id FROM research_runs WHERE id = ?`)
      .get(active.runId) as { workflow_session_id: string | null } | undefined;
    if (!linked?.workflow_session_id) return null;
    const item = this.options.db.db.prepare(`SELECT id, state FROM workflow_work_items
      WHERE session_id = ? AND json_extract(output_refs_json, '$.runId') = ?
        AND kind IN ('prepare-frame','discovery','known-problem','generate-ideas','research-request','assess-candidate') LIMIT 1`)
      .get(linked.workflow_session_id, active.runId) as { id: string; state: string } | undefined;
    if (!item) {
      const existing = this.options.db.db.prepare(`SELECT 1 FROM workflow_budget_entries
        WHERE session_id = ? LIMIT 1`).get(linked.workflow_session_id);
      if (existing) throw new AppError("BUDGET_TOO_SMALL", "The workflow run has no saved task reservation.");
      return null;
    }
    // A human can analyze a saved option after its generation task has settled. That
    // explicit follow-up is charged to the run, outside the finished task's reservation.
    if (item.state === "succeeded" && this.options.db.db.prepare(`SELECT 1 FROM solutions
      WHERE research_run_id = ? AND selected_at IS NOT NULL LIMIT 1`).get(active.runId)) return null;
    const reserved = this.options.db.db.prepare(`SELECT COALESCE(SUM(reserved_units),0) AS units
      FROM workflow_budget_entries WHERE work_item_id = ? AND kind = ? AND state = 'reserved'`)
      .get(item.id, kind) as { units: number };
    if (reserved.units < 1) throw new AppError("BUDGET_TOO_SMALL", `The workflow task has no ${kind} reservation.`);
    const used = kind === "search"
      ? (this.options.db.db.prepare(`SELECT COUNT(*) AS count FROM cost_ledger
          WHERE research_run_id = ? AND operation = 'search' AND status IN ('reserved','committed')`)
        .get(active.runId) as { count: number }).count
      : (this.options.db.db.prepare(`SELECT COALESCE(SUM(
          CASE WHEN attempt_metadata_json IS NOT NULL AND json_type(attempt_metadata_json, '$.attempts') = 'array'
            THEN MAX(1, json_array_length(attempt_metadata_json, '$.attempts'))
            WHEN status IN ('dispatched','accepted','completed','failed','cancelled','interrupted')
              AND terminal_kind IS NOT 'never-dispatched' THEN 1 ELSE 0 END
          ),0) AS count FROM generation_attempts WHERE research_run_id = ?`)
        .get(active.runId) as { count: number }).count;
    const baselineRow = this.options.db.db.prepare(`SELECT value_json FROM workflow_snapshots WHERE research_run_id = ?
      AND snapshot_key LIKE 'task-budget-retry-baseline:%' ORDER BY rowid DESC LIMIT 1`)
      .get(active.runId) as { value_json: string } | undefined;
    const baseline = baselineRow ? JSON.parse(baselineRow.value_json) as { modelCalls: number; searches: number } : null;
    // Explicit retries reserve fresh work. Earlier settled usage and uncertainty stay charged to their original entries.
    return reserved.units - Math.max(0, used - (kind === "model-call" ? baseline?.modelCalls ?? 0 : baseline?.searches ?? 0));
  }

  /** Estimates must not become dispatch limits in a depth-guided workflow. */
  private usesWorkGuidance(runId: string): boolean {
    const row = this.options.db.db.prepare(`SELECT json_extract(session.contract_json, '$.limits.enforced') AS enforced
      FROM research_runs run JOIN workflow_sessions session ON session.id = run.workflow_session_id
      WHERE run.id = ?`).get(runId) as { enforced: number | null } | undefined;
    return row?.enforced === 0;
  }

  private enforceRunawayBackstop(active: ActiveRun, provider: string, projection: number): void {
    if (this.usesWorkGuidance(active.runId)) return;
    const count = this.ledger.countProviderCalls(active.runId, provider);
    if (count >= Math.max(6, projection * 3)) throw new Error(`Runaway backstop triggered for ${provider}; the run exceeded 3× its projected calls.`);
  }

  private progress(active: ActiveRun, message: string, stage?: RuntimeStage, modelState?: "waiting" | "dispatched" | "accepted" | null): void {
    if (stage) active.stage = stage;
    if (modelState !== undefined) active.modelState = modelState;
    const codexCalls = this.ledger.countProviderCalls(active.runId, active.config.model.providerId);
    const searches = this.ledger.countProviderCalls(active.runId, "exa") + this.ledger.countProviderCalls(active.runId, "perplexity");
    const details = { message, codexCalls, searches, ...(active.stage ? { stage: active.stage } : {}),
      modelState: active.modelState ?? null, elapsedMs: Math.max(0, Date.now() - active.startedAt),
      operationStartedAt: new Date(active.startedAt).toISOString(), operationElapsedMs: Math.max(0, Date.now() - active.startedAt),
      lastSuccessfulCheckpoint: this.lastSuccessfulCheckpoint(active.runId) };
    this.emit({ type: "run-progress", runId: active.runId, threadId: active.threadId, ...details });
  }

  private lastSuccessfulCheckpoint(runId: string): string | null {
    const row = this.options.db.db.prepare(`SELECT stage_id FROM stage_results WHERE research_run_id = ? ORDER BY completed_at DESC, rowid DESC LIMIT 1`)
      .get(runId) as { stage_id: string } | undefined;
    return row?.stage_id ?? null;
  }

  private fail(active: ActiveRun, error: unknown, status?: "failed" | "cancelled"): void {
    if (this.activeRuns.get(active.runId) !== active) return;
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
    this.enforceRunawayBackstop(active, providerId, active.projectedCodexCalls);
    const searchProvider = this.workflowSearchClient(active.config.searchProvider).provider;
    this.enforceRunawayBackstop(active, searchProvider, active.projectedSearches);
    active.followUpModelReservation = this.ledger.reserve(
      active.runId, "evidence-follow-up", providerId, active.config.model.modelId, 0,
    );
    try {
      active.followUpSearchReservation = this.ledger.reserve(
        active.runId,
        "evidence-follow-up-search",
        searchProvider,
        null,
        searchProvider === "exa" ? 0.02 : 0.005,
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
    this.activeRuns.delete(active.runId);
    this.progress(active, `${result.factors.length} quote-verified follow-up observations saved`);
    this.updateThread(active.threadId, "solutions-ready");
    this.emit({ type: "run-completed", runId: active.runId, threadId: active.threadId, problemId: active.problemId });
  }

  private failEvidenceFollowUp(active: ActiveRun, error: unknown): void {
    const saved = this.followUps.find(active.runId);
    if (!saved || ["completed", "failed"].includes(saved.status)) return;
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

function sha256Area(areaId: string): string {
  return createHash("sha256").update(areaId).digest("hex").slice(0, 16);
}

function runtimeStage(stageKey: string): RuntimeStage {
  const stage = stageKey.split(":")[0];
  if (stage === "query-plan") return "searching";
  if (stage === "factor-harvest") return "extracting";
  if (stage === "problem-candidates" || stage === "problem-kill") return "synthesizing-problems";
  if (stage === "solutions" || stage === "solution-set-review") return "generating-options";
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
  frame?: ResearchFrame;
  frameId?: string;
};

function parseSavedExpansion(value: unknown): PersistableOpportunityExpansion {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Saved opportunity expansion is invalid.");
  const record = value as Record<string, unknown>;
  const frame = record.frame === undefined ? undefined : ResearchFrameSchema.parse(record.frame);
  const output = parseOpportunityExpansionOutput(record.output, {
    ...(typeof record.schemaRevision === "number" ? { schemaRevision: record.schemaRevision } : {}),
    ...(frame ? { frame } : {}),
    ...(Array.isArray(record.evidenceSourceIds) && record.evidenceSourceIds.every(id => typeof id === "string")
      ? { evidenceSourceIds: record.evidenceSourceIds as string[] } : {}),
  });
  if (!Array.isArray(record.candidateIds) || record.candidateIds.some((id) => typeof id !== "string")) {
    throw new Error("Saved opportunity expansion candidate IDs are invalid.");
  }
  return { ...withExpansionIds(output, record.candidateIds as string[]),
    ...(frame ? { frame } : {}), ...(typeof record.frameId === "string" ? { frameId: record.frameId } : {}) };
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
