import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderFailure, type StructuredModelClient, type StructuredStageRequest, type StructuredStageResult } from "../../src/providers/structured";
import { reviewSavedOpportunities } from "../../src/core/opportunity-review";
import { DatabaseClient } from "../../src/db/client";
import { OpportunityExplorationRepository } from "../../src/db/repositories/opportunity-exploration";
import {
  OpportunityRepository,
  acceptedOpportunityFamilyCount,
  recoverInterruptedOpportunityReviews,
} from "../../src/db/repositories/opportunities";
import type { OpportunityReviewOutput } from "../../src/shared/opportunity-review";
import { DEFAULT_OPPORTUNITY_EXPLORATION_CONFIG } from "../../src/shared/opportunity-exploration";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) {
    try { rmSync(directories.pop()!, { recursive: true, force: true }); } catch { /* SQLite may retain a Windows handle. */ }
  }
});

describe("opportunity review", () => {
  test("counts distinct startup families, keeps duplicates visible, and records reversible human edits", async () => {
    const db = database();
    seedOptions(db, ["option-a", "option-b", "option-c"]);
    const model = new PairwiseModel((candidateId, targetId) =>
      candidateId === "option-b" && targetId === "option-a" ? "duplicate" : "separate-business");

    const result = await reviewSavedOpportunities({
      db,
      threadId: "thread-1",
      modelClient: model,
      model: DEFAULT_RUN_CONFIG.model,
      reasoningEffort: "medium",
      limits: { candidatesPerBatch: 8, targetsPerChunk: 12 },
    });

    expect(result.modelCalls).toBe(1);
    expect(result.opportunities.acceptedFamilyCount).toBe(2);
    expect(result.opportunities.rawOptionCount).toBe(3);
    expect(result.opportunities.unreviewedOptionIds).toEqual([]);
    const duplicate = result.opportunities.families.flatMap((family) => family.members)
      .find((member) => member.optionId === "option-b");
    expect(duplicate?.relationship).toBe("duplicate");
    expect(acceptedOpportunityFamilyCount(db, "thread-1")).toBe(2);

    const repository = new OpportunityRepository(db);
    repository.editMembership("thread-1", {
      operation: "mark-uncertain",
      optionId: "option-a",
      reason: "The purchase boundary needs a customer interview.",
    });
    expect(repository.familyView("thread-1").acceptedFamilyCount).toBe(2);

    repository.editMembership("thread-1", {
      operation: "split",
      optionId: "option-a",
      title: "Option A standalone",
      summary: "A separate purchase after human review.",
      reason: "The trigger and budget owner differ.",
    });
    expect(repository.familyView("thread-1").acceptedFamilyCount).toBe(3);
    const exported = repository.exportReview("thread-1");
    expect(exported.membershipHistory.filter((item) => item.optionId === "option-a")).toHaveLength(3);
    expect(exported.coverage.every((item) => item.complete)).toBe(true);
    expect(exported.reviews[0]?.request).toBeTruthy();
    db.close();
  });

  test("reports 18 accepted families for 30 raw options with 12 duplicates", async () => {
    const db = database();
    seedOptions(db, Array.from({ length: 30 }, (_, index) => `option-${index}`));
    const result = await reviewSavedOpportunities({
      db,
      threadId: "thread-1",
      modelClient: new EighteenFamilyModel(),
      model: DEFAULT_RUN_CONFIG.model,
      reasoningEffort: "medium",
    });

    expect(result.opportunities.rawOptionCount).toBe(30);
    expect(result.opportunities.reviewedOptionCount).toBe(30);
    const duplicateIds = result.opportunities.families.flatMap((family) => family.members)
      .filter((member) => member.relationship === "duplicate")
      .map((member) => member.optionId)
      .sort((left, right) => Number(left.replace("option-", "")) - Number(right.replace("option-", "")));
    expect(duplicateIds).toEqual(Array.from({ length: 12 }, (_, index) => `option-${index + 18}`));
    expect(result.opportunities.acceptedFamilyCount).toBe(18);
    expect(result.opportunities.unresolved).toEqual([]);
    db.close();
  });

  test("projects exploration counts from current review membership instead of saved counters", async () => {
    const db = database();
    seedOptions(db, ["option-a", "option-b", "option-c"]);
    const exploration = new OpportunityExplorationRepository(db);
    db.immediateTransaction(() => exploration.create("thread-1", DEFAULT_OPPORTUNITY_EXPLORATION_CONFIG));
    expect(exploration.find("thread-1")?.counts).toMatchObject({
      acceptedFamilies: 0,
      duplicates: 0,
      unresolved: 0,
      unreviewed: 3,
    });

    await reviewSavedOpportunities({
      db,
      threadId: "thread-1",
      modelClient: new PairwiseModel((candidateId, targetId) =>
        candidateId === "option-b" && targetId === "option-a" ? "duplicate" : "separate-business"),
      model: DEFAULT_RUN_CONFIG.model,
      reasoningEffort: "medium",
    });
    expect(exploration.find("thread-1")?.counts).toMatchObject({
      acceptedFamilies: 2,
      duplicates: 1,
      unresolved: 0,
      unreviewed: 0,
    });

    db.setSetting("discarded-ideas:thread-1", JSON.stringify(["option-b"]));
    expect(exploration.find("thread-1")?.counts.duplicates).toBe(0);
    const opportunities = new OpportunityRepository(db);
    opportunities.editMembership("thread-1", {
      operation: "mark-uncertain",
      optionId: "option-b",
      reason: "The buyer boundary needs review.",
    });
    expect(exploration.find("thread-1")?.counts.unresolved).toBe(0);

    db.setSetting("discarded-ideas:thread-1", "[]");
    expect(exploration.find("thread-1")?.counts.unresolved).toBe(1);
    opportunities.editMembership("thread-1", {
      operation: "split",
      optionId: "option-b",
      title: "Option B standalone",
      summary: "A distinct purchase after human review.",
      reason: "The buyer and trigger are independent.",
    });
    const splitView = opportunities.familyView("thread-1");
    expect(exploration.find("thread-1")?.counts.acceptedFamilies).toBe(3);
    const sourceFamilyId = splitView.families.find((family) => family.representativeOptionId === "option-b")?.id;
    const targetFamilyId = splitView.families.find((family) => family.representativeOptionId === "option-a")?.id;
    expect(sourceFamilyId).toBeTruthy();
    expect(targetFamilyId).toBeTruthy();
    opportunities.editMembership("thread-1", {
      operation: "merge-family",
      sourceFamilyId: sourceFamilyId!,
      targetFamilyId: targetFamilyId!,
      reason: "Human review found one sellable workflow.",
    });
    expect(exploration.find("thread-1")?.counts).toMatchObject({
      acceptedFamilies: 2,
      variants: 1,
      duplicates: 0,
      unresolved: 0,
    });
    db.close();
  });

  test("projects a reached target as useful partial after a membership edit and restores it with the count", async () => {
    const db = database();
    seedOptions(db, ["option-a", "option-b"]);
    const exploration = new OpportunityExplorationRepository(db);
    const config = {
      ...DEFAULT_OPPORTUNITY_EXPLORATION_CONFIG,
      targetFamilies: 2,
      maxRawCandidates: 4,
    };
    db.immediateTransaction(() => exploration.create("thread-1", config));
    await reviewSavedOpportunities({
      db,
      threadId: "thread-1",
      modelClient: new PairwiseModel(() => "separate-business"),
      model: DEFAULT_RUN_CONFIG.model,
      reasoningEffort: "medium",
    });
    const reachedReason = "The requested 2 accepted families were reviewed.";
    db.immediateTransaction(() => exploration.setStatus("thread-1", "target-reached", reachedReason));

    const opportunities = new OpportunityRepository(db);
    opportunities.editMembership("thread-1", {
      operation: "mark-uncertain",
      optionId: "option-a",
      reason: "The purchase boundary needs another review.",
    });
    const projected = exploration.find("thread-1");
    expect(projected?.status).toBe("useful-partial");
    expect(projected?.counts.acceptedFamilies).toBe(1);
    expect(projected?.stopReason).toContain("Review changes left 1 accepted family; the target is 2");
    expect(exploration.exportExploration("thread-1").progress).toMatchObject({
      status: "useful-partial",
      counts: { acceptedFamilies: 1 },
    });

    opportunities.editMembership("thread-1", {
      operation: "split",
      optionId: "option-a",
      title: "Option A restored",
      summary: "A standalone purchase confirmed by human review.",
      reason: "The buyer and trigger are distinct after review.",
    });
    expect(exploration.find("thread-1")).toMatchObject({
      status: "target-reached",
      stopReason: reachedReason,
      counts: { acceptedFamilies: 2 },
    });
    db.close();
  });

  test("allows one semantic correction and never accepts incomplete coverage", async () => {
    const db = database();
    seedOptions(db, ["option-a", "option-b"]);
    const model = new PairwiseModel(() => "separate-business", 1);

    const result = await reviewSavedOpportunities({
      db,
      threadId: "thread-1",
      modelClient: model,
      model: DEFAULT_RUN_CONFIG.model,
      reasoningEffort: "medium",
    });

    expect(result.modelCalls).toBe(2);
    expect(result.correctedCalls).toBe(1);
    expect(result.opportunities.acceptedFamilyCount).toBe(2);
    const exported = new OpportunityRepository(db).exportReview("thread-1");
    expect(exported.reviews.map((review) => review.correctionNumber)).toEqual([0, 1]);
    expect(exported.coverage.some((entry) => !entry.complete)).toBe(true);
    expect(exported.coverage.some((entry) => entry.complete)).toBe(true);
    db.close();
  });

  test("reuses a completed correction when memberships were not committed", async () => {
    const db = database();
    seedOptions(db, ["option-a", "option-b"]);
    await reviewSavedOpportunities({
      db,
      threadId: "thread-1",
      modelClient: new PairwiseModel(() => "separate-business", 1),
      model: DEFAULT_RUN_CONFIG.model,
      reasoningEffort: "medium",
    });
    db.immediateTransaction(() => {
      db.db.prepare("DELETE FROM opportunity_membership_decisions").run();
      db.db.prepare("DELETE FROM opportunity_families").run();
    });

    const model = new NoDispatchModel();
    const resumed = await reviewSavedOpportunities({
      db,
      threadId: "thread-1",
      modelClient: model,
      model: DEFAULT_RUN_CONFIG.model,
      reasoningEffort: "medium",
    });
    expect(model.calls).toBe(0);
    expect(resumed.modelCalls).toBe(0);
    expect(resumed.opportunities.acceptedFamilyCount).toBe(2);
    db.close();
  });

  test("leaves every candidate unreviewed when the correction is still incomplete", async () => {
    const db = database();
    seedOptions(db, ["option-a", "option-b"]);
    const model = new PairwiseModel(() => "separate-business", 2);

    await expect(reviewSavedOpportunities({
      db,
      threadId: "thread-1",
      modelClient: model,
      model: DEFAULT_RUN_CONFIG.model,
      reasoningEffort: "medium",
    })).rejects.toThrow("stayed incomplete after one correction");

    const view = new OpportunityRepository(db).familyView("thread-1");
    expect(view.acceptedFamilyCount).toBe(0);
    expect(view.unreviewedOptionIds).toEqual(["option-a", "option-b"]);
    expect(view.reviewStatus).toBe("failed");
    expect(view.reviewError).toContain("missing comparison");
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM opportunity_membership_decisions").get()).toEqual({ count: 0 });
    db.close();
  });

  test("blocks an unknown post-dispatch result until an explicit retry is acknowledged", async () => {
    const db = database();
    seedOptions(db, ["option-a"]);
    const model = new FlakyDispatchModel();
    const request = {
      db,
      threadId: "thread-1",
      modelClient: model,
      model: DEFAULT_RUN_CONFIG.model,
      reasoningEffort: "medium" as const,
    };

    await expect(reviewSavedOpportunities(request)).rejects.toThrow("response was lost");
    expect(new OpportunityRepository(db).familyView("thread-1").reviewStatus).toBe("blocked");
    await expect(reviewSavedOpportunities(request)).rejects.toThrow("explicit user-approved review");
    expect(model.calls).toBe(1);

    const result = await reviewSavedOpportunities({ ...request, allowAmbiguousRetry: true });
    expect(model.calls).toBe(2);
    expect(result.opportunities.acceptedFamilyCount).toBe(1);
    expect(new OpportunityRepository(db).exportReview("thread-1").reviews[0]?.error).toMatch(/^acknowledged:/);
    db.close();
  });

  test("does not propagate uncertainty through a confirmed separate-business comparison", async () => {
    const db = database();
    seedOptions(db, ["option-a", "option-b"]);

    const result = await reviewSavedOpportunities({
      db,
      threadId: "thread-1",
      modelClient: new UnresolvedThenSeparateModel(),
      model: DEFAULT_RUN_CONFIG.model,
      reasoningEffort: "medium",
      limits: { candidatesPerBatch: 1, targetsPerChunk: 12 },
    });

    expect(result.opportunities.unresolved.map((item) => item.membership.optionId)).toEqual(["option-a"]);
    expect(result.opportunities.acceptedFamilyCount).toBe(1);
    expect(result.opportunities.families[0]?.representativeOptionId).toBe("option-b");
    db.close();
  });

  test("recovers calls left in flight by a stopped process before projecting review state", () => {
    const db = database();
    seedOptions(db, ["option-a"]);
    const repository = new OpportunityRepository(db);
    repository.prepareReviewCall(reviewCallInput(0));
    const dispatched = repository.prepareReviewCall(reviewCallInput(1));
    repository.markReviewDispatched(dispatched.id);

    expect(recoverInterruptedOpportunityReviews(db)).toEqual(["thread-1"]);
    const reviews = repository.exportReview("thread-1").reviews;
    expect(reviews.map((review) => review.status)).toEqual(["interrupted", "interrupted"]);
    expect(reviews.map((review) => review.error)).toContain("never-dispatched");
    expect(reviews.map((review) => review.error)).toContain("The app restarted after dispatch; provider completion is unknown.");
    expect(repository.familyView("thread-1").reviewStatus).not.toBe("running");
    expect(() => repository.assertReviewResumeSafe("thread-1")).toThrow("explicit user-approved review");
    expect(repository.acknowledgeAmbiguousReviewCalls("thread-1")).toBe(1);
    expect(() => repository.assertReviewResumeSafe("thread-1")).not.toThrow();
    db.close();
  });
});

