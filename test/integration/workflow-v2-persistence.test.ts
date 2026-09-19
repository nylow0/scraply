import { createHash } from "node:crypto";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";
import { Database } from "bun:sqlite";
import { MIGRATIONS } from "../../src/db/migrations";
import { DevelopmentRepository } from "../../src/db/repositories/development";
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
import { FactorHarvestOutputSchema, ProblemCandidatesOutputSchema } from "../../src/shared/structured-output-schemas";
import { WorkflowExecution } from "../../src/core/workflow-execution";
import { configurePromptPaths } from "../../src/core/prompts";
import { discoverProblems, harvestFactors, type HarvestedFactor, type HarvestedSource } from "../../src/core/discovery";
import type { StructuredModelClient, StructuredStageRequest } from "../../src/providers/structured";

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) {
    try { rmSync(directories.pop()!, { recursive: true, force: true }); } catch { /* SQLite may retain WAL briefly. */ }
  }
});

describe("workflow v2 persistence", () => {
  test("harvests formatted source quotes and rejects bad factors without aborting the research stage", async () => {
    configurePromptPaths({ bundledDir: join(process.cwd(), "prompts"), overrideDir: null });
    const client = database();
    const execution = new WorkflowExecution(client, "run-v2");
    const modelClient: StructuredModelClient = { async structuredCompletion(request) {
      const evidence = request.evidence[0]!.content as { sources?: Array<{ id: string }> };
      const factor = { subject: "Students", behavior: "miss deadlines", sourceId: evidence.sources?.[0]?.id,
        quote: "Students do not submit their assignments on time", modelConfidence: 0.8, uncertainty: "One source" };
      const output = request.stage.startsWith("query-plan")
        ? { queries: ["one", "two", "three"].map(query => ({ query, uncertainty: "Deadline challenges", intendedSourceType: "Student reports" })) }
        : { factors: [factor, { ...factor, quote: "Students do submit their assignments on time" }, { ...factor, sourceId: "invented" }] };
      return { output: request.schema.parse(output), metadata: {
        model: request.model, usage: { status: "unknown" }, latencyMs: 1, repairCount: 0, providerRequestIds: [], attempts: [],
        prompt: { id: "scraply.stage-worker.v1", sha256: createHash("sha256").update("runtime-prompt").digest("hex") },
      } };
    } };
    try {
      const result = await harvestFactors({ title: "Homework", audience: "Students", domain: "Homework", observations: "", offLimits: [] }, {
        model: { providerId: "openai-subscription", modelId: "gpt-5.6-luna" }, reasoningEffort: "low", depth: "quick", workflowVersion: 2,
        modelClient: execution.discoveryClient(modelClient), prompt: () => "Extract evidence", search: { async search() {
          return [{ id: "source", url: "https://example.test/homework", title: "Homework", text: "STUDENTS DO NOT SUBMIT THEIR ASSIGNMENTS ON TIME" }];
        } },
      });
      expect(result.factors).toHaveLength(1);
      expect(result.factors[0]!.quote).toBe("Students do not submit their assignments on time");
      expect(result.rejections.map(item => item.reason).sort()).toEqual(["quote-mismatch", "unknown-source"]);
      expect(result.metrics.accepted.domain).toBe(1);
      expect(result.metrics.rejected.domain).toBe(2);
    } finally { client.close(); }
  });

  test("migrates v19 risk snapshots without losing decisions, observations or historical child rows", () => {
    const source = database();
    const repository = new WorkflowV2Repository(source);
    const analysis = decisionAnalysis();
    const stage = decisionStageResult("solution-1", analysis);
    const promptSnapshot = prompt("risk-evaluation");
    try {
      source.immediateTransaction(() => {
        repository.saveSolutionOptions("run-v2", "problem-1", [solution("solution-1")]);
        repository.selectSolution("run-v2", "solution-1");
        const saved = repository.saveStageResult(stage);
        repository.saveDecisionAnalysis({ researchRunId: "run-v2", solutionId: "solution-1", stageResultId: saved.id, analysis });
      });
      source.db.prepare("UPDATE decision_analyses SET user_decision = 'Pilot', observed_result = 'Nine of ten worked'").run();
      const development = new DevelopmentRepository(source);
      development.persistOutcomes("run-v2", [{ id: "outcome-1", solutionId: "solution-1", description: "Less rework", direction: "positive", affects: "Operators", addressesCore: true }]);
      development.persistRiskAnalysis("run-v2", "solution-1", [{ id: "risk-1", solutionId: "solution-1", description: "Access fails", likelihood: "possible", impact: "project ends", sortKey: 8 }], [{ id: "mitigation-1", solutionId: "solution-1", approach: "Test export", cost: "One hour", failsIf: "Missing fields", riskIds: ["risk-1"] }]);
      source.db.prepare("UPDATE research_runs SET status = 'completed' WHERE id = 'run-v2'").run();
      source.immediateTransaction(() => new EvidenceFollowUpRepository(source).request("run-v2", "solution-1", "Do exports preserve state?"));
      const execution = new WorkflowExecution(source, "run-v2");
      execution.save("development-context", stage.context);
      execution.save("risk-evaluation:solution-1", {
        evaluation: { risks: analysis.risks, unknowns: analysis.unknowns },
        request: { model: DEFAULT_RUN_CONFIG.model, reasoningEffort: "low", workOrder: { stage: "risk-evaluation", instruction: promptSnapshot.text, goal: "Evaluate risk", inputs: stage.inputs }, evidence: stage.evidence, jsonSchema: deriveJsonSchema(WORKFLOW_V2_STAGE_REGISTRY["risk-evaluation"].schema), deadlineMs: 120000, repairPolicy: "one_retry" },
        prompt: promptSnapshot, metadata: { prompt: stage.runtimePrompt },
      });
      const directory = mkdtempSync(join(tmpdir(), "scraply-upgrade-v19-"));
      directories.push(directory);
      const path = join(directory, "scraply.db");
      const legacy = new Database(path);
      legacy.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
      for (const migration of MIGRATIONS.filter(item => item.id <= 19)) {
        legacy.exec(migration.sql);
        legacy.prepare("INSERT INTO schema_migrations VALUES (?, ?)").run(migration.id, new Date().toISOString());
      }
      const tables = ["threads", "research_runs", "problems", "solutions", "outcomes", "risks", "mitigations", "risk_mitigations", "stage_results", "decision_analyses", "evidence_follow_ups", "workflow_snapshots"];
      // Runs and problems reference each other; restore the complete fixture before checking it.
      legacy.exec("PRAGMA foreign_keys = OFF");
      const snapshots = new Map(tables.map(table => [table, source.db.prepare(`SELECT * FROM ${table}`).all()]));
      for (const table of tables) {
        for (const row of snapshots.get(table)!) {
          // The v19 fixture predates archive, evidence classification, startup and reassessment columns.
          const migration23Columns = new Set([
            "source_role", "audience_fit", "independent_source_key", "supports_demand", "demand_evidence_uncertainty",
            "intended_buyer_evidence_factor_ids_json", "evidence_gap",
          ]);
          const values = Object.entries(row as Record<string, string | number | null>)
            .filter(([column]) => {
              if (migration23Columns.has(column)) return false;
              if (table === "threads") return column !== "archived_at";
              if (table === "solutions") return column !== "startup_opportunity_json";
              if (table === "decision_analyses") return column !== "experiment_outcome";
              if (table === "evidence_follow_ups") return ![
                "reassessment_status", "risk_reassessment_json", "reassessment_analysis_json",
                "risk_generation_id", "analysis_generation_id", "reassessment_error", "reassessed_at",
              ].includes(column);
              return true;
            });
          legacy.prepare(`INSERT INTO ${table} (${values.map(([key]) => key).join(",")}) VALUES (${values.map(() => "?").join(",")})`).run(...values.map(([, value]) => value));
        }
      }
      expect(legacy.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      legacy.close();
      const upgraded = new DatabaseClient(path);
      try {
        for (const table of tables.filter(table => table !== "stage_results")) {
          expect(upgraded.db.prepare(`SELECT * FROM ${table}`).all()).toEqual(snapshots.get(table)!);
        }
        const risk = new WorkflowV2Repository(upgraded).findStageResult("run-v2", "risk-evaluation", "solution-1")!;
        expect(risk.output).toEqual({ risks: analysis.risks, unknowns: analysis.unknowns });
        expect(risk.prompt).toEqual(promptSnapshot);
        const resume = { researchRunId: "run-v2", stageId: "risk-evaluation" as const, selectionId: "solution-1", context: risk.context,
          identity: { promptSha256: risk.prompt.resolvedSha256, schema: risk.schema, inputs: risk.inputs, evidence: risk.evidence } };
        const restored = new WorkflowV2Repository(upgraded);
        expect(restored.getStageResumeState(resume).kind).toBe("reusable");
        for (const identity of [
          { ...resume.identity, promptSha256: "0".repeat(64) },
          { ...resume.identity, schema: {} },
          { ...resume.identity, inputs: {} },
          { ...resume.identity, evidence: [] },
        ]) expect(() => restored.getStageResumeState({ ...resume, identity })).toThrow(WorkflowV2ContextMismatchError);
        expect(() => restored.getStageResumeState({ ...resume, context: {} })).toThrow(WorkflowV2ContextMismatchError);
        expect(() => upgraded.db.prepare("UPDATE stage_results SET output_json = '{}' WHERE id = ?").run(risk.id)).toThrow("immutable");
        expect(upgraded.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(upgraded.db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
        expect(() => upgraded.db.prepare("UPDATE solutions SET option_position = 20 WHERE id = 'solution-1'").run()).toThrow();
        upgraded.db.prepare("UPDATE solutions SET option_position = 19 WHERE id = 'solution-1'").run();
        upgraded.db.prepare("DELETE FROM solutions WHERE id = 'solution-1'").run();
        for (const table of ["outcomes", "risks", "mitigations", "risk_mitigations", "decision_analyses", "evidence_follow_ups"]) {
          expect(upgraded.db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
        }
      } finally { upgraded.close(); }
    } finally { source.close(); }
  });

  test("snapshots earlier reported experiment results for a later run of the same problem", () => {
    configurePromptPaths({ bundledDir: join(process.cwd(), "prompts"), overrideDir: null });
    const client = database();
    const repository = new WorkflowV2Repository(client);
    try {
      client.immediateTransaction(() => {
        repository.saveSolutionOptions("run-v2", "problem-1", [solution("solution-1")]);
        repository.selectSolution("run-v2", "solution-1");
        const analysis = decisionAnalysis();
        const checkpoint = repository.saveStageResult(decisionStageResult("solution-1", analysis));
        repository.saveDecisionAnalysis({ researchRunId: "run-v2", solutionId: "solution-1", stageResultId: checkpoint.id, analysis });
      });
      client.db.prepare("UPDATE decision_analyses SET user_decision = 'Stop prototype', observed_result = 'Five trials failed to synchronize.'").run();
      client.db.prepare("UPDATE research_runs SET status = 'completed' WHERE id = 'run-v2'").run();
      const now = new Date().toISOString();
      client.db.prepare("INSERT INTO scopes (id, research_run_id, title, audience, domain, observations, off_limits_json, created_at, updated_at) VALUES ('scope-1', 'run-discovery', 'Filing', 'Operators', 'Filing', '', '[]', ?, ?)").run(now, now);
      client.db.prepare(`INSERT INTO research_runs (id, thread_id, status, config_json, workflow_version, problem_id, created_at, updated_at)
        VALUES ('run-next', 'thread-1', 'running', '{}', 2, 'problem-1', ?, ?)`).run(now, now);
      const context = new WorkflowExecution(client, "run-next").developmentContext("problem-1");
      expect(context.recordedExperiments).toEqual({ results: [{ mechanism: "Synchronize state", userDecision: "Stop prototype", observedResult: "Five trials failed to synchronize." }], omittedCount: 0 });
      client.db.prepare("UPDATE decision_analyses SET observed_result = 'Later correction'").run();
      expect(new WorkflowExecution(client, "run-next").developmentContext("problem-1").recordedExperiments).toEqual(context.recordedExperiments);
      client.db.prepare("UPDATE decision_analyses SET user_decision = ?, observed_result = ?").run("d".repeat(8000), "r".repeat(8000));
      client.db.prepare("UPDATE research_runs SET status = 'completed' WHERE id = 'run-next'").run();
      client.db.prepare(`INSERT INTO research_runs (id, thread_id, status, config_json, workflow_version, problem_id, created_at, updated_at)
        VALUES ('run-bounded', 'thread-1', 'running', '{}', 2, 'problem-1', ?, ?)`).run(now, now);
      expect(new WorkflowExecution(client, "run-bounded").developmentContext("problem-1").recordedExperiments)
        .toEqual({ results: [], omittedCount: 1 });
    } finally { client.close(); }
  });

  test("keeps older project mechanisms visible after several long option runs", () => {
    configurePromptPaths({ bundledDir: join(process.cwd(), "prompts"), overrideDir: null });
    const client = database();
    const now = new Date().toISOString();
    const learnerBlocker = "Collect learner setup blockers, keep each case open, and require learner confirmation before closure.";
    try {
      client.db.prepare("UPDATE research_runs SET status = 'completed' WHERE id = 'run-v2'").run();
      client.db.prepare(`
        INSERT INTO scopes (
          id, research_run_id, title, audience, domain, observations, off_limits_json, created_at, updated_at
        ) VALUES ('history-scope', 'run-discovery', 'Educator tools', 'Independent educators', 'Course operations', '', '[]', ?, ?)
      `).run(now, now);
      for (let problemIndex = 0; problemIndex < 5; problemIndex += 1) {
        const problemId = `history-problem-${problemIndex}`;
        const runId = `history-run-${problemIndex}`;
        client.db.prepare(`
          INSERT INTO problems (
            id, discovery_run_id, statement, why_it_persists, affected, scale_estimate,
            verdict, verdict_reason, verdict_source_ids_json, created_at
          ) VALUES (?, 'run-discovery', ?, '', '', '', 'user-asserted', 'Selected by the user.', '[]', ?)
        `).run(problemId, `Long supplementary hypothesis ${problemIndex}: ${"payment, enrollment, access, and administration. ".repeat(30)}`, now);
        client.db.prepare(`
          INSERT INTO research_runs (
            id, thread_id, status, config_json, workflow_version, problem_id, created_at, updated_at
          ) VALUES (?, 'thread-1', 'completed', ?, 2, ?, ?, ?)
        `).run(runId, JSON.stringify(DEFAULT_RUN_CONFIG), problemId, now, now);
      }
      for (let optionIndex = 0; optionIndex < 29; optionIndex += 1) {
        const problemIndex = Math.floor(optionIndex / 6);
        const mechanism = optionIndex === 0
          ? learnerBlocker
          : `Track enrollment exception ${optionIndex}. ${"Record each state transition and require explicit confirmation. ".repeat(20)}`;
        client.db.prepare(`
          INSERT INTO solutions (
            id, problem_id, mechanism, description, respects_off_limits, respects_off_limits_why,
            created_at, research_run_id, option_position
          ) VALUES (?, ?, ?, ?, 1, 'Within constraints.', ?, ?, ?)
        `).run(
          `history-solution-${optionIndex}`,
          `history-problem-${problemIndex}`,
          mechanism,
          `Compact option ${optionIndex}: ${"A deliberately long production-shaped description. ".repeat(10)}`,
          now,
          `history-run-${problemIndex}`,
          optionIndex % 6,
        );
      }
      client.db.prepare(`
        INSERT INTO research_runs (
          id, thread_id, status, config_json, workflow_version, problem_id, created_at, updated_at
        ) VALUES ('history-current', 'thread-1', 'running', ?, 2, 'problem-1', ?, ?)
      `).run(JSON.stringify(DEFAULT_RUN_CONFIG), now, now);

      const context = new WorkflowExecution(client, "history-current").developmentContext("problem-1");
      expect(context.priorProjectMechanisms).toHaveLength(29);
      expect(context.priorProjectMechanisms?.some((item) => item.mechanism.includes(learnerBlocker))).toBe(true);
      expect(context.priorProjectMechanismsOmittedCount).toBe(0);
      expect(JSON.stringify(context.priorProjectMechanisms).length).toBeLessThanOrEqual(24_000);

      client.db.prepare("UPDATE research_runs SET status = 'completed' WHERE id = 'history-current'").run();
      client.db.prepare(`
        INSERT INTO problems (
          id, discovery_run_id, statement, why_it_persists, affected, scale_estimate,
          verdict, verdict_reason, verdict_source_ids_json, created_at
        ) VALUES ('overflow-problem', 'run-discovery', ?, '', '', '', 'user-asserted', 'Selected by the user.', '[]', ?)
      `).run(`Another long hypothesis: ${"integration recovery and exception handling. ".repeat(30)}`, now);
      client.db.prepare(`
        INSERT INTO research_runs (
          id, thread_id, status, config_json, workflow_version, problem_id, created_at, updated_at
        ) VALUES ('overflow-run', 'thread-1', 'completed', ?, 2, 'overflow-problem', ?, ?)
      `).run(JSON.stringify(DEFAULT_RUN_CONFIG), now, now);
      for (let optionIndex = 0; optionIndex < 20; optionIndex += 1) {
        client.db.prepare(`
          INSERT INTO solutions (
            id, problem_id, mechanism, description, respects_off_limits, respects_off_limits_why,
            created_at, research_run_id, option_position
          ) VALUES (?, 'overflow-problem', ?, ?, 1, 'Within constraints.', ?, 'overflow-run', ?)
        `).run(
          `overflow-solution-${optionIndex}`,
          `Handle integration exception ${optionIndex}. ${"Record transitions and require operator confirmation. ".repeat(20)}`,
          `Overflow option ${optionIndex}: ${"A deliberately long production-shaped description. ".repeat(10)}`,
          now,
          optionIndex,
        );
      }
      client.db.prepare(`
        INSERT INTO research_runs (
          id, thread_id, status, config_json, workflow_version, problem_id, created_at, updated_at
        ) VALUES ('overflow-current', 'thread-1', 'running', ?, 2, 'problem-1', ?, ?)
      `).run(JSON.stringify(DEFAULT_RUN_CONFIG), now, now);
      const overflow = new WorkflowExecution(client, "overflow-current").developmentContext("problem-1");
      expect((overflow.priorProjectMechanisms?.length ?? 0) + (overflow.priorProjectMechanismsOmittedCount ?? 0)).toBe(49);
      expect(overflow.priorProjectMechanismsOmittedCount).toBeGreaterThan(0);
      expect(JSON.stringify(overflow.priorProjectMechanisms).length).toBeLessThanOrEqual(24_000);
    } finally { client.close(); }
  });

  test.each(["openrouter", "openai-subscription"])("uses each discovery stage's output ceiling for %s", async (providerId) => {
    configurePromptPaths({ bundledDir: join(process.cwd(), "prompts"), overrideDir: null });
    const client = database();
    const execution = new WorkflowExecution(client, "run-v2");
    try {
      for (const stageId of ["query-plan", "factor-harvest", "problem-candidates", "problem-kill"] as const) {
        const stage = WORKFLOW_V2_STAGE_REGISTRY[stageId];
        let inspected = false;
        const adapter = execution.discoveryClient({ async structuredCompletion(request) {
          if (providerId === "openai-subscription") expect(request).not.toHaveProperty("maxOutputTokens");
          else expect(request.maxOutputTokens).toBe(stage.maxOutputTokens);
          inspected = true;
          throw new Error("Inspected before provider dispatch");
        } });
        await expect(adapter.structuredCompletion<unknown>({
          generationId: `generation-${stageId}`, stage: stageId, model: { providerId, modelId: "test" }, reasoningEffort: "low",
          workOrder: { stage: stageId, instruction: "Legacy instruction", goal: "Review evidence", inputs: {}, requiredDecisions: [], definitionOfDone: [], constraints: [] },
          evidence: [], schema: stage.schema, jsonSchema: deriveJsonSchema(stage.schema), repairPolicy: "one_retry",
          maxOutputTokens: 8192, deadlineMs: 120000,
        })).rejects.toThrow("Inspected before provider dispatch");
        expect(inspected).toBe(true);
      }
    } finally { client.close(); }
  });

  test("reuses a completed factor batch after interruption before the full harvest is persisted", async () => {
    configurePromptPaths({ bundledDir: join(process.cwd(), "prompts"), overrideDir: null });
    const client = database();
    const stage = WORKFLOW_V2_STAGE_REGISTRY["factor-harvest"];
    let providerCalls = 0;
    const provider: StructuredModelClient = { async structuredCompletion(request) {
      providerCalls += 1;
      if (providerCalls > 1) throw new Error("Completed batch was sent to the provider again");
      const output = request.schema.parse({ factors: [{
        subject: "Operators", behavior: "repeat filing", quote: "Operators repeat filing.",
        sourceId: "source", modelConfidence: 0.8, uncertainty: "One source",
      }, {
        subject: "Operators", behavior: "reconcile duplicates", quote: "Operators reconcile duplicate records.",
        sourceId: "source", modelConfidence: 0.7, uncertainty: "One source",
      }] });
      const metadata = {
        model: request.model, usage: { status: "unknown" as const }, latencyMs: 1, repairCount: 0,
        providerRequestIds: [], attempts: [],
        prompt: { id: "scraply.stage-worker.v1", sha256: createHash("sha256").update("runtime-prompt").digest("hex") },
      };
      const attempts = new GenerationAttemptRepository(client);
      const prepared = attempts.prepare("run-v2", { ...request, deadlineMs: 120_000 });
      attempts.markDispatched(prepared.id);
      attempts.markAccepted(prepared.id, { compilerPrompt: metadata.prompt });
      attempts.recordTerminal(prepared.id, {
        status: "completed", terminalKind: "completed", output, attemptMetadata: metadata, usage: metadata.usage,
      });
      throw new Error("Process ended after recording the provider terminal");
    } };
    const request = (generationId: string, partitioned = false): StructuredStageRequest<unknown> => ({
      generationId, stage: partitioned ? "factor-harvest:domain:source" : "factor-harvest:domain:source,other", model: { providerId: "test", modelId: "test" }, reasoningEffort: "high",
      workOrder: { stage: partitioned ? "factor-harvest:domain:source" : "factor-harvest:domain:source,other", instruction: "Legacy instruction", goal: "Extract factors", inputs: { harvestMode: "domain", factorLimit: partitioned ? 1 : 15 }, requiredDecisions: [], definitionOfDone: [], constraints: [] },
      evidence: [{
        sourceId: partitioned ? "scraply:factor-harvest:domain:source" : "scraply:factor-harvest:domain:source,other",
        content: {
          scope: { title: "Filing", audience: "Operators" },
          sources: partitioned ? [{ id: "source", text: "Operators repeat filing." }] : [{ id: "source", text: "Operators repeat filing." }, { id: "other", text: "Other evidence." }],
        },
      }], schema: FactorHarvestOutputSchema,
      jsonSchema: deriveJsonSchema(FactorHarvestOutputSchema), repairPolicy: "one_retry", deadlineMs: stage.deadlineMs,
    });
    try {
      await expect(new WorkflowExecution(client, "run-v2").discoveryClient(provider).structuredCompletion(request("first")))
        .rejects.toThrow("Process ended after recording the provider terminal");

      let rejectedReuseDispatches = 0;
      const expectsFreshDispatch = async (candidate: StructuredStageRequest<unknown>) => {
        const rejectingProvider: StructuredModelClient = { async structuredCompletion() {
          rejectedReuseDispatches++;
          throw new Error("Fresh provider dispatch");
        } };
        await expect(new WorkflowExecution(client, "run-v2").discoveryClient(rejectingProvider).structuredCompletion(candidate))
          .rejects.toThrow("Fresh provider dispatch");
      };
      const smaller = request("resume-check", true);
      await expectsFreshDispatch({
        ...smaller,
        stage: "factor-harvest:audience:source",
        workOrder: { ...smaller.workOrder, stage: "factor-harvest:audience:source", inputs: { harvestMode: "audience", factorLimit: 1 } },
      });
      await expectsFreshDispatch({
        ...smaller,
        evidence: [{ ...smaller.evidence[0]!, content: { scope: { title: "Filing", audience: "Operators" }, sources: [{ id: "source", text: "Changed evidence." }] } }],
      });
      await expectsFreshDispatch({
        ...smaller,
        evidence: [{ ...smaller.evidence[0]!, content: { scope: { title: "Changed scope", audience: "Operators" }, sources: [{ id: "source", text: "Operators repeat filing." }] } }],
      });
      await expectsFreshDispatch({ ...smaller, evidence: [...smaller.evidence, { sourceId: "extra", content: { note: "Changed envelope" } }] });
      await expectsFreshDispatch({
        ...smaller,
        stage: "factor-harvest:domain:missing",
        workOrder: { ...smaller.workOrder, stage: "factor-harvest:domain:missing" },
        evidence: [{ sourceId: "missing", content: { scope: { title: "Filing", audience: "Operators" }, sources: [{ id: "missing", text: "Different source." }] } }],
      });

      await expectsFreshDispatch({ ...smaller, model: { ...smaller.model, modelId: "different-model" } });
      expect(rejectedReuseDispatches).toBe(6);

      const resumed = new WorkflowExecution(client, "run-v2");
      const recovered = await resumed.discoveryClient(provider).structuredCompletion(request("resume", true));

      expect(providerCalls).toBe(1);
      expect((recovered.output as { factors: unknown[] }).factors).toHaveLength(1);
      expect(recovered.output).toEqual({ factors: [expect.objectContaining({
        sourceRole: "unknown", audienceFit: "unknown", independentSourceKey: null, supportsDemand: false,
        demandEvidenceUncertainty: "Not classified in the saved output.",
      })] });
      expect(resumed.withFactorUncertainty([{
        subject: "Operators", behavior: "repeat filing", quote: "Operators repeat filing.", sourceId: "source",
      }])).toEqual([{
        subject: "Operators", behavior: "repeat filing", quote: "Operators repeat filing.", sourceId: "source",
        uncertainty: "One source",
      }]);
    } finally { client.close(); }
  });

  test("recovers a completed problem-candidates attempt without another provider call", async () => {
    configurePromptPaths({ bundledDir: join(process.cwd(), "prompts"), overrideDir: null });
    const client = database();
    const stage = WORKFLOW_V2_STAGE_REGISTRY["problem-candidates"];
    const request: StructuredStageRequest<unknown> = {
      generationId: "candidate-original", stage: "problem-candidates:batch-1", model: { providerId: "test", modelId: "test" }, reasoningEffort: "high",
      workOrder: { stage: "problem-candidates", instruction: "Legacy instruction", goal: "Find problems", inputs: {}, requiredDecisions: [], definitionOfDone: [], constraints: [] },
      evidence: [], schema: ProblemCandidatesOutputSchema, jsonSchema: deriveJsonSchema(ProblemCandidatesOutputSchema), repairPolicy: "one_retry", deadlineMs: stage.deadlineMs,
    };
    const output = stage.schema.parse({ problems: [{ statement: "Operators repeat filing.", whyItPersists: "Systems disagree.", affected: "Operators",
      scaleEstimate: "Unknown", scaleBasisFactorId: null, factorIds: [], alternativeExplanations: [], unknowns: ["Frequency"] }] });
    const metadata = { model: request.model, usage: { status: "unknown" as const }, latencyMs: 1, repairCount: 0, providerRequestIds: [], attempts: [],
      prompt: { id: "scraply.stage-worker.v1", sha256: createHash("sha256").update("runtime-prompt").digest("hex") } };
    try {
      let providerCalls = 0;
      const adapter = new WorkflowExecution(client, "run-v2").discoveryClient({ structuredCompletion: async (received) => {
        providerCalls++;
        if (providerCalls > 1) throw new Error("Provider must not be called twice");
        const attempts = new GenerationAttemptRepository(client);
        const prepared = attempts.prepare("run-v2", received);
        attempts.markDispatched(prepared.id); attempts.markAccepted(prepared.id, { compilerPrompt: metadata.prompt });
        attempts.recordTerminal(prepared.id, { status: "completed", terminalKind: "completed", output, attemptMetadata: metadata, usage: metadata.usage });
        throw new Error("Process ended after recording the provider terminal");
      } });
      await expect(adapter.structuredCompletion(request)).rejects.toThrow("Process ended");
      const recovered = await adapter.structuredCompletion({ ...request, generationId: "candidate-resume" });
      expect(providerCalls).toBe(1);
      expect(recovered.output).toEqual({ problems: [{ statement: "Operators repeat filing.", whyItPersists: "Systems disagree.", affected: "Operators",
        scaleEstimate: "Unknown", scaleBasisFactorId: null, factorIds: [] }] });
      expect(new WorkflowExecution(client, "run-v2").repository.findStageResult("run-v2", "problem-candidates", "batch-1")).not.toBeNull();
    } finally { client.close(); }
  });

  test.each([false, true])("assesses supplied supporting and contrary sources while rejecting invented citations (%s)", async (invented) => {
    await withDiscoveryFixture(async ({ execution, source }) => {
      const modelClient = discoveryModelClient((request) => {
        const evidence = request.evidence[0]!.content as { sources?: Array<{ id: string }> };
        return request.stage === "problem-candidates" ? { problems: [{
          statement: "Operators repeat filing.", whyItPersists: "Systems disagree.", affected: "Operators",
          scaleEstimate: "Unknown", scaleBasisFactorId: null, factorIds: ["factor"], alternativeExplanations: [], unknowns: [],
        }] } : {
          verdict: "already-solved", verdictReason: "A manual alternative addresses the supplied observation.",
          verdictSourceIds: ["support", evidence.sources![0]!.id, ...(invented ? ["invented"] : [])],
          unresolvedAssumptions: [], wouldChangeConclusion: [],
          intendedBuyerEvidenceFactorIds: [], evidenceGap: "No independent intended-buyer evidence.",
        };
      });
      const result = discoverProblems({ title: "Filing", audience: "Operators", domain: "Filing", observations: "", offLimits: [] }, [
        discoveryFactor(source, "factor", 0.8),
      ], [source], {
        model: { providerId: "test", modelId: "test" }, reasoningEffort: "low", depth: "quick", workflowVersion: 2,
        modelClient: execution.discoveryClient(modelClient),
        prompt: (stage) => execution.resolvePrompt(stage as keyof typeof WORKFLOW_V2_STAGE_REGISTRY).text,
        search: { async search() { return [{ id: "contrary", url: "https://contrary.test/page", title: "Alternative", text: "Use a checklist." }]; } },
      });
      if (invented) await expect(result).rejects.toThrow("unknown source ID");
      else {
        const discovery = await result;
        expect(discovery.problems[0]!.verdictSourceIds).toEqual(["support", discovery.killSources[0]!.id]);
      }
    });
  });

  test("does not let an invalid candidate consume the assessment limit", async () => {
    await withDiscoveryFixture(async ({ execution, source }) => {
      let assessments = 0;
      const modelClient = discoveryModelClient((request) => {
        const candidate = { statement: "Operators repeat filing.", whyItPersists: "Systems disagree.", affected: "Operators",
          scaleEstimate: "Unknown", scaleBasisFactorId: null, factorIds: ["factor"], alternativeExplanations: [], unknowns: [] };
        if (request.stage !== "problem-candidates") assessments++;
        return request.stage === "problem-candidates"
          ? { problems: [{ ...candidate, statement: "Untraceable candidate", factorIds: ["typo"] }, candidate] }
          : { verdict: "already-solved", verdictReason: "An existing option handles filing.", verdictSourceIds: ["support"], unresolvedAssumptions: [], wouldChangeConclusion: [], intendedBuyerEvidenceFactorIds: [], evidenceGap: "No independent intended-buyer evidence." };
      });
      const result = await discoverProblems({ title: "Filing", audience: "Operators", domain: "Filing", observations: "", offLimits: [] }, [
        discoveryFactor(source),
      ], [source], {
        workflowVersion: 2, model: { providerId: "openai-subscription", modelId: "gpt-5.6-luna" }, reasoningEffort: "low", depth: "quick",
        candidateLimit: 1,
        modelClient: execution.discoveryClient(modelClient), prompt: () => "Assess evidence", search: { async search() { return []; } },
      });
      expect(result.problems).toHaveLength(1);
      expect(result.problems[0]!.factorIds).toEqual(["factor"]);
      expect(result.blockedCandidates).toEqual([{ statement: "Untraceable candidate", reason: "Candidate cited an unknown factor ID; its evidence could not be verified." }]);
      expect(assessments).toBe(1);
    });
  });

  test("blocks scale estimates whose basis is unknown or absent from the cited factors", async () => {
    await withDiscoveryFixture(async ({ execution, source }) => {
      const factors = [discoveryFactor(source), discoveryFactor(source, "uncited-factor")];
      let assessments = 0;
      const modelClient = discoveryModelClient((request) => {
        const candidate = { whyItPersists: "Systems disagree.", affected: "Operators", scaleEstimate: "Weekly",
          factorIds: ["factor"], alternativeExplanations: [], unknowns: [] };
        if (request.stage !== "problem-candidates") assessments++;
        return request.stage === "problem-candidates"
          ? { problems: [
            { ...candidate, statement: "Unknown scale basis", scaleBasisFactorId: "missing-factor" },
            { ...candidate, statement: "Uncited scale basis", scaleBasisFactorId: "uncited-factor" },
          ] }
          : { verdict: "confirmed", verdictReason: "Evidence supports the estimate.", verdictSourceIds: ["support"], unresolvedAssumptions: [], wouldChangeConclusion: [] };
      });
      const result = await discoverProblems({ title: "Filing", audience: "Operators", domain: "Filing", observations: "", offLimits: [] }, factors, [source], {
        workflowVersion: 2, model: { providerId: "openai-subscription", modelId: "gpt-5.6-luna" }, reasoningEffort: "low", depth: "quick",
        modelClient: execution.discoveryClient(modelClient), prompt: () => "Assess evidence", search: { async search() { return []; } },
      });
      expect(result.problems).toEqual([]);
      expect(result.blockedCandidates).toEqual([
        { statement: "Unknown scale basis", reason: "Candidate scale basis did not cite a known supporting factor; its scale evidence could not be verified." },
        { statement: "Uncited scale basis", reason: "Candidate scale basis did not cite a known supporting factor; its scale evidence could not be verified." },
      ]);
      expect(assessments).toBe(0);
    });
  });

  test("uses compact references for new runs while reproducing legacy references exactly", () => {
    configurePromptPaths({ bundledDir: join(process.cwd(), "prompts"), overrideDir: null });
    const client = database();
    const execution = new WorkflowExecution(client, "run-v2");
    const next = execution.idFactory("harvest");
    const ids = Array.from({ length: 100 }, () => next());
    expect(new Set(ids).size).toBe(100);
    expect(ids.every((id) => id.length === 24)).toBe(true);
    expect(new WorkflowExecution(client, "run-v2").idFactory("harvest")()).toBe(ids[0]!);
    expect(execution.idFactory("other-phase")()).not.toBe(ids[0]!);

    const legacy = database();
    legacy.db.prepare("INSERT INTO workflow_snapshots VALUES (?, ?, ?)")
      .run("run-v2", "prompts", JSON.stringify(execution.read("prompts")));
    const restored = new WorkflowExecution(legacy, "run-v2");
    expect(restored.idFactory("harvest")()).toBe(hash("run-v2:harvest:0"));
    expect(restored.read("identifier-characters")).toBeNull();
    client.close();
    legacy.close();
  });

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

  test("persists startup opportunity details while keeping general options nullable", () => {
    const client = database();
    const repository = new WorkflowV2Repository(client);
    const candidate = {
      ...solution("startup-1"),
      startupOpportunity: {
        opportunityType: "startup-opportunity" as const,
        payingCustomerSegment: "Independent claims operators",
        trigger: "A duplicate claim is found",
        existingSubstitute: "Manual shared-state check",
        gapAssessment: { kind: "hypothesis" as const, description: "Operators may skip the check", evidenceIds: [] },
        smallestSellableWorkflow: "Block one duplicate filing",
        firstCustomerRoute: "Claims operator communities",
        disconfirmingDemandTest: "Ten operators decline a paid manual pilot",
      },
    };
    client.immediateTransaction(() => repository.saveSolutionOptions("run-v2", "problem-1", [candidate]));
    const rows = client.db.prepare("SELECT id, startup_opportunity_json FROM solutions ORDER BY id").all() as Array<{ id: string; startup_opportunity_json: string | null }>;
    expect(rows.map((row) => ({ id: row.id, startupOpportunity: JSON.parse(String(row.startup_opportunity_json)) })))
      .toEqual([{ id: "startup-1", startupOpportunity: candidate.startupOpportunity }]);
    expect(client.immediateTransaction(() => repository.saveSolutionOptions("run-v2", "problem-1", [candidate])).created).toBe(false);
    client.close();
  });

  test("rejects semantically invalid solution and decision checkpoints", () => {
    const client = database();
    const repository = new WorkflowV2Repository(client);
    expect(() => client.immediateTransaction(() => repository.saveStageResult(stageResult({
      options: Array.from({ length: 21 }, () => solutionOption()),
    })))).toThrow("more than 20 options");

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

  test("persists a separate evidence reassessment and permits retry only after failure", () => {
    const client = database();
    const followUps = new EvidenceFollowUpRepository(client);
    const analysis = decisionAnalysis();
    client.immediateTransaction(() => {
      const workflow = new WorkflowV2Repository(client);
      workflow.saveSolutionOptions("run-v2", "problem-1", [solution("solution-1")]);
      workflow.selectSolution("run-v2", "solution-1");
      const checkpoint = workflow.saveStageResult(decisionStageResult("solution-1", analysis));
      workflow.saveDecisionAnalysis({ researchRunId: "run-v2", solutionId: "solution-1", stageResultId: checkpoint.id, analysis });
      client.db.prepare("UPDATE research_runs SET status = 'completed' WHERE id = 'run-v2'").run();
      followUps.request("run-v2", "solution-1", "Does evidence change the risk?");
      followUps.markRunning("run-v2");
      followUps.complete("run-v2", [], []);
      followUps.beginReassessment("run-v2");
      followUps.failReassessment("run-v2", "Provider unavailable");
      followUps.beginReassessment("run-v2");
      followUps.completeReassessment({
        researchRunId: "run-v2",
        riskReassessment: { affectedRisks: [], newRisks: [], additionalUnknowns: ["No firsthand account found"] },
        analysis,
        riskGenerationId: "risk-generation",
        analysisGenerationId: "analysis-generation",
      });
    });
    expect(followUps.find("run-v2")).toEqual(expect.objectContaining({
      reassessmentStatus: "completed",
      reassessmentAnalysis: analysis,
      riskReassessment: { affectedRisks: [], newRisks: [], additionalUnknowns: ["No firsthand account found"] },
    }));
    expect(() => client.immediateTransaction(() => followUps.beginReassessment("run-v2")))
      .toThrow("cannot overlap or replace");
    const original = client.db.prepare("SELECT analysis_json FROM decision_analyses WHERE research_run_id = 'run-v2'")
      .get() as { analysis_json: string };
    expect(JSON.parse(original.analysis_json)).toEqual(analysis);
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

async function withDiscoveryFixture(
  run: (fixture: { execution: WorkflowExecution; source: HarvestedSource }) => Promise<void>,
): Promise<void> {
  configurePromptPaths({ bundledDir: join(process.cwd(), "prompts"), overrideDir: null });
  const client = database();
  const source: HarvestedSource = {
    id: "support", providerSourceId: "support", canonicalUrl: "https://support.test/page", url: "https://support.test/page",
    title: "Support", retrievedText: "Operators repeat filing.", author: null, publishedAt: null,
    contentHash: "support", retrievedAt: "2026-01-01T00:00:00.000Z",
  };
  try {
    await run({ execution: new WorkflowExecution(client, "run-v2"), source });
  } finally {
    client.close();
  }
}

function discoveryFactor(source: HarvestedSource, id = "factor", modelConfidence = 0.9): HarvestedFactor {
  const factor = {
    id, subject: "Operators", behavior: "repeat filing", quote: source.retrievedText,
    sourceId: source.id, harvestMode: "domain", modelConfidence, source,
  };
  // Keep the fixture's checkpoint context fully JSON-shaped when optional evidence
  // classification is absent from an older saved stage output.
  return Object.assign(factor, {
    uncertainty: null,
    sourceRole: "unknown",
    audienceFit: "unknown",
    independentSourceKey: null,
    supportsDemand: false,
    demandEvidenceUncertainty: "Not classified in the saved output.",
  }) as HarvestedFactor;
}

function discoveryModelClient(
  completion: (request: StructuredStageRequest<unknown>) => unknown | Promise<unknown>,
): StructuredModelClient {
  return {
    async structuredCompletion<T>(request: StructuredStageRequest<T>) {
      const output = await completion(request as StructuredStageRequest<unknown>);
      return {
        output: request.schema.parse(output),
        metadata: {
          model: request.model,
          usage: { status: "unknown" },
          latencyMs: 1,
          repairCount: 0,
          providerRequestIds: [],
          attempts: [],
          prompt: { id: "scraply.stage-worker.v1", sha256: createHash("sha256").update("fixture-runtime-prompt").digest("hex") },
        },
      };
    },
  };
}

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
    ) VALUES ('run-v2', 'thread-1', 'running', ?, 2, 'problem-1', ?, ?)
  `).run(JSON.stringify(DEFAULT_RUN_CONFIG), now, now);
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

function prompt(stageId: "solutions" | "decision-analysis" | "risk-evaluation") {
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
      inconclusiveCriterion: "The export cannot be obtained",
    },
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
