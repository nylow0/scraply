import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Publisher, PublishedReport } from "../report/publisher";
import { renderFullResearchReport } from "../report/render";
import { emptyStore, loadStore, saveStore } from "../store/json";
import {
  IntakeBriefSchema,
  ResearchNodeSchema,
  type KnowledgeStore,
  type ResearchNode,
  type StreamRun,
} from "../store/schema";
import { runResearchNodeInStore, type InMemoryResearchLoopOptions } from "./loop";
import type { ResearchSynthesizer } from "./synthesis";
import { RESEARCH_STREAMS } from "./streams";

export const FullResearchInputSchema = z.object({
  brief: IntakeBriefSchema,
  maxHops: z.number().int().min(1).max(20).default(3),
  coverageThreshold: z.number().min(0).max(1).default(0.8),
  maxQueriesPerHop: z.number().int().min(1).max(10).default(3),
});

export type FullResearchInput = z.input<typeof FullResearchInputSchema>;

export interface FullResearchOptions extends Omit<InMemoryResearchLoopOptions, "nodeId" | "idFactory" | "persist"> {
  storePath: string;
  publisher: Publisher;
  synthesizer: ResearchSynthesizer;
  fallbackSynthesizer?: ResearchSynthesizer;
  synthesisCostUsd?: number;
  nodeId?: string;
  now?: () => Date;
  idFactory?: () => string;
  researchStoredNode?: boolean;
}

export interface FullResearchRun {
  node: ResearchNode;
  store: KnowledgeStore;
  publication?: PublishedReport;
}

const MICROS = 1_000_000;

function toMicros(usd: number): number {
  return Math.max(0, Math.floor((usd + Number.EPSILON) * MICROS));
}

function costMicros(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) throw new Error(`Invalid synthesis cost: ${usd}`);
  return Math.ceil(usd * MICROS);
}

function fromMicros(micros: number): number {
  return Number((micros / MICROS).toFixed(6));
}

