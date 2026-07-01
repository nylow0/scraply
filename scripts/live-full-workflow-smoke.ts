import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseClient } from "../src/db/client";
import { ThreadRepository } from "../src/db/repositories/threads";
import { buildBriefFromAnswers, generateBriefWithModel } from "../src/core/intake";
import { generateIdeas } from "../src/core/ideas";
import { ResearchEngine } from "../src/core/research-engine";
import { ExaClient } from "../src/providers/exa";
import { OpenCodeClient } from "../src/providers/opencode";
import { ALL_INTAKE_QUESTIONS, DEFAULT_RUN_CONFIG } from "../src/shared/intake";
import { ProjectBriefSchema, RunConfigSchema } from "../src/shared/schemas";

loadDotEnv();

const OPENCODE_TIMEOUT_MS = Number(process.env.SCRAPLY_LIVE_OPENCODE_TIMEOUT_MS ?? 90_000);
const EXA_TIMEOUT_MS = Number(process.env.SCRAPLY_LIVE_EXA_TIMEOUT_MS ?? 45_000);
const RUN_TIMEOUT_MS = Number(process.env.SCRAPLY_LIVE_RUN_TIMEOUT_MS ?? 900_000);

if (!process.env.OPENCODE_API_KEY) throw new Error("OPENCODE_API_KEY is missing");
if (!process.env.EXA_API_KEY) throw new Error("EXA_API_KEY is missing");

const dir = mkdtempSync(join(tmpdir(), "scraply-live-full-"));
const db = new DatabaseClient(join(dir, "scraply.db"));
const threads = new ThreadRepository(db);
const opencode = new OpenCodeClient({
  apiKey: process.env.OPENCODE_API_KEY,
  fetcher: timeoutFetch(OPENCODE_TIMEOUT_MS),
});
const exa = new ExaClient(process.env.EXA_API_KEY, timeoutFetch(EXA_TIMEOUT_MS));

const answers = [
  ["goal", "Generate monetizable software project ideas for a solo student developer."],
  ["theme", "A browser and desktop helper that turns messy class schedules, PDFs, deadlines, and campus resources into a useful personal operating system."],
  ["good-idea", "Good ideas should have painful repeated use, obvious willingness to pay, low build complexity, and a path to $500/month."],
  ["output", "A research-backed shortlist of product ideas with risks and next steps."],
  ["success-decider", "A student founder deciding what to build in the next four weeks."],
  ["motivation", "Make money while building a portfolio-worthy product."],
  ["deadline", "Four weeks, with about 12 hours per week available."],
  ["resources", "TypeScript, Svelte, Electron, scraping, browser automation, SQLite, and access to student communities."],
  ["avoid", "Avoid generic AI chat wrappers, huge marketplaces, campus sales cycles, and anything requiring university partnerships."],
  ["final-decision", "Pick one product direction worth prototyping immediately."],
  ["style-balance", "Prefer practical ideas, but keep one or two weird high-upside angles."],
  ["examples", "Look at student productivity apps, tutoring marketplaces, browser extensions, note-taking tools, and scheduling pain."],
  ["research-needs", "Find evidence of repeated pain, existing competitors, pricing willingness, and cheap validation channels."],
  ["scoring-criteria", "Score by demand, novelty, feasibility, evidence quality, saturation, and speed to first revenue."],
  ["anything-else", "Assume the builder is technical but has little money and no audience yet."],
] as const;

const missing = ALL_INTAKE_QUESTIONS
  .map((question) => question.id)
  .filter((id) => !answers.some(([answerId]) => answerId === id));
if (missing.length > 0) throw new Error(`Missing intake answers: ${missing.join(", ")}`);

const answerRows = answers.map(([questionId, answer]) => ({ questionId, answer, skipped: false }));
const thread = threads.createThread("Live full workflow smoke");
for (const answer of answerRows) threads.saveIntakeAnswer(thread.id, answer.questionId, answer.answer, answer.skipped);

console.log(JSON.stringify({ type: "setup", dir, threadId: thread.id, answeredQuestions: answerRows.length }));

const models = await opencode.listModels();
console.log(JSON.stringify({ type: "opencode-models", count: models.length, requiredPresent: requiredModels(models) }));
assert(models.includes("glm-5.2"), "OpenCode model list does not include glm-5.2");
assert(models.includes("mimo-v2.5"), "OpenCode model list does not include mimo-v2.5");

