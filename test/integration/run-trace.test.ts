import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { getRunTrace } from "../../src/core/run-trace";
import { DatabaseClient } from "../../src/db/client";
import { DiscoveryRepository } from "../../src/db/repositories/discovery";
import { GenerationAttemptRepository } from "../../src/db/repositories/generation-attempts";
import { ResearchRunRepository } from "../../src/db/repositories/research-runs";
import { WorkflowV2Repository } from "../../src/db/repositories/workflow-v2";
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
