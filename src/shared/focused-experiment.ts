import { z } from "zod";

const RequiredTextSchema = z.string().trim().min(1);
const AssumptionIdSchema = z.string().trim().min(1).max(120).regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);

export const ExperimentAssumptionCategorySchema = z.enum([
  "pain",
  "substitute-inadequacy",
  "mechanism-value",
  "adoption",
  "payment",
]);

export const FocusedAssumptionSchema = z.object({
  id: AssumptionIdSchema,
  category: ExperimentAssumptionCategorySchema,
  testableClaim: RequiredTextSchema,
  decisionImpact: RequiredTextSchema,
  selectionReason: RequiredTextSchema,
}).strict();

export const FocusedDemandTestSchema = z.object({
  schemaVersion: z.literal(1),
  assumption: FocusedAssumptionSchema,
  methodSummary: RequiredTextSchema,
  disconfirmingObservation: RequiredTextSchema,
  paymentTerms: z.object({
    amount: z.number().positive().finite(),
    currency: z.string().trim().regex(/^[A-Z]{3}$/),
    commitmentAction: RequiredTextSchema,
  }).strict().nullable(),
}).strict();

const NumericOutcomeRulesSchema = z.object({
  kind: z.literal("numeric-threshold"),
  direction: z.enum(["higher-is-better", "lower-is-better"]),
  passThreshold: z.number().finite(),
  failThreshold: z.number().finite(),
  thresholdRationale: RequiredTextSchema,
  minimumUsableObservations: z.number().int().positive(),
  insufficientDataReason: RequiredTextSchema,
  unusableObservationRule: RequiredTextSchema,
}).strict();

const ReviewedTextOutcomeRulesSchema = z.object({
  kind: z.literal("reviewed-text"),
  passCriterion: RequiredTextSchema,
  failCriterion: RequiredTextSchema,
  inconclusiveCriterion: RequiredTextSchema,
  thresholdRationale: RequiredTextSchema,
  minimumUsableObservations: z.number().int().positive(),
  unusableObservationRule: RequiredTextSchema,
}).strict();

export const FocusedExperimentOutcomeRulesSchema = z.union([
  NumericOutcomeRulesSchema,
  ReviewedTextOutcomeRulesSchema,
]);

export const FocusedExperimentStructuredOutputSchema = z.object({
  schemaVersion: z.literal(1),
  assumption: FocusedAssumptionSchema,
  shortDemandTestAssumptionId: AssumptionIdSchema.nullable(),
  assumptionChangeReason: RequiredTextSchema.nullable(),
  participantsAndCases: z.object({
    eligibilityCriteria: z.array(RequiredTextSchema).min(1),
    caseSelection: RequiredTextSchema,
    exclusions: z.array(RequiredTextSchema),
    recruitmentMethod: RequiredTextSchema,
  }).strict(),
  primaryMetric: z.object({
    name: RequiredTextSchema,
    unit: RequiredTextSchema,
    numerator: RequiredTextSchema.nullable(),
    denominator: RequiredTextSchema.nullable(),
    collectionMethod: RequiredTextSchema,
    comparisonBaseline: RequiredTextSchema,
  }).strict(),
  sample: z.object({
    targetObservations: z.number().int().positive(),
    recruitmentLimit: z.number().int().positive(),
    observationWindow: z.object({
      value: z.number().positive().finite(),
      unit: z.enum(["hours", "days", "weeks"]),
    }).strict(),
    feasibilityRationale: RequiredTextSchema,
  }).strict(),
  outcomeRules: FocusedExperimentOutcomeRulesSchema,
  resources: z.object({
    estimatedEffort: RequiredTextSchema,
    dependencies: z.array(RequiredTextSchema),
    spendingLimit: z.object({
      amount: z.number().nonnegative().finite(),
      currency: z.string().trim().regex(/^[A-Z]{3}$/),
    }).strict(),
  }).strict(),
  paymentTerms: z.object({
    amount: z.number().positive().finite(),
    currency: z.string().trim().regex(/^[A-Z]{3}$/),
    commitmentAction: RequiredTextSchema,
  }).strict().nullable(),
  followOnDecision: z.object({
    pass: RequiredTextSchema,
    fail: RequiredTextSchema,
    inconclusive: RequiredTextSchema,
  }).strict(),
}).strict();

