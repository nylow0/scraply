import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { IdeaConversationService } from "../../src/core/idea-conversation-service";
import { WorkflowCoordinator } from "../../src/core/workflow-coordinator";
import { ResearchRequestService } from "../../src/core/research-request-service";
import { materializeResearchSnapshot } from "../../src/core/research-revisions";
import { DatabaseClient } from "../../src/db/client";
import { WorkflowV2Repository } from "../../src/db/repositories/workflow-v2";
import { ResearchFrameRepository } from "../../src/db/repositories/research-frames";
import type { ResearchFrame } from "../../src/shared/research-frame";
import { WorkflowRepository } from "../../src/db/repositories/workflows";
import { ProviderFailure, type StructuredModelClient, type StructuredStageRequest } from "../../src/providers/structured";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";

const roots: string[] = [];
const clients: DatabaseClient[] = [];
const model = { providerId: "test", modelId: "model-1" };
const promptSha = createHash("sha256").update("test runtime prompt").digest("hex");

afterEach(() => {
  while (clients.length) clients.pop()!.close();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture(): DatabaseClient {
  const root = mkdtempSync(join(tmpdir(), "scraply-idea-turn-"));
  roots.push(root);
  const db = new DatabaseClient(join(root, "scraply.db"));
  clients.push(db);
  const now = new Date().toISOString();
  db.db.prepare("INSERT INTO threads (id, title, status, created_at, updated_at) VALUES ('thread-1', 'Ideas', 'solutions-ready', ?, ?)")
    .run(now, now);
  db.db.prepare("INSERT INTO research_runs (id, thread_id, status, config_json, workflow_version, created_at, updated_at) VALUES ('discovery-1', 'thread-1', 'completed', '{}', 1, ?, ?)")
    .run(now, now);
  db.db.prepare("INSERT INTO scopes (id, research_run_id, title, audience, domain, observations, off_limits_json, created_at, updated_at) VALUES ('scope-1', 'discovery-1', 'Releases', 'Teams', 'Software', '', '[]', ?, ?)")
    .run(now, now);
  db.db.prepare(`
    INSERT INTO problems (id, discovery_run_id, statement, why_it_persists, affected,
      scale_estimate, verdict, verdict_reason, verdict_source_ids_json, created_at)
    VALUES ('problem-1', 'discovery-1', 'Upgrades bypass review', 'Teams rush', 'Release owners',
      'Unknown', 'confirmed', 'A saved source describes it', '[]', ?)
  `).run(now);
  db.db.prepare(`
    INSERT INTO sources (id, research_run_id, canonical_url, title, retrieved_text,
      content_hash, retrieved_at) VALUES ('source-1', 'discovery-1', 'https://example.test/review',
      'Release review account', 'Release review catches upgrade issues.', 'hash-1', ?)
  `).run(now);
  db.db.prepare("INSERT INTO problem_verdict_sources (problem_id, source_id, research_run_id, position) VALUES ('problem-1', 'source-1', 'discovery-1', 0)").run();
  db.db.prepare(`
    INSERT INTO research_runs (id, thread_id, status, config_json, workflow_version,
      problem_id, created_at, updated_at)
    VALUES ('run-v2', 'thread-1', 'completed', ?, 2, 'problem-1', ?, ?)
  `).run(JSON.stringify(DEFAULT_RUN_CONFIG), now, now);
  db.immediateTransaction(() => new WorkflowV2Repository(db).saveSolutionOptions("run-v2", "problem-1", [{
    id: "idea-1", mechanism: "Review dependencies before release",
    description: "Put upgrade changes in the release checklist.",
    keyAssumption: "Owners can review in time.", whyCurrentApproachMaySuffice: "Existing checklist may suffice.",
    supportingEvidenceIds: ["source-1"], contraryEvidenceIds: [], unknowns: ["Owner capacity"],
    respectsOffLimits: true, respectsOffLimitsWhy: "Uses existing process.",
  }]));
  return db;
}

function request(clientMessageId: string) {
  return {
    threadId: "thread-1", rootSolutionId: "idea-1", baseSolutionId: "idea-1",
    expectedHeadTurnId: null, parentTurnId: null, clientMessageId,
    intent: "explain" as const, text: "Why could this work?", model, reasoningEffort: "medium",
    allowance: { maxModelCalls: 2, maxMinutes: 2 },
  };
}

function completion(output: unknown): StructuredModelClient {
  return { async structuredCompletion<T>(prepared: StructuredStageRequest<T>) {
    prepared.onDispatched?.();
    prepared.onAccepted?.({ compilerPrompt: { id: "scraply.stage-worker.v1", sha256: promptSha } });
    return { output: output as T, metadata: {
      model, prompt: { id: "scraply.stage-worker.v1", sha256: promptSha },
      usage: { status: "unknown" }, latencyMs: 1, repairCount: 0,
      providerRequestIds: ["provider-request-1"],
      attempts: [{ attempt: "initial", outcome: "completed", providerCompletion: "confirmed",
        model, usage: { status: "unknown" }, cost: { status: "not_reported" }, latencyMs: 1 }],
    } };
  } };
}

async function waitForTurn(db: DatabaseClient, turnId: string): Promise<string> {
  for (let index = 0; index < 100; index += 1) {
    const row = db.db.prepare("SELECT state FROM idea_turns WHERE id = ?").get(turnId) as { state: string };
    if (row.state !== "pending") return row.state;
    await Bun.sleep(10);
  }
  throw new Error("Idea turn did not settle within one second");
}

async function versionSelectionFixture() {
  const db = fixture();
  const service = new IdeaConversationService({ db, modelClient: () => completion({
    reply: "Put dependency review in the weekly checklist.", citedEvidenceIds: ["source-1"],
    assumptions: [], changeSummary: "Uses the weekly checklist", candidate: {
      mechanism: "Review upgrades inside the weekly release checklist",
      description: "The release owner reviews changed dependencies before approval.",
      keyAssumption: "Owners can review in time.", whyCurrentApproachMaySuffice: "An existing checklist may suffice.",
      supportingEvidenceIds: ["source-1"], contraryEvidenceIds: [], unknowns: [],
      respectsOffLimits: true, respectsOffLimitsWhy: "Uses the existing process.",
    },
  }), modelAvailable: () => true, onProgress: () => {} });
  const admitted = await service.submitTurn({ ...request("selection-rethink"), intent: "rethink" });
  expect(await waitForTurn(db, admitted.turnId)).toBe("completed");
  const workflows = new WorkflowRepository(db);
  const session = workflows.getSession(admitted.sessionId)!;
  const versionId = service.getConversation({ ideaId: "idea-1" }).versions[1]!.solutionId;
  const coordinator = new WorkflowCoordinator({ db, ideaService: service,
    engine: () => { throw new Error("Version selection must not start the engine"); },
    capabilities: async () => { throw new Error("Version selection must not contact a provider"); },
    listProblems: () => [], onProgress: () => {},
  });
  const command = { threadId: session.threadId, sessionId: session.id,
    clientCommandId: "select-original", expectedRevision: session.revision,
    action: { type: "select-version" as const, rootSolutionId: "idea-1", solutionId: "idea-1" } };
  return { db, service, workflows, coordinator, session, versionId, command };
}

describe("idea version selection transactions", () => {
  test("workflow selection commits one revision and receipt, and duplicate commands never select again", async () => {
    const { db, service, workflows, coordinator, session, versionId, command } = await versionSelectionFixture();
    db.db.prepare("UPDATE workflow_solution_preferences SET updated_at = '2000-01-01T00:00:00.000Z'").run();
    const receipt = await coordinator.command(command);
    expect(receipt.revision).toBe(session.revision + 1);
    expect(workflows.getSession(session.id)).toEqual({ ...session, revision: receipt.revision });
    expect(service.getConversation({ ideaId: "idea-1" }).selectedVersionId).toBe("idea-1");
    expect(workflows.getCommand(session.threadId, command.clientCommandId)?.result).toEqual(receipt);
    const preference = db.db.prepare("SELECT * FROM workflow_solution_preferences").all();
    expect(preference).toEqual([expect.objectContaining({ selected_solution_id: "idea-1", updated_at: expect.any(String) })]);
    expect(preference).not.toEqual([expect.objectContaining({ updated_at: "2000-01-01T00:00:00.000Z" })]);
    expect((await coordinator.command(command)).revision).toBe(receipt.revision);
    expect(db.db.prepare("SELECT * FROM workflow_solution_preferences").all()).toEqual(preference);
    expect(workflows.getSession(session.id)?.revision).toBe(receipt.revision);

    await coordinator.command({ ...command, clientCommandId: "select-rethink", expectedRevision: receipt.revision,
      action: { ...command.action, solutionId: versionId } });
    // Replaying an older receipt must not overwrite a later version selection.
    expect((await coordinator.command(command)).revision).toBe(receipt.revision);
    expect(workflows.getSelectedVersion("idea-1")).toBe(versionId);
    expect(workflows.getSession(session.id)?.revision).toBe(session.revision + 2);
    await expect(coordinator.command({ ...command, action: { ...command.action, solutionId: versionId } }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(coordinator.command({ ...command, clientCommandId: "stale-selection" }))
      .rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(workflows.getCommand(session.threadId, "stale-selection")).toBeNull();
    expect(workflows.getSelectedVersion("idea-1")).toBe(versionId);
  });

  for (const failure of ["revision", "receipt"] as const) {
    test(`a failed workflow ${failure} rolls back the selected version, revision, and receipt`, async () => {
      const { db, workflows, coordinator, session, versionId, command } = await versionSelectionFixture();
      const before = db.db.prepare("SELECT * FROM workflow_solution_preferences").all();
      // Fire only after the selection changed, so this proves rollback of an actual mutation.
      db.db.exec(`CREATE TRIGGER fail_version_selection AFTER ${failure === "revision"
        ? "UPDATE ON workflow_sessions" : "INSERT ON workflow_commands"}
        WHEN (SELECT selected_solution_id FROM workflow_solution_preferences WHERE root_solution_id = 'idea-1') = 'idea-1'
        BEGIN SELECT RAISE(ABORT, 'forced ${failure} failure'); END`);
      await expect(coordinator.command(command)).rejects.toThrow(`forced ${failure} failure`);
      expect(db.db.prepare("SELECT * FROM workflow_solution_preferences").all()).toEqual(before);
      expect(workflows.getSelectedVersion("idea-1")).toBe(versionId);
      expect(workflows.getSession(session.id)).toEqual(session);
      expect(workflows.getCommand(session.threadId, command.clientCommandId)).toBeNull();
      db.db.exec("DROP TRIGGER fail_version_selection");
      expect((await coordinator.command(command)).revision).toBe(session.revision + 1);
    });
  }

  test("standalone selection owns its transaction and rolls back a failed preference write", async () => {
    const { db, service, workflows, session, versionId } = await versionSelectionFixture();
    const before = db.db.prepare("SELECT * FROM workflow_solution_preferences").all();
    db.db.exec(`CREATE TRIGGER fail_standalone_selection AFTER UPDATE ON workflow_solution_preferences
      BEGIN SELECT RAISE(ABORT, 'forced preference failure'); END`);
    expect(() => service.selectVersion(session.threadId, "idea-1", "idea-1")).toThrow("forced preference failure");
    expect(db.db.prepare("SELECT * FROM workflow_solution_preferences").all()).toEqual(before);
    expect(workflows.getSelectedVersion("idea-1")).toBe(versionId);
    expect(workflows.getSession(session.id)).toEqual(session);
    db.db.exec("DROP TRIGGER fail_standalone_selection");
    service.selectVersion(session.threadId, "idea-1", "idea-1");
    expect(workflows.getSelectedVersion("idea-1")).toBe("idea-1");
    expect(workflows.getSession(session.id)).toEqual(session);
  });

  test("caller-owned selection requires a transaction and rolls back with its caller", async () => {
    const { db, service, workflows, session, versionId } = await versionSelectionFixture();
    expect(() => service.selectVersion(session.threadId, "idea-1", "idea-1", { transaction: "existing" }))
      .toThrow("This mutation requires a caller-owned immediate transaction");
    expect(workflows.getSelectedVersion("idea-1")).toBe(versionId);
    expect(() => db.immediateTransaction(() => {
      service.selectVersion(session.threadId, "idea-1", "idea-1", { transaction: "existing" });
      expect(workflows.getSelectedVersion("idea-1")).toBe("idea-1");
      throw new Error("caller failed after selection");
    })).toThrow("caller failed after selection");
    expect(workflows.getSelectedVersion("idea-1")).toBe(versionId);
    // Explicit ownership must not weaken the database's global nested-transaction guard.
    expect(() => db.immediateTransaction(() => service.selectVersion(session.threadId, "idea-1", "idea-1")))
      .toThrow("Nested immediate transactions are not supported");
    expect(workflows.getSelectedVersion("idea-1")).toBe(versionId);
  });

  test("selection also advances an unfinished session without changing its state or timing", async () => {
    const { db, workflows, coordinator, session, command } = await versionSelectionFixture();
    db.db.prepare("UPDATE workflow_sessions SET state = 'waiting-for-review', outcome = NULL, finished_at = NULL WHERE id = ?")
      .run(session.id);
    const before = workflows.getSession(session.id)!;
    expect((await coordinator.command(command)).revision).toBe(before.revision + 1);
    expect(workflows.getSession(session.id)).toEqual({ ...before, revision: before.revision + 1 });
  });

  test("invalid roots, versions, projects, and session owners leave all selection state unchanged", async () => {
    const { db, service, workflows, coordinator, session, versionId, command } = await versionSelectionFixture();
    const now = new Date().toISOString();
    db.db.prepare("INSERT INTO threads (id, title, status, created_at, updated_at) VALUES ('thread-2', 'Synthetic second project', 'solutions-ready', ?, ?)")
      .run(now, now);
    db.db.prepare(`INSERT INTO research_runs (id, thread_id, status, config_json, workflow_version, created_at, updated_at)
      VALUES ('foreign-run', 'thread-2', 'completed', ?, 2, ?, ?)`).run(JSON.stringify(DEFAULT_RUN_CONFIG), now, now);
    db.db.prepare(`INSERT INTO problems (id, discovery_run_id, statement, why_it_persists, affected,
      scale_estimate, verdict, verdict_reason, verdict_source_ids_json, created_at)
      SELECT 'foreign-problem', 'foreign-run', statement, why_it_persists, affected,
        scale_estimate, verdict, verdict_reason, verdict_source_ids_json, created_at FROM problems WHERE id = 'problem-1'`).run();
    db.db.prepare("UPDATE research_runs SET problem_id = 'foreign-problem' WHERE id = 'foreign-run'").run();
    for (const [id, problemId, runId] of [
      ["other-idea", "problem-1", "run-v2"], ["foreign-idea", "foreign-problem", "foreign-run"],
    ] as const) {
      db.db.prepare(`INSERT INTO solutions (id, problem_id, research_run_id, mechanism, description,
        respects_off_limits, respects_off_limits_why, created_at)
        SELECT ?, ?, ?, mechanism, description, respects_off_limits, respects_off_limits_why, created_at
        FROM solutions WHERE id = 'idea-1'`).run(id, problemId, runId);
      db.immediateTransaction(() => workflows.createSolutionLineage({ solutionId: id, rootSolutionId: id, changeSummary: "Original idea" }));
    }
    const foreignSession = db.immediateTransaction(() => workflows.createSession({ threadId: "thread-2", purpose: "idea-turn",
      mode: "babysit", contract: {}, remainingMs: 60_000 }));
    const before = db.db.prepare("SELECT * FROM workflow_solution_preferences").all();
    const invalidReferences = [
      { rootSolutionId: "missing-root", solutionId: versionId },
      { rootSolutionId: "idea-1", solutionId: "missing-version" },
      { rootSolutionId: "idea-1", solutionId: "other-idea" },
      { rootSolutionId: "other-idea", solutionId: versionId },
      { rootSolutionId: "foreign-idea", solutionId: "foreign-idea" },
      { rootSolutionId: "idea-1", solutionId: "foreign-idea" },
    ];
    for (const [index, reference] of invalidReferences.entries()) {
      expect(() => service.selectVersion(session.threadId, reference.rootSolutionId, reference.solutionId))
        .toThrow(expect.objectContaining({ code: "INVALID_REFERENCE" }));
      const clientCommandId = `invalid-selection-${index}`;
      await expect(coordinator.command({ ...command, clientCommandId, action: { type: "select-version", ...reference } }))
        .rejects.toMatchObject({ code: "INVALID_REFERENCE" });
      expect(workflows.getCommand(session.threadId, clientCommandId)).toBeNull();
    }
    await expect(coordinator.command({ ...command, sessionId: foreignSession.id }))
      .rejects.toMatchObject({ code: "INVALID_REFERENCE" });
    await expect(coordinator.command({ ...command, threadId: "thread-2" }))
      .rejects.toMatchObject({ code: "INVALID_REFERENCE" });
    expect(workflows.getCommand(session.threadId, command.clientCommandId)).toBeNull();
    expect(workflows.getCommand("thread-2", command.clientCommandId)).toBeNull();
    expect(db.db.prepare("SELECT * FROM workflow_solution_preferences").all()).toEqual(before);
    expect(workflows.getSession(session.id)).toEqual(session);
    expect(workflows.getSession(foreignSession.id)).toEqual(foreignSession);
    expect(db.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});

describe("idea conversation service", () => {
  test("a new rethink of an older idea freezes the latest approved frame and saves its goal fit", async () => {
    const db = fixture();
    const frame: ResearchFrame = { goal: "Build a competition demo", goalKind: "competition-entry", contextFacts: [],
      successCriteria: [{ id: "month", name: "One-month build", weight: "must", howJudged: "Two students can demonstrate it", basis: "brief" }],
      constraints: [{ text: "Two students in one month", kind: "team", basis: "brief" }], areas: [], exclusions: [], openQuestions: [], languages: ["en"] };
    const frames = new ResearchFrameRepository(db);
    const draft = frames.createDraft({ threadId: "thread-1", runId: "discovery-1", frame, knownProblem: true, sources: [] });
    const approved = frames.approve(draft.id, "thread-1", frame);
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const candidate = { mechanism: "Show dependency changes inside the release checklist", description: "A checklist demo for one team", keyAssumption: "Owners see changes in time", whyCurrentApproachMaySuffice: "An existing checklist may suffice", supportingEvidenceIds: ["source-1"], contraryEvidenceIds: [], unknowns: [], respectsOffLimits: true, respectsOffLimitsWhy: "Existing process only",
      biggerProblem: { statement: "Upgrades bypass reviews across teams", affected: "Release owners", scale: "Unknown", scaleKnown: false, scaleEvidenceIds: [] },
      slice: { description: "One checklist demo", connectionToBiggerProblem: "Tests a missed review checkpoint", feasibilityWithinConstraints: "Two students in one month" },
      criteriaFit: [{ criterionId: "month", criterionName: "One-month build", mustHave: true, status: "unknown", evidenceIds: [], note: "Requires a measured demo" }],
      firstTest: { kind: "measurable-demo", question: "Does the demo expose missed reviews?", method: "Inspect ten releases", cost: "One day", metric: "Missed reviews found", sample: 10, observationWindow: "One week", passCriterion: "All missed reviews found", failCriterion: "Two reviews missed", inconclusiveCriterion: "Fewer than ten releases" },
    };
    const output = { reply: "A demo can test the checkpoint", citedEvidenceIds: ["source-1"], assumptions: [], changeSummary: "Narrowed to a demonstrable checkpoint", candidate };
    const client: StructuredModelClient = { async structuredCompletion<T>(prepared: StructuredStageRequest<T>) {
      expect(prepared.workOrder.inputs).toMatchObject({ context: { frame, frameId: approved.id } });
      await gate;
      return completion(output).structuredCompletion(prepared);
    } };
    const service = new IdeaConversationService({ db, modelClient: () => client, modelAvailable: () => true, onProgress: () => {} });
    const admitted = await service.submitTurn({ ...request("framed-message"), intent: "rethink" });
    const revisedFrame = { ...frame, goal: "A later competition goal" };
    const next = frames.createApprovedVersion(approved.id, "thread-1", revisedFrame);
    expect(next.id).not.toBe(approved.id);
    release?.();
    expect(await waitForTurn(db, admitted.turnId)).toBe("completed");
    const conversation = service.getConversation({ ideaId: "idea-1" });
    const version = conversation.versions[1]!;
    const saved = db.db.prepare("SELECT criteria_fit_json, first_test_json, research_run_id FROM solutions WHERE id = ?").get(version.solutionId) as { criteria_fit_json: string; first_test_json: string; research_run_id: string };
    expect(JSON.parse(saved.criteria_fit_json)).toEqual(candidate.criteriaFit);
    expect(JSON.parse(saved.first_test_json)).toEqual(candidate.firstTest);
    expect(frames.forRun(saved.research_run_id)?.id).toBe(approved.id);
    expect(new WorkflowV2Repository(db).findStageResult(saved.research_run_id, "idea-follow-up", admitted.turnId)?.schemaRevision).toBe(2);
    expect(db.db.prepare("SELECT criteria_fit_json FROM solutions WHERE id = 'idea-1'").get()).toEqual({ criteria_fit_json: null });
  });

  test("admits before dispatch, persists the reply, and replays the same client message ID", async () => {
    const db = fixture();
    const service = new IdeaConversationService({ db, modelClient: () => completion({
      reply: "The saved source reports upgrade review catching issues.", citedEvidenceIds: ["source-1"],
      assumptions: ["Owners have time to review."], changeSummary: null, candidate: null,
    }), modelAvailable: () => true, onProgress: () => {} });
    const first = await service.submitTurn(request("message-1"));
    expect(first.turnId).toBeTruthy();
    expect(await waitForTurn(db, first.turnId)).toBe("completed");
    const replay = await service.submitTurn(request("message-1"));
    expect(replay.turnId).toBe(first.turnId);
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM idea_turns").get()).toEqual({ count: 1 });
    expect(db.db.prepare("SELECT stage_id FROM stage_results WHERE selection_key = ?").get(first.turnId))
      .toEqual({ stage_id: "idea-follow-up" });
    expect(db.db.prepare("SELECT status FROM cost_ledger").get()).toEqual({ status: "committed" });
    expect(db.db.prepare("SELECT state, settled_units FROM workflow_budget_entries").get())
      .toEqual({ state: "spent", settled_units: 1 });
    const conversation = service.getConversation({ ideaId: "idea-1" });
    expect(conversation.turns[0]?.assistant?.citedEvidenceIds).toEqual(["source-1"]);
  });

  test("a later turn includes the saved assistant reply in its model context", async () => {
    const db = fixture();
    const reply = "The saved source reports upgrade review catching issues.";
    const service = new IdeaConversationService({ db, modelClient: () => completion({
      reply, citedEvidenceIds: ["source-1"], assumptions: [], changeSummary: null, candidate: null,
    }), modelAvailable: () => true, onProgress: () => {} });
    const first = await service.submitTurn(request("message-1"));
    expect(await waitForTurn(db, first.turnId)).toBe("completed");
    const branchId = service.getConversation({ ideaId: "idea-1" }).turns[0]!.branchId;
    const second = await service.submitTurn({ ...request("message-2"), branchId,
      parentTurnId: first.turnId, expectedHeadTurnId: first.turnId, text: "What would block it?" });
    expect(await waitForTurn(db, second.turnId)).toBe("completed");
    const saved = db.db.prepare("SELECT context_json FROM idea_turns WHERE id = ?")
      .get(second.turnId) as { context_json: string };
    const context = JSON.parse(saved.context_json) as {
      workOrder: { inputs: { context: { conversation: Array<{ id: string; userText: string; assistantText: string | null }> } } };
    };
    expect(context.workOrder.inputs.context.conversation).toEqual([{
      id: first.turnId, userText: "Why could this work?", assistantText: reply,
    }]);
  });

  test("a rethink saves an immutable second solution and leaves the original selected version history", async () => {
    const db = fixture();
    const revised = {
      mechanism: "Review upgrades inside the weekly release checklist",
      description: "The existing release owner sees changed dependencies before approval.",
      keyAssumption: "The owner can see a short diff.",
      whyCurrentApproachMaySuffice: "The checklist may already do this.",
      supportingEvidenceIds: ["source-1"], contraryEvidenceIds: [], unknowns: ["Owner capacity"],
      respectsOffLimits: true, respectsOffLimitsWhy: "Uses the existing review process.",
    };
    const service = new IdeaConversationService({ db, modelClient: () => completion({
      reply: "The revised workflow uses the saved release account.", citedEvidenceIds: ["source-1"],
      assumptions: ["The checklist can carry a diff."], changeSummary: "Moves review into the weekly checklist",
      candidate: revised,
    }), modelAvailable: () => true, onProgress: () => {} });
    const admitted = await service.submitTurn({ ...request("message-2"), intent: "rethink", text: "Put review in the weekly checklist." });
    expect(await waitForTurn(db, admitted.turnId)).toBe("completed");
    const conversation = service.getConversation({ ideaId: "idea-1" });
    expect(conversation.versions).toHaveLength(2);
    expect(conversation.selectedVersionId).toBe(conversation.versions[1]!.solutionId);
    expect(conversation.versions[1]).toMatchObject({ parentSolutionId: "idea-1", versionNumber: 2, reviewFreshness: "unreviewed" });
    expect(db.db.prepare("SELECT mechanism FROM solutions WHERE id = 'idea-1'").get())
      .toEqual({ mechanism: "Review dependencies before release" });
    expect(conversation.turns[0]?.assistant?.generatedSolutionId).toBe(conversation.versions[1]?.solutionId);
    service.selectVersion("thread-1", "idea-1", "idea-1");
    expect(service.getConversation({ ideaId: "idea-1" }).selectedVersionId).toBe("idea-1");
  });

  test("a rethink after applying newer research saves a version citing its new snapshot source", async () => {
    const db = fixture();
    const now = new Date().toISOString();
    db.db.prepare("UPDATE sources SET content_hash = ? WHERE id = 'source-1'")
      .run(createHash("sha256").update("Release review catches upgrade issues.").digest("hex"));
    const workflows = new WorkflowRepository(db);
    const session = db.immediateTransaction(() => workflows.createSession({
      threadId: "thread-1", purpose: "research-followup", mode: "babysit",
      contract: { contractVersion: 1, purpose: "research-followup", mode: "babysit", brief: "Review upgrade evidence",
        scope: { title: "Releases", audience: "Teams", domain: "Software", observations: "Review gaps", offLimits: [] },
        runConfig: DEFAULT_RUN_CONFIG, targets: { kind: "per-problem", ideaCount: 1 },
        limits: { maxMinutes: 10, maxModelCalls: 2, maxSearches: 0 },
        instructions: {}, resolvedInstructions: { research: "", ideas: "", review: "" },
        instructionHashes: { research: "hash", ideas: "hash", review: "hash" } },
      remainingMs: 10 * 60_000,
    }));
    const base = db.immediateTransaction(() => {
      const materialized = materializeResearchSnapshot(db, { threadId: "thread-1", baseRunId: "discovery-1",
        sourceProblemIds: ["problem-1"], sessionId: session.id });
      const snapshot = workflows.createSnapshot({ sessionId: session.id, materializationRunId: materialized.runId,
        selection: { problemIds: materialized.problemIds }, originMap: materialized.originMap });
      workflows.updateSession(session.id, workflows.getSession(session.id)!.revision, {
        state: "waiting-for-review", activeSnapshotId: snapshot.id,
      });
      return snapshot;
    });
    db.db.prepare("UPDATE research_runs SET evidence_snapshot_id = ? WHERE id = 'run-v2'").run(base.id);
    const originalConversation = new IdeaConversationService({ db,
      modelClient: () => { throw new Error("No provider call expected"); },
      modelAvailable: () => true, onProgress: () => {},
    }).getConversation({ ideaId: "idea-1" });
    expect(originalConversation.versions[0]?.evidenceSnapshotId).toBe(base.id);
    db.db.prepare(`INSERT INTO research_runs (id, thread_id, status, config_json, workflow_version, created_at, updated_at)
      VALUES ('new-evidence-run', 'thread-1', 'completed', ?, 2, ?, ?)`).run(JSON.stringify(DEFAULT_RUN_CONFIG), now, now);
    db.db.prepare(`INSERT INTO sources (id, research_run_id, canonical_url, title, retrieved_text, content_hash, retrieved_at)
      VALUES ('new-source', 'new-evidence-run', 'https://example.test/new-review', 'New review account',
        'Release owners now review dependency changes in the weekly checklist.', ?, ?)` )
      .run(createHash("sha256").update("Release owners now review dependency changes in the weekly checklist.").digest("hex"), now);
    db.db.prepare(`INSERT INTO problems (id, discovery_run_id, statement, why_it_persists, affected,
      scale_estimate, verdict, verdict_reason, verdict_source_ids_json, created_at)
      VALUES ('new-problem', 'new-evidence-run', 'Weekly review catches dependency changes', 'Teams rush',
        'Release owners', 'Unknown', 'confirmed', 'New saved account', '[]', ?)` ).run(now);
    db.db.prepare(`INSERT INTO problem_verdict_sources (problem_id, source_id, research_run_id, position)
      VALUES ('new-problem', 'new-source', 'new-evidence-run', 0)`).run();
    const requestItem = db.immediateTransaction(() => {
      const item = workflows.createWorkItem({ sessionId: session.id, kind: "research-request", scopeKey: "new-evidence",
        state: "ready", input: { action: { kind: "new-question", question: "Has review changed?" }, baseSnapshotId: base.id } });
      workflows.updateWorkItem(item.id, "running");
      workflows.updateWorkItem(item.id, "succeeded", { outputRefs: { runId: "new-evidence-run", problemIds: ["new-problem"] } });
      return item;
    });
    const research = new ResearchRequestService({ db,
      engine: () => ({ resumeRun: async () => {} }),
      modelClient: () => { throw new Error("No research dispatch expected"); },
    });
    const applied = db.immediateTransaction(() => research.applyResearch(session.id, workflows.getSession(session.id)!.revision, {
      type: "apply-research", baseSnapshotId: base.id, includedRequestIds: [requestItem.id], replacements: [],
    }));
    const newSource = db.db.prepare("SELECT id FROM sources WHERE research_run_id = ? AND title = 'New review account'")
      .get(applied.snapshot.materializationRunId) as { id: string };
    let providerCalls = 0;
    const service = new IdeaConversationService({ db, modelClient: () => ({
      async structuredCompletion<T>(prepared: StructuredStageRequest<T>) {
        providerCalls += 1;
        return completion({ reply: "Use weekly review for the new evidence.", citedEvidenceIds: [newSource.id],
          assumptions: ["Owners review weekly"], changeSummary: "Moves review to a weekly checklist",
          candidate: { mechanism: "Review dependencies in the weekly checklist",
            description: "Release owners review the changed dependencies each week.",
            keyAssumption: "Owners can review weekly.", whyCurrentApproachMaySuffice: "Current release checks may suffice.",
            supportingEvidenceIds: [newSource.id], contraryEvidenceIds: [], unknowns: ["Owner capacity"],
            respectsOffLimits: true, respectsOffLimitsWhy: "Uses the existing process." },
        }).structuredCompletion(prepared);
      },
    }), modelAvailable: () => true, onProgress: () => {} });
    const admitted = await service.submitTurn({ ...request("rethink-new-research"), intent: "rethink",
      text: "Rethink using the newer research.", evidenceSnapshotId: applied.snapshot.id });
    expect(await waitForTurn(db, admitted.turnId)).toBe("completed");
    expect(providerCalls).toBe(1);
    const conversation = service.getConversation({ ideaId: "idea-1" });
    expect(conversation.versions).toHaveLength(2);
    expect(conversation.versions[1]).toMatchObject({ parentSolutionId: "idea-1",
      evidenceSnapshotId: applied.snapshot.id });
    expect(conversation.versions[0]?.evidenceSnapshotId).toBe(base.id);
    expect(db.db.prepare("SELECT evidence_snapshot_id FROM solution_lineage WHERE solution_id = 'idea-1'").get())
      .toEqual({ evidence_snapshot_id: base.id });
    expect(conversation.turns[0]?.assistant?.citedEvidenceIds).toContain(newSource.id);
    expect(db.db.prepare("SELECT mechanism FROM solutions WHERE id = 'idea-1'").get())
      .toEqual({ mechanism: "Review dependencies before release" });
    expect(db.db.prepare(`SELECT rr.workflow_version, rr.evidence_snapshot_id, s.supporting_evidence_ids_json
      FROM solutions s JOIN research_runs rr ON rr.id = s.research_run_id WHERE s.id = ?`)
      .get(conversation.versions[1]!.solutionId)).toEqual({ workflow_version: 2,
        evidence_snapshot_id: applied.snapshot.id, supporting_evidence_ids_json: JSON.stringify([newSource.id]) });
  });

  test("a known provider failure retains the user message and spent attempt", async () => {
    const db = fixture();
    const failed: StructuredModelClient = { async structuredCompletion(prepared) {
      prepared.onDispatched?.();
      throw new ProviderFailure("rate-limit", "The model rate limit was reached", true, { attempts: [{
        attempt: "initial", outcome: "failed", providerCompletion: "confirmed", model,
        usage: { status: "unknown" }, cost: { status: "not_reported" }, latencyMs: 1,
      }] });
    } };
    const service = new IdeaConversationService({ db, modelClient: () => failed,
      modelAvailable: () => true, onProgress: () => {} });
    const admitted = await service.submitTurn(request("message-3"));
    expect(await waitForTurn(db, admitted.turnId)).toBe("failed");
    const conversation = service.getConversation({ ideaId: "idea-1" });
    expect(conversation.turns[0]?.userText).toBe("Why could this work?");
    expect(conversation.turns[0]?.error).toContain("rate limit");
    expect(db.db.prepare("SELECT state, settled_units FROM workflow_budget_entries").get())
      .toEqual({ state: "spent", settled_units: 1 });
  });

  test("an unknown provider completion consumes its reservation and does not create a version", async () => {
    const db = fixture();
    const unknown: StructuredModelClient = { async structuredCompletion(prepared) {
      prepared.onDispatched?.();
      throw new ProviderFailure("interrupted", "The provider completion could not be confirmed", false, { attempts: [{
        attempt: "initial", outcome: "failed", providerCompletion: "unknown", model,
        usage: { status: "unknown" }, cost: { status: "unknown" }, latencyMs: 1,
      }] });
    } };
    const service = new IdeaConversationService({ db, modelClient: () => unknown,
      modelAvailable: () => true, onProgress: () => {} });
    const admitted = await service.submitTurn(request("message-4"));
    expect(await waitForTurn(db, admitted.turnId)).toBe("unknown");
    expect(service.summary(admitted.sessionId).outcome).toBe("needs-attention");
    expect(db.db.prepare("SELECT state, settled_units FROM workflow_budget_entries").get())
      .toEqual({ state: "uncertain", settled_units: 2 });
    expect(db.db.prepare("SELECT status, terminal_kind FROM generation_attempts").get())
      .toEqual({ status: "interrupted", terminal_kind: "unknown-completion" });
    expect(service.getConversation({ ideaId: "idea-1" }).versions).toHaveLength(1);
  });

  test("restart reconciliation never replays an in-flight model request", async () => {
    const db = fixture();
    let calls = 0;
    const hanging: StructuredModelClient = { async structuredCompletion(prepared) {
      calls += 1;
      prepared.onDispatched?.();
      return new Promise(() => {});
    } };
    const first = new IdeaConversationService({ db, modelClient: () => hanging,
      modelAvailable: () => true, onProgress: () => {} });
    const admitted = await first.submitTurn(request("message-5"));
    const restarted = new IdeaConversationService({ db, modelClient: () => hanging,
      modelAvailable: () => true, onProgress: () => {} });
    expect(restarted.reconcileInterrupted()).toEqual([admitted.sessionId]);
    expect(await waitForTurn(db, admitted.turnId)).toBe("unknown");
    expect(calls).toBe(1);
    expect(restarted.summary(admitted.sessionId).outcome).toBe("needs-attention");
    expect(db.db.prepare("SELECT status FROM cost_ledger").get()).toEqual({ status: "committed" });
  });
});
