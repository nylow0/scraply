import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { DatabaseClient } from "../../src/db/client";
import { ResearchRunRepository } from "../../src/db/repositories/research-runs";
import { GenerationAttemptRepository } from "../../src/db/repositories/generation-attempts";
import { ThreadRepository } from "../../src/db/repositories/threads";
import { PreviewWorkflowResultSchema, WorkflowAdmissionReceiptSchema, WorkflowDetailSchema } from "../../src/shared/workflow-contracts";
import { FOCUSED_EXPERIMENT_DRAFT_INSTRUCTION, FOCUSED_EXPERIMENT_REVIEW_INSTRUCTION } from "../../src/core/experiment-review";
import { WorkspaceStateSchema, SolutionViewSchema, type WorkspaceState, type ResearchEvent } from "../../src/shared/ipc";
import { GenerationStartPayloadSchema } from "../../src/shared/runtime-protocol";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";
import type { JsonSchema } from "../../src/shared/json-schema";
import { NATIVE_WORKFLOW_MODEL as model, UNTRUSTED_WORKFLOW_TEXT as untrusted, startNativeWorkflowBackend } from "../fixtures/native-workflow-backend";
import { resolveWorkflowV2Prompt } from "../../src/core/prompts";
import { WORKFLOW_V2_STAGE_IDS } from "../../src/core/stages";
import { WorkflowRepository } from "../../src/db/repositories/workflows";
import { getRunTrace } from "../../src/core/run-trace";
import { RunTraceSchema, RunTraceStepDetailSchema } from "../../src/shared/run-trace";
import { WorkflowV2Repository } from "../../src/db/repositories/workflow-v2";

const statement = "Repair shops cannot reliably predict parts arrival times.";
const scope = {
  title: "Native workflow fixture", audience: "Repair shops", domain: "Parts delivery",
  observations: untrusted, offLimits: ["Holding inventory"],
};
const fixtures: Array<{ directory: string; close(): Promise<void> }> = [];

afterEach(async () => {
  for (const item of fixtures.splice(0)) {
    await item.close();
    try { rmSync(item.directory, { recursive: true, force: true }); }
    catch { /* Bun can retain the SQLite WAL handle until the test process exits on Windows. */ }
  }
});

