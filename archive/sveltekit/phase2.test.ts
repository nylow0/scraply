import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allocateStreamBudgets, runFullResearch } from "../src/research/full";
import { DeterministicTestSynthesizer } from "../src/research/synthesis";
import { RESEARCH_STREAMS } from "../src/research/streams";
import { loadStore } from "../src/store/json";
import type { Publisher } from "../src/report/publisher";
import type { ResearchReasoner } from "../src/research/loop";
import type { ResearchSynthesizer, SynthesisInput } from "../src/research/synthesis";

const brief = {
  topic: "Student business tools",
  objective: "Find evidence-backed opportunities",
  audience: "student founders",
  constraints: ["small build"],
  successCriteria: ["clear demand"],
  budgetUsd: 1,
};

async function temporaryStore(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "scraply-phase2-")), "store.json");
}

function researchMocks(reasoner: ResearchReasoner, searchOverride?: (query: string) => Promise<Array<{ id: string; url: string; title: string; text: string }>>) {
  return {
    reasoner,
    search: {
      search: searchOverride ?? (async (query: string) => [{
        id: `s-${query}`,
        url: `https://example.com/${query}`,
        title: query,
        text: `${query} has grounded evidence.`,
      }]),
    },
    extractor: {
      extract: async (query: string, sources: Array<{ id: string }>) => ({
        claims: [{
          text: `${query} has grounded evidence.`,
          sourceIds: [sources[0]!.id],
          evidence: [{ sourceId: sources[0]!.id, quote: "has grounded evidence" }],
          confidence: 0.9,
        }],
      }),
    },
    embeddings: { embed: async (texts: string[]) => ({ vectors: texts.map(() => [1, 0]), provider: "mock", model: "mock" }) },
  };
}

function publisherCapture() {
  let markdown = "";
  let calls = 0;
  const publisher: Publisher = {
    publish: async (report) => {
      calls += 1;
      markdown = report.markdown;
      return { localPath: "C:\\mock\\phase2.md", url: "https://phase2.llm-plans.com" };
    },
  };
  return { publisher, markdown: () => markdown, calls: () => calls };
}

