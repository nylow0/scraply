import { describe, expect, test } from "bun:test";
import {
  buildCoverageContext,
  buildIdeaContext,
  buildQueryContext,
  buildResearcherContext,
  buildSynthesisContext,
} from "../../src/core/brief-context";
import type { ProjectBrief } from "../../src/shared/schemas";
import { makeProjectBrief } from "../helpers/project-brief";

const brief: ProjectBrief = makeProjectBrief({
  title: "Northstar",
  objective: "Local-first study tools",
  context: "Find a focused product opportunity for students.",
  decisionToSupport: "Choose one product to prototype",
  audience: ["Students"],
  desiredOutput: { type: "ranked-shortlist", notes: "A ranked shortlist with a recommendation" },
  successCriteria: ["Useful weekly", "Feasible for one developer"],
  hardConstraints: ["Offline by default", "No paid data APIs"],
  preferences: ["Low operational complexity"],
  resources: ["TypeScript experience", "Twenty user interviews"],
  antiGoals: ["Ad-funded products", "Generic chatbot wrappers"],
  deadline: "Prototype within six weeks",
  availableEffort: "Ten hours per week",
  evidenceRequirements: ["Use primary evidence for student pain points"],
  examplesToInspect: ["Existing local-first study tools"],
  ideaStyle: "balanced",
});

describe("brief context routing", () => {
  test("routes constraints into researcher and coverage contexts", () => {
    for (const context of [buildResearcherContext(brief), buildCoverageContext(brief)]) {
      expect(context).toContain("Hard constraints");
      expect(context).toContain("Offline by default");
      expect(context).toContain("No paid data APIs");
    }
  });

  test("routes the final decision into coverage, synthesis, and idea contexts", () => {
    for (const context of [
      buildCoverageContext(brief),
      buildSynthesisContext(brief),
      buildIdeaContext(brief),
    ]) {
      expect(context).toContain("Decision to support: Choose one product to prototype");
    }
  });

  test("makes resources and effort explicit wherever feasibility is assessed", () => {
    for (const context of [
      buildResearcherContext(brief),
      buildCoverageContext(brief),
      buildSynthesisContext(brief),
      buildIdeaContext(brief),
    ]) {
      expect(context).toContain("TypeScript experience");
      expect(context).toContain("Ten hours per week");
    }
    expect(buildIdeaContext(brief)).toContain("Resources for feasibility scoring");
    expect(buildIdeaContext(brief)).toContain("Available effort for feasibility scoring");
  });

  test("uses the desired output for synthesis and idea packaging, but not query or coverage", () => {
    expect(buildSynthesisContext(brief)).toContain(
      "Desired output/package: A ranked shortlist with a recommendation",
    );
    expect(buildIdeaContext(brief)).toContain(
      "Desired output/package: A ranked shortlist with a recommendation",
    );
    expect(buildQueryContext(brief)).not.toContain("ranked shortlist");
    expect(buildCoverageContext(brief)).not.toContain("ranked shortlist");
  });

  test("turns avoid items into explicit exclusions and idea vetoes", () => {
    expect(buildResearcherContext(brief)).toContain(
      "Explicit exclusions (must not recommend or pursue): Ad-funded products; Generic chatbot wrappers",
    );
    expect(buildIdeaContext(brief)).toContain(
      "Explicit exclusions (veto matching ideas): Ad-funded products; Generic chatbot wrappers",
    );
  });

  test("omits empty optional values without placeholder noise", () => {
    const sparse: ProjectBrief = {
      ...brief,
      hardConstraints: [],
      resources: ["", "  "],
      antiGoals: [],
      evidenceRequirements: [" "],
      deadline: null,
      availableEffort: null,
      preferences: [],
      examplesToInspect: [],
      assumptions: [],
      openQuestions: [],
      contradictions: [],
    };

    for (const context of [
      buildQueryContext(sparse),
      buildResearcherContext(sparse),
      buildCoverageContext(sparse),
      buildSynthesisContext(sparse),
      buildIdeaContext(sparse),
    ]) {
      expect(context).not.toContain("Hard constraints");
      expect(context).not.toContain("Explicit exclusions");
      expect(context).not.toContain("Resources");
      expect(context).not.toContain("Deadline");
      expect(context).not.toContain("Available effort");
      expect(context).not.toContain("none");
      expect(context).not.toContain(": \n");
    }
  });
});
