import type { DatabaseClient } from "../client";

export type EvidenceFollowUpStatus = "requested" | "running" | "completed" | "failed";

export interface EvidenceFollowUp {
  researchRunId: string;
  solutionId: string;
  question: string;
  status: EvidenceFollowUpStatus;
  sourceIds: string[];
  factorIds: string[];
  error: string | null;
}

export class EvidenceFollowUpRepository {
  constructor(private readonly client: DatabaseClient) {}

  request(researchRunId: string, solutionId: string, question: string): EvidenceFollowUp {
    this.client.requireImmediateTransaction();
    const normalized = question.trim();
    if (!normalized || normalized.length > 500) {
      throw new Error("Evidence follow-up question must contain 1 to 500 characters");
    }
    const existing = this.find(researchRunId);
    if (existing) throw new Error("This run has already used its evidence follow-up");
    const target = this.client.db.prepare(`
      SELECT 1
      FROM research_runs rr
      JOIN solutions s ON s.research_run_id = rr.id AND s.id = ? AND s.selected_at IS NOT NULL
      JOIN decision_analyses da ON da.research_run_id = rr.id AND da.solution_id = s.id
      WHERE rr.id = ? AND rr.workflow_version = 2 AND rr.status = 'completed'
    `).get(solutionId, researchRunId);
    if (!target) throw new Error("Evidence follow-up requires a completed v2 selected-option analysis");
    const now = new Date().toISOString();
    this.client.db.prepare(`
      INSERT INTO evidence_follow_ups (
        research_run_id, solution_id, question, status, requested_at, updated_at
      ) VALUES (?, ?, ?, 'requested', ?, ?)
    `).run(researchRunId, solutionId, normalized, now, now);
    return this.find(researchRunId)!;
  }

  markRunning(researchRunId: string): void {
    this.transition(researchRunId, "requested", "running");
  }

  complete(researchRunId: string, sourceIds: string[], factorIds: string[]): void {
    this.client.requireImmediateTransaction();
    const now = new Date().toISOString();
    this.client.db.prepare(`
      UPDATE evidence_follow_ups
      SET status = 'completed', source_ids_json = ?, factor_ids_json = ?,
          error_message = NULL, completed_at = ?, updated_at = ?
      WHERE research_run_id = ? AND status = 'running'
    `).run(JSON.stringify(sourceIds), JSON.stringify(factorIds), now, now, researchRunId);
    if (this.changes() !== 1) throw new Error("Evidence follow-up is not running");
  }

  fail(researchRunId: string, error: string): void {
    this.client.requireImmediateTransaction();
    const now = new Date().toISOString();
    this.client.db.prepare(`
      UPDATE evidence_follow_ups SET status = 'failed', error_message = ?, completed_at = ?, updated_at = ?
      WHERE research_run_id = ? AND status IN ('requested', 'running')
    `).run(error, now, now, researchRunId);
    if (this.changes() !== 1) throw new Error("Evidence follow-up already has a terminal result");
  }

  find(researchRunId: string): EvidenceFollowUp | null {
    const row = this.client.db.prepare(`
      SELECT research_run_id, solution_id, question, status, source_ids_json, factor_ids_json, error_message
      FROM evidence_follow_ups WHERE research_run_id = ?
    `).get(researchRunId) as {
      research_run_id: string;
      solution_id: string;
      question: string;
      status: EvidenceFollowUpStatus;
      source_ids_json: string;
      factor_ids_json: string;
      error_message: string | null;
    } | undefined;
    return row ? {
      researchRunId: row.research_run_id,
      solutionId: row.solution_id,
      question: row.question,
      status: row.status,
      sourceIds: JSON.parse(row.source_ids_json) as string[],
      factorIds: JSON.parse(row.factor_ids_json) as string[],
      error: row.error_message,
    } : null;
  }

  failInterrupted(reason: string): string[] {
    const rows = this.interruptedRunIds().map((research_run_id) => ({ research_run_id }));
    if (rows.length === 0) return [];
    const now = new Date().toISOString();
    this.client.db.prepare(`
      UPDATE evidence_follow_ups
      SET status = 'failed', error_message = ?, completed_at = ?, updated_at = ?
      WHERE status IN ('requested', 'running')
    `).run(reason, now, now);
    const updateRun = this.client.db.prepare(`
      UPDATE research_runs SET status = 'completed', completion_reason = ?, updated_at = ? WHERE id = ?
    `);
    const updateThread = this.client.db.prepare(`
      UPDATE threads SET status = 'solutions-ready', updated_at = ?
      WHERE id = (SELECT thread_id FROM research_runs WHERE id = ?)
    `);
    for (const row of rows) {
      updateRun.run("Analysis completed; evidence follow-up interrupted", now, row.research_run_id);
      updateThread.run(now, row.research_run_id);
    }
    return rows.map((row) => row.research_run_id);
  }

  interruptedRunIds(): string[] {
    return (this.client.db.prepare(`
      SELECT research_run_id FROM evidence_follow_ups WHERE status IN ('requested', 'running')
    `).all() as Array<{ research_run_id: string }>).map((row) => row.research_run_id);
  }

  private transition(researchRunId: string, from: EvidenceFollowUpStatus, to: EvidenceFollowUpStatus): void {
    this.client.requireImmediateTransaction();
    this.client.db.prepare(`
      UPDATE evidence_follow_ups SET status = ?, updated_at = ?
      WHERE research_run_id = ? AND status = ?
    `).run(to, new Date().toISOString(), researchRunId, from);
    if (this.changes() !== 1) throw new Error(`Evidence follow-up is not ${from}`);
  }

  private changes(): number {
    return (this.client.db.prepare("SELECT changes() AS count").get() as { count: number }).count;
  }
}
