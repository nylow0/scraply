import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addIdeas } from "../src/ideas/add";
import { runResearchNode, type ResearchReflection } from "../src/research/loop";
import { LocalMarkdownPublisher } from "../src/report/publisher";
import { renderNodeReport } from "../src/report/render";
import { emptyStore, loadStore, saveStore } from "../src/store/json";
import type { KnowledgeStore, ResearchInput, ResearchNode, StoredClaim, StoredIdea } from "../src/store/schema";

const input: ResearchInput = {
  brief: {
    topic: "Student business tools",
    objective: "Find a software idea students would pay for",
    audience: "student founders",
    constraints: ["small build"],
    successCriteria: ["clear demand"],
    budgetUsd: 1,
  },
  stream: {
    id: "pain",
    name: "Pain and gaps",
    lens: "pain-gaps",
    focus: "Repeated costly student problems",
    maxHops: 3,
    coverageThreshold: 0.8,
    maxQueriesPerHop: 2,
  },
};

async function temporaryStore(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "scraply-phase1-")), "store.json");
}

function loopMocks(reflections: ResearchReflection[]) {
  let reflectCalls = 0;
  let searchCalls = 0;
  return {
    searchCalls: () => searchCalls,
    reflectCalls: () => reflectCalls,
    options: {
      search: {
        search: async (query: string) => {
          searchCalls += 1;
          return [{ id: `source-${query}`, url: `https://example.com/${query}`, title: query, text: `${query} reveals a costly student problem.` }];
        },
      },
      extractor: {
        extract: async (query: string, sources: Array<{ id: string }>) => ({
          claims: [{
            text: `${query} reveals a costly student problem.`,
            sourceIds: [sources[0]!.id],
            evidence: [{ sourceId: sources[0]!.id, quote: "reveals a costly student problem" }],
            confidence: 0.9,
          }],
        }),
      },
      embeddings: { embed: async (texts: string[]) => ({ vectors: texts.map(() => [1, 0]), provider: "mock", model: "mock" }) },
      reasoner: {
        plan: async () => ({ queries: ["first"] }),
        reflect: async () => reflections[reflectCalls++] ?? { coverage: 0, gaps: [], followUpQueries: [] },
      },
    },
  };
}

describe("Phase 1 research loop", () => {
  test("runs multiple hops and stops explicitly when coverage is sufficient", async () => {
    const path = await temporaryStore();
    const mocks = loopMocks([
      { coverage: 0.4, gaps: ["pricing"], followUpQueries: ["second"] },
      { coverage: 0.9, gaps: [], followUpQueries: [] },
    ]);
    const run = await runResearchNode(input, {
      storePath: path,
      ...mocks.options,
      nodeId: "n_root",
      costs: { planUsd: 0.1, queryUsd: 0.1, reflectUsd: 0.1 },
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      idFactory: (() => { let id = 0; return () => String(++id); })(),
    });

    expect(run.node).toMatchObject({ stopReason: "coverage", coverage: 0.9, hopsCompleted: 2, spentUsd: 0.5 });
    expect(mocks.searchCalls()).toBe(2);
    expect(mocks.reflectCalls()).toBe(2);
    const persisted = await loadStore(path);
    expect(persisted.nodes[0]?.claimIds).toHaveLength(2);
    expect(persisted.claims).toHaveLength(2);
    expect(persisted.sources).toHaveLength(2);
  });

  test("guards the budget before another model call and persists the partial run", async () => {
    const path = await temporaryStore();
    const mocks = loopMocks([{ coverage: 1, gaps: [], followUpQueries: [] }]);
    const run = await runResearchNode({ ...input, brief: { ...input.brief, budgetUsd: 0.25 } }, {
      storePath: path,
      ...mocks.options,
      nodeId: "n_budget",
      costs: { planUsd: 0.1, queryUsd: 0.1, reflectUsd: 0.1 },
    });

    expect(run.node.stopReason).toBe("budget");
    expect(run.node.spentUsd).toBe(0.2);
    expect(mocks.searchCalls()).toBe(1);
    expect(mocks.reflectCalls()).toBe(0);
    expect((await loadStore(path)).claims).toHaveLength(1);
  });

  test("stops at the configured hop cap when coverage remains incomplete", async () => {
    const path = await temporaryStore();
    const mocks = loopMocks([
      { coverage: 0.2, gaps: ["one"], followUpQueries: ["second"] },
      { coverage: 0.4, gaps: ["two"], followUpQueries: ["third"] },
    ]);
    const run = await runResearchNode({ ...input, stream: { ...input.stream, maxHops: 2 } }, {
      storePath: path,
      ...mocks.options,
      nodeId: "n_cap",
      costs: { planUsd: 0, queryUsd: 0, reflectUsd: 0 },
    });

    expect(run.node).toMatchObject({ stopReason: "max-hops", hopsCompleted: 2, coverage: 0.4 });
    expect(mocks.searchCalls()).toBe(2);
    expect(mocks.reflectCalls()).toBe(2);
  });
});

