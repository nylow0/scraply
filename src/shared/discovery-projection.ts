import type { DiscoveryDepth } from "./schemas";
import { candidateAssessmentProjection } from "./evidence-investigators";

export const DISCOVERY_DEPTHS = {
  quick: { queriesPerMode: 3, searchResultsPerQuery: 4, factorCap: 30, candidateLimit: 3 },
  standard: { queriesPerMode: 6, searchResultsPerQuery: 5, factorCap: 80, candidateLimit: 4 },
  deep: { queriesPerMode: 10, searchResultsPerQuery: 6, factorCap: 150, candidateLimit: 8 },
} as const;

export const SOURCE_BATCH_CHARACTERS = 60_000;
export const AUDIENCE_SOURCE_BATCH_CHARACTERS = 30_000;
export const SOURCE_MAX_CHARACTERS = 6_000;
export const DEFAULT_PROBLEM_CANDIDATE_LIMIT = DISCOVERY_DEPTHS.standard.candidateLimit;
export const MAX_FRAME_AREAS = 12;
export const FRAME_SCAN_SEARCHES_PER_AREA = 2;
export const FRAME_SCAN_FACTORS_PER_AREA = 6;
export const FRAME_INVESTIGATOR_COUNTS = { quick: 1, standard: 3, deep: 4 } as const;

/** The launch cannot know the proposed areas yet, so reserve for the schema's maximum breadth. */
export function framedDiscoveryProjection(depth: DiscoveryDepth, languageCount = 3): { searches: number; modelCalls: number; factorCap: number } {
  const config = DISCOVERY_DEPTHS[depth];
  const languages = Math.max(1, Math.min(3, Math.floor(languageCount)));
  // Either question in each scan can be firsthand, with two physical legs in each approved language.
  const physicalLegsPerMode = config.queriesPerMode * 2 * languages;
  const investigators = FRAME_INVESTIGATOR_COUNTS[depth];
  const assessment = candidateAssessmentProjection(depth);
  const harvestCalls = Math.ceil(Math.min(Math.ceil(config.factorCap / 2), physicalLegsPerMode * config.searchResultsPerQuery) / 3) * 2;
  return {
    searches: MAX_FRAME_AREAS * FRAME_SCAN_SEARCHES_PER_AREA * 2 * languages
      + (physicalLegsPerMode * 2 + config.candidateLimit * assessment.searches + 3) * investigators,
    // Scans read at most three sources per phase, so extra search legs do not add extraction calls.
    // The area gap adds one map, up to three harvests, and one synthesis for unused candidate slots.
    modelCalls: MAX_FRAME_AREAS * 4 + 1 + (2 + harvestCalls + 1 + config.candidateLimit * assessment.modelCalls + 5) * investigators,
    factorCap: MAX_FRAME_AREAS * FRAME_SCAN_FACTORS_PER_AREA + config.factorCap * investigators,
  };
}

/** Kept free of node-only imports so the renderer and backend use the same runtime estimate. */
export function discoveryRunProjection(
  depth: DiscoveryDepth,
  candidateLimit: number = DISCOVERY_DEPTHS[depth].candidateLimit,
  languageCount = 1,
  routedSearches = true,
): { searches: number; modelCalls: number; factorCap: number } {
  const config = DISCOVERY_DEPTHS[depth];
  // Planning covers at least three evidence intents; firsthand questions have two search legs.
  const pairedFirsthandQuestions = Math.ceil(config.queriesPerMode / 3);
  const languages = Math.max(1, Math.min(3, Math.floor(languageCount)));
  const searchesPerMode = routedSearches ? config.queriesPerMode + pairedFirsthandQuestions
    + pairedFirsthandQuestions * 3 * (languages - 1) : config.queriesPerMode;
  const domainBatches = Math.max(1, Math.ceil(
    (searchesPerMode * config.searchResultsPerQuery * SOURCE_MAX_CHARACTERS) / SOURCE_BATCH_CHARACTERS,
  ));
  const audienceBatches = Math.max(1, Math.ceil(
    (searchesPerMode * config.searchResultsPerQuery * SOURCE_MAX_CHARACTERS) / AUDIENCE_SOURCE_BATCH_CHARACTERS,
  ));
  return {
    searches: searchesPerMode * 2 + candidateLimit,
    modelCalls: 2 + domainBatches + audienceBatches + 1 + candidateLimit,
    factorCap: config.factorCap,
  };
}
