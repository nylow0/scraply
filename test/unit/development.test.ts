import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import {
  developmentProjection,
  riskSortKey,
  runDevelopment,
} from "../../src/core/development";
import type { StructuredModelClient } from "../../src/providers/structured";
import {
  MitigationsOutputSchema,
  OutcomeJudgeOutputSchema,
  OutcomesOutputSchema,
  RisksOutputSchema,
  RiskScoreOutputSchema,
  SolutionsOutputSchema,
} from "../../src/shared/structured-output-schemas";

describe("Phase 2 development", () => {
  test("builds the complete chain with an independent outcome judgment", async () => {
    const judgeInputs: string[] = [];
    let solutionInput = "";
    const result = await runDevelopment(scope(), problem(), factors(), {
      model: "test-model",
      modelClient: modelClient((user, schema) => {
        if (schema._def === SolutionsOutputSchema._def) solutionInput = user;
        return successfulCompletion(user, schema, judgeInputs);
      }),
    });

    expect(result.modelCalls).toBe(14);
    expect(result.solutions).toHaveLength(3);
    expect(result.solutions.every((solution) => solution.outcomes.length === 4)).toBe(true);
    expect(result.solutions.every((solution) => solution.outcomes.some((outcome) => outcome.direction === "negative"))).toBe(true);
    expect(result.solutions.every((solution) => solution.risks[0]?.impact === "project ends")).toBe(true);
    expect(result.solutions.every((solution) => solution.mitigations[0]?.riskIds.length === 2)).toBe(true);
    expect(judgeInputs).toHaveLength(1);
    expect(judgeInputs[0]).toContain(problem().statement);
    expect(judgeInputs[0]).not.toContain("Mechanism 1");
    expect(judgeInputs[0]).not.toContain("Build approach 1");
    expect(solutionInput).toContain('"audience":"Independent sellers"');
    expect(solutionInput).toContain('"domain":"Claims operations"');
    expect(solutionInput).toContain('"observations":"Claims are repeatedly filed."');
  });

  test("retries when a response fails a stage-level semantic constraint", async () => {
    let solutionCalls = 0;
    const result = await runDevelopment(scope(), problem(), factors(), {
      model: "test-model",
      modelClient: modelClient((user, schema) => {
        if (schema._def === SolutionsOutputSchema._def && solutionCalls++ === 0) {
          return schema.parse({ solutions: Array.from({ length: 2 }, (_, index) => ({
            mechanism: `Incomplete mechanism ${index + 1}`,
            description: `Incomplete approach ${index + 1}`,
            respectsOffLimits: true,
            respectsOffLimitsWhy: "It does not require lending.",
          })) });
        }
        return successfulCompletion(user, schema);
      }),
    });

    expect(solutionCalls).toBe(2);
    expect(result.modelCalls).toBe(15);
    expect(result.solutions).toHaveLength(3);
  });

  test("retries when dynamic outcome IDs do not match", async () => {
    let judgeCalls = 0;
    const result = await runDevelopment(scope(), problem(), factors(), {
      model: "test-model",
      modelClient: modelClient((user, schema) => {
        if (schema._def === OutcomeJudgeOutputSchema._def && judgeCalls++ === 0) {
          const outcomes = parseAfter<Array<{ id: string }>>(user, "Outcomes: ");
          return schema.parse({ judgments: outcomes.map((_, index) => ({
            outcomeId: `unknown-${index}`,
            addressesCore: false,
          })) });
        }
        return successfulCompletion(user, schema);
      }),
    });

    expect(judgeCalls).toBe(2);
    expect(result.modelCalls).toBe(15);
    expect(result.solutions.every((solution) => solution.outcomes.every((outcome) => typeof outcome.addressesCore === "boolean"))).toBe(true);
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
  user: string,
  schema: z.ZodTypeAny,
  judgeInputs?: string[],
): unknown {
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
    judgeInputs?.push(user);
    const outcomes = parseAfter<Array<{ id: string }>>(user, "Outcomes: ");
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
    const risks = parseAfter<Array<{ id: string }>>(user, "Risks: ");
    return schema.parse({ scores: [
      { riskId: risks[0]!.id, likelihood: "possible", impact: "project ends" },
      { riskId: risks[1]!.id, likelihood: "likely", impact: "~2 weeks" },
    ] });
  }
  if (schema._def === MitigationsOutputSchema._def) {
    const risks = parseAfter<Array<{ id: string }>>(user, "Ranked risks (all project-ends risks included): ");
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
  completion: (user: string, schema: z.ZodTypeAny) => unknown | Promise<unknown>,
): StructuredModelClient {
  return {
    async structuredCompletion<T>(
      _model: string,
      _system: string,
      user: string,
      schema: z.ZodType<T>,
    ): Promise<T> {
      return await completion(user, schema) as T;
    },
  };
}

function parseAfter<T>(value: string, marker: string): T {
  const start = value.indexOf(marker);
  if (start < 0) throw new Error(`Marker not found: ${marker}`);
  return JSON.parse(value.slice(start + marker.length)) as T;
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
