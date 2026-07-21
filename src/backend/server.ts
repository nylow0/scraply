import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { DatabaseClient } from "../db/client";
import { ThreadRepository } from "../db/repositories/threads";
import { buildBriefFromAnswers, generateBriefWithModel, intakeAssistantMessage, newThreadTitle } from "../core/intake";
import { generateIdeas } from "../core/ideas";
import { ResearchEngine } from "../core/research-engine";
import { cancelIncompleteRun, listPendingRuns } from "../core/research-recovery";
import { CodexClient, listCodexModels, probeCodexCli } from "../providers/codex";
import { ExaClient } from "../providers/exa";
import { OpenCodeClient } from "../providers/opencode";
import {
  CancelIncompleteResearchSchema,
  CancelResearchSchema,
  ConfirmBriefSchema,
  CreateThreadRequestSchema,
  HealthResponseSchema,
  RateIdeaSchema,
  ResumeResearchSchema,
  SaveRunConfigSchema,
  SaveFavoriteModelSchema,
  StartResearchSchema,
  SubmitIntakeAnswerSchema,
  ValidationStateSchema,
  WorkspaceStateSchema,
  type ResearchEvent,
  type ValidationState,
} from "../shared/ipc";
import { DEFAULT_RUN_CONFIG, intakeProgress, nextIntakeQuestion } from "../shared/intake";
import { ModelCatalogSchema, type ModelCatalog, type ModelRef, RunConfigSchema } from "../shared/schemas";

export interface BackendContext {
  dataDir: string;
  dbPath: string;
  getSecrets: () => { opencodeApiKey: string | null; exaApiKey: string | null };
}