let brief = buildBriefFromAnswers(answerRows);
try {
  brief = await generateBriefWithModel(opencode, "glm-5.2", answerRows);
  console.log(JSON.stringify({ type: "brief-generated-with-model", model: "glm-5.2", projectName: brief.projectName }));
} catch (error) {
  console.log(JSON.stringify({
    type: "brief-model-failed-using-deterministic-fallback",
    error: error instanceof Error ? error.message : String(error),
  }));
}
brief = ProjectBriefSchema.parse(brief);
threads.saveBrief(thread.id, brief, true);

const config = RunConfigSchema.parse({
  ...DEFAULT_RUN_CONFIG,
  orchestratorProvider: "opencode",
  orchestratorModel: "glm-5.2",
  workerModel: "mimo-v2.5",
  ideaProvider: "opencode",
  ideaModel: "glm-5.2",
  ideasRequested: 6,
  batchSize: 3,
  searchResultsPerStream: 1,
  pageCharLimit: 1400,
  maxFollowUpRounds: 0,
  parallelism: 2,
  maxSpendUsd: 4,
});
threads.saveRunConfig(thread.id, config, "live-full-smoke");

const engine = new ResearchEngine({
  db,
  opencode,
  exa,
  onEvent: (event) => {
    if (!["stream-progress"].includes(event.type)) {
      console.log(JSON.stringify({ type: "event", event }));
    }
  },
  onReport: (threadId, streamName, reportId) => {
    console.log(JSON.stringify({ type: "report", threadId, streamName, reportId }));
  },
});

const runId = await engine.startRun(thread.id, brief, config);
await waitForRun(db, runId);

const run = db.db.prepare("SELECT status, spend_estimate FROM research_runs WHERE id = ?").get(runId) as {
  status: string;
  spend_estimate: number;
};
const streams = db.db.prepare(`
  SELECT stream_id, status, coverage, error
  FROM stream_runs
  WHERE research_run_id = ?
  ORDER BY stream_id
`).all(runId) as Array<{ stream_id: string; status: string; coverage: number | null; error: string | null }>;
const reports = db.db.prepare(`
  SELECT stream_id, title, length(html) AS html_length
  FROM reports
  WHERE thread_id = ?
  ORDER BY created_at
`).all(thread.id) as Array<{ stream_id: string | null; title: string; html_length: number }>;

console.log(JSON.stringify({ type: "research-summary", run, streams, reports }, null, 2));
assert(["completed", "partial"].includes(run.status), `Unexpected run status: ${run.status}`);
assert(streams.length === 6, `Expected 6 stream rows, got ${streams.length}`);
assert(streams.filter((stream) => stream.status === "completed").length >= 4, "Fewer than 4 streams completed");
assert(reports.some((report) => report.stream_id === "synthesis" && report.html_length > 1000), "Missing substantial synthesis report");

const ideas = await generateIdeas(db, opencode, thread.id, brief, config.ideaModel, config.ideasRequested, config.batchSize);
console.log(JSON.stringify({
  type: "ideas-summary",
  count: ideas.length,
  ideas: ideas.map((idea) => ({
    title: idea.title,
    bucket: idea.bucket,
    scores: idea.scores,
    descriptionLength: idea.description.length,
  })),
}, null, 2));

assert(ideas.length >= 4, `Expected at least 4 ideas, got ${ideas.length}`);
assert(ideas.every((idea) => idea.description.length >= 40), "One or more ideas have thin descriptions");
assert(ideas.every((idea) => Object.values(idea.scores).every((score) => score >= 0 && score <= 10)), "Idea score out of range");

db.close();

function requiredModels(models: string[]) {
  return {
    "glm-5.2": models.includes("glm-5.2"),
    "mimo-v2.5": models.includes("mimo-v2.5"),
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function waitForRun(database: DatabaseClient, runId: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < RUN_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const row = database.db.prepare("SELECT status FROM research_runs WHERE id = ?").get(runId) as { status: string } | undefined;
    if (row && ["completed", "partial", "cancelled"].includes(row.status)) return;
  }
  throw new Error(`Research run timed out after ${RUN_TIMEOUT_MS}ms`);
}

function timeoutFetch(timeoutMs: number): typeof fetch {
  return async (input, init = {}) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(input, { ...init, signal: init.signal ?? controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  };
}

function loadDotEnv(): void {
  const path = ".env";
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^"|"$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}
