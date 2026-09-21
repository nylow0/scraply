import {
  OpportunityBudgetExtensionPreviewSchema,
  OpportunityExplorationConfigSchema,
  type OpportunityBudgetExtension,
  type OpportunityBudgetExtensionPreview,
  type OpportunityCoverageGap,
  type OpportunityExplorationProgress,
  type OpportunityTerminalStatus,
} from "../shared/opportunity-exploration";

export type OpportunityPlanningDecision =
  | { kind: "map-coverage"; reason: string }
  | { kind: "search-gap"; gap: OpportunityCoverageGap; reason: string }
  | { kind: "generate-batch"; gap: OpportunityCoverageGap; candidateCount: number; reason: string }
  | { kind: "review-batch"; batchId: string; reason: string }
  | { kind: "wait-for-batch"; batchId: string; reason: string }
  | { kind: "terminal"; status: OpportunityTerminalStatus; reason: string };

export interface OpportunityPlanningInput {
  progress: OpportunityExplorationProgress;
  maxRunMinutes: number;
  elapsedMinutes: number;
}

/**
 * Chooses one bounded coordinator action. It never infers semantic coverage or family membership.
 * Those judgments must already be persisted by the review stages supplied in progress.
 */
export function planOpportunityStep(input: OpportunityPlanningInput): OpportunityPlanningDecision {
  const { progress } = input;
  const config = OpportunityExplorationConfigSchema.parse(progress.config);
  if (!Number.isFinite(input.elapsedMinutes) || input.elapsedMinutes < 0) {
    throw new Error("Elapsed exploration time must be a nonnegative number.");
  }
  if (!Number.isFinite(input.maxRunMinutes) || input.maxRunMinutes <= 0) {
    throw new Error("Opportunity exploration needs a positive time budget.");
  }

  if (["target-reached", "useful-partial", "budget-exhausted", "paused", "failed"].includes(progress.status)) {
    return {
      kind: "terminal",
      status: progress.status as OpportunityTerminalStatus,
      reason: progress.stopReason ?? terminalFallback(progress.status),
    };
  }

  const openBatch = progress.batches.find((batch) =>
    ["planned", "generating", "awaiting-review", "reviewing", "unknown-dispatch", "failed"].includes(batch.status));
  if (openBatch) {
    if (["awaiting-review", "reviewing"].includes(openBatch.status)) {
      return {
        kind: "review-batch",
        batchId: openBatch.id,
        reason: `Batch ${openBatch.ordinal} must be reviewed in full before another batch is planned.`,
      };
    }
    if (openBatch.status === "unknown-dispatch") {
      return {
        kind: "terminal",
        status: "failed",
        reason: `Batch ${openBatch.ordinal} may have reached the provider before the result was saved. It will not be replayed automatically.`,
      };
    }
    if (openBatch.status === "failed") {
      return {
        kind: "terminal",
        status: "failed",
        reason: `Batch ${openBatch.ordinal} failed. Retry that stage without regenerating accepted work.`,
      };
    }
    return {
      kind: "wait-for-batch",
      batchId: openBatch.id,
      reason: `Batch ${openBatch.ordinal} is still ${openBatch.status}.`,
    };
  }

  if (progress.counts.acceptedFamilies >= config.targetFamilies) {
    return {
      kind: "terminal",
      status: "target-reached",
      reason: `${progress.counts.acceptedFamilies} accepted opportunity families reached the target of ${config.targetFamilies}.`,
    };
  }

  const timeRemaining = input.maxRunMinutes - input.elapsedMinutes;
  if (timeRemaining <= 0) {
    return budgetStop(progress, `The ${input.maxRunMinutes}-minute project time budget is exhausted.`);
  }
  if (progress.usage.rawCandidates >= config.maxRawCandidates) {
    return budgetStop(progress, `The raw candidate limit of ${config.maxRawCandidates} is exhausted.`);
  }
  if (progress.usage.modelCalls >= config.maxModelCalls) {
    return budgetStop(progress, `The model-call limit of ${config.maxModelCalls} is exhausted.`);
  }

  const lastReviewed = [...progress.batches].reverse().find((batch) => batch.status === "reviewed");
  if (lastReviewed && lastReviewed.acceptedFamiliesAfter === lastReviewed.acceptedFamiliesBefore) {
    return {
      kind: "terminal",
      status: "useful-partial",
      reason: `Expansion batch ${lastReviewed.ordinal} added no accepted opportunity family. The ${progress.counts.acceptedFamilies} accepted families remain saved.`,
    };
  }

  const availableGaps = progress.gaps.filter((gap) => ["named", "search-needed", "ready"].includes(gap.status));
  if (availableGaps.length === 0) {
    if (progress.usage.expansionRounds >= config.maxExpansionRounds) {
      return budgetStop(progress, `The expansion limit of ${config.maxExpansionRounds} rounds is exhausted.`);
    }
    return { kind: "map-coverage", reason: "Review the saved inventory and name a concrete coverage gap before expanding it." };
  }

  const gap = availableGaps[0]!;
  if (["buyer", "workflow"].includes(gap.dimension) && !gap.mapExhausted) {
    return {
      kind: "terminal",
      status: "failed",
      reason: `Coverage gap "${gap.name}" proposes a new ${gap.dimension} before the existing problem map is exhausted.`,
    };
  }
  if (gap.candidateOrigin === "exploratory-allowed" && !config.allowExploratoryProblems) {
    return {
      kind: "terminal",
      status: "failed",
      reason: `Coverage gap "${gap.name}" requires exploratory problem hypotheses, but this project allows evidence-backed problems only.`,
    };
  }

  if (gap.status === "search-needed") {
    if (!gap.evidenceNeeded || !gap.searchQuery) {
      return {
        kind: "terminal",
        status: "failed",
        reason: `Coverage gap "${gap.name}" requires evidence but has no bounded evidence request and search query.`,
      };
    }
    if (progress.usage.searches >= config.maxSearches) {
      return budgetStop(progress, `Coverage gap "${gap.name}" needs evidence, but the search limit of ${config.maxSearches} is exhausted.`);
    }
    return {
      kind: "search-gap",
      gap,
      reason: `Search only for the evidence named by coverage gap "${gap.name}" before generating another batch.`,
    };
  }

  if (gap.status === "named") {
    return {
      kind: "map-coverage",
      reason: `Coverage gap "${gap.name}" must be marked ready or given a bounded evidence request before generation.`,
    };
  }

  const rawCapacity = config.maxRawCandidates - progress.usage.rawCandidates;
  if (rawCapacity < 4) {
    return budgetStop(progress, `Only ${rawCapacity} raw candidate slots remain, fewer than the minimum batch of 4.`);
  }
  const candidateCount = Math.min(config.batchSize, rawCapacity, 6);
  return {
    kind: "generate-batch",
    gap,
    candidateCount,
    reason: `Generate ${candidateCount} candidates for the named gap "${gap.name}", then review the entire batch before planning more.`,
  };
}

