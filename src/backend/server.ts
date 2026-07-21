import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { DatabaseClient } from "../db/client";
import { ThreadRepository } from "../db/repositories/threads";
import { buildBriefFromAnswers, generateBriefWithModel, intakeAssistantMessage, newThreadTitle } from "../core/intake";
import { generateIdeas, IdeaGenerationBlockedError } from "../core/ideas";
import { ResearchEngine } from "../core/research-engine";
import { cancelIncompleteRun, listPendingRuns } from "../core/research-recovery";
import { CodexClient, listCodexModels, probeCodexCli } from "../providers/codex";
import { ExaClient } from "../providers/exa";
import { OpenCodeClient } from "../providers/opencode";
import {
  CancelIncompleteResearchSchema,
  CancelResearchSchema,
  ConfirmBriefSchema,
  CreateBranchRequestSchema,
  CreateThreadRequestSchema,
  DeleteThreadRequestSchema,
  ExportIdeasRequestSchema,
  GenerateIdeasRequestSchema,
  GetIdeaDetailRequestSchema,
  GetReportDetailRequestSchema,
  GetSourceDetailRequestSchema,
  HealthResponseSchema,
  IdeaRatingResponseSchema,
  RateIdeaSchema,
  ReportDetailSchema,
  ResumeResearchSchema,
  SaveRunConfigSchema,
  SaveFavoriteModelSchema,
  SelectThreadRequestSchema,
  SourceDetailSchema,
  StartResearchSchema,
  SubmitIntakeAnswerSchema,
  ValidationStateSchema,
  WorkspaceStateSchema,
  type ResearchEvent,
  type ValidationState,
} from "../shared/ipc";
import { AppError, toErrorPayload } from "../shared/errors";
import { DEFAULT_RUN_CONFIG, intakeProgress, nextIntakeQuestion } from "../shared/intake";
import { IdeaSchema, ModelCatalogSchema, type ModelCatalog, type ModelProvider, type ModelRef, RunConfigSchema } from "../shared/schemas";

export interface BackendContext {
  dataDir: string;
  dbPath: string;
  bundledPromptsDir: string;
  promptOverridesDir: string;
  getSecrets: () => { opencodeApiKey: string | null; exaApiKey: string | null };
  providerValidation?: {
    probeCodex?: () => Promise<{ detected: boolean; compatible: boolean; version?: string; error?: string }>;
    listCodexModels?: () => Promise<string[]>;
    validateExa?: (apiKey: string) => Promise<{ valid: boolean; error?: string }>;
    validateOpenCode?: (apiKey: string) => Promise<{ valid: boolean; models: string[]; error?: string }>;
  };
}

export function createBackendClients(secrets: { opencodeApiKey: string | null; exaApiKey: string | null }) {
  if (!secrets.exaApiKey) throw new AppError("conflict", "Configure Exa before starting research.");
  const opencode = secrets.opencodeApiKey ? new OpenCodeClient({ apiKey: secrets.opencodeApiKey }) : undefined;
  return {
    codex: new CodexClient(),
    opencode,
    exa: new ExaClient(secrets.exaApiKey),
  };
}

export function isSetupComplete(
  exa: { valid: boolean },
  codex: { detected: boolean; compatible: boolean },
  opencode: { valid: boolean } = { valid: false },
): boolean {
  return exa.valid && ((codex.detected && codex.compatible) || opencode.valid);
}

export interface BackendHandle {
  port: number;
  token: string;
  close: () => Promise<void>;
  emitEvent: (event: ResearchEvent) => void;
  secretsChanged: () => void;
}

