import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResearchEngine } from "../../src/core/research-engine";
import { configurePromptPaths } from "../../src/core/prompts";
import { WorkflowExecution } from "../../src/core/workflow-execution";
import { DatabaseClient } from "../../src/db/client";
import { DiscoveryRepository } from "../../src/db/repositories/discovery";
import { FocusedExperimentRepository } from "../../src/db/repositories/focused-experiments";
import { OpportunityExplorationRepository } from "../../src/db/repositories/opportunity-exploration";
import { OpportunityRepository } from "../../src/db/repositories/opportunities";
import { ThreadRepository } from "../../src/db/repositories/threads";
import type { SearchClient } from "../../src/providers/search";
import type { StructuredModelClient, StructuredStageRequest, StructuredStageResult } from "../../src/providers/structured";
import type { OpportunityReviewOutput } from "../../src/shared/opportunity-review";
import type { ResearchEvent } from "../../src/shared/ipc";
import { RunConfigSchema, type RunConfig } from "../../src/shared/schemas";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    try { rmSync(directory, { recursive: true, force: true }); }
    catch { /* SQLite can retain a WAL handle briefly on Windows. */ }
  }
});

function database(): DatabaseClient {
  configurePromptPaths({ bundledDir: join(process.cwd(), "prompts"), overrideDir: null });
  const directory = mkdtempSync(join(tmpdir(), "scraply-opportunity-exploration-"));
  directories.push(directory);
  return new DatabaseClient(join(directory, "test.db"));
}

function projectConfig(): RunConfig {
  return RunConfigSchema.parse({
    configVersion: 2,
    workflowVersion: 2,
    searchProvider: "exa",
    model: { providerId: "fixture", modelId: "fixture" },
    reasoningEffort: "low",
    discoveryDepth: "quick",
    maxRunMinutes: 5,
    researchMode: "known-problem",
    knownProblem: "Repair approvals stall after a revised estimate.",
    explorationPurpose: "startup-opportunities",
    opportunityExploration: {
      targetFamilies: 2,
      batchSize: 4,
      maxExpansionRounds: 1,
      maxRawCandidates: 4,
      maxModelCalls: 5,
      maxSearches: 1,
      allowExploratoryProblems: false,
    },
  });
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}

class ExpansionModel implements StructuredModelClient {
  readonly stages: string[] = [];

