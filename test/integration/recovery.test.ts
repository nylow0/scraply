import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseClient } from "../../src/db/client";
import { ResearchRunRepository } from "../../src/db/repositories/research-runs";
import { ThreadRepository } from "../../src/db/repositories/threads";
import { cancelIncompleteRun, listPendingRuns, loadStoredRunState } from "../../src/core/research-recovery";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/intake";
import { RunConfigSchema } from "../../src/shared/schemas";
import { makeProjectBrief } from "../helpers/project-brief";

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
  test("new runs snapshot the fixed six stream ids", () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-run-plan-"));
    tempDirs.push(dir);
    const db = new DatabaseClient(join(dir, "scraply.db"));
    const threads = new ThreadRepository(db);
    const thread = threads.createThread("Snapshot");
    const brief = makeProjectBrief();
    const config = RunConfigSchema.parse(DEFAULT_RUN_CONFIG);

    const created = new ResearchRunRepository(db).create(thread.id, brief, config);
    const snapshottedBrief = structuredClone(brief);
    const snapshottedConfig = structuredClone(config);
    brief.objective = "Edited after launch";
    config.maxSpendUsd = 99;
    const row = db.db.prepare(
      "SELECT brief_json, config_json, selected_stream_ids_json FROM research_runs WHERE id = ?",
    ).get(created.runId) as {
      brief_json: string;
      config_json: string;
      selected_stream_ids_json: string;
    };

    expect(JSON.parse(row.brief_json)).toEqual(snapshottedBrief);
    expect(JSON.parse(row.config_json)).toEqual(snapshottedConfig);
    expect(JSON.parse(row.selected_stream_ids_json)).toEqual([
      "landscape",
      "exemplars",
      "pain-gaps",
      "resources",
      "analogies",
      "evaluation",
    ]);
    db.close();
  });

  test("detects interrupted runs and can cancel while preserving completed stream reports", () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-recovery-"));
    tempDirs.push(dir);
    const db = new DatabaseClient(join(dir, "scraply.db"));
    const threads = new ThreadRepository(db);
    const thread = threads.createThread("Interrupted run");
    const runId = randomUUID();
    const now = new Date().toISOString();

    threads.saveBrief(thread.id, makeProjectBrief({
      title: "Recovery test",
      objective: "Recovery",
      context: "Test resume",
      desiredOutput: { type: "options", notes: "Ideas" },
      successCriteria: ["Resume works"],
      evidenceRequirements: ["Basic scan"],
      decisionToSupport: "Ship",
      deadline: "Soon",
      availableEffort: "Low",
      ideaStyle: "safe",
    }), true);
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
    db.db.prepare(`
      INSERT INTO stream_runs (id, research_run_id, stream_id, round, status, report_id, coverage, created_at, updated_at)
      VALUES (?, ?, 'landscape', 1, 'completed', ?, 0.9, ?, ?)
    `).run(randomUUID(), runId, reportId, now, now);

    const pending = listPendingRuns(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.completedStreams).toBe(1);
    expect(pending[0]?.totalStreams).toBe(6);

    const stored = loadStoredRunState(db, runId);
    expect(stored?.completedStreamIds.has("landscape")).toBe(true);
    expect(stored?.selectedStreamIds).toHaveLength(6);

    db.db.prepare("UPDATE research_runs SET selected_stream_ids_json = ? WHERE id = ?")
      .run(JSON.stringify(["landscape", "resources"]), runId);
    expect(listPendingRuns(db)[0]?.totalStreams).toBe(2);
    expect(loadStoredRunState(db, runId)?.selectedStreamIds).toEqual(["landscape", "resources"]);

    cancelIncompleteRun(db, runId);
    expect(listPendingRuns(db)).toHaveLength(0);
    expect(db.db.prepare("SELECT status FROM research_runs WHERE id = ?").get(runId)).toEqual({ status: "cancelled" });
    expect(db.db.prepare("SELECT html FROM reports WHERE id = ?").get(reportId)).toEqual({ html: "<p>Partial evidence</p>" });

    db.close();
  });
});
