import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { IdeaConversationService } from "../../src/core/idea-conversation-service";
import { DatabaseClient } from "../../src/db/client";
import { WorkflowV2Repository } from "../../src/db/repositories/workflow-v2";
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

describe("idea conversation service", () => {
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