  async structuredCompletion<T>(request: StructuredStageRequest<T>): Promise<StructuredStageResult<T>> {
    this.stages.push(request.stage);
    request.onDispatched?.();
    request.onAccepted?.({ protocolVersion: "test" });
    let output: unknown;
    if (request.stage.startsWith("coverage-map:")) {
      output = {
        gaps: [{
          name: "Revised-estimate approvals",
          description: "Repair shops need evidence about the revised-estimate approval trigger.",
          dimension: "trigger",
          evidenceNeeded: "A firsthand account that revised estimates delay approval.",
          searchQuery: "repair shop revised estimate customer approval delay",
          mapExhausted: false,
          candidateOrigin: "evidence-only",
        }],
        noUsefulGapReason: null,
      };
    } else if (request.stage.startsWith("gap-generation:")) {
      output = {
        problemHypothesis: {
          statement: "Revised estimates wait for customer approval while vehicles occupy repair bays.",
          whyItPersists: "Approval context is split across calls and estimate documents.",
          affected: "Independent repair shops and their customers.",
          scaleEstimate: "The supplied shop account describes repeated approval delays.",
          evidenceIds: ["source-approval"],
          evidenceGap: "The prevalence across shops remains unknown.",
        },
        options: [
          option("Approval relay", "Repair shops", "Customer receives a revised estimate", "Collect a signed approval and notify the service advisor"),
          option("Bay release exchange", "Vehicle storage operators", "A delayed repair blocks a bay", "Offer temporary vehicle transfer and bay release"),
        ],
      };
    } else if (request.stage.startsWith("opportunity-review:")) {
      const inputs = request.workOrder.inputs as {
        expectedAssessmentIds: string[];
        expectedComparisons: Array<{ candidateOptionId: string; target: { kind: "family" | "candidate" | "unresolved-option"; id: string } }>;
      };
      const review: OpportunityReviewOutput = {
        assessments: inputs.expectedAssessmentIds.map((candidateOptionId) => ({
          candidateOptionId,
          status: "reviewable",
          reason: "The buyer, trigger, and sellable workflow are explicit.",
        })),
        comparisons: inputs.expectedComparisons.map((comparison) => ({
          ...comparison,
          relationship: "separate-business",
          reason: "The candidates have different paying customers and purchases.",
          concreteDistinctionOrOverlap: "One sells approval capture to repair shops; the other sells vehicle transfer to storage operators.",
        })),
      };
      output = review;
    } else if (request.stage === "risk-evaluation" || request.stage.startsWith("risk-evaluation:")) {
      output = {
        risks: [{ riskId: "weak-demand", description: "The paid workflow may not displace phone calls.", whyDecisive: "No adoption means there is no standalone business." }],
        unknowns: ["Whether repair shops will change their approval workflow."],
      };
    } else if (request.stage.startsWith("focused-experiment:") && request.stage.endsWith("review")) {
      output = {
        schemaVersion: 1,
        verdict: "approved",
        isolatesAssumption: true,
        measuresBehavior: true,
        controlsComparison: true,
        outcomeRulesCoherent: true,
        rationale: "The plan isolates one adoption behavior with explicit thresholds.",
        issues: [],
        correctionInstruction: null,
      };
    } else if (request.stage.startsWith("focused-experiment:")) {
      const inputs = request.workOrder.inputs as { shortDemandTestAssumptionId: string | null };
      output = {
        schemaVersion: 1,
        assumption: {
          id: inputs.shortDemandTestAssumptionId ?? "approval-relay-adoption",
          category: "adoption",
          testableClaim: "Repair shops will route five revised estimates through the approval relay.",
          decisionImpact: "Failure stops investment in the approval relay workflow.",
          selectionReason: "Adoption is the earliest behavior that can invalidate demand.",
        },
        shortDemandTestAssumptionId: inputs.shortDemandTestAssumptionId,
        assumptionChangeReason: null,
        participantsAndCases: {
          eligibilityCriteria: ["Repair shops handling revised estimates"],
          caseSelection: "Use the next five consecutive revised estimates.",
          exclusions: [],
          recruitmentMethod: "Invite the service advisor responsible for each eligible estimate.",
        },
        primaryMetric: {
          name: "revised estimates routed",
          unit: "estimates",
          numerator: null,
          denominator: null,
          collectionMethod: "Count completed approval relay records.",
          comparisonBaseline: "The same shop's prior phone approval workflow.",
        },
        sample: {
          targetObservations: 5,
          recruitmentLimit: 8,
          observationWindow: { value: 2, unit: "weeks" },
          feasibilityRationale: "Five revised estimates fit a two-week concierge pilot.",
        },
        outcomeRules: {
          kind: "numeric-threshold",
          direction: "higher-is-better",
          passThreshold: 4,
          failThreshold: 2,
          metricRange: { minimum: 0, maximum: 5 },
          thresholdRationale: "Four uses support adoption; fewer than two stop the workflow.",
          minimumUsableObservations: 5,
          insufficientDataReason: "Fewer than five estimates cannot support the decision.",
          unusableObservationRule: "Exclude estimates cancelled before customer review.",
        },
        resources: {
          estimatedEffort: "One service advisor hour per week.",
          dependencies: ["Access to revised estimate records"],
          spendingLimit: { amount: 200, currency: "USD" },
        },
        paymentTerms: null,
        followOnDecision: {
          pass: "Build the approval relay prototype.",
          fail: "Stop the approval relay workflow.",
          inconclusive: "Finish the five-case sample without changing thresholds.",
        },
      };
    } else if (request.stage === "decision-analysis" || request.stage.startsWith("decision-analysis:")) {
      output = {
        consequences: [{
          description: "Service advisors route revised estimates through one approval record.",
          direction: "positive",
          affects: "Repair scheduling",
          rationale: "A shared approval state reduces repeated phone follow-up.",
        }],
        proposedResponses: [{
          riskIds: ["weak-demand"],
          approach: "Run the bounded concierge adoption test.",
          cost: "Two weeks and five eligible estimates.",
          failsIf: "Fewer than two eligible estimates use the relay.",
        }],
        additionalUnknowns: ["Whether adoption persists after the concierge pilot."],
        experiment: {
          question: "Will repair shops route revised estimates through the approval relay?",
          method: "Run the approved five-case concierge adoption test.",
          cost: "Two weeks and up to $200.",
          passCriterion: "At least four of five estimates use the relay.",
          failCriterion: "Fewer than two of five estimates use the relay.",
          inconclusiveCriterion: "Fewer than five usable estimates are observed.",
        },
      };
    } else {
      throw new Error(`Unexpected model stage ${request.stage}`);
    }
    return {
      output: request.schema.parse(output),
      metadata: {
        model: request.model,
        prompt: { id: "scraply.stage-worker.v1", sha256: "d".repeat(64) },
        usage: { status: "unknown" },
        finishReason: "stop",
        latencyMs: 1,
        repairCount: 0,
        providerRequestIds: [`request-${this.stages.length}`],
        attempts: [],
      },
    };
  }
}

