import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseClient } from "../../src/db/client";
import { ThreadRepository } from "../../src/db/repositories/threads";
import { cancelIncompleteRun, listPendingRuns, loadStoredRunState } from "../../src/core/research-recovery";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/intake";
import { RunConfigSchema } from "../../src/shared/schemas";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) {
    try {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    } catch {
      // Windows may keep WAL files locked briefly
    }
  }
});

describe("research recovery", () => {
  test("detects interrupted runs and can cancel while preserving completed stream reports", () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-recovery-"));
    tempDirs.push(dir);
    const db = new DatabaseClient(join(dir, "scraply.db"));
    const threads = new ThreadRepository(db);
    const thread = threads.createThread("Interrupted run");
    const runId = randomUUID();
    const now = new Date().toISOString();

    threads.saveBrief(thread.id, {
      projectName: "Recovery test",
      goal: "Test recovery",
      theme: "Recovery",
      description: "Test resume",
      successDefinition: "Resume works",
      desiredOutput: "Ideas",
      successDecider: "Me",
      motivation: "Reliability",
      constraints: [],
      resources: [],
      avoidList: [],
      researchNeeds: "Basic scan",
      finalDecision: "Ship",
      deadline: "Soon",
      availableEffort: "Low",
      ideaStylePreference: "Safe",
      examples: "",
      scoringCriteria: "",
      anythingElse: "",
    }, true);
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

    const pending = listPendingRuns(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.completedStreams).toBe(1);

    const stored = loadStoredRunState(db, runId);
    expect(stored?.completedStreamIds.has("landscape")).toBe(true);
    expect(stored?.spendEstimate).toBe(0.2);

    cancelIncompleteRun(db, runId);
    expect(listPendingRuns(db)).toHaveLength(0);
    expect(db.db.prepare("SELECT status FROM research_runs WHERE id = ?").get(runId)).toEqual({ status: "cancelled" });
    expect(db.db.prepare("SELECT html FROM reports WHERE id = ?").get(reportId)).toEqual({ html: "<p>Partial evidence</p>" });

    db.close();
  });

  test("lists failed runs with corrupt config without breaking workspace recovery", () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-recovery-"));
    tempDirs.push(dir);
    const db = new DatabaseClient(join(dir, "scraply.db"));
    const threads = new ThreadRepository(db);
    const thread = threads.createThread("Failed run");
    const runId = randomUUID();
    const now = new Date().toISOString();

    db.db.prepare(`
      INSERT INTO research_runs (id, thread_id, status, config_json, spend_estimate, round, cancelled, created_at, updated_at)
      VALUES (?, ?, 'failed', ?, 0, 0, 0, ?, ?)
    `).run(runId, thread.id, "{not-json", now, now);

    expect(listPendingRuns(db)[0]).toMatchObject({ runId, status: "failed", totalStreams: 1 });

    db.close();
  });

  test("cancels running streams without erasing failed stream diagnostics", () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-recovery-"));
    tempDirs.push(dir);
    const db = new DatabaseClient(join(dir, "scraply.db"));
    const threads = new ThreadRepository(db);
    const thread = threads.createThread("Cancel failed run");
    const runId = randomUUID();
    const now = new Date().toISOString();

    db.db.prepare(`
      INSERT INTO research_runs (id, thread_id, status, config_json, spend_estimate, round, cancelled, created_at, updated_at)
      VALUES (?, ?, 'running', ?, 0, 0, 0, ?, ?)
    `).run(runId, thread.id, JSON.stringify(DEFAULT_RUN_CONFIG), now, now);
    db.db.prepare(`
      INSERT INTO stream_runs (id, research_run_id, stream_id, round, status, error, created_at, updated_at)
      VALUES (?, ?, 'landscape', 0, 'failed', 'OpenCode unavailable', ?, ?)
    `).run(randomUUID(), runId, now, now);
    db.db.prepare(`
      INSERT INTO stream_runs (id, research_run_id, stream_id, round, status, created_at, updated_at)
      VALUES (?, ?, 'exemplars', 0, 'running', ?, ?)
    `).run(randomUUID(), runId, now, now);

    cancelIncompleteRun(db, runId);

    expect(db.db.prepare("SELECT status, error FROM stream_runs WHERE stream_id = 'landscape'").get()).toEqual({
      status: "failed",
      error: "OpenCode unavailable",
    });
    expect(db.db.prepare("SELECT status FROM stream_runs WHERE stream_id = 'exemplars'").get()).toEqual({
      status: "cancelled",
    });

    db.close();
  });
});
