import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeResearchSnapshot } from "../../src/core/research-revisions";
import { WorkflowCoordinator } from "../../src/core/workflow-coordinator";
import { fillGenerationAngle, initialGenerationAngles } from "../../src/core/idea-assignments";
import type { ResearchEngine } from "../../src/core/research-engine";
import { DatabaseClient } from "../../src/db/client";
import { WorkflowRepository } from "../../src/db/repositories/workflows";
import type { StructuredModelClient } from "../../src/providers/structured";
import type { SearchClient } from "../../src/providers/search";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";
import type { Source } from "../../src/shared/schemas";
import { WorkflowLaunchContractSchema } from "../../src/shared/workflow-contracts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}

function fixture(output: { gaps: unknown[]; noUsefulGapReason: string | null },
  options: { searchClient?: SearchClient; maxSearches?: number; target?: number;
    targetKind?: "project" | "per-problem"; acceptedIds?: string[]; proposedCount?: number;
    maxModelCalls?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "scraply-workflow-coverage-"));
  directories.push(directory);
  const db = new DatabaseClient(join(directory, "scraply.db"));
  const now = new Date().toISOString();
  const runConfig = { ...DEFAULT_RUN_CONFIG, explorationPurpose: "startup-opportunities" as const,
    researchMode: "known-problem" as const, knownProblem: "Approval delays repair work.", ideaCount: options.target ?? 2 };
  const contract = WorkflowLaunchContractSchema.parse({
    contractVersion: 1, purpose: "known-problem", mode: "vibe", brief: "Sell a repair approval workflow",
    scope: { title: "Repair approvals", audience: "Independent repair shops", domain: "Automotive repair",
      observations: "Revised estimates wait for signoff", offLimits: [] },
    runConfig, ideas: { model: runConfig.model, reasoningEffort: "medium" },
    targets: { kind: options.targetKind ?? "project", ideaCount: options.target ?? 2,
      ...((options.targetKind ?? "project") === "project" ? { distinctBusinessCount: options.target ?? 2 } : {}) },
    limits: { maxMinutes: 90, maxModelCalls: options.maxModelCalls ?? 10, maxSearches: options.maxSearches ?? 0 },
    instructions: {}, resolvedInstructions: { research: "", ideas: "", review: "" },
    instructionHashes: { research: "hash", ideas: "hash", review: "hash" },
  });
  db.db.prepare("INSERT INTO threads (id,title,status,created_at,updated_at) VALUES ('project','Project','configuring',?,?)")
    .run(now, now);
  db.db.prepare(`INSERT INTO research_runs (id,thread_id,status,config_json,workflow_version,created_at,updated_at)
    VALUES ('source','project','completed',?,2,?,?)`).run(JSON.stringify(runConfig), now, now);
  db.db.prepare(`INSERT INTO scopes (id,research_run_id,title,audience,domain,observations,off_limits_json,created_at,updated_at)
    VALUES ('source-scope','source','Repair approvals','Independent repair shops','Automotive repair','','[]',?,?)`)
    .run(now, now);
  db.db.prepare(`INSERT INTO problems (id,discovery_run_id,statement,why_it_persists,affected,scale_estimate,
    verdict,verdict_reason,verdict_source_ids_json,created_at)
    VALUES ('source-problem','source','Estimates wait for signoff','','Repair shops','','confirmed','','[]',?)`)
    .run(now);
  const workflows = new WorkflowRepository(db);
  const { sessionId, problemId } = db.immediateTransaction(() => {
    const session = workflows.createSession({ id: "session", threadId: "project", purpose: "known-problem",
      mode: "vibe", contract, remainingMs: 90 * 60_000 });
    const materialized = materializeResearchSnapshot(db, { threadId: "project", baseRunId: "source",
      sourceProblemIds: ["source-problem"], sessionId: session.id });
    const snapshot = workflows.createSnapshot({ sessionId: session.id,
      materializationRunId: materialized.runId, selection: { problemIds: materialized.problemIds },
      originMap: materialized.originMap });
    workflows.updateSession(session.id, session.revision, { activeSnapshotId: snapshot.id });
    const initial = workflows.createWorkItem({ sessionId: session.id, kind: "generate-ideas",
      scopeKey: "initial:0", state: "ready", input: {
        problemId: materialized.problemIds[0], snapshotId: snapshot.id,
        quota: options.target ?? 2, fillRound: 0, targetKind: options.targetKind ?? "project",
        requestedTarget: options.target ?? 2,
        model: runConfig.model, reasoningEffort: "medium",
      } });
    workflows.updateWorkItem(initial.id, "running");
    workflows.updateWorkItem(initial.id, "succeeded", { outputRefs: {
      solutionIds: options.acceptedIds ?? [],
      proposedSolutionIds: options.proposedCount === undefined ? ["candidate-a", "candidate-b"]
        : Array.from({ length: options.proposedCount }, (_, index) => `candidate-${index}`),
    } });
    return { sessionId: session.id, problemId: materialized.problemIds[0]! };
  });
  let modelCalls = 0;
  const modelClient: StructuredModelClient = {
    async structuredCompletion(request) {
      modelCalls += 1;
      expect(request.stage).toBe("coverage-map:1");
      expect(request.repairPolicy).toBe("disabled");
      request.onDispatched?.();
      return { output: request.schema.parse(output), metadata: { model: request.model,
        usage: { status: "unknown" }, latencyMs: 1, repairCount: 0, providerRequestIds: [], attempts: [] } };
    },
  };
  const generationCalls: Array<{ problemId: string; sessionId: string }> = [];
  const engine = {
    scheduledWorkflowModelClient: () => modelClient,
    workflowSearchClient: () => {
      if (!options.searchClient) throw new Error("Search client not supplied in test");
      return options.searchClient;
    },
    startSelectedProblem: async (_threadId: string, selectedProblemId: string, _config: unknown,
      options: { sessionId: string }) => {
      generationCalls.push({ problemId: selectedProblemId, sessionId: options.sessionId });
      return "pending-generation";
    },
  } as unknown as ResearchEngine;
  const errors: unknown[] = [];
  const coordinator = new WorkflowCoordinator({ db, engine: () => engine,
    capabilities: async () => ({ nativeConnected: true, searchReady: { exa: false, perplexity: false }, modelOptions: [] }),
    listProblems: () => [], onProgress: () => {}, onError: (error) => errors.push(error),
  });
  return { db, workflows, coordinator, sessionId, problemId, generationCalls, errors,
    modelCalls: () => modelCalls };
}