export const FocusedExperimentSchema = FocusedExperimentStructuredOutputSchema.superRefine((experiment, context) => {
  const changedAssumption = experiment.shortDemandTestAssumptionId !== null
    && experiment.shortDemandTestAssumptionId !== experiment.assumption.id;
  if (changedAssumption && experiment.assumptionChangeReason === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["assumptionChangeReason"],
      message: "Explain why the detailed experiment tests a different assumption",
    });
  }
  if (!changedAssumption && experiment.assumptionChangeReason !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["assumptionChangeReason"],
      message: "An assumption change reason is only valid when the assumption changed",
    });
  }
  if (experiment.assumption.category === "payment" && experiment.paymentTerms === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["paymentTerms"],
      message: "Payment experiments require a stated price and an actual commitment action",
    });
  }
  if (experiment.assumption.category !== "payment" && experiment.paymentTerms !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["paymentTerms"],
      message: "Payment terms would introduce a second assumption into this experiment",
    });
  }
  if (experiment.outcomeRules.minimumUsableObservations > experiment.sample.targetObservations) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["outcomeRules", "minimumUsableObservations"],
      message: "Minimum usable observations cannot exceed the target observation count",
    });
  }
  const rules = experiment.outcomeRules;
  if (rules.kind === "numeric-threshold") {
    const ordered = rules.direction === "higher-is-better"
      ? rules.failThreshold <= rules.passThreshold
      : rules.passThreshold <= rules.failThreshold;
    if (!ordered) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outcomeRules"],
        message: "Numeric pass and fail regions overlap",
      });
    }
  }
});

export const FocusedExperimentReviewStructuredOutputSchema = z.object({
  schemaVersion: z.literal(1),
  verdict: z.enum(["approved", "needs-revision", "uncertain"]),
  isolatesAssumption: z.boolean(),
  measuresBehavior: z.boolean(),
  controlsComparison: z.boolean(),
  outcomeRulesCoherent: z.boolean(),
  rationale: RequiredTextSchema,
  issues: z.array(RequiredTextSchema),
  correctionInstruction: RequiredTextSchema.nullable(),
}).strict();

export const FocusedExperimentReviewSchema = FocusedExperimentReviewStructuredOutputSchema.superRefine((review, context) => {
  const checksPass = review.isolatesAssumption
    && review.measuresBehavior
    && review.controlsComparison
    && review.outcomeRulesCoherent;
  if (review.verdict === "approved" && (!checksPass || review.issues.length > 0 || review.correctionInstruction !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "An approved review must pass every check without issues or a correction" });
  }
  if (review.verdict === "needs-revision" && review.correctionInstruction === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["correctionInstruction"], message: "A failed review requires one targeted correction" });
  }
  if (review.verdict === "uncertain" && review.correctionInstruction !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["correctionInstruction"], message: "An uncertain review cannot prescribe a correction as if it were known" });
  }
});

export const FocusedExperimentRecordSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.enum(["approved", "needs_revision"]),
  plan: FocusedExperimentSchema,
  initialReview: FocusedExperimentReviewSchema,
  finalReview: FocusedExperimentReviewSchema.nullable(),
  correctionCount: z.union([z.literal(0), z.literal(1)]),
}).strict();

export type FocusedAssumption = z.infer<typeof FocusedAssumptionSchema>;
export type FocusedDemandTest = z.infer<typeof FocusedDemandTestSchema>;
export type FocusedExperiment = z.infer<typeof FocusedExperimentSchema>;
export type FocusedExperimentOutcomeRules = z.infer<typeof FocusedExperimentOutcomeRulesSchema>;
export type FocusedExperimentReview = z.infer<typeof FocusedExperimentReviewSchema>;
export type FocusedExperimentRecord = z.infer<typeof FocusedExperimentRecordSchema>;

export interface NumericOutcomeClassificationInput {
  metricValue: number;
  usableObservations: number;
  hasUnusableData: boolean;
}

export function classifyNumericExperimentOutcome(
  rules: z.infer<typeof NumericOutcomeRulesSchema>,
  input: NumericOutcomeClassificationInput,
): "pass" | "fail" | "inconclusive" {
  if (!Number.isFinite(input.metricValue) || input.usableObservations < rules.minimumUsableObservations || input.hasUnusableData) {
    return "inconclusive";
  }
  if (rules.direction === "higher-is-better") {
    if (input.metricValue >= rules.passThreshold) return "pass";
    if (input.metricValue < rules.failThreshold) return "fail";
    return "inconclusive";
  }
  if (input.metricValue <= rules.passThreshold) return "pass";
  if (input.metricValue > rules.failThreshold) return "fail";
  return "inconclusive";
}

export function outcomeRulesNeedSemanticReview(rules: FocusedExperimentOutcomeRules): boolean {
  return rules.kind === "reviewed-text";
}

export function assertFocusedDemandTestSemantics(test: FocusedDemandTest): void {
  const isPaymentTest = test.assumption.category === "payment";
  if (isPaymentTest && test.paymentTerms === null) {
    throw new Error("A short payment test requires a stated price and actual commitment action");
  }
  if (!isPaymentTest && test.paymentTerms !== null) {
    throw new Error("Payment terms are only valid for a payment assumption");
  }
}
