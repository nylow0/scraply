import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { getRunTrace, getRunTraceStep, savedSearchKey, selectSessionEvidenceRunId } from "../../src/core/run-trace";
import { prepareWorkflowSearch, recordWorkflowSearchTerminal } from "../../src/core/workflow-search-attempts";
import { DatabaseClient } from "../../src/db/client";
import { DiscoveryRepository } from "../../src/db/repositories/discovery";
import { GenerationAttemptRepository } from "../../src/db/repositories/generation-attempts";
import { ResearchRunRepository } from "../../src/db/repositories/research-runs";
import { WorkflowV2Repository } from "../../src/db/repositories/workflow-v2";
import { WorkflowRepository } from "../../src/db/repositories/workflows";
import { OpportunityExplorationRepository } from "../../src/db/repositories/opportunity-exploration";
import type { StructuredStageRequest } from "../../src/providers/structured";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";

const fixtures: Array<{ db: DatabaseClient; directory: string }> = [];
afterEach(() => {
  for (const { db, directory } of fixtures.splice(0)) {
    db.close();
    try { rmSync(directory, { recursive: true, force: true }); }
    catch { /* SQLite can keep the WAL handle until the test process exits on Windows. */ }
  }
});

function fixture(goalFit = false) {
  const directory = mkdtempSync(join(tmpdir(), "scraply-run-trace-"));
  const db = new DatabaseClient(join(directory, "trace.db"));
  fixtures.push({ db, directory });
  const now = new Date().toISOString();
  db.db.prepare("INSERT INTO threads (id,title,status,created_at,updated_at) VALUES ('project','Trace','configuring',?,?)").run(now, now);
  const config = { ...DEFAULT_RUN_CONFIG, workflowVersion: 2 as const, ideaCount: 1 };
  const { problemId } = new DiscoveryRepository(db).createKnownProblemRoot("project", {
    title: "Filing", domain: "Filing", audience: "Owners", observations: "Repeated entries", offLimits: [],
  }, "Owners repeat filing entries", config);
  const runs = new ResearchRunRepository(db);
  const runId = runs.create("project", config, problemId).runId;
  const repository = new WorkflowV2Repository(db);
  db.immediateTransaction(() => repository.saveSolutionOptions(runId, problemId, [{
    id: "idea", mechanism: "Local comparison", description: "Compare exports and flag repeated entries",
    keyAssumption: "Stable record IDs", whyCurrentApproachMaySuffice: "Manual filing may be enough",
    supportingEvidenceIds: [], contraryEvidenceIds: [], unknowns: [],
    respectsOffLimits: true, respectsOffLimitsWhy: "Local files only",
  }]));
  if (goalFit) {
    const frame = JSON.stringify({ areas: [], successCriteria: [{ id: "useful", name: "Reduce entries", weight: "must" }] });
    db.db.prepare(`INSERT INTO research_frames (id, thread_id, version, known_problem, draft_json, approved_json, sources_json, created_at, approved_at)
      VALUES ('frame', 'project', 1, 1, ?, ?, '[]', ?, ?)`).run(frame, frame, now, now);
    db.db.prepare("UPDATE research_runs SET frame_id = 'frame' WHERE id = ?").run(runId);
    db.db.prepare("INSERT INTO workflow_snapshots VALUES (?, 'goal-fit', ?)").run(runId, JSON.stringify({ version: 1 }));
  }
  runs.finish(runId, "completed");

  function saveReview(context: unknown, options: { preliminary?: boolean; fit?: "fails" | "unknown" | "meets" } = {}) {
    const criteriaFit = options.fit ? [{ criterionId: "useful", criterionName: "Reduce entries", mustHave: true,
      status: options.fit, evidenceIds: [], note: "Saved independent assessment" }] : undefined;
    const promptText = "Review the saved filing option.";
    const promptHash = createHash("sha256").update(promptText).digest("hex");
    db.immediateTransaction(() => repository.saveStageResult({
      researchRunId: runId, stageId: "solution-set-review", schemaRevision: criteriaFit ? 2 : 1,
      selectionId: options.preliminary ? `preliminary:${problemId}` : problemId,
      context, output: { assessments: [{ candidateId: "idea", decision: "distinct", reason: "A distinct local workflow",
        matchingSolutionId: null, citedEvidenceIds: [], ...(criteriaFit ? { criteriaFit } : {}) }] },
      prompt: { stageId: "solution-set-review", filename: "workflow-v2-solution-set-review.md", revision: 1,
        source: "bundled", currentBundledSha256: promptHash, overrideBaseline: null, resolvedSha256: promptHash, text: promptText },
      schema: {}, inputs: { candidateIds: ["idea"] }, evidence: [],
      runtimePrompt: { id: "trace-fixture", sha256: "a".repeat(64) }, effectiveRequest: {},
    }));
    if (criteriaFit && !options.preliminary) db.db.prepare("UPDATE solutions SET reviewed_criteria_fit_json = ? WHERE id = 'idea'")
      .run(JSON.stringify(criteriaFit));
  }

  function prepareAttempt() {
    const repository = new GenerationAttemptRepository(db);
    const request: StructuredStageRequest<{ value: string }> = {
      generationId: randomUUID(), stage: "solutions", model: { providerId: "fixture", modelId: "fixture" }, reasoningEffort: "low",
      workOrder: { stage: "solutions", instruction: "Compare filing exports", goal: "Reduce repeated entries", definitionOfDone: ["Return a comparison"] },
      evidence: [], schema: z.object({ value: z.string() }), jsonSchema: { type: "object" }, repairPolicy: "one_retry",
    };
    return { repository, id: repository.prepare(runId, request).id };
  }
  return { db, runId, saveReview, prepareAttempt };
}

