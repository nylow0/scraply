import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseClient } from "../../src/db/client";
import { ThreadRepository } from "../../src/db/repositories/threads";
import { createBackendClients, isSetupComplete, startBackend } from "../../src/backend/server";
import type { BranchContext, ProjectBrief } from "../../src/shared/schemas";

const tempDirs: string[] = [];

function backendContext(dir: string) {
  return {
    dataDir: dir,
    dbPath: join(dir, "scraply.db"),
    bundledPromptsDir: join(process.cwd(), "prompts"),
    promptOverridesDir: join(dir, "prompts"),
    getSecrets: () => ({ opencodeApiKey: null, exaApiKey: null }),
  };
}

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  while (tempDirs.length) {
    try {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    } catch {
      // Windows may keep WAL files locked briefly
    }
  }
});

describe("SQLite persistence", () => {
  test("survives restart with thread and meta probe", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-db-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "scraply.db");

    const db1 = new DatabaseClient(dbPath);
    db1.setMeta("persistence_probe", "phase0");
    const threads1 = new ThreadRepository(db1);
    const thread = threads1.createThread("Restart test");
    threads1.saveIntakeAnswer(thread.id, "goal", "Build a desktop research studio");
    db1.close();

    const db2 = new DatabaseClient(dbPath);
    expect(db2.getMeta("persistence_probe")).toBe("phase0");
    const threads2 = new ThreadRepository(db2);
    expect(threads2.listThreads()).toHaveLength(1);
    expect(threads2.getIntakeAnswers(thread.id)[0]?.answer).toContain("desktop research studio");
    db2.close();
  });
});

