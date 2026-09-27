import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { DatabaseClient } from "../../src/db/client";
import {
  DiscoveryRepository,
  type DiscoveryFactorRecord,
  type DiscoveryProblemRecord,
  type DiscoverySourceRecord,
} from "../../src/db/repositories/discovery";

const sourceCount = 80;
const factorCount = 400;
const problemCount = 40;
const repetitions = 5;
const sources: DiscoverySourceRecord[] = Array.from({ length: sourceCount }, (_, index) => ({
  id: `source-${index}`,
  providerSourceId: `provider-${index}`,
  canonicalUrl: `https://example.test/${index}`,
  title: `Source ${index}`,
  retrievedText: `Evidence ${index}`,
  author: null,
  publishedAt: null,
  contentHash: `hash-${index}`,
  retrievedAt: "2026-01-01T00:00:00.000Z",
}));
const factors: DiscoveryFactorRecord[] = Array.from({ length: factorCount }, (_, index) => ({
  id: `factor-${index}`,
  subject: `Subject ${index}`,
  behavior: `Behavior ${index}`,
  quote: `Quote ${index}`,
  sourceId: sources[index % sourceCount]!.id,
  harvestMode: "domain",
  modelConfidence: 0.8,
}));
const problems: DiscoveryProblemRecord[] = Array.from({ length: problemCount }, (_, index) => ({
  id: `problem-${index}`,
  statement: `Statement ${index}`,
  whyItPersists: "Why",
  affected: "Who",
  scaleEstimate: "Recurring",
  scaleBasisFactorId: factors[index * 10]!.id,
  factorIds: factors.slice(index * 10, index * 10 + 10).map((factor) => factor.id),
  verdict: "confirmed",
  verdictReason: "Supported",
  verdictSourceIds: [sources[index]!.id, sources[index + 40]!.id],
}));

const samples: Array<{ factorsMs: number; problemsMs: number; digest: string }> = [];
let lookupPlans: { source: unknown[]; factor: unknown[] } | undefined;
for (let repetition = 0; repetition < repetitions; repetition++) {
  const directory = mkdtempSync(join(tmpdir(), "scraply-db-bench-"));
  const client = new DatabaseClient(join(directory, "scraply.db"));
  try {
    const now = "2026-01-01T00:00:00.000Z";
    client.db.prepare("INSERT INTO threads (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("thread-1", "Benchmark", "discovery-running", now, now);
    client.db.prepare("INSERT INTO research_runs (id, thread_id, status, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("run-1", "thread-1", "running", "{}", now, now);
    const repository = new DiscoveryRepository(client);
    if (repetition === 0) {
      lookupPlans = {
        source: client.db.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM sources WHERE id = ? AND research_run_id = ?")
          .all("source-0", "run-1"),
        factor: client.db.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM factors WHERE id = ? AND research_run_id = ?")
          .all("factor-0", "run-1"),
      };
    }
    const start = performance.now();
    repository.persistFactors("run-1", sources, factors);
    const factorsEnd = performance.now();
    repository.persistProblems("run-1", [], problems);
    const problemsEnd = performance.now();
    const rows = client.db.prepare(`
      SELECT p.id, pf.factor_id, pvs.source_id, pvs.position
      FROM problems p
      JOIN problem_factors pf ON pf.problem_id = p.id
      JOIN problem_verdict_sources pvs ON pvs.problem_id = p.id
      ORDER BY p.id, pf.factor_id, pvs.position
    `).all();
    const digest = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
    const foreignKeyFailures = client.db.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyFailures.length > 0) throw new Error("Fixture has broken foreign keys");
    samples.push({ factorsMs: factorsEnd - start, problemsMs: problemsEnd - factorsEnd, digest });
  } finally {
    client.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
if (new Set(samples.map((sample) => sample.digest)).size !== 1) throw new Error("Results differ between repetitions");
console.log(JSON.stringify({
  runtime: typeof Bun === "undefined" ? "node" : "bun",
  sourceCount, factorCount, problemCount, repetitions,
  factorsMs: median(samples.map((sample) => sample.factorsMs)),
  problemsMs: median(samples.map((sample) => sample.problemsMs)),
  digest: samples[0]!.digest,
  lookupPlans,
}));
