import { expect, test } from "bun:test";
import { repairVerdictSourceIds, scopeFactorAssessments } from "../../src/core/problem-evidence";

// Live Bookkeepers runs ended on these citation slips; the app now repairs them instead.
test("a verdict citing a fact ID maps to that fact's source and drops invented IDs", () => {
  const sources = new Set(["source-a", "source-b"]);
  const factSources = new Map([["fact-1", "source-b"]]);
  expect(repairVerdictSourceIds(["source-a", "fact-1", "invented", "source-b"], sources, factSources)).toEqual(["source-a", "source-b"]);
});

test("factor reviews keep the first review per supplied factor and drop unknown factors", () => {
  const review = (factorId: string, reason: string) => ({ factorId, reason });
  expect(scopeFactorAssessments([review("f1", "first"), review("invented", "x"), review("f1", "duplicate"), review("f2", "second")], ["f1", "f2", "f3"]))
    .toEqual([review("f1", "first"), review("f2", "second")]);
});
