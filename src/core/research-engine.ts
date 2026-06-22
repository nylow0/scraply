import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "../db/client";
import { wrapReportHtml } from "../core/sanitize";
import {
  renderSynthesisReportHtml,
  reviewCoverage,
  synthesizeResearch,
  type StreamReportSummary,
} from "../core/orchestrator";
import { loadStoredRunState, logJobEvent } from "../core/research-recovery";
import { generateIdeas } from "../core/ideas";
import type { ExaClient } from "../providers/exa";
import type { OpenCodeClient } from "../providers/opencode";
import type { ProjectBrief, Researcher, RunConfig } from "../shared/schemas";
import type { ResearchEvent } from "../shared/ipc";

/** Researchers that actually run for a config: enabled only. */
function activeResearchers(config: RunConfig): Researcher[] {
  return config.researchers.filter((researcher) => researcher.enabled);
}

export interface ResearchEngineOptions {
  db: DatabaseClient;
  opencode: OpenCodeClient;
  exa: ExaClient;
  onEvent: (event: ResearchEvent) => void;
  onReport?: (threadId: string, streamName: string, reportId: string) => void;
}

interface ActiveRun {
  runId: string;
  threadId: string;
  config: RunConfig;
  brief: ProjectBrief;
  cancelled: boolean;
  spendEstimate: number;
  completedStreamIds: Set<string>;
  hasSynthesis: boolean;
}

export class ResearchEngine {
  private activeRuns = new Map<string, ActiveRun>();
  private globalCancelled = new Set<string>();

  constructor(private readonly options: ResearchEngineOptions) {}

  async startRun(threadId: string, brief: ProjectBrief, config: RunConfig): Promise<string> {
    const researchers = activeResearchers(config);
    if (researchers.length === 0) {
      throw new Error("Enable at least one researcher before starting a run");
    }

    const runId = randomUUID();
    const now = new Date().toISOString();
    this.options.db.db.prepare(`
      INSERT INTO research_runs (id, thread_id, status, config_json, spend_estimate, round, cancelled, created_at, updated_at)
      VALUES (?, ?, 'running', ?, 0, 0, 0, ?, ?)
    `).run(runId, threadId, JSON.stringify(config), now, now);
    this.activeRuns.set(runId, {
      runId,
      threadId,
      config,
      brief,
      cancelled: false,
      spendEstimate: 0,
      completedStreamIds: new Set(),
      hasSynthesis: false,
    });
    this.emitJob(runId, threadId, "run-started", { runId, threadId });
    this.options.onEvent({ type: "run-started", runId, threadId });
    void this.executeRun(runId);
    return runId;
  }

  async resumeRun(runId: string): Promise<void> {
    const stored = loadStoredRunState(this.options.db, runId);
    if (!stored) throw new Error("Run not found or missing brief");
    if (this.activeRuns.has(runId)) return;

    const now = new Date().toISOString();
    this.options.db.db.prepare(`
      UPDATE research_runs SET status = 'running', cancelled = 0, updated_at = ? WHERE id = ?
    `).run(now, runId);
    this.activeRuns.set(runId, {
      runId,
      threadId: stored.threadId,
      config: stored.config,
      brief: stored.brief,
      cancelled: false,
      spendEstimate: stored.spendEstimate,
      completedStreamIds: stored.completedStreamIds,
      hasSynthesis: stored.hasSynthesis,
    });
    this.options.db.db.prepare("UPDATE threads SET status = ?, updated_at = ? WHERE id = ?")
      .run("research-running", now, stored.threadId);
    this.emitJob(runId, stored.threadId, "run-resumed", { runId });
    this.options.onEvent({ type: "run-resumed", runId, threadId: stored.threadId });
    void this.executeRun(runId);
  }

  cancelRun(runId: string): void {
    this.globalCancelled.add(runId);
    const active = this.activeRuns.get(runId);
    if (active) active.cancelled = true;
    const now = new Date().toISOString();
    this.options.db.db.prepare("UPDATE research_runs SET status = 'cancelled', cancelled = 1, updated_at = ? WHERE id = ?")
      .run(now, runId);
    if (active?.threadId) {
      this.options.db.db.prepare("UPDATE threads SET status = ?, updated_at = ? WHERE id = ?")
        .run("configuring", now, active.threadId);
    }
    this.emitJob(runId, active?.threadId ?? null, "run-cancelled", { runId });
    this.options.onEvent({ type: "run-cancelled", runId });
  }

