import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DatabaseClient } from "../db/client";
import { SearchProviderSchema } from "../providers/search";
import { canonicalJson, workflowSearchKey } from "../shared/content-identity";

export const WorkflowSearchAttemptSchema = z.object({
  id: z.string().uuid(), key: z.string().regex(/^search:[a-f0-9]{64}$/),
  query: z.string().min(1), parameters: z.record(z.unknown()), provider: SearchProviderSchema.optional(),
  createdAt: z.string().datetime(),
}).strict();
export const WorkflowSearchTerminalSchema = z.object({
  status: z.enum(["completed", "failed", "cancelled"]), finishedAt: z.string().datetime(),
  message: z.string().max(2_000).optional(),
}).strict();
export type WorkflowSearchAttempt = z.infer<typeof WorkflowSearchAttemptSchema>;

export class UnknownSearchCompletionError extends Error {
  constructor(readonly attemptId: string) {
    super("A search may have completed before interruption. Acknowledge this request before retrying it.");
    this.name = "UnknownSearchCompletionError";
  }
}

/** Missing terminals are ambiguous until the user acknowledges that exact dispatch. Old runs have no receipts. */
export function unknownSearchAttempts(db: Pick<DatabaseClient, "db">, runId: string,
  acknowledgedAttemptIds: readonly string[] = []): WorkflowSearchAttempt[] {
  const rows = db.db.prepare(`SELECT attempt.value_json FROM workflow_snapshots attempt
    WHERE attempt.research_run_id = ? AND attempt.snapshot_key LIKE 'search-attempt:%'
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

/** The receipt commits before dispatch. Acknowledgments and older attempts remain immutable audit history. */
export function prepareWorkflowSearch(db: DatabaseClient, runId: string,
  input: Pick<WorkflowSearchAttempt, "key" | "query" | "parameters" | "provider">,
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
