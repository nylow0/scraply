import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ResearchEngine } from "../../src/core/research-engine";
import { WorkflowCoordinator } from "../../src/core/workflow-coordinator";
import { configurePromptPaths } from "../../src/core/prompts";
import { DatabaseClient } from "../../src/db/client";
import { ResearchFrameRepository } from "../../src/db/repositories/research-frames";
import { WorkflowRepository } from "../../src/db/repositories/workflows";
import { ResearchRunRepository } from "../../src/db/repositories/research-runs";
import { DiscoveryRepository } from "../../src/db/repositories/discovery";
import { ProviderFailure, type StructuredModelClient, type StructuredStageRequest } from "../../src/providers/structured";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";
import type { ResearchFrame } from "../../src/shared/research-frame";
import type { WorkflowLaunchContract, WorkflowLaunchDraft } from "../../src/shared/workflow-contracts";

const scope = { title: "Bakery orders", domain: "Custom orders", audience: "", observations: "Orders change after deposits", offLimits: [] };
const model = { providerId: "fixture", modelId: "fixture-model" };

function frame(knownProblem = false): ResearchFrame {
  return { goal: "Reduce order disputes", goalKind: "process-improvement", contextFacts: [],
    successCriteria: [{ id: "disputes", name: "Fewer disputes", weight: "must", howJudged: "Observe fewer disputes", basis: "brief" }],
    constraints: [], languages: ["en"], exclusions: [],
    openQuestions: [{ id: "scope", question: "One shop or many?", whyItMatters: "Changes the test", options: ["One", "Many"] }],
    areas: knownProblem ? [] : ["deposits", "changes", "excluded"].map((id, index) => ({ id, name: id,
      whyRelevant: `${id} lead to disputes`, affectedPeople: "Small bakery owners", venues: [{ name: "Baking forum", domain: "reddit.com", kind: "community" }],
      exampleProblems: [], included: id !== "excluded", priority: index + 1 })) };
}

function inputs(request: StructuredStageRequest<unknown>): Record<string, unknown> {
  return (request.workOrder.inputs as { routing: Record<string, unknown> }).routing;
}