describe("Trace session evidence selection", () => {
  function sessionRuns(preparation: "metadata" | "work-item" | "legacy", includeDiscovery = true) {
    const f = fixture();
    const config = { ...DEFAULT_RUN_CONFIG, workflowVersion: 2 as const };
    const workflows = new WorkflowRepository(f.db);
    f.db.immediateTransaction(() => workflows.createSession({ id: "research-session", threadId: "project", purpose: "discovery",
      mode: "babysit", contract: {}, remainingMs: 60_000 }));
    const runs = new ResearchRunRepository(f.db);
    const link = { sessionId: "research-session", purpose: "discovery" as const };
    const frameRunId = runs.create("project", config, null, undefined, link).runId;
    if (preparation === "metadata") f.db.db.prepare("INSERT INTO workflow_snapshots VALUES (?, 'workflow-kind', ?)")
      .run(frameRunId, JSON.stringify({ kind: "prepare-frame", knownProblem: false }));
    if (preparation === "work-item") f.db.immediateTransaction(() => {
      const task = workflows.createWorkItem({ sessionId: link.sessionId, kind: "prepare-frame", scopeKey: "initial-research", input: {}, state: "ready" });
      workflows.updateWorkItem(task.id, "running", { outputRefs: { runId: frameRunId } });
      workflows.updateWorkItem(task.id, "succeeded", { outputRefs: { runId: frameRunId } });
    });
    runs.finish(frameRunId, "completed");
    const discoveryRunId = includeDiscovery ? runs.create("project", config, null, undefined, link).runId : null;
    if (discoveryRunId) runs.finish(discoveryRunId, "completed");
    return { ...f, frameRunId, discoveryRunId, sessionId: link.sessionId };
  }

  test.each(["metadata", "work-item"] as const)("saved preparation %s does not replace discovery evidence or derived candidate support", preparation => {
    const f = sessionRuns(preparation);
    const runId = f.discoveryRunId!;
    const now = new Date().toISOString();
    const sources = [1, 2].map(index => ({ id: `source-${index}`, providerSourceId: null, canonicalUrl: `https://owners.example/${index}`,
      title: "Owner account", retrievedText: "I repeat filing entries", author: null, publishedAt: null,
      contentHash: "a".repeat(64), retrievedAt: now }));
    const factors = sources.map(source => ({ id: `factor-${source.id}`, sourceId: source.id, subject: "Owner",
      behavior: "Repeats filing entries", quote: source.retrievedText, harvestMode: "audience" as const, modelConfidence: 0.8,
      sourceRole: "firsthand" as const, audienceFit: "intended-buyer" as const, independentSourceKey: source.id }));
    new DiscoveryRepository(f.db).persistFactors(runId, sources, factors);
    const candidate = { statement: "Owners repeat filing entries", whyItPersists: "Manual copying", affected: "Owners", scaleEstimate: "Unknown",
      scaleBasisFactorId: null, factorIds: factors.map(factor => factor.id), alternativeExplanations: [], unknowns: [],
      intendedBuyerEvidenceFactorIds: factors.map(factor => factor.id), evidenceGap: null };
    const repository = new WorkflowV2Repository(f.db);
    for (const stageId of ["problem-candidates", "problem-kill"] as const) {
      const promptText = "Read the saved owner accounts.";
      const promptHash = createHash("sha256").update(promptText).digest("hex");
      f.db.immediateTransaction(() => repository.saveStageResult({ researchRunId: runId, stageId, selectionId: stageId === "problem-kill" ? "candidate" : null,
        context: {}, output: stageId === "problem-candidates" ? { problems: [candidate] } : { verdict: "confirmed", verdictReason: "Two independent owner accounts",
          verdictSourceIds: sources.map(source => source.id), unresolvedAssumptions: [], wouldChangeConclusion: [],
          intendedBuyerEvidenceFactorIds: candidate.intendedBuyerEvidenceFactorIds, evidenceGap: null },
        prompt: { stageId, filename: `workflow-v2-${stageId}.md`, revision: 1, source: "bundled", currentBundledSha256: promptHash,
          overrideBaseline: null, resolvedSha256: promptHash, text: promptText }, schema: {}, inputs: {},
        evidence: [{ sourceId: "candidate", content: { candidate } }], runtimePrompt: { id: "trace-fixture", sha256: "a".repeat(64) }, effectiveRequest: {} }));
    }
    const checkpointRows = f.db.db.prepare("SELECT * FROM stage_results ORDER BY rowid").all();
    const changes = f.db.db.prepare("SELECT total_changes() AS count").get();
    expect(selectSessionEvidenceRunId(f.db, f.sessionId)).toBe(runId);
    for (const requestedRunId of [f.frameRunId, runId]) {
      const trace = getRunTrace(f.db, requestedRunId);
      expect(trace.metrics).toMatchObject({ factors: 2, totalSources: 2, qualifyingObservations: 2,
        candidateFunnel: { confirmed: 1 }, qualifyingPerAssessedCandidate: 2 });
      expect(trace.candidates).toContainEqual(expect.objectContaining({ derived: true, state: "confirmed", qualifyingObservations: 2, independentSources: 2 }));
    }
    expect(f.db.db.prepare("SELECT * FROM stage_results ORDER BY rowid").all()).toEqual(checkpointRows);
    expect(f.db.db.prepare("SELECT total_changes() AS count").get()).toEqual(changes);
  });

  test("legacy unmarked discovery keeps its original first-run selection", () => {
    const f = sessionRuns("legacy");
    expect(selectSessionEvidenceRunId(f.db, f.sessionId)).toBe(f.frameRunId);
  });

  test("a frame-only session retains its requested context without inventing discovery", () => {
    const f = sessionRuns("metadata", false);
    expect(selectSessionEvidenceRunId(f.db, f.sessionId)).toBeNull();
    expect(getRunTrace(f.db, f.frameRunId).metrics).toMatchObject({ factors: 0, qualifyingObservations: 0 });
  });

  test("known-problem evidence keeps the requested-run fallback", () => {
    const f = fixture();
    const root = f.db.db.prepare("SELECT discovery_run_id FROM problems WHERE verdict = 'user-asserted'").get() as { discovery_run_id: string };
    f.db.immediateTransaction(() => {
      new WorkflowRepository(f.db).createSession({ id: "known-session", threadId: "project", purpose: "known-problem", mode: "babysit", contract: {}, remainingMs: 60_000 });
      f.db.db.prepare("UPDATE research_runs SET workflow_session_id = 'known-session', purpose = 'known-problem' WHERE id = ?").run(root.discovery_run_id);
    });
    expect(selectSessionEvidenceRunId(f.db, "known-session")).toBeNull();
    expect(getRunTrace(f.db, root.discovery_run_id).candidates).toContainEqual(expect.objectContaining({ state: "user-asserted", derived: false }));
  });
});