describe("native research workflow through the production backend", () => {
  test("traces native saved steps, query results, arithmetic and older unassessed candidates without writes", async () => {
    const item = await fixture({ workflowVersion: 2 });
    const threadId = await item.createThread("explore-market");
    await item.post("/research/start", { threadId }, z.object({ runId: z.string() }));
    const workspace = await item.waitFor(state => state.threads.find(thread => thread.id === threadId)?.status === "problems-ready");
    const runId = workspace.latestResearchRun!.runId;
    const trace = await item.post(`/runs/${runId}/trace`, undefined, RunTraceSchema);
    expect(trace.live).toBe(false);
    expect(trace.steps.filter(step => step.kind === "model").map(step => step.stage.split(":")[0])).toEqual([
      "query-plan", "factor-harvest", "query-plan", "problem-candidates", "problem-kill",
    ]);
    expect(trace.metrics.modelCalls).toBe(item.requests().length);
    expect(trace.metrics.searches).toBe(item.searches.length);
    expect(trace.metrics.candidateFunnel).toMatchObject({ total: 1, assessed: 1, confirmed: 0, dropped: 1, notAssessed: 0 });
    expect(trace.metrics.confirmationRate).toBe(0);
    expect(Object.values(trace.metrics.evidenceMix).reduce((sum, count) => sum + count, 0)).toBe(trace.metrics.factors);
    expect(Object.values(trace.metrics.sourceMix).reduce((sum, count) => sum + count, 0)).toBe(trace.metrics.totalSources);
    expect(trace.steps.some(step => step.attempts.some(attempt => attempt.inputTokens === null))).toBe(true);
    const plan = trace.steps.find(step => step.stage.startsWith("query-plan"))!;
    const detail = await item.post(`/runs/${runId}/trace/steps/${encodeURIComponent(plan.id)}`, undefined, RunTraceStepDetailSchema);
    expect(detail.searches.length).toBeGreaterThan(0);
    expect(detail.searches.every(search => search.status === "completed" && search.results.every(source => source.sourceId && source.factsKept > 0))).toBe(true);
    const kill = trace.steps.find(step => step.stage.startsWith("problem-kill"))!;
    const killDetail = await item.post(`/runs/${runId}/trace/steps/${encodeURIComponent(kill.id)}`, undefined, RunTraceStepDetailSchema);
    expect(killDetail.searches).toHaveLength(1);
    expect(killDetail.candidates[0]?.state).toBe("dropped");
    const db = new DatabaseClient(item.dbPath);
    try {
      const changed = db.db.prepare("SELECT total_changes() AS count").get();
      expect(getRunTrace(db, runId).metrics).toEqual(trace.metrics);
      expect(db.db.prepare("SELECT total_changes() AS count").get()).toEqual(changed);
      // Pre-trace runs did not save query snapshots; links still reconstruct from the unchanged key.
      db.db.prepare("DELETE FROM workflow_snapshots WHERE research_run_id = ? AND snapshot_key LIKE 'search-query:%'").run(runId);
      const olderTrace = getRunTrace(db, runId);
      expect(olderTrace.steps.filter(step => step.kind === "search" && step.search?.query === "Query not recorded in this older run")
        .map(step => trace.steps.find(original => original.id === step.id)?.search)).toEqual([]);
      const repository = new WorkflowV2Repository(db);
      const saved = repository.findStageResult(runId, "problem-candidates")!;
      const { id: _stageId, ...checkpoint } = saved;
      void _stageId;
      const original = saved.output as { problems: Array<Record<string, unknown>> };
      const newRun = new ResearchRunRepository(db).create(threadId, { ...DEFAULT_RUN_CONFIG, workflowVersion: 2 }).runId;
      db.immediateTransaction(() => repository.saveStageResult({ ...checkpoint,
        researchRunId: newRun, output: { problems: [...original.problems, { ...original.problems[0], statement: "Another saved candidate beyond the old limit." }] },
      }));
      const archive = getRunTrace(db, newRun);
      expect(archive.metrics.candidateFunnel).toMatchObject({ total: 2, assessed: 0, notAssessed: 2 });
      expect(archive.candidates.every(candidate => candidate.derived && candidate.reason.includes("No saved verdict"))).toBe(true);
    } finally { db.close(); }
  }, 20_000);

  test("re-evaluates a completed blank-audience archive and finishes five reviewed ideas without replaying research", async () => {
    const item = await fixture({ mode: "workflow-audience-many", legacyAudienceCheckpoint: true });
    const threadId = await item.createThread("explore-market", 5);
    const broadScope = { ...scope, audience: "", riskEvaluationCriteria: "Two students can test it within one month." };
    const preview = await item.post("/workflows/preview", { type: "launch", threadId, draft: {
      contractVersion: 1, purpose: "discovery", mode: "vibe", brief: scope.domain, scope: broadScope,
      runConfig: { ...DEFAULT_RUN_CONFIG, model, reasoningEffort: "xhigh", discoveryDepth: "quick", searchProvider: "exa" },
      targets: { kind: "per-problem", ideaCount: 5, automaticProblemCap: 3 },
      ideas: { model, reasoningEffort: "xhigh", reviewModel: model, reviewReasoningEffort: "xhigh" },
      limits: { enforced: false, maxMinutes: 49, maxModelCalls: 62, maxSearches: 26 }, instructions: {},
    } }, PreviewWorkflowResultSchema);
    const receipt = await item.post("/workflows/start", { threadId, clientCommandId: "broad-discovery",
      contract: preview.proposal, previewHash: preview.previewHash, capabilityFingerprint: preview.capabilityFingerprint,
      previewExpiresAt: preview.expiresAt }, WorkflowAdmissionReceiptSchema);
    const original = await item.waitFor(state => state.activeWorkflow?.outcome === "no-qualifying-ideas");
    const runId = original.latestResearchRun!.runId;
    const detail = await item.post(`/workflows/${receipt.sessionId}`, undefined, WorkflowDetailSchema);
    const task = detail.tasks.find(task => task.kind === "discovery")!;
    expect(task.canReassessProblems).toBe(true);
    const requestsBefore = item.requests().length;
    const searchesBefore = item.searches.length;
    const saved = new DatabaseClient(item.dbPath);
    try {
      const contract = saved.db.prepare("SELECT contract_json, contract_sha256 FROM workflow_sessions WHERE id = ?").get(receipt.sessionId);
      const factors = saved.db.prepare("SELECT * FROM factors WHERE research_run_id = ? ORDER BY id").all(runId);
      const budget = saved.db.prepare("SELECT * FROM workflow_budget_entries WHERE session_id = ? ORDER BY id").all(receipt.sessionId) as Array<{ id: string }>;
      const stages = saved.db.prepare("SELECT * FROM stage_results WHERE research_run_id = ? ORDER BY id").all(runId) as Array<{ id: string }>;
      const command = { threadId, sessionId: receipt.sessionId, clientCommandId: "reassess-broad",
        expectedRevision: detail.summary.revision, action: { type: "reassess-problems", taskId: task.id } };
      const resumed = await item.post("/workflows/command", command, WorkflowAdmissionReceiptSchema);
      expect(resumed.sessionId).toBe(receipt.sessionId);
      const completed = await item.waitFor(state => state.activeWorkflow?.outcome === "target-met");
      expect(completed.solutions).toHaveLength(5);
      expect(completed.activeWorkflow?.counts.accepted).toBe(5);
      const completedTrace = getRunTrace(saved, completed.latestResearchRun!.runId);
      expect(completedTrace.metrics).toMatchObject({ ideas: 5, acceptedIdeas: 5 });
      expect(completedTrace.metrics.candidateFunnel).toMatchObject({ total: 1, confirmed: 1 });
      expect(completedTrace.steps.some(step => step.stage === "solutions")).toBe(true);
      expect(completedTrace.steps.some(step => step.stage === "solution-set-review")).toBe(true);
      expect(item.searches).toHaveLength(searchesBefore);
      const fresh = item.requests().slice(requestsBefore);
      expect(fresh.filter(request => /^(query-plan|factor-harvest|problem-candidates)/.test(request.workOrder.stage))).toEqual([]);
      const review = fresh.find(request => request.workOrder.stage.endsWith(":audience-v1"))!;
      expect(review.workOrder.instruction).toContain("blank audience alone is not a missing brief fit");
      expect((review.outputSchema as JsonSchema).properties?.factorAssessments).toBeDefined();
      expect(fresh.some(request => request.workOrder.stage === "solution-set-review")).toBe(true);
      expect(completed.problemCandidates[0]?.factors.every(factor => factor.audienceFit === "intended-buyer")).toBe(true);
      expect(fresh.every(request => request.reasoningEffort === "xhigh" && request.model.modelId === model.modelId)).toBe(true);
      expect(saved.db.prepare("SELECT contract_json, contract_sha256 FROM workflow_sessions WHERE id = ?").get(receipt.sessionId)).toEqual(contract);
      expect(saved.db.prepare("SELECT * FROM factors WHERE research_run_id = ? ORDER BY id").all(runId)).toEqual(factors);
      for (const stage of stages) expect(saved.db.prepare("SELECT * FROM stage_results WHERE id = ?").get(stage.id)).toEqual(stage);
      for (const entry of budget) expect(saved.db.prepare("SELECT * FROM workflow_budget_entries WHERE id = ?").get(entry.id)).toEqual(entry);
      const spent = saved.db.prepare(`SELECT SUM(settled_units) AS units FROM workflow_budget_entries
        WHERE work_item_id = ? AND kind = 'model-call' AND state = 'spent'`).get(task.id) as { units: number };
      expect(spent.units).toBe(new WorkflowRepository(saved).countProviderAttempts(runId));
      expect(saved.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect((await item.post("/workflows/command", command, WorkflowAdmissionReceiptSchema)).sessionId).toBe(receipt.sessionId);
      const requestCount = item.requests().length;
      await item.restart();
      expect((await item.workspace()).solutions).toEqual(completed.solutions);
      expect(item.requests()).toHaveLength(requestCount);
    } finally { saved.close(); }
  }, 20_000);

  test("explicit output-limit retry preserves the guided contract, searches, and completed packets", async () => {
    const item = await fixture({ mode: "workflow-checkpoint-recovery-output-limit" });
    const threadId = await item.createThread("explore-market");
    const preview = await item.post("/workflows/preview", { type: "launch", threadId, draft: {
      contractVersion: 1, purpose: "discovery", mode: "babysit", brief: scope.domain, scope,
      runConfig: { ...DEFAULT_RUN_CONFIG, model, reasoningEffort: "xhigh", discoveryDepth: "deep", searchProvider: "exa" },
      targets: { kind: "per-problem", ideaCount: 3 },
      limits: { enforced: false, maxMinutes: 90, maxModelCalls: 62, maxSearches: 26 }, instructions: {},
    } }, PreviewWorkflowResultSchema);
    const receipt = await item.post("/workflows/start", { threadId, clientCommandId: "output-limit-research",
      contract: preview.proposal, previewHash: preview.previewHash, capabilityFingerprint: preview.capabilityFingerprint,
      previewExpiresAt: preview.expiresAt }, WorkflowAdmissionReceiptSchema);
    await item.waitFor(workspace => workspace.activeWorkflow?.state === "finished");
    const failed = await item.post(`/workflows/${receipt.sessionId}`, undefined, WorkflowDetailSchema);
    const task = failed.tasks.find(task => task.kind === "discovery")!;
    expect(task.state).toBe("failed");
    expect(item.requests()).toHaveLength(10);
    const harvestSchema = item.requests()[1]!.outputSchema as JsonSchema;
    expect(harvestSchema.properties?.factors?.items?.anyOf).toHaveLength(2);
    for (const variant of harvestSchema.properties?.factors?.items?.anyOf ?? []) {
      expect(variant.properties?.uncertainty?.maxLength).toBe(600);
    }
    expect(item.searches).toHaveLength(9);
    const originalSearches = item.searches.map(search => z.object({ query: z.string() }).parse(search).query);
    const originalRunId = (await item.workspace()).latestResearchRun!.runId;
    const db = new DatabaseClient(item.dbPath);
    try {
      const originalContract = db.db.prepare("SELECT contract_sha256 FROM workflow_sessions WHERE id = ?").get(receipt.sessionId);
      const failedAttempt = db.db.prepare("SELECT * FROM generation_attempts WHERE id = ?").get(task.terminalAttemptId!);
      const savedStages = item.requests().slice(0, 9).map(request => request.workOrder.stage);
      const retry = { threadId, sessionId: receipt.sessionId, clientCommandId: "retry-output-limit",
        expectedRevision: failed.summary.revision, action: { type: "retry-task", taskId: task.id,
          expectedTerminalAttemptId: task.terminalAttemptId, acknowledgeUnknownCompletion: false } };
      const retried = await item.post("/workflows/command", retry, WorkflowAdmissionReceiptSchema);
      expect(retried.sessionId).toBe(receipt.sessionId);
      await item.waitFor(workspace => workspace.activeWorkflow?.state === "waiting-for-review");
      const recoveredSearches = item.searches.map(search => z.object({ query: z.string() }).parse(search).query);
      for (const query of originalSearches) expect(recoveredSearches.filter(saved => saved === query)).toHaveLength(1);
      expect(item.requests().slice(10).some(request => savedStages.includes(request.workOrder.stage))).toBe(false);
      expect(item.requests()[10]!.workOrder.stage).toBe(item.requests()[9]!.workOrder.stage);
      expect(item.requests().every(request => request.model.modelId === model.modelId && request.reasoningEffort === "xhigh")).toBe(true);
      expect(db.db.prepare("SELECT contract_sha256 FROM workflow_sessions WHERE id = ?").get(receipt.sessionId)).toEqual(originalContract);
      expect(db.db.prepare("SELECT * FROM generation_attempts WHERE id = ?").get(task.terminalAttemptId!)).toEqual(failedAttempt);
      expect(db.db.prepare("SELECT json_extract(output_refs_json, '$.runId') AS runId FROM workflow_work_items WHERE id = ?")
        .get(task.id)).toEqual({ runId: originalRunId });
    } finally { db.close(); }
  }, 20_000);

  test("acknowledged discovery recovery reuses eight harvests and nine searches without replaying confirmed work", async () => {
    const item = await fixture({ mode: "workflow-checkpoint-recovery" });
    const threadId = await item.createThread("explore-market");
    const preview = await item.post("/workflows/preview", { type: "launch", threadId, draft: {
      contractVersion: 1, purpose: "discovery", mode: "babysit", brief: scope.domain, scope,
      runConfig: { ...DEFAULT_RUN_CONFIG, model, reasoningEffort: "xhigh", discoveryDepth: "deep", searchProvider: "exa" },
      targets: { kind: "per-problem", ideaCount: 3 },
      limits: { enforced: false, maxMinutes: 90, maxModelCalls: 62, maxSearches: 26 }, instructions: {},
    } }, PreviewWorkflowResultSchema);
    const receipt = await item.post("/workflows/start", { threadId, clientCommandId: "checkpoint-research",
      contract: preview.proposal, previewHash: preview.previewHash, capabilityFingerprint: preview.capabilityFingerprint,
      previewExpiresAt: preview.expiresAt }, WorkflowAdmissionReceiptSchema);
    await item.waitFor(workspace => workspace.activeWorkflow?.state === "finished");
    const first = await item.post(`/workflows/${receipt.sessionId}`, undefined, WorkflowDetailSchema);
    expect(first.summary.outcome).toBe("needs-attention");
    expect(item.requests()).toHaveLength(10);
    expect(item.searches).toHaveLength(9);
    const runId = (await item.workspace()).latestResearchRun!.runId;
    const db = new DatabaseClient(item.dbPath);
    const confirmedStageKeys = item.requests().slice(0, 9).map(request => request.workOrder.stage);
    const originalUnknown = db.db.prepare("SELECT * FROM generation_attempts WHERE status = 'interrupted'").get();
    const originalLedger = db.db.prepare("SELECT * FROM cost_ledger ORDER BY created_at,id").all();
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM stage_results WHERE stage_id = 'factor-harvest'").get()).toEqual({ count: 8 });
    expect(new GenerationAttemptRepository(db).getResumeSafety(runId).canResume).toBe(false);
    expect((await item.raw("/research/resume", { runId })).ok).toBe(false);
    const task = first.tasks.find(task => task.kind === "discovery")!;
    const retry = { threadId, sessionId: receipt.sessionId, clientCommandId: "checkpoint-first-retry",
      expectedRevision: first.summary.revision, action: { type: "retry-task", taskId: task.id,
        expectedTerminalAttemptId: task.terminalAttemptId, acknowledgeUnknownCompletion: false } };
    expect((await item.raw("/workflows/command", retry)).ok).toBe(false);
    const firstRetry = await item.post("/workflows/command", { ...retry, action: { ...retry.action, acknowledgeUnknownCompletion: true } }, WorkflowAdmissionReceiptSchema);
    expect(firstRetry.sessionId).toBe(receipt.sessionId);
    await item.waitFor(workspace => workspace.activeWorkflow?.state === "finished");
    const second = await item.post(`/workflows/${receipt.sessionId}`, undefined, WorkflowDetailSchema);
    expect(second.summary.outcome).toBe("needs-attention");
    expect(second.summary.budget.modelCalls.spent).toBe(11);
    expect(second.summary.budget.searches.spent).toBe(9);
    expect(item.requests()).toHaveLength(11);
    expect(item.searches).toHaveLength(9);
    expect(item.requests()[10]!.workOrder.stage).toBe(item.requests()[9]!.workOrder.stage);
    expect(db.db.prepare("SELECT * FROM generation_attempts WHERE id = ?").get(task.terminalAttemptId!)).toEqual(originalUnknown);
    expect((await item.raw("/research/resume", { runId })).ok).toBe(false);
    const nextTask = second.tasks.find(task => task.kind === "discovery")!;
    const nextRetry = { ...retry, clientCommandId: "checkpoint-second-retry", expectedRevision: second.summary.revision,
      action: { ...retry.action, expectedTerminalAttemptId: nextTask.terminalAttemptId } };
    expect((await item.raw("/workflows/command", nextRetry)).ok).toBe(false);
    expect((await item.raw("/workflows/command", { ...nextRetry, action: { ...nextRetry.action,
      expectedTerminalAttemptId: task.terminalAttemptId, acknowledgeUnknownCompletion: true } })).ok).toBe(false);
    // Reproduce older startup recovery: the unknown task was settled but its run stayed active.
    db.db.prepare("UPDATE research_runs SET status = 'running', interrupted = 1 WHERE id = ?").run(runId);
    await item.restart("workflow-checkpoint-recovery-complete");
    expect(db.db.prepare("SELECT status, interrupted FROM research_runs WHERE id = ?").get(runId))
      .toEqual({ status: "failed", interrupted: 1 });
    expect((await item.raw("/research/resume", { runId })).ok).toBe(false);
    await item.post("/workflows/command", { ...nextRetry, action: { ...nextRetry.action, acknowledgeUnknownCompletion: true } }, WorkflowAdmissionReceiptSchema);
    const completed = await item.waitFor(workspace => workspace.activeWorkflow?.state === "waiting-for-review");
    expect(db.db.prepare("SELECT json_extract(output_refs_json, '$.runId') AS runId FROM workflow_work_items WHERE id = ?")
      .get(task.id)).toEqual({ runId });
    expect(completed.activeWorkflow?.sessionId).toBe(receipt.sessionId);
    expect(item.requests().slice(9).some(request => confirmedStageKeys.includes(request.workOrder.stage))).toBe(false);
    expect(item.requests()[11]!.workOrder.stage).toBe(item.requests()[9]!.workOrder.stage);
    const final = await item.post(`/workflows/${receipt.sessionId}`, undefined, WorkflowDetailSchema);
    expect(final.summary.budget.modelCalls.spent).toBe(item.requests().length);
    expect(final.summary.budget.searches.spent).toBe(item.searches.length);
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM generation_attempts WHERE status = 'interrupted'").get()).toEqual({ count: 2 });
    expect(db.db.prepare("SELECT * FROM generation_attempts WHERE id = ?").get(task.terminalAttemptId!)).toEqual(originalUnknown);
    const allLedger = db.db.prepare("SELECT * FROM cost_ledger ORDER BY created_at,id").all();
    expect(allLedger.slice(0, originalLedger.length)).toEqual(originalLedger);
    expect(new GenerationAttemptRepository(db).getResumeSafety(runId).canResume).toBe(true);
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM workflow_snapshots WHERE snapshot_key LIKE 'acknowledged-retry:%'").get()).toEqual({ count: 2 });
    db.close();
  }, 20_000);

  test("a lost OpenAI stream requires acknowledgement before a retry can complete research", async () => {
    const item = await fixture({ mode: "workflow-stream-interrupted-twice" });
    const threadId = await item.createThread("explore-market");
    const preview = await item.post("/workflows/preview", { type: "launch", threadId, draft: {
      contractVersion: 1, purpose: "discovery", mode: "babysit", brief: scope.domain, scope,
      runConfig: { ...DEFAULT_RUN_CONFIG, model, reasoningEffort: "medium", discoveryDepth: "quick", searchProvider: "exa" },
      targets: { kind: "per-problem", ideaCount: 3 },
      limits: { enforced: false, maxMinutes: 5, maxModelCalls: 1, maxSearches: 0 }, instructions: {},
    } }, PreviewWorkflowResultSchema);
    const receipt = await item.post("/workflows/start", {
      threadId, clientCommandId: "interrupted-discovery", contract: preview.proposal,
      previewHash: preview.previewHash, capabilityFingerprint: preview.capabilityFingerprint, previewExpiresAt: preview.expiresAt,
    }, WorkflowAdmissionReceiptSchema);
    await item.waitFor(workspace => workspace.activeWorkflow?.state === "finished");
    const interrupted = await item.post(`/workflows/${receipt.sessionId}`, undefined, WorkflowDetailSchema);
    expect(interrupted.summary.outcome).toBe("needs-attention");
    expect(interrupted.summary.stopReason).toContain("before confirming completion");
    expect(interrupted.summary.budget.modelCalls.spent).toBe(2);
    expect(interrupted.summary.budget.searches.spent).toBe(item.searches.length);
    const task = interrupted.tasks.find(task => task.kind === "discovery")!;
    expect(task.state).toBe("unknown");
    expect(item.requests()).toHaveLength(2);
    // Simulate the previous build's stored classification without losing native attempt metadata.
    const legacy = new DatabaseClient(item.dbPath);
    legacy.db.prepare("UPDATE generation_attempts SET status = 'failed', error_code = 'unavailable' WHERE id = ?").run(task.terminalAttemptId!);
    legacy.db.prepare("UPDATE workflow_work_items SET state = 'failed' WHERE id = ?").run(task.id);
    legacy.close();
    expect((await item.post(`/workflows/${receipt.sessionId}`, undefined, WorkflowDetailSchema)).tasks.find(saved => saved.id === task.id)?.state).toBe("unknown");
    const retry = { threadId, sessionId: receipt.sessionId, clientCommandId: "retry-interrupted-discovery",
      expectedRevision: interrupted.summary.revision, action: { type: "retry-task", taskId: task.id,
        expectedTerminalAttemptId: task.terminalAttemptId, acknowledgeUnknownCompletion: false } };
    const rejected = await item.raw("/workflows/command", retry);
    expect(rejected.ok).toBe(false);
    expect(item.requests()).toHaveLength(2);
    const firstRetry = await item.post("/workflows/command", { ...retry, action: { ...retry.action, acknowledgeUnknownCompletion: true } }, WorkflowAdmissionReceiptSchema);
    await item.waitFor(workspace => workspace.activeWorkflow?.sessionId === firstRetry.sessionId && workspace.activeWorkflow.state === "finished");
    const interruptedAgain = await item.post(`/workflows/${firstRetry.sessionId}`, undefined, WorkflowDetailSchema);
    const failedRetryTask = interruptedAgain.tasks.find(task => task.kind === "discovery")!;
    const retryAgain = { threadId, sessionId: firstRetry.sessionId, clientCommandId: "retry-second-interruption",
      expectedRevision: interruptedAgain.summary.revision, action: { type: "retry-task", taskId: failedRetryTask.id,
        expectedTerminalAttemptId: failedRetryTask.terminalAttemptId, acknowledgeUnknownCompletion: false } };
    expect((await item.raw("/workflows/command", retryAgain)).ok).toBe(false);
    expect(item.requests()).toHaveLength(3);
    const secondRetry = await item.post("/workflows/command", { ...retryAgain, action: { ...retryAgain.action, acknowledgeUnknownCompletion: true } }, WorkflowAdmissionReceiptSchema);
    expect(secondRetry.sessionId).toBe(firstRetry.sessionId);
    expect((await item.raw("/workflows/command", { ...retryAgain, clientCommandId: "duplicate-retry", action: { ...retryAgain.action, acknowledgeUnknownCompletion: true } })).ok).toBe(false);
    const recovered = await item.waitFor(workspace => workspace.activeWorkflow?.state === "waiting-for-review");
    expect(recovered.problemCandidates).toHaveLength(1);
    expect(recovered.activeWorkflow?.sessionId).toBe(receipt.sessionId);
    const original = await item.post(`/workflows/${receipt.sessionId}`, undefined, WorkflowDetailSchema);
    expect(original.summary.state).toBe("waiting-for-review");
    const history = new DatabaseClient(item.dbPath);
    expect(history.db.prepare("SELECT COUNT(*) AS count FROM generation_attempts WHERE status IN ('interrupted','failed')").get()).toEqual({ count: 2 });
    history.close();
  }, 15_000);

  test("depth-guided discovery completes beyond its call and search estimates", async () => {
    const item = await fixture();
    const threadId = await item.createThread("explore-market");
    const preview = await item.post("/workflows/preview", { type: "launch", threadId, draft: {
      contractVersion: 1, purpose: "discovery", mode: "babysit", brief: scope.domain, scope,
      runConfig: { ...DEFAULT_RUN_CONFIG, model, reasoningEffort: "medium", discoveryDepth: "quick", searchProvider: "exa" },
      targets: { kind: "per-problem", ideaCount: 3 },
      limits: { enforced: false, maxMinutes: 5, maxModelCalls: 1, maxSearches: 0 }, instructions: {},
    } }, PreviewWorkflowResultSchema);
    expect(preview.fieldErrors).toEqual([]);
    const receipt = await item.post("/workflows/start", {
      threadId, clientCommandId: "guided-discovery", contract: preview.proposal,
      previewHash: preview.previewHash, capabilityFingerprint: preview.capabilityFingerprint,
      previewExpiresAt: preview.expiresAt,
    }, WorkflowAdmissionReceiptSchema);
    const state = await item.waitFor((workspace) => workspace.activeWorkflow?.state === "waiting-for-review");
    expect(state.activeWorkflow?.sessionId).toBe(receipt.sessionId);
    expect(state.activeWorkflow?.limits.enforced).toBe(false);
    expect(state.problemCandidates).toHaveLength(1);
    expect(item.requests().length).toBeGreaterThan(1);
    expect(item.searches.length).toBeGreaterThan(0);
    expect(item.requests().every((request) => request.deadlineMs === undefined)).toBe(true);
    const progress = await item.post(`/workflows/${receipt.sessionId}`, undefined, WorkflowDetailSchema);
    expect(progress.summary.ideaTargetReady).toBe(false);
    expect(progress.summary.counts.requested).toBe(progress.summary.selectedProblemIds.length * 3);
    expect(progress.activity?.length).toBeGreaterThan(0);
    expect(progress.activity?.some(event => event.message.includes("problem"))).toBe(true);
    expect(progress.activity?.map(event => event.message)).toEqual(
      item.events.filter(event => event.type === "run-progress").slice(-16).map(event => event.message),
    );
    await item.restart();
    expect((await item.workspace()).activeWorkflow?.state).toBe("waiting-for-review");
    const restored = await item.post(`/workflows/${receipt.sessionId}`, undefined, WorkflowDetailSchema);
    expect(restored.activity).toEqual(progress.activity);
  }, 15_000);

  test.each([
    { freshUnknown: false, rejectResume: false },
    { freshUnknown: true, rejectResume: false },
    { freshUnknown: false, rejectResume: true },
  ])("restart preserves acknowledged checkpoints, blocks unknown work, and settles rejected resumes", async ({ freshUnknown, rejectResume }) => {
    const item = await fixture();
    const threadId = await item.createThread("explore-market");
    const preview = await item.post("/workflows/preview", { type: "launch", threadId, draft: {
      contractVersion: 1, purpose: "discovery", mode: "babysit", brief: scope.domain, scope,
      runConfig: { ...DEFAULT_RUN_CONFIG, model, reasoningEffort: "medium", discoveryDepth: "quick", searchProvider: "exa" },
      targets: { kind: "per-problem", ideaCount: 3 },
      limits: { enforced: false, maxMinutes: 30, maxModelCalls: 30, maxSearches: 10 }, instructions: {},
    } }, PreviewWorkflowResultSchema);
    const receipt = await item.post("/workflows/start", { threadId, clientCommandId: "restart-checkpoints",
      contract: preview.proposal, previewHash: preview.previewHash, capabilityFingerprint: preview.capabilityFingerprint,
      previewExpiresAt: preview.expiresAt }, WorkflowAdmissionReceiptSchema);
    await item.waitFor(workspace => workspace.activeWorkflow?.state === "waiting-for-review");
    const detail = await item.post(`/workflows/${receipt.sessionId}`, undefined, WorkflowDetailSchema);
    const task = detail.tasks.find(task => task.kind === "discovery")!;
    const requestCount = item.requests().length;
    const searchCount = item.searches.length;
    const db = new DatabaseClient(item.dbPath);
    try {
      const { runId } = db.db.prepare("SELECT json_extract(output_refs_json, '$.runId') AS runId FROM workflow_work_items WHERE id = ?")
        .get(task.id) as { runId: string };
      const repository = new WorkflowRepository(db);
      const now = new Date().toISOString();
      // Restore a crash between saved checkpoints and terminal handoff, retaining an older acknowledged interruption.
      const insertAttempt = db.db.prepare(`INSERT INTO generation_attempts
        (id, generation_id, research_run_id, stage_key, provider_id, model_id, reasoning_effort, status,
          request_json, wire_request_sha256, request_sha256, work_order_sha256, inputs_sha256, evidence_sha256,
          schema_sha256, terminal_kind, created_at, updated_at)
        VALUES (?, ?, ?, 'factor-harvest:historical', ?, ?, 'medium', 'interrupted', '{}', ?, ?, ?, ?, ?, ?, 'stream-interrupted', ?, ?)`);
      for (const id of ["acknowledged-attempt", ...(freshUnknown ? ["fresh-unknown-attempt"] : [])]) {
        insertAttempt.run(id, `generation-${id}`, runId, model.providerId, model.modelId,
          ...Array<string>(6).fill("0".repeat(64)), now, now);
      }
      db.db.prepare("INSERT INTO workflow_snapshots VALUES (?, ?, ?)").run(runId,
        "acknowledged-retry:before-restart", JSON.stringify({ attemptIds: ["acknowledged-attempt"] }));
      db.immediateTransaction(() => {
        const reservation = repository.reserveBudget({ sessionId: receipt.sessionId, workItemId: task.id,
          operationKey: "historical-unknown", kind: "model-call", reservedUnits: 30 });
        repository.settleBudget(reservation.id, { state: "uncertain", settledUnits: 30 });
      });
      db.db.prepare("UPDATE research_runs SET status = 'running', interrupted = 1 WHERE id = ?").run(runId);
      if (rejectResume) {
        // A saved config can fail rehydration before the engine starts; the UI must receive a terminal error.
        const savedConfig = db.db.prepare("SELECT config_json FROM research_runs WHERE id = ?").get(runId) as { config_json: string };
        db.db.prepare("UPDATE research_runs SET config_json = ? WHERE id = ?")
          .run(JSON.stringify({ ...JSON.parse(savedConfig.config_json) as Record<string, unknown>, workflowVersion: 1 }), runId);
      }
      db.db.prepare("UPDATE workflow_work_items SET state = 'running', output_refs_json = ?, finished_at = NULL WHERE id = ?")
        .run(JSON.stringify({ runId }), task.id);
      db.db.prepare(`UPDATE workflow_sessions SET state = 'running', outcome = NULL, finished_at = NULL,
        active_snapshot_id = NULL, running_since = ?, revision = revision + 1 WHERE id = ?`).run(now, receipt.sessionId);
      const historicalBudget = repository.listBudgetEntries(receipt.sessionId);
      expect(repository.hasUnknownProviderCompletion(runId)).toBe(freshUnknown);
      await item.restart();
      expect(repository.hasUnknownProviderCompletion(runId)).toBe(freshUnknown);
      const restored = await item.post(`/workflows/${receipt.sessionId}`, undefined, WorkflowDetailSchema);
      expect(item.requests()).toHaveLength(requestCount);
      expect(item.searches).toHaveLength(searchCount);
      if (freshUnknown) {
        expect(restored.summary).toMatchObject({ state: "finished", outcome: "needs-attention" });
        expect(restored.summary.canResume).not.toBe(true);
        expect((await item.raw("/workflows/command", { threadId, sessionId: receipt.sessionId,
          clientCommandId: "blocked-restart-resume", expectedRevision: restored.summary.revision,
          action: { type: "resume" } })).ok).toBe(false);
      } else {
        expect(restored.summary.state).toBe("paused");
        expect(restored.summary.canResume).toBe(true);
        expect(restored.summary.budget.modelCalls.uncertain).toBe(30);
        await item.post("/workflows/command", { threadId, sessionId: receipt.sessionId,
          clientCommandId: "acknowledged-restart-resume", expectedRevision: restored.summary.revision,
          action: { type: "resume" } }, WorkflowAdmissionReceiptSchema);
        const recovered = await item.waitFor(workspace => workspace.activeWorkflow?.state === (rejectResume ? "finished" : "waiting-for-review"));
        if (rejectResume) {
          expect(recovered.activeWorkflow?.outcome).toBe("failed");
          const rejected = await item.post(`/workflows/${receipt.sessionId}`, undefined, WorkflowDetailSchema);
          expect(rejected.tasks.find(item => item.id === task.id)?.error).toContain("Legacy generation has been retired");
          expect(db.db.prepare("SELECT status FROM research_runs WHERE id = ?").get(runId)).toEqual({ status: "failed" });
        }
        expect(item.requests()).toHaveLength(requestCount);
        expect(item.searches).toHaveLength(searchCount);
        for (const entry of historicalBudget) expect(repository.listBudgetEntries(receipt.sessionId)).toContainEqual(entry);
      }
      expect(db.db.prepare("SELECT status FROM generation_attempts WHERE id = 'acknowledged-attempt'").get())
        .toEqual({ status: "interrupted" });
      expect(db.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { db.close(); }
  }, 15_000);

  test("generates a title through the runtime and preserves archived research across restart", async () => {
    const item = await fixture({ searchEnabled: false });
    const threadId = await item.createThread("known-problem");
    const title = await item.post("/threads/title", { context: statement, model, reasoningEffort: "low" }, z.object({ title: z.string() }));
    expect(title.title).toBe("Reducing repair shop delays");
    const request = item.requests()[0]!;
    expect(request.model).toEqual(model);
    expect(request.reasoningEffort).toBe("low");
    expect(request.deadlineMs).toBeUndefined();
    expect(request.workOrder.inputs).toEqual({ brief: statement });
    expect((await item.raw("/threads/title", { context: statement, model: { ...model, modelId: "unavailable" }, reasoningEffort: "low" })).status).toBe(409);
    expect(item.requests()).toHaveLength(1);
    const archived = await item.post("/threads/archive", { threadId, archived: true }, WorkspaceStateSchema);
    expect(archived.activeThreadId).toBeNull();
    expect(archived.threads.find((thread) => thread.id === threadId)?.archivedAt).toBeTruthy();
    await item.restart();
    expect((await item.workspace()).threads.find((thread) => thread.id === threadId)?.archivedAt).toBeTruthy();
    await item.post("/threads/archive", { threadId, archived: false }, WorkspaceStateSchema);
    const restored = await item.post("/threads/select", { threadId }, WorkspaceStateSchema);
    expect(restored.scope).toEqual(expect.objectContaining(scope));
    expect(restored.runConfig?.researchMode).toBe("known-problem");
    await item.post("/threads/archive", { threadId, archived: true }, WorkspaceStateSchema);
    const removed = await item.post("/threads/delete", { threadId }, WorkspaceStateSchema);
    expect(removed.threads.some((thread) => thread.id === threadId)).toBe(false);
  });

  test("discarding an idea persists without removing its saved analysis", async () => {
    const item = await fixture({ searchEnabled: false });
    const threadId = await item.createThread("known-problem");
    await item.post("/research/start", { threadId }, z.object({ runId: z.string() }));
    const ready = await item.waitFor((state) => state.threads.find((thread) => thread.id === threadId)?.status === "solutions-ready");
    const ideaId = ready.solutions[0]!.id;
    const dismissed = await item.post("/ideas/discard", { threadId, ideaId, discarded: true }, WorkspaceStateSchema);
    expect(dismissed.solutions.find((idea) => idea.id === ideaId)?.discarded).toBe(true);
    await item.restart();
    expect((await item.workspace()).solutions.find((idea) => idea.id === ideaId)?.discarded).toBe(true);
    expect((await item.post(`/ideas/${ideaId}`, undefined, SolutionViewSchema)).description).toBeTruthy();
    const otherThread = await item.createThread("known-problem");
    expect((await item.raw("/ideas/discard", { threadId: otherThread, ideaId, discarded: false })).status).toBe(404);
    await item.post("/threads/select", { threadId }, WorkspaceStateSchema);
    const restored = await item.post("/ideas/discard", { threadId, ideaId, discarded: false }, WorkspaceStateSchema);
    expect(restored.solutions.find((idea) => idea.id === ideaId)?.discarded).toBe(false);
    expect(restored.solutions).toHaveLength(ready.solutions.length);
  }, 15_000);

  test("fails before provider spend on an empty override, then runs and snapshots a deliberate edit", async () => {
    const item = await fixture({ searchEnabled: false });
    const overridePath = join(item.directory, "prompts", "workflow-v2-solutions.md");
    writeFileSync(overridePath, " \n");
    const brokenThread = await item.createThread("known-problem");
    await item.post("/research/start", { threadId: brokenThread }, z.object({ runId: z.string() }));
    await item.waitFor((state) => state.threads.find((thread) => thread.id === brokenThread)?.status === "failed");
    expect(item.requests()).toHaveLength(0);
    item.assertAccounting(0);

    const instruction = `${readFileSync(join(process.cwd(), "prompts", "workflow-v2-solutions.md"), "utf8").trim()}\n\nExplain the maintenance burden of each mechanism.`;
    writeFileSync(overridePath, instruction);
    const threadId = await item.createThread("known-problem");
    await item.post("/research/start", { threadId }, z.object({ runId: z.string() }));
    await item.waitFor((state) => state.threads.find((thread) => thread.id === threadId)?.status === "solutions-ready");
    expect(item.requests()[0]?.workOrder.instruction).toBe(instruction);
    item.assertAccounting(1);
    await item.restart();
    expect(readFileSync(overridePath, "utf8")).toBe(instruction);
    expect((await item.workspace()).solutions).toHaveLength(2);
    const db = new DatabaseClient(item.dbPath);
    try {
      const row = db.db.prepare("SELECT request_json FROM generation_attempts WHERE stage_key = 'solutions'").get() as { request_json: string };
      expect(z.object({ workOrder: z.object({ instruction: z.string() }) }).parse(JSON.parse(row.request_json)).workOrder.instruction).toBe(instruction);
    } finally { db.close(); }
    expect(item.requests()).toHaveLength(1);
  }, 15_000);

  test("discovers, selects an adverse premise, develops, exports, and reopens without replay", async () => {
    const item = await fixture();
    const threadId = await item.createThread("explore-market", 3, "auto");
    const { runId } = await item.post("/research/start", { threadId }, z.object({ runId: z.string() }));
    const discovered = await item.waitFor((state) => state.threads.find((thread) => thread.id === threadId)?.status === "problems-ready");
    expect(discovered.problemCandidates).toHaveLength(1);
    expect(discovered.problemCandidates[0]?.verdict).toBe("overstated");
    expect(discovered.problemCandidates[0]?.verdictReason).toContain("disagrees");
    expect(discovered.problemCandidates[0]?.factors).toHaveLength(2);
    expect(item.searches).toHaveLength(6);

    await item.post("/research/select-problems", { threadId, problemIds: [discovered.problemCandidates[0]!.id], userProblem: null,
      model, reasoningEffort: "medium", explorationPurpose: "startup-opportunities" }, WorkspaceStateSchema);
    const options = await item.waitFor((state) => state.threads.find((thread) => thread.id === threadId)?.status === "solutions-ready");
    expect(options.solutions).toHaveLength(2);
    const selected = options.solutions[0]!;
    await item.post("/research/select-option", { threadId, runId: selected.runId, solutionId: selected.id }, WorkspaceStateSchema);
    const developed = await item.waitFor((state) => state.latestResearchRun?.status === "completed" && !state.latestResearchRun.awaitingSelection);
    const progress = item.events.filter((event) => event.type === "run-progress")
      .filter((event) => event.runId === developed.latestResearchRun?.runId);
    expect(progress.at(-1)?.usage).toEqual(developed.latestResearchRun?.usage);
    expect(progress.some((event) => (event.usage?.attemptCount ?? 0) > 1)).toBe(true);
    for (const summary of developed.solutions) {
      expect(summary.outcomes).toHaveLength(0);
      const solution = await item.post(`/ideas/${summary.id}`, undefined, SolutionViewSchema);
      expect(solution.outcomes).toHaveLength(0);
      if (solution.selected) {
        expect(solution.riskEvaluation?.risks).toHaveLength(1);
        expect(solution.decisionAnalysis?.proposedResponses[0]?.riskIds).toEqual(["sparse"]);
      }
    }

    const exported = await item.post("/research/export", { threadId }, z.object({ content: z.string() }));
    const research = z.object({
      sources: z.array(z.object({ id: z.string(), text: z.string() })),
      factors: z.array(z.object({ sourceId: z.string(), quote: z.string() })),
      researchRun: z.object({ config: z.object({ model: z.object({ providerId: z.string() }) }) }),
    }).parse(JSON.parse(exported.content));
    for (const factor of research.factors) {
      expect(research.sources.find((source) => source.id === factor.sourceId)?.text).toContain(factor.quote);
    }
    expect(research.researchRun.config.model.providerId).toBe(model.providerId);
    const ideas = await item.post("/ideas/export", { threadId, format: "json" }, z.object({ files: z.array(z.object({ content: z.string() })) }));
    expect(JSON.parse(ideas.files[0]!.content)).toHaveLength(2);

    const requests = item.requests();
    expect(requests).toHaveLength(10); // Five discovery calls, options, risk, focused draft/review, and analysis.
    expect(requests.filter((request) => request.workOrder.stage === "solutions")).toHaveLength(1);
    expect(requests.find((request) => request.workOrder.stage === "solutions")?.workOrder.inputs)
      .toMatchObject({ explorationPurpose: "auto" });
    const reused = await item.post("/research/select-problems", {
      threadId,
      problemIds: [discovered.problemCandidates[0]!.id],
      userProblem: null,
      model,
      reasoningEffort: "medium",
    }, WorkspaceStateSchema);
    expect(reused.problemCandidates[0]?.developmentCompleted).toBe(true);
    expect(item.requests()).toHaveLength(10);
    for (const request of requests) {
      expect(request.repairPolicy).toBe("one_retry");
      expect(JSON.stringify(request.workOrder)).not.toContain(untrusted);
      expect(request.maxOutputTokens).toBeUndefined();
      if (request.workOrder.stage.startsWith("focused-experiment:")) {
        expect(request.deadlineMs).toBeUndefined();
        expect(request.workOrder.instruction).toBe(request.workOrder.stage.endsWith("review")
          ? FOCUSED_EXPERIMENT_REVIEW_INSTRUCTION
          : FOCUSED_EXPERIMENT_DRAFT_INSTRUCTION);
      } else {
        const promptName = request.workOrder.stage.split(":")[0]!;
        expect(request.deadlineMs).toBeUndefined();
        expect(request.workOrder.instruction.startsWith(readFileSync(join(process.cwd(), "prompts", `workflow-v2-${promptName}.md`), "utf8").trim())).toBe(true);
      }
    }
    expect(requests.some((request) => JSON.stringify(request.evidence).includes(untrusted))).toBe(true);
    expect(JSON.stringify(requests)).not.toContain("synthetic-credential");
    expect(exported.content).not.toContain("synthetic-credential");
    expect(ideas.files[0]?.content).not.toContain("synthetic-credential");
    item.assertAccounting(10);
    expect(item.processIds()).toHaveLength(1);

    await item.restart();
    const reopened = await item.workspace();
    expect(reopened.solutions).toEqual(developed.solutions);
    expect(reopened.problemCandidates).toEqual(developed.problemCandidates);
    const replay = await item.raw("/research/resume", { runId });
    expect(replay.status).toBe(409);
    expect(item.requests()).toHaveLength(10);
    item.assertAccounting(10);
    const validation = await item.post("/validation", undefined, z.object({ native: z.object({ connected: z.boolean() }) }));
    expect(validation.native.connected).toBe(true);
    expect(item.processIds()).toHaveLength(2);
  }, 20_000);

  test("completes a known problem without a search provider", async () => {
    const item = await fixture({ searchEnabled: false });
    const threadId = await item.createThread("known-problem");
    await item.post("/research/start", { threadId }, z.object({ runId: z.string() }));
    const state = await item.waitFor((value) => value.threads.find((thread) => thread.id === threadId)?.status === "solutions-ready");
    expect(state.validation.native.connected).toBe(true);
    expect(state.validation.exa.valid).toBe(false);
    expect(state.solutions).toHaveLength(2);
    expect(item.searches).toHaveLength(0);
    expect(item.requests()).toHaveLength(1);
    item.assertAccounting(1);
    const exported = await item.post("/ideas/export", { threadId, format: "markdown" }, z.object({ files: z.array(z.object({ content: z.string() })) }));
    expect(exported.files[0]?.content).toContain("Supplier reliability ledger");
  }, 15_000);

  test("cancels an accepted generation and preserves unknown usage after reopening", async () => {
    const item = await fixture({ mode: "workflow-cancel", searchEnabled: false });
    const threadId = await item.createThread("known-problem");
    const { runId } = await item.post("/research/start", { threadId }, z.object({ runId: z.string() }));
    await item.waitForAttempt("accepted");
    const cancelled = await item.post("/research/cancel", { runId }, z.object({ workspace: WorkspaceStateSchema }));
    expect(cancelled.workspace.latestResearchRun).toMatchObject({ runId, status: "cancelled", canResume: true });
    expect(cancelled.workspace.latestResearchRun?.resumeBlockedReason).toBeUndefined();
    await item.waitForAttempt("cancelled");
    expect(item.operations()).toContain("generation.cancel");
    expect(item.requests()).toHaveLength(1);
    await item.restart();
    expect((await item.workspace()).solutions).toHaveLength(0);
    expect((await item.workspace()).latestResearchRun?.canResume).toBe(true);
    const db = new DatabaseClient(item.dbPath);
    try {
      expect(db.db.prepare("SELECT status, committed_usd FROM cost_ledger WHERE generation_attempt_id IS NOT NULL").all())
        .toEqual([{ status: "committed", committed_usd: null }]);
    } finally { db.close(); }
    expect(item.requests()).toHaveLength(1);
  }, 15_000);

  test("cancels a queued project without inventing provider usage after restart", async () => {
    const item = await fixture({ mode: "workflow-cancel", searchEnabled: false });
    const firstThread = await item.createThread("known-problem");
    const first = await item.post("/research/start", { threadId: firstThread }, z.object({ runId: z.string() }));
    await item.waitForAttempt("accepted");
    const queuedThread = await item.createThread("known-problem");
    const queued = await item.post("/research/start", { threadId: queuedThread }, z.object({ runId: z.string() }));
    await item.waitForAttempt("prepared");
    await item.post("/research/cancel", { runId: queued.runId }, z.object({ workspace: WorkspaceStateSchema }));
    await item.waitForAttempt("cancelled");
    expect(item.requests()).toHaveLength(1);
    const db = new DatabaseClient(item.dbPath);
    try {
      expect(db.db.prepare("SELECT terminal_kind FROM generation_attempts WHERE research_run_id = ?").get(queued.runId))
        .toEqual({ terminal_kind: "never-dispatched" });
      expect(db.db.prepare("SELECT id FROM cost_ledger WHERE research_run_id = ?").all(queued.runId)).toEqual([]);
    } finally { db.close(); }
    expect((await item.workspace()).latestResearchRun?.usage).toMatchObject({ attemptCount: 0, unknownAttemptCount: 0 });
    await item.post("/research/cancel", { runId: first.runId }, z.object({ workspace: WorkspaceStateSchema }));
    await item.restart();
    expect((await item.workspace()).latestResearchRun?.usage).toMatchObject({ attemptCount: 0, unknownAttemptCount: 0 });
    expect(item.requests()).toHaveLength(1);
  }, 30_000);

  test("retains partial results after pipe loss and never automatically replays ambiguous work", async () => {
    const item = await fixture({ mode: "workflow-crash", searchEnabled: false });
    const threadId = await item.createThread("known-problem");
    const { runId } = await item.post("/research/start", { threadId }, z.object({ runId: z.string() }));
    const options = await item.waitFor((state) => state.latestResearchRun?.awaitingSelection === true);
    await item.post("/research/select-option", { threadId, runId, solutionId: options.solutions[0]!.id }, WorkspaceStateSchema);
    const failed = await item.waitFor((state) => state.threads.find((thread) => thread.id === threadId)?.status === "failed");
    expect(failed.solutions).toHaveLength(2);
    expect(item.requests()).toHaveLength(2);
    await item.restart();
    expect((await item.workspace()).solutions).toEqual(failed.solutions);
    expect((await item.raw("/research/resume", { runId })).status).toBe(409);
    expect(item.requests()).toHaveLength(2);
    const db = new DatabaseClient(item.dbPath);
    try {
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM solutions WHERE research_run_id = ?").get(runId)).toEqual({ count: 2 });
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM outcomes").get()).toEqual({ count: 0 });
      expect(db.db.prepare("SELECT status FROM generation_attempts ORDER BY created_at, rowid").all())
        .toEqual([{ status: "completed" }, { status: "interrupted" }]);
      expect(db.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { db.close(); }
  }, 15_000);
});

describe("native v2 decisions through the production backend", () => {
  test("reuses a completed startup-option generation after persistence fails and saves focused tests as sidecars", async () => {
    const item = await fixture({ searchEnabled: false });
    const threadId = await item.createThread("known-problem", 3, "startup-opportunities");
    const blocked = new DatabaseClient(item.dbPath);
    blocked.db.exec(`
      CREATE TRIGGER fail_initial_startup_option
      BEFORE INSERT ON solutions
      BEGIN
        SELECT RAISE(ABORT, 'fixture startup persistence failure');
      END;
    `);
    blocked.close();

    const { runId } = await item.post("/research/start", { threadId }, z.object({ runId: z.string() }));
    await item.waitFor((state) => state.latestResearchRun?.status === "failed");
    expect(item.requests()).toHaveLength(1);
    const recover = new DatabaseClient(item.dbPath);
    try {
      expect(recover.db.prepare("SELECT status FROM generation_attempts WHERE research_run_id = ?").get(runId))
        .toEqual({ status: "completed" });
      expect(recover.db.prepare("SELECT COUNT(*) AS count FROM solutions WHERE research_run_id = ?").get(runId))
        .toEqual({ count: 0 });
      recover.db.exec("DROP TRIGGER fail_initial_startup_option");
    } finally { recover.close(); }

    await item.post("/research/resume", { runId }, z.unknown());
    const resumed = await item.waitFor((state) => state.latestResearchRun?.awaitingSelection === true);
    expect(item.requests()).toHaveLength(1);
    expect(resumed.solutions).toHaveLength(2);
    for (const solution of resumed.solutions) {
      expect((await item.post(`/ideas/${solution.id}`, undefined, SolutionViewSchema)).focusedDemandTest)
        .toEqual(expect.objectContaining({ schemaVersion: 1, paymentTerms: expect.objectContaining({ amount: 100, currency: "USD" }) }));
    }
    const persisted = new DatabaseClient(item.dbPath);
    try {
      expect(persisted.db.prepare("SELECT COUNT(*) AS count FROM focused_demand_tests WHERE research_run_id = ?").get(runId))
        .toEqual({ count: 2 });
      const checkpoint = persisted.db.prepare("SELECT output_json FROM stage_results WHERE research_run_id = ? AND stage_id = 'solutions'").get(runId) as { output_json: string };
      expect(checkpoint.output_json).not.toContain("focusedDemandTest");
      expect(persisted.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { persisted.close(); }
    item.assertAccounting(1);
  });

  test("saves twenty configured ideas and selects the last one", async () => {
    const item = await fixture({ mode: "workflow-many", searchEnabled: false });
    const threadId = await item.createThread("known-problem", 20);
    await item.post("/research/start", { threadId }, z.object({ runId: z.string() }));
    const options = await item.waitFor(state => state.latestResearchRun?.awaitingSelection === true);
    expect(options.solutions).toHaveLength(20);
    const selected = options.solutions[19]!;
    await item.post("/research/select-option", { threadId, runId: selected.runId, solutionId: selected.id }, WorkspaceStateSchema);
    await item.waitFor(state => state.latestResearchRun?.status === "completed" && !state.latestResearchRun.awaitingSelection);
    expect((await item.post(`/ideas/${selected.id}`, undefined, SolutionViewSchema)).decisionAnalysis).not.toBeNull();
    await item.restart();
    expect((await item.workspace()).solutions).toHaveLength(20);
    item.assertAccounting(5);
  });

  test("retains and exports risk evaluation after analysis fails, then reuses it on resume", async () => {
    const item = await fixture({ mode: "workflow-analysis-fail", searchEnabled: false });
    const threadId = await item.createThread("known-problem");
    await item.post("/research/start", { threadId }, z.object({ runId: z.string() }));
    const options = await item.waitFor(state => state.latestResearchRun?.awaitingSelection === true);
    const selected = options.solutions[0]!;
    await item.post("/research/select-option", { threadId, runId: selected.runId, solutionId: selected.id }, WorkspaceStateSchema);
    await item.waitFor(state => state.latestResearchRun?.status === "failed");
    const failed = await item.post(`/ideas/${selected.id}`, undefined, SolutionViewSchema);
    expect(failed.riskEvaluation?.risks[0]?.riskId).toBe("sparse");
    expect(failed.decisionAnalysis).toBeNull();
    const exported = await item.post("/ideas/export", { threadId, format: "markdown" }, z.object({ files: z.array(z.object({ content: z.string() })) }));
    expect(exported.files[0]!.content).toContain("Observed order volume stays too sparse");
    await item.restart("workflow");
    await item.post("/research/resume", { runId: selected.runId }, z.unknown());
    await item.waitFor(state => state.latestResearchRun?.status === "completed");
    const resumed = await item.post(`/ideas/${selected.id}`, undefined, SolutionViewSchema);
    expect(resumed.riskEvaluation).toEqual(failed.riskEvaluation);
    expect(resumed.decisionAnalysis?.risks).toEqual(failed.riskEvaluation?.risks);
    expect(item.requests().map(request => request.workOrder.stage)).toEqual([
      "solutions", "risk-evaluation", "focused-experiment:draft", "focused-experiment:initial-review",
      "decision-analysis", "decision-analysis",
    ]);
  });

  test("continues a historical six-stage run without adding risk evaluation", async () => {
    const item = await fixture({ searchEnabled: false });
    const threadId = await item.createThread("known-problem");
    await item.post("/research/start", { threadId }, z.object({ runId: z.string() }));
    const options = await item.waitFor(state => state.latestResearchRun?.awaitingSelection === true);
    const selected = options.solutions[0]!;
    const db = new DatabaseClient(item.dbPath);
    try {
      const row = db.db.prepare("SELECT value_json FROM workflow_snapshots WHERE research_run_id = ? AND snapshot_key = 'prompts'").get(selected.runId) as { value_json: string };
      const prompts = JSON.parse(row.value_json) as Record<string, unknown>;
      delete prompts["risk-evaluation"];
      db.db.prepare("UPDATE workflow_snapshots SET value_json = ? WHERE research_run_id = ? AND snapshot_key = 'prompts'").run(JSON.stringify(prompts), selected.runId);
    } finally { db.close(); }
    await item.restart();
    await item.post("/research/select-option", { threadId, runId: selected.runId, solutionId: selected.id }, WorkspaceStateSchema);
    await item.waitFor(state => state.latestResearchRun?.status === "completed" && !state.latestResearchRun.awaitingSelection);
    expect(item.requests().map(request => request.workOrder.stage)).toEqual(["solutions", "decision-analysis"]);
    item.assertAccounting(2);
    const completed = new DatabaseClient(item.dbPath);
    try {
      const now = new Date().toISOString();
      completed.db.prepare(`INSERT INTO evidence_follow_ups (
        research_run_id, solution_id, question, status, requested_at, completed_at, updated_at
      ) VALUES (?, ?, 'Does newer evidence change the result?', 'completed', ?, ?, ?)`)
        .run(selected.runId, selected.id, now, now, now);
    } finally { completed.close(); }
    expect((await item.post(`/ideas/${selected.id}`, undefined, SolutionViewSchema)).canReassessEvidence).toBe(false);
  });

  test("pauses after options, reopens under changed prompts, analyzes one option and records an observed result", async () => {
    const item = await fixture({ searchEnabled: false, workflowVersion: 2 });
    const threadId = await item.createThread("known-problem");
    await item.post("/research/start", { threadId }, z.object({ runId: z.string() }));
    const options = await item.waitFor((state) => state.latestResearchRun?.awaitingSelection === true);
    expect(options.solutions).toHaveLength(2);
    expect(item.requests()).toHaveLength(1);
    expect(item.searches).toHaveLength(0);
    const first = options.solutions[0]!;
    const savedPrompt = readFileSync(join(process.cwd(), "prompts/workflow-v2-decision-analysis.md"), "utf8");
    writeFileSync(join(item.directory, "prompts/workflow-v2-decision-analysis.md"), "This changed override must only affect a new run.");
    await item.restart();
    expect((await item.workspace()).solutions).toEqual(options.solutions);
    expect(item.requests()).toHaveLength(1);
    await item.post("/research/select-option", { threadId, runId: first.runId, solutionId: first.id }, WorkspaceStateSchema);
    const completed = await item.waitFor((state) => state.latestResearchRun?.status === "completed" && !state.latestResearchRun.awaitingSelection);
    expect(item.requests()).toHaveLength(5);
    expect(item.requests().find((request) => request.workOrder.stage === "decision-analysis")?.workOrder.instruction).toBe(savedPrompt.trim());
    expect(completed.solutions.filter((idea) => idea.selected)).toHaveLength(1);
    const detail = await item.post(`/ideas/${first.id}`, undefined, z.object({ decisionAnalysis: z.object({ experiment: z.object({ passCriterion: z.string() }) }) }));
    expect(detail.decisionAnalysis.experiment.passCriterion).toContain("eight");
    await item.post("/research/decision", { threadId, solutionId: first.id, userDecision: "Try one supplier", observedResult: "Nine of ten arrivals met the estimate" }, WorkspaceStateSchema);
    const exported = await item.post("/ideas/export", { threadId, format: "json" }, z.object({ files: z.array(z.object({ content: z.string() })) }));
    expect(exported.files[0]!.content).toContain("Nine of ten");
    expect(exported.files[0]!.content).toContain('"workflowVersion": 2');
    const markdown = await item.post("/ideas/export", { threadId, format: "markdown" }, z.object({ files: z.array(z.object({ content: z.string() })) }));
    expect(markdown.files[0]!.content).toContain("Next experiment");
    await item.restart();
    expect(item.requests()).toHaveLength(5);
    item.assertAccounting(5);
    const db = new DatabaseClient(item.dbPath);
    try {
      expect(db.db.prepare("SELECT stage_id FROM stage_results ORDER BY completed_at").all()).toEqual([{ stage_id: "solutions" }, { stage_id: "risk-evaluation" }, { stage_id: "decision-analysis" }]);
      expect(db.db.prepare("SELECT observed_result FROM decision_analyses").get()).toEqual({ observed_result: "Nine of ten arrivals met the estimate" });
    } finally { db.close(); }
  }, 20_000);

  test("preserves contrary sources and untrusted observations through all seven v2 stages", async () => {
    const item = await fixture({ workflowVersion: 2 });
    const threadId = await item.createThread("explore-market");
    await item.post("/research/start", { threadId }, z.object({ runId: z.string() }));
    const discovery = await item.waitFor((state) => state.threads.find((thread) => thread.id === threadId)?.status === "problems-ready");
    const problem = discovery.problemCandidates[0]!;
    expect(problem.verdict).toBe("overstated");
    await item.post("/research/select-problems", { threadId, problemIds: [problem.id], userProblem: null, model, reasoningEffort: "medium" }, WorkspaceStateSchema);
    const options = await item.waitFor((state) => state.latestResearchRun?.awaitingSelection === true);
    const selected = options.solutions[0]!;
    await item.post("/research/select-option", { threadId, runId: selected.runId, solutionId: selected.id }, WorkspaceStateSchema);
    await item.waitFor((state) => state.latestResearchRun?.status === "completed" && !state.latestResearchRun.awaitingSelection);
    for (const request of item.requests()) expect(JSON.stringify(request.workOrder)).not.toContain(untrusted);
    const analysis = item.requests().find((request) => request.workOrder.stage === "decision-analysis")!;
    expect(JSON.stringify(analysis.evidence)).toContain("Most deliveries arrived on time.");
    expect(JSON.stringify(analysis.evidence)).toContain("disagrees");
    expect(JSON.stringify(analysis.evidence)).toContain("Delays may cluster");
    expect(JSON.stringify(analysis.evidence)).toContain("This source may not represent other shops");
    expect(JSON.stringify(analysis.evidence)).not.toContain('"researchAssessments"');
    expect(item.requests().filter((request) => ["solutions", "risk-evaluation", "decision-analysis"].includes(request.workOrder.stage))).toHaveLength(3);

    const question = "Do representative delivery logs contradict the selected option?";
    const requestsBeforeFollowUp = item.requests().length;
    const searchesBeforeFollowUp = item.searches.length;
    await item.post("/research/evidence-follow-up", { threadId, runId: selected.runId, question }, WorkspaceStateSchema);
    const followedUp = await item.waitFor((state) => state.latestResearchRun?.status === "completed");
    const detail = await item.post(`/ideas/${selected.id}`, undefined, SolutionViewSchema);
    expect(detail.evidenceFollowUp).toEqual(expect.objectContaining({ status: "completed", question, error: null }));
    expect(detail.evidenceFollowUp?.sources).toHaveLength(2);
    expect(detail.evidenceFollowUp?.factors).toHaveLength(2);
    const sibling = options.solutions.find((solution) => solution.id !== selected.id)!;
    expect((await item.post(`/ideas/${sibling.id}`, undefined, SolutionViewSchema)).evidenceFollowUp).toBeUndefined();
    expect(followedUp.solutions.find((solution) => solution.id === sibling.id)?.evidenceFollowUpStatus).toBeUndefined();
    const siblingExport = await item.post("/ideas/export", { threadId, format: "json" }, z.object({
      files: z.array(z.object({ content: z.string() })),
    }));
    const exportedIdeas = siblingExport.files.flatMap((file) => JSON.parse(file.content) as Array<{ id: string; evidenceFollowUp?: unknown }>);
    expect(exportedIdeas.find((solution) => solution.id === sibling.id)?.evidenceFollowUp).toBeUndefined();
    const followUpRequest = item.requests().find((request) => request.workOrder.stage === "factor-harvest:follow-up")!;
    expect(followUpRequest.workOrder.inputs).toEqual({ routing: { harvestMode: "domain", followUp: true }, workflowVersion: 2 });
    expect(JSON.stringify(followUpRequest.workOrder)).not.toContain(question);
    expect(JSON.stringify(followUpRequest.evidence)).toContain(question);
    expect(item.searches.at(-1)).toEqual(expect.objectContaining({ query: question }));
    expect(item.searches).toHaveLength(searchesBeforeFollowUp + 1);
    expect(item.requests()).toHaveLength(requestsBeforeFollowUp + 1);
    const beforeReassessment = await item.post(`/ideas/${selected.id}`, undefined, SolutionViewSchema);
    expect(beforeReassessment.canReassessEvidence).toBe(true);
    await item.post("/research/evidence-reassessment", { threadId, runId: selected.runId }, WorkspaceStateSchema);
    await item.waitFor((state) => state.latestResearchRun?.status === "completed");
    const reassessed = await item.post(`/ideas/${selected.id}`, undefined, SolutionViewSchema);
    expect({ status: reassessed.evidenceFollowUp?.reassessmentStatus, error: reassessed.evidenceFollowUp?.reassessmentError }).toEqual({ status: "completed", error: null });
    expect(reassessed.evidenceFollowUp?.riskReassessment?.affectedRisks[0]?.riskId).toBe("sparse");
    expect(reassessed.decisionAnalysis).toEqual(detail.decisionAnalysis);
    expect(item.searches).toHaveLength(searchesBeforeFollowUp + 1);
    item.assertAccounting(requestsBeforeFollowUp + 3);
    const riskReassessmentRequest = item.requests().find((request) =>
      request.workOrder.stage === "risk-evaluation" && JSON.stringify(request.workOrder.inputs).includes('"reassessment":true'))!;
    expect(JSON.stringify(riskReassessmentRequest.evidence)).toContain('"sourceRole":"measured"');
    expect(JSON.stringify(riskReassessmentRequest.evidence)).toContain('"audienceFit":"intended-buyer"');
    expect(JSON.stringify(riskReassessmentRequest.evidence)).toContain('"independentSourceKey":"survey.example.test"');
    expect(JSON.stringify(riskReassessmentRequest.evidence)).toContain('"supportsDemand":true');
    expect(JSON.stringify(riskReassessmentRequest.evidence)).toContain('"demandEvidenceUncertainty":"The synthetic report covers one repair shop"');

    const attemptsBeforeRecovery = item.requests().length;
    const interrupted = new DatabaseClient(item.dbPath);
    interrupted.db.prepare("DELETE FROM stage_results WHERE research_run_id = ? AND selection_key LIKE '%:evidence-reassessment:%'").run(selected.runId);
    interrupted.db.prepare(`UPDATE evidence_follow_ups
      SET reassessment_status = 'failed', risk_reassessment_json = NULL, reassessment_analysis_json = NULL,
        risk_generation_id = NULL, analysis_generation_id = NULL, reassessment_error = 'Interrupted after provider completion'
      WHERE research_run_id = ?`).run(selected.runId);
    interrupted.close();
    await item.post("/research/evidence-reassessment", { threadId, runId: selected.runId }, WorkspaceStateSchema);
    await item.waitFor((state) => state.latestResearchRun?.status === "completed");
    expect(item.requests()).toHaveLength(attemptsBeforeRecovery);
    const provenance = new DatabaseClient(item.dbPath);
    try {
      const row = provenance.db.prepare("SELECT risk_generation_id AS riskGenerationId, analysis_generation_id AS analysisGenerationId FROM evidence_follow_ups WHERE research_run_id = ?")
        .get(selected.runId) as { riskGenerationId: string; analysisGenerationId: string };
      expect(provenance.db.prepare("SELECT stage_key FROM generation_attempts WHERE research_run_id = ? AND generation_id = ?").get(selected.runId, row.riskGenerationId))
        .toEqual({ stage_key: "risk-evaluation" });
      expect(provenance.db.prepare("SELECT stage_key FROM generation_attempts WHERE research_run_id = ? AND generation_id = ?").get(selected.runId, row.analysisGenerationId))
        .toEqual({ stage_key: "decision-analysis" });
    } finally { provenance.close(); }
    expect((await item.raw("/research/evidence-follow-up", { threadId, runId: selected.runId, question: "Try twice" })).status).toBe(409);
    await item.restart();
    const reopened = await item.post(`/ideas/${selected.id}`, undefined, SolutionViewSchema);
    expect(reopened.evidenceFollowUp).toEqual(reassessed.evidenceFollowUp);
    expect(followedUp.solutions.find((solution) => solution.id === selected.id)?.decisionAnalysis).toBeUndefined();
  }, 20_000);

  test("generates options for every selected problem before asking for analysis", async () => {
    const item = await fixture({ workflowVersion: 2 });
    const threadId = await item.createThread("explore-market");
    await item.post("/research/start", { threadId }, z.object({ runId: z.string() }));
    const discovery = await item.waitFor((state) => state.threads.find((thread) => thread.id === threadId)?.status === "problems-ready");
    const discovered = discovery.problemCandidates[0]!;
    await item.post("/research/select-problems", {
      threadId,
      problemIds: [discovered.id],
      userProblem: "Supplier credits disappear between return shipment and statement reconciliation.",
      model,
      reasoningEffort: "medium",
    }, WorkspaceStateSchema);

    let completed = await item.waitFor((state) => {
      const optionRuns = new Set(state.solutions.map((solution) => solution.runId));
      return state.threads.find((thread) => thread.id === threadId)?.status === "solutions-ready"
        && optionRuns.size === 2;
    });
    expect(completed.solutions).toHaveLength(4);
    expect(item.requests().filter((request) => request.workOrder.stage === "solutions")).toHaveLength(2);
    const db = new DatabaseClient(item.dbPath);
    let completedRunId = "";
    let removedProblemId = "";
    let queuedConfig = "";
    try {
      expect(db.db.prepare(`SELECT status, awaiting_selection FROM research_runs WHERE problem_id IS NOT NULL ORDER BY created_at, rowid`).all())
        .toEqual([{ status: "completed", awaiting_selection: 1 }, { status: "completed", awaiting_selection: 1 }]);
      const runs = db.db.prepare(`SELECT id, problem_id AS problemId, config_json AS configJson
        FROM research_runs WHERE problem_id IS NOT NULL ORDER BY created_at, rowid`).all() as Array<{ id: string; problemId: string; configJson: string }>;
      completedRunId = runs[0]!.id;
      removedProblemId = runs[1]!.problemId;
      queuedConfig = runs[1]!.configJson;
    } finally { db.close(); }

    const optionRequestsBeforeRecovery = item.requests().filter((request) => request.workOrder.stage === "solutions").length;
    await item.close();
    const gap = new DatabaseClient(item.dbPath);
    try {
      gap.db.prepare("DELETE FROM research_runs WHERE problem_id = ?").run(removedProblemId);
      gap.db.prepare("UPDATE threads SET status = 'development-running' WHERE id = ?").run(threadId);
      new ThreadRepository(gap).recoverStaleDevelopmentStatuses();
      expect(gap.db.prepare("SELECT status FROM threads WHERE id = ?").get(threadId)).toEqual({ status: "development-running" });
    } finally { gap.close(); }
    await item.restart();
    completed = await item.waitFor((state) => {
      const optionRuns = new Set(state.solutions.map((solution) => solution.runId));
      return state.threads.find((thread) => thread.id === threadId)?.status === "solutions-ready"
        && optionRuns.size === 2;
    });
    expect(item.requests().filter((request) => request.workOrder.stage === "solutions")).toHaveLength(optionRequestsBeforeRecovery + 1);
    const recovered = new DatabaseClient(item.dbPath);
    try {
      expect(recovered.db.prepare("SELECT COUNT(*) AS count FROM research_runs WHERE id = ?").get(completedRunId)).toEqual({ count: 1 });
      expect(recovered.db.prepare("SELECT config_json AS configJson FROM research_runs WHERE problem_id = ?").get(removedProblemId))
        .toEqual({ configJson: queuedConfig });
    } finally { recovered.close(); }
    const firstRunOption = completed.solutions[0]!;
    const aged = new DatabaseClient(item.dbPath);
    aged.db.prepare("UPDATE research_runs SET created_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 10 * 60_000).toISOString(), firstRunOption.runId);
    aged.close();

    const otherThreadId = await item.createThread("explore-market");
    const activeOtherProject = new DatabaseClient(item.dbPath);
    new ResearchRunRepository(activeOtherProject).create(otherThreadId, { ...DEFAULT_RUN_CONFIG, workflowVersion: 2, model }, null);
    activeOtherProject.db.prepare("UPDATE threads SET status = 'discovery-running' WHERE id = ?").run(otherThreadId);
    activeOtherProject.close();
    await item.post("/threads/select", { threadId }, WorkspaceStateSchema);

    const selectingOlderRun = await item.post("/research/select-option", {
      threadId, runId: firstRunOption.runId, solutionId: firstRunOption.id,
    }, WorkspaceStateSchema);
    expect(selectingOlderRun.latestResearchRun).toMatchObject({
      runId: firstRunOption.runId,
      problemId: firstRunOption.problemId,
    });
    expect(selectingOlderRun.latestResearchRun?.stage === "evaluating-risk"
      || selectingOlderRun.latestResearchRun?.stage === "analyzing-option").toBe(true);
    expect(selectingOlderRun.latestResearchRun?.elapsedMs).toBeGreaterThan(9 * 60_000);
    expect(selectingOlderRun.latestResearchRun?.operationElapsedMs).toBeLessThan(5_000);
    expect(Date.parse(selectingOlderRun.latestResearchRun!.operationStartedAt!)).toBeGreaterThan(Date.now() - 5_000);

    const analyzedOlderRun = await item.waitFor((state) =>
      state.threads.find((thread) => thread.id === threadId)?.status === "solutions-ready");
    expect(analyzedOlderRun.threads.find((thread) => thread.id === threadId)?.status).toBe("solutions-ready");
    expect(analyzedOlderRun.threads.find((thread) => thread.id === otherThreadId)?.status).toBe("discovery-running");
  }, 20_000);

  test("reassesses a completed zero-result follow-up without another search", async () => {
    const item = await fixture({ workflowVersion: 2, searchEnabled: false, mode: "workflow-reassessment-fail-once" });
    const threadId = await item.createThread("known-problem");
    await item.post("/research/start", { threadId }, z.object({ runId: z.string() }));
    const options = await item.waitFor((state) => state.latestResearchRun?.awaitingSelection === true);
    const selected = options.solutions[0]!;
    await item.post("/research/select-option", { threadId, runId: selected.runId, solutionId: selected.id }, WorkspaceStateSchema);
    await item.waitFor((state) => state.latestResearchRun?.status === "completed" && !state.latestResearchRun.awaitingSelection);
    const db = new DatabaseClient(item.dbPath);
    const now = new Date().toISOString();
    db.db.prepare(`INSERT INTO evidence_follow_ups (research_run_id, solution_id, question, status, source_ids_json, factor_ids_json, requested_at, completed_at, updated_at)
      VALUES (?, ?, 'Did the follow-up find any matching records?', 'completed', '["raw-unverified-source"]', '[]', ?, ?, ?)`).run(selected.runId, selected.id, now, now, now);
    db.close();
    const searches = item.searches.length;
    await item.post("/research/evidence-reassessment", { threadId, runId: selected.runId }, WorkspaceStateSchema);
    await item.waitFor((state) => state.latestResearchRun?.status === "completed");
    const failed = await item.post(`/ideas/${selected.id}`, undefined, SolutionViewSchema);
    expect(failed.evidenceFollowUp?.reassessmentStatus).toBe("failed");
    expect(failed.canReassessEvidence).toBe(true);
    await item.post("/research/evidence-reassessment", { threadId, runId: selected.runId }, WorkspaceStateSchema);
    await item.waitFor((state) => state.latestResearchRun?.status === "completed");
    const detail = await item.post(`/ideas/${selected.id}`, undefined, SolutionViewSchema);
    expect(detail.evidenceFollowUp).toMatchObject({ reassessmentStatus: "completed", sources: [], factors: [] });
    expect(item.searches).toHaveLength(searches);
    expect(item.requests().filter((request) => request.workOrder.stage === "risk-evaluation" && JSON.stringify(request.workOrder.inputs).includes('"reassessment":true'))).toHaveLength(1);
    const riskRequest = item.requests().find((request) => request.workOrder.stage === "risk-evaluation" && JSON.stringify(request.workOrder.inputs).includes('"reassessment":true'))!;
    expect(JSON.stringify(riskRequest.evidence)).not.toContain("raw-unverified-source");
    expect(JSON.stringify(riskRequest.evidence)).toContain("no new quote-verified support");
  }, 20_000);

  test("cancelling an accepted reassessment settles once and remains retryable", async () => {
    const item = await fixture({ workflowVersion: 2, searchEnabled: false, mode: "workflow-reassessment-cancel" });
    const threadId = await item.createThread("known-problem");
    await item.post("/research/start", { threadId }, z.object({ runId: z.string() }));
    const options = await item.waitFor((state) => state.latestResearchRun?.awaitingSelection === true);
    const selected = options.solutions[0]!;
    await item.post("/research/select-option", { threadId, runId: selected.runId, solutionId: selected.id }, WorkspaceStateSchema);
    await item.waitFor((state) => state.latestResearchRun?.status === "completed" && !state.latestResearchRun.awaitingSelection);
    const db = new DatabaseClient(item.dbPath);
    const now = new Date().toISOString();
    db.db.prepare(`INSERT INTO evidence_follow_ups (research_run_id, solution_id, question, status, requested_at, completed_at, updated_at)
      VALUES (?, ?, 'Did anything change?', 'completed', ?, ?, ?)`).run(selected.runId, selected.id, now, now, now);
    db.close();
    await item.post("/research/evidence-reassessment", { threadId, runId: selected.runId }, WorkspaceStateSchema);
    const attempts = new DatabaseClient(item.dbPath);
    const deadline = Date.now() + 5_000;
    while (!attempts.db.prepare(`SELECT 1 FROM generation_attempts WHERE stage_key = 'decision-analysis' AND status = 'accepted'
      AND json_extract(request_json, '$.workOrder.inputs.reassessment') = 1`).get()) {
      if (Date.now() >= deadline) throw new Error("Reassessment analysis was not accepted");
      await Bun.sleep(20);
    }
    attempts.close();
    const eventCount = item.events.length;
    const cancelled = await item.post("/research/cancel", { runId: selected.runId }, z.object({ workspace: WorkspaceStateSchema }));
    expect(cancelled.workspace.latestResearchRun?.status).toBe("completed");
    const detail = await item.post(`/ideas/${selected.id}`, undefined, SolutionViewSchema);
    expect(detail.evidenceFollowUp?.reassessmentStatus).toBe("failed");
    expect(detail.canReassessEvidence).toBe(true);
    expect(item.events.slice(eventCount).map((event) => event.type)).toEqual(["run-cancelled"]);
  }, 20_000);

  test("cancels a pending follow-up without losing analysis or reopening its cap", async () => {
    const item = await fixture({ workflowVersion: 2, hangFollowUpSearch: true });
    const threadId = await item.createThread("known-problem");
    await item.post("/research/start", { threadId }, z.object({ runId: z.string() }));
    const options = await item.waitFor((state) => state.latestResearchRun?.awaitingSelection === true);
    const selected = options.solutions[0]!;
    await item.post("/research/select-option", { threadId, runId: selected.runId, solutionId: selected.id }, WorkspaceStateSchema);
    await item.waitFor((state) => state.latestResearchRun?.status === "completed" && !state.latestResearchRun.awaitingSelection);
    await item.post("/research/evidence-follow-up", {
      threadId, runId: selected.runId, question: "Will this search be cancelled?",
    }, WorkspaceStateSchema);
    await item.waitFor((state) => state.latestResearchRun?.status === "running");
    await item.post("/research/cancel", { runId: selected.runId }, z.object({ workspace: WorkspaceStateSchema }));
    const detail = await item.post(`/ideas/${selected.id}`, undefined, SolutionViewSchema);
    expect(detail.decisionAnalysis).not.toBeNull();
    expect(detail.evidenceFollowUp).toEqual(expect.objectContaining({ status: "failed", error: "Cancelled by user" }));
    expect((await item.raw("/research/evidence-follow-up", {
      threadId, runId: selected.runId, question: "Try again",
    })).status).toBe(409);
    const db = new DatabaseClient(item.dbPath);
    try {
      expect(db.db.prepare("SELECT 1 FROM cost_ledger WHERE operation = 'evidence-follow-up'").all()).toEqual([]);
      expect(db.db.prepare("SELECT status, committed_usd FROM cost_ledger WHERE operation = 'evidence-follow-up-search'").all())
        .toEqual([{ status: "committed", committed_usd: null }]);
      expect(db.db.prepare("SELECT status FROM research_runs WHERE id = ?").get(selected.runId)).toEqual({ status: "completed" });
    } finally { db.close(); }
    await item.restart();
    expect((await item.post(`/ideas/${selected.id}`, undefined, SolutionViewSchema)).evidenceFollowUp)
      .toEqual(detail.evidenceFollowUp);
    expect(item.requests()).toHaveLength(5);
  }, 20_000);
});

async function fixture({ mode = "workflow", searchEnabled = true, workflowVersion = 2, hangFollowUpSearch = false, legacyAudienceCheckpoint = false }: {
  mode?: string; searchEnabled?: boolean; workflowVersion?: 1 | 2; hangFollowUpSearch?: boolean; legacyAudienceCheckpoint?: boolean;
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "scraply-native-workflow-"));
  const dbPath = join(directory, "scraply.db");
  const capture = join(directory, "requests.jsonl");
  const pids = join(directory, "pids.txt");
  const operationsCapture = join(directory, "operations.txt");
  const searches: unknown[] = [];
  const events: ResearchEvent[] = [];
  const backendErrors: string[] = [];
  let backend: Awaited<ReturnType<typeof startNativeWorkflowBackend>>;
  let closed = true;
  const lines = (path: string) => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : [];

  async function open() {
    backend = await startNativeWorkflowBackend(directory, { mode, searchEnabled, searches, hangFollowUpSearch,
      onError: error => backendErrors.push(error instanceof Error ? error.message : String(error)), onEvent: (event) => {
      events.push(event);
      if (legacyAudienceCheckpoint && event.type === "run-started" && !event.problemId) {
        // Seed a pre-policy archive before execution starts, without mutating completed history.
        const saved = new DatabaseClient(dbPath);
        try {
          const insert = saved.db.prepare("INSERT INTO workflow_snapshots VALUES (?, ?, ?)");
          insert.run(event.runId, "prompts", JSON.stringify(Object.fromEntries(WORKFLOW_V2_STAGE_IDS.map(stage => [stage, resolveWorkflowV2Prompt(stage)]))));
          insert.run(event.runId, "identifier-characters", "24");
          insert.run(event.runId, "small-harvest-batches", JSON.stringify({ version: 1 }));
          // A resumed archive retains uncertain reservations from its earlier interruption.
          const session = saved.db.prepare("SELECT workflow_session_id FROM research_runs WHERE id = ?").get(event.runId) as { workflow_session_id: string };
          const workflows = new WorkflowRepository(saved);
          saved.immediateTransaction(() => {
            for (const entry of workflows.listBudgetEntries(session.workflow_session_id).filter(entry => entry.state === "reserved")) {
              workflows.settleBudget(entry.id, { state: "uncertain", settledUnits: entry.reservedUnits });
            }
          });
        } finally { saved.close(); }
      }
    } });
    closed = false;
  }
  async function close() {
    if (closed) return;
    closed = true;
    await backend.close();
  }
  async function raw(path: string, body?: unknown) {
    return fetch(`http://127.0.0.1:${backend.port}${path}`, {
      method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(5_000),
      headers: { authorization: `Bearer ${backend.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function post<T>(path: string, body: unknown, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
    const startedAt = Date.now();
    const response = await raw(path, body);
    const text = await response.text();
    if (!text) throw new Error(`${path}: empty HTTP ${response.status} response after ${Date.now() - startedAt} ms (${response.headers.get("content-type") ?? "no content type"})`);
    const result: unknown = JSON.parse(text);
    if (response.status !== 200) throw new Error(`${path}: ${JSON.stringify(result)}`);
    return schema.parse(z.object({ data: z.unknown() }).parse(result).data);
  }
  async function workspace() { return post("/workspace", undefined, WorkspaceStateSchema); }
  const item = {
    directory, dbPath, searches, events, raw, post, workspace, close,
    operations: () => lines(operationsCapture), processIds: () => lines(pids),
    requests: () => lines(capture).map((line) => z.object({ payload: GenerationStartPayloadSchema }).parse(JSON.parse(line)).payload),
    async restart(nextMode = mode) { await close(); mode = nextMode; await open(); },
    async createThread(
      researchMode: "explore-market" | "known-problem",
      ideaCount = 3,
      explorationPurpose: "auto" | "general-solutions" | "startup-opportunities" = "general-solutions",
    ) {
      const created = await post("/threads", { title: scope.title }, z.object({ thread: z.object({ id: z.string() }) }));
      const threadId = created.thread.id;
      await post("/scope", { threadId, scope }, WorkspaceStateSchema);
      await post("/run-config", { threadId, config: {
        ...DEFAULT_RUN_CONFIG,
        workflowVersion,
        ideaCount,
        model,
        discoveryDepth: "quick",
        researchMode,
        knownProblem: researchMode === "known-problem" ? statement : "",
        explorationPurpose,
      } }, WorkspaceStateSchema);
      return threadId;
    },
    async waitFor(predicate: (state: WorkspaceState) => boolean) {
      const deadline = Date.now() + 8_000;
      let state = await workspace();
      while (!predicate(state) && Date.now() < deadline) {
        if (state.threads.find((thread) => thread.id === state.activeThreadId)?.status === "failed") {
          const db = new DatabaseClient(dbPath);
          const failed = db.db.prepare("SELECT completion_reason FROM research_runs WHERE id = ?").get(state.latestResearchRun?.runId);
          db.close();
          throw new Error(`Workflow failed: ${JSON.stringify(failed)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        state = await workspace();
      }
      if (!predicate(state)) throw new Error(`Workflow did not reach its expected outcome: ${JSON.stringify({
        state: state.activeWorkflow?.state, outcome: state.activeWorkflow?.outcome, stopReason: state.activeWorkflow?.stopReason,
        counts: state.activeWorkflow?.counts, errors: backendErrors, problems: state.problemCandidates.map(problem => ({ verdict: problem.verdict, evidenceGap: problem.evidenceGap })),
      })}`);
      return state;
    },
    async waitForAttempt(status: string) {
      const db = new DatabaseClient(dbPath);
      try {
        const deadline = Date.now() + 5_000;
        while (!db.db.prepare("SELECT 1 FROM generation_attempts WHERE status = ?").get(status)) {
          if (Date.now() >= deadline) throw new Error(`No generation reached ${status}`);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      } finally { db.close(); }
    },
    assertAccounting(count: number) {
      const db = new DatabaseClient(dbPath);
      try {
        const attempts = db.db.prepare("SELECT status, runtime_prompt_sha256, request_sha256 FROM generation_attempts").all() as Array<{ status: string; runtime_prompt_sha256: string; request_sha256: string }>;
        expect(attempts).toHaveLength(count);
        expect(attempts.every((attempt) => attempt.status === "completed" && attempt.runtime_prompt_sha256.length === 64 && attempt.request_sha256.length === 64)).toBe(true);
        const costs = db.db.prepare("SELECT status, committed_usd FROM cost_ledger WHERE generation_attempt_id IS NOT NULL").all();
        expect(costs).toHaveLength(count);
        expect(costs).toEqual(Array.from({ length: count }, () => ({ status: "committed", committed_usd: null })));
        expect(db.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally { db.close(); }
    },
  };
  fixtures.push(item);
  await open();
  return item;
}
