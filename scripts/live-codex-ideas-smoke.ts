import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseClient } from "../src/db/client";
import { ThreadRepository } from "../src/db/repositories/threads";
import { generateIdeas } from "../src/core/ideas";
import { CodexClient, listCodexModels, probeCodexCli } from "../src/providers/codex";
import { ProjectBriefSchema } from "../src/shared/schemas";

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
  projectName: "Tiny student revenue tool",
  theme: "small software products students can build and sell",
  description: "Find practical project ideas a student developer can ship in a month.",
  desiredOutput: "A shortlist of specific product ideas",
  successDefinition: "Ideas have clear users, clear pain, and a plausible first revenue path.",
  constraints: ["four weeks", "solo builder", "low budget"],
  resources: ["TypeScript", "Svelte", "Electron", "browser automation"],
  avoidList: ["generic AI wrappers", "university partnerships"],
  researchNeeds: "Use the existing research context and generate practical ideas.",
  finalDecision: "Pick one idea to prototype.",
  deadline: "Four weeks",
  availableEffort: "Part time",
  ideaStylePreference: "Practical with one high-upside outlier",
});

threads.saveBrief(thread.id, brief, true);
const ideas = await generateIdeas(db, new CodexClient(), thread.id, brief, model, 3, 3);

console.log(JSON.stringify({
  dir,
  codex: probe,
  model,
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
