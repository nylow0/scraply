import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKFLOW_V2_STAGE_REGISTRY } from "../../src/core/stages";
import { recoverInterruptedEvidenceFollowUps } from "../../src/core/research-engine";
import { DatabaseClient } from "../../src/db/client";
import { CostLedgerRepository } from "../../src/db/repositories/cost-ledger";
import { GenerationAttemptRepository } from "../../src/db/repositories/generation-attempts";
import { EvidenceFollowUpRepository } from "../../src/db/repositories/evidence-follow-ups";
import {
  WorkflowV2ConflictError,
  WorkflowV2ContextMismatchError,
  WorkflowV2Repository,
} from "../../src/db/repositories/workflow-v2";
import { deriveJsonSchema } from "../../src/shared/json-schema";

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) {
    try { rmSync(directories.pop()!, { recursive: true, force: true }); } catch { /* SQLite may retain WAL briefly. */ }
  }
});

describe("workflow v2 persistence", () => {
  test("requires caller-owned synchronous transactions and rolls failures back", () => {
    const client = database();
    const repository = new WorkflowV2Repository(client);
    expect(() => repository.saveSolutionOptions("run-v2", "problem-1", [])).toThrow("caller-owned");

    let asyncBodyCalled = false;
    const asyncOperation = (async () => { asyncBodyCalled = true; }) as unknown as () => void;
    expect(() => client.immediateTransaction(asyncOperation)).toThrow("must be synchronous");
    expect(asyncBodyCalled).toBe(false);

    expect(() => client.immediateTransaction(() => {
      repository.saveSolutionOptions("run-v2", "problem-1", [solution("solution-1")]);
      const invalidCheckpoint = stageResult({ options: [] });
      invalidCheckpoint.prompt.resolvedSha256 = hash("different prompt");
      repository.saveStageResult(invalidCheckpoint);
    })).toThrow("snapshot hash mismatch");
    expect(client.db.prepare("SELECT COUNT(*) AS count FROM solutions WHERE research_run_id = 'run-v2'").get())
      .toEqual({ count: 0 });
    expect(client.db.prepare("SELECT COUNT(*) AS count FROM stage_results WHERE research_run_id = 'run-v2'").get())
      .toEqual({ count: 0 });
    client.close();
  });

  test("stores exact immutable snapshots and reuses them after bundled prompt changes", () => {
    const client = database();
    const repository = new WorkflowV2Repository(client);
    const first = client.immediateTransaction(() => repository.saveStageResult(stageResult({ options: [] })));
    expect(first.created).toBe(true);

    const saved = repository.findStageResult("run-v2", "solutions");
    expect(saved?.prompt.text).toBe("  saved override bytes\r\n");
    expect(saved?.prompt.currentBundledSha256).toBe(hash("bundled-v1\n"));
    expect(repository.getStageResumeState({
      researchRunId: "run-v2",
      stageId: "solutions",
      context: { problemId: "problem-1", revision: 1 },
    }).kind).toBe("reusable");
    expect(() => repository.getStageResumeState({
      researchRunId: "run-v2",
      stageId: "solutions",
      context: { problemId: "problem-1", revision: 2 },
    })).toThrow(WorkflowV2ContextMismatchError);
    expect(() => client.db.prepare("UPDATE stage_results SET prompt_text = 'changed'").run())
      .toThrow("immutable");
    client.close();
  });

  test("reads and resumes a nonempty solution checkpoint with stored evidence roles", () => {
    const client = database();
    const repository = new WorkflowV2Repository(client);
    const candidate = solutionOption();
    client.immediateTransaction(() => repository.saveStageResult(stageResult({ options: [candidate] })));

    const saved = repository.findStageResult("run-v2", "solutions");
    expect(saved?.output).toEqual({ options: [candidate] });
    expect(repository.getStageResumeState({
      researchRunId: "run-v2",
      stageId: "solutions",
      context: { problemId: "problem-1", revision: 1 },
    }).kind).toBe("reusable");
    client.close();
  });

  test("keeps a completed zero-option result idempotent and rejects later options", () => {
    const client = database();
    const repository = new WorkflowV2Repository(client);
    client.immediateTransaction(() => {
      expect(repository.saveSolutionOptions("run-v2", "problem-1", []).created).toBe(true);
      repository.saveStageResult(stageResult({ options: [] }));
    });
    client.immediateTransaction(() => {
      expect(repository.saveSolutionOptions("run-v2", "problem-1", []).created).toBe(false);
    });
    expect(() => client.immediateTransaction(() => {
      repository.saveSolutionOptions("run-v2", "problem-1", [solution("solution-1")]);
    })).toThrow(WorkflowV2ConflictError);
    client.close();
  });

  test("rejects semantically invalid solution and decision checkpoints", () => {
    const client = database();
    const repository = new WorkflowV2Repository(client);
    expect(() => client.immediateTransaction(() => repository.saveStageResult(stageResult({
      options: Array.from({ length: 4 }, () => solutionOption()),
    })))).toThrow("more than three options");

    const duplicateRisks = decisionAnalysis();
    duplicateRisks.risks.push({ ...duplicateRisks.risks[0]! });
    expect(() => client.immediateTransaction(() => repository.saveStageResult(
      decisionStageResult("solution-1", duplicateRisks),
    ))).toThrow("Duplicate decision risk ID");
    expect(client.db.prepare("SELECT COUNT(*) AS count FROM stage_results").get()).toEqual({ count: 0 });
    client.close();
  });

  test("persists human selection before qualitative analysis and makes selection idempotent", () => {
    const client = database();
    const repository = new WorkflowV2Repository(client);
    client.immediateTransaction(() => {
      repository.saveSolutionOptions("run-v2", "problem-1", [
        solution("solution-1"),
        solution("solution-2", "Use an export"),
      ]);
    });
    const selected = client.immediateTransaction(() => repository.selectSolution("run-v2", "solution-1"));
    expect(selected.created).toBe(true);
    expect(client.immediateTransaction(() => repository.selectSolution("run-v2", "solution-1")))
      .toEqual({ selectedAt: selected.selectedAt, created: false });
    expect(() => client.immediateTransaction(() => repository.selectSolution("run-v2", "solution-2")))
      .toThrow(WorkflowV2ConflictError);

    const analysis = decisionAnalysis();
    const stored = client.immediateTransaction(() => {
      const checkpoint = repository.saveStageResult(decisionStageResult("solution-1", analysis));
      return repository.saveDecisionAnalysis({
        researchRunId: "run-v2",
        solutionId: "solution-1",
        stageResultId: checkpoint.id,
        analysis,
      });
    });
    expect(stored.created).toBe(true);
    const unknownRisk = {
      ...analysis,
      proposedResponses: [{ ...analysis.proposedResponses[0]!, riskIds: ["unknown-risk"] }],
    };
    expect(() => client.immediateTransaction(() => repository.saveDecisionAnalysis({
      researchRunId: "run-v2",
      solutionId: "solution-1",
      stageResultId: "stage-analysis",
      analysis: unknownRisk,
    }))).toThrow("empty or unknown risk set");
    expect(client.db.prepare("SELECT user_decision, observed_result FROM decision_analyses").get())
      .toEqual({ user_decision: null, observed_result: null });
    client.close();
  });

  test("marks interrupted dispatched generations at every v2 stage as unknown instead of replayable", () => {
    for (const [index, stage] of Object.values(WORKFLOW_V2_STAGE_REGISTRY).entries()) {
      const client = database();
      const attempts = new GenerationAttemptRepository(client);
      const prepared = attempts.prepare<unknown>("run-v2", {
      generationId: `generation-${index}`,
      stage: `${stage.id}:fixture-selection`,
      model: { providerId: "test", modelId: "test" },
      reasoningEffort: "medium",
      workOrder: {
        stage: stage.id,
        instruction: "Assess evidence.",
        goal: "Assess the problem.",
        definitionOfDone: ["Return the schema."],
      },
      evidence: [],
      schema: stage.schema as import("zod").z.ZodType<unknown>,
      jsonSchema: deriveJsonSchema(stage.schema),
      repairPolicy: "one_retry",
      deadlineMs: stage.deadlineMs,
    });
      attempts.markDispatched(prepared.id);
      attempts.interruptInFlight("process ended");

      expect(new WorkflowV2Repository(client).getStageResumeState({
        researchRunId: "run-v2",
        stageId: stage.id,
        selectionId: "fixture-selection",
        context: { problemId: "problem-1" },
      })).toEqual({ kind: "unknown-completion" });
      client.close();
    }
  });

  test("consumes the one-question follow-up cap before work and never reopens it after failure", () => {
    const client = database();
    const workflow = new WorkflowV2Repository(client);
    const followUps = new EvidenceFollowUpRepository(client);
    const analysis = decisionAnalysis();
    client.immediateTransaction(() => {
      workflow.saveSolutionOptions("run-v2", "problem-1", [solution("solution-1")]);
      workflow.selectSolution("run-v2", "solution-1");
      const checkpoint = workflow.saveStageResult(decisionStageResult("solution-1", analysis));
      workflow.saveDecisionAnalysis({
        researchRunId: "run-v2",
        solutionId: "solution-1",
        stageResultId: checkpoint.id,
        analysis,
      });
      client.db.prepare("UPDATE research_runs SET status = 'completed' WHERE id = 'run-v2'").run();
    });

    client.immediateTransaction(() => followUps.request("run-v2", "solution-1", "  Does the export preserve state?  "));
    expect(followUps.find("run-v2")).toEqual(expect.objectContaining({
      question: "Does the export preserve state?",
      status: "requested",
      sourceIds: [],
      factorIds: [],
    }));
    expect(() => client.immediateTransaction(() => followUps.request("run-v2", "solution-1", "Try again")))
      .toThrow("already used");
    client.db.prepare("UPDATE research_runs SET status = 'running', budget_limit = 1 WHERE id = 'run-v2'").run();
    const ledger = new CostLedgerRepository(client);
    ledger.reserve("run-v2", "evidence-follow-up", "test", "test", 0);
    ledger.reserve("run-v2", "evidence-follow-up-search", "exa", null, 0.02);
    expect(recoverInterruptedEvidenceFollowUps(client)).toEqual(["run-v2"]);
    expect(followUps.find("run-v2")).toEqual(expect.objectContaining({
      status: "failed",
      error: "The app restarted during this follow-up. It was not replayed.",
    }));
    expect(client.db.prepare("SELECT status FROM threads WHERE id = 'thread-1'").get()).toEqual({ status: "solutions-ready" });
    expect(client.db.prepare("SELECT operation, status, committed_usd FROM cost_ledger").all())
      .toEqual([{ operation: "evidence-follow-up-search", status: "committed", committed_usd: null }]);
    expect(() => client.immediateTransaction(() => followUps.request("run-v2", "solution-1", "Try again")))
      .toThrow("already used");
    client.close();
  });

  test("rejects changed schema, input, evidence, and context identities on checkpoint reuse", () => {
    const client = database();
    const repository = new WorkflowV2Repository(client);
    const stage = stageResult({ options: [solutionOption()] });
    client.immediateTransaction(() => repository.saveStageResult(stage));
    const baseline = {
      researchRunId: "run-v2",
      stageId: "solutions" as const,
      context: stage.context,
      identity: {
        promptSha256: stage.prompt.resolvedSha256,
        schema: stage.schema,
        inputs: stage.inputs,
        evidence: stage.evidence,
      },
    };
    expect(repository.getStageResumeState(baseline).kind).toBe("reusable");
    for (const changed of [
      { ...baseline, context: { problemId: "changed" } },
      { ...baseline, identity: { ...baseline.identity, schema: { type: "changed" } } },
      { ...baseline, identity: { ...baseline.identity, inputs: { problemId: "changed" } } },
      { ...baseline, identity: { ...baseline.identity, evidence: [] } },
    ]) expect(() => repository.getStageResumeState(changed)).toThrow(WorkflowV2ContextMismatchError);
    client.close();
  });
});

