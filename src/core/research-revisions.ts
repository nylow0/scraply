import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "../db/client";
import { canonicalJson, sha256 } from "../shared/content-identity";
import type { ResearchFindingComparison, ResearchReplacement, ResearchRequestDraft } from "../shared/research-revisions";
export type {
  ResearchFindingComparison, ResearchFindingView, ResearchReplacement, ResearchRequestDraft,
  ResearchRequestKind, ResearchRequestView,
} from "../shared/research-revisions";

export class ResearchRevisionError extends Error {
  readonly code = "INVALID_REFERENCE";
  constructor(message: string) {
    super(message);
    this.name = "ResearchRevisionError";
  }
}

/** Validate the work the user requested before the coordinator reserves any capacity. */
export function validateResearchRequest(draft: ResearchRequestDraft): ResearchRequestDraft {
  const question = draft.question.trim();
  if (!question || question.length > 500) throw new ResearchRevisionError("Enter a research question of at most 500 characters.");
  if (draft.kind !== "new-question" && !draft.targetFindingId) {
    throw new ResearchRevisionError("Choose the finding to revisit.");
  }
  if (draft.kind === "new-question" && draft.targetFindingId) {
    throw new ResearchRevisionError("A new question cannot replace a finding. Use Redo instead.");
  }
  const { maxModelCalls, maxSearches, maxMinutes } = draft.allowance;
  if (![maxModelCalls, maxSearches, maxMinutes].every((value) => Number.isInteger(value) && value >= 0)) {
    throw new ResearchRevisionError("Research allowances must be nonnegative whole numbers.");
  }
  if (maxModelCalls < 1 || maxMinutes < 1) {
    throw new ResearchRevisionError("Reserve at least one model call and one minute for the request.");
  }
  if (draft.kind === "reevaluate" && maxSearches !== 0) {
    throw new ResearchRevisionError("Reevaluating saved evidence cannot make search calls.");
  }
  const angles = [...new Set((draft.angles ?? []).map((angle) => angle.trim()).filter(Boolean))];
  if (angles.length > 4 || angles.some((angle) => angle.length > 200)) {
    throw new ResearchRevisionError("Use up to four angles, each at most 200 characters.");
  }
  const instructions = draft.instructions?.trim();
  if (instructions && instructions.length > 20_000) {
    throw new ResearchRevisionError("Keep task instructions under 20,000 characters.");
  }
  return { ...draft, question, angles, ...(instructions ? { instructions } : {}) };
}

/** An applied result replaces only the named finding; every other saved finding stays selected. */
export function resolveResearchSelection(
  baseFindingIds: string[],
  includedFindingIds: string[],
  replacements: ResearchReplacement[],
): string[] {
  const base = new Set(baseFindingIds);
  if (base.size !== baseFindingIds.length) throw new ResearchRevisionError("The current snapshot contains a duplicate finding.");
  const included = new Set(includedFindingIds);
  if (included.size !== includedFindingIds.length) throw new ResearchRevisionError("A research result was included twice.");
  const oldIds = new Set<string>();
  const newIds = new Set<string>();
  for (const { oldFindingId, newFindingId } of replacements) {
    if (!base.has(oldFindingId)) throw new ResearchRevisionError("A replacement target is absent from the current snapshot.");
    if (!included.has(newFindingId)) throw new ResearchRevisionError("A replacement must come from an included result.");
    if (oldIds.has(oldFindingId) || newIds.has(newFindingId) || oldFindingId === newFindingId) {
      throw new ResearchRevisionError("Each replacement must have one distinct old and new finding.");
    }
    oldIds.add(oldFindingId);
    newIds.add(newFindingId);
  }
  const selected = baseFindingIds.filter((id) => !oldIds.has(id));
  for (const id of includedFindingIds) {
    if (selected.includes(id)) throw new ResearchRevisionError("A finding is already in the current snapshot.");
    selected.push(id);
  }
  if (selected.length === 0) throw new ResearchRevisionError("Select at least one finding for the snapshot.");
  return selected;
}

export function compareResearchFindings(
  previous: { statement: string; verdict: string; sourceIds: string[]; factorIds: string[]; evidenceGap: string | null },
  proposed: { statement: string; verdict: string; sourceIds: string[]; factorIds: string[]; evidenceGap: string | null },
): ResearchFindingComparison {
  const oldSources = new Set(previous.sourceIds);
  const newSources = new Set(proposed.sourceIds);
  const oldFactors = new Set(previous.factorIds);
  const newFactors = new Set(proposed.factorIds);
  return {
    statementChanged: previous.statement !== proposed.statement,
    verdictChanged: previous.verdict !== proposed.verdict,
    addedSourceIds: proposed.sourceIds.filter((id) => !oldSources.has(id)),
    removedSourceIds: previous.sourceIds.filter((id) => !newSources.has(id)),
    addedFactorIds: proposed.factorIds.filter((id) => !oldFactors.has(id)),
    removedFactorIds: previous.factorIds.filter((id) => !newFactors.has(id)),
    previousGap: previous.evidenceGap,
    proposedGap: proposed.evidenceGap,
  };
}

