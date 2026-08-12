import { randomUUID } from "node:crypto";
import type { DevelopmentRepository } from "../db/repositories/development";
import { ProviderFailure, type StructuredModelClient } from "../providers/structured";
import { developmentProjection } from "../shared/development-projection";
export { developmentProjection } from "../shared/development-projection";
import { deriveJsonSchema } from "../shared/json-schema";
import {
  MitigationsOutputSchema,
  OutcomeJudgeOutputSchema,
  OutcomesOutputSchema,
  RisksOutputSchema,
  RiskScoreOutputSchema,
  SolutionsOutputSchema,
  type Factor,
  type Outcome,
  type Problem,
  type ProposedMitigation,
  type Risk,
  type Scope,
  type Solution,
} from "../shared/structured-output-schemas";
import { loadPrompt } from "./prompts";

export interface DevelopmentProblem extends Problem {
  id: string;
}

export interface DevelopmentFactor extends Factor {
  id: string;
}

export interface DevelopedOutcome extends Outcome {
  id: string;
}

export interface DevelopedRisk extends Risk {
  id: string;
}

export interface DevelopedMitigation extends ProposedMitigation {
  id: string;
}

export interface DevelopedSolution extends Solution {
  id: string;
  outcomes: DevelopedOutcome[];
  risks: DevelopedRisk[];
  mitigations: DevelopedMitigation[];
}

export interface DevelopmentResult {
  scope: Scope;
  problem: DevelopmentProblem;
  factors: DevelopmentFactor[];
  solutions: DevelopedSolution[];
  modelCalls: number;
}

export interface DevelopmentDependencies {
  modelClient: StructuredModelClient;
  model: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  stageWriter?: {
    persistSolutions(problemId: string, solutions: DevelopedSolution[]): void;
    persistOutcomes(outcomes: DevelopedOutcome[]): void;
    persistRiskAnalysis(solutionId: string, risks: DevelopedRisk[], mitigations: DevelopedMitigation[]): void;
  };
}

export interface PersistedDevelopmentDependencies extends DevelopmentDependencies {
  repository: DevelopmentRepository;
  researchRunId: string;
}

const LIKELIHOOD_ORDER = { rare: 1, possible: 2, likely: 3 } as const;
const IMPACT_ORDER = { "≤3 days lost": 1, "~2 weeks": 2, "~2 months": 3, "project ends": 4 } as const;

export function riskSortKey(
  likelihood: keyof typeof LIKELIHOOD_ORDER,
  impact: keyof typeof IMPACT_ORDER,
): number {
  return LIKELIHOOD_ORDER[likelihood] * IMPACT_ORDER[impact];
}

export async function runDevelopment(
  scope: Scope,
  problem: DevelopmentProblem,
  factors: DevelopmentFactor[],
  dependencies: DevelopmentDependencies,
): Promise<DevelopmentResult> {
  let modelCalls = 0;
  const call: StructuredCall = async <T, R = T>(
    system: string,
    user: string,
    schema: import("zod").z.ZodType<T>,
    validate?: (value: T) => R,
  ): Promise<R> => {
    const execute = async (): Promise<R> => {
      modelCalls += 1;
      const value = await dependencies.modelClient.structuredCompletion(
        dependencies.model,
        system,
        user,
        schema,
        deriveJsonSchema(schema),
        dependencies.signal ? { signal: dependencies.signal } : {},
      );
      return validate ? validate(value) : value as unknown as R;
    };
    try {
      return await execute();
    } catch (error) {
      if (error instanceof ProviderFailure && error.code === "schema") return execute();
      throw error;
    }
  };

  const solutions = await generateSolutions(scope, problem, factors, call);
  dependencies.stageWriter?.persistSolutions(
    problem.id,
    solutions.map((solution) => ({ ...solution, outcomes: [], risks: [], mitigations: [] })),
  );
  dependencies.onProgress?.(
    `Stage 3 produced ${solutions.length} solutions; projected total: ~${developmentProjection(solutions.length)} model calls before schema retries.`,
  );
  const outcomes = await generateOutcomes(problem, solutions, call);
  dependencies.stageWriter?.persistOutcomes([...outcomes.values()].flat());
  const developed: DevelopedSolution[] = [];
  for (const solution of solutions) {
    const solutionOutcomes = outcomes.get(solution.id) ?? [];
    const analysis = await generateRiskAnalysis(solution, solutionOutcomes, call);
    dependencies.stageWriter?.persistRiskAnalysis(solution.id, analysis.risks, analysis.mitigations);
    developed.push({ ...solution, outcomes: solutionOutcomes, ...analysis });
  }
  return { scope, problem, factors, solutions: developed, modelCalls };
}

