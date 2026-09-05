import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { recoverInterruptedEvidenceFollowUps, ResearchEngine } from "../core/research-engine";
import { DatabaseClient } from "../db/client";
import { GenerationAttemptRepository } from "../db/repositories/generation-attempts";
import { ActiveRunConflictError } from "../db/repositories/research-runs";
import { ThreadRepository } from "../db/repositories/threads";
import { CodexClient, inspectCodexCli, type CodexInspectionOptions, type CodexInspectionResult } from "../providers/codex";
import { ExaClient } from "../providers/exa";
import { PerplexityClient } from "../providers/perplexity";
import type { SearchClient, SearchProvider, ValidationResult } from "../providers/search";
import type { StructuredModelClient } from "../providers/structured";
import { RuntimeClient } from "../providers/runtime";
import { AppError, toErrorPayload } from "../shared/errors";
import { MAX_DEVELOPMENT_PROJECTED_CALLS } from "../shared/development-projection";
import {
  CreateThreadRequestSchema, DeleteThreadRequestSchema, EvidenceFollowUpRequestSchema, ExportIdeasRequestSchema, ExportResearchRequestSchema,
  GetIdeaDetailRequestSchema, GetSourceDetailRequestSchema, HealthResponseSchema,
  NativeLoginCancelSchema, NativeLoginCompleteSchema, NativeLoginStartSchema, NativeProviderSchema,
  ResumeResearchSchema, SaveFavoriteModelSchema, SaveRunConfigSchema, SaveScopeSchema,
  SelectProblemsSchema, SelectOptionSchema, SaveDecisionSchema, SelectThreadRequestSchema, SourceDetailSchema, StartResearchSchema,
  ValidationStateSchema, WorkspaceStateSchema, type FactorView, type ProblemCandidate, type RejectedProblemCandidate, type ResearchEvent,
  type SolutionView, type ValidationState,
} from "../shared/ipc";
import {
  DEFAULT_RUN_CONFIG, LEGACY_CODEX_PROVIDER_ID, ModelCatalogSchema, RunConfigSchema, sameModelRef,
  type ModelCatalog, type ModelOption, type ModelRef, type RunConfig,
} from "../shared/schemas";
import type { LogInput } from "../shared/logging";
import { discoveryRunProjection } from "../core/discovery";
import { summarizeRunUsage, type GenerationAttemptUsageRow } from "./run-usage";

export interface BackendContext {
  dataDir: string;
  dbPath: string;
  bundledPromptsDir: string;
  promptOverridesDir: string;
  appVersion: string;
  getSecrets: () => { exaApiKey: string | null; perplexityApiKey?: string | null };
  modelClients?: Partial<Record<string, StructuredModelClient>>;
  searchClients?: Partial<Record<SearchProvider, SearchClient>>;
  nativeRuntime?: RuntimeClient;
  nativeRuntimeError?: string;
  nativeRuntimeStatus?: () => { ready: boolean; error?: string };
  prepareNativeRuntime?: () => Promise<void>;
  persistProviderCredential?: (providerId: string, credential: string) => Promise<void>;
  forgetProviderCredential?: (providerId: string) => void;
  log?: (input: Omit<LogInput, "component">) => void;
  observeDataRead?: (read: { operation: "solution-summaries" | "solution-details"; queryCount: number; rowCount: number }) => void;
  providerValidation?: {
    inspectCodex?: (options?: CodexInspectionOptions) => Promise<CodexInspectionResult>;
    validateExa?: (apiKey: string) => Promise<ValidationResult>;
    validatePerplexity?: (apiKey: string) => Promise<ValidationResult>;
  };
}

interface SearchValidation {
  exa: { valid: boolean };
  perplexity: { valid: boolean };
}

export function isSetupComplete(
  search: SearchValidation,
  codex: { detected: boolean; compatible: boolean; authenticated: boolean },
  native: { available: boolean; connected: boolean } = { available: false, connected: false },
): boolean {
  return (search.exa.valid || search.perplexity.valid)
    && ((codex.detected && codex.compatible && codex.authenticated) || (native.available && native.connected));
}
type DataRead = (sql: string, params: readonly unknown[]) => Array<Record<string, unknown>>;
export function isResearchModeReady(
  config: Pick<RunConfig, "researchMode" | "searchProvider"> & { model?: ModelRef },
  search: SearchValidation,
  codex: { detected: boolean; compatible: boolean; authenticated: boolean },
  native: { available: boolean; connected: boolean } = { available: false, connected: false },
): boolean {
  const selectedSearchReady = search[config.searchProvider].valid;
  const selectedModelReady = (config.model?.providerId ?? LEGACY_CODEX_PROVIDER_ID) === LEGACY_CODEX_PROVIDER_ID
    ? codex.detected && codex.compatible && codex.authenticated
    : native.available && native.connected;
  return selectedModelReady
    && (config.researchMode === "known-problem" || selectedSearchReady);
}
export interface BackendHandle {
  port: number;
  token: string;
  close: () => Promise<void>;
  secretsChanged: () => void;
  providersChanged: () => void;
}

