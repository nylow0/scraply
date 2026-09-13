import { randomUUID } from "node:crypto";
import type { Scope } from "../../shared/structured-output-schemas";
import type { RunConfig } from "../../shared/schemas";
import type { DatabaseClient } from "../client";
import { ActiveRunConflictError } from "./research-runs";

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
}

export interface RejectedProblemCandidateRecord {
  statement: string;
  reason: string;
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
      for (const source of sources) this.insertSource(researchRunId, source);
      const now = new Date().toISOString();
      const insert = db.prepare(`
        INSERT INTO factors (
          id, research_run_id, subject, behavior, quote, source_id,
          harvest_mode, model_confidence, uncertainty, source_role, audience_fit,
          independent_source_key, supports_demand, demand_evidence_uncertainty, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const factor of factors) {
        this.assertSourceBelongsToRun(researchRunId, factor.sourceId);
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
      for (const source of sources) this.insertSource(researchRunId, source);
      const now = new Date().toISOString();
      const insertProblem = db.prepare(`
        INSERT INTO problems (
          id, discovery_run_id, statement, why_it_persists, affected,
          scale_estimate, scale_basis_factor_id, verdict, verdict_reason,
          verdict_source_ids_json, selected_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', NULL, ?)
      `);
      const insertFactor = db.prepare(`
        INSERT INTO problem_factors (problem_id, factor_id) VALUES (?, ?)
      `);
      const insertVerdictSource = db.prepare(`
        INSERT INTO problem_verdict_sources (problem_id, source_id, research_run_id, position)
        VALUES (?, ?, ?, ?)
      `);
      const insertRejectedCandidate = db.prepare(`
        INSERT INTO rejected_problem_candidates (
          id, discovery_run_id, statement, reason, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `);
      db.prepare("DELETE FROM rejected_problem_candidates WHERE discovery_run_id = ?").run(researchRunId);
      for (const problem of problems) {
        if (problem.scaleBasisFactorId !== null) {
          this.assertFactorBelongsToRun(researchRunId, problem.scaleBasisFactorId);
        }
        for (const factorId of problem.factorIds) this.assertFactorBelongsToRun(researchRunId, factorId);
        for (const sourceId of problem.verdictSourceIds) this.assertSourceBelongsToRun(researchRunId, sourceId);
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
          now,
        );
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
          now,
        );
      }
      checkpoint?.();
    });
  }

  createKnownProblemRoot(threadId: string, scope: Scope, statement: string, config: RunConfig): { runId: string; problemId: string } {
    const db = this.client.db;
    const trimmedStatement = statement.trim();
    if (!trimmedStatement) throw new Error("Known problem statement cannot be empty");
    db.exec("BEGIN IMMEDIATE");
    try {
      const active = db.prepare(`SELECT id FROM research_runs WHERE thread_id = ? AND status IN ('queued', 'running') LIMIT 1`)
        .get(threadId) as { id: string } | undefined;
      if (active) throw new ActiveRunConflictError(active.id);

      const existing = db.prepare(`
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
        INSERT INTO research_runs (id, thread_id, status, config_json, cancelled, completion_reason, problem_id, created_at, updated_at)
        VALUES (?, ?, 'completed', ?, 0, 'Known problem supplied; discovery bypassed.', NULL, ?, ?)
      `).run(runId, threadId, JSON.stringify(config), now, now);
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

  private insertSource(researchRunId: string, source: DiscoverySourceRecord): void {
    this.client.db.prepare(`
      INSERT INTO sources (
        id, research_run_id, provider_source_id,
        canonical_url, title, retrieved_text, author, published_at,
        content_hash, retrieved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
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

  private assertFactorBelongsToRun(researchRunId: string, factorId: string): void {
    const row = this.client.db.prepare("SELECT 1 FROM factors WHERE id = ? AND research_run_id = ?")
      .get(factorId, researchRunId);
    if (!row) throw new Error(`Factor ${factorId} does not belong to research run ${researchRunId}`);
  }

  private assertSourceBelongsToRun(researchRunId: string, sourceId: string): void {
    const row = this.client.db.prepare("SELECT 1 FROM sources WHERE id = ? AND research_run_id = ?")
      .get(sourceId, researchRunId);
    if (!row) throw new Error(`Source ${sourceId} does not belong to research run ${researchRunId}`);
  }
}
