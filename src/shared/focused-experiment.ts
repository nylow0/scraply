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

const MetricRangeSchema = z.object({
  minimum: z.number().finite().nullable(),
  maximum: z.number().finite().nullable(),
}).strict();

const NumericOutcomeRulesSchema = z.object({
  kind: z.literal("numeric-threshold"),
  direction: z.enum(["higher-is-better", "lower-is-better"]),
  passThreshold: z.number().finite(),
  failThreshold: z.number().finite(),
  // Absent on legacy records. Never infer bounds or reinterpret their thresholds.
  metricRange: MetricRangeSchema.optional(),
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

function validateExperiment(experiment: z.infer<typeof FocusedExperimentStructuredOutputSchema>, context: z.RefinementCtx): void {
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
    if (rules.metricRange) {
      const { minimum, maximum } = rules.metricRange;
      const invalidRange = minimum !== null && maximum !== null && minimum >= maximum;
      const passUnreachable = rules.direction === "higher-is-better"
        ? maximum !== null && rules.passThreshold > maximum
        : minimum !== null && rules.passThreshold < minimum;
      const failUnreachable = rules.direction === "higher-is-better"
        ? minimum !== null && rules.failThreshold <= minimum
        : maximum !== null && rules.failThreshold >= maximum;
      if (invalidRange || passUnreachable || failUnreachable) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["outcomeRules"], message: "Numeric rules must allow both pass and fail within the metric range" });
      }
    }
  }
}

// Storage remains backward compatible. Creation requires explicit bounds so a
// schema-valid legacy draft cannot become a newly accepted experiment unchecked.
export const FocusedExperimentSchema = FocusedExperimentStructuredOutputSchema.superRefine(validateExperiment);
export const NewFocusedExperimentStructuredOutputSchema = FocusedExperimentStructuredOutputSchema.extend({
  outcomeRules: z.union([
    NumericOutcomeRulesSchema.extend({ metricRange: MetricRangeSchema }),
    ReviewedTextOutcomeRulesSchema,
  ]),
});
export const NewFocusedExperimentSchema = NewFocusedExperimentStructuredOutputSchema.superRefine(validateExperiment);

export const NUMERIC_OUTCOME_CONTRACT = `Numeric rules use inclusive pass and strict fail comparisons. For higher-is-better: pass when value >= passThreshold, fail when value < failThreshold, otherwise inconclusive. For lower-is-better: pass when value <= passThreshold, fail when value > failThreshold, otherwise inconclusive. Equality at failThreshold is inconclusive unless it also reaches passThreshold. Too few usable observations or unusable data is always inconclusive. Declare metricRange in the same units as the metric: percentages have minimum 0 and maximum 100; proportions 0 and 1; counts and durations have minimum 0. Use null only for a genuinely unbounded endpoint. Both pass and fail must be reachable in that range. To make 0% fail under higher-is-better, use a positive failThreshold and describe that strict boundary exactly; failThreshold 0 cannot express this. The rationale must match every comparison, including exact thresholds. State thresholds as proposed decision policies, not established evidence.`;

export function numericOutcomeLabels(rules: z.infer<typeof NumericOutcomeRulesSchema>) {
  const noGap = rules.failThreshold === rules.passThreshold;
  return rules.direction === "higher-is-better"
    ? { pass: `at least ${rules.passThreshold}`, fail: `below ${rules.failThreshold}`, inconclusive: noGap ? null : `${rules.failThreshold} to below ${rules.passThreshold}` }
    : { pass: `at most ${rules.passThreshold}`, fail: `above ${rules.failThreshold}`, inconclusive: noGap ? null : `above ${rules.passThreshold} to ${rules.failThreshold}` };
}

export function numericInconclusiveLabel(rules: z.infer<typeof NumericOutcomeRulesSchema>, unit: string): string {
  const band = numericOutcomeLabels(rules).inconclusive;
  const observations = `fewer than ${rules.minimumUsableObservations} usable observations`;
  const outsideRange = rules.metricRange ? ", a value outside the declared metric range" : "";
  return `${band ? `${band} ${unit}, ${observations}` : `Fewer than ${rules.minimumUsableObservations} usable observations`}${outsideRange}, or data excluded by the unusable-observation rule.`;
}

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
  if (rules.metricRange && ((rules.metricRange.minimum !== null && input.metricValue < rules.metricRange.minimum)
    || (rules.metricRange.maximum !== null && input.metricValue > rules.metricRange.maximum))) return "inconclusive";
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
