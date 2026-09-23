import { expect, test } from "bun:test";
import { allocateIdeaTargets, planIdeaFill, planOpportunityStep, previewOpportunityBudgetExtension } from "../../src/core/opportunity-planning";
import {
  OpportunityExplorationProgressSchema,
  type OpportunityExplorationProgress,
} from "../../src/shared/opportunity-exploration";

const now = "2026-09-19T10:00:00.000Z";

function progress(overrides: Partial<OpportunityExplorationProgress> = {}): OpportunityExplorationProgress {
  return OpportunityExplorationProgressSchema.parse({
    threadId: "project",
    config: {
      targetFamilies: 30,
      batchSize: 5,
      maxExpansionRounds: 2,
      maxRawCandidates: 60,
      maxModelCalls: 12,
      maxSearches: 6,
      allowExploratoryProblems: false,
    },
    status: "mapping-coverage",
    stopReason: null,
    usage: { modelCalls: 1, searches: 0, rawCandidates: 0, expansionRounds: 0 },
    counts: { acceptedFamilies: 0, variants: 0, duplicates: 0, other: 0, unresolved: 0, unreviewed: 0 },
    originCounts: { problemEvidence: 0, exploratoryHypotheses: 0 },
    gaps: [],
    batches: [],
    activeGapId: null,
    startedAt: now,
    updatedAt: now,
    ...overrides,
  });
}

test("the last permitted expansion round can process its already named gap", () => {
  const current = progress({
    config: {
      targetFamilies: 30,
      batchSize: 5,
      maxExpansionRounds: 1,
      maxRawCandidates: 60,
      maxModelCalls: 12,
      maxSearches: 6,
      allowExploratoryProblems: false,
    },
    usage: { modelCalls: 1, searches: 0, rawCandidates: 10, expansionRounds: 1 },
    gaps: [{
      id: "gap-1",
      name: "Parts approval",
      description: "A reviewed workflow gap",
      dimension: "trigger",
      evidenceNeeded: null,
      searchQuery: null,
      mapExhausted: false,
      candidateOrigin: "evidence-only",
      status: "ready",
      createdAt: now,
      updatedAt: now,
    }],
  });

  expect(planOpportunityStep({ progress: current, maxRunMinutes: 10, elapsedMinutes: 1 })).toEqual({
    kind: "generate-batch",
    gap: current.gaps[0]!,
    candidateCount: 5,
    reason: 'Generate 5 candidates for the named gap "Parts approval", then review the entire batch before planning more.',
  });
});

test("a fully reviewed batch with no accepted-family gain stops even when another gap remains", () => {
  const decision = planOpportunityStep({
    progress: progress({
      counts: { acceptedFamilies: 7, variants: 2, duplicates: 3, other: 1, unresolved: 2, unreviewed: 0 },
      usage: { modelCalls: 5, searches: 1, rawCandidates: 14, expansionRounds: 1 },
      gaps: [{
        id: "gap-2",
        name: "Another mapped gap",
        description: "A second gap that must not trigger padding after a zero-gain batch.",
        dimension: "trigger",
        evidenceNeeded: null,
        searchQuery: null,
        mapExhausted: false,
        candidateOrigin: "evidence-only",
        status: "ready",
        createdAt: now,
        updatedAt: now,
      }],
      batches: [{
        id: "batch-1",
        ordinal: 1,
        coverageGapId: "gap-1",
        requestedCandidates: 5,
        savedCandidateIds: ["candidate-1"],
        status: "reviewed",
        acceptedFamiliesBefore: 7,
        acceptedFamiliesAfter: 7,
        createdAt: now,
        updatedAt: now,
      }],
    }),
    maxRunMinutes: 10,
    elapsedMinutes: 2,
  });

  expect(decision).toEqual({
    kind: "terminal",
    status: "useful-partial",
    reason: "Expansion batch 1 added no accepted opportunity family. The 7 accepted families remain saved.",
  });
});

test("an open batch is reviewed before time and expansion budget stopping checks", () => {
  const decision = planOpportunityStep({
    progress: progress({
      usage: { modelCalls: 12, searches: 6, rawCandidates: 60, expansionRounds: 2 },
      batches: [{
        id: "batch-1",
        ordinal: 1,
        coverageGapId: "gap-1",
        requestedCandidates: 5,
        savedCandidateIds: ["candidate-1"],
        status: "awaiting-review",
        acceptedFamiliesBefore: 2,
        acceptedFamiliesAfter: null,
        createdAt: now,
        updatedAt: now,
      }],
    }),
    maxRunMinutes: 10,
    elapsedMinutes: 10,
  });

  expect(decision.kind).toBe("review-batch");
});

