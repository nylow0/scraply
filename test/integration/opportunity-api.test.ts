import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { startBackend, type BackendHandle } from "../../src/backend/server";
import { DatabaseClient } from "../../src/db/client";
import { OpportunityExplorationRepository } from "../../src/db/repositories/opportunity-exploration";
import { ThreadRepository } from "../../src/db/repositories/threads";
import type { StructuredModelClient, StructuredStageRequest } from "../../src/providers/structured";
import { WorkspaceStateSchema } from "../../src/shared/ipc";
import { OpportunityReviewOutputSchema } from "../../src/shared/opportunity-review";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";
import { DEFAULT_OPPORTUNITY_EXPLORATION_CONFIG } from "../../src/shared/opportunity-exploration";

test("backend startup recovers exploration before the first workspace read or engine action", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scraply-opportunity-recovery-"));
  const dbPath = join(directory, "scraply.db");
  let handle: BackendHandle | undefined;
  try {
    const db = new DatabaseClient(dbPath);
    const thread = new ThreadRepository(db).createThread("Interrupted test", DEFAULT_RUN_CONFIG);
    db.immediateTransaction(() => new OpportunityExplorationRepository(db).create(thread.id, DEFAULT_OPPORTUNITY_EXPLORATION_CONFIG));
    db.setSetting("active_thread_id", thread.id);
    db.close();
    handle = await startBackend({
      dataDir: directory, dbPath, bundledPromptsDir: join(process.cwd(), "prompts"), promptOverridesDir: join(directory, "prompts"),
      appVersion: "test", getSecrets: () => ({ exaApiKey: null }),
    }, () => undefined);
    const response = await fetch(`http://127.0.0.1:${handle.port}/workspace`, { headers: { authorization: `Bearer ${handle.token}` } });
    const result = z.object({ data: WorkspaceStateSchema }).parse(await response.json());
    expect(result.data.opportunityExploration?.status).toBe("paused");
    expect(result.data.opportunityExploration?.stopReason).toContain("app restarted");
    expect(result.data.opportunityReviewStatus?.running).toBe(false);
  } finally {
    await handle?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("saved review, reversible edits, export, and reopen preserve the original options through the API", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scraply-opportunity-api-"));
  const dbPath = join(directory, "scraply.db");
  let handle: BackendHandle | undefined;
  let calls = 0;
  const client: StructuredModelClient = {
    async structuredCompletion<T>(request: StructuredStageRequest<T>) {
      calls += 1;
      request.onDispatched?.();
      request.onAccepted?.({ protocolVersion: "test" });
      const input = z.object({
        expectedAssessmentIds: z.array(z.string()),
        expectedComparisons: z.array(z.object({ candidateOptionId: z.string(), target: z.object({ kind: z.string(), id: z.string() }) })),
      }).parse(request.workOrder.inputs);
      const output = OpportunityReviewOutputSchema.parse({
        assessments: input.expectedAssessmentIds.map(candidateOptionId => ({ candidateOptionId, status: "reviewable", reason: "Saved comparison fields are complete." })),
        comparisons: input.expectedComparisons.map(pair => ({ ...pair, relationship: "duplicate", reason: "Both are the same repair approval purchase.", concreteDistinctionOrOverlap: "The buyer, trigger, and approval workflow match." })),
      });
      return { output: request.schema.parse(output), metadata: {
        model: request.model, usage: { status: "unknown" as const }, finishReason: "stop", latencyMs: 1, repairCount: 0, providerRequestIds: [], attempts: [],
      } };
    },
  };
  const launch = () => startBackend({
    dataDir: directory, dbPath, bundledPromptsDir: join(process.cwd(), "prompts"), promptOverridesDir: join(directory, "prompts"),
    appVersion: "test", getSecrets: () => ({ exaApiKey: null }), modelClients: { "openai-subscription": client },
    providerValidation: { inspectNative: async () => ({ available: true, connected: true, accounts: [{ providerId: "openai-subscription" }], models: [{ ...DEFAULT_RUN_CONFIG.model, displayName: "Sol", defaultReasoningEffort: "medium", reasoningEfforts: [{ id: "medium", description: "Balanced" }] }] }) },
  }, () => undefined);
  const request = async (path: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(`http://127.0.0.1:${handle!.port}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${handle!.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = z.object({ data: z.unknown().optional(), error: z.unknown().optional() }).parse(await response.json());
    if (!response.ok) throw new Error(JSON.stringify(result.error));
    return result.data;
  };
  try {
    const db = new DatabaseClient(dbPath);
    const now = new Date().toISOString();
    const config = JSON.stringify({ ...DEFAULT_RUN_CONFIG, explorationPurpose: "startup-opportunities" });
    db.db.prepare("INSERT INTO threads(id,title,status,created_at,updated_at) VALUES ('project','Saved review','solutions-ready',?,?)").run(now, now);
    db.db.prepare("INSERT INTO research_runs(id,thread_id,status,config_json,workflow_version,created_at,updated_at) VALUES ('discovery','project','completed',?,2,?,?)").run(config, now, now);
    db.db.prepare("INSERT INTO problems(id,discovery_run_id,statement,why_it_persists,affected,scale_estimate,verdict,verdict_reason,verdict_source_ids_json,selected_at,created_at) VALUES ('problem','discovery','Repair approval delays','','','','insufficient-evidence','No demand evidence','[]',?,?)").run(now, now);
    db.db.prepare("INSERT INTO research_runs(id,thread_id,problem_id,status,config_json,workflow_version,created_at,updated_at) VALUES ('development','project','problem','completed',?,2,?,?)").run(config, now, now);
    for (const id of ["option-a", "option-b"]) {
      db.db.prepare("INSERT INTO solutions(id,problem_id,research_run_id,mechanism,description,respects_off_limits,respects_off_limits_why,startup_opportunity_json,created_at) VALUES (?,'problem','development',?,'Approval workflow',1,'Within scope',?,?)").run(id, id, JSON.stringify({
        opportunityType: "startup-opportunity", payingCustomerSegment: "Repair shops", trigger: "Revised quote", existingSubstitute: "Telephone approval",
        gapAssessment: { kind: "hypothesis", description: "No demand evidence", evidenceIds: [] }, smallestSellableWorkflow: "Record quote approval", firstCustomerRoute: "Local shops", disconfirmingDemandTest: "Observe approval delays",
      }), now);
    }
    db.setSetting("active_thread_id", "project");
    db.close();
    handle = await launch();
    const before = WorkspaceStateSchema.parse(await request("/workspace"));
    expect(before.opportunityFamilies?.acceptedFamilyCount).toBe(0);
    expect(before.opportunityExploration).toBeNull();
    const originalExport = z.object({ content: z.string() }).parse(await request("/research/export", { threadId: "project" }));
    expect(JSON.parse(originalExport.content)).toMatchObject({ opportunityExploration: null });
    const originalIdeas = z.object({ files: z.array(z.object({ filename: z.string() })) }).parse(await request("/ideas/export", { threadId: "project", format: "json" }));
    expect(originalIdeas.files.some(file => file.filename === "opportunity-review.json")).toBe(false);
    await request("/opportunities/review", { threadId: "project", model: DEFAULT_RUN_CONFIG.model, reasoningEffort: "medium" });
    let state = WorkspaceStateSchema.parse(await request("/workspace"));
    for (let attempt = 0; state.opportunityReviewStatus?.running && attempt < 100; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      state = WorkspaceStateSchema.parse(await request("/workspace"));
    }
    expect(state.opportunityReviewStatus?.running).toBe(false);
    expect(state.opportunityReviewStatus?.error).toBeNull();
    expect(state.opportunityFamilies?.acceptedFamilyCount).toBe(1);
    expect(state.opportunityExploration).toBeNull();
    expect(calls).toBe(1);
    const changed = WorkspaceStateSchema.parse(await request("/opportunities/membership", { threadId: "project", command: {
      operation: "split", optionId: "option-b", title: "Separate quote audit", summary: "A separate buying decision", reason: "A different budget owner purchases an audit.",
    } }));
    expect(changed.opportunityFamilies?.acceptedFamilyCount).toBe(2);
    const exported = z.object({ files: z.array(z.object({ filename: z.string(), content: z.string() })) }).parse(await request("/ideas/export", { threadId: "project", format: "json" }));
    const review = exported.files.find(file => file.filename === "opportunity-review.json");
    expect(review).toBeDefined();
    expect(review!.content).toContain("membershipHistory");
    expect(review!.content).toContain("concreteDistinctionOrOverlap");
    await handle.close();
    handle = await launch();
    const reopened = WorkspaceStateSchema.parse(await request("/workspace"));
    expect(reopened.opportunityFamilies?.acceptedFamilyCount).toBe(2);
    expect(reopened.solutions.map(item => ({ id: item.id, description: item.description, problemVerdict: item.problemVerdict }))).toEqual(before.solutions.map(item => ({ id: item.id, description: item.description, problemVerdict: item.problemVerdict })));
    expect(calls).toBe(1);
  } finally {
    await handle?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
