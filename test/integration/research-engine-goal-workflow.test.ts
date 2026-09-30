import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResearchEngine } from "../../src/core/research-engine";
import { WorkflowModelScheduler } from "../../src/core/workflow-scheduler";
import { configurePromptPaths } from "../../src/core/prompts";
import { WorkflowExecution } from "../../src/core/workflow-execution";
import { DatabaseClient } from "../../src/db/client";
import { DiscoveryRepository } from "../../src/db/repositories/discovery";
import { ResearchFrameRepository } from "../../src/db/repositories/research-frames";
import { ResearchRunRepository } from "../../src/db/repositories/research-runs";
import { WorkflowRepository } from "../../src/db/repositories/workflows";
import type { StructuredModelClient, StructuredStageRequest } from "../../src/providers/structured";
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
  const scheduler = new WorkflowModelScheduler();
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
  async function start(kind: "discovery" | "generate-ideas", followUp = false) {
    const item = db.immediateTransaction(() => {
      const item = workflows.createWorkItem({ sessionId: "session", kind: followUp ? "research-request" : kind, scopeKey: kind, state: "ready",
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
