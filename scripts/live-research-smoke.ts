import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseClient } from "../src/db/client";
import { ThreadRepository } from "../src/db/repositories/threads";
import { ResearchEngine } from "../src/core/research-engine";
import { ExaClient } from "../src/providers/exa";
import { OpenCodeClient } from "../src/providers/opencode";
import { DEFAULT_RUN_CONFIG } from "../src/shared/intake";
import { ProjectBriefSchema, RunConfigSchema } from "../src/shared/schemas";

loadDotEnv();

if (!process.env.OPENCODE_API_KEY) throw new Error("OPENCODE_API_KEY is missing");
if (!process.env.EXA_API_KEY) throw new Error("EXA_API_KEY is missing");

const dir = mkdtempSync(join(tmpdir(), "scraply-live-research-"));
const db = new DatabaseClient(join(dir, "scraply.db"));
const threads = new ThreadRepository(db);
const thread = threads.createThread("Live research smoke");
const brief = ProjectBriefSchema.parse({
  projectName: "Student micro-SaaS smoke test",
  theme: "micro-SaaS ideas for students who can code",
  description: "Find practical, evidence-grounded project ideas a student developer could build and monetize.",
  desiredOutput: "A concise research synthesis",
  successDefinition: "At least several streams produce grounded claims and the synthesis completes.",
  constraints: ["small budget", "student time", "software project"],
  resources: ["coding skills", "desktop app"],
  avoidList: ["generic AI wrapper"],
  researchNeeds: "market pain, examples, buyer willingness, risks",
  finalDecision: "Choose one direction worth ideating around",
  deadline: "Flexible",
  availableEffort: "Part time",
  ideaStylePreference: "Practical but high-upside",
});
const config = RunConfigSchema.parse({
  ...DEFAULT_RUN_CONFIG,
  searchResultsPerStream: 1,
  pageCharLimit: 1200,
  maxFollowUpRounds: 0,
  parallelism: 1,
  maxSpendUsd: 3,
});

threads.saveBrief(thread.id, brief);
threads.saveRunConfig(thread.id, config);

const reports: Array<{ threadId: string; streamName: string; reportId: string }> = [];
const engine = new ResearchEngine({
  db,
  opencode: new OpenCodeClient({ apiKey: process.env.OPENCODE_API_KEY }),
  exa: new ExaClient(process.env.EXA_API_KEY),
  onEvent: (event) => {
    if ([
      "run-started",
      "stream-started",
      "stream-completed",
      "stream-failed",
      "coverage-review-completed",
      "synthesis-completed",
      "run-completed",
    ].includes(event.type)) {
      console.log(JSON.stringify(event));
    }
  },
  onReport: (threadId, streamName, reportId) => {
    reports.push({ threadId, streamName, reportId });
  },
});

const runId = await engine.startRun(thread.id, brief, config);
const started = Date.now();
let timedOut = true;
while (Date.now() - started < 300_000) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const row = db.db.prepare("SELECT status FROM research_runs WHERE id = ?").get(runId) as { status: string } | undefined;
  if (row && ["completed", "partial", "cancelled"].includes(row.status)) {
    timedOut = false;
    break;
  }
}

const finalRun = db.db.prepare("SELECT status, spend_estimate FROM research_runs WHERE id = ?").get(runId);
const streamRows = db.db.prepare(`
  SELECT stream_id, status, coverage, error
  FROM stream_runs
  WHERE research_run_id = ?
  ORDER BY created_at
`).all(runId);
const reportRows = db.db.prepare(`
  SELECT stream_id, title, length(html) as htmlLength
  FROM reports
  WHERE thread_id = ?
  ORDER BY created_at
`).all(thread.id);

console.log(`SUMMARY ${JSON.stringify({ dir, runId, timedOut, finalRun, streamRows, reportRows, reports }, null, 2)}`);
if (!timedOut) db.close();

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
