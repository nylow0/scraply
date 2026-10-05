import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configurePromptPaths } from "../../src/core/prompts";
import { ResearchEngine } from "../../src/core/research-engine";
import { getRunTrace } from "../../src/core/run-trace";
import { materializeResearchSnapshot } from "../../src/core/research-revisions";
import { WorkflowCoordinator } from "../../src/core/workflow-coordinator";
import { WorkflowModelScheduler } from "../../src/core/workflow-scheduler";
import { DatabaseClient } from "../../src/db/client";
import { DiscoveryRepository } from "../../src/db/repositories/discovery";
import { WorkflowRepository } from "../../src/db/repositories/workflows";
import type { StructuredModelClient, StructuredStageRequest } from "../../src/providers/structured";
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

// A real coordinator, engine and database. Only the model is scripted: writers return `ideasFor(problem)` ideas
// in one answer, and the ranker reverses the proposal order so the saved ranks are visibly the ranker's.
async function rankedRun(ideasFor: (problemStatement: string) => number) {
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
  const problemIds = ["problem-1", "problem-2", "problem-3", "problem-4"];
  const problem = (id: string, index: number) => ({ id, statement: `Owners repeat filing step ${index + 1}`, whyItPersists: "Disconnected tools",
    affected: "Shop owners", scaleEstimate: "Weekly", verdict: "confirmed" as const, verdictReason: "Owner account", intendedBuyerEvidenceFactorIds: ["factor"], evidenceGap: null });
  discovery.persistProblems("source", [], problemIds.map((id, index) => ({ ...problem(id, index), scaleBasisFactorId: "factor", factorIds: ["factor"],
    verdictSourceIds: ["source-quote"] })));
  const candidates = problemIds.map((id, index) => ProblemCandidateSchema.parse({ ...problem(id, index), selected: false, briefFit: "direct",
    contraryEvidence: "resolved", singleHarvestModeWarning: false, developmentCompleted: false,
    factors: [{ ...factor, sourceTitle: "Owner account", sourceUrl: "https://owners.example/filing" }] }));

  const calls: Array<{ stage: string; problem: string }> = [];
  const client: StructuredModelClient = { async structuredCompletion<T>(request: StructuredStageRequest<T>) {
    const inputs = request.workOrder.inputs as { problemId?: string; candidateIds?: string[]; problem?: { statement?: string } };
    const statement = request.stage === "solutions"
      ? candidates.find((candidate) => candidate.statement === JSON.stringify(request.evidence).match(/Owners repeat filing step \d/)?.[0])?.statement ?? ""
      : inputs.problem?.statement ?? "";
    calls.push({ stage: request.stage, problem: statement });
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
  const deadline = Date.now() + 10_000;
  while (repository.getSession(session.id)!.state !== "finished" && Date.now() < deadline) await Bun.sleep(10);
  const ideas = db.db.prepare(`SELECT p.statement, s.mechanism, s.rank, s.rank_reason, s.weak_fit_reason FROM solutions s
    JOIN problems p ON p.id = s.problem_id ORDER BY p.statement, s.rank`).all() as Array<{ statement: string; mechanism: string; rank: number; rank_reason: string; weak_fit_reason: string | null }>;
  const firstRun = db.db.prepare("SELECT id FROM research_runs WHERE workflow_session_id = ? LIMIT 1").get(session.id) as { id: string };
  const result = { session: repository.getSession(session.id)!, summary: coordinator.summary(session.id), calls, ideas, trace: getRunTrace(db, firstRun.id).metrics,
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
