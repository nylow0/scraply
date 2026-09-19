import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFocusedExperimentFlow } from "../../src/core/experiment-review";
import { ResearchEngine } from "../../src/core/research-engine";
import { DatabaseClient } from "../../src/db/client";
import { FocusedExperimentRepository } from "../../src/db/repositories/focused-experiments";
import { GenerationAttemptRepository } from "../../src/db/repositories/generation-attempts";
import { WorkflowV2Repository } from "../../src/db/repositories/workflow-v2";
import { ProviderFailure, type StructuredModelClient, type StructuredStageRequest } from "../../src/providers/structured";
import type { FocusedExperiment } from "../../src/shared/focused-experiment";
import { deriveJsonSchema } from "../../src/shared/json-schema";
import { RunConfigSchema } from "../../src/shared/schemas";
import { WorkflowV2SolutionsOutputSchema } from "../../src/shared/structured-output-schemas";
import { WORKFLOW_V2_STAGE_REGISTRY } from "../../src/core/stages";

const directories: string[] = [];
afterEach(() => {
  while (directories.length) {
    try { rmSync(directories.pop()!, { recursive: true, force: true }); } catch { /* SQLite can retain a WAL handle briefly. */ }
  }
});

describe("focused experiment flow", () => {
  test("persists draft, one correction, final review, and reuses the completed result", async () => {
    const client = setup();
    const repository = new FocusedExperimentRepository(client);
    const draft = plan();
    const corrected = { ...draft, participantsAndCases: { ...draft.participantsAndCases, caseSelection: "Use the next ten consecutive revisions." } };
    const outputs = [
      draft,
      review("needs-revision", "Use consecutive cases rather than cases chosen for known contradictions."),
      corrected,
      review("approved", null),
    ];
    let calls = 0;
    const modelClient: StructuredModelClient = {
      async structuredCompletion<T>(request: StructuredStageRequest<T>) {
        const output = outputs[calls++];
        return {
          output: request.schema.parse(output) as T,
          metadata: { model: request.model, usage: { status: "unknown" }, latencyMs: 1, repairCount: 0, providerRequestIds: [], attempts: [] },
        };
      },
    };
    const input = flowInput();
    const dependencies = {
      repository,
      modelClient,
      generationModel: { providerId: "test", modelId: "generator" },
      reviewModel: { providerId: "test", modelId: "reviewer" },
      generationReasoningEffort: "high" as const,
      reviewReasoningEffort: "high" as const,
    };

    const first = await runFocusedExperimentFlow(input, dependencies);
    expect(first.record.status).toBe("approved");
    expect(first.record.correctionCount).toBe(1);
    expect(first.record.plan.participantsAndCases.caseSelection).toContain("consecutive");
    expect(calls).toBe(4);
    expect(client.db.prepare("SELECT stage_key FROM focused_experiment_stage_results ORDER BY rowid").all())
      .toEqual([{ stage_key: "draft" }, { stage_key: "initial-review" }, { stage_key: "correction" }, { stage_key: "final-review" }]);
    const exported = repository.exportExperiments("thread-1");
    expect(exported.experiments).toHaveLength(1);
    expect(exported.experiments[0]).toMatchObject({
      researchRunId: "run-development",
      solutionId: "solution-1",
      record: { status: "approved" },
    });
    expect(exported.experiments[0]?.stages.map((stage) => stage.stageKey))
      .toEqual(["draft", "initial-review", "correction", "final-review"]);
    expect(exported.experiments[0]?.stages[0]?.prompt.text).toContain("one decision-focused experiment");

    const second = await runFocusedExperimentFlow(input, dependencies);
    expect(second.reused).toBe(true);
    expect(second.record).toEqual(first.record);
    expect(calls).toBe(4);
    client.close();
  });

  test("keeps an uncertain plan as needs revision without guessing a correction", async () => {
    const client = setup();
    let calls = 0;
    const outputs = [plan(), review("uncertain", null)];
    const modelClient: StructuredModelClient = {
      async structuredCompletion<T>(request: StructuredStageRequest<T>) {
        return {
          output: request.schema.parse(outputs[calls++]) as T,
          metadata: { model: request.model, usage: { status: "unknown" }, latencyMs: 1, repairCount: 0, providerRequestIds: [], attempts: [] },
        };
      },
    };
    const result = await runFocusedExperimentFlow(flowInput(), {
      repository: new FocusedExperimentRepository(client),
      modelClient,
      generationModel: { providerId: "test", modelId: "generator" },
      reviewModel: { providerId: "test", modelId: "reviewer" },
      generationReasoningEffort: "high",
      reviewReasoningEffort: "high",
    });
    expect(result.record.status).toBe("needs_revision");
    expect(result.record.correctionCount).toBe(0);
    expect(calls).toBe(2);
    client.close();
  });

  test("checkpoints a validated provider result when cancellation arrives with the response", async () => {
    const client = setup();
    const repository = new FocusedExperimentRepository(client);
    const abortController = new AbortController();
    let firstCalls = 0;
    const interruptedClient: StructuredModelClient = {
      async structuredCompletion<T>(request: StructuredStageRequest<T>) {
        firstCalls += 1;
        abortController.abort(new Error("cancelled after provider response"));
        return {
          output: request.schema.parse(plan()) as T,
          metadata: { model: request.model, usage: { status: "unknown" }, latencyMs: 1, repairCount: 0, providerRequestIds: [], attempts: [] },
        };
      },
    };
    await expect(runFocusedExperimentFlow(flowInput(), {
      repository,
      modelClient: interruptedClient,
      generationModel: { providerId: "test", modelId: "generator" },
      reviewModel: { providerId: "test", modelId: "reviewer" },
      generationReasoningEffort: "high",
      reviewReasoningEffort: "high",
      signal: abortController.signal,
    })).rejects.toThrow("cancelled after provider response");
    expect(firstCalls).toBe(1);
    expect(client.db.prepare("SELECT stage_key FROM focused_experiment_stage_results").all()).toEqual([{ stage_key: "draft" }]);

    let resumedCalls = 0;
    const resumedClient: StructuredModelClient = {
      async structuredCompletion<T>(request: StructuredStageRequest<T>) {
        resumedCalls += 1;
        return {
          output: request.schema.parse(review("approved", null)) as T,
          metadata: { model: request.model, usage: { status: "unknown" }, latencyMs: 1, repairCount: 0, providerRequestIds: [], attempts: [] },
        };
      },
    };
    const resumed = await runFocusedExperimentFlow(flowInput(), {
      repository,
      modelClient: resumedClient,
      generationModel: { providerId: "test", modelId: "generator" },
      reviewModel: { providerId: "test", modelId: "reviewer" },
      generationReasoningEffort: "high",
      reviewReasoningEffort: "high",
    });
    expect(resumed.record.status).toBe("approved");
    expect(resumedCalls).toBe(1);
    client.close();
  });
});

