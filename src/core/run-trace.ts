import { createHash } from "node:crypto";
import { summarizeRunUsage } from "../backend/run-usage";
import type { DatabaseClient } from "../db/client";
import { WorkflowSearchAttemptSchema, WorkflowSearchTerminalSchema, type WorkflowSearchAttempt } from "./workflow-search-attempts";
import { workflowSearchKey as savedSearchKey } from "../shared/content-identity";
import { DISCOVERY_DEPTHS, SOURCE_MAX_CHARACTERS } from "../shared/discovery-projection";
import { AppError } from "../shared/errors";
import { RunTraceSchema, RunTraceStepDetailSchema, type RunTrace, type RunTraceCandidate,
  type RunTraceSearch, type RunTraceStep, type RunTraceStepDetail } from "../shared/run-trace";

type TraceDatabase = Pick<DatabaseClient, "db">;
export interface RunTraceOptions { liveReasoningSummary?: (generationId: string) => string | null }
interface RunRow { id: string; thread_id: string; workflow_session_id: string | null; status: string;
  purpose: string | null; created_at: string; updated_at: string; config_json: string }
interface StageRow { id: string; research_run_id: string; stage_id: string; selection_key: string; completed_at: string;
  prompt_filename: string; prompt_source: string; prompt_sha256: string; stage_revision: number }
interface AttemptRow { id: string; research_run_id: string; generation_id: string; stage_key: string; provider_id: string;
  model_id: string; reasoning_effort: string; status: string; created_at: string; terminal_at: string | null;
  terminal_kind: string | null;
  usage_json: string | null; reported_cost_usd: number | null; error_code: string | null;
  error_message: string | null; attempt_metadata_json: string | null }
interface SourceRow { id: string; canonical_url: string; title: string }
interface FactorRow { id: string; source_id: string; subject: string; behavior: string; quote: string;
  source_role: string; audience_fit: string; independent_source_key: string | null; harvest_mode: string; area_id?: string | null }
interface ProblemRow { id: string; statement: string; verdict: string; verdict_reason: string;
  factor_assessments_json: string; intended_buyer_evidence_factor_ids_json: string; area_id?: string | null }
interface SnapshotRow { research_run_id: string; snapshot_key: string; value_json: string }
interface SearchAttempt { runId: string; receipt: WorkflowSearchAttempt;
  terminal: ReturnType<typeof WorkflowSearchTerminalSchema.parse> | null }
interface InvestigatorSearchRow { id: string; stage_key: string; status: string; input_json: string;
  result_json: string | null; model_json: string; prepared_at: string; dispatched_at: string | null;
  completed_at: string | null; error_message: string | null }

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function json(value: string | null): unknown { return value === null ? null : JSON.parse(value) as unknown; }
function objects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function matchesPlannedQuery(query: Record<string, unknown>, searched: string): boolean {
  const normalized = searched.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  const variants = [text(query.query), ...objects(query.translations).map(translation => text(translation.query))];
  return variants.some(variant => variant.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase() === normalized);
}
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []; }
function duration(start: string | null, end: string | null): number {
  const elapsed = start ? Date.parse(end ?? new Date().toISOString()) - Date.parse(start) : 0;
  return Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
}
function countBy(values: readonly string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}

/** Missing assessments remain unknown. A generator's must-have flag cannot override the approved criterion. */
export function countAcceptedIdeasFailingMustHave(accepted: ReadonlyArray<{
  criteriaFit: ReadonlyArray<{ criterionId: string; status: string }> | null;
  successCriteria: ReadonlyArray<{ id: string; weight: string }> | null;
}>, goalFitContractPresent: boolean): number | null {
  if (!goalFitContractPresent) return null;
  let failures = 0;
  for (const idea of accepted) {
    if (!idea.criteriaFit || !idea.successCriteria) return null;
    if (idea.successCriteria.some(criterion => !idea.criteriaFit?.some(fit => fit.criterionId === criterion.id))) return null;
    if (idea.successCriteria.some(criterion => criterion.weight === "must"
      && idea.criteriaFit?.some(fit => fit.criterionId === criterion.id && fit.status === "fails"))) failures++;
  }
  return failures;
}
function hostIs(host: string, domains: readonly string[]): boolean {
  return domains.some(domain => host === domain || host.endsWith(`.${domain}`));
}

/** URL classes describe the venue, never the truth or independence of a quote. Unknown stays explicit. */
export function classifyTraceSource(url: string): "forum" | "review" | "study" | "official" | "vendor" | "content-farm" | "unknown" {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return "unknown"; }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (hostIs(host, ["zipdo.co", "gitnux.org", "worldmetrics.org", "wifitalents.com", "scoop.market.us", "electroiq.com", "coolest-gadgets.com"])) return "content-farm";
  if (hostIs(host, ["reddit.com", "news.ycombinator.com", "quora.com", "stackoverflow.com", "stackexchange.com", "discourse.org", "x.com", "twitter.com", "bsky.app", "mastodon.social"])
    || /(^|\.)(forum|forums|community|communities)\./.test(host)
    || hostIs(host, ["github.com", "gitlab.com"]) && /\/(issues|discussions)(\/|$)/.test(parsed.pathname)) return "forum";
  if (hostIs(host, ["g2.com", "capterra.com", "trustpilot.com", "trustradius.com", "getapp.com", "softwareadvice.com", "yelp.com"])) return "review";
  if (hostIs(host, ["pubmed.ncbi.nlm.nih.gov", "pmc.ncbi.nlm.nih.gov", "arxiv.org", "doi.org", "nature.com", "sciencedirect.com", "springer.com", "journals.plos.org", "bmj.com", "thelancet.com", "semanticscholar.org", "scholar.google.com"])) return "study";
  if (/(^|\.)gov(\.[a-z]{2})?$/.test(host) || /\.gov\.[a-z]{2}$/.test(host)
    || hostIs(host, ["europa.eu", "who.int", "un.org", "worldbank.org", "oecd.org", "unesco.org", "ons.gov.uk"])) return "official";
  if (hostIs(host, ["shopify.com", "salesforce.com", "zendesk.com", "hubspot.com", "quickbooks.intuit.com", "xero.com", "microsoft.com", "atlassian.com"])) return "vendor";
  return "unknown";
}

export { workflowSearchKey as savedSearchKey } from "../shared/content-identity";

