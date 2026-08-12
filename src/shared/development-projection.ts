export const MAX_DEVELOPMENT_SOLUTIONS = 5;

export function developmentProjection(solutionCount: number): number {
  if (!Number.isInteger(solutionCount) || solutionCount < 0) {
    throw new Error("solutionCount must be a non-negative integer");
  }
  // Solutions + batched outcome judge, then outcomes/risks/scores/mitigations per solution.
  return 2 + solutionCount * 4;
}

export const MAX_DEVELOPMENT_PROJECTED_CALLS = developmentProjection(MAX_DEVELOPMENT_SOLUTIONS);
