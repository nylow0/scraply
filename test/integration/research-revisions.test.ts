import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBackend, type BackendHandle } from "../../src/backend/server";
import { materializeResearchSnapshot } from "../../src/core/research-revisions";
import { ResearchRequestService } from "../../src/core/research-request-service";
import { WorkflowCoordinator } from "../../src/core/workflow-coordinator";
import { WorkflowExecution } from "../../src/core/workflow-execution";
import { DatabaseClient } from "../../src/db/client";
import { DiscoveryRepository } from "../../src/db/repositories/discovery";
import { WorkflowRepository } from "../../src/db/repositories/workflows";
import { sha256 } from "../../src/shared/content-identity";
import { previewResearchAngles } from "../../src/shared/research-revisions";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";
import type { StructuredModelClient } from "../../src/providers/structured";
import { WorkflowAdmissionReceiptSchema } from "../../src/shared/workflow-contracts";

const directories: string[] = [];
afterEach(() => {
  while (directories.length) {
    try { rmSync(directories.pop()!, { recursive: true, force: true }); }
    catch { /* SQLite may still hold a WAL handle on Windows. */ }
  }
});

describe("research snapshot materialization", () => {
  test("copies two saved findings into one run, retains source identity, and leaves old runs intact", () => {
    const client = setup();
    saveFinding(client, "run-old", "old", "source-old", "factor-old", "Small teams file manually");
    saveFinding(client, "run-new", "new", "source-new", "factor-new", "Larger teams file manually");
    const workflows = new WorkflowRepository(client);
    client.immediateTransaction(() => workflows.createSession({
      id: "session-1", threadId: "project-1", purpose: "discovery", mode: "babysit",
      contract: { version: 1 }, remainingMs: 60_000,
    }));
    const { materialized, snapshot } = client.immediateTransaction(() => {
      const materialized = materializeResearchSnapshot(client, {
        threadId: "project-1", baseRunId: "run-old", sourceProblemIds: ["old", "new"],
        sessionId: "session-1",
      });
      const snapshot = workflows.createSnapshot({
        sessionId: "session-1", materializationRunId: materialized.runId,
        selection: { problemIds: materialized.problemIds, sourceProblemIds: ["old", "new"] },
        originMap: materialized.originMap,
      });
      return { materialized, snapshot };
    });
    expect(materialized.problemIds).toHaveLength(2);
    expect(Object.keys(materialized.originMap.problems)).toHaveLength(2);
    expect(Object.keys(materialized.originMap.factors)).toHaveLength(2);
    expect(Object.keys(materialized.originMap.sources)).toHaveLength(1);
    expect(Object.values(materialized.originMap.sources)[0]).toHaveLength(2);
    expect(workflows.getSnapshot(snapshot.id)?.selection.problemIds).toEqual(materialized.problemIds);
    expect(count(client, "sources", "research_run_id", materialized.runId)).toBe(1);
    expect(count(client, "factors", "research_run_id", materialized.runId)).toBe(2);
    expect(count(client, "problems", "discovery_run_id", materialized.runId)).toBe(2);
    expect(count(client, "problems", "discovery_run_id", "run-old")).toBe(1);
    expect(count(client, "problems", "discovery_run_id", "run-new")).toBe(1);
    expect(client.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const run = client.db.prepare("SELECT status, purpose, committed_cost FROM research_runs WHERE id = ?")
      .get(materialized.runId) as { status: string; purpose: string; committed_cost: number };
    expect(run).toEqual({ status: "completed", purpose: "research-materialization", committed_cost: 0 });
    client.close();
  });

  test("rejects a finding in another project and rolls back the new run", () => {
    const client = setup();
    saveFinding(client, "run-old", "old", "source-old", "factor-old", "Small teams file manually");
    saveFinding(client, "run-foreign", "foreign", "source-foreign", "factor-foreign", "Foreign finding");
    expect(() => client.immediateTransaction(() => materializeResearchSnapshot(client, {
      threadId: "project-1", baseRunId: "run-old", sourceProblemIds: ["old", "foreign"],
    }))).toThrow("unavailable in this project");
    expect(count(client, "research_runs", "purpose", "research-materialization")).toBe(0);
    client.close();
  });

  test("admits a new question before dispatch, saves its result, and applies a new snapshot explicitly", async () => {
    const { client, repository, sessionId, snapshotId, oldProblemId } = workflowFixture();
    const dispatched: string[] = [];
    const service = new ResearchRequestService({
      db: client, engine: () => ({ resumeRun: async (id: string) => { dispatched.push(id); } }),
      modelClient: () => { throw new Error("No model call expected in this admission test"); },
    });
    const startRevision = repository.getSession(sessionId)!.revision;
    const admitted = client.immediateTransaction(() => service.admitRequest(sessionId, startRevision, {
      type: "request-research", kind: "new-question", question: "What do buyers use today?",
      baseSnapshotId: snapshotId, model: { providerId: "openai-subscription", modelId: "test-model" },
      reasoningEffort: "medium", allowance: { maxModelCalls: 12, maxSearches: 10, maxMinutes: 10 },
    }));
    expect(repository.getWorkItem(admitted.workItemId)?.state).toBe("ready");
    expect(dispatched).toEqual([]);
    expect(repository.getSession(sessionId)?.activeSnapshotId).toBe(snapshotId);
    await service.dispatchReady(sessionId);
    expect(dispatched).toHaveLength(1);
    const runId = dispatched[0]!;
    expect(repository.getWorkItem(admitted.workItemId)?.state).toBe("running");
    saveRunFinding(client, runId, "new-question-finding", "new-question-source", "new-question-factor", "Buyers use spreadsheets");
    client.db.prepare("UPDATE research_runs SET status = 'completed' WHERE id = ?").run(runId);
    await service.handleRunEvent({ type: "run-completed", runId, threadId: "project-1", problemId: null });
    expect(repository.getWorkItem(admitted.workItemId)?.state).toBe("succeeded");
    expect(service.listRequests(sessionId)[0]?.resultFindings[0]?.statement).toBe("Buyers use spreadsheets");
    expect(repository.getSession(sessionId)?.activeSnapshotId).toBe(snapshotId);
    const revision = repository.getSession(sessionId)!.revision;
    const applied = client.immediateTransaction(() => service.applyResearch(sessionId, revision, {
      type: "apply-research", baseSnapshotId: snapshotId,
      includedRequestIds: [admitted.workItemId], replacements: [],
    }));
    expect(applied.snapshot.selection.sourceProblemIds).toEqual([oldProblemId, "new-question-finding"]);
    expect(repository.getSession(sessionId)?.activeSnapshotId).toBe(applied.snapshot.id);
    expect(repository.getSnapshot(snapshotId)).not.toBeNull();
    expect(() => client.immediateTransaction(() => service.keepResearch(sessionId, applied.session.revision, {
      type: "keep-research", requestId: admitted.workItemId, baseSnapshotId: applied.snapshot.id,
    }))).toThrow("completed, unapplied request");
    expect(() => client.immediateTransaction(() => service.applyResearch(sessionId, revision, {
      type: "apply-research", baseSnapshotId: snapshotId,
      includedRequestIds: [admitted.workItemId], replacements: [],
    }))).toThrow("revision changed");
    client.close();
  });

  test("reevaluates the saved excerpt without searching and preserves the earlier verdict", async () => {
    const { client, repository, sessionId, snapshotId, oldProblemId } = workflowFixture();
    let modelCalls = 0;
    const modelClient: StructuredModelClient = {
      structuredCompletion: async (request) => {
        modelCalls += 1;
        request.onDispatched?.();
        request.onAccepted?.({});
        const saved = request.evidence[0]!.content as { sources: Array<{ id: string }> };
        return {
          output: request.schema.parse({
            verdict: "insufficient-evidence", verdictReason: "The saved excerpt does not establish buyer demand.",
            verdictSourceIds: [saved.sources[0]!.id],
            unresolvedAssumptions: ["Buyer fit"], wouldChangeConclusion: ["Two independent buyer reports"],
            intendedBuyerEvidenceFactorIds: [], evidenceGap: "Buyer demand is unproven.",
          }),
          metadata: {
            model: request.model, usage: { status: "unknown" }, providerCosts: [{ amount: 0.01, currency: "USD" }],
            finishReason: "stop", latencyMs: 1, repairCount: 0, providerRequestIds: ["mock-1"],
            attempts: [{ attempt: "initial", outcome: "completed", providerCompletion: "confirmed",
              model: request.model, usage: { status: "unknown" }, cost: { status: "reported", value: { amount: 0.01, currency: "USD" } }, latencyMs: 1 }],
          },
        };
      },
    };
    const service = new ResearchRequestService({
      db: client, engine: () => ({ resumeRun: async () => { throw new Error("No discovery run expected"); } }),
      modelClient: () => modelClient,
    });
    const admitted = client.immediateTransaction(() => service.admitRequest(sessionId, repository.getSession(sessionId)!.revision, {
      type: "request-research", kind: "reevaluate", question: "Recheck buyer fit",
      targetFindingId: oldProblemId, baseSnapshotId: snapshotId,
      model: { providerId: "openai-subscription", modelId: "test-model" }, reasoningEffort: "medium",
      allowance: { maxModelCalls: 1, maxSearches: 0, maxMinutes: 5 },
    }));
    await service.dispatchReady(sessionId);
    expect(modelCalls).toBe(1);
    const item = repository.getWorkItem(admitted.workItemId)!;
    expect(item.error).toBeNull();
    expect(item.state).toBe("succeeded");
    const output = item.outputRefs as { runId: string; problemIds: string[] };
    expect(service.listRequests(sessionId)[0]?.resultFindings[0]?.verdict).toBe("insufficient-evidence");
    expect((client.db.prepare("SELECT verdict FROM problems WHERE id = ?").get(oldProblemId) as { verdict: string }).verdict)
      .toBe("confirmed");
    expect((client.db.prepare("SELECT COUNT(*) AS count FROM cost_ledger WHERE research_run_id = ? AND operation = 'search'")
      .get(output.runId) as { count: number }).count).toBe(0);
    expect(repository.getSession(sessionId)?.activeSnapshotId).toBe(snapshotId);
    client.close();
  });

  test("pauses after a running request reaches a terminal result", async () => {
    const { client, repository, sessionId, snapshotId } = workflowFixture();
    const service = new ResearchRequestService({
      db: client, engine: () => ({ resumeRun: async () => {} }),
      modelClient: () => { throw new Error("No direct model call expected"); },
    });
    const admitted = client.immediateTransaction(() => service.admitRequest(sessionId, repository.getSession(sessionId)!.revision, {
      type: "request-research", kind: "new-question", question: "What changed?", baseSnapshotId: snapshotId,
      model: { providerId: "openai-subscription", modelId: "test-model" }, reasoningEffort: "medium",
      allowance: { maxModelCalls: 12, maxSearches: 10, maxMinutes: 10 },
    }));
    await service.dispatchReady(sessionId);
    const runId = (repository.getWorkItem(admitted.workItemId)!.outputRefs as { runId: string }).runId;
    client.immediateTransaction(() => repository.updateSession(sessionId, repository.getSession(sessionId)!.revision, {
      state: "pause-requested",
    }));
    client.db.prepare("UPDATE research_runs SET status = 'completed' WHERE id = ?").run(runId);
    await service.handleRunEvent({ type: "run-completed", runId, threadId: "project-1", problemId: null });
    expect(repository.getSession(sessionId)?.state).toBe("paused");
    expect(repository.getWorkItem(admitted.workItemId)?.state).toBe("succeeded");
    client.close();
  });

  test("stopping a running request cancels queued requests and releases their reservations", async () => {
    const { client, repository, sessionId, snapshotId } = workflowFixture();
    const service = new ResearchRequestService({
      db: client, engine: () => ({ resumeRun: async () => {} }),
      modelClient: () => { throw new Error("No direct model call expected"); },
    });
    const action = (question: string) => ({
      type: "request-research" as const, kind: "new-question" as const, question, baseSnapshotId: snapshotId,
      model: { providerId: "openai-subscription" as const, modelId: "test-model" }, reasoningEffort: "medium",
      allowance: { maxModelCalls: 12, maxSearches: 10, maxMinutes: 10 },
    });
    const first = client.immediateTransaction(() => service.admitRequest(sessionId, repository.getSession(sessionId)!.revision, action("First question")));
    const second = client.immediateTransaction(() => service.admitRequest(sessionId, repository.getSession(sessionId)!.revision, action("Second question")));
    await service.dispatchReady(sessionId);
    const runId = (repository.getWorkItem(first.workItemId)!.outputRefs as { runId: string }).runId;
    client.immediateTransaction(() => repository.updateSession(sessionId, repository.getSession(sessionId)!.revision, {
      state: "stop-requested",
    }));
    client.db.prepare("UPDATE research_runs SET status = 'cancelled' WHERE id = ?").run(runId);
    await service.handleRunEvent({ type: "run-cancelled", runId, threadId: "project-1" });
    expect(repository.getSession(sessionId)?.state).toBe("finished");
    expect(repository.getSession(sessionId)?.outcome).toBe("cancelled");
    expect(repository.getWorkItem(first.workItemId)?.state).toBe("cancelled");
    expect(repository.getWorkItem(second.workItemId)?.state).toBe("cancelled");
    expect(repository.listBudgetEntries(sessionId).filter((entry) => entry.workItemId === second.workItemId)
      .every((entry) => entry.state === "released")).toBe(true);
    client.close();
  });

  test("a followup run freezes only the user research instruction in its prompt snapshot", async () => {
    const { client, repository, sessionId, snapshotId } = workflowFixture({
      researchInstruction: "Focus on operations teams with fewer than ten people.",
      auditResearchText: "Compiled prompt bundle marker that should stay in the audit snapshot.",
    });
    const session = repository.getSession(sessionId)!;
    const contract = session.contract as { instructions: { research?: string }; resolvedInstructions: { research: string } };
    let runId = "";
    const service = new ResearchRequestService({
      db: client, engine: () => ({ resumeRun: async (id: string) => { runId = id; } }),
      modelClient: () => { throw new Error("No direct model call expected"); },
    });
    client.immediateTransaction(() => service.admitRequest(sessionId, repository.getSession(sessionId)!.revision, {
      type: "request-research", kind: "new-question", question: "What changes for small teams?",
      baseSnapshotId: snapshotId, model: { providerId: "openai-subscription", modelId: "test-model" },
      reasoningEffort: "medium", allowance: { maxModelCalls: 12, maxSearches: 10, maxMinutes: 10 },
    }));
    await service.dispatchReady(sessionId);
    const first = new WorkflowExecution(client, runId).resolvePrompt("query-plan");
    expect(first.text).toContain(contract.instructions.research!);
    expect(first.text).not.toContain(contract.resolvedInstructions.research);
    expect(first.resolvedSha256).toBe(sha256(first.text));
    const resumed = new WorkflowExecution(client, runId).resolvePrompt("query-plan");
    expect(resumed.text).toBe(first.text);
    expect(resumed.resolvedSha256).toBe(first.resolvedSha256);
    client.close();
  });

  test("admits distinct angle tasks and exposes omitted coverage before dispatch", () => {
    const { client, repository, sessionId, snapshotId } = workflowFixture();
    const preview = previewResearchAngles("new-question", undefined, { maxSearches: 4 });
    expect(preview.planned.map((angle) => angle.name)).toEqual(["Firsthand problem reports", "Contrary evidence"]);
    expect(preview.omitted.map((angle) => angle.name)).toEqual(["Existing alternatives", "Buying or adoption behavior"]);
    const service = new ResearchRequestService({
      db: client, engine: () => ({ resumeRun: async () => {} }),
      modelClient: () => { throw new Error("No direct model call expected"); },
    });
    const admitted = client.immediateTransaction(() => service.admitRequest(sessionId, repository.getSession(sessionId)!.revision, {
      type: "request-research", kind: "new-question", question: "What do smaller buyers try?",
      baseSnapshotId: snapshotId, model: { providerId: "openai-subscription", modelId: "test-model" },
      reasoningEffort: "medium", allowance: { maxModelCalls: 7, maxSearches: 4, maxMinutes: 10 },
      instructions: "Use attributable buyer reports.",
    }));
    const children = repository.listWorkItems(sessionId).filter((item) => item.parentItemId === admitted.workItemId);
    expect(children).toHaveLength(4);
    expect(children.map((item) => item.state)).toEqual(["ready", "ready", "skipped", "skipped"]);
    expect(service.listRequests(sessionId)[0]?.angles?.map((angle) => angle.status))
      .toEqual(["planned", "planned", "omitted", "omitted"]);
    expect((repository.getWorkItem(admitted.workItemId)?.input as { action: { instructions: string } }).action.instructions)
      .toBe("Use attributable buyer reports.");
    client.close();
  });

  test("late queued research stops before dispatch when the project time is exhausted", async () => {
    const { client, repository, sessionId, snapshotId } = workflowFixture();
    const dispatched: string[] = [];
    const service = new ResearchRequestService({
      db: client, engine: () => ({ resumeRun: async (id: string) => { dispatched.push(id); } }),
      modelClient: () => { throw new Error("No direct model call expected"); },
    });
    const action = (question: string) => ({
      type: "request-research" as const, kind: "new-question" as const, question,
      baseSnapshotId: snapshotId, model: { providerId: "openai-subscription" as const, modelId: "test-model" },
      reasoningEffort: "medium", allowance: { maxModelCalls: 12, maxSearches: 10, maxMinutes: 10 },
    });
    const first = client.immediateTransaction(() => service.admitRequest(sessionId, repository.getSession(sessionId)!.revision, action("First")));
    const second = client.immediateTransaction(() => service.admitRequest(sessionId, repository.getSession(sessionId)!.revision, action("Second")));
    await service.dispatchReady(sessionId);
    expect(dispatched).toHaveLength(1);
    client.immediateTransaction(() => repository.updateSession(sessionId, repository.getSession(sessionId)!.revision, {
      remainingMs: 4 * 60_000, runningSince: new Date().toISOString(),
    }));
    const runId = (repository.getWorkItem(first.workItemId)!.outputRefs as { runId: string }).runId;
    client.db.prepare("UPDATE research_runs SET status = 'completed' WHERE id = ?").run(runId);
    await service.handleRunEvent({ type: "run-completed", runId, threadId: "project-1", problemId: null });
    expect(dispatched).toHaveLength(1);
    expect(repository.getWorkItem(second.workItemId)?.state).toBe("failed");
    expect(repository.getSession(sessionId)?.state).toBe("waiting-for-review");
    client.close();
  });

  test("a request queued behind discovery dispatches after its research task settles", async () => {
    const { client, repository, sessionId, snapshotId } = workflowFixture();
    const dispatched: string[] = [];
    const service = new ResearchRequestService({
      db: client, engine: () => ({ resumeRun: async (id: string) => { dispatched.push(id); } }),
      modelClient: () => { throw new Error("No direct model call expected"); },
    });
    const discoveryId = client.immediateTransaction(() => repository.createWorkItem({
      sessionId, kind: "discovery", scopeKey: "active-discovery", state: "ready", input: {},
    }).id);
    const request = client.immediateTransaction(() => service.admitRequest(sessionId, repository.getSession(sessionId)!.revision, {
      type: "request-research", kind: "new-question", question: "What do buyers try now?",
      baseSnapshotId: snapshotId, model: { providerId: "openai-subscription", modelId: "test-model" },
      reasoningEffort: "medium", allowance: { maxModelCalls: 12, maxSearches: 10, maxMinutes: 10 },
    }));
    await service.dispatchReady(sessionId);
    expect(dispatched).toHaveLength(0);
    client.immediateTransaction(() => {
      repository.updateWorkItem(discoveryId, "skipped");
      repository.updateSession(sessionId, repository.getSession(sessionId)!.revision, {
        state: "waiting-for-review", runningSince: null,
      });
    });
    await service.dispatchReady(sessionId);
    expect(dispatched).toHaveLength(1);
    expect(repository.getSession(sessionId)?.state).toBe("running");
    expect(repository.getWorkItem(request.workItemId)?.state).toBe("running");
    client.close();
  });

  test("a finished Babysit session continues through a linked snapshot without rewriting history", () => {
    const { client, repository, sessionId, snapshotId, oldProblemId } = workflowFixture();
    client.immediateTransaction(() => repository.updateSession(sessionId, repository.getSession(sessionId)!.revision, {
      state: "finished", outcome: "partial",
    }));
    const prior = repository.getSession(sessionId)!;
    const service = new ResearchRequestService({
      db: client, engine: () => ({ resumeRun: async () => {} }),
      modelClient: () => { throw new Error("No direct model call expected"); },
    });
    const continued = client.immediateTransaction(() => service.continueFinishedSession(sessionId, prior.revision, {
      type: "request-research", kind: "redo", question: "Find stronger buyer evidence",
      targetFindingId: oldProblemId, baseSnapshotId: snapshotId,
      model: { providerId: "openai-subscription", modelId: "test-model" }, reasoningEffort: "medium",
      allowance: { maxModelCalls: 12, maxSearches: 10, maxMinutes: 10 },
    }));
    expect(continued.session.id).not.toBe(sessionId);
    expect(continued.session.state).toBe("running");
    expect(repository.getSession(sessionId)).toEqual(prior);
    const linked = repository.getSnapshot(continued.session.activeSnapshotId!)!;
    expect(linked.parentSnapshotId).toBe(snapshotId);
    expect(linked.sessionId).toBe(continued.session.id);
    expect(linked.selection.problemIds).toHaveLength(1);
    const input = repository.getWorkItem(continued.workItemId)!.input as { action: { targetFindingId: string; baseSnapshotId: string } };
    expect(input.action.targetFindingId).toBe(linked.selection.problemIds[0]!);
    expect(input.action.baseSnapshotId).toBe(linked.id);
    client.close();
  });

  test("a finished Vibe session accepts explicit research and Apply closes only the linked review", () => {
    const { client, repository, sessionId, snapshotId } = workflowFixture({ mode: "vibe", maxSearches: 0 });
    client.immediateTransaction(() => repository.updateSession(sessionId, repository.getSession(sessionId)!.revision, {
      state: "finished", outcome: "partial",
    }));
    const original = repository.getSession(sessionId)!;
    const service = new ResearchRequestService({
      db: client, engine: () => ({ resumeRun: async () => {} }),
      modelClient: () => { throw new Error("No model call expected"); },
    });
    const continued = client.immediateTransaction(() => service.continueFinishedSession(sessionId, original.revision, {
      type: "request-research", kind: "new-question", question: "What changed in buyer approval?",
      baseSnapshotId: snapshotId,
      model: { providerId: "openai-subscription", modelId: "test-model" }, reasoningEffort: "medium",
      allowance: { maxModelCalls: 12, maxSearches: 2, maxMinutes: 10 },
    }));
    expect(continued.session.mode).toBe("babysit");
    expect(continued.session.purpose).toBe("research-followup");
    expect(continued.session.contract).toMatchObject({ mode: "babysit", purpose: "research-followup",
      limits: { maxModelCalls: 12, maxSearches: 2, maxMinutes: 10 } });
    expect(continued.session.remainingMs).toBe(10 * 60_000);
    expect(repository.getSession(sessionId)).toEqual(original);
    const linkedId = continued.session.activeSnapshotId!;
    saveFinding(client, "run-new", "new-vibe-finding", "source-vibe", "factor-vibe", "Buyers now approve in-app");
    client.immediateTransaction(() => {
      repository.updateWorkItem(continued.workItemId, "running");
      repository.updateWorkItem(continued.workItemId, "succeeded", {
        outputRefs: { runId: "run-new", problemIds: ["new-vibe-finding"] },
      });
    });
    const queued = client.immediateTransaction(() => repository.createWorkItem({
      sessionId: continued.session.id, kind: "research-request", scopeKey: "queued-second-question",
      state: "ready", input: { action: { type: "request-research", kind: "new-question",
        question: "What alternatives remain?" }, baseSnapshotId: linkedId },
    }));
    const beforeApply = repository.getSession(continued.session.id)!;
    expect(() => client.immediateTransaction(() => service.applyResearch(continued.session.id, beforeApply.revision, {
      type: "apply-research", baseSnapshotId: linkedId, includedRequestIds: [continued.workItemId], replacements: [],
    }))).toThrow("Wait for every research request to settle");
    client.immediateTransaction(() => repository.updateWorkItem(queued.id, "skipped"));
    const applied = client.immediateTransaction(() => service.applyResearch(continued.session.id, beforeApply.revision, {
      type: "apply-research", baseSnapshotId: linkedId, includedRequestIds: [continued.workItemId], replacements: [],
    }));
    expect(applied.session).toMatchObject({ state: "finished", outcome: "partial", activeSnapshotId: applied.snapshot.id });
    expect(applied.snapshot.parentSnapshotId).toBe(linkedId);
    expect(applied.snapshot.selection.problemIds).toHaveLength(2);
    expect(repository.getActiveSession("project-1")).toBeNull();
    expect(repository.getSession(sessionId)).toEqual(original);
    expect(repository.listWorkItems(continued.session.id).filter((item) => item.kind === "generate-ideas")).toEqual([]);
    const coordinator = new WorkflowCoordinator({ db: client, engine: () => { throw new Error("No generation expected"); },
      capabilities: async () => ({ nativeConnected: false, searchReady: { exa: false, perplexity: false }, modelOptions: [] }),
      listProblems: () => [], onProgress: () => {} });
    expect(coordinator.summary(continued.session.id)).toMatchObject({ researchApplied: true,
      stopReason: "Selected research was applied to a new evidence snapshot." });
    expect(coordinator.summary(sessionId).researchApplied).toBeUndefined();
    client.close();
  });

  test("keeping a no-result Vibe follow-up settles only after every completed request is reviewed", async () => {
    const { client, repository, sessionId, snapshotId } = workflowFixture({ mode: "vibe", maxSearches: 0 });
    client.immediateTransaction(() => repository.updateSession(sessionId, repository.getSession(sessionId)!.revision, {
      state: "finished", outcome: "target-met",
    }));
    const original = repository.getSession(sessionId)!;
    const service = new ResearchRequestService({ db: client,
      engine: () => ({ resumeRun: async () => {} }),
      modelClient: () => { throw new Error("No research dispatch expected"); },
    });
    const continued = client.immediateTransaction(() => service.continueFinishedSession(sessionId, original.revision, {
      type: "request-research", kind: "redo", question: "Find newer evidence",
      targetFindingId: original.activeSnapshotId ? repository.getSnapshot(original.activeSnapshotId)!.selection.problemIds[0]! : "",
      baseSnapshotId: snapshotId, model: { providerId: "openai-subscription", modelId: "test-model" },
      reasoningEffort: "medium", allowance: { maxModelCalls: 5, maxSearches: 2, maxMinutes: 10 },
    }));
    const second = client.immediateTransaction(() => {
      repository.updateWorkItem(continued.workItemId, "running");
      repository.updateWorkItem(continued.workItemId, "succeeded", { outputRefs: { runId: "run-new", problemIds: [] } });
      const item = repository.createWorkItem({ sessionId: continued.session.id, kind: "research-request",
        scopeKey: "another-finished-question", state: "ready",
        input: { action: { type: "request-research", kind: "new-question", question: "Any other new evidence?" },
          baseSnapshotId: continued.session.activeSnapshotId } });
      repository.updateWorkItem(item.id, "running");
      repository.updateWorkItem(item.id, "succeeded", { outputRefs: { runId: "run-new", problemIds: [] } });
      repository.updateSession(continued.session.id, repository.getSession(continued.session.id)!.revision, {
        state: "waiting-for-review", runningSince: null,
      });
      return item;
    });
    const foreign = client.immediateTransaction(() => {
      const item = repository.createWorkItem({ sessionId, kind: "research-request", scopeKey: "older-session-question",
        state: "ready", input: { action: { type: "request-research", kind: "new-question", question: "Earlier question" },
          baseSnapshotId: snapshotId } });
      repository.updateWorkItem(item.id, "running");
      repository.updateWorkItem(item.id, "succeeded", { outputRefs: { runId: "run-old", problemIds: [] } });
      return item;
    });
    const coordinator = new WorkflowCoordinator({ db: client,
      engine: () => { throw new Error("No generation expected"); },
      capabilities: async () => ({ nativeConnected: false, searchReady: { exa: false, perplexity: false }, modelOptions: [] }),
      listProblems: () => [], onProgress: () => {}, researchService: service,
    });
    const before = repository.getSession(continued.session.id)!;
    const command = { threadId: "project-1", sessionId: continued.session.id,
      expectedRevision: before.revision, clientCommandId: "keep-first-result",
      action: { type: "keep-research", requestId: continued.workItemId, baseSnapshotId: before.activeSnapshotId } };
    const first = await coordinator.command(command);
    expect(first.summary.state).toBe("waiting-for-review");
    expect(first.summary.researchApplied).toBeUndefined();
    expect(first.summary.activeSnapshotId).toBe(before.activeSnapshotId);
    expect(service.listRequests(continued.session.id).find((item) => item.id === continued.workItemId))
      .toMatchObject({ status: "completed", reviewDecision: "kept-current", resultFindings: [] });
    expect(repository.getWorkItem(continued.workItemId)?.outputRefs)
      .toMatchObject({ runId: "run-new", problemIds: [], reviewDecision: "kept-current" });
    await expect(coordinator.command({ ...command, clientCommandId: "stale-keep", action: {
      type: "keep-research", requestId: second.id, baseSnapshotId: before.activeSnapshotId,
    } })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await expect(coordinator.command({ ...command, expectedRevision: first.revision, clientCommandId: "foreign-keep",
      action: { type: "keep-research", requestId: foreign.id, baseSnapshotId: before.activeSnapshotId },
    })).rejects.toMatchObject({ code: "INVALID_REFERENCE" });
    const finished = await coordinator.command({ ...command, expectedRevision: first.revision,
      clientCommandId: "keep-second-result",
      action: { type: "keep-research", requestId: second.id, baseSnapshotId: before.activeSnapshotId } });
    expect(finished.summary).toMatchObject({ state: "finished", outcome: "partial",
      activeSnapshotId: before.activeSnapshotId });
    expect(finished.summary.researchApplied).toBeUndefined();
    expect(finished.summary.stopReason).toContain("Current research was kept");
    expect(repository.listSnapshots(continued.session.id)).toHaveLength(1);
    expect(repository.getSession(sessionId)).toEqual(original);
    client.close();
  });

  test("keeping research in an initial Babysit checkpoint preserves the generation choice", () => {
    const { client, repository, sessionId, snapshotId } = workflowFixture();
    const item = client.immediateTransaction(() => {
      const created = repository.createWorkItem({ sessionId, kind: "research-request", scopeKey: "unhelpful-question",
        state: "ready", input: { action: { type: "request-research", kind: "new-question", question: "Any more evidence?" },
          baseSnapshotId: snapshotId } });
      repository.updateWorkItem(created.id, "running");
      repository.updateWorkItem(created.id, "succeeded", { outputRefs: { runId: "run-new", problemIds: [] } });
      return created;
    });
    const service = new ResearchRequestService({ db: client,
      engine: () => ({ resumeRun: async () => {} }),
      modelClient: () => { throw new Error("No research dispatch expected"); },
    });
    const current = repository.getSession(sessionId)!;
    const kept = client.immediateTransaction(() => service.keepResearch(sessionId, current.revision, {
      type: "keep-research", requestId: item.id, baseSnapshotId: snapshotId,
    }));
    expect(kept.session).toMatchObject({ state: "waiting-for-review", activeSnapshotId: snapshotId, outcome: null });
    expect(service.listRequests(sessionId).find((request) => request.id === item.id)?.reviewDecision).toBe("kept-current");
    client.close();
  });

  test("keeping one result does not turn an uncertain sibling into ordinary partial completion", () => {
    const { client, repository, sessionId, snapshotId, oldProblemId } = workflowFixture({ mode: "vibe" });
    client.immediateTransaction(() => repository.updateSession(sessionId, repository.getSession(sessionId)!.revision, {
      state: "finished", outcome: "target-met",
    }));
    const service = new ResearchRequestService({ db: client,
      engine: () => ({ resumeRun: async () => {} }),
      modelClient: () => { throw new Error("No research dispatch expected"); },
    });
    const continued = client.immediateTransaction(() => service.continueFinishedSession(sessionId,
      repository.getSession(sessionId)!.revision, {
        type: "request-research", kind: "redo", question: "Check newer evidence",
        targetFindingId: oldProblemId, baseSnapshotId: snapshotId,
        model: { providerId: "openai-subscription", modelId: "test-model" }, reasoningEffort: "medium",
        allowance: { maxModelCalls: 5, maxSearches: 2, maxMinutes: 10 },
      }));
    client.immediateTransaction(() => {
      repository.updateWorkItem(continued.workItemId, "running");
      repository.updateWorkItem(continued.workItemId, "succeeded", { outputRefs: { runId: "run-new", problemIds: [] } });
      const uncertain = repository.createWorkItem({ sessionId: continued.session.id, kind: "research-request",
        scopeKey: "uncertain-sibling", state: "ready",
        input: { action: { type: "request-research", kind: "new-question", question: "Another question" },
          baseSnapshotId: continued.session.activeSnapshotId } });
      repository.updateWorkItem(uncertain.id, "running");
      repository.updateWorkItem(uncertain.id, "unknown", { error: { message: "Provider completion is uncertain." } });
      repository.updateSession(continued.session.id, repository.getSession(continued.session.id)!.revision, {
        state: "waiting-for-review", runningSince: null,
      });
    });
    const current = repository.getSession(continued.session.id)!;
    const kept = client.immediateTransaction(() => service.keepResearch(current.id, current.revision, {
      type: "keep-research", requestId: continued.workItemId, baseSnapshotId: current.activeSnapshotId!,
    }));
    expect(kept.session).toMatchObject({ state: "waiting-for-review", outcome: null });
    expect(repository.listWorkItems(current.id).find((item) => item.state === "unknown")).toBeDefined();
    client.close();
  });

  test("applying one result cannot settle a follow-up with an uncertain sibling", () => {
    const { client, repository, sessionId, snapshotId } = workflowFixture({ mode: "vibe" });
    client.immediateTransaction(() => repository.updateSession(sessionId, repository.getSession(sessionId)!.revision, {
      state: "finished", outcome: "target-met",
    }));
    const service = new ResearchRequestService({ db: client,
      engine: () => ({ resumeRun: async () => {} }),
      modelClient: () => { throw new Error("No research dispatch expected"); },
    });
    const continued = client.immediateTransaction(() => service.continueFinishedSession(sessionId,
      repository.getSession(sessionId)!.revision, {
        type: "request-research", kind: "new-question", question: "Any new buying evidence?",
        baseSnapshotId: snapshotId, model: { providerId: "openai-subscription", modelId: "test-model" },
        reasoningEffort: "medium", allowance: { maxModelCalls: 5, maxSearches: 2, maxMinutes: 10 },
      }));
    saveFinding(client, "run-new", "new-apply-finding", "new-apply-source", "new-apply-factor", "Buyers approved a new workflow");
    client.immediateTransaction(() => {
      repository.updateWorkItem(continued.workItemId, "running");
      repository.updateWorkItem(continued.workItemId, "succeeded", {
        outputRefs: { runId: "run-new", problemIds: ["new-apply-finding"] },
      });
      const uncertain = repository.createWorkItem({ sessionId: continued.session.id, kind: "research-request",
        scopeKey: "unknown-sibling-for-apply", state: "ready",
        input: { action: { type: "request-research", kind: "new-question", question: "Another question" },
          baseSnapshotId: continued.session.activeSnapshotId } });
      repository.updateWorkItem(uncertain.id, "running");
      repository.updateWorkItem(uncertain.id, "unknown", { error: { message: "Provider completion is uncertain." } });
      repository.updateSession(continued.session.id, repository.getSession(continued.session.id)!.revision, {
        state: "waiting-for-review", runningSince: null,
      });
    });
    const before = repository.getSession(continued.session.id)!;
    expect(() => client.immediateTransaction(() => service.applyResearch(before.id, before.revision, {
      type: "apply-research", baseSnapshotId: before.activeSnapshotId!,
      includedRequestIds: [continued.workItemId], replacements: [],
    }))).toThrow("Wait for every research request to settle");
    expect(repository.getSession(before.id)).toEqual(before);
    expect(repository.listSnapshots(before.id)).toHaveLength(1);
    client.close();
  });
});

test("finished Babysit research command survives backend reopening with linked request history", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scraply-research-continuation-api-"));
  const { client, repository, sessionId, snapshotId, oldProblemId } = workflowFixture({}, directory);
  const oldRequestId = client.immediateTransaction(() => {
    const oldRequest = repository.createWorkItem({ sessionId, kind: "research-request",
      scopeKey: "earlier-buyer-question", state: "ready", input: {
        action: { type: "request-research", kind: "new-question", question: "How do buyers file today?" },
        baseSnapshotId: snapshotId,
      } });
    repository.updateWorkItem(oldRequest.id, "running", { outputRefs: { problemIds: [oldProblemId] } });
    repository.updateWorkItem(oldRequest.id, "succeeded", { outputRefs: { problemIds: [oldProblemId] } });
    repository.updateSession(sessionId, repository.getSession(sessionId)!.revision, {
      state: "finished", outcome: "partial",
    });
    return oldRequest.id;
  });
  const prior = repository.getSession(sessionId)!;
  client.setSetting("active_thread_id", "project-1");
  client.close();
  const errors: string[] = [];
  const context = {
    dataDir: directory, dbPath: join(directory, "scraply.db"),
    bundledPromptsDir: join(process.cwd(), "prompts"), promptOverridesDir: join(directory, "prompts"),
    appVersion: "test", getSecrets: () => ({ exaApiKey: null }), log: (entry: { error?: unknown }) => {
      if (entry.error) errors.push(String(entry.error));
    },
    providerValidation: { inspectNative: async () => ({
      available: true, connected: true, accounts: [{ providerId: "openai-subscription" }],
      models: [{ providerId: "openai-subscription", modelId: "gpt-6-sol", displayName: "Test model",
        defaultReasoningEffort: "medium", reasoningEfforts: [{ id: "medium", description: "Medium" }] }],
    }) },
  };
  let backend: BackendHandle | null = null;
  try {
    backend = await startBackend(context, () => {});
    const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${backend!.port}${path}`, {
      method: "POST", headers: { authorization: `Bearer ${backend!.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const response = await post("/workflows/command", {
      threadId: "project-1", sessionId, expectedRevision: prior.revision,
      clientCommandId: "research-after-finish", action: {
        type: "request-research", kind: "redo", question: "Find stronger buyer reports",
        targetFindingId: oldProblemId, baseSnapshotId: snapshotId,
        model: { providerId: "openai-subscription", modelId: "gpt-6-sol" }, reasoningEffort: "medium",
        allowance: { maxModelCalls: 12, maxSearches: 10, maxMinutes: 10 },
      },
    });
    expect(response.status).toBe(200);
    const receipt = WorkflowAdmissionReceiptSchema.parse((await response.json() as { data: unknown }).data);
    expect(receipt.sessionId).not.toBe(sessionId);
    await backend.close();
    backend = await startBackend(context, () => {});
    const workspaceResponse = await fetch(`http://127.0.0.1:${backend.port}/workspace`, {
      headers: { authorization: `Bearer ${backend.token}` },
    });
    if (workspaceResponse.status !== 200) throw new Error(`Workspace returned ${workspaceResponse.status}: ${await workspaceResponse.text()}; ${errors.join("; ")}`);
    const workspace = (await workspaceResponse.json() as { data: {
      activeWorkflow: { sessionId: string; activeSnapshotId: string } | null;
      researchRequests: Array<{ id: string; archived?: boolean; question: string }>;
    } }).data;
    expect(workspace.activeWorkflow?.sessionId).toBe(receipt.sessionId);
    expect(workspace.activeWorkflow?.activeSnapshotId).not.toBe(snapshotId);
    expect(workspace.researchRequests).toContainEqual(expect.objectContaining({
      id: oldRequestId, archived: true, question: "How do buyers file today?",
    }));
    expect(workspace.researchRequests).toContainEqual(expect.objectContaining({
      question: "Find stronger buyer reports",
    }));
    const check = new DatabaseClient(join(directory, "scraply.db"));
    expect(new WorkflowRepository(check).getSession(sessionId)).toEqual(prior);
    check.close();
  } finally {
    if (backend) await backend.close();
  }
});

function workflowFixture(options: { researchInstruction?: string; auditResearchText?: string;
  mode?: "babysit" | "vibe"; maxSearches?: number } = {}, directory?: string): {
  client: DatabaseClient; repository: WorkflowRepository; sessionId: string; snapshotId: string; oldProblemId: string;
} {
  const client = setup(directory);
  saveFinding(client, "run-old", "old", "source-old", "factor-old", "Small teams file manually");
  const repository = new WorkflowRepository(client);
  const sessionId = "workflow-session";
  client.immediateTransaction(() => repository.createSession({
    id: sessionId, threadId: "project-1", purpose: "discovery", mode: options.mode ?? "babysit",
    contract: {
      contractVersion: 1, purpose: "discovery", mode: options.mode ?? "babysit", brief: "Research manual filing",
      scope: { title: "Operations", audience: "Small teams", domain: "Filing", observations: "Manual entries repeat", offLimits: [] },
      runConfig: DEFAULT_RUN_CONFIG,
      targets: { kind: "per-problem", ideaCount: 3 },
      limits: { maxMinutes: 60, maxModelCalls: 50, maxSearches: options.maxSearches ?? 30 },
      instructions: { ...(options.researchInstruction ? { research: options.researchInstruction } : {}) },
      resolvedInstructions: { research: options.auditResearchText ?? "", ideas: "", review: "" },
      instructionHashes: { research: "hash-research", ideas: "hash-ideas", review: "hash-review" },
    },
    remainingMs: 60 * 60_000,
  }));
  const snapshot = client.immediateTransaction(() => {
    const materialized = materializeResearchSnapshot(client, {
      threadId: "project-1", baseRunId: "run-old", sourceProblemIds: ["old"], sessionId,
    });
    const saved = repository.createSnapshot({
      sessionId, materializationRunId: materialized.runId,
      selection: { problemIds: materialized.problemIds, sourceProblemIds: ["old"] },
      originMap: materialized.originMap,
    });
    repository.updateSession(sessionId, 0, {
      state: "waiting-for-review", activeSnapshotId: saved.id, runningSince: null,
    });
    return saved;
  });
  return { client, repository, sessionId, snapshotId: snapshot.id, oldProblemId: snapshot.selection.problemIds[0]! };
}

function setup(directory = mkdtempSync(join(tmpdir(), "scraply-research-revision-"))): DatabaseClient {
  directories.push(directory);
  const client = new DatabaseClient(join(directory, "scraply.db"));
  const now = new Date().toISOString();
  client.db.prepare("INSERT INTO threads (id, title, status, created_at, updated_at) VALUES (?, ?, 'solutions-ready', ?, ?)")
    .run("project-1", "Project one", now, now);
  client.db.prepare("INSERT INTO threads (id, title, status, created_at, updated_at) VALUES (?, ?, 'solutions-ready', ?, ?)")
    .run("project-2", "Project two", now, now);
  for (const [runId, threadId] of [["run-old", "project-1"], ["run-new", "project-1"], ["run-foreign", "project-2"]]) {
    client.db.prepare(`INSERT INTO research_runs
      (id, thread_id, status, config_json, created_at, updated_at, workflow_version)
      VALUES (?, ?, 'completed', '{}', ?, ?, 2)`).run(runId, threadId, now, now);
  }
  return client;
}

function saveFinding(
  client: DatabaseClient, runId: string, problemId: string, sourceId: string,
  factorId: string, statement: string,
): void {
  const repository = new DiscoveryRepository(client);
  repository.persistScope(runId, {
    title: "Operations", audience: "Small teams", domain: "Filing",
    observations: "Manual entries repeat", offLimits: [],
  });
  saveRunFinding(client, runId, problemId, sourceId, factorId, statement);
}

function saveRunFinding(
  client: DatabaseClient, runId: string, problemId: string, sourceId: string,
  factorId: string, statement: string,
): void {
  const repository = new DiscoveryRepository(client);
  const retrievedText = "Teams repeat the same filing every week.";
  repository.persistFactors(runId, [{
    id: sourceId, providerSourceId: sourceId,
    canonicalUrl: "https://example.test/filing", title: "Filing report", retrievedText,
    author: null, publishedAt: null, contentHash: sha256(retrievedText),
    retrievedAt: "2026-09-20T00:00:00.000Z",
  }], [{
    id: factorId, subject: "Teams", behavior: "repeat filing", quote: retrievedText,
    sourceId, harvestMode: "domain", modelConfidence: 0.8,
  }]);
  repository.persistProblems(runId, [], [{
    id: problemId, statement, whyItPersists: "The tools are disconnected.",
    affected: "Teams", scaleEstimate: "Weekly", scaleBasisFactorId: factorId,
    factorIds: [factorId], verdict: "confirmed", verdictReason: "The report supports the claim.",
    verdictSourceIds: [sourceId], intendedBuyerEvidenceFactorIds: [factorId],
  }]);
}

function count(client: DatabaseClient, table: string, field: string, value: string): number {
  // The callers supply fixed table and column names from this fixture.
  return (client.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${field} = ?`)
    .get(value) as { count: number }).count;
}
