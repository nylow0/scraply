import { describe, expect, test } from "bun:test";
import {
  developmentProjection,
  riskSortKey,
  runDevelopment,
} from "../../src/core/development";
import type { StructuredModelClient, StructuredStageRequest } from "../../src/providers/structured";
import {
  MitigationsOutputSchema,
  OutcomeJudgeOutputSchema,
  OutcomesOutputSchema,
  RisksOutputSchema,
  RiskScoreOutputSchema,
  SolutionsOutputSchema,
} from "../../src/shared/structured-output-schemas";

describe("development", () => {
  const model = { providerId: "test-provider", modelId: "test-model" };
  const reasoningEffort = "medium" as const;
  test("builds the complete chain with an independent outcome judgment", async () => {
    const judgeInputs: unknown[] = [];
    let solutionInput: unknown;
    const result = await runDevelopment(scope(), problem(), factors(), {
      model,
      reasoningEffort,
      modelClient: modelClient((request) => {
        if (request.schema._def === SolutionsOutputSchema._def) solutionInput = request.evidence[0]!.content;
        return successfulCompletion(request, judgeInputs);
      }),
    });

    expect(result.modelCalls).toBe(14);
    expect(result.solutions).toHaveLength(3);
    expect(result.solutions.every((solution) => solution.outcomes.length === 4)).toBe(true);
    expect(result.solutions.every((solution) => solution.outcomes.some((outcome) => outcome.direction === "negative"))).toBe(true);
    expect(result.solutions.every((solution) => solution.risks[0]?.impact === "project ends")).toBe(true);
    expect(result.solutions.every((solution) => solution.mitigations[0]?.riskIds.length === 2)).toBe(true);
    expect(judgeInputs).toHaveLength(1);
    expect(JSON.stringify(judgeInputs[0])).toContain(problem().statement);
    expect(JSON.stringify(judgeInputs[0])).not.toContain("Mechanism 1");
    expect(JSON.stringify(judgeInputs[0])).not.toContain("Build approach 1");
    expect(solutionInput).toMatchObject({ researchContext: {
      audience: "Independent sellers",
      domain: "Claims operations",
      observations: "Claims are repeatedly filed.",
    } });
  });

  test("surfaces a stage semantic failure without an app-owned retry", async () => {
    let solutionCalls = 0;
    const run = runDevelopment(scope(), problem(), factors(), {
      model,
      reasoningEffort,
      modelClient: modelClient((request) => {
        if (request.schema._def === SolutionsOutputSchema._def) {
          solutionCalls += 1;
          return request.schema.parse({ solutions: Array.from({ length: 2 }, (_, index) => ({
            mechanism: `Incomplete mechanism ${index + 1}`,
            description: `Incomplete approach ${index + 1}`,
            respectsOffLimits: true,
            respectsOffLimitsWhy: "It does not require lending.",
          })) });
        }
        return successfulCompletion(request);
      }),
    });

    await expect(run).rejects.toMatchObject({ code: "schema" });
    expect(solutionCalls).toBe(1);
  });

  test("surfaces mismatched dynamic outcome IDs without an app-owned retry", async () => {
    let judgeCalls = 0;
    const run = runDevelopment(scope(), problem(), factors(), {
      model,
      reasoningEffort,
      modelClient: modelClient((request) => {
        if (request.schema._def === OutcomeJudgeOutputSchema._def) {
          judgeCalls += 1;
          const outcomes = (request.evidence[0]!.content as { outcomes: Array<{ id: string }> }).outcomes;
          return request.schema.parse({ judgments: outcomes.map((_, index) => ({
            outcomeId: `unknown-${index}`,
            addressesCore: false,
          })) });
        }
        return successfulCompletion(request);
      }),
    });

    await expect(run).rejects.toMatchObject({ code: "schema" });
    expect(judgeCalls).toBe(1);
  });

  test("uses a stipulated ordering and projects the real call fan-out", () => {
    expect(riskSortKey("rare", "≤3 days lost")).toBe(1);
    expect(riskSortKey("possible", "project ends")).toBe(8);
    expect(riskSortKey("likely", "~2 months")).toBe(9);
    expect(developmentProjection(3)).toBe(14);
    expect(developmentProjection(5)).toBe(22);
  });
});