function node(id: string): ResearchNode {
  return {
    id,
    parentId: null,
    depth: 0,
    brief: input.brief,
    stream: input.stream,
    streams: [],
    streamRuns: [],
    status: "researched",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    stopReason: "coverage",
    coverage: 0.9,
    spentUsd: 0.5,
    hopsCompleted: 2,
    sourceIds: ["s1"],
    claimIds: ["c_pain", "c_exemplar"],
    ideaIds: [],
  };
}

const claimBase = {
  nodeId: "n_root",
  streamId: "pain",
  text: "Students repeatedly pay to solve this workflow.",
  sourceIds: ["s1"],
  evidence: [{ sourceId: "s1", quote: "Students repeatedly pay" }],
  confidence: 0.9,
  verified: true,
};

function ideaStore(): KnowledgeStore {
  const store = emptyStore();
  const claims: StoredClaim[] = [
    { id: "c_pain", ...claimBase, streamLens: "pain-gaps", embedding: [0.8, 0.6] },
    { id: "c_exemplar", ...claimBase, streamLens: "exemplars", text: "An unrelated incumbent exists.", embedding: [-1, 0] },
  ];
  const existing: StoredIdea = {
    id: "i_existing",
    nodeId: "n_other",
    title: "Existing idea",
    description: "Already stored on another node",
    supportingClaimIds: [],
    embedding: [1, 0],
    scores: { relevance: 1, novelty: 0, demand: 0, supply: 0 },
    bucket: "safe-bet",
    rating: null,
  };
  return {
    ...store,
    nodes: [node("n_root"), { ...node("n_other"), claimIds: [], sourceIds: [], ideaIds: [existing.id] }],
    sources: [{ id: "s1", url: "https://example.com/research", title: "Research", text: "Students repeatedly pay to solve this workflow." }],
    claims,
    ideas: [existing],
  };
}

describe("Phase 1 director idea boundary", () => {
  test("dedups across the whole store, preserves separate scores, buckets, and persists", async () => {
    const path = await temporaryStore();
    await saveStore(path, ideaStore());
    const vectors = [[1, 0], [1, 0], [0.8, 0.6], [0, -1]];
    const result = await addIdeas(path, "n_root", [
      { title: "Duplicate", description: "Same as the other node", supportingClaimIds: [] },
      { title: "Demand fit", description: "Directly addresses the paid workflow", supportingClaimIds: ["c_pain"] },
      { title: "Wild transfer", description: "A genuinely different mechanism", supportingClaimIds: ["c_pain"] },
    ], {
      embeddings: { embed: async () => ({ vectors, provider: "mock", model: "mock" }) },
      idFactory: (() => { let id = 0; return () => String(++id); })(),
    });

    expect(result.droppedDuplicates).toEqual([{ title: "Duplicate", duplicateOf: "i_existing", similarity: 1 }]);
    expect(result.added.map((idea) => idea.bucket)).toEqual(["sweet-spot", "creative-outlier"]);
    expect(result.added[0]?.scores).toEqual({ relevance: 0.9, novelty: 0.2, demand: 1, supply: 0 });
    expect(Object.keys(result.added[0]!.scores)).toEqual(["relevance", "novelty", "demand", "supply"]);
    const persisted = await loadStore(path);
    expect(persisted.ideas).toHaveLength(3);
    expect(persisted.nodes.find((item) => item.id === "n_root")?.status).toBe("ideated");
  });

  test("renders a useful Markdown report and writes it through the local publisher", async () => {
    const path = await temporaryStore();
    const store = ideaStore();
    store.ideas[0] = { ...store.ideas[0]!, nodeId: "n_root", bucket: "safe-bet" };
    store.nodes[0] = { ...store.nodes[0]!, ideaIds: ["i_existing"] };
    const markdown = renderNodeReport(store, "n_root");
    expect(markdown).toContain("# Student business tools");
    expect(markdown).toContain("Stop reason: coverage");
    expect(markdown).toContain("[Research](https://example.com/research)");
    expect(markdown).toContain("## Director-produced ideas");
    expect(markdown).toContain("relevance 1.00");

    const output = await new LocalMarkdownPublisher(join(path, "reports")).publish({ slug: "node-report", markdown });
    expect(await readFile(output.localPath, "utf8")).toBe(markdown);
  });
});
