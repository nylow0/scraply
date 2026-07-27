import { describe, expect, test } from "bun:test";
import {
  INTAKE_FIXTURE_SCENARIOS,
  loadIntakeParserFixtures,
  type IntakeParserFixture,
} from "../fixtures/intake/load-fixtures";

const OUTPUT_TYPES = new Set([
  "options",
  "ranked-shortlist",
  "decision-memo",
  "research-brief",
  "comparison",
  "other",
]);

const ARRAY_FIELDS = [
  "successCriteria",
  "hardConstraints",
  "evidenceRequirements",
  "examplesToInspect",
  "antiGoals",
  "contradictions",
  "importantUnknowns",
] as const satisfies ReadonlyArray<keyof IntakeParserFixture["expected"]>;

describe("Intake parser fixtures", () => {
  test("contains exactly one fixture for each Phase 0 parser scenario", () => {
    const fixtures = loadIntakeParserFixtures();

    expect(fixtures).toHaveLength(10);
    expect(new Set(fixtures.map((fixture) => fixture.id)).size).toBe(10);
    expect(fixtures.map((fixture) => fixture.scenario)).toEqual([...INTAKE_FIXTURE_SCENARIOS]);
  });

  test("fixtures have non-empty inputs and a complete source-of-truth shape", () => {
    for (const fixture of loadIntakeParserFixtures()) {
      expect(fixture.id.trim()).not.toBe("");
      expect(fixture.input).toBe(fixture.input.trim());
      expect(fixture.input.length).toBeGreaterThan(10);
      expect(fixture.expected.objective.trim()).not.toBe("");

      if (fixture.expected.decisionToSupport !== null) {
        expect(fixture.expected.decisionToSupport.trim()).not.toBe("");
      }
      if (fixture.expected.deadline !== null) {
        expect(fixture.expected.deadline.trim()).not.toBe("");
      }
      if (fixture.expected.desiredOutputType !== null) {
        expect(OUTPUT_TYPES.has(fixture.expected.desiredOutputType)).toBe(true);
      }

      for (const field of ARRAY_FIELDS) {
        expect(Array.isArray(fixture.expected[field])).toBe(true);
        for (const value of fixture.expected[field]) {
          expect(value.trim()).not.toBe("");
        }
      }
    }
  });

  test("preserves the critical unknowns and contradiction cases", () => {
    const fixtures = loadIntakeParserFixtures();
    const byScenario = new Map(fixtures.map((fixture) => [fixture.scenario, fixture]));

    expect(byScenario.get("one-sentence-vague-prompt")?.expected.importantUnknowns.length).toBeGreaterThan(0);
    expect(byScenario.get("brief-with-no-deadline")?.expected.deadline).toBeNull();
    expect(byScenario.get("brief-with-contradictory-constraints")?.expected.contradictions.length).toBeGreaterThan(0);
    expect(byScenario.get("incomplete-prompt-with-important-values-unknown")?.expected.importantUnknowns.length).toBeGreaterThan(0);
  });
});
