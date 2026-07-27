import type { ProjectBrief } from "../../src/shared/schemas";

export function makeProjectBrief(overrides: Partial<ProjectBrief> = {}): ProjectBrief {
  return {
    schemaVersion: 2,
    title: "Test project",
    objective: "Find an evidence-backed direction",
    context: "Research the opportunity and its constraints.",
    decisionToSupport: "Choose what to do next",
    audience: [],
    desiredOutput: {
      type: "options",
      notes: "A useful set of options",
    },
    successCriteria: [],
    hardConstraints: [],
    preferences: [],
    antiGoals: [],
    resources: [],
    deadline: null,
    availableEffort: null,
    evidenceRequirements: [],
    examplesToInspect: [],
    ideaStyle: "balanced",
    assumptions: [],
    openQuestions: [],
    contradictions: [],
    ...overrides,
  };
}
