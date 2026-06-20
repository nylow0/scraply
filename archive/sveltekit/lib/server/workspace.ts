import { CreateChildInputSchema, RateIdeaInputSchema, type StoredIdea } from "../../store/schema";
import type { TreeService, TreeSnapshot } from "../../store/tree";

export type IdeaBucket = StoredIdea["bucket"];

export interface WorkspaceIdea extends StoredIdea {
  supportingClaims: Array<{ id: string; text: string; confidence: number; verified: boolean }>;
}

export interface WorkspaceView {
  tree: TreeSnapshot;
  selected: null | {
    node: Awaited<ReturnType<TreeService["getNode"]>>["node"];
    ideasByBucket: Record<IdeaBucket, WorkspaceIdea[]>;
    preferenceContext: Awaited<ReturnType<TreeService["getNode"]>>["preferenceContext"];
    path: TreeSnapshot["nodes"];
  };
}

export async function loadWorkspaceView(service: TreeService, selectedId?: string | null): Promise<WorkspaceView> {
  const tree = await service.getTree();
  if (tree.nodes.length === 0) return { tree, selected: null };

  const selectedSummary = tree.nodes.find((node) => node.id === selectedId)
    ?? tree.nodes.find((node) => node.parentId === null)
    ?? tree.nodes[0]!;
  const detail = await service.getNode(selectedSummary.id);
  const claims = new Map(detail.claims.map((claim) => [claim.id, claim]));
  const ideasByBucket: Record<IdeaBucket, WorkspaceIdea[]> = {
    "sweet-spot": [],
    "creative-outlier": [],
    "safe-bet": [],
  };

  for (const idea of detail.ideas) {
    ideasByBucket[idea.bucket].push({
      ...idea,
      supportingClaims: idea.supportingClaimIds.flatMap((id) => {
        const claim = claims.get(id);
        return claim ? [{ id: claim.id, text: claim.text, confidence: claim.confidence, verified: claim.verified }] : [];
      }),
    });
  }

  const path: TreeSnapshot["nodes"] = [];
  const seen = new Set<string>();
  let cursor: typeof selectedSummary | undefined = selectedSummary;
  while (cursor) {
    if (seen.has(cursor.id)) throw new Error(`Cycle in UI tree at node: ${cursor.id}`);
    seen.add(cursor.id);
    path.unshift(cursor);
    cursor = cursor.parentId ? tree.nodes.find((node) => node.id === cursor!.parentId) : undefined;
  }

  return { tree, selected: { node: detail.node, ideasByBucket, preferenceContext: detail.preferenceContext, path } };
}

export async function rateIdeaFromForm(service: TreeService, data: FormData): Promise<StoredIdea> {
  const input = RateIdeaInputSchema.parse({ ideaId: data.get("ideaId"), rating: data.get("rating") });
  return service.rateIdea(input.ideaId, input.rating);
}

export async function createDiveFromForm(service: TreeService, data: FormData) {
  const input = CreateChildInputSchema.parse({ parentId: data.get("parentId"), focusTopic: data.get("focusTopic") });
  const child = await service.createChild(input.parentId, input.focusTopic);
  try {
    await service.researchNode(child.id);
    return { child, researchStarted: true as const };
  } catch (error) {
    return {
      child,
      researchStarted: false as const,
      researchError: error instanceof Error ? error.message : "Research could not start",
    };
  }
}

export function actionError(error: unknown): { message: string; detail: string } {
  const detail = error instanceof Error ? error.message : "Unknown local error";
  if (detail.includes("Depth cap")) return { message: "Depth cap reached", detail };
  if (detail.includes("budget cap")) return { message: "Node budget cap reached", detail };
  if (detail.includes("required") || detail.includes("Invalid environment") || detail.includes("not configured")) {
    return { message: "Research providers are not configured", detail };
  }
  return { message: "The local action failed", detail };
}
