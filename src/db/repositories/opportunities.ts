import { createHash, randomUUID } from "node:crypto";
import type { GenerationAcceptanceMetadata, GenerationMetadata } from "../../providers/structured";
import {
  OpportunityFamiliesViewSchema,
  OpportunityMembershipEditSchema,
  OpportunityReviewExportSchema,
  OpportunityReviewOutputSchema,
  type OpportunityCandidateSnapshot,
  type OpportunityCompactFamily,
  type OpportunityFamiliesView,
  type OpportunityMembershipEdit,
  type OpportunityReviewExport,
  type OpportunityRelationship,
  type OpportunityReviewOutput,
} from "../../shared/opportunity-review";
import { StartupOpportunityDetailsSchema } from "../../shared/structured-output-schemas";
import type { DatabaseClient } from "../client";

export const OPPORTUNITY_REVIEW_MIGRATION_SQL = `
  CREATE TABLE opportunity_review_calls (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    batch_key TEXT NOT NULL,
    batch_index INTEGER NOT NULL CHECK(batch_index >= 0),
    chunk_index INTEGER NOT NULL CHECK(chunk_index >= 0),
    correction_number INTEGER NOT NULL CHECK(correction_number BETWEEN 0 AND 1),
    correction_of_id TEXT REFERENCES opportunity_review_calls(id),
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    reasoning_effort TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN (
      'prepared', 'dispatched', 'accepted', 'completed', 'failed', 'cancelled', 'interrupted'
    )),
    request_json TEXT NOT NULL CHECK(json_valid(request_json)),
    request_sha256 TEXT NOT NULL,
    runtime_identity_json TEXT CHECK(runtime_identity_json IS NULL OR json_valid(runtime_identity_json)),
    output_json TEXT CHECK(output_json IS NULL OR json_valid(output_json)),
    metadata_json TEXT CHECK(metadata_json IS NULL OR json_valid(metadata_json)),
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    terminal_at TEXT
  );

  CREATE INDEX idx_opportunity_review_calls_thread
    ON opportunity_review_calls(thread_id, created_at, id);
  CREATE INDEX idx_opportunity_review_calls_identity
    ON opportunity_review_calls(thread_id, request_sha256, status);

  CREATE TABLE opportunity_review_coverage (
    review_call_id TEXT NOT NULL REFERENCES opportunity_review_calls(id) ON DELETE CASCADE,
    candidate_option_id TEXT NOT NULL REFERENCES solutions(id) ON DELETE CASCADE,
    target_kind TEXT NOT NULL CHECK(target_kind IN ('self', 'family', 'candidate', 'unresolved-option')),
    target_id TEXT NOT NULL DEFAULT '',
    relationship TEXT CHECK(relationship IS NULL OR relationship IN (
      'duplicate', 'variant', 'separate-business', 'uncertain'
    )),
    complete INTEGER NOT NULL CHECK(complete IN (0, 1)),
    reason TEXT NOT NULL,
    PRIMARY KEY(review_call_id, candidate_option_id, target_kind, target_id)
  );

  CREATE TABLE opportunity_families (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    representative_option_id TEXT NOT NULL REFERENCES solutions(id) ON DELETE RESTRICT,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX idx_opportunity_families_thread
    ON opportunity_families(thread_id, active, created_at, id);

  CREATE TABLE opportunity_family_events (
    id TEXT PRIMARY KEY,
    family_id TEXT NOT NULL REFERENCES opportunity_families(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL CHECK(event_type IN ('created', 'merged', 'reactivated')),
    related_family_id TEXT REFERENCES opportunity_families(id),
    reason TEXT NOT NULL,
    actor TEXT NOT NULL CHECK(actor IN ('model', 'user')),
    created_at TEXT NOT NULL
  );

  CREATE TABLE opportunity_membership_decisions (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    option_id TEXT NOT NULL REFERENCES solutions(id) ON DELETE CASCADE,
    family_id TEXT REFERENCES opportunity_families(id) ON DELETE RESTRICT,
    relationship TEXT NOT NULL CHECK(relationship IN (
      'duplicate', 'variant', 'separate-business', 'uncertain'
    )),
    state TEXT NOT NULL CHECK(state IN ('accepted', 'unresolved')),
    reason TEXT NOT NULL,
    actor TEXT NOT NULL CHECK(actor IN ('model', 'user')),
    review_call_id TEXT REFERENCES opportunity_review_calls(id) ON DELETE SET NULL,
    supersedes_id TEXT UNIQUE REFERENCES opportunity_membership_decisions(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL,
    CHECK(
      (state = 'accepted' AND family_id IS NOT NULL AND relationship != 'uncertain')
      OR state = 'unresolved'
    )
  );

  CREATE INDEX idx_opportunity_memberships_thread_option
    ON opportunity_membership_decisions(thread_id, option_id, created_at, id);
  CREATE INDEX idx_opportunity_memberships_family
    ON opportunity_membership_decisions(family_id, created_at, id);
`;

