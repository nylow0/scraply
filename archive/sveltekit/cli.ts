#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { loadConfig } from "./config";
import { addIdeas } from "./ideas/add";
import { createEmbeddingsClient } from "./models/embeddings";
import { OpenCodeClaimExtractor } from "./models/opencode";
import { OpenCodeResearchReasoner, OpenCodeResearchSynthesizer } from "./models/research";
import { persistResult, runPipeline } from "./pipeline";
import { runResearchNode } from "./research/loop";
import { runFullResearch } from "./research/full";
import { LocalMarkdownPublisher, ShareCommandPublisher, type Publisher } from "./report/publisher";
import { renderNodeReport } from "./report/render";
import { ExaClient } from "./search/exa";
import { loadStore, saveStore } from "./store/json";
import { DirectorIdeaInputSchema, ResearchInputSchema } from "./store/schema";

function usage(): never {
  console.error([
    "Usage:",
    "  bun start -- research-all --input brief.json [--node-id id] [--store path] [--report-dir dir] [--publish]",
    "  bun start -- research --input brief.json [--node-id id] [--store path] [--report-dir dir] [--publish]",
    "  bun start -- add-ideas --node id --input ideas.json [--store path] [--report-dir dir] [--publish]",
    "  bun start -- <query> [--output path] [--no-persist]  # Phase 0 compatibility",
  ].join("\n"));
  process.exit(1);
}

async function phase2Research(args: string[]): Promise<void> {
  const parsed = parseOptions(args);
  const config = loadConfig();
  const input = JSON.parse(await readFile(required(parsed.values, "--input"), "utf8")) as unknown;
  const storePath = resolve(parsed.values.get("--store") ?? config.SCRAPLY_STORE_PATH);
  const local = new LocalMarkdownPublisher(resolve(parsed.values.get("--report-dir") ?? config.SCRAPLY_REPORT_DIR));
  const publisher = parsed.flags.has("--publish") ? new ShareCommandPublisher(local, config.SHARE_PUBLISH_COMMAND) : local;
  const requestedNodeId = parsed.values.get("--node-id");
  const run = await runFullResearch(input as Parameters<typeof runFullResearch>[0], {
    storePath,
    publisher,
    search: new ExaClient(config.EXA_API_KEY),
    extractor: new OpenCodeClaimExtractor({ apiKey: config.OPENCODE_API_KEY, baseUrl: config.OPENCODE_BASE_URL, model: config.WORKER_MODEL }),
    embeddings: createEmbeddingsClient({
      provider: config.EMBEDDINGS_PROVIDER,
      googleApiKey: config.GOOGLE_API_KEY,
      googleModel: config.GOOGLE_EMBEDDING_MODEL,
    }),
    reasoner: new OpenCodeResearchReasoner({ apiKey: config.OPENCODE_API_KEY, baseUrl: config.OPENCODE_BASE_URL, model: config.SMART_MODEL }),
    synthesizer: new OpenCodeResearchSynthesizer({ apiKey: config.OPENCODE_API_KEY, baseUrl: config.OPENCODE_BASE_URL, model: config.SMART_MODEL }),
    costs: {
      planUsd: config.RESEARCH_PLAN_COST_USD,
      queryUsd: config.RESEARCH_QUERY_COST_USD,
      reflectUsd: config.RESEARCH_REFLECT_COST_USD,
    },
    synthesisCostUsd: config.RESEARCH_SYNTHESIS_COST_USD,
    ...(requestedNodeId ? { nodeId: requestedNodeId } : {}),
  });
  console.log(JSON.stringify({
    nodeId: run.node.id,
    status: run.node.status,
    spentUsd: run.node.spentUsd,
    streams: run.node.streamRuns.map(({ stream, status, stopReason, error, spentUsd }) => ({ id: stream.id, status, stopReason, error, spentUsd })),
    synthesisModel: run.node.synthesis?.model,
    report: run.publication,
  }, null, 2));
}

function parseOptions(args: string[]): { values: Map<string, string>; flags: Set<string> } {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg?.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    if (arg === "--publish") flags.add(arg);
    else {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      values.set(arg, value);
    }
  }
  return { values, flags };
}

function required(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new Error(`Missing required option: ${name}`);
  return value;
}

