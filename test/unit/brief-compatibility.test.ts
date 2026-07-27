import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAndNormalizeBrief } from "../../src/shared/brief-normalizer";
import { ConfirmBriefSchema } from "../../src/shared/ipc";
import { ProjectBriefV2Schema, type LegacyProjectBrief } from "../../src/shared/schemas";
import { DatabaseClient } from "../../src/db/client";
import { ThreadRepository } from "../../src/db/repositories/threads";
import { loadStoredRunState } from "../../src/core/research-recovery";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/intake";
import { makeProjectBrief } from "../helpers/project-brief";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) {
    try {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    } catch {
      // Windows can briefly retain SQLite WAL handles.
    }
  }
});

const legacyBrief: LegacyProjectBrief = {
  projectName: "Legacy launch",
  theme: "Student software",
  description: "Find a small product students will pay for.",
  desiredOutput: "A ranked shortlist",
  successDefinition: "Can reach first revenue in one semester",
  constraints: ["No paid acquisition"],
  resources: ["TypeScript"],
  avoidList: ["Regulated markets"],
  researchNeeds: "Use demand evidence",
  finalDecision: "Choose one product to validate",
  deadline: "Flexible",
  availableEffort: "Not specified",
  ideaStylePreference: "Practical",
};

describe("brief V2 compatibility", () => {
  test("normalizes legacy semantics without turning placeholder defaults into facts", () => {
    const result = parseAndNormalizeBrief(legacyBrief);

    expect(result).toMatchObject({
      schemaVersion: 2,
      title: "Legacy launch",
      objective: "Student software",
      decisionToSupport: "Choose one product to validate",
      desiredOutput: { type: "ranked-shortlist", notes: "A ranked shortlist" },
      successCriteria: ["Can reach first revenue in one semester"],
      hardConstraints: ["No paid acquisition"],
      antiGoals: ["Regulated markets"],
      resources: ["TypeScript"],
      deadline: null,
      availableEffort: null,
      evidenceRequirements: ["Use demand evidence"],
      ideaStyle: "safe",
      contradictions: [],
    });
  });

  test("round-trips V2 and persisted contradictions through IPC without stripping fields", () => {
    const brief = makeProjectBrief({
      assumptions: ["The buyer is the student"],
      openQuestions: ["Which study workflow hurts most?"],
      contradictions: ["Launch globally", "Support only one campus"],
    });
    const parsed = ConfirmBriefSchema.parse({ threadId: "thread-1", brief });

    expect(parsed.brief).toEqual(brief);
    expect(ProjectBriefV2Schema.parse(parsed.brief)).toEqual(brief);
    expect(() => ConfirmBriefSchema.parse({
      threadId: "thread-1",
      brief: { ...brief, silentlyDropped: true },
    })).toThrow();
  });

  test("preserves unknown legacy values as explicit assumptions", () => {
    const result = parseAndNormalizeBrief({
      ...legacyBrief,
      geographyHint: "Ukraine and Poland",
    });

    expect(result.assumptions).toContain("Legacy geography hint: Ukraine and Poland");
  });

  test("reopens a database containing legacy briefs and writes only V2 revisions", () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-brief-reopen-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "scraply.db");
    let db = new DatabaseClient(dbPath);
    let threads = new ThreadRepository(db);
    const thread = threads.createThread("Existing workspace");
    const now = new Date().toISOString();
    db.db.prepare(`
      INSERT INTO briefs (id, thread_id, version, brief_json, confirmed, created_at)
      VALUES ('legacy-brief', ?, 7, ?, 1, ?)
    `).run(thread.id, JSON.stringify(legacyBrief), now);
    db.close();

    db = new DatabaseClient(dbPath);
    threads = new ThreadRepository(db);
    const reopened = threads.getLatestBriefSnapshot(thread.id);
    expect(reopened?.version).toBe(7);
    expect(reopened?.brief.schemaVersion).toBe(2);

    threads.saveBrief(thread.id, reopened!.brief, true);
    const raw = db.db.prepare(`
      SELECT brief_json FROM briefs WHERE thread_id = ? ORDER BY version DESC LIMIT 1
    `).get(thread.id) as { brief_json: string };
    expect(JSON.parse(raw.brief_json)).toMatchObject({ schemaVersion: 2, title: "Legacy launch" });
    expect(JSON.parse(raw.brief_json)).not.toHaveProperty("projectName");
    db.close();
  });

  test("loads legacy research-run snapshots and branch inheritance as V2", () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-brief-snapshots-"));
    tempDirs.push(dir);
    const db = new DatabaseClient(join(dir, "scraply.db"));
    const threads = new ThreadRepository(db);
    const parent = threads.createThread("Parent");
    const child = threads.createThread("Child");
    const now = new Date().toISOString();

    db.db.prepare(`
      INSERT INTO research_runs (
        id, thread_id, status, config_json, brief_json, spend_estimate, round,
        cancelled, created_at, updated_at
      ) VALUES ('legacy-run', ?, 'running', ?, ?, 0, 0, 0, ?, ?)
    `).run(parent.id, JSON.stringify(DEFAULT_RUN_CONFIG), JSON.stringify(legacyBrief), now, now);
    db.db.prepare(`
      INSERT INTO branch_contexts (
        thread_id, parent_thread_id, seed_idea_id, seed_idea_title, exploration_angle,
        inherited_brief_json, inherited_brief_version, selected_claim_ids_json, created_at
      ) VALUES (?, ?, 'idea-1', 'Legacy idea', 'Inspect the niche', ?, 7, '["claim-1"]', ?)
    `).run(child.id, parent.id, JSON.stringify(legacyBrief), now);

    expect(loadStoredRunState(db, "legacy-run")?.brief).toMatchObject({
      schemaVersion: 2,
      title: "Legacy launch",
    });
    expect(threads.getBranchContext(child.id)?.inheritedBriefSnapshot).toMatchObject({
      schemaVersion: 2,
      title: "Legacy launch",
    });
    db.close();
  });
});
