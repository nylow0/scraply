import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseClient } from "../src/db/client";
import { ResearchRunRepository } from "../src/db/repositories/research-runs";
import { ThreadRepository } from "../src/db/repositories/threads";
import { generateIdeas } from "../src/core/ideas";
import { CodexClient, listCodexModels, probeCodexCli } from "../src/providers/codex";
import { DEFAULT_RUN_CONFIG } from "../src/shared/intake";
import { ProjectBriefSchema, RunConfigSchema } from "../src/shared/schemas";

const probe = await probeCodexCli();
if (!probe.detected || !probe.compatible) {
  throw new Error(`Codex CLI is not ready: ${probe.error ?? "unknown error"}`);
}

const models = await listCodexModels();
const model = process.env.SCRAPLY_CODEX_IDEA_MODEL ?? models[0] ?? "gpt-5.5";
const dir = mkdtempSync(join(tmpdir(), "scraply-codex-ideas-"));
const db = new DatabaseClient(join(dir, "scraply.db"));
const threads = new ThreadRepository(db);
const thread = threads.createThread("Codex idea smoke");
const brief = ProjectBriefSchema.parse({
  schemaVersion: 2,
  title: "Tiny student revenue tool",
  objective: "Find practical software product ideas a student developer can ship and sell in a month.",
  context: "The builder is a student developer looking for a small, evidence-aware first revenue project.",
  decisionToSupport: "Pick one idea to prototype.",
  audience: ["student software developers"],
  desiredOutput: {
    type: "ranked-shortlist",
    notes: "A shortlist of specific product ideas with a plausible first-revenue path.",
  },
  successCriteria: ["clear users", "clear pain", "plausible first revenue path"],
  hardConstraints: ["four weeks", "solo builder", "low budget"],
  preferences: ["practical ideas", "one high-upside outlier"],
  resources: ["TypeScript", "Svelte", "Electron", "browser automation"],
  antiGoals: ["generic AI wrappers", "university partnerships"],
  deadline: "Four weeks",
  availableEffort: "Part time",
  evidenceRequirements: ["Use the existing research context and keep unsupported assumptions explicit."],
  examplesToInspect: [],
  ideaStyle: "balanced",
  assumptions: [],
  openQuestions: [],
  contradictions: [],
});

threads.saveBrief(thread.id, brief, true);
const config = RunConfigSchema.parse({
  ...DEFAULT_RUN_CONFIG,
  ideaModel: model,
  ideasRequested: 3,
  batchSize: 3,
  maxFollowUpRounds: 0,
  searchResultsPerStream: 1,
  parallelism: 1,
});
const runs = new ResearchRunRepository(db);
const { runId } = runs.create(thread.id, brief, config, "live-codex-ideas-smoke");
const now = new Date().toISOString();
db.db.prepare(`
  INSERT INTO reports (
    id, thread_id, research_run_id, stream_id, report_kind, title, html, created_at
  ) VALUES (?, ?, ?, 'synthesis', 'synthesis', ?, ?, ?)
`).run(
  "smoke-synthesis",
  thread.id,
  runId,
  "Student product opportunity synthesis",
  "<p>Solo student developers can validate small workflow tools by selling a narrow, manual-first solution before investing in broad automation.</p>",
  now,
);
db.db.prepare(`
  INSERT INTO sources (
    id, research_run_id, canonical_url, title, retrieved_text, content_hash, retrieved_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
`).run(
  "smoke-source",
  runId,
  "https://example.com/student-product-validation",
  "Student product validation",
  "Narrow workflow tools can be validated through direct outreach and a paid manual-first pilot.",
  "live-codex-smoke-source",
  now,
);
db.db.prepare(`
  INSERT INTO claims (
    id, research_run_id, text, confidence, validation_status, validation_reason, created_at
  ) VALUES (?, ?, ?, 0.9, 'valid', 'Seeded live smoke evidence', ?)
`).run(
  "smoke-claim",
  runId,
  "A narrow workflow tool can be validated with direct outreach and a paid manual-first pilot.",
  now,
);
db.db.prepare(`
  INSERT INTO claim_evidence (
    claim_id, source_id, quote, source_location, evidence_quality
  ) VALUES (?, ?, ?, ?, 0.9)
`).run(
  "smoke-claim",
  "smoke-source",
  "Narrow workflow tools can be validated through direct outreach and a paid manual-first pilot.",
  "seeded smoke evidence",
);
runs.finish(runId, "completed", "Seeded evidence fixture ready for live Luna generation");

const result = await generateIdeas(db, new CodexClient(), runId);
const ideas = result.ideas;

console.log(JSON.stringify({
  dir,
  codex: probe,
  model,
  completeness: result.completeness,
  count: ideas.length,
  ideas: ideas.map((idea) => ({
    title: idea.title,
    bucket: idea.bucket,
    scores: idea.scores,
    descriptionLength: idea.description.length,
  })),
}, null, 2));

if (ideas.length < 3) throw new Error(`Expected 3 Codex ideas, got ${ideas.length}`);
if (ideas.some((idea) => idea.description.length < 40)) throw new Error("Codex returned a thin idea description");

db.close();