describe("Backend health", () => {
  test("constructs a Codex model client without an OpenCode credential", () => {
    const clients = createBackendClients({ opencodeApiKey: null, exaApiKey: "exa-test" });
    expect(clients.codex).toBeDefined();
    expect(clients.opencode).toBeUndefined();
    expect(clients.exa).toBeDefined();
    expect(isSetupComplete({ valid: true }, { detected: true, compatible: true })).toBe(true);
  });

  test("marks Exa plus compatible Codex as setup-complete without validating OpenCode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-backend-"));
    tempDirs.push(dir);
    let openCodeValidations = 0;
    const context = {
      ...backendContext(dir),
      getSecrets: () => ({ opencodeApiKey: null, exaApiKey: "exa-test" }),
      providerValidation: {
        probeCodex: async () => ({ detected: true, compatible: true, version: "test" }),
        listCodexModels: async () => ["gpt-5.6-luna"],
        validateExa: async () => ({ valid: true }),
        validateOpenCode: async () => {
          openCodeValidations += 1;
          return { valid: true, models: ["optional-model"] };
        },
      },
    };
    const handle = await startBackend(context, () => {});

    try {
      const response = await fetch(`http://127.0.0.1:${handle.port}/validation`, {
        headers: { authorization: `Bearer ${handle.token}` },
      });
      const body = await response.json() as {
        ok: true;
        data: { setupComplete: boolean; opencode: { valid: boolean }; exa: { valid: boolean }; codex: { compatible: boolean } };
      };
      expect(body.data.setupComplete).toBe(true);
      expect(body.data.exa.valid).toBe(true);
      expect(body.data.codex.compatible).toBe(true);
      expect(body.data.opencode.valid).toBe(false);
      expect(openCodeValidations).toBe(0);
    } finally {
      await handle.close();
    }
  });

  test("starts on localhost with bearer auth", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-backend-"));
    tempDirs.push(dir);
    const handle = await startBackend(backendContext(dir), () => {});

    try {
      const unauthorized = await fetch(`http://127.0.0.1:${handle.port}/health`);
      expect(unauthorized.status).toBe(401);
      expect(await unauthorized.json()).toEqual({
        ok: false,
        error: { code: "unauthorized", message: "The request is not authorized." },
      });

      const health = await fetch(`http://127.0.0.1:${handle.port}/health`, {
        headers: { authorization: `Bearer ${handle.token}` },
      });
      expect(health.ok).toBe(true);
      const body = await health.json() as { ok: true; data: { ok: boolean; persistenceCheck: string } };
      expect(body.ok).toBe(true);
      expect(body.data.ok).toBe(true);
      expect(body.data.persistenceCheck).toStartWith("ok-");
    } finally {
      await handle.close();
    }
  });

  test("persists favorite models in workspace state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-backend-"));
    tempDirs.push(dir);
    const handle = await startBackend(backendContext(dir), () => {});

    try {
      const save = await fetch(`http://127.0.0.1:${handle.port}/models/favorite`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${handle.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: { provider: "codex", id: "gpt-5.5" }, favorite: true }),
      });
      expect(save.ok).toBe(true);

      const workspace = await fetch(`http://127.0.0.1:${handle.port}/workspace`, {
        headers: { authorization: `Bearer ${handle.token}` },
      });
      const body = await workspace.json() as { ok: true; data: { modelCatalog: { favorites: Array<{ provider: string; id: string }> } } };
      expect(body.data.modelCatalog.favorites).toContainEqual({ provider: "codex", id: "gpt-5.5" });
    } finally {
      await handle.close();
    }
  });

  test("maps validation and missing entities to typed errors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-backend-"));
    tempDirs.push(dir);
    const handle = await startBackend(backendContext(dir), () => {});
    const headers = { authorization: `Bearer ${handle.token}`, "content-type": "application/json" };

    try {
      const invalid = await fetch(`http://127.0.0.1:${handle.port}/threads/select`, {
        method: "POST",
        headers,
        body: JSON.stringify({ threadId: "" }),
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({
        ok: false,
        error: { code: "validation_error", message: "The request is invalid." },
      });

      const missing = await fetch(`http://127.0.0.1:${handle.port}/threads/select`, {
        method: "POST",
        headers,
        body: JSON.stringify({ threadId: "missing-thread" }),
      });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({
        ok: false,
        error: { code: "not_found", message: "Thread not found." },
      });
    } finally {
      await handle.close();
    }
  });

  test("rejects oversized request bodies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-backend-"));
    tempDirs.push(dir);
    const handle = await startBackend(backendContext(dir), () => {});

    try {
      const response = await fetch(`http://127.0.0.1:${handle.port}/threads`, {
        method: "POST",
        headers: { authorization: `Bearer ${handle.token}`, "content-type": "application/json" },
        body: JSON.stringify({ title: "x".repeat(300_000) }),
      });
      expect(response.status).toBe(400);
      const body = await response.json() as { ok: false; error: { code: string } };
      expect(body.error.code).toBe("validation_error");
    } finally {
      await handle.close();
    }
  });

  test("keeps report bodies out of workspace summaries and serves bounded detail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-backend-"));
    tempDirs.push(dir);
    const context = backendContext(dir);
    const db = new DatabaseClient(context.dbPath);
    const threads = new ThreadRepository(db);
    const thread = threads.createThread("Report contract");
    db.setSetting("active_thread_id", thread.id);
    db.db.prepare("INSERT INTO reports (id, thread_id, stream_id, title, html, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("report-1", thread.id, "market", "Market report", "<p>private body</p>", new Date().toISOString());
    db.close();

    const handle = await startBackend(context, () => {});
    const headers = { authorization: `Bearer ${handle.token}` };
    try {
      const workspaceResponse = await fetch(`http://127.0.0.1:${handle.port}/workspace`, { headers });
      const workspace = await workspaceResponse.json() as { ok: true; data: { reports: Array<Record<string, unknown>> } };
      expect(workspace.data.reports).toEqual([{ id: "report-1", streamId: "market", title: "Market report" }]);
      expect(workspace.data.reports[0]).not.toHaveProperty("html");

      const detailResponse = await fetch(`http://127.0.0.1:${handle.port}/reports/report-1`, { headers });
      const detail = await detailResponse.json() as { ok: true; data: { html: string } };
      expect(detail.data.html).toBe("<p>private body</p>");
    } finally {
      await handle.close();
    }
  });

  test("cancels an active research run before deleting its thread", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-backend-"));
    tempDirs.push(dir);
    const context = backendContext(dir);
    const db = new DatabaseClient(context.dbPath);
    const threads = new ThreadRepository(db);
    const thread = threads.createThread("Active run");
    const now = new Date().toISOString();
    db.db.prepare(`
      INSERT INTO research_runs (id, thread_id, status, config_json, spend_estimate, round, cancelled, created_at, updated_at)
      VALUES (?, ?, 'running', '{}', 0, 0, 0, ?, ?)
    `).run("active-run", thread.id, now, now);
    db.close();

    const handle = await startBackend(context, () => {});
    try {
      const response = await fetch(`http://127.0.0.1:${handle.port}/threads/delete`, {
        method: "POST",
        headers: { authorization: `Bearer ${handle.token}`, "content-type": "application/json" },
        body: JSON.stringify({ threadId: thread.id }),
      });
      expect(response.ok).toBe(true);
      const body = await response.json() as { ok: true; data: { threads: unknown[] } };
      expect(body.data.threads).toHaveLength(0);
    } finally {
      await handle.close();
    }
  });
});

