import { expect, test } from "bun:test";
import type { ResearchFrame, ResearchGoalKind } from "../../src/shared/research-frame";
import { FIRST_TEST_KIND, assertCriteriaFit, assertGoalFit, meetsAllMustHaves, type GoalFit } from "../../src/shared/solution-goal-fit";
import { classifySolutionSetReview, prepareSolutionSetReview } from "../../src/core/solution-set-review";
import { analyzeSelectedOption, evaluateSelectedOptionRisk, produceDevelopmentOptions, type WorkflowV2DevelopmentContext } from "../../src/core/development";
import { ensureSolutionNoveltyEvidence, type NoveltyEvidence, type NoveltySearchDependencies } from "../../src/core/solution-novelty";
import { parseWorkflowV2StageOutput } from "../../src/core/stages";
import { researchAnglesForGoal } from "../../src/shared/research-revisions";
import type { StructuredModelClient, StructuredStageRequest } from "../../src/providers/structured";
import { opportunityExpansionContract, parseOpportunityExpansionOutput } from "../../src/core/opportunity-expansion-contract";
import type { StartupOpportunityDetails } from "../../src/shared/structured-output-schemas";
import type { FocusedDemandTest } from "../../src/shared/focused-experiment";

const frame: ResearchFrame = {
  goal: "Build a regional ecology competition entry", goalKind: "competition-entry",
  contextFacts: [], successCriteria: [{ id: "scope", name: "Build in one month", weight: "must", howJudged: "Two students can build a demo", basis: "brief" },
    { id: "novelty", name: "Novelty", weight: "high", howJudged: "Compare with existing tools", basis: "brief" }],
  constraints: [{ text: "Two students, one month", kind: "team", basis: "brief" }],
  areas: [], exclusions: ["New equipment"], openQuestions: [], languages: ["en"],
};
const goalFit: GoalFit = {
  biggerProblem: { statement: "Regional food waste", affected: "Dorm residents", scale: "Unknown", scaleKnown: false, scaleEvidenceIds: [] },
  slice: { description: "Label a single shared fridge", connectionToBiggerProblem: "Test whether labels avoid waste", feasibilityWithinConstraints: "Two students in one month" },
  criteriaFit: frame.successCriteria.map(criterion => ({ criterionId: criterion.id, criterionName: criterion.name, mustHave: criterion.weight === "must", status: "unknown", evidenceIds: [], note: "Needs a measured demo" })),
  firstTest: { kind: "measurable-demo", question: "Do labels avoid waste?", method: "Weigh waste before and after", cost: "One week", metric: "Grams discarded", sample: 10, observationWindow: "Two weeks", passCriterion: "Waste falls at least 20%", failCriterion: "Waste does not fall", inconclusiveCriterion: "Fewer than ten observations" },
};
const plain = { mechanism: "Label the fridge", description: "Make leftovers visible", keyAssumption: "People read labels", whyCurrentApproachMaySuffice: "A note may suffice", supportingEvidenceIds: [], contraryEvidenceIds: [], unknowns: [], respectsOffLimits: true, respectsOffLimitsWhy: "No new equipment" };
const option = { ...plain, ...goalFit };

test("criterion coverage is exact, metadata cannot change, and claims need citable evidence", () => {
  expect(() => assertCriteriaFit(goalFit.criteriaFit, frame, [])).not.toThrow();
  expect(() => assertCriteriaFit(goalFit.criteriaFit.slice(1), frame, [])).toThrow("exactly one");
  expect(() => assertCriteriaFit([goalFit.criteriaFit[0]!, goalFit.criteriaFit[0]!], frame, [])).toThrow("repeated");
  expect(() => assertCriteriaFit([{ ...goalFit.criteriaFit[0]!, status: "meets", evidenceIds: ["generated"] }, goalFit.criteriaFit[1]!], frame, [])).toThrow("unknown evidence");
  expect(() => assertCriteriaFit([{ ...goalFit.criteriaFit[0]!, status: "meets" }, goalFit.criteriaFit[1]!], frame, [])).toThrow("saved evidence");
  expect(() => assertCriteriaFit([{ ...goalFit.criteriaFit[0]!, mustHave: false }, goalFit.criteriaFit[1]!], frame, [])).toThrow("changed");
  expect(meetsAllMustHaves(undefined)).toBe(false);
  expect(meetsAllMustHaves(goalFit.criteriaFit)).toBe(false);
  expect(meetsAllMustHaves([{ ...goalFit.criteriaFit[0]!, status: "meets" }, goalFit.criteriaFit[1]!])).toBe(true);
});