function finishCollection(coordinator: WorkflowCoordinator, sessionId: string): void {
  (coordinator as unknown as { finishCollection: (id: string) => void }).finishCollection(sessionId);
}

test("a managed startup fill maps a named gap, settles one call, and targets its selected problem", async () => {
  const caseFile = fixture({ gaps: [{ name: "Approval relay", description: "Route revised estimates through a new signoff mechanism.",
    dimension: "workflow", evidenceNeeded: null, searchQuery: null, mapExhausted: true,
    candidateOrigin: "evidence-only" }], noUsefulGapReason: null });
  const { db, workflows, coordinator, sessionId, problemId, generationCalls, errors } = caseFile;
  try {
    finishCollection(coordinator, sessionId);
    await waitUntil(() => generationCalls.length === 1);
    const items = workflows.listWorkItems(sessionId);
    const map = items.find((item) => item.kind === "coverage-map");
    const fill = items.find((item) => item.kind === "generate-ideas" && (item.input as { fillRound?: number }).fillRound === 1);
    expect(map).toMatchObject({ state: "succeeded", input: { round: 1 } });
    expect(fill).toMatchObject({ input: { problemId, fillRound: 1,
      generationAngle: { name: "Approval relay", angle: "Route revised estimates through a new signoff mechanism." } } });
    expect((fill?.input as { generationAngle?: { gapId: string } }).generationAngle?.gapId)
      .toBe((map?.outputRefs as { gapIds: string[] }).gapIds[0]);
    expect(generationCalls).toEqual([{ problemId, sessionId }]);
    const ledger = db.db.prepare(`SELECT reserved_units, settled_units, state, opportunity_attempt_id
      FROM workflow_budget_entries WHERE work_item_id = ?`).get(map!.id) as {
      reserved_units: number; settled_units: number; state: string; opportunity_attempt_id: string | null;
    };
    expect(ledger).toMatchObject({ reserved_units: 1, settled_units: 1, state: "spent" });
    expect(ledger.opportunity_attempt_id).toBe((map?.outputRefs as { attemptId: string }).attemptId);
    expect(caseFile.modelCalls()).toBe(1);
    expect(errors).toEqual([]);
  } finally { db.close(); }
});

