import type { ResearchFrame } from "../shared/research-frame";
import { frameNeedsNoveltySearch } from "../shared/solution-goal-fit";
import type { SolutionSetItem } from "./solution-set-review";
import { WorkflowGenerationEvidenceSchema } from "./development";
import type { z } from "zod";

export type NoveltyEvidence = z.infer<typeof WorkflowGenerationEvidenceSchema>;
export interface NoveltySearchDependencies {
  loadCompleted: (key: string) => NoveltyEvidence | undefined;
  wasStarted: (key: string) => boolean;
  reserveSearch: (query: string) => Promise<void> | void;
  markStarted: (key: string, query: string) => Promise<void> | void;
  search: (query: string, limit: number) => Promise<NoveltyEvidence>;
  saveCompleted: (key: string, query: string, evidence: NoveltyEvidence) => Promise<void> | void;
}

/** One saved existing-tools search per idea. A lost completion requires acknowledgement, never replay. */
export async function ensureSolutionNoveltyEvidence(
  frame: ResearchFrame,
  candidate: SolutionSetItem,
  dependencies: NoveltySearchDependencies,
): Promise<NoveltyEvidence> {
  if (!frameNeedsNoveltySearch(frame)) return [];
  const key = `solution-novelty:${candidate.id}`;
  const completed = dependencies.loadCompleted(key);
  if (completed !== undefined) return WorkflowGenerationEvidenceSchema.parse(completed);
  if (dependencies.wasStarted(key)) {
    throw new Error("The existing-tools search completion is unknown. Acknowledge the interrupted search before retrying it.");
  }
  const query = `${candidate.option.mechanism.replace(/[\r\n\t]/g, " ").slice(0, 220)} existing tools alternatives comparison`;
  await dependencies.reserveSearch(query);
  await dependencies.markStarted(key, query);
  const evidence = WorkflowGenerationEvidenceSchema.parse(await dependencies.search(query, 5));
  await dependencies.saveCompleted(key, query, evidence);
  return evidence;
}