test("generation uses the approved goal rather than the legacy startup setting, for every goal kind", async () => {
  const context: WorkflowV2DevelopmentContext = {
    frame, scope: { title: "Ecology", audience: "Residents", domain: "Food waste", observations: "Waste repeats", offLimits: [] },
    problem: { id: "problem", statement: "Food expires", whyItPersists: "People forget leftovers", affected: "Residents", scaleEstimate: "Unknown", scaleBasisFactorId: null, factorIds: [], verdict: "user-asserted", verdictReason: "User report", verdictSourceIds: [] },
    supportingEvidence: [], contraryEvidence: [], priorFailedAttempts: [],
  };
  for (const [goalKind, kind] of Object.entries(FIRST_TEST_KIND)) {
    const selectedFrame = { ...frame, goalKind: goalKind as ResearchGoalKind };
    const candidate = { ...option, firstTest: { ...goalFit.firstTest, kind }, ...(goalKind === "market-opportunity" ? {
      startupOpportunity: { opportunityType: "startup-opportunity", payingCustomerSegment: "Residents", trigger: "Food expires", existingSubstitute: "Notes", gapAssessment: { kind: "hypothesis", description: "Notes may be forgotten", evidenceIds: [] }, smallestSellableWorkflow: "Label fridge", firstCustomerRoute: "Dorm pilot", disconfirmingDemandTest: "Residents decline paid labels" },
    } : {}) };
    const modelClient: StructuredModelClient = { async structuredCompletion<T>(request: StructuredStageRequest<T>) {
      expect(request.workOrder.inputs).toMatchObject({ frame: selectedFrame });
      return { output: { options: [candidate] } as T, metadata: { model: request.model, usage: { status: "unknown" }, latencyMs: 1, repairCount: 0, providerRequestIds: [], attempts: [] } };
    } };
    const result = await produceDevelopmentOptions({ ...context, frame: selectedFrame }, { modelClient, model: { providerId: "test", modelId: "test" }, reasoningEffort: "low", explorationPurpose: "startup-opportunities" });
    expect(result.schemaRevision).toBe(2);
    expect(result.options[0]?.biggerProblem).toEqual(goalFit.biggerProblem);
    expect(result.options[0]?.slice).toEqual(goalFit.slice);
    expect(result.options[0]?.criteriaFit).toEqual(goalFit.criteriaFit);
    expect(result.options[0]?.firstTest?.kind).toBe(kind);
    expect(Boolean(result.options[0]?.startupOpportunity)).toBe(goalKind === "market-opportunity");
  }
  expect(() => assertGoalFit({ ...goalFit, firstTest: { ...goalFit.firstTest, kind: "demand-test" } }, frame, [])).toThrow("goal kind");
});

