import type { DatabaseClient } from "../db/client";
import { GenerationAttemptRepository } from "../db/repositories/generation-attempts";
import { WorkflowRepository } from "../db/repositories/workflows";
import { unknownSearchAttempts } from "./workflow-search-attempts";

type ModelReadiness = { acknowledgedAttemptIds: string[] } & (
  { kind: "ready" } | { kind: "unknown-model"; reason: string }
);
type EngineResumeReadiness = ModelReadiness | {
  kind: "unknown-investigator-search";
  acknowledgedAttemptIds: string[];
};
type RetryReview = { id: string; kind: "search" | "model"; completionUnknown: boolean };
type RetryAttempt = { id: string; kind: "search" } | {
  id: string; kind: "model"; ambiguous: boolean; safeTransient: boolean; outputLimit: boolean;
};

/** Read-only recovery decisions. Callers retain admission, transactions, accounting, and dispatch. */
export class RunRecovery {
  private readonly workflows: WorkflowRepository;
  private readonly models: GenerationAttemptRepository;

  constructor(private readonly db: DatabaseClient) {
    this.workflows = new WorkflowRepository(db);
    this.models = new GenerationAttemptRepository(db);
  }

  /** Selection reads only model receipts, even when unrelated search history is damaged. */
  acknowledgedModelReadiness(runId: string): ModelReadiness {
    return this.modelReadiness(runId, this.workflows.acknowledgedAttemptIds(runId));
  }

  /** Engine resume checks investigators before models; workflow searches keep their per-query guard. */
  engineResumeReadiness(runId: string, additionalIds: readonly string[] = []): EngineResumeReadiness {
    const acknowledged = [...new Set([...this.workflows.acknowledgedAttemptIds(runId), ...additionalIds])];
    if (this.workflows.unknownInvestigatorSearches(runId, acknowledged).length) {
      return { kind: "unknown-investigator-search", acknowledgedAttemptIds: acknowledged };
    }
    return this.modelReadiness(runId, acknowledged);
  }

  /** The run projection reads models first, then both search histories in their existing order. */
  runProjectionReadiness(runId: string) {
    const acknowledged = this.workflows.acknowledgedAttemptIds(runId);
    const model = this.modelReadiness(runId, acknowledged);
    const unknownSearch = unknownSearchAttempts(this.db, runId, acknowledged).length > 0
      || this.workflows.unknownInvestigatorSearches(runId, acknowledged).length > 0;
    return { model, unknownSearch };
  }

  hasUnknownCompletion(runId: string): boolean {
    if (unknownSearchAttempts(this.db, runId, this.workflows.acknowledgedAttemptIds(runId)).length > 0) return true;
    if (!this.models.getResumeSafety(runId, this.workflows.acknowledgedAttemptIds(runId)).canResume) return true;
    return this.workflows.unknownInvestigatorSearches(runId, this.workflows.acknowledgedAttemptIds(runId)).length > 0;
  }

  retryReview(runId: string): RetryReview | null {
    const acknowledged = this.workflows.acknowledgedAttemptIds(runId);
    const search = [...unknownSearchAttempts(this.db, runId, acknowledged), ...this.workflows.unknownInvestigatorSearches(runId, acknowledged)]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)).at(-1);
    // Stable sorting preserves investigator precedence and each history's row order on ties.
    if (search) return { id: search.id, kind: "search", completionUnknown: true };
    // Older builds saved some lost streams as failures while retaining the native uncertainty.
    const rows = this.db.db.prepare(`SELECT id, EXISTS(SELECT 1 FROM json_each(attempt_metadata_json, '$.attempts')
      WHERE json_extract(value, '$.providerCompletion') = 'unknown') AS completion_unknown
      FROM generation_attempts WHERE research_run_id = ? ORDER BY created_at DESC, rowid DESC`)
      .all(runId) as Array<{ id: string; completion_unknown: number }>;
    const unresolved = new Set(this.models.unresolvedAttemptIds(runId).filter(id => !acknowledged.includes(id)));
    const row = rows.find(attempt => unresolved.has(attempt.id)) ?? rows[0];
    return row ? { id: row.id, kind: "model", completionUnknown: Boolean(row.completion_unknown) } : null;
  }

  /** Classify the exact raw receipt before latest-target and task-state checks in the coordinator. */
  retryAttempt(runId: string, expectedId: string): RetryAttempt | null {
    const search = [...unknownSearchAttempts(this.db, runId), ...this.workflows.unknownInvestigatorSearches(runId)]
      .find(attempt => attempt.id === expectedId);
    if (search) return { id: search.id, kind: "search" };
    const attempt = this.db.db.prepare(`SELECT id, status, terminal_kind, error_code,
      EXISTS(SELECT 1 FROM json_each(attempt_metadata_json, '$.attempts')
        WHERE json_extract(value, '$.providerCompletion') = 'unknown') AS completion_unknown FROM generation_attempts
      WHERE id = ? AND research_run_id = ?`).get(expectedId, runId) as {
        id: string; status: string; terminal_kind: string | null; error_code: string | null; completion_unknown: number;
      } | undefined;
    if (!attempt) return null;
    return { id: attempt.id, kind: "model",
      ambiguous: Boolean(attempt.completion_unknown) || ["dispatched", "accepted"].includes(attempt.status)
        || (attempt.status === "interrupted" && attempt.terminal_kind !== "never-dispatched"),
      safeTransient: attempt.terminal_kind === "never-dispatched"
        || (attempt.status === "failed" && ["timeout", "rate-limit", "unavailable"].includes(attempt.error_code ?? "")),
      outputLimit: attempt.status === "failed" && attempt.error_code === "output-limit" };
  }

  /** The coordinator validates the current target and task kind before proposing this exact-ID set. */
  planAcknowledgement(runId: string, terminalId: string) {
    const acknowledgedAttemptIds = [...new Set([...this.workflows.acknowledgedAttemptIds(runId), terminalId])];
    const unresolved = [
      ...this.models.unresolvedAttemptIds(runId),
      ...unknownSearchAttempts(this.db, runId).map(attempt => attempt.id),
      ...this.workflows.unknownInvestigatorSearches(runId).map(attempt => attempt.id),
    ];
    return { acknowledgedAttemptIds, stillUnresolved: unresolved.some(id => !acknowledgedAttemptIds.includes(id)) };
  }

  private modelReadiness(runId: string, acknowledgedAttemptIds: string[]): ModelReadiness {
    const safety = this.models.getResumeSafety(runId, acknowledgedAttemptIds);
    return safety.canResume ? { kind: "ready", acknowledgedAttemptIds }
      : { kind: "unknown-model", reason: safety.resumeBlockedReason!, acknowledgedAttemptIds };
  }
}