describe("focused experiment engine orchestration", () => {
  test("records paid attempts and preserves the completed analysis state", async () => {
    const client = setupEngineFixture();
    const outputs = [plan(), review("approved", null)];
    let calls = 0;
    const modelClient: StructuredModelClient = {
      async structuredCompletion<T>(request: StructuredStageRequest<T>) {
        request.onDispatched?.();
        request.onAccepted?.({ protocolVersion: "fixture" });
        return {
          output: request.schema.parse(outputs[calls++]) as T,
          metadata: generationMetadata(request),
        };
      },
    };
    const engine = new ResearchEngine({ db: client, modelClients: { fixture: modelClient }, onEvent() {} });
    try {
      await engine.requestFocusedExperiment("thread-1", "run-development", "solution-1");
      await until(() => new FocusedExperimentRepository(client).findRecord("run-development", "solution-1") !== null);
      expect(calls).toBe(2);
      expect(client.db.prepare(`
        SELECT stage_key, status FROM generation_attempts
        WHERE research_run_id = 'run-development' ORDER BY rowid
      `).all()).toEqual([
        { stage_key: "focused-experiment:draft", status: "completed" },
        { stage_key: "focused-experiment:initial-review", status: "completed" },
      ]);
      expect(client.db.prepare(`
        SELECT status FROM cost_ledger WHERE research_run_id = 'run-development' ORDER BY rowid
      `).all()).toEqual([{ status: "committed" }, { status: "committed" }]);
      expect(client.db.prepare("SELECT status, completion_reason FROM research_runs WHERE id = 'run-development'").get())
        .toEqual({ status: "completed", completion_reason: "Original analysis completed" });
    } finally {
      await engine.shutdown();
      client.close();
    }
  });

  test("does not replay a provider call whose result was lost after dispatch", async () => {
    const client = setupEngineFixture();
    let calls = 0;
    const modelClient: StructuredModelClient = {
      async structuredCompletion<T>(request: StructuredStageRequest<T>) {
        void request;
        calls += 1;
        throw new Error("must not dispatch");
      },
    };
    const attempts = new GenerationAttemptRepository(client);
    const ambiguous = attempts.prepare("run-development", ambiguousFocusedRequest());
    attempts.markDispatched(ambiguous.id);
    attempts.interruptInFlight("Simulated process loss after provider dispatch");
    const engine = new ResearchEngine({ db: client, modelClients: { fixture: modelClient }, onEvent() {} });
    try {
      await expect(engine.requestFocusedExperiment("thread-1", "run-development", "solution-1"))
        .rejects.toThrow("may have completed");
      expect(calls).toBe(0);
      expect(client.db.prepare("SELECT status, terminal_kind FROM generation_attempts WHERE id = ?").get(ambiguous.id))
        .toEqual({ status: "interrupted", terminal_kind: "process-lost" });
    } finally {
      await engine.shutdown();
      client.close();
    }
  });

  test("cancels explicit planning without replacing the original completion reason", async () => {
    const client = setupEngineFixture();
    let dispatched = false;
    const modelClient: StructuredModelClient = {
      async structuredCompletion<T>(request: StructuredStageRequest<T>) {
        request.onDispatched?.();
        dispatched = true;
        await new Promise<void>((resolve, reject) => {
          void resolve;
          const abort = () => reject(new ProviderFailure("cancelled", "provider cancelled", false, { attempts: [] }));
          if (request.signal?.aborted) abort();
          else request.signal?.addEventListener("abort", abort, { once: true });
        });
        throw new Error("unreachable");
      },
    };
    const engine = new ResearchEngine({ db: client, modelClients: { fixture: modelClient }, onEvent() {} });
    try {
      await engine.requestFocusedExperiment("thread-1", "run-development", "solution-1");
      await until(() => dispatched);
      engine.cancelRun("run-development");
      await until(() => !engine.getOpportunityReviewStatus("thread-1").running);
      expect(client.db.prepare("SELECT status, cancelled, completion_reason FROM research_runs WHERE id = 'run-development'").get())
        .toEqual({ status: "completed", cancelled: 0, completion_reason: "Original analysis completed" });
      expect(client.db.prepare("SELECT status, terminal_kind FROM generation_attempts WHERE research_run_id = 'run-development'").get())
        .toEqual({ status: "cancelled", terminal_kind: "cancelled" });
    } finally {
      await engine.shutdown();
      client.close();
    }
  });
});

