import type { DatabaseClient } from "../db/client";
import { CostLedgerRepository } from "../db/repositories/cost-ledger";
import { ResearchRunRepository } from "../db/repositories/research-runs";
import { RESEARCH_STREAMS } from "../research/streams";
import { parseAndNormalizeBrief } from "../shared/brief-normalizer";
import { AppError } from "../shared/errors";
import { parseAndNormalizeRunConfig } from "../shared/run-config-normalizer";
import type { ProjectBrief, RunConfig } from "../shared/schemas";

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
  startedAt: string;
  selectedStreamIds: string[];
  completedStreamIds: Set<string>;
  hasSynthesis: boolean;
}

export function listPendingRuns(db: DatabaseClient, activeRunIds: ReadonlySet<string> = new Set()): PendingRun[] {
  const rows = db.db.prepare(`
    SELECT rr.id, rr.thread_id, rr.status, rr.selected_stream_ids_json, t.title as thread_title
    FROM research_runs rr
    JOIN threads t ON t.id = rr.thread_id
    WHERE rr.status IN ('queued', 'running')
    ORDER BY rr.updated_at DESC
  `).all() as Array<{
    id: string;
    thread_id: string;
    status: string;
    selected_stream_ids_json: string | null;
    thread_title: string;
  }>;

  return rows.filter((row) => !activeRunIds.has(row.id)).map((row) => {
    const streamRows = db.db.prepare(`
      SELECT stream_id, status FROM stream_runs WHERE research_run_id = ?
    `).all(row.id) as Array<{ stream_id: string; status: string }>;
    const completedStreams = new Set(
      streamRows.filter((stream) => stream.status === "completed").map((stream) => stream.stream_id),
    ).size;
    const synthesis = db.db.prepare(`
      SELECT id FROM reports WHERE research_run_id = ? AND report_kind = 'synthesis' LIMIT 1
    `).get(row.id) as { id: string } | undefined;

    return {
      runId: row.id,
      threadId: row.thread_id,
      threadTitle: row.thread_title,
      status: row.status,
      completedStreams,
      totalStreams: parseSelectedStreamIds(row.selected_stream_ids_json).length,
      hasSynthesis: Boolean(synthesis),
    };
  });
}

export function loadStoredRunState(db: DatabaseClient, runId: string): StoredRunState | null {
  const row = db.db.prepare(`
    SELECT id, thread_id, config_json, brief_json, selected_stream_ids_json, created_at
    FROM research_runs WHERE id = ?
  `).get(runId) as {
    id: string;
    thread_id: string;
    config_json: string;
    brief_json: string | null;
    selected_stream_ids_json: string | null;
    created_at: string;
  } | undefined;
  if (!row) return null;

  const briefRow = row.brief_json ? { brief_json: row.brief_json } : db.db.prepare(`
    SELECT brief_json FROM briefs WHERE thread_id = ? ORDER BY version DESC LIMIT 1
  `).get(row.thread_id) as { brief_json: string } | undefined;
  if (!briefRow) return null;

  const completed = db.db.prepare(`
    SELECT stream_id FROM stream_runs WHERE research_run_id = ? AND status = 'completed'
  `).all(runId) as Array<{ stream_id: string }>;

  const synthesis = db.db.prepare(`
    SELECT id FROM reports WHERE research_run_id = ? AND report_kind = 'synthesis' LIMIT 1
  `).get(runId) as { id: string } | undefined;

  return {
    runId: row.id,
    threadId: row.thread_id,
    brief: parseAndNormalizeBrief(JSON.parse(briefRow.brief_json)),
    config: parseAndNormalizeRunConfig(JSON.parse(row.config_json)),
    startedAt: row.created_at,
    selectedStreamIds: parseSelectedStreamIds(row.selected_stream_ids_json),
    completedStreamIds: new Set(completed.map((item) => item.stream_id)),
    hasSynthesis: Boolean(synthesis),
  };
}

function parseSelectedStreamIds(value: string | null): string[] {
  const fallback = RESEARCH_STREAMS.map((stream) => stream.id);
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return fallback;
    const knownIds = new Set<string>(fallback);
    const selected = [...new Set(parsed.filter((id): id is string => typeof id === "string" && knownIds.has(id)))];
    return selected.length ? selected : fallback;
  } catch {
    return fallback;
  }
}

export function cancelIncompleteRun(db: DatabaseClient, runId: string): void {
  const row = db.db.prepare("SELECT thread_id, status FROM research_runs WHERE id = ?").get(runId) as
    { thread_id: string; status: string } | undefined;
  if (!row) throw new AppError("not_found", "Research run not found.");
  if (!["queued", "running"].includes(row.status)) {
    throw new AppError("conflict", "This research run has already ended and cannot be cancelled.");
  }
  const now = new Date().toISOString();
  new ResearchRunRepository(db).cancel(runId, "Cancelled during recovery");
  new CostLedgerRepository(db).settleUncertain(runId, "Interrupted operation could not be reconciled");
  db.db.prepare("UPDATE threads SET status = ?, updated_at = ? WHERE id = ?").run("configuring", now, row.thread_id);
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
