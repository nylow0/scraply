import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ResearchEngine } from "../../src/core/research-engine";
import { materializeResearchSnapshot } from "../../src/core/research-revisions";
import { WorkflowCoordinator } from "../../src/core/workflow-coordinator";
import { DatabaseClient } from "../../src/db/client";
import { DiscoveryRepository } from "../../src/db/repositories/discovery";
import { GenerationAttemptRepository } from "../../src/db/repositories/generation-attempts";
import { ActiveRunConflictError, ResearchRunRepository, type ResearchRunWorkflowLink } from "../../src/db/repositories/research-runs";
import { WorkflowRepository } from "../../src/db/repositories/workflows";
import { sha256 } from "../../src/shared/content-identity";
import { ProblemCandidateSchema } from "../../src/shared/ipc";
import { DEFAULT_RUN_CONFIG, type RunConfig } from "../../src/shared/schemas";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    try { rmSync(directory, { recursive: true, force: true }); }
    catch { /* Bun can retain a SQLite WAL handle briefly on Windows. */ }
  }
});

// A real coordinator and database with an engine stub that only creates, cancels and resumes runs.
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "scraply-side-by-side-ideas-")); directories.push(directory);
  const db = new DatabaseClient(join(directory, "test.db"));
  const repository = new WorkflowRepository(db);
  const runs = new ResearchRunRepository(db);
  const now = new Date().toISOString();
  const model = { providerId: "fixture", modelId: "fixture-model" };
  const config = { ...DEFAULT_RUN_CONFIG, model };
  const scope = { title: "Filing", audience: "Shop owners", domain: "Invoices", observations: "Weekly delays", offLimits: [] };
  db.db.prepare("INSERT INTO threads (id,title,status,created_at,updated_at) VALUES ('project','Filing','researching',?,?)").run(now, now);
  const session = db.immediateTransaction(() => repository.createSession({ id: "session", threadId: "project", purpose: "discovery", mode: "babysit",
    remainingMs: 60 * 60_000, contract: { contractVersion: 1, purpose: "discovery", mode: "babysit", brief: "Research filing", scope, runConfig: config,
      ideas: { model, reasoningEffort: "medium" }, targets: { kind: "per-problem", ideaCount: 1 },
      limits: { enforced: false, maxMinutes: 60, maxModelCalls: 100, maxSearches: 50 },
      instructions: {}, resolvedInstructions: { research: "", ideas: "", review: "" }, instructionHashes: { research: "r", ideas: "i", review: "v" } } }));
  db.db.prepare(`INSERT INTO research_runs (id,thread_id,status,config_json,workflow_version,workflow_session_id,purpose,created_at,updated_at)
    VALUES ('source','project','completed',?,2,'session','discovery',?,?)`).run(JSON.stringify(config), now, now);
  const discovery = new DiscoveryRepository(db);
  discovery.persistScope("source", scope);
  const quote = "I repeat filing every week.";
  const factor = { id: "factor", sourceId: "source-quote", subject: "Shop owner", behavior: "Repeats filing", quote, harvestMode: "domain" as const,
    modelConfidence: 0.8, sourceRole: "firsthand" as const, audienceFit: "intended-buyer" as const, independentSourceKey: "shop-owner" };
  discovery.persistFactors("source", [{ id: "source-quote", providerSourceId: null, canonicalUrl: "https://owners.example/filing", title: "Owner account",
    retrievedText: quote, author: null, publishedAt: null, contentHash: sha256(quote), retrievedAt: now }], [{ ...factor, supportsDemand: false }]);
  const problemIds = ["problem-1", "problem-2", "problem-3"];
  discovery.persistProblems("source", [], problemIds.map((id, index) => ({ id, statement: `Owners repeat filing step ${index + 1}`,
    whyItPersists: "Disconnected tools", affected: "Shop owners", scaleEstimate: "Weekly", scaleBasisFactorId: "factor", factorIds: ["factor"],
    verdict: "confirmed" as const, verdictReason: "Owner account", verdictSourceIds: ["source-quote"], intendedBuyerEvidenceFactorIds: ["factor"], evidenceGap: null })));
  const candidates = problemIds.map((id, index) => ProblemCandidateSchema.parse({ id, statement: `Owners repeat filing step ${index + 1}`,
    whyItPersists: "Disconnected tools", affected: "Shop owners", scaleEstimate: "Weekly", verdict: "confirmed", verdictReason: "Owner account", selected: false,
    intendedBuyerEvidenceFactorIds: ["factor"], evidenceGap: null, briefFit: "direct", contraryEvidence: "resolved", singleHarvestModeWarning: false,
    developmentCompleted: false, factors: [{ ...factor, sourceTitle: "Owner account", sourceUrl: "https://owners.example/filing" }] }));
  const dispatched: string[] = [];
  const cancelled: string[] = [];
  const resumed: string[] = [];
  const engine = {
    startSelectedProblem: async (threadId: string, problemId: string, runConfig: RunConfig, link: ResearchRunWorkflowLink) => {
      const run = runs.create(threadId, runConfig, problemId, randomUUID(), link);
      link.onRunCreated?.(run.runId);
      dispatched.push(run.runId);
      return run.runId;
    },
    cancelRun: (runId: string) => { cancelled.push(runId); runs.cancel(runId); },
    resumeRun: async (runId: string) => { resumed.push(runId); },
  };
  const coordinator = new WorkflowCoordinator({ db, engine: () => engine as unknown as ResearchEngine, listProblems: () => candidates, onProgress() {},
    capabilities: async () => ({ nativeConnected: true, searchReady: { exa: true, perplexity: false },
      modelOptions: [{ ...model, displayName: "Fixture", defaultReasoningEffort: "medium", reasoningEfforts: [{ id: "medium", description: "Default" }] }] }) });
  const ideaTasks = () => repository.listWorkItems(session.id).filter(item => item.kind === "generate-ideas");
  const runIdOf = (item: (ReturnType<typeof ideaTasks>)[number]) => (item.outputRefs as { runId: string }).runId;
  return {
    db, repository, runs, session, coordinator, dispatched, cancelled, resumed, ideaTasks, runIdOf,
    state: () => repository.getSession(session.id)!,
    async generate() {
      const snapshot = db.immediateTransaction(() => {
        const copied = materializeResearchSnapshot(db, { threadId: "project", baseRunId: "source", sourceProblemIds: problemIds, sessionId: session.id });
        const saved = repository.createSnapshot({ sessionId: session.id, materializationRunId: copied.runId, selection: { problemIds: copied.problemIds }, originMap: copied.originMap });
        repository.updateSession(session.id, session.revision, { state: "waiting-for-review", activeSnapshotId: saved.id, runningSince: null });
        return saved;
      });
      await coordinator.command({ threadId: "project", sessionId: session.id, clientCommandId: "generate", expectedRevision: coordinator.summary(session.id).revision,
        action: { type: "generate-ideas", snapshotId: snapshot.id, problemIds: snapshot.selection.problemIds, model, reasoningEffort: "medium", target: { kind: "per-problem", count: 1 } } });
      // Tasks in one batch start one after another.
      await Bun.sleep(5);
      return snapshot;
    },
    complete(runId: string) {
      runs.finish(runId, "completed");
      coordinator.handleRunEvent({ type: "run-completed", threadId: "project", runId, problemId: null });
    },
    fail(runId: string) {
      runs.finish(runId, "failed", "Model failed");
      coordinator.handleRunEvent({ type: "run-failed", threadId: "project", runId, error: "Model failed" });
    },
  };
}

