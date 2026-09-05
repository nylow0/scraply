import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBackend, type BackendHandle } from "../../src/backend/server";
import { DatabaseClient } from "../../src/db/client";
import { DiscoveryRepository } from "../../src/db/repositories/discovery";
import { DEFAULT_RUN_CONFIG, LEGACY_CODEX_PROVIDER_ID } from "../../src/shared/schemas";

const dirs: string[] = [];
const handles: BackendHandle[] = [];
const modelOption = (id: string) => ({
  providerId: LEGACY_CODEX_PROVIDER_ID,
  modelId: id,
  displayName: id,
  defaultReasoningEffort: "medium",
  reasoningEfforts: [{ id: "medium", description: "Balanced reasoning" }],
});
const codexInspection = (models = [modelOption("gpt-5.6-luna")]) => ({ detected: true, compatible: true, authenticated: true, models });
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
      providerValidation: { inspectCodex: async () => codexInspection([modelOption("gpt-5.6-luna"), modelOption("gpt-test")]), validateExa: async () => ({ valid: true }) },
    }, () => undefined); handles.push(handle);

    const post = async (path: string, body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${handle.port}${path}`, { method: "POST", headers: { authorization: `Bearer ${handle.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      return (await response.json() as { data: unknown }).data;
    };
    const created = await post("/threads", {}) as {
      thread: { id: string; status: string };
      workspace: { models: Array<{ providerId: string; modelId: string }>; runConfig: { model: { providerId: string; modelId: string } } };
    };
    expect(created.thread.status).toBe("configuring");
    expect(created.workspace.models).toEqual([
      { providerId: LEGACY_CODEX_PROVIDER_ID, modelId: "gpt-5.6-luna" },
      { providerId: LEGACY_CODEX_PROVIDER_ID, modelId: "gpt-test" },
    ]);
    expect(created.workspace.runConfig.model).toEqual({ providerId: LEGACY_CODEX_PROVIDER_ID, modelId: "gpt-5.6-luna" });
    const removedEventsEndpoint = await fetch(`http://127.0.0.1:${handle.port}/events`, { headers: { authorization: `Bearer ${handle.token}` } });
    expect(removedEventsEndpoint.status).toBe(404);
    const workspace = await post("/scope", { threadId: created.thread.id, scope: { title: "Repair shops", audience: "Independent shops", domain: "Parts sourcing", observations: "", offLimits: ["Inventory"] } }) as { scope: { title: string; audience: string; domain: string; observations: string; offLimits: string[] } };
    expect(workspace.scope).toEqual({ title: "Repair shops", audience: "Independent shops", domain: "Parts sourcing", observations: "", offLimits: ["Inventory"] });
  });

  test("defaults a new thread to Perplexity when it is the only connected search provider", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-perplexity-default-")); dirs.push(dir);
    const handle = await startBackend({
      dataDir: dir, dbPath: join(dir, "scraply.db"), bundledPromptsDir: join(process.cwd(), "prompts"),
      promptOverridesDir: join(dir, "prompts"), appVersion: "test",
      getSecrets: () => ({ exaApiKey: null, perplexityApiKey: "perplexity-test" }),
      providerValidation: {
        inspectCodex: async () => codexInspection(),
        validatePerplexity: async () => ({ valid: true }),
      },
    }, () => undefined); handles.push(handle);

    const response = await fetch(`http://127.0.0.1:${handle.port}/threads`, {
      method: "POST",
      headers: { authorization: `Bearer ${handle.token}`, "content-type": "application/json" },
      body: "{}",
    });
    const result = await response.json() as { data: { workspace: { runConfig: { searchProvider: string } } } };
    expect(response.status).toBe(200);
    expect(result.data.workspace.runConfig.searchProvider).toBe("perplexity");
  });

  test("starts a known problem without Exa and persists a synthetic discovery root", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-known-problem-")); dirs.push(dir);
    const dbPath = join(dir, "scraply.db");
    let modelCalls = 0;
    const events: Array<{ type: string }> = [];
    const handle = await startBackend({
      dataDir: dir, dbPath, bundledPromptsDir: join(process.cwd(), "prompts"), promptOverridesDir: join(dir, "prompts"),
      appVersion: "test", getSecrets: () => ({ exaApiKey: null }),
      modelClients: { [LEGACY_CODEX_PROVIDER_ID]: { structuredCompletion: async (request) => {
        modelCalls += 1;
        const shape = request.schema.safeParse({ solutions: [] });
        if (shape.success) throw new Error("stop after development starts");
        throw new Error("unexpected model call");
      } } },
      providerValidation: {
        inspectCodex: async () => codexInspection(),
        validateExa: async () => { throw new Error("Exa validation must not run without a key"); },
      },
    }, (event) => events.push(event)); handles.push(handle);
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${handle.port}${path}`, { method: "POST", headers: { authorization: `Bearer ${handle.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      expect(response.status).toBe(200);
      return (await response.json() as { data: unknown }).data;
    };
    const created = await post("/threads", {}) as { thread: { id: string } };
    const threadId = created.thread.id;
    await post("/scope", { threadId, scope: { title: "Known delay", audience: "", domain: "", observations: "", offLimits: [] } });
    const config = {
      model: "gpt-5.6-luna", reasoningEffort: "medium", discoveryDepth: "standard", maxRunMinutes: 90,
      researchMode: "known-problem", knownProblem: "Repair shops cannot predict parts arrival times.",
    } as const;
    await post("/run-config", { threadId, config });
    await post("/research/start", { threadId });

    await new Promise((resolve) => setTimeout(resolve, 25));
    const client = new DatabaseClient(dbPath);
    const runs = client.db.prepare("SELECT status, problem_id FROM research_runs WHERE thread_id = ? ORDER BY created_at, rowid").all(threadId) as Array<{ status: string; problem_id: string | null }>;
    expect(runs).toHaveLength(2);
    expect(runs[0]).toEqual({ status: "completed", problem_id: null });
    expect(runs[1]!.problem_id).not.toBeNull();
    expect(client.db.prepare("SELECT statement, verdict, selected_at IS NOT NULL AS selected FROM problems").get()).toEqual({
      statement: "Repair shops cannot predict parts arrival times.", verdict: "user-asserted", selected: 1,
    });
    expect(client.db.prepare("SELECT COUNT(*) AS count FROM cost_ledger WHERE provider = 'exa'").get()).toEqual({ count: 0 });
    expect(client.db.prepare("SELECT COUNT(*) AS count FROM factors").get()).toEqual({ count: 0 });
    expect(modelCalls).toBeGreaterThan(0);
    expect(events.some((event) => event.type === "run-started")).toBe(true);
    client.close();
  });

  test("reports a failed Codex inspection without inventing model availability", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-model-listing-")); dirs.push(dir);
    const handle = await startBackend({
      dataDir: dir, dbPath: join(dir, "scraply.db"), bundledPromptsDir: join(process.cwd(), "prompts"), promptOverridesDir: join(dir, "prompts"),
      appVersion: "test", getSecrets: () => ({ exaApiKey: "test-key" }),
      providerValidation: {
        inspectCodex: async () => ({ detected: true, compatible: false, authenticated: false, models: [], error: "Installed Codex version is incompatible" }),
        validateExa: async () => ({ valid: true }),
      },
    }, () => undefined); handles.push(handle);
    const get = async <T>(path: string) => {
      const response = await fetch(`http://127.0.0.1:${handle.port}${path}`, { headers: { authorization: `Bearer ${handle.token}` } });
      return { status: response.status, body: (await response.json() as { data: T }).data };
    };

    const validation = await get<{ setupComplete: boolean; codex: { detected: boolean; compatible: boolean; authenticated: boolean; error?: string } }>("/validation");
    expect(validation.status).toBe(200);
    expect(validation.body).toMatchObject({ setupComplete: false, codex: { detected: true, compatible: false, authenticated: false, error: "Installed Codex version is incompatible" } });

    const workspace = await get<{ validation: { codex: { error?: string } }; models: Array<{ providerId: string; modelId: string }> }>("/workspace");
    expect(workspace.body.validation.codex.error).toBe("Installed Codex version is incompatible");
    expect(workspace.body.models).toEqual([]);
  });

  test("forces a fresh Codex inspection when secrets change", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-validation-refresh-")); dirs.push(dir);
    const forceFlags: Array<boolean | undefined> = [];
    let resolveForced!: () => void;
    const forced = new Promise<void>((resolve) => { resolveForced = resolve; });
    const handle = await startBackend({
      dataDir: dir, dbPath: join(dir, "scraply.db"), bundledPromptsDir: join(process.cwd(), "prompts"), promptOverridesDir: join(dir, "prompts"),
      appVersion: "test", getSecrets: () => ({ exaApiKey: null }),
      providerValidation: {
        inspectCodex: async (options) => {
          forceFlags.push(options?.force);
          if (options?.force) resolveForced();
          return codexInspection();
        },
      },
    }, () => undefined); handles.push(handle);

    handle.secretsChanged();
    await forced;

    expect(forceFlags).toContain(true);
  });

  test("keeps authentication separate from compatibility and blocks unauthenticated research", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-auth-guard-")); dirs.push(dir);
    const handle = await startBackend({
      dataDir: dir, dbPath: join(dir, "scraply.db"), bundledPromptsDir: join(process.cwd(), "prompts"), promptOverridesDir: join(dir, "prompts"),
      appVersion: "test", getSecrets: () => ({ exaApiKey: null }),
      providerValidation: {
        inspectCodex: async () => ({ ...codexInspection(), authenticated: false, error: "Codex is not signed in" }),
      },
    }, () => undefined); handles.push(handle);
    const request = async (path: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${handle.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() as {
        data: { codex: ReturnType<typeof codexInspection>; thread: { id: string } };
        error?: { message: string };
      } };
    };

    const validation = await request("/validation");
    expect(validation.body.data.codex).toMatchObject({ detected: true, compatible: true, authenticated: false });
    const threadId = (await request("/threads", {})).body.data.thread.id as string;
    await request("/scope", { threadId, scope: { title: "Known delay", audience: "", domain: "", observations: "", offLimits: [] } });
    await request("/run-config", { threadId, config: { ...DEFAULT_RUN_CONFIG, researchMode: "known-problem", knownProblem: "Parts arrive late." } });
    const start = await request("/research/start", { threadId });
    expect(start.status).toBe(409);
    expect(start.body.error?.message).toBe("Codex is not signed in");
  });

  test("blocks a selected model that the inspected account cannot access", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-model-guard-")); dirs.push(dir);
    const handle = await startBackend({
      dataDir: dir, dbPath: join(dir, "scraply.db"), bundledPromptsDir: join(process.cwd(), "prompts"), promptOverridesDir: join(dir, "prompts"),
      appVersion: "test", getSecrets: () => ({ exaApiKey: null }),
      providerValidation: { inspectCodex: async () => codexInspection([modelOption("gpt-available")]) },
    }, () => undefined); handles.push(handle);
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
        method: "POST", headers: { authorization: `Bearer ${handle.token}`, "content-type": "application/json" }, body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() as {
        data: { thread: { id: string } };
        error?: { message: string };
      } };
    };

    const threadId = (await post("/threads", {})).body.data.thread.id as string;
    await post("/scope", { threadId, scope: { title: "Known delay", audience: "", domain: "", observations: "", offLimits: [] } });
    await post("/run-config", { threadId, config: { ...DEFAULT_RUN_CONFIG, model: { providerId: LEGACY_CODEX_PROVIDER_ID, modelId: "gpt-unavailable" }, researchMode: "known-problem", knownProblem: "Parts arrive late." } });
    const start = await post("/research/start", { threadId });
    expect(start.status).toBe(409);
    expect(start.body.error?.message).toBe("Selected model is unavailable");
  });

  test("rejects a start that the configured research mode cannot satisfy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-start-guard-")); dirs.push(dir);
    const handle = await startBackend({
      dataDir: dir, dbPath: join(dir, "scraply.db"), bundledPromptsDir: join(process.cwd(), "prompts"), promptOverridesDir: join(dir, "prompts"),
      appVersion: "test", getSecrets: () => ({ exaApiKey: null }),
      providerValidation: {
        inspectCodex: async () => codexInspection(),
        validateExa: async () => { throw new Error("Exa validation must not run without a key"); },
      },
    }, () => undefined); handles.push(handle);
    const send = async (path: string, body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${handle.port}${path}`, { method: "POST", headers: { authorization: `Bearer ${handle.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as { data?: { thread: { id: string } }; error?: { message: string } } };
    };
    const threadId = (await send("/threads", {})).body.data!.thread.id;
    await send("/scope", { threadId, scope: { title: "Known delay", audience: "", domain: "", observations: "", offLimits: [] } });

    const base = { configVersion: 2, model: { providerId: LEGACY_CODEX_PROVIDER_ID, modelId: "gpt-5.6-luna" }, reasoningEffort: "medium", discoveryDepth: "standard", maxRunMinutes: 90 } as const;
    await send("/run-config", { threadId, config: { ...base, researchMode: "known-problem", knownProblem: "   " } });
    const blankStatement = await send("/research/start", { threadId });
    expect(blankStatement.status).toBe(400);
    expect(blankStatement.body.error?.message).toBe("Problem statement is required.");

    await send("/run-config", { threadId, config: { ...base, researchMode: "explore-market" } });
    const withoutExa = await send("/research/start", { threadId });
    expect(withoutExa.status).toBe(409);
    expect(withoutExa.body.error?.message).toBe("Connect Exa before discovering problems.");

    await send("/run-config", { threadId, config: { ...base, researchMode: "explore-market", searchProvider: "perplexity" } });
    const withoutPerplexity = await send("/research/start", { threadId });
    expect(withoutPerplexity.status).toBe(409);
    expect(withoutPerplexity.body.error?.message).toBe("Connect Perplexity before discovering problems.");
  });

  test("reuses an undeveloped known-problem root instead of stacking duplicates", () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-known-reuse-")); dirs.push(dir);
    const client = new DatabaseClient(join(dir, "scraply.db"));
    const now = new Date().toISOString();
    client.db.prepare("INSERT INTO threads (id, title, status, created_at, updated_at) VALUES ('thread-1', 'Known', 'configuring', ?, ?)").run(now, now);
    const repository = new DiscoveryRepository(client);
    const scope = { title: "Known", audience: "", domain: "", observations: "", offLimits: [] };
    const config = { ...DEFAULT_RUN_CONFIG, researchMode: "known-problem" as const, knownProblem: "Parts arrival is unpredictable." };

    const first = repository.createKnownProblemRoot("thread-1", scope, config.knownProblem, config);
    // The same statement re-submitted before development completes must resolve to the existing root.
    const second = repository.createKnownProblemRoot("thread-1", scope, `  ${config.knownProblem}  `, config);
    expect(second).toEqual(first);

    // A different statement is a different problem and earns its own root.
    const other = repository.createKnownProblemRoot("thread-1", scope, "Suppliers batch their shipments.", config);
    expect(other.problemId).not.toBe(first.problemId);
    expect((client.db.prepare("SELECT COUNT(*) AS count FROM research_runs").get() as { count: number }).count).toBe(2);
    client.close();
  });

  test("shows and exports solutions only for selected problems in the latest discovery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-backend-")); dirs.push(dir);
    const dbPath = join(dir, "scraply.db");
    const handle = await startBackend({
      dataDir: dir, dbPath, bundledPromptsDir: join(process.cwd(), "prompts"), promptOverridesDir: join(dir, "prompts"),
      appVersion: "test", getSecrets: () => ({ exaApiKey: "test-key" }),
      providerValidation: { inspectCodex: async () => codexInspection([modelOption("gpt-test")]), validateExa: async () => ({ valid: true }) },
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
      VALUES (?, ?, 'completed', ?, ?, ?, ?)
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
    const persistedConfig = JSON.stringify(DEFAULT_RUN_CONFIG);
    insertRun.run("discovery-old", created.thread.id, persistedConfig, null, now, now);
    insertProblem.run("problem-old", "discovery-old", "Superseded problem", now, now);
    insertRun.run("development-old", created.thread.id, persistedConfig, "problem-old", now, now);
    insertSolution.run("solution-old", "problem-old", "Superseded solution", now, "development-old");
    insertRun.run("discovery-latest", created.thread.id, persistedConfig, null, now, now);
    client.db.prepare(`
      INSERT INTO sources (id, research_run_id, canonical_url, title, retrieved_text, content_hash, retrieved_at)
      VALUES ('source-selected', 'discovery-latest', 'https://example.com/selected', 'Selected evidence', 'Source body stays in the source record.', 'hash-selected', ?)
    `).run(now);
    client.db.prepare(`
      INSERT INTO factors (id, research_run_id, subject, behavior, quote, source_id, harvest_mode, model_confidence, created_at)
      VALUES ('factor-selected', 'discovery-latest', 'Repair shops', 'wait for deliveries', 'Parts arrive several days late.', 'source-selected', 'domain', 0.82, ?)
    `).run(now);
    insertProblem.run("problem-selected", "discovery-latest", "Selected problem", now, now);
    client.db.prepare("INSERT INTO problem_factors (problem_id, factor_id) VALUES ('problem-selected', 'factor-selected')").run();
    insertProblem.run("problem-deselected", "discovery-latest", "Deselected problem", null, now);
    insertRun.run("development-selected", created.thread.id, persistedConfig, "problem-selected", now, now);
    insertRun.run("development-deselected", created.thread.id, persistedConfig, "problem-deselected", now, now);
    insertSolution.run("solution-selected", "problem-selected", "Current solution", now, "development-selected");
    insertSolution.run("solution-deselected", "problem-deselected", "Deselected solution", now, "development-deselected");
    client.close();

    const workspaceResponse = await fetch(`http://127.0.0.1:${handle.port}/workspace`, { headers: { authorization: `Bearer ${handle.token}` } });
    expect(workspaceResponse.status).toBe(200);
    const workspace = (await workspaceResponse.json() as { data: { solutions: Array<{ id: string; factors: Array<{ quote: string; sourceTitle: string; retrievedText?: string }> }>; latestResearchRun: { problemId: string | null } } }).data;
    expect(workspace.solutions.map((solution) => solution.id)).toEqual(["solution-selected"]);
    expect(workspace.solutions[0]!.factors).toEqual([expect.objectContaining({
      quote: "Parts arrive several days late.",
      sourceTitle: "Selected evidence",
    })]);
    expect(workspace.solutions[0]!.factors[0]!.retrievedText).toBeUndefined();
    expect(workspace.latestResearchRun.problemId).toBe("problem-deselected");
    const exported = await post("/ideas/export", { threadId: created.thread.id, format: "json" }) as { files: Array<{ filename: string; content: string }> };
    expect(exported.files).toHaveLength(1);
    const jsonIdeas = JSON.parse(exported.files[0]!.content) as Array<{ id: string; factors: Array<{ quote: string; retrievedText?: string }> }>;
    expect(jsonIdeas.map((solution) => solution.id)).toEqual(["solution-selected"]);
    expect(jsonIdeas[0]!.factors[0]!.quote).toBe("Parts arrive several days late.");
    expect(jsonIdeas[0]!.factors[0]!.retrievedText).toBeUndefined();
    const markdown = await post("/ideas/export", { threadId: created.thread.id, format: "markdown" }) as { files: Array<{ content: string }> };
    expect(markdown.files[0]!.content).toContain("## Evidence behind the problem");
    expect(markdown.files[0]!.content).toContain("> Parts arrive several days late.");
  });

  test("exports completed research before solution development", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-research-export-")); dirs.push(dir);
    const dbPath = join(dir, "scraply.db");
    const handle = await startBackend({
      dataDir: dir, dbPath, bundledPromptsDir: join(process.cwd(), "prompts"), promptOverridesDir: join(dir, "prompts"),
      appVersion: "test", getSecrets: () => ({ exaApiKey: "test-key" }),
      providerValidation: { inspectCodex: async () => codexInspection([modelOption("gpt-test")]), validateExa: async () => ({ valid: true }) },
    }, () => undefined); handles.push(handle);
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${handle.port}${path}`, { method: "POST", headers: { authorization: `Bearer ${handle.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      expect(response.status).toBe(200);
      return (await response.json() as { data: unknown }).data;
    };
    const created = await post("/threads", {}) as { thread: { id: string } };
    const scope = { title: "Repair evidence", audience: "Independent shops", domain: "Parts sourcing", observations: "", offLimits: ["Inventory"] };
    await post("/scope", { threadId: created.thread.id, scope });
    const client = new DatabaseClient(dbPath);
    const config = { ...DEFAULT_RUN_CONFIG, model: { providerId: LEGACY_CODEX_PROVIDER_ID, modelId: "gpt-test" } };
    const now = "2026-08-21T12:00:00.000Z";
    client.db.prepare(`INSERT INTO research_runs (id, thread_id, status, config_json, completion_reason, problem_id, created_at, updated_at) VALUES (?, ?, 'completed', ?, 'Discovery completed.', NULL, ?, ?)`)
      .run("discovery-export", created.thread.id, JSON.stringify(config), now, now);
    client.db.prepare(`INSERT INTO scopes (id, research_run_id, title, audience, domain, observations, off_limits_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("scope-export", "discovery-export", scope.title, scope.audience, scope.domain, scope.observations, JSON.stringify(scope.offLimits), now, now);
    client.db.prepare(`INSERT INTO sources (id, research_run_id, provider_source_id, canonical_url, title, retrieved_text, content_hash, retrieved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("source-export", "discovery-export", "provider-1", "https://example.com/evidence", "Repair evidence", "Observed delivery delays.", "hash-1", now);
    client.db.prepare(`INSERT INTO factors (id, research_run_id, subject, behavior, quote, source_id, harvest_mode, model_confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, 'domain', 0.83, ?)`)
      .run("factor-export", "discovery-export", "Repair shops", "wait for parts", "Observed delivery delays.", "source-export", now);
    client.db.prepare(`INSERT INTO problems (id, discovery_run_id, statement, why_it_persists, affected, scale_estimate, verdict, verdict_reason, verdict_source_ids_json, selected_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 'confirmed', ?, '[]', NULL, ?)`)
      .run("problem-export", "discovery-export", "Parts arrival is unpredictable.", "Supplier data is fragmented.", "Independent shops", "Thousands", "Evidence confirms recurring delays.", now);
    client.db.prepare(`INSERT INTO problem_verdict_sources (problem_id, source_id, research_run_id, position) VALUES (?, ?, ?, 0)`)
      .run("problem-export", "source-export", "discovery-export");
    client.db.prepare("INSERT INTO problem_factors (problem_id, factor_id) VALUES (?, ?)").run("problem-export", "factor-export");
    client.db.prepare(`
      INSERT INTO rejected_problem_candidates (id, discovery_run_id, statement, reason, created_at)
      VALUES ('rejected-export', 'discovery-export', 'One-source candidate', 'Cited factors span one source hostname; two are required.', ?)
    `).run(now);
    client.close();

    const workspaceResponse = await fetch(`http://127.0.0.1:${handle.port}/workspace`, {
      headers: { authorization: `Bearer ${handle.token}` },
    });
    const workspace = (await workspaceResponse.json() as { data: { rejectedProblemCandidates: Array<{ id: string; statement: string; reason: string }> } }).data;
    expect(workspace.rejectedProblemCandidates).toEqual([{
      id: "rejected-export",
      statement: "One-source candidate",
      reason: "Cited factors span one source hostname; two are required.",
    }]);

    // Editing the scope after the run must not rewrite what the completed run is exported as having used.
    await post("/scope", { threadId: created.thread.id, scope: { ...scope, title: "Edited later", domain: "Something else" } });

    const bundle = await post("/research/export", { threadId: created.thread.id }) as { filename: string; content: string };
    const exported = JSON.parse(bundle.content) as { schemaVersion: number; scope: typeof scope; sources: Array<{ text: string }>; factors: Array<{ sourceId: string }>; problems: Array<{ id: string }>; rejectedProblemCandidates: Array<{ id: string; statement: string; reason: string }> };
    expect(bundle.filename).toBe("edited-later-research.json");
    expect(exported.schemaVersion).toBe(1);
    expect(exported.scope).toEqual(scope);
    expect(exported.sources[0]?.text).toBe("Observed delivery delays.");
    expect(exported.factors[0]?.sourceId).toBe("source-export");
    expect(exported.problems.map((problem) => problem.id)).toEqual(["problem-export"]);
    expect(exported.rejectedProblemCandidates).toEqual([{
      id: "rejected-export",
      statement: "One-source candidate",
      reason: "Cited factors span one source hostname; two are required.",
    }]);
  });

  test("keeps evidence-gate failures separate until the user asserts the statement", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-rejected-candidate-")); dirs.push(dir);
    const dbPath = join(dir, "scraply.db");
    const handle = await startBackend({
      dataDir: dir, dbPath, bundledPromptsDir: join(process.cwd(), "prompts"), promptOverridesDir: join(dir, "prompts"),
      appVersion: "test", getSecrets: () => ({ exaApiKey: "test-key" }),
      modelClients: { codex: { structuredCompletion: async () => { throw new Error("stop after selection"); } } },
      providerValidation: { inspectCodex: async () => codexInspection([modelOption("gpt-test")]), validateExa: async () => ({ valid: true }) },
    }, () => undefined); handles.push(handle);
    const request = async (path: string, body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${handle.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() as { data?: {
        thread?: { id: string };
        problemCandidates?: Array<{ statement: string; verdict: string }>;
        rejectedProblemCandidates?: Array<{ id: string; statement: string; reason: string }>;
      }; error?: { message: string } } };
    };
    const created = await request("/threads", {});
    const threadId = created.body.data?.thread?.id;
    if (!threadId) throw new Error("Thread creation did not return an id");
    const client = new DatabaseClient(dbPath);
    const now = new Date().toISOString();
    client.db.prepare(`
      INSERT INTO research_runs (id, thread_id, status, config_json, problem_id, created_at, updated_at)
      VALUES ('discovery-rejected', ?, 'completed', ?, NULL, ?, ?)
    `).run(threadId, JSON.stringify({ ...DEFAULT_RUN_CONFIG, model: "gpt-test" }), now, now);
    client.db.prepare(`
      INSERT INTO rejected_problem_candidates (id, discovery_run_id, statement, reason, created_at)
      VALUES ('rejected-1', 'discovery-rejected', 'One-source candidate', 'Only one source hostname.', ?)
    `).run(now);
    client.close();

    const fakeEvidenceSelection = await request("/research/select-problems", {
      threadId,
      problemIds: ["rejected-1"],
      userProblem: null,
    });
    expect(fakeEvidenceSelection.status).toBe(409);

    const asserted = await request("/research/select-problems", {
      threadId,
      problemIds: [],
      userProblem: "One-source candidate",
    });
    expect(asserted.status).toBe(200);
    expect(asserted.body.data?.problemCandidates).toEqual([expect.objectContaining({
      statement: "One-source candidate",
      verdict: "user-asserted",
    })]);
    expect(asserted.body.data?.rejectedProblemCandidates).toEqual([{ id: "rejected-1", statement: "One-source candidate", reason: "Only one source hostname." }]);
  });

  test("cancels and deletes stale runs without provider credentials", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-backend-")); dirs.push(dir);
    const dbPath = join(dir, "scraply.db");
    const events: Array<{ type: string; runId?: string }> = [];
    const handle = await startBackend({
      dataDir: dir, dbPath, bundledPromptsDir: join(process.cwd(), "prompts"), promptOverridesDir: join(dir, "prompts"),
      appVersion: "test", getSecrets: () => ({ exaApiKey: null }),
      providerValidation: { inspectCodex: async () => ({ detected: false, compatible: false, authenticated: false, models: [] }) },
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
      VALUES (?, ?, 'running', ?, ?, ?)
    `);
    const now = new Date().toISOString();
    const persistedConfig = JSON.stringify(DEFAULT_RUN_CONFIG);
    insertRun.run("stale-cancel", cancellable.thread.id, persistedConfig, now, now);
    insertRun.run("stale-delete", deletable.thread.id, persistedConfig, now, now);
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

  test("loads a legacy latest run whose config predates required fields", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-legacy-run-")); dirs.push(dir);
    const dbPath = join(dir, "scraply.db");
    const handle = await startBackend({
      dataDir: dir, dbPath, bundledPromptsDir: join(process.cwd(), "prompts"), promptOverridesDir: join(dir, "prompts"),
      appVersion: "test", getSecrets: () => ({ exaApiKey: null }),
      providerValidation: { inspectCodex: async () => ({ detected: false, compatible: false, authenticated: false, models: [] }) },
    }, () => undefined); handles.push(handle);
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${handle.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      return (await response.json() as { data: unknown }).data;
    };
    const created = await post("/threads", {}) as { thread: { id: string } };
    const client = new DatabaseClient(dbPath);
    const now = new Date().toISOString();
    client.db.prepare(`
      INSERT INTO research_runs (id, thread_id, status, config_json, created_at, updated_at)
      VALUES ('legacy-run', ?, 'completed', '{}', ?, ?)
    `).run(created.thread.id, now, now);
    client.close();

    const response = await fetch(`http://127.0.0.1:${handle.port}/workspace`, {
      headers: { authorization: `Bearer ${handle.token}` },
    });
    expect(response.status).toBe(200);
    const workspace = await response.json() as { data: { latestResearchRun: { runId: string; searches: number } } };
    expect(workspace.data.latestResearchRun).toMatchObject({ runId: "legacy-run", searches: 0 });
  });
});
