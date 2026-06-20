import { randomUUID } from "node:crypto";
import type { EmbeddingsClient } from "../models/embeddings";
import { loadStore, saveStore } from "../store/json";
import {
  DirectorIdeaInputSchema,
  StoredIdeaSchema,
  type DirectorIdeaInput,
  type IdeaBucketSchema,
  type IdeaScoresSchema,
  type StoredClaim,
  type StoredIdea,
} from "../store/schema";
import type { z } from "zod";

type IdeaScores = z.infer<typeof IdeaScoresSchema>;
type IdeaBucket = z.infer<typeof IdeaBucketSchema>;

export interface DroppedDuplicate {
  title: string;
  duplicateOf: string;
  similarity: number;
}

export interface AddIdeasResult {
  added: StoredIdea[];
  droppedDuplicates: DroppedDuplicate[];
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) throw new Error("Cannot compare incompatible embeddings");
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftMagnitude += a * a;
    rightMagnitude += b * b;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

function maxSimilarity(vector: number[], candidates: Array<{ embedding: number[] }>): number {
  return candidates.reduce((best, candidate) => Math.max(best, cosineSimilarity(vector, candidate.embedding)), 0);
}

function semanticScore(vector: number[], claims: StoredClaim[]): number {
  return clamp(maxSimilarity(vector, claims));
}

function scoreIdea(
  vector: number[],
  briefVector: number[],
  claims: StoredClaim[],
  noveltyComparators: Array<{ embedding: number[] }>,
): IdeaScores {
  const painClaims = claims.filter((claim) => claim.streamLens === "pain-gaps");
  const exemplarClaims = claims.filter((claim) => claim.streamLens === "exemplars");
  return {
    relevance: clamp((cosineSimilarity(vector, briefVector) + 1) / 2),
    novelty: clamp(1 - maxSimilarity(vector, [...noveltyComparators, ...exemplarClaims])),
    demand: semanticScore(vector, painClaims),
    supply: semanticScore(vector, exemplarClaims),
  };
}

export function assignBucket(scores: IdeaScores): IdeaBucket {
  if (scores.novelty >= 0.75) return "creative-outlier";
  if (scores.demand >= 0.6 && scores.supply <= 0.45 && scores.relevance >= 0.55) return "sweet-spot";
  return "safe-bet";
}

function roundScores(scores: IdeaScores): IdeaScores {
  return Object.fromEntries(Object.entries(scores).map(([key, value]) => [key, Number(value.toFixed(4))])) as IdeaScores;
}

export async function addIdeas(
  storePath: string,
  nodeId: string,
  rawIdeas: DirectorIdeaInput[],
  options: { embeddings: EmbeddingsClient; duplicateThreshold?: number; idFactory?: () => string },
): Promise<AddIdeasResult> {
  const ideas = rawIdeas.map((idea) => DirectorIdeaInputSchema.parse(idea));
  const store = await loadStore(storePath);
  const nodeIndex = store.nodes.findIndex((node) => node.id === nodeId);
  const node = store.nodes[nodeIndex];
  if (!node || nodeIndex === -1) throw new Error(`Unknown node: ${nodeId}`);
  const claimIds = new Set(store.claims.filter((claim) => claim.nodeId === nodeId).map((claim) => claim.id));
  for (const idea of ideas) {
    const unknown = idea.supportingClaimIds.find((id) => !claimIds.has(id));
    if (unknown) throw new Error(`Idea cites unknown claim for node ${nodeId}: ${unknown}`);
  }
  if (ideas.length === 0) return { added: [], droppedDuplicates: [] };

  const texts = [
    [node.brief.topic, node.brief.objective, node.brief.audience, ...node.brief.constraints].filter(Boolean).join("\n"),
    ...ideas.map((idea) => `${idea.title}\n${idea.description}`),
  ];
  const embedded = await options.embeddings.embed(texts);
  if (embedded.vectors.length !== texts.length) throw new Error("Embedding count does not match idea input count");
  const briefVector = embedded.vectors[0];
  if (!briefVector) throw new Error("Brief embedding is missing");

  const threshold = options.duplicateThreshold ?? 0.92;
  const idFactory = options.idFactory ?? randomUUID;
  const existingIdeas = [...store.ideas];
  const accepted: StoredIdea[] = [];
  const droppedDuplicates: DroppedDuplicate[] = [];
  const nodeClaims = store.claims.filter((claim) => claim.nodeId === nodeId);

  for (let index = 0; index < ideas.length; index += 1) {
    const input = ideas[index];
    const vector = embedded.vectors[index + 1];
    if (!input || !vector) throw new Error("Idea embedding is missing");
    const comparators = [...existingIdeas, ...accepted];
    const duplicate = comparators
      .map((candidate) => ({ candidate, similarity: cosineSimilarity(vector, candidate.embedding) }))
      .sort((left, right) => right.similarity - left.similarity)[0];
    if (duplicate && duplicate.similarity >= threshold) {
      droppedDuplicates.push({
        title: input.title,
        duplicateOf: duplicate.candidate.id,
        similarity: Number(duplicate.similarity.toFixed(4)),
      });
      continue;
    }
    const scores = roundScores(scoreIdea(vector, briefVector, nodeClaims, comparators));
    accepted.push(StoredIdeaSchema.parse({
      id: `i_${idFactory()}`,
      nodeId,
      ...input,
      embedding: vector,
      scores,
      bucket: assignBucket(scores),
      rating: null,
    }));
  }

  store.ideas.push(...accepted);
  store.nodes[nodeIndex] = {
    ...node,
    status: accepted.length > 0 ? "ideated" : node.status,
    ideaIds: [...node.ideaIds, ...accepted.map((idea) => idea.id)],
    updatedAt: new Date().toISOString(),
  };
  await saveStore(storePath, store);
  return { added: accepted, droppedDuplicates };
}

