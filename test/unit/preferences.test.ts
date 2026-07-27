import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseClient } from "../../src/db/client";
import { ThreadRepository } from "../../src/db/repositories/threads";
import { buildPreferenceContext, formatPreferencePrompt } from "../../src/core/preferences";
import { buildIdeaPrompt } from "../../src/core/ideas";
import type { ProjectBrief } from "../../src/shared/schemas";
import { makeProjectBrief } from "../helpers/project-brief";

const brief: ProjectBrief = makeProjectBrief({
  title: "Test",
  objective: "Widgets",
  context: "Build better widgets",
  desiredOutput: { type: "options", notes: "Ideas" },
  successCriteria: ["Useful ideas"],
  evidenceRequirements: ["Market scan"],
  decisionToSupport: "Pick one idea",
  deadline: "Soon",
  availableEffort: "Medium",
});

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
    db.db.prepare("INSERT INTO idea_ratings (idea_id, rating, notes, updated_at) VALUES (?, ?, ?, ?)")
      .run(ideaId, 5, null, new Date().toISOString());

    const context = buildPreferenceContext(db);
    const prompt = buildIdeaPrompt(brief, formatPreferencePrompt(context), [], 3, "direct gaps");

    expect(context.positiveExamples).toHaveLength(1);
    expect(prompt).toContain("Highly rated examples:");
    expect(prompt).toContain("High-signal idea");
    db.close();
  });

  test("keeps neutral ideas out of positive and negative examples", () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-prefs-"));
    const db = new DatabaseClient(join(dir, "scraply.db"));
    const thread = new ThreadRepository(db).createThread("Prefs");
    const now = new Date().toISOString();
    const scores = JSON.stringify({ relevance: 7, novelty: 7, evidenceStrength: 7, feasibility: 7, demand: 7, saturation: 5 });

    for (const [id, title, rating] of [
      ["idea-positive", "Positive idea", 5],
      ["idea-neutral", "Neutral idea", 3],
      ["idea-negative", "Negative idea", 1],
    ] as const) {
      db.db.prepare(`
        INSERT INTO ideas (id, thread_id, title, description, bucket, scores_json, supporting_claim_ids_json, created_at)
        VALUES (?, ?, ?, ?, 'strong-fit', ?, '[]', ?)
      `).run(id, thread.id, title, `${title} description`, scores, now);
      db.db.prepare("INSERT INTO idea_ratings (idea_id, rating, notes, updated_at) VALUES (?, ?, NULL, ?)")
        .run(id, rating, now);
    }

    const context = buildPreferenceContext(db);

    expect(context.ratedCount).toBe(3);
    expect(context.positiveExamples.map((idea) => idea.title)).toEqual(["Positive idea"]);
    expect(context.negativeExamples.map((idea) => idea.title)).toEqual(["Negative idea"]);
    db.close();
  });
});
