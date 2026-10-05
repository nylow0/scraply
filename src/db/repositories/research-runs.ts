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
export interface ResearchRunWorkflowLink {
  sessionId: string;
  purpose: "discovery" | "known-problem" | "research-followup" | "idea-turn";
  evidenceSnapshotId?: string | null;
  frameId?: string | null;
  /** Link the new run to its reserved work item before any provider dispatch. False cancels it. */
  onRunCreated?: (runId: string) => boolean;
}
const ACCOUNTING_BUDGET_USD = 1_000;

/**
 * Returns an active run that keeps this run from starting or resuming, if any. Idea runs of one workflow
 * session may run side by side; any other run needs the project to itself.
 */
export function blockingActiveRun(client: DatabaseClient, threadId: string,
  run: { id?: string; problemId: string | null; sessionId: string | null }): string | null {
  const active = client.db.prepare(`SELECT id, problem_id, workflow_session_id FROM research_runs
    WHERE thread_id = ? AND id != ? AND status IN ('queued', 'running')`)
    .all(threadId, run.id ?? "") as Array<{ id: string; problem_id: string | null; workflow_session_id: string | null }>;
  const sideBySide = run.problemId !== null && run.sessionId !== null
    && active.every((other) => other.problem_id !== null && other.workflow_session_id === run.sessionId);
  return active[0] && !sideBySide ? active[0].id : null;
}

export class ResearchRunRepository {
  constructor(private readonly client: DatabaseClient) {}

  create(threadId: string, config: RunConfig, problemId: string | null = null, idempotencyKey = randomUUID(), workflow?: ResearchRunWorkflowLink): CreatedResearchRun {
    const db = this.client.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const previous = db.prepare("SELECT id FROM research_runs WHERE thread_id = ? AND idempotency_key = ?")
        .get(threadId, idempotencyKey) as { id: string } | undefined;
      if (previous) {
        db.exec("COMMIT");
        return { runId: previous.id, created: false };
      }
      const blocking = blockingActiveRun(this.client, threadId, { problemId, sessionId: workflow?.sessionId ?? null });
      if (blocking) throw new ActiveRunConflictError(blocking);
      const runId = randomUUID();
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO research_runs (
          id, thread_id, status, config_json, idempotency_key, spend_estimate, cancelled,
          completion_reason, budget_limit, reserved_cost, committed_cost, problem_id, created_at, updated_at,
          workflow_session_id, purpose, evidence_snapshot_id
        ) VALUES (?, ?, 'running', ?, ?, 0, 0, NULL, ?, 0, 0, ?, ?, ?, ?, ?, ?)
      `).run(runId, threadId, JSON.stringify(config), idempotencyKey, ACCOUNTING_BUDGET_USD, problemId, now, now,
        workflow?.sessionId ?? null, workflow?.purpose ?? null, workflow?.evidenceSnapshotId ?? null);
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
