import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseClient } from "../../src/db/client";
import { ThreadRepository } from "../../src/db/repositories/threads";
import { createBackendClients, isSetupComplete, startBackend, type BackendContext } from "../../src/backend/server";
import { buildPreferenceContext } from "../../src/core/preferences";
import type { StructuredModelClient } from "../../src/providers/structured";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/intake";
import type { BriefExtractionResponse } from "../../src/shared/ipc";
import type { BranchContext, ProjectBrief } from "../../src/shared/schemas";
import { loadIntakeParserFixtures } from "../fixtures/intake/load-fixtures";
import { makeProjectBrief } from "../helpers/project-brief";
import packageMetadata from "../../package.json";

const tempDirs: string[] = [];

function backendContext(dir: string): BackendContext {
  return {
    dataDir: dir,
    dbPath: join(dir, "scraply.db"),
    bundledPromptsDir: join(process.cwd(), "prompts"),
    promptOverridesDir: join(dir, "prompts"),
    appVersion: packageMetadata.version,
    getSecrets: () => ({ opencodeApiKey: null, exaApiKey: null }),
    providerValidation: {
      probeCodex: async () => ({ detected: false, compatible: false, error: "Disabled in tests" }),
      listCodexModels: async () => [],
      validateExa: async () => ({ valid: false, error: "Disabled in tests" }),
      validateOpenCode: async () => ({ valid: false, models: [], error: "Disabled in tests" }),
    },
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

describe("Smart brief intake", () => {
  test("persists one complete starter text, uncertainty, and the inferred thread title", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-brief-intake-"));
    tempDirs.push(dir);
    const fixture = loadIntakeParserFixtures().find((item) => item.id === "contradictory-constraints")!;
    const modelCalls: string[] = [];
    const extraction: BriefExtractionResponse = {
      brief: makeProjectBrief({
        title: "CRM selection",
        objective: fixture.expected.objective,
        decisionToSupport: fixture.expected.decisionToSupport ?? "",
        desiredOutput: {
          type: fixture.expected.desiredOutputType ?? "other",
          notes: "Ranked shortlist of three products",
        },
        hardConstraints: fixture.expected.hardConstraints,
        deadline: fixture.expected.deadline,
        openQuestions: ["Confirm which conflicting requirements take priority"],
      }),
      missingFields: ["migration owner"],
      assumptions: ["The eight-person team are all CRM users"],
      contradictions: fixture.expected.contradictions,
    };
    const fakeModel: StructuredModelClient = {
      async structuredCompletion(_model, _system, user) {
        modelCalls.push(user);
        return extraction as never;
      },
    };
    const handle = await startBackend({
      ...backendContext(dir),
      modelClients: { codex: fakeModel },
    }, () => {});
    const headers = {
      authorization: `Bearer ${handle.token}`,
      "content-type": "application/json",
    };

    try {
      const createdResponse = await fetch(`http://127.0.0.1:${handle.port}/threads`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      const created = await createdResponse.json() as {
        ok: true;
        data: { thread: { id: string } };
      };
      const threadId = created.data.thread.id;

      const response = await fetch(`http://127.0.0.1:${handle.port}/intake/brief`, {
        method: "POST",
        headers,
        body: JSON.stringify({ threadId, text: fixture.input }),
      });
      expect(response.ok).toBe(true);
      const payload = await response.json() as {
        ok: true;
        data: BriefExtractionResponse & {
          workspace: {
            brief: ProjectBrief;
            threads: Array<{ id: string; title: string; status: string }>;
          };
        };
      };

      expect(modelCalls).toEqual([fixture.input]);
      expect(payload.data.brief.openQuestions).toContain("migration owner");
      expect(payload.data.brief.assumptions).toContain("The eight-person team are all CRM users");
      expect(payload.data.brief.contradictions).toEqual(fixture.expected.contradictions);
      expect(payload.data.workspace.brief).toEqual(payload.data.brief);
      expect(payload.data.workspace.threads.find((thread) => thread.id === threadId)).toMatchObject({
        title: "CRM selection",
        status: "brief-draft",
      });
    } finally {
      await handle.close();
    }

    const reopened = new DatabaseClient(join(dir, "scraply.db"));
    const repository = new ThreadRepository(reopened);
    const thread = repository.listThreads()[0]!;
    const persistedBrief = repository.getLatestBrief(thread.id)!;
    const userMessages = repository.getMessages(thread.id).filter((message) => message.role === "user");

    expect(userMessages.map((message) => message.content)).toEqual([fixture.input]);
    expect(persistedBrief.openQuestions).toContain("migration owner");
    expect(persistedBrief.assumptions).toContain("The eight-person team are all CRM users");
    expect(persistedBrief.contradictions).toEqual(fixture.expected.contradictions);
    reopened.close();
  });
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
    expect(isSetupComplete(
      { valid: true },
      { detected: true, compatible: false },
      { valid: true },
    )).toBe(true);
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
      const body = await health.json() as { ok: true; data: { ok: boolean; version: string; persistenceCheck: string } };
      expect(body.ok).toBe(true);
      expect(body.data.ok).toBe(true);
      expect(body.data.version).toBe(packageMetadata.version);
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

  test("feeds ratings saved through the API into preference context", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-backend-"));
    tempDirs.push(dir);
    const db = new DatabaseClient(join(dir, "scraply.db"));
    const thread = new ThreadRepository(db).createThread("Preferences");
    db.db.prepare(`
      INSERT INTO ideas (id, thread_id, title, description, bucket, scores_json, supporting_claim_ids_json, created_at)
      VALUES ('idea-rated', ?, 'Rated through API', 'Preference signal', 'strong-fit', ?, '[]', ?)
    `).run(
      thread.id,
      JSON.stringify({ relevance: 8, novelty: 7, evidenceStrength: 8, feasibility: 7, demand: 8, saturation: 4 }),
      new Date().toISOString(),
    );
    db.close();

    const handle = await startBackend(backendContext(dir), () => {});
    const headers = { authorization: `Bearer ${handle.token}`, "content-type": "application/json" };
    try {
      for (const rating of [2, 5]) {
        const response = await fetch(`http://127.0.0.1:${handle.port}/ideas/rate`, {
          method: "POST",
          headers,
          body: JSON.stringify({ ideaId: "idea-rated", rating }),
        });
        expect(response.ok).toBe(true);
      }
    } finally {
      await handle.close();
    }

    const reopened = new DatabaseClient(join(dir, "scraply.db"));
    const context = buildPreferenceContext(reopened);
    expect(context.positiveExamples.map((idea) => idea.title)).toEqual(["Rated through API"]);
    expect(context.negativeExamples).toEqual([]);
    expect((reopened.db.prepare("SELECT COUNT(*) AS count FROM rating_history WHERE idea_id = 'idea-rated'").get() as { count: number }).count).toBe(2);
    reopened.close();
  });

  test("keeps idea summaries light while restoring ratings and evidence by ID", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-backend-idea-detail-"));
    tempDirs.push(dir);
    const context = backendContext(dir);
    const db = new DatabaseClient(context.dbPath);
    const thread = new ThreadRepository(db).createThread("Idea detail");
    const now = new Date().toISOString();
    db.setSetting("active_thread_id", thread.id);
    db.db.prepare(`
      INSERT INTO research_runs (id, thread_id, status, config_json, spend_estimate, round, cancelled, created_at, updated_at)
      VALUES ('run-detail', ?, 'completed', '{}', 0, 0, 0, ?, ?)
    `).run(thread.id, now, now);
    db.db.prepare(`
      INSERT INTO sources (
        id, research_run_id, canonical_url, title, retrieved_text, content_hash, retrieved_at
      ) VALUES ('source-detail', 'run-detail', 'https://example.com/detail', 'Detail source', 'Source body', 'hash-detail', ?)
    `).run(now);
    db.db.prepare(`
      INSERT INTO claims (
        id, research_run_id, text, confidence, validation_status, created_at
      ) VALUES ('claim-detail', 'run-detail', 'Validated claim', 0.9, 'valid', ?)
    `).run(now);
    db.db.prepare(`
      INSERT INTO claim_evidence (claim_id, source_id, quote, evidence_quality)
      VALUES ('claim-detail', 'source-detail', 'Evidence quote', 0.9)
    `).run();
    db.db.prepare(`
      INSERT INTO ideas (
        id, thread_id, research_run_id, generation_mode, title, description, bucket,
        scores_json, supporting_claim_ids_json, created_at
      ) VALUES ('idea-detail', ?, 'run-detail', 'complete', 'Detailed idea', 'Description', 'strong-fit', ?, '["claim-detail"]', ?)
    `).run(
      thread.id,
      JSON.stringify({ relevance: 8, novelty: 7, evidenceStrength: 9, feasibility: 8, demand: 7, saturation: 4 }),
      now,
    );
    db.db.prepare("INSERT INTO idea_claims (idea_id, claim_id) VALUES ('idea-detail', 'claim-detail')").run();
    db.db.prepare(`
      INSERT INTO idea_ratings (idea_id, rating, notes, updated_at)
      VALUES ('idea-detail', 4, 'Persisted', ?)
    `).run(now);
    db.close();

    const handle = await startBackend(context, () => {});
    const headers = { authorization: `Bearer ${handle.token}`, "content-type": "application/json" };
    try {
      const workspaceResponse = await fetch(`http://127.0.0.1:${handle.port}/workspace`, { headers });
      const workspace = await workspaceResponse.json() as {
        ok: true;
        data: { ideas: Array<Record<string, unknown>> };
      };
      expect(workspace.data.ideas[0]).toMatchObject({
        id: "idea-detail",
        researchRunId: "run-detail",
        generationMode: "complete",
        currentRating: { rating: 4, notes: "Persisted" },
      });
      expect(workspace.data.ideas[0]).not.toHaveProperty("evidence");

      const detailResponse = await fetch(`http://127.0.0.1:${handle.port}/ideas/idea-detail`, { headers });
      const detail = await detailResponse.json() as { ok: true; data: { evidence: Array<{ quote: string }> } };
      expect(detail.data.evidence).toEqual([expect.objectContaining({ quote: "Evidence quote" })]);

      const exportResponse = await fetch(`http://127.0.0.1:${handle.port}/ideas/export`, {
        method: "POST",
        headers,
        body: JSON.stringify({ threadId: thread.id }),
      });
      const exported = await exportResponse.json() as { ok: true; data: { ideas: Array<{ evidence: unknown[] }> } };
      expect(exported.data.ideas[0]?.evidence).toHaveLength(1);
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

  test("returns a safe correlation reference and logs unexpected route failures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-backend-correlation-"));
    tempDirs.push(dir);
    const context = backendContext(dir);
    const setup = new DatabaseClient(context.dbPath);
    const thread = new ThreadRepository(setup).createThread("Broken workspace");
    setup.setSetting("active_thread_id", thread.id);
    setup.close();
    const logs: Array<Parameters<NonNullable<BackendContext["log"]>>[0]> = [];
    context.log = (entry) => logs.push(entry);
    const handle = await startBackend(context, () => {});
    const sabotaged = new DatabaseClient(context.dbPath);
    sabotaged.db.exec("DROP TABLE ideas");
    sabotaged.close();

    try {
      const response = await fetch(`http://127.0.0.1:${handle.port}/workspace`, {
        headers: { authorization: `Bearer ${handle.token}` },
      });
      expect(response.status).toBe(500);
      const payload = await response.json() as {
        ok: false;
        error: { code: string; message: string; reference?: string };
      };
      expect(payload.error.code).toBe("internal_error");
      expect(payload.error.message).toBe("Something went wrong. Please try again.");
      expect(payload.error.reference).toBeString();
      expect(logs).toContainEqual(expect.objectContaining({
        level: "error",
        event: "backend-request-failed",
        context: expect.objectContaining({ correlationId: payload.error.reference, route: "/workspace" }),
      }));
    } finally {
      await handle.close();
    }
  });

  test("returns conflicts for repeated terminal resume and cancel actions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-backend-terminal-run-"));
    tempDirs.push(dir);
    const context = backendContext(dir);
    const db = new DatabaseClient(context.dbPath);
    const thread = new ThreadRepository(db).createThread("Terminal run");
    const now = new Date().toISOString();
    const brief: ProjectBrief = makeProjectBrief({
      title: "Terminal",
      objective: "Recovery",
      context: "Verify terminal lifecycle guards",
      desiredOutput: { type: "other", notes: "Typed conflicts" },
      successCriteria: ["Repeated actions stay safe"],
      evidenceRequirements: ["Lifecycle state"],
      decisionToSupport: "Whether to retry",
    });
    db.db.prepare(`
      INSERT INTO research_runs (
        id, thread_id, status, config_json, brief_json, spend_estimate, round, cancelled, created_at, updated_at
      ) VALUES ('terminal-run', ?, 'cancelled', ?, ?, 0, 0, 1, ?, ?)
    `).run(thread.id, JSON.stringify(DEFAULT_RUN_CONFIG), JSON.stringify(brief), now, now);
    db.close();

    const handle = await startBackend(context, () => {});
    const headers = { authorization: `Bearer ${handle.token}`, "content-type": "application/json" };
    try {
      for (const path of ["/research/resume", "/research/cancel"]) {
        const response = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
          method: "POST",
          headers,
          body: JSON.stringify({ runId: "terminal-run" }),
        });
        expect(response.status).toBe(409);
        const payload = await response.json() as { ok: false; error: { code: string; message: string } };
        expect(payload.error.code).toBe("conflict");
        expect(payload.error.message).toContain("already ended");
      }
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
    const brief: ProjectBrief = makeProjectBrief({
      title: "Scraply",
      objective: "Research workflows",
      context: "Find evidence-backed workflow opportunities",
      desiredOutput: { type: "options", notes: "Focused product ideas" },
      successCriteria: ["A testable direction"],
      evidenceRequirements: ["Validate the workflow and buyer demand."],
      decisionToSupport: "Choose whether to prototype the focused workflow.",
      availableEffort: "One week",
      ideaStyle: "safe",
    });
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
