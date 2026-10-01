import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { evaluationBackend } from "../../scripts/eval-research";
import { DatabaseClient } from "../../src/db/client";
import { DiscoveryRepository } from "../../src/db/repositories/discovery";
import { ResearchRunRepository } from "../../src/db/repositories/research-runs";
import { WorkflowRepository } from "../../src/db/repositories/workflows";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";

test("evaluation measures discovery evidence after frame preparation without writing or invoking the app", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scraply-evaluation-evidence-"));
  const databasePath = join(directory, "research.db");
  const db = new DatabaseClient(databasePath);
  try {
    const now = new Date().toISOString();
    db.db.prepare("INSERT INTO threads (id,title,status,created_at,updated_at) VALUES ('project','Evaluation','configuring',?,?)").run(now, now);
    db.immediateTransaction(() => new WorkflowRepository(db).createSession({
      id: "session", threadId: "project", purpose: "discovery", mode: "vibe", contract: {}, remainingMs: 60_000,
    }));
    const runs = new ResearchRunRepository(db);
    const config = { ...DEFAULT_RUN_CONFIG, workflowVersion: 2 as const };
    const link = { sessionId: "session", purpose: "discovery" as const };
    const preparationRunId = runs.create("project", config, null, undefined, link).runId;
    db.db.prepare("INSERT INTO workflow_snapshots VALUES (?, 'workflow-kind', ?)")
      .run(preparationRunId, JSON.stringify({ kind: "prepare-frame", knownProblem: false }));
    runs.finish(preparationRunId, "completed");
    const backend = evaluationBackend(async () => { throw new Error("Measurement must not invoke the app"); },
      databasePath, resolve(import.meta.dir, "../../src/core/run-trace.ts"));
    expect(await backend.measure("session")).toBeNull();

    const discoveryRunId = runs.create("project", config, null, undefined, link).runId;
    const source = { id: "owner-source", providerSourceId: null, canonicalUrl: "https://owners.example/filing",
      title: "Owner account", retrievedText: "I repeat filing entries", author: null, publishedAt: null,
      contentHash: "a".repeat(64), retrievedAt: now };
    new DiscoveryRepository(db).persistFactors(discoveryRunId, [source], [{ id: "owner-factor", sourceId: source.id,
      subject: "Owner", behavior: "Repeats filing entries", quote: source.retrievedText, harvestMode: "audience",
      modelConfidence: 0.8, sourceRole: "firsthand", audienceFit: "intended-buyer", independentSourceKey: source.id }]);
    runs.finish(discoveryRunId, "completed");
    const changes = db.db.prepare("SELECT total_changes() AS count").get();
    const measured = await backend.measure("session");
    expect(measured?.runId).toBe(discoveryRunId);
    expect(measured?.metrics).toMatchObject({ factors: 1, totalSources: 1, qualifyingObservations: 1 });
    expect(db.db.prepare("SELECT total_changes() AS count").get()).toEqual(changes);
  } finally {
    db.close();
    try { rmSync(directory, { recursive: true, force: true }); }
    catch { /* SQLite can retain its WAL handle until the test process exits on Windows. */ }
  }
});
