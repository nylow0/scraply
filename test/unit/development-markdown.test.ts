import { describe, expect, test } from "bun:test";
import { renderDevelopmentMarkdown } from "../../src/core/development-markdown";
import type { DevelopmentResult } from "../../src/core/development";

describe("Phase 2 Markdown", () => {
  test("renders the chain and risk information without a computed idea verdict", () => {
    const markdown = renderDevelopmentMarkdown(result());
    expect(markdown).toContain("## Problem");
    expect(markdown).toContain("## Idea 1: Queue reconciliation");
    expect(markdown).toContain("**negative**");
    expect(markdown).toContain("**likely × project ends**");
    expect(markdown).toContain("Fails if: Exports are disabled");
    expect(markdown).toContain("Unaddressed catastrophic risks: 0");
    expect(markdown).not.toMatch(/\b(blocked|high-risk|viable)\b/i);
  });
});

function result(): DevelopmentResult {
  return {
    scope: {
      title: "Claims",
      audience: "Sellers",
      domain: "Operations",
      observations: "Repeated claims",
      offLimits: [],
    },
    problem: {
      id: "problem-1",
      statement: "Claims repeat.",
      whyItPersists: "State is fragmented.",
      affected: "Sellers",
      scaleEstimate: "Weekly",
      scaleBasisFactorId: null,
      factorIds: [],
      verdict: "user-asserted",
      verdictReason: "Entered by the owner.",
      verdictSourceIds: [],
    },
    factors: [],
    modelCalls: 6,
    solutions: [{
      id: "solution-1",
      problemId: "problem-1",
      mechanism: "Queue reconciliation",
      description: "Reconcile claim states before submission.",
      respectsOffLimits: true,
      respectsOffLimitsWhy: "No prohibited mechanism.",
      outcomes: [
        { id: "outcome-1", solutionId: "solution-1", description: "Retries fall.", direction: "positive", affects: "sellers", addressesCore: true },
        { id: "outcome-2", solutionId: "solution-1", description: "Setup consumes time.", direction: "negative", affects: "builders", addressesCore: false },
      ],
      risks: [{
        id: "risk-1",
        solutionId: "solution-1",
        description: "The platform removes access.",
        likelihood: "likely",
        impact: "project ends",
        sortKey: 12,
      }],
      mitigations: [{
        id: "mitigation-1",
        solutionId: "solution-1",
        riskIds: ["risk-1"],
        approach: "Maintain export ingestion",
        cost: "Two days",
        failsIf: "Exports are disabled",
      }],
    }],
  };
}