function database(): DatabaseClient {
  const directory = mkdtempSync(join(tmpdir(), "scraply-workflow-v2-"));
  directories.push(directory);
  const client = new DatabaseClient(join(directory, "scraply.db"));
  const now = new Date().toISOString();
  client.db.prepare("INSERT INTO threads (id, title, status, created_at, updated_at) VALUES ('thread-1', 'V2', 'configuring', ?, ?)")
    .run(now, now);
  client.db.prepare(`
    INSERT INTO research_runs (id, thread_id, status, config_json, workflow_version, created_at, updated_at)
    VALUES ('run-discovery', 'thread-1', 'completed', '{}', 1, ?, ?)
  `).run(now, now);
  client.db.prepare(`
    INSERT INTO problems (
      id, discovery_run_id, statement, why_it_persists, affected, scale_estimate,
      verdict, verdict_reason, verdict_source_ids_json, created_at
    ) VALUES ('problem-1', 'run-discovery', 'Claims repeat', 'State is split', 'Operators',
      'Weekly', 'confirmed', 'Supported', '[]', ?)
  `).run(now);
  client.db.prepare(`
    INSERT INTO research_runs (
      id, thread_id, status, config_json, workflow_version, problem_id, created_at, updated_at
    ) VALUES ('run-v2', 'thread-1', 'running', '{}', 2, 'problem-1', ?, ?)
  `).run(now, now);
  return client;
}

