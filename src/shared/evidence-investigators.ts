import { z } from "zod";
import type { DiscoveryDepth } from "./schemas";

const TextSchema = z.string().trim().min(1).max(1_000);
export const InvestigatorSearchRouteSchema = z.enum([
  "open-web", "community", "issue-tracker", "social", "studies-official", "alternatives", "contrary", "buying",
]);
export const EvidenceGapSchema = z.object({
  kind: z.enum(["second-independent-observation", "contrary-check", "scale", "alternative"]),
  evidenceNeeded: TextSchema,
  query: z.string().trim().min(1).max(500),
  route: InvestigatorSearchRouteSchema,
}).strict();
// Replay identity for completed historical checks only. New dispatches use the object-root schema below.
export const LegacyEvidenceCheckOutputSchema = z.union([
  z.object({ decision: z.literal("confirmed"), reason: TextSchema, gaps: z.array(EvidenceGapSchema).max(0) }).strict(),
  z.object({ decision: z.literal("drop"), reason: TextSchema, gaps: z.array(EvidenceGapSchema).max(0) }).strict(),
  z.object({ decision: z.literal("follow-up"), reason: TextSchema, gaps: z.array(EvidenceGapSchema).min(1).max(2) }).strict(),
]);
// Native strict structured output requires an object root. Keep conditional gap rules at the app boundary.
export const EvidenceCheckOutputSchema = z.object({
  decision: z.enum(["confirmed", "drop", "follow-up"]),
  reason: TextSchema,
  gaps: z.array(EvidenceGapSchema).max(2),
}).strict().superRefine((output, context) => {
  if (output.decision === "follow-up" ? output.gaps.length === 0 : output.gaps.length !== 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["gaps"], message: output.decision === "follow-up"
      ? "A follow-up requires one or two evidence gaps."
      : "Confirmed and drop decisions cannot contain evidence gaps." });
  }
});
export const AreaGapOutputSchema = z.object({
  reason: TextSchema,
  gaps: z.array(z.object({
    name: z.string().trim().min(1).max(200),
    evidenceNeeded: TextSchema,
    query: z.string().trim().min(1).max(500),
    route: InvestigatorSearchRouteSchema,
  }).strict()).max(3),
}).strict();
export const ResearchTargetSchema = z.object({
  confirmedProblems: z.number().int().min(1).max(100),
  minAreas: z.number().int().min(1).max(12),
}).strict().refine(target => target.minAreas <= target.confirmedProblems, {
  path: ["minAreas"], message: "The area target cannot exceed the confirmed problem target.",
});

export const EVIDENCE_INVESTIGATION_ROUNDS = { quick: 0, standard: 1, deep: 2 } as const;
export const RESEARCH_TARGETS = {
  quick: { confirmedProblems: 2, minAreas: 1 },
  standard: { confirmedProblems: 4, minAreas: 2 },
  deep: { confirmedProblems: 6, minAreas: 3 },
} as const satisfies Record<DiscoveryDepth, z.infer<typeof ResearchTargetSchema>>;

/** Includes the initial verdict, evidence checks, and both bounded searches per round. Repairs are disabled. */
export function candidateAssessmentProjection(depth: DiscoveryDepth) {
  const rounds = EVIDENCE_INVESTIGATION_ROUNDS[depth];
  return { modelCalls: 2 + rounds * 4, searches: 1 + rounds * 2 };
}

/** Targets count independent problems across areas. Missing targets remain an honest partial result. */
export function researchTargetProgress(target: ResearchTarget, problems: readonly {
  id: string; verdict: string; areaId?: string | null;
}[]) {
  const confirmed = new Map(problems.filter(problem => problem.verdict === "confirmed").map(problem => [problem.id, problem]));
  const areas = new Set([...confirmed.values()].map(problem => problem.areaId).filter((id): id is string => Boolean(id)));
  const met = confirmed.size >= target.confirmedProblems && areas.size >= target.minAreas;
  return { confirmedProblems: confirmed.size, areas: areas.size, outcome: met ? "target-met" as const : "partial" as const };
}

export type InvestigatorSearchRoute = z.infer<typeof InvestigatorSearchRouteSchema>;
export type EvidenceGap = z.infer<typeof EvidenceGapSchema>;
export type EvidenceCheckOutput = z.infer<typeof EvidenceCheckOutputSchema>;
export type AreaGapOutput = z.infer<typeof AreaGapOutputSchema>;
export type ResearchTarget = z.infer<typeof ResearchTargetSchema>;
