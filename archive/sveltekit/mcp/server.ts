#!/usr/bin/env bun
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "../config";
import { createEmbeddingsClient } from "../models/embeddings";
import { OpenCodeClaimExtractor } from "../models/opencode";
import { OpenCodeResearchReasoner, OpenCodeResearchSynthesizer } from "../models/research";
import { LocalMarkdownPublisher } from "../report/publisher";
import { runFullResearch } from "../research/full";
import { ExaClient } from "../search/exa";
import {
  CreateChildInputSchema,
  DirectorIdeaInputSchema,
  IdeaBucketSchema,
  RateIdeaInputSchema,
  type DirectorIdeaInput,
} from "../store/schema";
import { TreeService } from "../store/tree";

const IdInputSchema = z.object({ id: z.string().min(1) });
const AddIdeasInputSchema = z.object({ nodeId: z.string().min(1), ideas: z.array(DirectorIdeaInputSchema) });
const GetIdeasInputSchema = z.object({ nodeId: z.string().min(1), bucket: IdeaBucketSchema.optional() });

export interface ScraplyToolHandlers {
  get_tree(): Promise<unknown>;
  get_node(input: { id: string }): Promise<unknown>;
  create_child(input: { parentId: string; focusTopic: string }): Promise<unknown>;
  research_node(input: { id: string }): Promise<unknown>;
  add_ideas(input: { nodeId: string; ideas: DirectorIdeaInput[] }): Promise<unknown>;
  get_ideas(input: { nodeId: string; bucket?: "sweet-spot" | "creative-outlier" | "safe-bet" | undefined }): Promise<unknown>;
  rate_idea(input: { ideaId: string; rating: number }): Promise<unknown>;
}

export function createToolHandlers(service: TreeService): ScraplyToolHandlers {
  return {
    get_tree: () => service.getTree(),
    get_node: ({ id }) => service.getNode(id),
    create_child: ({ parentId, focusTopic }) => service.createChild(parentId, focusTopic),
    research_node: ({ id }) => service.researchNode(id),
    add_ideas: ({ nodeId, ideas }) => service.addIdeas(nodeId, ideas),
    get_ideas: ({ nodeId, bucket }) => service.getIdeas(nodeId, bucket),
    rate_idea: ({ ideaId, rating }) => service.rateIdea(ideaId, rating),
  };
}

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export function createMcpServer(service: TreeService): McpServer {
  const handlers = createToolHandlers(service);
  const server = new McpServer({ name: "scraply", version: "0.1.0" });

  server.registerTool("get_tree", { description: "Load the persistent research tree." }, async () => result(await handlers.get_tree()));
  server.registerTool("get_node", { description: "Load one node with its claims and ideas.", inputSchema: IdInputSchema }, async (input) => result(await handlers.get_node(input)));
  server.registerTool("create_child", { description: "Create a narrower context-inheriting child node.", inputSchema: CreateChildInputSchema }, async (input) => result(await handlers.create_child(input)));
  server.registerTool("research_node", { description: "Run all six research streams for a stored pending node.", inputSchema: IdInputSchema }, async (input) => result(await handlers.research_node(input)));
  server.registerTool("add_ideas", { description: "Embed, score, tree-deduplicate, and persist director ideas.", inputSchema: AddIdeasInputSchema }, async (input) => result(await handlers.add_ideas(input)));
  server.registerTool("get_ideas", { description: "Load a node's ideas, optionally filtered by bucket.", inputSchema: GetIdeasInputSchema }, async (input) => result(await handlers.get_ideas(input)));
  server.registerTool("rate_idea", { description: "Persist an idea rating from 0 to 1.", inputSchema: RateIdeaInputSchema }, async (input) => result(await handlers.rate_idea(input)));
  return server;
}

function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required for this tool`);
  return value;
}

function positiveNumber(value: string | undefined, fallback: number, key: string): number {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${key} must be positive`);
  return parsed;
}

function nonNegativeInteger(value: string | undefined, fallback: number, key: string): number {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${key} must be a non-negative integer`);
  return parsed;
}

export function createProductionTreeService(env: Record<string, string | undefined> = process.env): TreeService {
  const storePath = resolve(env.SCRAPLY_STORE_PATH?.trim() || ".scraply/store.json");
  return new TreeService({
    storePath,
    maxDepth: nonNegativeInteger(env.SCRAPLY_MAX_DEPTH, 4, "SCRAPLY_MAX_DEPTH"),
    maxNodeBudgetUsd: positiveNumber(env.SCRAPLY_MAX_NODE_BUDGET_USD, 1, "SCRAPLY_MAX_NODE_BUDGET_USD"),
    embeddings: () => createEmbeddingsClient({
      provider: "google",
      googleApiKey: required(env, "GOOGLE_API_KEY"),
      googleModel: env.GOOGLE_EMBEDDING_MODEL?.trim() || "text-embedding-004",
    }),
    research: async (node) => {
      const config = loadConfig(env);
      return runFullResearch({ brief: node.brief }, {
        storePath,
        nodeId: node.id,
        researchStoredNode: true,
        publisher: new LocalMarkdownPublisher(resolve(config.SCRAPLY_REPORT_DIR)),
        search: new ExaClient(config.EXA_API_KEY),
        extractor: new OpenCodeClaimExtractor({ apiKey: config.OPENCODE_API_KEY, baseUrl: config.OPENCODE_BASE_URL, model: config.WORKER_MODEL }),
        embeddings: createEmbeddingsClient({ provider: config.EMBEDDINGS_PROVIDER, googleApiKey: config.GOOGLE_API_KEY, googleModel: config.GOOGLE_EMBEDDING_MODEL }),
        reasoner: new OpenCodeResearchReasoner({ apiKey: config.OPENCODE_API_KEY, baseUrl: config.OPENCODE_BASE_URL, model: config.SMART_MODEL }),
        synthesizer: new OpenCodeResearchSynthesizer({ apiKey: config.OPENCODE_API_KEY, baseUrl: config.OPENCODE_BASE_URL, model: config.SMART_MODEL }),
        costs: { planUsd: config.RESEARCH_PLAN_COST_USD, queryUsd: config.RESEARCH_QUERY_COST_USD, reflectUsd: config.RESEARCH_REFLECT_COST_USD },
        synthesisCostUsd: config.RESEARCH_SYNTHESIS_COST_USD,
      });
    },
  });
}

export async function startStdioServer(service = createProductionTreeService()): Promise<void> {
  const server = createMcpServer(service);
  await server.connect(new StdioServerTransport());
}

if (import.meta.main) {
  startStdioServer().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
