import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WorkflowCoordinator } from "../../src/core/workflow-coordinator";
import { ResearchRequestService } from "../../src/core/research-request-service";
import type { ResearchEngine } from "../../src/core/research-engine";
import { materializeResearchSnapshot } from "../../src/core/research-revisions";
import { DatabaseClient } from "../../src/db/client";
import { DiscoveryRepository } from "../../src/db/repositories/discovery";
import { ResearchRunRepository, type ResearchRunWorkflowLink } from "../../src/db/repositories/research-runs";
import { WorkflowRepository } from "../../src/db/repositories/workflows";
import { ResearchFrameRepository } from "../../src/db/repositories/research-frames";
import { OpportunityExplorationRepository } from "../../src/db/repositories/opportunity-exploration";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";
import { SavedProblemCandidateSchema } from "../../src/shared/structured-output-schemas";
import { PreviewWorkflowResultSchema } from "../../src/shared/workflow-contracts";
import type { ProblemCandidate } from "../../src/shared/ipc";
import { sha256 } from "../../src/shared/content-identity";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const scope = { title: "Filing", audience: "Shop owners", domain: "Invoices", observations: "Weekly delays", offLimits: [] };
const model = { providerId: "fixture", modelId: "fixture-model" };
const config = { ...DEFAULT_RUN_CONFIG, model, discoveryDepth: "quick" as const };

function fixture(maxModelCalls = 30) {
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
    contract: { contractVersion: 1, purpose: "discovery", mode: "babysit", brief: "Research filing", scope, runConfig: config,
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
  const engine = { async startCandidateAssessment(threadId: string, _sourceRunId: string, _candidateId: string, _config: typeof config, link: ResearchRunWorkflowLink) {
    const run = new ResearchRunRepository(db).create(threadId, config, null, randomUUID(), link);
    discovery.persistScope(run.runId, scope);
    link.onRunCreated?.(run.runId); dispatches.push(run.runId); return run.runId;
  } } as unknown as ResearchEngine;
  const coordinator = new WorkflowCoordinator({ db, engine: () => engine, capabilities: async () => ({ nativeConnected: true, searchReady: { exa: true, perplexity: false },
    modelOptions: [{ ...model, displayName: "Fixture", defaultReasoningEffort: "medium", reasoningEfforts: [{ id: "medium", description: "Medium" }] }] }),
    listProblems: (_threadId, runId) => db.db.prepare("SELECT id FROM problems WHERE discovery_run_id = ? ORDER BY rowid").all(runId) as ProblemCandidate[], onProgress() {},
    onError(error) { errors.push(String(error)); } });
  return { db, repository, coordinator, snapshot, candidateRow, dispatches, errors };
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
    expect(preview.fieldErrors).toContainEqual(expect.objectContaining({ code: "BUDGET_TOO_SMALL" }));
    expect(f.repository.getSession("session")).toEqual(before);
    await expect(f.coordinator.command(request)).rejects.toMatchObject({ code: "BUDGET_TOO_SMALL" });
    expect(f.dispatches).toEqual([]);
    expect(f.db.db.prepare("SELECT candidate_json FROM rejected_problem_candidates WHERE id = ?").get(f.candidateRow.id)).toEqual({ candidate_json: f.candidateRow.candidate_json });
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