function slugFor(nodeId: string): string {
  return `scraply-${nodeId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

async function publishNode(
  storePath: string,
  nodeId: string,
  publisher: Publisher,
): Promise<{ localPath: string; url?: string }> {
  const store = await loadStore(storePath);
  const publication = await publisher.publish({ slug: slugFor(nodeId), markdown: renderNodeReport(store, nodeId) });
  const index = store.nodes.findIndex((node) => node.id === nodeId);
  const node = store.nodes[index];
  if (!node || index === -1) throw new Error(`Unknown node: ${nodeId}`);
  store.nodes[index] = {
    ...node,
    researchReportPath: publication.localPath,
    ...(publication.url ? { researchReportLink: publication.url } : {}),
    updatedAt: new Date().toISOString(),
  };
  await saveStore(storePath, store);
  return publication;
}

async function phase1Research(args: string[]): Promise<void> {
  const parsed = parseOptions(args);
  const config = loadConfig();
  const input = ResearchInputSchema.parse(JSON.parse(await readFile(required(parsed.values, "--input"), "utf8")));
  const storePath = resolve(parsed.values.get("--store") ?? config.SCRAPLY_STORE_PATH);
  const embeddings = createEmbeddingsClient({
    provider: config.EMBEDDINGS_PROVIDER,
    googleApiKey: config.GOOGLE_API_KEY,
    googleModel: config.GOOGLE_EMBEDDING_MODEL,
  });
  const requestedNodeId = parsed.values.get("--node-id");
  const run = await runResearchNode(input, {
    storePath,
    search: new ExaClient(config.EXA_API_KEY),
    extractor: new OpenCodeClaimExtractor({ apiKey: config.OPENCODE_API_KEY, baseUrl: config.OPENCODE_BASE_URL, model: config.WORKER_MODEL }),
    embeddings,
    reasoner: new OpenCodeResearchReasoner({ apiKey: config.OPENCODE_API_KEY, baseUrl: config.OPENCODE_BASE_URL, model: config.SMART_MODEL }),
    costs: {
      planUsd: config.RESEARCH_PLAN_COST_USD,
      queryUsd: config.RESEARCH_QUERY_COST_USD,
      reflectUsd: config.RESEARCH_REFLECT_COST_USD,
    },
    ...(requestedNodeId ? { nodeId: requestedNodeId } : {}),
  });
  const local = new LocalMarkdownPublisher(resolve(parsed.values.get("--report-dir") ?? config.SCRAPLY_REPORT_DIR));
  const publisher = parsed.flags.has("--publish") ? new ShareCommandPublisher(local, config.SHARE_PUBLISH_COMMAND) : local;
  const publication = await publishNode(storePath, run.node.id, publisher);
  console.log(JSON.stringify({ nodeId: run.node.id, stopReason: run.node.stopReason, coverage: run.node.coverage, spentUsd: run.node.spentUsd, claims: run.node.claimIds.length, ...publication }, null, 2));
}

async function phase1AddIdeas(args: string[]): Promise<void> {
  const parsed = parseOptions(args);
  const config = loadConfig();
  const nodeId = required(parsed.values, "--node");
  const storePath = resolve(parsed.values.get("--store") ?? config.SCRAPLY_STORE_PATH);
  const raw = JSON.parse(await readFile(required(parsed.values, "--input"), "utf8")) as unknown;
  const ideas = z.array(DirectorIdeaInputSchema).parse(
    typeof raw === "object" && raw !== null && "ideas" in raw ? (raw as { ideas: unknown }).ideas : raw,
  );
  const result = await addIdeas(storePath, nodeId, ideas, {
    embeddings: createEmbeddingsClient({
      provider: config.EMBEDDINGS_PROVIDER,
      googleApiKey: config.GOOGLE_API_KEY,
      googleModel: config.GOOGLE_EMBEDDING_MODEL,
    }),
  });
  const local = new LocalMarkdownPublisher(resolve(parsed.values.get("--report-dir") ?? config.SCRAPLY_REPORT_DIR));
  const publisher = parsed.flags.has("--publish") ? new ShareCommandPublisher(local, config.SHARE_PUBLISH_COMMAND) : local;
  const publication = await publishNode(storePath, nodeId, publisher);
  console.log(JSON.stringify({ ...result, report: publication }, null, 2));
}

async function phase0(args: string[]): Promise<void> {
  let output: string | undefined;
  let persist = true;
  const queryParts: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--output") {
      output = args[++index];
      if (!output) usage();
    }
    else if (arg === "--no-persist") persist = false;
    else if (arg?.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    else if (arg) queryParts.push(arg);
  }
  const query = queryParts.join(" ").trim();
  if (!query) usage();
  const config = loadConfig();
  const result = await runPipeline(query, {
    search: new ExaClient(config.EXA_API_KEY),
    extractor: new OpenCodeClaimExtractor({ apiKey: config.OPENCODE_API_KEY, baseUrl: config.OPENCODE_BASE_URL, model: config.WORKER_MODEL }),
    embeddings: createEmbeddingsClient({ provider: config.EMBEDDINGS_PROVIDER, googleApiKey: config.GOOGLE_API_KEY, googleModel: config.GOOGLE_EMBEDDING_MODEL }),
    workerModel: config.WORKER_MODEL,
    numResults: config.EXA_RESULT_COUNT,
    maxCharacters: config.EXA_MAX_CHARACTERS,
  });
  if (persist) {
    await persistResult(result, output ?? resolve(config.SCRAPLY_OUTPUT_DIR, `${result.createdAt.replace(/[:.]/g, "-")}.json`));
  }
  console.log(JSON.stringify(result, null, 2));
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "research-all") return phase2Research(args);
  if (command === "research") return phase1Research(args);
  if (command === "add-ideas") return phase1AddIdeas(args);
  return phase0(process.argv.slice(2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
