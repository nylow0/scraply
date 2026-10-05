import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBackend, type BackendHandle } from "../../src/backend/server";
import { DatabaseClient } from "../../src/db/client";
import { ThreadRepository } from "../../src/db/repositories/threads";
import { WorkflowRepository } from "../../src/db/repositories/workflows";
import { WorkspaceStateSchema } from "../../src/shared/ipc";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";

const handles: BackendHandle[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("saved ranked writer quotas and counts survive newer settings and reload, including zero and legacy runs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scraply-idea-groups-"));
  directories.push(directory);
  const dbPath = join(directory, "test.db");
  const context = {
    dataDir: directory, dbPath, bundledPromptsDir: join(process.cwd(), "prompts"), promptOverridesDir: join(directory, "prompts"),
    appVersion: "test", getSecrets: () => ({ exaApiKey: null }),
    providerValidation: { inspectNative: async () => ({ available: false, connected: false, accounts: [], models: [] }) },
  };
  const handle = await startBackend(context, () => undefined);
  handles.push(handle);
  const created = await fetch(`http://127.0.0.1:${handle.port}/threads`, { method: "POST",
    headers: { authorization: `Bearer ${handle.token}`, "content-type": "application/json" }, body: "{}" });
  expect(created.status).toBe(200);
  const { data } = await created.json() as { data: { thread: { id: string } } };
  const client = new DatabaseClient(dbPath);
  const workflows = new WorkflowRepository(client);
  const now = "2026-09-23T12:00:00.000Z";
  const savedConfig = { ...DEFAULT_RUN_CONFIG, workflowVersion: 2 as const, ideaCount: 5 };
  const scope = { title: "Approvals", audience: "Shop owners", domain: "Parts purchasing", observations: "", offLimits: [] };
  client.db.prepare(`INSERT INTO research_runs (id, thread_id, status, config_json, workflow_version, created_at, updated_at)
    VALUES ('evidence', ?, 'completed', ?, 2, ?, ?)`).run(data.thread.id, JSON.stringify(savedConfig), now, now);
  const seedSession = (id: string, groups: Array<{ problemId: string; requested: number; returned: number; ranked: boolean; failed?: boolean }>) => {
    client.immediateTransaction(() => {
      const session = workflows.createSession({ id, threadId: data.thread.id, purpose: "discovery", mode: "babysit", remainingMs: 60_000,
        startedAt: now, contract: { contractVersion: 1, ideaWorkflowVersion: 2, purpose: "discovery", mode: "babysit", brief: "Inspect approval delays", scope,
          runConfig: savedConfig, targets: { kind: "per-problem", ideaCount: 5 }, limits: { enforced: false, maxMinutes: 30, maxModelCalls: 40, maxSearches: 0 },
          instructions: {}, resolvedInstructions: { research: "", ideas: "", review: "" }, instructionHashes: { research: "r", ideas: "i", review: "v" } } });
      for (const [ordinal, group] of groups.entries()) {
        const runId = `run-${group.problemId}`;
        client.db.prepare(`INSERT INTO problems (id, discovery_run_id, statement, why_it_persists, affected, scale_estimate, verdict,
          verdict_reason, verdict_source_ids_json, created_at) VALUES (?, 'evidence', ?, '', '', '', 'confirmed', '', '[]', ?)`)
          .run(group.problemId, `Problem ${group.problemId}`, now);
        client.db.prepare(`INSERT INTO research_runs (id, thread_id, problem_id, status, config_json, workflow_version, workflow_session_id, created_at, updated_at)
          VALUES (?, ?, ?, 'completed', ?, 2, ?, ?, ?)`).run(runId, data.thread.id, group.problemId,
            JSON.stringify({ ...savedConfig, ideaCount: group.requested }), id, now, now);
        const task = workflows.createWorkItem({ sessionId: id, kind: "generate-ideas", scopeKey: group.problemId, ordinal, state: "ready",
          input: { problemId: group.problemId, quota: group.requested, ...(group.ranked ? { ranked: true } : {}) } });
        workflows.updateWorkItem(task.id, "running");
        const ideaIds = Array.from({ length: group.returned }, (_, index) => `${group.problemId}-idea-${index + 1}`);
        for (const [index, ideaId] of ideaIds.entries()) {
          client.db.prepare(`INSERT INTO solutions (id, problem_id, research_run_id, mechanism, description, respects_off_limits,
            respects_off_limits_why, rank, created_at) VALUES (?, ?, ?, 'Compare records', ?, 1, '', ?, ?)`)
            .run(ideaId, group.problemId, runId, `Saved idea ${index + 1}`, group.ranked ? index + 1 : null, now);
        }
        workflows.updateWorkItem(task.id, group.failed ? "failed" : "succeeded", {
          outputRefs: { runId, solutionIds: ideaIds, proposedSolutionIds: ideaIds },
        });
      }
      workflows.updateSession(session.id, session.revision, { state: "finished", outcome: "partial", runningSince: null });
    });
  };
  seedSession("old-ranked", [{ problemId: "historical", requested: 2, returned: 1, ranked: true }]);
  seedSession("latest-ranked", [
    { problemId: "complete", requested: 3, returned: 3, ranked: true },
    { problemId: "short", requested: 3, returned: 2, ranked: true },
    { problemId: "zero", requested: 3, returned: 0, ranked: true },
    { problemId: "legacy", requested: 5, returned: 1, ranked: false },
    { problemId: "failed", requested: 3, returned: 0, ranked: true, failed: true },
  ]);
  new ThreadRepository(client).saveRunConfig(data.thread.id, { ...savedConfig, ideaCount: 1 });
  client.close();

  const readWorkspace = async (backend: BackendHandle) => {
    const response = await fetch(`http://127.0.0.1:${backend.port}/workspace`, { headers: { authorization: `Bearer ${backend.token}` } });
    expect(response.status).toBe(200);
    const result = await response.json() as { data: unknown };
    return WorkspaceStateSchema.parse(result.data);
  };
  const workspace = await readWorkspace(handle);
  expect(workspace.runConfig?.ideaCount).toBe(1);
  expect(workspace.ideaGroups).toEqual([
    { runId: "run-historical", problemId: "historical", problemStatement: "Problem historical", requestedIdeaCount: 2, returnedIdeaCount: 1 },
    { runId: "run-complete", problemId: "complete", problemStatement: "Problem complete", requestedIdeaCount: 3, returnedIdeaCount: 3 },
    { runId: "run-short", problemId: "short", problemStatement: "Problem short", requestedIdeaCount: 3, returnedIdeaCount: 2 },
    { runId: "run-zero", problemId: "zero", problemStatement: "Problem zero", requestedIdeaCount: 3, returnedIdeaCount: 0 },
  ]);
  expect(workspace.solutions).toHaveLength(7);
  expect(workspace.solutions.filter((idea) => idea.problemId === "zero")).toHaveLength(0);
  expect(workspace.solutions.find((idea) => idea.problemId === "legacy")).toBeDefined();
  await handle.close();
  handles.splice(handles.indexOf(handle), 1);
  const reopened = await startBackend(context, () => undefined);
  handles.push(reopened);
  const reloaded = await readWorkspace(reopened);
  expect(reloaded.ideaGroups).toEqual(workspace.ideaGroups);
  expect(reloaded.solutions.map((idea) => idea.id)).toEqual(workspace.solutions.map((idea) => idea.id));
});
