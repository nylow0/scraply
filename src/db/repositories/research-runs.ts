import { randomUUID } from "node:crypto";
import type { ProjectBrief, RunConfig } from "../../shared/schemas";
import type { DatabaseClient } from "../client";

export class ActiveRunConflictError extends Error {
  readonly code = "ACTIVE_RUN_CONFLICT";

  constructor(readonly existingRunId: string) {
    super("This thread already has an active research run");
    this.name = "ActiveRunConflictError";
  }
}

export interface CreatedResearchRun {
  runId: string;
  created: boolean;
}

export class ResearchRunRepository {
  constructor(private readonly client: DatabaseClient) {}

  create(
    threadId: string,
    brief: ProjectBrief,
    config: RunConfig,
    idempotencyKey?: string,
  ): CreatedResearchRun {
    const key = idempotencyKey ?? randomUUID();
    const db = this.client.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const idempotent = db.prepare(`
        SELECT id FROM research_runs WHERE thread_id = ? AND idempotency_key = ?
      `).get(threadId, key) as { id: string } | undefined;
      if (idempotent) {
        db.exec("COMMIT");
        return { runId: idempotent.id, created: false };
      }

      const active = db.prepare(`
        SELECT id FROM research_runs
        WHERE thread_id = ? AND status IN ('queued', 'running')
        LIMIT 1
      `).get(threadId) as { id: string } | undefined;
      if (active) throw new ActiveRunConflictError(active.id);

      const runId = randomUUID();
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO research_runs (
          id, thread_id, status, config_json, brief_json, idempotency_key,
          spend_estimate, round, cancelled, budget_limit, reserved_cost,
          committed_cost, created_at, updated_at
        ) VALUES (?, ?, 'running', ?, ?, ?, 0, 0, 0, ?, 0, 0, ?, ?)
      `).run(
        runId,
        threadId,
        JSON.stringify(config),
        JSON.stringify(brief),
        key,
        config.maxSpendUsd,
        now,
        now,
      );
      db.exec("COMMIT");
      return { runId, created: true };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  finish(runId: string, status: "completed" | "partial" | "failed" | "cancelled", reason?: string): void {
    if (status === "completed") {
      const synthesis = this.client.db.prepare(`
        SELECT id FROM reports
        WHERE research_run_id = ? AND report_kind = 'synthesis'
        LIMIT 1
      `).get(runId);
      if (!synthesis) throw new Error("A run cannot complete without a persisted synthesis");
    }
    this.client.db.prepare(`
      UPDATE research_runs
      SET status = ?, completion_reason = ?, cancelled = ?, updated_at = ?
      WHERE id = ?
    `).run(status, reason ?? null, status === "cancelled" ? 1 : 0, new Date().toISOString(), runId);
  }

  cancel(runId: string, reason = "Cancelled by user"): void {
    this.finish(runId, "cancelled", reason);
    this.client.db.prepare(`
      UPDATE stream_runs SET status = 'cancelled', gap_stop_reason = ?, updated_at = ?
      WHERE research_run_id = ? AND status = 'running'
    `).run(reason, new Date().toISOString(), runId);
  }
}
