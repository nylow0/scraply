import { randomUUID } from "node:crypto";
import type { EmbeddingsClient } from "../models/embeddings";
import type { FullResearchRun } from "../research/full";
import { addIdeas, type AddIdeasResult } from "../ideas/add";
import { buildPreferenceContext } from "../preferences/context";
import { loadStore, saveStore } from "./json";
import {
  DirectorIdeaInputSchema,
  IdeaBucketSchema,
  ResearchNodeSchema,
  type DirectorIdeaInput,
  type KnowledgeStore,
  type ResearchNode,
  type StoredIdea,
} from "./schema";
type IdeaBucket = StoredIdea["bucket"];

export interface TreeCaps {
  maxDepth: number;
  maxNodeBudgetUsd: number;
}

export interface TreeServiceOptions extends TreeCaps {
  storePath: string;
  embeddings?: () => EmbeddingsClient;
  research?: (node: ResearchNode) => Promise<FullResearchRun>;
  idFactory?: () => string;
  now?: () => Date;
}

export interface TreeNodeSummary {
  id: string;
  parentId: string | null;
  depth: number;
  topic: string;
  status: ResearchNode["status"];
  budgetUsd: number;
  spentUsd: number;
  report?: { path?: string; url?: string };
  ideaIds: string[];
  childIds: string[];
}

export interface TreeSnapshot {
  version: 1;
  nodes: TreeNodeSummary[];
}

function assertCaps(caps: TreeCaps): void {
  if (!Number.isInteger(caps.maxDepth) || caps.maxDepth < 0) throw new Error("maxDepth must be a non-negative integer");
  if (!Number.isFinite(caps.maxNodeBudgetUsd) || caps.maxNodeBudgetUsd <= 0) throw new Error("maxNodeBudgetUsd must be positive");
}

function ancestorPath(store: KnowledgeStore, node: ResearchNode): ResearchNode[] {
  const path: ResearchNode[] = [];
  const visited = new Set<string>();
  let current: ResearchNode | undefined = node;
  while (current) {
    if (visited.has(current.id)) throw new Error(`Cycle in research tree at node: ${current.id}`);
    visited.add(current.id);
    path.unshift(current);
    current = current.parentId ? store.nodes.find((item) => item.id === current!.parentId) : undefined;
    if (!current && path[0]?.parentId) throw new Error(`Missing ancestor node: ${path[0].parentId}`);
  }
  return path;
}

function selectedIdea(store: KnowledgeStore, parent: ResearchNode, focusTopic: string): StoredIdea | undefined {
  const normalized = focusTopic.trim().toLocaleLowerCase();
  return store.ideas.find((idea) => parent.ideaIds.includes(idea.id)
    && (idea.id.toLocaleLowerCase() === normalized || idea.title.trim().toLocaleLowerCase() === normalized));
}

export class TreeService {
  private readonly options: TreeServiceOptions;

  constructor(options: TreeServiceOptions) {
    assertCaps(options);
    this.options = options;
  }

  async getTree(): Promise<TreeSnapshot> {
    const store = await loadStore(this.options.storePath);
    return {
      version: store.version,
      nodes: store.nodes.map((node) => ({
        id: node.id,
        parentId: node.parentId,
        depth: node.depth,
        topic: node.brief.topic,
        status: node.status,
        budgetUsd: node.brief.budgetUsd,
        spentUsd: node.spentUsd,
        ...(node.researchReportPath || node.researchReportLink ? {
          report: {
            ...(node.researchReportPath ? { path: node.researchReportPath } : {}),
            ...(node.researchReportLink ? { url: node.researchReportLink } : {}),
          },
        } : {}),
        ideaIds: [...node.ideaIds],
        childIds: store.nodes.filter((child) => child.parentId === node.id).map((child) => child.id),
      })),
    };
  }

  async getNode(id: string): Promise<{ node: ResearchNode; claims: KnowledgeStore["claims"]; ideas: StoredIdea[]; preferenceContext: ReturnType<typeof buildPreferenceContext> }> {
    const store = await loadStore(this.options.storePath);
    const node = store.nodes.find((item) => item.id === id);
    if (!node) throw new Error(`Unknown node: ${id}`);
    return {
      node,
      claims: store.claims.filter((claim) => claim.nodeId === id),
      ideas: store.ideas.filter((idea) => idea.nodeId === id),
      preferenceContext: buildPreferenceContext(store),
    };
  }

