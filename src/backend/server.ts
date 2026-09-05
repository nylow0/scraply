import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ResearchEngine } from "../core/research-engine";
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
  CreateThreadRequestSchema, DeleteThreadRequestSchema, ExportIdeasRequestSchema, ExportResearchRequestSchema,
  GetIdeaDetailRequestSchema, GetSourceDetailRequestSchema, HealthResponseSchema,
  NativeLoginCancelSchema, NativeLoginCompleteSchema, NativeLoginStartSchema, NativeProviderSchema,
  ResumeResearchSchema, SaveFavoriteModelSchema, SaveRunConfigSchema, SaveScopeSchema,
  SelectProblemsSchema, SelectThreadRequestSchema, SourceDetailSchema, StartResearchSchema,
  ValidationStateSchema, WorkspaceStateSchema, type FactorView, type ProblemCandidate, type RejectedProblemCandidate, type ResearchEvent,
  type SolutionView, type ValidationState,
} from "../shared/ipc";
import {
  DEFAULT_RUN_CONFIG, LEGACY_CODEX_PROVIDER_ID, ModelCatalogSchema, RunConfigSchema, sameModelRef,
  type ModelCatalog, type ModelOption, type ModelRef, type RunConfig,
} from "../shared/schemas";
import type { LogInput } from "../shared/logging";
import { discoveryRunProjection } from "../core/discovery";