class PairwiseModel implements StructuredModelClient {
  private calls = 0;

  constructor(
    private readonly relationship: (candidateId: string, targetId: string) => "duplicate" | "variant" | "separate-business" | "uncertain",
    private readonly incompleteCalls = 0,
  ) {}

  async structuredCompletion<T>(request: StructuredStageRequest<T>): Promise<StructuredStageResult<T>> {
    this.calls += 1;
    request.onDispatched?.();
    request.onAccepted?.({ protocolVersion: "test" });
    const inputs = request.workOrder.inputs as {
      expectedAssessmentIds: string[];
      expectedComparisons: Array<{ candidateOptionId: string; target: { kind: string; id: string } }>;
    };
    const comparisons = inputs.expectedComparisons.map((comparison) => ({
      candidateOptionId: comparison.candidateOptionId,
      target: comparison.target,
      relationship: this.relationship(comparison.candidateOptionId, comparison.target.id),
      reason: `Compared ${comparison.candidateOptionId} with ${comparison.target.id}.`,
      concreteDistinctionOrOverlap: `The purchase relationship for ${comparison.target.id} is explicit.`,
    }));
    if (this.calls <= this.incompleteCalls) comparisons.pop();
    const output: OpportunityReviewOutput = {
      assessments: inputs.expectedAssessmentIds.map((candidateOptionId) => ({
        candidateOptionId,
        status: "reviewable",
        reason: `${candidateOptionId} has enough saved business detail to compare.`,
      })),
      comparisons: comparisons as OpportunityReviewOutput["comparisons"],
    };
    return {
      output: request.schema.parse(output),
      metadata: {
        model: request.model,
        usage: { status: "unknown" },
        finishReason: "stop",
        latencyMs: 1,
        repairCount: 0,
        providerRequestIds: [`request-${this.calls}`],
        attempts: [],
      },
    };
  }
}

