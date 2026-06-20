import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server";
import { runFullResearch } from "../src/research/full";
import type { ResearchReasoner } from "../src/research/loop";
import { emptyStore, loadStore, saveStore } from "../src/store/json";
import { ResearchNodeSchema, type KnowledgeStore, type StoredIdea } from "../src/store/schema";
import { TreeService } from "../src/store/tree";

async function temporaryStore(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "scraply-phase3-")), "store.json");
}

function node(input: {
  id: string;
  parentId?: string | null;
  depth?: number;
  topic?: string;
  budgetUsd?: number;
  ideaIds?: string[];
  summary?: string;
}) {
  return ResearchNodeSchema.parse({
    id: input.id,
    parentId: input.parentId ?? null,
    depth: input.depth ?? 0,
    brief: {
      topic: input.topic ?? input.id,
      objective: `Research ${input.topic ?? input.id}`,
      audience: "student founders",
      constraints: ["small build"],
      successCriteria: ["clear demand"],
      budgetUsd: input.budgetUsd ?? 1,
    },
    status: "researched",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ideaIds: input.ideaIds ?? [],
    ...(input.summary ? { synthesis: { model: "mock", summary: input.summary, fallback: false } } : {}),
  });
}

function storedIdea(input: Partial<StoredIdea> & Pick<StoredIdea, "id" | "nodeId" | "title">): StoredIdea {
  return {
    id: input.id,
    nodeId: input.nodeId,
    title: input.title,
    description: input.description ?? `${input.title} description`,
    supportingClaimIds: input.supportingClaimIds ?? [],
    embedding: input.embedding ?? [1, 0],
    scores: input.scores ?? { relevance: 1, novelty: 0, demand: 0, supply: 0 },
    bucket: input.bucket ?? "safe-bet",
    rating: input.rating ?? null,
  };
}

function inheritedStore(): KnowledgeStore {
  const root = node({ id: "n_root", topic: "Student tools", summary: "Root summary" });
  const parent = node({ id: "n_parent", parentId: root.id, depth: 1, topic: "Study workflows", budgetUsd: 0.8, ideaIds: ["i_focus"], summary: "Parent summary" });
  return {
    ...emptyStore(),
    nodes: [root, parent],
    sources: [
      { id: "s_root", url: "https://example.com/root", title: "Root", text: "Root evidence" },
      { id: "s_parent", url: "https://example.com/parent", title: "Parent", text: "Parent evidence" },
    ],
    claims: [
      { id: "c_root", nodeId: root.id, streamId: "landscape", streamLens: "landscape", text: "Root claim", sourceIds: ["s_root"], evidence: [{ sourceId: "s_root", quote: "Root evidence" }], confidence: 0.8, verified: true, embedding: [1, 0] },
      { id: "c_parent", nodeId: parent.id, streamId: "pain-gaps", streamLens: "pain-gaps", text: "Parent claim", sourceIds: ["s_parent"], evidence: [{ sourceId: "s_parent", quote: "Parent evidence" }], confidence: 0.9, verified: true, embedding: [0, 1] },
    ],
    ideas: [storedIdea({ id: "i_focus", nodeId: parent.id, title: "Deadline rescue coach", supportingClaimIds: ["c_parent"] })],
  };
}

