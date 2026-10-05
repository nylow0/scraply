import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DatabaseClient } from "../db/client";
import { SearchProviderSchema } from "../providers/search";
import { canonicalJson, workflowSearchKey } from "../shared/content-identity";

export const WorkflowSearchAttemptSchema = z.object({
  id: z.string().uuid(), key: z.string().regex(/^search:[a-f0-9]{64}$/),
  query: z.string().min(1), parameters: z.record(z.unknown()), provider: SearchProviderSchema.optional(),
  createdAt: z.string().datetime(),
  dispatchProofVersion: z.literal(1).optional(),
}).strict();
export const WorkflowSearchDispatchSchema = z.object({
  attemptId: z.string().uuid(), dispatchedAt: z.string().datetime(),
}).strict();
export const WorkflowSearchTerminalSchema = z.object({
  status: z.enum(["completed", "failed", "cancelled"]), finishedAt: z.string().datetime(),
  message: z.string().max(2_000).optional(),
}).strict();
export type WorkflowSearchAttempt = z.infer<typeof WorkflowSearchAttemptSchema>;

/** Historical keys remain readable; new proof must describe the exact saved request and snapshot. */
export function workflowSearchReceiptIdentityMatches(attempt: WorkflowSearchAttempt, snapshotKey: string): boolean {
  return snapshotKey === `search-attempt:${attempt.key.slice("search:".length)}:${attempt.id}`
    && (attempt.dispatchProofVersion === undefined || attempt.key === workflowSearchKey(attempt.query, attempt.parameters, attempt.provider));
}

export function workflowSearchWasDispatched(attempt: WorkflowSearchAttempt,
  dispatch: unknown, snapshotKey?: string): boolean {
  // A present proof, even malformed or contradictory, cannot establish that no request was sent.
  return attempt.dispatchProofVersion !== 1 || dispatch !== null
    || attempt.key !== workflowSearchKey(attempt.query, attempt.parameters, attempt.provider)
    || (snapshotKey !== undefined && !workflowSearchReceiptIdentityMatches(attempt, snapshotKey));
}

function readWorkflowSearchAttempts(db: Pick<DatabaseClient, "db">, runId: string) {
  const rows = db.db.prepare(`SELECT snapshot_key, value_json FROM workflow_snapshots
    WHERE research_run_id = ? AND snapshot_key LIKE 'search-attempt:%' ORDER BY rowid`).all(runId) as
    Array<{ snapshot_key: string; value_json: string }>;
  const saved = db.db.prepare("SELECT snapshot_key FROM workflow_snapshots WHERE research_run_id = ?").all(runId) as
    Array<{ snapshot_key: string }>;
  const keys = new Set(saved.map(row => row.snapshot_key));
  return rows.map(row => {
    let receipt: WorkflowSearchAttempt | null = null;
    try {
      const parsed = WorkflowSearchAttemptSchema.safeParse(JSON.parse(row.value_json));
      if (parsed.success) receipt = parsed.data;
    } catch { /* Invalid saved data cannot establish absence of dispatch. */ }
    const validReceipt = receipt !== null && workflowSearchReceiptIdentityMatches(receipt, row.snapshot_key) ? receipt : null;
    return { ...row, receipt: validReceipt,
      dispatched: validReceipt ? workflowSearchWasDispatched(validReceipt, keys.has(`search-dispatched:${validReceipt.id}`) ? true : null) : true,
      terminal: validReceipt !== null && keys.has(`search-terminal:${validReceipt.id}`),
      acknowledged: validReceipt !== null && keys.has(`search-acknowledged:${validReceipt.id}`),
      checkpoint: validReceipt !== null && keys.has(validReceipt.key) };
  });
}

/** Damaged receipts still count, but cannot supply a fabricated UUID for retries or ledger linkage. */
export function workflowSearchDispatches(db: Pick<DatabaseClient, "db">, runId: string): Array<{ id: string | null; unknown: boolean }> {
  return readWorkflowSearchAttempts(db, runId).filter(attempt => attempt.dispatched)
    .map(attempt => ({ id: attempt.receipt?.id ?? null, unknown: !attempt.terminal }));
}

/** Usage keeps uncertain historical dispatches even after acknowledgment permits a separate request. */
export function workflowSearchDispatchUsage(db: Pick<DatabaseClient, "db">, runId: string): { attemptCount: number; unknownCount: number } {
  const attempts = workflowSearchDispatches(db, runId);
  return { attemptCount: attempts.length, unknownCount: attempts.filter(attempt => attempt.unknown).length };
}

