import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configurePromptPaths } from "../../src/core/prompts";
import { ResearchEngine } from "../../src/core/research-engine";
import { DatabaseClient } from "../../src/db/client";
import { OpportunityRepository } from "../../src/db/repositories/opportunities";
import { WorkflowRepository } from "../../src/db/repositories/workflows";
import type { StructuredModelClient } from "../../src/providers/structured";
import { RunConfigSchema } from "../../src/shared/schemas";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    try { rmSync(directory, { recursive: true, force: true }); }
    catch { /* SQLite may release a WAL handle after the test ends on Windows. */ }
  }
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}

test("a workflow development run checkpoints collection decisions before completion", async () => {
  configurePromptPaths({ bundledDir: join(process.cwd(), "prompts"), overrideDir: null });
  const directory = mkdtempSync(join(tmpdir(), "scraply-solution-review-"));
  directories.push(directory);
  const db = new DatabaseClient(join(directory, "scraply.db"));
  const now = new Date().toISOString();
  db.db.prepare("INSERT INTO threads (id,title,status,created_at,updated_at) VALUES ('thread','Project','configuring',?,?)")
    .run(now, now);
  const scope = { title: "Claims", audience: "Operations teams", domain: "Insurance", observations: "", offLimits: [] };
  const config = RunConfigSchema.parse({
    configVersion: 2, workflowVersion: 2, searchProvider: "exa", explorationPurpose: "general-solutions",
    model: { providerId: "fixture", modelId: "fixture" }, reasoningEffort: "low",
    discoveryDepth: "quick", maxRunMinutes: 5, ideaCount: 1,
  });
  db.immediateTransaction(() => new WorkflowRepository(db).createSession({
    id: "session", threadId: "thread", purpose: "known-problem", mode: "babysit",
    remainingMs: 300_000,
    contract: {
      contractVersion: 1, purpose: "known-problem", mode: "babysit", brief: "Reconcile claims",
      scope, runConfig: config, targets: { kind: "project", ideaCount: 1 },
      ideas: { model: config.model, reasoningEffort: "low",
        reviewModel: { providerId: "fixture-fallback", modelId: "fallback" }, reviewReasoningEffort: "low" },
      limits: { maxMinutes: 5, maxModelCalls: 3, maxSearches: 0 },
      instructions: { review: "Keep genuine mechanism differences." },
      resolvedInstructions: { research: "", ideas: "", review: "Keep genuine mechanism differences." },
      instructionHashes: { research: "hash", ideas: "hash", review: "hash" },
    },
  }));
  const stages: string[] = [];
  const generationAngle = { gapId: "claims-handoff", name: "Claims handoff",
    angle: "Give adjusters a distinct way to reconcile duplicate claims after an operator handoff." };
  const generationEvidence = [{ id: "gap-search-source", url: "https://example.com/claims-handoff",
    title: "Claims handoff notes", text: "Adjusters reconcile duplicate claim exports after a handoff." }];
  let receivedAngle: unknown;
  let receivedEvidenceId: string | null = null;
  let releaseSolutions: () => void = () => {};
  const solutionsGate = new Promise<void>((resolve) => { releaseSolutions = resolve; });
  const model: StructuredModelClient = {
    async structuredCompletion(request) {
      stages.push(`${request.stage}:${request.model.providerId}`);
      if (request.stage === "solutions") {
        receivedAngle = (request.workOrder.inputs as { generationAngle?: unknown }).generationAngle;
        receivedEvidenceId = (request.workOrder.inputs as { generationEvidenceSourceIds?: string[] })
          .generationEvidenceSourceIds?.[0] ?? null;
        expect(JSON.stringify(request.evidence.find((item) => item.sourceId === receivedEvidenceId)?.content))
          .toContain(generationEvidence[0]!.text);
      }
      if (request.stage === "solutions") await solutionsGate;
      request.onDispatched?.();
      request.onAccepted?.({});
      const output = request.stage === "solutions"
        ? { options: [{
          mechanism: "Reconcile local exports", description: "Compare the two claim exports in a local workbook.",
          keyAssumption: "Both exports contain stable claim IDs.",
          whyCurrentApproachMaySuffice: "The current manual reconciliation may be sufficient.",
          supportingEvidenceIds: receivedEvidenceId ? [receivedEvidenceId] : [], contraryEvidenceIds: [], unknowns: [],
          respectsOffLimits: true, respectsOffLimitsWhy: "Uses local files only.",
        }] }
        : {
          assessments: [{
            candidateId: (request.workOrder.inputs as { candidateIds: string[] }).candidateIds[0],
            decision: "distinct", reason: "A local reconciliation workflow is distinct from saved approaches.",
            matchingSolutionId: null, citedEvidenceIds: [],
          }],
        };
      return {
        output: request.schema.parse(output),
        metadata: {
          model: request.model, prompt: { id: "fixture", sha256: "a".repeat(64) },
          usage: { status: "unknown" }, latencyMs: 1, repairCount: 0, providerRequestIds: [], attempts: [],
        },
      };
    },
  };
  const events: string[] = [];
  const engine = new ResearchEngine({ db, modelClients: {
    fixture: model, "fixture-fallback": model, "fixture-review": model,
  }, onEvent: (event) => events.push(event.type) });
  try {
    const item = db.immediateTransaction(() => {
      const workflows = new WorkflowRepository(db);
      const created = workflows.createWorkItem({ sessionId: "session", kind: "generate-ideas",
        scopeKey: "review-model-override", state: "ready", input: {
          reviewModel: { providerId: "fixture-review", modelId: "review" }, reviewReasoningEffort: "high",
          generationAngle, generationEvidence,
        },
      });
      workflows.reserveBudget({ sessionId: "session", workItemId: created.id,
        operationKey: `ideas:${created.id}`, kind: "model-call", reservedUnits: 4 });
      return created;
    });
    const runId = await engine.startKnownProblem("thread", scope, "Claims require manual reconciliation", config,
      { sessionId: "session", purpose: "known-problem", onRunCreated: (createdRunId) => {
        db.immediateTransaction(() => new WorkflowRepository(db).updateWorkItem(item.id, "running",
          { outputRefs: { runId: createdRunId } }));
        return true;
      } });
    releaseSolutions();
    await waitUntil(() => !engine.getActiveRunIds().has(runId));
    expect(stages).toEqual(["solutions:fixture", "solution-set-review:fixture-review"]);
    expect(receivedAngle).toEqual(generationAngle);
    const savedSource = db.db.prepare(`SELECT id, provider_source_id, retrieved_text FROM sources
      WHERE research_run_id = ? AND canonical_url = ?`).get(runId, generationEvidence[0]!.url) as {
      id: string; provider_source_id: string; retrieved_text: string;
    };
    expect(savedSource.provider_source_id).toBe(generationEvidence[0]!.id);
    expect(savedSource.retrieved_text).toBe(generationEvidence[0]!.text);
    expect(String(receivedEvidenceId)).toBe(savedSource.id);
    const savedSolutions = db.db.prepare(`SELECT input_json FROM stage_results
      WHERE research_run_id = ? AND stage_id = 'solutions'`).get(runId) as { input_json: string };
    expect(JSON.parse(savedSolutions.input_json)).toMatchObject({ generationAngle,
      generationEvidenceSourceIds: [savedSource.id] });
    const cited = db.db.prepare(`SELECT supporting_evidence_ids_json FROM solutions
      WHERE research_run_id = ?`).get(runId) as { supporting_evidence_ids_json: string };
    expect(JSON.parse(cited.supporting_evidence_ids_json)).toEqual([savedSource.id]);
    const runStatus = db.db.prepare("SELECT status, completion_reason FROM research_runs WHERE id = ?")
      .get(runId) as { status: string; completion_reason: string | null };
    expect(runStatus).toEqual({ status: "completed", completion_reason: null });
    expect(events).toContain("run-completed");
    const checkpoint = db.db.prepare(`
      SELECT context_json FROM stage_results
      WHERE research_run_id = ? AND stage_id = 'solution-set-review'
    `).get(runId) as { context_json: string } | undefined;
    const context = JSON.parse(checkpoint!.context_json) as {
      solutionSetReview: { acceptedSolutionIds: string[]; decisions: Array<{ status: string; reason: string }> };
    };
    const savedIds = db.db.prepare("SELECT id FROM solutions WHERE research_run_id = ?").all(runId) as Array<{ id: string }>;
    expect(context.solutionSetReview.acceptedSolutionIds).toEqual(savedIds.map((row) => row.id));
    expect(context.solutionSetReview.decisions[0]).toMatchObject({
      status: "accepted", reason: "A local reconciliation workflow is distinct from saved approaches.",
    });
    expect(new OpportunityRepository(db).familyView("thread").reviewStatus).toBe("not-reviewed");
    const attempts = db.db.prepare("SELECT stage_key, status FROM generation_attempts WHERE research_run_id = ? ORDER BY created_at, rowid")
      .all(runId) as Array<{ stage_key: string; status: string }>;
    expect(attempts).toEqual([
      { stage_key: "solutions", status: "completed" },
      { stage_key: "solution-set-review", status: "completed" },
    ]);
  } finally {
    await engine.shutdown();
    db.close();
  }
});

