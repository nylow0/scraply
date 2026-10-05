import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WorkflowCoordinator } from "../../src/core/workflow-coordinator";
import { ResearchRequestService } from "../../src/core/research-request-service";
import { ResearchEngine } from "../../src/core/research-engine";
import { ensureAreaInvestigatorWorkItems } from "../../src/core/evidence-investigators";
import { configurePromptPaths } from "../../src/core/prompts";
import { materializeResearchSnapshot } from "../../src/core/research-revisions";
import { DatabaseClient } from "../../src/db/client";
import { DiscoveryRepository } from "../../src/db/repositories/discovery";
import { ResearchRunRepository, type ResearchRunWorkflowLink } from "../../src/db/repositories/research-runs";
import { WorkflowRepository } from "../../src/db/repositories/workflows";
import { ResearchFrameRepository } from "../../src/db/repositories/research-frames";
import { OpportunityExplorationRepository } from "../../src/db/repositories/opportunity-exploration";
import { DEFAULT_RUN_CONFIG, type RunConfig } from "../../src/shared/schemas";
import { SavedProblemCandidateSchema } from "../../src/shared/structured-output-schemas";
import { PreviewWorkflowResultSchema } from "../../src/shared/workflow-contracts";
import type { ProblemCandidate } from "../../src/shared/ipc";
import { sha256 } from "../../src/shared/content-identity";
import type { StructuredModelClient } from "../../src/providers/structured";
import type { Source } from "../../src/shared/schemas";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const scope = { title: "Filing", audience: "Shop owners", domain: "Invoices", observations: "Weekly delays", offLimits: [] };
const model = { providerId: "fixture", modelId: "fixture-model" };
const config = { ...DEFAULT_RUN_CONFIG, model, discoveryDepth: "quick" as const };