export async function runPersistedDevelopment(
  problemId: string,
  dependencies: PersistedDevelopmentDependencies,
): Promise<DevelopmentResult> {
  const context = dependencies.repository.loadContext(problemId);
  if (!context) throw new Error(`Problem not found: ${problemId}`);
  dependencies.repository.attachProblem(dependencies.researchRunId, problemId);
  return runDevelopment(context.scope, context.problem, context.factors, {
    ...dependencies,
    stageWriter: {
      persistSolutions: (targetProblemId, solutions) =>
        dependencies.repository.persistSolutions(dependencies.researchRunId, targetProblemId, solutions),
      persistOutcomes: (outcomes) =>
        dependencies.repository.persistOutcomes(dependencies.researchRunId, outcomes),
      persistRiskAnalysis: (solutionId, risks, mitigations) =>
        dependencies.repository.persistRiskAnalysis(dependencies.researchRunId, solutionId, risks, mitigations),
    },
  });
}

type StructuredCall = <T, R = T>(
  system: string,
  user: string,
  schema: import("zod").z.ZodType<T>,
  validate?: (value: T) => R,
) => Promise<R>;

async function generateSolutions(
  scope: Scope,
  problem: DevelopmentProblem,
  factors: DevelopmentFactor[],
  call: StructuredCall,
): Promise<Array<Solution & { id: string }>> {
  return call(
    loadPrompt("solutions", "Propose distinct mechanisms for the supplied problem."),
    [
      `Problem: ${problem.statement}`,
      `Off limits: ${JSON.stringify(scope.offLimits)}`,
      `Optional factors: ${JSON.stringify(factors.map(({ id, subject, behavior, quote, sourceId }) => ({ id, subject, behavior, quote, sourceId })))}`,
    ].join("\n\n"),
    SolutionsOutputSchema,
    (response) => {
      if (response.solutions.length < 3 || response.solutions.length > 5) {
        throw schemaFailure(`Stage 3 returned ${response.solutions.length} solutions; expected 3–5`);
      }
      return response.solutions.map((solution) => ({ ...solution, id: randomUUID(), problemId: problem.id }));
    },
  );
}

async function generateOutcomes(
  problem: DevelopmentProblem,
  solutions: Array<Solution & { id: string }>,
  call: StructuredCall,
): Promise<Map<string, DevelopedOutcome[]>> {
  const unjudged = new Map<string, Array<Omit<DevelopedOutcome, "addressesCore">>>();
  for (const solution of solutions) {
    const outcomeDrafts = await call(
      loadPrompt("outcomes", "Describe the important positive and negative outcomes."),
      `Solution: ${JSON.stringify({ id: solution.id, mechanism: solution.mechanism, description: solution.description })}`,
      OutcomesOutputSchema,
      (response) => {
        if (response.outcomes.length < 4 || response.outcomes.length > 8) {
          throw schemaFailure(`Stage 4 returned ${response.outcomes.length} outcomes for solution ${solution.id}; expected 4–8`);
        }
        if (!response.outcomes.some((outcome) => outcome.direction === "negative")) {
          throw schemaFailure(`Stage 4 returned no negative outcome for solution ${solution.id}`);
        }
        return response.outcomes;
      },
    );
    unjudged.set(solution.id, outcomeDrafts.map((outcome) => ({
      ...outcome,
      id: randomUUID(),
      solutionId: solution.id,
    })));
  }

  const allOutcomes = [...unjudged.values()].flat();
  const judgments = await call(
    loadPrompt("outcome-judge", "Judge whether each outcome makes the problem less true."),
    [
      `Problem statement: ${problem.statement}`,
      `Outcomes: ${JSON.stringify(allOutcomes.map(({ id, description }) => ({ id, description })))}`,
    ].join("\n\n"),
    OutcomeJudgeOutputSchema,
    (response) => exactIdMap(
      allOutcomes.map((outcome) => outcome.id),
      response.judgments,
      (item) => item.outcomeId,
      "outcome judgments",
    ),
  );
  return new Map([...unjudged].map(([solutionId, items]) => [
    solutionId,
    items.map((outcome) => ({ ...outcome, addressesCore: judgments.get(outcome.id)!.addressesCore })),
  ]));
}

