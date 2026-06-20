export const REQUIRED_INTAKE_QUESTIONS = [
  { id: "goal", prompt: "What are we trying to generate ideas for?" },
  { id: "theme", prompt: "What is the broad theme or area, and what is your rough description?" },
  { id: "good-idea", prompt: "What would make an idea good in this context?" },
  { id: "output", prompt: "What final output do you want?" },
  { id: "success-decider", prompt: "Who or what decides whether this succeeds?" },
  { id: "motivation", prompt: "Why do you want to do this, and what main reward matters?" },
  { id: "deadline", prompt: "What is the deadline or ideal window, and how much time is available each week?" },
  { id: "resources", prompt: "What skills, tools, resources, people, or data are available?" },
  { id: "avoid", prompt: "What must be avoided?" },
  { id: "final-decision", prompt: "What decision must be made at the end?" },
] as const;

export const OPTIONAL_INTAKE_QUESTIONS = [
  { id: "style-balance", prompt: "How should we balance safe versus weird/high-upside ideas?" },
  { id: "examples", prompt: "Are there existing examples or problems we should inspect?" },
  { id: "research-needs", prompt: "Any specific research requirements?" },
  { id: "scoring-criteria", prompt: "Any important scoring criteria?" },
  { id: "anything-else", prompt: "Anything material that is still missing?" },
] as const;

export const ALL_INTAKE_QUESTIONS = [...REQUIRED_INTAKE_QUESTIONS, ...OPTIONAL_INTAKE_QUESTIONS];

export function nextIntakeQuestion(answeredIds: Set<string>): { id: string; prompt: string; optional: boolean } | null {
  for (const q of REQUIRED_INTAKE_QUESTIONS) {
    if (!answeredIds.has(q.id)) return { ...q, optional: false };
  }
  for (const q of OPTIONAL_INTAKE_QUESTIONS) {
    if (!answeredIds.has(q.id)) return { ...q, optional: true };
  }
  return null;
}

export function intakeProgress(answeredIds: Set<string>): { answered: number; required: number; total: number } {
  const requiredAnswered = REQUIRED_INTAKE_QUESTIONS.filter((q) => answeredIds.has(q.id)).length;
  return {
    answered: answeredIds.size,
    required: requiredAnswered,
    total: ALL_INTAKE_QUESTIONS.length,
  };
}

export const DEFAULT_RUN_CONFIG = {
  orchestratorProvider: "opencode" as const,
  orchestratorModel: "glm-5.2",
  workerModel: "mimo-v2.5",
  ideaProvider: "opencode" as const,
  ideaModel: "glm-5.2",
  ideasRequested: 24,
  batchSize: 6,
  maxFollowUpRounds: 2,
  searchResultsPerStream: 5,
  pageCharLimit: 6000,
  parallelism: 3,
  maxSpendUsd: 5,
  autoPublishPlans: false,
};
