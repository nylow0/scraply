import { expect, test } from "bun:test";
import { planOpportunityStep, previewOpportunityBudgetExtension } from "../../src/core/opportunity-planning";
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
