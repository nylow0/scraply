import { describe, expect, test } from "bun:test";
import type { Phase1AblationResult } from "../../src/core/discovery";
import type { DevelopmentResult } from "../../src/core/development";
import {
  phase1ObjectiveChecks,
  phase2ObjectiveChecks,
  renderPhase1Review,
  renderPhase2Review,
} from "../../scripts/gate-support";

describe("headless gate evidence", () => {
  test("Phase 1 separately records objective evidence and the required human overlap judgment", () => {
    const result = phase1Result();
    const checks = phase1ObjectiveChecks(result);

    expect(checks.objectiveChecksPassed).toBe(true);
    expect(checks.humanOverlapReviewRequired).toBe(true);
    expect(renderPhase1Review(checks)).toContain("- [ ] Human: at least two Arm A problems");

    result.armA.problems[0]!.factors[0]!.quote = "Text that is not in the source";
    expect(phase1ObjectiveChecks(result).objectiveChecksPassed).toBe(false);
  });

  test("Phase 2 records the measured projection delta and all mechanical contract checks", () => {
    const result = phase2Result();
    const checks = phase2ObjectiveChecks(result, "# Idea chain\n\nAn API request can be blocked by the provider.");

    expect(checks).toMatchObject({
      objectiveChecksPassed: true,
      expectedModelCallsWithoutRetries: 6,
      actualModelCalls: 6,
      inferredSchemaRetries: 0,
      ideaVerdictPhrases: [],
      humanReadabilityReviewRequired: true,
    });
    expect(renderPhase2Review(checks)).toContain("Measured model calls for this problem: **6**");

    result.modelCalls = 7;
    expect(phase2ObjectiveChecks(result, "# Idea chain").objectiveChecksPassed).toBe(false);
  });

  test("Phase 2 fails an incomplete risk chain on its own, without the verdict scan", () => {
    const result = phase2Result();
    result.solutions[0]!.mitigations = [];
    const checks = phase2ObjectiveChecks(result, "# Idea chain");

    expect(checks.everySolutionHasMitigationWithFailsIf).toBe(false);
    expect(checks.objectiveChecksPassed).toBe(false);
  });

  test("Phase 2 reports verdict wording to the human instead of deciding the gate on it", () => {
    // The scan cannot see "not viable" or "high risk", so it must never own a pass/fail.
    const flagged = phase2ObjectiveChecks(phase2Result(), "**Status:** viable");
    const missed = phase2ObjectiveChecks(phase2Result(), "**Verdict:** Not viable. The risk is high risk.");

    expect(flagged.ideaVerdictPhrases).toEqual(["**Status:** viable"]);
    expect(flagged.objectiveChecksPassed).toBe(true);
    expect(missed.ideaVerdictPhrases).toEqual([]);
    expect(renderPhase2Review(flagged)).toContain("- [ ] Human: the artifact does not pronounce the idea");
    expect(renderPhase2Review(flagged)).toContain("`**Status:** viable`");
    expect(renderPhase2Review(missed)).toContain("misses phrasings");
  });
});

function phase1Result(): Phase1AblationResult {
  const source = {
    id: "source-1",
    providerSourceId: "provider-1",
    url: "https://one.example/source",
    canonicalUrl: "https://one.example/source",
    title: "Source",
    retrievedText: "Operators repeat the same reconciliation every week.",
    author: null,
    publishedAt: null,
    contentHash: "hash",
    retrievedAt: "2026-08-11T00:00:00.000Z",
  };
  const factor = {
    id: "factor-1",
    subject: "Operators",
    behavior: "repeat reconciliation",
    quote: "Operators repeat the same reconciliation every week.",
    sourceId: source.id,
    harvestMode: "audience" as const,
    modelConfidence: 0.9,
    source,
  };
  const problem = {
    id: "problem-1",
    statement: "Operators repeatedly reconcile duplicate records.",
    whyItPersists: "Systems do not share state.",
    affected: "Operators",
    scaleEstimate: "Weekly",
    scaleBasisFactorId: factor.id,
    factorIds: [factor.id],
    verdict: "confirmed" as const,
    verdictReason: "The evidence survived the kill search.",
    verdictSourceIds: [source.id],
    factors: [factor],
    sourceHostnames: ["one.example", "two.example"],
    singleHarvestModeWarning: true,
  };
  return {
    scope: { title: "Ops", audience: "Operators", domain: "Operations", observations: "", offLimits: [] },
    harvest: {
      factors: [factor],
      sources: [source],
      rejections: [],
      metrics: {
        extracted: { domain: 0, audience: 1 },
        accepted: { domain: 0, audience: 1 },
        retained: { domain: 0, audience: 1 },
        rejected: { domain: 0, audience: 0 },
        quoteRejected: { domain: 0, audience: 0 },
        quoteRejectionRate: { domain: 0, audience: 0 },
      },
    },
    armA: { arm: "A", problems: [problem], blockedCandidates: [], killSources: [], factorUtilizationRate: 1 },
    armC: { arm: "C", problems: [], blockedCandidates: [], killSources: [], factorUtilizationRate: 0 },
  };
}

function phase2Result(): DevelopmentResult {
  return {
    scope: { title: "Ops", audience: "Operators", domain: "Operations", observations: "", offLimits: [] },
    problem: {
      id: "problem-1",
      statement: "Operators repeatedly reconcile duplicate records.",
      whyItPersists: "Systems do not share state.",
      affected: "Operators",
      scaleEstimate: "Weekly",
      scaleBasisFactorId: null,
      factorIds: [],
      verdict: "user-asserted",
      verdictReason: "Entered by the user.",
      verdictSourceIds: [],
    },
    factors: [],
    modelCalls: 6,
    solutions: [{
      id: "solution-1",
      problemId: "problem-1",
      mechanism: "Shared state journal",
      description: "Record state transitions once.",
      respectsOffLimits: true,
      respectsOffLimitsWhy: "No restriction applies.",
      outcomes: [
        { id: "outcome-1", solutionId: "solution-1", description: "Duplicate work falls.", direction: "positive", affects: "operators", addressesCore: true },
        { id: "outcome-2", solutionId: "solution-1", description: "Setup takes time.", direction: "negative", affects: "builders", addressesCore: false },
      ],
      risks: [{
        id: "risk-1",
        solutionId: "solution-1",
        description: "The source API changes.",
        likelihood: "possible",
        impact: "~2 weeks",
        sortKey: 4,
      }],
      mitigations: [{
        id: "mitigation-1",
        solutionId: "solution-1",
        riskIds: ["risk-1"],
        approach: "Version adapters",
        cost: "Two days",
        failsIf: "The provider removes exports",
      }],
    }],
  };
}
