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
  expect(calls).toBe(1);
});

test("reassesses only against follow-up evidence and keeps authoritative risk records exact", async () => {
  const followUp = [{ sourceId: "follow-up-factor", content: { quote: "Exports refresh each minute" } }];
  const riskResult = await reassessSelectedOptionRisk(context, option, evaluation, followUp, dependencies({
    affectedRisks: [{ riskId: "stale", effect: "weakened", rationale: "The refresh is bounded" }],
    newRisks: [{ riskId: "permissions", description: "Operators cannot read exports", whyDecisive: "The check cannot run" }],
    additionalUnknowns: ["Export permissions"],
  }, evidence => {
    const serialized = JSON.stringify(evidence);
    expect(serialized).toContain("follow-up-factor");
    expect(serialized).toContain("scraply:original-risk-evaluation");
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
  }));
  expect(result.analysis.risks).toEqual([...evaluation.risks, ...riskResult.reassessment.newRisks]);
  expect(result.analysis.risks[0]).toEqual(evaluation.risks[0]);
});

test("retains the historical call projection for saved v1 results", () => {
  expect(developmentProjection(3)).toBe(14);
  expect(developmentProjection(5)).toBe(22);
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
  const { id: _id, problemId: _problemId, ...plainOption } = option;
  void _id;
  void _problemId;
  const startupContext = {
    ...context,
    priorProjectMechanisms: [{ mechanism: "Shared-state reminder", problemStatement: "Claims are filed twice" }],
  };
  const result = await produceDevelopmentOptions(startupContext, {
    ...dependencies({ options: [{ ...plainOption, startupOpportunity: startup }] }),
    explorationPurpose: "startup-opportunities",
    ideaCount: 1,
  });
  expect(result.options[0]?.startupOpportunity).toEqual(startup);
  const requestInputs = result.request.workOrder.inputs as { explorationPurpose: string; evidenceSourceIds: string[] };
  expect(requestInputs).toMatchObject({ explorationPurpose: "startup-opportunities" });
  expect(JSON.stringify(result.request.evidence[0]?.content)).toContain("Shared-state reminder");
  expect(requestInputs.evidenceSourceIds).toEqual([]);

  await expect(produceDevelopmentOptions(startupContext, {
    ...dependencies({ options: [plainOption] }), explorationPurpose: "startup-opportunities", ideaCount: 1,
  })).rejects.toMatchObject({ code: "schema" });
});
