import type {
  DevelopedMitigation,
  DevelopedOutcome,
  DevelopedRisk,
  DevelopedSolution,
  DevelopmentFactor,
  DevelopmentProblem,
} from "../../core/development";
import type { Scope } from "../../shared/structured-output-schemas";
import type { DatabaseClient } from "../client";

export interface DevelopmentContext {
  scope: Scope;
  problem: DevelopmentProblem;
  factors: DevelopmentFactor[];
}

export class DevelopmentRepository {
  constructor(private readonly client: DatabaseClient) {}

  loadContext(problemId: string): DevelopmentContext | null {
    const problemRow = this.client.db.prepare(`
      SELECT p.*, s.title AS scope_title, s.audience, s.domain, s.observations, s.off_limits_json, s.risk_evaluation_criteria
      FROM problems p
      JOIN scopes s ON s.research_run_id = p.discovery_run_id
      WHERE p.id = ?
    `).get(problemId) as Record<string, unknown> | undefined;
    if (!problemRow) return null;
    const factorRows = this.client.db.prepare(`
      SELECT f.*
      FROM problem_factors pf
      JOIN factors f ON f.id = pf.factor_id
      WHERE pf.problem_id = ?
      ORDER BY f.created_at, f.id
    `).all(problemId) as Array<Record<string, unknown>>;
    const verdictSourceRows = this.client.db.prepare(`
      SELECT source_id
      FROM problem_verdict_sources
      WHERE problem_id = ?
      ORDER BY position
    `).all(problemId) as Array<{ source_id: string }>;
    const factorIds = factorRows.map((row) => String(row.id));
    return {
      scope: {
        title: String(problemRow.scope_title),
        audience: String(problemRow.audience),
        domain: String(problemRow.domain),
        observations: String(problemRow.observations),
        ...(problemRow.risk_evaluation_criteria ? { riskEvaluationCriteria: String(problemRow.risk_evaluation_criteria) } : {}),
        offLimits: parseStringArray(problemRow.off_limits_json),
      },
      problem: {
        id: String(problemRow.id),
        statement: String(problemRow.statement),
        whyItPersists: String(problemRow.why_it_persists),
        affected: String(problemRow.affected),
        scaleEstimate: String(problemRow.scale_estimate),
        scaleBasisFactorId: problemRow.scale_basis_factor_id === null ? null : String(problemRow.scale_basis_factor_id),
        factorIds,
        verdict: String(problemRow.verdict) as DevelopmentProblem["verdict"],
        verdictReason: String(problemRow.verdict_reason),
        verdictSourceIds: verdictSourceRows.map((row) => row.source_id),
      },
      factors: factorRows.map((row) => ({
        id: String(row.id),
        subject: String(row.subject),
        behavior: String(row.behavior),
        quote: String(row.quote),
        sourceId: String(row.source_id),
        harvestMode: String(row.harvest_mode) as DevelopmentFactor["harvestMode"],
        modelConfidence: Number(row.model_confidence),
        ...(row.uncertainty === null ? {} : { uncertainty: String(row.uncertainty) }),
      })),
    };
  }

  attachProblem(researchRunId: string, problemId: string): void {
    const row = this.client.db.prepare(`
      SELECT problem_id
      FROM research_runs
      WHERE id = ?
    `).get(researchRunId) as { problem_id: string | null } | undefined;
    if (!row) throw new Error(`Research run not found: ${researchRunId}`);
    if (row.problem_id !== null && row.problem_id !== problemId) {
      throw new Error(`Research run ${researchRunId} already targets problem ${row.problem_id}`);
    }
    this.client.db.prepare(`UPDATE research_runs SET problem_id = ?, updated_at = ? WHERE id = ?`).run(
      problemId,
      new Date().toISOString(),
      researchRunId,
    );
  }

  persistSolutions(researchRunId: string, problemId: string, solutions: DevelopedSolution[]): void {
    const db = this.client.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      this.assertRunTargetsProblem(researchRunId, problemId);
      const insert = db.prepare(`
        INSERT INTO solutions (
          id, research_run_id, problem_id, mechanism, description, respects_off_limits,
          respects_off_limits_why, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const now = new Date().toISOString();
      for (const solution of solutions) {
        if (solution.problemId !== problemId) {
          throw new Error(`Solution ${solution.id} targets problem ${solution.problemId}, expected ${problemId}`);
        }
        insert.run(
          solution.id,
          researchRunId,
          problemId,
          solution.mechanism,
          solution.description,
          solution.respectsOffLimits ? 1 : 0,
          solution.respectsOffLimitsWhy,
          now,
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  persistOutcomes(researchRunId: string, outcomes: DevelopedOutcome[]): void {
    const db = this.client.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const insert = db.prepare(`
        INSERT INTO outcomes (
          id, solution_id, description, direction, affects, addresses_core, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const now = new Date().toISOString();
      for (const outcome of outcomes) {
        this.assertRunOwnsSolution(researchRunId, outcome.solutionId);
        insert.run(
          outcome.id,
          outcome.solutionId,
          outcome.description,
          outcome.direction,
          outcome.affects,
          outcome.addressesCore ? 1 : 0,
          now,
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  persistRiskAnalysis(
    researchRunId: string,
    solutionId: string,
    risks: DevelopedRisk[],
    mitigations: DevelopedMitigation[],
  ): void {
    const db = this.client.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      this.assertRunOwnsSolution(researchRunId, solutionId);
      const now = new Date().toISOString();
      const insertRisk = db.prepare(`
        INSERT INTO risks (
          id, solution_id, description, likelihood, impact, sort_key, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const risk of risks) {
        if (risk.solutionId !== solutionId) {
          throw new Error(`Risk ${risk.id} links outside solution ${solutionId}`);
        }
        insertRisk.run(
          risk.id,
          solutionId,
          risk.description,
          risk.likelihood,
          risk.impact,
          risk.sortKey,
          now,
        );
      }
      const insertMitigation = db.prepare(`
        INSERT INTO mitigations (id, solution_id, approach, cost, fails_if, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const insertLink = db.prepare(`
        INSERT INTO risk_mitigations (risk_id, mitigation_id) VALUES (?, ?)
      `);
      const knownRiskIds = new Set(risks.map((risk) => risk.id));
      for (const mitigation of mitigations) {
        if (mitigation.solutionId !== solutionId || mitigation.riskIds.some((riskId) => !knownRiskIds.has(riskId))) {
          throw new Error(`Mitigation ${mitigation.id} links outside solution ${solutionId}`);
        }
        insertMitigation.run(
          mitigation.id,
          solutionId,
          mitigation.approach,
          mitigation.cost,
          mitigation.failsIf,
          now,
        );
        for (const riskId of mitigation.riskIds) insertLink.run(riskId, mitigation.id);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  private assertRunTargetsProblem(researchRunId: string, problemId: string): void {
    const row = this.client.db.prepare(`
      SELECT 1
      FROM research_runs
      WHERE id = ? AND problem_id = ?
    `).get(researchRunId, problemId);
    if (!row) throw new Error(`Research run ${researchRunId} does not target problem ${problemId}`);
  }

  private assertRunOwnsSolution(researchRunId: string, solutionId: string): void {
    const row = this.client.db.prepare(`
      SELECT 1
      FROM solutions
      WHERE id = ? AND research_run_id = ?
    `).get(solutionId, researchRunId);
    if (!row) throw new Error(`Solution ${solutionId} does not belong to research run ${researchRunId}`);
  }
}

function parseStringArray(value: unknown): string[] {
  const parsed: unknown = JSON.parse(String(value));
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("Expected a persisted JSON string array");
  }
  return parsed;
}
