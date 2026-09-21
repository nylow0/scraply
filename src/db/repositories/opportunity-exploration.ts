import { randomUUID } from "node:crypto";
import { canonicalJson } from "../../shared/content-identity";
import type { DatabaseClient } from "../client";
import {
  OpportunityBudgetExtensionPreviewSchema,
  OpportunityCandidateOriginSchema,
  OpportunityCoverageGapSchema,
  OpportunityExplorationBatchSchema,
  OpportunityExplorationConfigSchema,
  OpportunityExplorationCountsSchema,
  OpportunityExplorationExportSchema,
  OpportunityExplorationProgressSchema,
  type OpportunityBudgetExtensionPreview,
  type OpportunityCandidateOrigin,
  type OpportunityCoverageGap,
  type OpportunityExplorationBatch,
  type OpportunityExplorationConfig,
  type OpportunityExplorationCounts,
  type OpportunityExplorationExport,
  type OpportunityExplorationProgress,
  type OpportunityExplorationStatus,
} from "../../shared/opportunity-exploration";
import { opportunityCounts } from "../../shared/opportunity-review";
import { OpportunityRepository } from "./opportunities";

export const OPPORTUNITY_EXPLORATION_MIGRATION_SQL = `
  CREATE TABLE opportunity_explorations (
    thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
    config_json TEXT NOT NULL CHECK(json_valid(config_json)),
    status TEXT NOT NULL CHECK(status IN (
      'mapping-coverage', 'searching-gap', 'generating-batch', 'reviewing-batch',
      'target-reached', 'useful-partial', 'budget-exhausted', 'paused', 'failed'
    )),
    stop_reason TEXT,
    accepted_family_count INTEGER NOT NULL DEFAULT 0 CHECK(accepted_family_count >= 0),
    variant_count INTEGER NOT NULL DEFAULT 0 CHECK(variant_count >= 0),
    duplicate_count INTEGER NOT NULL DEFAULT 0 CHECK(duplicate_count >= 0),
    other_count INTEGER NOT NULL DEFAULT 0 CHECK(other_count >= 0),
    unresolved_count INTEGER NOT NULL DEFAULT 0 CHECK(unresolved_count >= 0),
    unreviewed_count INTEGER NOT NULL DEFAULT 0 CHECK(unreviewed_count >= 0),
    model_calls_used INTEGER NOT NULL DEFAULT 0 CHECK(model_calls_used >= 0),
    searches_used INTEGER NOT NULL DEFAULT 0 CHECK(searches_used >= 0),
    raw_candidates_used INTEGER NOT NULL DEFAULT 0 CHECK(raw_candidates_used >= 0),
    expansion_rounds_used INTEGER NOT NULL DEFAULT 0 CHECK(expansion_rounds_used >= 0),
    active_gap_id TEXT,
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE opportunity_coverage_gaps (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES opportunity_explorations(thread_id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    dimension TEXT NOT NULL CHECK(dimension IN ('buyer', 'workflow', 'trigger', 'problem', 'evidence')),
    evidence_needed TEXT,
    search_query TEXT,
    map_exhausted INTEGER NOT NULL CHECK(map_exhausted IN (0, 1)),
    candidate_origin TEXT NOT NULL CHECK(candidate_origin IN ('evidence-only', 'exploratory-allowed')),
    status TEXT NOT NULL CHECK(status IN ('named', 'search-needed', 'ready', 'covered', 'exhausted')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(thread_id, name)
  );
  CREATE INDEX idx_opportunity_gaps_thread_status
    ON opportunity_coverage_gaps(thread_id, status, created_at, id);

  CREATE TABLE opportunity_exploration_batches (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES opportunity_explorations(thread_id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK(ordinal > 0),
    coverage_gap_id TEXT REFERENCES opportunity_coverage_gaps(id) ON DELETE RESTRICT,
    requested_candidates INTEGER NOT NULL CHECK(requested_candidates BETWEEN 1 AND 6),
    saved_candidate_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(saved_candidate_ids_json)),
    status TEXT NOT NULL CHECK(status IN (
      'planned', 'generating', 'awaiting-review', 'reviewing', 'reviewed', 'failed', 'unknown-dispatch'
    )),
    accepted_families_before INTEGER NOT NULL CHECK(accepted_families_before >= 0),
    accepted_families_after INTEGER CHECK(accepted_families_after >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(thread_id, ordinal)
  );
  CREATE INDEX idx_opportunity_batches_thread_status
    ON opportunity_exploration_batches(thread_id, status, ordinal);

  CREATE TABLE opportunity_candidate_origins (
    candidate_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES opportunity_explorations(thread_id) ON DELETE CASCADE,
    batch_id TEXT REFERENCES opportunity_exploration_batches(id) ON DELETE SET NULL,
    origin_json TEXT NOT NULL CHECK(json_valid(origin_json)),
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_opportunity_origins_thread ON opportunity_candidate_origins(thread_id, created_at, candidate_id);

  CREATE TABLE opportunity_exploration_attempts (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES opportunity_explorations(thread_id) ON DELETE CASCADE,
    stage_key TEXT NOT NULL,
    stage_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('prepared', 'dispatched', 'completed', 'failed', 'unknown-dispatch')),
    input_json TEXT NOT NULL CHECK(json_valid(input_json)),
    model_json TEXT NOT NULL CHECK(json_valid(model_json)),
    prompt_version TEXT NOT NULL,
    prompt_text TEXT NOT NULL,
    result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
    error_message TEXT,
    prepared_at TEXT NOT NULL,
    dispatched_at TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE(thread_id, stage_key)
  );
  CREATE INDEX idx_opportunity_attempts_thread_status
    ON opportunity_exploration_attempts(thread_id, status, prepared_at);

  CREATE TABLE opportunity_budget_extensions (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES opportunity_explorations(thread_id) ON DELETE CASCADE,
    previous_config_json TEXT NOT NULL CHECK(json_valid(previous_config_json)),
    proposed_config_json TEXT NOT NULL CHECK(json_valid(proposed_config_json)),
    preview_json TEXT NOT NULL CHECK(json_valid(preview_json)),
    created_at TEXT NOT NULL
  );
`;

