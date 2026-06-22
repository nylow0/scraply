import type { DatabaseClient } from "../db/client";
import { RunConfigSchema, type ProjectBrief, type RunConfig } from "../shared/schemas";

export interface PendingRun {
  runId: string;
  threadId: string;
  threadTitle: string;
  status: string;
  completedStreams: number;
  totalStreams: number;
  hasSynthesis: boolean;
}

export interface StoredRunState {
  runId: string;
  threadId: string;
  brief: ProjectBrief;
  config: RunConfig;
  completedStreamIds: Set<string>;
  hasSynthesis: boolean;
  spendEstimate: number;
}

const FALLBACK_TOTAL_STREAMS = 1;

export function listPendingRuns(db: DatabaseClient): PendingRun[] {
  const rows = db.db.prepare(`
    SELECT rr.id, rr.thread_id, rr.status, rr.config_json, t.title as thread_title
    FROM research_runs rr
    JOIN threads t ON t.id = rr.thread_id
    WHERE rr.status IN ('running', 'failed')
    ORDER BY rr.updated_at DESC
  `).all() as Array<{ id: string; thread_id: string; status: string; config_json: string; thread_title: string }>;

  return rows.map((row) => {
    const streamRows = db.db.prepare(`
      SELECT stream_id, status FROM stream_runs WHERE research_run_id = ?
    `).all(row.id) as Array<{ stream_id: string; status: string }>;
    const completedStreams = new Set(
      streamRows.filter((stream) => stream.status === "completed").map((stream) => stream.stream_id),
    ).size;
    const synthesis = db.db.prepare(`
      SELECT id FROM reports WHERE thread_id = ? AND stream_id = 'synthesis' LIMIT 1
    `).get(row.thread_id) as { id: string } | undefined;

    const config = parseRunConfig(row.config_json);
    const enabledResearchers = config?.researchers.filter((researcher) => researcher.enabled).length ?? FALLBACK_TOTAL_STREAMS;

    return {
      runId: row.id,
      threadId: row.thread_id,
      threadTitle: row.thread_title,
      status: row.status,
      completedStreams,
      totalStreams: Math.max(enabledResearchers, 1),
      hasSynthesis: Boolean(synthesis),
    };
  });
}

export function loadStoredRunState(db: DatabaseClient, runId: string): StoredRunState | null {
  const row = db.db.prepare(`
    SELECT id, thread_id, config_json, spend_estimate FROM research_runs WHERE id = ?
  `).get(runId) as { id: string; thread_id: string; config_json: string; spend_estimate: number } | undefined;
  if (!row) return null;

  const briefRow = db.db.prepare(`
    SELECT brief_json FROM briefs WHERE thread_id = ? ORDER BY version DESC LIMIT 1
  `).get(row.thread_id) as { brief_json: string } | undefined;
  if (!briefRow) return null;

  const completed = db.db.prepare(`
    SELECT stream_id FROM stream_runs WHERE research_run_id = ? AND status = 'completed'
  `).all(runId) as Array<{ stream_id: string }>;

  const synthesis = db.db.prepare(`
    SELECT id FROM reports WHERE thread_id = ? AND stream_id = 'synthesis' LIMIT 1
  `).get(row.thread_id) as { id: string } | undefined;

  const brief = parseBrief(briefRow.brief_json);
  const config = parseRunConfig(row.config_json);
  if (!brief || !config) return null;

  return {
    runId: row.id,
    threadId: row.thread_id,
    brief,
    config,
    completedStreamIds: new Set(completed.map((item) => item.stream_id)),
    hasSynthesis: Boolean(synthesis),
    spendEstimate: row.spend_estimate ?? 0,
  };
}

export function cancelIncompleteRun(db: DatabaseClient, runId: string): void {
  const row = db.db.prepare("SELECT thread_id FROM research_runs WHERE id = ?").get(runId) as { thread_id: string } | undefined;
  if (!row) return;
  const now = new Date().toISOString();
  db.db.prepare("UPDATE research_runs SET status = 'cancelled', cancelled = 1, updated_at = ? WHERE id = ?").run(now, runId);
  db.db.prepare(`
    UPDATE stream_runs SET status = 'cancelled', updated_at = ?
    WHERE research_run_id = ? AND status = 'running'
  `).run(now, runId);

  const completedReports = db.db.prepare(`
    SELECT COUNT(*) as count FROM stream_runs WHERE research_run_id = ? AND status = 'completed'
  `).get(runId) as { count: number };
  const nextStatus = completedReports.count > 0 ? "research-complete" : "configuring";
  db.db.prepare("UPDATE threads SET status = ?, updated_at = ? WHERE id = ?").run(nextStatus, now, row.thread_id);
}

function parseRunConfig(raw: string): RunConfig | null {
  try {
    return RunConfigSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

function parseBrief(raw: string): ProjectBrief | null {
  try {
    return JSON.parse(raw) as ProjectBrief;
  } catch {
    return null;
  }
}

export function logJobEvent(
  db: DatabaseClient,
  runId: string | null,
  threadId: string | null,
  type: string,
  payload: Record<string, unknown>,
): void {
  db.db.prepare(`
    INSERT INTO job_events (run_id, thread_id, type, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(runId, threadId, type, JSON.stringify(payload), new Date().toISOString());
}
