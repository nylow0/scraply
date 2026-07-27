import { z } from "zod";
import {
  LegacyProjectBriefSchema,
  ProjectBriefV2Schema,
  type LegacyProjectBrief,
  type ProjectBriefV2,
} from "./schemas";

const LEGACY_KEYS = new Set([
  "projectName",
  "theme",
  "description",
  "desiredOutput",
  "successDefinition",
  "constraints",
  "resources",
  "avoidList",
  "researchNeeds",
  "finalDecision",
  "deadline",
  "availableEffort",
  "ideaStylePreference",
]);

export const NormalizedProjectBriefSchema = z.unknown().transform((value, context) => {
  try {
    return parseAndNormalizeBrief(value);
  } catch (error) {
    if (error instanceof z.ZodError) {
      for (const issue of error.issues) context.addIssue(issue);
      return z.NEVER;
    }
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : "Invalid project brief",
    });
    return z.NEVER;
  }
});

export function parseAndNormalizeBrief(value: unknown): ProjectBriefV2 {
  const v2 = ProjectBriefV2Schema.safeParse(value);
  if (v2.success) return v2.data;

  const legacy = LegacyProjectBriefSchema.parse(value);
  return ProjectBriefV2Schema.parse(normalizeLegacyBrief(legacy));
}

function normalizeLegacyBrief(legacy: LegacyProjectBrief): ProjectBriefV2 {
  const assumptions = Object.entries(legacy)
    .filter(([key, value]) => !LEGACY_KEYS.has(key) && hasMeaningfulValue(value))
    .map(([key, value]) => `Legacy ${humanizeKey(key)}: ${serializeValue(value)}`);
  const style = normalizeIdeaStyle(legacy.ideaStylePreference);
  if (style.assumption) assumptions.push(style.assumption);

  return {
    schemaVersion: 2,
    title: legacy.projectName.trim(),
    objective: legacy.theme.trim(),
    context: legacy.description.trim(),
    decisionToSupport: legacy.finalDecision.trim(),
    audience: [],
    desiredOutput: {
      type: inferDesiredOutputType(legacy.desiredOutput),
      notes: legacy.desiredOutput.trim(),
    },
    successCriteria: toSingleItemList(legacy.successDefinition),
    hardConstraints: normalizeList(legacy.constraints),
    preferences: [],
    antiGoals: normalizeList(legacy.avoidList),
    resources: normalizeList(legacy.resources),
    deadline: nullableLegacyText(legacy.deadline, ["flexible", "no deadline", "not specified"]),
    availableEffort: nullableLegacyText(legacy.availableEffort, ["not specified"]),
    evidenceRequirements: toSingleItemList(legacy.researchNeeds),
    examplesToInspect: [],
    ideaStyle: style.value,
    assumptions,
    openQuestions: [],
    contradictions: [],
  };
}

function inferDesiredOutputType(value: string): ProjectBriefV2["desiredOutput"]["type"] {
  const normalized = value.toLowerCase();
  if (/\b(rank|ranked|shortlist)\b/.test(normalized)) return "ranked-shortlist";
  if (/\bdecision\s+(memo|brief)\b/.test(normalized)) return "decision-memo";
  if (/\b(research\s+brief|briefing)\b/.test(normalized)) return "research-brief";
  if (/\b(compare|comparison|versus|vs\.?)\b/.test(normalized)) return "comparison";
  if (/\b(option|ideas?|opportunities|directions|alternatives)\b/.test(normalized)) return "options";
  return "other";
}

function normalizeIdeaStyle(value: string): { value: ProjectBriefV2["ideaStyle"]; assumption?: string } {
  const normalized = value.trim().toLowerCase();
  if (/\b(safe|conservative|practical|evidence-first)\b/.test(normalized)) return { value: "safe" };
  if (/\b(bold|creative|experimental|novel|outlier)\b/.test(normalized)) return { value: "bold" };
  if (!normalized || /\bbalanced?\b/.test(normalized)) return { value: "balanced" };
  return {
    value: "balanced",
    assumption: `Legacy idea style preference: ${value.trim()}`,
  };
}

function normalizeList(values: string[]): string[] {
  return values.map((value) => value.trim()).filter(Boolean);
}

function toSingleItemList(value: string): string[] {
  const normalized = value.trim();
  return normalized ? [normalized] : [];
}

function nullableText(value: string): string | null {
  const normalized = value.trim();
  return normalized || null;
}

function nullableLegacyText(value: string, placeholders: string[]): string | null {
  const normalized = nullableText(value);
  if (!normalized) return null;
  return placeholders.includes(normalized.toLowerCase()) ? null : normalized;
}

function hasMeaningfulValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return Boolean(value.trim());
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function serializeValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function humanizeKey(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
}
