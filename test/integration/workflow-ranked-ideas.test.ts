import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configurePromptPaths } from "../../src/core/prompts";
import { ResearchEngine } from "../../src/core/research-engine";
import { getRunTrace } from "../../src/core/run-trace";
import { materializeResearchSnapshot } from "../../src/core/research-revisions";
import { WorkflowCoordinator } from "../../src/core/workflow-coordinator";
import { WorkflowModelScheduler } from "../../src/core/workflow-scheduler";
import { streamRestarts } from "../../src/core/workflow-execution";
import { DatabaseClient } from "../../src/db/client";
import { CostLedgerRepository } from "../../src/db/repositories/cost-ledger";
import { DiscoveryRepository } from "../../src/db/repositories/discovery";
import { GenerationAttemptRepository } from "../../src/db/repositories/generation-attempts";
import { WorkflowRepository } from "../../src/db/repositories/workflows";
import { ProviderFailure, type StructuredModelClient, type StructuredStageRequest } from "../../src/providers/structured";
import { sha256 } from "../../src/shared/content-identity";
import { ProblemCandidateSchema } from "../../src/shared/ipc";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    try { rmSync(directory, { recursive: true, force: true }); }
    catch { /* Bun can retain a SQLite WAL handle briefly on Windows. */ }
  }
});

const model = { providerId: "fixture", modelId: "fixture-model" };
const restartPauses = streamRestarts.pausesMs;
beforeAll(() => { streamRestarts.pausesMs = [1, 1]; });
afterAll(() => { streamRestarts.pausesMs = restartPauses; });

