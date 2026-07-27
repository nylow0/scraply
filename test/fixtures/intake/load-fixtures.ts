import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const INTAKE_FIXTURE_SCENARIOS = [
  "one-sentence-vague-prompt",
  "detailed-pasted-brief",
  "brief-with-no-deadline",
  "brief-with-contradictory-constraints",
  "brief-with-examples-and-anti-examples",
  "broad-exploration-without-ranking",
  "decision-request-with-explicit-criteria",
  "brief-with-strict-evidence-requirement",
  "prompt-with-irrelevant-background",
  "incomplete-prompt-with-important-values-unknown",
] as const;

export type IntakeFixtureScenario = (typeof INTAKE_FIXTURE_SCENARIOS)[number];

export interface IntakeParserFixture {
  id: string;
  scenario: IntakeFixtureScenario;
  input: string;
  expected: {
    objective: string;
    decisionToSupport: string | null;
    desiredOutputType:
      | "options"
      | "ranked-shortlist"
      | "decision-memo"
      | "research-brief"
      | "comparison"
      | "other"
      | null;
    successCriteria: string[];
    hardConstraints: string[];
    deadline: string | null;
    evidenceRequirements: string[];
    examplesToInspect: string[];
    antiGoals: string[];
    contradictions: string[];
    importantUnknowns: string[];
  };
}

export function loadIntakeParserFixtures(): IntakeParserFixture[] {
  return readdirSync(import.meta.dir)
    .filter((name) => /^\d{2}-.+\.json$/.test(name))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(import.meta.dir, name), "utf8")) as IntakeParserFixture);
}