describe("Phase 3 persistent research tree", () => {
  test("creates a stable narrower child with the full ancestor context and reloads it", async () => {
    const path = await temporaryStore();
    await saveStore(path, inheritedStore());
    const service = new TreeService({ storePath: path, maxDepth: 4, maxNodeBudgetUsd: 0.4, idFactory: () => "child", now: () => new Date("2026-02-01T00:00:00.000Z") });

    const child = await service.createChild("n_parent", "i_focus");
    expect(child).toMatchObject({ id: "n_child", parentId: "n_parent", depth: 2, status: "pending" });
    expect(child.brief).toMatchObject({ topic: "Deadline rescue coach", budgetUsd: 0.4 });
    expect(child.brief.inheritedContext?.pathNodeIds).toEqual(["n_root", "n_parent"]);
    expect(child.brief.inheritedContext?.ancestorSummaries).toEqual([
      { nodeId: "n_root", summary: "Root summary" },
      { nodeId: "n_parent", summary: "Parent summary" },
    ]);
    expect(child.brief.inheritedContext?.ancestorClaims.map((claim) => claim.id)).toEqual(["c_root", "c_parent"]);
    expect(child.brief.inheritedContext?.selectedIdea).toMatchObject({ id: "i_focus", title: "Deadline rescue coach", supportingClaimIds: ["c_parent"] });

    const reloaded = await loadStore(path);
    expect(reloaded.nodes.find((item) => item.id === child.id)).toEqual(child);
    expect((await service.getTree()).nodes.find((item) => item.id === child.id)).toMatchObject({ budgetUsd: 0.4, spentUsd: 0, childIds: [] });
  });

  test("enforces depth and per-node budget caps", async () => {
    const path = await temporaryStore();
    await saveStore(path, inheritedStore());
    const capped = new TreeService({ storePath: path, maxDepth: 1, maxNodeBudgetUsd: 0.25 });
    await expect(capped.createChild("n_parent", "Too deep")).rejects.toThrow("Depth cap exceeded");

    const allowed = new TreeService({ storePath: path, maxDepth: 2, maxNodeBudgetUsd: 0.25, idFactory: () => "capped" });
    expect((await allowed.createChild("n_parent", "Narrow topic")).brief.budgetUsd).toBe(0.25);
  });

  test("deduplicates against sibling ideas across the whole tree", async () => {
    const path = await temporaryStore();
    const store = inheritedStore();
    store.nodes.push(node({ id: "n_sibling", parentId: "n_root", depth: 1, topic: "Sibling" }));
    await saveStore(path, store);
    const service = new TreeService({
      storePath: path,
      maxDepth: 4,
      maxNodeBudgetUsd: 1,
      embeddings: () => ({ embed: async () => ({ vectors: [[0, 1], [1, 0]], provider: "mock", model: "mock" }) }),
    });

    const result = await service.addIdeas("n_sibling", [{ title: "Sibling duplicate", description: "Same semantic idea", supportingClaimIds: [] }]);
    expect(result.added).toEqual([]);
    expect(result.droppedDuplicates).toEqual([{ title: "Sibling duplicate", duplicateOf: "i_focus", similarity: 1 }]);
    expect((await loadStore(path)).ideas).toHaveLength(1);
  });

  test("filters ideas and persists ratings", async () => {
    const path = await temporaryStore();
    const store = inheritedStore();
    store.ideas.push(storedIdea({ id: "i_sweet", nodeId: "n_parent", title: "Sweet", bucket: "sweet-spot" }));
    store.nodes[1]!.ideaIds.push("i_sweet");
    await saveStore(path, store);
    const service = new TreeService({ storePath: path, maxDepth: 4, maxNodeBudgetUsd: 1 });

    expect((await service.getIdeas("n_parent", "sweet-spot")).map((idea) => idea.id)).toEqual(["i_sweet"]);
    expect((await service.rateIdea("i_sweet", 0.85)).rating).toBe(0.85);
    expect((await loadStore(path)).ideas.find((idea) => idea.id === "i_sweet")?.rating).toBe(0.85);
    await expect(service.rateIdea("i_sweet", 2)).rejects.toThrow("between 0 and 1");
  });

  test("completes parent to child to six-stream research and idea import", async () => {
    const path = await temporaryStore();
    await saveStore(path, inheritedStore());
    const reasoner: ResearchReasoner = {
      plan: async (_brief, stream) => ({ queries: [`${stream.id}-query`] }),
      reflect: async () => ({ coverage: 1, gaps: [], followUpQueries: [] }),
    };
    const researchMocks = {
      search: { search: async (query: string) => [{ id: query, url: `https://example.com/${query}`, title: query, text: `${query} evidence` }] },
      extractor: { extract: async (query: string, sources: Array<{ id: string }>) => ({ claims: [{ text: `${query} evidence`, sourceIds: [sources[0]!.id], evidence: [{ sourceId: sources[0]!.id, quote: "evidence" }], confidence: 0.9 }] }) },
      embeddings: { embed: async (texts: string[]) => ({ vectors: texts.map(() => [0, 1]), provider: "mock", model: "mock" }) },
      reasoner,
    };
    let service!: TreeService;
    service = new TreeService({
      storePath: path,
      maxDepth: 4,
      maxNodeBudgetUsd: 0.5,
      idFactory: () => "flow",
      embeddings: () => researchMocks.embeddings,
      research: (stored) => runFullResearch({ brief: stored.brief, maxHops: 1, maxQueriesPerHop: 1 }, {
        storePath: path,
        nodeId: stored.id,
        researchStoredNode: true,
        ...researchMocks,
        synthesizer: { model: "mock-smart", synthesize: async () => "Child synthesis" },
        publisher: { publish: async () => ({ localPath: "C:\\mock\\child.md" }) },
        costs: { planUsd: 0, queryUsd: 0, reflectUsd: 0 },
        synthesisCostUsd: 0.05,
      }),
    });

    const child = await service.createChild("n_parent", "i_focus");
    const researched = await service.researchNode(child.id);
    expect(researched.node).toMatchObject({ id: child.id, parentId: "n_parent", depth: 2, status: "researched", synthesis: { summary: "Child synthesis" } });
    expect(researched.node.claimIds).toHaveLength(6);
    const ideas = await service.addIdeas(child.id, [{ title: "Sharper child idea", description: "Built from the deeper evidence", supportingClaimIds: [researched.node.claimIds[0]!] }]);
    expect(ideas.added).toHaveLength(1);
    const persisted = await loadStore(path);
    expect(persisted.nodes.find((item) => item.id === child.id)).toMatchObject({ status: "ideated", ideaIds: [ideas.added[0]!.id], researchReportPath: "C:\\mock\\child.md" });
    expect(persisted.ideas).toHaveLength(2);
  });

  test("exposes exactly the seven validated MCP tools without live credentials", async () => {
    const path = await temporaryStore();
    await saveStore(path, inheritedStore());
    const server = createMcpServer(new TreeService({ storePath: path, maxDepth: 4, maxNodeBudgetUsd: 1 }));
    const client = new Client({ name: "phase3-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(["get_tree", "get_node", "create_child", "research_node", "add_ideas", "get_ideas", "rate_idea"]);
    const tree = await client.callTool({ name: "get_tree", arguments: {} });
    const content = tree.content as Array<{ type: string; text?: string }>;
    expect(JSON.parse(content[0]?.type === "text" ? content[0].text ?? "{}" : "{}").nodes).toHaveLength(2);
    const invalid = await client.callTool({ name: "rate_idea", arguments: { ideaId: "i_focus", rating: 2 } });
    expect(invalid.isError).toBe(true);

    await client.close();
    await server.close();
  });
});