/** Frame preparation shares the discovery purpose, but its context sources are not research evidence. */
export function selectSessionEvidenceRunId(db: TraceDatabase, sessionId: string): string | null {
  const run = db.db.prepare(`SELECT run.id FROM research_runs run
    WHERE run.workflow_session_id = ? AND run.purpose = 'discovery'
      AND NOT EXISTS (SELECT 1 FROM workflow_snapshots snapshot WHERE snapshot.research_run_id = run.id
        AND snapshot.snapshot_key = 'workflow-kind' AND json_extract(snapshot.value_json, '$.kind') = 'prepare-frame')
      AND NOT EXISTS (SELECT 1 FROM workflow_work_items work WHERE work.session_id = run.workflow_session_id
        AND work.kind = 'prepare-frame' AND json_extract(work.output_refs_json, '$.runId') = run.id)
    ORDER BY run.created_at, run.rowid LIMIT 1`).get(sessionId) as { id: string } | undefined;
  return run?.id ?? null;
}

function load(db: TraceDatabase, runId: string) {
  const run = db.db.prepare("SELECT id, thread_id, workflow_session_id, status, purpose, created_at, updated_at, config_json FROM research_runs WHERE id = ?")
    .get(runId) as RunRow | undefined;
  if (!run) throw new AppError("not_found", "Run not found.");
  // A workflow's research and idea tasks have separate research_run IDs. Show their shared session together.
  const runIds = run.workflow_session_id ? (db.db.prepare("SELECT id FROM research_runs WHERE workflow_session_id = ? ORDER BY created_at, rowid")
    .all(run.workflow_session_id) as Array<{ id: string }>).map(item => item.id) : [runId];
  const placeholders = runIds.map(() => "?").join(",");
  // When the latest task is idea generation, retain the discovery task's evidence in its trace.
  const evidenceRunId = (run.workflow_session_id ? selectSessionEvidenceRunId(db, run.workflow_session_id) : null) ?? runId;
  const session = run.workflow_session_id ? db.db.prepare("SELECT state, started_at, finished_at FROM workflow_sessions WHERE id = ?")
    .get(run.workflow_session_id) as { state: string; started_at: string; finished_at: string | null } | undefined : undefined;
  const stages = db.db.prepare(`SELECT id, research_run_id, stage_id, selection_key, completed_at, prompt_filename, prompt_source, prompt_sha256, stage_revision
    FROM stage_results WHERE research_run_id IN (${placeholders}) ORDER BY completed_at, rowid`).all(...runIds) as StageRow[];
  const attempts = db.db.prepare(`SELECT id, research_run_id, generation_id, stage_key, provider_id, model_id, reasoning_effort, status,
    created_at, terminal_at, terminal_kind, usage_json, reported_cost_usd, error_code, error_message, attempt_metadata_json
    FROM generation_attempts WHERE research_run_id IN (${placeholders}) ORDER BY created_at, rowid`).all(...runIds) as AttemptRow[];
  const sources = db.db.prepare("SELECT id, canonical_url, title FROM sources WHERE research_run_id = ? ORDER BY rowid").all(evidenceRunId) as SourceRow[];
  const factors = db.db.prepare("SELECT * FROM factors WHERE research_run_id = ? ORDER BY rowid").all(evidenceRunId) as FactorRow[];
  const problems = db.db.prepare("SELECT * FROM problems WHERE discovery_run_id = ? ORDER BY rowid").all(evidenceRunId) as ProblemRow[];
  const snapshots = db.db.prepare(`SELECT research_run_id, snapshot_key, value_json FROM workflow_snapshots WHERE research_run_id IN (${placeholders}) ORDER BY rowid`).all(...runIds) as SnapshotRow[];
  const searchAttempts: SearchAttempt[] = snapshots.filter(snapshot => snapshot.snapshot_key.startsWith("search-attempt:")).map(snapshot => {
    const receipt = WorkflowSearchAttemptSchema.parse(json(snapshot.value_json));
    const terminal = snapshots.find(item => item.research_run_id === snapshot.research_run_id && item.snapshot_key === `search-terminal:${receipt.id}`);
    return { runId: snapshot.research_run_id, receipt, terminal: terminal ? WorkflowSearchTerminalSchema.parse(json(terminal.value_json)) : null };
  });
  const outputs = db.db.prepare(`SELECT id, stage_id, selection_key, output_json, context_json FROM stage_results
    WHERE research_run_id IN (${placeholders}) AND stage_id IN ('query-plan','frame-search-plan','problem-candidates','solution-set-review') ORDER BY completed_at, rowid`)
    .all(...runIds) as Array<{ id: string; stage_id: string; selection_key: string; output_json: string; context_json: string }>;
  const frameTable = db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'research_frames'").get();
  const frames = frameTable ? db.db.prepare(`SELECT run.id AS run_id, frame.approved_json FROM research_runs run
    JOIN research_frames frame ON frame.id = run.frame_id WHERE run.id IN (${placeholders})`).all(...runIds) as
    Array<{ run_id: string; approved_json: string | null }> : [];
  const areas = new Map<string, { id: string; name: string }>();
  for (const frame of frames) for (const area of objects(record(json(frame.approved_json)).areas)) {
    if (text(area.id)) areas.set(text(area.id), { id: text(area.id), name: text(area.name) || text(area.id) });
  }
  for (const snapshot of snapshots.filter(snapshot => snapshot.snapshot_key === "frame-selected-areas")) {
    for (const area of objects(json(snapshot.value_json))) if (text(area.id)) areas.set(text(area.id), { id: text(area.id), name: text(area.name) || text(area.id) });
  }
  const investigatorSearches = run.workflow_session_id ? db.db.prepare(`SELECT attempt.id, attempt.stage_key, attempt.status, attempt.input_json,
    attempt.result_json, attempt.model_json, attempt.prepared_at, attempt.dispatched_at, attempt.completed_at, attempt.error_message
    FROM opportunity_exploration_attempts attempt JOIN workflow_work_items work ON work.id = attempt.work_item_id
    WHERE work.session_id = ? AND attempt.stage_name = 'investigator-search' ORDER BY attempt.prepared_at, attempt.rowid`)
    .all(run.workflow_session_id) as InvestigatorSearchRow[] : [];
  return { db, run, evidenceRunId, session, runIds, placeholders, stages, attempts, sources, factors, problems, snapshots, searchAttempts, outputs, frames, areas, investigatorSearches };
}
type TraceData = ReturnType<typeof load>;