test("a startup workflow uses bounded collection review and rejects a process-only option", async () => {
  configurePromptPaths({ bundledDir: join(process.cwd(), "prompts"), overrideDir: null });
  const directory = mkdtempSync(join(tmpdir(), "scraply-startup-review-"));
  directories.push(directory);
  const db = new DatabaseClient(join(directory, "scraply.db"));
  const now = new Date().toISOString();
  db.db.prepare("INSERT INTO threads (id,title,status,created_at,updated_at) VALUES ('startup','Project','configuring',?,?)")
    .run(now, now);
  const scope = { title: "Repair approvals", audience: "Independent repair shops", domain: "Automotive repair",
    observations: "Revised estimates wait for signoff", offLimits: [] };
  const config = RunConfigSchema.parse({
    configVersion: 2, workflowVersion: 2, searchProvider: "exa", explorationPurpose: "startup-opportunities",
    model: { providerId: "fixture", modelId: "fixture" }, reasoningEffort: "low",
    discoveryDepth: "quick", maxRunMinutes: 5, ideaCount: 2,
    opportunityExploration: { targetFamilies: 2, batchSize: 4, maxExpansionRounds: 1,
      maxRawCandidates: 4, maxModelCalls: 5, maxSearches: 1, allowExploratoryProblems: false },
  });
  db.immediateTransaction(() => new WorkflowRepository(db).createSession({
    id: "startup-session", threadId: "startup", purpose: "known-problem", mode: "babysit",
    remainingMs: 300_000,
    contract: {
      contractVersion: 1, purpose: "known-problem", mode: "babysit", brief: "Sell an approval workflow",
      scope, runConfig: config, targets: { kind: "project", ideaCount: 2 },
      ideas: { model: config.model, reasoningEffort: "low" },
      limits: { maxMinutes: 5, maxModelCalls: 4, maxSearches: 0 },
      instructions: {}, resolvedInstructions: { research: "", ideas: "", review: "" },
      instructionHashes: { research: "hash", ideas: "hash", review: "hash" },
    },
  }));
  const startup = {
    mechanism: "Approval relay", description: "Route revised estimates for paid shop approval.",
    keyAssumption: "Shops pay to shorten approval wait", whyCurrentApproachMaySuffice: "Phone calls can work at low volume.",
    supportingEvidenceIds: [], contraryEvidenceIds: [], unknowns: ["Payment willingness"],
    respectsOffLimits: true, respectsOffLimitsWhy: "No excluded behavior.",
    startupOpportunity: {
      opportunityType: "startup-opportunity", payingCustomerSegment: "Independent repair shops",
      trigger: "A revised estimate needs customer signoff", existingSubstitute: "Phone calls and notes",
      gapAssessment: { kind: "hypothesis", description: "Demand requires testing.", evidenceIds: [] },
      smallestSellableWorkflow: "Collect and route signed approval",
      firstCustomerRoute: "Direct outreach to five shop owners",
      disconfirmingDemandTest: "Five qualified shops refuse a paid pilot.",
    },
    focusedDemandTest: {
      schemaVersion: 1, assumption: { id: "approval-relay-adoption", category: "adoption",
        testableClaim: "Shops will use the approval relay in a concierge pilot.",
        decisionImpact: "A failed pilot would stop this workflow.",
        selectionReason: "Adoption is the earliest uncertain behavior." },
      methodSummary: "Offer five qualified shops a concierge pilot.",
      disconfirmingObservation: "All five qualified shops decline or abandon the pilot.",
      paymentTerms: null,
    },
  };
  const processOption = { ...startup, mechanism: "Better phone script", description: "Standardize the existing phone script.",
    startupOpportunity: { ...startup.startupOpportunity, opportunityType: "process-improvement" } };
  db.db.prepare(`INSERT INTO research_runs
    (id, thread_id, status, config_json, workflow_version, created_at, updated_at)
    VALUES ('older-startup-run', 'startup', 'completed', ?, 2, ?, ?)`)
    .run(JSON.stringify(config), now, now);
  db.db.prepare(`INSERT INTO problems
    (id, discovery_run_id, statement, why_it_persists, affected, scale_estimate,
      verdict, verdict_reason, verdict_source_ids_json, created_at)
    VALUES ('older-startup-problem', 'older-startup-run', 'Shops wait for approval', 'Phone calls stall',
      'Repair shops', 'Unknown', 'confirmed', 'Saved baseline', '[]', ?)`)
    .run(now);
  db.db.prepare("UPDATE research_runs SET problem_id = 'older-startup-problem' WHERE id = 'older-startup-run'").run();
  const insertOlder = db.db.prepare(`INSERT INTO solutions
    (id, problem_id, research_run_id, option_position, mechanism, description,
      respects_off_limits, respects_off_limits_why, startup_opportunity_json, created_at)
    VALUES (?, 'older-startup-problem', 'older-startup-run', ?, ?, ?, 1, 'No excluded behavior.', ?, ?)`);
  insertOlder.run("legacy-representative", 0, "Existing approval relay", "A previously reviewed paid approval workflow.",
    JSON.stringify(startup.startupOpportunity), now);
  insertOlder.run("inactive-representative", 1, "Old call script", "A retired family of call scripts.",
    JSON.stringify(startup.startupOpportunity), now);
  const insertFamily = db.db.prepare(`INSERT INTO opportunity_families
    (id, thread_id, representative_option_id, title, summary, active, created_at, updated_at)
    VALUES (?, 'startup', ?, ?, ?, ?, ?, ?)`);
  insertFamily.run("legacy-family", "legacy-representative", "Approval relay", "Previously accepted paid workflow", 1, now, now);
  insertFamily.run("inactive-family", "inactive-representative", "Call script", "No longer an active family", 0, now, now);
  const insertMembership = db.db.prepare(`INSERT INTO opportunity_membership_decisions
    (id, thread_id, option_id, family_id, relationship, state, reason, actor, created_at)
    VALUES (?, 'startup', ?, ?, 'separate-business', 'accepted', 'Saved review', 'user', ?)`);
  insertMembership.run("legacy-membership", "legacy-representative", "legacy-family", now);
  insertMembership.run("inactive-membership", "inactive-representative", "inactive-family", now);
  db.immediateTransaction(() => new WorkflowRepository(db).createWorkItem({
    sessionId: "startup-session", kind: "known-problem", scopeKey: "launch-inventory",
    input: { familyBaseline: { acceptedFamilyCount: 1, acceptedFamilyIds: ["legacy-family"],
      candidateInventoryIds: ["legacy-representative", "inactive-representative"], existingCount: 1 } },
  }));
  insertOlder.run("concurrent-after-launch", 2, "Later outside candidate", "Added by another session after launch.",
    JSON.stringify(startup.startupOpportunity), now);
  db.db.prepare(`INSERT INTO research_runs
    (id, thread_id, workflow_session_id, problem_id, status, config_json, workflow_version, created_at, updated_at)
    VALUES ('same-session-prior-run', 'startup', 'startup-session', 'older-startup-problem', 'completed', ?, 2, ?, ?)`)
    .run(JSON.stringify(config), now, now);
  db.db.prepare(`INSERT INTO solutions
    (id, problem_id, research_run_id, option_position, mechanism, description,
      respects_off_limits, respects_off_limits_why, startup_opportunity_json, created_at)
    VALUES ('session-added', 'older-startup-problem', 'same-session-prior-run', 0,
      'Fresh approval flow', 'Generated earlier in this session.', 1, 'No excluded behavior.', ?, ?)`)
    .run(JSON.stringify(startup.startupOpportunity), now);
  const stages: string[] = [];
  let acceptedInventory: string[] = [];
  let otherInventory: string[] = [];
  let releaseSolutions: () => void = () => {};
  const gate = new Promise<void>((resolve) => { releaseSolutions = resolve; });
  const model: StructuredModelClient = {
    async structuredCompletion(request) {
      stages.push(request.stage);
      if (request.stage === "solutions") await gate;
      request.onDispatched?.();
      request.onAccepted?.({});
      const output = request.stage === "solutions"
        ? { options: [startup, processOption] }
        : { assessments: (request.workOrder.inputs as { candidateIds: string[] }).candidateIds.map((candidateId) => ({
          candidateId, decision: "distinct", reason: "Proposed a separate operating method.",
          matchingSolutionId: null, citedEvidenceIds: [],
        })) };
      if (request.stage === "solution-set-review") {
        const inputs = request.workOrder.inputs as {
          existingSolutions: Array<{ id: string }>;
          otherExistingSolutions: Array<{ id: string }>;
        };
        acceptedInventory = inputs.existingSolutions.map((item) => item.id);
        otherInventory = inputs.otherExistingSolutions.map((item) => item.id);
      }
      return { output: request.schema.parse(output), metadata: {
        model: request.model, prompt: { id: "fixture", sha256: "a".repeat(64) },
        usage: { status: "unknown" }, latencyMs: 1, repairCount: 0, providerRequestIds: [], attempts: [],
      } };
    },
  };
  const engine = new ResearchEngine({ db, modelClients: { fixture: model }, onEvent: () => {} });
  try {
    const runId = await engine.startKnownProblem("startup", scope, "Revised estimates wait for signoff", config,
      { sessionId: "startup-session", purpose: "known-problem" });
    db.immediateTransaction(() => {
      const workflows = new WorkflowRepository(db);
      const item = workflows.createWorkItem({ sessionId: "startup-session", kind: "generate-ideas",
        scopeKey: "startup-ideas", state: "ready", input: {} });
      workflows.updateWorkItem(item.id, "running", { outputRefs: { runId } });
      workflows.reserveBudget({ sessionId: "startup-session", workItemId: item.id,
        operationKey: `ideas:${item.id}`, kind: "model-call", reservedUnits: 4 });
    });
    db.db.prepare(`INSERT INTO research_runs
      (id, thread_id, problem_id, status, config_json, workflow_version, created_at, updated_at)
      VALUES ('accepted-after-launch-run', 'startup', 'older-startup-problem', 'completed', ?, 2, ?, ?)`)
      .run(JSON.stringify(config), now, now);
    db.db.prepare(`INSERT INTO solutions
      (id, problem_id, research_run_id, option_position, mechanism, description,
        respects_off_limits, respects_off_limits_why, startup_opportunity_json, created_at)
      VALUES ('accepted-after-launch', 'older-startup-problem', 'accepted-after-launch-run', 0,
        'New paid booking flow', 'A separate family accepted while generation is running.',
        1, 'No excluded behavior.', ?, ?)`)
      .run(JSON.stringify(startup.startupOpportunity), now);
    insertFamily.run("accepted-after-launch-family", "accepted-after-launch", "Booking flow", "Accepted after launch", 1, now, now);
    insertMembership.run("accepted-after-launch-membership", "accepted-after-launch", "accepted-after-launch-family", now);
    releaseSolutions();
    await waitUntil(() => !engine.getActiveRunIds().has(runId));
    expect(stages).toEqual(["solutions", "solution-set-review"]);
    expect(acceptedInventory).toEqual(["accepted-after-launch", "legacy-representative"]);
    expect(otherInventory).toEqual(["session-added", "inactive-representative"]);
    expect([...acceptedInventory, ...otherInventory]).not.toContain("concurrent-after-launch");
    const run = db.db.prepare("SELECT status FROM research_runs WHERE id = ?").get(runId) as { status: string };
    expect(run.status).toBe("completed");
    const review = db.db.prepare(`SELECT context_json FROM stage_results
      WHERE research_run_id = ? AND stage_id = 'solution-set-review'`).get(runId) as { context_json: string };
    const decisions = (JSON.parse(review.context_json) as { solutionSetReview: { decisions: Array<{ status: string }> } })
      .solutionSetReview.decisions;
    expect(decisions.map((decision) => decision.status)).toEqual(["accepted", "rejected"]);
    const legacy = db.db.prepare("SELECT COUNT(*) AS count FROM opportunity_explorations WHERE thread_id = 'startup'")
      .get() as { count: number };
    expect(legacy.count).toBe(0);

    const opportunities = new OpportunityRepository(db);
    const firstProjection = db.immediateTransaction(() => opportunities.materializeSolutionSetReviews("startup"));
    const newOptions = db.db.prepare("SELECT id FROM solutions WHERE research_run_id = ? ORDER BY option_position")
      .all(runId) as Array<{ id: string }>;
    expect(firstProjection.projectedOptionIds).toEqual(newOptions.map((option) => option.id));
    const view = opportunities.familyView("startup");
    expect(view.acceptedFamilyCount).toBe(3);
    expect(view.reviewStatus).toBe("completed");
    expect(view.unreviewedOptionIds).toEqual(["concurrent-after-launch", "session-added"]);
    expect(view.families.find((family) => family.representativeOptionId === newOptions[0]!.id))
      .toMatchObject({ counted: true, members: [{ optionId: newOptions[0]!.id, relationship: "separate-business" }] });
    expect(view.unresolved.map((item) => item.membership.optionId)).toEqual([newOptions[1]!.id]);
    const exported = opportunities.exportReview("startup");
    expect(exported.view.acceptedFamilyCount).toBe(3);
    expect(exported.membershipHistory.filter((item) => newOptions.some((option) => option.id === item.optionId)))
      .toHaveLength(2);

    expect(db.immediateTransaction(() => opportunities.materializeSolutionSetReviews("startup")))
      .toEqual({ projectedOptionIds: [] });
    expect(opportunities.exportReview("startup").membershipHistory).toHaveLength(exported.membershipHistory.length);
    opportunities.editMembership("startup", {
      operation: "mark-uncertain", optionId: newOptions[0]!.id, reason: "A user wants more evidence",
    });
    expect(opportunities.familyView("startup").acceptedFamilyCount).toBe(2);
    expect(db.immediateTransaction(() => opportunities.materializeSolutionSetReviews("startup")))
      .toEqual({ projectedOptionIds: [] });
    const history = opportunities.exportReview("startup").membershipHistory
      .filter((item) => item.optionId === newOptions[0]!.id);
    expect(history).toHaveLength(2);
    expect(history.map((item) => item.actor)).toEqual(["model", "user"]);
  } finally {
    await engine.shutdown();
    db.close();
  }
});
