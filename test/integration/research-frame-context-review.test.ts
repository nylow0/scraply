import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configurePromptPaths } from "../../src/core/prompts";
import type { WorkflowV2StageId } from "../../src/core/stages";
import { scanResearchArea } from "../../src/core/frame-discovery";
import { ResearchEngine } from "../../src/core/research-engine";
import { WorkflowExecution } from "../../src/core/workflow-execution";
import { DatabaseClient } from "../../src/db/client";
import { DiscoveryRepository } from "../../src/db/repositories/discovery";
import { GenerationAttemptRepository } from "../../src/db/repositories/generation-attempts";
import { ResearchFrameRepository } from "../../src/db/repositories/research-frames";
import { ResearchRunRepository } from "../../src/db/repositories/research-runs";
import type { StructuredModelClient, StructuredStageRequest } from "../../src/providers/structured";
import type { SearchClient, SearchOptions } from "../../src/providers/search";
import { canonicalJson, sha256 } from "../../src/shared/content-identity";
import type { ResearchFrame } from "../../src/shared/research-frame";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";

const model = { providerId: "fixture", modelId: "frame-context" };
const scope = { title: "Filing", domain: "Repeated entries", audience: "Owners", observations: "", offLimits: [] };
const source = { id: "frame-source", url: "https://www.reddit.com/r/filing", title: "Owner report", text: "I repeat filing every week." };
const config = { ...DEFAULT_RUN_CONFIG, workflowVersion: 2 as const, model, ideaCount: 1, discoveryDepth: "quick" as const,
  explorationPurpose: "general-solutions" as const };

function frame(languages = ["en"]): ResearchFrame {
  return { goal: "Reduce repeated entries", goalKind: "process-improvement", languages,
    contextFacts: [{ fact: "Owners repeat filing", sourceIds: [source.id] }],
    successCriteria: [{ id: "time", name: "Less filing time", weight: "must", howJudged: "Compare weekly filing time", basis: "brief" }],
    constraints: [{ text: "Use local exports only", kind: "scope", basis: "brief" }], exclusions: [], openQuestions: [],
    areas: [{ id: "filing", name: "Filing", whyRelevant: "Repeated entries", affectedPeople: "Owners", region: "UA",
      venues: [{ name: "Owner reports", kind: "community", domain: "reddit.com" }], exampleProblems: [], included: true, priority: 1 }] };
}

function option() {
  return { mechanism: "Local comparison", description: "Compare local exports", keyAssumption: "Stable record IDs",
    whyCurrentApproachMaySuffice: "Manual filing may suffice", supportingEvidenceIds: [source.id], contraryEvidenceIds: [],
    unknowns: ["Time saved"], respectsOffLimits: true, respectsOffLimitsWhy: "Local exports",
    biggerProblem: { statement: "Repeated entries waste time", affected: "Owners", scale: "Unknown", scaleKnown: false, scaleEvidenceIds: [] },
    slice: { description: "One export comparison", connectionToBiggerProblem: "Avoid repeated work", feasibilityWithinConstraints: "Local exports" },
    criteriaFit: [{ criterionId: "time", criterionName: "Less filing time", mustHave: true, status: "meets", evidenceIds: [source.id], note: "Saved owner report" }],
    firstTest: { kind: "process-test", question: "Approved local test", method: "Compare one week", cost: "One hour", metric: "Repeat entries",
      sample: 5, observationWindow: "One week", passCriterion: "Fewer entries", failCriterion: "More entries", inconclusiveCriterion: "Equal entries" } };
}

function routing(request: StructuredStageRequest<unknown>) {
  const inputs = request.workOrder.inputs as Record<string, unknown>;
  return "routing" in inputs ? inputs.routing as Record<string, unknown> : inputs;
}

