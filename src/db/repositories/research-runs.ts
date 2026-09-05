import { randomUUID } from "node:crypto";
import type { RunConfig } from "../../shared/schemas";
import type { DatabaseClient } from "../client";

export class ActiveRunConflictError extends Error {
  readonly code = "ACTIVE_RUN_CONFLICT";
  constructor(readonly existingRunId: string) {
    super("This thread already has an active research run");
    this.name = "ActiveRunConflictError";
  }
}

export interface CreatedResearchRun { runId: string; created: boolean }
const ACCOUNTING_BUDGET_USD = 1_000;

export class ResearchRunRepository {
  constructor(private readonly client: DatabaseClient) {}

  create(threadId: string, config: RunConfig, problemId: string | null = null, idempotencyKey = randomUUID()): CreatedResearchRun {
    const db = this.client.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const previous = db.prepare("SELECT id FROM research_runs WHERE thread_id = ? AND idempotency_key = ?")
        .get(threadId, idempotencyKey) as { id: string } | undefined;
      if (previous) {
        db.exec("COMMIT");
        return { runId: previous.id, created: false };
      }
      const active = db.prepare(`SELECT id FROM research_runs WHERE thread_id = ? AND status IN ('queued', 'running') LIMIT 1`)
        .get(threadId) as { id: string } | undefined;
      if (active) throw new ActiveRunConflictError(active.id);
      const runId = randomUUID();
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO research_runs (
          id, thread_id, status, config_json, idempotency_key, spend_estimate, cancelled,
          completion_reason, budget_limit, reserved_cost, committed_cost, problem_id, created_at, updated_at
        ) VALUES (?, ?, 'running', ?, ?, 0, 0, NULL, ?, 0, 0, ?, ?, ?)
      `).run(runId, threadId, JSON.stringify(config), idempotencyKey, ACCOUNTING_BUDGET_USD, problemId, now, now);
      db.prepare("UPDATE research_runs SET workflow_version = ? WHERE id = ?").run(config.workflowVersion ?? 1, runId);
      db.exec("COMMIT");
      return { runId, created: true };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  finish(runId: string, status: "completed" | "failed" | "cancelled", reason?: string): void {
    this.client.db.prepare(`
      UPDATE research_runs SET status = ?, completion_reason = ?, cancelled = ?, updated_at = ? WHERE id = ?
    `).run(status, reason ?? null, status === "cancelled" ? 1 : 0, new Date().toISOString(), runId);
  }

  cancel(runId: string, reason = "Cancelled by user"): void { this.finish(runId, "cancelled", reason); }
}