function solution(id: string, mechanism = "Synchronize state") {
  return {
    id,
    ...solutionOption(mechanism),
  };
}

function solutionOption(mechanism = "Synchronize state") {
  return {
    mechanism,
    description: "Read shared state before filing.",
    keyAssumption: "State is available.",
    whyCurrentApproachMaySuffice: "An existing tool may already expose it.",
    supportingEvidenceIds: ["source-1"],
    contraryEvidenceIds: ["source-2"],
    unknowns: ["Access reliability"],
    respectsOffLimits: true,
    respectsOffLimitsWhy: "No prohibited action.",
  };
}

function stageResult(output: unknown) {
  return {
    id: "stage-solutions",
    researchRunId: "run-v2",
    stageId: "solutions" as const,
    context: { problemId: "problem-1", revision: 1 },
    output,
    prompt: prompt("solutions" as const),
    schema: deriveJsonSchema(WORKFLOW_V2_STAGE_REGISTRY.solutions.schema),
    inputs: { problemId: "problem-1" },
    evidence: [
      { sourceId: "source-1", content: { categories: ["supporting"], evidence: { quote: "Repeated filing" } } },
      { sourceId: "source-2", content: { categories: ["contrary"], evidence: { quote: "Existing tools work" } } },
    ],
    runtimePrompt: { id: "scraply.stage-worker.v1", sha256: hash("runtime-prompt") },
    effectiveRequest: { stage: "solutions", model: { providerId: "test", modelId: "test" } },
  };
}

