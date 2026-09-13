import { createHash } from "node:crypto";
import type { DatabaseClient } from "../db/client";
import { CostLedgerRepository, type CostReservation } from "../db/repositories/cost-ledger";
import { DiscoveryRepository } from "../db/repositories/discovery";
import { EvidenceFollowUpRepository } from "../db/repositories/evidence-follow-ups";
import { GenerationAttemptRepository } from "../db/repositories/generation-attempts";
import { ResearchRunRepository } from "../db/repositories/research-runs";
import type { SearchClient, SearchOptions, SearchProvider } from "../providers/search";
import { ProviderFailure, type GenerationMetadata, type StructuredModelClient, type StructuredStageRequest } from "../providers/structured";
import { AppError } from "../shared/errors";
import type { ResearchEvent } from "../shared/ipc";
import { DEFAULT_IDEA_COUNT, RunConfigSchema, sameModelRef, type RunConfig } from "../shared/schemas";
import { ScopeSchema, WorkflowV2CompatibleDecisionAnalysisOutputSchema, WorkflowV2RiskEvaluationOutputSchema, WorkflowV2RiskReassessmentOutputSchema, type Scope } from "../shared/structured-output-schemas";
import { analyzeSelectedOption, evaluateSelectedOptionRisk, produceDevelopmentOptions, reassessSelectedOption, reassessSelectedOptionRisk, type WorkflowV2EvidenceItem } from "./development";
import { discoverProblems, discoveryRunProjection, harvestEvidenceFollowUp, harvestFactors, type HarvestResult } from "./discovery";
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
  stage?: RuntimeStage;
  modelState?: "waiting" | "dispatched" | "accepted" | null;
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

  constructor(private readonly options: ResearchEngineOptions) {
    this.runs = new ResearchRunRepository(options.db);
    this.ledger = new CostLedgerRepository(options.db);
    this.generationAttempts = new GenerationAttemptRepository(options.db);
    this.followUps = new EvidenceFollowUpRepository(options.db);
    this.discovery = new DiscoveryRepository(options.db);
    recoverInterruptedEvidenceFollowUps(options.db);
  }

  getActiveRunIds(): ReadonlySet<string> { return new Set(this.activeRuns.keys()); }

  async shutdown(): Promise<void> {
    for (const runId of this.getActiveRunIds()) {
      try { this.cancelRun(runId); } catch { /* the run ended before shutdown reached it */ }
    }
    await Promise.allSettled([...this.executions.values()]);
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
    this.begin(runId, row.thread_id, row.problem_id, config, true);
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
      projectedCodexCalls: 1,
      projectedSearches: 1,
      workflow: new WorkflowExecution(this.options.db, runId),
      followUpModelReservation: null,
      followUpSearchReservation: null,
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
      projectedCodexCalls: completedCalls + 2, projectedSearches: 0, workflow: new WorkflowExecution(this.options.db, runId), followUpModelReservation: null, followUpSearchReservation: null };
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
      if (!waiting.awaiting_selection && selected) return;
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
          workflow.flushPendingStages(["query-plan", "factor-harvest"]);
          workflow.save("harvest", snapshot);
        });
      }
      this.progress(active, `${harvest.factors.length} observations from ${harvest.sources.length} sources`);
      const result = await discoverProblems(scope, harvest.factors, harvest.sources, { ...deps, idFactory: workflow.idFactory("problems") });
      this.discovery.persistProblems(active.runId, result.killSources, result.problems, result.blockedCandidates, () => {
        workflow.flushPendingStages(["problem-candidates", "problem-kill"]);
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
      const deps = {
        modelClient: this.instrumentedModel(active), model: active.config.model,
        ideaCount: active.config.ideaCount,
        explorationPurpose: active.config.explorationPurpose,
        reasoningEffort: active.config.reasoningEffort, signal: active.abortController.signal,
        resolvePrompt: workflow.resolvePrompt,
      };
      const savedSolutions = workflow.repository.findStageResult(active.runId, "solutions");
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
      } else {
        this.progress(active, `Generating up to ${active.config.ideaCount ?? DEFAULT_IDEA_COUNT} ideas`, "generating-options");
        const result = await produceDevelopmentOptions(context, deps);
        active.abortController.signal.throwIfAborted();
        this.options.db.immediateTransaction(() => {
          workflow.repository.saveSolutionOptions(active.runId, active.problemId!, result.options.map(({ problemId, ...option }) => { void problemId; return option; }));
          workflow.commitStage("solutions", result.request, result.resolvedPrompt, result.metadata,
            { options: result.options.map(({ id, problemId, ...option }) => { void id; void problemId; return option; }) }, context);
        });
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
      this.progress(active, "Analyzing the selected option and its next experiment", "analyzing-option");
      const result = await analyzeSelectedOption(context, option, deps, riskEvaluation);
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

  private instrumentedModel(active: ActiveRun): StructuredModelClient {
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
          return { output: reusable.output, metadata: reusable.metadata as GenerationMetadata };
        }
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
          const result = await client.structuredCompletion({
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
    this.logJob(event.runId, event.threadId, event.type, event);
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
      active.workflow!.flushPendingStages(["factor-harvest"]);
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
        riskGenerationId: riskResult.request?.generationId ?? this.reassessmentRiskGenerationId(active.runId), analysisGenerationId: analysisResult.request.generationId });
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

  private evidenceFollowUpItems(followUp: ReturnType<EvidenceFollowUpRepository["find"]> & {}): WorkflowV2EvidenceItem[] {
    const sourceIds = followUp.sourceIds;
    const factorIds = followUp.factorIds;
    const sources = sourceIds.length ? this.options.db.db.prepare(`SELECT id, title, canonical_url AS url FROM sources WHERE id IN (${sourceIds.map(() => "?").join(",")})`).all(...sourceIds) : [];
    const factors = factorIds.length ? this.options.db.db.prepare(`SELECT id, source_id AS sourceId, subject, behavior, quote, model_confidence AS modelConfidence, uncertainty FROM factors WHERE id IN (${factorIds.map(() => "?").join(",")})`).all(...factorIds) : [];
    const sentinel = { sourceId: "scraply:evidence-follow-up-outcome", content: { question: followUp.question, status: "completed",
      searchedSourceCount: sourceIds.length, quoteVerifiedObservationCount: factorIds.length,
      conclusion: factorIds.length === 0 ? "The follow-up found no new quote-verified support." : "Only the quote-verified observations below are new evidence." } };
    return [sentinel, ...factors.map((factor) => {
      const sourceId = (factor as { sourceId: string }).sourceId;
      return { sourceId: `scraply:evidence-follow-up-factor:${(factor as { id: string }).id}`, content: {
        factor, source: sources.find((item) => (item as { id: string }).id === sourceId) ?? { id: sourceId },
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