export async function startBackend(context: BackendContext, onEvent: (event: ResearchEvent) => void): Promise<BackendHandle> {
  const token = randomBytes(24).toString("hex");
  const db = new DatabaseClient(context.dbPath);
  const generationAttempts = new GenerationAttemptRepository(db);
  generationAttempts.interruptInFlight("The backend restarted before the generation reached a durable terminal result");
  recoverInterruptedEvidenceFollowUps(db);
  db.db.exec(`
    UPDATE research_runs SET interrupted = 1 WHERE status IN ('queued', 'running');
    UPDATE threads SET status = 'failed' WHERE id IN (
      SELECT thread_id FROM research_runs WHERE interrupted = 1 AND status IN ('queued', 'running')
    );
  `);
  const threads = new ThreadRepository(db);
  db.setMeta("persistence_probe", `ok-${Date.now()}`);
  let activeThreadId: string | null = db.getSetting("active_thread_id") || null;
  let cachedValidation: ValidationState | null = null;
  let validationPromise: Promise<ValidationState> | null = null;
  let cachedModels: ModelRef[] = [];
  let cachedModelOptions: ModelOption[] = [];
  let validationGeneration = 0;
  const pendingNativeLogins = new Map<string, string>();
  let engine: ResearchEngine | null = null;
  const invalidateProviderCache = () => {
    validationGeneration += 1;
    validationPromise = null;
    cachedValidation = null;
    cachedModels = [];
    cachedModelOptions = [];
  };
  const emitEvent = (event: ResearchEvent) => {
    try {
      onEvent(event);
    } catch (error) {
      context.log?.({ level: "error", event: "backend-event-delivery-failed", error });
    }
  };
  const ensureEngine = () => {
    if (!engine) {
      // Known-problem runs never search, so the engine is usable without either search credential.
      const { exaApiKey, perplexityApiKey } = context.getSecrets();
      const searchClients = { ...context.searchClients };
      if (exaApiKey && !searchClients.exa) searchClients.exa = new ExaClient(exaApiKey);
      if (perplexityApiKey && !searchClients.perplexity) searchClients.perplexity = new PerplexityClient(perplexityApiKey);
      engine = new ResearchEngine({
        db,
        modelClients: {
          [LEGACY_CODEX_PROVIDER_ID]: context.modelClients?.[LEGACY_CODEX_PROVIDER_ID] ?? new CodexClient(),
          ...context.modelClients,
        },
        searchClients,
        onEvent: emitEvent,
      });
    }
    return engine;
  };

  async function validateProviders(forceCodex = false): Promise<ValidationState> {
    if (validationPromise) return validationPromise;
    const generation = validationGeneration;
    const pending = (async () => {
      const secrets = context.getSecrets();
      const [inspection, nativeInspection, exa, perplexity] = await Promise.all([
        (context.providerValidation?.inspectCodex ?? inspectCodexCli)({ force: forceCodex }).catch((): CodexInspectionResult => ({
          detected: false,
          compatible: false,
          authenticated: false,
          models: [],
          error: "Codex CLI inspection failed",
        })),
        inspectNativeRuntime(context.nativeRuntime, context.nativeRuntimeError, context.nativeRuntimeStatus?.()),
        secrets.exaApiKey
          ? (context.providerValidation?.validateExa ?? ((key: string) => new ExaClient(key).validateKey()))(secrets.exaApiKey)
          : Promise.resolve({ valid: false, error: "Exa key missing" }),
        secrets.perplexityApiKey
          ? (context.providerValidation?.validatePerplexity ?? ((key: string) => new PerplexityClient(key).validateKey()))(secrets.perplexityApiKey)
          : Promise.resolve({ valid: false, error: "Perplexity key missing" }),
      ]);
      const { models, ...codex } = inspection;
      const { models: nativeModels, ...native } = nativeInspection;
      const value = ValidationStateSchema.parse({ exa, perplexity, codex, native, setupComplete: isSetupComplete({ exa, perplexity }, codex, native) });
      context.log?.({
        level: value.setupComplete ? "info" : "warn",
        event: "provider-validation-completed",
        message: value.setupComplete ? "Research providers are ready" : "Research providers need attention",
        context: {
          setupComplete: value.setupComplete,
          exaValid: value.exa.valid,
          exaError: value.exa.error,
          perplexityValid: value.perplexity.valid,
          perplexityError: value.perplexity.error,
          codexDetected: value.codex.detected,
          codexCompatible: value.codex.compatible,
          codexAuthenticated: value.codex.authenticated,
          codexVersion: value.codex.version,
          codexError: value.codex.error,
        },
      });
      if (generation === validationGeneration) {
        cachedValidation = value;
        cachedModelOptions = [...nativeModels, ...models];
        cachedModels = cachedModelOptions.map(({ providerId, modelId }) => ({ providerId, modelId }));
      }
      return value;
    })();
    validationPromise = pending;
    try { return await pending; }
    finally { if (validationPromise === pending) validationPromise = null; }
  }
  const pendingValidation = () => ValidationStateSchema.parse({
    exa: { valid: false, error: context.getSecrets().exaApiKey ? "Checking Exa connection" : "Exa key missing" },
    perplexity: { valid: false, error: context.getSecrets().perplexityApiKey ? "Checking Perplexity connection" : "Perplexity key missing" },
    codex: { detected: false, compatible: false, authenticated: false, error: "Checking Codex connection" }, setupComplete: false,
    native: { available: false, connected: false, accounts: [], error: "Checking native runtime" },
  });

  function modelCatalog(): ModelCatalog {
    const favorites = readFavoriteModels();
    const models = [...cachedModels];
    for (const favorite of favorites) {
      if (!models.some((model) => sameModelRef(model, favorite))) models.push(favorite);
    }
    return ModelCatalogSchema.parse({ models, favorites });
  }
  function readFavoriteModels(): ModelRef[] {
    const raw = db.getSetting("favorite_models");
    if (!raw) return [];
    try {
      const parsed = ModelCatalogSchema.shape.favorites.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : [];
    } catch {
      return [];
    }
  }
  function saveFavoriteModel(model: ModelRef, favorite: boolean): void {
    const current = readFavoriteModels().filter((item) => !sameModelRef(item, model));
    if (favorite) current.push(model);
    db.setSetting("favorite_models", JSON.stringify(current));
  }

  async function workspaceState() {
    if (!cachedValidation) void validateProviders().catch(() => undefined);
    const threadList = threads.listThreads();
    if (activeThreadId && !threadList.some((thread) => thread.id === activeThreadId)) activeThreadId = threadList[0]?.id ?? null;
    const runConfig = activeThreadId ? threads.getLatestRunConfig(activeThreadId) : null;
    const latestResearchRun = activeThreadId ? latestRun(activeThreadId) : null;
    const state = {
      validation: cachedValidation ?? pendingValidation(),
      threads: threadList,
      activeThreadId,
      messages: activeThreadId ? threads.getMessages(activeThreadId) : [],
      scope: activeThreadId ? threads.getScope(activeThreadId) : null,
      runConfig,
      models: cachedModels,
      modelOptions: cachedModelOptions,
      modelCatalog: modelCatalog(),
      presets: threads.listPresets(),
      problemCandidates: activeThreadId ? listProblems(activeThreadId) : [],
      rejectedProblemCandidates: activeThreadId ? listRejectedProblemCandidates(activeThreadId) : [],
      solutions: activeThreadId ? listSolutions(activeThreadId, false) : [],
      latestResearchRun,
      pendingRuns: listPendingRuns(),
    };
    return WorkspaceStateSchema.parse(state);
  }

  function latestDiscoveryRun(threadId: string): string | null {
    const row = db.db.prepare(`SELECT id FROM research_runs WHERE thread_id = ? AND problem_id IS NULL AND status = 'completed' ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(threadId) as { id: string } | undefined;
    return row?.id ?? null;
  }
  function listProblems(threadId: string): ProblemCandidate[] {
    const runId = latestDiscoveryRun(threadId);
    if (!runId) return [];
    const rows = db.db.prepare("SELECT * FROM problems WHERE discovery_run_id = ? ORDER BY created_at, id").all(runId) as Array<Record<string, unknown>>;
    const factorsByProblem = listProblemFactorsForRun(runId);
    return rows.map((row) => {
      const factors = factorsByProblem.get(String(row.id)) ?? [];
      return {
        id: String(row.id), statement: String(row.statement), whyItPersists: String(row.why_it_persists),
        affected: String(row.affected), scaleEstimate: String(row.scale_estimate), verdict: String(row.verdict) as ProblemCandidate["verdict"],
        verdictReason: String(row.verdict_reason), selected: row.selected_at !== null,
        factors,
        singleHarvestModeWarning: factors.length > 0 && new Set(factors.map((factor) => factor.harvestMode)).size === 1,
      };
    });
  }
  function listProblemFactorsForRun(runId: string): Map<string, FactorView[]> {
    const rows = db.db.prepare(`
      SELECT pf.problem_id, f.*, s.title AS source_title, s.canonical_url
      FROM problems p
      JOIN problem_factors pf ON pf.problem_id = p.id
      JOIN factors f ON f.id = pf.factor_id
      JOIN sources s ON s.id = f.source_id
      WHERE p.discovery_run_id = ?
      ORDER BY f.created_at, f.id
    `).all(runId) as Array<Record<string, unknown>>;
    return groupRows(rows, "problem_id", mapFactor);
  }
  function listRejectedProblemCandidates(threadId: string): RejectedProblemCandidate[] {
    const runId = latestDiscoveryRun(threadId);
    if (!runId) return [];
    return (db.db.prepare(`
      SELECT id, statement, reason
      FROM rejected_problem_candidates
      WHERE discovery_run_id = ?
      ORDER BY created_at, id
    `).all(runId) as Array<{ id: string; statement: string; reason: string }>).map((candidate) => ({
      id: candidate.id,
      statement: candidate.statement,
      reason: candidate.reason,
    }));
  }
  function listSolutions(threadId: string, details = true, solutionId?: string): SolutionView[] {
    let queryCount = 0;
    const readAll: DataRead = (sql, params) => {
      queryCount += 1;
      return db.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    };
    const rows = readAll(`
      WITH relevant_solutions AS (
        SELECT s2.id
        FROM solutions s2
        JOIN problems p2 ON p2.id = s2.problem_id
        JOIN research_runs rr2 ON rr2.id = s2.research_run_id
        WHERE rr2.thread_id = ? AND (rr2.status = 'completed' OR rr2.workflow_version = 2)
          AND (? IS NULL OR s2.id = ?)
          AND p2.selected_at IS NOT NULL
          AND p2.discovery_run_id = (
            SELECT id FROM research_runs
            WHERE thread_id = ? AND problem_id IS NULL AND status = 'completed'
            ORDER BY created_at DESC, rowid DESC LIMIT 1
          )
      ), outcome_counts AS (
        SELECT solution_id, COUNT(*) AS outcome_count,
          SUM(CASE WHEN addresses_core = 1 THEN 1 ELSE 0 END) AS core_count
        FROM outcomes WHERE solution_id IN (SELECT id FROM relevant_solutions) GROUP BY solution_id
      ), risk_counts AS (
        SELECT r.solution_id, COUNT(*) AS risk_count,
          SUM(CASE WHEN r.impact = 'project ends' THEN 1 ELSE 0 END) AS ending_count,
          SUM(CASE WHEN r.impact = 'project ends' AND NOT EXISTS (
            SELECT 1 FROM risk_mitigations rm WHERE rm.risk_id = r.id
          ) THEN 1 ELSE 0 END) AS unaddressed_count
        FROM risks r WHERE solution_id IN (SELECT id FROM relevant_solutions) GROUP BY r.solution_id
      ), ranked_risks AS (
        SELECT id, solution_id, description, likelihood, impact, sort_key,
          ROW_NUMBER() OVER (PARTITION BY solution_id ORDER BY sort_key DESC, created_at, id) AS position
        FROM risks WHERE solution_id IN (SELECT id FROM relevant_solutions)
      )
      SELECT s.*, p.statement AS problem_statement, p.verdict AS problem_verdict,
        rr.workflow_version, rr.status AS run_status, rr.awaiting_selection, rr.updated_at AS run_updated_at,
        ${details ? "da.analysis_json, da.user_decision, da.observed_result," : ""} da.updated_at AS decision_updated_at,
        ef.status AS evidence_follow_up_status, ef.updated_at AS evidence_follow_up_updated_at,
        COALESCE(oc.outcome_count, 0) AS outcome_count, COALESCE(oc.core_count, 0) AS core_count,
        COALESCE(rc.risk_count, 0) AS risk_count, COALESCE(rc.ending_count, 0) AS ending_count,
        COALESCE(rc.unaddressed_count, 0) AS unaddressed_count,
        hr.id AS highest_risk_id, hr.description AS highest_risk_description,
        hr.likelihood AS highest_risk_likelihood, hr.impact AS highest_risk_impact,
        hr.sort_key AS highest_risk_sort_key
      FROM solutions s JOIN problems p ON p.id = s.problem_id
      JOIN research_runs rr ON rr.id = s.research_run_id
      LEFT JOIN decision_analyses da ON da.solution_id = s.id
      LEFT JOIN evidence_follow_ups ef ON ef.research_run_id = rr.id AND ef.solution_id = s.id
      LEFT JOIN outcome_counts oc ON oc.solution_id = s.id
      LEFT JOIN risk_counts rc ON rc.solution_id = s.id
      LEFT JOIN ranked_risks hr ON hr.solution_id = s.id AND hr.position = 1
      WHERE s.id IN (SELECT id FROM relevant_solutions)
      ORDER BY s.created_at, s.option_position, s.id
    `, [threadId, solutionId ?? null, solutionId ?? null, threadId]);
    const solutionIds = rows.map((row) => String(row.id));
    const problemIds = [...new Set(rows.map((row) => String(row.problem_id)))];
    const outcomesBySolution = details ? readOutcomes(solutionIds, readAll) : new Map<string, SolutionView["outcomes"]>();
    const risksBySolution = details ? readRisks(solutionIds, readAll) : new Map<string, SolutionView["risks"]>();
    const factorsByProblem = details ? readProblemFactors(problemIds, readAll) : new Map<string, FactorView[]>();
    const contrarySourcesByProblem = details ? readContrarySources(problemIds, readAll) : new Map<string, NonNullable<SolutionView["contrarySources"]>>();
    const followUpsByRun = details ? readEvidenceFollowUps(rows.map((row) => String(row.research_run_id)), readAll) : new Map();
    context.observeDataRead?.({ operation: details ? "solution-details" : "solution-summaries", queryCount, rowCount: rows.length });
    const result = rows.map((row): SolutionView => {
      const highest = row.highest_risk_id === null ? null : {
        id: String(row.highest_risk_id), description: String(row.highest_risk_description),
        likelihood: String(row.highest_risk_likelihood) as "rare" | "possible" | "likely",
        impact: String(row.highest_risk_impact) as "≤3 days lost" | "~2 weeks" | "~2 months" | "project ends",
        sortKey: Number(row.highest_risk_sort_key),
      };
      const evidenceFollowUp = followUpsByRun.get(String(row.research_run_id));
      return {
        detailsLoaded: details, highestRisk: highest,
        outcomeCount: Number(row.outcome_count), riskCount: Number(row.risk_count), projectEndingRiskCount: Number(row.ending_count),
        workflowVersion: Number(row.workflow_version) as 1 | 2,
        runId: String(row.research_run_id), selected: row.selected_at !== null,
        selectable: Boolean(row.awaiting_selection),
        ...(row.evidence_follow_up_status === null ? {} : {
          evidenceFollowUpStatus: (row.evidence_follow_up_status === "requested" ? "running" : String(row.evidence_follow_up_status)) as "running" | "completed" | "failed",
        }),
        canRequestEvidenceFollowUp: Number(row.workflow_version) === 2 && row.selected_at !== null
          && row.decision_updated_at !== null && row.evidence_follow_up_status === null && row.run_status === "completed",
        keyAssumption: row.key_assumption === null ? undefined : String(row.key_assumption),
        whyCurrentApproachMaySuffice: row.why_current_approach_may_suffice === null ? undefined : String(row.why_current_approach_may_suffice),
        unknowns: JSON.parse(String(row.unknowns_json ?? "[]")),
        supportingEvidenceIds: JSON.parse(String(row.supporting_evidence_ids_json ?? "[]")),
        contraryEvidenceIds: JSON.parse(String(row.contrary_evidence_ids_json ?? "[]")),
        ...(details ? {
          decisionAnalysis: row.analysis_json ? JSON.parse(String(row.analysis_json)) : null,
          userDecision: row.user_decision === null ? null : String(row.user_decision),
          observedResult: row.observed_result === null ? null : String(row.observed_result),
          contrarySources: contrarySourcesByProblem.get(String(row.problem_id)) ?? [],
          ...(evidenceFollowUp ? { evidenceFollowUp } : {}),
        } : {}),
        detailRevision: `${row.run_updated_at}:${row.decision_updated_at ?? ""}:${row.evidence_follow_up_updated_at ?? ""}`,
        id: String(row.id), problemId: String(row.problem_id), problemStatement: String(row.problem_statement),
        problemVerdict: String(row.problem_verdict) as SolutionView["problemVerdict"], mechanism: String(row.mechanism),
        factors: details ? factorsByProblem.get(String(row.problem_id)) ?? [] : [],
        description: String(row.description), respectsOffLimits: Boolean(row.respects_off_limits), respectsOffLimitsWhy: String(row.respects_off_limits_why),
        outcomes: outcomesBySolution.get(String(row.id)) ?? [], risks: risksBySolution.get(String(row.id)) ?? [],
        confirmedCoreOutcomes: Number(row.core_count), unaddressedCatastrophicRisks: Number(row.unaddressed_count),
      };
    });
    return result;
  }
  function readOutcomes(solutionIds: string[], readAll: DataRead): Map<string, SolutionView["outcomes"]> {
    if (solutionIds.length === 0) return new Map();
    const rows = readAll(`SELECT * FROM outcomes WHERE solution_id IN (${placeholders(solutionIds)}) ORDER BY created_at, id`, solutionIds);
    return groupRows(rows, "solution_id", (item) => ({
      id: String(item.id), description: String(item.description), direction: String(item.direction) as "positive" | "negative",
      affects: String(item.affects), addressesCore: Boolean(item.addresses_core),
    }));
  }
  function readRisks(solutionIds: string[], readAll: DataRead): Map<string, SolutionView["risks"]> {
    if (solutionIds.length === 0) return new Map();
    const rows = readAll(`SELECT * FROM risks WHERE solution_id IN (${placeholders(solutionIds)}) ORDER BY sort_key DESC, created_at, id`, solutionIds);
    const riskIds = rows.map((row) => String(row.id));
    const mitigationRows = riskIds.length === 0 ? [] : readAll(`
      SELECT owned.risk_id, m.*, linked.risk_id AS linked_risk_id
      FROM risk_mitigations owned
      JOIN mitigations m ON m.id = owned.mitigation_id
      JOIN risk_mitigations linked ON linked.mitigation_id = m.id
      WHERE owned.risk_id IN (${placeholders(riskIds)})
      ORDER BY m.created_at, m.id, linked.risk_id
    `, riskIds);
    const mitigationsByRisk = new Map<string, SolutionView["risks"][number]["mitigations"]>();
    for (const row of mitigationRows) {
      const riskId = String(row.risk_id);
      const mitigations = mitigationsByRisk.get(riskId) ?? [];
      const mitigationId = String(row.id);
      const existing = mitigations.find((item) => item.id === mitigationId);
      if (existing) existing.riskIds.push(String(row.linked_risk_id));
      else mitigations.push({
        id: mitigationId, approach: String(row.approach), cost: String(row.cost), failsIf: String(row.fails_if),
        riskIds: [String(row.linked_risk_id)],
      });
      mitigationsByRisk.set(riskId, mitigations);
    }
    return groupRows(rows, "solution_id", (item) => ({
      id: String(item.id), description: String(item.description), likelihood: String(item.likelihood) as "rare" | "possible" | "likely",
      impact: String(item.impact) as "≤3 days lost" | "~2 weeks" | "~2 months" | "project ends",
      sortKey: Number(item.sort_key), mitigations: mitigationsByRisk.get(String(item.id)) ?? [],
    }));
  }
  function readProblemFactors(problemIds: string[], readAll: DataRead): Map<string, FactorView[]> {
    if (problemIds.length === 0) return new Map();
    const rows = readAll(`
      SELECT pf.problem_id, f.*, s.title AS source_title, s.canonical_url
      FROM problem_factors pf JOIN factors f ON f.id = pf.factor_id JOIN sources s ON s.id = f.source_id
      WHERE pf.problem_id IN (${placeholders(problemIds)}) ORDER BY f.created_at, f.id
    `, problemIds);
    return groupRows(rows, "problem_id", mapFactor);
  }
  function readContrarySources(problemIds: string[], readAll: DataRead): Map<string, NonNullable<SolutionView["contrarySources"]>> {
    if (problemIds.length === 0) return new Map();
    const rows = readAll(`
      SELECT pvs.problem_id, s.id, s.title, s.canonical_url AS url, s.retrieved_text AS text
      FROM problem_verdict_sources pvs JOIN sources s ON s.id = pvs.source_id
      WHERE pvs.problem_id IN (${placeholders(problemIds)}) ORDER BY pvs.problem_id, pvs.position
    `, problemIds);
    return groupRows(rows, "problem_id", (row) => ({ id: String(row.id), title: String(row.title), url: String(row.url), text: String(row.text) }));
  }
  function readEvidenceFollowUps(runIds: string[], readAll: DataRead) {
    if (runIds.length === 0) return new Map<string, {
      status: "running" | "completed" | "failed"; question: string; sources: Array<Record<string, unknown>>;
      factors: FactorView[]; error: string | null; updatedAt: string;
    }>();
    const uniqueRunIds = [...new Set(runIds)];
    const rows = readAll(`SELECT * FROM evidence_follow_ups WHERE research_run_id IN (${placeholders(uniqueRunIds)})`, uniqueRunIds);
    const sourceIds = [...new Set(rows.flatMap((row) => JSON.parse(String(row.source_ids_json)) as string[]))];
    const factorIds = [...new Set(rows.flatMap((row) => JSON.parse(String(row.factor_ids_json)) as string[]))];
    const sourceRows = sourceIds.length === 0 ? [] : readAll(`SELECT * FROM sources WHERE id IN (${placeholders(sourceIds)})`, sourceIds);
    const factorRows = factorIds.length === 0 ? [] : readAll(`
      SELECT f.*, s.title AS source_title, s.canonical_url FROM factors f JOIN sources s ON s.id = f.source_id
      WHERE f.id IN (${placeholders(factorIds)}) ORDER BY f.created_at, f.id
    `, factorIds);
    const sourcesById = new Map(sourceRows.map((source) => [String(source.id), {
      id: String(source.id), researchRunId: String(source.research_run_id), url: String(source.canonical_url), title: String(source.title),
      text: String(source.retrieved_text), ...(source.author ? { author: String(source.author) } : {}),
      ...(source.published_at ? { publishedDate: String(source.published_at) } : {}),
      contentHash: String(source.content_hash), retrievedAt: String(source.retrieved_at),
    }]));
    const factorsById = new Map(factorRows.map((factor) => [String(factor.id), mapFactor(factor)]));
    return new Map(rows.map((row) => {
      const status = String(row.status);
      return [String(row.research_run_id), {
        status: status === "requested" ? "running" : status as "running" | "completed" | "failed",
        question: String(row.question),
        sources: (JSON.parse(String(row.source_ids_json)) as string[]).flatMap((id) => sourcesById.get(id) ?? []),
        factors: (JSON.parse(String(row.factor_ids_json)) as string[]).flatMap((id) => factorsById.get(id) ?? []),
        error: row.error_message === null ? null : String(row.error_message), updatedAt: String(row.updated_at),
      }];
    }));
  }
  function researchExport(threadId: string) {
    const runId = latestDiscoveryRun(threadId);
    if (!runId) throw new AppError("conflict", "Research must finish before it can be exported.");
    const thread = db.db.prepare("SELECT id, title FROM threads WHERE id = ?").get(threadId) as { id: string; title: string };
    const run = db.db.prepare(`
      SELECT id, status, config_json, completion_reason, created_at, updated_at
      FROM research_runs WHERE id = ?
    `).get(runId) as Record<string, unknown>;
    const sources = (db.db.prepare(`
      SELECT id, provider_source_id, canonical_url, title, retrieved_text, author, published_at, content_hash, retrieved_at
      FROM sources WHERE research_run_id = ? ORDER BY retrieved_at, id
    `).all(runId) as Array<Record<string, unknown>>).map((source) => ({
      id: String(source.id), providerSourceId: source.provider_source_id === null ? null : String(source.provider_source_id),
      url: String(source.canonical_url), title: String(source.title), text: String(source.retrieved_text),
      author: source.author === null ? null : String(source.author), publishedAt: source.published_at === null ? null : String(source.published_at),
      contentHash: String(source.content_hash), retrievedAt: String(source.retrieved_at),
    }));
    const factors = (db.db.prepare(`
      SELECT id, subject, behavior, quote, source_id, harvest_mode, model_confidence, uncertainty, created_at
      FROM factors WHERE research_run_id = ? ORDER BY created_at, id
    `).all(runId) as Array<Record<string, unknown>>).map((factor) => ({
      id: String(factor.id), subject: String(factor.subject), behavior: String(factor.behavior), quote: String(factor.quote),
      sourceId: String(factor.source_id), harvestMode: String(factor.harvest_mode), modelConfidence: Number(factor.model_confidence),
      ...(factor.uncertainty === null || factor.uncertainty === undefined ? {} : { uncertainty: String(factor.uncertainty) }),
      createdAt: String(factor.created_at),
    }));
    // The archived scope is the one this run actually used; the thread's live scope may have been edited since.
    const archivedScope = db.db.prepare(`
      SELECT title, audience, domain, observations, off_limits_json FROM scopes WHERE research_run_id = ?
    `).get(runId) as { title: string; audience: string; domain: string; observations: string; off_limits_json: string } | undefined;
    return {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      thread,
      researchRun: {
        id: String(run.id), status: String(run.status), completionReason: run.completion_reason === null ? null : String(run.completion_reason),
        createdAt: String(run.created_at), completedAt: String(run.updated_at), config: RunConfigSchema.parse(JSON.parse(String(run.config_json))),
        usage: runUsage(runId),
      },
      scope: archivedScope
        ? {
          title: archivedScope.title, audience: archivedScope.audience, domain: archivedScope.domain,
          observations: archivedScope.observations, offLimits: JSON.parse(archivedScope.off_limits_json) as string[],
        }
        : threads.getScope(threadId),
      sources,
      factors,
      problems: listProblems(threadId),
      rejectedProblemCandidates: listRejectedProblemCandidates(threadId),
      evidenceFollowUps: listEvidenceFollowUpExports(threadId),
    };
  }
  function listEvidenceFollowUpExports(threadId: string) {
    const rows = db.db.prepare(`
      SELECT ef.research_run_id FROM evidence_follow_ups ef
      JOIN research_runs rr ON rr.id = ef.research_run_id
      WHERE rr.thread_id = ? ORDER BY ef.requested_at, ef.research_run_id
    `).all(threadId) as Array<{ research_run_id: string }>;
    const readAll: DataRead = (sql, params) => db.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    const byRun = readEvidenceFollowUps(rows.map((row) => row.research_run_id), readAll);
    return rows.flatMap((row) => {
      const followUp = byRun.get(row.research_run_id);
      return followUp ? [{ researchRunId: row.research_run_id, ...followUp }] : [];
    });
  }
  function runUsage(runId: string) {
    const rows = db.db.prepare(`
      SELECT status, provider_id, model_id, attempt_metadata_json, usage_json
      FROM generation_attempts WHERE research_run_id = ? ORDER BY created_at, id
    `).all(runId) as GenerationAttemptUsageRow[];
    if (rows.length === 0) {
      const ledgerRows = db.db.prepare(`
        SELECT provider, model, COUNT(*) AS count
        FROM cost_ledger
        WHERE research_run_id = ? AND operation = 'structured-completion' AND status IN ('reserved', 'committed')
        GROUP BY provider, model
      `).all(runId) as Array<{ provider: string; model: string | null; count: number }>;
      for (const item of ledgerRows) {
        for (let index = 0; index < item.count; index += 1) {
          rows.push({ status: "completed", provider_id: item.provider, model_id: item.model ?? "unknown", attempt_metadata_json: null, usage_json: null });
        }
      }
    }
    return summarizeRunUsage(rows);
  }
  function solutionRunUsage(solutionId: string) {
    const row = db.db.prepare(`
      SELECT research_run_id FROM solutions WHERE id = ?
    `).get(solutionId) as { research_run_id: string } | undefined;
    return row ? { runId: row.research_run_id, summary: runUsage(row.research_run_id) } : null;
  }
  function latestRun(threadId: string) {
    const row = db.db.prepare("SELECT id, status, problem_id, config_json, workflow_version, awaiting_selection, interrupted FROM research_runs WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(threadId) as { id: string; status: string; problem_id: string | null; config_json: string; workflow_version: 1 | 2; awaiting_selection: number; interrupted: number } | undefined;
    if (!row) return null;
    const runConfig = RunConfigSchema.parse({ ...DEFAULT_RUN_CONFIG, ...JSON.parse(row.config_json) });
    const counts = db.db.prepare(`SELECT provider, COUNT(*) AS count FROM cost_ledger WHERE research_run_id = ? AND status IN ('reserved','committed') GROUP BY provider`)
      .all(row.id) as Array<{ provider: string; count: number }>;
    const projection = row.problem_id ? { modelCalls: row.workflow_version === 2 ? 2 : MAX_DEVELOPMENT_PROJECTED_CALLS, searches: 0 } : discoveryRunProjection(runConfig.discoveryDepth);
    const activity = db.db.prepare("SELECT payload_json FROM job_events WHERE run_id = ? AND type = 'run-progress' ORDER BY id DESC LIMIT 1")
      .get(row.id) as { payload_json: string } | undefined;
    const resumeSafety = generationAttempts.getResumeSafety(row.id);
    return {
      runId: row.id, status: row.status, problemId: row.problem_id,
      workflowVersion: row.workflow_version, awaitingSelection: Boolean(row.awaiting_selection), interrupted: Boolean(row.interrupted),
      codexCalls: counts.find((item) => item.provider === runConfig.model.providerId)?.count ?? 0,
      searches: counts.find((item) => item.provider === runConfig.searchProvider)?.count ?? 0,
      projectedCodexCalls: projection.modelCalls, projectedSearches: projection.searches,
      lastActivity: activity ? String(JSON.parse(activity.payload_json).message ?? "") : null,
      canResume: resumeSafety.canResume,
      ...(resumeSafety.resumeBlockedReason ? { resumeBlockedReason: resumeSafety.resumeBlockedReason } : {}),
      usage: runUsage(row.id),
    };
  }
  function listPendingRuns(): Array<{ runId: string; threadId: string; threadTitle: string; status: "queued" | "running"; problemId: string | null }> {
    return db.db.prepare(`
      SELECT rr.id AS run_id, rr.thread_id, t.title, rr.status, rr.problem_id
      FROM research_runs rr JOIN threads t ON t.id = rr.thread_id
      WHERE rr.status IN ('queued','running') ORDER BY rr.created_at
    `).all().map((row) => {
      const item = row as Record<string, unknown>;
      return { runId: String(item.run_id), threadId: String(item.thread_id), threadTitle: String(item.title), status: String(item.status) as "queued" | "running", problemId: item.problem_id === null ? null : String(item.problem_id) };
    });
  }
  function requireThread(threadId: string): void {
    if (!db.db.prepare("SELECT 1 FROM threads WHERE id = ?").get(threadId)) throw new AppError("not_found", "Thread not found.");
  }
  function cancelActiveRuns(target: ResearchEngine | null): void {
    if (!target) return;
    for (const runId of target.getActiveRunIds()) {
      try { target.cancelRun(runId); } catch { /* the run ended before we could cancel it */ }
    }
  }
  function cancelRun(runId: string): void {
    if (engine) {
      engine.cancelRun(runId);
      return;
    }
    const row = db.db.prepare("SELECT thread_id, status FROM research_runs WHERE id = ?").get(runId) as
      { thread_id: string; status: string } | undefined;
    if (!row) throw new AppError("not_found", "Research run not found.");
    if (!["queued", "running"].includes(row.status)) throw new AppError("conflict", "This research run has already ended.");
    db.db.prepare(`
      UPDATE research_runs
      SET status = 'cancelled', completion_reason = 'Cancelled by user', cancelled = 1, updated_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), runId);
    threads.updateThreadStatus(row.thread_id, "failed");
    emitEvent({ type: "run-cancelled", runId, threadId: row.thread_id });
  }

  const pendingRequests = new Set<Promise<void>>();
  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const startedAt = Date.now();
    const method = req.method ?? "GET";
    let route = req.url ?? "/";
    try {
      if (!authorize(req, token)) return sendError(res, new AppError("unauthorized"));
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      route = url.pathname;
      if (method === "GET" && route === "/health") return sendJson(res, 200, HealthResponseSchema.parse({ ok: true, version: context.appVersion, persistenceCheck: db.getMeta("persistence_probe") ?? undefined }));
      if (method === "GET" && route === "/validation") return sendJson(res, 200, await validateProviders());
      if (method === "GET" && route === "/workspace") return sendJson(res, 200, await workspaceState());
      if (method === "GET" && route.startsWith("/sources/")) {
        const { sourceId } = GetSourceDetailRequestSchema.parse({ sourceId: route.slice(9) });
        const row = db.db.prepare("SELECT * FROM sources WHERE id = ?").get(sourceId) as Record<string, unknown> | undefined;
        if (!row) throw new AppError("not_found", "Source not found.");
        return sendJson(res, 200, SourceDetailSchema.parse({ id: row.id, researchRunId: row.research_run_id, url: row.canonical_url, title: row.title,
          text: row.retrieved_text, ...(row.author ? { author: row.author } : {}), ...(row.published_at ? { publishedDate: row.published_at } : {}),
          contentHash: row.content_hash, retrievedAt: row.retrieved_at }));
      }
      if (method === "GET" && route.startsWith("/ideas/")) {
        const { ideaId } = GetIdeaDetailRequestSchema.parse({ ideaId: route.slice(7) });
        const idea = listSolutions(activeThreadId ?? "", true, ideaId)[0];
        if (!idea) throw new AppError("not_found", "Solution not found.");
        return sendJson(res, 200, idea);
      }
      if (method !== "POST") throw new AppError("not_found", "Route not found.");
      const body = await readBody(req);
      if (route === "/threads") {
        const input = CreateThreadRequestSchema.parse(body);
        const validation = cachedValidation ?? await validateProviders();
        const searchProvider = validation.exa.valid ? "exa" : validation.perplexity.valid ? "perplexity" : "exa";
        const defaultModel = cachedModels.some((model) => sameModelRef(model, DEFAULT_RUN_CONFIG.model))
          ? DEFAULT_RUN_CONFIG.model
          : cachedModels[0] ?? DEFAULT_RUN_CONFIG.model;
        const thread = threads.createThread(input.title ?? "New research", { ...DEFAULT_RUN_CONFIG, model: defaultModel, searchProvider });
        activeThreadId = thread.id; db.setSetting("active_thread_id", thread.id); return sendJson(res, 200, { thread, workspace: await workspaceState() });
      }
      if (route === "/threads/select") {
        const { threadId } = SelectThreadRequestSchema.parse(body); requireThread(threadId); activeThreadId = threadId;
        db.setSetting("active_thread_id", threadId); return sendJson(res, 200, await workspaceState());
      }
      if (route === "/threads/delete") {
        const { threadId } = DeleteThreadRequestSchema.parse(body); requireThread(threadId);
        for (const run of listPendingRuns().filter((item) => item.threadId === threadId)) cancelRun(run.runId);
        threads.deleteThread(threadId); if (activeThreadId === threadId) activeThreadId = threads.listThreads()[0]?.id ?? null;
        db.setSetting("active_thread_id", activeThreadId ?? ""); return sendJson(res, 200, await workspaceState());
      }
      if (route === "/scope") {
        const input = SaveScopeSchema.parse(body); requireThread(input.threadId); threads.saveScope(input.threadId, input.scope);
        return sendJson(res, 200, await workspaceState());
      }
      if (route === "/run-config") {
        const input = SaveRunConfigSchema.parse(body); requireThread(input.threadId); threads.saveRunConfig(input.threadId, input.config, input.presetName);
        return sendJson(res, 200, await workspaceState());
      }
      if (route === "/models/favorite") {
        const input = SaveFavoriteModelSchema.parse(body); saveFavoriteModel(input.model, input.favorite); return sendJson(res, 200, await workspaceState());
      }
      if (route === "/native/login/start") {
        if (!context.nativeRuntime) throw new AppError("conflict", context.nativeRuntimeError ?? "Native runtime is unavailable");
        if (context.nativeRuntimeStatus?.().ready === false && context.prepareNativeRuntime) {
          try { await context.prepareNativeRuntime(); }
          catch { throw new AppError("conflict", context.nativeRuntimeStatus().error ?? "Native runtime could not be started"); }
        }
        if (context.nativeRuntimeStatus?.().ready === false) throw new AppError("conflict", context.nativeRuntimeStatus().error ?? "Native runtime is starting");
        const input = NativeLoginStartSchema.parse(body);
        const login = await context.nativeRuntime.startLogin(input.providerId, input.method);
        pendingNativeLogins.set(login.loginId, input.providerId);
        return sendJson(res, 200, login);
      }
      if (route === "/native/login/complete") {
        if (!context.nativeRuntime || !context.persistProviderCredential || context.nativeRuntimeStatus?.().ready === false) {
          throw new AppError("conflict", context.nativeRuntimeStatus?.().error ?? "Native account storage is unavailable");
        }
        const input = NativeLoginCompleteSchema.parse(body);
        const providerId = pendingNativeLogins.get(input.loginId);
        if (!providerId) throw new AppError("conflict", "This native sign-in is no longer active");
        let result;
        try {
          result = await context.nativeRuntime.completeLogin(input.loginId, async (persistedProviderId, credential) => {
            if (pendingNativeLogins.get(input.loginId) !== providerId || persistedProviderId !== providerId) {
              throw new Error("The native sign-in was cancelled before its credential could be saved");
            }
            await context.persistProviderCredential!(persistedProviderId, credential);
          });
        } catch (error) {
          pendingNativeLogins.delete(input.loginId);
          try { await context.nativeRuntime.logout(providerId); } catch { /* persistence failure still leaves the account unusable */ }
          invalidateProviderCache();
          throw error;
        }
        if (!result) return sendJson(res, 200, { pending: true });
        pendingNativeLogins.delete(input.loginId);
        invalidateProviderCache();
        return sendJson(res, 200, { pending: false, workspace: await workspaceState() });
      }
      if (route === "/native/login/cancel") {
        if (!context.nativeRuntime || context.nativeRuntimeStatus?.().ready === false) {
          throw new AppError("conflict", context.nativeRuntimeStatus?.().error ?? "Native runtime is unavailable");
        }
        const input = NativeLoginCancelSchema.parse(body);
        if (pendingNativeLogins.get(input.loginId) !== input.providerId) {
          return sendJson(res, 200, await workspaceState());
        }
        pendingNativeLogins.delete(input.loginId);
        try { await context.nativeRuntime.cancelLogin(input.loginId); }
        finally {
          try { await context.nativeRuntime.logout(input.providerId); }
          finally { context.forgetProviderCredential?.(input.providerId); }
        }
        invalidateProviderCache();
        return sendJson(res, 200, await workspaceState());
      }
      if (route === "/native/account/refresh") {
        if (!context.nativeRuntime || !context.persistProviderCredential || context.nativeRuntimeStatus?.().ready === false) {
          throw new AppError("conflict", context.nativeRuntimeStatus?.().error ?? "Native account storage is unavailable");
        }
        const { providerId } = NativeProviderSchema.parse(body);
        try { await context.nativeRuntime.refreshAccount(providerId, context.persistProviderCredential); }
        catch (error) {
          try { await context.nativeRuntime.logout(providerId); }
          finally { context.forgetProviderCredential?.(providerId); }
          invalidateProviderCache();
          throw error;
        }
        invalidateProviderCache();
        return sendJson(res, 200, await workspaceState());
      }
      if (route === "/native/logout") {
        if (!context.nativeRuntime || context.nativeRuntimeStatus?.().ready === false) {
          throw new AppError("conflict", context.nativeRuntimeStatus?.().error ?? "Native runtime is unavailable");
        }
        const { providerId } = NativeProviderSchema.parse(body);
        let cleanupError: unknown;
        for (const [loginId, loginProviderId] of pendingNativeLogins) {
          if (loginProviderId !== providerId) continue;
          try { await context.nativeRuntime.cancelLogin(loginId); }
          catch (error) { cleanupError ??= error; }
          finally { pendingNativeLogins.delete(loginId); }
        }
        try { await context.nativeRuntime.logout(providerId); }
        catch (error) { cleanupError ??= error; }
        finally { context.forgetProviderCredential?.(providerId); }
        invalidateProviderCache();
        if (cleanupError) throw cleanupError;
        return sendJson(res, 200, await workspaceState());
      }
      if (route === "/native/retry") {
        if (context.prepareNativeRuntime) {
          try { await context.prepareNativeRuntime(); }
          catch { throw new AppError("conflict", context.nativeRuntimeStatus?.().error ?? "Native runtime could not be started"); }
          invalidateProviderCache();
        }
        return sendJson(res, 200, await workspaceState());
      }
      if (route === "/research/start") {
        const { threadId } = StartResearchSchema.parse(body); requireThread(threadId);
        const validation = cachedValidation ?? await validateProviders();
        const scope = threads.getScope(threadId); if (!scope) throw new AppError("conflict", "Save the research scope first.");
        const config = threads.getLatestRunConfig(threadId) ?? RunConfigSchema.parse(DEFAULT_RUN_CONFIG);
        if (!isResearchModeReady(config, validation, validation.codex, validation.native)) {
          if (config.model.providerId === LEGACY_CODEX_PROVIDER_ID) {
            if (!validation.codex.detected) throw new AppError("conflict", "Codex CLI not found");
            if (!validation.codex.compatible) throw new AppError("conflict", "Installed Codex version is incompatible");
            if (!validation.codex.authenticated) throw new AppError("conflict", "Codex is not signed in");
          } else {
            if (!validation.native.available) throw new AppError("conflict", validation.native.error ?? "Native runtime is unavailable");
            if (!validation.native.connected) throw new AppError("conflict", "Connect the selected native model provider before starting research");
          }
          throw new AppError("conflict", `Connect ${config.searchProvider === "exa" ? "Exa" : "Perplexity"} before discovering problems.`);
        }
        if (!cachedModels.some((model) => sameModelRef(model, config.model))) throw new AppError("conflict", "Selected model is unavailable");
        if (config.researchMode === "known-problem" && !config.knownProblem.trim()) throw new AppError("validation_error", "Problem statement is required.");
        try {
          const runId = config.researchMode === "known-problem"
            ? await ensureEngine().startKnownProblem(threadId, scope, config.knownProblem, config)
            : await ensureEngine().startDiscovery(threadId, scope, config);
          return sendJson(res, 200, { runId, workspace: await workspaceState() });
        }
        catch (error) { if (error instanceof ActiveRunConflictError) throw new AppError("conflict", "This research already has an active run."); throw error; }
      }
      if (route === "/research/select-problems") {
        const input = SelectProblemsSchema.parse(body); requireThread(input.threadId);
        const runId = latestDiscoveryRun(input.threadId); if (!runId) throw new AppError("conflict", "No completed discovery run is ready for selection.");
        const known = new Set((db.db.prepare("SELECT id FROM problems WHERE discovery_run_id = ?").all(runId) as Array<{ id: string }>).map((item) => item.id));
        if (input.problemIds.some((id) => !known.has(id))) throw new AppError("conflict", "A selected problem no longer belongs to the latest discovery run.");
        db.db.exec("BEGIN IMMEDIATE");
        try {
          db.db.prepare("UPDATE problems SET selected_at = NULL WHERE discovery_run_id = ?").run(runId);
          const selectedAt = new Date().toISOString();
          for (const id of input.problemIds) db.db.prepare("UPDATE problems SET selected_at = ? WHERE id = ?").run(selectedAt, id);
          db.db.prepare(`
            DELETE FROM problems
            WHERE discovery_run_id = ? AND verdict = 'user-asserted' AND selected_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM research_runs rr WHERE rr.problem_id = problems.id)
          `).run(runId);
          if (input.userProblem) {
            const existing = db.db.prepare("SELECT id FROM problems WHERE discovery_run_id = ? AND verdict = 'user-asserted' AND statement = ? ORDER BY created_at, id LIMIT 1")
              .get(runId, input.userProblem) as { id: string } | undefined;
            if (existing) db.db.prepare("UPDATE problems SET selected_at = ? WHERE id = ?").run(selectedAt, existing.id);
            else db.db.prepare(`
              INSERT INTO problems (id, discovery_run_id, statement, why_it_persists, affected, scale_estimate, scale_basis_factor_id,
                verdict, verdict_reason, verdict_source_ids_json, selected_at, created_at)
              VALUES (?, ?, ?, '', '', '', NULL, 'user-asserted', 'Selected by the user.', '[]', ?, ?)
            `).run(randomUUID(), runId, input.userProblem, selectedAt, selectedAt);
          }
          db.db.exec("COMMIT");
        } catch (error) { db.db.exec("ROLLBACK"); throw error; }
        if (input.problemIds.length === 0 && !input.userProblem) { threads.updateThreadStatus(input.threadId, "problems-ready"); return sendJson(res, 200, await workspaceState()); }
        const config = threads.getLatestRunConfig(input.threadId) ?? DEFAULT_RUN_CONFIG;
        try { await ensureEngine().startNextSelected(input.threadId, config); }
        catch (error) { if (error instanceof ActiveRunConflictError) throw new AppError("conflict", "This research already has an active run."); throw error; }
        return sendJson(res, 200, await workspaceState());
      }
      if (route === "/research/resume") {
        const { runId } = ResumeResearchSchema.parse(body); await ensureEngine().resumeRun(runId); return sendJson(res, 200, { workspace: await workspaceState() });
      }
      if (route === "/research/select-option") {
        const input = SelectOptionSchema.parse(body);
        requireThread(input.threadId);
        await ensureEngine().selectOption(input.threadId, input.runId, input.solutionId);
        return sendJson(res, 200, await workspaceState());
      }
      if (route === "/research/evidence-follow-up") {
        const input = EvidenceFollowUpRequestSchema.parse(body);
        requireThread(input.threadId);
        await ensureEngine().requestEvidenceFollowUp(input.threadId, input.runId, input.question);
        return sendJson(res, 200, await workspaceState());
      }
      if (route === "/research/decision") {
        const input = SaveDecisionSchema.parse(body);
        const belongs = db.db.prepare(`SELECT da.id FROM decision_analyses da JOIN research_runs rr ON rr.id = da.research_run_id
          WHERE rr.thread_id = ? AND da.solution_id = ?`).get(input.threadId, input.solutionId) as { id: string } | undefined;
        if (!belongs) throw new AppError("not_found", "Selected analysis does not belong to this project.");
        db.db.prepare("UPDATE decision_analyses SET user_decision = ?, observed_result = ?, updated_at = ? WHERE id = ?")
          .run(input.userDecision, input.observedResult, new Date().toISOString(), belongs.id);
        return sendJson(res, 200, await workspaceState());
      }
      if (route === "/research/cancel") {
        const { runId } = ResumeResearchSchema.parse(body); cancelRun(runId); return sendJson(res, 200, { workspace: await workspaceState() });
      }
      if (route === "/research/export") {
        const input = ExportResearchRequestSchema.parse(body); requireThread(input.threadId);
        const thread = db.db.prepare("SELECT title FROM threads WHERE id = ?").get(input.threadId) as { title: string };
        return sendJson(res, 200, { filename: `${slug(thread.title)}-research.json`, content: JSON.stringify(researchExport(input.threadId), null, 2) });
      }
      if (route === "/ideas/export") {
        const input = ExportIdeasRequestSchema.parse(body); requireThread(input.threadId); const ideas = listSolutions(input.threadId);
        const files = [...new Set(ideas.map((idea) => idea.problemId))].map((problemId, index) => {
          const group = ideas.filter((idea) => idea.problemId === problemId);
          const filename = `${slug(group[0]!.problemStatement)}-${index + 1}.${input.format === "json" ? "json" : "md"}`;
          const exportedGroup = input.format === "json"
            ? group.map((idea) => {
              const usage = solutionRunUsage(idea.id);
              return { ...idea, ...(usage ? { usage } : {}) };
            })
            : group;
          const followUpMarkdown = input.format === "markdown"
            ? [...new Map(group.flatMap((idea) => idea.runId && idea.evidenceFollowUp ? [[idea.runId, idea.evidenceFollowUp] as const] : [])).values()]
              .map(renderEvidenceFollowUpMarkdown).join("\n")
            : "";
          return { filename, content: input.format === "json" ? JSON.stringify(exportedGroup, null, 2) : `${renderMarkdown(group)}${followUpMarkdown}` };
        });
        return sendJson(res, 200, { files });
      }
      throw new AppError("not_found", "Route not found.");
    } catch (error) {
      const normalized = toErrorPayload(error);
      if (normalized.error.code === "internal_error") context.log?.({ level: "error", event: "backend-request-failed", message: "Unexpected backend request failure", context: { method, route, durationMs: Date.now() - startedAt }, error });
      sendError(res, error);
    }
  };
  const server = createServer((req, res) => {
    const pending = handleRequest(req, res);
    pendingRequests.add(pending);
    void pending.then(
      () => pendingRequests.delete(pending),
      () => pendingRequests.delete(pending),
    );
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError);
        resolve();
      });
    });
  } catch (error) {
    db.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Backend failed to bind");
  void validateProviders().catch(() => undefined);
  return {
    port: address.port, token,
    close: async () => {
      let closeError: unknown;
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
          server.closeAllConnections();
        });
      } catch (error) {
        closeError = error;
      } finally {
        await Promise.allSettled([...pendingRequests]);
        await engine?.shutdown();
        await context.nativeRuntime?.close();
        db.close();
      }
      if (closeError) throw closeError;
    },
    secretsChanged: () => {
      cancelActiveRuns(engine);
      engine = null;
      invalidateProviderCache();
      void validateProviders(true).catch(() => undefined);
    },
    providersChanged: () => {
      invalidateProviderCache();
      void validateProviders(true).catch(() => undefined);
    },
  };
}