function flowInput() {
  return {
    researchRunId: "run-development",
    context: {
      scope: { title: "Exercise quality", audience: "Educators", domain: "Courses", observations: "Contradictions survive review", offLimits: [] },
      problem: { id: "problem-1", statement: "Exercise contradictions ship", whyItPersists: "Review is manual", affected: "Educators", scaleEstimate: "Monthly", scaleBasisFactorId: null, factorIds: [], verdict: "insufficient-evidence" as const, verdictReason: "No intended-buyer evidence", verdictSourceIds: [] },
      supportingEvidence: [], contraryEvidence: [], priorFailedAttempts: [],
    },
    selectedOption: {
      id: "solution-1", problemId: "problem-1", mechanism: "Contradiction checker", description: "Compare prompts and answer keys",
      keyAssumption: "The checker catches meaningful contradictions", whyCurrentApproachMaySuffice: "Editors can review manually",
      supportingEvidenceIds: [], contraryEvidenceIds: [], unknowns: [], respectsOffLimits: true, respectsOffLimitsWhy: "No conflict",
    },
    riskEvaluation: { risks: [{ riskId: "false-positive", description: "The checker flags valid variation", whyDecisive: "Noise could make it unusable" }], unknowns: [] },
  };
}

function plan(): FocusedExperiment {
  return {
    schemaVersion: 1,
    assumption: { id: "mechanism-contradictions", category: "mechanism-value", testableClaim: "The checker finds confirmed contradictions missed by normal review.", decisionImpact: "Failure stops the mechanism.", selectionReason: "Mechanism value comes before adoption." },
    shortDemandTestAssumptionId: null,
    assumptionChangeReason: null,
    participantsAndCases: { eligibilityCriteria: ["Maintains answer keys"], caseSelection: "Choose ten revisions", exclusions: [], recruitmentMethod: "Invite the full maintainer roster." },
    primaryMetric: { name: "additional confirmed contradictions", unit: "contradictions", numerator: null, denominator: null, collectionMethod: "Confirm checker-only findings against intended answers.", comparisonBaseline: "The same revision after normal review." },
    sample: { targetObservations: 10, recruitmentLimit: 15, observationWindow: { value: 3, unit: "weeks" }, feasibilityRationale: "Ten revisions normally arrive in three weeks." },
    outcomeRules: { kind: "numeric-threshold", direction: "higher-is-better", passThreshold: 8, failThreshold: 4, thresholdRationale: "Eight justifies a prototype; fewer than four does not.", minimumUsableObservations: 10, insufficientDataReason: "Fewer than ten cases misses the policy sample.", unusableObservationRule: "Exclude findings whose intended answer cannot be confirmed." },
    resources: { estimatedEffort: "Three facilitator days.", dependencies: ["Revision access"], spendingLimit: { amount: 500, currency: "USD" } },
    paymentTerms: null,
    followOnDecision: { pass: "Prototype automation.", fail: "Stop this mechanism.", inconclusive: "Recruit the remaining consecutive cases." },
  };
}