describe("focused child branches", () => {
  test("validates selected claims and persists inherited branch context", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-branch-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "scraply.db");
    const db = new DatabaseClient(dbPath);
    const threads = new ThreadRepository(db);
    const parent = threads.createThread("Parent research");
    const brief: ProjectBrief = {
      projectName: "Scraply",
      theme: "Research workflows",
      description: "Find evidence-backed workflow opportunities",
      desiredOutput: "Focused product ideas",
      successDefinition: "A testable direction",
      constraints: [],
      resources: [],
      avoidList: [],
      researchNeeds: "Validate the workflow and buyer demand.",
      finalDecision: "Choose whether to prototype the focused workflow.",
      deadline: "No deadline",
      availableEffort: "One week",
      ideaStylePreference: "Practical",
    };
    threads.saveBrief(parent.id, brief, true);
    db.db.prepare(`
      INSERT INTO ideas (id, thread_id, title, description, bucket, scores_json, supporting_claim_ids_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "idea-seed",
      parent.id,
      "Evidence navigator",
      "Turn claims into a navigable decision trail.",
      "strong-fit",
      JSON.stringify({ relevance: 9, novelty: 8, feasibility: 7, evidenceStrength: 9 }),
      JSON.stringify(["claim-a", "claim-b"]),
      new Date().toISOString(),
    );
    db.close();

    const handle = await startBackend(backendContext(dir), () => {});
    const headers = { authorization: `Bearer ${handle.token}`, "content-type": "application/json" };
    let branchThreadId = "";
    try {
      const invalidClaim = await fetch(`http://127.0.0.1:${handle.port}/threads/branch`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          parentThreadId: parent.id,
          seedIdeaId: "idea-seed",
          seedIdeaTitle: "Evidence navigator",
          explorationAngle: "Validate the decision trail with solo founders.",
          selectedClaimIds: ["claim-outside-idea"],
        }),
      });
      expect(invalidClaim.status).toBe(409);

      const response = await fetch(`http://127.0.0.1:${handle.port}/threads/branch`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          parentThreadId: parent.id,
          seedIdeaId: "idea-seed",
          seedIdeaTitle: "Evidence navigator",
          explorationAngle: "Validate the decision trail with solo founders.",
          selectedClaimIds: ["claim-a"],
        }),
      });
      const responsePayload = await response.json();
      if (!response.ok) throw new Error(JSON.stringify(responsePayload));
      const body = responsePayload as {
        ok: true;
        data: { thread: { id: string; status: string }; workspace: { activeThreadId: string; branchContext: BranchContext } };
      };
      expect(body.data.thread.status).toBe("brief-confirmed");
      expect(body.data.workspace.activeThreadId).toBe(body.data.thread.id);
      branchThreadId = body.data.thread.id;
      expect(body.data.workspace.branchContext).toMatchObject({
        parentThreadId: parent.id,
        seedIdeaId: "idea-seed",
        seedIdeaTitle: "Evidence navigator",
        explorationAngle: "Validate the decision trail with solo founders.",
        inheritedBriefVersion: 1,
        selectedClaimIds: ["claim-a"],
      });
    } finally {
      await handle.close();
    }

    const reopened = new DatabaseClient(dbPath);
    const persisted = new ThreadRepository(reopened).getBranchContext(branchThreadId);
    expect(persisted?.inheritedBriefSnapshot).toEqual(brief);
    expect(persisted?.selectedClaimIds).toEqual(["claim-a"]);
    reopened.close();
  });
});
