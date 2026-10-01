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

// Missing proof is conclusive only for new prepared receipts. Historical receipts stay conservative.
const physicalSearchPredicate = `(json_extract(attempt.value_json, '$.dispatchProofVersion') IS NOT 1
  OR EXISTS (SELECT 1 FROM workflow_snapshots dispatch WHERE dispatch.research_run_id = attempt.research_run_id
    AND dispatch.snapshot_key = 'search-dispatched:' || json_extract(attempt.value_json, '$.id')
    AND json_extract(dispatch.value_json, '$.attemptId') = json_extract(attempt.value_json, '$.id')))`;

export function workflowSearchWasDispatched(attempt: WorkflowSearchAttempt,
  dispatch: z.infer<typeof WorkflowSearchDispatchSchema> | null): boolean {
  return attempt.dispatchProofVersion === undefined || dispatch?.attemptId === attempt.id;
}

/** Usage keeps uncertain historical dispatches even after acknowledgment permits a separate request. */
export function workflowSearchDispatchUsage(db: Pick<DatabaseClient, "db">, runId: string): { attemptCount: number; unknownCount: number } {
  const row = db.db.prepare(`SELECT COUNT(*) AS attemptCount,
    COALESCE(SUM(NOT EXISTS (SELECT 1 FROM workflow_snapshots terminal
      WHERE terminal.research_run_id = attempt.research_run_id
        AND terminal.snapshot_key = 'search-terminal:' || json_extract(attempt.value_json, '$.id'))), 0) AS unknownCount
    FROM workflow_snapshots attempt
    WHERE attempt.research_run_id = ? AND attempt.snapshot_key LIKE 'search-attempt:%'
      AND ${physicalSearchPredicate}`).get(runId) as { attemptCount: number; unknownCount: number };
  return row;
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
  const rows = db.db.prepare(`SELECT attempt.value_json FROM workflow_snapshots attempt
    WHERE attempt.research_run_id = ? AND attempt.snapshot_key LIKE 'search-attempt:%'
      AND ${physicalSearchPredicate}
      AND NOT EXISTS (SELECT 1 FROM workflow_snapshots terminal WHERE terminal.research_run_id = attempt.research_run_id
        AND terminal.snapshot_key = 'search-terminal:' || json_extract(attempt.value_json, '$.id'))
      AND NOT EXISTS (SELECT 1 FROM workflow_snapshots acknowledgment WHERE acknowledgment.research_run_id = attempt.research_run_id
        AND acknowledgment.snapshot_key = 'search-acknowledged:' || json_extract(attempt.value_json, '$.id'))
      AND NOT EXISTS (SELECT 1 FROM workflow_snapshots checkpoint WHERE checkpoint.research_run_id = attempt.research_run_id
        AND checkpoint.snapshot_key = json_extract(attempt.value_json, '$.key'))
    ORDER BY attempt.rowid`).all(runId) as Array<{ value_json: string }>;
  return rows.map(row => WorkflowSearchAttemptSchema.parse(JSON.parse(row.value_json)))
    .filter(attempt => !acknowledgedAttemptIds.includes(attempt.id));
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
