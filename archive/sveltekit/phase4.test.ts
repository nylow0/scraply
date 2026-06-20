import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPreferenceContext } from "../src/preferences/context";
import { createDiveFromForm, loadWorkspaceView, rateIdeaFromForm } from "../src/lib/server/workspace";
import { emptyStore, loadStore, saveStore } from "../src/store/json";
import { ResearchNodeSchema, type KnowledgeStore, type StoredIdea } from "../src/store/schema";
import { TreeService } from "../src/store/tree";

const idea = (id: string, nodeId: string, rating: number | null, bucket: StoredIdea["bucket"] = "safe-bet"): StoredIdea => ({
  id,
  nodeId,
  title: `Idea ${id}`,
  description: `Concrete direction for ${id}`,
  supportingClaimIds: id === "i_high" ? ["c_root"] : [],
  embedding: [1, 0],
  scores: { relevance: 0.73, novelty: 0.62, demand: 0.81, supply: 0.28 },
  bucket,
  rating,
});

function fixture(): KnowledgeStore {
  const root = ResearchNodeSchema.parse({
    id: "n_root",
    parentId: null,
    depth: 0,
    brief: { topic: "Student workflow tools", objective: "Find focused product opportunities", budgetUsd: 0.8 },
    status: "ideated",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ideaIds: ["i_high", "i_mid", "i_low"],
    synthesis: { model: "mock", summary: "Students lose time coordinating deadlines.", fallback: false },
  });
  return {
    ...emptyStore(),
    nodes: [root],
    sources: [{ id: "s_root", url: "https://example.com/root", title: "Root", text: "Students lose time." }],
    claims: [{
      id: "c_root",
      nodeId: root.id,
      streamId: "pain-gaps",
      streamLens: "pain-gaps",
      text: "Students lose time coordinating deadlines.",
      sourceIds: ["s_root"],
      evidence: [{ sourceId: "s_root", quote: "Students lose time" }],
      confidence: 0.91,
      verified: true,
      embedding: [1, 0],
    }],
    ideas: [
      idea("i_high", root.id, 1, "sweet-spot"),
      idea("i_mid", root.id, 0.6, "creative-outlier"),
      idea("i_low", root.id, 0.2),
    ],
  };
}

async function temporaryStore(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "scraply-phase4-")), "store.json");
}

describe("Phase 4 preference learning and local UI server mapping", () => {
  test("turns ratings into explicit positive and negative few-shot bias", () => {
    const context = buildPreferenceContext(fixture());
    expect(context.ratedCount).toBe(3);
    expect(context.positiveExamples.map((item) => item.title)).toEqual(["Idea i_high"]);
    expect(context.negativeExamples.map((item) => item.title)).toEqual(["Idea i_low"]);
    expect(context.instructions.join(" ")).toContain("few-shot signals");
    expect(context.instructions.join(" ")).toContain("low-rated examples");
    expect(context.instructions.join(" ")).toContain("four independent axes");
  });

  test("maps a selected node into buckets, supporting claims, path, and director preference context", async () => {
    const path = await temporaryStore();
    await saveStore(path, fixture());
    const service = new TreeService({ storePath: path, maxDepth: 4, maxNodeBudgetUsd: 1 });
    const view = await loadWorkspaceView(service, "n_root");

    expect(view.selected?.path.map((node) => node.id)).toEqual(["n_root"]);
    expect(view.selected?.ideasByBucket["sweet-spot"][0]?.supportingClaims[0]).toMatchObject({ id: "c_root", verified: true });
    expect(view.selected?.ideasByBucket["creative-outlier"].map((item) => item.id)).toEqual(["i_mid"]);
    expect(view.selected?.preferenceContext.positiveExamples[0]?.title).toBe("Idea i_high");
  });

  test("persists ratings and creates an inherited child while returning the honest provider error", async () => {
    const path = await temporaryStore();
    await saveStore(path, fixture());
    const service = new TreeService({ storePath: path, maxDepth: 4, maxNodeBudgetUsd: 0.4, idFactory: () => "phase4" });

    const rating = new FormData();
    rating.set("ideaId", "i_mid");
    rating.set("rating", "0.8");
    expect((await rateIdeaFromForm(service, rating)).rating).toBe(0.8);

    const dive = new FormData();
    dive.set("parentId", "n_root");
    dive.set("focusTopic", "i_high");
    const result = await createDiveFromForm(service, dive);
    expect(result).toMatchObject({ researchStarted: false, researchError: "Research providers are not configured" });
    expect(result.child).toMatchObject({ id: "n_phase4", parentId: "n_root", depth: 1, status: "pending" });
    expect(result.child.brief.inheritedContext?.selectedIdea?.id).toBe("i_high");

    const persisted = await loadStore(path);
    expect(persisted.ideas.find((item) => item.id === "i_mid")?.rating).toBe(0.8);
    expect(persisted.nodes.find((node) => node.id === "n_phase4")).toBeDefined();
  });
});
