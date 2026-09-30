import { describe, expect, test } from "bun:test";
import {
  assessNotAssessedCandidate, runAreaGapInvestigation, runCandidateEvidenceInvestigator,
  type InvestigatorDependencies, type InvestigatorSearchRequest,
} from "../../src/core/evidence-investigators";
import type { DiscoveryProblem, HarvestedFactor, HarvestedSource } from "../../src/core/discovery";
import type { StructuredModelClient, StructuredStageRequest } from "../../src/providers/structured";
import {
  AreaGapOutputSchema, candidateAssessmentProjection, EvidenceCheckOutputSchema, researchTargetProgress, RESEARCH_TARGETS,
} from "../../src/shared/evidence-investigators";
import { WorkflowTargetSchema } from "../../src/shared/workflow-contracts";
import type { ResearchArea, ResearchFrame } from "../../src/shared/research-frame";
import type { DiscoveryDepth, Source } from "../../src/shared/schemas";

const area: ResearchArea = { id: "close", name: "Month-end close", whyRelevant: "Reconciliation delays",
  affectedPeople: "Bookkeepers", venues: [{ name: "Accounting forum", domain: "forum.example.test", kind: "community" }],
  exampleProblems: [], included: true, priority: 1 };
const frame: ResearchFrame = { goal: "Find bookkeeping workflow problems", goalKind: "market-opportunity",
  contextFacts: [], successCriteria: [{ id: "pain", name: "Observed pain", weight: "must", howJudged: "Independent accounts", basis: "brief" }],
  constraints: [], languages: ["en"], areas: [area], exclusions: [], openQuestions: [] };
const quote = "I spend hours fixing duplicate bank-feed entries every month.";

function source(id: string): HarvestedSource {
  const url = `https://forum.example.test/${id}`;
  return { id, providerSourceId: id, canonicalUrl: url, url, title: "Bookkeeper account", retrievedText: quote,
    author: null, publishedAt: null, contentHash: id, retrievedAt: "2026-09-30T12:00:00.000Z" };
}
function factor(id: string, origin = id): HarvestedFactor {
  return { id, subject: "Bookkeeper", behavior: "Fixes duplicate entries", quote, sourceId: id, source: source(id),
    harvestMode: "domain", modelConfidence: 0.8, uncertainty: "Scope unknown", sourceRole: "firsthand", audienceFit: "intended-buyer",
    independentSourceKey: origin, supportsDemand: false, demandEvidenceUncertainty: "No purchase observed" };
}
function problem(factors = [factor("one")]): DiscoveryProblem {
  return { id: "problem", statement: "Bookkeepers repeatedly fix duplicate feed entries", whyItPersists: "Feeds re-import transactions",
    affected: "Bookkeepers", scaleEstimate: "Unknown", scaleBasisFactorId: null, factorIds: factors.map(item => item.id),
    verdict: "insufficient-evidence", verdictReason: "Only one observed origin", verdictSourceIds: [],
    intendedBuyerEvidenceFactorIds: factors.map(item => item.id), evidenceGap: "Need another independent observation",
    briefFit: "direct", contraryEvidence: "resolved", workflowKey: "reconcile-bank-feeds",
    factors, sourceHostnames: ["forum.example.test"], singleHarvestModeWarning: true };
}

function fixture(options: { depth?: DiscoveryDepth; vendor?: boolean; duplicateOrigin?: boolean; forceConfirmedCheck?: boolean; drop?: boolean } = {}) {
  const snapshots = new Map<string, unknown>();
  const calls: string[] = [];
  const searches: InvestigatorSearchRequest[] = [];
  const client: StructuredModelClient = {
    async structuredCompletion<T>(request: StructuredStageRequest<T>) {
      calls.push(request.stage);
      expect(request.repairPolicy).toBe("disabled");
      const packet = request.evidence[0]!.content as { problem?: DiscoveryProblem; sources?: Array<{ id: string }>; supportingFactors?: HarvestedFactor[] };
      let output: unknown;
      if (request.stage.startsWith("evidence-check:")) {
        const confirmed = options.forceConfirmedCheck || packet.problem?.verdict === "confirmed";
        output = { decision: options.drop ? "drop" : confirmed ? "confirmed" : "follow-up", reason: "Find a second affected actor",
          gaps: confirmed || options.drop ? [] : [{ kind: "second-independent-observation", evidenceNeeded: "An independent bookkeeper account",
            query: "duplicate bank feed entries bookkeeper experience", route: "community" }] };
      } else if (request.stage.startsWith("factor-harvest:")) {
        output = { factors: packet.sources!.map(item => ({ subject: "Bookkeeper", behavior: "Fixes duplicate entries", quote,
          sourceId: item.id, modelConfidence: 0.8, uncertainty: "Scope unknown", sourceRole: options.vendor ? "vendor" : "firsthand",
          audienceFit: "intended-buyer", independentSourceKey: options.duplicateOrigin ? "one" : item.id,
          supportsDemand: false, demandEvidenceUncertainty: "No purchase observed" })) };
      } else if (request.stage.startsWith("problem-kill:")) {
        output = { verdict: "confirmed", verdictReason: "Independent observations support the problem", verdictSourceIds: [],
          intendedBuyerEvidenceFactorIds: packet.supportingFactors!.map(item => item.id), evidenceGap: null,
          briefFit: "direct", contraryEvidence: "resolved", workflowKey: "reconcile-bank-feeds" };
      } else if (request.stage.startsWith("area-gap:")) {
        output = { reason: "One group remains unsearched", gaps: [{ name: "Multi-client close", evidenceNeeded: "Bookkeepers with several clients",
          query: "multi-client close duplicate bank feeds", route: "community" }] };
      } else throw new Error(`Unexpected stage ${request.stage}`);
      return { output: request.schema.parse(output), metadata: { model: request.model, usage: { status: "unknown" },
        latencyMs: 1, repairCount: 0, providerRequestIds: [], attempts: [] } };
    },
  };
  const input: InvestigatorDependencies = { runId: "run", scope: { title: "Close", audience: "Bookkeepers", domain: "Bank feeds", observations: "", offLimits: [] },
    frame, area, dependencies: { modelClient: client, model: { providerId: "fixture", modelId: "fixture" }, reasoningEffort: "medium",
      workflowVersion: 2, depth: options.depth ?? "standard", prompt: name => name, search: { search: async () => [] } },
    checkpoints: { read: key => snapshots.get(key) ?? null, save: (key, value) => { snapshots.set(key, value); } },
    budgetAvailable: () => true,
    durableSearch: async request => {
      searches.push(request);
      const id = `new-${searches.length}`;
      return [{ id, url: `https://forum.example.test/${id}`, title: "Bookkeeper account", text: quote } satisfies Source];
    } };
  return { input, calls, searches, snapshots };
}