function option(mechanism: string, buyer: string, trigger: string, workflow: string) {
  return {
    mechanism,
    description: `${mechanism} is a small paid workflow.`,
    keyAssumption: `${buyer} will pay for the workflow.`,
    whyCurrentApproachMaySuffice: "Phone calls may remain adequate for low volume shops.",
    supportingEvidenceIds: ["source-approval"],
    contraryEvidenceIds: [],
    unknowns: ["Willingness to pay is unknown."],
    respectsOffLimits: true,
    respectsOffLimitsWhy: "The workflow stays inside the saved scope.",
    startupOpportunity: {
      opportunityType: "startup-opportunity" as const,
      payingCustomerSegment: buyer,
      trigger,
      existingSubstitute: "Phone calls and manual notes",
      gapAssessment: { kind: "evidenced" as const, description: "The supplied account supports the workflow problem.", evidenceIds: ["source-approval"] },
      smallestSellableWorkflow: workflow,
      firstCustomerRoute: "Direct outreach to five local operators",
      disconfirmingDemandTest: "Five target buyers decline a paid concierge pilot.",
    },
    focusedDemandTest: {
      schemaVersion: 1 as const,
      assumption: {
        id: `${mechanism.toLowerCase().replaceAll(" ", "-")}-adoption`,
        category: "adoption" as const,
        testableClaim: `${buyer} will use ${workflow.toLowerCase()} in a concierge pilot.`,
        decisionImpact: "A failed pilot would stop investment in this workflow.",
        selectionReason: "Adoption is the earliest uncertain behavior that can invalidate demand.",
      },
      methodSummary: "Offer a five-case concierge pilot to qualified buyers.",
      disconfirmingObservation: "Qualified buyers decline or abandon the workflow in all five cases.",
      paymentTerms: null,
    },
  };
}

function initialOption(mechanism: string) {
  const candidate = option(mechanism, "Independent repair shops", "A revised estimate needs approval", "Collect and route a signed approval");
  return {
    ...candidate,
    supportingEvidenceIds: [],
    startupOpportunity: {
      ...candidate.startupOpportunity,
      gapAssessment: {
        kind: "hypothesis" as const,
        description: "The user supplied the problem; external demand evidence remains missing.",
        evidenceIds: [],
      },
    },
  };
}