async function setup(mode: "babysit" | "vibe" = "babysit", knownProblem = false,
  beforeStage?: (stage: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "scraply-frame-workflow-"));
  const db = new DatabaseClient(join(directory, "test.db"));
  configurePromptPaths({ bundledDir: join(process.cwd(), "prompts"), overrideDir: join(directory, "prompts") });
  db.db.prepare("INSERT INTO threads (id,title,status,created_at,updated_at) VALUES ('project','Bakery','configuring',?,?)")
    .run(new Date().toISOString(), new Date().toISOString());
  const queries: string[] = [];
  const stages: Array<{ stage: string; repair: string }> = [];
  const errors: string[] = [];
  const client: StructuredModelClient = { async structuredCompletion(request) {
    stages.push({ stage: request.stage, repair: request.repairPolicy });
    beforeStage?.(request.stage);
    request.onDispatched?.(); request.onAccepted?.({});
    const stage = request.stage.split(":")[0];
    const input = inputs(request);
    let output: unknown;
    if (stage === "frame-search-plan") output = { queries: [{ query: "Bakery deposit context", reason: "Understand the scope" }] };
    else if (stage === "frame") output = { frame: frame(Boolean(input.knownProblem)) };
    else if (stage === "area-ranking") output = { areas: frame().areas.filter(area => area.included).map((area, index) => ({
      areaId: area.id, rank: index + 1, reason: "Quoted owners describe disputes", evidenceStrength: "strong", fit: "meets" })) };
    else if (stage === "query-plan") {
      const evidence = request.evidence[0]!.content as { scope: { domain: string }; harvestMode: string };
      const count = Number(input.queryCount);
      output = { queries: Array.from({ length: count }, (_, index) => ({ query: `${evidence.scope.domain} ${input.harvestMode} ${index}`,
        intent: ["firsthand-experience", "measured-behavior", "contrary-evidence"][index % 3], uncertainty: "Frequency unknown", intendedSourceType: "Owner accounts" })) };
    } else if (stage === "factor-harvest") {
      const evidence = request.evidence[0]!.content as { sources: Array<{ id: string }> };
      output = { factors: evidence.sources.slice(0, 1).map(source => ({ sourceId: source.id,
        subject: "Bakery owner", behavior: "Loses time handling order changes", quote: "I lose time handling order changes.",
        modelConfidence: 0.8, uncertainty: "Frequency unknown", sourceRole: "firsthand", audienceFit: "intended-buyer",
        independentSourceKey: source.id, supportsDemand: true, demandEvidenceUncertainty: "Payment not established" })) };
    } else if (stage === "problem-candidates") output = { problems: [] };
    else if (stage === "solutions") output = { options: [] };
    else if (stage === "solution-set-review") output = { assessments: [] };
    else throw new Error(`Unexpected stage ${request.stage}`);
    return { output: request.schema.parse(output), metadata: { model, prompt: { id: "fixture", sha256: "a".repeat(64) },
      usage: { status: "unknown" }, latencyMs: 0, repairCount: 0, providerRequestIds: [], attempts: [] } };
  } };
  const engine = new ResearchEngine({ db, modelClients: { fixture: client },
    searchClients: { exa: { provider: "exa", async validateKey() { return { valid: true }; }, async search(query) {
      queries.push(query); return [{ id: `provider-${queries.length}`, url: `https://owners.example/${encodeURIComponent(query)}`,
        title: "An owner account", text: "I lose time handling order changes." }];
    } } }, onEvent(event) { if (event.type === "run-failed") errors.push(event.error); coordinator.handleRunEvent(event); } });
  const capabilities = async () => ({ nativeConnected: true, searchReady: { exa: !knownProblem, perplexity: false },
    modelOptions: [{ ...model, displayName: "Fixture", defaultReasoningEffort: "medium" as const,
      reasoningEfforts: [{ id: "medium" as const, description: "Fixture" }] }] });
  const coordinator = new WorkflowCoordinator({ db, engine: () => engine, capabilities, listProblems: () => [], onProgress() {},
    onError(error) { errors.push(error instanceof Error ? error.message : String(error)); } });
  const draft: WorkflowLaunchDraft = { contractVersion: 1, purpose: knownProblem ? "known-problem" : "discovery", mode,
    brief: "Reduce bakery order disputes", scope, runConfig: { ...DEFAULT_RUN_CONFIG, model, discoveryDepth: "quick",
      researchMode: knownProblem ? "known-problem" : "explore-market", knownProblem: knownProblem ? "Order changes take too much time" : "" },
    ideas: { model, reasoningEffort: "medium" }, targets: { kind: "per-problem", ideaCount: 1 },
    limits: { enforced: false, maxMinutes: 90, maxModelCalls: 500, maxSearches: 500 }, instructions: {} };
  const preview = await coordinator.preview({ type: "launch", threadId: "project", draft });
  expect(preview.fieldErrors).toEqual([]);
  const receipt = await coordinator.start({ threadId: "project", clientCommandId: "launch", contract: preview.proposal,
    previewHash: preview.previewHash, capabilityFingerprint: preview.capabilityFingerprint, previewExpiresAt: preview.expiresAt });
  return { db, engine, coordinator, queries, stages, errors, sessionId: receipt.sessionId, draft,
    async close() { await engine.shutdown(); db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}

test("Controlled persists the frame review, then scans included areas and saves area IDs", async () => {
  const fixture = await setup();
  try {
    const { coordinator, sessionId, queries, db } = fixture;
    await until(() => coordinator.summary(sessionId).state === "waiting-for-review");
    expect(coordinator.summary(sessionId).reviewKind).toBe("frame");
    expect(queries).toEqual(["Bakery deposit context"]);
    const saved = coordinator.get(sessionId).researchFrame!;
    expect(saved.approved).toBeNull();
    const restarted = new WorkflowCoordinator({ db, engine: () => fixture.engine, capabilities: async () => {
      throw new Error("Reading a saved review must not contact a provider");
    }, listProblems: () => [], onProgress() {} });
    expect(restarted.get(sessionId).researchFrame).toEqual(saved);
    const edited = { ...saved.draft, goal: "Reduce disputes in one bakery" };
    await coordinator.command({ threadId: "project", sessionId, clientCommandId: "approve", expectedRevision: coordinator.summary(sessionId).revision,
      action: { type: "approve-frame", frameId: saved.id, frame: edited } });
    await until(() => ["waiting-for-review", "finished"].includes(coordinator.summary(sessionId).state));
    expect(fixture.errors).toEqual([]);
    expect(coordinator.summary(sessionId).reviewKind).toBe("research");
    expect(coordinator.get(sessionId).researchFrame!.approved!.goal).toBe(edited.goal);
    expect(queries.some(query => query.includes("excluded"))).toBe(false);
    const rows = db.db.prepare("SELECT area_id FROM factors ORDER BY area_id").all() as Array<{ area_id: string | null }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map(row => row.area_id))).toEqual(new Set(["changes", "deposits"]));
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM stage_results WHERE stage_id = 'area-ranking'").get()).toEqual({ count: 1 });
  } finally { await fixture.close(); }
});

