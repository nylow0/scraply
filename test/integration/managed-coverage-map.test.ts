import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadManagedCoverageGaps, markManagedCoverageGapCovered, runManagedCoverageMap,
} from "../../src/core/managed-coverage-map";
import { DatabaseClient } from "../../src/db/client";
import { configurePromptPaths, loadWritingGuidance } from "../../src/core/prompts";
import { OpportunityExplorationRepository } from "../../src/db/repositories/opportunity-exploration";
import { WorkflowRepository } from "../../src/db/repositories/workflows";
import type { StructuredModelClient } from "../../src/providers/structured";
import { DEFAULT_OPPORTUNITY_EXPLORATION_CONFIG } from "../../src/shared/opportunity-exploration";

const directories: string[] = [];
afterEach(() => {
  configurePromptPaths({ bundledDir: join(import.meta.dir, "../../prompts"), overrideDir: null });
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "scraply-managed-coverage-"));
  directories.push(directory);
  const db = new DatabaseClient(join(directory, "scraply.db"));
  const now = new Date().toISOString();
  db.db.prepare("INSERT INTO threads (id,title,status,created_at,updated_at) VALUES ('thread','Project','configuring',?,?)")
    .run(now, now);
  db.immediateTransaction(() => {
    const workflows = new WorkflowRepository(db);
    workflows.createSession({ id: "session", threadId: "thread", purpose: "discovery", mode: "vibe",
      contract: {}, remainingMs: 60_000 });
    workflows.createWorkItem({ id: "coverage-item", sessionId: "session", kind: "coverage-map",
      scopeKey: "coverage-map:0", state: "ready", input: { round: 0 } });
    workflows.updateWorkItem("coverage-item", "running");
  });
  const input = {
    db, threadId: "thread", sessionId: "session", workItemId: "coverage-item", round: 0 as const,
    explorationConfig: DEFAULT_OPPORTUNITY_EXPLORATION_CONFIG,
    model: { providerId: "fixture", modelId: "fixture" }, reasoningEffort: "low" as const,
    signal: new AbortController().signal,
  };
  return { db, input, now };
}

test("managed coverage maps a mechanism gap once and retains user-updated status on replay", async () => {
  const { db, input, now } = fixture();
  let calls = 0;
  let dispatches = 0;
  const modelClient: StructuredModelClient = {
    async structuredCompletion(request) {
      calls += 1;
      expect(request.repairPolicy).toBe("disabled");
      expect(request.workOrder.instruction).toContain("mechanism gap is a workflow gap");
      expect(request.workOrder.instruction?.split(loadWritingGuidance())).toHaveLength(2);
      request.onDispatched?.();
      const output = request.schema.parse({
        gaps: [{ name: "Approval route", description: "A different signoff mechanism for repair estimates.",
          dimension: "workflow", evidenceNeeded: null, searchQuery: null,
          mapExhausted: true, candidateOrigin: "evidence-only" }],
        noUsefulGapReason: null,
      });
      return { output, metadata: { model: request.model, usage: { status: "unknown" },
        latencyMs: 1, repairCount: 0, providerRequestIds: [], attempts: [] } };
    },
  };
  try {
    const first = await runManagedCoverageMap({ ...input, modelClient, onDispatched: () => { dispatches += 1; } });
    expect(first).toMatchObject({ replayed: false, gaps: [{ name: "Approval route", status: "ready" }] });
    expect(first.gaps[0]!.id).toBe(`${first.attemptId}:gap:1`);
    expect(new OpportunityExplorationRepository(db).find("thread")).toBeNull();
    expect(db.db.prepare("SELECT session_id, work_item_id, status FROM opportunity_exploration_attempts WHERE id = ?")
      .get(first.attemptId)).toEqual({ session_id: "session", work_item_id: "coverage-item", status: "completed" });
    expect(dispatches).toBe(1);

    db.db.prepare(`INSERT INTO research_runs (id,thread_id,status,config_json,created_at,updated_at)
      VALUES ('later-run','thread','completed','{}',?,?)`).run(now, now);
    db.db.prepare(`INSERT INTO problems (id,discovery_run_id,statement,why_it_persists,affected,scale_estimate,
      verdict,verdict_reason,verdict_source_ids_json,created_at)
      VALUES ('later-problem','later-run','Another approval problem','','Shops','','confirmed','','[]',?)`).run(now);
    db.immediateTransaction(() => markManagedCoverageGapCovered(db, "thread", "session", first.gaps[0]!.id));
    const futureBundle = mkdtempSync(join(tmpdir(), "scraply-future-coverage-writing-"));
    directories.push(futureBundle);
    writeFileSync(join(futureBundle, "writing-guidance.md"), "Future writing rules.");
    configurePromptPaths({ bundledDir: futureBundle, overrideDir: null });
    const replayed = await runManagedCoverageMap({ ...input, onDispatched: () => { dispatches += 1; } });
    expect(replayed).toMatchObject({ attemptId: first.attemptId, replayed: true,
      gaps: [{ id: first.gaps[0]!.id, status: "covered" }] });
    expect(loadManagedCoverageGaps(db, "thread", "session")).toHaveLength(1);
    expect(calls).toBe(1);
    expect(dispatches).toBe(1);
  } finally { db.close(); }
});