const search: SearchClient = {
  provider: "exa",
  async validateKey() { return { valid: true }; },
  async search(query, options) {
    expect(query).toBe("repair shop revised estimate customer approval delay");
    expect(options?.numResults).toBe(5);
    return [{
      id: "source-approval",
      url: "https://example.com/repair-approval",
      title: "Repair approval delays",
      text: "A repair shop owner describes revised estimates waiting for customer approval while a vehicle occupies a bay.",
    }];
  },
};

test("one permitted round maps a named gap, searches, generates, reviews, and reaches its family target", async () => {
  const db = database();
  const config = projectConfig();
  const thread = new ThreadRepository(db).createThread("Approval research", config);
  const oldSourceTime = "2026-09-18T10:00:00.000Z";
  db.db.prepare(`
    INSERT INTO research_runs (id, thread_id, status, config_json, workflow_version, created_at, updated_at)
    VALUES ('older-discovery', ?, 'completed', ?, 2, ?, ?)
  `).run(thread.id, JSON.stringify(config), oldSourceTime, oldSourceTime);
  db.db.prepare(`
    INSERT INTO sources (
      id, research_run_id, provider_source_id, canonical_url, title, retrieved_text,
      content_hash, retrieved_at
    ) VALUES ('source-old', 'older-discovery', 'source-old', ?, ?, ?, 'hash', ?)
  `).run(
    "https://example.com/repair-approval",
    "Repair approval delays",
    "A repair shop owner describes revised estimates waiting for customer approval while a vehicle occupies a bay.",
    oldSourceTime,
  );
  const root = new DiscoveryRepository(db).createKnownProblemRoot(thread.id, {
    title: "Repair approval",
    audience: "Independent repair shops",
    domain: "Automotive repair",
    observations: "Revised estimates require a second customer decision.",
    offLimits: [],
    riskEvaluationCriteria: "Reject ideas whose demand cannot be tested through observed buyer behavior.",
  }, config.knownProblem ?? "Repair approvals stall.", config);
  const now = new Date().toISOString();
  db.db.prepare(`
    INSERT INTO research_runs (id, thread_id, problem_id, status, config_json, workflow_version, created_at, updated_at)
    VALUES ('completed-initial-development', ?, ?, 'completed', ?, 2, ?, ?)
  `).run(thread.id, root.problemId, JSON.stringify(config), now, now);
  const model = new ExpansionModel();
  const engine = new ResearchEngine({
    db,
    modelClients: { fixture: model },
    searchClients: { exa: search },
    onEvent() {},
  });
  try {
    expect(await engine.startNextSelected(thread.id, config)).toBeNull();
    await until(() => !engine.getOpportunityReviewStatus(thread.id).running);

    const progress = engine.getOpportunityExploration(thread.id);
    expect({ status: progress?.status, error: engine.getOpportunityReviewStatus(thread.id).error }).toEqual({
      status: "target-reached",
      error: null,
    });
    expect(progress?.counts.acceptedFamilies).toBe(2);
    expect(progress?.usage).toEqual({ modelCalls: 3, searches: 1, rawCandidates: 2, expansionRounds: 1 });
    expect(progress?.batches).toHaveLength(1);
    expect(progress?.batches[0]?.status).toBe("reviewed");
    expect(model.stages).toEqual([
      "coverage-map:1",
      expect.stringMatching(/^gap-generation:/),
      expect.stringMatching(/^opportunity-review:/),
    ]);

    const families = new OpportunityRepository(db).familyView(thread.id);
    expect(families.acceptedFamilyCount).toBe(2);
    const expandedRun = db.db.prepare(`
      SELECT id, awaiting_selection FROM research_runs
      WHERE thread_id = ? AND completion_reason LIKE 'Opportunity expansion for %'
    `).get(thread.id) as { id: string; awaiting_selection: number };
    expect(expandedRun.awaiting_selection).toBe(1);
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM solutions WHERE research_run_id = ?").get(expandedRun.id)).toEqual({ count: 2 });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM sources WHERE id = 'source-approval'").get()).toEqual({ count: 1 });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM problem_verdict_sources WHERE source_id = 'source-approval'").get()).toEqual({ count: 1 });
    expect(db.db.prepare("SELECT research_run_id FROM problem_verdict_sources WHERE source_id = 'source-approval'").get()).toEqual({ research_run_id: root.runId });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM problem_verdict_sources WHERE source_id = 'source-old'").get()).toEqual({ count: 0 });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM focused_demand_tests WHERE research_run_id = ?").get(expandedRun.id)).toEqual({ count: 2 });

    const selected = db.db.prepare(`
      SELECT id, problem_id FROM solutions WHERE research_run_id = ? ORDER BY option_position LIMIT 1
    `).get(expandedRun.id) as { id: string; problem_id: string };
    db.db.exec(`
      CREATE TRIGGER fail_expanded_risk_checkpoint
      BEFORE INSERT ON stage_results
      WHEN NEW.stage_id = 'risk-evaluation'
      BEGIN
        SELECT RAISE(FAIL, 'simulated expanded-option checkpoint failure');
      END
    `);
    await engine.selectOption(thread.id, expandedRun.id, selected.id);
    await until(() => !engine.getActiveRunIds().has(expandedRun.id));
    expect(db.db.prepare("SELECT status, completion_reason FROM research_runs WHERE id = ?").get(expandedRun.id))
      .toEqual({ status: "failed", completion_reason: "simulated expanded-option checkpoint failure" });
    expect(model.stages.filter((stage) => stage === "risk-evaluation")).toHaveLength(1);

    db.db.exec("DROP TRIGGER fail_expanded_risk_checkpoint");
    await engine.resumeRun(expandedRun.id);
    await until(() => !engine.getActiveRunIds().has(expandedRun.id));
    expect(db.db.prepare("SELECT status, awaiting_selection, completion_reason FROM research_runs WHERE id = ?").get(expandedRun.id))
      .toEqual({ status: "completed", awaiting_selection: 0, completion_reason: null });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM decision_analyses WHERE research_run_id = ?").get(expandedRun.id))
      .toEqual({ count: 1 });
    expect(new FocusedExperimentRepository(db).findRecord(expandedRun.id, selected.id)?.status).toBe("approved");
    expect(
      model.stages.some(
        (stage) => stage === "risk-evaluation" || stage.startsWith("risk-evaluation:"),
      ),
    ).toBe(true);
    expect(model.stages.filter((stage) => stage === "risk-evaluation")).toHaveLength(1);
    expect(model.stages.some((stage) => stage.startsWith("focused-experiment:") && stage.endsWith("draft"))).toBe(true);
    expect(model.stages.some((stage) => stage.startsWith("focused-experiment:") && stage.endsWith("review"))).toBe(true);
    expect(
      model.stages.some(
        (stage) => stage === "decision-analysis" || stage.startsWith("decision-analysis:"),
      ),
    ).toBe(true);

    await engine.shutdown();
    const reopened = new ResearchEngine({ db, modelClients: { fixture: model }, searchClients: { exa: search }, onEvent() {} });
    try {
      expect(new WorkflowExecution(db, expandedRun.id).selectedOption(selected.problem_id)?.id).toBe(selected.id);
      expect(new FocusedExperimentRepository(db).findRecord(expandedRun.id, selected.id)?.status).toBe("approved");
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM decision_analyses WHERE research_run_id = ?").get(expandedRun.id))
        .toEqual({ count: 1 });
    } finally {
      await reopened.shutdown();
    }

    const exported = new OpportunityExplorationRepository(db).exportExploration(thread.id);
    expect(exported.attempts.map((attempt) => attempt.status)).toEqual(["completed", "completed", "completed"]);
    expect(exported.origins).toHaveLength(2);
    expect(exported.origins.every((origin) => origin.origin.kind === "problem-evidence")).toBe(true);
  } finally {
    await engine.shutdown();
    db.close();
  }
});