type ScopeRow = {
  title: string; audience: string; domain: string; observations: string;
  off_limits_json: string; risk_evaluation_criteria: string;
};
type SourceRow = {
  id: string; research_run_id: string; provider_source_id: string | null;
  canonical_url: string; title: string; retrieved_text: string; author: string | null;
  published_at: string | null; content_hash: string; retrieved_at: string;
};
type FactorRow = {
  id: string; research_run_id: string; subject: string; behavior: string; quote: string;
  source_id: string; harvest_mode: string; model_confidence: number; uncertainty: string | null;
  source_role: string; audience_fit: string; independent_source_key: string | null;
  supports_demand: number; demand_evidence_uncertainty: string | null;
};
type ProblemRow = {
  id: string; discovery_run_id: string; statement: string; why_it_persists: string;
  affected: string; scale_estimate: string; scale_basis_factor_id: string | null;
  verdict: string; verdict_reason: string; intended_buyer_evidence_factor_ids_json: string;
  evidence_gap: string | null; brief_fit: string; contrary_evidence: string; workflow_key: string | null;
};
type RunRow = { id: string; thread_id: string; status: string; config_json: string; workflow_version: number };

export interface ResearchOrigin {
  originalId: string;
  originalRunId: string;
  contentSha256: string;
}

export interface ResearchOriginMap {
  sources: Record<string, ResearchOrigin[]>;
  factors: Record<string, ResearchOrigin>;
  problems: Record<string, ResearchOrigin>;
}

export interface MaterializeResearchInput {
  threadId: string;
  baseRunId: string;
  sourceProblemIds: string[];
  sessionId?: string;
  runId?: string;
}

export interface MaterializedResearch {
  runId: string;
  problemIds: string[];
  originMap: ResearchOriginMap;
}

/**
 * Copy the chosen evidence into one ordinary completed discovery run. Call inside the
 * same immediate transaction that creates the immutable snapshot and advances the
 * session revision. Nothing here changes the source runs or their problem verdicts.
 */
