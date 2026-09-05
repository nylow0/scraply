/* eslint-disable @typescript-eslint/no-require-imports */
// Deterministic v1 outputs for the JSONL child. This never invokes a provider or interprets source instructions.
const { stageOutputs } = require("./research-baseline/corpus.json");

module.exports = function workflowOutput(request) {
  const stage = request.workOrder.stage.split(":")[0];
  const data = request.evidence[0].content;
  switch (stage) {
    case "query-plan":
      return { queries: ["delivery windows", "supplier reliability", "repair scheduling"] };
    case "factor-harvest":
      return {
        factors: data.sources.map((source) => ({
          subject: "Repair shops",
          behavior: "record uncertain parts delivery windows",
          quote: source.text.split("\n")[0],
          sourceId: source.id,
          modelConfidence: 0.7,
        })),
      };
    case "problem-candidates":
      return { problems: data.factors.length ? [{
        ...stageOutputs.problemCandidates.problems[0],
        factorIds: data.factors.map((factor) => factor.id),
        scaleBasisFactorId: null,
      }] : [] };
    case "problem-kill":
      return {
        verdict: "overstated",
        verdictReason: "The supplied vendor report disagrees with the customer complaints.",
        verdictSourceIds: data.sources.map((source) => source.id),
      };
    case "solutions":
      return { solutions: [
        stageOutputs.solutions.solutions[0],
        { mechanism: "Manual supplier check", description: "Call before quoting a delivery window.", respectsOffLimits: true, respectsOffLimitsWhy: "No inventory." },
        { mechanism: "Customer scheduling buffer", description: "Reserve time after the part arrives.", respectsOffLimits: true, respectsOffLimitsWhy: "No inventory." },
      ] };
    case "outcomes":
      return { outcomes: [
        ...stageOutputs.outcomes.outcomes,
        { description: "Staff spend time checking records.", direction: "negative", affects: "Staff workload" },
        { description: "Customers receive clearer schedules.", direction: "positive", affects: "Customer planning" },
      ] };
    case "outcome-judge":
      return { judgments: data.outcomes.map((outcome, index) => ({ outcomeId: outcome.id, addressesCore: index % 2 === 0 })) };
    case "risks":
      return stageOutputs.risks;
    case "risk-score":
      return { scores: data.risks.map((risk, index) => ({
        riskId: risk.id, likelihood: "possible", impact: index === 0 ? "~2 weeks" : "project ends",
      })) };
    case "mitigations":
      return { mitigations: [{
        ...stageOutputs.mitigations.mitigations[0],
        riskIds: data.rankedRisks.map((risk) => risk.id),
      }] };
    default:
      throw new Error(`Unexpected workflow stage: ${stage}`);
  }
};