test("independent review controls must-have acceptance while both assessments remain citable", () => {
  const candidates = [{ id: "idea", option }];
  const assessment = { candidateId: "idea", decision: "distinct", matchingSolutionId: null, reason: "A useful distinct mechanism", citedEvidenceIds: [], criteriaFit: goalFit.criteriaFit };
  expect(classifySolutionSetReview(candidates, [], [], { assessments: [assessment] }, { frame }).decisions[0]?.status).toBe("accepted");
  const failed = [{ ...goalFit.criteriaFit[0]!, status: "fails" as const, evidenceIds: ["source"] }, goalFit.criteriaFit[1]!];
  const meets = [{ ...goalFit.criteriaFit[0]!, status: "meets" as const, evidenceIds: ["source"] }, goalFit.criteriaFit[1]!];
  expect(classifySolutionSetReview(candidates, [], ["source"], { assessments: [{ ...assessment, criteriaFit: failed }] }, { frame }).decisions[0]?.status).toBe("rejected");
  expect(classifySolutionSetReview([{ id: "idea", option: { ...option, criteriaFit: failed } }], [], ["source"], { assessments: [assessment] }, { frame }).decisions[0]?.status).toBe("accepted");
  expect(classifySolutionSetReview([{ id: "idea", option: { ...option, criteriaFit: failed } }], [], ["source"], { assessments: [{ ...assessment, criteriaFit: meets }] }, { frame }).decisions[0]?.status).toBe("accepted");
  expect(classifySolutionSetReview([{ id: "idea", option: { ...option, criteriaFit: failed } }], [], [], { assessments: [{ ...assessment, criteriaFit: meets }] }, { frame }).decisions[0]?.status).toBe("unresolved");
  expect(classifySolutionSetReview([{ id: "idea", option: { ...option, criteriaFit: [] } }], [], ["source"], { assessments: [{ ...assessment, criteriaFit: meets }] }, { frame }).decisions[0]?.status).toBe("unresolved");
  expect(classifySolutionSetReview([{ id: "idea", option: { ...option, respectsOffLimits: false } }], [], ["source"], { assessments: [{ ...assessment, criteriaFit: meets }] }, { frame }).decisions[0]?.status).toBe("rejected");
  expect(classifySolutionSetReview(candidates, [], [], { assessments: [{ ...assessment, criteriaFit: [] }] }, { frame }).decisions[0]?.status).toBe("unresolved");
  expect(() => prepareSolutionSetReview({ candidates, existingSolutions: [], frame, problem: {}, projectConstraints: {}, evidence: [], savedInstructions: "", model: { providerId: "test", modelId: "test" }, reasoningEffort: "low" })).not.toThrow();
});

test("the review schema repairs copy slips and uncited verdicts instead of leaving the idea unresolved", () => {
  const candidates = [{ id: "idea", option }];
  const prepared = prepareSolutionSetReview({ candidates, existingSolutions: [], frame, problem: {}, projectConstraints: {},
    evidence: [{ sourceId: "source", content: "A dorm reported weekly waste." }], savedInstructions: "",
    model: { providerId: "test", modelId: "test" }, reasoningEffort: "low" });
  const output = prepared.request.schema.parse({ assessments: [{ candidateId: "idea", decision: "distinct", matchingSolutionId: null,
    reason: "Distinct", citedEvidenceIds: [], criteriaFit: [
      { criterionId: "scope", criterionName: "Buildable in a month", mustHave: false, status: "partial", evidenceIds: [], note: "Likely" },
      { criterionId: "novelty", criterionName: "Novelty", mustHave: false, status: "meets", evidenceIds: ["source", "invented"], note: "New" },
    ] }] });
  expect(output.assessments[0]!.criteriaFit).toEqual([
    { criterionId: "scope", criterionName: "Build in one month", mustHave: true, status: "unknown", evidenceIds: [],
      note: "Likely Marked unknown because no saved evidence was cited." },
    { criterionId: "novelty", criterionName: "Novelty", mustHave: false, status: "meets", evidenceIds: ["source"], note: "New" },
  ]);
  expect(classifySolutionSetReview(candidates, [], ["source"], output, { frame }).decisions[0]?.status).toBe("accepted");
});