test("a dispatched managed map with unknown completion cannot call the model again", async () => {
  const { db, input } = fixture();
  let calls = 0;
  const modelClient: StructuredModelClient = {
    async structuredCompletion(request) {
      calls += 1;
      request.onDispatched?.();
      throw new Error("transport closed after dispatch");
    },
  };
  try {
    await expect(runManagedCoverageMap({ ...input, modelClient })).rejects.toThrow("transport closed after dispatch");
    expect(db.db.prepare("SELECT status FROM opportunity_exploration_attempts WHERE session_id = 'session'").get())
      .toEqual({ status: "unknown-dispatch" });
    await expect(runManagedCoverageMap({ ...input, modelClient })).rejects.toThrow("will not be replayed automatically");
    expect(calls).toBe(1);
  } finally { db.close(); }
});

test.each(["legacy-prepared", "legacy-completed", "guided-prepared", "guided-completed"] as const)(
  "managed coverage resumes a saved %s attempt without repeating completed work", async kind => {
    const { db, input } = fixture();
    const repository = new OpportunityExplorationRepository(db);
    const writingGuidance = kind.startsWith("guided") ? "Writing rules saved before the bundle changed." : "";
    const instruction = "Name concrete gaps in the saved startup inventory. A mechanism gap is a workflow gap with a specific different operating method. Name a new buyer or workflow only when the existing problem map is exhausted. Ask for one bounded search query when evidence is required. Return no gap rather than generic 'more ideas'. Exploratory hypotheses are allowed only when the project flag says so."
      + (writingGuidance ? `\n\n${writingGuidance}` : "");
    const output = { gaps: [], noUsefulGapReason: "The saved inventory covers the current scope." };
    const attempt = db.immediateTransaction(() => repository.prepareAttempt("thread", {
      stageKey: "coverage-map:0", stageName: "coverage-map",
      input: { round: 0, explorationConfig: input.explorationConfig, context: { saved: "inventory" },
        ...(writingGuidance ? { writingGuidance } : {}) },
      model: { ...input.model, reasoningEffort: input.reasoningEffort },
      promptVersion: "opportunity-coverage-managed-v1", promptText: instruction, workItemId: input.workItemId,
    }, input.sessionId));
    if (attempt.kind !== "prepared") throw new Error("Fixture attempt was not prepared");
    const completed = kind.endsWith("completed");
    if (completed) db.immediateTransaction(() => {
      repository.markAttemptDispatched("thread", attempt.attemptId, "none", input.sessionId);
      repository.completeAttempt("thread", attempt.attemptId, output, input.sessionId);
    });
    let calls = 0;
    const modelClient: StructuredModelClient = { async structuredCompletion(request) {
      calls += 1;
      if (completed) throw new Error("Completed map must not dispatch again");
      expect(request.workOrder.instruction).toBe(instruction);
      expect(request.evidence[0]?.content).toEqual({ saved: "inventory" });
      request.onDispatched?.();
      return { output: request.schema.parse(output), metadata: { model: request.model, usage: { status: "unknown" },
        latencyMs: 1, repairCount: 0, providerRequestIds: [], attempts: [] } };
    } };
    try {
      const resumed = await runManagedCoverageMap({ ...input, modelClient });
      expect(resumed).toMatchObject({ attemptId: attempt.attemptId, replayed: completed, gaps: [],
        noUsefulGapReason: output.noUsefulGapReason });
      expect(calls).toBe(completed ? 0 : 1);
      expect(repository.loadAttempt("thread", "coverage-map:0", input.sessionId)?.promptText).toBe(instruction);
    } finally { db.close(); }
  },
);
