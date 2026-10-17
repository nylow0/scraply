import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { RunRecovery } from "../../src/core/run-recovery";
import { prepareWorkflowSearch } from "../../src/core/workflow-search-attempts";
import { DatabaseClient } from "../../src/db/client";
import { GenerationAttemptRepository } from "../../src/db/repositories/generation-attempts";
import { OpportunityExplorationRepository } from "../../src/db/repositories/opportunity-exploration";
import { WorkflowRepository } from "../../src/db/repositories/workflows";
import { workflowSearchKey } from "../../src/shared/content-identity";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "scraply-recovery-reads-"));
  const db = new DatabaseClient(join(directory, "test.db"));
  const workflows = new WorkflowRepository(db);
  const models = new GenerationAttemptRepository(db);
  const timestamp = "2026-01-01T00:00:00.000Z";
  db.db.prepare("INSERT INTO threads (id,title,status,created_at,updated_at) VALUES ('project','Parcel tray labels','discovery-running',?,?)").run(timestamp, timestamp);
  db.immediateTransaction(() => {
    workflows.createSession({ id: "session", threadId: "project", purpose: "discovery", mode: "babysit", contract: {}, remainingMs: 60_000 });
    db.db.prepare(`INSERT INTO research_runs (id,thread_id,status,config_json,workflow_version,workflow_session_id,purpose,created_at,updated_at)
      VALUES ('run','project','running',?,2,'session','discovery',?,?)`).run(JSON.stringify(DEFAULT_RUN_CONFIG), timestamp, timestamp);
    workflows.createWorkItem({ id: "task", sessionId: "session", kind: "discovery", scopeKey: "initial", state: "ready", input: {} });
    workflows.updateWorkItem("task", "running", { outputRefs: { runId: "run" } });
  });
  const model = models.prepare("run", { generationId: randomUUID(), stage: "area-scan", model: DEFAULT_RUN_CONFIG.model, reasoningEffort: "medium",
    workOrder: { stage: "area-scan", instruction: "Read tray handoffs", goal: "Find observations", inputs: {}, definitionOfDone: [], constraints: [] },
    evidence: [], schema: z.object({}), jsonSchema: { type: "object" }, repairPolicy: "disabled", signal: new AbortController().signal });
  models.markDispatched(model.id);
  const recovery = new RunRecovery(db);
  return { db, models, workflows, model, recovery,
    close() { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

function search(db: DatabaseClient) {
  const query = "parcel tray handoff labels";
  const parameters = { maxResults: 2 };
  return prepareWorkflowSearch(db, "run", { key: workflowSearchKey(query, parameters), query, parameters, provider: "exa" }, []);
}

test("recovery decisions and acknowledgment planning read persisted receipts without writing", () => {
  const f = fixture();
  try {
    const ordinary = search(f.db);
    const investigator = f.db.immediateTransaction(() => {
      const attempts = new OpportunityExplorationRepository(f.db);
      const child = f.workflows.createWorkItem({ sessionId: "session", parentItemId: "task", kind: "evidence-check", scopeKey: "tray-gap", state: "ready", input: {} });
      const attempt = attempts.prepareAttempt("project", { stageKey: "investigator-search:tray", stageName: "investigator-search", input: {},
        model: { providerId: "exa", modelId: "search", reasoningEffort: "bounded" }, promptVersion: "1", promptText: "Find tray handoff evidence", workItemId: child.id }, "session");
      if (attempt.kind !== "prepared") throw new Error("Expected a prepared search");
      attempts.markAttemptDispatched("project", attempt.attemptId, "none", "session");
      f.db.db.prepare("UPDATE opportunity_exploration_attempts SET prepared_at = ? WHERE id = ?").run(ordinary.createdAt, attempt.attemptId);
      return attempt.attemptId;
    });
    f.db.db.prepare("INSERT INTO workflow_snapshots VALUES ('run', 'acknowledged-retry:stream-restart:fixture', ?)")
      .run(JSON.stringify({ attemptIds: [f.model.id, f.model.id] }));
    const before = f.db.db.prepare("SELECT * FROM workflow_snapshots ORDER BY rowid").all();
    const changes = f.db.db.prepare("SELECT total_changes() AS count").get();
    f.db.db.exec("PRAGMA query_only = ON");
    expect(f.recovery.acknowledgedModelReadiness("run")).toEqual({ kind: "ready", acknowledgedAttemptIds: [f.model.id] });
    expect(f.recovery.engineResumeReadiness("run")).toEqual({ kind: "unknown-investigator-search", acknowledgedAttemptIds: [f.model.id] });
    expect(f.recovery.engineResumeReadiness("run", [f.model.id, investigator])).toEqual({ kind: "ready", acknowledgedAttemptIds: [f.model.id, investigator] });
    expect(f.recovery.runProjectionReadiness("run")).toEqual({ model: { kind: "ready", acknowledgedAttemptIds: [f.model.id] }, unknownSearch: true });
    expect(f.recovery.hasUnknownCompletion("run")).toBe(true);
    expect(f.recovery.retryReview("run")).toEqual({ id: investigator, kind: "search", completionUnknown: true });
    expect(f.recovery.retryAttempt("run", ordinary.id)).toEqual({ id: ordinary.id, kind: "search" });
    // Exact raw classification deliberately includes an already acknowledged model receipt.
    expect(f.recovery.retryAttempt("run", f.model.id)).toEqual({ id: f.model.id, kind: "model", ambiguous: true, safeTransient: false, outputLimit: false });
    expect(f.recovery.retryAttempt("run", randomUUID())).toBeNull();
    expect(f.recovery.planAcknowledgement("run", investigator)).toEqual({ acknowledgedAttemptIds: [f.model.id, investigator], stillUnresolved: true });
    expect(f.db.db.prepare("SELECT * FROM workflow_snapshots ORDER BY rowid").all()).toEqual(before);
    expect(f.db.db.prepare("SELECT total_changes() AS count").get()).toEqual(changes);
    expect(f.models.getResumeSafety("run").canResume).toBe(false);
  } finally { f.close(); }
});

test("model-only readiness and engine resume remain insulated from malformed workflow searches", () => {
  const f = fixture();
  try {
    f.db.db.prepare("INSERT INTO workflow_snapshots VALUES ('run', 'search-attempt:damaged', '{}')").run();
    f.db.db.exec("PRAGMA query_only = ON");
    expect(f.recovery.acknowledgedModelReadiness("run")).toMatchObject({ kind: "unknown-model", acknowledgedAttemptIds: [] });
    expect(f.recovery.engineResumeReadiness("run")).toMatchObject({ kind: "unknown-model", acknowledgedAttemptIds: [] });
    expect(f.recovery.engineResumeReadiness("run", [f.model.id])).toEqual({ kind: "ready", acknowledgedAttemptIds: [f.model.id] });
    expect(() => f.recovery.hasUnknownCompletion("run")).toThrow();
    expect(() => f.recovery.runProjectionReadiness("run")).toThrow();
    expect(() => f.recovery.retryReview("run")).toThrow();
    expect(() => f.recovery.retryAttempt("run", f.model.id)).toThrow();
    expect(() => f.recovery.planAcknowledgement("run", f.model.id)).toThrow();
  } finally { f.close(); }
});

test("whole-run search short-circuit preserves SQLite errors on later malformed model metadata", () => {
  const f = fixture();
  try {
    const ordinary = search(f.db);
    f.db.db.prepare("UPDATE generation_attempts SET status = 'failed', terminal_kind = 'failed', error_code = 'unavailable', attempt_metadata_json = ? WHERE id = ?")
      .run(JSON.stringify({ attempts: ["broken"] }), f.model.id);
    f.db.db.exec("PRAGMA query_only = ON");
    expect(f.recovery.hasUnknownCompletion("run")).toBe(true);
    expect(f.recovery.retryReview("run")).toEqual({ id: ordinary.id, kind: "search", completionUnknown: true });
    expect(() => f.models.getResumeSafety("run")).toThrow("malformed JSON");
    expect(() => f.recovery.acknowledgedModelReadiness("run")).toThrow("malformed JSON");
    expect(() => f.recovery.runProjectionReadiness("run")).toThrow("malformed JSON");
    expect(() => f.recovery.planAcknowledgement("run", ordinary.id)).toThrow("malformed JSON");
  } finally { f.close(); }
});

test("malformed saved acknowledgment remains an error rather than granting recovery", () => {
  const f = fixture();
  try {
    f.db.db.prepare("INSERT INTO workflow_snapshots VALUES ('run', 'acknowledged-retry:damaged', '{}')").run();
    f.db.db.exec("PRAGMA query_only = ON");
    expect(() => f.recovery.acknowledgedModelReadiness("run")).toThrow();
    expect(() => f.recovery.engineResumeReadiness("run", [f.model.id])).toThrow();
    expect(() => f.recovery.runProjectionReadiness("run")).toThrow();
    expect(() => f.recovery.hasUnknownCompletion("run")).toThrow();
    expect(() => f.recovery.retryReview("run")).toThrow();
    expect(() => f.recovery.planAcknowledgement("run", f.model.id)).toThrow();
    expect(f.recovery.retryAttempt("run", f.model.id)).toMatchObject({ id: f.model.id, kind: "model", ambiguous: true });
  } finally { f.close(); }
});
