import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResearchEngine } from "../../src/core/research-engine";
import { getRunTrace } from "../../src/core/run-trace";
import { WorkflowModelScheduler } from "../../src/core/workflow-scheduler";
import { configurePromptPaths } from "../../src/core/prompts";
import { WorkflowExecution } from "../../src/core/workflow-execution";
import { DatabaseClient } from "../../src/db/client";
import { DiscoveryRepository } from "../../src/db/repositories/discovery";
import { ResearchFrameRepository } from "../../src/db/repositories/research-frames";
import { ResearchRunRepository } from "../../src/db/repositories/research-runs";
import { WorkflowRepository } from "../../src/db/repositories/workflows";
import { ProviderFailure, type StructuredModelClient, type StructuredStageRequest } from "../../src/providers/structured";
import type { SearchClient, SearchOptions, SearchProvider } from "../../src/providers/search";
import type { ResearchVenueResolver } from "../../src/providers/venue-validation";
import type { ResearchFrame } from "../../src/shared/research-frame";
import { DEFAULT_RUN_CONFIG, type RunConfig, type Source, type DiscoveryDepth } from "../../src/shared/schemas";

const model = { providerId: "fixture", modelId: "fixture" };
const scope = { title: "Bakery filing", domain: "Filing", audience: "Bakery owners", observations: "Repeated entries", offLimits: [] };
const text = "I repeat filing every week.";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function frame(novelty = false): ResearchFrame {
  return { goal: "Reduce repeated entries", goalKind: "process-improvement", contextFacts: [{ fact: "Owners repeat entries", sourceIds: ["frame-source"] }],
    successCriteria: [{ id: "useful", name: novelty ? "Different from existing tools" : "Reduce repeated entries", weight: "must",
      howJudged: "Compare tools and observe the actual process", basis: "brief" }], constraints: [], languages: ["en"], exclusions: [], openQuestions: [],
    areas: ["filing", "handoff"].map((id, index) => ({ id, name: id, affectedPeople: "Bakery owners", whyRelevant: "Repeated entries",
      venues: [{ name: "Owner reports", kind: "publication" }], exampleProblems: [], included: true, priority: index + 1 })) };
}

function fit(status: "unknown" | "meets" | "fails", evidenceId?: string, novelty = false) {
  return [{ criterionId: "useful", criterionName: novelty ? "Different from existing tools" : "Reduce repeated entries", mustHave: true,
    status, evidenceIds: evidenceId ? [evidenceId] : [], note: status === "unknown" ? "Still unverified" : "Compared with saved evidence" }];
}

function option(novelty = false) {
  return { mechanism: "Local filing comparison", description: "Compare two local exports and flag repeated entries", keyAssumption: "Stable record IDs",
    whyCurrentApproachMaySuffice: "Manual filing may be sufficient", supportingEvidenceIds: ["frame-source"], contraryEvidenceIds: [], unknowns: ["Effect on time"],
    respectsOffLimits: true, respectsOffLimitsWhy: "Uses local exports",
    biggerProblem: { statement: "Repeated entries waste owner time", affected: "Bakery owners", scale: "Unknown", scaleKnown: false, scaleEvidenceIds: [] },
    slice: { description: "One export comparison", connectionToBiggerProblem: "Removes repeated entries", feasibilityWithinConstraints: "One local workflow" },
    criteriaFit: fit("unknown", undefined, novelty), firstTest: { kind: "process-test", question: "Does comparison reduce repeat work?", method: "Compare one week",
      cost: "One hour", metric: "Repeated entries", sample: 5, observationWindow: "One week", passCriterion: "Fewer entries", failCriterion: "More entries", inconclusiveCriterion: "No change" } };
}

function input(request: StructuredStageRequest<unknown>): Record<string, unknown> {
  const value = request.workOrder.inputs as Record<string, unknown>;
  return "routing" in value ? value.routing as Record<string, unknown> : value;
}