function fixture(approvedFrame = frame()) {
  const directory = mkdtempSync(join(tmpdir(), "scraply-frame-context-review-"));
  configurePromptPaths({ bundledDir: join(process.cwd(), "prompts"), overrideDir: null });
  const db = new DatabaseClient(join(directory, "test.db"));
  const now = new Date().toISOString();
  db.db.prepare("INSERT INTO threads (id,title,status,created_at,updated_at) VALUES ('project','Filing','configuring',?,?)").run(now, now);
  const seedRun = new ResearchRunRepository(db).create("project", config).runId;
  const discovery = new DiscoveryRepository(db);
  discovery.persistScope(seedRun, scope);
  discovery.persistFactors(seedRun, [{ id: source.id, providerSourceId: "fixture-source", canonicalUrl: source.url, title: source.title,
    retrievedText: source.text, author: null, publishedAt: null, contentHash: sha256(source.text), retrievedAt: now }], []);
  const frames = new ResearchFrameRepository(db);
  const draft = frames.createDraft({ threadId: "project", runId: seedRun, knownProblem: false, frame: approvedFrame, sources: [source] });
  frames.approve(draft.id, "project", draft.draft);
  db.db.prepare("UPDATE research_runs SET status = 'completed' WHERE id = ?").run(seedRun);
  const requests: StructuredStageRequest<unknown>[] = [];
  const searches: Array<{ query: string; options?: SearchOptions }> = [];
  const errors: string[] = [];
  const client: StructuredModelClient = { async structuredCompletion(request) {
    requests.push(request); request.onDispatched?.(); request.onAccepted?.({});
    const inputs = routing(request);
    const output = request.stage.startsWith("query-plan")
      ? { queries: Array.from({ length: Number(inputs.queryCount) }, (_, index) => ({ query: `filing ${inputs.harvestMode} ${index}`,
          intent: ["firsthand-experience", "measured-behavior", "contrary-evidence"][index % 3], intendedSourceType: "Owner report", uncertainty: "Scale unknown",
          ...(index % 3 !== 2 && Array.isArray(inputs.languages) && inputs.languages.includes("uk")
            ? { translations: [{ language: "uk", query: `облік ${inputs.harvestMode} ${index}` }] } : {}) })) }
      : request.stage === "area-ranking" ? { areas: approvedFrame.areas.map((area, index) => ({ areaId: area.id,
          rank: index + 1, reason: "Bounded fixture", evidenceStrength: "none", fit: "unknown" })) }
      : request.stage.startsWith("problem-candidates") ? { problems: [] }
      : request.stage === "solutions" ? { options: [option()] }
      : request.stage === "risk-evaluation" ? (inputs.reassessment ? { affectedRisks: [], newRisks: [], additionalUnknowns: [] } : { risks: [], unknowns: [] })
      : request.stage === "decision-analysis" ? { consequences: [], proposedResponses: [], additionalUnknowns: [],
          experiment: { question: "Unrelated expensive trial", method: "Buy a new tool", cost: "Twenty hours", passCriterion: "Less work",
            failCriterion: "More work", inconclusiveCriterion: "No change" } }
      : (() => { throw new Error(`Unexpected stage ${request.stage}`); })();
    return { output: request.schema.parse(output), metadata: { model, usage: { status: "unknown" }, latencyMs: 1, repairCount: 0,
      providerRequestIds: [], attempts: [], prompt: { id: "fixture", sha256: sha256("fixture") } } };
  } };
  const search: SearchClient = { provider: "exa", async validateKey() { return { valid: true }; }, async search(query, options) {
    searches.push({ query, ...(options ? { options } : {}) }); return [];
  } };
  const engine = new ResearchEngine({ db, modelClients: { fixture: client }, searchClients: { exa: search },
    venueResolver: async () => { throw new Error("Saved venue proof must avoid DNS"); },
    onEvent(event) { if (event.type === "run-failed") errors.push(event.error); } });
  return { db, frames, draft, seedRun, client, search, engine, requests, searches, errors,
    async wait(runId: string) {
      const deadline = Date.now() + 5_000;
      while (engine.getActiveRunIds().has(runId) && Date.now() < deadline) await Bun.sleep(5);
      expect(engine.getActiveRunIds().has(runId)).toBe(false);
    },
    async close() { await engine.shutdown(); db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

function discoveryWorkflow(f: ReturnType<typeof fixture>, legacy = false) {
  const runId = new ResearchRunRepository(f.db).create("project", config).runId;
  new DiscoveryRepository(f.db).persistScope(runId, scope);
  f.frames.bindRun(runId, "project", f.draft.id);
  const workflow = new WorkflowExecution(f.db, runId);
  workflow.save("frame-workflow", { version: 1 });
  // This endpoint completes the bounded scan and empty-candidate investigation.
  const prompts = workflow.read<Record<string, unknown>>("prompts")!;
  delete prompts["area-gap"]; delete prompts["evidence-check"];
  f.db.db.prepare("UPDATE workflow_snapshots SET value_json = ? WHERE research_run_id = ? AND snapshot_key = 'prompts'")
    .run(canonicalJson(prompts), runId);
  if (legacy) f.db.db.prepare("UPDATE workflow_snapshots SET value_json = ? WHERE research_run_id = ? AND snapshot_key = 'source-routes'")
    .run(canonicalJson({ version: 1 }), runId);
  return { runId, workflow: new WorkflowExecution(f.db, runId) };
}

test("an interrupted pre-frame-routing scan reuses its exact saved planners and searches", async () => {
  const f = fixture();
  try {
    const { runId, workflow } = discoveryWorkflow(f, true);
    const approved = f.draft.draft;
    const area = approved.areas[0]!;
    await scanResearchArea(scope, approved, area, { modelClient: workflow.discoveryClient(f.client), search: workflow.search(f.search),
      model, reasoningEffort: config.reasoningEffort, depth: "quick", workflowVersion: 2, frame: approved, area,
      prompt: name => workflow.resolvePrompt(name as WorkflowV2StageId).text,
      sourceRouting: { now: new Date(workflow.read<string>("source-route-start")!) },
      stageScope: `scan-${sha256(area.id).slice(0, 16)}`, idFactory: workflow.idFactory(`frame-scan:${area.id}`), random: () => 0.5 });
    const stages = f.db.db.prepare("SELECT * FROM stage_results WHERE research_run_id = ? ORDER BY rowid").all(runId);
    expect(stages).toHaveLength(2);
    expect(routing(f.requests[0]!)).not.toHaveProperty("goalKind");
    expect(routing(f.requests[0]!)).not.toHaveProperty("languages");
    expect(workflow.read(`frame-scan:${area.id}`)).toBeNull();
    await f.engine.resumeRun(runId); await f.wait(runId);
    expect(f.errors).toEqual([]);
    expect(f.requests.filter(request => request.stage.includes(":scan-"))).toHaveLength(2);
    expect(f.db.db.prepare("SELECT * FROM stage_results WHERE research_run_id = ? ORDER BY rowid LIMIT 2").all(runId)).toEqual(stages);
    expect(workflow.read<unknown>("frame-source-venues")).toEqual({ compatibility: "preserve-saved-routing" });
    expect(workflow.read(`frame-scan:${area.id}`)).not.toBeNull();
    expect(f.frames.forRun(runId)?.id).toBe(f.draft.id);
    expect(f.db.db.prepare("SELECT status FROM research_runs WHERE id = ?").get(runId)).toEqual({ status: "completed" });
  } finally { await f.close(); }
});

test.each(["legacy", "current"] as const)("a %s completed planner before stage commit is recovered without dispatching it again", async contract => {
  const legacy = contract === "legacy";
  const f = fixture(frame(legacy ? ["en"] : ["en", "uk"]));
  try {
    const { runId, workflow } = discoveryWorkflow(f, legacy);
    const approved = f.draft.draft;
    const area = approved.areas[0]!;
    let originalAttemptId = "";
    const provider: StructuredModelClient = { async structuredCompletion(request) {
      const attempts = new GenerationAttemptRepository(f.db);
      const attempt = attempts.prepare(runId, request);
      originalAttemptId = attempt.id;
      attempts.markDispatched(attempt.id);
      const completion = await f.client.structuredCompletion(request);
      attempts.recordTerminal(attempt.id, { status: "completed", terminalKind: "completed", output: completion.output,
        attemptMetadata: completion.metadata });
      throw new Error("Process stopped after completion, before stage commit");
    } };
    await expect(scanResearchArea(scope, approved, area, { modelClient: workflow.discoveryClient(provider), search: workflow.search(f.search),
      model, reasoningEffort: config.reasoningEffort, depth: "quick", workflowVersion: 2, frame: approved, area,
      prompt: name => workflow.resolvePrompt(name as WorkflowV2StageId).text,
      sourceRouting: { now: new Date(workflow.read<string>("source-route-start")!),
        ...(!legacy ? { goalKind: approved.goalKind, languages: approved.languages } : {}) },
      stageScope: `scan-${sha256(area.id).slice(0, 16)}`, idFactory: workflow.idFactory(`frame-scan:${area.id}`), random: () => 0.5 }))
      .rejects.toThrow("Process stopped after completion");
    const original = f.db.db.prepare("SELECT * FROM generation_attempts WHERE id = ?").get(originalAttemptId);
    expect(f.db.db.prepare("SELECT id FROM stage_results WHERE research_run_id = ?").all(runId)).toEqual([]);
    const request = f.requests[0]!;
    expect(f.requests).toHaveLength(1);
    await f.engine.resumeRun(runId); await f.wait(runId);
    expect(f.errors).toEqual([]);
    expect(f.requests.filter(item => item.stage.includes(":scan-")).map(item => routing(item).harvestMode)).toEqual(["domain", "audience"]);
    expect(f.db.db.prepare("SELECT * FROM generation_attempts WHERE id = ?").get(originalAttemptId)).toEqual(original);
    expect(f.db.db.prepare("SELECT id FROM generation_attempts WHERE research_run_id = ? AND stage_key = ?").all(runId, request.stage))
      .toEqual([{ id: originalAttemptId }]);
    const recovered = workflow.repository.findStageResult(runId, "query-plan", request.stage.split(":").slice(1).join(":"))!;
    expect(recovered.inputs).toEqual(request.workOrder.inputs);
    expect(recovered.output).toEqual({ queries: [{ query: "filing domain 0", intent: "firsthand-experience", intendedSourceType: "Owner report",
      uncertainty: "Scale unknown", ...(!legacy ? { translations: [{ language: "uk", query: "облік domain 0" }] } : {}) }] });
    expect(workflow.read<unknown>("frame-source-venues")).toMatchObject(legacy
      ? { compatibility: "preserve-saved-routing" } : { validated: true, version: 2 });
    if (!legacy) for (const next of f.requests.filter(item => item.stage.includes(":scan-"))) {
      expect(routing(next)).toMatchObject({ goalKind: approved.goalKind, languages: approved.languages });
    }
    expect(f.db.db.prepare("SELECT status FROM research_runs WHERE id = ?").get(runId)).toEqual({ status: "completed" });
  } finally { await f.close(); }
});

test("new scans still plan the approved goal and languages and use proven area venues", async () => {
  const f = fixture(frame(["en", "uk"]));
  try {
    const { runId } = discoveryWorkflow(f);
    await f.engine.resumeRun(runId); await f.wait(runId);
    expect(f.errors).toEqual([]);
    expect(f.requests.filter(request => request.stage.includes(":scan-"))).toHaveLength(2);
    for (const request of f.requests.filter(item => item.stage.includes(":scan-"))) {
      expect(routing(request)).toMatchObject({ goalKind: "process-improvement", languages: ["en", "uk"] });
    }
    expect(f.searches.length).toBeGreaterThanOrEqual(8);
    expect(f.searches.some(item => item.query.startsWith("облік"))).toBe(true);
    expect(f.searches.every(item => item.options?.userLocation === "UA")).toBe(true);
    expect(f.searches.filter(item => item.options?.route === "community").every(item => item.options?.includeDomains?.includes("reddit.com"))).toBe(true);
  } finally { await f.close(); }
});
