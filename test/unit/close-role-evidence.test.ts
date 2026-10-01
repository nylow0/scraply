import { expect, test } from "bun:test";
import { qualifiesAsProblemObservation, reliesOnCloseRoles } from "../../src/core/problem-evidence";
import { selectVibeProblems, type VibeProblemCandidate } from "../../src/core/vibe-selection";

// A freelance-bookkeeper brief: one freelancer account plus one account from a bookkeeper at a small firm.
const freelancer = { id: "freelancer", sourceId: "s1", sourceUrl: "https://reddit.com/r/Bookkeeping/1", quote: "I reconcile 30 client feeds by hand every month.",
  sourceRole: "firsthand" as const, audienceFit: "intended-buyer" as const, independentSourceKey: "freelancer-post", supportsDemand: false };
const firmBookkeeper = { ...freelancer, id: "firm", sourceId: "s2", sourceUrl: "https://community.example.com/2",
  quote: "Our three-person firm loses a day each close matching bank feeds.", audienceFit: "adjacent" as const, independentSourceKey: "firm-post" };
const consultant = { ...firmBookkeeper, id: "consultant", sourceId: "s3", audienceFit: "general" as const, independentSourceKey: "consultant-blog" };

test("a close role doing the same task counts as problem evidence; a general actor does not", () => {
  expect(qualifiesAsProblemObservation(freelancer)).toBe(true);
  expect(qualifiesAsProblemObservation(firmBookkeeper)).toBe(true);
  expect(qualifiesAsProblemObservation(consultant)).toBe(false);
  expect(qualifiesAsProblemObservation({ ...firmBookkeeper, sourceRole: "vendor" })).toBe(false);
});

test("the close-role label appears only when close roles were needed for two origins", () => {
  expect(reliesOnCloseRoles([freelancer, firmBookkeeper])).toBe(true);
  expect(reliesOnCloseRoles([freelancer, { ...freelancer, id: "second", independentSourceKey: "second-freelancer" }])).toBe(false);
  expect(reliesOnCloseRoles([freelancer, consultant])).toBe(false);
});

test("Vibe selects a problem confirmed by a freelancer and a firm bookkeeper", () => {
  const problem: VibeProblemCandidate = { id: "bank-feeds", statement: "Bookkeepers match bank feeds by hand", affected: "Bookkeepers",
    verdict: "confirmed", evidenceGap: null, intendedBuyerEvidenceFactorIds: ["freelancer", "firm"], factors: [freelancer, firmBookkeeper] };
  const result = selectVibeProblems({ candidates: [problem] });
  expect(result.selectedProblemIds).toEqual(["bank-feeds"]);
  expect(result.decisions[0]).toMatchObject({ directObservationCount: 2, independentSourceCount: 2 });
});
