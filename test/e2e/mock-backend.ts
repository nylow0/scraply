import { createServer, type IncomingMessage, type Server } from "node:http";
import { once } from "node:events";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/intake";

type Scenario = "fresh" | "interrupted" | "provider-failure";

interface MockState {
  configured: boolean;
  threads: Array<{ id: string; title: string; status: string; parentThreadId?: string; createdAt: string; updatedAt: string }>;
  activeThreadId: string | null;
  messages: unknown[];
  brief: Record<string, unknown> | null;
  runConfig: typeof DEFAULT_RUN_CONFIG | null;
  ideas: unknown[];
  reports: Array<{ id: string; researchRunId?: string; streamId: string | null; title: string }>;
  pendingRuns: unknown[];
  /** A run that ended without a synthesis but still has usable evidence. */
  partialRunAvailable: boolean;
  favorites: string[];
  presets: Array<{ name: string; config: typeof DEFAULT_RUN_CONFIG }>;
}

export interface MockBackend {
  url: string;
  token: string;
  requests: Array<{ method: string; path: string; body: unknown }>;
  close: () => Promise<void>;
}

const now = "2026-07-21T12:00:00.000Z";
const validationReady = {
  exa: { valid: true },
  codex: { detected: true, compatible: true, version: "codex-e2e" },
  setupComplete: true,
};
const validationMissing = {
  exa: { valid: false, error: "Exa key missing" },
  codex: { detected: true, compatible: true, version: "codex-e2e" },
  setupComplete: false,
};
const brief = {
  schemaVersion: 2,
  title: "Student Income Lab",
  objective: "small software products",
  context: "Find evidence-backed software ideas a student can ship.",
  decisionToSupport: "Which product to build first",
  audience: ["Students"],
  desiredOutput: { type: "ranked-shortlist", notes: "A ranked product direction" },
  successCriteria: ["A validated path to first revenue"],
  hardConstraints: ["10 hours per week"],
  preferences: [],
  antiGoals: ["regulated markets"],
  resources: ["TypeScript", "student communities"],
  deadline: "Six weeks",
  availableEffort: "10 hours per week",
  evidenceRequirements: ["Demand and competitive evidence"],
  examplesToInspect: [],
  ideaStyle: "balanced",
  assumptions: [],
  openQuestions: [],
  contradictions: [],
};
const idea = {
  id: "idea-1",
  threadId: "thread-1",
  title: "Exam Feedback Copilot",
  description: "Turn marked assignments into a focused revision plan.",
  bucket: "strong-fit",
  scores: { relevance: 9, novelty: 7, evidenceStrength: 8, feasibility: 9, demand: 8, saturation: 5 },
  supportingClaimIds: ["claim-1"],
  researchRunId: "run-1",
  generationMode: "complete",
  currentRating: null,
  evidence: [{
    claimId: "claim-1",
    sourceId: "source-1",
    sourceTitle: "Student workflow survey",
    url: "https://example.com/evidence",
    quote: "Students repeatedly requested actionable feedback.",
  }],
  createdAt: now,
};

