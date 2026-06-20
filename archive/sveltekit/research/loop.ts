import { randomUUID } from "node:crypto";
import type { EmbeddingsClient } from "../models/embeddings";
import type { ClaimExtractor } from "../models/opencode";
import { assertGroundedClaims, type SearchClient } from "../pipeline";
import { loadStore, saveStore } from "../store/json";
import {
  ResearchInputSchema,
  ResearchNodeSchema,
  StoredClaimSchema,
  type IntakeBrief,
  type KnowledgeStore,
  type ResearchInput,
  type ResearchNode,
  type ResearchStream,
  type StoredClaim,
} from "../store/schema";

export interface ResearchPlan {
  queries: string[];
}

export interface ResearchReflection {
  coverage: number;
  gaps: string[];
  followUpQueries: string[];
}

export interface ResearchReasoner {
  plan(brief: IntakeBrief, stream: ResearchStream): Promise<ResearchPlan>;
  reflect(input: {
    brief: IntakeBrief;
    stream: ResearchStream;
    claims: StoredClaim[];
    hop: number;
  }): Promise<ResearchReflection>;
}

export interface ResearchCosts {
  planUsd: number;
  queryUsd: number;
  reflectUsd: number;
}

export interface ResearchLoopOptions {
  storePath: string;
  search: SearchClient;
  extractor: ClaimExtractor;
  embeddings: EmbeddingsClient;
  reasoner: ResearchReasoner;
  costs?: Partial<ResearchCosts>;
  nodeId?: string;
  now?: () => Date;
  idFactory?: () => string;
}

export type InMemoryResearchLoopOptions = Omit<ResearchLoopOptions, "storePath"> & {
  persist?: (store: KnowledgeStore) => Promise<void>;
};

export interface ResearchRun {
  node: ResearchNode;
  store: KnowledgeStore;
}

const DEFAULT_COSTS: ResearchCosts = { planUsd: 0.02, queryUsd: 0.05, reflectUsd: 0.02 };

function safeCost(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid research cost: ${value}`);
  return Math.ceil(value * 1_000_000) / 1_000_000;
}

function uniqueQueries(queries: string[], limit: number): string[] {
  const seen = new Set<string>();
  return queries.filter((query) => {
    const key = query.trim().toLocaleLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit);
}

function upsertNode(store: KnowledgeStore, node: ResearchNode): void {
  const index = store.nodes.findIndex((item) => item.id === node.id);
  if (index === -1) store.nodes.push(node);
  else store.nodes[index] = node;
}

export async function runResearchNodeInStore(
  rawInput: ResearchInput,
  store: KnowledgeStore,
  options: InMemoryResearchLoopOptions,
): Promise<ResearchRun> {
  const input = ResearchInputSchema.parse(rawInput);
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;
  const configuredCosts = { ...DEFAULT_COSTS, ...options.costs };
  const costs: ResearchCosts = {
    planUsd: safeCost(configuredCosts.planUsd),
    queryUsd: safeCost(configuredCosts.queryUsd),
    reflectUsd: safeCost(configuredCosts.reflectUsd),
  };
  const nodeId = options.nodeId ?? `n_${idFactory()}`;
  if (store.nodes.some((node) => node.id === nodeId)) throw new Error(`Node already exists: ${nodeId}`);
  const timestamp = now().toISOString();
  let node = ResearchNodeSchema.parse({
    id: nodeId,
    parentId: null,
    depth: 0,
    brief: input.brief,
    stream: input.stream,
    status: "researching",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  upsertNode(store, node);

  const canSpend = (amount: number): boolean => node.spentUsd + amount <= input.brief.budgetUsd + Number.EPSILON;
  const spend = (amount: number): void => {
    node = { ...node, spentUsd: Number((node.spentUsd + amount).toFixed(6)) };
  };
  const persist = async (): Promise<void> => options.persist?.(store);
  const finish = async (stopReason: ResearchNode["stopReason"]): Promise<ResearchRun> => {
    node = ResearchNodeSchema.parse({ ...node, status: "researched", stopReason, updatedAt: now().toISOString() });
    upsertNode(store, node);
    await persist();
    return { node, store };
  };

  try {
    if (!canSpend(costs.planUsd)) return finish("budget");
    spend(costs.planUsd);
    const plan = await options.reasoner.plan(input.brief, input.stream);
    let queries = uniqueQueries(plan.queries, input.stream.maxQueriesPerHop);
    if (queries.length === 0) return finish("no-follow-ups");

    for (let hop = 1; hop <= input.stream.maxHops; hop += 1) {
      for (let queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
        if (!canSpend(costs.queryUsd)) return finish("budget");
        spend(costs.queryUsd);
        const query = queries[queryIndex];
        if (!query) continue;
        const found = await options.search.search(query);
        const sources = found.map((source) => ({
          ...source,
          id: `${nodeId}:h${hop}:q${queryIndex + 1}:${source.id}`,
        }));
        const extraction = sources.length === 0
          ? { claims: [] }
          : await options.extractor.extract(query, sources);
        assertGroundedClaims(extraction.claims, sources);
        const novelClaims = extraction.claims.filter((claim) => !store.claims.some(
          (existing) => existing.nodeId === nodeId && existing.text.trim().toLocaleLowerCase() === claim.text.trim().toLocaleLowerCase(),
        ));
        const embedded = await options.embeddings.embed(novelClaims.map((claim) => claim.text));
        if (embedded.vectors.length !== novelClaims.length) throw new Error("Embedding count does not match claim count");
        const storedClaims = novelClaims.map((claim, index) => StoredClaimSchema.parse({
          id: `c_${idFactory()}`,
          nodeId,
          streamId: input.stream.id,
          streamLens: input.stream.lens,
          ...claim,
          verified: true,
          embedding: embedded.vectors[index],
        }));
        store.sources.push(...sources);
        store.claims.push(...storedClaims);
        node = {
          ...node,
          sourceIds: [...node.sourceIds, ...sources.map((source) => source.id)],
          claimIds: [...node.claimIds, ...storedClaims.map((claim) => claim.id)],
        };
      }

      node = { ...node, hopsCompleted: hop };
      if (!canSpend(costs.reflectUsd)) return finish("budget");
      spend(costs.reflectUsd);
      const claims = store.claims.filter((claim) => claim.nodeId === nodeId);
      const reflection = await options.reasoner.reflect({ brief: input.brief, stream: input.stream, claims, hop });
      node = { ...node, coverage: reflection.coverage };
      if (reflection.coverage >= input.stream.coverageThreshold) return finish("coverage");
      if (hop === input.stream.maxHops) return finish("max-hops");
      queries = uniqueQueries(reflection.followUpQueries, input.stream.maxQueriesPerHop);
      if (queries.length === 0) return finish("no-follow-ups");
    }

    return finish("max-hops");
  } catch (error) {
    node = ResearchNodeSchema.parse({
      ...node,
      status: "research-failed",
      error: error instanceof Error ? error.message : String(error),
      updatedAt: now().toISOString(),
    });
    upsertNode(store, node);
    await persist();
    return { node, store };
  }
}

export async function runResearchNode(rawInput: ResearchInput, options: ResearchLoopOptions): Promise<ResearchRun> {
  const store = await loadStore(options.storePath);
  const { storePath, ...core } = options;
  return runResearchNodeInStore(rawInput, store, {
    ...core,
    persist: async (next) => saveStore(storePath, next),
  });
}
