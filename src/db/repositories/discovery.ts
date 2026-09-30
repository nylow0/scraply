import { randomUUID } from "node:crypto";
import { SavedProblemCandidateSchema, type ProblemBriefFit, type ProblemContraryEvidence, type ProblemFactorAssessment, type SavedProblemCandidate, type Scope } from "../../shared/structured-output-schemas";
import type { RunConfig } from "../../shared/schemas";
import type { DatabaseClient } from "../client";
import type { SqlStatement } from "../sqlite";
import { ActiveRunConflictError, type ResearchRunWorkflowLink } from "./research-runs";

export interface DiscoverySourceRecord {
  id: string;
  providerSourceId: string | null;
  canonicalUrl: string;
  title: string;
  retrievedText: string;
  author: string | null;
  publishedAt: string | null;
  contentHash: string;
  retrievedAt: string;
}

export interface DiscoveryFactorRecord {
  id: string;
  subject: string;
  behavior: string;
  quote: string;
  sourceId: string;
  harvestMode: "domain" | "audience";
  modelConfidence: number;
  uncertainty?: string | null;
  sourceRole?: "firsthand" | "measured" | "vendor" | "recommendation" | "illustration" | "unknown";
  audienceFit?: "intended-buyer" | "adjacent" | "general" | "unknown";
  independentSourceKey?: string | null;
  supportsDemand?: boolean;
  demandEvidenceUncertainty?: string | null;
}

export interface DiscoveryProblemRecord {
  id: string;
  statement: string;
  whyItPersists: string;
  affected: string;
  scaleEstimate: string;
  scaleBasisFactorId: string | null;
  factorIds: string[];
  verdict: "confirmed" | "overstated" | "already-solved" | "insufficient-evidence" | "attempted-and-failed" | "user-asserted";
  verdictReason: string;
  verdictSourceIds: string[];
  intendedBuyerEvidenceFactorIds?: string[];
  evidenceGap?: string | null;
  briefFit?: ProblemBriefFit;
  contraryEvidence?: ProblemContraryEvidence;
  workflowKey?: string | null;
  factorAssessments?: ProblemFactorAssessment[];
}

export interface RejectedProblemCandidateRecord {
  statement: string;
  reason: string;
  disposition?: "blocked" | "not-assessed";
  candidate?: SavedProblemCandidate | null;
}

export class DiscoveryRepository {
  constructor(private readonly client: DatabaseClient) {}

