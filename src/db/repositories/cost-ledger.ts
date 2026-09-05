import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "../client";

export class BudgetExceededError extends Error {
  readonly code = "BUDGET_EXCEEDED";

  constructor(readonly availableUsd: number, readonly requestedUsd: number) {
    super("The next operation cannot fit inside this run's remaining budget");
    this.name = "BudgetExceededError";
  }
}

export interface CostReservation {
  id: string;
  reservedUsd: number;
}

export class CostLedgerRepository {
  constructor(private readonly client: DatabaseClient) {}

  countProviderCalls(runId: string, provider: string): number {
    const row = this.client.db.prepare(`
      SELECT COUNT(*) AS count FROM cost_ledger
      WHERE research_run_id = ? AND provider = ? AND status IN ('reserved', 'committed')
    `).get(runId, provider) as { count: number };
    return row.count;
  }

  reserve(
    runId: string,
    operation: string,
    provider: string,
    model: string | null,
    upperBoundUsd: number,
    generationAttemptId?: string,
  ): CostReservation {
    if (!Number.isFinite(upperBoundUsd) || upperBoundUsd < 0) throw new Error("Invalid cost reservation");
    const db = this.client.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const run = db.prepare(`
        SELECT status, budget_limit, reserved_cost, committed_cost
        FROM research_runs WHERE id = ?
      `).get(runId) as {
        status: string;
        budget_limit: number;
        reserved_cost: number;
        committed_cost: number;
      } | undefined;
      if (!run) throw new Error("Research run not found");
      if (!["queued", "running"].includes(run.status)) {
        throw new Error("Research run cannot accept new paid operations");
      }
      const available = Math.max(0, run.budget_limit - run.reserved_cost - run.committed_cost);
      if (upperBoundUsd > available) throw new BudgetExceededError(available, upperBoundUsd);

      const id = randomUUID();
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO cost_ledger (
          id, research_run_id, operation, provider, model, reservation_usd,
          committed_usd, status, generation_attempt_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'reserved', ?, ?, ?)
      `).run(id, runId, operation, provider, model, upperBoundUsd, generationAttemptId ?? null, now, now);
      db.prepare(`
        UPDATE research_runs SET reserved_cost = reserved_cost + ?, updated_at = ? WHERE id = ?
      `).run(upperBoundUsd, now, runId);
      db.exec("COMMIT");
      return { id, reservedUsd: upperBoundUsd };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  commit(reservationId: string, actualUsd: number | null, usage?: Record<string, unknown>): void {
    const db = this.client.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const entry = db.prepare(`
        SELECT research_run_id, reservation_usd, status FROM cost_ledger WHERE id = ?
      `).get(reservationId) as { research_run_id: string; reservation_usd: number; status: string } | undefined;
      if (!entry) throw new Error("Cost reservation not found");
      if (entry.status === "committed") {
        db.exec("COMMIT");
        return;
      }
      if (entry.status !== "reserved") throw new Error("Cost reservation is already settled");
      if (actualUsd !== null && (!Number.isFinite(actualUsd) || actualUsd < 0 || actualUsd > entry.reservation_usd)) {
        throw new Error("Committed cost must be within the reservation");
      }
      const now = new Date().toISOString();
      db.prepare(`
        UPDATE cost_ledger
        SET committed_usd = ?, status = 'committed', usage_json = ?, updated_at = ?
        WHERE id = ?
      `).run(actualUsd, usage ? JSON.stringify(usage) : null, now, reservationId);
      db.prepare(`
        UPDATE research_runs
        SET reserved_cost = MAX(0, reserved_cost - ?), committed_cost = committed_cost + ?,
            spend_estimate = committed_cost + ?, updated_at = ?
        WHERE id = ?
      `).run(entry.reservation_usd, actualUsd ?? 0, actualUsd ?? 0, now, entry.research_run_id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  settleUncertain(runId: string, reason: string): void {
    const rows = this.client.db.prepare(`
      SELECT id FROM cost_ledger WHERE research_run_id = ? AND status = 'reserved'
    `).all(runId) as Array<{ id: string }>;
    for (const row of rows) this.commit(row.id, null, { uncertain: true, reason });
  }

  release(reservationId: string): void {
    const db = this.client.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const entry = db.prepare("SELECT research_run_id, reservation_usd, status FROM cost_ledger WHERE id = ?")
        .get(reservationId) as { research_run_id: string; reservation_usd: number; status: string } | undefined;
      if (!entry || entry.status !== "reserved") {
        db.exec("COMMIT");
        return;
      }
      db.prepare("DELETE FROM cost_ledger WHERE id = ?").run(reservationId);
      db.prepare("UPDATE research_runs SET reserved_cost = MAX(0, reserved_cost - ?), updated_at = ? WHERE id = ?")
        .run(entry.reservation_usd, new Date().toISOString(), entry.research_run_id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
