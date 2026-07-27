import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildIdeaPrompt } from "../../src/core/ideas";
import { loadPrompt } from "../../src/core/prompts";
import type { ProjectBrief } from "../../src/shared/schemas";
import { makeProjectBrief } from "../helpers/project-brief";

const promptDir = join(process.cwd(), "prompts");
const testPromptPath = join(promptDir, "unit-test-prompt.md");

afterEach(() => {
  if (existsSync(testPromptPath)) rmSync(testPromptPath, { force: true });
});

describe("prompt loader", () => {
  test("loads editable prompt files from the project prompts folder", () => {
    mkdirSync(promptDir, { recursive: true });
    writeFileSync(testPromptPath, "Editable prompt from disk.\n", "utf8");

    expect(loadPrompt("unit-test-prompt", "fallback prompt")).toBe("Editable prompt from disk.");
  });

  test("falls back when a prompt file is missing", () => {
    expect(loadPrompt("missing-unit-test-prompt", "fallback prompt")).toBe("fallback prompt");
  });
});

describe("downstream brief prompts", () => {
  test("idea generation consumes the centralized decision, feasibility, and packaging context", () => {
    const brief: ProjectBrief = makeProjectBrief({
      title: "Prompt test",
      objective: "Study tools",
      context: "Find a product direction",
      desiredOutput: { type: "ranked-shortlist", notes: "Ranked shortlist" },
      successCriteria: ["Can be built by one student"],
      hardConstraints: ["Local-first"],
      resources: ["TypeScript"],
      antiGoals: ["Ads"],
      evidenceRequirements: ["Student interviews"],
      decisionToSupport: "Pick one prototype",
      deadline: "Six weeks",
      availableEffort: "Ten hours weekly",
    });

    const prompt = buildIdeaPrompt(brief, "No preferences yet.", [], 3, "direct gaps");

    expect(prompt).toContain("Decision to support: Pick one prototype");
    expect(prompt).toContain("Desired output/package: Ranked shortlist");
    expect(prompt).toContain("Hard constraints (veto ideas that violate these): Local-first");
    expect(prompt).toContain("Resources for feasibility scoring: TypeScript");
    expect(prompt).toContain("Available effort for feasibility scoring: Ten hours weekly");
    expect(prompt).toContain("Explicit exclusions (veto matching ideas): Ads");
  });
});
