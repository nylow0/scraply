/* eslint-disable @typescript-eslint/no-require-imports */
// Deterministic workflow outputs for the JSONL child. Never invokes a provider.
const { stageOutputs } = require("./research-baseline/corpus.json");

module.exports = function workflowOutput(request) {
  const stage = request.workOrder.stage.split(":")[0];
  if (stage === "research-title") return { title: "Reducing repair shop delays" };
  const data = request.evidence[0].content;
  const v2 = request.workOrder.inputs?.workflowVersion === 2;
  if (v2) {
    switch (stage) {
      case "risk-evaluation": return request.workOrder.inputs.reassessment
        ? { affectedRisks: [{ riskId: "sparse", effect: "weakened", rationale: "The follow-up found enough comparable deliveries" }], newRisks: [], additionalUnknowns: [] }
        : { risks: [{ riskId: "sparse", description: "Observed order volume stays too sparse", whyDecisive: "A small sample can mislead scheduling" }], unknowns: ["Whether this shop has enough repeat orders"] };
      case "query-plan": return { queries: [
        { query: "delivery windows", intent: "measured-behavior" },
        { query: "supplier reliability", intent: "current-alternative" },
        { query: "repair scheduling", intent: "firsthand-experience" },
      ].map(({ query, intent }) => ({ query, intent, uncertainty: "How often deliveries slip", intendedSourceType: "Operational records and customer reports" })) };
      case "factor-harvest": return { factors: data.sources.map((source) => ({ subject: "Repair shops", behavior: "record uncertain parts delivery windows", quote: source.text.split("\n")[0], sourceId: source.id, modelConfidence: 0.7, uncertainty: "This source may not represent other shops", sourceRole: "measured", audienceFit: "intended-buyer", independentSourceKey: new URL(source.url).hostname, supportsDemand: source.text.startsWith("Parts delivery windows are uncertain."), demandEvidenceUncertainty: "The synthetic report covers one repair shop" })) };
      case "problem-candidates": return { problems: data.factors.length ? [{ ...stageOutputs.problemCandidates.problems[0], factorIds: data.factors.map((factor) => factor.id), scaleBasisFactorId: null, alternativeExplanations: ["Delays may cluster around one supplier"], unknowns: ["Frequency across suppliers"], intendedBuyerEvidenceFactorIds: data.factors.filter((factor) => factor.supportsDemand).map((factor) => factor.id), evidenceGap: null }] : [] };
      case "problem-kill": return { verdict: "overstated", verdictReason: "The supplied vendor report disagrees with the customer complaints.", verdictSourceIds: data.sources.map((source) => source.id), unresolvedAssumptions: ["The complaints represent all suppliers"], wouldChangeConclusion: ["A representative delivery log"], intendedBuyerEvidenceFactorIds: data.supportingFactors.filter((factor) => factor.supportsDemand).map((factor) => factor.id), evidenceGap: null };
      case "solutions": return { options: [stageOutputs.solutions.solutions[0], { mechanism: "Manual supplier check", description: "Call before quoting a delivery window.", respectsOffLimits: true, respectsOffLimitsWhy: "No inventory." }].flatMap((option, index) => process.env.SCRAPLY_RUNTIME_CHILD_MODE === "workflow-many" ? Array.from({ length: Math.ceil((request.workOrder.inputs.ideaCount - index) / 2) }, (_, copy) => ({ ...option, mechanism: `${option.mechanism} ${copy * 2 + index + 1}` })) : [option]).map((option) => ({ ...option, keyAssumption: "Delivery records help the next estimate", whyCurrentApproachMaySuffice: "A call may already resolve most uncertainty", supportingEvidenceIds: request.evidence.filter((item) => item.content.categories?.includes("supporting")).map((item) => item.sourceId), contraryEvidenceIds: request.evidence.filter((item) => item.content.categories?.includes("contrary")).map((item) => item.sourceId), unknowns: ["Whether the saved time exceeds the recording effort"] })) };
      case "decision-analysis": {
        const consequences = [{ description: "Staff quote delivery windows from records", direction: "positive", affects: "Repair scheduling", rationale: "Recent deliveries can inform the next estimate" }];
        const proposedResponses = [{ riskIds: ["sparse"], approach: "Pilot with one supplier", cost: "One week of logging", failsIf: "The week contains no comparable deliveries" }];
        const experiment = { question: "Do records improve delivery estimates?", method: "Compare estimates with arrivals for ten deliveries", cost: "One week of logging", passCriterion: "At least eight arrive within the quoted window", failCriterion: "Fewer than eight arrive within the quoted window", inconclusiveCriterion: "Fewer than ten comparable deliveries are recorded" };
        if (request.outputSchema.required.includes("risks")) {
          return { consequences, risks: [{ riskId: "sparse", description: "Observed order volume stays too sparse", whyDecisive: "A small sample can mislead scheduling" }], proposedResponses, unknowns: ["Whether this shop has enough repeat orders"], experiment };
        }
        return { consequences, proposedResponses, additionalUnknowns: [], experiment };
      }
    }
  }
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
