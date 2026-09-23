import { expect, test } from "bun:test";
import { evaluateSelectedOptionRisk, analyzeSelectedOption, produceDevelopmentOptions, reassessSelectedOption, reassessSelectedOptionRisk, type WorkflowV2DevelopmentContext } from "../../src/core/development";
import type { StructuredModelClient } from "../../src/providers/structured";
import { developmentProjection } from "../../src/shared/development-projection";

const context: WorkflowV2DevelopmentContext = {
  scope: { title: "Claims", audience: "Operators", domain: "Claims", observations: "Claims repeat", offLimits: ["No lending"], riskEvaluationCriteria: "Avoid losing a week of filing" },
  problem: { id: "problem", statement: "Claims are filed twice", whyItPersists: "State is split", affected: "Operators", scaleEstimate: "Weekly", scaleBasisFactorId: null, factorIds: [], verdict: "overstated", verdictReason: "Existing tools already help", verdictSourceIds: [] },
  supportingEvidence: [], contraryEvidence: [], priorFailedAttempts: [],
};
const option = { id: "option", problemId: "problem", mechanism: "Read shared state", description: "Check before filing", keyAssumption: "State is current", whyCurrentApproachMaySuffice: "The existing tool may already work", supportingEvidenceIds: [], contraryEvidenceIds: [], unknowns: ["Freshness"], respectsOffLimits: true, respectsOffLimitsWhy: "No lending" };
const evaluation = { risks: [{ riskId: "stale", description: "State stays stale", whyDecisive: "Claims still repeat" }], unknowns: ["Refresh interval"] };

function dependencies(output: unknown, inspect: (evidence: unknown) => void = () => {}) {
  const modelClient: StructuredModelClient = { async structuredCompletion<T>(request: import("../../src/providers/structured").StructuredStageRequest<T>) {
    inspect(request.evidence);
    return { output: output as T, metadata: {
      model: request.model, usage: { status: "unknown" }, latencyMs: 1, repairCount: 0, providerRequestIds: [], attempts: [],
    } };
  } };
  return { modelClient, model: { providerId: "test", modelId: "test" }, reasoningEffort: "low" as const };
}

test("evaluates the full selected mechanism, original premise and user risk criteria", async () => {
  const result = await evaluateSelectedOptionRisk(context, option, dependencies(evaluation, evidence => {
    const text = JSON.stringify(evidence);
    expect(text).toContain(context.problem.verdictReason);
    expect(text).toContain(context.scope.riskEvaluationCriteria!);
    expect(text).toContain(option.description);
  }));
  expect(result.evaluation).toEqual(evaluation);
});

test("rejects duplicate risk identities without an app-owned retry", async () => {
  let calls = 0;
  await expect(evaluateSelectedOptionRisk(context, option, dependencies({ ...evaluation, risks: [evaluation.risks[0], evaluation.risks[0]] }, () => { calls++; })))
    .rejects.toMatchObject({ code: "schema" });
  expect(calls).toBe(1);
});

test("retains independently evaluated risks and unknowns when analysis omits them", async () => {
  const analysis = { consequences: [], proposedResponses: [], additionalUnknowns: ["Operator access"], experiment: { question: "Is state current?", method: "Check ten claims", cost: "One hour", passCriterion: "Ten agree", failCriterion: "Any stale", inconclusiveCriterion: "The sample cannot be retrieved" } };
  let calls = 0;
  const result = await analyzeSelectedOption(context, option, dependencies(analysis, evidence => {
    calls++;
    expect(JSON.stringify(evidence)).toContain("scraply:risk-evaluation");
  }), evaluation);
  expect(result.analysis.risks).toEqual(evaluation.risks);
  expect(result.analysis.unknowns).toEqual([...evaluation.unknowns, "Operator access"]);
  expect(result.request.jsonSchema).not.toHaveProperty("properties.risks");
  expect(result.request.jsonSchema).not.toHaveProperty("properties.unknowns");
  expect(result.request.deadlineMs).toBe(300_000);
  expect(calls).toBe(1);
});

test("reassesses only against follow-up evidence and keeps authoritative risk records exact", async () => {
  const beyondLimit = "UNBOUNDED-FOLLOW-UP-MARKER";
  const followUp = [{ sourceId: "follow-up-factor", content: { quote: `${"x".repeat(30_000)}${beyondLimit}` } }];
  const riskResult = await reassessSelectedOptionRisk(context, option, evaluation, followUp, dependencies({
    affectedRisks: [{ riskId: "stale", effect: "weakened", rationale: "The refresh is bounded" }],
    newRisks: [{ riskId: "permissions", description: "Operators cannot read exports", whyDecisive: "The check cannot run" }],
    additionalUnknowns: ["Export permissions"],
  }, evidence => {
    const serialized = JSON.stringify(evidence);
    expect(serialized).toContain("follow-up-factor");
    expect(serialized).toContain("scraply:original-risk-evaluation");
    expect(serialized).not.toContain(beyondLimit);
  }));
  const draft = { consequences: [], proposedResponses: [], additionalUnknowns: [], experiment: {
    question: "Can operators read current state?", method: "Check ten claims", cost: "One hour",
    passCriterion: "Ten are current", failCriterion: "Two are stale", inconclusiveCriterion: "Permissions prevent inspection",
  } };
  const result = await reassessSelectedOption(context, option, {
    consequences: [], risks: evaluation.risks, proposedResponses: [], unknowns: evaluation.unknowns,
    experiment: { ...draft.experiment },
  }, evaluation, riskResult.reassessment, followUp, dependencies(draft, evidence => {
    const serialized = JSON.stringify(evidence);
    expect(serialized).toContain("scraply:original-decision-analysis");
    expect(serialized).toContain("follow-up-factor");
    expect(serialized).not.toContain(beyondLimit);
  }));
  expect(result.analysis.risks).toEqual([...evaluation.risks, ...riskResult.reassessment.newRisks]);
  expect(result.analysis.risks[0]).toEqual(evaluation.risks[0]);
});

