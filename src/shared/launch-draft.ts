import { framedDiscoveryProjection } from "./discovery-projection";
import { DEFAULT_IDEA_COUNT, type DiscoveryDepth, type ResearchMode, type RunConfig } from "./schemas";
import type { Scope } from "./structured-output-schemas";
import type { WorkflowLaunchDraft } from "./workflow-contracts";

export type WorkflowLaunchOptions = {
  automaticProblemCap?: number | null;
  limits?: Partial<Pick<WorkflowLaunchDraft["limits"], "maxModelCalls" | "maxSearches">>;
  instructions?: WorkflowLaunchDraft["instructions"];
  languageCount?: number;
} & (
  | { mode: "vibe"; ideas: Pick<NonNullable<WorkflowLaunchDraft["ideas"]>, "model" | "reasoningEffort"> }
  | { mode: "babysit" }
);

/** New launches show these estimates without enforcing them as research budgets. */
export function launchDraftEstimates(researchMode: ResearchMode, depth: DiscoveryDepth, languageCount = 3) {
  if (researchMode === "known-problem") return { maxModelCalls: 14, maxSearches: 0 };
  const projection = framedDiscoveryProjection(depth, languageCount);
  return { maxModelCalls: projection.modelCalls * 2 + 12, maxSearches: projection.searches + 2 };
}

/** Build a new launch from saved or edited values. Availability checks belong to preview, never model substitution. */
export function buildWorkflowLaunchDraft(scope: Scope, config: RunConfig, options: WorkflowLaunchOptions): WorkflowLaunchDraft {
  const researchMode = config.researchMode ?? "explore-market";
  const knownProblem = (config.knownProblem ?? "").trim();
  const brief = (researchMode === "known-problem" ? knownProblem : scope.domain).trim();
  const ideaCount = config.ideaCount ?? DEFAULT_IDEA_COUNT;
  const estimates = launchDraftEstimates(researchMode, config.discoveryDepth, options.languageCount);
  // The form constructs plain model refs in this order, including when a saved model is unavailable.
  const model = { providerId: config.model.providerId, modelId: config.model.modelId };
  const ideas = options.mode === "vibe" ? {
    model: { providerId: options.ideas.model.providerId, modelId: options.ideas.model.modelId },
    reasoningEffort: options.ideas.reasoningEffort,
  } : null;
  return {
    contractVersion: 1, frameWorkflowVersion: 1, purpose: researchMode === "known-problem" ? "known-problem" : "discovery",
    mode: options.mode, brief,
    scope: {
      title: scope.title.trim() || brief.slice(0, 80), audience: scope.audience.trim(), domain: scope.domain.trim(),
      observations: scope.observations.trim(), riskEvaluationCriteria: (scope.riskEvaluationCriteria ?? "").trim(),
      offLimits: scope.offLimits.flatMap((item) => item.split("\n")).map((item) => item.trim()).filter(Boolean),
    },
    runConfig: {
      configVersion: 2, workflowVersion: 2, ideaCount,
      model, reasoningEffort: config.reasoningEffort, discoveryDepth: config.discoveryDepth,
      searchProvider: config.searchProvider, maxRunMinutes: config.maxRunMinutes,
      researchMode, knownProblem, explorationPurpose: config.explorationPurpose ?? "auto",
    },
    ...(ideas ? { ideas: { model: ideas.model, reasoningEffort: ideas.reasoningEffort,
      reviewModel: ideas.model, reviewReasoningEffort: ideas.reasoningEffort } } : {}),
    targets: {
      kind: "per-problem", ideaCount,
      ...(options.mode === "vibe" && researchMode === "explore-market" && options.automaticProblemCap != null
        ? { automaticProblemCap: options.automaticProblemCap } : {}),
    },
    limits: { enforced: false, maxMinutes: config.maxRunMinutes,
      maxModelCalls: options.limits?.maxModelCalls ?? estimates.maxModelCalls,
      maxSearches: options.limits?.maxSearches ?? estimates.maxSearches },
    instructions: { research: options.instructions?.research?.trim() ?? "", ideas: options.instructions?.ideas?.trim() ?? "",
      review: options.instructions?.review?.trim() ?? "" },
  };
}
