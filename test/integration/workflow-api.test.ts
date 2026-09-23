import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBackend, type BackendHandle } from "../../src/backend/server";
import { materializeResearchSnapshot } from "../../src/core/research-revisions";
import { WorkflowCoordinator } from "../../src/core/workflow-coordinator";
import type { ResearchEngine } from "../../src/core/research-engine";
import { sha256 } from "../../src/shared/content-identity";
import { DatabaseClient } from "../../src/db/client";
import { WorkflowRepository } from "../../src/db/repositories/workflows";
import type { ResearchEvent } from "../../src/shared/ipc";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";
import { IdeaConversationSchema, PreviewWorkflowResultSchema, WorkflowAdmissionReceiptSchema, WorkflowDetailSchema, WorkflowLaunchContractSchema } from "../../src/shared/workflow-contracts";

const handles: BackendHandle[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "scraply-workflow-api-"));
  directories.push(directory);
  const dbPath = join(directory, "scraply.db");
  const errors: string[] = [];
  const events: ResearchEvent[] = [];
  const handle = await startBackend({
    dataDir: directory,
    dbPath,
    bundledPromptsDir: join(process.cwd(), "prompts"),
    promptOverridesDir: join(directory, "prompts"),
    appVersion: "test",
    getSecrets: () => ({ exaApiKey: null }),
    log: (entry) => { if (entry.error) errors.push(String(entry.error)); },
    providerValidation: { inspectNative: async () => ({
      available: true, connected: true, accounts: [{ providerId: "openai-subscription" }],
      models: [{
        providerId: "openai-subscription", modelId: "gpt-5.6-sol", displayName: "Test model",
        defaultReasoningEffort: "medium", reasoningEfforts: [{ id: "medium", description: "Medium" }],
      }],
    }) },
  }, (event) => events.push(event));
  handles.push(handle);
  const request = (path: string, body?: unknown) => fetch(`http://127.0.0.1:${handle.port}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${handle.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const created = await request("/threads", {});
  expect(created.status).toBe(200);
  const { data } = await created.json() as { data: { thread: { id: string } } };
  return { request, threadId: data.thread.id, dbPath, errors, events };
}

function launchDraft() {
  return {
    contractVersion: 1,
    purpose: "known-problem",
    mode: "babysit",
    brief: "Find practical ways for repair shops to approve parts purchases.",
    scope: { title: "Repair approvals", audience: "Independent repair shops", domain: "Parts purchasing", observations: "", offLimits: [] },
    runConfig: {
      ...DEFAULT_RUN_CONFIG,
      researchMode: "known-problem",
      knownProblem: "Parts approvals delay repairs.",
    },
    ideas: { model: DEFAULT_RUN_CONFIG.model, reasoningEffort: "medium" },
    targets: { kind: "per-problem", ideaCount: 2 },
    limits: { maxMinutes: 90, maxModelCalls: 8, maxSearches: 0 },
    instructions: {},
  };
}

test("workflow preview, start, detail, and workspace use the same saved session", async () => {
  const { request, threadId, dbPath, errors, events } = await fixture();
  const previewResponse = await request("/workflows/preview", { type: "launch", threadId, draft: launchDraft() });
  expect(previewResponse.status).toBe(200);
  const preview = PreviewWorkflowResultSchema.parse((await previewResponse.json() as { data: unknown }).data);
  expect(preview.fieldErrors).toEqual([]);
  expect(WorkflowLaunchContractSchema.parse(preview.proposal).runConfig.explorationPurpose).toBe("auto");

  const start = {
    threadId, clientCommandId: "launch-command-1", contract: preview.proposal,
    previewHash: preview.previewHash, capabilityFingerprint: preview.capabilityFingerprint,
    previewExpiresAt: preview.expiresAt,
  };
  const startResponse = await request("/workflows/start", start);
  if (startResponse.status !== 200) throw new Error(`Workflow start returned ${startResponse.status}: ${errors.join("; ")}`);
  expect(startResponse.status).toBe(200);
  const receipt = WorkflowAdmissionReceiptSchema.parse((await startResponse.json() as { data: unknown }).data);
  expect(receipt.summary.threadId).toBe(threadId);
  expect(events).toContainEqual(expect.objectContaining({
    type: "workflow-progress", sessionId: receipt.sessionId, threadId,
  }));

  const detailResponse = await request(`/workflows/${receipt.sessionId}`);
  expect(detailResponse.status).toBe(200);
  const detail = WorkflowDetailSchema.parse((await detailResponse.json() as { data: unknown }).data);
  expect(detail.summary.sessionId).toBe(receipt.sessionId);
  expect(detail.tasks.length).toBeGreaterThan(0);

  const workspaceResponse = await request("/workspace");
  expect(workspaceResponse.status).toBe(200);
  const workspace = (await workspaceResponse.json() as { data: { activeWorkflow: { sessionId: string } | null } }).data;
  expect(workspace.activeWorkflow?.sessionId).toBe(receipt.sessionId);

  const replayResponse = await request("/workflows/start", start);
  expect(replayResponse.status).toBe(200);
  const replay = WorkflowAdmissionReceiptSchema.parse((await replayResponse.json() as { data: unknown }).data);
  expect(replay.sessionId).toBe(receipt.sessionId);

  const changedReplay = await request("/workflows/start", { ...start, previewHash: "changed-hash" });
  expect(changedReplay.status).toBe(409);
  expect((await changedReplay.json() as { error: { code: string } }).error.code).toBe("IDEMPOTENCY_CONFLICT");

  const staleCommand = await request("/workflows/command", {
    threadId, sessionId: receipt.sessionId, clientCommandId: "pause-with-stale-revision",
    expectedRevision: 999_999, action: { type: "pause" },
  });
  expect(staleCommand.status).toBe(409);
  expect((await staleCommand.json() as { error: { code: string } }).error.code).toBe("REVISION_CONFLICT");

  let checkpoint: ReturnType<typeof WorkflowDetailSchema.parse> | null = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await request(`/workflows/${receipt.sessionId}`);
    const current = WorkflowDetailSchema.parse((await response.json() as { data: unknown }).data);
    if (current.summary.state === "waiting-for-review") { checkpoint = current; break; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(checkpoint?.summary.state).toBe("waiting-for-review");
  const client = new DatabaseClient(dbPath);
  const repository = new WorkflowRepository(client);
  const currentSession = repository.getSession(receipt.sessionId)!;
  const settled = client.immediateTransaction(() => repository.updateSession(receipt.sessionId, currentSession.revision, {
    state: "finished", outcome: "cancelled",
  }));
  client.close();
  const terminalExtensionPreview = await request("/workflows/preview", {
    type: "budget-extension", threadId, sessionId: receipt.sessionId,
    expectedRevision: settled.revision,
    extension: { additionalModelCalls: 1, additionalSearches: 0, additionalMinutes: 0 },
  });
  expect(terminalExtensionPreview.status).toBe(409);
  expect((await terminalExtensionPreview.json() as { error: { code: string } }).error.code).toBe("REVISION_CONFLICT");
});

test("completed discovery respects a pending pause or stop before Vibe generation", async () => {
  for (const requestedState of ["pause-requested", "stop-requested"] as const) {
    const { threadId, dbPath } = await fixture();
    const client = new DatabaseClient(dbPath);
    const workflows = new WorkflowRepository(client);
    const now = new Date().toISOString();
    const runId = `completed-${requestedState}`;
    const problemId = `problem-${requestedState}`;
    const contract = WorkflowLaunchContractSchema.parse({
      ...launchDraft(), purpose: "discovery", mode: "vibe",
      runConfig: { ...DEFAULT_RUN_CONFIG, researchMode: "explore-market" },
      resolvedInstructions: { research: "Research", ideas: "Ideas", review: "Review" },
      instructionHashes: { research: "research", ideas: "ideas", review: "review" },
    });
    const session = client.immediateTransaction(() => {
      const created = workflows.createSession({ threadId, purpose: "discovery", mode: "vibe", contract,
        remainingMs: contract.limits.maxMinutes * 60_000 });
      const item = workflows.createWorkItem({ sessionId: created.id, kind: "discovery",
        scopeKey: "initial-research", state: "ready", input: { brief: contract.brief } });
      workflows.updateWorkItem(item.id, "running", { outputRefs: { runId } });
      workflows.updateSession(created.id, created.revision, { state: requestedState });
      return { sessionId: created.id, taskId: item.id };
    });
    client.db.prepare(`INSERT INTO research_runs (id,thread_id,status,config_json,workflow_version,
      workflow_session_id,purpose,created_at,updated_at) VALUES (?,?,'completed',?,2,?,'discovery',?,?)`)
      .run(runId, threadId, JSON.stringify(DEFAULT_RUN_CONFIG), session.sessionId, now, now);
    client.db.prepare(`INSERT INTO scopes (id,research_run_id,title,audience,domain,observations,
      off_limits_json,created_at,updated_at) VALUES (?,?,?,'Repair shops','Parts purchasing','','[]',?,?)`)
      .run(`scope-${requestedState}`, runId, "Repair approvals", now, now);
    client.db.prepare(`INSERT INTO problems (id,discovery_run_id,statement,why_it_persists,affected,
      scale_estimate,verdict,verdict_reason,verdict_source_ids_json,created_at)
      VALUES (?,?,'Repair approvals stall','','Repair shops','','confirmed','','[]',?)`)
      .run(problemId, runId, now);
    const errors: unknown[] = [];
    const coordinator = new WorkflowCoordinator({ db: client,
      engine: () => ({}) as ResearchEngine,
      capabilities: async () => ({ nativeConnected: true, searchReady: { exa: false, perplexity: false }, modelOptions: [] }),
      listProblems: () => [{ id: problemId, statement: "Repair approvals stall", whyItPersists: "", affected: "Repair shops",
        scaleEstimate: "", verdict: "confirmed", verdictReason: "", selected: false,
        factors: [{ id: "evidence-factor", subject: "Repair shops", behavior: "Approvals stall", quote: "Approvals stall",
          sourceId: "evidence-source", sourceTitle: "Shop interview", sourceUrl: "https://example.com/interview",
          harvestMode: "audience", modelConfidence: 0.9, sourceRole: "firsthand", audienceFit: "intended-buyer",
          independentSourceKey: "shop-one", supportsDemand: false }],
        intendedBuyerEvidenceFactorIds: ["evidence-factor"], evidenceGap: null, briefFit: "direct",
        contraryEvidence: "resolved", workflowKey: "repair-approvals", singleHarvestModeWarning: false,
        developmentCompleted: false }],
      onProgress: () => {}, onError: (error) => errors.push(error),
    });
    coordinator.handleRunEvent({ type: "run-completed", runId, threadId, problemId: null });
    const settled = workflows.getSession(session.sessionId)!;
    expect(errors).toEqual([]);
    expect(workflows.getWorkItem(session.taskId)?.state).toBe("succeeded");
    expect(settled.activeSnapshotId).not.toBeNull();
    expect(settled.state).toBe(requestedState === "stop-requested" ? "finished" : "paused");
    expect(settled.outcome).toBe(requestedState === "stop-requested" ? "cancelled" : null);
    expect(settled.runningSince).toBeNull();
    expect(workflows.listWorkItems(session.sessionId).filter((item) => item.kind === "generate-ideas")).toEqual([]);
    client.close();
  }
});

test("an active workflow can extend its budget through preview and command", async () => {
  const { request, threadId, dbPath, errors } = await fixture();
  const launchPreviewResponse = await request("/workflows/preview", { type: "launch", threadId, draft: launchDraft() });
  const launchPreview = PreviewWorkflowResultSchema.parse((await launchPreviewResponse.json() as { data: unknown }).data);
  const contract = WorkflowLaunchContractSchema.parse(launchPreview.proposal);
  const client = new DatabaseClient(dbPath);
  const session = client.immediateTransaction(() => new WorkflowRepository(client).createSession({
    threadId, purpose: contract.purpose, mode: contract.mode,
    contract, remainingMs: contract.limits.maxMinutes * 60_000,
  }));
  client.close();

  const extensionPreviewResponse = await request("/workflows/preview", {
    type: "budget-extension", threadId, sessionId: session.id,
    expectedRevision: session.revision,
    extension: { additionalModelCalls: 1, additionalSearches: 0, additionalMinutes: 0 },
  });
  expect(extensionPreviewResponse.status).toBe(200);
  const extensionPreview = PreviewWorkflowResultSchema.parse((await extensionPreviewResponse.json() as { data: unknown }).data);
  const extension = await request("/workflows/command", {
    threadId, sessionId: session.id, clientCommandId: "extend-one-model-call",
    expectedRevision: session.revision,
    action: {
      type: "extend-budget", previewHash: extensionPreview.previewHash,
      capabilityFingerprint: extensionPreview.capabilityFingerprint,
      previewExpiresAt: extensionPreview.expiresAt,
      extension: { additionalModelCalls: 1, additionalSearches: 0, additionalMinutes: 0 },
    },
  });
  if (extension.status !== 200) throw new Error(`Workflow extension returned ${extension.status}: ${errors.join("; ")}`);
  expect(extension.status).toBe(200);
  const extended = WorkflowAdmissionReceiptSchema.parse((await extension.json() as { data: unknown }).data);
  expect(extended.summary.budget.modelCalls.limit).toBe(9);
});

test("per-problem progress does not credit another problem's surplus", async () => {
  const { request, threadId, dbPath } = await fixture();
  const draft = { ...launchDraft(), targets: { kind: "per-problem" as const, ideaCount: 1 } };
  const previewResponse = await request("/workflows/preview", { type: "launch", threadId, draft });
  const preview = PreviewWorkflowResultSchema.parse((await previewResponse.json() as { data: unknown }).data);
  const contract = WorkflowLaunchContractSchema.parse(preview.proposal);
  const client = new DatabaseClient(dbPath);
  const workflows = new WorkflowRepository(client);
  const now = new Date().toISOString();
  const config = JSON.stringify(DEFAULT_RUN_CONFIG);
  client.db.prepare(`INSERT INTO research_runs (id, thread_id, status, config_json, workflow_version, created_at, updated_at)
    VALUES ('quota-source', ?, 'completed', ?, 2, ?, ?)`).run(threadId, config, now, now);
  client.db.prepare(`INSERT INTO scopes (id, research_run_id, title, audience, domain, observations, off_limits_json, created_at, updated_at)
    VALUES ('quota-scope', 'quota-source', 'Synthetic quota case', '', '', '', '[]', ?, ?)`).run(now, now);
  const addProblem = client.db.prepare(`INSERT INTO problems (id, discovery_run_id, statement, why_it_persists,
    affected, scale_estimate, verdict, verdict_reason, verdict_source_ids_json, created_at)
    VALUES (?, 'quota-source', ?, '', '', '', 'confirmed', '', '[]', ?)`);
  for (const label of ["a", "b", "c"]) addProblem.run(`quota-${label}`, `Problem ${label}`, now);
  const session = client.immediateTransaction(() => workflows.createSession({
    threadId, purpose: "known-problem", mode: "babysit", contract,
    remainingMs: contract.limits.maxMinutes * 60_000,
  }));
  const materializedIds = client.immediateTransaction(() => {
    const materialized = materializeResearchSnapshot(client, {
      threadId, baseRunId: "quota-source", sourceProblemIds: ["quota-a", "quota-b", "quota-c"], sessionId: session.id,
    });
    const snapshot = workflows.createSnapshot({
      sessionId: session.id, materializationRunId: materialized.runId,
      selection: { problemIds: materialized.problemIds }, originMap: materialized.originMap,
    });
    workflows.updateSession(session.id, session.revision, { state: "waiting-for-review", activeSnapshotId: snapshot.id });
    materialized.problemIds.forEach((problemId, index) => {
      const item = workflows.createWorkItem({ sessionId: session.id, kind: "generate-ideas",
        scopeKey: `quota:${problemId}`, ordinal: index, state: "ready",
        input: { problemId, quota: 1, fillRound: 0, targetKind: "per-problem", requestedTarget: 3 },
      });
      workflows.updateWorkItem(item.id, "running");
      workflows.updateWorkItem(item.id, "succeeded", {
        outputRefs: { solutionIds: index === 0 ? ["accepted-a"] : index === 1 ? ["accepted-b1", "accepted-b2"] : [] },
      });
    });
    return materialized.problemIds;
  });
  client.close();

  const response = await request(`/workflows/${session.id}`);
  expect(response.status).toBe(200);
  const detail = WorkflowDetailSchema.parse((await response.json() as { data: unknown }).data);
  expect(materializedIds).toHaveLength(3);
  expect(detail.summary.targetKind).toBe("per-problem");
  expect(detail.summary.counts).toMatchObject({ requested: 3, accepted: 2, missing: 1 });
});

test("a target of 20 can request a bounded fill after 18 reviewed ideas", async () => {
  const { request, threadId, dbPath } = await fixture();
  const draft = { ...launchDraft(), targets: { kind: "per-problem" as const, ideaCount: 20 },
    limits: { maxMinutes: 90, maxModelCalls: 24, maxSearches: 0 } };
  const previewResponse = await request("/workflows/preview", { type: "launch", threadId, draft });
  const preview = PreviewWorkflowResultSchema.parse((await previewResponse.json() as { data: unknown }).data);
  expect(preview.fieldErrors).toEqual([]);
  const contract = WorkflowLaunchContractSchema.parse(preview.proposal);
  const client = new DatabaseClient(dbPath);
  const workflows = new WorkflowRepository(client);
  const now = new Date().toISOString();
  client.db.prepare(`INSERT INTO research_runs (id, thread_id, status, config_json, workflow_version, created_at, updated_at)
    VALUES ('fill-source', ?, 'completed', ?, 2, ?, ?)`).run(threadId, JSON.stringify(DEFAULT_RUN_CONFIG), now, now);
  client.db.prepare(`INSERT INTO scopes (id, research_run_id, title, audience, domain, observations, off_limits_json, created_at, updated_at)
    VALUES ('fill-scope', 'fill-source', 'Synthetic fill case', '', '', '', '[]', ?, ?)`).run(now, now);
  client.db.prepare(`INSERT INTO problems (id, discovery_run_id, statement, why_it_persists,
    affected, scale_estimate, verdict, verdict_reason, verdict_source_ids_json, created_at)
    VALUES ('fill-problem', 'fill-source', 'One synthetic problem', '', '', '', 'confirmed', '', '[]', ?)`)
    .run(now);
  const session = client.immediateTransaction(() => workflows.createSession({
    threadId, purpose: "known-problem", mode: "babysit", contract,
    remainingMs: contract.limits.maxMinutes * 60_000,
  }));
  client.immediateTransaction(() => {
    const materialized = materializeResearchSnapshot(client, {
      threadId, baseRunId: "fill-source", sourceProblemIds: ["fill-problem"], sessionId: session.id,
    });
    const snapshot = workflows.createSnapshot({ sessionId: session.id,
      materializationRunId: materialized.runId,
      selection: { problemIds: materialized.problemIds }, originMap: materialized.originMap });
    workflows.updateSession(session.id, session.revision, { activeSnapshotId: snapshot.id });
    for (let batch = 0; batch < 4; batch += 1) {
      const item = workflows.createWorkItem({ sessionId: session.id, kind: "generate-ideas",
        scopeKey: `initial:${batch}`, ordinal: batch, state: "ready",
        input: { problemId: materialized.problemIds[0], snapshotId: snapshot.id,
          quota: 5, fillRound: 0, targetKind: "per-problem", requestedTarget: 20 },
      });
      workflows.updateWorkItem(item.id, "running");
      workflows.updateWorkItem(item.id, "succeeded", {
        outputRefs: {
          solutionIds: Array.from({ length: batch === 3 ? 3 : 5 }, (_, index) => `accepted-${batch}-${index}`),
          proposedSolutionIds: Array.from({ length: 5 }, (_, index) => `candidate-${batch}-${index}`),
        },
      });
    }
  });
  const coordinator = new WorkflowCoordinator({ db: client,
    engine: () => ({ startSelectedProblem: async () => "synthetic-fill-run" }) as unknown as ResearchEngine,
    capabilities: async () => ({ nativeConnected: true, searchReady: { exa: false, perplexity: false }, modelOptions: [] }),
    listProblems: () => [], onProgress: () => {},
  });
  expect(coordinator.summary(session.id).counts).toMatchObject({ requested: 20, attempted: 20, accepted: 18, missing: 2 });
  (coordinator as unknown as { finishCollection: (id: string) => void }).finishCollection(session.id);
  const fill = workflows.listWorkItems(session.id).find((item) => item.scopeKey.startsWith("fill:"));
  expect(fill?.input).toMatchObject({ quota: 2 });
  expect(workflows.getSession(session.id)?.state).toBe("running");
  client.close();
});

test("project targets retain their starting family count while recounting membership edits", async () => {
  const { request, threadId, dbPath } = await fixture();
  const draft = { ...launchDraft(), mode: "vibe" as const,
    runConfig: { ...launchDraft().runConfig, explorationPurpose: "startup-opportunities" as const },
    targets: { kind: "project" as const, ideaCount: 2, distinctBusinessCount: 2 },
    limits: { maxMinutes: 90, maxModelCalls: 16, maxSearches: 0 } };
  const previewResponse = await request("/workflows/preview", { type: "launch", threadId, draft });
  const preview = PreviewWorkflowResultSchema.parse((await previewResponse.json() as { data: unknown }).data);
  expect(preview.fieldErrors).toEqual([]);
  const contract = WorkflowLaunchContractSchema.parse(preview.proposal);
  const client = new DatabaseClient(dbPath);
  const workflows = new WorkflowRepository(client);
  const now = new Date().toISOString();
  const config = JSON.stringify(DEFAULT_RUN_CONFIG);
  client.db.prepare(`INSERT INTO research_runs (id, thread_id, status, config_json, workflow_version, created_at, updated_at)
    VALUES ('family-source', ?, 'completed', ?, 2, ?, ?)`).run(threadId, config, now, now);
  client.db.prepare(`INSERT INTO scopes (id, research_run_id, title, audience, domain, observations, off_limits_json, created_at, updated_at)
    VALUES ('family-scope', 'family-source', 'Family baseline', '', '', '', '[]', ?, ?)`).run(now, now);
  client.db.prepare(`INSERT INTO problems (id, discovery_run_id, statement, why_it_persists,
    affected, scale_estimate, verdict, verdict_reason, verdict_source_ids_json, created_at)
    VALUES ('family-problem', 'family-source', 'One business problem', '', '', '', 'confirmed', '', '[]', ?)`)
    .run(now);
  client.db.prepare(`INSERT INTO research_runs (id, thread_id, problem_id, status, config_json, workflow_version, created_at, updated_at)
    VALUES ('family-old-development', ?, 'family-problem', 'completed', ?, 2, ?, ?)`)
    .run(threadId, config, now, now);
  client.db.prepare(`INSERT INTO solutions (id, problem_id, research_run_id, mechanism, description,
    respects_off_limits, respects_off_limits_why, startup_opportunity_json, created_at)
    VALUES ('family-existing-option', 'family-problem', 'family-old-development', 'Approval inbox',
      'A sellable quote approval workflow', 1, 'Within scope', ?, ?)`)
    .run(JSON.stringify({ opportunityType: "startup-opportunity", payingCustomerSegment: "Repair shops",
      trigger: "Quote revision", existingSubstitute: "Telephone approval",
      gapAssessment: { kind: "hypothesis", description: "Manual delays", evidenceIds: [] },
      smallestSellableWorkflow: "Record quote approval", firstCustomerRoute: "Local shops",
      disconfirmingDemandTest: "Observe quote approval delays" }), now);
  client.db.prepare(`INSERT INTO opportunity_families (id, thread_id, representative_option_id, title, summary, active, created_at, updated_at)
    VALUES ('family-existing', ?, 'family-existing-option', 'Quote approvals', 'One buying decision', 1, ?, ?)`)
    .run(threadId, now, now);
  client.db.prepare(`INSERT INTO opportunity_membership_decisions (id, thread_id, option_id, family_id,
    relationship, state, reason, actor, created_at)
    VALUES ('family-membership', ?, 'family-existing-option', 'family-existing',
      'separate-business', 'accepted', 'Distinct quote approval purchase', 'user', ?)`)
    .run(threadId, now);
  const session = client.immediateTransaction(() => workflows.createSession({
    threadId, purpose: "known-problem", mode: "vibe", contract,
    remainingMs: contract.limits.maxMinutes * 60_000,
  }));
  client.immediateTransaction(() => workflows.createWorkItem({
    sessionId: session.id, kind: "known-problem", scopeKey: "initial-research", state: "ready",
    input: { familyBaseline: { acceptedFamilyCount: 1, acceptedFamilyIds: ["family-existing"],
      candidateInventoryIds: ["family-existing-option"], existingCount: 1 } },
  }));
  const materialized = client.immediateTransaction(() => {
    const copy = materializeResearchSnapshot(client, {
      threadId, baseRunId: "family-source", sourceProblemIds: ["family-problem"], sessionId: session.id,
    });
    const snapshot = workflows.createSnapshot({ sessionId: session.id,
      materializationRunId: copy.runId, selection: { problemIds: copy.problemIds }, originMap: copy.originMap });
    workflows.updateSession(session.id, session.revision, { activeSnapshotId: snapshot.id });
    return { snapshotId: snapshot.id, problemIds: copy.problemIds };
  });
  const coordinator = new WorkflowCoordinator({ db: client,
    engine: () => ({}) as ResearchEngine,
    capabilities: async () => ({ nativeConnected: true, searchReady: { exa: false, perplexity: false }, modelOptions: [] }),
    listProblems: () => [], onProgress: () => {},
  });
  expect(coordinator.summary(session.id).counts).toMatchObject({ requested: 2, existing: 1, accepted: 1, missing: 1 });
  client.immediateTransaction(() => (coordinator as unknown as {
    admitGenerationTasks: (session: NonNullable<ReturnType<WorkflowRepository["getSession"]>>,
      snapshotId: string, problemIds: string[]) => string[];
  }).admitGenerationTasks(workflows.getSession(session.id)!, materialized.snapshotId, materialized.problemIds));
  const generated = workflows.listWorkItems(session.id).filter((item) => item.kind === "generate-ideas");
  expect(generated).toHaveLength(1);
  expect(generated[0]?.input).toMatchObject({ quota: 1, requestedTarget: 2, targetKind: "project" });
  client.db.prepare("UPDATE opportunity_families SET active = 0 WHERE id = 'family-existing'").run();
  expect(coordinator.summary(session.id).counts).toMatchObject({ requested: 2, existing: 1,
    addedBySession: 0, total: 0, accepted: 0, missing: 2 });
  client.close();
});

test("Babysit admits a thirty-family project target at the research checkpoint", async () => {
  const { request, threadId, errors } = await fixture();
  const draft = { ...launchDraft(),
    runConfig: { ...launchDraft().runConfig, explorationPurpose: "startup-opportunities" as const },
    targets: { kind: "project" as const, ideaCount: 3, distinctBusinessCount: 30 },
    limits: { maxMinutes: 90, maxModelCalls: 40, maxSearches: 0 } };
  const previewResponse = await request("/workflows/preview", { type: "launch", threadId, draft });
  const preview = PreviewWorkflowResultSchema.parse((await previewResponse.json() as { data: unknown }).data);
  expect(preview.fieldErrors).toEqual([]);
  const start = await request("/workflows/start", { threadId, clientCommandId: "start-thirty",
    contract: preview.proposal, previewHash: preview.previewHash,
    capabilityFingerprint: preview.capabilityFingerprint, previewExpiresAt: preview.expiresAt });
  if (start.status !== 200) throw new Error(`Start failed: ${await start.text()}; ${errors.join("; ")}`);
  const receipt = WorkflowAdmissionReceiptSchema.parse((await start.json() as { data: unknown }).data);
  let checkpoint: ReturnType<typeof WorkflowDetailSchema.parse> | null = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const detail = await request(`/workflows/${receipt.sessionId}`);
    const current = WorkflowDetailSchema.parse((await detail.json() as { data: unknown }).data);
    if (current.summary.state === "waiting-for-review") { checkpoint = current; break; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(checkpoint?.summary.state).toBe("waiting-for-review");
  const snapshotId = checkpoint!.summary.activeSnapshotId!;
  const command = await request("/workflows/command", { threadId, sessionId: receipt.sessionId,
    clientCommandId: "generate-thirty", expectedRevision: checkpoint!.summary.revision,
    action: { type: "generate-ideas", snapshotId,
      problemIds: checkpoint!.summary.selectedProblemIds,
      model: DEFAULT_RUN_CONFIG.model, reasoningEffort: "medium", target: { kind: "project", count: 30 } } });
  if (command.status !== 200) throw new Error(`Generate failed: ${await command.text()}; ${errors.join("; ")}`);
  const generation = WorkflowAdmissionReceiptSchema.parse((await command.json() as { data: unknown }).data);
  expect(generation.summary.targetKind).toBe("project");
  expect(generation.summary.counts.requested).toBe(30);
});

test("restart recovery requeues an undispatched task and links a saved run before resume", async () => {
  const { request, threadId, dbPath } = await fixture();
  const previewResponse = await request("/workflows/preview", { type: "launch", threadId, draft: launchDraft() });
  const preview = PreviewWorkflowResultSchema.parse((await previewResponse.json() as { data: unknown }).data);
  const contract = WorkflowLaunchContractSchema.parse(preview.proposal);
  const client = new DatabaseClient(dbPath);
  const workflows = new WorkflowRepository(client);
  const first = client.immediateTransaction(() => {
    const session = workflows.createSession({ threadId, purpose: contract.purpose, mode: contract.mode,
      contract, remainingMs: contract.limits.maxMinutes * 60_000 });
    const item = workflows.createWorkItem({ sessionId: session.id, kind: "known-problem",
      scopeKey: "initial-research", state: "ready", input: { brief: contract.brief } });
    workflows.updateWorkItem(item.id, "running");
    return { sessionId: session.id, taskId: item.id };
  });
  const resumedRun: { id: string | null } = { id: null };
  const coordinator = new WorkflowCoordinator({ db: client,
    engine: () => ({ resumeRun: async (runId: string) => { resumedRun.id = runId; } }) as ResearchEngine,
    capabilities: async () => ({ nativeConnected: true, searchReady: { exa: false, perplexity: false }, modelOptions: [] }),
    listProblems: () => [], onProgress: () => {},
  });
  coordinator.reconcileInterrupted();
  expect(workflows.getWorkItem(first.taskId)?.state).toBe("ready");
  expect(workflows.getSession(first.sessionId)?.state).toBe("paused");
  client.immediateTransaction(() => {
    workflows.updateWorkItem(first.taskId, "skipped", { error: { message: "Fixture moves to the next recovery case." } });
    const paused = workflows.getSession(first.sessionId)!;
    workflows.updateSession(first.sessionId, paused.revision, { state: "finished", outcome: "cancelled" });
  });

  const second = client.immediateTransaction(() => {
    const session = workflows.createSession({ threadId, purpose: contract.purpose, mode: contract.mode,
      contract, remainingMs: contract.limits.maxMinutes * 60_000 });
    const item = workflows.createWorkItem({ sessionId: session.id, kind: "discovery",
      scopeKey: "initial-research", state: "ready", input: { brief: contract.brief } });
    workflows.updateWorkItem(item.id, "running");
    const now = new Date().toISOString();
    client.db.prepare(`INSERT INTO research_runs (id, thread_id, status, config_json, workflow_version,
      workflow_session_id, purpose, created_at, updated_at)
      VALUES ('saved-unlinked-run', ?, 'running', ?, 2, ?, 'known-problem', ?, ?)`)
      .run(threadId, JSON.stringify(DEFAULT_RUN_CONFIG), session.id, now, now);
    return { sessionId: session.id, taskId: item.id };
  });
  coordinator.reconcileInterrupted();
  expect(workflows.getWorkItem(second.taskId)?.outputRefs).toEqual({ runId: "saved-unlinked-run" });
  const paused = workflows.getSession(second.sessionId)!;
  expect(paused.state).toBe("paused");
  const resumed = await coordinator.command({ threadId, sessionId: second.sessionId,
    clientCommandId: "resume-linked-run", expectedRevision: paused.revision, action: { type: "resume" } });
  expect(resumed.summary.state).toBe("running");
  expect(resumedRun.id).toBe("saved-unlinked-run");
  client.close();
});

test("workflow routes validate payloads and typed errors before provider work", async () => {
  const { request, threadId } = await fixture();
  const invalidPreview = await request("/workflows/preview", { type: "launch", threadId, draft: { ...launchDraft(), targets: { kind: "per-problem", ideaCount: 0 } } });
  expect(invalidPreview.status).toBe(400);
  expect((await invalidPreview.json() as { error: { code: string } }).error.code).toBe("validation_error");

  const invalidConversation = await request("/ideas/missing/conversation?branchId=");
  expect(invalidConversation.status).toBe(400);
  expect((await invalidConversation.json() as { error: { code: string } }).error.code).toBe("validation_error");

  const missingConversation = await request("/ideas/missing/conversation");
  expect(missingConversation.status).toBe(404);
  expect((await missingConversation.json() as { error: { code: string } }).error.code).toBe("not_found");

  const invalidTurn = await request("/ideas/turn", { threadId, text: "Explain this idea" });
  expect(invalidTurn.status).toBe(400);
  expect((await invalidTurn.json() as { error: { code: string } }).error.code).toBe("validation_error");

  const missingWorkflow = await request("/workflows/missing");
  expect(missingWorkflow.status).toBe(404);
  expect((await missingWorkflow.json() as { error: { code: string } }).error.code).toBe("not_found");
});

test("deleting a project removes its workflow session before legacy project rows", async () => {
  const { request, threadId, dbPath } = await fixture();
  const previewResponse = await request("/workflows/preview", { type: "launch", threadId, draft: launchDraft() });
  const preview = PreviewWorkflowResultSchema.parse((await previewResponse.json() as { data: unknown }).data);
  const contract = WorkflowLaunchContractSchema.parse(preview.proposal);
  const client = new DatabaseClient(dbPath);
  const workflows = new WorkflowRepository(client);
  const session = client.immediateTransaction(() => workflows.createSession({
    threadId, purpose: contract.purpose, mode: contract.mode,
    contract, remainingMs: contract.limits.maxMinutes * 60_000,
  }));

  const blocked = await request("/threads/delete", { threadId });
  expect(blocked.status).toBe(409);
  expect((await blocked.json() as { error: { code: string } }).error.code).toBe("PROJECT_BUSY");
  client.immediateTransaction(() => workflows.updateSession(session.id, session.revision, { state: "finished", outcome: "cancelled" }));
  client.close();

  const deleted = await request("/threads/delete", { threadId });
  expect(deleted.status).toBe(200);
  const detail = await request(`/workflows/${session.id}`);
  expect(detail.status).toBe(404);
  const workspace = (await deleted.json() as { data: { activeWorkflow: unknown } }).data;
  expect(workspace.activeWorkflow).toBeNull();
});

test("workspace keeps an earlier root idea after a new evidence snapshot while version history exports", async () => {
  const { request, threadId, dbPath, errors } = await fixture();
  const previewResponse = await request("/workflows/preview", { type: "launch", threadId, draft: launchDraft() });
  const preview = PreviewWorkflowResultSchema.parse((await previewResponse.json() as { data: unknown }).data);
  const contract = WorkflowLaunchContractSchema.parse(preview.proposal);
  const client = new DatabaseClient(dbPath);
  const workflows = new WorkflowRepository(client);
  const session = client.immediateTransaction(() => workflows.createSession({
    threadId, purpose: contract.purpose, mode: contract.mode,
    contract, remainingMs: contract.limits.maxMinutes * 60_000,
  }));
  const now = "2026-09-23T10:00:00.000Z";
  const config = JSON.stringify(DEFAULT_RUN_CONFIG);
  client.db.prepare(`
    INSERT INTO research_runs (id, thread_id, status, config_json, workflow_version, created_at, updated_at)
    VALUES ('discovery-for-versions', ?, 'completed', ?, 2, ?, ?)
  `).run(threadId, config, now, now);
  client.db.prepare(`
    INSERT INTO scopes (id, research_run_id, title, audience, domain, observations, off_limits_json, created_at, updated_at)
    VALUES ('scope-for-versions', 'discovery-for-versions', 'Approval delays', 'Repair shops', 'Parts purchasing', '', '[]', ?, ?)
  `).run(now, now);
  client.db.prepare(`
    INSERT INTO problems (id, discovery_run_id, statement, why_it_persists, affected, scale_estimate,
      verdict, verdict_reason, verdict_source_ids_json, selected_at, created_at)
    VALUES ('problem-for-versions', 'discovery-for-versions', 'Approval delays repairs', '', '', '',
      'confirmed', '', '[]', ?, ?)
  `).run(now, now);
  const sourceText = "Repair teams wait for a manager to approve parts purchases.";
  client.db.prepare(`
    INSERT INTO sources (id, research_run_id, provider_source_id, canonical_url, title,
      retrieved_text, author, published_at, content_hash, retrieved_at)
    VALUES ('source-for-versions', 'discovery-for-versions', 'source-for-versions',
      'https://example.test/repair-approvals', 'Repair approvals report', ?, NULL, NULL, ?, ?)
  `).run(sourceText, sha256(sourceText), now);
  client.db.prepare(`
    INSERT INTO problem_verdict_sources (problem_id, source_id, research_run_id, position)
    VALUES ('problem-for-versions', 'source-for-versions', 'discovery-for-versions', 0)
  `).run();
  const addRun = client.db.prepare(`
    INSERT INTO research_runs (id, thread_id, status, config_json, problem_id, workflow_version, created_at, updated_at)
    VALUES (?, ?, 'completed', ?, 'problem-for-versions', 2, ?, ?)
  `);
  addRun.run("root-run", threadId, config, now, now);
  addRun.run("version-run", threadId, config, now, now);
  addRun.run("board-version-run", threadId, config, now, now);
  const addSolution = client.db.prepare(`
    INSERT INTO solutions (id, problem_id, mechanism, description, respects_off_limits,
      respects_off_limits_why, created_at, research_run_id)
    VALUES (?, 'problem-for-versions', ?, 'A practical option', 1, '', ?, ?)
  `);
  addSolution.run("root-idea", "Approval inbox", now, "root-run");
  addSolution.run("version-idea", "Approval queue", now, "version-run");
  addSolution.run("board-version-idea", "Approval board", now, "board-version-run");
  client.db.prepare(`
    INSERT INTO idea_turns (id, root_solution_id, branch_id, branch_sequence, base_solution_id,
      session_id, client_message_id, intent, user_text, context_json, context_sha256,
      state, assistant_json, generated_solution_id, created_at, completed_at)
    VALUES ('turn-for-version', 'root-idea', 'branch-for-version', 1, 'root-idea', ?,
      'message-for-version', 'rethink', 'Try a queue', '{}', ?, 'completed', ?,
      'version-idea', ?, ?)
  `).run(session.id, sha256("{}"), JSON.stringify({
    text: "Use a queue.", citedEvidenceIds: [], assumptions: [],
    changeSummary: "Queue approvals", generatedSolutionId: "version-idea",
  }), now, now);
  client.db.prepare(`
    INSERT INTO idea_turns (id, root_solution_id, branch_id, branch_sequence, base_solution_id,
      session_id, client_message_id, intent, user_text, context_json, context_sha256,
      state, assistant_json, generated_solution_id, created_at, completed_at)
    VALUES ('turn-for-board', 'root-idea', 'branch-for-board', 1, 'root-idea', ?,
      'message-for-board', 'rethink', 'Try a board', '{}', ?, 'completed', ?,
      'board-version-idea', ?, ?)
  `).run(session.id, sha256("{}"), JSON.stringify({
    text: "Use a board.", citedEvidenceIds: [], assumptions: [],
    changeSummary: "Board approvals", generatedSolutionId: "board-version-idea",
  }), now, now);
  client.db.prepare(`
    INSERT INTO solution_lineage (solution_id, root_solution_id, version_number, change_summary, created_at)
    VALUES ('root-idea', 'root-idea', 1, 'Original idea', ?)
  `).run(now);
  client.db.prepare(`
    INSERT INTO solution_lineage (solution_id, root_solution_id, parent_solution_id,
      version_number, turn_id, change_summary, created_at)
    VALUES ('board-version-idea', 'root-idea', 'root-idea', 3, 'turn-for-board', 'Board approvals', ?)
  `).run(now);
  client.db.prepare(`
    INSERT INTO solution_lineage (solution_id, root_solution_id, parent_solution_id,
      version_number, turn_id, change_summary, created_at)
    VALUES ('version-idea', 'root-idea', 'root-idea', 2, 'turn-for-version', 'Queue approvals', ?)
  `).run(now);
  client.immediateTransaction(() => workflows.updateSession(session.id, workflows.getSession(session.id)!.revision, {
    state: "finished", outcome: "partial",
  }));
  const followupSession = client.immediateTransaction(() => workflows.createSession({
    threadId, purpose: "research-followup", mode: contract.mode, contract,
    remainingMs: contract.limits.maxMinutes * 60_000,
  }));
  client.immediateTransaction(() => {
    const materialized = materializeResearchSnapshot(client, {
      threadId, baseRunId: "discovery-for-versions", sourceProblemIds: ["problem-for-versions"], sessionId: followupSession.id,
    });
    const snapshot = workflows.createSnapshot({
      sessionId: followupSession.id, materializationRunId: materialized.runId,
      selection: { problemIds: materialized.problemIds, sourceProblemIds: ["problem-for-versions"] },
      originMap: materialized.originMap,
    });
    workflows.updateSession(followupSession.id, workflows.getSession(followupSession.id)!.revision, {
      state: "waiting-for-review", activeSnapshotId: snapshot.id,
    });
    const requestItem = workflows.createWorkItem({
      sessionId: followupSession.id, kind: "research-request", scopeKey: "saved-question",
      input: { action: { type: "request-research", kind: "new-question", question: "How do shops approve purchases?" }, baseSnapshotId: snapshot.id },
    });
    client.db.prepare(`
      INSERT INTO research_runs (id, thread_id, status, config_json, workflow_version,
        workflow_session_id, purpose, created_at, updated_at)
      VALUES ('completed-request-run', ?, 'completed', ?, 2, ?, 'research-followup', ?, ?)
    `).run(threadId, config, followupSession.id, now, now);
    client.db.prepare(`
      INSERT INTO problems (id, discovery_run_id, statement, why_it_persists, affected, scale_estimate,
        verdict, verdict_reason, verdict_source_ids_json, created_at)
      VALUES ('completed-request-finding', 'completed-request-run', 'Managers approve each parts purchase',
        '', '', '', 'confirmed', '', '[]', ?)
    `).run(now);
    workflows.updateWorkItem(requestItem.id, "ready");
    workflows.updateWorkItem(requestItem.id, "running");
    workflows.updateWorkItem(requestItem.id, "succeeded", {
      outputRefs: { runId: "completed-request-run", problemIds: ["completed-request-finding"] },
    });
  });
  client.close();

  const workspaceResponse = await request("/workspace");
  expect(workspaceResponse.status).toBe(200);
  const workspace = (await workspaceResponse.json() as { data: { solutions: Array<{ id: string }>;
    problemCandidates: Array<{ id: string; statement: string; selected: boolean }>;
    researchRequests: Array<{ question: string; status: string }>;
    researchFindings: Array<{ statement: string }> } }).data;
  expect(workspace.solutions.map((solution) => solution.id)).toEqual(["root-idea"]);
  expect(workspace.problemCandidates).toEqual([expect.objectContaining({ statement: "Approval delays repairs", selected: true })]);
  expect(workspace.problemCandidates[0]?.id).not.toBe("completed-request-finding");
  expect(workspace.researchRequests).toEqual([expect.objectContaining({ question: "How do shops approve purchases?", status: "completed" })]);
  expect(workspace.researchFindings.map((finding) => finding.statement)).toEqual(["Approval delays repairs"]);

  const versionResponse = await request("/ideas/version-idea");
  expect(versionResponse.status).toBe(200);
  expect((await versionResponse.json() as { data: { id: string } }).data.id).toBe("version-idea");

  const conversationResponse = await request("/ideas/version-idea/conversation");
  if (conversationResponse.status !== 200) throw new Error(`Conversation returned ${conversationResponse.status}: ${await conversationResponse.text()}; ${errors.join("; ")}`);
  expect(conversationResponse.status).toBe(200);
  const conversation = IdeaConversationSchema.parse((await conversationResponse.json() as { data: unknown }).data);
  expect(conversation.versions.map((version) => version.solutionId)).toEqual(["root-idea", "version-idea", "board-version-idea"]);
  expect(conversation.turns).toHaveLength(2);

  const selectResponse = await request("/ideas/select-version", {
    threadId, rootSolutionId: "root-idea", solutionId: "version-idea",
  });
  expect(selectResponse.status).toBe(200);
  const selectedConversation = IdeaConversationSchema.parse((await selectResponse.json() as { data: unknown }).data);
  expect(selectedConversation.selectedVersionId).toBe("version-idea");
  const reloaded = await request("/ideas/root-idea/conversation");
  expect(reloaded.status).toBe(200);
  expect(IdeaConversationSchema.parse((await reloaded.json() as { data: unknown }).data).selectedVersionId).toBe("version-idea");
  const invalidSelection = await request("/ideas/select-version", {
    threadId, rootSolutionId: "root-idea", solutionId: "missing-version",
  });
  expect(invalidSelection.status).toBe(400);
  expect((await invalidSelection.json() as { error: { code: string } }).error.code).toBe("INVALID_REFERENCE");

  const exportResponse = await request("/ideas/export", { threadId, format: "json" });
  expect(exportResponse.status).toBe(200);
  const exported = (await exportResponse.json() as { data: { files: Array<{ filename: string; content: string }> } }).data;
  expect((JSON.parse(exported.files[0]!.content) as Array<{ id: string }>).map((idea) => idea.id).sort()).toEqual([
    "board-version-idea", "root-idea", "version-idea",
  ]);
  const historyFile = exported.files.find((file) => file.filename === "idea-history.json");
  expect(historyFile).toBeDefined();
  const history = JSON.parse(historyFile!.content) as {
    versions: Array<{ solutionId: string; rootSolutionId: string; turnId: string | null }>;
    turns: Array<{ id: string; branchId: string; generatedSolutionId: string }>;
    evidenceSnapshots: Array<{ id: string; selection: { problemIds: string[] }; originMap: { problems: Record<string, unknown>; sources: Record<string, unknown> } }>;
  };
  expect(history.versions.map((version) => version.solutionId)).toEqual(["root-idea", "version-idea", "board-version-idea"]);
  expect(history.versions[1]).toMatchObject({ rootSolutionId: "root-idea", turnId: "turn-for-version" });
  expect(history.turns).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "turn-for-version", branchId: "branch-for-version", generatedSolutionId: "version-idea" }),
    expect.objectContaining({ id: "turn-for-board", branchId: "branch-for-board", generatedSolutionId: "board-version-idea" }),
  ]));
  expect(history.turns).toHaveLength(2);
  expect(history.evidenceSnapshots).toHaveLength(1);
  expect(history.evidenceSnapshots[0]!.selection.problemIds).toHaveLength(1);
  expect(Object.keys(history.evidenceSnapshots[0]!.originMap.problems)).toEqual(history.evidenceSnapshots[0]!.selection.problemIds);
  expect(Object.keys(history.evidenceSnapshots[0]!.originMap.sources)).toHaveLength(1);

  const markdownResponse = await request("/ideas/export", { threadId, format: "markdown" });
  expect(markdownResponse.status).toBe(200);
  const markdownFiles = (await markdownResponse.json() as { data: { files: Array<{ filename: string; content: string }> } }).data.files;
  const markdownHistory = markdownFiles.find((file) => file.filename === "idea-history.md")?.content;
  expect(markdownHistory).toContain("# Idea history");
  expect(markdownHistory).toContain("Conversation branch `branch-for-version`");
  expect(markdownHistory).toContain("Conversation branch `branch-for-board`");
  expect(markdownHistory).toContain("Selected findings:");
  expect(markdownHistory).toContain("`source-for-versions`");
  expect(markdownHistory).not.toContain('"versions": [');

  const researchResponse = await request("/research/export", { threadId });
  expect(researchResponse.status).toBe(200);
  const researchExport = (await researchResponse.json() as { data: { content: string } }).data;
  const archived = JSON.parse(researchExport.content) as {
    researchRun: { id: string };
    history: { researchRequests: Array<{ question: string; workflowSessionId: string }>;
      evidenceSnapshots: Array<{ id: string; originMap: { problems: Record<string, unknown> } }>;
      runs: Array<{ id: string; sources: Array<{ id: string }>; problems: Array<{ id: string }> }> };
  };
  expect(archived.researchRun.id).toBe("discovery-for-versions");
  expect(archived.history.researchRequests).toEqual([expect.objectContaining({ question: "How do shops approve purchases?", status: "completed", workflowSessionId: followupSession.id })]);
  expect(archived.history.evidenceSnapshots.map((snapshot) => snapshot.id)).toEqual(history.evidenceSnapshots.map((snapshot) => snapshot.id));
  expect(archived.history.runs.map((run) => run.id)).toContain("discovery-for-versions");
  expect(archived.history.runs.find((run) => run.id === "completed-request-run")?.problems.map((problem) => problem.id)).toEqual(["completed-request-finding"]);
  expect(archived.history.runs.find((run) => run.id === "discovery-for-versions")?.sources.map((source) => source.id)).toEqual(["source-for-versions"]);
  expect(archived.history.runs.some((run) => run.problems.some((problem) => problem.id === "problem-for-versions"))).toBe(true);
});

test("a project without a launch session can select and reload an idea version", async () => {
  const { request, threadId, dbPath } = await fixture();
  const client = new DatabaseClient(dbPath);
  const now = new Date().toISOString();
  const config = JSON.stringify(DEFAULT_RUN_CONFIG);
  client.db.prepare(`
    INSERT INTO research_runs (id, thread_id, status, config_json, workflow_version, created_at, updated_at)
    VALUES ('legacy-discovery', ?, 'completed', ?, 2, ?, ?)
  `).run(threadId, config, now, now);
  client.db.prepare(`
    INSERT INTO problems (id, discovery_run_id, statement, why_it_persists, affected, scale_estimate,
      verdict, verdict_reason, verdict_source_ids_json, selected_at, created_at)
    VALUES ('legacy-problem', 'legacy-discovery', 'Approval delays repairs', '', '', '',
      'confirmed', '', '[]', ?, ?)
  `).run(now, now);
  const addRun = client.db.prepare(`
    INSERT INTO research_runs (id, thread_id, status, config_json, problem_id, workflow_version, created_at, updated_at)
    VALUES (?, ?, 'completed', ?, 'legacy-problem', 2, ?, ?)
  `);
  addRun.run("legacy-root-run", threadId, config, now, now);
  addRun.run("legacy-version-run", threadId, config, now, now);
  const addSolution = client.db.prepare(`
    INSERT INTO solutions (id, problem_id, mechanism, description, respects_off_limits,
      respects_off_limits_why, created_at, research_run_id)
    VALUES (?, 'legacy-problem', ?, 'A practical option', 1, '', ?, ?)
  `);
  addSolution.run("legacy-root", "Approval inbox", now, "legacy-root-run");
  addSolution.run("legacy-version", "Approval queue", now, "legacy-version-run");
  const session = client.immediateTransaction(() => new WorkflowRepository(client).createSession({
    threadId, purpose: "idea-turn", mode: "babysit",
    contract: { limits: { maxMinutes: 5, maxModelCalls: 1, maxSearches: 0 } }, remainingMs: 5 * 60_000,
  }));
  client.db.prepare(`
    INSERT INTO idea_turns (id, root_solution_id, branch_id, branch_sequence, base_solution_id,
      session_id, client_message_id, intent, user_text, context_json, context_sha256,
      state, assistant_json, generated_solution_id, created_at, completed_at)
    VALUES ('legacy-turn', 'legacy-root', 'legacy-branch', 1, 'legacy-root', ?,
      'legacy-message', 'rethink', 'Try a queue', '{}', ?, 'completed', ?,
      'legacy-version', ?, ?)
  `).run(session.id, sha256("{}"), JSON.stringify({
    text: "Use a queue.", citedEvidenceIds: [], assumptions: [],
    changeSummary: "Queue approvals", generatedSolutionId: "legacy-version",
  }), now, now);
  client.db.prepare(`
    INSERT INTO solution_lineage (solution_id, root_solution_id, version_number, change_summary, created_at)
    VALUES ('legacy-root', 'legacy-root', 1, 'Original idea', ?)
  `).run(now);
  client.db.prepare(`
    INSERT INTO solution_lineage (solution_id, root_solution_id, parent_solution_id, version_number, turn_id, change_summary, created_at)
    VALUES ('legacy-version', 'legacy-root', 'legacy-root', 2, 'legacy-turn', 'Queue approvals', ?)
  `).run(now);
  client.close();

  const selected = await request("/ideas/select-version", {
    threadId, rootSolutionId: "legacy-root", solutionId: "legacy-version",
  });
  expect(selected.status).toBe(200);
  expect(IdeaConversationSchema.parse((await selected.json() as { data: unknown }).data).selectedVersionId).toBe("legacy-version");
  const reloaded = await request("/ideas/legacy-root/conversation");
  expect(reloaded.status).toBe(200);
  expect(IdeaConversationSchema.parse((await reloaded.json() as { data: unknown }).data).selectedVersionId).toBe("legacy-version");
});
