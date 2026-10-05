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

type RawRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is RawRecord => typeof value === "object" && value !== null && !Array.isArray(value);
const knownIds = (value: unknown, evidence: ReadonlySet<string>) => Array.isArray(value)
  ? [...new Set(value.filter((id): id is string => typeof id === "string").map(id => id.trim()).filter(id => evidence.has(id)))]
  : value;

/**
 * Raw model output in, repaired output out, before schema validation. The app owns criterion names,
 * must-have flags and the first-test kind, so it fills them from the frame instead of rejecting a copy slip.
 * A verdict or known scale without saved evidence becomes unknown, which keeps the confirmation rules strict
 * without discarding a whole batch. Shapes the schema would reject for other reasons pass through unchanged.
 */
export function normalizeCriteriaFit(value: unknown, frame: ResearchFrame, evidenceSourceIds: readonly string[]): unknown {
  if (!Array.isArray(value)) return value;
  const evidence = new Set(evidenceSourceIds);
  const byId = new Map<string, RawRecord>();
  for (const entry of value) {
    if (isRecord(entry) && typeof entry.criterionId === "string" && !byId.has(entry.criterionId.trim())) byId.set(entry.criterionId.trim(), entry);
  }
  return frame.successCriteria.map((criterion) => {
    const entry = byId.get(criterion.id);
    const evidenceIds = knownIds(entry?.evidenceIds ?? [], evidence);
    const claimed = entry?.status ?? "unknown";
    const unsupported = claimed !== "unknown" && Array.isArray(evidenceIds) && evidenceIds.length === 0;
    const note = typeof entry?.note === "string" && entry.note.trim() ? entry.note.trim() : "The model did not assess this criterion.";
    return {
      criterionId: criterion.id, criterionName: criterion.name, mustHave: criterion.weight === "must",
      status: unsupported ? "unknown" : claimed, evidenceIds,
      note: unsupported ? `${note} Marked unknown because no saved evidence was cited.`.slice(0, 2_000) : note,
    };
  });
}

/** See normalizeCriteriaFit. Applies to one generated or revised option. */
export function normalizeGoalFitInput(value: unknown, frame: ResearchFrame, evidenceSourceIds: readonly string[]): unknown {
  if (!isRecord(value)) return value;
  const evidence = new Set(evidenceSourceIds);
  const next: RawRecord = { ...value, criteriaFit: normalizeCriteriaFit(value.criteriaFit, frame, evidenceSourceIds) };
  if (isRecord(value.firstTest)) next.firstTest = { ...value.firstTest, kind: FIRST_TEST_KIND[frame.goalKind] };
  if (isRecord(value.biggerProblem)) {
    const scaleEvidenceIds = knownIds(value.biggerProblem.scaleEvidenceIds, evidence);
    const scaleKnown = value.biggerProblem.scaleKnown;
    next.biggerProblem = { ...value.biggerProblem, scaleEvidenceIds,
      scaleKnown: scaleKnown === true && Array.isArray(scaleEvidenceIds) ? scaleEvidenceIds.length > 0 : scaleKnown };
  }
  return next;
}

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