// A real coordinator, engine and database. Only the model is scripted: writers return `ideasFor(problem)` ideas
// in one answer, and the ranker reverses the proposal order so the saved ranks are visibly the ranker's.
async function rankedRun(ideasFor: (problemStatement: string) => number, failure?: {
  stage: "solutions" | "idea-ranking"; drops: number; rateLimitFirst?: boolean; unrelatedUnknown?: boolean; retry?: boolean;
}) {
  const directory = mkdtempSync(join(tmpdir(), "scraply-ranked-ideas-")); directories.push(directory);
  configurePromptPaths({ bundledDir: join(process.cwd(), "prompts"), overrideDir: join(directory, "prompts") });
  const db = new DatabaseClient(join(directory, "test.db"));
  const repository = new WorkflowRepository(db);
  const now = new Date().toISOString();
  const config = { ...DEFAULT_RUN_CONFIG, model, workflowVersion: 2 as const, ideaCount: 3, explorationPurpose: "general-solutions" as const };
  const scope = { title: "Filing", audience: "Shop owners", domain: "Invoices", observations: "Weekly delays", offLimits: [] };
  db.db.prepare("INSERT INTO threads (id,title,status,created_at,updated_at) VALUES ('project','Filing','researching',?,?)").run(now, now);
  const session = db.immediateTransaction(() => repository.createSession({ id: "session", threadId: "project", purpose: "discovery", mode: "babysit",
    remainingMs: 60 * 60_000, contract: { contractVersion: 1, ideaWorkflowVersion: 2, purpose: "discovery", mode: "babysit", brief: "Research filing", scope,
      runConfig: config, ideas: { model, reasoningEffort: "medium" }, targets: { kind: "per-problem", ideaCount: 3 },
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
  const problemIds = failure ? ["problem-1"] : ["problem-1", "problem-2", "problem-3", "problem-4"];
  const problem = (id: string, index: number) => ({ id, statement: `Owners repeat filing step ${index + 1}`, whyItPersists: "Disconnected tools",
    affected: "Shop owners", scaleEstimate: "Weekly", verdict: "confirmed" as const, verdictReason: "Owner account", intendedBuyerEvidenceFactorIds: ["factor"], evidenceGap: null });
  discovery.persistProblems("source", [], problemIds.map((id, index) => ({ ...problem(id, index), scaleBasisFactorId: "factor", factorIds: ["factor"],
    verdictSourceIds: ["source-quote"] })));
  const candidates = problemIds.map((id, index) => ProblemCandidateSchema.parse({ ...problem(id, index), selected: false, briefFit: "direct",
    contraryEvidence: "resolved", singleHarvestModeWarning: false, developmentCompleted: false,
    factors: [{ ...factor, sourceTitle: "Owner account", sourceUrl: "https://owners.example/filing" }] }));

  const calls: Array<{ stage: string; problem: string; generationId: string }> = [];
  let failingStageCalls = 0;
  let unrelatedAttemptId: string | undefined;
  const client: StructuredModelClient = { async structuredCompletion<T>(request: StructuredStageRequest<T>) {
    const inputs = request.workOrder.inputs as { problemId?: string; candidateIds?: string[]; problem?: { statement?: string } };
    const statement = request.stage === "solutions"
      ? candidates.find((candidate) => candidate.statement === JSON.stringify(request.evidence).match(/Owners repeat filing step \d/)?.[0])?.statement ?? ""
      : inputs.problem?.statement ?? "";
    calls.push({ stage: request.stage, problem: statement, generationId: request.generationId });
    if (failure?.stage === request.stage) {
      failingStageCalls++;
      if (failure.rateLimitFirst && failingStageCalls === 1) throw new ProviderFailure("rate-limit", "Rate limit reached", true);
      const dropped = new ProviderFailure("interrupted", "Stream dropped", false, { attempts: [{
        attempt: "initial", outcome: "failed", providerCompletion: "unknown", model,
        usage: { status: "unknown" }, cost: { status: "unknown" }, latencyMs: 1,
      }] });
      if (failure.unrelatedUnknown && !unrelatedAttemptId) {
        const owner = db.db.prepare("SELECT research_run_id FROM generation_attempts WHERE generation_id = ?").get(request.generationId) as { research_run_id: string };
        const attempts = new GenerationAttemptRepository(db);
        const unrelated = attempts.prepare(owner.research_run_id, { ...request, generationId: "unrelated-generation", stage: "unrelated-probe" });
        attempts.markDispatched(unrelated.id);
        attempts.recordTerminal(unrelated.id, { status: "interrupted", terminalKind: "interrupted", attemptMetadata: { attempts: dropped.attempts } });
        unrelatedAttemptId = unrelated.id;
      }
      if (failingStageCalls <= failure.drops + Number(Boolean(failure.rateLimitFirst))) {
        request.onDispatched?.(); request.onAccepted?.({});
        throw dropped;
      }
    }
    request.onDispatched?.(); request.onAccepted?.({});
    const output = request.stage === "solutions"
      ? { options: Array.from({ length: ideasFor(statement) }, (_, index) => ({ mechanism: `Mechanism ${index + 1} for ${statement}`,
        description: `Idea ${index + 1}: a short idea for ${statement}`, keyAssumption: "Owners try it", whyCurrentApproachMaySuffice: "Manual work may do",
        supportingEvidenceIds: [], contraryEvidenceIds: [], unknowns: ["Frequency"], respectsOffLimits: true, respectsOffLimitsWhy: "Within limits" })) }
      : { ranking: [...inputs.candidateIds!].reverse().map((candidateId, index) => ({ candidateId, reason: `Ranked ${index + 1}`, sameAsCandidateId: null })) };
    return { output: request.schema.parse(output), metadata: { model, prompt: { id: "fixture", sha256: "a".repeat(64) },
      usage: { status: "unknown" as const }, latencyMs: 0, repairCount: 0, providerRequestIds: [], attempts: [] } };
  } };
  let coordinator: WorkflowCoordinator | undefined = undefined;
  const engine = new ResearchEngine({ db, modelScheduler: new WorkflowModelScheduler(4), modelClients: { fixture: client }, rateLimitPausesMs: [1, 1],
    onEvent(event) { void Promise.resolve().then(() => coordinator?.handleRunEvent(event)); } });
  coordinator = new WorkflowCoordinator({ db, engine: () => engine, listProblems: () => candidates, onProgress() {},
    capabilities: async () => ({ nativeConnected: true, searchReady: { exa: true, perplexity: false },
      modelOptions: [{ ...model, displayName: "Fixture", defaultReasoningEffort: "medium", reasoningEfforts: [{ id: "medium", description: "Default" }] }] }) });

  const snapshot = db.immediateTransaction(() => {
    const copied = materializeResearchSnapshot(db, { threadId: "project", baseRunId: "source", sourceProblemIds: problemIds, sessionId: session.id });
    const saved = repository.createSnapshot({ sessionId: session.id, materializationRunId: copied.runId, selection: { problemIds: copied.problemIds }, originMap: copied.originMap });
    repository.updateSession(session.id, session.revision, { state: "waiting-for-review", activeSnapshotId: saved.id, runningSince: null });
    return saved;
  });
  await coordinator.command({ threadId: "project", sessionId: session.id, clientCommandId: "generate", expectedRevision: coordinator.summary(session.id).revision,
    action: { type: "generate-ideas", snapshotId: snapshot.id, problemIds: snapshot.selection.problemIds, model, reasoningEffort: "medium", target: { kind: "per-problem", count: 3 } } });
  async function settled() {
    const deadline = Date.now() + 5_000;
    while (repository.getSession(session.id)!.state !== "finished" && Date.now() < deadline) await Bun.sleep(10);
    expect(repository.getSession(session.id)!.state).toBe("finished");
  }
  await settled();
  const tasks = repository.listWorkItems(session.id).filter((item) => item.kind === "generate-ideas");
  const ideaRunId = (tasks[0]!.outputRefs as { runId: string }).runId;
  const firstOutcome = repository.getSession(session.id)!.outcome;
  const firstAttempts = db.db.prepare(`SELECT id, generation_id AS generationId, stage_key AS stage, status, usage_json AS usage
    FROM generation_attempts WHERE research_run_id = ? ORDER BY rowid`).all(ideaRunId) as Array<{ id: string; generationId: string; stage: string; status: string; usage: string | null }>;
  const streamAcknowledgements = db.db.prepare(`SELECT snapshot_key AS key, value_json AS value FROM workflow_snapshots
    WHERE research_run_id = ? AND snapshot_key LIKE 'acknowledged-retry:stream-restart:%' ORDER BY rowid`)
    .all(ideaRunId) as Array<{ key: string; value: string }>;
  const firstSafety = new GenerationAttemptRepository(db).getResumeSafety(ideaRunId, repository.acknowledgedAttemptIds(ideaRunId));
  if (failure?.retry) {
    const dropped = firstAttempts.filter((attempt) => attempt.stage === failure.stage && attempt.status === "interrupted");
    await expect(coordinator.command({ threadId: "project", sessionId: session.id, clientCommandId: "retry-without-ack",
      expectedRevision: coordinator.summary(session.id).revision,
      action: { type: "retry-task", taskId: tasks[0]!.id, expectedTerminalAttemptId: dropped.at(-1)!.id } })).rejects.toMatchObject({ code: "UNKNOWN_COMPLETION" });
    await coordinator.command({ threadId: "project", sessionId: session.id, clientCommandId: "retry-exact-ranker",
      expectedRevision: coordinator.summary(session.id).revision,
      action: { type: "retry-task", taskId: tasks[0]!.id, expectedTerminalAttemptId: dropped.at(-1)!.id, acknowledgeUnknownCompletion: true } });
    await settled();
  }
  const ideas = db.db.prepare(`SELECT p.statement, s.mechanism, s.rank, s.rank_reason, s.weak_fit_reason FROM solutions s
    JOIN problems p ON p.id = s.problem_id ORDER BY p.statement, s.rank`).all() as Array<{ statement: string; mechanism: string; rank: number; rank_reason: string; weak_fit_reason: string | null }>;
  const firstRun = db.db.prepare("SELECT id FROM research_runs WHERE workflow_session_id = ? LIMIT 1").get(session.id) as { id: string };
  const result = { session: repository.getSession(session.id)!, summary: coordinator.summary(session.id), calls, ideas, trace: getRunTrace(db, firstRun.id).metrics,
    firstOutcome, firstAttempts, streamAcknowledgements, firstSafety, unrelatedAttemptId,
    acknowledgedAttemptIds: repository.acknowledgedAttemptIds(ideaRunId), paidCalls: new CostLedgerRepository(db).countProviderCalls(ideaRunId, "fixture"),
    tasks: repository.listWorkItems(session.id).filter((item) => item.kind === "generate-ideas") };
  await engine.shutdown();
  db.close();
  return result;
}

test("four problems make one writing and one ranking call each and save twelve ranked ideas", async () => {
  const run = await rankedRun(() => 3);
  expect(run.session).toMatchObject({ state: "finished", outcome: "target-met" });
  expect(run.calls.filter((call) => call.stage === "solutions")).toHaveLength(4);
  expect(run.calls.filter((call) => call.stage === "idea-ranking")).toHaveLength(4);
  expect(run.calls).toHaveLength(8);
  expect(run.tasks).toHaveLength(4);
  expect(run.ideas).toHaveLength(12);
  // The ranker reversed each group, so mechanism 3 is ranked first everywhere.
  expect(run.ideas.filter((idea) => idea.statement.endsWith("step 1")).map((idea) => [idea.rank, idea.mechanism])).toEqual([
    [1, "Mechanism 3 for Owners repeat filing step 1"], [2, "Mechanism 2 for Owners repeat filing step 1"], [3, "Mechanism 1 for Owners repeat filing step 1"],
  ]);
  expect(run.ideas.every((idea) => idea.rank_reason.startsWith("Ranked ") && idea.weak_fit_reason === null)).toBe(true);
  expect(run.summary.counts).toMatchObject({ requested: 12, accepted: 12, missing: 0 });
  // The trace an agent reads counts ranked ideas too, so a ranked run is not reported as a zero-idea run.
  expect(run.trace).toMatchObject({ ideas: 12, acceptedIdeas: 12 });
});

test("a writer that returns two of three ideas leaves a group of two, with no extra call", async () => {
  const run = await rankedRun((statement) => statement.endsWith("step 2") ? 2 : 3);
  expect(run.session).toMatchObject({ state: "finished", outcome: "partial" });
  expect(run.calls).toHaveLength(8);
  expect(run.ideas.filter((idea) => idea.statement.endsWith("step 2")).map((idea) => idea.rank)).toEqual([1, 2]);
  expect(run.ideas).toHaveLength(11);
  expect(run.summary.counts).toMatchObject({ requested: 12, accepted: 11, missing: 1 });
});

test.each(["solutions", "idea-ranking"] as const)("%s acknowledges the physical stream drop after a rate-limit replacement", async stage => {
  const run = await rankedRun(() => 3, { stage, drops: 1, rateLimitFirst: true });
  const attempts = run.firstAttempts.filter(attempt => attempt.stage === stage);
  expect(attempts.map(attempt => attempt.status)).toEqual(["failed", "interrupted", "completed"]);
  expect(run.calls.filter(call => call.stage === stage)).toHaveLength(3);
  expect(run.streamAcknowledgements).toEqual([{ key: `acknowledged-retry:stream-restart:${attempts[1]!.generationId}`,
    value: JSON.stringify({ attemptIds: [attempts[1]!.id] }) }]);
  expect(JSON.parse(attempts[1]!.usage!)).toEqual([{ status: "unknown" }]);
  expect(run.paidCalls).toBe(3);
  expect(run.firstSafety.canResume).toBe(true);
  expect(run.session).toMatchObject({ state: "finished", outcome: "target-met" });
  expect(run.ideas).toHaveLength(3);
});

test("a stream restart leaves an unrelated unknown idea call unacknowledged", async () => {
  const run = await rankedRun(() => 3, { stage: "solutions", drops: 1, rateLimitFirst: true, unrelatedUnknown: true });
  const lost = run.firstAttempts.find(attempt => attempt.stage === "solutions" && attempt.status === "interrupted")!;
  expect(run.acknowledgedAttemptIds).toEqual([lost.id]);
  expect(run.acknowledgedAttemptIds).not.toContain(run.unrelatedAttemptId!);
  expect(run.firstSafety.canResume).toBe(false);
});

test.each(["solutions", "idea-ranking"] as const)("%s leaves its third physical drop unresolved after a rate-limit replacement", async stage => {
  const run = await rankedRun(() => 3, { stage, drops: 3, rateLimitFirst: true });
  const lost = run.firstAttempts.filter(attempt => attempt.stage === stage && attempt.status === "interrupted");
  expect(run.calls.filter(call => call.stage === stage)).toHaveLength(4);
  expect(lost).toHaveLength(3);
  expect(run.streamAcknowledgements.map(row => JSON.parse(row.value).attemptIds)).toEqual(lost.slice(0, 2).map(attempt => [attempt.id]));
  expect(run.acknowledgedAttemptIds).not.toContain(lost[2]!.id);
  expect(lost.map(attempt => JSON.parse(attempt.usage!))).toEqual(Array.from({ length: 3 }, () => [{ status: "unknown" }]));
  expect(run.paidCalls).toBe(stage === "solutions" ? 3 : 4);
  expect(run.firstSafety.canResume).toBe(false);
  expect(run.session).toMatchObject({ state: "finished", outcome: "needs-attention" });
});

test("the ranker restarts its first dropped stream and saves the ranking on its second call", async () => {
  const run = await rankedRun(() => 3, { stage: "idea-ranking", drops: 1 });
  expect(run.calls.filter(call => call.stage === "idea-ranking")).toHaveLength(2);
  expect(run.session).toMatchObject({ state: "finished", outcome: "target-met" });
  expect(run.ideas.map(idea => idea.rank)).toEqual([1, 2, 3]);
});

test("three ranker drops stop for review and an exact acknowledged retry reuses the saved writer", async () => {
  const run = await rankedRun(() => 3, { stage: "idea-ranking", drops: 3, retry: true });
  const lost = run.firstAttempts.filter(attempt => attempt.stage === "idea-ranking");
  expect(lost).toHaveLength(3);
  expect(run.firstOutcome).toBe("needs-attention");
  expect(run.firstSafety.canResume).toBe(false);
  expect(run.streamAcknowledgements).toHaveLength(2);
  expect([...run.acknowledgedAttemptIds].sort()).toEqual(lost.map(attempt => attempt.id).sort());
  expect(run.calls.filter(call => call.stage === "solutions")).toHaveLength(1);
  expect(run.calls.filter(call => call.stage === "idea-ranking")).toHaveLength(4);
  expect(run.session).toMatchObject({ state: "finished", outcome: "target-met" });
  expect(run.ideas.map(idea => idea.rank)).toEqual([1, 2, 3]);
});
