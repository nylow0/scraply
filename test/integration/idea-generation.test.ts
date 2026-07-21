import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import { generateIdeas, IdeaGenerationBlockedError } from "../../src/core/ideas";
import { DatabaseClient } from "../../src/db/client";
import { EvidenceRepository } from "../../src/db/repositories/evidence";
import { ResearchRunRepository } from "../../src/db/repositories/research-runs";
import { ThreadRepository } from "../../src/db/repositories/threads";
import type { StructuredModelClient } from "../../src/providers/structured";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/intake";
import { RunConfigSchema, type ProjectBrief } from "../../src/shared/schemas";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* SQLite WAL lock */ }
  }
});

const brief: ProjectBrief = {
  projectName: "Claim-linked ideas",
  theme: "Evidence",
  description: "Generate only grounded ideas",
  desiredOutput: "Ideas",
  successDefinition: "Every idea has evidence",
  constraints: [],
  resources: [],
  avoidList: [],
  researchNeeds: "Validate claims",
  finalDecision: "Choose one",
  deadline: "Soon",
  availableEffort: "Low",
  ideaStylePreference: "Practical",
};

function setup(withSynthesis: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "scraply-ideas-"));
  dirs.push(dir);
  const db = new DatabaseClient(join(dir, "scraply.db"));
  const thread = new ThreadRepository(db).createThread();
  const config = RunConfigSchema.parse({
    ...DEFAULT_RUN_CONFIG,
    orchestratorProvider: "opencode",
    workerProvider: "opencode",
    ideaProvider: "opencode",
    ideasRequested: 1,
    batchSize: 1,
  });
  const runId = new ResearchRunRepository(db).create(thread.id, brief, config).runId;
  const now = new Date().toISOString();
  db.db.prepare(`
    INSERT INTO stream_runs (id, research_run_id, stream_id, lens, round, status, created_at, updated_at)
    VALUES ('stream', ?, 'landscape', 'landscape', 0, 'completed', ?, ?)
  `).run(runId, now, now);
  const sources = new EvidenceRepository(db).persistSources(runId, "stream", [{
    id: "provider-source",
    url: "https://example.com/evidence",
    title: "Evidence",
    text: "Customers need a faster workflow.",
  }]);
  const claims = new EvidenceRepository(db).validateAndPersistClaims(runId, "stream", [{
    text: "Customers need a faster workflow",
    confidence: 0.9,
    sourceIds: [sources[0]!.id],
    evidence: [{ sourceId: sources[0]!.id, quote: "Customers need a faster workflow." }],
  }]);
  let synthesisId: string | null = null;
  if (withSynthesis) {
    synthesisId = "synthesis";
    db.db.prepare(`
      INSERT INTO reports (id, thread_id, research_run_id, stream_id, report_kind, title, html, created_at)
      VALUES (?, ?, ?, 'synthesis', 'synthesis', 'Synthesis', '<p>Faster workflows matter.</p>', ?)
    `).run(synthesisId, thread.id, runId, now);
    new ResearchRunRepository(db).finish(runId, "completed");
  }
  return { db, runId, claimId: claims.valid[0]!.id, synthesisId };
}

function clientWithClaim(claimId: string): StructuredModelClient {
  return {
    async structuredCompletion<T>(
      _model: string,
      _system: string,
      _user: string,
      schema: z.ZodType<T>,
    ): Promise<T> {
      return schema.parse({
        ideas: [{
          title: "Workflow accelerator",
          description: "Automate the slow path.",
          bucket: "strong-fit",
          scores: { relevance: 9, novelty: 7, evidenceStrength: 9, feasibility: 8, demand: 8, saturation: 4 },
          supportingClaimIds: [claimId],
        }],
      });
    },
  };
}

describe("run-scoped idea generation", () => {
  test("requires synthesis by default and stamps explicitly confirmed partial batches", async () => {
    const { db, runId, claimId } = setup(false);
    await expect(generateIdeas(db, clientWithClaim(claimId), runId)).rejects.toBeInstanceOf(IdeaGenerationBlockedError);

    const result = await generateIdeas(db, clientWithClaim(claimId), runId, true);
    expect(result.completeness.mode).toBe("partial");
    expect(result.completeness.synthesisReportId).toBeNull();
    expect(result.completeness.missingLenses).toContain("evaluation");
    expect(result.ideas[0]?.generationMode).toBe("partial");
    db.close();
  });

  test("persists only in-run claim links and reserves each paid idea batch", async () => {
    const { db, runId, claimId, synthesisId } = setup(true);
    const result = await generateIdeas(db, clientWithClaim(claimId), runId);
    const idea = result.ideas[0]!;
    expect(result.completeness).toEqual({ mode: "complete", synthesisReportId: synthesisId, missingLenses: [], gaps: [] });
    expect(idea.researchRunId).toBe(runId);
    expect(db.db.prepare("SELECT claim_id FROM idea_claims WHERE idea_id = ?").get(idea.id)).toEqual({ claim_id: claimId });
    expect(db.db.prepare(`
      SELECT status, reservation_usd, committed_usd FROM cost_ledger
      WHERE research_run_id = ? AND operation = 'idea-generation'
    `).get(runId)).toEqual({ status: "committed", reservation_usd: 0.08, committed_usd: 0.08 });
    db.close();
  });

  test("rejects model claim IDs outside the selected run", async () => {
    const first = setup(true);
    const second = setup(true);
    await expect(generateIdeas(first.db, clientWithClaim(second.claimId), first.runId)).rejects.toThrow("valid in-run claim links");
    expect(first.db.db.prepare("SELECT COUNT(*) AS count FROM ideas WHERE research_run_id = ?").get(first.runId)).toEqual({ count: 0 });
    first.db.close();
    second.db.close();
  });
});