test("idea tasks for several problems start together, and one that fails waits for the others to finish the session", async () => {
  const f = fixture();
  try {
    await f.generate();
    expect(f.dispatched).toHaveLength(3);
    expect(f.ideaTasks().map(item => item.state)).toEqual(["running", "running", "running"]);
    const [first, second, third] = f.ideaTasks().map(f.runIdOf);
    f.fail(first!);
    expect(f.state().state).toBe("running");
    expect(f.ideaTasks().map(item => item.state)).toEqual(["failed", "running", "running"]);
    f.complete(second!);
    expect(f.state().state).toBe("running");
    f.complete(third!);
    expect(f.state()).toMatchObject({ state: "finished", outcome: "partial" });
    expect(f.ideaTasks().map(item => item.state)).toEqual(["failed", "succeeded", "succeeded"]);
    expect(f.dispatched).toHaveLength(3);
  } finally { f.db.close(); }
});

test("stopping cancels every idea task running side by side and finishes once the last one reports back", async () => {
  const f = fixture();
  try {
    await f.generate();
    const runIds = f.ideaTasks().map(f.runIdOf);
    await f.coordinator.command({ threadId: "project", sessionId: f.session.id, clientCommandId: "stop", expectedRevision: f.state().revision,
      action: { type: "stop" } });
    expect(f.cancelled).toEqual(runIds);
    expect(f.state().state).toBe("stop-requested");
    for (const runId of runIds.slice(0, 2)) f.coordinator.handleRunEvent({ type: "run-cancelled", threadId: "project", runId });
    expect(f.state().state).toBe("stop-requested");
    f.coordinator.handleRunEvent({ type: "run-cancelled", threadId: "project", runId: runIds[2]! });
    expect(f.state()).toMatchObject({ state: "finished", outcome: "cancelled" });
    expect(f.ideaTasks().map(item => item.state)).toEqual(["cancelled", "cancelled", "cancelled"]);
  } finally { f.db.close(); }
});