  private async executeRun(runId: string): Promise<void> {
    const active = this.activeRuns.get(runId);
    if (!active) return;
    const { config, brief, threadId } = active;

    try {
      const researchers = activeResearchers(config);
      const pendingStreams = researchers.filter((stream) => !active.completedStreamIds.has(stream.id));
      if (pendingStreams.length > 0) {
        await runWithConcurrency(
          pendingStreams,
          config.parallelism,
          (stream) => this.runStream(runId, threadId, brief, config, stream),
        );
      }

      if (this.isRunCancelled(runId, active)) {
        this.persistSpendEstimate(runId, active.spendEstimate);
        this.options.db.db.prepare(`
          UPDATE research_runs SET status = 'cancelled', spend_estimate = ?, updated_at = ? WHERE id = ?
        `).run(active.spendEstimate, new Date().toISOString(), runId);
        return;
      }

      const streamReports = this.loadStreamReports(runId, researchers);
      if (streamReports.length > 0 && !active.hasSynthesis && this.hasSpendBudget(active, config)) {
        await this.runOrchestrator(runId, threadId, brief, config, streamReports, active);
      }

      const finalReports = this.loadStreamReports(runId, researchers);
      const hasEvidence = finalReports.some((report) => report.status === "completed" && report.reportHtml.trim());
      const partial = finalReports.some((report) => report.status !== "completed");
      const status = active.cancelled ? "cancelled" : !hasEvidence ? "failed" : partial ? "partial" : "completed";
      this.persistSpendEstimate(runId, active.spendEstimate);
      this.options.db.db.prepare(`
        UPDATE research_runs SET status = ?, spend_estimate = ?, updated_at = ? WHERE id = ?
      `).run(status, active.spendEstimate, new Date().toISOString(), runId);

      if (!active.cancelled) {
        if (!hasEvidence) {
          const message = "Research ended before any stream saved usable evidence. Check provider connectivity, then resume the run.";
          this.emitJob(runId, threadId, "run-failed", { runId, error: message });
          this.options.onEvent({ type: "run-failed", runId, error: message });
          this.options.db.db.prepare("UPDATE threads SET status = ?, updated_at = ? WHERE id = ?")
            .run("configuring", new Date().toISOString(), threadId);
          return;
        }
        this.emitJob(runId, threadId, "run-completed", { runId, partial });
        this.options.onEvent({ type: "run-completed", runId, partial });
        this.options.db.db.prepare("UPDATE threads SET status = ?, updated_at = ? WHERE id = ?")
          .run("research-complete", new Date().toISOString(), threadId);
        await this.generateIdeasForRun(runId, threadId, brief, config, hasEvidence);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Research run failed unexpectedly";
      this.persistSpendEstimate(runId, active.spendEstimate);
      this.options.db.db.prepare(`
        UPDATE research_runs SET status = 'failed', spend_estimate = ?, updated_at = ? WHERE id = ?
      `).run(active.spendEstimate, new Date().toISOString(), runId);
      this.options.db.db.prepare("UPDATE threads SET status = ?, updated_at = ? WHERE id = ?")
        .run(this.hasSavedEvidence(runId) ? "research-complete" : "configuring", new Date().toISOString(), threadId);
      this.emitJob(runId, threadId, "run-failed", { runId, error: message });
      this.options.onEvent({ type: "run-failed", runId, error: message });
    } finally {
      this.globalCancelled.delete(runId);
      this.activeRuns.delete(runId);
    }
  }

  private isRunCancelled(runId: string, active: ActiveRun): boolean {
    return active.cancelled || this.globalCancelled.has(runId);
  }

  private hasSpendBudget(active: ActiveRun, config: RunConfig): boolean {
    if (active.spendEstimate >= config.maxSpendUsd) {
      this.options.onEvent({
        type: "run-failed",
        runId: active.runId,
        error: `Spend cap of $${config.maxSpendUsd.toFixed(2)} reached before synthesis`,
      });
      return false;
    }
    return true;
  }

  private persistSpendEstimate(runId: string, spendEstimate: number): void {
    this.options.db.db.prepare(`
      UPDATE research_runs SET spend_estimate = ?, updated_at = ? WHERE id = ?
    `).run(spendEstimate, new Date().toISOString(), runId);
  }

  private hasSavedEvidence(runId: string): boolean {
    const row = this.options.db.db.prepare(`
      SELECT COUNT(*) as count
      FROM stream_runs
      WHERE research_run_id = ? AND status = 'completed' AND report_id IS NOT NULL
    `).get(runId) as { count: number };
    return row.count > 0;
  }

  /** Auto-generate the idea shortlist once research finishes so the user gets a result, not just reports. */
  private async generateIdeasForRun(
    runId: string,
    threadId: string,
    brief: ProjectBrief,
    config: RunConfig,
    hasEvidence: boolean,
  ): Promise<void> {
    if (!hasEvidence) return;
    this.options.db.db.prepare("UPDATE threads SET status = ?, updated_at = ? WHERE id = ?")
      .run("ideas-generating", new Date().toISOString(), threadId);
    try {
      const ideas = await generateIdeas(
        this.options.db,
        this.options.opencode,
        threadId,
        brief,
        config.ideaModel,
        config.ideasRequested,
        config.batchSize,
      );
      this.options.db.db.prepare("UPDATE threads SET status = ?, updated_at = ? WHERE id = ?")
        .run("ideas-ready", new Date().toISOString(), threadId);
      this.emitJob(runId, threadId, "ideas-generated", { threadId, count: ideas.length });
      this.options.onEvent({ type: "ideas-generated", threadId, ideaCount: ideas.length });
    } catch (error) {
      // Leave the thread at research-complete so the user can retry idea generation manually.
      this.options.db.db.prepare("UPDATE threads SET status = ?, updated_at = ? WHERE id = ?")
        .run("research-complete", new Date().toISOString(), threadId);
      const message = error instanceof Error ? error.message : "Idea generation failed";
      this.emitJob(runId, threadId, "ideas-failed", { threadId, error: message });
      this.options.onEvent({ type: "ideas-failed", threadId, error: message });
    }
  }

  private async runOrchestrator(
    runId: string,
    threadId: string,
    brief: ProjectBrief,
    config: RunConfig,
    streamReports: StreamReportSummary[],
    active: ActiveRun,
  ): Promise<void> {
    this.options.onEvent({ type: "coverage-review-started", runId });
    this.emitJob(runId, threadId, "coverage-review-started", { runId });

    const researchers = activeResearchers(config);
    let coverageReview;
    try {
      coverageReview = await reviewCoverage(this.options.opencode, config.orchestratorModel, brief, streamReports, researchers);
      active.spendEstimate += 0.06;
      this.persistSpendEstimate(runId, active.spendEstimate);
      this.options.onEvent({
        type: "coverage-review-completed",
        runId,
        overallCoverage: coverageReview.overallCoverage,
      });
      this.emitJob(runId, threadId, "coverage-review-completed", {
        runId,
        overallCoverage: coverageReview.overallCoverage,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Coverage review failed";
      this.options.onEvent({ type: "coverage-review-failed", runId, error: message });
      this.emitJob(runId, threadId, "coverage-review-failed", { runId, error: message });
      return;
    }

    const followUpTargets = coverageReview.streamReviews
      .filter((review) => review.needsFollowUp && config.maxFollowUpRounds > 0)
      .slice(0, config.maxFollowUpRounds);

    for (const target of followUpTargets) {
      const stream = researchers.find((item) => item.id === target.streamId);
      if (!stream || this.isRunCancelled(runId, active)) continue;
      if (!this.hasSpendBudget(active, config)) break;
      this.options.onEvent({ type: "follow-up-started", runId, streamId: stream.id, round: 1 });
      await this.runStream(runId, threadId, brief, config, stream, true);
    }

    const refreshedReports = this.loadStreamReports(runId, researchers);
    this.options.onEvent({ type: "synthesis-started", runId });
    this.emitJob(runId, threadId, "synthesis-started", { runId });

    try {
      const synthesis = await synthesizeResearch(
        this.options.opencode,
        config.orchestratorModel,
        brief,
        refreshedReports,
        coverageReview,
      );
      active.spendEstimate += 0.08;
      this.persistSpendEstimate(runId, active.spendEstimate);
      const reportId = randomUUID();
      const html = renderSynthesisReportHtml(brief, config, refreshedReports, coverageReview, synthesis);
      this.options.db.db.prepare(`
        INSERT INTO reports (id, thread_id, stream_id, title, html, created_at)
        VALUES (?, ?, 'synthesis', ?, ?, ?)
      `).run(reportId, threadId, `${brief.projectName} — Research synthesis`, html, new Date().toISOString());
      active.hasSynthesis = true;
      this.options.onEvent({ type: "synthesis-completed", runId, reportId });
      this.emitJob(runId, threadId, "synthesis-completed", { runId, reportId });
      this.options.onReport?.(threadId, "Research synthesis", reportId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Synthesis failed";
      this.options.onEvent({ type: "synthesis-failed", runId, error: message });
      this.emitJob(runId, threadId, "synthesis-failed", { runId, error: message });
    }
  }

  private loadStreamReports(runId: string, researchers: Researcher[]): StreamReportSummary[] {
    const rows = this.options.db.db.prepare(`
      SELECT sr.stream_id, sr.status, sr.coverage, sr.error, sr.report_id, sr.round, r.html
      FROM stream_runs sr
      LEFT JOIN reports r ON r.id = sr.report_id
      WHERE sr.research_run_id = ?
      ORDER BY sr.stream_id ASC, sr.round DESC, sr.updated_at DESC
    `).all(runId) as Array<{
      stream_id: string;
      status: string;
      coverage: number | null;
      error: string | null;
      report_id: string | null;
      round: number;
      html: string | null;
    }>;

    const latestByStream = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      if (!latestByStream.has(row.stream_id)) latestByStream.set(row.stream_id, row);
    }

    return [...latestByStream.values()].map((row) => {
      const stream = researchers.find((item) => item.id === row.stream_id);
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
    stream: Researcher,
    isFollowUp = false,
  ): Promise<void> {
    const active = this.activeRuns.get(runId);
    if (!active || this.isRunCancelled(runId, active)) return;
    if (!isFollowUp && active.completedStreamIds.has(stream.id)) return;

    if (active.spendEstimate >= config.maxSpendUsd) {
      this.options.onEvent({
        type: "stream-failed",
        runId,
        streamId: stream.id,
        error: `Spend cap of $${config.maxSpendUsd.toFixed(2)} reached`,
      });
      return;
    }

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
    this.options.db.db.prepare(`
      INSERT INTO stream_runs (id, research_run_id, stream_id, round, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'running', ?, ?)
    `).run(streamRunId, runId, stream.id, isFollowUp ? 1 : 0, now, now);
    this.options.onEvent({ type: "stream-started", runId, streamId: stream.id });
    this.emitJob(runId, threadId, "stream-started", { runId, streamId: stream.id });
    this.options.onEvent({ type: "stream-progress", runId, streamId: stream.id, message: "Planning searches" });

    try {
      const queryParts = [`${brief.theme}: ${stream.focus}`];
      if (stream.instructions.trim()) queryParts.push(stream.instructions.trim());
      const query = queryParts.join(". ");
      this.options.onEvent({ type: "stream-progress", runId, streamId: stream.id, message: "Searching Exa" });
      const sources = await this.options.exa.search(query, {
        numResults: config.searchResultsPerStream,
        maxCharacters: config.pageCharLimit,
      });
      active.spendEstimate += 0.05;
      this.persistSpendEstimate(runId, active.spendEstimate);

      if (sources.length === 0) {
        throw new Error("Exa returned no sources — try broadening the theme or increasing search results");
      }

      if (active.spendEstimate > config.maxSpendUsd) {
        throw new Error(`Spend cap of $${config.maxSpendUsd.toFixed(2)} reached`);
      }

      this.options.onEvent({
        type: "stream-progress",
        runId,
        streamId: stream.id,
        message: `Found ${sources.length} source${sources.length === 1 ? "" : "s"}`,
      });
      this.options.onEvent({ type: "stream-progress", runId, streamId: stream.id, message: "Extracting claims" });
      const claims = await this.options.opencode.extractClaims(config.workerModel, query, sources);
      active.spendEstimate += 0.08;
      this.persistSpendEstimate(runId, active.spendEstimate);

      this.options.onEvent({ type: "stream-progress", runId, streamId: stream.id, message: "Writing report" });
      const findings = claims.claims.slice(0, 8).map((claim) =>
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
        <h2>Weak spots and uncertainty</h2><p>${claims.claims.length === 0 ? "Limited evidence from search results." : "Some claims may need follow-up verification."}</p>
        <h2>Suggested next search</h2><p>Deepen ${escapeHtml(stream.name)} with narrower subquestions.</p>
      `;
      const reportId = randomUUID();
      const html = wrapReportHtml(`${stream.name} — ${brief.projectName}`, body);
      this.options.db.db.prepare(`
        INSERT INTO reports (id, thread_id, stream_id, title, html, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(reportId, threadId, stream.id, `${stream.name} report`, html, new Date().toISOString());

      const coverage = Math.min(1, claims.claims.length / 5);
      this.options.db.db.prepare(`
        UPDATE stream_runs SET status = 'completed', report_id = ?, coverage = ?, updated_at = ? WHERE id = ?
      `).run(reportId, coverage, new Date().toISOString(), streamRunId);
      active.completedStreamIds.add(stream.id);
      this.options.onEvent({ type: "stream-completed", runId, streamId: stream.id, reportId });
      this.emitJob(runId, threadId, "stream-completed", { runId, streamId: stream.id, reportId });
      this.options.onReport?.(threadId, stream.name, reportId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Stream failed";
      this.options.db.db.prepare(`
        UPDATE stream_runs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?
      `).run(message, new Date().toISOString(), streamRunId);
      this.options.onEvent({ type: "stream-failed", runId, streamId: stream.id, error: message });
      this.emitJob(runId, threadId, "stream-failed", { runId, streamId: stream.id, error: message });
    }
  }

  private emitJob(runId: string | null, threadId: string | null, type: string, payload: Record<string, unknown>): void {
    logJobEvent(this.options.db, runId, threadId, type, payload);
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
