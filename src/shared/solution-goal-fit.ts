import { z } from "zod";
import type { ResearchFrame, ResearchGoalKind } from "./research-frame";

const Text = z.string().trim().min(1).max(2_000);
export const CriterionFitSchema = z.object({
  criterionId: z.string().trim().min(1).max(120),
  criterionName: Text,
  mustHave: z.boolean(),
  status: z.enum(["meets", "partial", "fails", "unknown"]),
  evidenceIds: z.array(z.string().trim().min(1)).max(30),
  note: Text,
}).strict();
export const CriteriaFitSchema = z.array(CriterionFitSchema).max(20);
export const BiggerProblemSchema = z.object({
  statement: Text,
  affected: Text,
  scale: Text,
  scaleEvidenceIds: z.array(z.string().trim().min(1)).max(30),
  scaleKnown: z.boolean(),
}).strict();
export const SolutionSliceSchema = z.object({
  description: Text,
  connectionToBiggerProblem: Text,
  feasibilityWithinConstraints: Text,
}).strict();
export const FirstTestSchema = z.object({
  kind: z.enum(["demand-test", "measurable-demo", "validation-dataset", "pilot", "process-test", "goal-test"]),
  question: Text,
  method: Text,
  cost: Text,
  metric: Text,
  sample: z.number().int().positive().max(1_000_000),
  observationWindow: Text,
  passCriterion: Text,
  failCriterion: Text,
  inconclusiveCriterion: Text,
}).strict();
export const GoalFitFields = {
  biggerProblem: BiggerProblemSchema,
  slice: SolutionSliceSchema,
  criteriaFit: CriteriaFitSchema,
  firstTest: FirstTestSchema,
};
export type CriterionFit = z.infer<typeof CriterionFitSchema>;
export type FirstTest = z.infer<typeof FirstTestSchema>;
export type GoalFit = { [K in keyof typeof GoalFitFields]: z.infer<typeof GoalFitFields[K]> };

export const FIRST_TEST_KIND: Record<ResearchGoalKind, FirstTest["kind"]> = {
  "market-opportunity": "demand-test",
  "competition-entry": "measurable-demo",
  "research-question": "validation-dataset",
  "community-or-personal": "pilot",
  "process-improvement": "process-test",
  other: "goal-test",
};

/** Check criterion coverage and citations against the approved frame, never model confidence. */
export function assertCriteriaFit(
  fit: CriterionFit[],
  frame: ResearchFrame,
  evidenceSourceIds: readonly string[],
): void {
  const criteria = new Map(frame.successCriteria.map(criterion => [criterion.id, criterion]));
  const evidence = new Set(evidenceSourceIds);
  const seen = new Set<string>();
  if (fit.length !== criteria.size) throw new Error("Every frame criterion needs exactly one fit assessment");
  for (const entry of fit) {
    const criterion = criteria.get(entry.criterionId);
    if (!criterion || seen.has(entry.criterionId)) throw new Error("Unknown or repeated fit criterion ID");
    seen.add(entry.criterionId);
    if (entry.mustHave !== (criterion.weight === "must") || entry.criterionName !== criterion.name) {
      throw new Error("A fit assessment changed the approved criterion");
    }
    if (entry.evidenceIds.some(id => !evidence.has(id))) throw new Error("A fit assessment cited unknown evidence");
    if (entry.status !== "unknown" && entry.evidenceIds.length === 0) {
      throw new Error("A criterion verdict needs saved evidence; use unknown when it is not established");
    }
  }
}

export function assertGoalFit(option: GoalFit, frame: ResearchFrame, evidenceSourceIds: readonly string[]): void {
  assertCriteriaFit(option.criteriaFit, frame, evidenceSourceIds);
  const evidence = new Set(evidenceSourceIds);
  if (option.biggerProblem.scaleEvidenceIds.some(id => !evidence.has(id))) throw new Error("Problem scale cited unknown evidence");
  if (option.biggerProblem.scaleKnown && option.biggerProblem.scaleEvidenceIds.length === 0) {
    throw new Error("Known problem scale needs saved evidence");
  }
  if (option.firstTest.kind !== FIRST_TEST_KIND[frame.goalKind]) throw new Error("The first test does not match the approved goal kind");
}

/** Unknown and partial must-haves remain visible but do not enter this optional shortlist. */
export function meetsAllMustHaves(fit: CriterionFit[] | undefined): boolean {
  return fit !== undefined && fit.every(entry => !entry.mustHave || entry.status === "meets");
}

export function frameNeedsNoveltySearch(frame: ResearchFrame): boolean {
  return frame.successCriteria.some(criterion => /novel|differentiat|original|existing tools|новизн|оригінал|відмінн/i.test(`${criterion.name} ${criterion.howJudged}`));
}