  async createChild(parentId: string, focusTopic: string): Promise<ResearchNode> {
    const focus = focusTopic.trim();
    if (!focus) throw new Error("focusTopic must not be empty");
    const store = await loadStore(this.options.storePath);
    const parent = store.nodes.find((node) => node.id === parentId);
    if (!parent) throw new Error(`Unknown parent node: ${parentId}`);
    const depth = parent.depth + 1;
    if (depth > this.options.maxDepth) throw new Error(`Depth cap exceeded: ${depth} > ${this.options.maxDepth}`);

    const path = ancestorPath(store, parent);
    const pathIds = new Set(path.map((node) => node.id));
    const idea = selectedIdea(store, parent, focus);
    const idFactory = this.options.idFactory ?? randomUUID;
    let id = `n_${idFactory()}`;
    while (store.nodes.some((node) => node.id === id)) id = `n_${idFactory()}`;
    const timestamp = (this.options.now ?? (() => new Date()))().toISOString();
    const topic = idea?.title ?? focus;
    const child = ResearchNodeSchema.parse({
      id,
      parentId,
      depth,
      brief: {
        topic,
        objective: `Investigate ${topic} as a narrower branch of: ${parent.brief.objective}`,
        ...(parent.brief.audience ? { audience: parent.brief.audience } : {}),
        constraints: [...parent.brief.constraints],
        successCriteria: [...parent.brief.successCriteria],
        budgetUsd: Math.min(parent.brief.budgetUsd, this.options.maxNodeBudgetUsd),
        inheritedContext: {
          pathNodeIds: path.map((node) => node.id),
          ancestorSummaries: path.flatMap((node) => node.synthesis ? [{ nodeId: node.id, summary: node.synthesis.summary }] : []),
          ancestorClaims: store.claims.filter((claim) => pathIds.has(claim.nodeId)).map(({ id: claimId, nodeId, text, sourceIds, confidence }) => ({
            id: claimId,
            nodeId,
            text,
            sourceIds,
            confidence,
          })),
          ...(idea ? { selectedIdea: {
            id: idea.id,
            title: idea.title,
            description: idea.description,
            supportingClaimIds: idea.supportingClaimIds,
          } } : {}),
        },
      },
      status: "pending",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    store.nodes.push(child);
    await saveStore(this.options.storePath, store);
    return child;
  }

  async researchNode(id: string): Promise<FullResearchRun> {
    const research = this.options.research;
    if (!research) throw new Error("Research providers are not configured");
    const { node } = await this.getNode(id);
    if (node.status !== "pending") throw new Error(`Node is not pending: ${id}`);
    if (node.depth > this.options.maxDepth) throw new Error(`Depth cap exceeded for node: ${id}`);
    if (node.brief.budgetUsd > this.options.maxNodeBudgetUsd) throw new Error(`Node budget cap exceeded for node: ${id}`);
    return research(node);
  }

  async addIdeas(nodeId: string, rawIdeas: DirectorIdeaInput[]): Promise<AddIdeasResult> {
    const embeddings = this.options.embeddings;
    if (!embeddings) throw new Error("Embeddings provider is not configured");
    const ideas = rawIdeas.map((idea) => DirectorIdeaInputSchema.parse(idea));
    return addIdeas(this.options.storePath, nodeId, ideas, { embeddings: embeddings() });
  }

  async getIdeas(nodeId: string, bucket?: IdeaBucket): Promise<StoredIdea[]> {
    if (bucket) IdeaBucketSchema.parse(bucket);
    const store = await loadStore(this.options.storePath);
    if (!store.nodes.some((node) => node.id === nodeId)) throw new Error(`Unknown node: ${nodeId}`);
    return store.ideas.filter((idea) => idea.nodeId === nodeId && (!bucket || idea.bucket === bucket));
  }

  async rateIdea(ideaId: string, rating: number): Promise<StoredIdea> {
    if (!Number.isFinite(rating) || rating < 0 || rating > 1) throw new Error("rating must be between 0 and 1");
    const store = await loadStore(this.options.storePath);
    const index = store.ideas.findIndex((idea) => idea.id === ideaId);
    const idea = store.ideas[index];
    if (!idea || index === -1) throw new Error(`Unknown idea: ${ideaId}`);
    const rated = { ...idea, rating };
    store.ideas[index] = rated;
    await saveStore(this.options.storePath, store);
    return rated;
  }
}