function review(verdict: "approved" | "needs-revision" | "uncertain", correctionInstruction: string | null) {
  const approved = verdict === "approved";
  return {
    schemaVersion: 1 as const,
    verdict,
    isolatesAssumption: true,
    measuresBehavior: true,
    controlsComparison: true,
    outcomeRulesCoherent: approved,
    rationale: approved ? "The plan isolates the mechanism and partitions outcomes." : "Case selection may bias the result.",
    issues: approved ? [] : ["Case selection is not defined independently of known outcomes."],
    correctionInstruction,
  };
}

function setup(): DatabaseClient {
  const directory = mkdtempSync(join(tmpdir(), "scraply-focused-experiment-"));
  directories.push(directory);
  const client = new DatabaseClient(join(directory, "scraply.db"));
  const now = new Date().toISOString();
  client.db.prepare("INSERT INTO threads (id,title,status,created_at,updated_at) VALUES ('thread-1','Test','development-running',?,?)").run(now, now);
  client.db.prepare("INSERT INTO research_runs (id,thread_id,status,config_json,created_at,updated_at) VALUES ('run-discovery','thread-1','completed','{}',?,?)").run(now, now);
  client.db.prepare("INSERT INTO problems (id,discovery_run_id,statement,why_it_persists,affected,scale_estimate,verdict,verdict_reason,verdict_source_ids_json,created_at) VALUES ('problem-1','run-discovery','Exercise contradictions ship','Manual review','Educators','Monthly','insufficient-evidence','No buyer evidence','[]',?)").run(now);
  client.db.prepare("INSERT INTO research_runs (id,thread_id,problem_id,status,config_json,created_at,updated_at) VALUES ('run-development','thread-1','problem-1','development-running','{}',?,?)").run(now, now);
  client.db.prepare("INSERT INTO solutions (id,research_run_id,problem_id,mechanism,description,respects_off_limits,respects_off_limits_why,selected_at,created_at) VALUES ('solution-1','run-development','problem-1','Checker','Compare prompts',1,'No conflict',?,?)").run(now, now);
  return client;
}