test("startup recovery pauses an orphaned exploration and marks an in-flight dispatch unknown", async () => {
  const db = database();
  const config = projectConfig();
  const thread = new ThreadRepository(db).createThread("Interrupted exploration", config);
  const repository = new OpportunityExplorationRepository(db);
  db.immediateTransaction(() => {
    repository.create(thread.id, config.opportunityExploration!);
    const attempt = repository.prepareAttempt(thread.id, {
      stageKey: "coverage-map:1",
      stageName: "coverage-map",
      input: { round: 1 },
      model: { ...config.model, reasoningEffort: config.reasoningEffort },
      promptVersion: "opportunity-coverage-v1",
      promptText: "Map coverage",
    });
    if (attempt.kind !== "prepared") throw new Error("Expected a prepared attempt");
    repository.markAttemptDispatched(thread.id, attempt.attemptId, "model");
  });

  const engine = new ResearchEngine({ db, modelClients: {}, onEvent() {} });
  try {
    const recovered = engine.getOpportunityExploration(thread.id);
    expect(recovered?.status).toBe("paused");
    expect(recovered?.stopReason).toContain("app restarted");
    expect(repository.exportExploration(thread.id).attempts[0]?.status).toBe("unknown-dispatch");
  } finally {
    await engine.shutdown();
    db.close();
  }
});

