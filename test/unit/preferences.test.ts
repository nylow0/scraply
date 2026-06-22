import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseClient } from "../../src/db/client";
import { ThreadRepository } from "../../src/db/repositories/threads";
import { buildPreferenceContext, formatPreferencePrompt } from "../../src/core/preferences";
import { buildIdeaPrompt } from "../../src/core/ideas";
import type { ProjectBrief } from "../../src/shared/schemas";

const brief: ProjectBrief = {
  projectName: "Test",
  goal: "Find widget ideas",
  theme: "Widgets",
  description: "Build better widgets",
  successDefinition: "Useful ideas",
  desiredOutput: "Ideas",
  successDecider: "Me",
  motivation: "Learning",
  constraints: [],
  resources: [],
  avoidList: [],
  researchNeeds: "Market scan",
  finalDecision: "Pick one idea",
  deadline: "Soon",
  availableEffort: "Medium",
  ideaStylePreference: "Balanced",
  examples: "",
  scoringCriteria: "",
  anythingElse: "",
};

describe("preference feedback loop", () => {
  test("includes rated examples in idea prompt context", () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-prefs-"));
    const db = new DatabaseClient(join(dir, "scraply.db"));
    const threads = new ThreadRepository(db);
    const thread = threads.createThread("Prefs");
    const ideaId = "idea-1";
    db.db.prepare(`
      INSERT INTO ideas (id, thread_id, title, description, bucket, scores_json, supporting_claim_ids_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ideaId,
      thread.id,
      "High-signal idea",
      "A specific niche workflow assistant",
      "strong-fit",
      JSON.stringify({ relevance: 9, novelty: 8, evidenceStrength: 7, feasibility: 8, demand: 8, saturation: 4 }),
      "[]",
      new Date().toISOString(),
    );
    db.db.prepare("INSERT INTO ratings (idea_id, rating, notes, created_at) VALUES (?, ?, ?, ?)")
      .run(ideaId, 5, null, new Date().toISOString());

    const context = buildPreferenceContext(db);
    const prompt = buildIdeaPrompt(brief, formatPreferencePrompt(context), [], 3, "direct gaps");

    expect(context.positiveExamples).toHaveLength(1);
    expect(prompt).toContain("Highly rated examples:");
    expect(prompt).toContain("High-signal idea");
    db.close();
  });

  test("surfaces negative examples and weak-signal guidance", () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-prefs-neg-"));
    const db = new DatabaseClient(join(dir, "scraply.db"));
    const threads = new ThreadRepository(db);
    const thread = threads.createThread("Prefs negative");
    db.db.prepare(`
      INSERT INTO ideas (id, thread_id, title, description, bucket, scores_json, supporting_claim_ids_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "idea-bad",
      thread.id,
      "Generic AI wrapper",
      "Description",
      "strong-fit",
      JSON.stringify({ relevance: 3, novelty: 2, evidenceStrength: 2, feasibility: 4, demand: 3, saturation: 9 }),
      "[]",
      new Date().toISOString(),
    );
    db.db.prepare("INSERT INTO ratings (idea_id, rating, notes, created_at) VALUES (?, ?, ?, ?)")
      .run("idea-bad", 1, null, new Date().toISOString());

    const context = buildPreferenceContext(db);
    const prompt = formatPreferencePrompt(context);

    expect(context.negativeExamples).toHaveLength(1);
    expect(prompt).toContain("Low-rated examples to avoid resembling:");
    expect(prompt).toContain("fewer than three ideas have been rated");

    db.close();
  });
});