export async function startBackend(context: BackendContext, onEvent: (event: ResearchEvent) => void): Promise<BackendHandle> {
  const token = randomBytes(24).toString("hex");
  const db = new DatabaseClient(context.dbPath);
  const threads = new ThreadRepository(db);
  db.setMeta("persistence_probe", `ok-${Date.now()}`);

  let cachedValidation: ValidationState | null = null;
  let cachedModels: string[] = [];
  let cachedCodexModels: string[] = [];
  let activeThreadId: string | null = db.getSetting("active_thread_id");
  let researchEngine: ResearchEngine | null = null;

  function ensureResearchEngine(): ResearchEngine {
    const { opencode, codex, exa } = clients();
    if (!researchEngine) {
      researchEngine = new ResearchEngine({
        db,
        ...(opencode ? { opencode } : {}),
        modelClients: {
          codex,
          ...(opencode ? { opencode } : {}),
        },
        exa,
        onEvent: emitEvent,
        onReport: (threadId, streamName, reportId) => {
          threads.addMessage(threadId, "report", `${streamName} report ready`, { reportId, streamName });
        },
      });
    }
    return researchEngine;
  }

  function clients() {
    return createBackendClients(context.getSecrets());
  }

  function modelClient(provider: ModelProvider) {
    const configured = clients();
    if (provider === "codex") return configured.codex;
    if (configured.opencode) return configured.opencode;
    throw new AppError("conflict", "Configure OpenCode before selecting an OpenCode model.");
  }

  async function validateProviders(validateOptionalOpenCode = false): Promise<ValidationState> {
    const secrets = context.getSecrets();
    const probeCodex = context.providerValidation?.probeCodex ?? probeCodexCli;
    const loadCodexModels = context.providerValidation?.listCodexModels ?? listCodexModels;
    const validateExa = context.providerValidation?.validateExa ?? (async (apiKey: string) => new ExaClient(apiKey).validateKey());
    const validateOpenCode = context.providerValidation?.validateOpenCode
      ?? (async (apiKey: string) => {
        const result = await new OpenCodeClient({ apiKey }).validateKey();
        return result.valid
          ? { valid: true, models: result.models }
          : { valid: false, models: [], error: result.error };
      });
    const [codex, codexModels, exaResult] = await Promise.all([
      probeCodex(),
      loadCodexModels(),
      secrets.exaApiKey ? validateExa(secrets.exaApiKey) : Promise.resolve({ valid: false, error: "Exa key missing" }),
    ]);
    cachedCodexModels = codexModels;
    let open: { valid: boolean; models: string[]; error?: string };
    if (!secrets.opencodeApiKey) {
      open = { valid: false, models: [], error: "OpenCode key not configured (optional)" };
    } else if (validateOptionalOpenCode) {
      open = await validateOpenCode(secrets.opencodeApiKey);
    } else {
      open = { valid: false, models: [], error: "OpenCode validation is optional" };
    }
    cachedModels = open.valid ? open.models : [];
    cachedValidation = ValidationStateSchema.parse({
      opencode: open.valid
        ? { valid: true, modelCount: open.models.length, models: open.models }
        : { valid: false, modelCount: 0, models: [], error: open.error },
      exa: exaResult.valid ? { valid: true } : { valid: false, error: exaResult.error },
      codex,
      setupComplete: isSetupComplete(exaResult, codex, open),
    });
    return cachedValidation;
  }

  async function workspaceState() {
    const validation = cachedValidation ?? await validateProviders();
    const threadList = threads.listThreads();
    const messages = activeThreadId ? threads.getMessages(activeThreadId) : [];
    const brief = activeThreadId ? threads.getLatestBrief(activeThreadId) : null;
    const branchContext = activeThreadId ? threads.getBranchContext(activeThreadId) : null;
    const runConfig = activeThreadId ? threads.getLatestRunConfig(activeThreadId) : null;
    const ideas = activeThreadId ? listIdeas(activeThreadId) : [];
    const reports = activeThreadId ? listReports(activeThreadId) : [];
    const latestResearchRun = activeThreadId ? getLatestResearchRun(activeThreadId) : null;
    return WorkspaceStateSchema.parse({
      validation,
      threads: threadList,
      activeThreadId,
      messages,
      brief,
      branchContext,
      runConfig,
      models: cachedModels,
      modelCatalog: buildModelCatalog(),
      presets: threads.listPresets(),
      ideas,
      reports,
      latestResearchRun,
      pendingRuns: listPendingRuns(db),
    });
  }

  function buildModelCatalog(): ModelCatalog {
    return ModelCatalogSchema.parse({
      opencode: cachedModels,
      codex: cachedCodexModels,
      favorites: readFavoriteModels(),
    });
  }

  function readFavoriteModels(): ModelRef[] {
    const raw = db.getSetting("favorite_models");
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      return ModelCatalogSchema.shape.favorites.parse(parsed);
    } catch {
      return [];
    }
  }

  function saveFavoriteModel(model: ModelRef, favorite: boolean): void {
    const favorites = readFavoriteModels();
    const next = favorites.filter((item) => item.provider !== model.provider || item.id !== model.id);
    if (favorite) next.push(model);
    db.setSetting("favorite_models", JSON.stringify(next));
  }

  function listIdeas(threadId: string) {
    const rows = db.db.prepare("SELECT * FROM ideas WHERE thread_id = ? ORDER BY created_at DESC").all(threadId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id,
      threadId: row.thread_id,
      title: row.title,
      description: row.description,
      bucket: row.bucket,
      scores: JSON.parse(String(row.scores_json)),
      supportingClaimIds: JSON.parse(String(row.supporting_claim_ids_json)),
      createdAt: row.created_at,
    }));
  }

  function listReports(threadId: string) {
    return db.db.prepare("SELECT id, research_run_id, stream_id, title FROM reports WHERE thread_id = ? ORDER BY created_at ASC")
      .all(threadId)
      .map((row) => {
        const record = row as { id: string; research_run_id: string | null; stream_id: string | null; title: string };
        return {
          id: record.id,
          ...(record.research_run_id ? { researchRunId: record.research_run_id } : {}),
          streamId: record.stream_id,
          title: record.title,
        };
      });
  }

  function getLatestResearchRun(threadId: string) {
    const run = db.db.prepare(`
      SELECT id, status FROM research_runs WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(threadId) as { id: string; status: string } | undefined;
    if (!run) return null;
    const synthesis = db.db.prepare(`
      SELECT id FROM reports WHERE research_run_id = ? AND report_kind = 'synthesis'
      ORDER BY created_at DESC LIMIT 1
    `).get(run.id) as { id: string } | undefined;
    const streams = db.db.prepare(`
      SELECT stream_id, status, gap_stop_reason, error
      FROM stream_runs WHERE research_run_id = ? ORDER BY round DESC, created_at DESC
    `).all(run.id) as Array<{
      stream_id: string;
      status: string;
      gap_stop_reason: string | null;
      error: string | null;
    }>;
    const completed = new Set(streams.filter((stream) => stream.status === "completed").map((stream) => stream.stream_id));
    const missingLenses = ["landscape", "exemplars", "pain-gaps", "resources", "analogies", "evaluation"]
      .filter((lens) => !completed.has(lens));
    const gaps = [...new Set(streams.flatMap((stream) => [stream.error, stream.gap_stop_reason]
      .filter((value): value is string => Boolean(value))))];
    return {
      runId: run.id,
      status: run.status,
      synthesisReportId: synthesis?.id ?? null,
      missingLenses,
      gaps,
    };
  }

  function requireThread(threadId: string): void {
    const row = db.db.prepare("SELECT 1 FROM threads WHERE id = ?").get(threadId);
    if (!row) throw new AppError("not_found", "Thread not found.");
  }

  const subscribers = new Set<(event: ResearchEvent) => void>();
  function emitEvent(event: ResearchEvent) {
    onEvent(event);
    for (const subscriber of subscribers) subscriber(event);
  }

  const server = createServer(async (req, res) => {
    try {
      if (!authorize(req, token)) {
        sendError(res, new AppError("unauthorized"));
        return;
      }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, HealthResponseSchema.parse({
          ok: true,
          version: "0.2.0",
          persistenceCheck: db.getMeta("persistence_probe") ?? undefined,
        }));
        return;
      }

      if (method === "GET" && url.pathname === "/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const listener = (event: ResearchEvent) => {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        };
        subscribers.add(listener);
        req.on("close", () => subscribers.delete(listener));
        return;
      }

      if (method === "GET" && url.pathname === "/validation") {
        sendJson(res, 200, await validateProviders(url.searchParams.get("validateOptional") === "1"));
        return;
      }

      if (method === "GET" && url.pathname === "/workspace") {
        sendJson(res, 200, await workspaceState());
        return;
      }

      if (method === "GET" && url.pathname.startsWith("/reports/")) {
        const input = GetReportDetailRequestSchema.parse({ reportId: url.pathname.slice("/reports/".length) });
        const row = db.db.prepare("SELECT id, stream_id, title, html FROM reports WHERE id = ?").get(input.reportId) as
          { id: string; stream_id: string | null; title: string; html: string } | undefined;
        if (!row) throw new AppError("not_found", "Report not found.");
        sendJson(res, 200, ReportDetailSchema.parse({ id: row.id, streamId: row.stream_id, title: row.title, html: row.html }));
        return;
      }

      if (method === "GET" && url.pathname.startsWith("/sources/")) {
        const input = GetSourceDetailRequestSchema.parse({ sourceId: url.pathname.slice("/sources/".length) });
        const row = db.db.prepare(`
          SELECT id, research_run_id, canonical_url, title, retrieved_text, author, published_at, content_hash, retrieved_at
          FROM sources WHERE id = ?
        `).get(input.sourceId) as {
          id: string; research_run_id: string; canonical_url: string; title: string; retrieved_text: string;
          author: string | null; published_at: string | null; content_hash: string; retrieved_at: string;
        } | undefined;
        if (!row) throw new AppError("not_found", "Source not found.");
        sendJson(res, 200, SourceDetailSchema.parse({
          id: row.id,
          researchRunId: row.research_run_id,
          url: row.canonical_url,
          title: row.title,
          text: row.retrieved_text,
          author: row.author ?? undefined,
          publishedDate: row.published_at ?? undefined,
          contentHash: row.content_hash,
          retrievedAt: row.retrieved_at,
        }));
        return;
      }

      if (method === "GET" && url.pathname.startsWith("/ideas/")) {
        const input = GetIdeaDetailRequestSchema.parse({ ideaId: url.pathname.slice("/ideas/".length) });
        const row = db.db.prepare("SELECT * FROM ideas WHERE id = ?").get(input.ideaId) as Record<string, unknown> | undefined;
        if (!row) throw new AppError("not_found", "Idea not found.");
        const rating = db.db.prepare("SELECT rating, notes, updated_at FROM idea_ratings WHERE idea_id = ?").get(input.ideaId) as
          { rating: number; notes: string | null; updated_at: string } | undefined;
        const evidence = db.db.prepare(`
          SELECT ic.claim_id, s.id AS source_id, s.title AS source_title, s.canonical_url, ce.quote
          FROM idea_claims ic
          JOIN claim_evidence ce ON ce.claim_id = ic.claim_id
          JOIN sources s ON s.id = ce.source_id
          WHERE ic.idea_id = ?
          ORDER BY ic.claim_id, s.id
        `).all(input.ideaId) as Array<{
          claim_id: string; source_id: string; source_title: string; canonical_url: string; quote: string;
        }>;
        sendJson(res, 200, IdeaSchema.parse({
          id: row.id,
          threadId: row.thread_id,
          title: row.title,
          description: row.description,
          bucket: row.bucket,
          scores: JSON.parse(String(row.scores_json)),
          supportingClaimIds: JSON.parse(String(row.supporting_claim_ids_json)),
          researchRunId: row.research_run_id ?? undefined,
          generationMode: row.generation_mode ?? undefined,
          currentRating: rating ? { rating: rating.rating, notes: rating.notes, updatedAt: rating.updated_at } : null,
          evidence: evidence.map((item) => ({
            claimId: item.claim_id,
            sourceId: item.source_id,
            sourceTitle: item.source_title,
            url: item.canonical_url,
            quote: item.quote,
          })),
          createdAt: row.created_at,
        }));
        return;
      }

      if (method === "POST") {
        const body = await readBody(req);
        if (url.pathname === "/threads") {
          const input = CreateThreadRequestSchema.parse(body);
          const thread = threads.createThread(input.title ?? "New research");
          activeThreadId = thread.id;
          db.setSetting("active_thread_id", thread.id);
          const first = nextIntakeQuestion(new Set());
          if (first) {
            threads.addMessage(thread.id, "assistant", first.prompt);
          }
          sendJson(res, 200, { thread, workspace: await workspaceState() });
          return;
        }

        if (url.pathname === "/threads/select") {
          const { threadId } = SelectThreadRequestSchema.parse(body);
          requireThread(threadId);
          activeThreadId = threadId;
          db.setSetting("active_thread_id", activeThreadId);
          sendJson(res, 200, await workspaceState());
          return;
        }

        if (url.pathname === "/threads/delete") {
          const { threadId } = DeleteThreadRequestSchema.parse(body);
          requireThread(threadId);
          const activeRuns = db.db.prepare(`
            SELECT id FROM research_runs WHERE thread_id = ? AND status = 'running'
          `).all(threadId) as Array<{ id: string }>;
          for (const run of activeRuns) {
            if (researchEngine) researchEngine.cancelRun(run.id);
            else cancelIncompleteRun(db, run.id);
          }
          db.db.prepare("UPDATE threads SET parent_thread_id = NULL WHERE parent_thread_id = ?").run(threadId);
          threads.deleteThread(threadId);
          if (activeThreadId === threadId) {
            activeThreadId = threads.listThreads()[0]?.id ?? null;
            db.setSetting("active_thread_id", activeThreadId ?? "");
          }
          sendJson(res, 200, await workspaceState());
          return;
        }

        if (url.pathname === "/intake") {
          const input = SubmitIntakeAnswerSchema.parse(body);
          requireThread(input.threadId);
          threads.saveIntakeAnswer(input.threadId, input.questionId, input.answer, input.skipped ?? false);
          if (input.questionId === "goal") {
            threads.renameThread(input.threadId, newThreadTitle(input.answer));
          }
          threads.addMessage(input.threadId, "user", input.skipped ? "(skipped)" : input.answer);
          const answers = threads.getIntakeAnswers(input.threadId);
          const answered = new Set(answers.map((a) => a.questionId));
          const next = nextIntakeQuestion(answered);
          if (next) {
            threads.addMessage(input.threadId, "assistant", next.optional ? `${next.prompt}\n\n(Optional — you can skip.)` : next.prompt);
            threads.updateThreadStatus(input.threadId, "intake");
          } else {
            const config = threads.getLatestRunConfig(input.threadId) ?? RunConfigSchema.parse(DEFAULT_RUN_CONFIG);
            const brief = await generateBriefWithModel(
              modelClient(config.orchestratorProvider),
              config.orchestratorModel,
              answers,
            );
            threads.saveBrief(input.threadId, brief, false);
            threads.addMessage(input.threadId, "assistant", "I've drafted your project brief. Review and edit it below, then confirm to continue.");
            threads.updateThreadStatus(input.threadId, "brief-draft");
          }
          sendJson(res, 200, { progress: intakeProgress(answered), workspace: await workspaceState() });
          return;
        }

        if (url.pathname === "/brief/confirm") {
          const input = ConfirmBriefSchema.parse(body);
          requireThread(input.threadId);
          threads.saveBrief(input.threadId, input.brief, true);
          threads.updateThreadStatus(input.threadId, "brief-confirmed");
          if (!threads.getLatestRunConfig(input.threadId)) {
            threads.saveRunConfig(input.threadId, RunConfigSchema.parse(DEFAULT_RUN_CONFIG));
          }
          threads.updateThreadStatus(input.threadId, "configuring");
          threads.addMessage(input.threadId, "assistant", "Brief confirmed. Configure models and research settings next.");
          sendJson(res, 200, await workspaceState());
          return;
        }

        if (url.pathname === "/run-config") {
          const input = SaveRunConfigSchema.parse(body);
          requireThread(input.threadId);
          threads.saveRunConfig(input.threadId, input.config, input.presetName);
          threads.addMessage(input.threadId, "system", "Run configuration saved.");
          sendJson(res, 200, await workspaceState());
          return;
        }

        if (url.pathname === "/models/favorite") {
          const input = SaveFavoriteModelSchema.parse(body);
          saveFavoriteModel(input.model, input.favorite);
          sendJson(res, 200, await workspaceState());
          return;
        }

        if (url.pathname === "/research/start") {
          const input = StartResearchSchema.parse(body);
          requireThread(input.threadId);
          const brief = threads.getLatestBrief(input.threadId);
          const config = threads.getLatestRunConfig(input.threadId) ?? RunConfigSchema.parse(DEFAULT_RUN_CONFIG);
          if (!brief) throw new AppError("conflict", "Confirm the brief before starting research.");
          const engine = ensureResearchEngine();
          const runId = await engine.startRun(input.threadId, brief, config);
          threads.updateThreadStatus(input.threadId, "research-running");
          threads.addMessage(input.threadId, "event", `Research run ${runId} started.`);
          sendJson(res, 200, { runId, workspace: await workspaceState() });
          return;
        }

        if (url.pathname === "/research/resume") {
          const input = ResumeResearchSchema.parse(body);
          const existing = db.db.prepare("SELECT 1 FROM research_runs WHERE id = ?").get(input.runId);
          if (!existing) throw new AppError("not_found", "Research run not found.");
          const engine = ensureResearchEngine();
          await engine.resumeRun(input.runId);
          const row = db.db.prepare("SELECT thread_id FROM research_runs WHERE id = ?").get(input.runId) as { thread_id: string } | undefined;
          if (row) {
            threads.addMessage(row.thread_id, "event", `Resuming research run ${input.runId}.`);
          }
          sendJson(res, 200, { ok: true, workspace: await workspaceState() });
          return;
        }

        if (url.pathname === "/research/cancel-incomplete") {
          const input = CancelIncompleteResearchSchema.parse(body);
          const existing = db.db.prepare("SELECT 1 FROM research_runs WHERE id = ?").get(input.runId);
          if (!existing) throw new AppError("not_found", "Research run not found.");
          researchEngine?.cancelRun(input.runId);
          cancelIncompleteRun(db, input.runId);
          sendJson(res, 200, { ok: true, workspace: await workspaceState() });
          return;
        }

        if (url.pathname === "/research/cancel") {
          const input = CancelResearchSchema.parse(body);
          const existing = db.db.prepare("SELECT 1 FROM research_runs WHERE id = ?").get(input.runId);
          if (!existing) throw new AppError("not_found", "Research run not found.");
          researchEngine?.cancelRun(input.runId);
          sendJson(res, 200, { ok: true, workspace: await workspaceState() });
          return;
        }

        if (url.pathname === "/ideas/generate") {
          const { runId, allowPartial } = GenerateIdeasRequestSchema.parse(body);
          const run = db.db.prepare(`
            SELECT thread_id, config_json FROM research_runs WHERE id = ?
          `).get(runId) as { thread_id: string; config_json: string } | undefined;
          if (!run) throw new AppError("not_found", "Research run not found.");
          const config = RunConfigSchema.parse(JSON.parse(run.config_json));
          const ideaClient = modelClient(config.ideaProvider);
          let result;
          try {
            result = await generateIdeas(db, ideaClient, runId, allowPartial);
          } catch (error) {
            if (error instanceof IdeaGenerationBlockedError) throw new AppError("conflict", error.message);
            throw error;
          }
          threads.updateThreadStatus(run.thread_id, "ideas-ready");
          emitEvent({ type: "ideas-generated", threadId: run.thread_id, runId, ...result });
          sendJson(res, 200, { ...result, workspace: await workspaceState() });
          return;
        }

        if (url.pathname === "/ideas/rate") {
          const input = RateIdeaSchema.parse(body);
          const idea = db.db.prepare("SELECT 1 FROM ideas WHERE id = ?").get(input.ideaId);
          if (!idea) throw new AppError("not_found", "Idea not found.");
          const updatedAt = new Date().toISOString();
          db.db.exec("BEGIN");
          try {
            db.db.prepare(`
              INSERT INTO idea_ratings (idea_id, rating, notes, updated_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(idea_id) DO UPDATE SET rating = excluded.rating, notes = excluded.notes, updated_at = excluded.updated_at
            `).run(input.ideaId, input.rating, input.notes ?? null, updatedAt);
            db.db.prepare("INSERT INTO rating_history (idea_id, rating, notes, created_at) VALUES (?, ?, ?, ?)")
              .run(input.ideaId, input.rating, input.notes ?? null, updatedAt);
            db.db.exec("COMMIT");
          } catch (error) {
            db.db.exec("ROLLBACK");
            throw error;
          }
          sendJson(res, 200, IdeaRatingResponseSchema.parse({ ...input, updatedAt }));
          return;
        }

        if (url.pathname === "/ideas/export") {
          const { threadId } = ExportIdeasRequestSchema.parse(body);
          requireThread(threadId);
          sendJson(res, 200, { ideas: listIdeas(threadId) });
          return;
        }

        if (url.pathname === "/threads/branch") {
          const input = CreateBranchRequestSchema.parse(body);
          requireThread(input.parentThreadId);
          const idea = db.db.prepare(`
            SELECT title, supporting_claim_ids_json FROM ideas WHERE id = ? AND thread_id = ?
          `).get(input.seedIdeaId, input.parentThreadId) as
            | { title: string; supporting_claim_ids_json: string }
            | undefined;
          if (!idea) throw new AppError("not_found", "Idea not found in the parent research.");
          if (idea.title !== input.seedIdeaTitle) {
            throw new AppError("conflict", "The seed idea changed. Refresh the workspace and try again.");
          }
          const supportingClaimIds = new Set(JSON.parse(idea.supporting_claim_ids_json) as string[]);
          if (input.selectedClaimIds.some((claimId) => !supportingClaimIds.has(claimId))) {
            throw new AppError("conflict", "Selected claims must support the seed idea.");
          }
          const parentBrief = threads.getLatestBriefSnapshot(input.parentThreadId);
          if (!parentBrief) throw new AppError("conflict", "Confirm the parent brief before creating a branch.");

          let threadId = "";
          db.db.exec("BEGIN");
          try {
            const created = threads.createThread(`Deeper: ${idea.title.slice(0, 48)}`);
            threadId = created.id;
            db.db.prepare("UPDATE threads SET parent_thread_id = ? WHERE id = ?").run(input.parentThreadId, threadId);
            threads.saveBrief(threadId, parentBrief.brief, true);
            threads.saveBranchContext({
              threadId,
              parentThreadId: input.parentThreadId,
              seedIdeaId: input.seedIdeaId,
              seedIdeaTitle: idea.title,
              explorationAngle: input.explorationAngle,
              inheritedBriefSnapshot: parentBrief.brief,
              inheritedBriefVersion: parentBrief.version,
              selectedClaimIds: input.selectedClaimIds,
              createdAt: new Date().toISOString(),
            });
            db.db.exec("COMMIT");
          } catch (error) {
            db.db.exec("ROLLBACK");
            throw error;
          }
          const thread = threads.listThreads().find((item) => item.id === threadId);
          if (!thread) throw new AppError("not_found", "Created branch could not be loaded.");
          activeThreadId = thread.id;
          db.setSetting("active_thread_id", thread.id);
          sendJson(res, 200, { thread, workspace: await workspaceState() });
          return;
        }
      }

      sendError(res, new AppError("not_found", "Route not found."));
    } catch (error) {
      sendError(res, error);
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind backend port");
  await validateProviders();

  return {
    port: address.port,
    token,
    emitEvent,
    secretsChanged: () => {
      cachedValidation = null;
      cachedModels = [];
      researchEngine = null;
    },
    close: async () => {
      server.close();
      db.close();
    },
  };
}

function authorize(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  return header === `Bearer ${token}`;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const maxBytes = 256 * 1024;
  const declaredLength = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new AppError("validation_error", "Request body is too large.");
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) throw new AppError("validation_error", "Request body is too large.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, data: payload }));
}

function sendError(res: ServerResponse, error: unknown): void {
  const normalized = toErrorPayload(error);
  res.writeHead(normalized.status, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: normalized.error }));
}