test("budget extensions leave hard raw-candidate and expansion-round limits intact", () => {
  const current = progress();
  const preview = previewOpportunityBudgetExtension(current, { additionalModelCalls: 3, additionalSearches: 2 });
  expect(preview.proposed).toEqual({ ...current.config, maxModelCalls: 15, maxSearches: 8 });
  expect(preview.proposed.maxRawCandidates).toBe(60);
  expect(preview.proposed.maxExpansionRounds).toBe(2);
});

test("project target allocation gives each ranked problem one slot before filling round-robin", () => {
  expect(allocateIdeaTargets({ problemIds: ["strong", "middle", "weak"], target: 8 })).toEqual({
    allocations: [
      { problemId: "strong", quota: 3 },
      { problemId: "middle", quota: 3 },
      { problemId: "weak", quota: 2 },
    ],
    unassignedCount: 0,
    reason: null,
  });
  expect(allocateIdeaTargets({ problemIds: ["strong", "middle", "weak"], target: 2 }).allocations).toEqual([
    { problemId: "strong", quota: 1 },
    { problemId: "middle", quota: 1 },
    { problemId: "weak", quota: 0 },
  ]);
});

test("project target allocation reports capacity shortfalls and rejects invalid input", () => {
  expect(allocateIdeaTargets({ problemIds: ["first", "second"], target: 5, maxPerProblem: 2 })).toEqual({
    allocations: [{ problemId: "first", quota: 2 }, { problemId: "second", quota: 2 }],
    unassignedCount: 1,
    reason: "The selected problems can accept at most 4 distinct ideas; 1 target slot cannot be assigned.",
  });
  expect(() => allocateIdeaTargets({ problemIds: ["same", "same"], target: 2 })).toThrow("distinct");
  expect(() => allocateIdeaTargets({ problemIds: ["valid"], target: 0 })).toThrow("positive whole number");
  expect(() => allocateIdeaTargets({ problemIds: ["valid"], target: 1, maxPerProblem: 21 })).toThrow("from 1 to 20");
});

test("a reviewed 20-to-12 set fills named gaps five, then three at a time", () => {
  const first = planIdeaFill({
    acceptedDistinct: 12,
    target: 20,
    rawCandidateCap: 40,
    rawCandidatesUsed: 20,
    fillRoundsUsed: 0,
    lastRoundAcceptedGain: null,
    namedGapIds: ["buyer-gap", "workflow-gap"],
    remainingModelCalls: 6,
    remainingMs: 30_000,
  });
  expect(first).toMatchObject({ kind: "generate", gapId: "buyer-gap", quota: 5, deficit: 8, round: 1 });
  const second = planIdeaFill({
    acceptedDistinct: 17,
    target: 20,
    rawCandidateCap: 40,
    rawCandidatesUsed: 25,
    fillRoundsUsed: 1,
    lastRoundAcceptedGain: 5,
    namedGapIds: ["workflow-gap"],
    remainingModelCalls: 4,
    remainingMs: 20_000,
  });
  expect(second).toMatchObject({ kind: "generate", gapId: "workflow-gap", quota: 3, deficit: 3, round: 2 });
});

test.each([1, 2, 3])("practical solution fill accepts a final deficit of %i", (deficit) => {
  const decision = planIdeaFill({
    acceptedDistinct: 20 - deficit,
    target: 20,
    rawCandidateCap: 40,
    rawCandidatesUsed: 30,
    fillRoundsUsed: 1,
    lastRoundAcceptedGain: 1,
    namedGapIds: ["last-gap"],
  });
  expect(decision).toMatchObject({ kind: "generate", gapId: "last-gap", quota: deficit });
});

test("practical solution fill stops on no gain, two rounds, or no named gap", () => {
  const base = {
    acceptedDistinct: 12,
    target: 20,
    rawCandidateCap: 40,
    rawCandidatesUsed: 20,
    fillRoundsUsed: 1,
    lastRoundAcceptedGain: 4,
    namedGapIds: ["gap"],
  };
  expect(planIdeaFill({ ...base, lastRoundAcceptedGain: 0 })).toMatchObject({ kind: "terminal", stop: "no-gain" });
  expect(planIdeaFill({ ...base, fillRoundsUsed: 2 })).toMatchObject({ kind: "terminal", stop: "round-limit" });
  expect(planIdeaFill({ ...base, namedGapIds: [] })).toMatchObject({ kind: "terminal", stop: "no-useful-gap" });
});

