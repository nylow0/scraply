import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { DatabaseClient } from "../../src/db/client";
import { WORKFLOW_V2_STAGE_REGISTRY, type WorkflowV2StageId } from "../../src/core/stages";
import { WorkspaceStateSchema, SolutionViewSchema, type WorkspaceState, type ResearchEvent } from "../../src/shared/ipc";
import { GenerationStartPayloadSchema } from "../../src/shared/runtime-protocol";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";
import { NATIVE_WORKFLOW_MODEL as model, UNTRUSTED_WORKFLOW_TEXT as untrusted, startNativeWorkflowBackend } from "../fixtures/native-workflow-backend";

const statement = "Repair shops cannot reliably predict parts arrival times.";
const scope = {
  title: "Native workflow fixture", audience: "Repair shops", domain: "Parts delivery",
  observations: untrusted, offLimits: ["Holding inventory"],
};
const fixtures: Array<{ directory: string; close(): Promise<void> }> = [];

afterEach(async () => {
  for (const item of fixtures.splice(0)) {
    await item.close();
    try { rmSync(item.directory, { recursive: true, force: true }); }
    catch { /* Bun can retain the SQLite WAL handle until the test process exits on Windows. */ }
  }
});

describe("native research workflow through the production backend", () => {
  test("fails before provider spend on an empty override, then runs and snapshots a deliberate edit", async () => {
    const item = await fixture({ searchEnabled: false });
    const overridePath = join(item.directory, "prompts", "workflow-v2-solutions.md");
    writeFileSync(overridePath, " \n");
    const brokenThread = await item.createThread("known-problem");
    await item.post("/research/start", { threadId: brokenThread }, z.object({ runId: z.string() }));
    await item.waitFor((state) => state.threads.find((thread) => thread.id === brokenThread)?.status === "failed");
    expect(item.requests()).toHaveLength(0);
    item.assertAccounting(0);

    const instruction = `${readFileSync(join(process.cwd(), "prompts", "workflow-v2-solutions.md"), "utf8").trim()}\n\nExplain the maintenance burden of each mechanism.`;
    writeFileSync(overridePath, instruction);
    const threadId = await item.createThread("known-problem");
    await item.post("/research/start", { threadId }, z.object({ runId: z.string() }));
    await item.waitFor((state) => state.threads.find((thread) => thread.id === threadId)?.status === "solutions-ready");
    expect(item.requests()[0]?.workOrder.instruction).toBe(instruction);
    item.assertAccounting(1);
    await item.restart();
    expect(readFileSync(overridePath, "utf8")).toBe(instruction);
    expect((await item.workspace()).solutions).toHaveLength(2);
    const db = new DatabaseClient(item.dbPath);
    try {
      const row = db.db.prepare("SELECT request_json FROM generation_attempts WHERE stage_key = 'solutions'").get() as { request_json: string };
      expect(z.object({ workOrder: z.object({ instruction: z.string() }) }).parse(JSON.parse(row.request_json)).workOrder.instruction).toBe(instruction);
    } finally { db.close(); }
    expect(item.requests()).toHaveLength(1);
  }, 15_000);

  test("discovers, selects an adverse premise, develops, exports, and reopens without replay", async () => {
    const item = await fixture();
    const threadId = await item.createThread("explore-market");
    const { runId } = await item.post("/research/start", { threadId }, z.object({ runId: z.string() }));
    const discovered = await item.waitFor((state) => state.threads.find((thread) => thread.id === threadId)?.status === "problems-ready");
    expect(discovered.problemCandidates).toHaveLength(1);
    expect(discovered.problemCandidates[0]?.verdict).toBe("overstated");
    expect(discovered.problemCandidates[0]?.verdictReason).toContain("disagrees");
    expect(discovered.problemCandidates[0]?.factors).toHaveLength(2);
    expect(item.searches).toHaveLength(7);

    await item.post("/research/select-problems", { threadId, problemIds: [discovered.problemCandidates[0]!.id], userProblem: null }, WorkspaceStateSchema);
    const options = await item.waitFor((state) => state.threads.find((thread) => thread.id === threadId)?.status === "solutions-ready");
    expect(options.solutions).toHaveLength(2);
    const selected = options.solutions[0]!;
    await item.post("/research/select-option", { threadId, runId: selected.runId, solutionId: selected.id }, WorkspaceStateSchema);
    const developed = await item.waitFor((state) => state.latestResearchRun?.status === "completed" && !state.latestResearchRun.awaitingSelection);
    const progress = item.events.filter((event) => event.type === "run-progress")
      .filter((event) => event.runId === developed.latestResearchRun?.runId);
    expect(progress.at(-1)?.usage).toEqual(developed.latestResearchRun?.usage);
    expect(progress.some((event) => (event.usage?.attemptCount ?? 0) > 1)).toBe(true);
    for (const summary of developed.solutions) {
      expect(summary.outcomes).toHaveLength(0);
      const solution = await item.post(`/ideas/${summary.id}`, undefined, SolutionViewSchema);
      expect(solution.outcomes).toHaveLength(0);
      if (solution.selected) {
        expect(solution.riskEvaluation?.risks).toHaveLength(1);
        expect(solution.decisionAnalysis?.proposedResponses[0]?.riskIds).toEqual(["sparse"]);
      }
    }

    const exported = await item.post("/research/export", { threadId }, z.object({ content: z.string() }));
    const research = z.object({
      sources: z.array(z.object({ id: z.string(), text: z.string() })),
      factors: z.array(z.object({ sourceId: z.string(), quote: z.string() })),
      researchRun: z.object({ config: z.object({ model: z.object({ providerId: z.string() }) }) }),
    }).parse(JSON.parse(exported.content));
    for (const factor of research.factors) {
      expect(research.sources.find((source) => source.id === factor.sourceId)?.text).toContain(factor.quote);
    }
    expect(research.researchRun.config.model.providerId).toBe(model.providerId);
    const ideas = await item.post("/ideas/export", { threadId, format: "json" }, z.object({ files: z.array(z.object({ content: z.string() })) }));
    expect(JSON.parse(ideas.files[0]!.content)).toHaveLength(2);

    const requests = item.requests();
    expect(requests).toHaveLength(8); // Five discovery generations, options, risk evaluation and analysis.
    expect(requests.filter((request) => request.workOrder.stage === "solutions")).toHaveLength(1);
    for (const request of requests) {
      expect(request.repairPolicy).toBe("one_retry");
      expect(JSON.stringify(request.workOrder)).not.toContain(untrusted);
      expect(request.maxOutputTokens).toBeUndefined();
      const promptName = request.workOrder.stage.split(":")[0]!;
      expect(request.deadlineMs).toBe(WORKFLOW_V2_STAGE_REGISTRY[promptName as WorkflowV2StageId].deadlineMs);
      expect(request.workOrder.instruction.startsWith(readFileSync(join(process.cwd(), "prompts", `workflow-v2-${promptName}.md`), "utf8").trim())).toBe(true);
    }
    expect(requests.some((request) => JSON.stringify(request.evidence).includes(untrusted))).toBe(true);
    expect(JSON.stringify(requests)).not.toContain("synthetic-credential");
    expect(exported.content).not.toContain("synthetic-credential");
    expect(ideas.files[0]?.content).not.toContain("synthetic-credential");
    item.assertAccounting(8);
    expect(item.processIds()).toHaveLength(1);

    await item.restart();
    const reopened = await item.workspace();
    expect(reopened.solutions).toEqual(developed.solutions);
    expect(reopened.problemCandidates).toEqual(developed.problemCandidates);
    const replay = await item.raw("/research/resume", { runId });
    expect(replay.status).toBe(409);
    expect(item.requests()).toHaveLength(8);
    item.assertAccounting(8);
    const validation = await item.post("/validation", undefined, z.object({ native: z.object({ connected: z.boolean() }) }));
    expect(validation.native.connected).toBe(true);
    expect(item.processIds()).toHaveLength(2);
  }, 20_000);

  test("completes a known problem without a search provider", async () => {
    const item = await fixture({ searchEnabled: false });
    const threadId = await item.createThread("known-problem");
    await item.post("/research/start", { threadId }, z.object({ runId: z.string() }));
    const state = await item.waitFor((value) => value.threads.find((thread) => thread.id === threadId)?.status === "solutions-ready");
    expect(state.validation.native.connected).toBe(true);
    expect(state.validation.exa.valid).toBe(false);
    expect(state.solutions).toHaveLength(2);
    expect(item.searches).toHaveLength(0);
    expect(item.requests()).toHaveLength(1);
    item.assertAccounting(1);
    const exported = await item.post("/ideas/export", { threadId, format: "markdown" }, z.object({ files: z.array(z.object({ content: z.string() })) }));
    expect(exported.files[0]?.content).toContain("Supplier reliability ledger");
  }, 15_000);

  test("cancels an accepted generation and preserves unknown usage after reopening", async () => {
    const item = await fixture({ mode: "workflow-cancel", searchEnabled: false });
    const threadId = await item.createThread("known-problem");
    const { runId } = await item.post("/research/start", { threadId }, z.object({ runId: z.string() }));
    await item.waitForAttempt("accepted");
    await item.post("/research/cancel", { runId }, z.object({ workspace: WorkspaceStateSchema }));
    await item.waitForAttempt("cancelled");
    expect(item.operations()).toContain("generation.cancel");
    expect(item.requests()).toHaveLength(1);
    await item.restart();
    expect((await item.workspace()).solutions).toHaveLength(0);
    expect((await item.workspace()).latestResearchRun?.canResume).toBe(true);
    const db = new DatabaseClient(item.dbPath);
    try {
      expect(db.db.prepare("SELECT status, committed_usd FROM cost_ledger WHERE generation_attempt_id IS NOT NULL").all())
        .toEqual([{ status: "committed", committed_usd: null }]);
    } finally { db.close(); }
    expect(item.requests()).toHaveLength(1);
  }, 15_000);

  test("cancels a queued project without inventing provider usage after restart", async () => {
    const item = await fixture({ mode: "workflow-cancel", searchEnabled: false });
    const firstThread = await item.createThread("known-problem");
    const first = await item.post("/research/start", { threadId: firstThread }, z.object({ runId: z.string() }));
    await item.waitForAttempt("accepted");
    const queuedThread = await item.createThread("known-problem");
    const queued = await item.post("/research/start", { threadId: queuedThread }, z.object({ runId: z.string() }));
    await item.waitForAttempt("prepared");
    await item.post("/research/cancel", { runId: queued.runId }, z.object({ workspace: WorkspaceStateSchema }));
    await item.waitForAttempt("cancelled");
    expect(item.requests()).toHaveLength(1);
    const db = new DatabaseClient(item.dbPath);
    try {
      expect(db.db.prepare("SELECT terminal_kind FROM generation_attempts WHERE research_run_id = ?").get(queued.runId))
        .toEqual({ terminal_kind: "never-dispatched" });
      expect(db.db.prepare("SELECT id FROM cost_ledger WHERE research_run_id = ?").all(queued.runId)).toEqual([]);
    } finally { db.close(); }
    expect((await item.workspace()).latestResearchRun?.usage).toMatchObject({ attemptCount: 0, unknownAttemptCount: 0 });
    await item.post("/research/cancel", { runId: first.runId }, z.object({ workspace: WorkspaceStateSchema }));
    await item.restart();
    expect((await item.workspace()).latestResearchRun?.usage).toMatchObject({ attemptCount: 0, unknownAttemptCount: 0 });
    expect(item.requests()).toHaveLength(1);
  }, 30_000);

  test("retains partial results after pipe loss and never automatically replays ambiguous work", async () => {
    const item = await fixture({ mode: "workflow-crash", searchEnabled: false });
    const threadId = await item.createThread("known-problem");
    const { runId } = await item.post("/research/start", { threadId }, z.object({ runId: z.string() }));
    const options = await item.waitFor((state) => state.latestResearchRun?.awaitingSelection === true);
    await item.post("/research/select-option", { threadId, runId, solutionId: options.solutions[0]!.id }, WorkspaceStateSchema);
    const failed = await item.waitFor((state) => state.threads.find((thread) => thread.id === threadId)?.status === "failed");
    expect(failed.solutions).toHaveLength(2);
    expect(item.requests()).toHaveLength(2);
    await item.restart();
    expect((await item.workspace()).solutions).toEqual(failed.solutions);
    expect((await item.raw("/research/resume", { runId })).status).toBe(409);
    expect(item.requests()).toHaveLength(2);
    const db = new DatabaseClient(item.dbPath);
    try {
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM solutions WHERE research_run_id = ?").get(runId)).toEqual({ count: 2 });
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM outcomes").get()).toEqual({ count: 0 });
      expect(db.db.prepare("SELECT status FROM generation_attempts ORDER BY created_at, rowid").all())
        .toEqual([{ status: "completed" }, { status: "interrupted" }]);
      expect(db.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { db.close(); }
  }, 15_000);
});

describe("native v2 decisions through the production backend", () => {
  test("saves twenty configured ideas and selects the last one", async () => {
    const item = await fixture({ mode: "workflow-many", searchEnabled: false });
    const threadId = await item.createThread("known-problem", 20);
    await item.post("/research/start", { threadId }, z.object({ runId: z.string() }));
    const options = await item.waitFor(state => state.latestResearchRun?.awaitingSelection === true);
    expect(options.solutions).toHaveLength(20);
    const selected = options.solutions[19]!;
    await item.post("/research/select-option", { threadId, runId: selected.runId, solutionId: selected.id }, WorkspaceStateSchema);
    await item.waitFor(state => state.latestResearchRun?.status === "completed" && !state.latestResearchRun.awaitingSelection);
    expect((await item.post(`/ideas/${selected.id}`, undefined, SolutionViewSchema)).decisionAnalysis).not.toBeNull();
    await item.restart();
    expect((await item.workspace()).solutions).toHaveLength(20);
    item.assertAccounting(3);
  });

  test("retains and exports risk evaluation after analysis fails, then reuses it on resume", async () => {
    const item = await fixture({ mode: "workflow-analysis-fail", searchEnabled: false });
    const threadId = await item.createThread("known-problem");
    await item.post("/research/start", { threadId }, z.object({ runId: z.string() }));
    const options = await item.waitFor(state => state.latestResearchRun?.awaitingSelection === true);
    const selected = options.solutions[0]!;
    await item.post("/research/select-option", { threadId, runId: selected.runId, solutionId: selected.id }, WorkspaceStateSchema);
    await item.waitFor(state => state.latestResearchRun?.status === "failed");
    const failed = await item.post(`/ideas/${selected.id}`, undefined, SolutionViewSchema);
    expect(failed.riskEvaluation?.risks[0]?.riskId).toBe("sparse");
    expect(failed.decisionAnalysis).toBeNull();
    const exported = await item.post("/ideas/export", { threadId, format: "markdown" }, z.object({ files: z.array(z.object({ content: z.string() })) }));
    expect(exported.files[0]!.content).toContain("Observed order volume stays too sparse");
    await item.restart("workflow");
    await item.post("/research/resume", { runId: selected.runId }, z.unknown());
    await item.waitFor(state => state.latestResearchRun?.status === "completed");
    const resumed = await item.post(`/ideas/${selected.id}`, undefined, SolutionViewSchema);
    expect(resumed.riskEvaluation).toEqual(failed.riskEvaluation);
    expect(resumed.decisionAnalysis?.risks).toEqual(failed.riskEvaluation?.risks);
    expect(item.requests().map(request => request.workOrder.stage)).toEqual(["solutions", "risk-evaluation", "decision-analysis", "decision-analysis"]);
  });

  test("continues a historical six-stage run without adding risk evaluation", async () => {
    const item = await fixture({ searchEnabled: false });
    const threadId = await item.createThread("known-problem");
    await item.post("/research/start", { threadId }, z.object({ runId: z.string() }));
    const options = await item.waitFor(state => state.latestResearchRun?.awaitingSelection === true);
    const selected = options.solutions[0]!;
    const db = new DatabaseClient(item.dbPath);
    try {
      const row = db.db.prepare("SELECT value_json FROM workflow_snapshots WHERE research_run_id = ? AND snapshot_key = 'prompts'").get(selected.runId) as { value_json: string };
      const prompts = JSON.parse(row.value_json) as Record<string, unknown>;
      delete prompts["risk-evaluation"];
      db.db.prepare("UPDATE workflow_snapshots SET value_json = ? WHERE research_run_id = ? AND snapshot_key = 'prompts'").run(JSON.stringify(prompts), selected.runId);
    } finally { db.close(); }
    await item.restart();
    await item.post("/research/select-option", { threadId, runId: selected.runId, solutionId: selected.id }, WorkspaceStateSchema);
    await item.waitFor(state => state.latestResearchRun?.status === "completed" && !state.latestResearchRun.awaitingSelection);
    expect(item.requests().map(request => request.workOrder.stage)).toEqual(["solutions", "decision-analysis"]);
    item.assertAccounting(2);
  });

  test("pauses after options, reopens under changed prompts, analyzes one option and records an observed result", async () => {
    const item = await fixture({ searchEnabled: false, workflowVersion: 2 });
    const threadId = await item.createThread("known-problem");
    await item.post("/research/start", { threadId }, z.object({ runId: z.string() }));
    const options = await item.waitFor((state) => state.latestResearchRun?.awaitingSelection === true);
    expect(options.solutions).toHaveLength(2);
    expect(item.requests()).toHaveLength(1);
    expect(item.searches).toHaveLength(0);
    const first = options.solutions[0]!;
    const savedPrompt = readFileSync(join(process.cwd(), "prompts/workflow-v2-decision-analysis.md"), "utf8");
    writeFileSync(join(item.directory, "prompts/workflow-v2-decision-analysis.md"), "This changed override must only affect a new run.");
    await item.restart();
    expect((await item.workspace()).solutions).toEqual(options.solutions);
    expect(item.requests()).toHaveLength(1);
    await item.post("/research/select-option", { threadId, runId: first.runId, solutionId: first.id }, WorkspaceStateSchema);
    const completed = await item.waitFor((state) => state.latestResearchRun?.status === "completed" && !state.latestResearchRun.awaitingSelection);
    expect(item.requests()).toHaveLength(3);
    expect(item.requests()[2]!.workOrder.instruction).toBe(savedPrompt.trim());
    expect(completed.solutions.filter((idea) => idea.selected)).toHaveLength(1);
    const detail = await item.post(`/ideas/${first.id}`, undefined, z.object({ decisionAnalysis: z.object({ experiment: z.object({ passCriterion: z.string() }) }) }));
    expect(detail.decisionAnalysis.experiment.passCriterion).toContain("eight");
    await item.post("/research/decision", { threadId, solutionId: first.id, userDecision: "Try one supplier", observedResult: "Nine of ten arrivals met the estimate" }, WorkspaceStateSchema);
    const exported = await item.post("/ideas/export", { threadId, format: "json" }, z.object({ files: z.array(z.object({ content: z.string() })) }));
    expect(exported.files[0]!.content).toContain("Nine of ten");
    expect(exported.files[0]!.content).toContain('"workflowVersion": 2');
    const markdown = await item.post("/ideas/export", { threadId, format: "markdown" }, z.object({ files: z.array(z.object({ content: z.string() })) }));
    expect(markdown.files[0]!.content).toContain("Next experiment");
    await item.restart();
    expect(item.requests()).toHaveLength(3);
    item.assertAccounting(3);
    const db = new DatabaseClient(item.dbPath);
    try {
      expect(db.db.prepare("SELECT stage_id FROM stage_results ORDER BY completed_at").all()).toEqual([{ stage_id: "solutions" }, { stage_id: "risk-evaluation" }, { stage_id: "decision-analysis" }]);
      expect(db.db.prepare("SELECT observed_result FROM decision_analyses").get()).toEqual({ observed_result: "Nine of ten arrivals met the estimate" });
    } finally { db.close(); }
  }, 20_000);

  test("preserves contrary sources and untrusted observations through all seven v2 stages", async () => {
    const item = await fixture({ workflowVersion: 2 });
    const threadId = await item.createThread("explore-market");
    await item.post("/research/start", { threadId }, z.object({ runId: z.string() }));
    const discovery = await item.waitFor((state) => state.threads.find((thread) => thread.id === threadId)?.status === "problems-ready");
    const problem = discovery.problemCandidates[0]!;
    expect(problem.verdict).toBe("overstated");
    await item.post("/research/select-problems", { threadId, problemIds: [problem.id], userProblem: null }, WorkspaceStateSchema);
    const options = await item.waitFor((state) => state.latestResearchRun?.awaitingSelection === true);
    const selected = options.solutions[0]!;
    await item.post("/research/select-option", { threadId, runId: selected.runId, solutionId: selected.id }, WorkspaceStateSchema);
    await item.waitFor((state) => state.latestResearchRun?.status === "completed" && !state.latestResearchRun.awaitingSelection);
    for (const request of item.requests()) expect(JSON.stringify(request.workOrder)).not.toContain(untrusted);
    const analysis = item.requests().find((request) => request.workOrder.stage === "decision-analysis")!;
    expect(JSON.stringify(analysis.evidence)).toContain("Most deliveries arrived on time.");
    expect(JSON.stringify(analysis.evidence)).toContain("disagrees");
    expect(JSON.stringify(analysis.evidence)).toContain("Delays may cluster");
    expect(JSON.stringify(analysis.evidence)).toContain("This source may not represent other shops");
    expect(JSON.stringify(analysis.evidence)).not.toContain('"researchAssessments"');
    expect(item.requests().filter((request) => ["solutions", "risk-evaluation", "decision-analysis"].includes(request.workOrder.stage))).toHaveLength(3);

    const question = "Do representative delivery logs contradict the selected option?";
    const requestsBeforeFollowUp = item.requests().length;
    const searchesBeforeFollowUp = item.searches.length;
    await item.post("/research/evidence-follow-up", { threadId, runId: selected.runId, question }, WorkspaceStateSchema);
    const followedUp = await item.waitFor((state) => state.latestResearchRun?.status === "completed");
    const detail = await item.post(`/ideas/${selected.id}`, undefined, SolutionViewSchema);
    expect(detail.evidenceFollowUp).toEqual(expect.objectContaining({ status: "completed", question, error: null }));
    expect(detail.evidenceFollowUp?.sources).toHaveLength(2);
    expect(detail.evidenceFollowUp?.factors).toHaveLength(2);
    const followUpRequest = item.requests().find((request) => request.workOrder.stage === "factor-harvest:follow-up")!;
    expect(followUpRequest.workOrder.inputs).toEqual({ routing: { harvestMode: "domain", followUp: true }, workflowVersion: 2 });
    expect(JSON.stringify(followUpRequest.workOrder)).not.toContain(question);
    expect(JSON.stringify(followUpRequest.evidence)).toContain(question);
    expect(item.searches.at(-1)).toEqual(expect.objectContaining({ query: question }));
    expect(item.searches).toHaveLength(searchesBeforeFollowUp + 1);
    expect(item.requests()).toHaveLength(requestsBeforeFollowUp + 1);
    item.assertAccounting(requestsBeforeFollowUp + 1);
    expect((await item.raw("/research/evidence-follow-up", { threadId, runId: selected.runId, question: "Try twice" })).status).toBe(409);
    await item.restart();
    const reopened = await item.post(`/ideas/${selected.id}`, undefined, SolutionViewSchema);
    expect(reopened.evidenceFollowUp).toEqual(detail.evidenceFollowUp);
    expect(followedUp.solutions.find((solution) => solution.id === selected.id)?.decisionAnalysis).toBeUndefined();
  }, 20_000);

  test("cancels a pending follow-up without losing analysis or reopening its cap", async () => {
    const item = await fixture({ workflowVersion: 2, hangFollowUpSearch: true });
    const threadId = await item.createThread("known-problem");
    await item.post("/research/start", { threadId }, z.object({ runId: z.string() }));
    const options = await item.waitFor((state) => state.latestResearchRun?.awaitingSelection === true);
    const selected = options.solutions[0]!;
    await item.post("/research/select-option", { threadId, runId: selected.runId, solutionId: selected.id }, WorkspaceStateSchema);
    await item.waitFor((state) => state.latestResearchRun?.status === "completed" && !state.latestResearchRun.awaitingSelection);
    await item.post("/research/evidence-follow-up", {
      threadId, runId: selected.runId, question: "Will this search be cancelled?",
    }, WorkspaceStateSchema);
    await item.waitFor((state) => state.latestResearchRun?.status === "running");
    await item.post("/research/cancel", { runId: selected.runId }, z.object({ workspace: WorkspaceStateSchema }));
    const detail = await item.post(`/ideas/${selected.id}`, undefined, SolutionViewSchema);
    expect(detail.decisionAnalysis).not.toBeNull();
    expect(detail.evidenceFollowUp).toEqual(expect.objectContaining({ status: "failed", error: "Cancelled by user" }));
    expect((await item.raw("/research/evidence-follow-up", {
      threadId, runId: selected.runId, question: "Try again",
    })).status).toBe(409);
    const db = new DatabaseClient(item.dbPath);
    try {
      expect(db.db.prepare("SELECT 1 FROM cost_ledger WHERE operation = 'evidence-follow-up'").all()).toEqual([]);
      expect(db.db.prepare("SELECT status, committed_usd FROM cost_ledger WHERE operation = 'evidence-follow-up-search'").all())
        .toEqual([{ status: "committed", committed_usd: null }]);
      expect(db.db.prepare("SELECT status FROM research_runs WHERE id = ?").get(selected.runId)).toEqual({ status: "completed" });
    } finally { db.close(); }
    await item.restart();
    expect((await item.post(`/ideas/${selected.id}`, undefined, SolutionViewSchema)).evidenceFollowUp)
      .toEqual(detail.evidenceFollowUp);
    expect(item.requests()).toHaveLength(3);
  }, 20_000);
});

async function fixture({ mode = "workflow", searchEnabled = true, workflowVersion = 2, hangFollowUpSearch = false }: {
  mode?: string; searchEnabled?: boolean; workflowVersion?: 1 | 2; hangFollowUpSearch?: boolean;
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "scraply-native-workflow-"));
  const dbPath = join(directory, "scraply.db");
  const capture = join(directory, "requests.jsonl");
  const pids = join(directory, "pids.txt");
  const operationsCapture = join(directory, "operations.txt");
  const searches: unknown[] = [];
  const events: ResearchEvent[] = [];
  let backend: Awaited<ReturnType<typeof startNativeWorkflowBackend>>;
  let closed = true;
  const lines = (path: string) => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : [];

  async function open() {
    backend = await startNativeWorkflowBackend(directory, { mode, searchEnabled, searches, hangFollowUpSearch, onEvent: (event) => events.push(event) });
    closed = false;
  }
  async function close() {
    if (closed) return;
    closed = true;
    await backend.close();
  }
  async function raw(path: string, body?: unknown) {
    return fetch(`http://127.0.0.1:${backend.port}${path}`, {
      method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(5_000),
      headers: { authorization: `Bearer ${backend.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function post<T>(path: string, body: unknown, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
    const startedAt = Date.now();
    const response = await raw(path, body);
    const text = await response.text();
    if (!text) throw new Error(`${path}: empty HTTP ${response.status} response after ${Date.now() - startedAt} ms (${response.headers.get("content-type") ?? "no content type"})`);
    const result: unknown = JSON.parse(text);
    if (response.status !== 200) throw new Error(`${path}: ${JSON.stringify(result)}`);
    return schema.parse(z.object({ data: z.unknown() }).parse(result).data);
  }
  async function workspace() { return post("/workspace", undefined, WorkspaceStateSchema); }
  const item = {
    directory, dbPath, searches, events, raw, post, workspace, close,
    operations: () => lines(operationsCapture), processIds: () => lines(pids),
    requests: () => lines(capture).map((line) => z.object({ payload: GenerationStartPayloadSchema }).parse(JSON.parse(line)).payload),
    async restart(nextMode = mode) { await close(); mode = nextMode; await open(); },
    async createThread(researchMode: "explore-market" | "known-problem", ideaCount = 3) {
      const created = await post("/threads", { title: scope.title }, z.object({ thread: z.object({ id: z.string() }) }));
      const threadId = created.thread.id;
      await post("/scope", { threadId, scope }, WorkspaceStateSchema);
      await post("/run-config", { threadId, config: { ...DEFAULT_RUN_CONFIG, workflowVersion, ideaCount, model, discoveryDepth: "quick", researchMode, knownProblem: researchMode === "known-problem" ? statement : "" } }, WorkspaceStateSchema);
      return threadId;
    },
    async waitFor(predicate: (state: WorkspaceState) => boolean) {
      const deadline = Date.now() + 8_000;
      let state = await workspace();
      while (!predicate(state) && Date.now() < deadline) {
        if (state.threads.find((thread) => thread.id === state.activeThreadId)?.status === "failed") {
          const db = new DatabaseClient(dbPath);
          const failed = db.db.prepare("SELECT completion_reason FROM research_runs WHERE id = ?").get(state.latestResearchRun?.runId);
          db.close();
          throw new Error(`Workflow failed: ${JSON.stringify(failed)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        state = await workspace();
      }
      expect(predicate(state)).toBe(true);
      return state;
    },
    async waitForAttempt(status: string) {
      const db = new DatabaseClient(dbPath);
      try {
        const deadline = Date.now() + 5_000;
        while (!db.db.prepare("SELECT 1 FROM generation_attempts WHERE status = ?").get(status)) {
          if (Date.now() >= deadline) throw new Error(`No generation reached ${status}`);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      } finally { db.close(); }
    },
    assertAccounting(count: number) {
      const db = new DatabaseClient(dbPath);
      try {
        const attempts = db.db.prepare("SELECT status, runtime_prompt_sha256, request_sha256 FROM generation_attempts").all() as Array<{ status: string; runtime_prompt_sha256: string; request_sha256: string }>;
        expect(attempts).toHaveLength(count);
        expect(attempts.every((attempt) => attempt.status === "completed" && attempt.runtime_prompt_sha256.length === 64 && attempt.request_sha256.length === 64)).toBe(true);
        const costs = db.db.prepare("SELECT status, committed_usd FROM cost_ledger WHERE generation_attempt_id IS NOT NULL").all();
        expect(costs).toHaveLength(count);
        expect(costs).toEqual(Array.from({ length: count }, () => ({ status: "committed", committed_usd: null })));
        expect(db.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally { db.close(); }
    },
  };
  fixtures.push(item);
  await open();
  return item;
}
