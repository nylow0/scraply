import type { DatabaseClient } from "../db/client";
import { CostLedgerRepository } from "../db/repositories/cost-ledger";
import { DevelopmentRepository } from "../db/repositories/development";
import { DiscoveryRepository } from "../db/repositories/discovery";
import { GenerationAttemptRepository } from "../db/repositories/generation-attempts";
import { ResearchRunRepository } from "../db/repositories/research-runs";
import type { SearchClient, SearchOptions, SearchProvider } from "../providers/search";
import { ProviderFailure, type GenerationMetadata, type StructuredModelClient, type StructuredStageRequest } from "../providers/structured";
import { AppError } from "../shared/errors";
import { MAX_DEVELOPMENT_PROJECTED_CALLS } from "../shared/development-projection";
import type { ResearchEvent } from "../shared/ipc";
import { RunConfigSchema, sameModelRef, type RunConfig } from "../shared/schemas";
import { ScopeSchema, type Scope } from "../shared/structured-output-schemas";
import { analyzeSelectedOption, produceDevelopmentOptions, runPersistedDevelopment } from "./development";
import { discoverProblems, discoveryRunProjection, harvestFactors, type HarvestResult, type HarvestedFactor, type HarvestedSource } from "./discovery";
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
}

export class ResearchEngine {
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly executions = new Map<string, Promise<void>>();
  private readonly runs: ResearchRunRepository;
  private readonly ledger: CostLedgerRepository;
  private readonly generationAttempts: GenerationAttemptRepository;
  private readonly discovery: DiscoveryRepository;
  private readonly development: DevelopmentRepository;

  constructor(private readonly options: ResearchEngineOptions) {
    this.runs = new ResearchRunRepository(options.db);
    this.ledger = new CostLedgerRepository(options.db);
    this.generationAttempts = new GenerationAttemptRepository(options.db);
    this.discovery = new DiscoveryRepository(options.db);
    this.development = new DevelopmentRepository(options.db);
  }

  getActiveRunIds(): ReadonlySet<string> { return new Set(this.activeRuns.keys()); }

  async shutdown(): Promise<void> {
    for (const runId of this.getActiveRunIds()) {
      try { this.cancelRun(runId); } catch { /* the run ended before shutdown reached it */ }
    }
    await Promise.allSettled([...this.executions.values()]);
  }

  async startDiscovery(threadId: string, scope: Scope, config: RunConfig): Promise<string> {
    const parsedScope = ScopeSchema.parse(scope);
    const created = this.runs.create(threadId, config, null);
    if (!created.created) return created.runId;
    this.discovery.persistScope(created.runId, parsedScope);
    this.begin(created.runId, threadId, null, config);
    return created.runId;
  }

  async startKnownProblem(threadId: string, scope: Scope, problemStatement: string, config: RunConfig): Promise<string> {
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
    const created = this.runs.create(threadId, config, problemId);
    if (created.created) this.begin(created.runId, threadId, problemId, config);
    return created.runId;
  }

