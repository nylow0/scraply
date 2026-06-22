import { randomUUID } from "node:crypto";
import { nextIntakeQuestion } from "../shared/intake";
import { ProjectBriefSchema, type ProjectBrief } from "../shared/schemas";

export function buildBriefFromAnswers(
  answers: Array<{ questionId: string; answer: string; skipped: boolean }>,
): ProjectBrief {
  const map = new Map(answers.filter((a) => !a.skipped && a.answer.trim()).map((a) => [a.questionId, a.answer.trim()]));
  const firstLine = map.get("goal") ?? "Untitled project";
  const projectName = firstLine.split(/[.!?]/)[0]?.slice(0, 80) || "Untitled project";
  return ProjectBriefSchema.parse({
    projectName,
    goal: map.get("goal") ?? "",
    theme: map.get("theme") ?? firstLine,
    description: map.get("theme") ?? firstLine,
    successDefinition: map.get("good-idea") ?? "A strong, evidence-backed idea worth pursuing",
    desiredOutput: map.get("output") ?? "A shortlist of strong ideas with evidence",
    successDecider: map.get("success-decider") ?? "",
    motivation: map.get("motivation") ?? "",
    constraints: [],
    resources: splitLines(map.get("resources")),
    avoidList: splitLines(map.get("avoid")),
    researchNeeds: map.get("research-needs") ?? "",
    finalDecision: map.get("final-decision") ?? "Choose the best next idea to pursue",
    deadline: map.get("deadline") ?? "Flexible",
    availableEffort: map.get("deadline") ?? "Not specified",
    ideaStylePreference: map.get("style-balance") ?? "Balanced",
    examples: map.get("examples") ?? "",
    scoringCriteria: map.get("scoring-criteria") ?? "",
    anythingElse: map.get("anything-else") ?? "",
  });
}

function splitLines(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value.split(/\n|;/).map((part) => part.trim()).filter(Boolean);
}

export function intakeAssistantMessage(answeredIds: Set<string>): string | null {
  const next = nextIntakeQuestion(answeredIds);
  if (!next) return null;
  return next.optional
    ? `${next.prompt}\n\n(This question is optional — you can skip it.)`
    : next.prompt;
}

export function newThreadTitle(goalAnswer?: string): string {
  if (!goalAnswer?.trim()) return "New research";
  return goalAnswer.trim().slice(0, 60);
}

export function createId(): string {
  return randomUUID();
}
