import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResearchEngine } from "../../src/core/research-engine";
import { materializeResearchSnapshot } from "../../src/core/research-revisions";
import { WorkflowCoordinator } from "../../src/core/workflow-coordinator";
import { DatabaseClient } from "../../src/db/client";
import { DiscoveryRepository } from "../../src/db/repositories/discovery";
import { ResearchRunRepository, type ResearchRunWorkflowLink } from "../../src/db/repositories/research-runs";
import { WorkflowRepository } from "../../src/db/repositories/workflows";
import { ProblemCandidateSchema } from "../../src/shared/ipc";
import { DEFAULT_RUN_CONFIG, type RunConfig } from "../../src/shared/schemas";
import { sha256 } from "../../src/shared/content-identity";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture(mode: "babysit" | "vibe", purpose: "discovery" | "known-problem" = "discovery") {
  const directory = mkdtempSync(join(tmpdir(), "scraply-admission-budget-")); directories.push(directory);
  const db = new DatabaseClient(join(directory, "test.db"));
  const repository = new WorkflowRepository(db);
  const now = new Date().toISOString();
  const model = { providerId: "fixture", modelId: "fixture-model" };
  const config = { ...DEFAULT_RUN_CONFIG, model };
  const scope = { title: "Filing", audience: "Shop owners", domain: "Invoices", observations: "Weekly delays", offLimits: [] };
  db.db.prepare("INSERT INTO threads (id,title,status,created_at,updated_at) VALUES ('project','Filing','researching',?,?)").run(now, now);
  const session = db.immediateTransaction(() => repository.createSession({ id: "session", threadId: "project", purpose, mode, remainingMs: 60 * 60_000,
    contract: { contractVersion: 1, purpose, mode, brief: "Research filing", scope, runConfig: config, ideas: { model, reasoningEffort: "medium" },
      targets: { kind: "per-problem", ideaCount: 1 }, limits: { enforced: true, maxMinutes: 60, maxModelCalls: 12, maxSearches: purpose === "known-problem" ? 0 : 5 },
      instructions: {}, resolvedInstructions: { research: "", ideas: "", review: "" }, instructionHashes: { research: "r", ideas: "i", review: "v" } } }));
  db.db.prepare(`INSERT INTO research_runs (id,thread_id,status,config_json,workflow_version,workflow_session_id,purpose,created_at,updated_at)
    VALUES ('source','project','completed',?,2,'session',?,?,?)`).run(JSON.stringify(config), purpose, now, now);
  const discovery = new DiscoveryRepository(db);
  discovery.persistScope("source", scope);
  const quote = "I repeat filing every week.";
  discovery.persistFactors("source", [{ id: "source-quote", providerSourceId: null, canonicalUrl: "https://owners.example/filing", title: "Owner account",
    retrievedText: quote, author: null, publishedAt: null, contentHash: sha256(quote), retrievedAt: now }],
    [{ id: "factor", sourceId: "source-quote", subject: "Shop owner", behavior: "Repeats filing", quote, harvestMode: "domain", modelConfidence: 0.8,
      sourceRole: "firsthand", audienceFit: "intended-buyer", independentSourceKey: "shop-owner", supportsDemand: false }]);
  discovery.persistProblems("source", [], [{ id: "problem", statement: "Owners repeat filing", whyItPersists: "Disconnected tools", affected: "Shop owners",
    scaleEstimate: "Weekly", scaleBasisFactorId: "factor", factorIds: ["factor"], verdict: "confirmed", verdictReason: "Owner account", verdictSourceIds: ["source-quote"],
    intendedBuyerEvidenceFactorIds: ["factor"], evidenceGap: null }]);
  const candidate = ProblemCandidateSchema.parse({ id: "problem", statement: "Owners repeat filing", whyItPersists: "Disconnected tools", affected: "Shop owners",
    scaleEstimate: "Weekly", verdict: "confirmed", verdictReason: "Owner account", selected: false,
    intendedBuyerEvidenceFactorIds: ["factor"], evidenceGap: null, briefFit: "direct", contraryEvidence: "resolved", singleHarvestModeWarning: false, developmentCompleted: false,
    factors: [{ id: "factor", subject: "Shop owner", behavior: "Repeats filing", quote, sourceId: "source-quote", sourceTitle: "Owner account",
      sourceUrl: "https://owners.example/filing", harvestMode: "domain", modelConfidence: 0.8, sourceRole: "firsthand", audienceFit: "intended-buyer", independentSourceKey: "shop-owner" }] });
  const engine = new ResearchEngine({ db, modelClients: {}, searchClients: {}, onEvent() {} });
  const allowance = engine as unknown as { remainingWorkflowTaskCalls: (active: { runId: string }, kind: "model-call" | "search") => number | null };
  const dispatched: Array<{ runId: string; models: number | null; searches: number }> = [];
  const dispatcher = { startSelectedProblem: async (threadId: string, problemId: string, runConfig: RunConfig, link: ResearchRunWorkflowLink) => {
    const run = new ResearchRunRepository(db).create(threadId, runConfig, problemId, randomUUID(), link);
    link.onRunCreated?.(run.runId);
    const task = repository.listWorkItems(session.id).find(item => (item.outputRefs as { runId?: string } | null)?.runId === run.runId)!;
    const searches = purpose === "known-problem" ? 0 : allowance.remainingWorkflowTaskCalls({ runId: run.runId }, "search")!;
    dispatched.push({ runId: run.runId, models: allowance.remainingWorkflowTaskCalls({ runId: run.runId }, "model-call"), searches });
    expect(repository.listBudgetEntries(session.id).filter(entry => entry.workItemId === task.id && entry.kind === "search")
      .reduce((total, entry) => total + entry.reservedUnits, 0)).toBe(searches);
    return run.runId;
  } };
  const coordinator = new WorkflowCoordinator({ db, engine: () => dispatcher as unknown as ResearchEngine, listProblems: () => [candidate], onProgress() {},
    capabilities: async () => ({ nativeConnected: true, searchReady: { exa: purpose === "discovery", perplexity: false },
      modelOptions: [{ ...model, displayName: "Fixture", defaultReasoningEffort: "medium", reasoningEfforts: [{ id: "medium", description: "Default" }] }] }) });
  return { db, repository, session, model, coordinator, dispatched, engine };
}