describe("Phase 2 six-stream research", () => {
  test("defines exactly the six canonical focused streams", () => {
    expect(RESEARCH_STREAMS.map((stream) => stream.name)).toEqual([
      "Landscape", "Exemplars", "Pain & Gaps", "Resources", "Analogies", "Evaluation",
    ]);
    expect(new Set(RESEARCH_STREAMS.map((stream) => stream.lens)).size).toBe(6);
    expect(RESEARCH_STREAMS.every((stream) => stream.focus.length > 20 && stream.instructions.length > 40)).toBe(true);
  });

  test("fans out concurrently, keeps deterministic node budget, synthesizes, persists, and attaches one complete report", async () => {
    const path = await temporaryStore();
    let activePlans = 0;
    let maxActivePlans = 0;
    let enteredPlans = 0;
    let releasePlans!: () => void;
    const barrier = new Promise<void>((resolve) => { releasePlans = resolve; });
    const reasoner: ResearchReasoner = {
      plan: async (_brief, stream) => {
        activePlans += 1;
        enteredPlans += 1;
        maxActivePlans = Math.max(maxActivePlans, activePlans);
        if (enteredPlans === 6) releasePlans();
        await barrier;
        activePlans -= 1;
        return { queries: [`${stream.id}-first`] };
      },
      reflect: async () => ({ coverage: 1, gaps: [], followUpQueries: [] }),
    };
    let synthesisInput: SynthesisInput | undefined;
    const synthesizer: ResearchSynthesizer = {
      model: "glm-test",
      synthesize: async (input) => {
        synthesisInput = input;
        return "Cross-stream synthesis with concrete validation steps.";
      },
    };
    const report = publisherCapture();
    const run = await runFullResearch({ brief, maxHops: 1, maxQueriesPerHop: 1 }, {
      storePath: path,
      ...researchMocks(reasoner),
      synthesizer,
      publisher: report.publisher,
      synthesisCostUsd: 0.1,
      costs: { planUsd: 0.01, queryUsd: 0.01, reflectUsd: 0.01 },
      nodeId: "n_phase2",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(maxActivePlans).toBe(6);
    expect(run.node.status).toBe("researched");
    expect(run.node.streamRuns).toHaveLength(6);
    expect(run.node.streamRuns.map((item) => item.stream.name)).toEqual(RESEARCH_STREAMS.map((item) => item.name));
    expect(run.node.streamRuns.reduce((sum, item) => sum + item.spentUsd, 0)).toBeCloseTo(0.18, 6);
    expect(run.node.spentUsd).toBeCloseTo(0.28, 6);
    expect(run.node.spentUsd).toBeLessThanOrEqual(brief.budgetUsd);
    expect(allocateStreamBudgets(1, 0.1).streamMicros).toEqual([150000, 150000, 150000, 150000, 150000, 150000]);
    expect(synthesisInput?.streamRuns.map((item) => item.stream.id)).toEqual(RESEARCH_STREAMS.map((item) => item.id));
    expect(run.node.synthesis).toMatchObject({ model: "glm-test", fallback: false });
    expect(report.calls()).toBe(1);
    for (const stream of RESEARCH_STREAMS) expect(report.markdown()).toContain(`## ${stream.name}`);
    expect(report.markdown()).toContain("## Synthesis");
    expect(run.node).toMatchObject({ researchReportPath: "C:\\mock\\phase2.md", researchReportLink: "https://phase2.llm-plans.com" });

    const persisted = await loadStore(path);
    const persistedNode = persisted.nodes.find((item) => item.id === "n_phase2");
    expect(persistedNode?.status).toBe("researched");
    expect(persisted.claims).toHaveLength(6);
    expect(new Set(persisted.claims.map((claim) => claim.streamId))).toEqual(new Set(RESEARCH_STREAMS.map((stream) => stream.id)));
    expect(persisted.claims.every((claim) => claim.nodeId === "n_phase2")).toBe(true);
  });

  test("preserves a failed stream's earlier claims and other streams, then uses only an explicit mocked fallback", async () => {
    const path = await temporaryStore();
    const reasoner: ResearchReasoner = {
      plan: async (_brief, stream) => ({ queries: [`${stream.id}-first`] }),
      reflect: async ({ stream, hop }) => ({ coverage: 0.4, gaps: ["more"], followUpQueries: hop === 1 ? [`${stream.id}-second`] : [] }),
    };
    const search = async (query: string) => {
      if (query === "pain-gaps-second") throw new Error("stream search rejected");
      return [{ id: `s-${query}`, url: `https://example.com/${query}`, title: query, text: `${query} has grounded evidence.` }];
    };
    const report = publisherCapture();
    const run = await runFullResearch({ brief, maxHops: 2, maxQueriesPerHop: 1 }, {
      storePath: path,
      ...researchMocks(reasoner, search),
      synthesizer: { model: "glm-test", synthesize: async () => { throw new Error("mock smart worker unavailable"); } },
      fallbackSynthesizer: new DeterministicTestSynthesizer("mocked-tests-only"),
      publisher: report.publisher,
      synthesisCostUsd: 0.1,
      costs: { planUsd: 0.01, queryUsd: 0.01, reflectUsd: 0.01 },
      nodeId: "n_partial",
    });

    const failed = run.node.streamRuns.find((item) => item.stream.id === "pain-gaps");
    expect(run.node.status).toBe("research-partial");
    expect(failed).toMatchObject({ status: "failed", error: "stream search rejected", spentUsd: 0.04 });
    expect(failed?.claimIds).toHaveLength(1);
    expect(run.store.claims.filter((claim) => claim.streamId === "pain-gaps")).toHaveLength(1);
    expect(run.store.claims.filter((claim) => claim.streamId !== "pain-gaps").length).toBeGreaterThan(5);
    expect(run.node.synthesis).toMatchObject({ model: "deterministic-test-fallback", fallback: true });
    expect(run.node.synthesisError).toBe("mock smart worker unavailable");
    expect(report.markdown()).toContain("stream search rejected");
    expect((await loadStore(path)).claims.length).toBe(run.store.claims.length);
  });
});