function investigatorResultKeys(attempt: InvestigatorSearchRow): string[] {
  const input = record(json(attempt.input_json));
  const parameters = record(input.parameters);
  const query = text(record(input.request).query);
  const provider = text(record(json(attempt.model_json)).providerId);
  // Ordinary searches store the provider beside parameters; managed inputs keep it inside them.
  const { provider: _provider, ...ordinaryParameters } = parameters;
  void _provider;
  return [attempt.stage_key, savedSearchKey(query, parameters), savedSearchKey(query, ordinaryParameters, provider)];
}

/** Receipts count physical dispatches. Successful old checkpoints fill only gaps with no receipt. */
function searchCallCount(data: TraceData, legacyCount: number | null | undefined): number {
  const managedKeys = new Set(data.investigatorSearches.filter(attempt => attempt.dispatched_at !== null).flatMap(investigatorResultKeys));
  const legacyResults = data.snapshots.filter(snapshot => snapshot.snapshot_key.startsWith("search:")
    && !data.searchAttempts.some(attempt => attempt.runId === snapshot.research_run_id && attempt.receipt.key === snapshot.snapshot_key)
    && !managedKeys.has(snapshot.snapshot_key));
  const calls = data.searchAttempts.length + data.investigatorSearches.filter(attempt => attempt.dispatched_at !== null).length
    + legacyResults.length;
  return data.searchAttempts.length || data.investigatorSearches.length || legacyResults.length ? calls : legacyCount ?? 0;
}

/** Only committed final decisions count. Older checkpoints can still use their raw review output. */
function acceptedReviewSolutions(data: TraceData): Set<string> {
  const accepted = new Set<string>();
  for (const output of data.outputs.filter(output => output.stage_id === "solution-set-review"
    && !output.selection_key.startsWith("preliminary:"))) {
    const context = record(json(output.context_json));
    const classified = context.solutionSetReview;
    if (classified !== null && typeof classified === "object" && !Array.isArray(classified)) {
      const review = record(classified);
      const ids = Array.isArray(review.decisions)
        ? objects(review.decisions).filter(decision => decision.status === "accepted").map(decision => text(decision.candidateId))
        : strings(review.acceptedSolutionIds);
      for (const id of ids) if (id) accepted.add(id);
      continue;
    }
    const review = record(json(output.output_json));
    for (const decision of objects(review.assessments ?? review.decisions ?? review.reviews)) {
      if (!["accept", "distinct"].includes(text(decision.decision)) && decision.status !== "accepted") continue;
      const id = text(decision.candidateId ?? decision.solutionId ?? decision.optionId);
      if (id) accepted.add(id);
    }
    for (const id of strings(review.acceptedSolutionIds ?? review.acceptedOptionIds)) if (id) accepted.add(id);
  }
  return accepted;
}

function investigatorArea(data: TraceData, key: string): string | null {
  for (const area of data.areas.values()) {
    const hash = createHash("sha256").update(area.id).digest("hex").slice(0, 16);
    if (key.includes(`:area-${hash}:`) || key.includes(`:scan-${hash}:`) || key.includes(`:${area.id}:`) || key.endsWith(`:${area.id}`)) return area.id;
  }
  return null;
}

function goalFitFailures(data: TraceData, accepted: ReadonlySet<string>): number | null {
  const columns = data.db.db.prepare("PRAGMA table_info(solutions)").all() as Array<{ name: string }>;
  const hasFit = columns.some(column => column.name === "criteria_fit_json");
  const hasReviewedFit = columns.some(column => column.name === "reviewed_criteria_fit_json");
  if (!hasFit) return null;
  const goalFitContract = data.frames.some(frame => frame.approved_json !== null)
    && (data.snapshots.some(snapshot => ["goal-fit", "goal-fit-contract", "goal-fit-ideas"].includes(snapshot.snapshot_key)
      && record(json(snapshot.value_json)).version === 1) || data.stages.some(stage => stage.stage_id === "solutions" && stage.stage_revision >= 2));
  const rows = data.db.db.prepare(`SELECT id, research_run_id, criteria_fit_json${hasReviewedFit ? ", reviewed_criteria_fit_json" : ""}
    FROM solutions WHERE research_run_id IN (${data.placeholders})`).all(...data.runIds) as
    Array<{ id: string; research_run_id: string; criteria_fit_json: string | null; reviewed_criteria_fit_json?: string | null }>;
  const acceptedRows = rows.filter(row => accepted.has(row.id));
  if (acceptedRows.length !== accepted.size) return null;
  return countAcceptedIdeasFailingMustHave(acceptedRows.map(row => {
    const frame = data.frames.find(frame => frame.run_id === row.research_run_id);
    const fit = json(row.reviewed_criteria_fit_json ?? row.criteria_fit_json);
    const criteria = frame ? record(json(frame.approved_json)).successCriteria : null;
    return { criteriaFit: Array.isArray(fit) ? objects(fit).map(item => ({ criterionId: text(item.criterionId), status: text(item.status) })) : null,
      successCriteria: Array.isArray(criteria) ? objects(criteria).map(item => ({ id: text(item.id), weight: text(item.weight) })) : null };
  }), goalFitContract);
}

