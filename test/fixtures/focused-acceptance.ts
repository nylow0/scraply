import saved from "./focused-acceptance.json";
import { FocusedExperimentSchema, NewFocusedExperimentSchema, type FocusedExperimentReview } from "../../src/shared/focused-experiment";

export const savedPaymentDraft = FocusedExperimentSchema.parse(saved.savedPaymentDraft);
export const combinedConditions = saved.combinedConditions;

/** Offline correction of the observed rule, not a new model result. */
export function validPaymentPlan() {
  return NewFocusedExperimentSchema.parse({
    ...savedPaymentDraft,
    outcomeRules: {
      ...savedPaymentDraft.outcomeRules,
      metricRange: { minimum: 0, maximum: 100 },
      failThreshold: 1,
      thresholdRationale: "With five usable offers: below 1% fails, 1% to below 40% is inconclusive, and at least 40% passes. These are proposed decision thresholds, not market evidence.",
    },
  });
}

export function combinedAssumptionPlan() {
  return NewFocusedExperimentSchema.parse({
    ...validPaymentPlan(),
    assumption: { ...savedPaymentDraft.assumption, testableClaim: combinedConditions.question },
    outcomeRules: {
      kind: "reviewed-text",
      passCriterion: combinedConditions.passCriterion,
      failCriterion: combinedConditions.failCriterion,
      inconclusiveCriterion: combinedConditions.inconclusiveCriterion,
      thresholdRationale: "Saved negative example combines adoption, reliability, and payment.",
      minimumUsableObservations: 1,
      unusableObservationRule: "Exclude releases without inspectable evidence.",
    },
  });
}

export function acceptanceReview(verdict: FocusedExperimentReview["verdict"]): FocusedExperimentReview {
  const approved = verdict === "approved";
  return {
    schemaVersion: 1, verdict, isolatesAssumption: approved, measuresBehavior: true,
    controlsComparison: true, outcomeRulesCoherent: true,
    rationale: approved ? "Payment is the only success condition. Eligibility, delivered offers and cleared payments are measurement validity checks; usage and reliability do not gate success."
      : "Teammate use tests adoption; maintained entries and correct reconciliation test participation and reliability; paid continuation tests payment. Failure would not isolate one premise.",
    issues: approved ? [] : ["The mandatory conditions test several independent assumptions."],
    correctionInstruction: verdict === "needs-revision" ? "Keep one payment test; test adoption and reliability separately." : null,
  };
}