test("one reviewed fill round reserves five and three candidates for an eight-idea deficit", async () => {
  const caseFile = fixture({ gaps: [], noUsefulGapReason: null }, {
    targetKind: "per-problem", target: 20, acceptedIds: Array.from({ length: 12 }, (_, index) => `accepted-${index}`),
    proposedCount: 20, maxModelCalls: 8,
  });
  const { db, workflows, coordinator, sessionId, generationCalls } = caseFile;
  try {
    finishCollection(coordinator, sessionId);
    await waitUntil(() => generationCalls.length === 1);
    const fills = workflows.listWorkItems(sessionId).filter((item) => item.kind === "generate-ideas"
      && (item.input as { fillRound?: number }).fillRound === 1);
    expect(fills).toHaveLength(2);
    expect(fills.map((item) => (item.input as { quota: number }).quota)).toEqual([5, 3]);
    expect(fills.map((item) => (item.input as { acceptedBefore: number }).acceptedBefore)).toEqual([12, 12]);
    expect(new Set(fills.map((item) => (item.input as { generationAngle: { gapId: string } }).generationAngle.gapId)).size).toBe(2);
    expect(fills.map((item) => item.state)).toEqual(["running", "ready"]);
    const reserved = db.db.prepare(`SELECT SUM(reserved_units) AS units FROM workflow_budget_entries
      WHERE session_id = ? AND state = 'reserved'`).get(sessionId) as { units: number };
    expect(reserved.units).toBe(8);
    for (const item of fills) {
      db.immediateTransaction(() => {
        if (item.state === "ready") workflows.updateWorkItem(item.id, "running");
        workflows.updateWorkItem(item.id, "succeeded", { outputRefs: { solutionIds: [], proposedSolutionIds: [] } });
        const reservation = workflows.listBudgetEntries(sessionId).find((entry) => entry.workItemId === item.id)!;
        workflows.settleBudget(reservation.id, { state: "spent", settledUnits: 2 });
      });
    }
    finishCollection(coordinator, sessionId);
    expect(workflows.getSession(sessionId)).toMatchObject({ state: "finished", outcome: "partial" });
    expect(workflows.listWorkItems(sessionId).find((item) => item.kind === "collection-stop")?.outputRefs)
      .toMatchObject({ code: "no-gain", shortfall: 8 });
  } finally { db.close(); }
});

test.each([
  { targetKind: "per-problem" as const, unit: "idea" },
  { targetKind: "project" as const, unit: "business family" },
])("a one-$unit shortfall uses a singular terminal reason", ({ targetKind, unit }) => {
  const { db, coordinator, sessionId } = fixture({ gaps: [], noUsefulGapReason: null }, {
    targetKind, target: 1, proposedCount: 1, maxModelCalls: 1,
  });
  try {
    finishCollection(coordinator, sessionId);
    expect(coordinator.summary(sessionId).stopReason).toMatch(new RegExp(`^Short by 1 distinct ${unit}\\.`));
  } finally { db.close(); }
});

test("initial assignments use distinct saved observations and retain stable identities", () => {
  const caseFile = fixture({ gaps: [], noUsefulGapReason: null });
  const { db, problemId } = caseFile;
  try {
    const now = new Date().toISOString();
    for (const [id, subject, behavior] of [
      ["factor-approval", "shop owner", "waits for revised estimate approval"],
      ["factor-status", "service advisor", "calls the customer to learn approval status"],
    ]) {
      db.db.prepare(`INSERT INTO sources (id,research_run_id,canonical_url,title,retrieved_text,content_hash,retrieved_at)
        VALUES (?, 'source', ?, ?, ?, ?, ?)`).run(`source-${id}`, `https://example.test/${id}`, id,
          behavior, "a".repeat(64), now);
      db.db.prepare(`INSERT INTO factors (id,research_run_id,subject,behavior,quote,source_id,harvest_mode,model_confidence,created_at)
        VALUES (?, 'source', ?, ?, ?, ?, 'audience', 0.8, ?)`).run(id, subject, behavior, behavior, `source-${id}`, now);
      db.db.prepare("INSERT INTO problem_factors (problem_id,factor_id) VALUES (?,?)").run(problemId, id);
    }
    const angles = initialGenerationAngles(db, problemId, 2);
    expect(angles.map((angle) => angle.gapId)).toEqual([
      `initial:${problemId}:factor:factor-approval:0`, `initial:${problemId}:factor:factor-status:0`,
    ]);
    expect(angles[0]?.angle).toContain("waits for revised estimate approval");
    expect(angles[1]?.angle).toContain("calls the customer to learn approval status");
    expect(initialGenerationAngles(db, problemId, 2)).toEqual(angles);
    const fillAngle = fillGenerationAngle(db, problemId, 2, ["Approval queue", "SMS approval link"]);
    expect(fillAngle.angle).toContain("Approval queue");
    expect(fillAngle.angle).toContain("SMS approval link");
    expect(fillAngle.angle).toContain("Return fewer or no ideas");
  } finally { db.close(); }
});

