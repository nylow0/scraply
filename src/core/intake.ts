import { randomUUID } from "node:crypto";
import type { OpenCodeClient } from "../providers/opencode";
import { ALL_INTAKE_QUESTIONS, nextIntakeQuestion } from "../shared/intake";
import { ProjectBriefSchema, type ProjectBrief } from "../shared/schemas";

export function buildBriefFromAnswers(
  answers: Array<{ questionId: string; answer: string; skipped: boolean }>,
): ProjectBrief {
  const map = new Map(answers.filter((a) => !a.skipped && a.answer.trim()).map((a) => [a.questionId, a.answer.trim()]));
  const firstLine = map.get("goal") ?? "Untitled project";
  const projectName = firstLine.split(/[.!?]/)[0]?.slice(0, 80) || "Untitled project";
  return ProjectBriefSchema.parse({
    projectName,
    theme: map.get("theme") ?? firstLine,
    description: map.get("theme") ?? firstLine,
    desiredOutput: map.get("output") ?? "A shortlist of strong ideas with evidence",
    successDefinition: map.get("success-decider") ?? "The user decides what succeeds",
    constraints: splitLines(map.get("deadline")),
    resources: splitLines(map.get("resources")),
    avoidList: splitLines(map.get("avoid")),
    researchNeeds: map.get("research-needs") ?? map.get("examples") ?? "",
    finalDecision: map.get("final-decision") ?? "Choose the best next idea to pursue",
    deadline: map.get("deadline") ?? "Flexible",
    availableEffort: map.get("deadline") ?? "Not specified",
    ideaStylePreference: map.get("style-balance") ?? map.get("good-idea") ?? "Balanced",
  });
}

function splitLines(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value.split(/\n|;/).map((part) => part.trim()).filter(Boolean);
}

export async function generateBriefWithModel(
  client: OpenCodeClient,
  model: string,
  answers: Array<{ questionId: string; answer: string; skipped: boolean }>,
): Promise<ProjectBrief> {
  const transcript = answers
    .map((a) => {
      const q = ALL_INTAKE_QUESTIONS.find((item) => item.id === a.questionId);
      return `${q?.prompt ?? a.questionId}: ${a.skipped ? "(skipped)" : a.answer}`;
    })
    .join("\n");
  return client.structuredCompletion(
    model,
    "Turn intake answers into a concise confirmed project brief. Use arrays for list fields.",
    transcript,
    ProjectBriefSchema,
    {
      type: "object",
      properties: {
        projectName: { type: "string" },
        theme: { type: "string" },
        description: { type: "string" },
        desiredOutput: { type: "string" },
        successDefinition: { type: "string" },
        constraints: { type: "array", items: { type: "string" } },
        resources: { type: "array", items: { type: "string" } },
        avoidList: { type: "array", items: { type: "string" } },
        researchNeeds: { type: "string" },
        finalDecision: { type: "string" },
        deadline: { type: "string" },
        availableEffort: { type: "string" },
        ideaStylePreference: { type: "string" },
      },
      required: [
        "projectName", "theme", "description", "desiredOutput", "successDefinition",
        "constraints", "resources", "avoidList", "researchNeeds", "finalDecision",
        "deadline", "availableEffort", "ideaStylePreference",
      ],
    },
  );
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