export function previewOpportunityBudgetExtension(
  progress: OpportunityExplorationProgress,
  extension: OpportunityBudgetExtension,
): OpportunityBudgetExtensionPreview {
  const current = OpportunityExplorationConfigSchema.parse(progress.config);
  const proposed = OpportunityExplorationConfigSchema.parse({
    ...current,
    maxModelCalls: current.maxModelCalls + extension.additionalModelCalls,
    maxSearches: current.maxSearches + extension.additionalSearches,
  });
  const nextGap = progress.gaps.find((gap) => ["named", "search-needed", "ready"].includes(gap.status)) ?? null;
  const needsSearch = nextGap?.status === "search-needed";
  const estimatedModelCalls = nextGap ? 2 : 1;
  const estimatedSearches = needsSearch ? 1 : 0;
  return OpportunityBudgetExtensionPreviewSchema.parse({
    current,
    proposed,
    nextGap,
    estimatedAdditionalCalls: { modelCalls: estimatedModelCalls, searches: estimatedSearches },
    summary: nextGap
      ? `The next bounded attempt covers "${nextGap.name}" with a baseline of ${estimatedModelCalls} model calls${needsSearch ? " and 1 search" : ""}; comparison chunks or one correction can use more within the project cap.`
      : "No next gap is saved. Extending the budget would first use one model call to map coverage.",
  });
}

function budgetStop(progress: OpportunityExplorationProgress, reason: string): OpportunityPlanningDecision {
  return {
    kind: "terminal",
    status: "budget-exhausted",
    reason: `${reason} ${progress.counts.acceptedFamilies} accepted families remain saved.`,
  };
}

function terminalFallback(status: OpportunityExplorationProgress["status"]): string {
  switch (status) {
    case "target-reached": return "The configured family target was reached.";
    case "useful-partial": return "The project stopped with a useful partial set.";
    case "budget-exhausted": return "The configured exploration budget was exhausted.";
    case "paused": return "Opportunity exploration is paused.";
    case "failed": return "Opportunity exploration failed.";
    default: return "Opportunity exploration stopped.";
  }
}
