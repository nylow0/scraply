import { describe, expect, test } from "bun:test";
import { generateBriefFromText } from "../../src/core/intake";
import type { StructuredModelClient } from "../../src/providers/structured";
import {
  BriefExtractionResponseSchema,
  StartBriefIntakeSchema,
  type BriefExtractionResponse,
} from "../../src/shared/ipc";
import type { IntakeParserFixture } from "../fixtures/intake/load-fixtures";
import { loadIntakeParserFixtures } from "../fixtures/intake/load-fixtures";
import { makeProjectBrief } from "../helpers/project-brief";

function responseForFixture(fixture: IntakeParserFixture): BriefExtractionResponse {
  const expected = fixture.expected;
  return {
    brief: makeProjectBrief({
      title: expected.objective.replace(/[.!?]+$/, ""),
      objective: expected.objective,
      decisionToSupport: expected.decisionToSupport ?? "",
      desiredOutput: {
        type: expected.desiredOutputType ?? "other",
        notes: expected.desiredOutputType ?? "",
      },
      successCriteria: expected.successCriteria,
      hardConstraints: expected.hardConstraints,
      antiGoals: expected.antiGoals,
      deadline: expected.deadline,
      evidenceRequirements: expected.evidenceRequirements,
      examplesToInspect: expected.examplesToInspect,
      assumptions: [],
      openQuestions: [],
      contradictions: [],
    }),
    missingFields: expected.importantUnknowns,
    assumptions: [],
    contradictions: expected.contradictions,
  };
}

function fakeClient(
  response: BriefExtractionResponse,
  calls: Array<{ system: string; user: string }>,
): StructuredModelClient {
  return {
    async structuredCompletion(_model, system, user) {
      calls.push({ system, user });
      return response as never;
    },
  };
}

describe("brief-first extraction", () => {
  test("sends each Phase 0 fixture as one complete model input and preserves expected critical fields", async () => {
    let criticalMatches = 0;
    let criticalChecks = 0;

    for (const fixture of loadIntakeParserFixtures()) {
      const calls: Array<{ system: string; user: string }> = [];
      const result = await generateBriefFromText(
        fakeClient(responseForFixture(fixture), calls),
        "fixture-model",
        fixture.input,
      );

      expect(calls).toHaveLength(1);
      expect(calls[0]?.user).toBe(fixture.input);
      expect(calls[0]?.system).toContain("Never invent hard constraints, deadlines, resources, anti-goals");

      const expected = fixture.expected;
      const actualCritical = [
        result.brief.objective,
        result.brief.decisionToSupport || null,
        expected.desiredOutputType === null ? null : result.brief.desiredOutput.type,
      ];
      const expectedCritical = [
        expected.objective,
        expected.decisionToSupport,
        expected.desiredOutputType,
      ];
      for (let index = 0; index < expectedCritical.length; index += 1) {
        criticalChecks += 1;
        if (actualCritical[index] === expectedCritical[index]) criticalMatches += 1;
      }

      expect(result.brief.hardConstraints).toEqual(expected.hardConstraints);
      expect(result.brief.deadline).toBe(expected.deadline);
      expect(result.brief.antiGoals).toEqual(expected.antiGoals);
      expect(result.brief.openQuestions).toEqual(expect.arrayContaining(expected.importantUnknowns));
      expect(result.brief.contradictions).toEqual(expect.arrayContaining(expected.contradictions));
    }

    expect(criticalMatches / criticalChecks).toBeGreaterThanOrEqual(0.9);
  });

  test("persists envelope assumptions, contradictions, and missing fields inside the V2 brief", async () => {
    const response: BriefExtractionResponse = {
      brief: makeProjectBrief({
        assumptions: ["Existing assumption"],
        openQuestions: ["Who is the audience?"],
        contradictions: ["Existing contradiction"],
      }),
      missingFields: ["budget", "deadline", "budget"],
      assumptions: ["Model inferred a student audience", "Existing assumption"],
      contradictions: ["Deadline is both fixed and flexible", "Existing contradiction"],
    };

    const result = await generateBriefFromText(fakeClient(response, []), "fixture-model", "A starter brief");

    expect(result.brief.assumptions).toEqual([
      "Existing assumption",
      "Model inferred a student audience",
    ]);
    expect(result.brief.openQuestions).toEqual(["Who is the audience?", "budget", "deadline"]);
    expect(result.brief.contradictions).toEqual([
      "Existing contradiction",
      "Deadline is both fixed and flexible",
    ]);
    expect(result.missingFields).toEqual(["budget", "deadline"]);
  });

  test("validates strict request and V2 extraction contracts", () => {
    expect(StartBriefIntakeSchema.parse({ threadId: "thread-1", text: "  Full brief  " })).toEqual({
      threadId: "thread-1",
      text: "Full brief",
    });
    expect(() => StartBriefIntakeSchema.parse({ threadId: "thread-1", text: " " })).toThrow();
    expect(() => BriefExtractionResponseSchema.parse({
      ...responseForFixture(loadIntakeParserFixtures()[0]!),
      unexpected: true,
    })).toThrow();
  });
});