function candidates(data: TraceData): RunTraceCandidate[] {
  const links = data.db.db.prepare(`SELECT pf.problem_id, pf.factor_id FROM problem_factors pf JOIN problems p ON p.id = pf.problem_id
    WHERE p.discovery_run_id = ?`).all(data.evidenceRunId) as Array<{ problem_id: string; factor_id: string }>;
  const byFactor = new Map(data.factors.map(factor => [factor.id, factor]));
  const result = data.problems.map((problem): RunTraceCandidate => {
    const assessments = objects(json(problem.factor_assessments_json));
    const assessmentById = new Map(assessments.map(assessment => [text(assessment.factorId), assessment]));
    const factorIds = links.filter(link => link.problem_id === problem.id).map(link => link.factor_id);
    const qualifying = factorIds.flatMap(id => {
      const factor = byFactor.get(id);
      if (!factor) return [];
      const assessment = assessmentById.get(id);
      const role = assessment ? text(assessment.sourceRole) : factor.source_role;
      const fit = assessment ? text(assessment.audienceFit) : factor.audience_fit;
      const key = assessment ? text(assessment.independentSourceKey) : factor.independent_source_key;
      return (role === "firsthand" || role === "measured") && fit === "intended-buyer" ? [{ id, key }] : [];
    });
    return { id: problem.id, statement: problem.statement,
      state: problem.verdict === "confirmed" ? "confirmed" : problem.verdict === "insufficient-evidence" ? "insufficient"
        : problem.verdict === "user-asserted" ? "user-asserted" : "dropped",
      reason: problem.verdict_reason, derived: false, factorIds, qualifyingObservations: qualifying.length,
      independentSources: new Set(qualifying.map(item => item.key).filter(Boolean)).size, assessments, candidate: null };
  });
  const rejected = data.db.db.prepare("SELECT * FROM rejected_problem_candidates WHERE discovery_run_id = ? ORDER BY rowid")
    .all(data.evidenceRunId) as Array<{ id: string; statement: string; reason: string; disposition?: string; candidate_json?: string | null }>;
  result.push(...rejected.map((item): RunTraceCandidate => ({ id: item.id, statement: item.statement,
    state: item.disposition === "not-assessed" ? "not-assessed" : "dropped", reason: item.reason, derived: false,
    factorIds: strings(record(json(item.candidate_json ?? null)).factorIds), qualifyingObservations: 0,
    independentSources: 0, assessments: [], candidate: json(item.candidate_json ?? null) })));
  const seen = new Set(result.map(candidate => candidate.statement.trim()));
  const verdicts = data.db.db.prepare(`SELECT selection_key, output_json,
    json_extract(evidence_json, '$[0].content.candidate.statement') AS statement
    FROM stage_results WHERE research_run_id IN (${data.placeholders}) AND stage_id = 'problem-kill' ORDER BY completed_at, rowid`)
    .all(...data.runIds) as Array<{ selection_key: string; output_json: string; statement: string | null }>;
  for (const output of data.outputs.filter(stage => stage.stage_id === "problem-candidates")) {
    for (const [index, candidate] of objects(record(json(output.output_json)).problems).entries()) {
      const statement = text(candidate.statement).trim();
      if (!statement || seen.has(statement)) continue;
      // A completed verdict is durable even when domain materialization was interrupted.
      const verdict = verdicts.find(verdict => verdict.statement?.trim() === statement);
      const reviewed = record(json(verdict?.output_json ?? null));
      const assessments = objects(reviewed.factorAssessments);
      const claimed = strings(reviewed.intendedBuyerEvidenceFactorIds);
      const qualifying = strings(candidate.factorIds).flatMap(id => {
        const factor = byFactor.get(id);
        if (!factor || !claimed.includes(id)) return [];
        const assessment = assessments.find(assessment => assessment.factorId === id);
        const role = assessment ? text(assessment.sourceRole) : factor.source_role;
        const fit = assessment ? text(assessment.audienceFit) : factor.audience_fit;
        return ["firsthand", "measured"].includes(role) && fit === "intended-buyer"
          ? [{ key: assessment ? text(assessment.independentSourceKey) : factor.independent_source_key }] : [];
      });
      const independentSources = new Set(qualifying.map(factor => factor.key).filter(Boolean)).size;
      const guardedVerdict = reviewed.verdict === "confirmed" && independentSources < 2 ? "insufficient-evidence" : reviewed.verdict;
      result.push({ id: `derived:${output.id}:${index}`, statement,
        state: verdict ? guardedVerdict === "confirmed" ? "confirmed" : guardedVerdict === "insufficient-evidence" ? "insufficient" : "dropped" : "not-assessed",
        reason: verdict ? `${reviewed.verdict === "confirmed" && independentSources < 2 ? "Saved model verdict lacks two independent qualifying sources. " : ""}${text(reviewed.verdictReason)}`
          : "No saved verdict for this candidate. Older runs did not record candidates beyond the assessment limit.",
        derived: true, factorIds: strings(candidate.factorIds), qualifyingObservations: qualifying.length, independentSources,
        assessments, candidate });
      seen.add(statement);
    }
  }
  return result;
}

function searchResults(data: TraceData, value: string | null): RunTraceSearch["results"] {
  return objects(json(value)).map(item => {
    const url = text(item.url) || text(item.canonicalUrl);
    const source = data.sources.find(source => source.canonical_url === url);
    return { sourceId: source?.id ?? null, url, title: text(item.title), sourceClass: classifyTraceSource(url),
      factsKept: source ? data.factors.filter(factor => factor.source_id === source.id).length : 0 };
  });
}

