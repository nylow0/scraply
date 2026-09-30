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
        metricRange: { minimum: 0, maximum: 10 },
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
  const inputs = request.workOrder.inputs.routing ?? request.workOrder.inputs;
  if (stage === "frame-search-plan") return { queries: [{ query: "repair shops parts delivery workflow reports",
    reason: "Find operational context for the delivery-estimation brief." }] };
  if (stage === "frame") {
    const scope = inputs.scope;
    return { frame: {
      version: 1, goal: `Reduce uncertain delivery estimates for ${scope.audience || "repair shops"}`,
      goalKind: "market-opportunity",
      contextFacts: request.evidence.slice(0, 2).map(source => ({ fact: source.content.text.split("\n")[0], sourceIds: [source.sourceId] })),
      successCriteria: [{ id: "observed-problem", name: "Observed recurring delivery problem", weight: "must",
        howJudged: "Independent accounts or measured records about affected repair shops.", basis: "brief" }],
      constraints: scope.offLimits.map(text => ({ text, kind: "scope", basis: "brief" })),
      languages: ["en"], exclusions: scope.offLimits,
      areas: inputs.knownProblem ? [] : [{ id: "parts-delivery", name: "Parts delivery estimates",
        whyRelevant: "A late part changes the promised repair date.", affectedPeople: scope.audience || "Repair shops",
        venues: [{ name: "Repair shop community", domain: "reddit.com", kind: "community" }], region: null,
        exampleProblems: ["Uncertain supplier delivery windows"], included: true, priority: 1 }],
      openQuestions: [{ id: "supplier-scope", question: "One supplier or several?", whyItMatters: "Changes the pilot's comparison.",
        options: ["One supplier", "Several suppliers"], answer: null }],
    } };
  }
  if (stage === "area-ranking") return { areas: inputs.frame.areas.filter(area => area.included).map((area, index) => ({
    areaId: area.id, rank: index + 1, reason: "The scan retained quote-verified operational observations for this workflow.",
    evidenceStrength: inputs.scans.find(scan => scan.areaId === area.id)?.qualifyingFacts ? "strong" : "weak", fit: "meets",
  })) };
  const data = request.evidence[0]?.content ?? {};
  if (stage === "evidence-check") {
    if (data.problem.verdict === "confirmed") return { decision: "confirmed", reason: "The saved verdict has independent relevant observations.", gaps: [] };
    if (data.problem.verdict !== "insufficient-evidence") return { decision: "drop", reason: "The contrary review did not retain this candidate.", gaps: [] };
    return { decision: "follow-up", reason: "The affected workflow needs another independent observation.",
      gaps: [{ kind: "second-independent-observation", evidenceNeeded: "An independent repair shop account of uncertain supplier arrival windows",
        query: "repair shop supplier arrival window firsthand account", route: "community" }] };
  }
  if (stage === "area-gap") return { reason: "The fixture area has no additional unsearched workflow or group.", gaps: [] };
  if (stage === "research-title") return { title: "Reducing repair shop delays" };
  if (stage === "solution-set-review") return { assessments: request.workOrder.inputs.candidateIds.map((candidateId) => ({
    candidateId, decision: "distinct", reason: "The fixture treats each proposed workflow as a distinct option.",
    matchingSolutionId: null, citedEvidenceIds: [],
    ...(inputs.frame ? { criteriaFit: criterionFit(inputs.frame) } : {}),
  })) };
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
      ].slice(0, inputs.queryCountIsGuidance === false ? inputs.queryCount : undefined)
        .map(({ query, intent }) => ({ query, intent, uncertainty: "How often deliveries slip", intendedSourceType: "Operational records and customer reports",
          ...(request.outputSchema.properties.queries.items.properties?.reason ? { reason: "Find quoted operational observations for this delivery question." } : {}),
        })) };
      case "factor-harvest": return { factors: data.sources.map((source) => ({ subject: "Repair shops", behavior: "record uncertain parts delivery windows", quote: source.text.split("\n")[0], sourceId: source.id, modelConfidence: 0.7, uncertainty: "This source may not represent other shops", sourceRole: "measured", audienceFit: process.env.SCRAPLY_RUNTIME_CHILD_MODE === "workflow-audience-many" ? "unknown" : "intended-buyer", independentSourceKey: new URL(source.url).hostname, supportsDemand: source.text.startsWith("Parts delivery windows are uncertain."), demandEvidenceUncertainty: "The synthetic report covers one repair shop" })) };
      case "problem-candidates": return { problems: data.factors.length ? [{ ...stageOutputs.problemCandidates.problems[0], factorIds: data.factors.map((factor) => factor.id), scaleBasisFactorId: null, alternativeExplanations: ["Delays may cluster around one supplier"], unknowns: ["Frequency across suppliers"], intendedBuyerEvidenceFactorIds: data.factors.filter((factor) => factor.supportsDemand).map((factor) => factor.id), evidenceGap: null }] : [] };
      case "problem-kill": {
        const reviewedAudience = request.workOrder.stage.endsWith(":audience-v1");
        // Fresh framed cases retain a problem only with two quote-checked buyer origins. Older adverse fixtures stay adverse.
        const framedConfirmation = Boolean(inputs.frame) && new Set(data.supportingFactors
          .filter(factor => factor.supportsDemand && factor.audienceFit === "intended-buyer"
            && factor.source.retrievedText.includes(factor.quote))
          .map(factor => new URL(factor.source.url).hostname)).size >= 2;
        const confirmed = reviewedAudience || framedConfirmation;
        return { verdict: confirmed ? "confirmed" : "overstated", verdictReason: reviewedAudience ? "Independent reports support the affected repair shops; on-time deliveries do not eliminate uncertain windows." : framedConfirmation ? "Two quote-checked buyer origins describe uncertain delivery windows; on-time arrivals do not resolve that uncertainty." : "The supplied vendor report disagrees with the customer complaints.", verdictSourceIds: data.sources.map((source) => source.id), unresolvedAssumptions: ["The complaints represent all suppliers"], wouldChangeConclusion: ["A representative delivery log"], intendedBuyerEvidenceFactorIds: data.supportingFactors.filter((factor) => reviewedAudience || factor.supportsDemand).map((factor) => factor.id), evidenceGap: null, briefFit: "direct", contraryEvidence: confirmed ? "resolved" : "unresolved", workflowKey: "repair shop: estimate part arrival for a repair",
          ...(reviewedAudience ? { factorAssessments: data.supportingFactors.map(factor => ({ factorId: factor.id, sourceRole: "measured", audienceFit: "intended-buyer", independentSourceKey: new URL(factor.source.url).hostname, reason: "The supplied report describes this affected shop workflow." })) } : {}) };
      }
      case "solutions": return { options: [stageOutputs.solutions.solutions[0], { mechanism: "Manual supplier check", description: "Call before quoting a delivery window.", respectsOffLimits: true, respectsOffLimitsWhy: "No inventory." }].flatMap((option, index) => process.env.SCRAPLY_RUNTIME_CHILD_MODE?.includes("many") ? Array.from({ length: Math.ceil((request.workOrder.inputs.ideaCount - index) / 2) }, (_, copy) => ({ ...option, mechanism: `${option.mechanism} ${copy * 2 + index + 1}` })) : [option]).map((option, index) => ({
        ...option,
        keyAssumption: "Delivery records help the next estimate",
        whyCurrentApproachMaySuffice: "A call may already resolve most uncertainty",
        supportingEvidenceIds: request.evidence.filter((item) => item.content.categories?.includes("supporting")).map((item) => item.sourceId),
        contraryEvidenceIds: request.evidence.filter((item) => item.content.categories?.includes("contrary")).map((item) => item.sourceId),
        unknowns: ["Whether the saved time exceeds the recording effort"],
        ...(inputs.frame ? goalFitFields(inputs.frame) : {}),
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

function criterionFit(frame) {
  return frame.successCriteria.map(criterion => ({ criterionId: criterion.id, criterionName: criterion.name,
    mustHave: criterion.weight === "must", status: "unknown", evidenceIds: [],
    note: "The supplied fixture evidence does not establish this criterion for the proposed mechanism." }));
}

function goalFitFields(frame) {
  const kind = { "market-opportunity": "demand-test", "competition-entry": "measurable-demo", "research-question": "validation-dataset",
    "community-or-personal": "pilot", "process-improvement": "process-test", other: "goal-test" }[frame.goalKind];
  return {
    biggerProblem: { statement: "Repair shops cannot reliably predict parts arrival times.", affected: "Repair shops",
      scale: "The prevalence beyond the supplied observations is unknown.", scaleEvidenceIds: [], scaleKnown: false },
    slice: { description: "Record delivery estimates and arrivals for one shop and one supplier.",
      connectionToBiggerProblem: "A narrow comparison tests whether saved delivery records improve the next estimate.",
      feasibilityWithinConstraints: "Use current records and a manual pilot without holding inventory." },
    criteriaFit: criterionFit(frame),
    firstTest: { kind, question: "Will affected repair coordinators use the record-assisted workflow?",
      method: "Offer the same manual pilot to ten eligible coordinators and record the declared outcome.", cost: "One coordinator day",
      metric: kind === "demand-test" ? "Paid pilot commitments" : "Estimates within the declared delivery window",
      sample: 10, observationWindow: "Three weeks",
      passCriterion: kind === "demand-test" ? "At least three coordinators pay for the pilot." : "At least eight estimates match the recorded arrivals.",
      failCriterion: kind === "demand-test" ? "No coordinator pays for the pilot." : "At most five estimates match the recorded arrivals.",
      inconclusiveCriterion: "The outcome falls between the thresholds, or fewer than ten usable observations are recorded." },
  };
}