  persistScope(researchRunId: string, scope: Scope): void {
    const now = new Date().toISOString();
    this.client.db.prepare(`
      INSERT INTO scopes (
        id, research_run_id, title, audience, domain, observations,
        off_limits_json, risk_evaluation_criteria, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      researchRunId,
      scope.title,
      scope.audience,
      scope.domain,
      scope.observations,
      JSON.stringify(scope.offLimits),
      scope.riskEvaluationCriteria ?? "",
      now,
      now,
    );
  }

  persistFactors(
    researchRunId: string,
    sources: DiscoverySourceRecord[],
    factors: DiscoveryFactorRecord[],
    checkpoint?: () => void,
  ): void {
    const db = this.client.db;
    this.client.immediateTransaction(() => {
      if (sources.length > 0) {
        const insertSource = db.prepare(INSERT_SOURCE_SQL);
        for (const source of sources) this.insertSource(insertSource, researchRunId, source);
      }
      const sourceExists = db.prepare("SELECT 1 FROM sources WHERE id = ? AND research_run_id = ?");
      const now = new Date().toISOString();
      const insert = db.prepare(`
        INSERT INTO factors (
          id, research_run_id, subject, behavior, quote, source_id,
          harvest_mode, model_confidence, uncertainty, source_role, audience_fit,
          independent_source_key, supports_demand, demand_evidence_uncertainty, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const factor of factors) {
        this.assertSourceBelongsToRun(sourceExists, researchRunId, factor.sourceId);
        insert.run(
          factor.id,
          researchRunId,
          factor.subject,
          factor.behavior,
          factor.quote,
          factor.sourceId,
          factor.harvestMode,
          factor.modelConfidence,
          factor.uncertainty ?? null,
          factor.sourceRole ?? "unknown",
          factor.audienceFit ?? "unknown",
          factor.independentSourceKey ?? null,
          factor.supportsDemand ? 1 : 0,
          factor.demandEvidenceUncertainty ?? null,
          now,
        );
      }
      checkpoint?.();
    });
  }

  persistProblems(
    researchRunId: string,
    sources: DiscoverySourceRecord[],
    problems: DiscoveryProblemRecord[],
    rejectedCandidates: RejectedProblemCandidateRecord[] = [],
    checkpoint?: () => void,
  ): void {
    const db = this.client.db;
    this.client.immediateTransaction(() => {
      if (sources.length > 0) {
        const insertSource = db.prepare(INSERT_SOURCE_SQL);
        for (const source of sources) this.insertSource(insertSource, researchRunId, source);
      }
      const factorExists = db.prepare("SELECT 1 FROM factors WHERE id = ? AND research_run_id = ?");
      const sourceExists = db.prepare("SELECT 1 FROM sources WHERE id = ? AND research_run_id = ?");
      const now = new Date().toISOString();
      const existingProblem = db.prepare("SELECT discovery_run_id, statement, affected, scale_basis_factor_id FROM problems WHERE id = ?");
      const insertProblem = db.prepare(`
        INSERT INTO problems (
          id, discovery_run_id, statement, why_it_persists, affected,
          scale_estimate, scale_basis_factor_id, verdict, verdict_reason,
          verdict_source_ids_json, intended_buyer_evidence_factor_ids_json,
          evidence_gap, brief_fit, contrary_evidence, workflow_key, factor_assessments_json, selected_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, NULL, ?)
        ON CONFLICT(id) DO UPDATE SET verdict = excluded.verdict, verdict_reason = excluded.verdict_reason,
          intended_buyer_evidence_factor_ids_json = excluded.intended_buyer_evidence_factor_ids_json,
          evidence_gap = excluded.evidence_gap, brief_fit = excluded.brief_fit,
          contrary_evidence = excluded.contrary_evidence, workflow_key = excluded.workflow_key,
          factor_assessments_json = excluded.factor_assessments_json
        WHERE problems.discovery_run_id = excluded.discovery_run_id AND problems.statement = excluded.statement
          AND problems.affected = excluded.affected AND problems.scale_basis_factor_id IS excluded.scale_basis_factor_id
      `);
      const insertFactor = db.prepare(`
        INSERT OR IGNORE INTO problem_factors (problem_id, factor_id) VALUES (?, ?)
      `);
      const insertVerdictSource = db.prepare(`
        INSERT INTO problem_verdict_sources (problem_id, source_id, research_run_id, position)
        VALUES (?, ?, ?, ?)
      `);
      const insertRejectedCandidate = db.prepare(`
        INSERT INTO rejected_problem_candidates (
          id, discovery_run_id, statement, reason, disposition, candidate_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      db.prepare("DELETE FROM rejected_problem_candidates WHERE discovery_run_id = ?").run(researchRunId);
      for (const problem of problems) {
        if (problem.scaleBasisFactorId !== null) {
          this.assertFactorBelongsToRun(factorExists, researchRunId, problem.scaleBasisFactorId);
        }
        for (const factorId of problem.factorIds) this.assertFactorBelongsToRun(factorExists, researchRunId, factorId);
        for (const sourceId of problem.verdictSourceIds) this.assertSourceBelongsToRun(sourceExists, researchRunId, sourceId);
        const prior = existingProblem.get(problem.id) as { discovery_run_id: string; statement: string; affected: string; scale_basis_factor_id: string | null } | undefined;
        if (prior && (prior.discovery_run_id !== researchRunId || prior.statement !== problem.statement
          || prior.affected !== problem.affected || prior.scale_basis_factor_id !== problem.scaleBasisFactorId)) {
          throw new Error("Problem reassessment cannot change its original identity");
        }
        insertProblem.run(
          problem.id,
          researchRunId,
          problem.statement,
          problem.whyItPersists,
          problem.affected,
          problem.scaleEstimate,
          problem.scaleBasisFactorId,
          problem.verdict,
          problem.verdictReason,
          JSON.stringify(problem.intendedBuyerEvidenceFactorIds ?? []),
          problem.evidenceGap ?? null,
          problem.briefFit ?? "unknown",
          problem.contraryEvidence ?? "unknown",
          problem.workflowKey?.trim() || null,
          JSON.stringify(problem.factorAssessments ?? []),
          now,
        );
        // These links materialize the latest verdict; immutable stage outputs retain every prior review.
        db.prepare("DELETE FROM problem_verdict_sources WHERE problem_id = ?").run(problem.id);
        problem.verdictSourceIds.forEach((sourceId, position) => {
          insertVerdictSource.run(problem.id, sourceId, researchRunId, position);
        });
        for (const factorId of problem.factorIds) insertFactor.run(problem.id, factorId);
      }
      for (const candidate of rejectedCandidates) {
        insertRejectedCandidate.run(
          randomUUID(),
          researchRunId,
          candidate.statement.trim(),
          candidate.reason.trim(),
          candidate.disposition ?? "blocked",
          candidate.candidate ? JSON.stringify(SavedProblemCandidateSchema.parse(candidate.candidate)) : null,
          now,
        );
      }
      checkpoint?.();
    });
  }

  createKnownProblemRoot(threadId: string, scope: Scope, statement: string, config: RunConfig, workflow?: ResearchRunWorkflowLink): { runId: string; problemId: string } {
    const db = this.client.db;
    const trimmedStatement = statement.trim();
    if (!trimmedStatement) throw new Error("Known problem statement cannot be empty");
    db.exec("BEGIN IMMEDIATE");
    try {
      const active = db.prepare(`SELECT id FROM research_runs WHERE thread_id = ? AND status IN ('queued', 'running') LIMIT 1`)
        .get(threadId) as { id: string } | undefined;
      if (active) throw new ActiveRunConflictError(active.id);

      const existing = workflow ? undefined : db.prepare(`
        SELECT rr.id AS run_id, p.id AS problem_id
        FROM research_runs rr
        JOIN scopes s ON s.research_run_id = rr.id
        JOIN problems p ON p.discovery_run_id = rr.id
        WHERE rr.thread_id = ? AND rr.problem_id IS NULL AND rr.status = 'completed'
          AND p.verdict = 'user-asserted' AND p.selected_at IS NOT NULL AND p.statement = ?
          AND s.title = ? AND s.audience = ? AND s.domain = ? AND s.observations = ? AND s.off_limits_json = ?
          AND s.risk_evaluation_criteria = ?
          AND NOT EXISTS (SELECT 1 FROM research_runs development WHERE development.problem_id = p.id AND development.status = 'completed')
        ORDER BY rr.created_at DESC, rr.rowid DESC LIMIT 1
      `).get(threadId, trimmedStatement, scope.title, scope.audience, scope.domain, scope.observations, JSON.stringify(scope.offLimits), scope.riskEvaluationCriteria ?? "") as
        { run_id: string; problem_id: string } | undefined;
      if (existing) {
        db.exec("COMMIT");
        return { runId: existing.run_id, problemId: existing.problem_id };
      }

      const runId = randomUUID();
      const problemId = randomUUID();
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO research_runs (id, thread_id, status, config_json, cancelled, completion_reason, problem_id, created_at, updated_at,
          workflow_session_id, purpose, evidence_snapshot_id)
        VALUES (?, ?, 'completed', ?, 0, 'Known problem supplied; discovery bypassed.', NULL, ?, ?, ?, ?, ?)
      `).run(runId, threadId, JSON.stringify(config), now, now,
        workflow?.sessionId ?? null, workflow?.purpose ?? null, workflow?.evidenceSnapshotId ?? null);
      db.prepare("UPDATE research_runs SET workflow_version = ? WHERE id = ?").run(config.workflowVersion ?? 1, runId);
      this.persistScope(runId, scope);
      db.prepare(`
        INSERT INTO problems (
          id, discovery_run_id, statement, why_it_persists, affected,
          scale_estimate, scale_basis_factor_id, verdict, verdict_reason,
          verdict_source_ids_json, selected_at, created_at
        ) VALUES (?, ?, ?, '', '', '', NULL, 'user-asserted', 'Stated directly by the user.', '[]', ?, ?)
      `).run(problemId, runId, trimmedStatement, now, now);
      db.exec("COMMIT");
      return { runId, problemId };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  private insertSource(statement: SqlStatement, researchRunId: string, source: DiscoverySourceRecord): void {
    const existing = this.client.db.prepare("SELECT canonical_url, retrieved_text, content_hash FROM sources WHERE id = ? AND research_run_id = ?")
      .get(source.id, researchRunId) as { canonical_url: string; retrieved_text: string; content_hash: string } | undefined;
    if (existing) {
      if (existing.canonical_url !== source.canonicalUrl || existing.retrieved_text !== source.retrievedText || existing.content_hash !== source.contentHash) {
        throw new Error("Saved source identity cannot change during problem reassessment");
      }
      return;
    }
    statement.run(
      source.id,
      researchRunId,
      source.providerSourceId,
      source.canonicalUrl,
      source.title,
      source.retrievedText,
      source.author,
      source.publishedAt,
      source.contentHash,
      source.retrievedAt,
    );
  }

  private assertFactorBelongsToRun(statement: SqlStatement, researchRunId: string, factorId: string): void {
    const row = statement.get(factorId, researchRunId);
    if (!row) throw new Error(`Factor ${factorId} does not belong to research run ${researchRunId}`);
  }

  private assertSourceBelongsToRun(statement: SqlStatement, researchRunId: string, sourceId: string): void {
    const row = statement.get(sourceId, researchRunId);
    if (!row) throw new Error(`Source ${sourceId} does not belong to research run ${researchRunId}`);
  }
}

const INSERT_SOURCE_SQL = `
  INSERT INTO sources (
    id, research_run_id, provider_source_id,
    canonical_url, title, retrieved_text, author, published_at,
    content_hash, retrieved_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;