class FlakyDispatchModel implements StructuredModelClient {
  calls = 0;

  async structuredCompletion<T>(request: StructuredStageRequest<T>): Promise<StructuredStageResult<T>> {
    this.calls += 1;
    request.onDispatched?.();
    if (this.calls === 1) throw new ProviderFailure("timeout", "The provider response was lost.", true);
    request.onAccepted?.({ protocolVersion: "test" });
    const inputs = request.workOrder.inputs as { expectedAssessmentIds: string[] };
    return {
      output: request.schema.parse({
        assessments: inputs.expectedAssessmentIds.map((candidateOptionId) => ({
          candidateOptionId,
          status: "reviewable",
          reason: "The saved business description is reviewable.",
        })),
        comparisons: [],
      }),
      metadata: {
        model: request.model,
        usage: { status: "unknown" },
        finishReason: "stop",
        latencyMs: 1,
        repairCount: 0,
        providerRequestIds: ["request-retry"],
        attempts: [],
      },
    };
  }
}

class NoDispatchModel implements StructuredModelClient {
  calls = 0;

  async structuredCompletion<T>(): Promise<StructuredStageResult<T>> {
    this.calls += 1;
    throw new Error("A completed correction should have been reused");
  }
}

class EighteenFamilyModel implements StructuredModelClient {
  private calls = 0;