describe("bounded evidence investigators", () => {
  test("one origin becomes confirmed only after a quote-checked second independent observation", async () => {
    const item = fixture();
    const result = await runCandidateEvidenceInvestigator({ ...item.input, problem: problem() });
    expect(result.problem.verdict).toBe("confirmed");
    expect(result.problem.intendedBuyerEvidenceFactorIds).toHaveLength(2);
    expect(result.factors).toHaveLength(1);
    expect(result.rounds).toHaveLength(2);
    expect(item.searches).toHaveLength(1);
    expect(item.calls).toEqual(["evidence-check:close:problem:round-0",
      "factor-harvest:follow-up:investigator:close:problem:round-1:gap-1", "problem-kill:close:problem:round-1", "evidence-check:close:problem:round-1"]);
  });

  test("a model's confirmation with one independent origin stays insufficient", async () => {
    const item = fixture({ forceConfirmedCheck: true });
    const result = await runCandidateEvidenceInvestigator({ ...item.input, problem: { ...problem(), verdict: "confirmed" } });
    expect(result.problem.verdict).toBe("insufficient-evidence");
    expect(result.stopReason).toContain("rejected by the evidence rule");
    expect(item.searches).toHaveLength(0);
  });

  test("the checker can drop a candidate even after a confirmed verdict", async () => {
    const item = fixture({ drop: true });
    const result = await runCandidateEvidenceInvestigator({ ...item.input,
      problem: { ...problem([factor("one"), factor("two")]), verdict: "confirmed" } });
    expect(result.dropped).toBe(true);
    expect(result.stopReason).toBe("Find a second affected actor");
    expect(item.searches).toHaveLength(0);
  });

  test("syndicated observations cannot manufacture independence and the fixed round limit stops work", async () => {
    const item = fixture({ duplicateOrigin: true });
    const result = await runCandidateEvidenceInvestigator({ ...item.input, problem: problem() });
    expect(result.problem.verdict).toBe("insufficient-evidence");
    expect(result.stopReason).toContain("rounds exhausted");
    expect(item.searches).toHaveLength(1);
  });

  test("quick depth assesses the gap without starting follow-up searches", async () => {
    const item = fixture({ depth: "quick" });
    const result = await runCandidateEvidenceInvestigator({ ...item.input, problem: problem() });
    expect(result.problem.verdict).toBe("insufficient-evidence");
    expect(result.stopReason).toContain("0 follow-up round");
    expect(item.searches).toHaveLength(0);
  });

  test("deep depth switches route after zero qualifying yield and stops after two follow-ups", async () => {
    const item = fixture({ depth: "deep", vendor: true });
    const result = await runCandidateEvidenceInvestigator({ ...item.input, problem: problem() });
    expect(result.problem.verdict).toBe("insufficient-evidence");
    expect(item.searches.map(search => search.route)).toEqual(["community", "issue-tracker"]);
    expect(result.rounds).toHaveLength(3);
    expect(result.rounds.flatMap(round => round.searches).map(search => search.qualifyingFacts)).toEqual([0, 0]);
  });

  test("exhausted search budget preserves the candidate and explains the skipped gap", async () => {
    const item = fixture();
    const result = await runCandidateEvidenceInvestigator({ ...item.input, budgetAvailable: (_calls, searches) => searches === 0, problem: problem() });
    expect(result.problem.verdict).toBe("insufficient-evidence");
    expect(result.stopReason).toContain("Budget exhausted before evidence gap");
    expect(item.searches).toHaveLength(0);
  });

  test("completed rounds resume from their exact saved factors without providers or further budget", async () => {
    const item = fixture();
    const first = await runCandidateEvidenceInvestigator({ ...item.input, problem: problem() });
    const calls = item.calls.length;
    const resumed = await runCandidateEvidenceInvestigator({ ...item.input, budgetAvailable: () => false,
      durableSearch: async () => { throw new Error("Provider unavailable"); }, problem: problem() });
    expect(resumed.problem).toEqual(first.problem);
    expect(resumed.factors).toEqual(first.factors);
    expect(resumed.sources).toEqual(first.sources);
    expect(item.calls).toHaveLength(calls);
    expect(item.searches).toHaveLength(1);
  });

  test("an area's gap map and all completed searches run once across restart", async () => {
    const item = fixture();
    const first = await runAreaGapInvestigation({ ...item.input, completedResearch: { workflows: ["single-client"] } });
    const resumed = await runAreaGapInvestigation({ ...item.input, completedResearch: {}, budgetAvailable: () => false });
    expect(resumed).toEqual(first);
    expect(item.calls.filter(call => call.startsWith("area-gap:"))).toHaveLength(1);
    expect(item.searches).toHaveLength(1);
  });

  test("research targets count distinct confirmed problems and area coverage without padding", () => {
    const target = RESEARCH_TARGETS.standard;
    const problems = [{ id: "one", verdict: "confirmed", areaId: "a" }, { id: "two", verdict: "confirmed", areaId: "a" },
      { id: "three", verdict: "confirmed", areaId: "a" }, { id: "four", verdict: "confirmed", areaId: "a" }];
    expect(researchTargetProgress(target, problems)).toEqual({ confirmedProblems: 4, areas: 1, outcome: "partial" });
    expect(researchTargetProgress(target, [...problems, { id: "five", verdict: "confirmed", areaId: "b" }]).outcome).toBe("target-met");
    expect(researchTargetProgress(target, [...problems, problems[0]!]).confirmedProblems).toBe(4);
  });

  test("Assess preview covers bounded verdict and investigator work", () => {
    expect(candidateAssessmentProjection("deep")).toEqual({ modelCalls: 10, searches: 5 });
    expect(candidateAssessmentProjection("quick")).toEqual({ modelCalls: 2, searches: 1 });
    expect(EvidenceCheckOutputSchema.safeParse({ decision: "follow-up", reason: "Gap", gaps: [] }).success).toBe(false);
  });

  test("Assess uses the saved candidate and its factors without rerunning synthesis", async () => {
    const item = fixture({ depth: "quick" });
    const original = problem([factor("one"), factor("two")]);
    const candidate = { statement: original.statement, whyItPersists: original.whyItPersists, affected: original.affected,
      scaleEstimate: original.scaleEstimate, scaleBasisFactorId: original.scaleBasisFactorId, factorIds: original.factorIds };
    const result = await assessNotAssessedCandidate({ ...item.input, candidateId: "saved", candidate,
      factors: original.factors, existingSources: original.factors.map(factor => factor.source) });
    expect(result.assessed).toBe(true);
    if (!result.assessed) throw new Error(result.stopReason);
    expect(result.problem.verdict).toBe("confirmed");
    expect(result.problem.statement).toBe(candidate.statement);
    expect(item.calls.some(call => call.startsWith("problem-candidates"))).toBe(false);
    expect(item.searches).toHaveLength(1);
  });

  test("Assess keeps an unaffordable candidate not assessed rather than inventing a verdict", async () => {
    const item = fixture();
    const original = problem();
    const result = await assessNotAssessedCandidate({ ...item.input, budgetAvailable: () => false, candidateId: "saved",
      candidate: original, factors: original.factors, existingSources: original.factors.map(factor => factor.source) });
    expect(result.assessed).toBe(false);
    expect(item.calls).toHaveLength(0);
    expect(item.searches).toHaveLength(0);
  });

  test("area-gap evidence identifiers are unique across different research runs", async () => {
    const first = fixture();
    const second = fixture();
    const a = await runAreaGapInvestigation({ ...first.input, runId: "first", completedResearch: {} });
    const b = await runAreaGapInvestigation({ ...second.input, runId: "second", completedResearch: {} });
    expect(a.factors[0]!.id).not.toBe(b.factors[0]!.id);
    expect(a.sources[0]!.id).not.toBe(b.sources[0]!.id);
  });

  test("old target contracts still parse and new evidence maps reject unbounded work", () => {
    expect(WorkflowTargetSchema.parse({ kind: "per-problem", ideaCount: 3 })).not.toHaveProperty("research");
    expect(WorkflowTargetSchema.parse({ kind: "project", ideaCount: 3, research: RESEARCH_TARGETS.standard }).research).toEqual(RESEARCH_TARGETS.standard);
    const gap = { name: "Another workflow", evidenceNeeded: "Independent accounts", query: "bookkeeper feed issues", route: "community" };
    expect(AreaGapOutputSchema.safeParse({ reason: "Too many gaps", gaps: [gap, gap, gap, gap] }).success).toBe(false);
  });
});