test("risk and decision use frame constraints, and the decision preserves the selected first test", async () => {
  const context: WorkflowV2DevelopmentContext = {
    frame, scope: { title: "Ecology", audience: "Residents", domain: "Food waste", observations: "Waste repeats", offLimits: [] },
    problem: { id: "problem", statement: "Food expires", whyItPersists: "People forget leftovers", affected: "Residents", scaleEstimate: "Unknown", scaleBasisFactorId: null, factorIds: [], verdict: "user-asserted", verdictReason: "User report", verdictSourceIds: [] },
    supportingEvidence: [], contraryEvidence: [], priorFailedAttempts: [],
  };
  const selected = { ...option, id: "idea", problemId: "problem" };
  const modelClient: StructuredModelClient = { async structuredCompletion<T>(request: StructuredStageRequest<T>) {
    expect(request.workOrder.inputs).toMatchObject({ frame });
    expect(JSON.stringify(request.evidence)).toContain("Two students, one month");
    const output = request.stage === "risk-evaluation" ? { risks: [], unknowns: [] } : {
      consequences: [], proposedResponses: [], additionalUnknowns: [],
      experiment: { question: "An unrelated question", method: "Unrelated method", cost: "A year", passCriterion: "Vague", failCriterion: "Vague", inconclusiveCriterion: "Vague" },
    };
    return { output: output as T, metadata: { model: request.model, usage: { status: "unknown" }, latencyMs: 1, repairCount: 0, providerRequestIds: [], attempts: [] } };
  } };
  const dependencies = { modelClient, model: { providerId: "test", modelId: "test" }, reasoningEffort: "low" as const };
  const risk = await evaluateSelectedOptionRisk(context, selected, dependencies);
  const decision = await analyzeSelectedOption(context, selected, dependencies, risk.evaluation);
  expect(decision.analysis.experiment.question).toBe(goalFit.firstTest.question);
  expect(decision.analysis.experiment.method).toContain("Metric: Grams discarded. Sample: 10");
  expect(decision.analysis.experiment.passCriterion).toBe(goalFit.firstTest.passCriterion);
});

test("novelty reserves one bounded search and saves it before return; restarts reuse it", async () => {
  const completed = new Map<string, NoveltyEvidence>();
  const started = new Set<string>();
  let reservations = 0; let searches = 0;
  const dependencies: NoveltySearchDependencies = {
    loadCompleted: key => completed.get(key), wasStarted: key => started.has(key),
    reserveSearch: () => { reservations++; }, markStarted: key => { started.add(key); },
    search: async (_query, limit) => { searches++; expect(limit).toBe(5); return []; },
    saveCompleted: (key, _query, evidence) => { completed.set(key, evidence); },
  };
  await ensureSolutionNoveltyEvidence(frame, { id: "idea", option }, dependencies);
  expect(completed.has("solution-novelty:idea")).toBe(true);
  await ensureSolutionNoveltyEvidence(frame, { id: "idea", option }, { ...dependencies });
  expect(reservations).toBe(1); expect(searches).toBe(1);
  await expect(ensureSolutionNoveltyEvidence(frame, { id: "lost", option }, { ...dependencies, search: async () => { throw new Error("Completion lost"); } })).rejects.toThrow("Completion lost");
  await expect(ensureSolutionNoveltyEvidence(frame, { id: "lost", option }, dependencies)).rejects.toThrow("unknown");
  expect(reservations).toBe(2); expect(searches).toBe(1);
});

test("saved revision one outputs stay parseable and cannot acquire new goal fields", () => {
  expect(parseWorkflowV2StageOutput("solutions", 1, { options: [plain] })).toEqual({ options: [plain] });
  expect(() => parseWorkflowV2StageOutput("solutions", 1, { options: [option] })).toThrow();
  expect(parseWorkflowV2StageOutput("solutions", 2, { options: [option] })).toEqual({ options: [option] });
  expect(() => parseWorkflowV2StageOutput("solutions", 2, { options: [plain] })).toThrow();
  expect(researchAnglesForGoal("research-question").some(angle => angle.sourceClass === "buying-signal")).toBe(false);
  expect(researchAnglesForGoal("market-opportunity").some(angle => angle.sourceClass === "buying-signal")).toBe(true);
});