export function allocateStreamBudgets(budgetUsd: number, synthesisCostUsd: number): {
  synthesisMicros: number;
  streamMicros: number[];
} {
  const total = toMicros(budgetUsd);
  const requestedSynthesis = costMicros(synthesisCostUsd);
  const synthesisMicros = requestedSynthesis <= total ? requestedSynthesis : 0;
  const researchMicros = total - synthesisMicros;
  const base = Math.floor(researchMicros / RESEARCH_STREAMS.length);
  const remainder = researchMicros % RESEARCH_STREAMS.length;
  return {
    synthesisMicros,
    streamMicros: RESEARCH_STREAMS.map((_, index) => base + (index < remainder ? 1 : 0)),
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function upsertNode(store: KnowledgeStore, node: ResearchNode): void {
  const index = store.nodes.findIndex((item) => item.id === node.id);
  if (index === -1) store.nodes.push(node);
  else store.nodes[index] = node;
}

export async function runFullResearch(rawInput: FullResearchInput, options: FullResearchOptions): Promise<FullResearchRun> {
  const input = FullResearchInputSchema.parse(rawInput);
  const store = await loadStore(options.storePath);
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;
  const nodeId = options.nodeId ?? `n_${idFactory()}`;
  const storedNode = store.nodes.find((item) => item.id === nodeId);
  if (storedNode && !options.researchStoredNode) throw new Error(`Node already exists: ${nodeId}`);
  if (options.researchStoredNode && !storedNode) throw new Error(`Unknown node: ${nodeId}`);
  if (storedNode && storedNode.status !== "pending") throw new Error(`Node is not pending: ${nodeId}`);
  const timestamp = now().toISOString();
  const streams = RESEARCH_STREAMS.map((stream) => ({
    ...stream,
    maxHops: input.maxHops,
    coverageThreshold: input.coverageThreshold,
    maxQueriesPerHop: input.maxQueriesPerHop,
  }));
  let node = ResearchNodeSchema.parse({
    ...(storedNode ?? {}),
    id: nodeId,
    parentId: storedNode?.parentId ?? null,
    depth: storedNode?.depth ?? 0,
    brief: input.brief,
    streams,
    status: "researching",
    createdAt: storedNode?.createdAt ?? timestamp,
    updatedAt: timestamp,
  });
  upsertNode(store, node);
  await saveStore(options.storePath, store);

  const synthesisCostUsd = options.synthesisCostUsd ?? 0.05;
  const allocation = allocateStreamBudgets(input.brief.budgetUsd, synthesisCostUsd);
  const tasks = streams.map(async (stream, streamIndex) => {
    const isolated = emptyStore();
    let claimCounter = 0;
    const run = await runResearchNodeInStore({
      brief: { ...input.brief, budgetUsd: fromMicros(allocation.streamMicros[streamIndex]!) },
      stream,
    }, isolated, {
      search: options.search,
      extractor: options.extractor,
      embeddings: options.embeddings,
      reasoner: options.reasoner,
      ...(options.costs ? { costs: options.costs } : {}),
      nodeId: `${nodeId}:${stream.id}`,
      now,
      idFactory: () => `${stream.id}_${++claimCounter}`,
    });
    return { run, stream, allocatedUsd: fromMicros(allocation.streamMicros[streamIndex]!) };
  });
  const settled = await Promise.allSettled(tasks);
  const streamRuns: StreamRun[] = [];

  for (let index = 0; index < settled.length; index += 1) {
    const result = settled[index]!;
    const stream = streams[index]!;
    const budgetUsd = fromMicros(allocation.streamMicros[index]!);
    if (result.status === "rejected") {
      streamRuns.push({ stream, status: "failed", budgetUsd, spentUsd: 0, coverage: 0, hopsCompleted: 0, sourceIds: [], claimIds: [], error: message(result.reason) });
      continue;
    }
    const { node: streamNode, store: streamStore } = result.value.run;
    const claims = streamStore.claims.map((claim) => ({ ...claim, nodeId }));
    store.sources.push(...streamStore.sources);
    store.claims.push(...claims);
    streamRuns.push({
      stream,
      status: streamNode.status === "research-failed" ? "failed" : "completed",
      budgetUsd,
      spentUsd: streamNode.spentUsd,
      coverage: streamNode.coverage,
      hopsCompleted: streamNode.hopsCompleted,
      sourceIds: streamNode.sourceIds,
      claimIds: claims.map((claim) => claim.id),
      ...(streamNode.stopReason ? { stopReason: streamNode.stopReason } : {}),
      ...(streamNode.error ? { error: streamNode.error } : {}),
    });
  }

  const completed = streamRuns.filter((run) => run.status === "completed").length;
  const streamSpentMicros = streamRuns.reduce((sum, run) => sum + toMicros(run.spentUsd), 0);
  node = ResearchNodeSchema.parse({
    ...node,
    status: completed === 6 ? "researched" : completed === 0 ? "research-failed" : "research-partial",
    streamRuns,
    spentUsd: fromMicros(streamSpentMicros),
    sourceIds: streamRuns.flatMap((run) => run.sourceIds),
    claimIds: streamRuns.flatMap((run) => run.claimIds),
    coverage: streamRuns.reduce((sum, run) => sum + run.coverage, 0) / 6,
    hopsCompleted: Math.max(0, ...streamRuns.map((run) => run.hopsCompleted)),
    updatedAt: now().toISOString(),
  });
  upsertNode(store, node);

  if (allocation.synthesisMicros === 0) {
    node = ResearchNodeSchema.parse({ ...node, status: node.status === "research-failed" ? node.status : "research-partial", synthesisError: "Node budget cannot fund synthesis", updatedAt: now().toISOString() });
  } else {
    node = ResearchNodeSchema.parse({ ...node, spentUsd: fromMicros(streamSpentMicros + allocation.synthesisMicros) });
    try {
      const summary = await options.synthesizer.synthesize({ brief: input.brief, streamRuns, claims: store.claims.filter((claim) => claim.nodeId === nodeId) });
      node = ResearchNodeSchema.parse({ ...node, synthesis: { model: options.synthesizer.model, summary, fallback: false }, updatedAt: now().toISOString() });
    } catch (error) {
      if (options.fallbackSynthesizer) {
        try {
          const summary = await options.fallbackSynthesizer.synthesize({ brief: input.brief, streamRuns, claims: store.claims.filter((claim) => claim.nodeId === nodeId) });
          node = ResearchNodeSchema.parse({ ...node, synthesis: { model: options.fallbackSynthesizer.model, summary, fallback: true }, synthesisError: message(error), updatedAt: now().toISOString() });
        } catch (fallbackError) {
          node = ResearchNodeSchema.parse({ ...node, status: node.status === "research-failed" ? node.status : "research-partial", synthesisError: `${message(error)}; fallback failed: ${message(fallbackError)}`, updatedAt: now().toISOString() });
        }
      } else {
        node = ResearchNodeSchema.parse({ ...node, status: node.status === "research-failed" ? node.status : "research-partial", synthesisError: message(error), updatedAt: now().toISOString() });
      }
    }
  }
  if (toMicros(node.spentUsd) > toMicros(input.brief.budgetUsd)) throw new Error("Internal error: node budget overspent");
  upsertNode(store, node);

  let publication: PublishedReport | undefined;
  try {
    publication = await options.publisher.publish({ slug: `scraply-${nodeId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, markdown: renderFullResearchReport(store, nodeId) });
    node = ResearchNodeSchema.parse({
      ...node,
      researchReportPath: publication.localPath,
      ...(publication.url ? { researchReportLink: publication.url } : {}),
      updatedAt: now().toISOString(),
    });
  } catch (error) {
    node = ResearchNodeSchema.parse({ ...node, status: node.status === "research-failed" ? node.status : "research-partial", reportError: message(error), updatedAt: now().toISOString() });
  }
  upsertNode(store, node);
  await saveStore(options.storePath, store);
  return { node, store, ...(publication ? { publication } : {}) };
}