describe("Trace committed idea decisions", () => {
  test.each([
    { status: "rejected", fit: "fails" as const, reason: "Fails an approved must-have" },
    { status: "unresolved", fit: "unknown" as const, reason: "Novelty search unavailable" },
  ])("a raw distinct review classified $status is not accepted", ({ status, fit, reason }) => {
    const f = fixture(true);
    f.saveReview({ preliminary: true }, { preliminary: true, fit: "unknown" });
    f.saveReview({ solutionSetReview: { acceptedSolutionIds: [], decisions: [{ candidateId: "idea", status, reason }] } }, { fit });
    const checkpoints = f.db.db.prepare("SELECT * FROM stage_results ORDER BY rowid").all();
    const changes = f.db.db.prepare("SELECT total_changes() AS count").get();
    expect(getRunTrace(f.db, f.runId).metrics).toMatchObject({ ideas: 1, acceptedIdeas: 0, acceptedIdeasFailingMustHave: 0 });
    expect(f.db.db.prepare("SELECT * FROM stage_results ORDER BY rowid").all()).toEqual(checkpoints);
    expect(f.db.db.prepare("SELECT total_changes() AS count").get()).toEqual(changes);
  });

  test("preliminary acceptance does not count before a final checkpoint", () => {
    const f = fixture(true);
    f.saveReview({ solutionSetReview: { acceptedSolutionIds: ["idea"], decisions: [{ candidateId: "idea", status: "accepted" }] } },
      { preliminary: true, fit: "unknown" });
    expect(getRunTrace(f.db, f.runId).metrics).toMatchObject({ acceptedIdeas: 0, acceptedIdeasFailingMustHave: 0 });
  });

  test("classified accepted IDs remain readable without a decisions array", () => {
    const f = fixture();
    f.saveReview({ solutionSetReview: { acceptedSolutionIds: ["idea"] } });
    expect(getRunTrace(f.db, f.runId).metrics).toMatchObject({ acceptedIdeas: 1, acceptedIdeasFailingMustHave: null });
  });

  test("legacy final acceptance stays readable with unknown goal fit", () => {
    const f = fixture();
    f.saveReview({ developmentContext: {} });
    expect(getRunTrace(f.db, f.runId).metrics).toMatchObject({ ideas: 1, acceptedIdeas: 1, acceptedIdeasFailingMustHave: null });
  });

  test("a classified context without accepted decisions does not fall back to raw acceptance", () => {
    const f = fixture();
    f.saveReview({ solutionSetReview: { decisions: [] } });
    expect(getRunTrace(f.db, f.runId).metrics).toMatchObject({ acceptedIdeas: 0, acceptedIdeasFailingMustHave: null });
  });
});