test("revision two review and conversation checkpoints require goal fit while legacy outputs remain readable", () => {
  const assessment = { candidateId: "idea", decision: "distinct", reason: "Fits the evidence", matchingSolutionId: null, citedEvidenceIds: [] };
  expect(parseWorkflowV2StageOutput("solution-set-review", 1, { assessments: [assessment] })).toEqual({ assessments: [assessment] });
  expect(() => parseWorkflowV2StageOutput("solution-set-review", 2, { assessments: [assessment] })).toThrow();
  const goalAssessment = { ...assessment, criteriaFit: goalFit.criteriaFit };
  expect(parseWorkflowV2StageOutput("solution-set-review", 2, { assessments: [goalAssessment] })).toEqual({ assessments: [goalAssessment] });
  expect(() => parseWorkflowV2StageOutput("solution-set-review", 1, { assessments: [goalAssessment] })).toThrow();
  const turn = { reply: "Try the narrow slice", citedEvidenceIds: [], assumptions: [], changeSummary: "Narrowed the pilot", candidate: plain };
  expect(parseWorkflowV2StageOutput("idea-follow-up", 1, turn)).toEqual(turn);
  expect(() => parseWorkflowV2StageOutput("idea-follow-up", 2, turn)).toThrow();
  expect(parseWorkflowV2StageOutput("idea-follow-up", 2, { ...turn, candidate: option })).toEqual({ ...turn, candidate: option });
});

test("opportunity expansion selects a framed startup contract and preserves unmarked legacy results", () => {
  const startupFrame = { ...frame, goalKind: "market-opportunity" as const };
  const startup = { opportunityType: "startup-opportunity", payingCustomerSegment: "Dorm residents", trigger: "Food expires", existingSubstitute: "Notes", gapAssessment: { kind: "hypothesis", description: "Notes may be forgotten", evidenceIds: [] }, smallestSellableWorkflow: "Label the fridge", firstCustomerRoute: "Dorm pilot", disconfirmingDemandTest: "Residents refuse a paid pilot" } satisfies StartupOpportunityDetails;
  const focusedDemandTest = { schemaVersion: 1, assumption: { id: "labels.adoption", category: "adoption", testableClaim: "Residents keep using labels", decisionImpact: "Stop if use falls", selectionReason: "Use is the main unknown" }, methodSummary: "Observe one fridge for a week", disconfirmingObservation: "Residents stop labeling", paymentTerms: null } satisfies FocusedDemandTest;
  const problemHypothesis = { statement: "Residents forget food", whyItPersists: "No labels", affected: "Dorm residents", scaleEstimate: "Unknown", evidenceIds: [], evidenceGap: "No independent measurements" };
  const legacy = { problemHypothesis, options: [{ ...plain, startupOpportunity: startup, focusedDemandTest }] };
  const framed = { problemHypothesis, options: [{ ...option, startupOpportunity: startup, focusedDemandTest, firstTest: { ...goalFit.firstTest, kind: "demand-test" as const } }] };
  expect(opportunityExpansionContract().schemaRevision).toBe(1);
  expect(parseOpportunityExpansionOutput(legacy)).toEqual(legacy);
  expect(() => parseOpportunityExpansionOutput(framed)).toThrow();
  expect(opportunityExpansionContract(startupFrame).schemaRevision).toBe(2);
  expect(parseOpportunityExpansionOutput(framed, { schemaRevision: 2, frame: startupFrame })).toEqual(framed);
  expect(() => opportunityExpansionContract(frame)).toThrow("ordinary idea generation");
  expect(() => parseOpportunityExpansionOutput(framed, { schemaRevision: 2 })).toThrow("saved frame");
});
