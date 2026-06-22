import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseClient } from "../../src/db/client";
import { ThreadRepository } from "../../src/db/repositories/threads";
import { ResearchEngine } from "../../src/core/research-engine";
import { loadStoredRunState } from "../../src/core/research-recovery";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/intake";
import { DEFAULT_RESEARCHERS, RunConfigSchema, type Source } from "../../src/shared/schemas";
import type { ExaClient } from "../../src/providers/exa";
import type { OpenCodeClient } from "../../src/providers/opencode";

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

function mockClients() {
  const sources: Source[] = [{
    id: "s1",
    url: "https://example.com",
    title: "Example source",
    text: "Widgets are underserved in small-team workflows.",
  }];

  const exa = {
    search: async () => sources,
  } as unknown as ExaClient;

  const opencode = {
    extractClaims: async () => ({
      claims: [{
        text: "Widgets remain underserved.",
        sourceIds: ["s1"],
        evidence: [{ sourceId: "s1", quote: "Widgets are underserved" }],
        confidence: 0.85,
      }],
    }),
    structuredCompletion: async (_model: string, _system: string, _user: string) => ({
      overallCoverage: 0.8,
      summary: "Adequate coverage.",
      streamReviews: [{
        streamId: "landscape",
        coverage: 0.8,
        gaps: [],
        needsFollowUp: false,
      }],
    }),
  } as unknown as OpenCodeClient;

  return { exa, opencode };
}

describe("ResearchEngine", () => {
  test("rejects runs with no enabled researchers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-engine-"));
    tempDirs.push(dir);
    const db = new DatabaseClient(join(dir, "scraply.db"));
    const threads = new ThreadRepository(db);
    const thread = threads.createThread("Empty researchers");
    const { exa, opencode } = mockClients();
    const engine = new ResearchEngine({ db, exa, opencode, onEvent: () => {} });

    const config = RunConfigSchema.parse({
      ...DEFAULT_RUN_CONFIG,
      researchers: DEFAULT_RESEARCHERS.map((r) => ({ ...r, enabled: false })),
    });

    await expect(engine.startRun(thread.id, {
      projectName: "Test",
      goal: "Test",
      theme: "Test",
      description: "Test",
      successDefinition: "Done",
      desiredOutput: "Ideas",
      successDecider: "Me",
      motivation: "Test",
      constraints: [],
      resources: [],
      avoidList: [],
      researchNeeds: "Basic",
      finalDecision: "Pick",
      deadline: "Soon",
      availableEffort: "Low",
      ideaStylePreference: "Balanced",
      examples: "",
      scoringCriteria: "",
      anythingElse: "",
    }, config)).rejects.toThrow("Enable at least one researcher");

    db.close();
  });

  test("runs a single stream end to end with mocked providers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-engine-run-"));
    tempDirs.push(dir);
    const db = new DatabaseClient(join(dir, "scraply.db"));
    const threads = new ThreadRepository(db);
    const thread = threads.createThread("Single stream");
    const brief = {
      projectName: "Widget test",
      goal: "Find ideas",
      theme: "Widgets",
      description: "Widget research",
      successDefinition: "Evidence",
      desiredOutput: "Ideas",
      successDecider: "Me",
      motivation: "Test",
      constraints: [],
      resources: [],
      avoidList: [],
      researchNeeds: "Landscape",
      finalDecision: "Pick one",
      deadline: "Flexible",
      availableEffort: "Low",
      ideaStylePreference: "Balanced",
      examples: "",
      scoringCriteria: "",
      anythingElse: "",
    };
    threads.saveBrief(thread.id, brief, true);

    const config = RunConfigSchema.parse({
      ...DEFAULT_RUN_CONFIG,
      researchers: [{ ...DEFAULT_RESEARCHERS[0], enabled: true }],
      maxFollowUpRounds: 0,
      ideasRequested: 2,
      batchSize: 2,
    });

    const events: string[] = [];
    const { exa, opencode } = mockClients();
    (opencode as { structuredCompletion: (...args: unknown[]) => Promise<unknown> }).structuredCompletion = async (...args: unknown[]) => {
      const user = String((args[2] as string) ?? "");
      if (user.includes("Stream reports:")) {
        return {
          overallCoverage: 0.8,
          summary: "Adequate coverage.",
          streamReviews: [{ streamId: "landscape", coverage: 0.8, gaps: [], needsFollowUp: false }],
        };
      }
      if (user.includes("Stream evidence:")) {
        return {
          summary: "Widgets are promising.",
          keyThemes: ["Workflow friction"],
          opportunities: ["Vertical bundles"],
          risks: ["Incumbents"],
          recommendedNextSteps: ["Interview users"],
        };
      }
      return {
        ideas: [{
          title: "Widget CRM",
          description: "CRM for widget makers.",
          bucket: "strong-fit",
          scores: { relevance: 8, novelty: 6, evidenceStrength: 7, feasibility: 8, demand: 7, saturation: 4 },
        }],
      };
    };

    const engine = new ResearchEngine({
      db,
      exa,
      opencode,
      onEvent: (event) => events.push(event.type),
    });

    const runId = await engine.startRun(thread.id, brief, config);
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const run = db.db.prepare("SELECT status, spend_estimate FROM research_runs WHERE id = ?").get(runId) as {
      status: string;
      spend_estimate: number;
    };
    expect(["completed", "partial"]).toContain(run.status);
    expect(run.spend_estimate).toBeGreaterThan(0);
    expect(events).toContain("stream-completed");
    expect(events).toContain("run-completed");

    db.close();
  });

  test("resume restores spend estimate from database", () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-engine-resume-"));
    tempDirs.push(dir);
    const db = new DatabaseClient(join(dir, "scraply.db"));
    const threads = new ThreadRepository(db);
    const thread = threads.createThread("Resume spend");
    const runId = randomUUID();
    const now = new Date().toISOString();

    threads.saveBrief(thread.id, {
      projectName: "Resume",
      goal: "Test",
      theme: "Resume",
      description: "Test",
      successDefinition: "Done",
      desiredOutput: "Ideas",
      successDecider: "Me",
      motivation: "Test",
      constraints: [],
      resources: [],
      avoidList: [],
      researchNeeds: "Basic",
      finalDecision: "Pick",
      deadline: "Soon",
      availableEffort: "Low",
      ideaStylePreference: "Balanced",
      examples: "",
      scoringCriteria: "",
      anythingElse: "",
    }, true);

    db.db.prepare(`
      INSERT INTO research_runs (id, thread_id, status, config_json, spend_estimate, round, cancelled, created_at, updated_at)
      VALUES (?, ?, 'running', ?, 1.25, 0, 0, ?, ?)
    `).run(runId, thread.id, JSON.stringify(DEFAULT_RUN_CONFIG), now, now);

    const stored = loadStoredRunState(db, runId);
    expect(stored?.spendEstimate).toBe(1.25);

    db.close();
  });
});
