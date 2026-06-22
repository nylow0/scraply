import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseClient } from "../../src/db/client";
import { ThreadRepository } from "../../src/db/repositories/threads";
import {
  cancelIncompleteRun,
  listPendingRuns,
  loadStoredRunState,
  logJobEvent,
} from "../../src/core/research-recovery";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/intake";
import { RunConfigSchema } from "../../src/shared/schemas";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) {
    try {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    } catch {
      // Windows may keep WAL files locked briefly.
    }
  }
});

function createTempDb(prefix: string): DatabaseClient {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return new DatabaseClient(join(dir, "scraply.db"));
}

const sampleBrief = {
  projectName: "Recovery test",
  goal: "Test recovery",
  theme: "Recovery",
  description: "Test resume",
  successDefinition: "Resume works",
  desiredOutput: "Ideas",
  successDecider: "Me",
  motivation: "Reliability",
  constraints: [] as string[],
  resources: [] as string[],
  avoidList: [] as string[],
  researchNeeds: "Basic scan",
  finalDecision: "Ship",
  deadline: "Soon",
  availableEffort: "Low",
  ideaStylePreference: "Safe",
  examples: "",
  scoringCriteria: "",
  anythingElse: "",
};

describe("research recovery", () => {
  test("detects interrupted runs and can cancel while preserving completed stream reports", () => {
    const db = createTempDb("scraply-recovery-");
    const threads = new ThreadRepository(db);
    const thread = threads.createThread("Interrupted run");
    const runId = randomUUID();
    const now = new Date().toISOString();

    threads.saveBrief(thread.id, sampleBrief, true);
    threads.saveRunConfig(thread.id, RunConfigSchema.parse(DEFAULT_RUN_CONFIG));

    db.db.prepare(`
      INSERT INTO research_runs (id, thread_id, status, config_json, spend_estimate, round, cancelled, created_at, updated_at)
      VALUES (?, ?, 'running', ?, 0.2, 0, 0, ?, ?)
    `).run(runId, thread.id, JSON.stringify(DEFAULT_RUN_CONFIG), now, now);

    const reportId = randomUUID();
    db.db.prepare(`
      INSERT INTO reports (id, thread_id, stream_id, title, html, created_at)
      VALUES (?, ?, 'landscape', 'Landscape report', '<p>Partial evidence</p>', ?)
    `).run(reportId, thread.id, now);
    db.db.prepare(`
      INSERT INTO stream_runs (id, research_run_id, stream_id, round, status, report_id, coverage, created_at, updated_at)
      VALUES (?, ?, 'landscape', 0, 'completed', ?, 0.7, ?, ?)
    `).run(randomUUID(), runId, reportId, now, now);

    expect(listPendingRuns(db)[0]).toMatchObject({ runId, completedStreams: 1, hasSynthesis: false });
    expect(loadStoredRunState(db, runId)?.spendEstimate).toBe(0.2);

    cancelIncompleteRun(db, runId);
    expect(listPendingRuns(db)).toHaveLength(0);
    expect(db.db.prepare("SELECT status FROM research_runs WHERE id = ?").get(runId)).toEqual({ status: "cancelled" });
    expect(db.db.prepare("SELECT status FROM threads WHERE id = ?").get(thread.id)).toEqual({ status: "research-complete" });

    db.close();
  });

  test("lists failed runs as pending and cancel resets thread to configuring without evidence", () => {
    const db = createTempDb("scraply-recovery-failed-");
    const threads = new ThreadRepository(db);
    const thread = threads.createThread("Failed run");
    const runId = randomUUID();
    const now = new Date().toISOString();

    threads.saveBrief(thread.id, sampleBrief, true);
    db.db.prepare(`
      INSERT INTO research_runs (id, thread_id, status, config_json, spend_estimate, round, cancelled, created_at, updated_at)
      VALUES (?, ?, 'failed', ?, 0.05, 0, 0, ?, ?)
    `).run(runId, thread.id, JSON.stringify(DEFAULT_RUN_CONFIG), now, now);

    expect(listPendingRuns(db)[0]).toMatchObject({ runId, status: "failed", completedStreams: 0 });

    cancelIncompleteRun(db, runId);
    expect(listPendingRuns(db)).toHaveLength(0);
    expect(db.db.prepare("SELECT status FROM threads WHERE id = ?").get(thread.id)).toEqual({ status: "configuring" });

    db.close();
  });

  test("loadStoredRunState returns null for missing brief or invalid config", () => {
    const db = createTempDb("scraply-recovery-null-");
    const runId = randomUUID();
    const now = new Date().toISOString();

    expect(loadStoredRunState(db, "missing-run")).toBeNull();

    const threads = new ThreadRepository(db);
    const thread = threads.createThread("No brief");
    db.db.prepare(`
      INSERT INTO research_runs (id, thread_id, status, config_json, spend_estimate, round, cancelled, created_at, updated_at)
      VALUES (?, ?, 'running', ?, 0, 0, 0, ?, ?)
    `).run(runId, thread.id, JSON.stringify(DEFAULT_RUN_CONFIG), now, now);
    expect(loadStoredRunState(db, runId)).toBeNull();

    threads.saveBrief(thread.id, sampleBrief, true);
    db.db.prepare("UPDATE research_runs SET config_json = ? WHERE id = ?").run("{bad", runId);
    expect(loadStoredRunState(db, runId)).toBeNull();

    db.close();
  });

  test("logJobEvent persists typed payloads", () => {
    const db = createTempDb("scraply-recovery-events-");
    logJobEvent(db, randomUUID(), randomUUID(), "stream-started", { streamId: "landscape" });
    const row = db.db.prepare("SELECT type, payload_json FROM job_events LIMIT 1").get() as {
      type: string;
      payload_json: string;
    };
    expect(row.type).toBe("stream-started");
    expect(JSON.parse(row.payload_json)).toEqual({ streamId: "landscape" });

    db.close();
  });
});