test("restart recovery resumes idea tasks that ran side by side, or holds all of them when one may have finished", async () => {
  const f = fixture();
  try {
    await f.generate();
    const runIds = f.ideaTasks().map(f.runIdOf);
    f.coordinator.reconcileInterrupted();
    expect(f.state().state).toBe("paused");
    await f.coordinator.command({ threadId: "project", sessionId: f.session.id, clientCommandId: "resume", expectedRevision: f.state().revision,
      action: { type: "resume" } });
    await Bun.sleep(0);
    expect(f.resumed).toEqual(runIds);
    expect(f.state().state).toBe("running");

    // A call dispatched by the second task has no saved result: no task may continue without review.
    const attempts = new GenerationAttemptRepository(f.db);
    const attempt = attempts.prepare(runIds[1]!, { generationId: "lost-review", stage: "solution-set-review",
      model: { providerId: "fixture", modelId: "fixture-model" }, reasoningEffort: "medium", deadlineMs: 1_000, repairPolicy: "one_retry",
      workOrder: { stage: "solution-set-review", instruction: "Review.", goal: "Review ideas.", definitionOfDone: ["One review"] }, evidence: [],
      schema: z.object({ answer: z.string() }).strict(), jsonSchema: { type: "object" } }, {});
    attempts.markDispatched(attempt.id);
    f.coordinator.reconcileInterrupted();
    expect(f.state()).toMatchObject({ state: "finished", outcome: "needs-attention" });
    expect(f.ideaTasks().map(item => item.state)).toEqual(["unknown", "unknown", "unknown"]);
    expect(f.ideaTasks()[1]!.error).toMatchObject({ message: "A provider call may have completed while the app was closed." });
    expect(f.ideaTasks()[0]!.error).toMatchObject({ message: expect.stringContaining("running beside one that needs review") });
  } finally { f.db.close(); }
});

test("idea tasks saved without the side-by-side flag still run one at a time", async () => {
  const f = fixture();
  try {
    const snapshot = await f.generate();
    // Recreate the tasks the way an older version saved them, then resume the paused session.
    f.db.immediateTransaction(() => {
      for (const item of f.ideaTasks()) {
        f.runs.cancel(f.runIdOf(item));
        f.repository.updateWorkItem(item.id, "cancelled", { error: { message: "Fixture replaces these tasks." } });
      }
      for (const [index, problemId] of snapshot.selection.problemIds.entries()) {
        f.repository.createWorkItem({ sessionId: f.session.id, kind: "generate-ideas", scopeKey: `older:${index}`, state: "ready",
          input: { problemId, snapshotId: snapshot.id, quota: 1, model: { providerId: "fixture", modelId: "fixture-model" }, reasoningEffort: "medium",
            fillRound: 0, batch: 0, targetKind: "per-problem", requestedTarget: 3 } });
      }
      f.repository.updateSession(f.session.id, f.state().revision, { state: "paused", runningSince: null });
    });
    f.dispatched.length = 0;
    await f.coordinator.command({ threadId: "project", sessionId: f.session.id, clientCommandId: "resume-older", expectedRevision: f.state().revision,
      action: { type: "resume" } });
    await Bun.sleep(0);
    expect(f.dispatched).toHaveLength(1);
    f.complete(f.dispatched[0]!);
    await Bun.sleep(0);
    expect(f.dispatched).toHaveLength(2);
    expect(f.ideaTasks().filter(item => item.state === "running")).toHaveLength(1);
  } finally { f.db.close(); }
});

test("a project allows idea runs of one session side by side, and nothing else beside them", () => {
  const f = fixture();
  try {
    const config = { ...DEFAULT_RUN_CONFIG, model: { providerId: "fixture", modelId: "fixture-model" } };
    const link = { sessionId: f.session.id, purpose: "discovery" as const };
    f.runs.create("project", config, "problem-1", randomUUID(), link);
    f.runs.create("project", config, "problem-2", randomUUID(), link);
    expect(() => f.runs.create("project", config, null, randomUUID(), link)).toThrow(ActiveRunConflictError);
    expect(() => f.runs.create("project", config, "problem-3", randomUUID())).toThrow(ActiveRunConflictError);
    const now = new Date().toISOString();
    const insert = f.db.db.prepare(`INSERT INTO research_runs (id,thread_id,status,config_json,created_at,updated_at)
      VALUES (?,'project','running',?,?,?)`);
    insert.run("research-a", JSON.stringify(config), now, now);
    // The database still holds one active research run per project.
    expect(() => insert.run("research-b", JSON.stringify(config), now, now)).toThrow();
  } finally { f.db.close(); }
});

test("pausing waits for every idea task running side by side, and resuming continues the rest", async () => {
  const f = fixture();
  try {
    await f.generate();
    const runIds = f.ideaTasks().map(f.runIdOf);
    await f.coordinator.command({ threadId: "project", sessionId: f.session.id, clientCommandId: "pause", expectedRevision: f.state().revision,
      action: { type: "pause" } });
    f.complete(runIds[0]!);
    f.complete(runIds[1]!);
    expect(f.state().state).toBe("pause-requested");
    f.complete(runIds[2]!);
    expect(f.state().state).toBe("paused");
    expect(f.dispatched).toHaveLength(3);
  } finally { f.db.close(); }
});
