import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "../db/client";
import { CostLedgerRepository } from "../db/repositories/cost-ledger";
import { EvidenceRepository } from "../db/repositories/evidence";
import { ResearchRunRepository } from "../db/repositories/research-runs";
import { wrapReportHtml } from "../core/sanitize";
import { loadPrompt } from "../core/prompts";
import { buildQueryContext, buildResearcherContext } from "../core/brief-context";
import {
  renderSynthesisReportHtml,
  reviewCoverage,
  synthesizeResearch,
  type StreamReportSummary,
} from "../core/orchestrator";
import { loadStoredRunState, logJobEvent } from "../core/research-recovery";
import type { ExaClient } from "../providers/exa";
import type { StructuredModelClient } from "../providers/structured";
import { ProviderFailure } from "../providers/structured";
import { RESEARCH_STREAMS, type CanonicalStream } from "../research/streams";
import type { ModelProvider, ProjectBrief, RunConfig } from "../shared/schemas";
import type { ResearchEvent } from "../shared/ipc";
import { AppError } from "../shared/errors";
import { extractClaims } from "./claim-extraction";

export interface ResearchEngineOptions {
  db: DatabaseClient;
  modelClients?: Partial<Record<ModelProvider, StructuredModelClient>>;
  exa: ExaClient;
  onEvent: (event: ResearchEvent) => void;
  onReport?: (threadId: string, streamName: string, reportId: string) => void;
}

interface ActiveRun {
  runId: string;
  threadId: string;
  config: RunConfig;
  brief: ProjectBrief;
  abortController: AbortController;
  startedAt: number;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  codexCalls: number;
  exaSearches: number;
  selectedStreamIds: string[];
  completedStreamIds: Set<string>;
  hasSynthesis: boolean;
}

export class ResearchEngine {
  private activeRuns = new Map<string, ActiveRun>();
  private globalCancelled = new Set<string>();

  private readonly runs: ResearchRunRepository;
  private readonly ledger: CostLedgerRepository;
  private readonly evidence: EvidenceRepository;

  constructor(private readonly options: ResearchEngineOptions) {
    this.runs = new ResearchRunRepository(options.db);
    this.ledger = new CostLedgerRepository(options.db);
    this.evidence = new EvidenceRepository(options.db);
  }

  getActiveRunIds(): ReadonlySet<string> {
    return new Set(this.activeRuns.keys());
  }

  async startRun(threadId: string, brief: ProjectBrief, config: RunConfig, idempotencyKey?: string): Promise<string> {
    const created = this.runs.create(threadId, brief, config, idempotencyKey);
    const runId = created.runId;
    if (!created.created) return runId;
    const active: ActiveRun = {
      runId,
      threadId,
      config,
      brief,
      abortController: new AbortController(),
      startedAt: Date.now(),
      codexCalls: 0,
      exaSearches: 0,
      selectedStreamIds: RESEARCH_STREAMS.map((stream) => stream.id),
      completedStreamIds: new Set(),
      hasSynthesis: false,
    };
    this.activeRuns.set(runId, active);
    this.scheduleDeadline(active);
    this.emitJob(runId, threadId, "run-started", { runId, threadId });
    this.options.onEvent({ type: "run-started", runId, threadId });
    void this.executeRun(runId).catch((error) => this.failRun(runId, error));
    return runId;
  }