function successfulCompletion(
  request: StructuredStageRequest<unknown>,
  judgeInputs?: unknown[],
): unknown {
  const schema = request.schema;
  if (schema._def === SolutionsOutputSchema._def) {
    return schema.parse({ solutions: Array.from({ length: 3 }, (_, index) => ({
      mechanism: `Mechanism ${index + 1}`,
      description: `Build approach ${index + 1}`,
      respectsOffLimits: true,
      respectsOffLimitsWhy: "It does not require lending.",
    })) });
  }
  if (schema._def === OutcomesOutputSchema._def) {
    return schema.parse({ outcomes: [
      { description: "Processing time falls", direction: "positive", affects: "operators" },
      { description: "Errors become visible", direction: "positive", affects: "owners" },
      { description: "Setup takes time", direction: "negative", affects: "builders" },
      { description: "Reviews happen earlier", direction: "positive", affects: "reviewers" },
    ] });
  }
  if (schema._def === OutcomeJudgeOutputSchema._def) {
    judgeInputs?.push(request.evidence[0]!.content);
    const outcomes = (request.evidence[0]!.content as { outcomes: Array<{ id: string }> }).outcomes;
    return schema.parse({ judgments: outcomes.map((outcome, index) => ({
      outcomeId: outcome.id,
      addressesCore: index % 2 === 0,
    })) });
  }
  if (schema._def === RisksOutputSchema._def) {
    return schema.parse({ risks: [
      { description: "A platform blocks access" },
      { description: "Adoption stalls" },
    ] });
  }
  if (schema._def === RiskScoreOutputSchema._def) {
    const risks = (request.evidence[0]!.content as { risks: Array<{ id: string }> }).risks;
    return schema.parse({ scores: [
      { riskId: risks[0]!.id, likelihood: "possible", impact: "project ends" },
      { riskId: risks[1]!.id, likelihood: "likely", impact: "~2 weeks" },
    ] });
  }
  if (schema._def === MitigationsOutputSchema._def) {
    const risks = (request.evidence[0]!.content as { rankedRisks: Array<{ id: string }> }).rankedRisks;
    return schema.parse({ mitigations: [{
      riskIds: risks.map((risk) => risk.id),
      approach: "Keep a manual export path",
      cost: "Two days",
      failsIf: "The platform also blocks exports",
    }] });
  }
  throw new Error("Unexpected schema");
}

function modelClient(
  completion: (request: StructuredStageRequest<unknown>) => unknown | Promise<unknown>,
): StructuredModelClient {
  return {
    async structuredCompletion<T>(request: StructuredStageRequest<T>) {
      return {
        output: await completion(request as StructuredStageRequest<unknown>) as T,
        metadata: { model: request.model, usage: { status: "unknown" }, latencyMs: 1, repairCount: 0, providerRequestIds: [], attempts: [] },
      };
    },
  };
}

function scope() {
  return {
    title: "Marketplace reimbursement",
    audience: "Independent sellers",
    domain: "Claims operations",
    observations: "Claims are repeatedly filed.",
    offLimits: ["No lending"],
  };
}

function problem() {
  return {
    id: "problem-1",
    statement: "Sellers repeatedly file the same claim.",
    whyItPersists: "Systems do not share state.",
    affected: "Independent sellers",
    scaleEstimate: "Weekly",
    scaleBasisFactorId: "factor-1",
    factorIds: ["factor-1"],
    verdict: "confirmed" as const,
    verdictReason: "Contrary evidence did not kill it.",
    verdictSourceIds: [],
  };
}

function factors() {
  return [{
    id: "factor-1",
    subject: "Sellers",
    behavior: "repeat claims",
    quote: "I filed it three times.",
    sourceId: "source-1",
    harvestMode: "audience" as const,
    modelConfidence: 0.8,
  }];
}