  async structuredCompletion<T>(request: StructuredStageRequest<T>): Promise<StructuredStageResult<T>> {
    this.calls += 1;
    request.onDispatched?.();
    request.onAccepted?.({ protocolVersion: "test" });
    const inputs = request.workOrder.inputs as {
      expectedAssessmentIds: string[];
      expectedComparisons: Array<{ candidateOptionId: string; target: { kind: string; id: string } }>;
    };
    const evidence = request.evidence[0]?.content as {
      families: Array<{ familyId: string; representativeOptionId: string }>;
    };
    const representativeByFamily = new Map(evidence.families.map((family) => [family.familyId, family.representativeOptionId]));
    const output: OpportunityReviewOutput = {
      assessments: inputs.expectedAssessmentIds.map((candidateOptionId) => ({
        candidateOptionId,
        status: "reviewable",
        reason: "The saved option has a complete compact business record.",
      })),
      comparisons: inputs.expectedComparisons.map((comparison) => {
        const candidateNumber = Number(comparison.candidateOptionId.replace("option-", ""));
        const targetOptionId = comparison.target.kind === "family"
          ? representativeByFamily.get(comparison.target.id)
          : comparison.target.id;
        const duplicateTarget = candidateNumber >= 18 ? `option-${candidateNumber - 18}` : null;
        const relationship = duplicateTarget === targetOptionId ? "duplicate" as const : "separate-business" as const;
        return {
          candidateOptionId: comparison.candidateOptionId,
          target: comparison.target as OpportunityReviewOutput["comparisons"][number]["target"],
          relationship,
          reason: relationship === "duplicate" ? "The purchase and workflow match." : "The purchase remains distinct.",
          concreteDistinctionOrOverlap: relationship === "duplicate" ? "Same trigger, job, and sellable workflow." : "Different standalone workflow.",
        };
      }),
    };
    return {
      output: request.schema.parse(output),
      metadata: {
        model: request.model,
        usage: { status: "unknown" },
        finishReason: "stop",
        latencyMs: 1,
        repairCount: 0,
        providerRequestIds: [`family-request-${this.calls}`],
        attempts: [],
      },
    };
  }
}