async function inspectNativeRuntime(
  runtime?: RuntimeClient,
  unavailableReason?: string,
  startup?: { ready: boolean; error?: string },
): Promise<{
  available: boolean;
  connected: boolean;
  version?: string;
  accounts: Array<{ providerId: string; email?: string | undefined; accountId?: string | undefined; plan?: string | undefined }>;
  models: ModelOption[];
  error?: string;
}> {
  if (!runtime) return { available: false, connected: false, accounts: [], models: [], error: unavailableReason ?? "Native runtime is not installed" };
  if (startup && !startup.ready) {
    return { available: false, connected: false, accounts: [], models: [], error: startup.error ?? "Native runtime is starting" };
  }
  try {
    const initialized = await runtime.start();
    const accounts = await runtime.listAccounts();
    const listed = (await Promise.all(accounts.map((account) => runtime.listModels(account.providerId)))).flat();
    const models = listed.filter((model) => model.supportsStructuredOutput).map((model) => {
      const efforts = model.supportedReasoningEfforts?.length ? model.supportedReasoningEfforts : [model.defaultReasoningEffort ?? "medium"];
      return {
        ...model.identity,
        displayName: model.displayName,
        defaultReasoningEffort: model.defaultReasoningEffort ?? efforts[0]!,
        reasoningEfforts: efforts.map((id) => ({ id, description: model.reasoningEffortDescriptions?.[id] ?? "" })),
      };
    });
    return { available: true, connected: accounts.length > 0, version: initialized.runtime.version, accounts, models };
  } catch (error) {
    return {
      available: false,
      connected: false,
      accounts: [],
      models: [],
      error: error instanceof Error ? error.message : "Native runtime validation failed",
    };
  }
}