test("an initial generation failure terminates exploration and resume immediately reconciles it", async () => {
  const db = database();
  const config = projectConfig();
  const thread = new ThreadRepository(db).createThread("Failed initial generation", config);
  const events: ResearchEvent[] = [];
  let failGeneration = true;
  const model: StructuredModelClient = {
    async structuredCompletion<T>(request: StructuredStageRequest<T>): Promise<StructuredStageResult<T>> {
      if (failGeneration) throw new Error("fixture initial option persistence failed");
      request.onDispatched?.();
      return new Promise<StructuredStageResult<T>>((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => reject(request.signal?.reason ?? new Error("cancelled")), { once: true });
      });
    },
  };
  const engine = new ResearchEngine({ db, modelClients: { fixture: model }, onEvent: (event) => events.push(event) });
  try {
    const runId = await engine.startKnownProblem(thread.id, {
      title: "Repair approval",
      audience: "Independent repair shops",
      domain: "Automotive repair",
      observations: "",
      offLimits: [],
    }, config.knownProblem ?? "Repair approvals stall.", config);
    await until(() => !engine.getActiveRunIds().has(runId));

    const failed = engine.getOpportunityExploration(thread.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.stopReason).toContain("Initial opportunity generation failed:");
    expect(events).toContainEqual(expect.objectContaining({
      type: "opportunity-progress",
      threadId: thread.id,
      status: "failed",
      error: expect.stringContaining("fixture initial option persistence failed"),
    }));

    failGeneration = false;
    await engine.resumeRun(runId);
    expect(engine.getOpportunityExploration(thread.id)?.status).toBe("mapping-coverage");
    expect(events).toContainEqual(expect.objectContaining({
      type: "opportunity-progress",
      threadId: thread.id,
      status: "mapping-coverage",
    }));
    engine.cancelRun(runId);
  } finally {
    await engine.shutdown();
    db.close();
  }
});

