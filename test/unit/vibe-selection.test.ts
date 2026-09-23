import { describe, expect, test } from "bun:test";
import { selectVibeProblems, type VibeProblemCandidate } from "../../src/core/vibe-selection";

function candidate(id: string, changes: Partial<VibeProblemCandidate> = {}): VibeProblemCandidate {
  return {
    id,
    statement: `Teams lose time reconciling ${id}`,
    affected: "Operations teams",
    verdict: "confirmed",
    evidenceGap: null,
    intendedBuyerEvidenceFactorIds: [`${id}:observation`],
    factors: [{
      id: `${id}:observation`, sourceId: `${id}:source`, sourceUrl: `https://example.com/${id}`,
      quote: "We spend hours reconciling these records.",
      sourceRole: "firsthand", audienceFit: "intended-buyer",
      independentSourceKey: `${id}:buyer-account`, supportsDemand: false,
    }],
    ...changes,
  };
}

describe("unattended problem selection", () => {
  test("a confirmed label alone cannot qualify a problem", () => {
    const result = selectVibeProblems({ candidates: [candidate("weak", {
      intendedBuyerEvidenceFactorIds: [],
    })] });
    expect(result.outcome).toBe("no-qualifying-problems");
    expect(result.selectedProblemIds).toEqual([]);
    expect(result.reason).toContain("Zero ideas");
    expect(result.decisions[0]?.reason).toContain("confirmed label alone is insufficient");
  });

  test("one direct identified buyer observation can qualify without inventing demand", () => {
    const result = selectVibeProblems({ candidates: [candidate("direct")] });
    expect(result.selectedProblemIds).toEqual(["direct"]);
    expect(result.decisions[0]).toMatchObject({
      selected: true, origin: "problem-evidence", directObservationCount: 1,
      independentSourceCount: 1, demandSignalFactorIds: [], sourceIds: ["direct:source"],
    });
    expect(result.decisions[0]?.reason).toContain("Buyer demand is not established");
  });

  test("a lone observation with doubtful source independence is rejected", () => {
    const result = selectVibeProblems({ candidates: [candidate("weak-source", {
      factors: [{ ...candidate("weak-source").factors[0]!, independentSourceKey: null }],
    })] });
    expect(result.outcome).toBe("no-qualifying-problems");
    expect(result.decisions[0]?.reason).toContain("independent source key");
  });

  test("only cited intended-buyer observations count, even if other factors look strong", () => {
    const unsupported = candidate("uncited", {
      factors: [{ ...candidate("uncited").factors[0]!, id: "another-factor" }],
    });
    const adjacent = candidate("adjacent", {
      factors: [{ ...candidate("adjacent").factors[0]!, audienceFit: "adjacent" }],
    });
    const vendor = candidate("vendor", {
      factors: [{ ...candidate("vendor").factors[0]!, sourceRole: "vendor" }],
    });
    const result = selectVibeProblems({ candidates: [unsupported, adjacent, vendor] });
    expect(result.selectedProblemIds).toEqual([]);
    expect(result.rejectedProblemIds).toEqual(["uncited", "adjacent", "vendor"]);
  });

  test("open gaps, unresolved contradictions, and outside-brief fit block selection", () => {
    const result = selectVibeProblems({ candidates: [
      candidate("gap", { evidenceGap: "Need a buyer interview" }),
      candidate("contrary", { contraryEvidence: "unresolved" }),
      candidate("outside", { briefFit: "outside" }),
    ] });
    expect(result.selectedProblemIds).toEqual([]);
    expect(result.decisions.map((item) => item.reason)).toEqual([
      "The evidence gap remains open: Need a buyer interview",
      "Contradictory evidence remains unresolved.",
      "The saved review places this problem outside the launch brief or intended buyer.",
    ]);
  });

  test("ranks brief fit and independent evidence, removes duplicate workflows, and defaults to three", () => {
    const stronger = candidate("b", { briefFit: "direct", workflowKey: "Invoice approval", factors: [
      ...candidate("b").factors,
      { ...candidate("b").factors[0]!, id: "b:second", sourceId: "b:second-source", independentSourceKey: "b:second-account" },
    ], intendedBuyerEvidenceFactorIds: ["b:observation", "b:second"] });
    const weakerDuplicate = candidate("a", { briefFit: "direct", workflowKey: "  invoice  approval " });
    const input = [candidate("z", { briefFit: "unknown" }), weakerDuplicate, candidate("d", { briefFit: "partial" }), stronger, candidate("c", { briefFit: "direct" })];
    const result = selectVibeProblems({ candidates: input });
    expect(result.selectedProblemIds).toEqual(["b", "c", "d"]);
    expect(result.decisions.find((item) => item.problemId === "a")?.reason).toContain("already covers this buyer workflow");
    expect(result.decisions.find((item) => item.problemId === "z")?.reason).toContain("cap of 3");
    expect(input.map((item) => item.id)).toEqual(["z", "a", "d", "b", "c"]);
  });

  test("a known problem keeps user-asserted origin only when launched explicitly", () => {
    const supplied = candidate("supplied", {
      verdict: "user-asserted", intendedBuyerEvidenceFactorIds: [], factors: [],
    });
    expect(selectVibeProblems({ candidates: [supplied] }).selectedProblemIds).toEqual([]);
    const result = selectVibeProblems({ purpose: "known-problem", candidates: [supplied] });
    expect(result.selectedProblemIds).toEqual(["supplied"]);
    expect(result.decisions[0]).toMatchObject({ origin: "user-asserted", directObservationCount: 0, demandSignalFactorIds: [] });
    expect(result.decisions[0]?.reason).toContain("user-asserted");
  });

  test("the configured cap is validated and results are independent of candidate order", () => {
    expect(() => selectVibeProblems({ candidates: [], maxProblems: 0 })).toThrow("positive integer");
    expect(() => selectVibeProblems({ candidates: [candidate("same"), candidate("same")] })).toThrow("unique");
    const first = selectVibeProblems({ candidates: [candidate("b"), candidate("a")] });
    const second = selectVibeProblems({ candidates: [candidate("a"), candidate("b")] });
    expect(first.selectedProblemIds).toEqual(second.selectedProblemIds);
  });
});