export type OpportunityReviewCallStatus =
  | "prepared"
  | "dispatched"
  | "accepted"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface PreparedOpportunityReviewCall {
  id: string;
  requestSha256: string;
}

export interface OpportunityReviewCallInput {
  threadId: string;
  batchKey: string;
  batchIndex: number;
  chunkIndex: number;
  correctionNumber: 0 | 1;
  correctionOfId?: string;
  providerId: string;
  modelId: string;
  reasoningEffort: string;
  request: unknown;
  runtimeIdentity?: GenerationAcceptanceMetadata;
}

export interface OpportunityCoverageEntry {
  candidateOptionId: string;
  targetKind: "self" | "family" | "candidate" | "unresolved-option";
  targetId: string;
  relationship: OpportunityRelationship | null;
  complete: boolean;
  reason: string;
}

export interface ResolvedOpportunityDecision {
  candidate: OpportunityCandidateSnapshot;
  familyId: string | null;
  relationship: OpportunityRelationship;
  state: "accepted" | "unresolved";
  reason: string;
}

interface SolutionCandidateRow {
  id: string;
  research_run_id: string;
  problem_id: string;
  problem_statement: string;
  mechanism: string;
  description: string;
  startup_opportunity_json: string | null;
}

interface CurrentMembershipRow {
  id: string;
  option_id: string;
  family_id: string | null;
  relationship: OpportunityRelationship;
  state: "accepted" | "unresolved";
  reason: string;
  actor: "model" | "user";
  created_at: string;
  mechanism: string;
  description: string;
  startup_opportunity_json: string | null;
}

export class OpportunityRepository {
  constructor(private readonly client: DatabaseClient) {}

  loadUnreviewedCandidates(threadId: string): OpportunityCandidateSnapshot[] {
    const reviewed = new Set(this.currentMembershipRows(threadId).map((row) => row.option_id));
    return this.solutionRows(threadId)
      .filter((row) => !reviewed.has(row.id))
      .map(candidateFromRow);
  }

  loadUnresolvedCandidates(threadId: string): OpportunityCandidateSnapshot[] {
    const unresolved = new Set(this.currentMembershipRows(threadId)
      .filter((row) => row.state === "unresolved")
      .map((row) => row.option_id));
    return this.solutionRows(threadId)
      .filter((row) => unresolved.has(row.id))
      .map(candidateFromRow);
  }

  compactFamilies(threadId: string): OpportunityCompactFamily[] {
    const memberships = this.currentMembershipRows(threadId).filter((row) => row.state === "accepted");
    const membersByFamily = new Map<string, CurrentMembershipRow[]>();
    for (const membership of memberships) {
      if (!membership.family_id) continue;
      const familyMembers = membersByFamily.get(membership.family_id) ?? [];
      familyMembers.push(membership);
      membersByFamily.set(membership.family_id, familyMembers);
    }
    const rows = this.client.db.prepare(`
      SELECT id, title, summary, representative_option_id
      FROM opportunity_families
      WHERE thread_id = ? AND active = 1
      ORDER BY created_at, id
    `).all(threadId) as Array<{
      id: string;
      title: string;
      summary: string;
      representative_option_id: string;
    }>;
    return rows.flatMap((family) => {
      const members = membersByFamily.get(family.id) ?? [];
      if (members.length === 0) return [];
      return [{
        familyId: family.id,
        title: family.title,
        summary: family.summary,
        representativeOptionId: family.representative_option_id,
        members: members.map((member) => {
          const candidate = candidateFromMembership(member);
          return {
            optionId: member.option_id,
            mechanism: member.mechanism,
            businessDescription: member.description,
            relationship: member.relationship === "uncertain" ? "variant" as const : member.relationship,
            buyer: candidate.buyer,
            buyingTrigger: candidate.buyingTrigger,
            coreWorkflow: candidate.coreWorkflow,
            currentSubstitute: candidate.currentSubstitute,
          };
        }),
      }];
    });
  }

  prepareReviewCall(input: OpportunityReviewCallInput): PreparedOpportunityReviewCall {
    const id = randomUUID();
    const requestJson = canonicalJson(input.request);
    const requestSha256 = sha256(requestJson);
    const now = new Date().toISOString();
    this.client.db.prepare(`
      INSERT INTO opportunity_review_calls (
        id, thread_id, batch_key, batch_index, chunk_index, correction_number,
        correction_of_id, provider_id, model_id, reasoning_effort, status,
        request_json, request_sha256, runtime_identity_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?)
    `).run(
      id,
      input.threadId,
      input.batchKey,
      input.batchIndex,
      input.chunkIndex,
      input.correctionNumber,
      input.correctionOfId ?? null,
      input.providerId,
      input.modelId,
      input.reasoningEffort,
      requestJson,
      requestSha256,
      input.runtimeIdentity ? canonicalJson(input.runtimeIdentity) : null,
      now,
      now,
    );
    return { id, requestSha256 };
  }