export function materializeResearchSnapshot(client: DatabaseClient, input: MaterializeResearchInput): MaterializedResearch {
  client.requireImmediateTransaction();
  const db = client.db;
  if (!input.sourceProblemIds.length || new Set(input.sourceProblemIds).size !== input.sourceProblemIds.length) {
    throw new ResearchRevisionError("Choose distinct findings to include in the snapshot.");
  }
  const baseRun = db.prepare("SELECT id, thread_id, status, config_json, workflow_version FROM research_runs WHERE id = ?")
    .get(input.baseRunId) as RunRow | undefined;
  if (!baseRun || baseRun.thread_id !== input.threadId || baseRun.status !== "completed") {
    throw new ResearchRevisionError("The base research run is unavailable in this project.");
  }
  const scope = db.prepare(`SELECT title, audience, domain, observations, off_limits_json,
    risk_evaluation_criteria FROM scopes WHERE research_run_id = ?`).get(baseRun.id) as ScopeRow | undefined;
  if (!scope) throw new ResearchRevisionError("The base research scope is missing.");

  const problems = input.sourceProblemIds.map((id) => {
    const row = db.prepare(`SELECT p.id, p.discovery_run_id, p.statement, p.why_it_persists,
      p.affected, p.scale_estimate, p.scale_basis_factor_id, p.verdict, p.verdict_reason,
      p.intended_buyer_evidence_factor_ids_json, p.evidence_gap,
      p.brief_fit, p.contrary_evidence, p.workflow_key
      FROM problems p JOIN research_runs r ON r.id = p.discovery_run_id
      WHERE p.id = ? AND r.thread_id = ? AND r.status = 'completed'`).get(id, input.threadId) as ProblemRow | undefined;
    if (!row) throw new ResearchRevisionError("A selected finding is unavailable in this project.");
    return row;
  });

  const factorRows = new Map<string, FactorRow>();
  const sourceRows = new Map<string, SourceRow>();
  const verdictSources = new Map<string, string[]>();
  const factorIdsByProblem = new Map<string, string[]>();
  for (const problem of problems) {
    const ids = (db.prepare("SELECT factor_id FROM problem_factors WHERE problem_id = ? ORDER BY rowid")
      .all(problem.id) as { factor_id: string }[]).map((row) => row.factor_id);
    factorIdsByProblem.set(problem.id, ids);
    const requiredFactorIds = new Set(ids);
    if (problem.scale_basis_factor_id) requiredFactorIds.add(problem.scale_basis_factor_id);
    for (const id of parseIdArray(problem.intended_buyer_evidence_factor_ids_json)) requiredFactorIds.add(id);
    const verdictSourceIds = (db.prepare(`SELECT source_id FROM problem_verdict_sources
      WHERE problem_id = ? ORDER BY position`).all(problem.id) as { source_id: string }[]).map((row) => row.source_id);
    verdictSources.set(problem.id, verdictSourceIds);
    const sourceIds = [...verdictSourceIds];
    for (const factorId of requiredFactorIds) {
      const factor = db.prepare("SELECT * FROM factors WHERE id = ? AND research_run_id = ?")
        .get(factorId, problem.discovery_run_id) as FactorRow | undefined;
      if (!factor) throw new ResearchRevisionError("A cited factor no longer belongs to its finding.");
      factorRows.set(factor.id, factor);
      sourceIds.push(factor.source_id);
    }
    for (const sourceId of new Set(sourceIds)) {
      const source = db.prepare("SELECT * FROM sources WHERE id = ? AND research_run_id = ?")
        .get(sourceId, problem.discovery_run_id) as SourceRow | undefined;
      if (!source || sha256(source.retrieved_text) !== source.content_hash) {
        throw new ResearchRevisionError("A cited source is missing or its saved excerpt has changed.");
      }
      sourceRows.set(source.id, source);
    }
  }

  const runId = input.runId ?? randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO research_runs
    (id, thread_id, status, config_json, cancelled, completion_reason, problem_id,
      created_at, updated_at, workflow_version, workflow_session_id, purpose)
    VALUES (?, ?, 'completed', ?, 0, 'Evidence snapshot materialization; no provider calls.',
      NULL, ?, ?, ?, ?, 'research-materialization')`)
    .run(runId, input.threadId, baseRun.config_json, now, now, baseRun.workflow_version, input.sessionId ?? null);
  db.prepare(`INSERT INTO scopes
    (id, research_run_id, title, audience, domain, observations, off_limits_json,
      risk_evaluation_criteria, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), runId, scope.title, scope.audience, scope.domain, scope.observations,
      scope.off_limits_json, scope.risk_evaluation_criteria, now, now);

  const originMap: ResearchOriginMap = { sources: {}, factors: {}, problems: {} };
  const copiedSources = new Map<string, string>();
  const sourceByUrl = new Map<string, { id: string; contentHash: string }>();
  for (const source of sourceRows.values()) {
    const prior = sourceByUrl.get(source.canonical_url);
    if (prior && prior.contentHash !== source.content_hash) {
      throw new ResearchRevisionError("Two selected results saved different excerpts for the same source URL. Review the selection before applying it.");
    }
    const copiedId = prior?.id ?? randomUUID();
    copiedSources.set(source.id, copiedId);
    const origin = { originalId: source.id, originalRunId: source.research_run_id, contentSha256: source.content_hash };
    (originMap.sources[copiedId] ??= []).push(origin);
    if (prior) continue;
    sourceByUrl.set(source.canonical_url, { id: copiedId, contentHash: source.content_hash });
    db.prepare(`INSERT INTO sources
      (id, research_run_id, provider_source_id, canonical_url, title, retrieved_text,
        author, published_at, content_hash, retrieved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(copiedId, runId, source.provider_source_id, source.canonical_url, source.title,
        source.retrieved_text, source.author, source.published_at, source.content_hash, source.retrieved_at);
  }

  const copiedFactors = new Map<string, string>();
  for (const factor of factorRows.values()) {
    const copiedId = randomUUID();
    const copiedSourceId = copiedSources.get(factor.source_id);
    if (!copiedSourceId) throw new ResearchRevisionError("A factor's cited source was not copied.");
    copiedFactors.set(factor.id, copiedId);
    originMap.factors[copiedId] = {
      originalId: factor.id,
      originalRunId: factor.research_run_id,
      contentSha256: sha256(canonicalJson({
        subject: factor.subject, behavior: factor.behavior, quote: factor.quote,
        sourceId: factor.source_id, modelConfidence: factor.model_confidence,
        uncertainty: factor.uncertainty, sourceRole: factor.source_role,
        audienceFit: factor.audience_fit, independentSourceKey: factor.independent_source_key,
        supportsDemand: factor.supports_demand, demandEvidenceUncertainty: factor.demand_evidence_uncertainty,
      })),
    };
    db.prepare(`INSERT INTO factors
      (id, research_run_id, subject, behavior, quote, source_id, harvest_mode,
        model_confidence, uncertainty, source_role, audience_fit, independent_source_key,
        supports_demand, demand_evidence_uncertainty, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(copiedId, runId, factor.subject, factor.behavior, factor.quote, copiedSourceId,
        factor.harvest_mode, factor.model_confidence, factor.uncertainty, factor.source_role,
        factor.audience_fit, factor.independent_source_key, factor.supports_demand,
        factor.demand_evidence_uncertainty, now);
  }

  const copiedProblems: string[] = [];
  for (const problem of problems) {
    const copiedId = randomUUID();
    copiedProblems.push(copiedId);
    const originalVerdictSources = verdictSources.get(problem.id) ?? [];
    const buyerFactorIds = parseIdArray(problem.intended_buyer_evidence_factor_ids_json);
    const originalFactorIds = [...new Set([
      ...(factorIdsByProblem.get(problem.id) ?? []),
      ...(problem.scale_basis_factor_id ? [problem.scale_basis_factor_id] : []),
      ...buyerFactorIds,
    ])];
    const originalSourceIds = [...originalVerdictSources, ...originalFactorIds.map((id) => {
      const factor = factorRows.get(id);
      if (!factor) throw new ResearchRevisionError("An original problem factor is missing.");
      return factor.source_id;
    })];
    const copiedVerdictSources = originalVerdictSources.map((id) => {
      const copied = copiedSources.get(id);
      if (!copied) throw new ResearchRevisionError("A verdict's cited source was not copied.");
      return copied;
    });
    const copiedScaleBasis = problem.scale_basis_factor_id
      ? copiedFactors.get(problem.scale_basis_factor_id) ?? null : null;
    const copiedBuyerFactors = buyerFactorIds.map((id) => {
      const copied = copiedFactors.get(id);
      if (!copied) throw new ResearchRevisionError("A buyer-evidence factor was not copied.");
      return copied;
    });
    originMap.problems[copiedId] = {
      originalId: problem.id,
      originalRunId: problem.discovery_run_id,
      contentSha256: sha256(canonicalJson({
        statement: problem.statement, whyItPersists: problem.why_it_persists,
        affected: problem.affected, scaleEstimate: problem.scale_estimate,
        scaleBasisFactorId: problem.scale_basis_factor_id, verdict: problem.verdict,
        verdictReason: problem.verdict_reason, verdictSourceIds: originalSourceIds,
        factorIds: originalFactorIds,
        intendedBuyerEvidenceFactorIds: buyerFactorIds,
        evidenceGap: problem.evidence_gap, briefFit: problem.brief_fit,
        contraryEvidence: problem.contrary_evidence, workflowKey: problem.workflow_key,
      })),
    };
    db.prepare(`INSERT INTO problems
      (id, discovery_run_id, statement, why_it_persists, affected, scale_estimate,
        scale_basis_factor_id, verdict, verdict_reason, verdict_source_ids_json,
        intended_buyer_evidence_factor_ids_json, evidence_gap, brief_fit,
        contrary_evidence, workflow_key, selected_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`)
      .run(copiedId, runId, problem.statement, problem.why_it_persists, problem.affected,
        problem.scale_estimate, copiedScaleBasis, problem.verdict, problem.verdict_reason,
        "[]", JSON.stringify(copiedBuyerFactors), problem.evidence_gap,
        problem.brief_fit, problem.contrary_evidence, problem.workflow_key, now);
    for (const factorId of factorIdsByProblem.get(problem.id) ?? []) {
      const copied = copiedFactors.get(factorId);
      if (!copied) throw new ResearchRevisionError("A problem's cited factor was not copied.");
      db.prepare("INSERT INTO problem_factors (problem_id, factor_id) VALUES (?, ?)").run(copiedId, copied);
    }
    copiedVerdictSources.forEach((sourceId, position) => {
      db.prepare(`INSERT INTO problem_verdict_sources
        (problem_id, source_id, research_run_id, position) VALUES (?, ?, ?, ?)`)
        .run(copiedId, sourceId, runId, position);
    });
  }
  return { runId, problemIds: copiedProblems, originMap };
}

function parseIdArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((id) => typeof id === "string")) return parsed;
  } catch { /* Saved legacy rows may carry malformed JSON. */ }
  throw new ResearchRevisionError("Saved evidence IDs are invalid.");
}
