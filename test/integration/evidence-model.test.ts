import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseClient } from "../../src/db/client";
import { BudgetExceededError, CostLedgerRepository } from "../../src/db/repositories/cost-ledger";
import { EvidenceRepository } from "../../src/db/repositories/evidence";
import { ActiveRunConflictError, ResearchRunRepository } from "../../src/db/repositories/research-runs";
import { ThreadRepository } from "../../src/db/repositories/threads";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/intake";
import { RunConfigSchema, type ProjectBrief } from "../../src/shared/schemas";
import { makeProjectBrief } from "../helpers/project-brief";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) {
    try {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    } catch {
      // Windows may keep SQLite WAL files locked briefly.
    }
  }
});

const brief: ProjectBrief = makeProjectBrief({
  title: "Evidence test",
  objective: "Research integrity",
  context: "Verify persisted evidence",
  desiredOutput: { type: "options", notes: "Reliable ideas" },
  successCriteria: ["Unsupported claims are rejected"],
  evidenceRequirements: ["Validate sources"],
  decisionToSupport: "Ship",
  deadline: "Soon",
  availableEffort: "Low",
  ideaStyle: "safe",
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "scraply-evidence-"));
  tempDirs.push(dir);
  const db = new DatabaseClient(join(dir, "scraply.db"));
  const thread = new ThreadRepository(db).createThread("Evidence model");
  return { db, thread };
}

describe("evidence model", () => {
  test("enforces idempotent starts, one active run, and synthesis-gated completion", () => {
    const { db, thread } = setup();
    const runs = new ResearchRunRepository(db);
    const config = RunConfigSchema.parse(DEFAULT_RUN_CONFIG);
    const first = runs.create(thread.id, brief, config, "same-request");
    expect(runs.create(thread.id, brief, config, "same-request")).toEqual({ runId: first.runId, created: false });
    expect(() => runs.create(thread.id, brief, config, "different-request")).toThrow(ActiveRunConflictError);
    expect(() => runs.finish(first.runId, "completed")).toThrow("persisted synthesis");

    db.db.prepare(`
      INSERT INTO reports (id, thread_id, research_run_id, stream_id, report_kind, title, html, created_at)
      VALUES ('synthesis', ?, ?, 'synthesis', 'synthesis', 'Synthesis', '<p>done</p>', ?)
    `).run(thread.id, first.runId, new Date().toISOString());
    runs.finish(first.runId, "completed");
    expect(db.db.prepare("SELECT status FROM research_runs WHERE id = ?").get(first.runId)).toEqual({ status: "completed" });
    db.close();
  });

  test("reserves budget transactionally and keeps conservative unknown cost", () => {
    const { db, thread } = setup();
    const config = RunConfigSchema.parse({ ...DEFAULT_RUN_CONFIG, maxSpendUsd: 5 });
    const runId = new ResearchRunRepository(db).create(thread.id, brief, config).runId;
    const ledger = new CostLedgerRepository(db);
    const reservation = ledger.reserve(runId, "search", "exa", null, 3);
    expect(() => ledger.reserve(runId, "extraction", "opencode", "model", 3)).toThrow(BudgetExceededError);
    ledger.commit(reservation.id);
    expect(db.db.prepare(`
      SELECT reserved_cost, committed_cost FROM research_runs WHERE id = ?
    `).get(runId)).toEqual({ reserved_cost: 0, committed_cost: 3 });
    db.close();
  });

  test("deduplicates sources and rejects evidence quotes not present in stored text", () => {
    const { db, thread } = setup();
    const config = RunConfigSchema.parse(DEFAULT_RUN_CONFIG);
    const runId = new ResearchRunRepository(db).create(thread.id, brief, config).runId;
    const now = new Date().toISOString();
    db.db.prepare(`
      INSERT INTO stream_runs (id, research_run_id, stream_id, lens, round, status, created_at, updated_at)
      VALUES ('stream', ?, 'landscape', 'landscape', 0, 'running', ?, ?)
    `).run(runId, now, now);

    const evidence = new EvidenceRepository(db);
    const sources = evidence.persistSources(runId, "stream", [
      { id: "provider-1", url: "https://Example.com/page#section", title: "One", text: "Exact supporting sentence." },
      { id: "provider-2", url: "https://example.com/page", title: "Duplicate", text: "Exact supporting sentence." },
    ]);
    expect(sources).toHaveLength(2);
    expect(new Set(sources.map((source) => source.id)).size).toBe(1);

    const persisted = evidence.validateAndPersistClaims(runId, "stream", [
      {
        text: "Supported",
        sourceIds: [sources[0]!.id],
        evidence: [{ sourceId: sources[0]!.id, quote: "Exact supporting sentence." }],
        confidence: 0.9,
      },
      {
        text: "Hallucinated",
        sourceIds: [sources[0]!.id],
        evidence: [{ sourceId: sources[0]!.id, quote: "This quote is absent." }],
        confidence: 0.8,
      },
    ]);
    expect(persisted.valid).toHaveLength(1);
    expect(persisted.rejected).toHaveLength(1);
    expect(evidence.listValidClaims(runId)[0]?.text).toBe("Supported");
    db.close();
  });
});