test("retains the historical call projection for saved v1 results", () => {
  expect(developmentProjection(3)).toBe(14);
  expect(developmentProjection(5)).toBe(22);
});

test("rejects extra provider candidates before returning anything for persistence", async () => {
  const { id: _id, problemId: _problemId, ...plainOption } = option;
  void _id;
  void _problemId;
  let calls = 0;
  await expect(produceDevelopmentOptions(context, {
    ...dependencies({ options: [plainOption, { ...plainOption, mechanism: "Check the claim archive" }] }, () => { calls++; }),
    ideaCount: 1,
  })).rejects.toMatchObject({ code: "schema", message: "The solutions stage returned more than 1 options" });
  expect(calls).toBe(1);
});

test("sends a saved buyer and workflow angle in the solutions model work order", async () => {
  const { id: _id, problemId: _problemId, ...plainOption } = option;
  void _id;
  void _problemId;
  const generationAngle = {
    gapId: "gap-repeat-claims", name: "Independent adjusters",
    angle: "Find a distinct paid workflow for adjusters who reconcile duplicate claims after a handoff.",
  };
  const base = dependencies({ options: [plainOption] });
  let calls = 0;
  const modelClient: StructuredModelClient = {
    async structuredCompletion<T>(request: import("../../src/providers/structured").StructuredStageRequest<T>) {
      calls++;
      expect(request.workOrder.inputs).toMatchObject({ generationAngle });
      expect(request.workOrder.goal).toContain(generationAngle.angle);
      expect(request.workOrder.constraints).toContain(
        "Treat the generation angle as task direction, not evidence. Respect the saved evidence and off-limits list; return no candidate if the gap cannot be addressed honestly.",
      );
      return base.modelClient.structuredCompletion(request);
    },
  };
  await produceDevelopmentOptions(context, { ...base, modelClient, ideaCount: 1, generationAngle });
  expect(calls).toBe(1);

  const ordinary = await produceDevelopmentOptions(context, { ...base, ideaCount: 1 });
  expect(ordinary.request.workOrder.inputs).not.toHaveProperty("generationAngle");
  expect(ordinary.request.workOrder.goal).toBe("Produce up to 1 distinct, useful, unranked ideas for the selected problem.");
});

test("requires startup details and passes prior project mechanisms without making them evidence", async () => {
  const startup = {
    opportunityType: "startup-opportunity" as const,
    payingCustomerSegment: "Independent claims operators",
    trigger: "A duplicate filing is discovered",
    existingSubstitute: "Check the shared claims tool manually",
    gapAssessment: { kind: "hypothesis" as const, description: "Manual checks may be skipped under time pressure", evidenceIds: [] },
    smallestSellableWorkflow: "Detect and block a duplicate filing",
    firstCustomerRoute: "Interview operators in two claims communities",
    disconfirmingDemandTest: "Reject demand if ten operators decline a manual paid pilot",
  };
  const focusedDemandTest = {
    schemaVersion: 1 as const,
    assumption: {
      id: "payment-paid-pilot",
      category: "payment" as const,
      testableClaim: "Operators will pay for a manual duplicate-filing check before automation exists.",
      decisionImpact: "No paid commitment would stop the opportunity before building the workflow.",
      selectionReason: "The existing tool may already solve the problem, so actual payment is the decisive gap.",
    },
    methodSummary: "Offer the same manual pilot at a stated price to ten eligible operators.",
    disconfirmingObservation: "None of the ten operators pays a deposit or signs a purchase commitment.",
    paymentTerms: { amount: 250, currency: "USD", commitmentAction: "Pay a refundable deposit for the pilot." },
  };
  const { id: _id, problemId: _problemId, ...plainOption } = option;
  void _id;
  void _problemId;
  const startupContext = {
    ...context,
    priorProjectMechanisms: [{ mechanism: "Shared-state reminder", problemStatement: "Claims are filed twice" }],
    priorProjectMechanismsOmittedCount: 7,
  };
  const result = await produceDevelopmentOptions(startupContext, {
    ...dependencies({ options: [{ ...plainOption, startupOpportunity: startup, focusedDemandTest }] }),
    explorationPurpose: "startup-opportunities",
    focusedExperiments: true,
    ideaCount: 1,
  });
  expect(result.options[0]?.startupOpportunity).toEqual(startup);
  expect(result.options[0]?.focusedDemandTest).toEqual(focusedDemandTest);
  const requestInputs = result.request.workOrder.inputs as { explorationPurpose: string; evidenceSourceIds: string[] };
  expect(requestInputs).toMatchObject({ explorationPurpose: "startup-opportunities" });
  expect(JSON.stringify(result.request.evidence[0]?.content)).toContain("Shared-state reminder");
  expect(result.request.evidence[0]?.content).toMatchObject({ priorProjectMechanismsOmittedCount: 7 });
  expect(requestInputs.evidenceSourceIds).toEqual([]);

  await expect(produceDevelopmentOptions(startupContext, {
    ...dependencies({ options: [{ ...plainOption, startupOpportunity: startup }] }), explorationPurpose: "startup-opportunities", focusedExperiments: true, ideaCount: 1,
  })).rejects.toMatchObject({ code: "schema" });

  const legacy = await produceDevelopmentOptions(startupContext, {
    ...dependencies({ options: [{ ...plainOption, startupOpportunity: startup }] }),
    explorationPurpose: "startup-opportunities",
    ideaCount: 1,
  });
  expect(legacy.options[0]?.focusedDemandTest).toBeUndefined();
  expect(legacy.request.workOrder.inputs).not.toHaveProperty("focusedExperimentVersion");
});

