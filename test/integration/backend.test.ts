import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBackend, type BackendHandle } from "../../src/backend/server";
import { DatabaseClient } from "../../src/db/client";

const dirs: string[] = [];
const handles: BackendHandle[] = [];
const modelOption = (id: string) => ({
  id,
  displayName: id,
  defaultReasoningEffort: "medium",
  reasoningEfforts: [{ id: "medium", description: "Balanced reasoning" }],
});
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  for (const dir of dirs.splice(0)) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { rmSync(dir, { recursive: true, force: true }); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1))); }
    }
  }
});

describe("cutover backend", () => {
  test("creates a configuring thread and persists the five-field scope", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-backend-")); dirs.push(dir);
    const handle = await startBackend({
      dataDir: dir, dbPath: join(dir, "scraply.db"), bundledPromptsDir: join(process.cwd(), "prompts"),
      promptOverridesDir: join(dir, "prompts"), appVersion: "test", getSecrets: () => ({ exaApiKey: "test-key" }),
      providerValidation: { probeCodex: async () => ({ detected: true, compatible: true }), listCodexModels: async () => [modelOption("gpt-5.6-luna"), modelOption("gpt-test")], validateExa: async () => ({ valid: true }) },
    }, () => undefined); handles.push(handle);

    const post = async (path: string, body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${handle.port}${path}`, { method: "POST", headers: { authorization: `Bearer ${handle.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      return (await response.json() as { data: unknown }).data;
    };
    const created = await post("/threads", {}) as {
      thread: { id: string; status: string };
      workspace: { models: string[]; runConfig: { model: string } };
    };
    expect(created.thread.status).toBe("configuring");
    expect(created.workspace.models).toEqual(["gpt-5.6-luna", "gpt-test"]);
    expect(created.workspace.runConfig.model).toBe("gpt-5.6-luna");
    const workspace = await post("/scope", { threadId: created.thread.id, scope: { title: "Repair shops", audience: "Independent shops", domain: "Parts sourcing", observations: "", offLimits: ["Inventory"] } }) as { scope: { title: string; audience: string; domain: string; observations: string; offLimits: string[] } };
    expect(workspace.scope).toEqual({ title: "Repair shops", audience: "Independent shops", domain: "Parts sourcing", observations: "", offLimits: ["Inventory"] });
  });

  test("shows and exports solutions only for selected problems in the latest discovery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-backend-")); dirs.push(dir);
    const dbPath = join(dir, "scraply.db");
    const handle = await startBackend({
      dataDir: dir, dbPath, bundledPromptsDir: join(process.cwd(), "prompts"), promptOverridesDir: join(dir, "prompts"),
      appVersion: "test", getSecrets: () => ({ exaApiKey: "test-key" }),
      providerValidation: { probeCodex: async () => ({ detected: true, compatible: true }), listCodexModels: async () => [modelOption("gpt-test")], validateExa: async () => ({ valid: true }) },
    }, () => undefined); handles.push(handle);
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${handle.port}${path}`, { method: "POST", headers: { authorization: `Bearer ${handle.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      expect(response.status).toBe(200);
      return (await response.json() as { data: unknown }).data;
    };
    const created = await post("/threads", {}) as { thread: { id: string } };
    const client = new DatabaseClient(dbPath);
    const now = "2026-01-01T00:00:00.000Z";
    const insertRun = client.db.prepare(`
      INSERT INTO research_runs (id, thread_id, status, config_json, problem_id, created_at, updated_at)
      VALUES (?, ?, 'completed', '{}', ?, ?, ?)
    `);
    const insertProblem = client.db.prepare(`
      INSERT INTO problems (id, discovery_run_id, statement, why_it_persists, affected, scale_estimate, verdict,
        verdict_reason, verdict_source_ids_json, selected_at, created_at)
      VALUES (?, ?, ?, '', '', '', 'confirmed', '', '[]', ?, ?)
    `);
    const insertSolution = client.db.prepare(`
      INSERT INTO solutions (id, problem_id, mechanism, description, respects_off_limits, respects_off_limits_why, created_at, research_run_id)
      VALUES (?, ?, ?, '', 1, '', ?, ?)
    `);
    insertRun.run("discovery-old", created.thread.id, null, "2026-01-01T00:00:01.000Z", now);
    insertProblem.run("problem-old", "discovery-old", "Superseded problem", now, now);
    insertRun.run("development-old", created.thread.id, "problem-old", "2026-01-01T00:00:02.000Z", now);
    insertSolution.run("solution-old", "problem-old", "Superseded solution", now, "development-old");
    insertRun.run("discovery-latest", created.thread.id, null, "2026-01-01T00:00:03.000Z", now);
    insertProblem.run("problem-selected", "discovery-latest", "Selected problem", now, now);
    insertProblem.run("problem-deselected", "discovery-latest", "Deselected problem", null, now);
    insertRun.run("development-selected", created.thread.id, "problem-selected", "2026-01-01T00:00:04.000Z", now);
    insertRun.run("development-deselected", created.thread.id, "problem-deselected", "2026-01-01T00:00:05.000Z", now);
    insertSolution.run("solution-selected", "problem-selected", "Current solution", now, "development-selected");
    insertSolution.run("solution-deselected", "problem-deselected", "Deselected solution", now, "development-deselected");
    client.close();

    const workspaceResponse = await fetch(`http://127.0.0.1:${handle.port}/workspace`, { headers: { authorization: `Bearer ${handle.token}` } });
    expect(workspaceResponse.status).toBe(200);
    const workspace = (await workspaceResponse.json() as { data: { solutions: Array<{ id: string }> } }).data;
    expect(workspace.solutions.map((solution) => solution.id)).toEqual(["solution-selected"]);
    const exported = await post("/ideas/export", { threadId: created.thread.id, format: "json" }) as { files: Array<{ filename: string; content: string }> };
    expect(exported.files).toHaveLength(1);
    expect(JSON.parse(exported.files[0]!.content).map((solution: { id: string }) => solution.id)).toEqual(["solution-selected"]);
  });

  test("cancels and deletes stale runs without provider credentials", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-backend-")); dirs.push(dir);
    const dbPath = join(dir, "scraply.db");
    const events: Array<{ type: string; runId?: string }> = [];
    const handle = await startBackend({
      dataDir: dir, dbPath, bundledPromptsDir: join(process.cwd(), "prompts"), promptOverridesDir: join(dir, "prompts"),
      appVersion: "test", getSecrets: () => ({ exaApiKey: null }),
      providerValidation: { probeCodex: async () => ({ detected: false, compatible: false }), listCodexModels: async () => [] },
    }, (event) => events.push(event)); handles.push(handle);
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${handle.port}${path}`, { method: "POST", headers: { authorization: `Bearer ${handle.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      expect(response.status).toBe(200);
      return (await response.json() as { data: unknown }).data;
    };
    const cancellable = await post("/threads", { title: "Cancel me" }) as { thread: { id: string } };
    const deletable = await post("/threads", { title: "Delete me" }) as { thread: { id: string } };
    const client = new DatabaseClient(dbPath);
    const insertRun = client.db.prepare(`
      INSERT INTO research_runs (id, thread_id, status, config_json, created_at, updated_at)
      VALUES (?, ?, 'running', '{}', ?, ?)
    `);
    const now = new Date().toISOString();
    insertRun.run("stale-cancel", cancellable.thread.id, now, now);
    insertRun.run("stale-delete", deletable.thread.id, now, now);
    client.close();

    await post("/research/cancel", { runId: "stale-cancel" });
    const verification = new DatabaseClient(dbPath);
    expect(verification.db.prepare("SELECT status, cancelled FROM research_runs WHERE id = ?").get("stale-cancel"))
      .toEqual({ status: "cancelled", cancelled: 1 });
    verification.close();
    await post("/threads/delete", { threadId: deletable.thread.id });
    const deleted = new DatabaseClient(dbPath);
    expect(deleted.db.prepare("SELECT 1 FROM threads WHERE id = ?").get(deletable.thread.id)).toBeNull();
    expect(deleted.db.prepare("SELECT 1 FROM research_runs WHERE id = ?").get("stale-delete")).toBeNull();
    deleted.close();
    expect(events.filter((event) => event.type === "run-cancelled").map((event) => event.runId)).toEqual(["stale-cancel", "stale-delete"]);
  });
});
