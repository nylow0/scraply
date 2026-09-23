import { describe, expect, test } from "bun:test";
import {
  compareResearchFindings, resolveResearchSelection, validateResearchRequest,
} from "../../src/core/research-revisions";

describe("research revision admission", () => {
  test("reevaluation cannot reserve searches and redo needs a target", () => {
    expect(() => validateResearchRequest({
      kind: "reevaluate", question: "Recheck the verdict", targetFindingId: "problem-a",
      allowance: { maxModelCalls: 2, maxSearches: 1, maxMinutes: 5 },
    })).toThrow("cannot make search calls");
    expect(() => validateResearchRequest({
      kind: "redo", question: "Find better buyer reports",
      allowance: { maxModelCalls: 2, maxSearches: 2, maxMinutes: 5 },
    })).toThrow("Choose the finding");
  });

  test("applying a replacement keeps unrelated findings without including the old one", () => {
    expect(resolveResearchSelection(
      ["old", "unrelated"], ["replacement", "new"],
      [{ oldFindingId: "old", newFindingId: "replacement" }],
    )).toEqual(["unrelated", "replacement", "new"]);
    expect(() => resolveResearchSelection(
      ["old"], ["replacement"], [{ oldFindingId: "another-project", newFindingId: "replacement" }],
    )).toThrow("absent from the current snapshot");
  });

  test("comparison reports new and removed evidence without rewriting the previous finding", () => {
    const previous = {
      statement: "Small teams struggle", verdict: "confirmed", sourceIds: ["a", "b"],
      factorIds: ["one"], evidenceGap: "Buyer fit unknown",
    };
    expect(compareResearchFindings(previous, {
      statement: "Larger teams struggle", verdict: "insufficient-evidence", sourceIds: ["b", "c"],
      factorIds: ["two"], evidenceGap: "Small-team demand unproven",
    })).toEqual({
      statementChanged: true, verdictChanged: true,
      addedSourceIds: ["c"], removedSourceIds: ["a"],
      addedFactorIds: ["two"], removedFactorIds: ["one"],
      previousGap: "Buyer fit unknown", proposedGap: "Small-team demand unproven",
    });
    expect(previous.statement).toBe("Small teams struggle");
  });
});