function searches(data: TraceData): RunTraceSearch[] {
  const config = record(json(data.run.config_json));
  const depth = config.discoveryDepth === "quick" || config.discoveryDepth === "deep" ? config.discoveryDepth : "standard";
  const parameters = { numResults: DISCOVERY_DEPTHS[depth].searchResultsPerQuery, maxCharacters: SOURCE_MAX_CHARACTERS };
  const saved = new Map(data.snapshots.map(snapshot => [snapshot.snapshot_key, snapshot.value_json]));
  const querySnapshots: Array<Record<string, unknown> & { key: string }> = data.snapshots.filter(snapshot => snapshot.snapshot_key.startsWith("search-query:"))
    .map(snapshot => ({ ...record(json(snapshot.value_json)), key: snapshot.snapshot_key.replace("search-query:", "search:") }));
  const normalized = (query: string) => query.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  const queries: Array<{ query: string; intent: string; reason: string; expectedSourceType: string; parameters: Record<string, unknown>; key: string; provider: string | null; route: string | null }> = [];
  for (const stage of data.outputs.filter(stage => stage.stage_id === "query-plan" || stage.stage_id === "frame-search-plan")) {
    for (const query of objects(record(json(stage.output_json)).queries)) {
      const queryText = text(query.query);
      const recordedLegs = querySnapshots.filter(snapshot => matchesPlannedQuery(query, text(snapshot.query)));
      if (recordedLegs.length) {
        for (const snapshot of recordedLegs) queries.push({ query: text(snapshot.query), intent: text(query.intent) || "unclassified",
          reason: text(query.reason) || text(query.uncertainty) || "Search recorded by the workflow.",
          expectedSourceType: text(query.intendedSourceType) || "Not recorded", key: snapshot.key,
          parameters: record(snapshot.parameters), provider: text(snapshot.provider) || text(config.searchProvider) || null,
          route: text(snapshot.route) || text(record(snapshot.parameters).route) || null });
        continue;
      }
      const choices = [parameters, { ...parameters, includeDomains: [] }, { ...parameters, includeDomains: ["reddit.com", "news.ycombinator.com"] }];
      const fallback = stage.selection_key.includes("audience") ? config.audienceSourcePolicy === "communities" ? choices[2]! : choices[1]! : choices[0]!;
      const matched = [fallback, ...choices].find(choice => saved.has(savedSearchKey(queryText, choice)));
      const selected = matched ?? fallback;
      queries.push({ query: queryText, intent: text(query.intent) || "unclassified", reason: text(query.reason) || text(query.uncertainty) || "Search recorded by the workflow.",
        expectedSourceType: text(query.intendedSourceType) || "Not recorded", parameters: selected, key: savedSearchKey(queryText, selected), provider: text(config.searchProvider) || null, route: null });
    }
  }
  for (const candidate of candidates(data).filter(candidate => candidate.state !== "not-assessed" && candidate.state !== "user-asserted")) {
    const query = `${candidate.statement} already solved widespread self-correcting attempted failed shutdown`;
    const key = savedSearchKey(query, parameters);
    if (saved.has(key)) queries.push({ query, key, parameters, intent: "contrary-evidence", reason: "Check contrary evidence before the verdict.", expectedSourceType: "Independent accounts of existing solutions, scale and failed attempts.", provider: text(config.searchProvider) || null, route: null });
  }
  for (const snapshot of data.snapshots.filter(snapshot => snapshot.snapshot_key.startsWith("search-query:"))) {
    const item = record(json(snapshot.value_json));
    const key = text(item.key) || snapshot.snapshot_key.replace("search-query:", "search:");
    const existing = queries.find(query => query.key === key);
    if (existing) { existing.provider = text(item.provider) || existing.provider; existing.route = text(item.route) || text(record(item.parameters).route) || existing.route; continue; }
    const contrary = record(item.parameters).route === "contrary";
    queries.push({ query: text(item.query), key, parameters: record(item.parameters), intent: text(item.intent) || (contrary ? "contrary-evidence" : "unclassified"),
      reason: text(item.reason) || (contrary ? "Check contrary evidence before the verdict." : "Search recorded by the workflow."),
      expectedSourceType: text(item.expectedSourceType) || (contrary ? "Independent accounts of existing solutions, scale and failed attempts." : "Not recorded"),
      provider: text(item.provider) || text(config.searchProvider) || null, route: text(item.route) || text(record(item.parameters).route) || null });
  }
  for (const attempt of data.investigatorSearches) {
    const input = record(json(attempt.input_json));
    const request = record(input.request);
    const matching = queries.find(query => normalized(query.query) === normalized(text(request.query)) && query.route === text(request.route));
    if (matching) { matching.reason = text(request.evidenceNeeded); matching.expectedSourceType = text(request.route); }
    const parameters = { ...record(input.parameters), areaId: investigatorArea(data, attempt.stage_key) };
    const provider = text(record(json(attempt.model_json)).providerId) || null;
    queries.push({ key: attempt.stage_key, query: text(request.query), intent: "evidence-gap", reason: text(request.evidenceNeeded),
      expectedSourceType: text(request.route), provider, route: text(request.route) || null, parameters });
    if (attempt.status === "completed") saved.set(attempt.stage_key, JSON.stringify(record(json(attempt.result_json)).sources ?? []));
  }
  for (const snapshot of data.snapshots.filter(snapshot => snapshot.snapshot_key.startsWith("search:"))) {
    if (!queries.some(query => query.key === snapshot.snapshot_key)) queries.push({ query: "Query not recorded in this older run", key: snapshot.snapshot_key,
      parameters: {}, intent: "unclassified", reason: "No matching query plan or query snapshot was saved.", expectedSourceType: "Not recorded", provider: text(config.searchProvider) || null, route: null });
  }
  return [...new Map(queries.map(query => [query.key, query])).values()].map(query => {
    return { ...query, status: saved.has(query.key) ? "completed" as const : "not-saved" as const,
      results: searchResults(data, saved.get(query.key) ?? null) };
  });
}

