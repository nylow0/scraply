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
      theme: "Recovery",
      description: "Test resume",
      desiredOutput: "Ideas",
      successDefinition: "Resume works",
      constraints: [],
      resources: [],
      avoidList: [],
      researchNeeds: "Basic scan",
      finalDecision: "Ship",
      deadline: "Soon",
      availableEffort: "Low",
      ideaStylePreference: "Safe",
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

    cancelIncompleteRun(db, runId);
    expect(listPendingRuns(db)).toHaveLength(0);
    expect(db.db.prepare("SELECT status FROM research_runs WHERE id = ?").get(runId)).toEqual({ status: "cancelled" });
    expect(db.db.prepare("SELECT html FROM reports WHERE id = ?").get(reportId)).toEqual({ html: "<p>Partial evidence</p>" });

    db.close();
  });
});