async function fixture(output: (request: StructuredStageRequest<unknown>) => Promise<unknown> | unknown,
  options: { novelty?: boolean; bounded?: boolean; depth?: DiscoveryDepth; modelCapacity?: number;
    noSearchProvider?: boolean; maxSearches?: number; maxModelCalls?: number; singleArea?: boolean;
    taskModelReservation?: number; taskSearchReservation?: number;
    researchTarget?: { confirmedProblems: number; minAreas: number };
    frameValue?: ResearchFrame; frameSourceUrl?: string; venueResolver?: ResearchVenueResolver; autoSearch?: boolean;
    search?: (query: string, options?: SearchOptions, provider?: SearchProvider) => Promise<Source[]> } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "scraply-engine-goal-"));
  const db = new DatabaseClient(join(directory, "test.db"));
  configurePromptPaths({ bundledDir: join(process.cwd(), "prompts"), overrideDir: join(directory, "prompts") });
  const now = new Date().toISOString();
  db.db.prepare("INSERT INTO threads (id,title,status,created_at,updated_at) VALUES ('project','Bakery','configuring',?,?)").run(now, now);
  const config: RunConfig = { ...DEFAULT_RUN_CONFIG, model, workflowVersion: 2, discoveryDepth: options.depth ?? "quick", ideaCount: 1,
    explorationPurpose: "general-solutions", ...(options.autoSearch ? { searchProvider: "auto" } : {}) };
  const frames = new ResearchFrameRepository(db);
  const frameRun = new ResearchRunRepository(db).create("project", config).runId;
  new DiscoveryRepository(db).persistFactors(frameRun, [{ id: "frame-source", providerSourceId: "context-provider",
    canonicalUrl: options.frameSourceUrl ?? "https://owners.example/filing", title: "Owner", retrievedText: text, author: null, publishedAt: null,
    contentHash: hash(text), retrievedAt: now }], []);
  const approvedFrame = options.frameValue ?? frame(options.novelty);
  if (options.singleArea) approvedFrame.areas = approvedFrame.areas.slice(0, 1);
  const draft = frames.createDraft({ threadId: "project", runId: frameRun, knownProblem: false, frame: approvedFrame,
    sources: [{ id: "frame-source", url: options.frameSourceUrl ?? "https://owners.example/filing", title: "Owner", text }] });
  frames.approve(draft.id, "project", draft.draft);
  db.db.prepare("UPDATE research_runs SET status = 'completed' WHERE id = ?").run(frameRun);
  const workflows = new WorkflowRepository(db);
  db.immediateTransaction(() => workflows.createSession({ id: "session", threadId: "project", purpose: "discovery", mode: "babysit", remainingMs: 300_000,
    contract: { contractVersion: 1, frameWorkflowVersion: 1, purpose: "discovery", mode: "babysit", brief: "Reduce repeated entries", scope,
      runConfig: config, targets: { kind: "project", ideaCount: 1, ...(options.researchTarget ? { research: options.researchTarget } : {}) },
      limits: { enforced: options.bounded === true, maxMinutes: 5, maxModelCalls: options.maxModelCalls ?? 500, maxSearches: options.maxSearches ?? 500 },
      instructions: {}, resolvedInstructions: { research: "", ideas: "", review: "" }, instructionHashes: { research: "r", ideas: "i", review: "v" } } }));
  const stages: string[] = []; const queries: string[] = []; const errors: string[] = [];
  const client: StructuredModelClient = { async structuredCompletion(request) {
    stages.push(request.stage); request.onDispatched?.(); request.onAccepted?.({});
    return { output: request.schema.parse(await output(request)), metadata: { model, prompt: { id: "fixture", sha256: "a".repeat(64) },
      usage: { status: "unknown" }, latencyMs: 0, repairCount: 0, providerRequestIds: [], attempts: [] } };
  } };
  const scheduler = new WorkflowModelScheduler(options.modelCapacity ?? 1);
  function searchClient(provider: SearchProvider): SearchClient {
    return { provider, async validateKey() { return { valid: true }; }, async search(query, searchOptions) {
      queries.push(query);
      return options.search ? options.search(query, searchOptions, provider) : [1, 2].map(index => ({ id: `provider-${queries.length}-${index}`,
        url: `https://owners.example/${index === 1 ? "filing" : "handoff"}?utm_source=${encodeURIComponent(query)}`, title: "Owner", text }));
    } };
  }
  const engine = new ResearchEngine({ db, modelScheduler: scheduler, modelClients: { fixture: client },
    ...(options.venueResolver ? { venueResolver: options.venueResolver } : {}),
    searchClients: options.noSearchProvider ? {} : { exa: searchClient("exa"), ...(options.autoSearch ? { perplexity: searchClient("perplexity") } : {}) },
    onEvent(event) { if (event.type === "run-failed") errors.push(event.error); } });
  async function start(kind: "discovery" | "generate-ideas", followUp = false, scopeKey: string = kind) {
    const item = db.immediateTransaction(() => {
      const item = workflows.createWorkItem({ sessionId: "session", kind: followUp ? "research-request" : kind, scopeKey, state: "ready",
        input: followUp ? { action: { allowance: { maxModelCalls: 100, maxSearches: 100 } } } : {} });
      if (options.bounded) {
        workflows.reserveBudget({ sessionId: "session", workItemId: item.id, operationKey: "models", kind: "model-call",
          reservedUnits: options.taskModelReservation ?? options.maxModelCalls ?? 500 });
        if ((options.taskSearchReservation ?? options.maxSearches ?? 500) > 0) workflows.reserveBudget({ sessionId: "session", workItemId: item.id,
          operationKey: "searches", kind: "search", reservedUnits: options.taskSearchReservation ?? options.maxSearches ?? 500 });
      }
      return item;
    });
    const link = { sessionId: "session", ...(!followUp ? { frameId: draft.id } : {}),
      purpose: followUp ? "research-followup" as const : "discovery" as const, onRunCreated(runId: string) {
      if (followUp) frames.bindRun(runId, "project", draft.id);
      db.immediateTransaction(() => workflows.updateWorkItem(item.id, "running", { outputRefs: { runId } })); return true;
    } };
    const runId = kind === "discovery" ? await engine.startDiscovery("project", scope, config, link)
      : await engine.startKnownProblem("project", scope, "Owners repeat entries every week", config, link);
    await until(() => !engine.getActiveRunIds().has(runId));
    return runId;
  }
  return { db, engine, scheduler, stages, queries, errors, start, config, workflows, draft,
    async close() { await engine.shutdown(); db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}

function researchOutput(request: StructuredStageRequest<unknown>, options: {
  initialCandidates?: number; gapCandidates?: number; gap?: boolean; insufficient?: boolean;
} = {}): unknown {
  const stage = request.stage.split(":")[0];
  const routing = input(request);
  const packet = request.evidence[0]?.content as Record<string, unknown>;
  if (stage === "query-plan") return { queries: Array.from({ length: Number(routing.queryCount) }, (_, index) => ({
    query: `${(packet.scope as { domain: string }).domain} ${routing.harvestMode} ${index}`,
    intent: ["firsthand-experience", "measured-behavior", "contrary-evidence"][index % 3], uncertainty: "Scale unknown", intendedSourceType: "Owner reports" })) };
  if (stage === "factor-harvest") return { factors: (packet.sources as Array<{ id: string }>).map(source => ({ sourceId: source.id,
    subject: "Bakery owner", behavior: "Repeats filing", quote: text, modelConfidence: 0.8, uncertainty: "Scale unknown",
    sourceRole: "firsthand", audienceFit: "intended-buyer", independentSourceKey: source.id, supportsDemand: true, demandEvidenceUncertainty: "Payment unknown" })) };
  if (stage === "area-ranking") return { areas: (routing.frame as ResearchFrame).areas.map((area, index) => ({ areaId: area.id,
    rank: index + 1, reason: "Independent quotes", evidenceStrength: "strong", fit: "meets" })) };
  if (stage === "problem-candidates") {
    const factors = (packet.factors as Array<{ id: string }>).slice(0, 2);
    const gap = request.stage.includes(":gap");
    return { problems: Array.from({ length: gap ? options.gapCandidates ?? 1 : options.initialCandidates ?? 1 }, (_, index) => ({
      statement: `${(routing.area as { id: string }).id} ${gap ? "unsearched" : "initial"} workflow ${index + 1}`,
      whyItPersists: "Disconnected exports", affected: "Bakery owners", scaleEstimate: "Unknown", scaleBasisFactorId: null,
      factorIds: factors.map(factor => factor.id), intendedBuyerEvidenceFactorIds: factors.map(factor => factor.id),
      alternativeExplanations: ["An unusual owner"], unknowns: ["Frequency"], evidenceGap: null })) };
  }
  if (stage === "problem-kill") return { verdict: "confirmed", verdictReason: "Independent owner accounts", verdictSourceIds: [],
    unresolvedAssumptions: [], wouldChangeConclusion: ["Contrary observations"],
    intendedBuyerEvidenceFactorIds: (packet.supportingFactors as Array<{ id: string }>).slice(0, options.insufficient ? 1 : 2).map(factor => factor.id),
    evidenceGap: options.insufficient ? "Second independent owner required" : null, briefFit: "direct", contraryEvidence: "resolved", workflowKey: "filing" };
  if (stage === "evidence-check") return { decision: "confirmed", reason: "Use the saved evidence rule", gaps: [] };
  if (stage === "area-gap") return { reason: "Check one unsearched group", gaps: options.gap ? [{ name: "Another group",
    query: "new coverage", evidenceNeeded: "Independent owners in another group", route: "open-web" }] : [] };
  throw new Error(`Unexpected research stage ${request.stage}`);
}

test("goal generation saves revision two, globally readable frame citations, and independent reviewed fit", async () => {
  const f = await fixture(request => {
    if (request.stage === "solutions") { expect(input(request).frame).toEqual(frame()); return { options: [option()] }; }
    const id = (input(request).candidateIds as string[])[0];
    return { assessments: [{ candidateId: id, decision: "distinct", reason: "Useful distinct local workflow", matchingSolutionId: null,
      citedEvidenceIds: ["frame-source"], criteriaFit: fit("meets", "frame-source") }] };
  });
  try {
    const runId = await f.start("generate-ideas");
    expect(f.errors).toEqual([]);
    expect(f.stages).toEqual(["solutions", "solution-set-review"]);
    expect(f.db.db.prepare("SELECT stage_id,stage_revision FROM stage_results WHERE research_run_id = ? ORDER BY rowid").all(runId))
      .toEqual([{ stage_id: "solutions", stage_revision: 2 }, { stage_id: "solution-set-review", stage_revision: 2 }]);
    const row = f.db.db.prepare("SELECT criteria_fit_json,reviewed_criteria_fit_json FROM solutions WHERE research_run_id = ?").get(runId) as { criteria_fit_json: string; reviewed_criteria_fit_json: string };
    expect(JSON.parse(row.criteria_fit_json)).toEqual(fit("unknown"));
    expect(JSON.parse(row.reviewed_criteria_fit_json)).toEqual(fit("meets", "frame-source"));
    expect(f.db.db.prepare("SELECT retrieved_text FROM sources WHERE id = 'frame-source'").get()).toEqual({ retrieved_text: text });
    expect(new WorkflowExecution(f.db, runId).read<{ version: number }>("goal-fit")).toEqual({ version: 1 });
    expect(f.db.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { await f.close(); }
});

test("novelty acceptance waits for its durable search and a final review, preserving failed must-have fit", async () => {
  const f = await fixture(request => {
    if (request.stage === "solutions") return { options: [option(true)] };
    const id = (input(request).candidateIds as string[])[0];
    const isFinal = request.stage === "solution-set-review";
    const evidence = isFinal ? request.evidence.find(item => item.sourceId !== "frame-source")?.sourceId : undefined;
    if (isFinal) expect(evidence).toBeDefined();
    return { assessments: [{ candidateId: id, decision: "distinct", reason: "Compared with the available tools", matchingSolutionId: null,
      citedEvidenceIds: evidence ? [evidence] : [], criteriaFit: isFinal ? fit("fails", evidence, true) : fit("unknown", undefined, true) }] };
  }, { novelty: true, bounded: true, autoSearch: true });
  try {
    const runId = await f.start("generate-ideas");
    expect(f.errors).toEqual([]);
    expect(f.stages).toEqual(["solutions", "solution-set-review:preliminary", "solution-set-review"]);
    expect(f.queries).toHaveLength(1);
    const review = new WorkflowExecution(f.db, runId).repository.findStageResult(runId, "solution-set-review",
      (f.db.db.prepare("SELECT problem_id FROM research_runs WHERE id = ?").get(runId) as { problem_id: string }).problem_id)!;
    expect((review.context as { solutionSetReview: { decisions: Array<{ status: string }> } }).solutionSetReview.decisions[0]?.status).toBe("rejected");
    const row = f.db.db.prepare("SELECT reviewed_criteria_fit_json FROM solutions WHERE research_run_id = ?").get(runId) as { reviewed_criteria_fit_json: string };
    expect(JSON.parse(row.reviewed_criteria_fit_json)[0]?.status).toBe("fails");
    expect(f.db.db.prepare("SELECT COUNT(*) AS count FROM opportunity_exploration_attempts WHERE status = 'completed' AND stage_name = 'investigator-search'").get())
      .toEqual({ count: 1 });
    expect(f.db.db.prepare("SELECT json_extract(model_json,'$.providerId') AS provider FROM opportunity_exploration_attempts WHERE stage_name = 'investigator-search'").get())
      .toEqual({ provider: "perplexity" });
    expect(getRunTrace(f.db, runId).metrics).toMatchObject({ acceptedIdeas: 0, acceptedIdeasFailingMustHave: 0, modelCalls: f.stages.length });
  } finally { await f.close(); }
});

test.each([{ noSearchProvider: false, maxSearches: 0, maxModelCalls: 8 }, { noSearchProvider: true, maxSearches: 5, maxModelCalls: 8 },
  { noSearchProvider: false, maxSearches: 0, maxModelCalls: 2 }])(
  "known-problem novelty remains explained and unresolved when search is unavailable (%s)", async options => {
    const f = await fixture(request => {
      if (request.stage === "solutions") return { options: [option(true)] };
      if (request.stage === "solution-set-review") expect(input(request).unavailableNoveltyChecks).toHaveLength(1);
      const id = (input(request).candidateIds as string[])[0];
      return { assessments: [{ candidateId: id, decision: "distinct", reason: "The local workflow is distinct", matchingSolutionId: null,
        citedEvidenceIds: [], criteriaFit: fit("unknown", undefined, true) }] };
    }, { novelty: true, bounded: true, ...options });
    try {
      const runId = await f.start("generate-ideas");
      expect(f.errors).toEqual([]);
      expect(f.stages).toEqual(options.maxModelCalls === 2 ? ["solutions", "solution-set-review:preliminary"]
        : ["solutions", "solution-set-review:preliminary", "solution-set-review"]);
      expect(f.queries).toHaveLength(0);
      expect(getRunTrace(f.db, runId).metrics).toMatchObject({ acceptedIdeas: 0, acceptedIdeasFailingMustHave: 0, modelCalls: f.stages.length });
      const workflow = new WorkflowExecution(f.db, runId);
      const review = workflow.repository.findStageResult(runId, "solution-set-review",
        (f.db.db.prepare("SELECT problem_id FROM research_runs WHERE id = ?").get(runId) as { problem_id: string }).problem_id)!;
      const decision = (review.context as { solutionSetReview: { decisions: Array<{ status: string; reason: string }> } }).solutionSetReview.decisions[0]!;
      expect(decision.status).toBe("unresolved");
      expect(decision.reason).toContain(options.noSearchProvider ? "no connected search provider" : "no remaining search allowance");
      expect(workflow.read("generation-partial-outcome")).toMatchObject({ outcome: "partial" });
      expect(f.db.db.prepare("SELECT count(*) AS count FROM opportunity_exploration_attempts WHERE stage_name = 'investigator-search'").get()).toEqual({ count: 0 });
      expect(f.db.db.prepare("SELECT status FROM research_runs WHERE id = ?").get(runId)).toEqual({ status: "completed" });
      expect(f.db.db.prepare("SELECT count(*) AS count FROM workflow_snapshots WHERE research_run_id = ? AND snapshot_key LIKE 'solution-novelty:%:unavailable'").get(runId))
        .toEqual({ count: 1 });
      expect(f.db.db.prepare("SELECT count(*) AS count FROM workflow_snapshots WHERE research_run_id = ? AND snapshot_key LIKE 'solution-novelty:%:completed'").get(runId))
        .toEqual({ count: 0 });
    } finally { await f.close(); }
  });

test("a shared target stops a peer's next round and skips new area gaps after dispatched checks settle", async () => {
  const checking = new Set<string>(); let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async request => {
    const packet = request.evidence[0]?.content as { area?: { id: string } };
    if (request.stage.startsWith("evidence-check:")) {
      const id = packet.area!.id; checking.add(id);
      if (checking.size === 2) release();
      await gate;
      if (id === "handoff") { await Bun.sleep(10); return { decision: "follow-up", reason: "Another owner is needed", gaps: [{
        kind: "second-independent-observation", evidenceNeeded: "A second owner", query: "handoff owner experience", route: "community" }] }; }
    }
    return researchOutput(request, { insufficient: request.stage.startsWith("problem-kill:")
      && (input(request).area as { id: string }).id === "handoff", gap: true });
  }, { depth: "standard", bounded: true, modelCapacity: 2, researchTarget: { confirmedProblems: 1, minAreas: 1 } });
  try {
    const runId = await f.start("discovery");
    expect(f.errors).toEqual([]);
    expect(checking.size).toBe(2);
    expect(f.scheduler.activeCallCount).toBe(0);
    expect(f.stages.filter(stage => stage.startsWith("area-gap:") || stage.includes(":round-1"))).toEqual([]);
    expect(f.db.db.prepare("SELECT count(*) AS count FROM opportunity_exploration_attempts WHERE stage_name = 'investigator-search'").get()).toEqual({ count: 0 });
    expect(new WorkflowExecution(f.db, runId).read("research-target-outcome")).toMatchObject({ outcome: "target-met", confirmedProblems: 1, areas: 1 });
    expect(f.db.db.prepare("SELECT verdict FROM problems WHERE discovery_run_id = ? ORDER BY statement").all(runId))
      .toEqual([{ verdict: "confirmed" }, { verdict: "insufficient-evidence" }]);
    const handoff = f.workflows.listWorkItems("session").find(item => item.kind === "evidence-check" && item.scopeKey.includes(":handoff:"))!;
    expect(handoff.state).toBe("succeeded");
    expect((handoff.outputRefs as { stopReason: string }).stopReason).toContain("research target was met");
  } finally { release(); await f.close(); }
});

test.each([{ depth: "quick" as const, expected: 3 }, { depth: "deep" as const, expected: 8 }])(
  "gap assessment respects the whole area's depth candidate limit (%s)", async ({ depth, expected }) => {
    const f = await fixture(request => researchOutput(request, { gap: true, gapCandidates: 8, insufficient: true }),
      { depth, singleArea: true, search: async query => [{ id: query === "new coverage" ? "new-group" : "owner-one",
        url: query === "new coverage" ? "https://other.example/group" : "https://owners.example/filing", title: "Owner", text }] });
    try {
      const runId = await f.start("discovery");
      expect(f.errors).toEqual([]);
      expect(f.stages.filter(stage => stage.startsWith("problem-kill:"))).toHaveLength(expected);
      expect(f.db.db.prepare("SELECT count(*) AS count FROM problems WHERE discovery_run_id = ?").get(runId)).toEqual({ count: expected });
      expect(f.db.db.prepare("SELECT count(*) AS count FROM rejected_problem_candidates WHERE discovery_run_id = ? AND disposition = 'not-assessed'").get(runId))
        .toEqual({ count: 9 - expected });
      expect(f.db.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { await f.close(); }
  });

test("a known budget stop retains the first verdict and every remaining full candidate for later assessment", async () => {
  const f = await fixture(request => researchOutput(request, { initialCandidates: 3 }),
    { bounded: true, singleArea: true, maxModelCalls: 9 });
  try {
    const runId = await f.start("discovery");
    expect(f.errors).toEqual([]);
    expect(f.stages.filter(stage => stage.startsWith("problem-kill:"))).toHaveLength(1);
    expect(f.db.db.prepare("SELECT count(*) AS count FROM problems WHERE discovery_run_id = ?").get(runId)).toEqual({ count: 1 });
    const archived = f.db.db.prepare(`SELECT id, candidate_json FROM rejected_problem_candidates
      WHERE discovery_run_id = ? AND disposition = 'not-assessed' ORDER BY statement`).all(runId) as Array<{ id: string; candidate_json: string }>;
    expect(archived).toHaveLength(2);
    for (const row of archived) expect(JSON.parse(row.candidate_json)).toMatchObject({ alternativeExplanations: ["An unusual owner"], unknowns: ["Frequency"] });
    expect(new WorkflowExecution(f.db, runId).read("research-target-outcome")).toMatchObject({ outcome: "partial" });
    const item = f.db.immediateTransaction(() => {
      const item = f.workflows.createWorkItem({ sessionId: "session", kind: "assess-candidate", scopeKey: "assess-budget-archive", state: "ready", input: {} });
      f.workflows.reserveBudget({ sessionId: "session", workItemId: item.id, operationKey: "assess-models", kind: "model-call", reservedUnits: 2 });
      f.workflows.reserveBudget({ sessionId: "session", workItemId: item.id, operationKey: "assess-search", kind: "search", reservedUnits: 1 });
      return item;
    });
    const assessment = await f.engine.startCandidateAssessment("project", runId, archived[0]!.id, f.config, { sessionId: "session", purpose: "research-followup",
      onRunCreated(created) { f.db.immediateTransaction(() => f.workflows.updateWorkItem(item.id, "running", { outputRefs: { runId: created } })); return true; } });
    await until(() => !f.engine.getActiveRunIds().has(assessment));
    expect(f.errors).toEqual([]);
    expect(new WorkflowExecution(f.db, assessment).read("candidate-assessment-result")).toMatchObject({ assessed: true, candidateId: archived[0]!.id });
    expect(f.db.db.prepare("SELECT candidate_json FROM rejected_problem_candidates WHERE id = ?").get(archived[0]!.id))
      .toEqual({ candidate_json: archived[0]!.candidate_json });
    expect(f.db.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { await f.close(); }
});

test.each([{ failedArea: null }, { failedArea: "handoff" }])("selected area lanes overlap, retain source IDs, and settle their independent results (%s)", async ({ failedArea }) => {
  const planning = new Set<string>(); let release: () => void = () => {};
  let activePlans = 0; let maximumActivePlans = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async request => {
    const stage = request.stage.split(":")[0]; const routing = input(request);
    const evidence = request.evidence[0]?.content as Record<string, unknown>;
    if (stage === "query-plan") {
      if (request.stage.includes(":area-")) {
        planning.add((routing.area as { id: string }).id);
        activePlans += 1;
        maximumActivePlans = Math.max(maximumActivePlans, activePlans);
        if (planning.size === 2) release();
        await Promise.race([gate, Bun.sleep(250)]);
        activePlans -= 1;
        if ((routing.area as { id: string }).id === failedArea) throw new Error("The handoff investigator failed after both lanes started");
      }
      return { queries: Array.from({ length: Number(routing.queryCount) }, (_, index) => ({ query: `${(evidence.scope as { domain: string }).domain} ${routing.harvestMode} ${index}`,
        intent: ["firsthand-experience", "measured-behavior", "contrary-evidence"][index % 3], uncertainty: "Scale unknown", intendedSourceType: "Owner reports" })) };
    }
    if (stage === "factor-harvest") return { factors: (evidence.sources as Array<{ id: string }>).map(source => ({ sourceId: source.id,
      subject: "Bakery owner", behavior: "Repeats filing", quote: text, modelConfidence: 0.8, uncertainty: "Scale unknown",
      sourceRole: "firsthand", audienceFit: "intended-buyer", independentSourceKey: source.id, supportsDemand: true, demandEvidenceUncertainty: "Payment unknown" })) };
    if (stage === "area-ranking") return { areas: frame().areas.map((area, index) => ({ areaId: area.id, rank: index + 1, reason: "Independent quotes",
      evidenceStrength: "strong", fit: "meets" })) };
    if (stage === "problem-candidates") {
      const factors = (evidence.factors as Array<{ id: string }>).slice(0, 2);
      return { problems: [{ statement: `${(routing.area as { id: string }).id} takes repeated work`, whyItPersists: "Repeated entries", affected: "Bakery owners", scaleEstimate: "Unknown",
        scaleBasisFactorId: null, factorIds: factors.map(factor => factor.id), alternativeExplanations: ["One unusual shop"], unknowns: ["Frequency"],
        intendedBuyerEvidenceFactorIds: factors.map(factor => factor.id), evidenceGap: null }] };
    }
    if (stage === "problem-kill") return { verdict: "confirmed", verdictReason: "Two independent owner reports", verdictSourceIds: [],
      unresolvedAssumptions: [], wouldChangeConclusion: ["Contrary observations"], intendedBuyerEvidenceFactorIds: (evidence.supportingFactors as Array<{ id: string }>).map(factor => factor.id),
      evidenceGap: null, briefFit: "direct", contraryEvidence: "resolved", workflowKey: "repeated-filing" };
    if (stage === "evidence-check") return { decision: "drop", reason: "The observed workflow does not fit the approved criteria", gaps: [] };
    if (stage === "area-gap") return { gaps: [], reason: "No additional bounded workflows" };
    throw new Error(`Unexpected fixture stage ${request.stage}`);
  }, { depth: "standard", bounded: true, modelCapacity: 2 });
  try {
    const runId = await f.start("discovery");
    const scans = f.db.db.prepare("SELECT snapshot_key,json_extract(value_json,'$.qualifyingFacts') AS facts FROM workflow_snapshots WHERE research_run_id = ? AND snapshot_key LIKE 'frame-scan:%'").all(runId);
    expect({ errors: f.errors, scans, stages: f.stages.filter(stage => stage.includes(":area-")), planning: [...planning] })
      .toMatchObject({ errors: failedArea ? ["The handoff investigator failed after both lanes started"] : [], planning: ["filing", "handoff"] });
    expect(maximumActivePlans).toBe(2);
    expect(f.scheduler.activeCallCount).toBe(0);
    expect(f.db.db.prepare("SELECT COUNT(*) AS count FROM problems WHERE discovery_run_id = ?").get(runId)).toEqual({ count: 0 });
    expect(f.db.db.prepare("SELECT COUNT(*) AS count FROM rejected_problem_candidates WHERE discovery_run_id = ? AND disposition = 'blocked'").get(runId))
      .toEqual({ count: failedArea ? 1 : 2 });
    const lanes = f.workflows.listWorkItems("session").filter(item => item.kind === "investigate-area");
    expect(lanes).toHaveLength(2);
    for (const lane of lanes) {
      const failed = lane.scopeKey === `investigate-area:${failedArea}`;
      expect(lane.state).toBe(failed ? "failed" : "succeeded");
      if (!failed) expect((lane.outputRefs as { investigator: { confirmedCount: number; droppedCount: number } }).investigator)
        .toMatchObject({ confirmedCount: 0, droppedCount: 1 });
    }
    const allowances = f.db.db.prepare(`SELECT snapshot_key, value_json FROM workflow_snapshots
      WHERE research_run_id = ? AND snapshot_key LIKE 'area:%:allowance' ORDER BY snapshot_key`).all(runId) as Array<{ snapshot_key: string; value_json: string }>;
    expect(allowances.map(row => JSON.parse(row.value_json).areaId)).toEqual(["filing", "handoff"]);
    expect(allowances.every(row => JSON.parse(row.value_json).maxModelCalls > 0 && JSON.parse(row.value_json).maxSearches > 0)).toBe(true);
    const searches = f.db.db.prepare(`SELECT json_extract(usage_json,'$.areaId') AS areaId, count(*) AS count FROM cost_ledger
      WHERE research_run_id = ? AND operation = 'search' AND json_extract(usage_json,'$.areaId') IS NOT NULL GROUP BY areaId ORDER BY areaId`).all(runId) as Array<{ areaId: string; count: number }>;
    expect(searches.map(row => row.areaId)).toEqual(failedArea ? ["filing"] : ["filing", "handoff"]);
    expect(searches.every(row => row.count > 0)).toBe(true);
    expect(f.db.db.prepare("SELECT COUNT(*) AS count FROM sources WHERE research_run_id = ?").get(runId)).toEqual({ count: 2 });
    expect(f.db.db.prepare("SELECT retrieved_text FROM sources WHERE id = 'frame-source'").get()).toEqual({ retrieved_text: text });
    if (failedArea) expect(f.workflows.listWorkItems("session").filter(item =>
      ["investigate-area", "area-research", "area-candidates", "evidence-check"].includes(item.kind))
      .every(item => ["succeeded", "failed", "skipped"].includes(item.state))).toBe(true);
    else expect(new WorkflowExecution(f.db, runId).read("research-target-outcome")).toMatchObject({ outcome: "partial", confirmedProblems: 0 });
    expect(f.db.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { release(); await f.close(); }
});

test("saved-candidate assessment uses copied original quotes without synthesizing a new candidate", async () => {
  const candidatesSeen: unknown[] = [];
  const f = await fixture(request => {
    const evidence = request.evidence[0]?.content as { candidate?: unknown; supportingFactors?: Array<{ id: string }> };
    if (request.stage.startsWith("problem-kill:")) {
      candidatesSeen.push(evidence.candidate);
      return { verdict: "confirmed", verdictReason: "The quote describes the saved workflow", verdictSourceIds: [],
        unresolvedAssumptions: [], wouldChangeConclusion: ["A second independent observation"],
        intendedBuyerEvidenceFactorIds: evidence.supportingFactors?.map(factor => factor.id) ?? [], evidenceGap: "Second independent observation required",
        briefFit: "direct", contraryEvidence: "resolved", workflowKey: "original-filing" };
    }
    if (request.stage.startsWith("evidence-check:")) return { decision: "confirmed", reason: "No further bounded round at quick depth", gaps: [] };
    throw new Error(`Assessment must not synthesize: ${request.stage}`);
  });
  try {
    const sourceRun = new ResearchRunRepository(f.db).create("project", f.config).runId;
    const discovery = new DiscoveryRepository(f.db); discovery.persistScope(sourceRun, scope);
    const now = new Date().toISOString();
    discovery.persistFactors(sourceRun, [{ id: "original-source", providerSourceId: "original-provider", canonicalUrl: "https://original.example/owner",
      title: "Original owner", retrievedText: text, contentHash: hash(text), retrievedAt: now, author: null, publishedAt: null }],
      [{ id: "original-factor", sourceId: "original-source", subject: "Bakery owner", behavior: "Repeats filing", quote: text,
        harvestMode: "audience", modelConfidence: 0.8, sourceRole: "firsthand", audienceFit: "intended-buyer",
        independentSourceKey: "original-owner", supportsDemand: true }]);
    const candidate = { statement: "Owners repeat filing every week", whyItPersists: "Disconnected exports", affected: "Bakery owners", scaleEstimate: "Unknown",
      scaleBasisFactorId: "original-factor", factorIds: ["original-factor"], intendedBuyerEvidenceFactorIds: ["original-factor"],
      alternativeExplanations: ["One unusual owner"], unknowns: ["Other shops"], evidenceGap: "Second owner" };
    discovery.persistProblems(sourceRun, [], [], [{ statement: candidate.statement, reason: "Depth candidate cap", disposition: "not-assessed", candidate }]);
    f.db.db.prepare("UPDATE research_runs SET status = 'completed' WHERE id = ?").run(sourceRun);
    const original = f.db.db.prepare("SELECT id,candidate_json FROM rejected_problem_candidates WHERE discovery_run_id = ?").get(sourceRun) as { id: string; candidate_json: string };
    const item = f.db.immediateTransaction(() => f.workflows.createWorkItem({ sessionId: "session", kind: "assess-candidate", scopeKey: "assess", state: "ready", input: {} }));
    const runId = await f.engine.startCandidateAssessment("project", sourceRun, original.id, f.config, { sessionId: "session", purpose: "research-followup",
      onRunCreated(created) { f.db.immediateTransaction(() => f.workflows.updateWorkItem(item.id, "running", { outputRefs: { runId: created } })); return true; } });
    await until(() => !f.engine.getActiveRunIds().has(runId));
    expect(f.errors).toEqual([]); expect(candidatesSeen).toHaveLength(1); expect(f.queries).toHaveLength(1);
    expect(f.stages.some(stage => stage.startsWith("problem-candidates"))).toBe(false);
    expect(f.db.db.prepare("SELECT candidate_json FROM rejected_problem_candidates WHERE id = ?").get(original.id)).toEqual({ candidate_json: original.candidate_json });
    const result = new WorkflowExecution(f.db, runId);
    expect(result.read("candidate-assessment-result")).toMatchObject({ assessed: true, candidateId: original.id, sourceRunId: sourceRun, verdict: "insufficient-evidence" });
    expect(result.read("candidate-assessment-frame")).toMatchObject({ provenance: { kind: "reconstructed-from-saved-scope", sourceRunId: sourceRun } });
    const copied = f.db.db.prepare("SELECT id,quote,source_id FROM factors WHERE research_run_id = ?").get(runId) as { id: string; quote: string; source_id: string };
    expect(copied.id).not.toBe("original-factor"); expect(copied.source_id).not.toBe("original-source"); expect(copied.quote).toBe(text);
    const problem = f.db.db.prepare("SELECT scale_basis_factor_id,intended_buyer_evidence_factor_ids_json FROM problems WHERE discovery_run_id = ?").get(runId) as {
      scale_basis_factor_id: string; intended_buyer_evidence_factor_ids_json: string;
    };
    expect(problem.scale_basis_factor_id).toBe(copied.id); expect(JSON.parse(problem.intended_buyer_evidence_factor_ids_json)).toEqual([copied.id]);
    expect(f.db.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { await f.close(); }
});

test("a lost candidate gap search resumes only after its exact acknowledgment without resynthesis or source loss", async () => {
  let gapDispatches = 0;
  const f = await fixture(request => {
    if (request.stage.startsWith("evidence-check:")) {
      const packet = request.evidence[0]!.content as { problem: { verdict: string } };
      return { decision: packet.problem.verdict === "confirmed" ? "confirmed" : "follow-up", reason: "Check another owner",
        gaps: packet.problem.verdict === "confirmed" ? [] : [{ kind: "second-independent-observation", route: "community",
          query: "second bakery owner filing", evidenceNeeded: "A second independent owner report" }] };
    }
    return researchOutput(request);
  }, { depth: "standard", autoSearch: true, search: async (query, options, provider) => {
    expect(provider).toBe("exa");
    expect(options).toMatchObject({ provider: "exa", route: query === "second bakery owner filing" ? "community" : "contrary" });
    if (query !== "second bakery owner filing") return [];
    gapDispatches++;
    if (gapDispatches === 1) throw new Error("Gap response lost after dispatch");
    return [{ id: "second-owner", url: "https://another.example.org/owner", title: "Another owner", text }];
  } });
  try {
    const sourceRun = new ResearchRunRepository(f.db).create("project", f.config).runId;
    const discovery = new DiscoveryRepository(f.db); discovery.persistScope(sourceRun, scope);
    discovery.persistFactors(sourceRun, [{ id: "original-source", providerSourceId: "original-provider", canonicalUrl: "https://original.example.org/owner",
      title: "Original owner", retrievedText: text, contentHash: hash(text), retrievedAt: new Date().toISOString(), author: null, publishedAt: null }],
      [{ id: "original-factor", sourceId: "original-source", subject: "Bakery owner", behavior: "Repeats filing", quote: text,
        harvestMode: "audience", modelConfidence: 0.8, sourceRole: "firsthand", audienceFit: "intended-buyer",
        independentSourceKey: "original-owner", supportsDemand: true }]);
    const candidate = { statement: "Owners repeat filing", whyItPersists: "Disconnected exports", affected: "Bakery owners", scaleEstimate: "Unknown",
      scaleBasisFactorId: null, factorIds: ["original-factor"], intendedBuyerEvidenceFactorIds: ["original-factor"],
      alternativeExplanations: ["One unusual owner"], unknowns: ["Other shops"], evidenceGap: "Second owner" };
    discovery.persistProblems(sourceRun, [], [], [{ statement: candidate.statement, reason: "Depth cap", disposition: "not-assessed", candidate }]);
    f.db.db.prepare("UPDATE research_runs SET status = 'completed' WHERE id = ?").run(sourceRun);
    const archived = f.db.db.prepare("SELECT id,candidate_json FROM rejected_problem_candidates WHERE discovery_run_id = ?").get(sourceRun) as { id: string; candidate_json: string };
    const item = f.db.immediateTransaction(() => f.workflows.createWorkItem({ sessionId: "session", kind: "assess-candidate", scopeKey: "assess-lost-gap", state: "ready", input: {} }));
    const runId = await f.engine.startCandidateAssessment("project", sourceRun, archived.id, f.config, { sessionId: "session", purpose: "research-followup", frameId: f.draft.id,
      onRunCreated(created) { f.db.immediateTransaction(() => f.workflows.updateWorkItem(item.id, "running", { outputRefs: { runId: created } })); return true; } });
    await until(() => !f.engine.getActiveRunIds().has(runId));
    expect(f.errors).toEqual(["Gap response lost after dispatch"]);
    expect(new WorkflowExecution(f.db, runId).read("candidate-assessment-frame")).toMatchObject({ frame: frame(),
      provenance: { kind: "approved-frame", frameId: f.draft.id, sourceRunId: sourceRun, candidateId: archived.id } });
    const lost = f.db.db.prepare("SELECT * FROM opportunity_exploration_attempts WHERE status = 'unknown-dispatch'").get() as { id: string; stage_key: string };
    expect(lost.stage_key).toContain(":round-1:gap-1");
    await expect(f.engine.resumeRun(runId)).rejects.toThrow("previous investigator search");
    expect(gapDispatches).toBe(1);
    await f.engine.resumeRun(runId, [lost.id]);
    await until(() => !f.engine.getActiveRunIds().has(runId));
    expect(gapDispatches).toBe(2);
    expect(f.errors).toHaveLength(1);
    expect(new WorkflowExecution(f.db, runId).read("candidate-assessment-result")).toMatchObject({ assessed: true, verdict: "confirmed" });
    expect(f.stages.filter(stage => stage.startsWith("problem-kill:") && stage.endsWith(":assess"))).toHaveLength(1);
    expect(f.stages.filter(stage => stage.startsWith("evidence-check:") && stage.endsWith(":round-0"))).toHaveLength(1);
    expect(f.stages.some(stage => stage.startsWith("problem-candidates:"))).toBe(false);
    expect(f.db.db.prepare("SELECT * FROM opportunity_exploration_attempts WHERE id = ?").get(lost.id)).toEqual(lost);
    expect(f.db.db.prepare("SELECT candidate_json FROM rejected_problem_candidates WHERE id = ?").get(archived.id)).toEqual({ candidate_json: archived.candidate_json });
    expect(f.db.db.prepare("SELECT quote FROM factors WHERE id = 'original-factor'").get()).toEqual({ quote: text });
    expect(f.db.db.prepare("SELECT count(*) AS count FROM sources WHERE research_run_id = ?").get(runId)).toEqual({ count: 2 });
    expect(f.db.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { await f.close(); }
});

test("frame venues expand routed searches only with saved retrieved proof and keep the area's region", async () => {
  const approved = frame();
  approved.areas.forEach(area => { area.region = "UA"; area.venues = [
    { name: "Saved issue tracker", kind: "issue-tracker", domain: "github.com" },
    { name: "DNS only", kind: "issue-tracker", domain: "example.org" },
  ]; });
  let dnsCalls = 0;
  const routed: SearchOptions[] = [];
  const f = await fixture(request => researchOutput(request), { frameValue: approved, frameSourceUrl: "https://github.com/owners/project/issues/1",
    autoSearch: true, venueResolver: async domain => { expect(domain).toBe("example.org"); dnsCalls++; return ["93.184.215.14"]; },
    search: async (_query, options) => { if (options) routed.push(options); return [{ id: "account", url: "https://another.example.org/owner", title: "Owner", text }]; } });
  try {
    const runId = await f.start("discovery");
    expect(f.errors).toEqual([]);
    expect(dnsCalls).toBe(1);
    const validation = new WorkflowExecution(f.db, runId).read("frame-source-venues");
    expect(validation).toMatchObject({ version: 2, validated: true, verified: approved.areas.map(area => area.venues[0]),
      proofs: [{ domain: "github.com", method: "saved-source", sourceUrl: "https://github.com/owners/project/issues/1" }, { domain: "example.org", method: "dns" }] });
    expect(routed.filter(options => options.route === "issue-tracker").length).toBeGreaterThan(0);
    expect(routed.every(options => options.userLocation === "UA")).toBe(true);
    expect(routed.every(options => !options.includeDomains?.includes("example.org"))).toBe(true);
    expect(routed.filter(options => options.route === "issue-tracker").every(options => options.includeDomains?.includes("github.com"))).toBe(true);
    expect(f.draft.approved).toBeNull();
    expect(new ResearchFrameRepository(f.db).get(f.draft.id)?.approved).toEqual(approved);
    expect(f.db.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { await f.close(); }
});

test("new ordinary research follow-ups use their frozen approved goal, criteria, and exclusions in actual model requests", async () => {
  const approved = frame(); approved.exclusions = ["Do not collect payment details"];
  approved.constraints = [{ text: "Use existing exports", kind: "scope", basis: "brief" }];
  let latestCreated = false;
  const f = await fixture(request => {
    expect(input(request).frame).toEqual(approved);
    if (!latestCreated) {
      latestCreated = true;
      const edited = { ...approved, goal: "A later unrelated project goal", exclusions: ["A later exclusion"] };
      new ResearchFrameRepository(f.db).createApprovedVersion(f.draft.id, "project", edited);
    }
    if (request.stage.split(":")[0] === "problem-candidates") {
      const packet = request.evidence[0]!.content as { factors: Array<{ id: string }> };
      return { problems: [{ statement: "Filing exports repeat work", whyItPersists: "Disconnected exports", affected: "Bakery owners",
        scaleEstimate: "Unknown", scaleBasisFactorId: null, factorIds: packet.factors.slice(0, 2).map(factor => factor.id),
        intendedBuyerEvidenceFactorIds: packet.factors.slice(0, 2).map(factor => factor.id),
        alternativeExplanations: ["One unusual owner"], unknowns: ["Frequency"], evidenceGap: null }] };
    }
    return researchOutput(request);
  }, { frameValue: approved });
  try {
    const runId = await f.start("discovery", true);
    expect(f.errors).toEqual([]);
    expect(latestCreated).toBe(true);
    expect(new ResearchFrameRepository(f.db).forRun(runId)?.approved).toEqual(approved);
    expect(new ResearchFrameRepository(f.db).latestApproved("project")?.approved?.goal).toBe("A later unrelated project goal");
    expect(f.stages.some(stage => stage.startsWith("area-ranking"))).toBe(false);
    expect(new WorkflowExecution(f.db, runId).read("discovery-completed")).toBeDefined();
  } finally { await f.close(); }
});

test("same-run novelty recovery spends only its fresh allowance while old uncertainty and released reservations stay settled", async () => {
  let searchCalls = 0;
  const f = await fixture(request => {
    if (request.stage === "solutions") return { options: [option(true)] };
    const id = (input(request).candidateIds as string[])[0]!;
    const final = request.stage === "solution-set-review";
    if (final) expect(request.repairPolicy).toBe("disabled");
    const sourceId = final ? request.evidence.find(source => source.sourceId !== "frame-source")?.sourceId : undefined;
    return { assessments: [{ candidateId: id, decision: "distinct", reason: "Compared against saved existing-tool evidence", matchingSolutionId: null,
      citedEvidenceIds: sourceId ? [sourceId] : [], criteriaFit: final ? fit("meets", sourceId, true) : fit("unknown", undefined, true) }] };
  }, { novelty: true, bounded: true, autoSearch: true, maxModelCalls: 10, maxSearches: 10, taskModelReservation: 3, taskSearchReservation: 1,
    search: async (_query, options, provider) => {
      expect(provider).toBe("perplexity"); expect(options).toMatchObject({ route: "alternatives", provider: "perplexity" });
      searchCalls++;
      if (searchCalls === 1) throw new Error("Novelty search response was lost");
      return [{ id: "existing-tool", url: "https://tools.example.org/filing", title: "Existing filing tool", text: "The tool compares local filing exports." }];
    } });
  try {
    const runId = await f.start("generate-ideas");
    expect(f.errors).toEqual(["Novelty search response was lost"]);
    const lost = f.db.db.prepare("SELECT * FROM opportunity_exploration_attempts WHERE status = 'unknown-dispatch'").get() as { id: string };
    const task = f.workflows.listWorkItems("session").find(item => (item.outputRefs as { runId?: string })?.runId === runId)!;
    const originalEntries = f.workflows.listBudgetEntries("session").filter(entry => entry.workItemId === task.id);
    f.db.immediateTransaction(() => {
      for (const entry of originalEntries) f.workflows.settleBudget(entry.id, { state: "uncertain", settledUnits: entry.reservedUnits });
      const unused = f.workflows.reserveBudget({ sessionId: "session", workItemId: task.id, operationKey: "unused-model-allowance", kind: "model-call", reservedUnits: 5 });
      f.workflows.settleBudget(unused.id, { state: "released", settledUnits: 0 });
      f.db.db.prepare("INSERT INTO workflow_snapshots VALUES (?, 'task-budget-retry-baseline:explicit-retry', ?)").run(runId,
        JSON.stringify({ modelCalls: f.workflows.countProviderAttempts(runId), searches: 1, searchAttempts: 1 }));
      f.workflows.reserveBudget({ sessionId: "session", workItemId: task.id, operationKey: "fresh-retry-models", kind: "model-call", reservedUnits: 1 });
      f.workflows.reserveBudget({ sessionId: "session", workItemId: task.id, operationKey: "fresh-retry-searches", kind: "search", reservedUnits: 1 });
    });
    const settledBefore = f.workflows.listBudgetEntries("session").filter(entry => entry.state !== "reserved");
    await f.engine.resumeRun(runId, [lost.id]);
    await until(() => !f.engine.getActiveRunIds().has(runId));
    expect(f.errors).toHaveLength(1); expect(searchCalls).toBe(2);
    expect(f.stages).toEqual(["solutions", "solution-set-review:preliminary", "solution-set-review"]);
    expect(f.db.db.prepare("SELECT status FROM research_runs WHERE id = ?").get(runId)).toEqual({ status: "completed" });
    expect(getRunTrace(f.db, runId).metrics).toMatchObject({ acceptedIdeas: 1, acceptedIdeasFailingMustHave: 0, modelCalls: 3 });
    expect(f.workflows.listBudgetEntries("session").filter(entry => entry.state !== "reserved")).toEqual(settledBefore);
    expect(f.db.db.prepare("SELECT * FROM opportunity_exploration_attempts WHERE id = ?").get(lost.id)).toEqual(lost);
    expect(f.db.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { await f.close(); }
});

test("a second idea round reloads a saved startup idea judged against a market goal", async () => {
  // Live Bookkeepers stopped here: the saved idea had both goal fit and startup details.
  const marketFrame: ResearchFrame = { ...frame(), goalKind: "market-opportunity" };
  const startup = { opportunityType: "startup-opportunity", payingCustomerSegment: "Bakery owners", trigger: "Weekly filing", existingSubstitute: "Spreadsheets",
    gapAssessment: { kind: "hypothesis", description: "Spreadsheets may miss repeats", evidenceIds: [] }, smallestSellableWorkflow: "One export comparison",
    firstCustomerRoute: "Local bakery owners", disconfirmingDemandTest: "Owners refuse a paid pilot" };
  const focusedDemandTest = { schemaVersion: 1, assumption: { id: "filing.adoption", category: "adoption", testableClaim: "Owners keep using the comparison",
    decisionImpact: "Stop if use falls", selectionReason: "Use is the main unknown" }, methodSummary: "Observe five owners for a week",
    disconfirmingObservation: "Owners stop comparing exports", paymentTerms: null };
  let rounds = 0;
  const f = await fixture(request => {
    if (request.stage === "solutions") {
      rounds += 1;
      const base = option();
      return { options: [{ ...base, mechanism: `${base.mechanism} ${rounds}`, startupOpportunity: startup, focusedDemandTest,
        firstTest: { ...base.firstTest, kind: "demand-test" } }] };
    }
    const id = (input(request).candidateIds as string[])[0];
    return { assessments: [{ candidateId: id, decision: "distinct", reason: "Reviewed", matchingSolutionId: null,
      citedEvidenceIds: ["frame-source"], criteriaFit: fit("meets", "frame-source") }] };
  }, { frameValue: marketFrame });
  try {
    await f.start("generate-ideas");
    // A second idea task in the same session reviews against the first task's saved idea.
    await f.start("generate-ideas", false, "generate-ideas:second-problem");
    expect(f.errors).toEqual([]);
    expect(rounds).toBe(2);
    expect(f.stages).toEqual(["solutions", "solution-set-review", "solutions", "solution-set-review"]);
  } finally { await f.close(); }
});

test("a verdict citing a fact ID or an invented ID keeps research going with mapped citations", async () => {
  // Live Bookkeepers stopped here: the verdict cited fact IDs as source IDs.
  const f = await fixture(request => {
    const output = researchOutput(request) as Record<string, unknown>;
    if (!request.stage.startsWith("problem-kill")) return output;
    const factors = (request.evidence[0]?.content as { supportingFactors?: Array<{ id: string }> }).supportingFactors ?? [];
    return { ...output, verdictSourceIds: [...factors.map(factor => factor.id), "invented-source"] };
  }, { singleArea: true });
  try {
    const runId = await f.start("discovery");
    expect(f.errors).toEqual([]);
    const cited = f.db.db.prepare(`SELECT pvs.source_id FROM problem_verdict_sources pvs JOIN problems p ON p.id = pvs.problem_id
      WHERE p.discovery_run_id = ?`).all(runId) as Array<{ source_id: string }>;
    const sources = new Set((f.db.db.prepare("SELECT id FROM sources WHERE research_run_id = ?").all(runId) as Array<{ id: string }>).map(row => row.id));
    expect(cited.length).toBeGreaterThan(0);
    expect(cited.every(row => sources.has(row.source_id))).toBe(true);
  } finally { await f.close(); }
});

test("a research call that times out is retried once with its stage time limit", async () => {
  const kills: Array<number | undefined> = [];
  const f = await fixture(request => {
    if (request.stage.startsWith("problem-kill")) {
      kills.push(request.callTimeLimitMs);
      if (kills.length === 1) throw new ProviderFailure("timeout", "Call time limit reached", false);
    }
    return researchOutput(request);
  }, { singleArea: true });
  try {
    const runId = await f.start("discovery");
    expect(f.errors).toEqual([]);
    expect(kills.slice(0, 2)).toEqual([480_000, 480_000]);
    const saved = f.db.db.prepare(`SELECT status, json_extract(request_json, '$.callTimeLimitMs') AS limitMs FROM generation_attempts
      WHERE research_run_id = ? AND stage_key LIKE 'problem-kill%' ORDER BY created_at, rowid`).all(runId) as Array<{ status: string; limitMs: number }>;
    expect(saved.slice(0, 2)).toEqual([{ status: "failed", limitMs: 480_000 }, { status: "completed", limitMs: 480_000 }]);
    const confirmed = f.db.db.prepare("SELECT COUNT(*) AS count FROM problems WHERE discovery_run_id = ? AND verdict = 'confirmed'").get(runId) as { count: number };
    expect(confirmed.count).toBeGreaterThan(0);
  } finally { await f.close(); }
});

test("a model failure late in an area keeps the problems it already checked and the run continues", async () => {
  // Live Bookkeepers lost a confirmed categorization problem when a later call in its area failed.
  const f = await fixture(request => {
    if (request.stage.startsWith("area-gap")) throw new ProviderFailure("output-limit", "Output limit reached", false);
    return researchOutput(request);
  }, { singleArea: true });
  try {
    const runId = await f.start("discovery");
    expect(f.errors).toEqual([]);
    const confirmed = f.db.db.prepare("SELECT COUNT(*) AS count FROM problems WHERE discovery_run_id = ? AND verdict = 'confirmed'").get(runId) as { count: number };
    expect(confirmed.count).toBeGreaterThan(0);
    const outcome = f.db.db.prepare("SELECT value_json FROM workflow_snapshots WHERE research_run_id = ? AND snapshot_key = 'research-target-outcome'")
      .get(runId) as { value_json: string } | undefined;
    expect(JSON.parse(outcome!.value_json).reason).toContain("stopped early because a model call failed");
  } finally { await f.close(); }
});

test("a new run scans areas and checks candidates at the same time, within the shared call cap", async () => {
  const active = new Map<string, number>();
  const peak = new Map<string, number>();
  const f = await fixture(async request => {
    const family = request.stage.includes(":scan-") ? "scan" : request.stage.split(":")[0]!;
    active.set(family, (active.get(family) ?? 0) + 1);
    peak.set(family, Math.max(peak.get(family) ?? 0, active.get(family)!));
    await Bun.sleep(10);
    active.set(family, active.get(family)! - 1);
    return researchOutput(request, { initialCandidates: 2 });
  }, { modelCapacity: 3, depth: "standard" });
  try {
    const runId = await f.start("discovery");
    expect(f.errors).toEqual([]);
    expect(peak.get("scan")).toBeGreaterThan(1);
    expect(peak.get("evidence-check")).toBeGreaterThan(1);
    expect([...peak.values()].every(count => count <= 3)).toBe(true);
    const checked = f.db.db.prepare("SELECT COUNT(*) AS count FROM problems WHERE discovery_run_id = ? AND verdict = 'confirmed'").get(runId) as { count: number };
    expect(checked.count).toBeGreaterThan(1);
  } finally { await f.close(); }
});
