import type { DatabaseClient } from "../db/client";
import { CostLedgerRepository } from "../db/repositories/cost-ledger";
import { DevelopmentRepository } from "../db/repositories/development";
import { DiscoveryRepository } from "../db/repositories/discovery";
import { ResearchRunRepository } from "../db/repositories/research-runs";
import type { ExaClient, ExaSearchOptions } from "../providers/exa";
import type { StructuredCallOptions, StructuredModelClient } from "../providers/structured";
import type { z } from "zod";
import { AppError } from "../shared/errors";
import type { ResearchEvent } from "../shared/ipc";
import { RunConfigSchema, type ModelProvider, type RunConfig } from "../shared/schemas";
import { ScopeSchema, type Scope } from "../shared/structured-output-schemas";
import { runPersistedDevelopment } from "./development";
import { discoveryRunProjection, harvestFactors, runDiscoveryArm, type HarvestedFactor, type HarvestedSource } from "./discovery";

export interface ResearchEngineOptions {
  db: DatabaseClient;
  modelClients?: Partial<Record<ModelProvider, StructuredModelClient>>;
  exa: ExaClient;
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
  projectedExaSearches: number;
}

export class ResearchEngine {
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly runs: ResearchRunRepository;
  private readonly ledger: CostLedgerRepository;
  private readonly discovery: DiscoveryRepository;
  private readonly development: DevelopmentRepository;

  constructor(private readonly options: ResearchEngineOptions) {
    this.runs = new ResearchRunRepository(options.db);
    this.ledger = new CostLedgerRepository(options.db);
    this.discovery = new DiscoveryRepository(options.db);
    this.development = new DevelopmentRepository(options.db);
  }

  getActiveRunIds(): ReadonlySet<string> { return new Set(this.activeRuns.keys()); }

  async startDiscovery(threadId: string, scope: Scope, config: RunConfig): Promise<string> {
    const parsedScope = ScopeSchema.parse(scope);
    const created = this.runs.create(threadId, config, null);
    if (!created.created) return created.runId;
    this.discovery.persistScope(created.runId, parsedScope);
    this.begin(created.runId, threadId, null, config);
    return created.runId;
  }