function fixture(maxModelCalls = 30, searchProvider: RunConfig["searchProvider"] = "exa", dispatchGate?: Promise<void>, client?: StructuredModelClient,
  search?: (query: string) => Promise<Source[]>) {
  const directory = mkdtempSync(join(tmpdir(), "scraply-candidate-workflow-")); directories.push(directory);
  const db = new DatabaseClient(join(directory, "test.db"));
  const now = new Date().toISOString();
  db.db.prepare("INSERT INTO threads (id,title,status,created_at,updated_at) VALUES ('project','Filing','solutions-ready',?,?)").run(now, now);
  db.db.prepare("INSERT INTO research_runs (id,thread_id,status,config_json,created_at,updated_at,workflow_version) VALUES ('source','project','completed',?,?,?,2)")
    .run(JSON.stringify(config), now, now);
  const discovery = new DiscoveryRepository(db);
  discovery.persistScope("source", scope);
  discovery.persistFactors("source", [{ id: "source-quote", providerSourceId: null, canonicalUrl: "https://example.test/filing", title: "An owner",
    retrievedText: "I repeat filing every week.", author: null, publishedAt: null, contentHash: sha256("I repeat filing every week."), retrievedAt: now }],
    [{ id: "factor", sourceId: "source-quote", subject: "Shop owner", behavior: "Repeats filing", quote: "I repeat filing every week.", harvestMode: "domain", modelConfidence: 0.8 }]);
  const candidate = { statement: "Owners lose time filing", whyItPersists: "Disconnected tools", affected: "Shop owners", scaleEstimate: "Unknown",
    scaleBasisFactorId: "factor", factorIds: ["factor"], alternativeExplanations: ["One shop uses old tools"], unknowns: ["Frequency outside this shop"],
    intendedBuyerEvidenceFactorIds: ["factor"], evidenceGap: "Second independent owner" };
  discovery.persistProblems("source", [], [{ id: "old-problem", statement: "Owners repeat entries", whyItPersists: "Disconnected tools", affected: "Shop owners",
    scaleEstimate: "Unknown", scaleBasisFactorId: "factor", factorIds: ["factor"], verdict: "confirmed", verdictReason: "Saved quote", verdictSourceIds: [] }],
    [candidate, { ...candidate, statement: "Owners chase invoices" }].map(value => ({ statement: value.statement, reason: "Depth limit", disposition: "not-assessed" as const, candidate: value })));
  db.db.prepare("UPDATE factors SET area_id = 'filing' WHERE research_run_id = 'source'").run();
  db.db.prepare("UPDATE problems SET area_id = 'filing' WHERE discovery_run_id = 'source'").run();
  const repository = new WorkflowRepository(db);
  const session = db.immediateTransaction(() => repository.createSession({ id: "session", threadId: "project", purpose: "discovery", mode: "babysit", remainingMs: 60 * 60_000,
    contract: { contractVersion: 1, purpose: "discovery", mode: "babysit", brief: "Research filing", scope, runConfig: { ...config, searchProvider },
      targets: { kind: "per-problem", ideaCount: 1 }, limits: { maxMinutes: 60, maxModelCalls, maxSearches: 20 }, instructions: {},
      resolvedInstructions: { research: "", ideas: "", review: "" }, instructionHashes: { research: "r", ideas: "i", review: "v" } } }));
  const snapshot = db.immediateTransaction(() => {
    const copy = materializeResearchSnapshot(db, { threadId: "project", baseRunId: "source", sourceProblemIds: ["old-problem"], sessionId: session.id });
    const saved = repository.createSnapshot({ sessionId: session.id, materializationRunId: copy.runId, selection: { problemIds: copy.problemIds }, originMap: copy.originMap });
    repository.updateSession(session.id, session.revision, { state: "waiting-for-review", activeSnapshotId: saved.id, runningSince: null });
    return saved;
  });
  const candidateRow = db.db.prepare("SELECT id,candidate_json FROM rejected_problem_candidates WHERE discovery_run_id = ? ORDER BY rowid LIMIT 1")
    .get(snapshot.materializationRunId) as { id: string; candidate_json: string };
  const dispatches: string[] = [];
  const errors: string[] = [];
  let notifyDispatch: () => void = () => undefined;
  const whenDispatched = new Promise<void>(resolve => { notifyDispatch = resolve; });
  const fakeEngine = { async startCandidateAssessment(threadId: string, _sourceRunId: string, _candidateId: string, _config: typeof config, link: ResearchRunWorkflowLink) {
    if (dispatchGate) await dispatchGate;
    const run = new ResearchRunRepository(db).create(threadId, config, null, randomUUID(), link);
    if (link.frameId) new ResearchFrameRepository(db).bindRun(run.runId, threadId, link.frameId);
    discovery.persistScope(run.runId, scope);
    link.onRunCreated?.(run.runId); dispatches.push(run.runId); notifyDispatch(); return run.runId;
  } } as unknown as ResearchEngine;
  const searches: string[] = [];
  if (client) configurePromptPaths({ bundledDir: join(process.cwd(), "prompts"), overrideDir: null });
  const realEngine = client ? new ResearchEngine({ db, modelClients: { fixture: client }, searchClients: { exa: {
    provider: "exa", async validateKey() { return { valid: true }; }, async search(query) { searches.push(query); return search ? search(query) : []; },
  } }, onEvent(event) {
    if (event.type === "run-started") { dispatches.push(event.runId); notifyDispatch(); }
    if (event.type === "run-failed") errors.push(event.error);
    coordinator.handleRunEvent(event);
  } }) : null;
  const coordinator = new WorkflowCoordinator({ db, engine: () => realEngine ?? fakeEngine, capabilities: async () => ({ nativeConnected: true, searchReady: { exa: true, perplexity: false },
    modelOptions: [{ ...model, displayName: "Fixture", defaultReasoningEffort: "medium", reasoningEfforts: [{ id: "medium", description: "Medium" }] }] }),
    listProblems: (_threadId, runId) => db.db.prepare("SELECT id FROM problems WHERE discovery_run_id = ? ORDER BY rowid").all(runId) as ProblemCandidate[], onProgress() {},
    onError(error) { errors.push(String(error)); } });
  return { db, repository, coordinator, snapshot, candidateRow, dispatches, searches, errors, whenDispatched, realEngine };
}

