import { expect, test } from "bun:test";
import { evaluateSelectedOptionRisk, analyzeSelectedOption, type WorkflowV2DevelopmentContext } from "../../src/core/development";
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
  const analysis = { consequences: [], risks: [], proposedResponses: [], unknowns: [], experiment: { question: "Is state current?", method: "Check ten claims", cost: "One hour", passCriterion: "Ten agree", failCriterion: "Any stale" } };
  let calls = 0;
  const result = await analyzeSelectedOption(context, option, dependencies(analysis, () => { calls++; }), evaluation);
  expect(result.analysis.risks).toEqual(evaluation.risks);
  expect(result.analysis.unknowns).toEqual(evaluation.unknowns);
  expect(calls).toBe(1);
});

test("retains the historical call projection for saved v1 results", () => {
  expect(developmentProjection(3)).toBe(14);
  expect(developmentProjection(5)).toBe(22);
});
