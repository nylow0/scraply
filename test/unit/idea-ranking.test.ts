import { expect, test } from "bun:test";
import { orderRankedIdeas, prepareIdeaRanking, type RankingCandidate } from "../../src/core/idea-ranking";
import type { ResearchFrame } from "../../src/shared/research-frame";

const frame: ResearchFrame = {
  goal: "Reduce repeated entries", goalKind: "process-improvement", contextFacts: [], constraints: [], languages: ["en"], exclusions: [], openQuestions: [],
  successCriteria: [
    { id: "solo", name: "Fits a solo founder", weight: "must", howJudged: "Team needed to run it", basis: "brief" },
    { id: "cheap", name: "Costs under 100 a month", weight: "nice", howJudged: "Monthly cost", basis: "brief" },
  ],
  areas: [],
} as unknown as ResearchFrame;

const option = (mechanism: string) => ({ mechanism, description: `${mechanism}: a short idea`, keyAssumption: "Owners will try it",
  whyCurrentApproachMaySuffice: "Manual work may be fine", supportingEvidenceIds: [], contraryEvidenceIds: [], unknowns: [],
  respectsOffLimits: true, respectsOffLimitsWhy: "Within limits" });
const candidates: RankingCandidate[] = ["a", "b", "c"].map((id) => ({ id, option: option(`Idea ${id}`) }));

function prepared() {
  return prepareIdeaRanking({ frame, candidates, problem: { statement: "Owners repeat filing" }, projectConstraints: {}, savedInstructions: "",
    evidence: [{ sourceId: "source-1", content: { text: "A bookkeeper needs a sales team to reach firms." } }],
    model: { providerId: "fixture", modelId: "fixture" }, reasoningEffort: "medium" });
}

const fit = (solo: "meets" | "fails" | "unknown", evidenceIds: string[] = solo === "unknown" ? [] : ["source-1"]) => [
  { criterionId: "solo", criterionName: "Fits a solo founder", mustHave: true, status: solo, evidenceIds, note: "Needs a sales team to reach accounting firms" },
  { criterionId: "cheap", criterionName: "Costs under 100 a month", mustHave: false, status: "unknown", evidenceIds: [], note: "No price evidence" },
];

test("an idea that fails a must-have moves to the end of its group with the criterion in its weak-fit reason", () => {
  const output = prepared().request.schema.parse({ ranking: [
    { candidateId: "a", reason: "Cheapest to test", sameAsCandidateId: null, criteriaFit: fit("fails") },
    { candidateId: "b", reason: "Clear buyer", sameAsCandidateId: null, criteriaFit: fit("meets") },
    { candidateId: "c", reason: "Slower to sell", sameAsCandidateId: null, criteriaFit: fit("meets") },
  ] });
  expect(orderRankedIdeas(output).map(({ candidateId, rank, weakFitReason }) => ({ candidateId, rank, weakFitReason }))).toEqual([
    { candidateId: "b", rank: 1, weakFitReason: null },
    { candidateId: "c", rank: 2, weakFitReason: null },
    { candidateId: "a", rank: 3, weakFitReason: 'fails "Fits a solo founder": Needs a sales team to reach accounting firms' },
  ]);
});

test("unknown on a criterion never marks an idea weak, even when the ranker claims a failure without evidence", () => {
  const output = prepared().request.schema.parse({ ranking: [
    { candidateId: "a", reason: "Best fit", sameAsCandidateId: null, criteriaFit: fit("unknown") },
    // A fail with no cited evidence is repaired to unknown before validation.
    { candidateId: "b", reason: "Second", sameAsCandidateId: null, criteriaFit: fit("fails", []) },
    { candidateId: "c", reason: "Third", sameAsCandidateId: null, criteriaFit: fit("unknown") },
  ] });
  expect(output.ranking[1]!.criteriaFit![0]!.status).toBe("unknown");
  expect(orderRankedIdeas(output).map((idea) => [idea.candidateId, idea.weakFitReason])).toEqual([["a", null], ["b", null], ["c", null]]);
});

test("a near-repeat of a higher idea is a weak fit that names the higher idea's final place", () => {
  const output = prepared().request.schema.parse({ ranking: [
    // Pointing at a lower idea is not a repeat of a better one.
    { candidateId: "a", reason: "Strongest evidence", sameAsCandidateId: "c", criteriaFit: fit("meets") },
    { candidateId: "b", reason: "Same checklist with a different wrapper", sameAsCandidateId: "a", criteriaFit: fit("meets") },
    { candidateId: "c", reason: "Different channel", sameAsCandidateId: null, criteriaFit: fit("meets") },
  ] });
  expect(orderRankedIdeas(output).map((idea) => [idea.candidateId, idea.rank, idea.weakFitReason])).toEqual([
    ["a", 1, null], ["c", 2, null], ["b", 3, "same as idea 1: Same checklist with a different wrapper"],
  ]);
});

test("the ranking must list every idea exactly once", () => {
  const schema = prepared().request.schema;
  expect(() => schema.parse({ ranking: [
    { candidateId: "a", reason: "Only one", sameAsCandidateId: null, criteriaFit: fit("meets") },
    { candidateId: "a", reason: "Again", sameAsCandidateId: null, criteriaFit: fit("meets") },
  ] })).toThrow("exactly once");
  expect(() => schema.parse({ ranking: [
    { candidateId: "z", reason: "Unknown idea", sameAsCandidateId: null, criteriaFit: fit("meets") },
  ] })).toThrow();
});