test("resume from a startup-recovered pause replays completed initial options despite exhausted budgets", async () => {
  const db = database();
  const config = projectConfig();
  const thread = new ThreadRepository(db).createThread("Recovered initial options", config);
  let modelCalls = 0;
  const identity = {
    protocolVersion: "1.1",
    runtimeVersion: "test",
    runtimeSourceSha: "a".repeat(40),
    runtimeExecutableSha256: "b".repeat(64),
    compilerPrompt: { id: "scraply.stage-worker.v1", sha256: "c".repeat(64) },
  };
  const model: StructuredModelClient = {
    preparedIdentity() { return identity; },
    async structuredCompletion<T>(request: StructuredStageRequest<T>): Promise<StructuredStageResult<T>> {
      modelCalls += 1;
      request.onDispatched?.();
      request.onAccepted?.(identity);
      const output = request.schema.parse({
        options: [initialOption("Approval relay"), initialOption("Estimate decision room"), initialOption("Repair authorization inbox")],
      });
      return {
        output,
        metadata: {
          model: request.model,
          prompt: identity.compilerPrompt,
          usage: { status: "unknown" },
          finishReason: "stop",
          latencyMs: 1,
          repairCount: 0,
          providerRequestIds: ["initial-options"],
          attempts: [],
        },
      };
    },
  };
  db.db.exec(`
    CREATE TRIGGER interrupt_initial_option_persistence BEFORE INSERT ON solutions
    BEGIN SELECT RAISE(ABORT, 'simulated initial option persistence interruption'); END;
  `);
  const firstEngine = new ResearchEngine({ db, modelClients: { fixture: model }, onEvent() {} });
  const runId = await firstEngine.startKnownProblem(thread.id, {
    title: "Repair approval",
    audience: "Independent repair shops",
    domain: "Automotive repair",
    observations: "",
    offLimits: [],
  }, config.knownProblem ?? "Repair approvals stall.", config);
  await until(() => !firstEngine.getActiveRunIds().has(runId));
  expect(modelCalls).toBe(1);
  expect(db.db.prepare("SELECT status FROM generation_attempts WHERE research_run_id = ?").get(runId)).toEqual({ status: "completed" });
  await firstEngine.shutdown();

  const repository = new OpportunityExplorationRepository(db);
  db.immediateTransaction(() => repository.setStatus(thread.id, "mapping-coverage", null));
  db.db.prepare(`
    UPDATE opportunity_explorations
    SET model_calls_used = ?, started_at = ?
    WHERE thread_id = ?
  `).run(config.opportunityExploration!.maxModelCalls, "2026-09-19T00:00:00.000Z", thread.id);

  const events: ResearchEvent[] = [];
  const resumedEngine = new ResearchEngine({ db, modelClients: { fixture: model }, onEvent: (event) => events.push(event) });
  try {
    expect(resumedEngine.getOpportunityExploration(thread.id)?.status).toBe("paused");
    db.db.exec("DROP TRIGGER interrupt_initial_option_persistence");
    await resumedEngine.resumeRun(runId);
    await until(() => !resumedEngine.getActiveRunIds().has(runId));

    expect(modelCalls).toBe(1);
    expect(db.db.prepare("SELECT status, completion_reason FROM research_runs WHERE id = ?").get(runId)).toEqual({ status: "completed", completion_reason: null });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM solutions WHERE research_run_id = ?").get(runId)).toEqual({ count: 3 });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM focused_demand_tests WHERE research_run_id = ?").get(runId)).toEqual({ count: 3 });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM generation_attempts WHERE research_run_id = ?").get(runId)).toEqual({ count: 1 });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM cost_ledger WHERE research_run_id = ?").get(runId)).toEqual({ count: 1 });
    expect(resumedEngine.getOpportunityExploration(thread.id)?.usage.modelCalls).toBe(config.opportunityExploration!.maxModelCalls);
    expect(db.db.prepare("SELECT awaiting_selection FROM research_runs WHERE id = ?").get(runId)).toEqual({ awaiting_selection: 1 });
    expect(events).toContainEqual(expect.objectContaining({
      type: "opportunity-progress",
      threadId: thread.id,
      status: "mapping-coverage",
    }));
  } finally {
    await resumedEngine.shutdown();
    db.close();
  }
});