export interface BackendContext {
  dataDir: string;
  dbPath: string;
  bundledPromptsDir: string;
  promptOverridesDir: string;
  appVersion: string;
  getSecrets: () => { exaApiKey: string | null; perplexityApiKey?: string | null };
  modelClients?: Partial<Record<string, StructuredModelClient>>;
  nativeRuntime?: RuntimeClient;
  nativeRuntimeError?: string;
  nativeRuntimeStatus?: () => { ready: boolean; error?: string };
  prepareNativeRuntime?: () => Promise<void>;
  persistProviderCredential?: (providerId: string, credential: string) => Promise<void>;
  forgetProviderCredential?: (providerId: string) => void;
  log?: (input: Omit<LogInput, "component">) => void;
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
  new GenerationAttemptRepository(db).interruptInFlight("The backend restarted before the generation reached a durable terminal result");
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
      const searchClients: Partial<Record<SearchProvider, SearchClient>> = {};
      if (exaApiKey) searchClients.exa = new ExaClient(exaApiKey);
      if (perplexityApiKey) searchClients.perplexity = new PerplexityClient(perplexityApiKey);
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
      solutions: activeThreadId ? listSolutions(activeThreadId) : [],
      latestResearchRun: activeThreadId ? latestRun(activeThreadId) : null,
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
    return rows.map((row) => {
      const factors = listProblemFactors(String(row.id));
      return {
        id: String(row.id), statement: String(row.statement), whyItPersists: String(row.why_it_persists),
        affected: String(row.affected), scaleEstimate: String(row.scale_estimate), verdict: String(row.verdict) as ProblemCandidate["verdict"],
        verdictReason: String(row.verdict_reason), selected: row.selected_at !== null,
        factors,
        singleHarvestModeWarning: factors.length > 0 && new Set(factors.map((factor) => factor.harvestMode)).size === 1,
      };
    });
  }
  function listProblemFactors(problemId: string): FactorView[] {
    const rows = db.db.prepare(`
      SELECT f.*, s.title AS source_title, s.canonical_url
      FROM problem_factors pf JOIN factors f ON f.id = pf.factor_id JOIN sources s ON s.id = f.source_id
      WHERE pf.problem_id = ? ORDER BY f.created_at, f.id
    `).all(problemId) as Array<Record<string, unknown>>;
    return rows.map((factor) => ({
      id: String(factor.id), subject: String(factor.subject), behavior: String(factor.behavior), quote: String(factor.quote),
      sourceId: String(factor.source_id), sourceTitle: String(factor.source_title), sourceUrl: String(factor.canonical_url),
      harvestMode: String(factor.harvest_mode) as "domain" | "audience", modelConfidence: Number(factor.model_confidence),
    }));
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
  function listSolutions(threadId: string): SolutionView[] {
    const rows = db.db.prepare(`
      SELECT s.*, p.statement AS problem_statement, p.verdict AS problem_verdict
      FROM solutions s JOIN problems p ON p.id = s.problem_id
      JOIN research_runs rr ON rr.id = s.research_run_id
      WHERE rr.thread_id = ? AND rr.status = 'completed'
        AND p.selected_at IS NOT NULL
        AND p.discovery_run_id = (
          SELECT id FROM research_runs
          WHERE thread_id = ? AND problem_id IS NULL AND status = 'completed'
          ORDER BY created_at DESC, rowid DESC LIMIT 1
        )
      ORDER BY s.created_at, s.id
    `).all(threadId, threadId) as Array<Record<string, unknown>>;
    const result = rows.map((row): SolutionView => {
      const outcomes = (db.db.prepare("SELECT * FROM outcomes WHERE solution_id = ? ORDER BY created_at, id").all(row.id) as Array<Record<string, unknown>>)
        .map((item) => ({ id: String(item.id), description: String(item.description), direction: String(item.direction) as "positive" | "negative", affects: String(item.affects), addressesCore: Boolean(item.addresses_core) }));
      const risks = (db.db.prepare("SELECT * FROM risks WHERE solution_id = ? ORDER BY sort_key DESC, created_at, id").all(row.id) as Array<Record<string, unknown>>)
        .map((item) => {
          const mitigations = (db.db.prepare(`
            SELECT m.* FROM risk_mitigations rm JOIN mitigations m ON m.id = rm.mitigation_id WHERE rm.risk_id = ? ORDER BY m.created_at, m.id
          `).all(item.id) as Array<Record<string, unknown>>).map((mitigation) => ({
            id: String(mitigation.id), approach: String(mitigation.approach), cost: String(mitigation.cost), failsIf: String(mitigation.fails_if),
            riskIds: (db.db.prepare("SELECT risk_id FROM risk_mitigations WHERE mitigation_id = ?").all(mitigation.id) as Array<{ risk_id: string }>).map((link) => link.risk_id),
          }));
          return { id: String(item.id), description: String(item.description), likelihood: String(item.likelihood) as "rare" | "possible" | "likely",
            impact: String(item.impact) as "≤3 days lost" | "~2 weeks" | "~2 months" | "project ends", sortKey: Number(item.sort_key), mitigations };
        });
      return {
        id: String(row.id), problemId: String(row.problem_id), problemStatement: String(row.problem_statement),
        problemVerdict: String(row.problem_verdict) as SolutionView["problemVerdict"], mechanism: String(row.mechanism),
        factors: listProblemFactors(String(row.problem_id)),
        description: String(row.description), respectsOffLimits: Boolean(row.respects_off_limits), respectsOffLimitsWhy: String(row.respects_off_limits_why),
        outcomes, risks, confirmedCoreOutcomes: outcomes.filter((outcome) => outcome.addressesCore).length,
        unaddressedCatastrophicRisks: risks.filter((risk) => risk.impact === "project ends" && risk.mitigations.length === 0).length,
      };
    });
    return result.sort((left, right) => right.confirmedCoreOutcomes - left.confirmedCoreOutcomes);
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
      SELECT id, subject, behavior, quote, source_id, harvest_mode, model_confidence, created_at
      FROM factors WHERE research_run_id = ? ORDER BY created_at, id
    `).all(runId) as Array<Record<string, unknown>>).map((factor) => ({
      id: String(factor.id), subject: String(factor.subject), behavior: String(factor.behavior), quote: String(factor.quote),
      sourceId: String(factor.source_id), harvestMode: String(factor.harvest_mode), modelConfidence: Number(factor.model_confidence),
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
    };
  }
  function latestRun(threadId: string) {
    const row = db.db.prepare("SELECT id, status, problem_id, config_json FROM research_runs WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(threadId) as { id: string; status: string; problem_id: string | null; config_json: string } | undefined;
    if (!row) return null;
    const runConfig = RunConfigSchema.parse({ ...DEFAULT_RUN_CONFIG, ...JSON.parse(row.config_json) });
    const counts = db.db.prepare(`SELECT provider, COUNT(*) AS count FROM cost_ledger WHERE research_run_id = ? AND status IN ('reserved','committed') GROUP BY provider`)
      .all(row.id) as Array<{ provider: string; count: number }>;
    const projection = row.problem_id ? { modelCalls: MAX_DEVELOPMENT_PROJECTED_CALLS, searches: 0 } : discoveryRunProjection(runConfig.discoveryDepth);
    const activity = db.db.prepare("SELECT payload_json FROM job_events WHERE run_id = ? AND type = 'run-progress' ORDER BY id DESC LIMIT 1")
      .get(row.id) as { payload_json: string } | undefined;
    return {
      runId: row.id, status: row.status, problemId: row.problem_id,
      codexCalls: counts.find((item) => item.provider === runConfig.model.providerId)?.count ?? 0,
      searches: counts.find((item) => item.provider === runConfig.searchProvider)?.count ?? 0,
      projectedCodexCalls: projection.modelCalls, projectedSearches: projection.searches,
      lastActivity: activity ? String(JSON.parse(activity.payload_json).message ?? "") : null,
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
        const idea = listSolutions(activeThreadId ?? "").find((item) => item.id === ideaId);
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
          return { filename, content: input.format === "json" ? JSON.stringify(group, null, 2) : renderMarkdown(group) };
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
  const first = ideas[0]!;
  const evidence = first.factors.length > 0
    ? first.factors.flatMap((factor) => [
      `### ${factor.subject}`,
      "",
      factor.behavior,
      "",
      `> ${factor.quote}`,
      "",
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