export async function startMockBackend(scenario: Scenario = "fresh", port = 0): Promise<MockBackend> {
  const requests: MockBackend["requests"] = [];
  const thread = {
    id: "thread-1",
    title: "Student Income Lab",
    status: scenario === "fresh" ? "intake" : scenario === "provider-failure" ? "configuring" : "research-running",
    createdAt: now,
    updatedAt: now,
  };
  const state: MockState = {
    configured: true,
    threads: scenario === "fresh" ? [] : [thread],
    activeThreadId: scenario === "fresh" ? null : thread.id,
    messages: [],
    brief: scenario === "fresh" ? null : brief,
    runConfig: scenario === "fresh" ? null : DEFAULT_RUN_CONFIG,
    ideas: [],
    reports: scenario === "interrupted" ? [{ id: "report-partial", streamId: "market", title: "Partial market evidence" }] : [],
    pendingRuns: scenario === "interrupted" ? [{
      runId: "run-interrupted",
      threadId: thread.id,
      threadTitle: thread.title,
      status: "running",
      completedStreams: 2,
      totalStreams: 6,
      hasSynthesis: false,
    }] : [],
    partialRunAvailable: scenario === "interrupted",
    favorites: [],
    presets: [],
  };
  const token = "scraply-e2e-token";

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const body = await readBody(req);
    requests.push({ method: req.method ?? "GET", path: `${url.pathname}${url.search}`, body });
    if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, error("unauthorized", "Missing test token"));

    if (req.method === "GET" && url.pathname === "/validation") {
      return send(res, 200, ok(state.configured ? validationReady : validationMissing));
    }
    if (req.method === "GET" && url.pathname === "/workspace") return send(res, 200, ok(workspace(state)));
    if (req.method === "POST" && url.pathname === "/threads") {
      state.threads = [thread];
      state.activeThreadId = thread.id;
      return send(res, 200, ok({ workspace: workspace(state) }));
    }
    if (req.method === "POST" && url.pathname === "/intake/brief") {
      thread.status = "brief-draft";
      state.brief = brief;
      return send(res, 200, ok({
        brief,
        missingFields: [],
        assumptions: [],
        contradictions: [],
        workspace: workspace(state),
      }));
    }
    if (req.method === "POST" && url.pathname === "/intake") {
      const answer = body as { questionId?: string };
      if (answer.questionId === "anything-else") {
        thread.status = "brief-draft";
        state.brief = brief;
      }
      return send(res, 200, ok({ workspace: workspace(state) }));
    }
    if (req.method === "POST" && url.pathname === "/brief/confirm") {
      thread.status = "brief-confirmed";
      state.brief = (body as { brief?: Record<string, unknown> }).brief ?? brief;
      state.runConfig = DEFAULT_RUN_CONFIG;
      return send(res, 200, ok(workspace(state)));
    }
    if (req.method === "POST" && url.pathname === "/run-config") {
      const input = body as { config?: typeof DEFAULT_RUN_CONFIG; presetName?: string };
      state.runConfig = input.config ?? DEFAULT_RUN_CONFIG;
      if (input.presetName) {
        state.presets = [...state.presets.filter((item) => item.name !== input.presetName), { name: input.presetName, config: state.runConfig }];
      }
      thread.status = "configuring";
      return send(res, 200, ok(workspace(state)));
    }
    if (req.method === "POST" && url.pathname === "/models/favorite") {
      const input = body as { model?: string; favorite?: boolean };
      if (input.model) {
        state.favorites = input.favorite
          ? [...new Set([...state.favorites, input.model])]
          : state.favorites.filter((model) => model !== input.model);
      }
      return send(res, 200, ok(workspace(state)));
    }
    if (req.method === "POST" && url.pathname === "/research/start") {
      if (scenario === "provider-failure") return send(res, 504, error("provider_timeout", "Deterministic provider timeout"));
      thread.status = "research-complete";
      state.reports = [
        { id: "report-market", researchRunId: "run-1", streamId: "market", title: "Market evidence" },
        { id: "report-synthesis", researchRunId: "run-1", streamId: "synthesis", title: "Composite synthesis" },
      ];
      return send(res, 200, ok({ runId: "run-1", workspace: workspace(state) }));
    }
    if (req.method === "POST" && url.pathname === "/ideas/generate") {
      const allowPartial = Boolean((body as { allowPartial?: boolean }).allowPartial);
      thread.status = "ideas-ready";
      state.ideas = [idea];
      state.pendingRuns = [];
      if (allowPartial) state.partialRunAvailable = false;
      return send(res, 200, ok({
        ideas: state.ideas,
        completeness: allowPartial
          ? { mode: "partial", synthesisReportId: null, missingLenses: ["analogies"], gaps: ["Exa quota exceeded"] }
          : { mode: "complete", synthesisReportId: "report-synthesis", missingLenses: [], gaps: [] },
        workspace: workspace(state),
      }));
    }
    if (req.method === "POST" && url.pathname === "/ideas/rate") {
      const rating = Number((body as { rating?: number }).rating);
      (idea as { currentRating: unknown }).currentRating = { rating, updatedAt: now };
      return send(res, 200, ok({ ideaId: idea.id, rating, updatedAt: now }));
    }
    if (req.method === "POST" && url.pathname === "/ideas/export") {
      return send(res, 200, ok({ ideas: state.ideas }));
    }
    if (req.method === "POST" && url.pathname === "/threads/branch") {
      const child = { id: "thread-child", title: `Explore: ${(body as { seedIdeaTitle?: string }).seedIdeaTitle}`, status: "brief-confirmed", parentThreadId: thread.id, createdAt: now, updatedAt: now };
      state.threads.push(child);
      state.activeThreadId = child.id;
      state.brief = brief;
      state.ideas = [];
      state.reports = [];
      return send(res, 200, ok({ workspace: workspace(state) }));
    }
    if (req.method === "POST" && url.pathname === "/research/cancel-incomplete") {
      state.pendingRuns = [];
      thread.status = "research-complete";
      return send(res, 200, ok({ workspace: workspace(state) }));
    }
    if (req.method === "POST" && url.pathname === "/research/resume") {
      state.pendingRuns = [];
      thread.status = "research-complete";
      state.reports = [
        { id: "report-market", researchRunId: "run-1", streamId: "market", title: "Market evidence" },
        { id: "report-synthesis", researchRunId: "run-1", streamId: "synthesis", title: "Composite synthesis" },
      ];
      return send(res, 200, ok({ workspace: workspace(state) }));
    }
    if (req.method === "GET" && url.pathname.startsWith("/ideas/")) {
      const ideaId = url.pathname.split("/").at(-1);
      if (ideaId !== idea.id) return send(res, 404, error("not_found", "Idea not found"));
      return send(res, 200, ok(idea));
    }
    if (req.method === "GET" && url.pathname.startsWith("/reports/")) {
      const id = url.pathname.split("/").at(-1) ?? "report";
      return send(res, 200, ok({ id, researchRunId: "run-1", streamId: id === "report-synthesis" ? "synthesis" : "market", title: id === "report-synthesis" ? "Composite synthesis" : "Market evidence", html: "<h2>Finding</h2><p>Demand is supported by deterministic local evidence.</p>" }));
    }
    return send(res, 404, error("not_found", `No mock route for ${req.method} ${url.pathname}`));
  });

  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock backend did not bind a TCP port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    token,
    requests,
    close: () => closeServer(server),
  };
}

