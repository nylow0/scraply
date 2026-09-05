import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKFLOW_V2_STAGE_REGISTRY } from "../../src/core/stages";
import { DatabaseClient } from "../../src/db/client";
import { GenerationAttemptRepository } from "../../src/db/repositories/generation-attempts";
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
    expect(client.db.prepare("SELECT user_decision, observed_result FROM decision_analyses").get())
      .toEqual({ user_decision: null, observed_result: null });
    client.close();
  });

  test("marks an interrupted dispatched generation as unknown instead of replayable", () => {
    const client = database();
    const attempts = new GenerationAttemptRepository(client);
    const stage = WORKFLOW_V2_STAGE_REGISTRY["problem-kill"];
    const prepared = attempts.prepare("run-v2", {
      generationId: "generation-1",
      stage: stage.id,
      model: { providerId: "test", modelId: "test" },
      reasoningEffort: "medium",
      workOrder: {
        stage: stage.id,
        instruction: "Assess evidence.",
        goal: "Assess the problem.",
        definitionOfDone: ["Return the schema."],
      },
      evidence: [],
      schema: stage.schema,
      jsonSchema: deriveJsonSchema(stage.schema),
      repairPolicy: "one_retry",
      deadlineMs: stage.deadlineMs,
    });
    attempts.markDispatched(prepared.id);
    attempts.interruptInFlight("process ended");

    expect(new WorkflowV2Repository(client).getStageResumeState({
      researchRunId: "run-v2",
      stageId: "problem-kill",
      context: { problemId: "problem-1" },
    })).toEqual({ kind: "unknown-completion" });
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
    evidence: [{ sourceId: "source-1", content: { quote: "Repeated filing" } }],
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