test("A scan resumes committed searches and stages without replaying them", async () => {
  const areaHash = createHash("sha256").update("changes").digest("hex").slice(0, 16);
  let interrupted = false;
  const fixture = await setup("babysit", false, stage => {
    if (!interrupted && stage === `query-plan:scan-${areaHash}:audience`) {
      interrupted = true;
      throw new ProviderFailure("unavailable", "Intentional pre-dispatch interruption", true);
    }
  });
  try {
    const { coordinator, sessionId, db, engine } = fixture;
    await until(() => coordinator.summary(sessionId).reviewKind === "frame");
    const saved = coordinator.get(sessionId).researchFrame!;
    await coordinator.command({ threadId: "project", sessionId, clientCommandId: "approve", expectedRevision: coordinator.summary(sessionId).revision,
      action: { type: "approve-frame", frameId: saved.id, frame: saved.draft } });
    await until(() => coordinator.summary(sessionId).state === "finished");
    expect(fixture.errors).toEqual(["Intentional pre-dispatch interruption"]);
    const item = new WorkflowRepository(db).listWorkItems(sessionId).find(task => task.kind === "discovery")!;
    const runId = (item.outputRefs as { runId: string }).runId;
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM workflow_snapshots WHERE research_run_id = ? AND snapshot_key = 'frame-scan:deposits'").get(runId))
      .toEqual({ count: 1 });
    const searchesBefore = [...fixture.queries];
    await engine.resumeRun(runId);
    await until(() => !engine.getActiveRunIds().has(runId));
    expect(db.db.prepare("SELECT status FROM research_runs WHERE id = ?").get(runId)).toEqual({ status: "completed" });
    for (const query of searchesBefore) {
      // Investigator questions intentionally repeat the scan's first question. A saved scan itself never repeats it.
      if (query.includes("changes")) expect(fixture.queries.filter(item => item === query)).toHaveLength(1);
    }
    const depositHash = createHash("sha256").update("deposits").digest("hex").slice(0, 16);
    expect(fixture.stages.filter(item => item.stage.startsWith(`query-plan:scan-${depositHash}:`))).toHaveLength(2);
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM factors WHERE research_run_id = ? AND area_id = 'changes'").get(runId))
      .toEqual({ count: 2 });
  } finally { await fixture.close(); }
});

test("Vibe approves without pausing and records unanswered questions", async () => {
  const fixture = await setup("vibe");
  try {
    await until(() => fixture.coordinator.summary(fixture.sessionId).state === "finished");
    expect(fixture.errors).toEqual([]);
    expect(fixture.coordinator.summary(fixture.sessionId).outcome).toBe("no-qualifying-ideas");
    const saved = fixture.coordinator.get(fixture.sessionId).researchFrame!;
    expect(saved.approved).not.toBeNull();
    expect(fixture.db.db.prepare("SELECT value_json FROM workflow_snapshots WHERE snapshot_key = 'frame-autoapproval'").get())
      .toEqual({ value_json: JSON.stringify({ frameId: saved.id, unansweredQuestionIds: ["scope"] }) });
    expect(fixture.queries.some(query => query.includes("excluded"))).toBe(false);
  } finally { await fixture.close(); }
});

test("Known-problem framing makes no search or scan and regeneration is exactly one call", async () => {
  const fixture = await setup("babysit", true);
  try {
    const { coordinator, sessionId } = fixture;
    await until(() => coordinator.summary(sessionId).state === "waiting-for-review");
    const first = coordinator.get(sessionId).researchFrame!;
    expect(first.draft.areas).toEqual([]);
    await coordinator.command({ threadId: "project", sessionId, clientCommandId: "regenerate", expectedRevision: coordinator.summary(sessionId).revision,
      action: { type: "regenerate-frame", frameId: first.id, frame: { ...first.draft, goal: "One bakery workflow" } } });
    await until(() => coordinator.summary(sessionId).state === "waiting-for-review");
    const regenerated = coordinator.get(sessionId).researchFrame!;
    expect(regenerated.version).toBe(first.version + 1);
    expect(fixture.stages).toHaveLength(2);
    expect(fixture.stages[1]!.repair).toBe("disabled");
    const entries = new WorkflowRepository(fixture.db).listBudgetEntries(sessionId);
    expect(entries.find(entry => entry.operationKey.startsWith("frame-regeneration:"))?.settledUnits).toBe(1);
    await coordinator.command({ threadId: "project", sessionId, clientCommandId: "approve", expectedRevision: coordinator.summary(sessionId).revision,
      action: { type: "approve-frame", frameId: regenerated.id, frame: regenerated.draft } });
    await until(() => coordinator.summary(sessionId).reviewKind === "research");
    expect(fixture.queries).toEqual([]);
    expect(fixture.stages.some(item => item.stage.startsWith("area-ranking"))).toBe(false);
    const root = fixture.db.db.prepare("SELECT frame_id FROM research_runs WHERE completion_reason = 'Known problem supplied; discovery bypassed.'").get();
    expect(root).toEqual({ frame_id: regenerated.id });
  } finally { await fixture.close(); }
});

