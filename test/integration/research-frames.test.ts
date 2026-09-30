import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseClient } from "../../src/db/client";
import { ResearchFrameRepository } from "../../src/db/repositories/research-frames";
import { ResearchRunRepository } from "../../src/db/repositories/research-runs";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";
import type { ResearchFrame } from "../../src/shared/research-frame";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const frame: ResearchFrame = {
  goal: "Reduce food waste in a dorm kitchen", goalKind: "community-or-personal",
  contextFacts: [{ fact: "The pilot measured discarded food.", sourceIds: ["study"] }],
  successCriteria: [{ id: "waste", name: "Less discarded food", weight: "must", howJudged: "Weigh waste before and after the pilot", basis: "brief" }],
  constraints: [{ text: "No dedicated volunteer", kind: "team", basis: "brief" }],
  languages: ["en", "uk"], exclusions: ["Paid subscriptions"], openQuestions: [],
  areas: [{ id: "fridge", name: "Forgotten food", whyRelevant: "Unlabelled food stays in the shared fridge",
    affectedPeople: "Dorm residents", venues: [{ name: "Student community", kind: "community" }],
    exampleProblems: ["Residents forget leftovers"], included: true, priority: 1 }],
};
const sources = [{ id: "study", url: "https://example.org/study", title: "Dorm kitchen study", text: "The pilot measured discarded food." }];

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "scraply-frames-"));
  directories.push(directory);
  const path = join(directory, "scraply.db");
  const db = new DatabaseClient(path);
  const now = new Date().toISOString();
  db.db.prepare("INSERT INTO threads(id,title,status,created_at,updated_at) VALUES ('project','Dorm','new',?,?)").run(now, now);
  return { db, path };
}

test("approved frames survive restart and each run retains its original version", () => {
  const { db, path } = setup();
  const runs = new ResearchRunRepository(db);
  const run = runs.create("project", { ...DEFAULT_RUN_CONFIG, workflowVersion: 2 }).runId;
  const frames = new ResearchFrameRepository(db);
  const original = frames.createDraft({ threadId: "project", runId: run, frame, sources, knownProblem: false });
  const edited = { ...frame, goal: "Reduce forgotten leftovers" };
  frames.approve(original.id, "project", edited);
  runs.finish(run, "completed");
  const nextRun = runs.create("project", { ...DEFAULT_RUN_CONFIG, workflowVersion: 2 }).runId;
  const next = frames.createDraft({ threadId: "project", runId: nextRun, frame: { ...edited, languages: ["en"] }, sources, knownProblem: false });
  frames.approve(next.id, "project", next.draft);
  db.close();

  const reopened = new DatabaseClient(path);
  try {
    const saved = new ResearchFrameRepository(reopened);
    expect(saved.forRun(run)?.approved?.languages).toEqual(["en", "uk"]);
    expect(saved.latestApproved("project")?.version).toBe(2);
    expect(saved.latestApproved("project")?.approved?.languages).toEqual(["en"]);
    expect(() => saved.bindRun(run, "project", next.id)).toThrow("cannot change");
    expect(() => saved.approve(original.id, "project", frame)).toThrow("already been approved");
    expect(reopened.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { reopened.close(); }
});

test("approval rejects fabricated sources, excluded discovery coverage and cross-project references", () => {
  const { db } = setup();
  try {
    const runId = new ResearchRunRepository(db).create("project", { ...DEFAULT_RUN_CONFIG, workflowVersion: 2 }).runId;
    const frames = new ResearchFrameRepository(db);
    const saved = frames.createDraft({ threadId: "project", runId, frame, sources, knownProblem: false });
    expect(() => frames.approve(saved.id, "another-project", frame)).toThrow("does not belong");
    expect(() => frames.approve(saved.id, "project", { ...frame, contextFacts: [{ fact: "Unsupported", sourceIds: ["missing"] }] })).toThrow("unknown source");
    expect(() => frames.approve(saved.id, "project", { ...frame, areas: frame.areas.map((area) => ({ ...area, included: false })) })).toThrow("included research area");
    expect(frames.get(saved.id)?.approved).toBeNull();
  } finally { db.close(); }
});
