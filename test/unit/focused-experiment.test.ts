import { describe, expect, test } from "bun:test";
import { assertShortAssumptionIdentity } from "../../src/core/experiment-review";
import {
  FocusedExperimentSchema,
  assertFocusedDemandTestSemantics,
  classifyNumericExperimentOutcome,
  outcomeRulesNeedSemanticReview,
  type FocusedExperiment,
} from "../../src/shared/focused-experiment";

describe("focused experiment contract", () => {
  test("numeric rules partition pass, fail, inconclusive, insufficient, and unusable results", () => {
    const rules = numericPlan().outcomeRules;
    if (rules.kind !== "numeric-threshold") throw new Error("Expected numeric rules");

    expect(classifyNumericExperimentOutcome(rules, { metricValue: 8, usableObservations: 10, hasUnusableData: false })).toBe("pass");
    expect(classifyNumericExperimentOutcome(rules, { metricValue: 5, usableObservations: 10, hasUnusableData: false })).toBe("inconclusive");
    expect(classifyNumericExperimentOutcome(rules, { metricValue: 3.9, usableObservations: 10, hasUnusableData: false })).toBe("fail");
    expect(classifyNumericExperimentOutcome(rules, { metricValue: 9, usableObservations: 9, hasUnusableData: false })).toBe("inconclusive");
    expect(classifyNumericExperimentOutcome(rules, { metricValue: 9, usableObservations: 10, hasUnusableData: true })).toBe("inconclusive");
  });

  test("rejects overlapping numeric thresholds and impossible usable sample requirements", () => {
    const plan = numericPlan();
    const parsed = FocusedExperimentSchema.safeParse({
      ...plan,
      outcomeRules: { ...plan.outcomeRules, passThreshold: 4, failThreshold: 8, minimumUsableObservations: 11 },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.map((issue) => issue.message)).toContain("Numeric pass and fail regions overlap");
    expect(parsed.error.issues.map((issue) => issue.message)).toContain("Minimum usable observations cannot exceed the target observation count");
  });

  test("requires a reason when detailed analysis changes the short-test assumption", () => {
    const plan = numericPlan();
    expect(FocusedExperimentSchema.safeParse({
      ...plan,
      shortDemandTestAssumptionId: "pain-frequency",
      assumptionChangeReason: null,
    }).success).toBe(false);
    expect(FocusedExperimentSchema.safeParse({
      ...plan,
      shortDemandTestAssumptionId: "pain-frequency",
      assumptionChangeReason: "Existing evidence already established frequency, so mechanism value is now decisive.",
    }).success).toBe(true);
  });

  test("retains the exact short-test assumption identity instead of accepting null or an invented ID", () => {
    const shortTest = {
      schemaVersion: 1 as const,
      assumption: {
        id: "pain-frequency",
        category: "pain" as const,
        testableClaim: "Educators encounter exercise contradictions every month.",
        decisionImpact: "Rare contradictions would stop the opportunity.",
        selectionReason: "Problem frequency comes before mechanism value.",
      },
      methodSummary: "Review consecutive monthly revisions.",
      disconfirmingObservation: "No contradiction appears in the sampled revisions.",
      paymentTerms: null,
    };
    expect(() => assertShortAssumptionIdentity({ ...numericPlan(), shortDemandTestAssumptionId: null }, shortTest))
      .toThrow("must retain short demand-test assumption ID pain-frequency");
    expect(() => assertShortAssumptionIdentity({ ...numericPlan(), shortDemandTestAssumptionId: "invented-id", assumptionChangeReason: "Changed" }, shortTest))
      .toThrow("must retain short demand-test assumption ID pain-frequency");
    expect(() => assertShortAssumptionIdentity({ ...numericPlan(), shortDemandTestAssumptionId: "pain-frequency", assumptionChangeReason: "Mechanism value is now the remaining risk." }, shortTest))
      .not.toThrow();
  });

  test("short payment tests also require a concrete price and commitment", () => {
    const paymentTest = {
      schemaVersion: 1 as const,
      assumption: {
        id: "payment-pilot",
        category: "payment" as const,
        testableClaim: "Operators will pay for a manual pilot.",
        decisionImpact: "No commitment stops the build.",
        selectionReason: "Payment is the remaining unproven premise.",
      },
      methodSummary: "Offer a manual pilot to eligible operators.",
      disconfirmingObservation: "No operator makes the stated commitment.",
      paymentTerms: null,
    };
    expect(() => assertFocusedDemandTestSemantics(paymentTest)).toThrow("stated price and actual commitment");
    expect(() => assertFocusedDemandTestSemantics({
      ...paymentTest,
      paymentTerms: { amount: 250, currency: "USD", commitmentAction: "Pay a refundable deposit." },
    })).not.toThrow();
  });

  test("payment experiments require a price and actual commitment action", () => {
    const plan = numericPlan();
    const paymentPlan = {
      ...plan,
      assumption: { ...plan.assumption, category: "payment" as const },
      paymentTerms: null,
    };
    expect(FocusedExperimentSchema.safeParse(paymentPlan).success).toBe(false);
    expect(FocusedExperimentSchema.safeParse({
      ...paymentPlan,
      paymentTerms: { amount: 250, currency: "USD", commitmentAction: "Pay a refundable deposit for the pilot." },
    }).success).toBe(true);
    expect(FocusedExperimentSchema.safeParse({
      ...plan,
      paymentTerms: { amount: 250, currency: "USD", commitmentAction: "Pay a refundable deposit for the pilot." },
    }).success).toBe(false);
  });

  test("free-text outcome rules remain marked for semantic review", () => {
    expect(outcomeRulesNeedSemanticReview({
      kind: "reviewed-text",
      passCriterion: "The buyer signs the dated purchase commitment.",
      failCriterion: "The buyer refuses the same stated offer after the workflow demonstration.",
      inconclusiveCriterion: "The buyer cannot approve purchases during the observation window.",
      thresholdRationale: "The commitment is the behavior under test.",
      minimumUsableObservations: 1,
      unusableObservationRule: "Exclude buyers without purchase authority.",
    })).toBe(true);
  });
});

function numericPlan(): FocusedExperiment {
  return {
    schemaVersion: 1,
    assumption: {
      id: "mechanism-contradictions",
      category: "mechanism-value",
      testableClaim: "The checker finds confirmed exercise contradictions missed by the normal review.",
      decisionImpact: "Failure means the core checker is not worth building.",
      selectionReason: "The mechanism has to add signal before adoption or payment matters.",
    },
    shortDemandTestAssumptionId: "mechanism-contradictions",
    assumptionChangeReason: null,
    participantsAndCases: {
      eligibilityCriteria: ["Maintains published exercises with answer keys"],
      caseSelection: "Use the next ten consecutive exercise revisions.",
      exclusions: ["Revisions created only for this test"],
      recruitmentMethod: "Recruit educators from the full course-maintainer roster, regardless of reported error history.",
    },
    primaryMetric: {
      name: "additional confirmed contradictions",
      unit: "contradictions",
      numerator: null,
      denominator: null,
      collectionMethod: "An educator confirms each checker-only finding against the intended answer.",
      comparisonBaseline: "The same revision after the educator's normal review process.",
    },
    sample: {
      targetObservations: 10,
      recruitmentLimit: 15,
      observationWindow: { value: 3, unit: "weeks" },
      feasibilityRationale: "The roster normally produces at least ten revisions in three weeks.",
    },
    outcomeRules: {
      kind: "numeric-threshold",
      direction: "higher-is-better",
      passThreshold: 8,
      failThreshold: 4,
      thresholdRationale: "Eight additional findings justify a product prototype; fewer than four do not.",
      minimumUsableObservations: 10,
      insufficientDataReason: "Fewer than ten eligible revisions cannot support the chosen policy.",
      unusableObservationRule: "Treat a revision as unusable when the intended answer cannot be independently confirmed.",
    },
    resources: {
      estimatedEffort: "Three facilitator days across three weeks.",
      dependencies: ["Access to revision histories and intended answers"],
      spendingLimit: { amount: 500, currency: "USD" },
    },
    paymentTerms: null,
    followOnDecision: {
      pass: "Prototype automated checking on the same contradiction classes.",
      fail: "Stop this mechanism and revisit the problem evidence.",
      inconclusive: "Recruit the missing consecutive cases without changing the thresholds.",
    },
  };
}