function decisionStageResult(solutionId: string, output: unknown) {
  return {
    ...stageResult(output),
    id: "stage-analysis",
    stageId: "decision-analysis" as const,
    selectionId: solutionId,
    prompt: prompt("decision-analysis" as const),
    schema: deriveJsonSchema(WORKFLOW_V2_STAGE_REGISTRY["decision-analysis"].schema),
    effectiveRequest: { stage: "decision-analysis", solutionId },
  };
}

function prompt(stageId: "solutions" | "decision-analysis") {
  return {
    stageId,
    filename: `workflow-v2-${stageId}.md`,
    revision: 1 as const,
    source: "override" as const,
    currentBundledSha256: hash("bundled-v1\n"),
    resolvedSha256: hash("  saved override bytes\r\n"),
    overrideBaseline: null,
    text: "  saved override bytes\r\n",
  };
}

function decisionAnalysis() {
  return {
    consequences: [{
      description: "Fewer repeats",
      direction: "positive" as const,
      affects: "Operators",
      rationale: "State is shared",
    }],
    risks: [{ riskId: "risk-1", description: "Access fails", whyDecisive: "Sync stops" }],
    proposedResponses: [{
      riskIds: ["risk-1"], approach: "Test export", cost: "One hour", failsIf: "Fields are absent",
    }],
    unknowns: ["Export quality"],
    experiment: {
      question: "Is export complete?",
      method: "Inspect ten claims",
      cost: "One hour",
      passCriterion: "Nine are complete",
      failCriterion: "Two are incomplete",
    },
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