test("an evidence-only batch without problem-level evidence saves no candidates and stops usefully", async () => {
  const db = database();
  const config = projectConfig();
  const thread = new ThreadRepository(db).createThread("Unsupported expansion", config);
  new DiscoveryRepository(db).createKnownProblemRoot(thread.id, {
    title: "Repair approval",
    audience: "Independent repair shops",
    domain: "Automotive repair",
    observations: "",
    offLimits: [],
  }, config.knownProblem ?? "Repair approvals stall.", config);
  const supportedModel = new ExpansionModel();
  const model: StructuredModelClient = {
    async structuredCompletion<T>(request: StructuredStageRequest<T>) {
      const result = await supportedModel.structuredCompletion(request);
      if (!request.stage.startsWith("gap-generation:")) return result;
      const generated = result.output as {
        problemHypothesis: { evidenceIds: string[] };
        options: unknown[];
      };
      return { ...result, output: request.schema.parse({
        ...generated,
        problemHypothesis: { ...generated.problemHypothesis, evidenceIds: [] },
      }) };
    },
  };
  const engine = new ResearchEngine({ db, modelClients: { fixture: model }, searchClients: { exa: search }, onEvent() {} });
  try {
    await engine.startOpportunityExploration(thread.id, config.model, config.reasoningEffort);
    await until(() => !engine.getOpportunityReviewStatus(thread.id).running);
    const progress = engine.getOpportunityExploration(thread.id);
    expect(progress?.status).toBe("useful-partial");
    expect(progress?.counts.acceptedFamilies).toBe(0);
    expect(progress?.usage.rawCandidates).toBe(0);
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM solutions").get()).toEqual({ count: 0 });
    expect(new OpportunityExplorationRepository(db).exportExploration(thread.id).attempts
      .find((attempt) => attempt.stageName === "gap-generation")?.result).toMatchObject({
        output: { options: [] },
        rejectionReason: expect.stringContaining("did not cite supplied evidence"),
      });
  } finally {
    await engine.shutdown();
    db.close();
  }
});

test("resume reuses a completed generation checkpoint after persistence was interrupted", async () => {
  const db = database();
  const config = projectConfig();
  const thread = new ThreadRepository(db).createThread("Recover expansion", config);
  new DiscoveryRepository(db).createKnownProblemRoot(thread.id, {
    title: "Repair approval",
    audience: "Independent repair shops",
    domain: "Automotive repair",
    observations: "",
    offLimits: [],
  }, config.knownProblem ?? "Repair approvals stall.", config);
  db.db.exec(`
    CREATE TRIGGER interrupt_opportunity_persistence BEFORE INSERT ON solutions
    BEGIN SELECT RAISE(ABORT, 'simulated persistence interruption'); END;
  `);
  const model = new ExpansionModel();
  const engine = new ResearchEngine({ db, modelClients: { fixture: model }, searchClients: { exa: search }, onEvent() {} });
  try {
    await engine.startOpportunityExploration(thread.id, config.model, config.reasoningEffort);
    await until(() => !engine.getOpportunityReviewStatus(thread.id).running);
    expect(engine.getOpportunityExploration(thread.id)?.status).toBe("failed");
    expect(engine.getOpportunityExploration(thread.id)?.batches[0]?.status).toBe("generating");
    expect(model.stages.filter((stage) => stage.startsWith("gap-generation:"))).toHaveLength(1);

    db.db.exec("DROP TRIGGER interrupt_opportunity_persistence");
    await engine.resumeOpportunityExploration(thread.id, config.model, config.reasoningEffort);
    await until(() => !engine.getOpportunityReviewStatus(thread.id).running);

    expect(engine.getOpportunityExploration(thread.id)?.status).toBe("target-reached");
    expect(model.stages.filter((stage) => stage.startsWith("coverage-map:"))).toHaveLength(1);
    expect(model.stages.filter((stage) => stage.startsWith("gap-generation:"))).toHaveLength(1);
    expect(model.stages.filter((stage) => stage.startsWith("opportunity-review:"))).toHaveLength(1);
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM solutions").get()).toEqual({ count: 2 });
  } finally {
    await engine.shutdown();
    db.close();
  }
});