describe("Trace physical model calls", () => {
  test("counts an initial and schema repair call once each within one durable row", () => {
    const f = fixture();
    const attempt = f.prepareAttempt();
    const calls = ["initial", "schema_repair"].map(kind => ({ attempt: kind, model: { providerId: "fixture", modelId: "fixture" },
      usage: { status: "unknown" }, cost: { status: "unknown" }, latencyMs: 1, providerCompletion: "confirmed" }));
    attempt.repository.recordTerminal(attempt.id, { status: "completed", terminalKind: "completed", attemptMetadata: { attempts: calls } });
    expect(getRunTrace(f.db, f.runId).metrics.modelCalls).toBe(2);
  });

  test("reads legacy physical usage arrays when parent metadata has no attempts", () => {
    const f = fixture();
    const attempt = f.prepareAttempt();
    attempt.repository.recordTerminal(attempt.id, { status: "completed", terminalKind: "completed",
      attemptMetadata: { attempts: [] }, usage: [{ status: "unknown" }, { status: "unknown" }] });
    expect(getRunTrace(f.db, f.runId).metrics.modelCalls).toBe(2);
  });

  test("prepared and never-dispatched rows count zero without using a legacy ledger fallback", () => {
    const f = fixture();
    f.prepareAttempt();
    const neverDispatched = f.prepareAttempt();
    neverDispatched.repository.recordTerminal(neverDispatched.id, { status: "interrupted", terminalKind: "never-dispatched" });
    const now = new Date().toISOString();
    f.db.db.prepare(`INSERT INTO cost_ledger (id,research_run_id,operation,provider,model,reservation_usd,status,created_at,updated_at)
      VALUES ('reservation',?,'solutions','fixture','fixture',0,'reserved',?,?)`).run(f.runId, now, now);
    const trace = getRunTrace(f.db, f.runId);
    expect(trace.metrics.modelCalls).toBe(0);
    expect(trace.warnings.some(warning => warning.includes("unknown provider completion"))).toBe(false);
  });

  test("lost provider completion retains its recorded attempt and an explicit unknown warning", () => {
    const f = fixture();
    const attempt = f.prepareAttempt();
    attempt.repository.markDispatched(attempt.id);
    attempt.repository.recordTerminal(attempt.id, { status: "interrupted", terminalKind: "process-lost" });
    const trace = getRunTrace(f.db, f.runId);
    expect(trace.metrics.modelCalls).toBe(1);
    expect(trace.warnings).toContain("Some recorded model attempts have unknown provider completion. They are included in the call count.");
  });
});