function steps(data: TraceData, options: RunTraceOptions): RunTraceStep[] {
  const entries = [...data.attempts.map(attempt => ({ runId: attempt.research_run_id, key: attempt.stage_key })),
    ...data.stages.map(stage => ({ runId: stage.research_run_id, key: `${stage.stage_id}${stage.selection_key ? `:${stage.selection_key}` : ""}` }))];
  const keys = [...new Map(entries.map(entry => [`${entry.runId}:${entry.key}`, entry])).values()];
  const result = keys.map(({ runId, key }): RunTraceStep => {
    const stage = data.stages.find(stage => stage.research_run_id === runId && `${stage.stage_id}${stage.selection_key ? `:${stage.selection_key}` : ""}` === key);
    const attempts = data.attempts.filter(attempt => attempt.research_run_id === runId && attempt.stage_key === key).map(attempt => {
      const usage = record(json(attempt.usage_json));
      const tokens = usage.status === "known" ? record(usage.value) : {};
      const metadata = record(json(attempt.attempt_metadata_json));
      const token = (name: string) => typeof tokens[name] === "number" ? tokens[name] as number : null;
      return { id: attempt.id, status: attempt.status, provider: attempt.provider_id, model: attempt.model_id, effort: attempt.reasoning_effort,
        startedAt: attempt.created_at, finishedAt: attempt.terminal_at, durationMs: duration(attempt.created_at, attempt.terminal_at),
        inputTokens: token("inputTokens"), outputTokens: token("outputTokens"), reasoningTokens: token("reasoningTokens"),
        costUsd: attempt.reported_cost_usd, errorCode: attempt.error_code, message: attempt.error_message,
        reasoningSummary: text(metadata.reasoningSummary) || options.liveReasoningSummary?.(attempt.generation_id) || null };
    });
    const first = attempts[0];
    const last = attempts.at(-1);
    const phase = investigatorArea(data, key) ?? (key.includes("audience") ? "audience" : key.includes("domain") ? "domain" : null);
    const savedPrompts = data.snapshots.find(snapshot => snapshot.snapshot_key === "prompts");
    const savedPrompt = record(record(json(savedPrompts?.value_json ?? null))[key.split(":")[0]!]);
    return { id: stage?.id ?? `attempt:${first?.id ?? key}`, kind: "model", stage: key, label: key.split(":")[0]!.replaceAll("-", " "),
      phase, status: stage ? "completed" : last?.status ?? "not-started", startedAt: first?.startedAt ?? stage?.completed_at ?? null,
      finishedAt: stage?.completed_at ?? last?.finishedAt ?? null, durationMs: attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0),
      attempts, prompt: stage ? { filename: stage.prompt_filename, source: stage.prompt_source, sha256: stage.prompt_sha256 }
        : savedPrompt.filename ? { filename: text(savedPrompt.filename), source: text(savedPrompt.source), sha256: text(savedPrompt.resolvedSha256) } : null, search: null };
  });
  // Saved searches lack timestamps. Keep them alongside their planner, without inventing durations.
  const allSearches = searches(data);
  const managedKeys = new Set(data.investigatorSearches.filter(attempt => attempt.dispatched_at !== null).flatMap(investigatorResultKeys));
  for (const search of allSearches) {
    if (data.searchAttempts.some(attempt => attempt.receipt.key === search.key)
      || managedKeys.has(search.key) && !data.investigatorSearches.some(attempt => attempt.stage_key === search.key)) continue;
    const planner = data.outputs.find(output => (output.stage_id === "query-plan" || output.stage_id === "frame-search-plan")
      && objects(record(json(output.output_json)).queries).some(query => matchesPlannedQuery(query, search.query)));
    const area = text(search.parameters.areaId) || (planner ? investigatorArea(data, `query-plan:${planner.selection_key}`) : null);
    const managed = data.investigatorSearches.find(attempt => attempt.stage_key === search.key);
    result.push({ id: search.key.length > 256 ? `search:${createHash("sha256").update(search.key).digest("hex")}` : search.key,
      kind: "search", stage: search.key, label: search.query,
      phase: area || investigatorArea(data, search.key), status: managed?.status ?? search.status,
      startedAt: managed?.prepared_at ?? null, finishedAt: managed?.completed_at ?? null,
      durationMs: managed ? duration(managed.prepared_at, managed.completed_at) : 0, attempts: [], prompt: null, search });
  }
  for (const attempt of data.searchAttempts) {
    const { receipt, terminal } = attempt;
    const savedSearch = allSearches.find(search => search.key === receipt.key);
    const latestCompleted = data.searchAttempts.filter(item => item.runId === attempt.runId && item.receipt.key === receipt.key
      && item.terminal?.status === "completed").at(-1);
    const savedResult = terminal?.status === "completed" && latestCompleted === attempt ? data.snapshots.find(snapshot =>
      snapshot.research_run_id === attempt.runId && snapshot.snapshot_key === receipt.key) : undefined;
    const search: RunTraceSearch = { ...savedSearch, key: receipt.key, query: receipt.query, parameters: receipt.parameters,
      provider: receipt.provider ?? savedSearch?.provider ?? null, route: text(receipt.parameters.route) || savedSearch?.route || null,
      intent: savedSearch?.intent ?? "unclassified", reason: savedSearch?.reason ?? "Search recorded by the workflow.",
      expectedSourceType: savedSearch?.expectedSourceType ?? "Not recorded", status: savedResult ? "completed" : "not-saved",
      results: searchResults(data, savedResult?.value_json ?? null) };
    const planner = data.outputs.find(output => (output.stage_id === "query-plan" || output.stage_id === "frame-search-plan")
      && objects(record(json(output.output_json)).queries).some(query => matchesPlannedQuery(query, receipt.query)));
    const phase = text(receipt.parameters.areaId) || (planner ? investigatorArea(data, `query-plan:${planner.selection_key}`) : null);
    // A later replacement's checkpoint cannot prove how an earlier lost request ended.
    const step: RunTraceStep = { id: `search-attempt:${receipt.id}`, kind: "search", stage: receipt.key, label: receipt.query,
      phase: phase || null, status: terminal?.status ?? "unknown-dispatch", startedAt: receipt.createdAt,
      finishedAt: terminal?.finishedAt ?? null, durationMs: terminal ? duration(receipt.createdAt, terminal.finishedAt) : 0,
      attempts: [], prompt: null, search };
    result.push(step);
  }
  const items = data.db.db.prepare(`SELECT id, kind, scope_key, state, created_at, finished_at FROM workflow_work_items
    WHERE session_id = ? ORDER BY ordinal, created_at`).all(data.run.workflow_session_id) as Array<{ id: string; kind: string; scope_key: string; state: string; created_at: string; finished_at: string | null }>;
  for (const item of items) result.push({ id: `work:${item.id}`, kind: "work", stage: item.kind, label: item.kind.replaceAll("-", " "), phase: investigatorArea(data, `work:${item.scope_key}`) ?? item.scope_key,
    status: item.state, startedAt: item.created_at, finishedAt: item.finished_at, durationMs: duration(item.created_at, item.finished_at), attempts: [], prompt: null, search: null });
  if (!result.length && (data.factors.length || data.problems.length || data.sources.length)) result.push({ id: "legacy:saved", kind: "work",
    stage: "saved-research", label: "Saved research", phase: null, status: data.run.status, startedAt: data.run.created_at,
    finishedAt: data.run.updated_at, durationMs: duration(data.run.created_at, data.run.updated_at), attempts: [], prompt: null, search: null });
  return result.sort((a, b) => {
    if (a.startedAt && b.startedAt) return a.startedAt.localeCompare(b.startedAt);
    if (a.startedAt) return -1;
    if (b.startedAt) return 1;
    return 0;
  });
}