export class UnknownSearchCompletionError extends Error {
  constructor(readonly attemptId: string) {
    super("A search may have completed before interruption. Acknowledge this request before retrying it.");
    this.name = "UnknownSearchCompletionError";
  }
}

/** Missing terminals are ambiguous only after dispatch, or for conservative historical receipts. */
export function unknownSearchAttempts(db: Pick<DatabaseClient, "db">, runId: string,
  acknowledgedAttemptIds: readonly string[] = []): WorkflowSearchAttempt[] {
  return readWorkflowSearchAttempts(db, runId)
    .filter(attempt => attempt.dispatched && !attempt.terminal && !attempt.acknowledged && !attempt.checkpoint)
    .map(attempt => {
      if (!attempt.receipt) {
        WorkflowSearchAttemptSchema.parse(JSON.parse(attempt.value_json));
        throw new Error("Search receipt identity conflict");
      }
      return attempt.receipt;
    }).filter(attempt => !acknowledgedAttemptIds.includes(attempt.id));
}

/** The receipt commits before admission. Opt-in proof distinguishes new preparation from physical work. */
export function prepareWorkflowSearch(db: DatabaseClient, runId: string,
  input: Pick<WorkflowSearchAttempt, "key" | "query" | "parameters" | "provider" | "dispatchProofVersion">,
  acknowledgedAttemptIds: readonly string[]): WorkflowSearchAttempt {
  return db.immediateTransaction(() => {
    for (const previous of unknownSearchAttempts(db, runId).filter(attempt =>
      workflowSearchKey(attempt.query, attempt.parameters) === workflowSearchKey(input.query, input.parameters))) {
      if (!acknowledgedAttemptIds.includes(previous.id)) throw new UnknownSearchCompletionError(previous.id);
      db.db.prepare("INSERT INTO workflow_snapshots VALUES (?, ?, ?)")
        .run(runId, `search-acknowledged:${previous.id}`, canonicalJson({ attemptId: previous.id, acknowledgedAt: new Date().toISOString() }));
    }
    const attempt = WorkflowSearchAttemptSchema.parse({ ...input, id: randomUUID(), createdAt: new Date().toISOString() });
    db.db.prepare("INSERT INTO workflow_snapshots VALUES (?, ?, ?)")
      .run(runId, `search-attempt:${input.key.slice("search:".length)}:${attempt.id}`, canonicalJson(attempt));
    return attempt;
  });
}

/** A saved intent precedes provider invocation; a crash after it remains conservatively uncertain. */
export function recordWorkflowSearchDispatched(db: DatabaseClient, runId: string, attemptId: string): void {
  db.immediateTransaction(() => {
    const key = `search-dispatched:${attemptId}`;
    const existing = db.db.prepare("SELECT value_json FROM workflow_snapshots WHERE research_run_id = ? AND snapshot_key = ?")
      .get(runId, key) as { value_json: string } | undefined;
    if (existing) {
      const dispatch = WorkflowSearchDispatchSchema.parse(JSON.parse(existing.value_json));
      if (dispatch.attemptId !== attemptId) throw new Error("Search dispatch identity conflict");
      return;
    }
    const dispatch = WorkflowSearchDispatchSchema.parse({ attemptId, dispatchedAt: new Date().toISOString() });
    db.db.prepare("INSERT INTO workflow_snapshots VALUES (?, ?, ?)").run(runId, key, canonicalJson(dispatch));
  });
}

export function recordWorkflowSearchTerminal(db: DatabaseClient, runId: string, attemptId: string,
  status: z.infer<typeof WorkflowSearchTerminalSchema>["status"], message?: string,
  options?: { transaction: "existing" }): void {
  const terminal = WorkflowSearchTerminalSchema.parse({ status, finishedAt: new Date().toISOString(),
    ...(message ? { message: message.slice(0, 2_000) } : {}) });
  const mutation = () => {
    const existing = db.db.prepare("SELECT value_json FROM workflow_snapshots WHERE research_run_id = ? AND snapshot_key = ?")
      .get(runId, `search-terminal:${attemptId}`) as { value_json: string } | undefined;
    if (existing) {
      WorkflowSearchTerminalSchema.parse(JSON.parse(existing.value_json));
      return;
    }
    db.db.prepare("INSERT INTO workflow_snapshots VALUES (?, ?, ?)")
      .run(runId, `search-terminal:${attemptId}`, canonicalJson(terminal));
  };
  if (options?.transaction === "existing") {
    db.requireImmediateTransaction();
    mutation();
  } else db.immediateTransaction(mutation);
}
