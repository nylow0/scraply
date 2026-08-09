import { randomUUID } from "node:crypto";
import type { Scope } from "../../shared/structured-output-schemas";
import type { DatabaseClient } from "../client";

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

export class DiscoveryRepository {
  constructor(private readonly client: DatabaseClient) {}

  persistScope(researchRunId: string, scope: Scope): void {
    const now = new Date().toISOString();
    this.client.db.prepare(`
      INSERT INTO scopes (
        id, research_run_id, title, audience, domain, observations,
        off_limits_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      researchRunId,
      scope.title,
      scope.audience,
      scope.domain,
      scope.observations,
      JSON.stringify(scope.offLimits),
      now,
      now,
    );
  }

  persistFactors(
    researchRunId: string,
    sources: DiscoverySourceRecord[],
    factors: DiscoveryFactorRecord[],
  ): void {
    const db = this.client.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const source of sources) this.insertSource(researchRunId, source);
      const now = new Date().toISOString();
      const insert = db.prepare(`
        INSERT INTO factors (
          id, research_run_id, subject, behavior, quote, source_id,
          harvest_mode, model_confidence, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const factor of factors) {
        insert.run(
          factor.id,
          researchRunId,
          factor.subject,
          factor.behavior,
          factor.quote,
          factor.sourceId,
          factor.harvestMode,
          factor.modelConfidence,
          now,
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  persistProblems(
    researchRunId: string,
    sources: DiscoverySourceRecord[],
    problems: DiscoveryProblemRecord[],
  ): void {
    const db = this.client.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const source of sources) this.insertSource(researchRunId, source);
      const now = new Date().toISOString();
      const insertProblem = db.prepare(`
        INSERT INTO problems (
          id, discovery_run_id, statement, why_it_persists, affected,
          scale_estimate, scale_basis_factor_id, verdict, verdict_reason,
          verdict_source_ids_json, selected_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
      `);
      const insertFactor = db.prepare(`
        INSERT INTO problem_factors (problem_id, factor_id) VALUES (?, ?)
      `);
      for (const problem of problems) {
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
          JSON.stringify(problem.verdictSourceIds),
          now,
        );
        for (const factorId of problem.factorIds) insertFactor.run(problem.id, factorId);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  private insertSource(researchRunId: string, source: DiscoverySourceRecord): void {
    this.client.db.prepare(`
      INSERT INTO sources (
        id, research_run_id, originating_stream_run_id, provider_source_id,
        canonical_url, title, retrieved_text, author, published_at,
        content_hash, retrieved_at
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
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
}