  async resumeRun(runId: string): Promise<void> {
    const stored = loadStoredRunState(this.options.db, runId);
    if (!stored) throw new AppError("conflict", "This research run is missing the saved state required to resume.");
    const run = this.options.db.db.prepare("SELECT status FROM research_runs WHERE id = ?").get(runId) as { status: string } | undefined;
    if (!run || !["queued", "running"].includes(run.status)) {
      throw new AppError("conflict", "This research run has already ended and cannot be resumed.");
    }
    if (this.activeRuns.has(runId)) return;
    this.globalCancelled.delete(runId);

    const now = new Date().toISOString();
    this.options.db.db.prepare(`
      UPDATE research_runs SET status = 'running', cancelled = 0, updated_at = ? WHERE id = ?
    `).run(now, runId);
    const active: ActiveRun = {
      runId,
      threadId: stored.threadId,
      config: stored.config,
      brief: stored.brief,
      abortController: new AbortController(),
      startedAt: Date.parse(stored.startedAt),
      codexCalls: 0,
      exaSearches: 0,
      selectedStreamIds: stored.selectedStreamIds,
      completedStreamIds: stored.completedStreamIds,
      hasSynthesis: stored.hasSynthesis,
    };
    this.activeRuns.set(runId, active);
    this.scheduleDeadline(active);
    this.options.db.db.prepare("UPDATE threads SET status = ?, updated_at = ? WHERE id = ?")
      .run("research-running", now, stored.threadId);
    this.emitJob(runId, stored.threadId, "run-resumed", { runId });
    this.options.onEvent({ type: "run-resumed", runId, threadId: stored.threadId });
    void this.executeRun(runId).catch((error) => this.failRun(runId, error));
  }

  cancelRun(runId: string): void {
    const run = this.options.db.db.prepare("SELECT thread_id, status FROM research_runs WHERE id = ?").get(runId) as
      { thread_id: string; status: string } | undefined;
    if (!run) throw new AppError("not_found", "Research run not found.");
    if (!["queued", "running"].includes(run.status)) {
      throw new AppError("conflict", "This research run has already ended and cannot be cancelled.");
    }

    const active = this.activeRuns.get(runId);
    if (active) {
      this.globalCancelled.add(runId);
      if (active.deadlineTimer) clearTimeout(active.deadlineTimer);
      active.abortController.abort(new Error("Cancelled by user"));
    }
    this.runs.cancel(runId);
    this.ledger.settleUncertain(runId, "Run cancelled while operations were in flight");
    this.options.db.db.prepare("UPDATE threads SET status = ?, updated_at = ? WHERE id = ?")
      .run("configuring", new Date().toISOString(), run.thread_id);
    this.emitJob(runId, run.thread_id, "run-cancelled", { runId });
    this.options.onEvent({ type: "run-cancelled", runId, threadId: run.thread_id });
  }

  private async executeRun(runId: string): Promise<void> {
    const active = this.activeRuns.get(runId);
    if (!active) return;
    const { config, brief, threadId } = active;

    const selectedStreamIds = new Set(active.selectedStreamIds);
    const pendingStreams = RESEARCH_STREAMS.filter(
      (stream) => selectedStreamIds.has(stream.id) && !active.completedStreamIds.has(stream.id),
    );
    if (pendingStreams.length > 0) {
      await runWithConcurrency(
        pendingStreams,
        config.parallelism,
        (stream) => this.runStream(runId, threadId, brief, config, stream),
      );
    }

    if (this.isStopped(active)) {
      if (active.deadlineTimer) clearTimeout(active.deadlineTimer);
      this.activeRuns.delete(runId);
      this.globalCancelled.delete(runId);
      return;
    }

    const streamReports = this.loadStreamReports(runId);
    if (streamReports.length > 0 && !active.hasSynthesis) {
      await this.runOrchestrator(runId, threadId, brief, config, streamReports, active);
    }

    const finalReports = this.loadStreamReports(runId);
    if (!active.hasSynthesis) {
      this.failRun(runId, new Error("Required synthesis was not produced"));
      return;
    }

    const partial = finalReports.some((report) => report.status !== "completed");
    this.runs.finish(runId, partial ? "partial" : "completed");
    this.options.db.db.prepare("UPDATE threads SET status = ?, updated_at = ? WHERE id = ?")
      .run("research-complete", new Date().toISOString(), threadId);
    this.emitJob(runId, threadId, "run-completed", { runId, partial });
    this.options.onEvent({ type: "run-completed", runId, threadId, partial });
    if (active.deadlineTimer) clearTimeout(active.deadlineTimer);
    this.activeRuns.delete(runId);
    this.globalCancelled.delete(runId);
  }