describe("Trace physical search dispatches", () => {
  const query = "bookkeeper matching errors";
  const parameters = { numResults: 5, maxCharacters: 4000, route: "firsthand-web" };
  const input = { query, parameters, provider: "exa" as const, key: savedSearchKey(query, parameters, "exa") };

  function managedSearch(f: ReturnType<typeof fixture>, status: "completed" | "prepared" | "failed-before-dispatch") {
    const workflows = new WorkflowRepository(f.db);
    f.db.immediateTransaction(() => {
      workflows.createSession({ id: "session", threadId: "project", purpose: "discovery", mode: "babysit", contract: {}, remainingMs: 60_000 });
      workflows.createWorkItem({ id: "search-task", sessionId: "session", kind: "evidence-check", scopeKey: "owner", input: {}, state: "ready" });
      f.db.db.prepare("UPDATE research_runs SET workflow_session_id = 'session' WHERE id = ?").run(f.runId);
    });
    const query = "managed owner follow-up";
    const request = { key: "owner-follow-up", query, route: "firsthand-web", evidenceNeeded: "Another owner account" };
    const repository = new OpportunityExplorationRepository(f.db);
    const attempt = f.db.immediateTransaction(() => repository.prepareAttempt("project", {
      stageKey: "investigator-search:owner-follow-up", stageName: "investigator-search", input: { request, parameters: { ...parameters, provider: "exa" } },
      model: { providerId: "exa", modelId: "search", reasoningEffort: "bounded" }, promptVersion: "fixture", promptText: query, workItemId: "search-task",
    }, "session"));
    if (attempt.kind !== "prepared") throw new Error("Expected a fresh managed fixture");
    f.db.immediateTransaction(() => {
      if (status === "completed") {
        repository.markAttemptDispatched("project", attempt.attemptId, "none", "session");
        repository.completeAttempt("project", attempt.attemptId, { sources: [] }, "session");
      } else if (status === "failed-before-dispatch") repository.failAttempt("project", attempt.attemptId, "Provider unavailable before dispatch", true, "session");
      workflows.updateSession("session", 0, { state: "finished", outcome: "partial", runningSince: null });
    });
    return { key: savedSearchKey(query, parameters, "exa"), query, attemptId: attempt.attemptId };
  }

  test("same-query cancellation and replacement remain two physical searches", () => {
    const f = fixture();
    const cancelled = prepareWorkflowSearch(f.db, f.runId, input, []);
    recordWorkflowSearchTerminal(f.db, f.runId, cancelled.id, "cancelled", "Cancelled during the provider request");
    const replacement = prepareWorkflowSearch(f.db, f.runId, input, []);
    recordWorkflowSearchTerminal(f.db, f.runId, replacement.id, "completed");
    f.db.db.prepare("INSERT INTO workflow_snapshots VALUES (?, ?, '[]')").run(f.runId, input.key);
    const trace = getRunTrace(f.db, f.runId);
    expect(trace.metrics.searches).toBe(2);
    expect(trace.steps.filter(step => step.kind === "search").map(step => step.status)).toEqual(["cancelled", "completed"]);
    expect(getRunTraceStep(f.db, f.runId, `search-attempt:${cancelled.id}`).output).toBeNull();
  });

  test.each(["failed", "unknown-dispatch"] as const)("an ordinary %s search remains visible with its UUID and inputs", status => {
    const f = fixture();
    const attempt = prepareWorkflowSearch(f.db, f.runId, input, []);
    if (status === "failed") recordWorkflowSearchTerminal(f.db, f.runId, attempt.id, "failed", "Provider request failed");
    const trace = getRunTrace(f.db, f.runId);
    expect(trace.metrics.searches).toBe(1);
    const step = trace.steps.find(step => step.id === `search-attempt:${attempt.id}`);
    expect(step).toMatchObject({ kind: "search", status, search: { query, provider: "exa", results: [],
      reason: "Search recorded by the workflow.", expectedSourceType: "Not recorded" } });
    const detail = getRunTraceStep(f.db, f.runId, step!.id);
    expect(detail.inputs).toEqual(attempt);
    if (status === "failed") expect(detail.events).toContainEqual({ type: "search-interrupted",
      createdAt: step!.finishedAt!, payload: { attemptId: attempt.id, status, message: "Provider request failed" } });
  });

  test("acknowledged lost requests keep unknown status after a same-query replacement completes", () => {
    const f = fixture();
    const lost = prepareWorkflowSearch(f.db, f.runId, input, []);
    const replacement = prepareWorkflowSearch(f.db, f.runId, input, [lost.id]);
    recordWorkflowSearchTerminal(f.db, f.runId, replacement.id, "completed");
    f.db.db.prepare("INSERT INTO workflow_snapshots VALUES (?, ?, '[]')").run(f.runId, input.key);
    const receipts = f.db.db.prepare("SELECT * FROM workflow_snapshots ORDER BY rowid").all();
    const trace = getRunTrace(f.db, f.runId);
    expect(trace.metrics.searches).toBe(2);
    expect(trace.warnings).toContain("Some recorded search attempts have unknown provider completion. They are included in the search count.");
    const old = getRunTraceStep(f.db, f.runId, `search-attempt:${lost.id}`);
    expect(old.step).toMatchObject({ status: "unknown-dispatch", finishedAt: null, search: { status: "not-saved", results: [] } });
    expect(old.output).toBeNull();
    expect(f.db.db.prepare("SELECT * FROM workflow_snapshots ORDER BY rowid").all()).toEqual(receipts);
  });

  test("managed dispatches and their matching checkpoints count once beside ordinary and legacy searches", () => {
    const f = fixture();
    const managed = managedSearch(f, "completed");
    f.db.db.prepare("INSERT INTO workflow_snapshots VALUES (?, ?, '[]')").run(f.runId, managed.key);
    f.db.db.prepare("INSERT INTO workflow_snapshots VALUES (?, ?, ?)").run(f.runId, managed.key.replace("search:", "search-query:"),
      JSON.stringify({ key: managed.key, query: managed.query, parameters, provider: "exa" }));
    const ordinary = prepareWorkflowSearch(f.db, f.runId, input, []);
    recordWorkflowSearchTerminal(f.db, f.runId, ordinary.id, "completed");
    f.db.db.prepare("INSERT INTO workflow_snapshots VALUES (?, ?, '[]')").run(f.runId, input.key);
    f.db.db.prepare("INSERT INTO workflow_snapshots VALUES (?, ?, '[]')").run(f.runId, savedSearchKey("older different query", parameters));
    const trace = getRunTrace(f.db, f.runId);
    expect(trace.metrics.searches).toBe(3);
    expect(trace.steps.filter(step => step.kind === "search")).toHaveLength(3);
    expect(trace.steps.filter(step => step.kind === "search" && step.search?.query === managed.query)).toHaveLength(1);
  });

  test.each(["prepared", "failed-before-dispatch"] as const)("a managed %s request counts zero", status => {
    const f = fixture();
    managedSearch(f, status);
    const trace = getRunTrace(f.db, f.runId);
    expect(trace.metrics.searches).toBe(0);
    expect(trace.warnings.some(warning => warning.includes("unknown provider completion"))).toBe(false);
  });

  test("legacy successful checkpoints remain readable without dispatch receipts", () => {
    const f = fixture();
    f.db.db.prepare("INSERT INTO workflow_snapshots VALUES (?, ?, '[]')").run(f.runId, input.key);
    const trace = getRunTrace(f.db, f.runId);
    expect(trace.metrics.searches).toBe(1);
    expect(trace.steps.filter(step => step.kind === "search")).toHaveLength(1);
    expect(trace.steps.find(step => step.kind === "search")?.search?.reason).toBe("No matching query plan or query snapshot was saved.");
  });

  test("a legacy query snapshot without a planned reason keeps the generic explanation", () => {
    const f = fixture();
    f.db.db.prepare("INSERT INTO workflow_snapshots VALUES (?, ?, '[]')").run(f.runId, input.key);
    f.db.db.prepare("INSERT INTO workflow_snapshots VALUES (?, ?, ?)").run(f.runId, input.key.replace("search:", "search-query:"), JSON.stringify(input));
    const trace = getRunTrace(f.db, f.runId);
    const search = trace.steps.find(step => step.kind === "search")!;
    expect(search.search).toMatchObject({ reason: "Search recorded by the workflow.", expectedSourceType: "Not recorded" });
    expect(getRunTraceStep(f.db, f.runId, search.id).searches).toContainEqual(expect.objectContaining({ reason: "Search recorded by the workflow." }));
  });

  test("a prepared managed request cannot hide an older paid result with the same identity", () => {
    const f = fixture();
    const managed = managedSearch(f, "prepared");
    f.db.db.prepare("INSERT INTO workflow_snapshots VALUES (?, ?, '[]')").run(f.runId, managed.key);
    const trace = getRunTrace(f.db, f.runId);
    expect(trace.metrics.searches).toBe(1);
    const completed = trace.steps.find(step => step.kind === "search" && step.search?.key === managed.key && step.status === "completed");
    expect(completed).toBeDefined();
    const detail = getRunTraceStep(f.db, f.runId, completed!.id);
    expect(detail.step).toEqual(completed!);
    expect(detail.searches).toContainEqual({ ...completed!.search!, key: managed.key, status: "completed", results: [] });
  });
});
