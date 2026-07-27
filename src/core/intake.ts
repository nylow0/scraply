import type { StructuredModelClient } from "../providers/structured";
import { BriefExtractionResponseSchema, type BriefExtractionResponse } from "../shared/ipc";
import { loadPrompt } from "./prompts";
import { ALL_INTAKE_QUESTIONS } from "../shared/intake";
import { ProjectBriefV2Schema, type ProjectBrief } from "../shared/schemas";

const briefExtractionJsonSchema = {
  type: "object",
  properties: {
    brief: {
      type: "object",
      properties: {
        schemaVersion: { type: "number", const: 2 },
        title: { type: "string" },
        objective: { type: "string" },
        context: { type: "string" },
        decisionToSupport: { type: "string" },
        audience: { type: "array", items: { type: "string" } },
        desiredOutput: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["options", "ranked-shortlist", "decision-memo", "research-brief", "comparison", "other"],
            },
            notes: { type: "string" },
          },
          required: ["type", "notes"],
          additionalProperties: false,
        },
        successCriteria: { type: "array", items: { type: "string" } },
        hardConstraints: { type: "array", items: { type: "string" } },
        preferences: { type: "array", items: { type: "string" } },
        antiGoals: { type: "array", items: { type: "string" } },
        resources: { type: "array", items: { type: "string" } },
        deadline: { type: ["string", "null"] },
        availableEffort: { type: ["string", "null"] },
        evidenceRequirements: { type: "array", items: { type: "string" } },
        examplesToInspect: { type: "array", items: { type: "string" } },
        ideaStyle: { type: "string", enum: ["safe", "balanced", "bold"] },
        assumptions: { type: "array", items: { type: "string" } },
        openQuestions: { type: "array", items: { type: "string" } },
        contradictions: { type: "array", items: { type: "string" } },
      },
      required: [
        "schemaVersion", "title", "objective", "context", "decisionToSupport", "audience",
        "desiredOutput", "successCriteria", "hardConstraints", "preferences", "antiGoals",
        "resources", "deadline", "availableEffort", "evidenceRequirements", "examplesToInspect",
        "ideaStyle", "assumptions", "openQuestions", "contradictions",
      ],
      additionalProperties: false,
    },
    missingFields: { type: "array", items: { type: "string" } },
    assumptions: { type: "array", items: { type: "string" } },
    contradictions: { type: "array", items: { type: "string" } },
  },
  required: ["brief", "missingFields", "assumptions", "contradictions"],
  additionalProperties: false,
} as const;

export function buildBriefFromAnswers(
  answers: Array<{ questionId: string; answer: string; skipped: boolean }>,
): ProjectBrief {
  const map = new Map(answers.filter((a) => !a.skipped && a.answer.trim()).map((a) => [a.questionId, a.answer.trim()]));
  const firstLine = map.get("goal") ?? "Untitled project";
  const title = firstLine.split(/[.!?]/)[0]?.slice(0, 80) || "Untitled project";
  const desiredOutputNotes = map.get("output") ?? "";
  return ProjectBriefV2Schema.parse({
    schemaVersion: 2,
    title,
    objective: map.get("theme") ?? firstLine,
    context: [map.get("theme"), map.get("motivation")].filter(Boolean).join("\n"),
    decisionToSupport: map.get("final-decision") ?? "",
    audience: splitLines(map.get("success-decider")),
    desiredOutput: {
      type: inferDesiredOutputType(desiredOutputNotes),
      notes: desiredOutputNotes,
    },
    successCriteria: [
      ...splitLines(map.get("good-idea")),
      ...splitLines(map.get("scoring-criteria")),
    ],
    hardConstraints: [],
    preferences: splitLines(map.get("style-balance")),
    antiGoals: splitLines(map.get("avoid")),
    resources: splitLines(map.get("resources")),
    deadline: map.get("deadline") ?? null,
    availableEffort: map.get("deadline") ?? null,
    evidenceRequirements: splitLines(map.get("research-needs")),
    examplesToInspect: splitLines(map.get("examples")),
    ideaStyle: inferIdeaStyle(map.get("style-balance")),
    assumptions: splitLines(map.get("anything-else")),
    openQuestions: [],
    contradictions: [],
  });
}

function splitLines(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value.split(/\n|;/).map((part) => part.trim()).filter(Boolean);
}