async function command(f: ReturnType<typeof fixture>) {
  const session = f.repository.getSession("session")!;
  const preview = PreviewWorkflowResultSchema.parse(await f.coordinator.preview({ type: "candidate-assessment", threadId: "project", sessionId: session.id,
    expectedRevision: session.revision, candidateId: f.candidateRow.id }));
  const request = { threadId: "project", sessionId: session.id, expectedRevision: session.revision, clientCommandId: "assess-command", action: {
    type: "assess-not-assessed", candidateId: f.candidateRow.id, previewHash: preview.previewHash, capabilityFingerprint: preview.capabilityFingerprint, previewExpiresAt: preview.expiresAt } };
  return { preview, request };
}

test("preview is read-only, and an insufficient allowance retains the full candidate without dispatch", async () => {
  const f = fixture(1);
  try {
    const before = f.repository.getSession("session");
    const { preview, request } = await command(f);
    expect(preview.minimumWork).toEqual({ modelCalls: 2, searches: 1 });
    expect(preview.proposal).toMatchObject({ frameId: null, frameVersion: null, assessmentFrameSource: "scope-derived" });
    expect(preview.fieldErrors).toContainEqual(expect.objectContaining({ code: "BUDGET_TOO_SMALL" }));
    expect(f.repository.getSession("session")).toEqual(before);
    await expect(f.coordinator.command(request)).rejects.toMatchObject({ code: "BUDGET_TOO_SMALL" });
    expect(f.dispatches).toEqual([]);
    expect(f.db.db.prepare("SELECT candidate_json FROM rejected_problem_candidates WHERE id = ?").get(f.candidateRow.id)).toEqual({ candidate_json: f.candidateRow.candidate_json });
  } finally { f.db.close(); }
});

test("candidate admission freezes the latest approved frame while source evidence keeps its original frame", async () => {
  let releaseDispatch: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { releaseDispatch = resolve; });
  const f = fixture(30, "exa", gate);
  try {
    const frames = new ResearchFrameRepository(f.db);
    const first = frames.createDraft({ threadId: "project", runId: "source", knownProblem: true, sources: [], frame: {
      goal: "Reduce filing delays", goalKind: "process-improvement", contextFacts: [],
      successCriteria: [{ id: "delay", name: "Less time filing", weight: "must", howJudged: "Observe time", basis: "brief" }],
      constraints: [], languages: ["en"], exclusions: [], openQuestions: [], areas: [],
    } });
    frames.approve(first.id, "project", first.draft);
    frames.bindRun(f.snapshot.materializationRunId, "project", first.id);
    const edited = frames.createApprovedVersion(first.id, "project", { ...first.draft, goal: "Reduce duplicate data entry",
      exclusions: ["Replacing accounting systems"], languages: ["en", "uk"] });
    const { preview, request } = await command(f);
    expect(preview.proposal).toMatchObject({ frameId: edited.id, frameVersion: edited.version, assessmentFrameSource: "approved" });
    await f.coordinator.command(request);
    const task = f.repository.listWorkItems("session").find(item => item.kind === "assess-candidate")!;
    expect(task.input).toMatchObject({ frameId: edited.id, frameVersion: edited.version, assessmentFrameSource: "approved",
      candidateId: f.candidateRow.id, sourceRunId: f.snapshot.materializationRunId });
    frames.createApprovedVersion(edited.id, "project", { ...edited.approved!, goal: "A later unrelated goal", exclusions: [] });
    releaseDispatch();
    await f.whenDispatched;
    expect(frames.forRun(f.dispatches[0]!)?.approved).toEqual(edited.approved);
    expect(frames.forRun(f.snapshot.materializationRunId)?.id).toBe(first.id);
    expect(f.db.db.prepare("SELECT candidate_json FROM rejected_problem_candidates WHERE id = ?").get(f.candidateRow.id))
      .toEqual({ candidate_json: f.candidateRow.candidate_json });
    expect(f.db.db.prepare("SELECT quote,area_id FROM factors WHERE research_run_id = 'source'").get())
      .toEqual({ quote: "I repeat filing every week.", area_id: "filing" });
  } finally { releaseDispatch(); f.db.close(); }
});