test("Editing an approved frame creates a future version while the saved run remains bound", async () => {
  const fixture = await setup("babysit", true);
  try {
    const { coordinator, sessionId, db } = fixture;
    await until(() => coordinator.summary(sessionId).state === "waiting-for-review");
    const first = coordinator.get(sessionId).researchFrame!;
    await coordinator.command({ threadId: "project", sessionId, clientCommandId: "approve", expectedRevision: coordinator.summary(sessionId).revision,
      action: { type: "approve-frame", frameId: first.id, frame: first.draft } });
    await until(() => coordinator.summary(sessionId).reviewKind === "research");
    const oldRun = db.db.prepare("SELECT id FROM research_runs WHERE completion_reason = 'Known problem supplied; discovery bypassed.'").get() as { id: string };
    await coordinator.command({ threadId: "project", sessionId, clientCommandId: "edit", expectedRevision: coordinator.summary(sessionId).revision,
      action: { type: "edit-approved-frame", frameId: first.id, frame: { ...first.draft, goal: "Build for two bakeries" } } });
    const frames = new ResearchFrameRepository(db);
    expect(frames.latestApproved("project")!.version).toBe(first.version + 1);
    expect(frames.forRun(oldRun.id)!.approved!.goal).toBe(first.draft.goal);
    expect((new WorkflowRepository(db).getSession(sessionId)!.contract as WorkflowLaunchContract).frameWorkflowVersion).toBe(1);
    await coordinator.command({ threadId: "project", sessionId, clientCommandId: "stop", expectedRevision: coordinator.summary(sessionId).revision,
      action: { type: "stop" } });
    const preview = await coordinator.preview({ type: "launch", threadId: "project", draft: fixture.draft });
    const next = await coordinator.start({ threadId: "project", clientCommandId: "next-launch", contract: preview.proposal,
      previewHash: preview.previewHash, capabilityFingerprint: preview.capabilityFingerprint, previewExpiresAt: preview.expiresAt });
    await until(() => coordinator.summary(next.sessionId).reviewKind === "research");
    expect(coordinator.get(next.sessionId).researchFrame!.id).toBe(frames.latestApproved("project")!.id);
    expect(fixture.stages).toHaveLength(1);
    expect(new WorkflowRepository(db).listWorkItems(next.sessionId).map(item => item.kind)).toEqual(["known-problem"]);
  } finally { await fixture.close(); }
});

test("A saved run without the frame marker resumes on its original discovery path", async () => {
  const fixture = await setup("babysit", true);
  try {
    await until(() => fixture.coordinator.summary(fixture.sessionId).reviewKind === "frame");
    const config = { ...DEFAULT_RUN_CONFIG, model, workflowVersion: 2 as const, discoveryDepth: "quick" as const };
    const runId = new ResearchRunRepository(fixture.db).create("project", config).runId;
    new DiscoveryRepository(fixture.db).persistScope(runId, scope);
    await fixture.engine.resumeRun(runId);
    await until(() => !fixture.engine.getActiveRunIds().has(runId));
    expect(fixture.db.db.prepare("SELECT status,frame_id FROM research_runs WHERE id = ?").get(runId))
      .toEqual({ status: "completed", frame_id: null });
    const ids = fixture.db.db.prepare("SELECT stage_id,selection_key AS selection_id FROM stage_results WHERE research_run_id = ?")
      .all(runId) as Array<{ stage_id: string; selection_id: string | null }>;
    expect(ids.some(item => item.stage_id === "frame" || item.stage_id === "area-ranking")).toBe(false);
    expect(ids.filter(item => item.stage_id === "query-plan").map(item => item.selection_id).sort()).toEqual(["audience", "domain"]);
  } finally { await fixture.close(); }
});
