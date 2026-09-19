/* eslint-disable @typescript-eslint/no-require-imports */
// Deterministic workflow outputs for the JSONL child. Never invokes a provider.
const { stageOutputs } = require("./research-baseline/corpus.json");

module.exports = function workflowOutput(request) {
  const stageKey = request.workOrder.stage;
  if (stageKey.startsWith("focused-experiment:")) {
    if (stageKey.endsWith("review")) {
      return {
        schemaVersion: 1,
        verdict: "approved",
        isolatesAssumption: true,
        measuresBehavior: true,
        controlsComparison: true,
        outcomeRulesCoherent: true,
        rationale: "The fixture plan isolates one observable mechanism claim with exhaustive thresholds.",
        issues: [],
        correctionInstruction: null,
      };
    }
    const shortTest = request.evidence.find((item) => item.sourceId === "scraply:short-demand-test")?.content;
    const assumption = shortTest?.assumption ?? {
      id: "mechanism-delivery-estimates",
      category: "mechanism-value",
      testableClaim: "Using saved delivery records improves the next delivery estimate.",
      decisionImpact: "Failure means the record-based mechanism should not be built.",
      selectionReason: "The mechanism must improve estimates before adoption matters.",
    };
    return {
      schemaVersion: 1,
      assumption,
      shortDemandTestAssumptionId: request.workOrder.inputs.shortDemandTestAssumptionId ?? null,
      assumptionChangeReason: null,
      participantsAndCases: {
        eligibilityCriteria: ["Repair orders with a supplier estimate and recorded arrival"],
        caseSelection: "Use the next ten consecutive eligible repair orders.",
        exclusions: ["Orders missing a supplier estimate before arrival"],
        recruitmentMethod: "Invite every repair coordinator handling the consecutive orders.",
      },
      primaryMetric: {
        name: "arrivals within the quoted window",
        unit: "orders",
        numerator: null,
        denominator: null,
        collectionMethod: "Compare each saved estimate with the recorded arrival timestamp.",
        comparisonBaseline: "The coordinator's estimate made without saved delivery records.",
      },
      sample: {
        targetObservations: 10,
        recruitmentLimit: 15,
        observationWindow: { value: 3, unit: "weeks" },
        feasibilityRationale: "The fixture shop normally completes ten eligible orders in three weeks.",
      },
      outcomeRules: {
        kind: "numeric-threshold",
        direction: "higher-is-better",
        passThreshold: 8,
        failThreshold: 5,
        thresholdRationale: "Eight improved estimates justify a prototype; fewer than five stop it.",
        minimumUsableObservations: 10,
        insufficientDataReason: "Fewer than ten eligible orders cannot support the decision.",
        unusableObservationRule: "Exclude orders without both a prior estimate and an arrival timestamp.",
      },
      resources: {
        estimatedEffort: "One coordinator day across three weeks.",
        dependencies: ["Access to supplier estimates and arrival timestamps"],
        spendingLimit: { amount: 200, currency: "USD" },
      },
      paymentTerms: assumption.category === "payment"
        ? shortTest.paymentTerms
        : null,
      followOnDecision: {
        pass: "Prototype record-assisted estimation.",
        fail: "Stop the record-based mechanism.",
        inconclusive: "Collect the remaining consecutive eligible orders without changing thresholds.",
      },
    };
  }
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
      case "solutions": return { options: [stageOutputs.solutions.solutions[0], { mechanism: "Manual supplier check", description: "Call before quoting a delivery window.", respectsOffLimits: true, respectsOffLimitsWhy: "No inventory." }].flatMap((option, index) => process.env.SCRAPLY_RUNTIME_CHILD_MODE === "workflow-many" ? Array.from({ length: Math.ceil((request.workOrder.inputs.ideaCount - index) / 2) }, (_, copy) => ({ ...option, mechanism: `${option.mechanism} ${copy * 2 + index + 1}` })) : [option]).map((option, index) => ({
        ...option,
        keyAssumption: "Delivery records help the next estimate",
        whyCurrentApproachMaySuffice: "A call may already resolve most uncertainty",
        supportingEvidenceIds: request.evidence.filter((item) => item.content.categories?.includes("supporting")).map((item) => item.sourceId),
        contraryEvidenceIds: request.evidence.filter((item) => item.content.categories?.includes("contrary")).map((item) => item.sourceId),
        unknowns: ["Whether the saved time exceeds the recording effort"],
        ...(request.workOrder.inputs.focusedExperimentVersion === 1 ? {
          startupOpportunity: {
            opportunityType: "startup-opportunity",
            payingCustomerSegment: "Independent repair shops",
            trigger: "A delayed part makes a promised repair date unreliable.",
            existingSubstitute: "Call the supplier before quoting each delivery window.",
            gapAssessment: { kind: "hypothesis", description: "Shops may pay to avoid repeated supplier calls.", evidenceIds: [] },
            smallestSellableWorkflow: "Record a supplier estimate and show the next likely arrival window.",
            firstCustomerRoute: "Offer the workflow to the repair coordinator who handles incoming parts.",
            disconfirmingDemandTest: "Offer a paid manual pilot and record whether the coordinator pays a deposit.",
          },
          focusedDemandTest: {
            schemaVersion: 1,
            assumption: {
              id: `payment-pilot-${index + 1}`,
              category: "payment",
              testableClaim: "An independent repair shop will pay a deposit for a delivery-estimate pilot.",
              decisionImpact: "No paid commitment stops this startup opportunity.",
              selectionReason: "The smallest sellable workflow is already defined, so payment is the decisive unknown.",
            },
            methodSummary: "Offer the same manual pilot at the stated price to eligible repair coordinators.",
            disconfirmingObservation: "No eligible coordinator pays the deposit during the offer window.",
            paymentTerms: { amount: 100, currency: "USD", commitmentAction: "Pay a refundable pilot deposit." },
          },
        } : {}),
      })) };
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