  reusableReviewCall(threadId: string, request: unknown): { id: string; output: OpportunityReviewOutput } | null {
    const requestSha256 = sha256(canonicalJson(request));
    const row = this.client.db.prepare(`
      SELECT id, output_json FROM opportunity_review_calls
      WHERE thread_id = ? AND request_sha256 = ? AND status = 'completed'
      ORDER BY terminal_at DESC, id DESC LIMIT 1
    `).get(threadId, requestSha256) as { id: string; output_json: string } | undefined;
    return row ? { id: row.id, output: OpportunityReviewOutputSchema.parse(JSON.parse(row.output_json)) } : null;
  }

  reusableSuccessfulCorrection(threadId: string, initialRequest: unknown): { id: string; output: OpportunityReviewOutput } | null {
    const requestSha256 = sha256(canonicalJson(initialRequest));
    const row = this.client.db.prepare(`
      SELECT correction.id, correction.output_json
      FROM opportunity_review_calls correction
      JOIN opportunity_review_calls initial ON initial.id = correction.correction_of_id
      WHERE initial.thread_id = ? AND initial.request_sha256 = ?
        AND initial.status = 'failed' AND correction.status = 'completed'
      ORDER BY correction.terminal_at DESC, correction.id DESC LIMIT 1
    `).get(threadId, requestSha256) as { id: string; output_json: string } | undefined;
    return row ? { id: row.id, output: OpportunityReviewOutputSchema.parse(JSON.parse(row.output_json)) } : null;
  }

  assertReviewResumeSafe(threadId: string): void {
    const ambiguous = this.client.db.prepare(`
      SELECT 1 FROM opportunity_review_calls
      WHERE thread_id = ? AND (
        status IN ('dispatched', 'accepted')
        OR (status = 'interrupted' AND error_message != 'never-dispatched'
          AND error_message NOT LIKE 'acknowledged:%')
      ) LIMIT 1
    `).get(threadId);
    if (ambiguous) {
      throw new Error("A previous opportunity review may have completed before its result was saved. An explicit user-approved review is required before another paid request can run.");
    }
  }

  acknowledgeAmbiguousReviewCalls(threadId: string): number {
    const now = new Date().toISOString();
    this.client.db.prepare(`
      UPDATE opportunity_review_calls
      SET error_message = 'acknowledged:' || COALESCE(error_message, 'unknown completion'),
          updated_at = ?
      WHERE thread_id = ? AND status = 'interrupted'
        AND error_message != 'never-dispatched'
        AND error_message NOT LIKE 'acknowledged:%'
    `).run(now, threadId);
    return (this.client.db.prepare("SELECT changes() AS count").get() as { count: number }).count;
  }

  recoverInFlightReviewCalls(threadId?: string): string[] {
    const now = new Date().toISOString();
    const filter = threadId ? "thread_id = ? AND " : "";
    const parameters = threadId ? [threadId] : [];
    const rows = this.client.db.prepare(`
      SELECT DISTINCT thread_id FROM opportunity_review_calls
      WHERE ${filter}status IN ('prepared', 'dispatched', 'accepted')
      ORDER BY thread_id
    `).all(...parameters) as Array<{ thread_id: string }>;
    if (rows.length === 0) return [];
    this.client.immediateTransaction(() => {
      this.client.db.prepare(`
        UPDATE opportunity_review_calls
        SET status = 'interrupted', error_message = 'never-dispatched', terminal_at = ?, updated_at = ?
        WHERE ${filter}status = 'prepared'
      `).run(now, now, ...parameters);
      this.client.db.prepare(`
        UPDATE opportunity_review_calls
        SET status = 'interrupted',
          error_message = 'The app restarted after dispatch; provider completion is unknown.',
          terminal_at = ?, updated_at = ?
        WHERE ${filter}status IN ('dispatched', 'accepted')
      `).run(now, now, ...parameters);
    });
    return rows.map((row) => row.thread_id);
  }

  markReviewDispatched(id: string): void {
    this.updateReviewStatus(id, "dispatched");
  }

  markReviewAccepted(id: string, identity: GenerationAcceptanceMetadata): void {
    const now = new Date().toISOString();
    this.client.db.prepare(`
      UPDATE opportunity_review_calls
      SET status = 'accepted', runtime_identity_json = ?, updated_at = ?
      WHERE id = ? AND status IN ('prepared', 'dispatched')
    `).run(canonicalJson(identity), now, id);
  }