test("practical solution fill respects raw, model, and time capacity before requesting work", () => {
  const base = {
    acceptedDistinct: 12,
    target: 20,
    rawCandidateCap: 40,
    rawCandidatesUsed: 39,
    fillRoundsUsed: 1,
    lastRoundAcceptedGain: 4,
    namedGapIds: ["gap"],
  };
  expect(planIdeaFill(base)).toMatchObject({ kind: "generate", quota: 1 });
  expect(planIdeaFill({ ...base, rawCandidatesUsed: 40 })).toMatchObject({ kind: "terminal", stop: "raw-cap" });
  expect(planIdeaFill({ ...base, remainingModelCalls: 1 })).toMatchObject({ kind: "terminal", stop: "model-budget" });
  expect(planIdeaFill({ ...base, remainingMs: 0 })).toMatchObject({ kind: "terminal", stop: "time-budget" });
  expect(planIdeaFill({ ...base, remainingMs: -1 })).toMatchObject({ kind: "terminal", stop: "time-budget" });
  expect(planIdeaFill({ ...base, acceptedDistinct: 20, rawCandidatesUsed: 40 })).toMatchObject({ kind: "terminal", stop: "target-met" });
});

test.each([1, 2, 3])("a final deficit of %i plans a fully reviewable small batch", (deficit) => {
  const current = progress({
    config: {
      targetFamilies: 30,
      batchSize: 5,
      maxExpansionRounds: 2,
      maxRawCandidates: 60,
      maxModelCalls: 12,
      maxSearches: 6,
      allowExploratoryProblems: false,
    },
    counts: { acceptedFamilies: 30 - deficit, variants: 0, duplicates: 0, other: 0, unresolved: 0, unreviewed: 0 },
    usage: { modelCalls: 10, searches: 0, rawCandidates: 60 - deficit, expansionRounds: 2 },
    gaps: [{
      id: "last-gap",
      name: "Last missing workflow",
      description: "A ready gap from the final fill round",
      dimension: "trigger",
      evidenceNeeded: null,
      searchQuery: null,
      mapExhausted: false,
      candidateOrigin: "evidence-only",
      status: "ready",
      createdAt: now,
      updatedAt: now,
    }],
  });
  const decision = planOpportunityStep({ progress: current, maxRunMinutes: 90, elapsedMinutes: 20 });
  expect(decision.kind).toBe("generate-batch");
  if (decision.kind === "generate-batch") expect(decision.candidateCount).toBe(deficit);
});

test("accepted families cap the request even when raw capacity is larger", () => {
  const current = progress({
    counts: { acceptedFamilies: 28, variants: 0, duplicates: 0, other: 0, unresolved: 0, unreviewed: 0 },
    usage: { modelCalls: 9, searches: 0, rawCandidates: 40, expansionRounds: 2 },
    gaps: [{
      id: "gap",
      name: "Last workflow",
      description: "A ready gap",
      dimension: "trigger",
      evidenceNeeded: null,
      searchQuery: null,
      mapExhausted: false,
      candidateOrigin: "evidence-only",
      status: "ready",
      createdAt: now,
      updatedAt: now,
    }],
  });
  const decision = planOpportunityStep({ progress: current, maxRunMinutes: 90, elapsedMinutes: 20 });
  expect(decision.kind).toBe("generate-batch");
  if (decision.kind === "generate-batch") expect(decision.candidateCount).toBe(2);
});

test("the second exhausted fill round has an explicit terminal reason", () => {
  const current = progress({
    counts: { acceptedFamilies: 17, variants: 0, duplicates: 0, other: 0, unresolved: 0, unreviewed: 0 },
    usage: { modelCalls: 7, searches: 0, rawCandidates: 25, expansionRounds: 2 },
  });
  expect(planOpportunityStep({ progress: current, maxRunMinutes: 90, elapsedMinutes: 20 })).toMatchObject({
    kind: "terminal",
    status: "budget-exhausted",
    reason: expect.stringContaining("expansion limit of 2 rounds is exhausted"),
  });
});

test("the planner stops before generation when no review call can fit", () => {
  const current = progress({
    usage: { modelCalls: 11, searches: 0, rawCandidates: 10, expansionRounds: 1 },
    gaps: [{
      id: "gap",
      name: "Demand gap",
      description: "A ready gap",
      dimension: "trigger",
      evidenceNeeded: null,
      searchQuery: null,
      mapExhausted: false,
      candidateOrigin: "evidence-only",
      status: "ready",
      createdAt: now,
      updatedAt: now,
    }],
  });
  expect(planOpportunityStep({ progress: current, maxRunMinutes: 90, elapsedMinutes: 20 })).toMatchObject({
    kind: "terminal",
    status: "budget-exhausted",
    reason: expect.stringContaining("generation and review need at least 2"),
  });
});

test("mapping needs room for mapping, generation, and review", () => {
  const current = progress({
    usage: { modelCalls: 10, searches: 0, rawCandidates: 0, expansionRounds: 0 },
  });
  expect(planOpportunityStep({ progress: current, maxRunMinutes: 90, elapsedMinutes: 20 })).toMatchObject({
    kind: "terminal",
    status: "budget-exhausted",
    reason: expect.stringContaining("coverage mapping, generation, and review need at least 3"),
  });
});