class UnresolvedThenSeparateModel implements StructuredModelClient {
  private calls = 0;

  async structuredCompletion<T>(request: StructuredStageRequest<T>): Promise<StructuredStageResult<T>> {
    this.calls += 1;
    request.onDispatched?.();
    request.onAccepted?.({ protocolVersion: "test" });
    const inputs = request.workOrder.inputs as {
      expectedAssessmentIds: string[];
      expectedComparisons: Array<{ candidateOptionId: string; target: { kind: string; id: string } }>;
    };
    const output: OpportunityReviewOutput = {
      assessments: inputs.expectedAssessmentIds.map((candidateOptionId) => ({
        candidateOptionId,
        status: candidateOptionId === "option-a" ? "uncertain" : "reviewable",
        reason: candidateOptionId === "option-a"
          ? "The saved buyer boundary remains ambiguous."
          : "The saved business boundary is reviewable.",
      })),
      comparisons: inputs.expectedComparisons.map((comparison) => ({
        candidateOptionId: comparison.candidateOptionId,
        target: comparison.target as OpportunityReviewOutput["comparisons"][number]["target"],
        relationship: "separate-business",
        reason: "The buyer, trigger, and purchase are distinct.",
        concreteDistinctionOrOverlap: "This option has an independent sellable workflow.",
      })),
    };
    return {
      output: request.schema.parse(output),
      metadata: {
        model: request.model,
        usage: { status: "unknown" },
        finishReason: "stop",
        latencyMs: 1,
        repairCount: 0,
        providerRequestIds: [`unresolved-request-${this.calls}`],
        attempts: [],
      },
    };
  }
}