test.each(["babysit", "vibe"] as const)("bounded %s generation receives its admitted novelty searches", async mode => {
  const f = fixture(mode);
  try {
    if (mode === "babysit") {
      const snapshot = f.db.immediateTransaction(() => {
        const copied = materializeResearchSnapshot(f.db, { threadId: "project", baseRunId: "source", sourceProblemIds: ["problem"], sessionId: f.session.id });
        const saved = f.repository.createSnapshot({ sessionId: f.session.id, materializationRunId: copied.runId, selection: { problemIds: copied.problemIds }, originMap: copied.originMap });
        f.repository.updateSession(f.session.id, f.session.revision, { state: "waiting-for-review", activeSnapshotId: saved.id, runningSince: null });
        return saved;
      });
      await f.coordinator.command({ threadId: "project", sessionId: f.session.id, clientCommandId: "generate", expectedRevision: f.coordinator.summary(f.session.id).revision,
        action: { type: "generate-ideas", snapshotId: snapshot.id, problemIds: snapshot.selection.problemIds, model: f.model, reasoningEffort: "medium", target: { kind: "per-problem", count: 1 } } });
    } else {
      f.db.immediateTransaction(() => {
        const task = f.repository.createWorkItem({ sessionId: f.session.id, kind: "discovery", scopeKey: "initial", input: {}, state: "ready" });
        f.repository.updateWorkItem(task.id, "running", { outputRefs: { runId: "source" } });
      });
      f.coordinator.handleRunEvent({ type: "run-completed", threadId: "project", runId: "source", problemId: null });
    }
    expect(f.dispatched).toEqual([{ runId: expect.any(String), models: 4, searches: 5 }]);
    expect(f.coordinator.summary(f.session.id).budget.searches).toMatchObject({ limit: 5, reserved: 5 });
  } finally { await f.engine.shutdown(); f.db.close(); }
});

test("bounded known-problem generation retains its zero-search path", async () => {
  const f = fixture("babysit", "known-problem");
  try {
    const snapshot = f.db.immediateTransaction(() => {
      const copied = materializeResearchSnapshot(f.db, { threadId: "project", baseRunId: "source", sourceProblemIds: ["problem"], sessionId: f.session.id });
      const saved = f.repository.createSnapshot({ sessionId: f.session.id, materializationRunId: copied.runId, selection: { problemIds: copied.problemIds }, originMap: copied.originMap });
      f.repository.updateSession(f.session.id, f.session.revision, { state: "waiting-for-review", activeSnapshotId: saved.id, runningSince: null });
      return saved;
    });
    await f.coordinator.command({ threadId: "project", sessionId: f.session.id, clientCommandId: "generate-known", expectedRevision: f.coordinator.summary(f.session.id).revision,
      action: { type: "generate-ideas", snapshotId: snapshot.id, problemIds: snapshot.selection.problemIds, model: f.model, reasoningEffort: "medium", target: { kind: "per-problem", count: 1 } } });
    expect(f.dispatched).toEqual([{ runId: expect.any(String), models: 4, searches: 0 }]);
    expect(f.coordinator.summary(f.session.id).budget.searches).toMatchObject({ limit: 0, reserved: 0 });
  } finally { await f.engine.shutdown(); f.db.close(); }
});

test("a bounded fill receives its own novelty reservation after the first result settles", async () => {
  const f = fixture("babysit");
  try {
    const snapshot = f.db.immediateTransaction(() => {
      const copied = materializeResearchSnapshot(f.db, { threadId: "project", baseRunId: "source", sourceProblemIds: ["problem"], sessionId: f.session.id });
      const saved = f.repository.createSnapshot({ sessionId: f.session.id, materializationRunId: copied.runId, selection: { problemIds: copied.problemIds }, originMap: copied.originMap });
      f.repository.updateSession(f.session.id, f.session.revision, { state: "waiting-for-review", activeSnapshotId: saved.id, runningSince: null });
      return saved;
    });
    await f.coordinator.command({ threadId: "project", sessionId: f.session.id, clientCommandId: "generate-fill", expectedRevision: f.coordinator.summary(f.session.id).revision,
      action: { type: "generate-ideas", snapshotId: snapshot.id, problemIds: snapshot.selection.problemIds, model: f.model, reasoningEffort: "medium", target: { kind: "per-problem", count: 1 } } });
    const first = f.dispatched[0]!;
    f.db.db.prepare("UPDATE research_runs SET status = 'completed' WHERE id = ?").run(first.runId);
    f.coordinator.handleRunEvent({ type: "run-completed", threadId: "project", runId: first.runId, problemId: snapshot.selection.problemIds[0]! });
    expect(f.dispatched).toHaveLength(2);
    expect(f.dispatched[1]).toMatchObject({ models: 4, searches: 5 });
    const fill = f.repository.listWorkItems(f.session.id).find(item => item.kind === "generate-ideas" && (item.input as { fillRound?: number }).fillRound === 1)!;
    expect(fill.state).toBe("running");
    expect(f.repository.listBudgetEntries(f.session.id).find(entry => entry.workItemId === fill.id && entry.kind === "search")?.reservedUnits).toBe(5);
  } finally { await f.engine.shutdown(); f.db.close(); }
});
