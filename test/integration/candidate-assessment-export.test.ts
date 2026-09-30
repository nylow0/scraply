import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBackend, type BackendHandle } from "../../src/backend/server";
import { DatabaseClient } from "../../src/db/client";
import { ResearchFrameRepository } from "../../src/db/repositories/research-frames";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";

const handles: BackendHandle[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test.each(["approved", "scope-derived", "legacy-scope-derived"] as const)("research export retains %s assessment and original candidate frame provenance", async source => {
  const directory = mkdtempSync(join(tmpdir(), "scraply-assessment-export-")); directories.push(directory);
  const dbPath = join(directory, "test.db");
  const db = new DatabaseClient(dbPath);
  const now = new Date().toISOString();
  db.db.prepare("INSERT INTO threads (id,title,status,created_at,updated_at) VALUES ('project','Filing','problems-ready',?,?)").run(now, now);
  for (const id of ["source", "assessment"]) db.db.prepare(`INSERT INTO research_runs
    (id,thread_id,status,config_json,workflow_version,created_at,updated_at) VALUES (?,'project','completed',?,2,?,?)`)
    .run(id, JSON.stringify(DEFAULT_RUN_CONFIG), now, now);
  const frames = new ResearchFrameRepository(db);
  const first = frames.createDraft({ threadId: "project", runId: "source", knownProblem: true, sources: [], frame: {
    goal: "Reduce filing delays", goalKind: "process-improvement", contextFacts: [],
    successCriteria: [{ id: "delay", name: "Less time filing", weight: "must", howJudged: "Observe time", basis: "brief" }],
    constraints: [], languages: ["en"], exclusions: [], openQuestions: [], areas: [],
  } });
  const approved = frames.approve(first.id, "project", first.draft);
  const edited = frames.createApprovedVersion(first.id, "project", { ...first.draft, goal: "Reduce duplicate entries", exclusions: ["Accounting replacement"] });
  if (source === "approved") frames.bindRun("assessment", "project", edited.id);
  const candidate = { statement: "Owners lose time filing", whyItPersists: "Disconnected tools", affected: "Shop owners", scaleEstimate: "Unknown",
    scaleBasisFactorId: null, factorIds: [], alternativeExplanations: ["One old process"], unknowns: ["Other shops"],
    intendedBuyerEvidenceFactorIds: [], evidenceGap: "Another owner account" };
  db.db.prepare(`INSERT INTO rejected_problem_candidates (id,discovery_run_id,statement,reason,disposition,candidate_json,created_at)
    VALUES ('candidate','source',?,'Depth limit','not-assessed',?,?)`).run(candidate.statement, JSON.stringify(candidate), now);
  const provenance = source === "approved"
    ? { kind: "approved-frame", frameId: edited.id, frameVersion: edited.version, sourceRunId: "source", candidateId: "candidate" }
    : { kind: "reconstructed-from-saved-scope", sourceRunId: "source", note: "Saved scope fallback",
      ...(source === "scope-derived" ? { candidateId: "candidate" } : {}) };
  db.db.prepare("INSERT INTO workflow_snapshots VALUES ('assessment','candidate-assessment-frame',?)")
    .run(JSON.stringify({ frame: source === "approved" ? edited.approved : approved.approved, provenance }));
  frames.createApprovedVersion(edited.id, "project", { ...edited.approved!, goal: "Later unrelated goal" });
  db.close();
  const handle = await startBackend({ dataDir: directory, dbPath, bundledPromptsDir: join(process.cwd(), "prompts"),
    promptOverridesDir: join(directory, "prompts"), appVersion: "test", getSecrets: () => ({ exaApiKey: null }) }, () => {});
  handles.push(handle);
  const response = await fetch(`http://127.0.0.1:${handle.port}/research/export`, { method: "POST",
    headers: { authorization: `Bearer ${handle.token}`, "content-type": "application/json" }, body: JSON.stringify({ threadId: "project" }) });
  expect(response.status).toBe(200);
  const bundle = (await response.json() as { data: { content: string } }).data;
  const exported = JSON.parse(bundle.content) as { researchFrame?: { id: string; version: number }; assessmentFrame: {
    frame: typeof first.draft; provenance: typeof provenance; sourceCandidate?: typeof candidate;
    sourceResearchFrame: { id: string; version: number; approved: typeof first.draft };
  } };
  expect(exported.assessmentFrame.provenance).toEqual(provenance);
  expect(exported.assessmentFrame.sourceResearchFrame).toMatchObject({ id: first.id, version: first.version, approved: approved.approved });
  expect(exported.assessmentFrame.sourceCandidate).toEqual(source === "legacy-scope-derived" ? undefined : candidate);
  if (source === "approved") {
    expect(exported.researchFrame).toMatchObject({ id: edited.id, version: edited.version });
    expect(exported.assessmentFrame.frame).toEqual(edited.approved!);
  } else expect(exported.researchFrame).toBeUndefined();
});