  private async runOrchestrator(
    runId: string,
    threadId: string,
    brief: ProjectBrief,
    config: RunConfig,
    streamReports: StreamReportSummary[],
    active: ActiveRun,
  ): Promise<void> {
    this.options.onEvent({ type: "coverage-review-started", runId, threadId });
    this.emitJob(runId, threadId, "coverage-review-started", { runId });

    let coverageReview;
    const orchestrator = this.getModelClient(config.orchestratorProvider);
    const coverageReservation = this.reserveModel(active, "coverage-review", config.orchestratorProvider, config.orchestratorModel, 0.06);
    try {
      coverageReview = await reviewCoverage(orchestrator, config.orchestratorModel, brief, streamReports, {
        signal: active.abortController.signal,
        timeoutMs: 120_000,
      });
      this.throwIfStopped(active);
      this.options.onEvent({
        type: "coverage-review-completed",
        runId,
        threadId,
        overallCoverage: coverageReview.overallCoverage,
      });
      this.emitJob(runId, threadId, "coverage-review-completed", {
        runId,
        overallCoverage: coverageReview.overallCoverage,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Coverage review failed";
      this.emitJob(runId, threadId, "coverage-review-failed", { runId, error: message });
      throw error;
    } finally {
      this.ledger.commit(coverageReservation.id);
    }

    const followUpTargets = coverageReview.streamReviews
      .filter((review) => review.needsFollowUp && config.maxFollowUpRounds > 0)
      .slice(0, config.maxFollowUpRounds);

    for (const target of followUpTargets) {
      const stream = RESEARCH_STREAMS.find((item) => item.id === target.streamId);
      if (!stream || !active.selectedStreamIds.includes(stream.id) || this.isStopped(active)) continue;
      this.options.onEvent({ type: "follow-up-started", runId, threadId, streamId: stream.id, round: 1 });
      await this.runStream(runId, threadId, brief, config, stream, true, target.gaps[0]);
    }

    const refreshedReports = this.loadStreamReports(runId);
    this.options.onEvent({ type: "synthesis-started", runId, threadId });
    this.emitJob(runId, threadId, "synthesis-started", { runId });

    const synthesisReservation = this.reserveModel(active, "synthesis", config.orchestratorProvider, config.orchestratorModel, 0.08);
    try {
      const synthesis = await synthesizeResearch(
        orchestrator,
        config.orchestratorModel,
        brief,
        refreshedReports,
        coverageReview,
        { signal: active.abortController.signal, timeoutMs: 120_000 },
      );
      this.throwIfStopped(active);
      const reportId = randomUUID();
      const html = renderSynthesisReportHtml(brief, config, refreshedReports, coverageReview, synthesis);
      this.options.db.db.prepare(`
        INSERT INTO reports (id, thread_id, research_run_id, stream_id, report_kind, title, html, created_at)
        VALUES (?, ?, ?, 'synthesis', 'synthesis', ?, ?, ?)
      `).run(reportId, threadId, runId, `${brief.title} — Research synthesis`, html, new Date().toISOString());
      active.hasSynthesis = true;
      this.options.onEvent({ type: "synthesis-completed", runId, threadId, reportId });
      this.emitJob(runId, threadId, "synthesis-completed", { runId, reportId });
      this.options.onReport?.(threadId, "Research synthesis", reportId);
      this.options.db.db.prepare(`
        INSERT INTO messages (id, thread_id, role, content, metadata_json, created_at)
        VALUES (?, ?, 'report', ?, ?, ?)
      `).run(
        randomUUID(),
        threadId,
        "Composite research synthesis is ready.",
        JSON.stringify({ reportId, streamName: "Research synthesis", synthesis: true }),
        new Date().toISOString(),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Synthesis failed";
      this.emitJob(runId, threadId, "synthesis-failed", { runId, error: message });
      throw error;
    } finally {
      this.ledger.commit(synthesisReservation.id);
    }
  }

  private loadStreamReports(runId: string): StreamReportSummary[] {
    const rows = this.options.db.db.prepare(`
      SELECT sr.stream_id, sr.status, sr.coverage, sr.error, sr.report_id, r.html
      FROM stream_runs sr
      LEFT JOIN reports r ON r.id = sr.report_id
      WHERE sr.research_run_id = ?
      ORDER BY sr.created_at ASC
    `).all(runId) as Array<{
      stream_id: string;
      status: string;
      coverage: number | null;
      error: string | null;
      report_id: string | null;
      html: string | null;
    }>;

    return rows.map((row) => {
      const stream = RESEARCH_STREAMS.find((item) => item.id === row.stream_id);
      return {
        streamId: row.stream_id,
        streamName: stream?.name ?? row.stream_id,
        status: row.status,
        coverage: row.coverage ?? 0,
        reportHtml: row.html ?? "",
        ...(row.error ? { error: row.error } : {}),
      };
    }).filter((report) => report.reportHtml || report.status === "failed");
  }

  private async runStream(
    runId: string,
    threadId: string,
    brief: ProjectBrief,
    config: RunConfig,
    stream: CanonicalStream,
    isFollowUp = false,
    followUpQuery?: string,
  ): Promise<void> {
    const active = this.activeRuns.get(runId);
    if (!active || this.isStopped(active)) return;
    if (!isFollowUp && active.completedStreamIds.has(stream.id)) return;

    const existing = this.options.db.db.prepare(`
      SELECT id FROM stream_runs
      WHERE research_run_id = ? AND stream_id = ? AND status = 'completed'
      LIMIT 1
    `).get(runId, stream.id) as { id: string } | undefined;
    if (!isFollowUp && existing) {
      active.completedStreamIds.add(stream.id);
      return;
    }

    const streamRunId = randomUUID();
    const now = new Date().toISOString();
    const query = followUpQuery?.trim() || [
      buildQueryContext(brief),
      `Research stream: ${stream.name}`,
      `Stream focus: ${stream.focus}`,
    ].join("\n").slice(0, 1500);
    this.options.db.db.prepare(`
      INSERT INTO stream_runs (
        id, research_run_id, stream_id, lens, round, planned_query, status,
        provider_started_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)
    `).run(streamRunId, runId, stream.id, stream.lens, isFollowUp ? 1 : 0, query, now, now, now);
    this.options.onEvent({ type: "stream-started", runId, threadId, streamId: stream.id });
    this.emitJob(runId, threadId, "stream-started", { runId, streamId: stream.id });
    this.options.onEvent({ type: "stream-progress", runId, threadId, streamId: stream.id, message: "Planning searches" });

    try {
      const researcherPrompt = loadPrompt(`researcher-${stream.id}`, [
        "Extract only useful atomic factual claims that directly answer the research query.",
        "Every claim must cite source IDs with short evidence quotes.",
        "",
        `Research stream: ${stream.name}`,
        `Stream focus: ${stream.focus}`,
        `Stream instructions: ${stream.instructions ?? "Use the stream focus."}`,
        "",
        "Brief context:",
        buildResearcherContext(brief),
      ].join("\n"));
      this.options.onEvent({ type: "stream-progress", runId, threadId, streamId: stream.id, message: "Searching Exa" });
      this.consumeExaSearch(active);
      const searchReservation = this.ledger.reserve(runId, "exa-search", "exa", null, 0.05);
      let searchedSources: Awaited<ReturnType<ExaClient["search"]>>;
      try {
        searchedSources = await this.options.exa.search(query, {
          numResults: config.searchResultsPerStream,
          maxCharacters: config.pageCharLimit,
          signal: active.abortController.signal,
          timeoutMs: 30_000,
        });
        this.throwIfStopped(active);
      } finally {
        this.ledger.commit(searchReservation.id);
      }
      const sources = this.evidence.persistSources(runId, streamRunId, searchedSources);

      this.options.onEvent({ type: "stream-progress", runId, threadId, streamId: stream.id, message: "Extracting claims" });
      const workerProvider = config.workerProvider ?? config.orchestratorProvider;
      const worker = this.getModelClient(workerProvider);
      const extractionReservation = this.reserveModel(active, "claim-extraction", workerProvider, config.workerModel, 0.08);
      let claims;
      try {
        claims = await extractClaims(worker, config.workerModel, query, sources, researcherPrompt, {
          signal: active.abortController.signal,
          timeoutMs: 120_000,
        });
        this.throwIfStopped(active);
      } finally {
        this.ledger.commit(extractionReservation.id);
      }
      const persistedClaims = this.evidence.validateAndPersistClaims(runId, streamRunId, claims.claims);

      this.options.onEvent({ type: "stream-progress", runId, threadId, streamId: stream.id, message: "Writing report" });
      const findings = persistedClaims.valid.slice(0, 8).map(({ claim }) =>
        `<li><strong>${escapeHtml(claim.text)}</strong> (${Math.round(claim.confidence * 100)}% confidence)</li>`,
      ).join("");
      const sourceList = sources.map((s) =>
        `<li><a href="${escapeHtml(s.url)}">${escapeHtml(s.title)}</a></li>`,
      ).join("");
      const body = `
        <h2>Summary</h2><p>${escapeHtml(stream.focus)}</p>
        <h2>What was researched</h2><p>${escapeHtml(query)}</p>
        <h2>Key findings</h2><ul>${findings || "<li>No strong claims extracted.</li>"}</ul>
        <h2>Sources</h2><ul>${sourceList || "<li>No sources returned.</li>"}</ul>
        <h2>Opportunities noticed</h2><p>Review gaps between user constraints and current landscape.</p>
        <h2>Weak spots and uncertainty</h2><p>${persistedClaims.valid.length === 0 ? "Limited validated evidence from search results." : `${persistedClaims.rejected.length} unsupported claims were excluded.`}</p>
        <h2>Suggested next search</h2><p>Deepen ${escapeHtml(stream.name)} with narrower subquestions.</p>
      `;
      const reportId = randomUUID();
      const html = wrapReportHtml(`${stream.name} — ${brief.title}`, body);
      this.options.db.db.prepare(`
        INSERT INTO reports (
          id, thread_id, research_run_id, stream_run_id, stream_id, report_kind,
          title, html, created_at
        ) VALUES (?, ?, ?, ?, ?, 'stream', ?, ?, ?)
      `).run(reportId, threadId, runId, streamRunId, stream.id, `${stream.name} report`, html, new Date().toISOString());

      const evidenceSourceCount = new Set(persistedClaims.valid.flatMap(({ claim }) => claim.sourceIds)).size;
      const coverage = Math.min(1, (persistedClaims.valid.length / 5) * 0.7 + (evidenceSourceCount / 3) * 0.3);
      this.options.db.db.prepare(`
        UPDATE stream_runs
        SET status = 'completed', report_id = ?, coverage = ?, provider_finished_at = ?,
            gap_stop_reason = ?, updated_at = ? WHERE id = ?
      `).run(reportId, coverage, new Date().toISOString(), coverage >= stream.coverageThreshold ? "coverage-threshold" : "round-limit", new Date().toISOString(), streamRunId);
      active.completedStreamIds.add(stream.id);
      this.options.onEvent({ type: "stream-completed", runId, threadId, streamId: stream.id, reportId });
      this.emitJob(runId, threadId, "stream-completed", { runId, streamId: stream.id, reportId });
      this.options.onReport?.(threadId, stream.name, reportId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Stream failed";
      const stopped = this.isStopped(active);
      this.options.db.db.prepare(`
        UPDATE stream_runs
        SET status = ?, error = ?, gap_stop_reason = ?, provider_finished_at = ?, updated_at = ?
        WHERE id = ?
      `).run(stopped ? "cancelled" : "failed", message, stopped ? "cancelled" : "provider-failure", new Date().toISOString(), new Date().toISOString(), streamRunId);
      if (stopped) return;
      this.options.onEvent({ type: "stream-failed", runId, threadId, streamId: stream.id, error: message });
      this.emitJob(runId, threadId, "stream-failed", { runId, streamId: stream.id, error: message });
    }
  }

  private emitJob(runId: string | null, threadId: string | null, type: string, payload: Record<string, unknown>): void {
    logJobEvent(this.options.db, runId, threadId, type, payload);
  }

  private getModelClient(provider: ModelProvider): StructuredModelClient {
    const configured = this.options.modelClients?.[provider];
    if (configured) return configured;
    throw new ProviderFailure("unavailable", `${provider} model client is not configured`, false);
  }

  private reserveModel(
    active: ActiveRun,
    operation: string,
    provider: ModelProvider,
    model: string,
    conservativeUsd: number,
  ) {
    this.throwIfStopped(active);
    if (provider === "codex") {
      if (active.codexCalls >= active.config.maxCodexCalls) {
        throw new ProviderFailure("failed", "Codex call limit reached", false);
      }
      active.codexCalls++;
    }
    return this.ledger.reserve(active.runId, operation, provider, model, provider === "codex" ? 0 : conservativeUsd);
  }

  private consumeExaSearch(active: ActiveRun): void {
    this.throwIfStopped(active);
    if (active.exaSearches >= active.config.maxExaSearches) {
      throw new ProviderFailure("failed", "Exa search limit reached", false);
    }
    active.exaSearches++;
  }

  private isStopped(active: ActiveRun): boolean {
    if (active.abortController.signal.aborted || this.globalCancelled.has(active.runId)) return true;
    return Date.now() - active.startedAt >= active.config.maxRunMinutes * 60_000;
  }

  private throwIfStopped(active: ActiveRun): void {
    if (!this.isStopped(active)) return;
    if (!active.abortController.signal.aborted) active.abortController.abort(new Error("Run time limit reached"));
    throw new ProviderFailure("cancelled", "Research run was stopped", false);
  }

  private failRun(runId: string, error: unknown): void {
    const active = this.activeRuns.get(runId);
    if (!active) return;
    if (!this.globalCancelled.has(runId)) {
      const message = error instanceof Error ? error.message : "Research run failed";
      this.ledger.settleUncertain(runId, message);
      this.runs.finish(runId, "failed", message);
      this.options.db.db.prepare("UPDATE threads SET status = ?, updated_at = ? WHERE id = ?")
        .run("configuring", new Date().toISOString(), active.threadId);
      this.emitJob(runId, active.threadId, "run-failed", {
        runId,
        error: message,
        ...(error instanceof ProviderFailure ? { code: error.code } : {}),
      });
      this.options.onEvent({ type: "run-failed", runId, threadId: active.threadId, error: message });
    }
    if (active.deadlineTimer) clearTimeout(active.deadlineTimer);
    this.activeRuns.delete(runId);
    this.globalCancelled.delete(runId);
  }

  private scheduleDeadline(active: ActiveRun): void {
    const remainingMs = Math.max(0, active.config.maxRunMinutes * 60_000 - (Date.now() - active.startedAt));
    active.deadlineTimer = setTimeout(() => {
      if (!this.activeRuns.has(active.runId)) return;
      const error = new ProviderFailure("timeout", "Research run wall-clock limit reached", false);
      active.abortController.abort(error);
      this.failRun(active.runId, error);
    }, remainingMs);
  }
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<Array<PromiseSettledResult<void>>> {
  const results: Array<PromiseSettledResult<void>> = [];
  let index = 0;
  async function next(): Promise<void> {
    const current = index++;
    if (current >= items.length) return;
    try {
      await worker(items[current]!);
      results[current] = { status: "fulfilled", value: undefined };
    } catch (reason) {
      results[current] = { status: "rejected", reason };
    }
    await next();
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => next()));
  return results;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
