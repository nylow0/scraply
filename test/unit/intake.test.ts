import { describe, expect, test } from "bun:test";
import { RESEARCH_STREAMS } from "../../src/research/streams";
import { nextIntakeQuestion } from "../../src/shared/intake";
import {
  buildCoverageContext,
  buildIdeaContext,
  buildQueryContext,
  buildResearcherContext,
  buildSynthesisContext,
} from "../../src/core/brief-context";
import type { ProjectBrief } from "../../src/shared/schemas";
import { makeProjectBrief } from "../helpers/project-brief";

describe("Research streams", () => {
  test("defines exactly six canonical streams", () => {
    expect(RESEARCH_STREAMS).toHaveLength(6);
    expect(RESEARCH_STREAMS.map((s) => s.id)).toEqual([
      "landscape", "exemplars", "pain-gaps", "resources", "analogies", "evaluation",
    ]);
  });
});

describe("Intake flow", () => {
  test("asks required questions before optional ones", () => {
    expect(nextIntakeQuestion(new Set())?.id).toBe("goal");
    const requiredDone = new Set(["goal", "theme", "good-idea", "output", "success-decider", "motivation", "deadline", "resources", "avoid", "final-decision"]);
    expect(nextIntakeQuestion(requiredDone)?.optional).toBe(true);
  });

  test("routes every consequential current brief field to at least one consumer", () => {
    const brief: ProjectBrief = makeProjectBrief({
      title: "project-token",
      objective: "theme-token",
      context: "description-token",
      decisionToSupport: "decision-token",
      audience: ["audience-token"],
      desiredOutput: { type: "other", notes: "output-token" },
      successCriteria: ["success-token"],
      hardConstraints: ["constraint-token"],
      preferences: ["preference-token", "style-token"],
      resources: ["resource-token"],
      antiGoals: ["avoid-token"],
      deadline: "deadline-token",
      availableEffort: "effort-token",
      evidenceRequirements: ["research-token"],
      examplesToInspect: ["example-token"],
      ideaStyle: "bold",
      assumptions: ["assumption-token"],
      openQuestions: ["question-token"],
      contradictions: ["contradiction-token"],
    });
    const contexts = [
      buildQueryContext(brief),
      buildResearcherContext(brief),
      buildCoverageContext(brief),
      buildSynthesisContext(brief),
      buildIdeaContext(brief),
    ].join("\n");

    for (const token of [
      "project-token",
      "theme-token",
      "description-token",
      "output-token",
      "success-token",
      "constraint-token",
      "resource-token",
      "avoid-token",
      "research-token",
      "decision-token",
      "deadline-token",
      "effort-token",
      "style-token",
    ]) {
      expect(contexts).toContain(token);
    }
  });
});