async function generateRiskAnalysis(
  solution: Solution & { id: string },
  outcomes: DevelopedOutcome[],
  call: StructuredCall,
): Promise<{ risks: DevelopedRisk[]; mitigations: DevelopedMitigation[] }> {
  const generated = await call(
    loadPrompt("risks", "Generate consequential failure modes from three risk framings."),
    [
      `Solution: ${JSON.stringify({ id: solution.id, mechanism: solution.mechanism, description: solution.description })}`,
      `Outcomes: ${JSON.stringify(outcomes.map(({ description, direction, affects }) => ({ description, direction, affects })))}`,
    ].join("\n\n"),
    RisksOutputSchema,
  );
  const riskDrafts = generated.risks.map((risk) => ({ id: randomUUID(), description: risk.description }));
  if (riskDrafts.length === 0) return { risks: [], mitigations: [] };

  const scores = await call(
    loadPrompt("risk-score", "Evaluate each supplied risk independently."),
    `Risks: ${JSON.stringify(riskDrafts)}`,
    RiskScoreOutputSchema,
    (response) => exactIdMap(riskDrafts.map((risk) => risk.id), response.scores, (item) => item.riskId, "risk scores"),
  );
  const risks = riskDrafts.map((risk): DevelopedRisk => {
    const score = scores.get(risk.id)!;
    return {
      ...risk,
      solutionId: solution.id,
      likelihood: score.likelihood,
      impact: score.impact,
      sortKey: riskSortKey(score.likelihood, score.impact),
    };
  }).sort((left, right) => right.sortKey - left.sortKey);

  const knownRiskIds = new Set(risks.map((risk) => risk.id));
  const mitigationDrafts = await call(
    loadPrompt("mitigations", "Propose responses to the ranked risk list."),
    [
      `Solution ID: ${solution.id}`,
      `Ranked risks (all project-ends risks included): ${JSON.stringify(risks)}`,
    ].join("\n\n"),
    MitigationsOutputSchema,
    (response) => response.mitigations.map((mitigation) => {
      const riskIds = [...new Set(mitigation.riskIds)];
      if (riskIds.length === 0 || riskIds.some((riskId) => !knownRiskIds.has(riskId))) {
        throw schemaFailure("A proposed mitigation linked an empty or unknown risk set");
      }
      return { ...mitigation, riskIds };
    }),
  );
  const mitigations = mitigationDrafts.map((mitigation): DevelopedMitigation => ({
    ...mitigation,
    id: randomUUID(),
    solutionId: solution.id,
  }));
  return { risks, mitigations };
}

function exactIdMap<T>(
  expectedIds: string[],
  values: T[],
  idOf: (value: T) => string,
  label: string,
): Map<string, T> {
  const expected = new Set(expectedIds);
  const result = new Map<string, T>();
  for (const value of values) {
    const id = idOf(value);
    if (!expected.has(id) || result.has(id)) throw schemaFailure(`Invalid or duplicate ID in ${label}: ${id}`);
    result.set(id, value);
  }
  if (result.size !== expected.size) throw schemaFailure(`Incomplete ${label}: received ${result.size} of ${expected.size}`);
  return result;
}

function schemaFailure(message: string): ProviderFailure {
  return new ProviderFailure("schema", message, true);
}