function inferDesiredOutputType(value: string): ProjectBrief["desiredOutput"]["type"] {
  const normalized = value.toLowerCase();
  if (/\b(rank|ranked|shortlist)\b/.test(normalized)) return "ranked-shortlist";
  if (/\bdecision\s+(memo|brief)\b/.test(normalized)) return "decision-memo";
  if (/\b(research\s+brief|briefing)\b/.test(normalized)) return "research-brief";
  if (/\b(compare|comparison|versus|vs\.?)\b/.test(normalized)) return "comparison";
  if (/\b(option|ideas?|opportunities|directions|alternatives)\b/.test(normalized)) return "options";
  return "other";
}

function inferIdeaStyle(value: string | undefined): ProjectBrief["ideaStyle"] {
  const normalized = value?.toLowerCase() ?? "";
  if (/\b(safe|conservative|practical)\b/.test(normalized)) return "safe";
  if (/\b(bold|creative|weird|experimental|high-upside)\b/.test(normalized)) return "bold";
  return "balanced";
}

export async function generateBriefWithModel(
  client: StructuredModelClient,
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
    loadPrompt(
      "brief-agent",
      "Turn intake answers into a concise confirmed project brief. Use arrays for list fields.",
    ),
    transcript,
    ProjectBriefV2Schema,
    {
      type: "object",
      properties: {
        schemaVersion: { type: "number", const: 2 },
        title: { type: "string" },
        objective: { type: "string" },
        context: { type: "string" },
        decisionToSupport: { type: "string" },
        audience: { type: "array", items: { type: "string" } },
        desiredOutput: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["options", "ranked-shortlist", "decision-memo", "research-brief", "comparison", "other"],
            },
            notes: { type: "string" },
          },
          required: ["type", "notes"],
          additionalProperties: false,
        },
        successCriteria: { type: "array", items: { type: "string" } },
        hardConstraints: { type: "array", items: { type: "string" } },
        preferences: { type: "array", items: { type: "string" } },
        antiGoals: { type: "array", items: { type: "string" } },
        resources: { type: "array", items: { type: "string" } },
        deadline: { type: ["string", "null"] },
        availableEffort: { type: ["string", "null"] },
        evidenceRequirements: { type: "array", items: { type: "string" } },
        examplesToInspect: { type: "array", items: { type: "string" } },
        ideaStyle: { type: "string", enum: ["safe", "balanced", "bold"] },
        assumptions: { type: "array", items: { type: "string" } },
        openQuestions: { type: "array", items: { type: "string" } },
        contradictions: { type: "array", items: { type: "string" } },
      },
      required: [
        "schemaVersion", "title", "objective", "context", "decisionToSupport", "audience",
        "desiredOutput", "successCriteria", "hardConstraints", "preferences", "antiGoals",
        "resources", "deadline", "availableEffort", "evidenceRequirements", "examplesToInspect",
        "ideaStyle", "assumptions", "openQuestions", "contradictions",
      ],
      additionalProperties: false,
    },
  );
}

export async function generateBriefFromText(
  client: StructuredModelClient,
  model: string,
  text: string,
): Promise<BriefExtractionResponse> {
  const extracted = await client.structuredCompletion(
    model,
    loadPrompt(
      "brief-interpreter",
      [
        "Interpret the user's single starter prompt or pasted brief as a reviewable Scraply research brief.",
        "Preserve explicit user statements. Put model inferences only in assumptions and distinguish them from stated facts.",
        "Never invent hard constraints, deadlines, resources, anti-goals, or evidence requirements.",
        "Use null, empty arrays, missingFields, and openQuestions when important information is absent.",
        "Surface contradictions explicitly instead of choosing one side or silently reconciling them.",
        "Derive a concise title from the stated objective. Keep exploratory requests exploratory.",
        "Return the complete V2 brief plus missingFields, assumptions, and contradictions.",
      ].join("\n"),
    ),
    text.trim(),
    BriefExtractionResponseSchema,
    briefExtractionJsonSchema,
  );

  const missingFields = uniqueNonEmpty(extracted.missingFields);
  const assumptions = uniqueNonEmpty([...extracted.brief.assumptions, ...extracted.assumptions]);
  const contradictions = uniqueNonEmpty([...extracted.brief.contradictions, ...extracted.contradictions]);
  const openQuestions = uniqueNonEmpty([...extracted.brief.openQuestions, ...missingFields]);

  return BriefExtractionResponseSchema.parse({
    brief: {
      ...extracted.brief,
      assumptions,
      openQuestions,
      contradictions,
    },
    missingFields,
    assumptions,
    contradictions,
  });
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function newThreadTitle(goalAnswer?: string): string {
  if (!goalAnswer?.trim()) return "New research";
  return goalAnswer.trim().slice(0, 60);
}