/** Derive a compact trace without migrations, provider calls, or loading each stage's evidence body. */
export function getRunTrace(db: TraceDatabase, runId: string, options: RunTraceOptions = {}): RunTrace {
  const data = load(db, runId);
  const allCandidates = candidates(data);
  const allSteps = steps(data, options);
  const live = data.session ? ["running", "pause-requested", "stop-requested"].includes(data.session.state)
    : ["running", "queued", "pending", "cancelling"].includes(data.run.status);
  const assessed = allCandidates.filter(candidate => !["not-assessed", "user-asserted"].includes(candidate.state)
    && (candidate.state !== "dropped" || candidate.derived || data.problems.some(problem => problem.id === candidate.id)));
  const confirmed = allCandidates.filter(candidate => candidate.state === "confirmed").length;
  const interruptions = allSteps.flatMap(step => step.attempts).filter(attempt => attempt.status === "interrupted" || ["timeout", "rate-limit"].includes(attempt.errorCode ?? ""));
  const sourceRoles = new Map(data.sources.map(source => [source.id, data.factors.some(factor => factor.source_id === source.id && factor.source_role === "vendor") ? "vendor" : "unknown"]));
  const hasAreas = data.factors.some(factor => factor.area_id) || data.problems.some(problem => problem.area_id);
  const groups = new Map<string, { id: string; factors: number; problems: number; confirmed: number }>();
  for (const factor of data.factors) {
    const id = hasAreas ? factor.area_id ?? "unassigned" : factor.harvest_mode;
    const group = groups.get(id) ?? { id, factors: 0, problems: 0, confirmed: 0 };
    group.factors++; groups.set(id, group);
  }
  const links = data.db.db.prepare(`SELECT pf.problem_id, pf.factor_id FROM problem_factors pf JOIN problems p ON p.id = pf.problem_id
    WHERE p.discovery_run_id = ?`).all(data.evidenceRunId) as Array<{ problem_id: string; factor_id: string }>;
  for (const problem of data.problems) {
    const phases = hasAreas ? [problem.area_id ?? "unassigned"] : [...new Set(links.filter(link => link.problem_id === problem.id)
      .map(link => data.factors.find(factor => factor.id === link.factor_id)?.harvest_mode).filter((phase): phase is string => Boolean(phase)))];
    for (const id of phases) {
      const group = groups.get(id) ?? { id, factors: 0, problems: 0, confirmed: 0 };
      group.problems++; if (problem.verdict === "confirmed") group.confirmed++; groups.set(id, group);
    }
  }
  const ideas = db.db.prepare(`SELECT COUNT(*) AS count FROM solutions WHERE research_run_id IN (${data.placeholders})`).get(...data.runIds) as { count: number };
  const accepted = acceptedReviewSolutions(data);
  const usage = summarizeRunUsage(data.attempts.filter(attempt => attempt.status !== "prepared"));
  const unknownCompletion = data.attempts.some(attempt => attempt.terminal_kind !== "never-dispatched"
    && (["dispatched", "accepted", "interrupted"].includes(attempt.status)
      || objects(record(json(attempt.attempt_metadata_json)).attempts).some(item => item.providerCompletion === "unknown")));
  const legacyCounts = data.attempts.length === 0 ? db.db.prepare(`SELECT
    SUM(CASE WHEN model IS NOT NULL AND operation NOT LIKE '%search%' THEN 1 ELSE 0 END) AS calls,
    SUM(CASE WHEN operation LIKE '%search%' THEN 1 ELSE 0 END) AS searches
    FROM cost_ledger WHERE research_run_id IN (${data.placeholders}) AND status != 'released'`).get(...data.runIds) as
    { calls: number | null; searches: number | null } : null;
  const qualifyingObservations = data.factors.filter(factor => ["firsthand", "measured"].includes(factor.source_role) && factor.audience_fit === "intended-buyer").length;
  const acceptedIdeasFailingMustHave = goalFitFailures(data, accepted);
  const investigators = [...data.areas.values()].flatMap(area => {
    const areaSteps = allSteps.filter(step => step.phase === area.id);
    const current = areaSteps.filter(step => step.kind !== "search").at(-1);
    return areaSteps.length ? [{ ...area, state: current?.status ?? "planned", stepIds: areaSteps.map(step => step.id) }] : [];
  });
  return RunTraceSchema.parse({ runId, threadId: data.run.thread_id, sessionId: data.run.workflow_session_id,
    status: data.session?.state ?? data.run.status, purpose: data.run.purpose ?? "discovery", startedAt: data.session?.started_at ?? data.run.created_at,
    finishedAt: data.session ? data.session.finished_at : live ? null : data.run.updated_at, live, steps: allSteps, investigators, candidates: allCandidates,
    metrics: { factors: data.factors.length, totalSources: data.sources.length,
      evidenceMix: countBy(data.factors.map(factor => factor.source_role)), audienceFit: countBy(data.factors.map(factor => factor.audience_fit)),
      sourceMix: countBy(data.sources.map(source => { const classified = classifyTraceSource(source.canonical_url); return classified === "unknown" ? sourceRoles.get(source.id) ?? "unknown" : classified; })),
      qualifyingObservations, qualifyingPerAssessedCandidate: assessed.length ? assessed.reduce((sum, candidate) => sum + candidate.qualifyingObservations, 0) / assessed.length : null,
      candidateFunnel: { total: allCandidates.length, assessed: assessed.length, confirmed,
        insufficient: allCandidates.filter(candidate => candidate.state === "insufficient").length,
        dropped: allCandidates.filter(candidate => candidate.state === "dropped").length,
        notAssessed: allCandidates.filter(candidate => candidate.state === "not-assessed").length,
        userAsserted: allCandidates.filter(candidate => candidate.state === "user-asserted").length },
      confirmationRate: assessed.length ? confirmed / assessed.length : null,
      coverage: { kind: hasAreas ? "areas" : "phases", groups: [...groups.values()] },
      modelCalls: data.attempts.length ? usage.attemptCount : legacyCounts?.calls ?? 0,
      searches: searchCallCount(data, legacyCounts?.searches),
      wallTimeMs: duration(data.session?.started_at ?? data.run.created_at, live ? null : data.session?.finished_at ?? data.run.updated_at),
      modelTimeMs: allSteps.reduce((sum, step) => sum + (step.kind === "model" ? step.durationMs : 0), 0),
      interruptionTimeMs: interruptions.reduce((sum, attempt) => sum + attempt.durationMs, 0), interruptions: interruptions.length,
      ideas: ideas.count, acceptedIdeas: accepted.size, acceptedIdeasFailingMustHave },
    warnings: [...(allCandidates.some(candidate => candidate.derived) ? ["Some candidate states were derived from older saved outputs."] : []),
      ...(unknownCompletion ? ["Some recorded model attempts have unknown provider completion. They are included in the call count."] : []),
      ...(data.searchAttempts.some(attempt => attempt.terminal === null)
        || data.investigatorSearches.some(attempt => attempt.dispatched_at !== null && ["dispatched", "unknown-dispatch", "failed"].includes(attempt.status))
        ? ["Some recorded search attempts have unknown provider completion. They are included in the search count."] : []),
      ...(accepted.size && data.frames.length && acceptedIdeasFailingMustHave === null
        ? ["Accepted ideas do not all have a saved assessment against the bound frame. Must-have failures are unknown."] : []),
      ...(data.snapshots.some(snapshot => snapshot.snapshot_key.startsWith("search:")) && !data.snapshots.some(snapshot => snapshot.snapshot_key.startsWith("search-query:"))
        ? ["Older search links were reconstructed from saved query plans and parameters. Search timings were not saved."] : [])] });
}

