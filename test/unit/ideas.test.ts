import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseClient } from "../../src/db/client";
import { buildIdeaPrompt, buildResearchEvidenceContext } from "../../src/core/ideas";
import type { ProjectBrief } from "../../src/shared/schemas";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) {
    try {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    } catch {
      // Windows may keep WAL files locked briefly
    }
  }
});

const brief: ProjectBrief = {
  projectName: "Widget Studio",
  goal: "Find widget product ideas",
  theme: "Widgets",
  description: "Explore widget opportunities",
  successDefinition: "Clear next steps",
  desiredOutput: "Actionable ideas",
  successDecider: "Founder",
  motivation: "Grow revenue",
  constraints: [],
  resources: [],
  avoidList: ["crypto"],
  researchNeeds: "Landscape and gaps",
  finalDecision: "Choose direction",
  deadline: "Q3",
  availableEffort: "Medium",
  ideaStylePreference: "Balanced",
  examples: "Notion, Airtable",
  scoringCriteria: "Feasibility first",
  anythingElse: "",
};

describe("idea generation helpers", () => {
  test("buildIdeaPrompt includes brief fields and evidence context", () => {
    const prompt = buildIdeaPrompt(brief, "No ratings yet.", [], 4, "direct gaps", "Market is fragmented.");
    expect(prompt).toContain("Widget Studio");
    expect(prompt).toContain("Find widget product ideas");
    expect(prompt).toContain("Feasibility first");
    expect(prompt).toContain("Research evidence");
    expect(prompt).toContain("Market is fragmented.");
    expect(prompt).toContain("crypto");
  });

  test("buildResearchEvidenceContext prioritizes synthesis and strips HTML", () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-ideas-"));
    tempDirs.push(dir);
    const db = new DatabaseClient(join(dir, "scraply.db"));
    const threadId = "thread-1";
    db.db.prepare(`
      INSERT INTO threads (id, title, status, created_at, updated_at)
      VALUES (?, 'Test', 'research-complete', ?, ?)
    `).run(threadId, new Date().toISOString(), new Date().toISOString());
    db.db.prepare(`
      INSERT INTO reports (id, thread_id, stream_id, title, html, created_at)
      VALUES ('r1', ?, 'landscape', 'Landscape', '<p>Landscape evidence.</p>', ?)
    `).run(threadId, new Date().toISOString());
    db.db.prepare(`
      INSERT INTO reports (id, thread_id, stream_id, title, html, created_at)
      VALUES ('r2', ?, 'synthesis', 'Synthesis', '<p>Synthesis summary.</p>', ?)
    `).run(threadId, new Date().toISOString());

    const context = buildResearchEvidenceContext(db, threadId);
    expect(context.indexOf("Synthesis summary.")).toBeLessThan(context.indexOf("Landscape evidence."));
    expect(context).not.toContain("<p>");

    db.close();
  });
});