  async startNextSelected(threadId: string, config: RunConfig): Promise<string | null> {
    const problem = this.options.db.db.prepare(`
      SELECT p.id
      FROM problems p
      WHERE p.selected_at IS NOT NULL
        AND p.discovery_run_id = (
          SELECT id FROM research_runs WHERE thread_id = ? AND problem_id IS NULL AND status = 'completed'
          ORDER BY created_at DESC LIMIT 1
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
    const created = this.runs.create(threadId, config, problem.id);
    if (!created.created) return created.runId;
    this.begin(created.runId, threadId, problem.id, config);
    return created.runId;
  }

  async resumeRun(runId: string): Promise<void> {
    if (this.activeRuns.has(runId)) return;
    const row = this.options.db.db.prepare(`SELECT thread_id, status, config_json, problem_id FROM research_runs WHERE id = ?`)
      .get(runId) as { thread_id: string; status: string; config_json: string; problem_id: string | null } | undefined;
    if (!row || !["queued", "running"].includes(row.status)) {
      throw new AppError("conflict", "This research run has already ended and cannot be resumed.");
    }
    for (const reservation of this.options.db.db.prepare("SELECT id FROM cost_ledger WHERE research_run_id = ? AND status = 'reserved'").all(runId) as Array<{ id: string }>) {
      this.ledger.release(reservation.id);
    }
    this.options.db.db.prepare("UPDATE research_runs SET status = 'running', cancelled = 0, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), runId);
    const config = RunConfigSchema.parse(JSON.parse(row.config_json));
    this.begin(runId, row.thread_id, row.problem_id, config, true);
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
      ? { modelCalls: 18, searches: 0 }
      : discoveryRunProjection(config.discoveryDepth);
    const active: ActiveRun = {
      runId, threadId, problemId, config, abortController: new AbortController(), startedAt: Date.now(),
      projectedCodexCalls: projection.modelCalls, projectedExaSearches: projection.searches,
    };
    this.activeRuns.set(runId, active);
    this.scheduleDeadline(active);
    this.updateThread(threadId, problemId ? "development-running" : "discovery-running");
    this.emit(resumed
      ? { type: "run-resumed", runId, threadId }
      : { type: "run-started", runId, threadId, problemId });
    void this.execute(active).catch((error) => this.fail(active, error));
  }

  private async execute(active: ActiveRun): Promise<void> {
    if (active.problemId) await this.executeDevelopment(active);
    else await this.executeDiscovery(active);
    if (active.abortController.signal.aborted || !this.activeRuns.has(active.runId)) return;
    this.runs.finish(active.runId, "completed");
    if (active.deadlineTimer) clearTimeout(active.deadlineTimer);
    this.activeRuns.delete(active.runId);
    this.emit({ type: "run-completed", runId: active.runId, threadId: active.threadId, problemId: active.problemId });
    if (!active.problemId) { this.updateThread(active.threadId, "problems-ready"); return; }
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
    const existingProblems = this.options.db.db.prepare("SELECT COUNT(*) AS count FROM problems WHERE discovery_run_id = ?")
      .get(active.runId) as { count: number };
    if (existingProblems.count > 0) return;
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
    const result = await runDiscoveryArm("A", scope, factors, sources, deps);
    this.discovery.persistProblems(active.runId, result.killSources, result.problems);
    this.progress(active, `Problem candidates: ${result.problems.length} · killed ${result.blockedCandidates.length} · factor utilization ${Math.round(result.factorUtilizationRate * 100)}%`);
  }

  private async executeDevelopment(active: ActiveRun): Promise<void> {
    const existing = this.options.db.db.prepare(`
      SELECT COUNT(*) AS count,
        SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM outcomes o WHERE o.solution_id = s.id) THEN 1 ELSE 0 END) AS missing_outcomes,
        SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM risks r WHERE r.solution_id = s.id) THEN 1 ELSE 0 END) AS missing_risks
      FROM solutions s WHERE s.research_run_id = ?
    `).get(active.runId) as { count: number; missing_outcomes: number | null; missing_risks: number | null };
    if (existing.count > 0 && existing.missing_outcomes === 0 && existing.missing_risks === 0) return;
    if (existing.count > 0) {
      this.progress(active, "An incomplete development stage was found; restarting this problem from its last complete run boundary.");
      this.options.db.db.prepare("DELETE FROM solutions WHERE research_run_id = ?").run(active.runId);
    }
    await runPersistedDevelopment(active.problemId!, {
      repository: this.development,
      researchRunId: active.runId,
      modelClient: this.instrumentedModel(active),
      model: active.config.model,
      signal: active.abortController.signal,
      onProgress: (message) => this.progress(active, message),
    });
  }

  private dependencies(active: ActiveRun) {
    return {
      modelClient: this.instrumentedModel(active),
      exa: this.instrumentedExa(active),
      model: active.config.model,
      depth: active.config.discoveryDepth,
      signal: active.abortController.signal,
      onProjection: (message: string) => this.progress(active, message),
    };
  }

  private instrumentedModel(active: ActiveRun): StructuredModelClient {
    const client = this.options.modelClients?.codex;
    if (!client) throw new Error("Codex client is unavailable");
    return {
      structuredCompletion: async <T>(model: string, system: string, user: string, schema: z.ZodType<T>, jsonSchema: object, options?: StructuredCallOptions): Promise<T> => {
        this.enforceRunawayBackstop(active, "codex", active.projectedCodexCalls);
        const reservation = this.ledger.reserve(active.runId, "structured-completion", "codex", active.config.model, 0);
        try { return await client.structuredCompletion(model, system, user, schema, jsonSchema, options); }
        finally { this.ledger.commit(reservation.id, 0); this.progress(active, "Codex call completed"); }
      },
    };
  }

  private instrumentedExa(active: ActiveRun): Pick<ExaClient, "search"> {
    return {
      search: async (query: string, options?: ExaSearchOptions) => {
        this.enforceRunawayBackstop(active, "exa", active.projectedExaSearches);
        const reservation = this.ledger.reserve(active.runId, "search", "exa", null, 0.05);
        try { return await this.options.exa.search(query, options); }
        finally { this.ledger.commit(reservation.id); this.progress(active, `Search: ${query}`); }
      },
    };
  }

  private enforceRunawayBackstop(active: ActiveRun, provider: string, projection: number): void {
    const count = this.ledger.countProviderCalls(active.runId, provider);
    if (count >= Math.max(6, projection * 3)) throw new Error(`Runaway backstop triggered for ${provider}; the run exceeded 3× its projected calls.`);
  }

  private progress(active: ActiveRun, message: string): void {
    const codexCalls = this.ledger.countProviderCalls(active.runId, "codex");
    const exaSearches = this.ledger.countProviderCalls(active.runId, "exa");
    this.logJob(active.runId, active.threadId, "run-progress", { message, codexCalls, exaSearches });
    this.emit({ type: "run-progress", runId: active.runId, threadId: active.threadId, message, codexCalls, exaSearches });
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
