import type { ProjectBrief } from "../shared/schemas";

type ContextValue = string | null | readonly string[];

function addValue(lines: string[], label: string, value: ContextValue): void {
  if (value === null) return;
  if (typeof value === "string") {
    const normalized = value.trim();
    if (normalized) lines.push(`${label}: ${normalized}`);
    return;
  }

  const normalized = value.map((item) => item.trim()).filter(Boolean);
  if (normalized.length) lines.push(`${label}: ${normalized.join("; ")}`);
}

function buildContext(fields: ReadonlyArray<readonly [label: string, value: ContextValue]>): string {
  const lines: string[] = [];
  for (const [label, value] of fields) addValue(lines, label, value);
  return lines.join("\n");
}

const coreFields = (brief: ProjectBrief) => [
  ["Project", brief.title],
  ["Objective/theme", brief.objective],
  ["Description/context", brief.context],
  ["Decision to support", brief.decisionToSupport],
] as const;

const guardrailFields = (brief: ProjectBrief) => [
  ["Hard constraints (must satisfy)", brief.hardConstraints],
  ["Explicit exclusions (must not recommend or pursue)", brief.antiGoals],
] as const;

export function buildQueryContext(brief: ProjectBrief): string {
  return buildContext([
    ...coreFields(brief),
    ...guardrailFields(brief),
    ["Evidence/research needs", brief.evidenceRequirements],
    ["Success definition", brief.successCriteria],
    ["Resources relevant to feasibility", brief.resources],
    ["Deadline/time horizon", brief.deadline],
    ["Idea style for query diversification", brief.ideaStyle],
    ["Audience", brief.audience],
    ["Preferences", brief.preferences],
    ["Examples to inspect", brief.examplesToInspect],
  ]);
}

export function buildResearcherContext(brief: ProjectBrief): string {
  return buildContext([
    ...coreFields(brief),
    ...guardrailFields(brief),
    ["Desired output", formatDesiredOutput(brief)],
    ["Success definition", brief.successCriteria],
    ["Evidence/research needs", brief.evidenceRequirements],
    ["Available resources", brief.resources],
    ["Deadline/time horizon", brief.deadline],
    ["Available effort", brief.availableEffort],
    ["Audience", brief.audience],
    ["Preferences", brief.preferences],
    ["Examples to inspect", brief.examplesToInspect],
    ["Assumptions to verify", brief.assumptions],
    ["Open questions", brief.openQuestions],
    ["Known contradictions", brief.contradictions],
  ]);
}

export function buildCoverageContext(brief: ProjectBrief): string {
  return buildContext([
    ...coreFields(brief),
    ...guardrailFields(brief),
    ["Success definition/coverage criteria", brief.successCriteria],
    ["Evidence/research needs", brief.evidenceRequirements],
    ["Resources relevant to feasibility", brief.resources],
    ["Deadline/time horizon", brief.deadline],
    ["Available effort for feasibility", brief.availableEffort],
    ["Audience", brief.audience],
    ["Assumptions to verify", brief.assumptions],
    ["Open questions/gaps to resolve", brief.openQuestions],
    ["Known contradictions", brief.contradictions],
  ]);
}

export function buildSynthesisContext(brief: ProjectBrief): string {
  return buildContext([
    ...coreFields(brief),
    ...guardrailFields(brief),
    ["Desired output/package", formatDesiredOutput(brief)],
    ["Success definition", brief.successCriteria],
    ["Evidence/research needs", brief.evidenceRequirements],
    ["Available resources", brief.resources],
    ["Deadline/time horizon", brief.deadline],
    ["Available effort", brief.availableEffort],
    ["Idea style", brief.ideaStyle],
    ["Audience", brief.audience],
    ["Preferences", brief.preferences],
    ["Examples to inspect", brief.examplesToInspect],
    ["Assumptions to disclose", brief.assumptions],
    ["Open questions to preserve", brief.openQuestions],
    ["Known contradictions", brief.contradictions],
  ]);
}

export function buildIdeaContext(brief: ProjectBrief): string {
  return buildContext([
    ...coreFields(brief),
    ["Desired output/package", formatDesiredOutput(brief)],
    ["Success definition/ranking criteria", brief.successCriteria],
    ["Hard constraints (veto ideas that violate these)", brief.hardConstraints],
    ["Explicit exclusions (veto matching ideas)", brief.antiGoals],
    ["Evidence/research needs", brief.evidenceRequirements],
    ["Resources for feasibility scoring", brief.resources],
    ["Deadline/time horizon for feasibility scoring", brief.deadline],
    ["Available effort for feasibility scoring", brief.availableEffort],
    ["Idea style/diversity guidance", brief.ideaStyle],
    ["Audience", brief.audience],
    ["Preferences", brief.preferences],
    ["Examples to inspect", brief.examplesToInspect],
  ]);
}

function formatDesiredOutput(brief: ProjectBrief): string {
  return brief.desiredOutput.notes.trim()
    ? `${brief.desiredOutput.notes.trim()} (type: ${brief.desiredOutput.type})`
    : brief.desiredOutput.type;
}
