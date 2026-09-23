import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseClient } from "../../src/db/client";
import { WorkflowConflictError, WorkflowRepository } from "../../src/db/repositories/workflows";
import { materializeResearchSnapshot } from "../../src/core/research-revisions";

const directories: string[] = [];
const now = "2026-09-23T12:00:00.000Z";

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup(): { client: DatabaseClient; workflows: WorkflowRepository } {
  const directory = mkdtempSync(join(tmpdir(), "scraply-workflows-"));
  directories.push(directory);
  const client = new DatabaseClient(join(directory, "scraply.db"));
  client.db.prepare(`
    INSERT INTO threads (id, title, status, created_at, updated_at)
    VALUES ('project-a', 'A', 'configuring', ?, ?), ('project-b', 'B', 'configuring', ?, ?)
  `).run(now, now, now, now);
  return { client, workflows: new WorkflowRepository(client) };
}

function addRun(client: DatabaseClient, id: string, threadId: string, options: {
  sessionId?: string; problemId?: string; purpose?: string;
} = {}): void {
  client.db.prepare(`
    INSERT INTO research_runs (id, thread_id, status, config_json, created_at, updated_at,
      workflow_version, workflow_session_id, problem_id, purpose)
    VALUES (?, ?, 'completed', '{}', ?, ?, 2, ?, ?, ?)
  `).run(id, threadId, now, now, options.sessionId ?? null,
    options.problemId ?? null, options.purpose ?? null);
}

function addProblem(client: DatabaseClient, id: string, runId: string): void {
  client.db.prepare(`
    INSERT INTO problems (id, discovery_run_id, statement, why_it_persists, affected,
      scale_estimate, verdict, verdict_reason, verdict_source_ids_json, created_at)
    VALUES (?, ?, 'Saved problem', '', '', '', 'user-asserted', '', '[]', ?)
  `).run(id, runId, now);
}

function addSolution(client: DatabaseClient, id: string, problemId: string, runId: string): void {
  client.db.prepare(`
    INSERT INTO solutions (id, problem_id, mechanism, description, respects_off_limits,
      respects_off_limits_why, research_run_id, created_at)
    VALUES (?, ?, 'Mechanism', 'Description', 1, 'Yes', ?, ?)
  `).run(id, problemId, runId, now);
}