  async resumeRun(runId: string): Promise<void> {
    if (this.activeRuns.has(runId)) return;
    const row = this.options.db.db.prepare(`SELECT thread_id, status, config_json, problem_id FROM research_runs WHERE id = ?`)
      .get(runId) as { thread_id: string; status: string; config_json: string; problem_id: string | null } | undefined;
    const config = row ? RunConfigSchema.parse(JSON.parse(row.config_json)) : null;
    if (!row || !config || !["queued", "running", ...(config.workflowVersion === 2 ? ["failed", "cancelled"] : [])].includes(row.status)) {
      throw new AppError("conflict", "This research run has already ended and cannot be resumed.");
    }
    const uncertain = this.options.db.db.prepare(`
      SELECT 1 FROM generation_attempts
      WHERE research_run_id = ? AND status = 'interrupted' AND terminal_kind = 'process-lost'
      LIMIT 1
    `).get(runId);
    if (uncertain) {
      this.ledger.settleUncertain(runId, "A dispatched generation lost its terminal result during restart");
      throw new AppError("conflict", "A previous model request may have completed before the app restarted. Cancel this run and start a new one to avoid an automatic duplicate charge.");
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

  private assertThreadIdle(threadId: string, exceptRunId: string): void {
    const other = this.options.db.db.prepare("SELECT id FROM research_runs WHERE thread_id = ? AND id != ? AND status IN ('queued','running')")
      .get(threadId, exceptRunId);
    if (other) throw new AppError("conflict", "This project already has another active run.");
  }

  cancelRun(runId: string): void {
    const row = this.options.db.db.prepare("SELECT thread_id, status FROM research_runs WHERE id = ?").get(runId) as
      { thread_id: string; status: string } | undefined;
    if (!row) throw new AppError("not_found", "Research run not found.");
    if (!["queued", "running"].includes(row.status)) throw new AppError("conflict", "This research run has already ended.");
    const active = this.activeRuns.get(runId);
    if (active) {
      if (active.deadlineTimer) clearTimeout(active.deadlineTimer);
      active.abortController.abort(new Error("Cancelled by user"));
      this.activeRuns.delete(runId);
    }
    this.ledger.settleUncertain(runId, "Run cancelled while operations were in flight");
    this.runs.cancel(runId);
    this.updateThread(row.thread_id, "failed");
    this.emit({ type: "run-cancelled", runId, threadId: row.thread_id });
  }

  private begin(runId: string, threadId: string, problemId: string | null, config: RunConfig, resumed = false): void {
    const projection = problemId
      ? { modelCalls: config.workflowVersion === 2 ? 2 : MAX_DEVELOPMENT_PROJECTED_CALLS, searches: 0 }
      : discoveryRunProjection(config.discoveryDepth);
    const active: ActiveRun = {
      runId, threadId, problemId, config, abortController: new AbortController(), startedAt: Date.now(),
      projectedCodexCalls: projection.modelCalls, projectedSearches: projection.searches,
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
        if (this.executions.get(runId) === execution) this.executions.delete(runId);
      });
    this.executions.set(runId, execution);
  }

  private async execute(active: ActiveRun): Promise<void> {
    if (active.config.workflowVersion === 2) active.workflow = new WorkflowExecution(this.options.db, active.runId);
    if (active.problemId) await this.executeDevelopment(active);
    else await this.executeDiscovery(active);
    if (active.abortController.signal.aborted || !this.activeRuns.has(active.runId)) return;
    this.runs.finish(active.runId, "completed");
    if (active.deadlineTimer) clearTimeout(active.deadlineTimer);
    this.activeRuns.delete(active.runId);
    this.emit({ type: "run-completed", runId: active.runId, threadId: active.threadId, problemId: active.problemId });
    if (!active.problemId) { this.updateThread(active.threadId, "problems-ready"); return; }
    if (active.workflow) {
      const waiting = this.options.db.db.prepare("SELECT awaiting_selection FROM research_runs WHERE id = ?").get(active.runId) as { awaiting_selection: number };
      if (waiting.awaiting_selection) { this.updateThread(active.threadId, "solutions-ready"); return; }
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
    const scopeRow = this.options.db.db.prepare("SELECT title, audience, domain, observations, off_limits_json FROM scopes WHERE research_run_id = ?")
      .get(active.runId) as { title: string; audience: string; domain: string; observations: string; off_limits_json: string } | undefined;
    if (!scopeRow) throw new Error("Discovery scope is missing");
    const scope = ScopeSchema.parse({
      title: scopeRow.title,
      audience: scopeRow.audience,
      domain: scopeRow.domain,
      observations: scopeRow.observations,
      offLimits: JSON.parse(scopeRow.off_limits_json),
    });
    const deps = this.dependencies(active);
    if (active.workflow) {
      const workflow = active.workflow;
      if (workflow.read("discovery-completed")) return;
      let harvest = workflow.read<HarvestResult>("harvest");
      if (!harvest) {
        harvest = await harvestFactors(scope, { ...deps, idFactory: workflow.idFactory("harvest"), random: () => 0.5 });
        const snapshot = harvest;
        this.discovery.persistFactors(active.runId, harvest.sources, harvest.factors, () => workflow.save("harvest", snapshot));
      }
      this.progress(active, `${harvest.factors.length} observations from ${harvest.sources.length} sources`);
      const result = await discoverProblems(scope, harvest.factors, harvest.sources, { ...deps, idFactory: workflow.idFactory("problems") });
      this.discovery.persistProblems(active.runId, result.killSources, result.problems, result.blockedCandidates,
        () => workflow.save("discovery-completed", result));
      this.progress(active, `${result.problems.length} problems ready for your review`);
      return;
    }
    const existingCandidates = this.options.db.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM problems WHERE discovery_run_id = ?) +
        (SELECT COUNT(*) FROM rejected_problem_candidates WHERE discovery_run_id = ?) AS count
    `).get(active.runId, active.runId) as { count: number };
    if (existingCandidates.count > 0) return;
    const persistedFactors = this.options.db.db.prepare(`
      SELECT f.*, s.provider_source_id, s.canonical_url, s.title, s.retrieved_text, s.author, s.published_at,
             s.content_hash, s.retrieved_at
      FROM factors f JOIN sources s ON s.id = f.source_id
      WHERE f.research_run_id = ? ORDER BY f.created_at, f.id
    `).all(active.runId) as Array<Record<string, unknown>>;
    let factors: HarvestedFactor[];
    let sources: HarvestedSource[];
    if (persistedFactors.length > 0) {
      const byId = new Map<string, HarvestedSource>();
      factors = persistedFactors.map((row) => {
        const source: HarvestedSource = {
          id: String(row.source_id), providerSourceId: row.provider_source_id === null ? null : String(row.provider_source_id),
          canonicalUrl: String(row.canonical_url), url: String(row.canonical_url), title: String(row.title), retrievedText: String(row.retrieved_text),
          author: row.author === null ? null : String(row.author), publishedAt: row.published_at === null ? null : String(row.published_at),
          contentHash: String(row.content_hash), retrievedAt: String(row.retrieved_at),
        };
        byId.set(source.id, source);
        return { id: String(row.id), subject: String(row.subject), behavior: String(row.behavior), quote: String(row.quote), sourceId: source.id,
          harvestMode: String(row.harvest_mode) as "domain" | "audience", modelConfidence: Number(row.model_confidence), source };
      });
      sources = [...byId.values()];
      this.progress(active, `Resuming Stage 2 from ${factors.length} persisted factors · ${sources.length} sources`);
    } else {
      const harvest = await harvestFactors(scope, deps);
      this.discovery.persistFactors(active.runId, harvest.sources, harvest.factors);
      factors = harvest.factors; sources = harvest.sources;
      this.progress(active, `Factors: ${factors.length} (${harvest.metrics.retained.domain} domain, ${harvest.metrics.retained.audience} audience) · ${sources.length} sources`);
    }
    const result = await discoverProblems(scope, factors, sources, deps);
    this.discovery.persistProblems(active.runId, result.killSources, result.problems, result.blockedCandidates);
    this.progress(active, `Evidence-backed problems: ${result.problems.length} · failed evidence gate ${result.blockedCandidates.length} · factor utilization ${Math.round(result.factorUtilizationRate * 100)}%`);
  }

  private async executeDevelopment(active: ActiveRun): Promise<void> {
    if (active.workflow) {
      const workflow = active.workflow;
      const context = workflow.developmentContext(active.problemId!);
      const deps = {
        modelClient: this.instrumentedModel(active), model: active.config.model,
        reasoningEffort: active.config.reasoningEffort, signal: active.abortController.signal,
        resolvePrompt: workflow.resolvePrompt,
      };
      if (!workflow.repository.findStageResult(active.runId, "solutions")) {
        this.progress(active, "Generating up to three options");
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
      if (workflow.repository.findStageResult(active.runId, "decision-analysis", option.id)) return;
      this.progress(active, "Analyzing the selected option and its next experiment");
      const result = await analyzeSelectedOption(context, option, deps);
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
    const existing = this.options.db.db.prepare(`
      SELECT COUNT(*) AS count,
        SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM outcomes o WHERE o.solution_id = s.id) THEN 1 ELSE 0 END) AS missing_outcomes,
        SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM risks r WHERE r.solution_id = s.id) THEN 1 ELSE 0 END) AS missing_risks
      FROM solutions s WHERE s.research_run_id = ?
    `).get(active.runId) as { count: number; missing_outcomes: number | null; missing_risks: number | null };
    if (existing.count > 0 && existing.missing_outcomes === 0 && existing.missing_risks === 0) return;
    if (existing.count > 0) {
      throw new AppError(
        "conflict",
        "This development run contains partial saved results and cannot be replayed safely. The saved records were retained. Cancel this run and start a new development run for the problem.",
      );
    }
    await runPersistedDevelopment(active.problemId!, {
      repository: this.development,
      researchRunId: active.runId,
      modelClient: this.instrumentedModel(active),
      model: active.config.model,
      reasoningEffort: active.config.reasoningEffort,
      signal: active.abortController.signal,
      onProgress: (message) => this.progress(active, message),
    });
  }

  private dependencies(active: ActiveRun) {
    const modelClient = this.instrumentedModel(active);
    const search = this.instrumentedSearch(active);
    return {
      modelClient: active.workflow ? active.workflow.discoveryClient(modelClient) : modelClient,
      search: active.workflow ? active.workflow.search(search) : search,
      model: active.config.model,
      reasoningEffort: active.config.reasoningEffort,
      depth: active.config.discoveryDepth,
      signal: active.abortController.signal,
      onProjection: (message: string) => this.progress(active, message),
      ...(active.workflow ? {
        workflowVersion: 2 as const,
        prompt: (name: string) => active.workflow!.resolvePrompt(name as WorkflowV2StageId).text,
        audienceSearch: { includeDomains: active.config.audienceSourcePolicy === "communities" ? ["reddit.com", "news.ycombinator.com"] : [] },
      } : {}),
    };
  }

  private instrumentedModel(active: ActiveRun): StructuredModelClient {
    const client = this.options.modelClients?.[active.config.model.providerId];
    if (!client) throw new Error(`Model provider ${active.config.model.providerId} is unavailable`);
    return {
      structuredCompletion: async <T>(request: StructuredStageRequest<T>) => {
        if (!sameModelRef(request.model, active.config.model)) throw new Error("Stage model does not match the active run configuration");
        const providerId = active.config.model.providerId;
        const preparedIdentity = client.prepareIdentity
          ? await client.prepareIdentity()
          : client.preparedIdentity?.();
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
          const result = await client.structuredCompletion({
            ...request,
            onDispatched: () => {
              reservation = this.ledger.reserve(active.runId, "structured-completion", providerId, active.config.model.modelId, 0, attempt.id);
              dispatched = true;
              this.generationAttempts.markDispatched(attempt.id);
              request.onDispatched?.();
            },
            onAccepted: (metadata) => {
              accepted = true;
              this.generationAttempts.markAccepted(attempt.id, metadata);
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
          if (this.activeRuns.get(active.runId) === active) this.progress(active, "Model call completed");
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
              terminalKind: code,
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

  private instrumentedSearch(active: ActiveRun): Pick<SearchClient, "search"> {
    const provider = active.config.searchProvider;
    const client = this.options.searchClients?.[provider];
    return {
      search: async (query: string, options?: SearchOptions) => {
        if (!client) throw new AppError("conflict", `Connect ${provider === "exa" ? "Exa" : "Perplexity"} before discovering problems.`);
        this.enforceRunawayBackstop(active, provider, active.projectedSearches);
        const reservation = this.ledger.reserve(active.runId, "search", provider, null, provider === "exa" ? 0.02 : 0.005);
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

  private progress(active: ActiveRun, message: string): void {
    const codexCalls = this.ledger.countProviderCalls(active.runId, active.config.model.providerId);
    const searches = this.ledger.countProviderCalls(active.runId, active.config.searchProvider);
    this.logJob(active.runId, active.threadId, "run-progress", { message, codexCalls, searches });
    this.emit({ type: "run-progress", runId: active.runId, threadId: active.threadId, message, codexCalls, searches });
  }

  private fail(active: ActiveRun, error: unknown, status?: "failed" | "cancelled"): void {
    if (!this.activeRuns.has(active.runId)) return;
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
      this.fail(active, error, "failed");
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