function renderMarkdown(ideas: SolutionView[]): string {
  if (ideas.some((idea) => idea.workflowVersion === 2)) return renderDecisionMarkdown(ideas);
  const first = ideas[0]!;
  const evidence = first.factors.length > 0
    ? first.factors.flatMap((factor) => [
      `### ${factor.subject}`,
      "",
      factor.behavior,
      "",
      `> ${factor.quote}`,
      "",
      ...(factor.uncertainty ? [`Uncertainty: ${factor.uncertainty}`, ""] : []),
      `Source: [${factor.sourceTitle}](${factor.sourceUrl})`,
      "",
    ])
    : [first.problemVerdict === "user-asserted"
      ? "No source-backed factors. This problem was user-asserted."
      : "No source-backed factors are attached to this problem.", ""];
  return [`# ${first.problemStatement}`, "", "## Evidence behind the problem", "", ...evidence, ...ideas.flatMap((idea, index) => [
    `## ${index + 1}. ${idea.mechanism}`, "", idea.description, "",
    `Off-limits check: ${idea.respectsOffLimits ? "respects" : "possible conflict"} — ${idea.respectsOffLimitsWhy}`, "",
    "### Outcomes", "", ...idea.outcomes.map((outcome) => `- ${outcome.direction}: ${outcome.description} (${outcome.addressesCore ? "addresses core" : "indirect"})`), "",
    "### Risks", "", ...idea.risks.map((risk) => `- ${risk.likelihood} / ${risk.impact}: ${risk.description}${risk.mitigations.length ? `\n  - Proposed response: ${risk.mitigations.map((m) => `${m.approach}; fails if ${m.failsIf}`).join(" | ")}` : ""}`), "",
  ])].join("\n");
}
function renderDecisionMarkdown(ideas: SolutionView[]): string {
  return ideas.flatMap((idea) => {
    const analysis = idea.decisionAnalysis;
    return [
      `# ${idea.mechanism}`, "", idea.description, "", `Problem: ${idea.problemStatement}`, "",
      `Workflow: v2. ${idea.selected ? "Selected by the user." : "Not selected."} Problem evidence: ${idea.problemVerdict}.`, "",
      `Key assumption: ${idea.keyAssumption}`, "", `Current approach may suffice: ${idea.whyCurrentApproachMaySuffice}`, "",
      `Constraints: ${idea.respectsOffLimitsWhy}`, "", "## Uncertainty", "", ...(idea.unknowns ?? []).map((item) => `- ${item}`), "",
      "## Supporting observations", "", ...idea.factors.flatMap((factor) => [
        `> ${factor.quote}`, "", ...(factor.uncertainty ? [`Uncertainty: ${factor.uncertainty}`, ""] : []),
        `[${factor.sourceTitle}](${factor.sourceUrl})`, "",
      ]),
      "## Contrary evidence considered", "", ...(idea.contrarySources ?? []).flatMap((source) => [`[${source.title}](${source.url})`, "", source.text, ""]),
      ...(analysis ? [
        "## Model analysis, not observed results", "", ...analysis.consequences.map((item) => `- ${item.direction}: ${item.description}. Affects ${item.affects}. ${item.rationale}`), "",
        "## Decisive risks", "", ...analysis.risks.map((risk) => `- ${risk.description}: ${risk.whyDecisive}`), "",
        "## Proposed responses, untested", "", ...analysis.proposedResponses.map((response) => `- ${response.approach}. Cost: ${response.cost}. Fails if: ${response.failsIf}`), "",
        "## Open questions", "", ...analysis.unknowns.map((item) => `- ${item}`), "",
        "## Next experiment", "", analysis.experiment.question, "", analysis.experiment.method, "",
        `Cost: ${analysis.experiment.cost}`, "", `Pass: ${analysis.experiment.passCriterion}`, "", `Fail: ${analysis.experiment.failCriterion}`, "",
      ] : ["No completed analysis for this option.", ""]),
      "## User decision", "", idea.userDecision || "Not recorded.", "",
      "## Observed test result", "", idea.observedResult || "Not recorded. Proposed responses remain untested.", "",
    ];
  }).join("\n");
}
function renderEvidenceFollowUpMarkdown(followUp: {
  question: string; status: string; error: string | null;
  sources: unknown[]; factors: unknown[];
}): string {
  const sources = followUp.sources as Array<Record<string, unknown>>;
  const factors = followUp.factors as Array<Record<string, unknown>>;
  return [
    "", "## Evidence follow-up", "", `Question: ${followUp.question}`, "", `Status: ${followUp.status}`, "",
    ...(followUp.error ? [`Error: ${followUp.error}`, ""] : []),
    ...factors.flatMap((factor) => [
      `### ${String(factor.subject)}`, "", String(factor.behavior), "", `> ${String(factor.quote)}`, "",
      ...(factor.uncertainty === null || factor.uncertainty === undefined ? [] : [`Uncertainty: ${String(factor.uncertainty)}`, ""]),
      `Source ID: ${String(factor.sourceId)}`, "",
    ]),
    ...sources.flatMap((source) => [
      `[${String(source.title)}](${String(source.url)})`, "", String(source.text), "",
    ]),
  ].join("\n");
}
function placeholders(values: readonly unknown[]): string { return values.map(() => "?").join(", "); }
function groupRows<T>(rows: Array<Record<string, unknown>>, key: string, map: (row: Record<string, unknown>) => T): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const id = String(row[key]);
    const values = grouped.get(id) ?? [];
    values.push(map(row));
    grouped.set(id, values);
  }
  return grouped;
}
function mapFactor(factor: Record<string, unknown>): FactorView {
  return {
    id: String(factor.id), subject: String(factor.subject), behavior: String(factor.behavior), quote: String(factor.quote),
    sourceId: String(factor.source_id), sourceTitle: String(factor.source_title), sourceUrl: String(factor.canonical_url),
    harvestMode: String(factor.harvest_mode) as "domain" | "audience", modelConfidence: Number(factor.model_confidence),
    ...(factor.uncertainty === null || factor.uncertainty === undefined ? {} : { uncertainty: String(factor.uncertainty) }),
  };
}
function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "problem"; }
function authorize(req: IncomingMessage, token: string): boolean { return req.headers.authorization === `Bearer ${token}`; }
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const buffer = Buffer.from(chunk); size += buffer.length; if (size > 1_000_000) throw new AppError("validation_error", "Request body is too large."); chunks.push(buffer); }
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new AppError("validation_error", "Request body must be valid JSON."); }
}
function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(status < 400 ? { ok: true, data: value } : value));
}
function sendError(res: ServerResponse, error: unknown): void { const normalized = toErrorPayload(error); sendJson(res, normalized.status, { ok: false, error: normalized.error }); }