test("a frame edit after candidate preview requires a fresh review before assessment admission", async () => {
  const f = fixture();
  try {
    const { request } = await command(f);
    const frames = new ResearchFrameRepository(f.db);
    const first = frames.createDraft({ threadId: "project", runId: "source", knownProblem: true, sources: [], frame: {
      goal: "Reduce filing delays", goalKind: "process-improvement", contextFacts: [],
      successCriteria: [{ id: "delay", name: "Less time filing", weight: "must", howJudged: "Observe time", basis: "brief" }],
      constraints: [], languages: ["en"], exclusions: [], openQuestions: [], areas: [],
    } });
    frames.approve(first.id, "project", first.draft);
    await expect(f.coordinator.command(request)).rejects.toMatchObject({ code: "PREVIEW_STALE" });
    expect(f.dispatches).toEqual([]);
    expect(f.repository.listWorkItems("session")).toEqual([]);
  } finally { f.db.close(); }
});

test("automatic search accepts an available physical provider during candidate assessment preview", async () => {
  const f = fixture(30, "auto");
  try {
    const { preview } = await command(f);
    expect(preview.fieldErrors).toEqual([]);
    expect(f.dispatches).toEqual([]);
  } finally { f.db.close(); }
});

test("a final assessment adds its finding and preserves old findings and the remaining candidate's quoted graph", async () => {
  const f = fixture();
  try {
    const { request } = await command(f);
    await f.coordinator.command(request); await f.coordinator.command(request);
    expect(f.dispatches, JSON.stringify(f.errors)).toHaveLength(1);
    const runId = f.dispatches[0]!;
    f.db.db.prepare("INSERT INTO problems (id,discovery_run_id,statement,why_it_persists,affected,scale_estimate,verdict,verdict_reason,verdict_source_ids_json,created_at) VALUES ('assessed',?,'Owners lose time filing','Tools','Owners','Unknown','confirmed','Reviewed','[]',?)")
      .run(runId, new Date().toISOString());
    f.db.db.prepare("UPDATE research_runs SET status = 'completed' WHERE id = ?").run(runId);
    f.db.db.prepare("INSERT INTO workflow_snapshots VALUES (?, 'candidate-assessment-result', ?)").run(runId, JSON.stringify({ assessed: true }));
    f.coordinator.handleRunEvent({ type: "run-completed", threadId: "project", runId, problemId: null });
    const updated = f.repository.getSession("session")!;
    expect(updated.state).toBe("waiting-for-review");
    const current = f.repository.getSnapshot(updated.activeSnapshotId!)!;
    expect(current.selection.problemIds).toHaveLength(2);
    const remaining = f.db.db.prepare("SELECT disposition,candidate_json FROM rejected_problem_candidates WHERE discovery_run_id = ?")
      .all(current.materializationRunId) as Array<{ disposition: string; candidate_json: string }>;
    expect(remaining).toHaveLength(1);
    const candidate = SavedProblemCandidateSchema.parse(JSON.parse(remaining[0]!.candidate_json));
    expect(candidate.statement).toBe("Owners chase invoices");
    expect("unknowns" in candidate ? candidate.unknowns : null).toEqual(["Frequency outside this shop"]);
    expect(f.db.db.prepare("SELECT quote FROM factors WHERE id = ? AND research_run_id = ?").get(candidate.factorIds[0]!, current.materializationRunId))
      .toEqual({ quote: "I repeat filing every week." });
    expect(f.db.db.prepare("SELECT area_id FROM factors WHERE id = ?").get(candidate.factorIds[0]!)).toEqual({ area_id: "filing" });
    expect(f.db.db.prepare("SELECT area_id FROM problems WHERE id = ?").get(current.selection.problemIds[0]!)).toEqual({ area_id: "filing" });
    expect(f.db.db.prepare("SELECT COUNT(*) AS count FROM rejected_problem_candidates WHERE discovery_run_id = 'source'").get()).toEqual({ count: 2 });
    expect(f.db.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { f.db.close(); }
});

test("a lost investigator search is needs-attention on restart and never resumes automatically", async () => {
  const f = fixture();
  try {
    const { request } = await command(f); await f.coordinator.command(request);
    const owner = f.repository.listWorkItems("session").find(item => item.kind === "assess-candidate")!;
    const attempts = new OpportunityExplorationRepository(f.db);
    f.db.immediateTransaction(() => {
      const child = f.repository.createWorkItem({ sessionId: "session", parentItemId: owner.id, kind: "evidence-check", scopeKey: "candidate-evidence", state: "ready", input: {} });
      const attempt = attempts.prepareAttempt("project", { stageKey: "investigator-search:lost", stageName: "investigator-search", input: {}, model: { ...model, reasoningEffort: "medium" }, promptVersion: "1", promptText: "query", workItemId: child.id }, "session");
      if (attempt.kind !== "prepared") throw new Error("Expected prepared fixture attempt");
      attempts.markAttemptDispatched("project", attempt.attemptId, "none", "session");
    });
    f.coordinator.reconcileInterrupted();
    const result = f.repository.getSession("session")!;
    expect(result.outcome).toBe("needs-attention");
    expect(result.activeSnapshotId).toBe(f.snapshot.id);
    expect(f.repository.getWorkItem(owner.id)?.state).toBe("unknown");
    expect(f.dispatches).toHaveLength(1);
    expect(f.db.db.prepare("SELECT candidate_json FROM rejected_problem_candidates WHERE id = ?").get(f.candidateRow.id)).toEqual({ candidate_json: f.candidateRow.candidate_json });
    const preview = await f.coordinator.preview({ type: "candidate-assessment", threadId: "project", sessionId: "session", expectedRevision: result.revision, candidateId: f.candidateRow.id });
    expect(preview.fieldErrors).toContainEqual(expect.objectContaining({ code: "UNKNOWN_COMPLETION" }));
  } finally { f.db.close(); }
});

test("a real deferred assessment counts its managed search once and retains both investigators for the same area", async () => {
  const stages: string[] = [];
  const client: StructuredModelClient = { async structuredCompletion(request) {
    stages.push(request.stage);
    request.onDispatched?.();
    const output = request.schema.parse({ verdict: "insufficient-evidence", verdictReason: "Only the saved owner account is available.",
      verdictSourceIds: [], intendedBuyerEvidenceFactorIds: [], evidenceGap: "Another independent owner account",
      briefFit: "direct", contraryEvidence: "unresolved", workflowKey: null,
      unresolvedAssumptions: [], wouldChangeConclusion: [] });
    return { output, metadata: { model, usage: { status: "unknown" }, latencyMs: 0, repairCount: 0,
      providerRequestIds: [], attempts: [], prompt: { id: "fixture", sha256: "a".repeat(64) } } };
  } };
  const f = fixture(30, "exa", undefined, client);
  try {
    const task = f.db.immediateTransaction(() => {
      const task = f.repository.createWorkItem({ sessionId: "session", kind: "discovery", scopeKey: "original-discovery", input: {}, state: "ready" });
      f.repository.updateWorkItem(task.id, "running");
      f.repository.updateWorkItem(task.id, "succeeded", { outputRefs: { runId: f.snapshot.materializationRunId } });
      return task;
    });
    const lane = ensureAreaInvestigatorWorkItems(f.db, "session", task.id, { id: "filing", name: "Filing", whyRelevant: "Owners repeat filing",
      affectedPeople: "Shop owners", venues: [], exampleProblems: [], included: true, priority: 1 });
    const original = f.db.immediateTransaction(() => {
      f.repository.updateWorkItem(lane.parent.id, "ready"); f.repository.updateWorkItem(lane.parent.id, "running");
      f.repository.updateWorkItem(lane.parent.id, "succeeded", { outputRefs: { investigator: { areaId: "filing", areaName: "Filing",
        currentStep: "Original investigation finished", confirmedCount: 1, insufficientCount: 0, droppedCount: 0 } } });
      return lane.parent.id;
    });
    const { request } = await command(f);
    await f.coordinator.command(request);
    const deadline = Date.now() + 5_000;
    while (f.realEngine!.getActiveRunIds().size > 0 && Date.now() < deadline) await Bun.sleep(5);
    expect(f.realEngine!.getActiveRunIds().size).toBe(0);
    expect(f.errors).toEqual([]);
    expect(f.searches).toHaveLength(1);
    expect(stages).toHaveLength(1);
    const runId = f.dispatches[0]!;
    const attempt = f.db.db.prepare("SELECT id FROM opportunity_exploration_attempts WHERE stage_name = 'investigator-search'").get() as { id: string };
    expect(f.db.db.prepare("SELECT status,json_extract(usage_json,'$.searchDispatch.attemptId') AS attemptId FROM cost_ledger WHERE research_run_id = ? AND operation = 'search'").get(runId))
      .toEqual({ status: "committed", attemptId: attempt.id });
    expect(f.coordinator.summary("session").budget.searches).toMatchObject({ spent: 1, reserved: 0, uncertain: 0 });
    expect(f.repository.listBudgetEntries("session").filter(entry => entry.operationKey.startsWith("observed-overrun:"))).toEqual([]);
    const lanes = f.coordinator.get("session").tasks.filter(task => task.kind === "investigate-area" && task.investigator?.areaId === "filing");
    expect(lanes).toHaveLength(2);
    expect(new Set(lanes.map(task => task.id)).size).toBe(2);
    expect(lanes.find(task => task.id === original)?.investigator).toMatchObject({ currentStep: "Original investigation finished", confirmedCount: 1 });
    expect(lanes.find(task => task.id !== original)).toMatchObject({ state: "succeeded", investigator: { insufficientCount: 1 } });
  } finally { await f.realEngine!.shutdown(); f.db.close(); }
});

test("explicit recovery restarts interrupted investigators and records the replacement assessment outcome", async () => {
  const client: StructuredModelClient = { async structuredCompletion(request) {
    request.onDispatched?.();
    return { output: request.schema.parse({ verdict: "insufficient-evidence", verdictReason: "Only the saved owner account is available.",
      verdictSourceIds: [], intendedBuyerEvidenceFactorIds: [], evidenceGap: "Another owner account", briefFit: "direct",
      contraryEvidence: "unresolved", workflowKey: null, unresolvedAssumptions: [], wouldChangeConclusion: [] }),
    metadata: { model, usage: { status: "unknown" }, latencyMs: 0, repairCount: 0,
      providerRequestIds: [], attempts: [], prompt: { id: "fixture", sha256: "a".repeat(64) } } };
  } };
  let searches = 0;
  const f = fixture(30, "exa", undefined, client, async () => {
    if (++searches === 1) throw new Error("Search completion lost");
    return [];
  });
  try {
    const { request } = await command(f);
    await f.coordinator.command(request);
    const waitForSettlement = async () => {
      const deadline = Date.now() + 5_000;
      while (f.realEngine!.getActiveRunIds().size > 0 && Date.now() < deadline) await Bun.sleep(5);
      expect(f.realEngine!.getActiveRunIds().size).toBe(0);
    };
    await waitForSettlement();
    expect(f.coordinator.summary("session").outcome).toBe("needs-attention");
    const owner = f.repository.listWorkItems("session").find(item => item.kind === "assess-candidate")!;
    const lane = f.repository.listWorkItems("session").find(item => item.kind === "investigate-area")!;
    f.db.immediateTransaction(() => {
      for (const item of f.repository.listWorkItems("session").filter(item => item.state === "running")) {
        f.repository.updateWorkItem(item.id, item.id === lane.id ? "unknown" : "failed", { outputRefs: item.outputRefs, error: { message: "Interrupted" } });
      }
    });
    const attempt = f.db.db.prepare("SELECT id FROM opportunity_exploration_attempts WHERE stage_name = 'investigator-search'").get() as { id: string };
    const originalAttempt = f.db.db.prepare("SELECT * FROM opportunity_exploration_attempts WHERE id = ?").get(attempt.id);
    const current = f.repository.getSession("session")!;
    await f.coordinator.command({ threadId: "project", sessionId: "session", expectedRevision: current.revision, clientCommandId: "recover-assessment",
      action: { type: "retry-task", taskId: owner.id, expectedTerminalAttemptId: attempt.id, acknowledgeUnknownCompletion: true } });
    await waitForSettlement();

    expect(f.errors).toEqual(["Search completion lost"]);
    expect(f.searches).toHaveLength(2);
    expect(f.db.db.prepare("SELECT * FROM opportunity_exploration_attempts WHERE id = ?").get(attempt.id)).toEqual(originalAttempt);
    expect(f.repository.getWorkItem(lane.id)).toMatchObject({ state: "succeeded", error: null,
      outputRefs: { investigator: { currentStep: "Assessment complete", insufficientCount: 1 } } });
    expect(f.repository.getWorkItem(lane.id)?.finishedAt).not.toBeNull();
    expect(f.coordinator.summary("session").budget.searches).toMatchObject({ spent: 1, uncertain: 1, reserved: 0 });
    expect(f.repository.listBudgetEntries("session").filter(entry => entry.operationKey.startsWith("observed-overrun:"))).toEqual([]);
  } finally { await f.realEngine!.shutdown(); f.db.close(); }
});

test("a finished project starts a linked assessment and still shows its previous snapshot after an incomplete assessment", async () => {
  const f = fixture();
  try {
    const prior = f.repository.getSession("session")!;
    f.db.immediateTransaction(() => f.repository.updateSession(prior.id, prior.revision, { state: "finished", outcome: "partial" }));
    const finished = f.repository.getSession("session")!;
    const { request } = await command(f);
    const receipt = await f.coordinator.command(request);
    expect(receipt.sessionId).not.toBe("session");
    expect(f.repository.getSession("session")).toEqual(finished);
    const linked = f.repository.getSnapshot(receipt.summary.activeSnapshotId!)!;
    expect(linked.selection.problemIds).toHaveLength(1);
    expect(linked.parentSnapshotId).toBe(f.snapshot.id);
    const runId = f.dispatches[0]!;
    f.db.db.prepare("UPDATE research_runs SET status = 'completed' WHERE id = ?").run(runId);
    f.db.db.prepare("INSERT INTO workflow_snapshots VALUES (?, 'candidate-assessment-result', ?)").run(runId, JSON.stringify({ assessed: false, stopReason: "Budget exhausted before verdict" }));
    f.coordinator.handleRunEvent({ type: "run-completed", threadId: "project", runId, problemId: null });
    expect(f.repository.getSession(receipt.sessionId)?.activeSnapshotId).toBe(linked.id);
    expect(f.db.db.prepare("SELECT COUNT(*) AS count FROM rejected_problem_candidates WHERE discovery_run_id = ? AND disposition = 'not-assessed'")
      .get(linked.materializationRunId)).toEqual({ count: 2 });
    expect(f.repository.getSession("session")).toEqual(finished);
  } finally { f.db.close(); }
});

test("new follow-up admission freezes the latest approved frame and queued dispatch keeps it after another edit", async () => {
  const f = fixture();
  try {
    const frames = new ResearchFrameRepository(f.db);
    const first = frames.createDraft({ threadId: "project", runId: "source", knownProblem: true, sources: [], frame: {
      goal: "Reduce filing delays", goalKind: "process-improvement", contextFacts: [],
      successCriteria: [{ id: "delay", name: "Less time filing", weight: "must", howJudged: "Observe time", basis: "brief" }],
      constraints: [], languages: ["en"], exclusions: [], openQuestions: [], areas: [],
    } });
    frames.approve(first.id, "project", first.draft);
    frames.bindRun(f.snapshot.materializationRunId, "project", first.id);
    const edited = frames.createApprovedVersion(first.id, "project", { ...first.draft, languages: ["en", "uk"] });
    const runs: string[] = [];
    const service = new ResearchRequestService({ db: f.db, engine: () => ({ async resumeRun(runId: string) { runs.push(runId); } }),
      modelClient: () => { throw new Error("No provider call is expected in admission/dispatch verification"); }, onProgress() {} });
    const session = f.repository.getSession("session")!;
    const admitted = f.db.immediateTransaction(() => service.admitRequest(session.id, session.revision, {
      type: "request-research", kind: "new-question", question: "Which filing steps cause delay?", baseSnapshotId: f.snapshot.id,
      model, reasoningEffort: "medium", allowance: { maxModelCalls: 20, maxSearches: 12, maxMinutes: 10 },
    }));
    expect((f.repository.getWorkItem(admitted.workItemId)!.input as { frameId: string }).frameId).toBe(edited.id);
    frames.createApprovedVersion(edited.id, "project", { ...edited.approved!, languages: ["en"] });
    await service.dispatchReady(admitted.session.id);
    expect(runs).toHaveLength(1);
    expect(frames.forRun(runs[0]!)?.id).toBe(edited.id);
    expect(frames.forRun(runs[0]!)?.approved?.languages).toEqual(["en", "uk"]);
    expect(frames.forRun(f.snapshot.materializationRunId)?.id).toBe(first.id);
  } finally { f.db.close(); }
});