describe("workflow persistence", () => {
  test("admission receipts and revision updates are atomic and immutable", () => {
    const { client, workflows } = setup();
    const session = client.immediateTransaction(() => workflows.createSession({
      id: "session-a", threadId: "project-a", purpose: "discovery", mode: "babysit",
      contract: { contractVersion: 1, brief: "Build this" }, remainingMs: 60_000,
    }));
    expect(session.revision).toBe(0);
    expect(() => client.immediateTransaction(() => workflows.createSession({
      id: "session-b", threadId: "project-a", purpose: "discovery", mode: "vibe",
      contract: {}, remainingMs: 1,
    }))).toThrow();
    const first = client.immediateTransaction(() => workflows.recordCommand({
      threadId: "project-a", sessionId: session.id, clientCommandId: "command-1",
      payload: { type: "start" }, result: { sessionId: session.id },
    }));
    expect(first.created).toBe(true);
    expect(client.immediateTransaction(() => workflows.recordCommand({
      threadId: "project-a", sessionId: session.id, clientCommandId: "command-1",
      payload: { type: "start" }, result: { different: true },
    })).created).toBe(false);
    expect(() => client.immediateTransaction(() => workflows.recordCommand({
      threadId: "project-a", sessionId: session.id, clientCommandId: "command-1",
      payload: { type: "stop" }, result: {},
    }))).toThrow(WorkflowConflictError);
    const waiting = client.immediateTransaction(() => workflows.updateSession(session.id, 0, {
      state: "waiting-for-review", remainingMs: 50_000,
    }));
    expect(waiting.runningSince).toBeNull();
    expect(waiting.revision).toBe(1);
    const extended = client.immediateTransaction(() => workflows.extendLimits(session.id, 1, {
      modelCalls: 2, searches: 1, minutes: 1,
    }));
    expect(extended.revision).toBe(2);
    expect(extended.remainingMs).toBe(110_000);
    expect(extended.additionalModelCalls).toBe(2);
    expect(() => client.immediateTransaction(() => workflows.updateSession(session.id, 0, {
      state: "paused",
    }))).toThrow(WorkflowConflictError);
    expect(() => client.db.prepare("UPDATE workflow_sessions SET contract_json = '{}' WHERE id = ?")
      .run(session.id)).toThrow();
    expect(client.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    client.close();
  });

  test("work dependencies and unknown completion retain the full reservation", () => {
    const { client, workflows } = setup();
    client.immediateTransaction(() => {
      workflows.createSession({ id: "session-a", threadId: "project-a", purpose: "discovery",
        mode: "vibe", contract: {}, remainingMs: 60_000 });
      const parent = workflows.createWorkItem({ id: "parent", sessionId: "session-a",
        kind: "research-request", scopeKey: "research:1", input: { question: "Why?" } });
      const child = workflows.createWorkItem({ id: "child", sessionId: "session-a",
        parentItemId: parent.id, kind: "search", scopeKey: "search:1",
        dependencies: [parent.id], input: { query: "Example" } });
      expect(() => workflows.updateWorkItem(child.id, "ready")).toThrow();
      workflows.updateWorkItem(parent.id, "ready");
      workflows.updateWorkItem(parent.id, "running");
      workflows.updateWorkItem(parent.id, "succeeded", { outputRefs: { runId: "saved-run" } });
      workflows.updateWorkItem(child.id, "ready");
      const budget = workflows.reserveBudget({ sessionId: "session-a", workItemId: child.id,
        operationKey: "search:1", kind: "search", reservedUnits: 2 });
      expect(() => workflows.settleBudget(budget.id, { state: "uncertain", settledUnits: 1 })).toThrow();
      workflows.settleBudget(budget.id, { state: "uncertain", settledUnits: 2 });
      expect(workflows.getBudgetTotals("session-a").searches.uncertain).toBe(2);
      expect(() => workflows.settleBudget(budget.id, { state: "spent", settledUnits: 1 })).toThrow();
    });
    expect(client.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    client.close();
  });

  test("snapshot creation checks project and origin hashes, then freezes selection", () => {
    const { client, workflows } = setup();
    client.immediateTransaction(() => {
      workflows.createSession({ id: "session-a", threadId: "project-a", purpose: "discovery",
        mode: "babysit", contract: {}, remainingMs: 60_000 });
      addRun(client, "original", "project-a");
      client.db.prepare(`
        INSERT INTO scopes (id, research_run_id, title, audience, domain,
          observations, off_limits_json, risk_evaluation_criteria, created_at, updated_at)
        VALUES ('scope', 'original', 'Scope', 'Audience', 'Domain', '', '[]', '', ?, ?)
      `).run(now, now);
      addProblem(client, "problem-original", "original");
      const materialized = materializeResearchSnapshot(client, {
        threadId: "project-a", baseRunId: "original",
        sourceProblemIds: ["problem-original"], sessionId: "session-a", runId: "materialized",
      });
      const copiedProblemId = materialized.problemIds[0]!;
      const snapshot = workflows.createSnapshot({ id: "snapshot-a", sessionId: "session-a",
        materializationRunId: materialized.runId, selection: { problemIds: materialized.problemIds },
        originMap: materialized.originMap });
      expect(snapshot.originMap.problems[copiedProblemId]?.originalId).toBe("problem-original");
      expect(() => workflows.createSnapshot({ sessionId: "session-a", materializationRunId: "materialized",
        selection: { problemIds: ["problem-original"] }, originMap: materialized.originMap })).toThrow(WorkflowConflictError);
      expect(() => client.db.prepare("UPDATE evidence_snapshots SET selection_json = '[]' WHERE id = ?")
        .run(snapshot.id)).toThrow();
      workflows.updateSession("session-a", 0, {
        state: "finished", outcome: "partial", activeSnapshotId: snapshot.id,
      });
      workflows.createSession({ id: "session-b", threadId: "project-a", purpose: "research-followup",
        mode: "babysit", contract: {}, remainingMs: 60_000 });
      const continued = materializeResearchSnapshot(client, {
        threadId: "project-a", baseRunId: materialized.runId,
        sourceProblemIds: [copiedProblemId], sessionId: "session-b", runId: "materialized-again",
      });
      const child = workflows.createSnapshot({ id: "snapshot-b", sessionId: "session-b",
        parentSnapshotId: snapshot.id, materializationRunId: continued.runId,
        selection: { problemIds: continued.problemIds }, originMap: continued.originMap });
      expect(child.parentSnapshotId).toBe(snapshot.id);
      workflows.deleteProjectMetadata("project-a");
      expect(workflows.getSnapshot(snapshot.id)).toBeNull();
      expect(workflows.getSnapshot(child.id)).toBeNull();
    });
    expect(client.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    client.close();
  });

  test("idea turns and versions preserve their root and selected version", () => {
    const { client, workflows } = setup();
    client.immediateTransaction(() => {
      workflows.createSession({ id: "session-a", threadId: "project-a", purpose: "idea-turn",
        mode: "babysit", contract: {}, remainingMs: 60_000 });
      addRun(client, "discovery", "project-a");
      addProblem(client, "problem-a", "discovery");
      addRun(client, "development", "project-a", { sessionId: "session-a", problemId: "problem-a" });
      addSolution(client, "root", "problem-a", "development");
      workflows.createSolutionLineage({ solutionId: "root", rootSolutionId: "root", changeSummary: "Original" });
      const turn = workflows.createIdeaTurn({ id: "turn-a", rootSolutionId: "root", branchId: "branch-a",
        baseSolutionId: "root", sessionId: "session-a", clientMessageId: "message-a",
        intent: "rethink", userText: "Change the audience", context: { model: "test" } });
      addSolution(client, "version-2", "problem-a", "development");
      const lineage = workflows.createSolutionLineage({ solutionId: "version-2", rootSolutionId: "root",
        parentSolutionId: "root", turnId: turn.id, changeSummary: "New audience" });
      expect(lineage.versionNumber).toBe(2);
      workflows.completeIdeaTurn(turn.id, { state: "completed", assistant: { reply: "Here is the revision" },
        generatedSolutionId: "version-2" });
      workflows.setSelectedVersion("root", "version-2");
      expect(workflows.getSelectedVersion("root")).toBe("version-2");
      expect(workflows.listIdeaTurns("root", undefined, turn.id)).toEqual([]);
      expect(workflows.listSolutionVersions("root").map((item) => item.solutionId)).toEqual(["root", "version-2"]);
      expect(() => workflows.completeIdeaTurn(turn.id, { state: "completed", assistant: {} })).toThrow();
      workflows.deleteProjectMetadata("project-a");
      expect(workflows.getSession("session-a")).toBeNull();
      expect(workflows.getIdeaTurn("turn-a")).toBeNull();
      expect(workflows.listSolutionVersions("root")).toEqual([]);
    });
    expect(client.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    client.close();
  });

  test("opportunity work uses session-scoped gap names, batch ordinals, and stage keys", () => {
    const { client, workflows } = setup();
    client.immediateTransaction(() => {
      workflows.createSession({ id: "session-a", threadId: "project-a", purpose: "discovery",
        mode: "vibe", contract: {}, remainingMs: 60_000 });
      workflows.updateSession("session-a", 0, { state: "finished", outcome: "partial" });
      workflows.createSession({ id: "session-b", threadId: "project-a", purpose: "discovery",
        mode: "vibe", contract: {}, remainingMs: 60_000 });
      client.db.prepare(`
        INSERT INTO opportunity_explorations (thread_id, config_json, status, started_at, updated_at)
        VALUES ('project-a', '{}', 'mapping-coverage', ?, ?)
      `).run(now, now);
      const gap = client.db.prepare(`
        INSERT INTO opportunity_coverage_gaps (
          id, thread_id, session_id, name, description, dimension,
          map_exhausted, candidate_origin, status, created_at, updated_at
        ) VALUES (?, 'project-a', ?, 'Buyer gap', '', 'buyer', 0, 'evidence-only', 'named', ?, ?)
      `);
      gap.run("gap-a", "session-a", now, now);
      gap.run("gap-b", "session-b", now, now);
      expect(() => gap.run("gap-duplicate", "session-b", now, now)).toThrow();
      const batch = client.db.prepare(`
        INSERT INTO opportunity_exploration_batches (
          id, thread_id, session_id, ordinal, requested_candidates,
          status, accepted_families_before, created_at, updated_at
        ) VALUES (?, 'project-a', ?, 1, 1, 'planned', 0, ?, ?)
      `);
      batch.run("batch-a", "session-a", now, now);
      batch.run("batch-b", "session-b", now, now);
      expect(() => batch.run("batch-duplicate", "session-b", now, now)).toThrow();
      const attempt = client.db.prepare(`
        INSERT INTO opportunity_exploration_attempts (
          id, thread_id, session_id, stage_key, stage_name, status,
          input_json, model_json, prompt_version, prompt_text, prepared_at, updated_at
        ) VALUES (?, 'project-a', ?, 'review:1', 'review', 'prepared', '{}', '{}', '1', '', ?, ?)
      `);
      attempt.run("attempt-a", "session-a", now, now);
      attempt.run("attempt-b", "session-b", now, now);
      expect(() => attempt.run("attempt-duplicate", "session-b", now, now)).toThrow();
    });
    expect(client.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    client.close();
  });
});