/** Fetch large saved output and evidence only when a step is opened or exported. */
export function getRunTraceStep(db: TraceDatabase, runId: string, stepId: string, options: RunTraceOptions = {}): RunTraceStepDetail {
  const data = load(db, runId);
  const step = steps(data, options).find(step => step.id === stepId);
  if (!step) throw new AppError("not_found", "Trace step not found in this run.");
  const saved = db.db.prepare(`SELECT input_json, output_json, evidence_json FROM stage_results WHERE id = ? AND research_run_id IN (${data.placeholders})`)
    .get(stepId, ...data.runIds) as { input_json: string; output_json: string; evidence_json: string } | undefined;
  const attempt = !saved && step.kind === "model" ? db.db.prepare(`SELECT request_json, output_json FROM generation_attempts
    WHERE research_run_id IN (${data.placeholders}) AND id = ?`).get(...data.runIds, step.attempts.at(-1)?.id) as
    { request_json: string; output_json: string | null } | undefined : undefined;
  const request = record(json(attempt?.request_json ?? null));
  const managedSearch = data.investigatorSearches.find(attempt => attempt.stage_key === step.stage);
  const ordinarySearch = data.searchAttempts.find(attempt => stepId === `search-attempt:${attempt.receipt.id}`);
  const searchOutput = ordinarySearch?.terminal?.status === "completed" && step.search?.status === "completed" ? data.snapshots.find(snapshot =>
    snapshot.research_run_id === ordinarySearch.runId && snapshot.snapshot_key === ordinarySearch.receipt.key) : null;
  const output = json(saved?.output_json ?? attempt?.output_json ?? managedSearch?.result_json ?? searchOutput?.value_json ?? null);
  const evidence = stepId === "legacy:saved" ? db.db.prepare("SELECT * FROM sources WHERE research_run_id = ? ORDER BY rowid").all(runId)
    : saved ? objects(json(saved.evidence_json)) : objects(request.evidence);
  const rawFactors = objects(record(output).factors);
  const facts = stepId === "legacy:saved" ? data.factors.map(factor => ({ id: factor.id, sourceId: factor.source_id,
    subject: factor.subject, behavior: factor.behavior, quote: factor.quote, sourceRole: factor.source_role,
    audienceFit: factor.audience_fit, kept: true, reason: null })) : rawFactors.map(factor => {
    const sourceId = text(factor.sourceId);
    const quote = text(factor.quote);
    const kept = data.factors.find(savedFactor => savedFactor.source_id === sourceId && savedFactor.quote === quote);
    const source = db.db.prepare(`SELECT retrieved_text FROM sources WHERE id = ? AND research_run_id IN (${data.placeholders})`).get(sourceId, ...data.runIds) as { retrieved_text: string } | undefined;
    const settled = !["running", "queued", "pending"].includes(data.run.status);
    return { id: kept?.id ?? null, sourceId, subject: text(factor.subject), behavior: text(factor.behavior), quote,
      sourceRole: text(factor.sourceRole) || "unknown", audienceFit: text(factor.audienceFit) || "unknown", kept: kept ? true : settled ? false : null,
      reason: kept ? null : source && !source.retrieved_text.includes(quote) ? "Quote does not occur in the saved source text."
        : !source ? "No persisted source with this ID." : settled ? "Not kept after validation, deduplication or the saved factor limit." : "Materialization is still in progress." };
  });
  const candidateStatement = evidence.map(item => text(record(record(record(item).content).candidate).statement)).find(Boolean);
  const relatedSearches = ordinarySearch && step.search ? [step.search] : searches(data).filter(search => step.search?.key === search.key
    || (step.stage.startsWith("query-plan") || step.stage.startsWith("frame-search-plan")) && objects(record(output).queries).some(query => matchesPlannedQuery(query, search.query))
    || step.stage.startsWith("problem-kill") && candidateStatement && search.query.startsWith(candidateStatement));
  const allCandidates = candidates(data);
  const relatedCandidates = stepId === "legacy:saved" || step.stage.startsWith("problem-candidates") ? allCandidates
    : step.stage.startsWith("problem-kill") ? allCandidates.filter(candidate => candidate.statement === candidateStatement) : [];
  const events = db.db.prepare(`SELECT type, created_at, payload_json FROM job_events WHERE run_id IN (${data.placeholders}) ORDER BY id`)
    .all(...data.runIds) as Array<{ type: string; created_at: string; payload_json: string }>;
  return RunTraceStepDetailSchema.parse({ runId, step, inputs: saved ? json(saved.input_json) : managedSearch ? json(managedSearch.input_json)
    : ordinarySearch?.receipt ?? record(request.workOrder).inputs ?? null,
    output, evidence, searches: relatedSearches, facts, candidates: relatedCandidates,
    events: [...events.filter(event => !step.startedAt || event.created_at >= step.startedAt && (!step.finishedAt || event.created_at <= step.finishedAt))
      .map(event => ({ type: event.type, createdAt: event.created_at, payload: json(event.payload_json) })),
      ...(managedSearch?.error_message ? [{ type: "search-interrupted", createdAt: managedSearch.completed_at ?? managedSearch.prepared_at,
        payload: { status: managedSearch.status, message: managedSearch.error_message } }] : []),
      ...(ordinarySearch && ordinarySearch.terminal?.status !== "completed" ? [{ type: "search-interrupted",
        createdAt: ordinarySearch.terminal?.finishedAt ?? ordinarySearch.receipt.createdAt,
        payload: { attemptId: ordinarySearch.receipt.id, status: ordinarySearch.terminal?.status ?? "unknown-dispatch",
          message: ordinarySearch.terminal?.message ?? "Search may have completed before interruption. No terminal result was saved." } }] : [])] });
}