function setupEngineFixture(): DatabaseClient {
  const directory = mkdtempSync(join(tmpdir(), "scraply-focused-engine-"));
  directories.push(directory);
  const client = new DatabaseClient(join(directory, "scraply.db"));
  const now = new Date().toISOString();
  const config = RunConfigSchema.parse({
    configVersion: 2,
    workflowVersion: 2,
    audienceSourcePolicy: "web",
    ideaCount: 3,
    model: { providerId: "fixture", modelId: "experiment-model" },
    reasoningEffort: "high",
    discoveryDepth: "quick",
    maxRunMinutes: 5,
    searchProvider: "exa",
    researchMode: "known-problem",
    knownProblem: "Exercise contradictions ship",
    explorationPurpose: "general-solutions",
  });
  client.db.prepare("INSERT INTO threads (id,title,status,created_at,updated_at) VALUES ('thread-1','Test','solutions-ready',?,?)")
    .run(now, now);
  client.db.prepare(`
    INSERT INTO research_runs (id,thread_id,status,config_json,workflow_version,created_at,updated_at)
    VALUES ('run-discovery','thread-1','completed','{}',2,?,?)
  `).run(now, now);
  client.db.prepare(`
    INSERT INTO scopes (id,research_run_id,title,audience,domain,observations,off_limits_json,created_at,updated_at)
    VALUES ('scope-1','run-discovery','Exercise quality','Educators','Courses','Contradictions survive review','[]',?,?)
  `).run(now, now);
  client.db.prepare(`
    INSERT INTO problems (
      id,discovery_run_id,statement,why_it_persists,affected,scale_estimate,
      verdict,verdict_reason,verdict_source_ids_json,created_at
    ) VALUES ('problem-1','run-discovery','Exercise contradictions ship','Review is manual','Educators',
      'Monthly','insufficient-evidence','No intended-buyer evidence','[]',?)
  `).run(now);
  client.db.prepare(`
    INSERT INTO research_runs (
      id,thread_id,problem_id,status,completion_reason,config_json,workflow_version,created_at,updated_at
    ) VALUES ('run-development','thread-1','problem-1','running','Original analysis completed',?,2,?,?)
  `).run(JSON.stringify(config), now, now);

  const context = flowInput().context;
  const selected = flowInput().selectedOption;
  const option = {
    mechanism: selected.mechanism,
    description: selected.description,
    keyAssumption: selected.keyAssumption,
    whyCurrentApproachMaySuffice: selected.whyCurrentApproachMaySuffice,
    supportingEvidenceIds: selected.supportingEvidenceIds,
    contraryEvidenceIds: selected.contraryEvidenceIds,
    unknowns: selected.unknowns,
    respectsOffLimits: selected.respectsOffLimits,
    respectsOffLimitsWhy: selected.respectsOffLimitsWhy,
  };
  const repository = new WorkflowV2Repository(client);
  client.immediateTransaction(() => {
    repository.saveSolutionOptions("run-development", "problem-1", [{ id: "solution-1", ...option }]);
    repository.selectSolution("run-development", "solution-1");
    repository.saveStageResult(engineStage("solutions", context, { options: [option] }));
    repository.saveStageResult(engineStage("risk-evaluation", context, flowInput().riskEvaluation, "solution-1"));
  });
  client.db.prepare("UPDATE research_runs SET status = 'completed' WHERE id = 'run-development'").run();
  return client;
}

function engineStage(
  stageId: "solutions" | "risk-evaluation",
  context: unknown,
  output: unknown,
  selectionId: string | null = null,
) {
  const text = `Fixture ${stageId} prompt`;
  const promptSha256 = hash(text);
  return {
    researchRunId: "run-development",
    stageId,
    selectionId,
    context,
    output,
    prompt: {
      stageId,
      filename: `workflow-v2-${stageId}.md`,
      revision: 1 as const,
      source: "override" as const,
      currentBundledSha256: promptSha256,
      resolvedSha256: promptSha256,
      overrideBaseline: null,
      text,
    },
    schema: deriveJsonSchema(WORKFLOW_V2_STAGE_REGISTRY[stageId].schema),
    inputs: { problemId: "problem-1" },
    evidence: [],
    runtimePrompt: { id: "fixture-runtime", sha256: hash("fixture-runtime") },
    effectiveRequest: { stage: stageId },
  };
}

function ambiguousFocusedRequest(): StructuredStageRequest<unknown> {
  return {
    generationId: "lost-focused-dispatch",
    stage: "focused-experiment:draft",
    model: { providerId: "fixture", modelId: "experiment-model" },
    reasoningEffort: "high",
    workOrder: {
      stage: "focused-experiment:draft",
      instruction: "Plan one experiment",
      goal: "Create a focused experiment",
      definitionOfDone: ["One experiment is returned"],
      inputs: {},
    },
    evidence: [],
    schema: WorkflowV2SolutionsOutputSchema,
    jsonSchema: deriveJsonSchema(WorkflowV2SolutionsOutputSchema),
    repairPolicy: "one_retry",
    deadlineMs: 120_000,
  };
}

function generationMetadata<T>(request: StructuredStageRequest<T>) {
  return {
    model: request.model,
    usage: { status: "unknown" as const },
    latencyMs: 1,
    repairCount: 0,
    providerRequestIds: [],
    attempts: [],
  };
}

async function until(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for focused experiment work");
    await Bun.sleep(10);
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
