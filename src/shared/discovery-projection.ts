import type { DiscoveryDepth } from "./schemas";

export const DISCOVERY_DEPTHS = {
  quick: { queriesPerMode: 3, searchResultsPerQuery: 4, factorCap: 30 },
  standard: { queriesPerMode: 6, searchResultsPerQuery: 5, factorCap: 80 },
  deep: { queriesPerMode: 10, searchResultsPerQuery: 6, factorCap: 150 },
} as const;

export const SOURCE_BATCH_CHARACTERS = 60_000;
export const SOURCE_MAX_CHARACTERS = 6_000;
export const DEFAULT_PROBLEM_CANDIDATE_LIMIT = 4;

/** Kept free of node-only imports so the renderer and backend use the same runtime estimate. */
export function discoveryRunProjection(
  depth: DiscoveryDepth,
  candidateLimit = DEFAULT_PROBLEM_CANDIDATE_LIMIT,
): { searches: number; modelCalls: number; factorCap: number } {
  const config = DISCOVERY_DEPTHS[depth];
  const batchesPerMode = Math.max(1, Math.ceil(
    (config.queriesPerMode * config.searchResultsPerQuery * SOURCE_MAX_CHARACTERS) / SOURCE_BATCH_CHARACTERS,
  ));
  return {
    searches: config.queriesPerMode * 2 + candidateLimit,
    modelCalls: 2 + batchesPerMode * 2 + 1 + candidateLimit,
    factorCap: config.factorCap,
  };
}