test("an empty managed map records a no-useful-gap stop without dispatching fill generation", async () => {
  const caseFile = fixture({ gaps: [], noUsefulGapReason: "The saved buyer and workflow map has no distinct angle left." });
  const { db, workflows, coordinator, sessionId, generationCalls, errors } = caseFile;
  try {
    finishCollection(coordinator, sessionId);
    await waitUntil(() => workflows.getSession(sessionId)?.state === "finished");
    const items = workflows.listWorkItems(sessionId);
    expect(items.find((item) => item.kind === "coverage-map")?.state).toBe("succeeded");
    expect(items.find((item) => item.kind === "collection-stop")?.outputRefs)
      .toMatchObject({ code: "no-useful-gap", reason: "The saved buyer and workflow map has no distinct angle left." });
    expect(items.filter((item) => item.kind === "generate-ideas")).toHaveLength(1);
    expect(generationCalls).toEqual([]);
    expect(caseFile.modelCalls()).toBe(1);
    expect(errors).toEqual([]);
  } finally { db.close(); }
});

const buyerEvidence: Source = {
  id: "buyer-account", url: "https://example.test/buyer-account", title: "Repair shop account",
  text: "A shop owner describes delayed estimate signoff after revisions.",
};

function evidenceGapOutput() {
  return { gaps: [{ name: "Buyer signoff evidence", description: "Test a different signoff workflow with repair shops.",
    dimension: "workflow", evidenceNeeded: "Direct shop accounts of the signoff delay",
    searchQuery: "repair shop revised estimate signoff interview", mapExhausted: true,
    candidateOrigin: "evidence-only" }], noUsefulGapReason: null };
}

test("a search-needed managed gap settles one search and passes its saved source to fill generation", async () => {
  let searchCalls = 0;
  const searchClient: SearchClient = {
    provider: "exa", validateKey: async () => ({ valid: true }),
    async search(query, options) {
      searchCalls += 1;
      expect(query).toBe("repair shop revised estimate signoff interview");
      expect(options).toMatchObject({ numResults: 5, maxCharacters: 4_000, timeoutMs: 45_000 });
      return [buyerEvidence];
    },
  };
  const caseFile = fixture(evidenceGapOutput(), { searchClient, maxSearches: 1 });
  const { db, workflows, coordinator, sessionId, generationCalls, errors } = caseFile;
  try {
    finishCollection(coordinator, sessionId);
    await waitUntil(() => generationCalls.length === 1);
    const items = workflows.listWorkItems(sessionId);
    const search = items.find((item) => item.kind === "coverage-search");
    const fill = items.find((item) => item.kind === "generate-ideas" && (item.input as { fillRound?: number }).fillRound === 1);
    expect(search).toMatchObject({ state: "succeeded", outputRefs: { sourceIds: ["buyer-account"] } });
    expect(fill?.input).toMatchObject({ generationEvidence: [buyerEvidence] });
    const ledger = db.db.prepare(`SELECT reserved_units, settled_units, state, opportunity_attempt_id
      FROM workflow_budget_entries WHERE work_item_id = ?`).get(search!.id) as {
      reserved_units: number; settled_units: number; state: string; opportunity_attempt_id: string | null;
    };
    expect(ledger).toMatchObject({ reserved_units: 1, settled_units: 1, state: "spent" });
    expect(ledger.opportunity_attempt_id).toBe((search?.outputRefs as { attemptId: string }).attemptId);
    expect(searchCalls).toBe(1);
    expect(errors).toEqual([]);
  } finally { db.close(); }
});

test("recovery leaves a dispatched managed search uncertain and never replays it", async () => {
  let searchCalls = 0;
  let rejectSearch: (error: Error) => void = () => {};
  const searchClient: SearchClient = {
    provider: "exa", validateKey: async () => ({ valid: true }),
    search: async () => {
      searchCalls += 1;
      return new Promise<Source[]>((_resolve, reject) => { rejectSearch = reject; });
    },
  };
  const caseFile = fixture(evidenceGapOutput(), { searchClient, maxSearches: 1 });
  const { db, workflows, coordinator, sessionId } = caseFile;
  try {
    finishCollection(coordinator, sessionId);
    await waitUntil(() => db.db.prepare(`SELECT 1 FROM opportunity_exploration_attempts
      WHERE session_id = ? AND stage_name = 'gap-search' AND status = 'dispatched'`).get(sessionId) !== null);
    coordinator.reconcileInterrupted();
    const search = workflows.listWorkItems(sessionId).find((item) => item.kind === "coverage-search");
    expect(search?.state).toBe("unknown");
    expect(workflows.getSession(sessionId)).toMatchObject({ state: "finished", outcome: "needs-attention" });
    expect(db.db.prepare("SELECT state FROM workflow_budget_entries WHERE work_item_id = ?").get(search!.id))
      .toEqual({ state: "uncertain" });
    coordinator.reconcileInterrupted();
    expect(searchCalls).toBe(1);
  } finally {
    rejectSearch(new Error("Original in-flight request ended"));
    await Bun.sleep(5);
    db.close();
  }
});