export interface BackendHandle {
  port: number;
  token: string;
  close: () => Promise<void>;
  emitEvent: (event: ResearchEvent) => void;
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
    const { opencode, exa } = clients();
    if (!researchEngine) {
      researchEngine = new ResearchEngine({
        db,
        opencode,
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
    const secrets = context.getSecrets();
    if (!secrets.opencodeApiKey || !secrets.exaApiKey) {
      throw new Error("API keys are not configured");
    }
    return {
      opencode: new OpenCodeClient({ apiKey: secrets.opencodeApiKey }),
      exa: new ExaClient(secrets.exaApiKey),
    };
  }

  async function validateProviders(): Promise<ValidationState> {
    const secrets = context.getSecrets();
    const [codex, codexModels] = await Promise.all([probeCodexCli(), listCodexModels()]);
    cachedCodexModels = codexModels;
    if (!secrets.opencodeApiKey || !secrets.exaApiKey) {
      cachedValidation = ValidationStateSchema.parse({
        opencode: { valid: false, modelCount: 0, models: [], error: "OpenCode key missing" },
        exa: { valid: false, error: "Exa key missing" },
        codex,
        setupComplete: false,
      });
      return cachedValidation;
    }
    const opencode = new OpenCodeClient({ apiKey: secrets.opencodeApiKey });
    const exa = new ExaClient(secrets.exaApiKey);
    const [open, exaResult] = await Promise.all([opencode.validateKey(), exa.validateKey()]);
    cachedModels = open.valid ? open.models : [];
    cachedValidation = ValidationStateSchema.parse({
      opencode: open.valid
        ? { valid: true, modelCount: open.models.length, models: open.models }
        : { valid: false, modelCount: 0, models: [], error: open.error },
      exa: exaResult.valid ? { valid: true } : { valid: false, error: exaResult.error },
      codex,
      setupComplete: open.valid && exaResult.valid,
    });
    return cachedValidation;
  }

  async function workspaceState() {
    const validation = cachedValidation ?? await validateProviders();
    const threadList = threads.listThreads();
    const messages = activeThreadId ? threads.getMessages(activeThreadId) : [];
    const brief = activeThreadId ? threads.getLatestBrief(activeThreadId) : null;
    const runConfig = activeThreadId ? threads.getLatestRunConfig(activeThreadId) : null;
    const ideas = activeThreadId ? listIdeas(activeThreadId) : [];
    const reports = activeThreadId ? listReports(activeThreadId) : [];
    return WorkspaceStateSchema.parse({
      validation,
      threads: threadList,
      activeThreadId,
      messages,
      brief,
      runConfig,
      models: cachedModels,
      modelCatalog: buildModelCatalog(),
      presets: threads.listPresets(),
      ideas,
      reports,
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
    return db.db.prepare("SELECT id, stream_id, title, html FROM reports WHERE thread_id = ? ORDER BY created_at ASC")
      .all(threadId)
      .map((row) => {
        const record = row as { id: string; stream_id: string | null; title: string; html: string };
        return {
          id: record.id,
          streamId: record.stream_id,
          title: record.title,
          html: record.html,
        };
      });
  }

  const subscribers = new Set<(event: ResearchEvent) => void>();
  function emitEvent(event: ResearchEvent) {
    onEvent(event);
    for (const subscriber of subscribers) subscriber(event);
  }

  const server = createServer(async (req, res) => {
    try {
      if (!authorize(req, token)) {
        sendJson(res, 401, { error: "Unauthorized" });
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
        sendJson(res, 200, await validateProviders());
        return;
      }

      if (method === "GET" && url.pathname === "/workspace") {
        sendJson(res, 200, await workspaceState());
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
          activeThreadId = String((body as { threadId: string }).threadId);
          db.setSetting("active_thread_id", activeThreadId);
          sendJson(res, 200, await workspaceState());
          return;
        }

        if (url.pathname === "/threads/delete") {
          const threadId = String((body as { threadId: string }).threadId);
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
            const { opencode } = clients();
            const brief = await generateBriefWithModel(opencode, cachedModels[0] ?? DEFAULT_RUN_CONFIG.orchestratorModel, answers);
            threads.saveBrief(input.threadId, brief, false);
            threads.addMessage(input.threadId, "assistant", "I've drafted your project brief. Review and edit it below, then confirm to continue.");
            threads.updateThreadStatus(input.threadId, "brief-draft");
          }
          sendJson(res, 200, { progress: intakeProgress(answered), workspace: await workspaceState() });
          return;
        }

        if (url.pathname === "/brief/confirm") {
          const input = ConfirmBriefSchema.parse(body);
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
          const brief = threads.getLatestBrief(input.threadId);
          const config = threads.getLatestRunConfig(input.threadId) ?? RunConfigSchema.parse(DEFAULT_RUN_CONFIG);
          if (!brief) throw new Error("Brief must be confirmed before research");
          const engine = ensureResearchEngine();
          const runId = await engine.startRun(input.threadId, brief, config);
          threads.updateThreadStatus(input.threadId, "research-running");
          threads.addMessage(input.threadId, "event", `Research run ${runId} started.`);
          sendJson(res, 200, { runId, workspace: await workspaceState() });
          return;
        }

        if (url.pathname === "/research/resume") {
          const input = ResumeResearchSchema.parse(body);
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
          researchEngine?.cancelRun(input.runId);
          cancelIncompleteRun(db, input.runId);
          sendJson(res, 200, { ok: true, workspace: await workspaceState() });
          return;
        }

        if (url.pathname === "/research/cancel") {
          const input = CancelResearchSchema.parse(body);
          researchEngine?.cancelRun(input.runId);
          sendJson(res, 200, { ok: true, workspace: await workspaceState() });
          return;
        }

        if (url.pathname === "/ideas/generate") {
          const threadId = String((body as { threadId: string }).threadId);
          const brief = threads.getLatestBrief(threadId);
          const config = threads.getLatestRunConfig(threadId) ?? RunConfigSchema.parse(DEFAULT_RUN_CONFIG);
          if (!brief) throw new Error("Brief required");
          const { opencode } = clients();
          const ideaClient = config.ideaProvider === "codex" ? new CodexClient() : opencode;
          const ideas = await generateIdeas(db, ideaClient, threadId, brief, config.ideaModel, config.ideasRequested, config.batchSize);
          threads.updateThreadStatus(threadId, "ideas-ready");
          emitEvent({ type: "ideas-generated", threadId, ideas });
          sendJson(res, 200, { ideas, workspace: await workspaceState() });
          return;
        }

        if (url.pathname === "/ideas/rate") {
          const input = RateIdeaSchema.parse(body);
          db.db.prepare("INSERT INTO ratings (idea_id, rating, notes, created_at) VALUES (?, ?, ?, ?)")
            .run(input.ideaId, input.rating, input.notes ?? null, new Date().toISOString());
          sendJson(res, 200, { ok: true });
          return;
        }

        if (url.pathname === "/ideas/export") {
          const threadId = String((body as { threadId: string }).threadId);
          sendJson(res, 200, { ideas: listIdeas(threadId) });
          return;
        }

        if (url.pathname === "/threads/branch") {
          const input = body as { parentThreadId: string; ideaTitle: string };
          const parentBrief = threads.getLatestBrief(input.parentThreadId);
          const thread = threads.createThread(`Deeper: ${input.ideaTitle.slice(0, 48)}`);
          db.db.prepare("UPDATE threads SET parent_thread_id = ? WHERE id = ?").run(input.parentThreadId, thread.id);
          if (parentBrief) threads.saveBrief(thread.id, parentBrief, true);
          threads.addMessage(thread.id, "assistant", `Branching deeper into “${input.ideaTitle}”. What specific angle should this branch explore?`);
          activeThreadId = thread.id;
          db.setSetting("active_thread_id", thread.id);
          sendJson(res, 200, { thread, workspace: await workspaceState() });
          return;
        }
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : "Internal error" });
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
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}