test("automatic intent accepts practical and sellable ideas from the same brief without inventing a business", async () => {
  const { id: _id, problemId: _problemId, ...plainOption } = option;
  void _id;
  void _problemId;
  const startupOpportunity = {
    opportunityType: "startup-opportunity" as const,
    payingCustomerSegment: "Independent repair shops",
    trigger: "A late part delays a promised repair",
    existingSubstitute: "Call suppliers for updates",
    gapAssessment: { kind: "hypothesis" as const, description: "Calls may miss changes between check-ins", evidenceIds: [] },
    smallestSellableWorkflow: "Track delivery changes and alert the shop",
    firstCustomerRoute: "Pilot with two local repair shops",
    disconfirmingDemandTest: "Neither shop agrees to pay for a manual alert pilot",
  };
  const brief = { ...context, scope: { ...context.scope,
    title: "Improve repair operations and explore a sellable supplier alert service" } };
  const result = await produceDevelopmentOptions(brief, {
    ...dependencies({ options: [plainOption, { ...plainOption, mechanism: "Supplier alert service", startupOpportunity }] }),
    explorationPurpose: "auto", ideaCount: 2,
  });
  expect(result.options).toHaveLength(2);
  expect(result.options[0]?.startupOpportunity).toBeUndefined();
  expect(result.options[1]?.startupOpportunity).toEqual(startupOpportunity);
  expect(result.request.workOrder.inputs).toMatchObject({ explorationPurpose: "auto" });
  expect(result.request.workOrder.requiredDecisions?.join(" ")).toContain("user's original scope");
  expect(JSON.stringify(result.request.evidence[0]?.content)).toContain(brief.scope.title);
  expect(JSON.stringify(result.request.jsonSchema)).toContain('"anyOf"');

  const focusedDemandTest = {
    schemaVersion: 1 as const,
    assumption: {
      id: "repair-shop-pain", category: "pain" as const,
      testableClaim: "Late parts force shops to revise repair promises.",
      decisionImpact: "Without this pain the alert service should not be built.",
      selectionReason: "The original problem may already be solved by supplier calls.",
    },
    methodSummary: "Interview five shops about their most recent late delivery.",
    disconfirmingObservation: "No shop reports a missed or changed promise.",
    paymentTerms: null,
  };
  const focused = await produceDevelopmentOptions(brief, {
    ...dependencies({ options: [plainOption, { ...plainOption, mechanism: "Supplier alert service",
      startupOpportunity, focusedDemandTest }] }),
    explorationPurpose: "auto", focusedExperiments: true, ideaCount: 2,
  });
  expect(focused.options[0]?.focusedDemandTest).toBeUndefined();
  expect(focused.options[1]?.focusedDemandTest).toEqual(focusedDemandTest);
  expect(focused.request.workOrder.inputs).toMatchObject({ focusedExperimentVersion: 1 });
  await expect(produceDevelopmentOptions(brief, {
    ...dependencies({ options: [{ ...plainOption, startupOpportunity }] }),
    explorationPurpose: "auto", focusedExperiments: true, ideaCount: 1,
  })).rejects.toMatchObject({ code: "schema" });

  await expect(produceDevelopmentOptions(brief, {
    ...dependencies({ options: [{ ...plainOption, startupOpportunity: { ...startupOpportunity,
      opportunityType: "process-improvement" } }] }),
    explorationPurpose: "auto", ideaCount: 1,
  })).rejects.toMatchObject({ code: "schema" });
});
