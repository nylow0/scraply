import { expect, test } from "bun:test";
import { FocusedExperimentSchema, NewFocusedExperimentSchema, classifyNumericExperimentOutcome, numericOutcomeLabels, numericInconclusiveLabel } from "../../src/shared/focused-experiment";
import { renderFocusedExperiment } from "../../src/backend/opportunity-export";
import { savedPaymentDraft, validPaymentPlan, acceptanceReview } from "../fixtures/focused-acceptance";

test("the saved USD 400 draft remains readable but cannot be accepted as a new numeric plan", () => {
  expect(savedPaymentDraft.paymentTerms?.amount).toBe(400);
  expect(FocusedExperimentSchema.parse(savedPaymentDraft)).toEqual(savedPaymentDraft);
  expect(NewFocusedExperimentSchema.safeParse(savedPaymentDraft).success).toBe(false);
  const explicitRange = { ...savedPaymentDraft, outcomeRules: { ...savedPaymentDraft.outcomeRules, metricRange: { minimum: 0, maximum: 100 } } };
  expect(NewFocusedExperimentSchema.safeParse(explicitRange).success).toBe(false);
  if (savedPaymentDraft.outcomeRules.kind !== "numeric-threshold") throw new Error("Expected saved numeric rules");
  expect(classifyNumericExperimentOutcome(savedPaymentDraft.outcomeRules, { metricValue: 0, usableObservations: 5, hasUnusableData: false })).toBe("inconclusive");
});

test("valid numeric boundaries, insufficient observations, and invalid metric values agree with displayed rules", () => {
  const rules = validPaymentPlan().outcomeRules;
  if (rules.kind !== "numeric-threshold") throw new Error("Expected numeric rules");
  for (const [metricValue, expected] of [[0,"fail"],[0.99,"fail"],[1,"inconclusive"],[39.99,"inconclusive"],[40,"pass"],[100,"pass"],[-1,"inconclusive"],[101,"inconclusive"]] as const) {
    expect(classifyNumericExperimentOutcome(rules,{metricValue,usableObservations:5,hasUnusableData:false})).toBe(expected);
  }
  expect(classifyNumericExperimentOutcome(rules,{metricValue:0,usableObservations:4,hasUnusableData:false})).toBe("inconclusive");
  expect(classifyNumericExperimentOutcome(rules,{metricValue:40,usableObservations:5,hasUnusableData:true})).toBe("inconclusive");
  expect(numericOutcomeLabels(rules)).toEqual({pass:"at least 40",fail:"below 1",inconclusive:"1 to below 40"});
  const lower = {...rules,direction:"lower-is-better" as const,passThreshold:10,failThreshold:20};
  for(const [metricValue,expected] of [[0,"pass"],[10,"pass"],[10.1,"inconclusive"],[20,"inconclusive"],[20.1,"fail"],[100,"fail"]] as const) {
    expect(classifyNumericExperimentOutcome(lower,{metricValue,usableObservations:5,hasUnusableData:false})).toBe(expected);
  }
  expect(numericOutcomeLabels(lower)).toEqual({pass:"at most 10",fail:"above 20",inconclusive:"above 10 to 20"});
});

test("new numeric rules reject overlap, unreachable pass or fail, and contradictory ranges in both directions", () => {
  const plan=validPaymentPlan();
  for(const change of [
    {failThreshold:0}, {passThreshold:101}, {failThreshold:41},
    {metricRange:{minimum:100,maximum:0}},
    {direction:"lower-is-better",passThreshold:10,failThreshold:100},
    {direction:"lower-is-better",passThreshold:-1,failThreshold:20},
    {direction:"lower-is-better",passThreshold:21,failThreshold:20},
  ]) expect(NewFocusedExperimentSchema.safeParse({...plan,outcomeRules:{...plan.outcomeRules,...change}}).success).toBe(false);
});

test("equal thresholds have no numeric gap, and exports share the exact UI comparison contract",()=>{
  const plan=validPaymentPlan();
  if(plan.outcomeRules.kind!=="numeric-threshold") throw new Error("Expected numeric rules");
  const rules={...plan.outcomeRules,failThreshold:40};
  expect(NewFocusedExperimentSchema.safeParse({...plan,outcomeRules:rules}).success).toBe(true);
  expect(numericOutcomeLabels(rules).inconclusive).toBeNull();
  expect(numericInconclusiveLabel(rules,plan.primaryMetric.unit)).not.toContain("40 to below 40");
  expect(classifyNumericExperimentOutcome(rules,{metricValue:40,usableObservations:5,hasUnusableData:false})).toBe("pass");
  expect(classifyNumericExperimentOutcome(rules,{metricValue:39.9,usableObservations:5,hasUnusableData:false})).toBe("fail");
  const markdown=renderFocusedExperiment({schemaVersion:1,status:"approved",plan,initialReview:acceptanceReview("approved"),finalReview:null,correctionCount:0});
  expect(markdown).toContain("is below 1 percent of usable offers");
  expect(markdown).toContain(numericInconclusiveLabel(plan.outcomeRules,plan.primaryMetric.unit));
});