function workspace(state: MockState) {
  return {
    validation: state.configured ? validationReady : validationMissing,
    threads: state.threads,
    activeThreadId: state.activeThreadId,
    messages: state.messages,
    brief: state.brief,
    runConfig: state.runConfig,
    models: ["gpt-5.6-luna"],
    modelCatalog: { codex: ["gpt-5.6-luna"], favorites: state.favorites },
    branchContext: null,
    presets: state.presets,
    ideas: state.ideas.map(toIdeaSummary),
    reports: state.reports,
    latestResearchRun: state.reports.some((report) => report.id === "report-synthesis")
      ? {
          runId: "run-1",
          status: "completed",
          synthesisReportId: "report-synthesis",
          canGeneratePartialIdeas: false,
          missingLenses: [],
          gaps: [],
        }
      : state.partialRunAvailable
        ? {
            runId: "run-interrupted",
            status: "failed",
            synthesisReportId: null,
            canGeneratePartialIdeas: true,
            missingLenses: ["analogies", "evaluation"],
            gaps: ["Exa quota exceeded"],
          }
        : null,
    pendingRuns: state.pendingRuns,
  };
}

function toIdeaSummary(value: unknown) {
  const record = value as typeof idea;
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== "evidence"));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function ok(data: unknown) {
  return { ok: true, data };
}

function error(code: string, message: string) {
  return { ok: false, error: { code, message } };
}

function send(res: import("node:http").ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "connection": "close",
  });
  res.end(body);
}

async function closeServer(server: Server): Promise<void> {
  server.close();
  await once(server, "close");
}
