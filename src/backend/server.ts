import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ResearchEngine } from "../core/research-engine";
import { DatabaseClient } from "../db/client";
import { ActiveRunConflictError } from "../db/repositories/research-runs";
import { ThreadRepository } from "../db/repositories/threads";
import { CodexClient, listCodexModels, probeCodexCli } from "../providers/codex";
import { ExaClient } from "../providers/exa";
import type { StructuredModelClient } from "../providers/structured";
import { AppError, toErrorPayload } from "../shared/errors";
import { MAX_DEVELOPMENT_PROJECTED_CALLS } from "../shared/development-projection";
import {
  CreateThreadRequestSchema, DeleteThreadRequestSchema, ExportIdeasRequestSchema,
  GetIdeaDetailRequestSchema, GetSourceDetailRequestSchema, HealthResponseSchema,
  ResumeResearchSchema, SaveFavoriteModelSchema, SaveRunConfigSchema, SaveScopeSchema,
  SelectProblemsSchema, SelectThreadRequestSchema, SourceDetailSchema, StartResearchSchema,
  ValidationStateSchema, WorkspaceStateSchema, type ProblemCandidate, type ResearchEvent,
  type SolutionView, type ValidationState,
} from "../shared/ipc";
import {
  DEFAULT_RUN_CONFIG, ModelCatalogSchema, RunConfigSchema,
  type ModelCatalog, type ModelOption, type ModelProvider, type ModelRef, type RunConfig,
} from "../shared/schemas";
import type { LogInput } from "../shared/logging";
import { discoveryRunProjection } from "../core/discovery";

export interface BackendContext {
  dataDir: string;
  dbPath: string;
  bundledPromptsDir: string;
  promptOverridesDir: string;
  appVersion: string;
  getSecrets: () => { exaApiKey: string | null };
  modelClients?: Partial<Record<ModelProvider, StructuredModelClient>>;
  log?: (input: Omit<LogInput, "component">) => void;
  providerValidation?: {
    probeCodex?: () => Promise<{ detected: boolean; compatible: boolean; version?: string; error?: string }>;
    listCodexModels?: () => Promise<ModelOption[]>;
    validateExa?: (apiKey: string) => Promise<{ valid: boolean; error?: string }>;
  };
}

export function createBackendClients(secrets: { exaApiKey: string | null }) {
  if (!secrets.exaApiKey) throw new AppError("conflict", "Configure Exa before starting research.");
  return { codex: new CodexClient(), exa: new ExaClient(secrets.exaApiKey) };
}

function fallbackModelOption(): ModelOption {
  return {
    id: DEFAULT_RUN_CONFIG.model,
    displayName: DEFAULT_RUN_CONFIG.model,
    defaultReasoningEffort: DEFAULT_RUN_CONFIG.reasoningEffort,
    reasoningEfforts: [{ id: DEFAULT_RUN_CONFIG.reasoningEffort, description: "" }],
  };
}
export function isSetupComplete(exa: { valid: boolean }, codex: { detected: boolean; compatible: boolean }): boolean {
  return exa.valid && codex.detected && codex.compatible;
}
export interface BackendHandle { port: number; token: string; close: () => Promise<void>; secretsChanged: () => void }

