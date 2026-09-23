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

export interface IdeaTargetAllocationInput {
  /** Selected problem IDs in saved evidence-rank order. */
  problemIds: string[];
  target: number;
  maxPerProblem?: number;
}

export interface IdeaTargetAllocation {
  allocations: Array<{ problemId: string; quota: number }>;
  unassignedCount: number;
  reason: string | null;
}

/** Assigns distinct idea slots once per problem, then round-robin in saved rank order. */
export function allocateIdeaTargets(input: IdeaTargetAllocationInput): IdeaTargetAllocation {
  const maxPerProblem = input.maxPerProblem ?? 20;
  if (!Number.isSafeInteger(input.target) || input.target < 1) {
    throw new Error("The idea target must be a positive whole number.");
  }
  if (!Number.isSafeInteger(maxPerProblem) || maxPerProblem < 1 || maxPerProblem > 20) {
    throw new Error("The per-problem idea limit must be a whole number from 1 to 20.");
  }
  if (input.problemIds.some((id) => !id.trim() || id !== id.trim()) || new Set(input.problemIds).size !== input.problemIds.length) {
    throw new Error("Selected problem IDs must be nonempty and distinct.");
  }

  const allocations = input.problemIds.map((problemId) => ({ problemId, quota: 0 }));
  let unassignedCount = input.target;
  while (unassignedCount > 0) {
    let assignedThisPass = 0;
    for (const allocation of allocations) {
      if (unassignedCount === 0) break;
      if (allocation.quota >= maxPerProblem) continue;
      allocation.quota += 1;
      unassignedCount -= 1;
      assignedThisPass += 1;
    }
    if (assignedThisPass === 0) break;
  }

  return {
    allocations,
    unassignedCount,
    reason: unassignedCount > 0
      ? `The selected problems can accept at most ${allocations.length * maxPerProblem} distinct ideas; ${unassignedCount} target ${unassignedCount === 1 ? "slot" : "slots"} cannot be assigned.`
      : null,
  };
}

export interface IdeaFillInput {
  acceptedDistinct: number;
  target: number;
  rawCandidateCap: number;
  rawCandidatesUsed: number;
  /** Completed fill rounds; the current round is not counted until its review finishes. */
  fillRoundsUsed: number;
  lastRoundAcceptedGain: number | null;
  /** Eligible coverage gaps in saved priority order. */
  namedGapIds: string[];
  remainingModelCalls?: number;
  remainingMs?: number;
}

export type IdeaFillDecision =
  | { kind: "generate"; gapId: string; quota: number; round: number; deficit: number; reason: string }
  | {
      kind: "terminal";
      stop: "target-met" | "time-budget" | "raw-cap" | "model-budget" | "no-gain" | "round-limit" | "no-useful-gap";
      reason: string;
    };