function database(): DatabaseClient {
  const directory = mkdtempSync(join(tmpdir(), "scraply-opportunity-review-"));
  directories.push(directory);
  return new DatabaseClient(join(directory, "scraply.db"));
}

function reviewCallInput(chunkIndex: number) {
  return {
    threadId: "thread-1",
    batchKey: "batch-1",
    batchIndex: 0,
    chunkIndex,
    correctionNumber: 0 as const,
    providerId: DEFAULT_RUN_CONFIG.model.providerId,
    modelId: DEFAULT_RUN_CONFIG.model.modelId,
    reasoningEffort: "medium",
    request: { chunkIndex },
  };
}

function seedOptions(db: DatabaseClient, optionIds: string[]): void {
  const now = new Date().toISOString();
  const config = JSON.stringify({ ...DEFAULT_RUN_CONFIG, workflowVersion: 2, explorationPurpose: "startup-opportunities" });
  db.db.prepare("INSERT INTO threads (id, title, status, created_at, updated_at) VALUES (?, ?, 'solutions-ready', ?, ?)")
    .run("thread-1", "Review", now, now);
  db.db.prepare(`
    INSERT INTO research_runs (id, thread_id, status, config_json, workflow_version, created_at, updated_at)
    VALUES (?, ?, 'completed', ?, 2, ?, ?)
  `).run("discovery-run", "thread-1", config, now, now);
  db.db.prepare(`
    INSERT INTO problems (
      id, discovery_run_id, statement, why_it_persists, affected, scale_estimate,
      verdict, verdict_reason, verdict_source_ids_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'confirmed', ?, '[]', ?)
  `).run("problem-1", "discovery-run", "Teams lose time coordinating repair work.", "Tools are fragmented.", "Small teams", "Unknown", "Saved baseline", now);
  const insertRun = db.db.prepare(`
    INSERT INTO research_runs (
      id, thread_id, status, config_json, workflow_version, problem_id, created_at, updated_at
    ) VALUES (?, ?, 'completed', ?, 2, ?, ?, ?)
  `);
  const insertSolution = db.db.prepare(`
    INSERT INTO solutions (
      id, problem_id, research_run_id, mechanism, description, respects_off_limits,
      respects_off_limits_why, startup_opportunity_json, created_at
    ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
  `);
  for (const [index, optionId] of optionIds.entries()) {
    const runId = `run-${index}`;
    const optionCreatedAt = new Date(Date.parse(now) + index).toISOString();
    insertRun.run(runId, "thread-1", config, "problem-1", now, now);
    insertSolution.run(
      optionId,
      "problem-1",
      runId,
      `Mechanism ${optionId}`,
      `Business description for ${optionId}`,
      "Within the saved boundaries.",
      JSON.stringify({
        opportunityType: "startup-opportunity",
        payingCustomerSegment: "Small repair teams",
        trigger: `Trigger ${optionId}`,
        existingSubstitute: "Shared spreadsheets",
        gapAssessment: { kind: "hypothesis", description: "Demand remains untested.", evidenceIds: [] },
        smallestSellableWorkflow: `Workflow ${optionId}`,
        firstCustomerRoute: "Direct outreach",
        disconfirmingDemandTest: "Ask for a paid pilot.",
      }),
      optionCreatedAt,
    );
  }
}
