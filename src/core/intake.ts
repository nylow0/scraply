import type { OpenCodeClient } from "../providers/opencode";
import { ALL_INTAKE_QUESTIONS } from "../shared/intake";
import { ProjectBriefSchema, type ProjectBrief } from "../shared/schemas";

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

export function newThreadTitle(goalAnswer?: string): string {
  if (!goalAnswer?.trim()) return "New research";
  return goalAnswer.trim().slice(0, 60);
}