export async function startBackend(context: BackendContext, onEvent: (event: ResearchEvent) => void): Promise<BackendHandle> {
  const token = randomBytes(24).toString("hex");
  const db = new DatabaseClient(context.dbPath);
  const threads = new ThreadRepository(db);
  db.setMeta("persistence_probe", `ok-${Date.now()}`);
  let activeThreadId: string | null = db.getSetting("active_thread_id") || null;
  let cachedValidation: ValidationState | null = null;
  let validationPromise: Promise<ValidationState> | null = null;
  let cachedCodexModels: string[] = [];
  let cachedModelOptions: ModelOption[] = [];
  let validationGeneration = 0;
  let engine: ResearchEngine | null = null;
  const subscribers = new Set<(event: ResearchEvent) => void>();

  const clients = () => createBackendClients(context.getSecrets());
  const emitEvent = (event: ResearchEvent) => {
    onEvent(event);
    for (const subscriber of subscribers) subscriber(event);
  };
  const ensureEngine = () => {
    if (!engine) {
      const built = clients();
      engine = new ResearchEngine({
        db,
        modelClients: { codex: context.modelClients?.codex ?? built.codex },
        exa: built.exa,
        onEvent: emitEvent,
      });
    }
    return engine;
  };

  async function ensureCodexModels(): Promise<ModelOption[]> {
    if (cachedModelOptions.length > 0) return cachedModelOptions;
    const generation = validationGeneration;
    const listed = await (context.providerValidation?.listCodexModels ?? listCodexModels)();
    if (generation === validationGeneration) {
      cachedModelOptions = listed;
      cachedCodexModels = listed.map((model) => model.id);
    }
    return listed;
  }

  async function validateProviders(): Promise<ValidationState> {
    if (validationPromise) return validationPromise;
    const generation = validationGeneration;
    validationPromise = (async () => {
      const secrets = context.getSecrets();
      const [codex, models, exa] = await Promise.all([
        (context.providerValidation?.probeCodex ?? probeCodexCli)(),
        ensureCodexModels(),
        secrets.exaApiKey
          ? (context.providerValidation?.validateExa ?? ((key: string) => new ExaClient(key).validateKey()))(secrets.exaApiKey)
          : Promise.resolve({ valid: false, error: "Exa key missing" }),
      ]);
      const value = ValidationStateSchema.parse({ exa, codex, setupComplete: isSetupComplete(exa, codex) });
      context.log?.({
        level: value.setupComplete ? "info" : "warn",
        event: "provider-validation-completed",
        message: value.setupComplete ? "Research providers are ready" : "Research providers need attention",
        context: {
          setupComplete: value.setupComplete,
          exaValid: value.exa.valid,
          exaError: value.exa.error,
          codexDetected: value.codex.detected,
          codexCompatible: value.codex.compatible,
          codexVersion: value.codex.version,
          codexError: value.codex.error,
        },
      });
      if (generation === validationGeneration) { cachedValidation = value; cachedModelOptions = models; cachedCodexModels = models.map((model) => model.id); }
      return value;
    })();
    try { return await validationPromise; }
    finally { validationPromise = null; }
  }
  const pendingValidation = () => ValidationStateSchema.parse({
    exa: { valid: false, error: context.getSecrets().exaApiKey ? "Checking Exa connection" : "Exa key missing" },
    codex: { detected: false, compatible: false, error: "Checking Codex connection" }, setupComplete: false,
  });

  function modelCatalog(): ModelCatalog {
    const favorites = readFavoriteModels();
    return ModelCatalogSchema.parse({ codex: [...new Set([...cachedCodexModels, ...favorites.map((item) => item.id)])], favorites });
  }
  function readFavoriteModels(): ModelRef[] {
    const raw = db.getSetting("favorite_models");
    if (!raw) return [];
    const parsed = ModelCatalogSchema.shape.favorites.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  }
  function saveFavoriteModel(model: ModelRef, favorite: boolean): void {
    const current = readFavoriteModels().filter((item) => !(item.provider === model.provider && item.id === model.id));
    if (favorite) current.push(model);
    db.setSetting("favorite_models", JSON.stringify(current));
  }

  async function workspaceState() {
    if (cachedCodexModels.length === 0) {
      await ensureCodexModels().catch(() => {
        cachedModelOptions = [fallbackModelOption()];
        cachedCodexModels = [DEFAULT_RUN_CONFIG.model];
      });
    }
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
      models: cachedCodexModels,
      modelOptions: cachedModelOptions,
      modelCatalog: modelCatalog(),
      presets: threads.listPresets(),
      problemCandidates: activeThreadId ? listProblems(activeThreadId) : [],
      solutions: activeThreadId ? listSolutions(activeThreadId) : [],
      latestResearchRun: activeThreadId ? latestRun(activeThreadId, runConfig ?? DEFAULT_RUN_CONFIG) : null,
      pendingRuns: listPendingRuns(),
    };
    return WorkspaceStateSchema.parse(state);
  }

  function latestDiscoveryRun(threadId: string): string | null {
    const row = db.db.prepare(`SELECT id FROM research_runs WHERE thread_id = ? AND problem_id IS NULL AND status = 'completed' ORDER BY created_at DESC LIMIT 1`)
      .get(threadId) as { id: string } | undefined;
    return row?.id ?? null;
  }
  function listProblems(threadId: string): ProblemCandidate[] {
    const runId = latestDiscoveryRun(threadId);
    if (!runId) return [];
    const rows = db.db.prepare("SELECT * FROM problems WHERE discovery_run_id = ? ORDER BY created_at, id").all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const factors = db.db.prepare(`
        SELECT f.*, s.title AS source_title, s.canonical_url
        FROM problem_factors pf JOIN factors f ON f.id = pf.factor_id JOIN sources s ON s.id = f.source_id
        WHERE pf.problem_id = ? ORDER BY f.created_at, f.id
      `).all(row.id) as Array<Record<string, unknown>>;
      return {
        id: String(row.id), statement: String(row.statement), whyItPersists: String(row.why_it_persists),
        affected: String(row.affected), scaleEstimate: String(row.scale_estimate), verdict: String(row.verdict) as ProblemCandidate["verdict"],
        verdictReason: String(row.verdict_reason), selected: row.selected_at !== null,
        factors: factors.map((factor) => ({
          id: String(factor.id), subject: String(factor.subject), behavior: String(factor.behavior), quote: String(factor.quote),
          sourceId: String(factor.source_id), sourceTitle: String(factor.source_title), sourceUrl: String(factor.canonical_url),
          harvestMode: String(factor.harvest_mode) as "domain" | "audience", modelConfidence: Number(factor.model_confidence),
        })),
        singleHarvestModeWarning: factors.length > 0 && new Set(factors.map((factor) => factor.harvest_mode)).size === 1,
      };
    });
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
          ORDER BY created_at DESC LIMIT 1
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
        description: String(row.description), respectsOffLimits: Boolean(row.respects_off_limits), respectsOffLimitsWhy: String(row.respects_off_limits_why),
        outcomes, risks, confirmedCoreOutcomes: outcomes.filter((outcome) => outcome.addressesCore).length,
        unaddressedCatastrophicRisks: risks.filter((risk) => risk.impact === "project ends" && risk.mitigations.length === 0).length,
      };
    });
    return result.sort((left, right) => right.confirmedCoreOutcomes - left.confirmedCoreOutcomes);
  }
  function latestRun(threadId: string, config: RunConfig) {
    const row = db.db.prepare("SELECT id, status, problem_id FROM research_runs WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(threadId) as { id: string; status: string; problem_id: string | null } | undefined;
    if (!row) return null;
    const counts = db.db.prepare(`SELECT provider, COUNT(*) AS count FROM cost_ledger WHERE research_run_id = ? AND status IN ('reserved','committed') GROUP BY provider`)
      .all(row.id) as Array<{ provider: string; count: number }>;
    const projection = row.problem_id ? { modelCalls: MAX_DEVELOPMENT_PROJECTED_CALLS, searches: 0 } : discoveryRunProjection(config.discoveryDepth);
    const activity = db.db.prepare("SELECT payload_json FROM job_events WHERE run_id = ? AND type = 'run-progress' ORDER BY id DESC LIMIT 1")
      .get(row.id) as { payload_json: string } | undefined;
    return {
      runId: row.id, status: row.status, problemId: row.problem_id,
      codexCalls: counts.find((item) => item.provider === "codex")?.count ?? 0,
      exaSearches: counts.find((item) => item.provider === "exa")?.count ?? 0,
      projectedCodexCalls: projection.modelCalls, projectedExaSearches: projection.searches,
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

  const server = createServer(async (req, res) => {
    const startedAt = Date.now();
    const method = req.method ?? "GET";
    let route = req.url ?? "/";
    try {
      if (!authorize(req, token)) return sendError(res, new AppError("unauthorized"));
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      route = url.pathname;
      if (method === "GET" && route === "/health") return sendJson(res, 200, HealthResponseSchema.parse({ ok: true, version: context.appVersion, persistenceCheck: db.getMeta("persistence_probe") ?? undefined }));
      if (method === "GET" && route === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        const listener = (event: ResearchEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);
        subscribers.add(listener); req.on("close", () => subscribers.delete(listener)); return;
      }
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
        const input = CreateThreadRequestSchema.parse(body); const thread = threads.createThread(input.title ?? "New research");
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
      if (route === "/research/start") {
        const { threadId } = StartResearchSchema.parse(body); requireThread(threadId);
        const validation = cachedValidation ?? await validateProviders();
        if (!validation.setupComplete) throw new AppError("conflict", "Connect Exa and a compatible Codex CLI before starting research.");
        const scope = threads.getScope(threadId); if (!scope) throw new AppError("conflict", "Save the research scope first.");
        const config = threads.getLatestRunConfig(threadId) ?? RunConfigSchema.parse(DEFAULT_RUN_CONFIG);
        try { const runId = await ensureEngine().startDiscovery(threadId, scope, config); return sendJson(res, 200, { runId, workspace: await workspaceState() }); }
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
              VALUES (?, ?, ?, '', '', '', NULL, 'user-asserted', 'Stated directly by the user.', '[]', ?, ?)
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
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Backend failed to bind");
  void validateProviders().catch(() => undefined);
  return {
    port: address.port, token,
    close: async () => { cancelActiveRuns(engine); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); db.close(); },
    secretsChanged: () => { cancelActiveRuns(engine); engine = null; validationGeneration += 1; cachedValidation = null; cachedCodexModels = []; cachedModelOptions = []; void validateProviders().catch(() => undefined); },
  };
}

function renderMarkdown(ideas: SolutionView[]): string {
  const first = ideas[0]!;
  return [`# ${first.problemStatement}`, "", ...ideas.flatMap((idea, index) => [
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