  completeReviewCall(
    id: string,
    output: OpportunityReviewOutput,
    metadata: GenerationMetadata,
    coverage: OpportunityCoverageEntry[],
    validationError?: string,
  ): void {
    const parsed = OpportunityReviewOutputSchema.parse(output);
    const now = new Date().toISOString();
    this.client.requireImmediateTransaction();
    this.client.db.prepare(`
      UPDATE opportunity_review_calls
      SET status = ?, output_json = ?, metadata_json = ?, error_message = ?, terminal_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('prepared', 'dispatched', 'accepted')
    `).run(
      validationError ? "failed" : "completed",
      canonicalJson(parsed),
      canonicalJson(metadata),
      validationError ?? null,
      now,
      now,
      id,
    );
    const updated = this.client.db.prepare("SELECT changes() AS count").get() as { count: number };
    if (updated.count !== 1) throw new Error("Opportunity review call already has a terminal result");
    const insert = this.client.db.prepare(`
      INSERT INTO opportunity_review_coverage (
        review_call_id, candidate_option_id, target_kind, target_id,
        relationship, complete, reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const entry of coverage) {
      insert.run(
        id,
        entry.candidateOptionId,
        entry.targetKind,
        entry.targetId,
        entry.relationship,
        entry.complete ? 1 : 0,
        entry.reason,
      );
    }
  }

  failReviewCall(id: string, status: Extract<OpportunityReviewCallStatus, "failed" | "cancelled" | "interrupted">, error: string): void {
    const now = new Date().toISOString();
    this.client.db.prepare(`
      UPDATE opportunity_review_calls
      SET status = ?, error_message = ?, terminal_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('prepared', 'dispatched', 'accepted')
    `).run(status, error, now, now, id);
  }

  applyResolvedDecisions(
    threadId: string,
    reviewCallId: string,
    decisions: ResolvedOpportunityDecision[],
    idFactory: () => string = randomUUID,
  ): void {
    this.client.requireImmediateTransaction();
    for (const decision of decisions) {
      const current = this.currentDecision(decision.candidate.optionId);
      if (current) throw new Error(`Option ${decision.candidate.optionId} already has a membership decision`);
      let familyId = decision.familyId;
      if (decision.state === "accepted" && decision.relationship === "separate-business") {
        familyId = familyId ?? idFactory();
        this.createFamily(
          familyId,
          threadId,
          decision.candidate.optionId,
          decision.candidate.mechanism,
          decision.candidate.businessDescription,
          decision.reason,
          "model",
          idFactory,
        );
      }
      if (decision.state === "accepted" && !familyId) {
        throw new Error(`Accepted option ${decision.candidate.optionId} has no family`);
      }
      this.insertDecision({
        id: idFactory(),
        threadId,
        optionId: decision.candidate.optionId,
        familyId,
        relationship: decision.relationship,
        state: decision.state,
        reason: decision.reason,
        actor: "model",
        reviewCallId,
        supersedesId: null,
      });
      if (familyId && decision.state === "accepted") {
        this.preferCountableRepresentative(
          threadId,
          familyId,
          decision.candidate.optionId,
          "Selected an eligible, non-discarded startup option as the family representative.",
          "model",
          idFactory,
        );
      }
    }
  }

  editMembership(threadId: string, edit: OpportunityMembershipEdit): OpportunityFamiliesView {
    const parsed = OpportunityMembershipEditSchema.parse(edit);
    this.client.immediateTransaction(() => this.applyMembershipEdit(threadId, parsed));
    return this.familyView(threadId);
  }

  acceptedFamilyCount(threadId: string): number {
    return this.familyView(threadId).acceptedFamilyCount;
  }

  familyView(threadId: string): OpportunityFamiliesView {
    const candidates = this.solutionRows(threadId).map(candidateFromRow);
    const candidateById = new Map(candidates.map((candidate) => [candidate.optionId, candidate]));
    const discarded = this.discardedIds(threadId);
    const memberships = this.currentMembershipRows(threadId);
    const membershipsByFamily = new Map<string, CurrentMembershipRow[]>();
    const unresolved = [];
    for (const membership of memberships) {
      const candidate = candidateById.get(membership.option_id);
      if (!candidate) continue;
      const view = {
        decisionId: membership.id,
        optionId: membership.option_id,
        familyId: membership.family_id,
        relationship: membership.relationship,
        state: membership.state,
        reason: membership.reason,
        decidedBy: membership.actor,
        decidedAt: membership.created_at,
        mechanism: membership.mechanism,
        description: membership.description,
        eligibleStartup: candidate.eligibleStartup,
        discarded: discarded.has(membership.option_id),
      } as const;
      if (membership.state === "unresolved") {
        unresolved.push({ membership: view, suggestedFamilyId: membership.family_id });
        continue;
      }
      if (!membership.family_id) continue;
      const familyMembers = membershipsByFamily.get(membership.family_id) ?? [];
      familyMembers.push(membership);
      membershipsByFamily.set(membership.family_id, familyMembers);
    }
    const familyRows = this.client.db.prepare(`
      SELECT id, title, summary, representative_option_id, active, created_at
      FROM opportunity_families WHERE thread_id = ? ORDER BY created_at, id
    `).all(threadId) as Array<{
      id: string;
      title: string;
      summary: string;
      representative_option_id: string;
      active: number;
      created_at: string;
    }>;
    const families = familyRows.map((family) => {
      const members = (membershipsByFamily.get(family.id) ?? []).map((membership) => {
        const candidate = candidateById.get(membership.option_id);
        if (!candidate) throw new Error("Opportunity membership references a missing option");
        return {
          decisionId: membership.id,
          optionId: membership.option_id,
          familyId: membership.family_id,
          relationship: membership.relationship,
          state: membership.state,
          reason: membership.reason,
          decidedBy: membership.actor,
          decidedAt: membership.created_at,
          mechanism: membership.mechanism,
          description: membership.description,
          eligibleStartup: candidate.eligibleStartup,
          discarded: discarded.has(membership.option_id),
        };
      });
      const representative = members.find((member) => member.optionId === family.representative_option_id);
      const counted = family.active === 1
        && representative?.state === "accepted"
        && representative.eligibleStartup
        && !representative.discarded;
      return {
        id: family.id,
        title: family.title,
        summary: family.summary,
        representativeOptionId: family.representative_option_id,
        active: family.active === 1,
        createdAt: family.created_at,
        members,
        counted: Boolean(counted),
      };
    });
    const reviewed = new Set(memberships.map((membership) => membership.option_id));
    const latestCompleted = this.client.db.prepare(`
      SELECT MAX(terminal_at) AS reviewed_at FROM opportunity_review_calls
      WHERE thread_id = ? AND status = 'completed'
    `).get(threadId) as { reviewed_at: string | null };
    const latestCall = this.client.db.prepare(`
      SELECT status, error_message FROM opportunity_review_calls
      WHERE thread_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(threadId) as { status: OpportunityReviewCallStatus; error_message: string | null } | undefined;
    const reviewStatus = latestCall
      ? latestCall.status === "completed"
        ? "completed" as const
        : ["prepared", "dispatched", "accepted"].includes(latestCall.status)
          ? "running" as const
          : latestCall.status === "interrupted" && latestCall.error_message !== "never-dispatched"
            ? "blocked" as const
            : "failed" as const
      : "not-reviewed" as const;
    return OpportunityFamiliesViewSchema.parse({
      rawOptionCount: candidates.length,
      reviewedOptionCount: reviewed.size,
      acceptedFamilyCount: families.filter((family) => family.counted).length,
      families,
      unresolved,
      unreviewedOptionIds: candidates.filter((candidate) => !reviewed.has(candidate.optionId)).map((candidate) => candidate.optionId),
      lastReviewedAt: latestCompleted.reviewed_at,
      reviewStatus,
      reviewError: reviewStatus === "failed" || reviewStatus === "blocked" ? latestCall?.error_message ?? "Opportunity review did not complete." : null,
    });
  }

  exportReview(threadId: string): OpportunityReviewExport {
    const reviewRows = this.client.db.prepare(`
      SELECT id, batch_key, batch_index, chunk_index, correction_number,
        correction_of_id, provider_id, model_id, reasoning_effort, status,
        request_json, request_sha256, runtime_identity_json, output_json,
        metadata_json, error_message, created_at, terminal_at
      FROM opportunity_review_calls
      WHERE thread_id = ? ORDER BY created_at, id
    `).all(threadId) as Array<{
      id: string;
      batch_key: string;
      batch_index: number;
      chunk_index: number;
      correction_number: 0 | 1;
      correction_of_id: string | null;
      provider_id: string;
      model_id: string;
      reasoning_effort: string;
      status: OpportunityReviewCallStatus;
      request_json: string;
      request_sha256: string;
      runtime_identity_json: string | null;
      output_json: string | null;
      metadata_json: string | null;
      error_message: string | null;
      created_at: string;
      terminal_at: string | null;
    }>;
    const coverageRows = this.client.db.prepare(`
      SELECT c.review_call_id, c.candidate_option_id, c.target_kind, c.target_id,
        c.relationship, c.complete, c.reason
      FROM opportunity_review_coverage c
      JOIN opportunity_review_calls r ON r.id = c.review_call_id
      WHERE r.thread_id = ?
      ORDER BY r.created_at, c.candidate_option_id, c.target_kind, c.target_id
    `).all(threadId) as Array<{
      review_call_id: string;
      candidate_option_id: string;
      target_kind: "self" | "family" | "candidate" | "unresolved-option";
      target_id: string;
      relationship: OpportunityRelationship | null;
      complete: number;
      reason: string;
    }>;
    const eventRows = this.client.db.prepare(`
      SELECT e.id, e.family_id, e.event_type, e.related_family_id, e.reason, e.actor, e.created_at
      FROM opportunity_family_events e
      JOIN opportunity_families f ON f.id = e.family_id
      WHERE f.thread_id = ? ORDER BY e.created_at, e.id
    `).all(threadId) as Array<{
      id: string;
      family_id: string;
      event_type: "created" | "merged" | "reactivated";
      related_family_id: string | null;
      reason: string;
      actor: "model" | "user";
      created_at: string;
    }>;
    const decisionRows = this.client.db.prepare(`
      SELECT id, option_id, family_id, relationship, state, reason, actor,
        review_call_id, supersedes_id, created_at
      FROM opportunity_membership_decisions
      WHERE thread_id = ? ORDER BY created_at, id
    `).all(threadId) as Array<{
      id: string;
      option_id: string;
      family_id: string | null;
      relationship: OpportunityRelationship;
      state: "accepted" | "unresolved";
      reason: string;
      actor: "model" | "user";
      review_call_id: string | null;
      supersedes_id: string | null;
      created_at: string;
    }>;
    return OpportunityReviewExportSchema.parse({
      schemaVersion: 1,
      threadId,
      view: this.familyView(threadId),
      reviews: reviewRows.map((row) => ({
        id: row.id,
        batchKey: row.batch_key,
        batchIndex: row.batch_index,
        chunkIndex: row.chunk_index,
        correctionNumber: row.correction_number,
        correctionOfId: row.correction_of_id,
        model: { providerId: row.provider_id, modelId: row.model_id, reasoningEffort: row.reasoning_effort },
        status: row.status,
        request: JSON.parse(row.request_json) as unknown,
        requestSha256: row.request_sha256,
        runtimeIdentity: row.runtime_identity_json ? JSON.parse(row.runtime_identity_json) as unknown : null,
        output: row.output_json ? OpportunityReviewOutputSchema.parse(JSON.parse(row.output_json)) : null,
        metadata: row.metadata_json ? JSON.parse(row.metadata_json) as unknown : null,
        error: row.error_message,
        createdAt: row.created_at,
        terminalAt: row.terminal_at,
      })),
      coverage: coverageRows.map((row) => ({
        reviewCallId: row.review_call_id,
        candidateOptionId: row.candidate_option_id,
        targetKind: row.target_kind,
        targetId: row.target_id,
        relationship: row.relationship,
        complete: row.complete === 1,
        reason: row.reason,
      })),
      familyEvents: eventRows.map((row) => ({
        id: row.id,
        familyId: row.family_id,
        eventType: row.event_type,
        relatedFamilyId: row.related_family_id,
        reason: row.reason,
        actor: row.actor,
        createdAt: row.created_at,
      })),
      membershipHistory: decisionRows.map((row) => ({
        id: row.id,
        optionId: row.option_id,
        familyId: row.family_id,
        relationship: row.relationship,
        state: row.state,
        reason: row.reason,
        actor: row.actor,
        reviewCallId: row.review_call_id,
        supersedesId: row.supersedes_id,
        createdAt: row.created_at,
      })),
    });
  }

  private applyMembershipEdit(threadId: string, edit: OpportunityMembershipEdit): void {
    this.client.requireImmediateTransaction();
    if (edit.operation === "merge-family") {
      if (edit.sourceFamilyId === edit.targetFamilyId) throw new Error("Choose two different families to merge");
      const source = this.requireActiveFamily(threadId, edit.sourceFamilyId);
      this.requireActiveFamily(threadId, edit.targetFamilyId);
      const members = this.currentMembershipRows(threadId)
        .filter((membership) => membership.state === "accepted" && membership.family_id === source.id);
      for (const member of members) {
        this.insertDecision({
          id: randomUUID(),
          threadId,
          optionId: member.option_id,
          familyId: edit.targetFamilyId,
          relationship: member.option_id === source.representative_option_id ? "variant" : member.relationship,
          state: "accepted",
          reason: edit.reason,
          actor: "user",
          reviewCallId: null,
          supersedesId: member.id,
        });
        this.preferCountableRepresentative(
          threadId,
          edit.targetFamilyId,
          member.option_id,
          edit.reason,
          "user",
          randomUUID,
        );
      }
      const now = new Date().toISOString();
      this.client.db.prepare("UPDATE opportunity_families SET active = 0, updated_at = ? WHERE id = ?")
        .run(now, source.id);
      this.insertFamilyEvent(source.id, "merged", edit.targetFamilyId, edit.reason, "user", randomUUID);
      return;
    }

    const current = this.currentDecision(edit.optionId);
    if (!current || current.thread_id !== threadId) throw new Error("Opportunity membership was not found");
    if (edit.operation === "mark-uncertain") {
      this.promoteRepresentativeBeforeMove(threadId, current, edit.reason);
      this.insertDecision({
        id: randomUUID(),
        threadId,
        optionId: edit.optionId,
        familyId: current.family_id,
        relationship: "uncertain",
        state: "unresolved",
        reason: edit.reason,
        actor: "user",
        reviewCallId: null,
        supersedesId: current.id,
      });
      return;
    }
    if (edit.operation === "move") {
      this.requireActiveFamily(threadId, edit.targetFamilyId);
      if (current.family_id === edit.targetFamilyId) {
        const family = this.requireActiveFamily(threadId, edit.targetFamilyId);
        if (family.representative_option_id === edit.optionId) {
          throw new Error("Move the representative to a different family or split it into a new family");
        }
      } else {
        this.promoteRepresentativeBeforeMove(threadId, current, edit.reason);
      }
      this.insertDecision({
        id: randomUUID(),
        threadId,
        optionId: edit.optionId,
        familyId: edit.targetFamilyId,
        relationship: edit.relationship,
        state: "accepted",
        reason: edit.reason,
        actor: "user",
        reviewCallId: null,
        supersedesId: current.id,
      });
      this.preferCountableRepresentative(
        threadId,
        edit.targetFamilyId,
        edit.optionId,
        edit.reason,
        "user",
        randomUUID,
      );
      return;
    }
    this.promoteRepresentativeBeforeMove(threadId, current, edit.reason);
    const familyId = randomUUID();
    this.createFamily(familyId, threadId, edit.optionId, edit.title, edit.summary, edit.reason, "user", randomUUID);
    this.insertDecision({
      id: randomUUID(),
      threadId,
      optionId: edit.optionId,
      familyId,
      relationship: "separate-business",
      state: "accepted",
      reason: edit.reason,
      actor: "user",
      reviewCallId: null,
      supersedesId: current.id,
    });
  }

  private createFamily(
    id: string,
    threadId: string,
    representativeOptionId: string,
    title: string,
    summary: string,
    reason: string,
    actor: "model" | "user",
    idFactory: () => string,
  ): void {
    const now = new Date().toISOString();
    this.client.db.prepare(`
      INSERT INTO opportunity_families (
        id, thread_id, representative_option_id, title, summary, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, threadId, representativeOptionId, title, summary, now, now);
    this.insertFamilyEvent(id, "created", null, reason, actor, idFactory);
  }

  private insertFamilyEvent(
    familyId: string,
    eventType: "created" | "merged" | "reactivated",
    relatedFamilyId: string | null,
    reason: string,
    actor: "model" | "user",
    idFactory: () => string,
  ): void {
    this.client.db.prepare(`
      INSERT INTO opportunity_family_events (
        id, family_id, event_type, related_family_id, reason, actor, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(idFactory(), familyId, eventType, relatedFamilyId, reason, actor, new Date().toISOString());
  }

  private promoteRepresentativeBeforeMove(
    threadId: string,
    current: CurrentMembershipRow,
    reason: string,
  ): void {
    if (!current.family_id) return;
    const family = this.requireActiveFamily(threadId, current.family_id);
    if (family.representative_option_id !== current.option_id) return;
    const replacements = this.currentMembershipRows(threadId).filter((membership) =>
      membership.option_id !== current.option_id
      && membership.family_id === current.family_id
      && membership.state === "accepted");
    const discarded = this.discardedIds(threadId);
    const replacement = replacements.find((membership) =>
      parseStartup(membership.startup_opportunity_json)?.opportunityType === "startup-opportunity"
      && !discarded.has(membership.option_id)) ?? replacements[0];
    if (!replacement) return;
    const now = new Date().toISOString();
    this.client.db.prepare(`
      UPDATE opportunity_families SET representative_option_id = ?, updated_at = ? WHERE id = ?
    `).run(replacement.option_id, now, current.family_id);
    this.insertFamilyEvent(
      current.family_id,
      "reactivated",
      null,
      `${reason} Replacement representative: ${replacement.option_id}.`,
      "user",
      randomUUID,
    );
  }

  private preferCountableRepresentative(
    threadId: string,
    familyId: string,
    optionId: string,
    reason: string,
    actor: "model" | "user",
    idFactory: () => string,
  ): void {
    const discarded = this.discardedIds(threadId);
    if (discarded.has(optionId)) return;
    const candidate = this.client.db.prepare(`
      SELECT startup_opportunity_json FROM solutions WHERE id = ?
    `).get(optionId) as { startup_opportunity_json: string | null } | undefined;
    if (parseStartup(candidate?.startup_opportunity_json ?? null)?.opportunityType !== "startup-opportunity") return;
    const family = this.requireActiveFamily(threadId, familyId);
    if (family.representative_option_id === optionId) return;
    const representative = this.client.db.prepare(`
      SELECT startup_opportunity_json FROM solutions WHERE id = ?
    `).get(family.representative_option_id) as { startup_opportunity_json: string | null } | undefined;
    const representativeEligible = parseStartup(representative?.startup_opportunity_json ?? null)?.opportunityType === "startup-opportunity"
      && !discarded.has(family.representative_option_id);
    if (representativeEligible) return;
    const now = new Date().toISOString();
    this.client.db.prepare(`
      UPDATE opportunity_families SET representative_option_id = ?, updated_at = ? WHERE id = ?
    `).run(optionId, now, familyId);
    this.insertFamilyEvent(
      familyId,
      "reactivated",
      null,
      `${reason} Representative: ${optionId}.`,
      actor,
      idFactory,
    );
  }

  private insertDecision(input: {
    id: string;
    threadId: string;
    optionId: string;
    familyId: string | null;
    relationship: OpportunityRelationship;
    state: "accepted" | "unresolved";
    reason: string;
    actor: "model" | "user";
    reviewCallId: string | null;
    supersedesId: string | null;
  }): void {
    this.client.db.prepare(`
      INSERT INTO opportunity_membership_decisions (
        id, thread_id, option_id, family_id, relationship, state, reason,
        actor, review_call_id, supersedes_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.threadId,
      input.optionId,
      input.familyId,
      input.relationship,
      input.state,
      input.reason,
      input.actor,
      input.reviewCallId,
      input.supersedesId,
      new Date().toISOString(),
    );
  }

  private currentMembershipRows(threadId: string): CurrentMembershipRow[] {
    return this.client.db.prepare(`
      SELECT d.id, d.option_id, d.family_id, d.relationship, d.state, d.reason,
        d.actor, d.created_at, s.mechanism, s.description, s.startup_opportunity_json
      FROM opportunity_membership_decisions d
      JOIN solutions s ON s.id = d.option_id
      WHERE d.thread_id = ? AND NOT EXISTS (
        SELECT 1 FROM opportunity_membership_decisions next WHERE next.supersedes_id = d.id
      )
      ORDER BY d.created_at, d.id
    `).all(threadId) as CurrentMembershipRow[];
  }

  private currentDecision(optionId: string): (CurrentMembershipRow & { thread_id: string }) | null {
    return this.client.db.prepare(`
      SELECT d.id, d.thread_id, d.option_id, d.family_id, d.relationship, d.state,
        d.reason, d.actor, d.created_at, s.mechanism, s.description, s.startup_opportunity_json
      FROM opportunity_membership_decisions d
      JOIN solutions s ON s.id = d.option_id
      WHERE d.option_id = ? AND NOT EXISTS (
        SELECT 1 FROM opportunity_membership_decisions next WHERE next.supersedes_id = d.id
      )
    `).get(optionId) as (CurrentMembershipRow & { thread_id: string }) | undefined ?? null;
  }

  private requireActiveFamily(threadId: string, familyId: string): { id: string; representative_option_id: string } {
    const family = this.client.db.prepare(`
      SELECT id, representative_option_id FROM opportunity_families
      WHERE id = ? AND thread_id = ? AND active = 1
    `).get(familyId, threadId) as { id: string; representative_option_id: string } | undefined;
    if (!family) throw new Error("Active opportunity family was not found");
    return family;
  }

  private solutionRows(threadId: string): SolutionCandidateRow[] {
    return this.client.db.prepare(`
      SELECT s.id, s.research_run_id, s.problem_id, p.statement AS problem_statement,
        s.mechanism, s.description, s.startup_opportunity_json
      FROM solutions s
      JOIN research_runs rr ON rr.id = s.research_run_id
      JOIN problems p ON p.id = s.problem_id
      WHERE rr.thread_id = ?
      ORDER BY s.created_at, s.id
    `).all(threadId) as SolutionCandidateRow[];
  }

  private discardedIds(threadId: string): Set<string> {
    const value = this.client.getSetting(`discarded-ideas:${threadId}`);
    if (!value) return new Set();
    const parsed: unknown = JSON.parse(value);
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []);
  }

  private updateReviewStatus(id: string, status: Extract<OpportunityReviewCallStatus, "dispatched">): void {
    this.client.db.prepare(`
      UPDATE opportunity_review_calls SET status = ?, updated_at = ?
      WHERE id = ? AND status = 'prepared'
    `).run(status, new Date().toISOString(), id);
  }
}

export function acceptedOpportunityFamilyCount(db: DatabaseClient, threadId: string): number {
  return new OpportunityRepository(db).acceptedFamilyCount(threadId);
}

/** Marks calls left in flight by a stopped process before any review state is projected. */
export function recoverInterruptedOpportunityReviews(db: DatabaseClient): string[] {
  return new OpportunityRepository(db).recoverInFlightReviewCalls();
}

function candidateFromRow(row: SolutionCandidateRow): OpportunityCandidateSnapshot {
  const startup = parseStartup(row.startup_opportunity_json);
  return {
    optionId: row.id,
    runId: row.research_run_id,
    problemId: row.problem_id,
    problemStatement: row.problem_statement,
    mechanism: row.mechanism,
    businessDescription: row.description,
    buyer: startup?.payingCustomerSegment ?? null,
    payingDecisionMaker: startup?.payingCustomerSegment ?? null,
    buyingTrigger: startup?.trigger ?? null,
    jobToBeDone: row.problem_statement,
    coreWorkflow: startup?.smallestSellableWorkflow ?? null,
    currentSubstitute: startup?.existingSubstitute ?? null,
    eligibleStartup: startup?.opportunityType === "startup-opportunity",
  };
}

function candidateFromMembership(row: CurrentMembershipRow): OpportunityCandidateSnapshot {
  const startup = parseStartup(row.startup_opportunity_json);
  return {
    optionId: row.option_id,
    runId: "membership-view",
    problemId: "membership-view",
    problemStatement: row.description,
    mechanism: row.mechanism,
    businessDescription: row.description,
    buyer: startup?.payingCustomerSegment ?? null,
    payingDecisionMaker: startup?.payingCustomerSegment ?? null,
    buyingTrigger: startup?.trigger ?? null,
    jobToBeDone: row.description,
    coreWorkflow: startup?.smallestSellableWorkflow ?? null,
    currentSubstitute: startup?.existingSubstitute ?? null,
    eligibleStartup: startup?.opportunityType === "startup-opportunity",
  };
}

function parseStartup(value: string | null) {
  if (!value) return null;
  const parsed = StartupOpportunityDetailsSchema.safeParse(JSON.parse(value));
  return parsed.success ? parsed.data : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Opportunity review snapshot contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, canonicalValue(object[key])]));
  }
  throw new Error("Opportunity review snapshot contains a non-JSON value");
}