interface ExplorationRow {
  thread_id: string;
  config_json: string;
  status: OpportunityExplorationStatus;
  stop_reason: string | null;
  accepted_family_count: number;
  variant_count: number;
  duplicate_count: number;
  other_count: number;
  unresolved_count: number;
  unreviewed_count: number;
  model_calls_used: number;
  searches_used: number;
  raw_candidates_used: number;
  expansion_rounds_used: number;
  active_gap_id: string | null;
  started_at: string;
  updated_at: string;
}

interface GapRow {
  id: string;
  name: string;
  description: string;
  dimension: OpportunityCoverageGap["dimension"];
  evidence_needed: string | null;
  search_query: string | null;
  map_exhausted: number;
  candidate_origin: OpportunityCoverageGap["candidateOrigin"];
  status: OpportunityCoverageGap["status"];
  created_at: string;
  updated_at: string;
}

interface BatchRow {
  id: string;
  ordinal: number;
  coverage_gap_id: string | null;
  requested_candidates: number;
  saved_candidate_ids_json: string;
  status: OpportunityExplorationBatch["status"];
  accepted_families_before: number;
  accepted_families_after: number | null;
  created_at: string;
  updated_at: string;
}

export interface OpportunityStageAttemptInput {
  stageKey: string;
  stageName: string;
  input: unknown;
  model: { providerId: string; modelId: string; reasoningEffort: string };
  promptVersion: string;
  promptText: string;
}

export type OpportunityStageResumeState =
  | { kind: "not-started" }
  | { kind: "prepared"; attemptId: string }
  | { kind: "unknown-dispatch"; attemptId: string }
  | { kind: "completed"; attemptId: string; result: unknown };

