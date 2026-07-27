import { ProjectBriefV2Schema, type ProjectBrief } from "@shared/schemas";

export interface BriefReviewErrors {
  objective?: string;
  decisionToSupport?: string;
  desiredOutput?: string;
}

const LIST_FIELDS = [
  "audience",
  "successCriteria",
  "hardConstraints",
  "preferences",
  "antiGoals",
  "resources",
  "evidenceRequirements",
  "examplesToInspect",
  "assumptions",
  "openQuestions",
  "contradictions",
] as const satisfies ReadonlyArray<keyof ProjectBrief>;

export function validateBriefForReview(brief: ProjectBrief): BriefReviewErrors {
  const errors: BriefReviewErrors = {};
  if (!brief.objective.trim()) errors.objective = "Add the objective this research should serve.";
  if (!brief.decisionToSupport.trim()) {
    errors.decisionToSupport = "Add the decision to support or state the exploratory intent.";
  }
  if (brief.desiredOutput.type === "other" && !brief.desiredOutput.notes.trim()) {
    errors.desiredOutput = "Describe the desired output when “Other” is selected.";
  }
  return errors;
}

export function prepareBriefForSubmission(brief: ProjectBrief): ProjectBrief {
  const prepared = cloneBriefForReview(brief);
  prepared.title = prepared.title.trim();
  prepared.objective = prepared.objective.trim();
  prepared.context = prepared.context.trim();
  prepared.decisionToSupport = prepared.decisionToSupport.trim();
  prepared.desiredOutput.notes = prepared.desiredOutput.notes.trim();
  prepared.deadline = nullableText(prepared.deadline);
  prepared.availableEffort = nullableText(prepared.availableEffort);
  for (const field of LIST_FIELDS) {
    prepared[field] = prepared[field].map((item) => item.trim()).filter(Boolean);
  }
  return prepared;
}

export function cloneBriefForReview(value: unknown): ProjectBrief {
  return structuredClone(ProjectBriefV2Schema.parse(value));
}

function nullableText(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed || null;
}
