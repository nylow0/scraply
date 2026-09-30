import { FRAME_SCAN_FACTORS_PER_AREA } from "../shared/discovery-projection";
import { ResearchAreaRankingSchema, scopeResearchArea, selectResearchAreas,
  type ResearchArea, type ResearchFrame } from "../shared/research-frame";
import type { Scope } from "../shared/structured-output-schemas";
import { harvestFactors, qualifiesAsIntendedBuyerObservation,
  type DiscoveryDependencies, type HarvestResult } from "./discovery";
import { frameCompletion, type ResearchFrameDependencies } from "./research-frame";

export interface AreaScan extends HarvestResult { areaId: string; qualifyingFacts: number }

/** Each area gets one query per phase and at most six retained quote-verified observations. */
export async function scanResearchArea(scope: Scope, frame: ResearchFrame, area: ResearchArea,
  dependencies: DiscoveryDependencies): Promise<AreaScan> {
  const result = await harvestFactors(scopeResearchArea(scope, area, frame), {
    ...dependencies, queryCountByMode: { domain: 1, audience: 1 }, factorCap: FRAME_SCAN_FACTORS_PER_AREA,
    // A scan is bounded even when the later investigator uses depth as guidance.
    guided: false, smallHarvestBatches: true,
  });
  return { ...result, areaId: area.id, qualifyingFacts: result.factors.filter(qualifiesAsIntendedBuyerObservation).length };
}

export async function rankScannedAreas(frame: ResearchFrame, scans: readonly AreaScan[], depth: "quick" | "standard" | "deep",
  dependencies: ResearchFrameDependencies): Promise<ResearchArea[]> {
  const ranking = await frameCompletion("area-ranking", { frame,
    scans: scans.map(scan => ({ areaId: scan.areaId, qualifyingFacts: scan.qualifyingFacts, factors: scan.factors,
      sources: scan.sources.map(source => ({ id: source.id, title: source.title, url: source.url })) })) }, [], ResearchAreaRankingSchema, dependencies);
  return selectResearchAreas(frame, ranking, Object.fromEntries(scans.map(scan => [scan.areaId, scan.qualifyingFacts])), depth);
}