export class OpportunityExplorationRepository {
  constructor(
    private readonly client: DatabaseClient,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  recoverInterruptedExplorations(): string[] {
    this.client.requireImmediateTransaction();
    const rows = this.client.db.prepare(`
      SELECT thread_id FROM opportunity_explorations
      WHERE status IN ('mapping-coverage', 'searching-gap', 'generating-batch', 'reviewing-batch')
      ORDER BY started_at, thread_id
    `).all() as Array<{ thread_id: string }>;
    for (const row of rows) {
      this.markInterruptedDispatchesUnknown(row.thread_id);
      this.setStatus(
        row.thread_id,
        "paused",
        "The app restarted while opportunity exploration was active. Saved checkpoints are retained; resume to continue without replaying an unknown provider dispatch.",
      );
    }
    return rows.map((row) => row.thread_id);
  }

  create(threadId: string, config: OpportunityExplorationConfig): OpportunityExplorationProgress {
    this.client.requireImmediateTransaction();
    const parsed = OpportunityExplorationConfigSchema.parse(config);
    const existing = this.find(threadId);
    if (existing) {
      if (canonicalJson(existing.config) !== canonicalJson(parsed)) {
        throw new Error("This project already has a different opportunity exploration configuration.");
      }
      return existing;
    }
    this.requireThread(threadId);
    const now = this.now();
    this.client.db.prepare(`
      INSERT INTO opportunity_explorations (
        thread_id, config_json, status, started_at, updated_at
      ) VALUES (?, ?, 'mapping-coverage', ?, ?)
    `).run(threadId, canonicalJson(parsed), now, now);
    return this.require(threadId);
  }

  find(threadId: string): OpportunityExplorationProgress | null {
    const row = this.client.db.prepare("SELECT * FROM opportunity_explorations WHERE thread_id = ?")
      .get(threadId) as ExplorationRow | undefined;
    if (!row) return null;
    const config = OpportunityExplorationConfigSchema.parse(JSON.parse(row.config_json));
    const counts = opportunityCounts(new OpportunityRepository(this.client).familyView(threadId));
    const targetLostAfterReview = row.status === "target-reached" && counts.acceptedFamilies < config.targetFamilies;
    const acceptedFamilyLabel = counts.acceptedFamilies === 1 ? "family" : "families";
    return OpportunityExplorationProgressSchema.parse({
      threadId: row.thread_id,
      config,
      status: targetLostAfterReview ? "useful-partial" : row.status,
      stopReason: targetLostAfterReview
        ? `Review changes left ${counts.acceptedFamilies} accepted ${acceptedFamilyLabel}; the target is ${config.targetFamilies}. Review unresolved ideas or continue exploration to restore the target.`
        : row.stop_reason,
      usage: {
        modelCalls: row.model_calls_used,
        searches: row.searches_used,
        rawCandidates: row.raw_candidates_used,
        expansionRounds: row.expansion_rounds_used,
      },
      counts,
      originCounts: this.originCounts(threadId),
      gaps: this.gaps(threadId),
      batches: this.batches(threadId),
      activeGapId: row.active_gap_id,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
    });
  }

  require(threadId: string): OpportunityExplorationProgress {
    const progress = this.find(threadId);
    if (!progress) throw new Error("Opportunity exploration has not been started for this project.");
    return progress;
  }

  saveGap(threadId: string, gap: OpportunityCoverageGap): void {
    this.client.requireImmediateTransaction();
    this.require(threadId);
    const parsed = OpportunityCoverageGapSchema.parse(gap);
    const config = this.require(threadId).config;
    if (parsed.candidateOrigin === "exploratory-allowed" && !config.allowExploratoryProblems) {
      throw new Error("Exploratory problem hypotheses were not enabled for this project.");
    }
    const existing = this.client.db.prepare("SELECT thread_id FROM opportunity_coverage_gaps WHERE id = ?")
      .get(parsed.id) as { thread_id: string } | undefined;
    if (existing && existing.thread_id !== threadId) throw new Error("Coverage gap belongs to another project.");
    this.client.db.prepare(`
      INSERT INTO opportunity_coverage_gaps (
        id, thread_id, name, description, dimension, evidence_needed, search_query,
        map_exhausted, candidate_origin, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        dimension = excluded.dimension,
        evidence_needed = excluded.evidence_needed,
        search_query = excluded.search_query,
        map_exhausted = excluded.map_exhausted,
        candidate_origin = excluded.candidate_origin,
        status = excluded.status,
        updated_at = excluded.updated_at
    `).run(
      parsed.id, threadId, parsed.name, parsed.description, parsed.dimension,
      parsed.evidenceNeeded, parsed.searchQuery, parsed.mapExhausted ? 1 : 0,
      parsed.candidateOrigin, parsed.status, parsed.createdAt, parsed.updatedAt,
    );
    this.touch(threadId);
  }

  setActiveGap(threadId: string, gapId: string | null): void {
    this.client.requireImmediateTransaction();
    if (gapId) this.requireGap(threadId, gapId);
    this.client.db.prepare("UPDATE opportunity_explorations SET active_gap_id = ?, updated_at = ? WHERE thread_id = ?")
      .run(gapId, this.now(), threadId);
  }

  saveCounts(threadId: string, counts: OpportunityExplorationCounts): void {
    this.client.requireImmediateTransaction();
    const parsed = OpportunityExplorationCountsSchema.parse(counts);
    this.client.db.prepare(`
      UPDATE opportunity_explorations SET
        accepted_family_count = ?, variant_count = ?, duplicate_count = ?, other_count = ?,
        unresolved_count = ?, unreviewed_count = ?, updated_at = ?
      WHERE thread_id = ?
    `).run(
      parsed.acceptedFamilies, parsed.variants, parsed.duplicates, parsed.other,
      parsed.unresolved, parsed.unreviewed, this.now(), threadId,
    );
  }

  addUsage(threadId: string, usage: { modelCalls?: number; searches?: number; rawCandidates?: number; expansionRounds?: number }): void {
    this.client.requireImmediateTransaction();
    const increments = {
      modelCalls: nonnegativeInteger(usage.modelCalls ?? 0, "model calls"),
      searches: nonnegativeInteger(usage.searches ?? 0, "searches"),
      rawCandidates: nonnegativeInteger(usage.rawCandidates ?? 0, "raw candidates"),
      expansionRounds: nonnegativeInteger(usage.expansionRounds ?? 0, "expansion rounds"),
    };
    this.client.db.prepare(`
      UPDATE opportunity_explorations SET
        model_calls_used = model_calls_used + ?, searches_used = searches_used + ?,
        raw_candidates_used = raw_candidates_used + ?, expansion_rounds_used = expansion_rounds_used + ?,
        updated_at = ?
      WHERE thread_id = ?
    `).run(
      increments.modelCalls, increments.searches, increments.rawCandidates,
      increments.expansionRounds, this.now(), threadId,
    );
  }

  planBatch(input: {
    threadId: string;
    coverageGapId: string | null;
    requestedCandidates: number;
    acceptedFamiliesBefore: number;
  }): OpportunityExplorationBatch {
    this.client.requireImmediateTransaction();
    const progress = this.require(input.threadId);
    if (progress.batches.some((batch) => ["planned", "generating", "awaiting-review", "reviewing"].includes(batch.status))) {
      throw new Error("Finish the current opportunity batch review before planning another batch.");
    }
    if (input.coverageGapId) this.requireGap(input.threadId, input.coverageGapId);
    if (!Number.isInteger(input.requestedCandidates) || input.requestedCandidates < 1 || input.requestedCandidates > 6) {
      throw new Error("Opportunity batches must request between one and six candidates.");
    }
    if (input.acceptedFamiliesBefore !== progress.counts.acceptedFamilies) {
      throw new Error("Accepted family count changed before the batch was planned.");
    }
    const id = randomUUID();
    const ordinal = progress.batches.length + 1;
    const now = this.now();
    this.client.db.prepare(`
      INSERT INTO opportunity_exploration_batches (
        id, thread_id, ordinal, coverage_gap_id, requested_candidates, status,
        accepted_families_before, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'planned', ?, ?, ?)
    `).run(id, input.threadId, ordinal, input.coverageGapId, input.requestedCandidates, input.acceptedFamiliesBefore, now, now);
    return OpportunityExplorationBatchSchema.parse({
      id, ordinal, coverageGapId: input.coverageGapId, requestedCandidates: input.requestedCandidates,
      savedCandidateIds: [], status: "planned", acceptedFamiliesBefore: input.acceptedFamiliesBefore,
      acceptedFamiliesAfter: null, createdAt: now, updatedAt: now,
    });
  }

  updateBatch(input: {
    threadId: string;
    batchId: string;
    status: OpportunityExplorationBatch["status"];
    savedCandidateIds?: string[];
    acceptedFamiliesAfter?: number | null;
  }): void {
    this.client.requireImmediateTransaction();
    const batch = this.requireBatch(input.threadId, input.batchId);
    const savedCandidateIds = input.savedCandidateIds ?? batch.savedCandidateIds;
    OpportunityExplorationBatchSchema.parse({
      ...batch,
      status: input.status,
      savedCandidateIds,
      acceptedFamiliesAfter: input.acceptedFamiliesAfter ?? batch.acceptedFamiliesAfter,
      updatedAt: this.now(),
    });
    this.client.db.prepare(`
      UPDATE opportunity_exploration_batches SET
        status = ?, saved_candidate_ids_json = ?, accepted_families_after = ?, updated_at = ?
      WHERE id = ? AND thread_id = ?
    `).run(
      input.status, canonicalJson(savedCandidateIds), input.acceptedFamiliesAfter ?? batch.acceptedFamiliesAfter,
      this.now(), input.batchId, input.threadId,
    );
    this.touch(input.threadId);
  }

  saveCandidateOrigin(input: {
    threadId: string;
    candidateId: string;
    batchId: string | null;
    origin: OpportunityCandidateOrigin;
  }): void {
    this.client.requireImmediateTransaction();
    const progress = this.require(input.threadId);
    const origin = OpportunityCandidateOriginSchema.parse(input.origin);
    if (origin.kind === "exploratory-hypothesis" && !progress.config.allowExploratoryProblems) {
      throw new Error("Exploratory problem hypotheses were not enabled for this project.");
    }
    if (input.batchId) this.requireBatch(input.threadId, input.batchId);
    const serialized = canonicalJson(origin);
    const existing = this.client.db.prepare("SELECT thread_id, batch_id, origin_json FROM opportunity_candidate_origins WHERE candidate_id = ?")
      .get(input.candidateId) as { thread_id: string; batch_id: string | null; origin_json: string } | undefined;
    if (existing) {
      if (existing.thread_id !== input.threadId || existing.batch_id !== input.batchId || existing.origin_json !== serialized) {
        throw new Error("Candidate origin is immutable once saved.");
      }
      return;
    }
    this.client.db.prepare(`
      INSERT INTO opportunity_candidate_origins (candidate_id, thread_id, batch_id, origin_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(input.candidateId, input.threadId, input.batchId, serialized, this.now());
  }

  candidateOrigin(threadId: string, candidateId: string): OpportunityCandidateOrigin | null {
    const row = this.client.db.prepare(`
      SELECT origin_json FROM opportunity_candidate_origins WHERE thread_id = ? AND candidate_id = ?
    `).get(threadId, candidateId) as { origin_json: string } | undefined;
    return row ? OpportunityCandidateOriginSchema.parse(JSON.parse(row.origin_json)) : null;
  }

  completedAttemptResult(threadId: string, stageKey: string): unknown | null {
    const row = this.attemptRow(threadId, stageKey);
    if (!row || row.status !== "completed" || !row.result_json) return null;
    return JSON.parse(row.result_json);
  }

  prepareAttempt(threadId: string, input: OpportunityStageAttemptInput): OpportunityStageResumeState {
    this.client.requireImmediateTransaction();
    this.require(threadId);
    const existing = this.attemptRow(threadId, input.stageKey);
    if (existing) {
      const identity = canonicalJson({
        input: JSON.parse(existing.input_json),
        model: JSON.parse(existing.model_json),
        promptVersion: existing.prompt_version,
        promptText: existing.prompt_text,
      });
      const requested = canonicalJson({
        input: input.input,
        model: input.model,
        promptVersion: input.promptVersion,
        promptText: input.promptText,
      });
      if (identity !== requested) throw new Error("Opportunity stage checkpoint identity changed. Start a new review.");
      return decodeAttemptState(existing);
    }
    const id = randomUUID();
    const now = this.now();
    this.client.db.prepare(`
      INSERT INTO opportunity_exploration_attempts (
        id, thread_id, stage_key, stage_name, status, input_json, model_json,
        prompt_version, prompt_text, prepared_at, updated_at
      ) VALUES (?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?)
    `).run(
      id, threadId, input.stageKey, input.stageName, canonicalJson(input.input), canonicalJson(input.model),
      input.promptVersion, input.promptText, now, now,
    );
    return { kind: "prepared", attemptId: id };
  }

  markAttemptDispatched(threadId: string, attemptId: string, operation: "model" | "search" | "none" = "model"): void {
    this.client.requireImmediateTransaction();
    const now = this.now();
    this.client.db.prepare(`
      UPDATE opportunity_exploration_attempts
      SET status = 'dispatched', dispatched_at = ?, updated_at = ?
      WHERE id = ? AND thread_id = ? AND status = 'prepared'
    `).run(now, now, attemptId, threadId);
    if (this.lastChangeCount() !== 1) throw new Error("Opportunity stage was already dispatched or does not belong to this project.");
    if (operation !== "none") this.addUsage(threadId, operation === "model" ? { modelCalls: 1 } : { searches: 1 });
  }

  completeAttempt(threadId: string, attemptId: string, result: unknown): void {
    this.client.requireImmediateTransaction();
    const now = this.now();
    this.client.db.prepare(`
      UPDATE opportunity_exploration_attempts
      SET status = 'completed', result_json = ?, completed_at = ?, updated_at = ?
      WHERE id = ? AND thread_id = ? AND status = 'dispatched'
    `).run(canonicalJson(result), now, now, attemptId, threadId);
    if (this.lastChangeCount() !== 1) throw new Error("Only a dispatched opportunity stage can be completed.");
  }

  failAttempt(threadId: string, attemptId: string, error: string, completionKnown: boolean): void {
    this.client.requireImmediateTransaction();
    const status = completionKnown ? "failed" : "unknown-dispatch";
    this.client.db.prepare(`
      UPDATE opportunity_exploration_attempts
      SET status = ?, error_message = ?, completed_at = ?, updated_at = ?
      WHERE id = ? AND thread_id = ? AND status IN ('prepared', 'dispatched')
    `).run(status, error, this.now(), this.now(), attemptId, threadId);
    if (this.lastChangeCount() !== 1) throw new Error("Opportunity stage attempt is already terminal or missing.");
  }

  markInterruptedDispatchesUnknown(threadId: string): number {
    this.client.requireImmediateTransaction();
    this.client.db.prepare(`
      UPDATE opportunity_exploration_attempts
      SET status = 'unknown-dispatch', error_message = ?, completed_at = ?, updated_at = ?
      WHERE thread_id = ? AND status = 'dispatched'
    `).run("The app restarted after dispatch; this request will not be replayed.", this.now(), this.now(), threadId);
    return this.lastChangeCount();
  }

  setStatus(threadId: string, status: OpportunityExplorationStatus, reason: string | null): void {
    this.client.requireImmediateTransaction();
    const terminal = ["target-reached", "useful-partial", "budget-exhausted", "paused", "failed"].includes(status);
    if (terminal && !reason?.trim()) throw new Error("A terminal opportunity status requires a precise reason.");
    this.client.db.prepare(`
      UPDATE opportunity_explorations SET status = ?, stop_reason = ?, updated_at = ? WHERE thread_id = ?
    `).run(status, terminal ? reason!.trim() : null, this.now(), threadId);
  }

  applyBudgetExtension(threadId: string, preview: OpportunityBudgetExtensionPreview): OpportunityExplorationProgress {
    this.client.requireImmediateTransaction();
    const parsed = OpportunityBudgetExtensionPreviewSchema.parse(preview);
    const current = this.require(threadId);
    if (canonicalJson(current.config) !== canonicalJson(parsed.current)) {
      throw new Error("Opportunity budget changed after this preview was created.");
    }
    const now = this.now();
    this.client.db.prepare(`
      INSERT INTO opportunity_budget_extensions (
        id, thread_id, previous_config_json, proposed_config_json, preview_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), threadId, canonicalJson(parsed.current), canonicalJson(parsed.proposed), canonicalJson(parsed), now);
    this.client.db.prepare(`
      UPDATE opportunity_explorations SET config_json = ?, status = 'mapping-coverage', stop_reason = NULL, updated_at = ?
      WHERE thread_id = ?
    `).run(canonicalJson(parsed.proposed), now, threadId);
    return this.require(threadId);
  }

  exportExploration(threadId: string): OpportunityExplorationExport {
    const progress = this.require(threadId);
    const origins = this.client.db.prepare(`
      SELECT candidate_id, batch_id, origin_json, created_at
      FROM opportunity_candidate_origins WHERE thread_id = ? ORDER BY created_at, candidate_id
    `).all(threadId) as Array<{
      candidate_id: string;
      batch_id: string | null;
      origin_json: string;
      created_at: string;
    }>;
    const attempts = this.client.db.prepare(`
      SELECT id, stage_key, stage_name, status, input_json, model_json, prompt_version,
        prompt_text, result_json, error_message, prepared_at, dispatched_at, completed_at
      FROM opportunity_exploration_attempts WHERE thread_id = ? ORDER BY prepared_at, id
    `).all(threadId) as Array<{
      id: string;
      stage_key: string;
      stage_name: string;
      status: "prepared" | "dispatched" | "completed" | "failed" | "unknown-dispatch";
      input_json: string;
      model_json: string;
      prompt_version: string;
      prompt_text: string;
      result_json: string | null;
      error_message: string | null;
      prepared_at: string;
      dispatched_at: string | null;
      completed_at: string | null;
    }>;
    const extensions = this.client.db.prepare(`
      SELECT id, previous_config_json, proposed_config_json, preview_json, created_at
      FROM opportunity_budget_extensions WHERE thread_id = ? ORDER BY created_at, id
    `).all(threadId) as Array<{
      id: string;
      previous_config_json: string;
      proposed_config_json: string;
      preview_json: string;
      created_at: string;
    }>;
    return OpportunityExplorationExportSchema.parse({
      schemaVersion: 1,
      progress,
      origins: origins.map((row) => ({
        candidateId: row.candidate_id,
        batchId: row.batch_id,
        origin: JSON.parse(row.origin_json),
        createdAt: row.created_at,
      })),
      attempts: attempts.map((row) => ({
        id: row.id,
        stageKey: row.stage_key,
        stageName: row.stage_name,
        status: row.status,
        input: JSON.parse(row.input_json),
        model: JSON.parse(row.model_json),
        promptVersion: row.prompt_version,
        promptText: row.prompt_text,
        result: row.result_json ? JSON.parse(row.result_json) : null,
        error: row.error_message,
        preparedAt: row.prepared_at,
        dispatchedAt: row.dispatched_at,
        completedAt: row.completed_at,
      })),
      budgetExtensions: extensions.map((row) => ({
        id: row.id,
        previousConfig: JSON.parse(row.previous_config_json),
        proposedConfig: JSON.parse(row.proposed_config_json),
        preview: JSON.parse(row.preview_json),
        createdAt: row.created_at,
      })),
    });
  }

  private gaps(threadId: string): OpportunityCoverageGap[] {
    const rows = this.client.db.prepare(`
      SELECT id, name, description, dimension, evidence_needed, search_query, map_exhausted,
        candidate_origin, status, created_at, updated_at
      FROM opportunity_coverage_gaps WHERE thread_id = ? ORDER BY created_at, id
    `).all(threadId) as GapRow[];
    return rows.map((row) => OpportunityCoverageGapSchema.parse({
      id: row.id,
      name: row.name,
      description: row.description,
      dimension: row.dimension,
      evidenceNeeded: row.evidence_needed,
      searchQuery: row.search_query,
      mapExhausted: Boolean(row.map_exhausted),
      candidateOrigin: row.candidate_origin,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  private batches(threadId: string): OpportunityExplorationBatch[] {
    const rows = this.client.db.prepare(`
      SELECT id, ordinal, coverage_gap_id, requested_candidates, saved_candidate_ids_json,
        status, accepted_families_before, accepted_families_after, created_at, updated_at
      FROM opportunity_exploration_batches WHERE thread_id = ? ORDER BY ordinal
    `).all(threadId) as BatchRow[];
    return rows.map((row) => OpportunityExplorationBatchSchema.parse({
      id: row.id,
      ordinal: row.ordinal,
      coverageGapId: row.coverage_gap_id,
      requestedCandidates: row.requested_candidates,
      savedCandidateIds: JSON.parse(row.saved_candidate_ids_json),
      status: row.status,
      acceptedFamiliesBefore: row.accepted_families_before,
      acceptedFamiliesAfter: row.accepted_families_after,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  private originCounts(threadId: string): { problemEvidence: number; exploratoryHypotheses: number } {
    const rows = this.client.db.prepare(`
      SELECT json_extract(origin_json, '$.kind') AS kind, COUNT(*) AS count
      FROM opportunity_candidate_origins WHERE thread_id = ?
      GROUP BY json_extract(origin_json, '$.kind')
    `).all(threadId) as Array<{ kind: OpportunityCandidateOrigin["kind"]; count: number }>;
    return {
      problemEvidence: rows.find((row) => row.kind === "problem-evidence")?.count ?? 0,
      exploratoryHypotheses: rows.find((row) => row.kind === "exploratory-hypothesis")?.count ?? 0,
    };
  }

  private requireGap(threadId: string, gapId: string): void {
    const row = this.client.db.prepare("SELECT 1 FROM opportunity_coverage_gaps WHERE id = ? AND thread_id = ?")
      .get(gapId, threadId);
    if (!row) throw new Error("Coverage gap does not belong to this project.");
  }

  private requireBatch(threadId: string, batchId: string): OpportunityExplorationBatch {
    const batch = this.batches(threadId).find((item) => item.id === batchId);
    if (!batch) throw new Error("Opportunity batch does not belong to this project.");
    return batch;
  }

  private requireThread(threadId: string): void {
    if (!this.client.db.prepare("SELECT 1 FROM threads WHERE id = ?").get(threadId)) {
      throw new Error("Project does not exist.");
    }
  }

  private touch(threadId: string): void {
    this.client.db.prepare("UPDATE opportunity_explorations SET updated_at = ? WHERE thread_id = ?")
      .run(this.now(), threadId);
  }

  private attemptRow(threadId: string, stageKey: string): AttemptRow | undefined {
    return this.client.db.prepare(`
      SELECT id, status, input_json, model_json, prompt_version, prompt_text, result_json
      FROM opportunity_exploration_attempts WHERE thread_id = ? AND stage_key = ?
    `).get(threadId, stageKey) as AttemptRow | undefined;
  }

  private lastChangeCount(): number {
    return (this.client.db.prepare("SELECT changes() AS count").get() as { count: number }).count;
  }
}

interface AttemptRow {
  id: string;
  status: "prepared" | "dispatched" | "completed" | "failed" | "unknown-dispatch";
  input_json: string;
  model_json: string;
  prompt_version: string;
  prompt_text: string;
  result_json: string | null;
}

function decodeAttemptState(row: AttemptRow): OpportunityStageResumeState {
  if (row.status === "completed") {
    if (!row.result_json) throw new Error("Completed opportunity stage has no saved result.");
    return { kind: "completed", attemptId: row.id, result: JSON.parse(row.result_json) };
  }
  if (["dispatched", "unknown-dispatch", "failed"].includes(row.status)) {
    return { kind: "unknown-dispatch", attemptId: row.id };
  }
  return { kind: "prepared", attemptId: row.id };
}

function nonnegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative integer.`);
  return value;
}