/** Uses only reviewed, distinct ideas to choose one bounded fill batch. */
export function planIdeaFill(input: IdeaFillInput): IdeaFillDecision {
  for (const [name, value] of [
    ["accepted distinct count", input.acceptedDistinct],
    ["idea target", input.target],
    ["raw candidate cap", input.rawCandidateCap],
    ["raw candidates used", input.rawCandidatesUsed],
    ["completed fill rounds", input.fillRoundsUsed],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < (name === "idea target" ? 1 : 0)) {
      throw new Error(`The ${name} must be a valid nonnegative whole number${name === "idea target" ? " above zero" : ""}.`);
    }
  }
  if (input.fillRoundsUsed > 2) throw new Error("At most two fill rounds are allowed.");
  if (input.lastRoundAcceptedGain !== null
    && (!Number.isSafeInteger(input.lastRoundAcceptedGain) || input.lastRoundAcceptedGain < 0)) {
    throw new Error("The last fill round gain must be a nonnegative whole number or null.");
  }
  if (input.remainingModelCalls !== undefined
    && (!Number.isSafeInteger(input.remainingModelCalls) || input.remainingModelCalls < 0)) {
    throw new Error("Remaining model calls must be a nonnegative whole number.");
  }
  if (input.remainingMs !== undefined && !Number.isFinite(input.remainingMs)) {
    throw new Error("Remaining time must be a finite number of milliseconds.");
  }
  if (input.namedGapIds.some((id) => !id.trim() || id !== id.trim())
    || new Set(input.namedGapIds).size !== input.namedGapIds.length) {
    throw new Error("Named gap IDs must be nonempty and distinct.");
  }

  if (input.acceptedDistinct >= input.target) {
    return { kind: "terminal", stop: "target-met", reason: `${input.acceptedDistinct} distinct ideas meet the target of ${input.target}.` };
  }
  if (input.remainingMs !== undefined && input.remainingMs <= 0) {
    return { kind: "terminal", stop: "time-budget", reason: "The project time budget is exhausted." };
  }
  const rawRemaining = Math.max(0, input.rawCandidateCap - input.rawCandidatesUsed);
  if (rawRemaining === 0) {
    return { kind: "terminal", stop: "raw-cap", reason: `The raw candidate cap of ${input.rawCandidateCap} is exhausted.` };
  }
  if (input.remainingModelCalls !== undefined && input.remainingModelCalls < 2) {
    return { kind: "terminal", stop: "model-budget", reason: "A new idea batch needs four available model calls to reserve generation, review, and possible schema corrections." };
  }
  if (input.lastRoundAcceptedGain === 0) {
    return { kind: "terminal", stop: "no-gain", reason: "The last reviewed fill round added no distinct idea." };
  }
  if (input.fillRoundsUsed >= 2) {
    return { kind: "terminal", stop: "round-limit", reason: "Two fill rounds finished without reaching the distinct idea target." };
  }
  const gapId = input.namedGapIds[0];
  if (!gapId) {
    return { kind: "terminal", stop: "no-useful-gap", reason: "No named coverage gap remains for a targeted fill batch." };
  }

  const deficit = input.target - input.acceptedDistinct;
  const quota = Math.min(5, deficit, rawRemaining);
  return {
    kind: "generate",
    gapId,
    quota,
    round: input.fillRoundsUsed + 1,
    deficit,
    reason: `Request ${quota} candidates for named gap "${gapId}", then review and recount distinct ideas.`,
  };
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

  // Every new generation needs a separate collection review before it can earn target credit.
  const modelCallsRemaining = config.maxModelCalls - progress.usage.modelCalls;
  if (modelCallsRemaining < 2) {
    return budgetStop(progress, `Only ${modelCallsRemaining} model call remains, but generation and review need at least 2.`);
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
    if (modelCallsRemaining < 3) {
      return budgetStop(progress, `Only ${modelCallsRemaining} model calls remain, but coverage mapping, generation, and review need at least 3.`);
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
    if (modelCallsRemaining < 3) {
      return budgetStop(progress, `Only ${modelCallsRemaining} model calls remain, but coverage mapping, generation, and review need at least 3.`);
    }
    return {
      kind: "map-coverage",
      reason: `Coverage gap "${gap.name}" must be marked ready or given a bounded evidence request before generation.`,
    };
  }

  const rawCapacity = config.maxRawCandidates - progress.usage.rawCandidates;
  const deficit = config.targetFamilies - progress.counts.acceptedFamilies;
  const candidateCount = Math.min(config.batchSize, rawCapacity, deficit, 6);
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
  const estimatedModelCalls = nextGap?.status === "ready" || needsSearch ? 2 : 3;
  const estimatedSearches = needsSearch ? 1 : 0;
  return OpportunityBudgetExtensionPreviewSchema.parse({
    current,
    proposed,
    nextGap,
    estimatedAdditionalCalls: { modelCalls: estimatedModelCalls, searches: estimatedSearches },
    summary: nextGap
      ? `The next bounded attempt covers "${nextGap.name}" with a baseline of ${estimatedModelCalls} model calls${needsSearch ? " and 1 search" : ""}; comparison chunks or one correction can use more within the project cap.`
      : "No next gap is saved. Mapping coverage, generation, and review need a baseline of 3 model calls.",
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
