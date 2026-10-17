import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DatabaseClient } from "../../../src/db/client";
import { ThreadRepository } from "../../../src/db/repositories/threads";
import { ResearchRunRepository } from "../../../src/db/repositories/research-runs";
import { DiscoveryRepository } from "../../../src/db/repositories/discovery";
import { WorkflowRepository } from "../../../src/db/repositories/workflows";
import { APP_CHANNELS, ListProjectsResultSchema, ListRunsResultSchema, ProjectDetailSchema } from "../../../src/shared/cli-contracts";
import { canonicalJson, sha256 } from "../../../src/shared/content-identity";
import { DEFAULT_RUN_CONFIG } from "../../../src/shared/schemas";
import { WorkflowDetailSchema, WorkflowLaunchContractSchema } from "../../../src/shared/workflow-contracts";
import { CliEnvelopeSchema, createCliFixture } from "../../fixtures/cli-process";
import { NATIVE_WORKFLOW_MODEL } from "../../fixtures/native-workflow-backend";
import { readOwnerMetadata } from "../../../src/app/owner";

const fixtures: ReturnType<typeof createCliFixture>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });

// Historical formats are invented directly before the owner starts. No installed
// database is read, and tests never open SQLite while the owner holds its lock.
function seedHistory(item: ReturnType<typeof createCliFixture>) {
  mkdirSync(item.dataDir, { recursive: true });
  const db = new DatabaseClient(item.dbPath);
  try {
    const now = "2025-06-18T10:00:00.000Z";
    const threads = new ThreadRepository(db);
    const config = { ...DEFAULT_RUN_CONFIG, model: NATIVE_WORKFLOW_MODEL, reasoningEffort: "medium", workflowVersion: 1 as const };
    const create = (id: string, title: string) => {
      db.db.prepare("INSERT INTO threads (id,title,status,created_at,updated_at) VALUES (?,?,'ideas-ready',?,?)").run(id, title, now, now);
      threads.saveRunConfig(id, config);
      threads.saveScope(id, { title, audience: "Repair shops", domain: "Parts delivery", observations: "Synthetic historical delivery desk.", offLimits: [] });
      return id;
    };
    const active = create("synthetic-current-project", "Indigo current desk");
    const archived = create("synthetic-history-amber", "Amber saved route");
    const duplicateA = create("synthetic-duplicate-a", "Birch shared title");
    const duplicateB = create("synthetic-duplicate-b", "Birch shared title");
    threads.archiveThread(archived, true);
    db.setSetting("active_thread_id", active);
    const scope = threads.getScope(archived)!;
    const runs = new ResearchRunRepository(db);
    const { runId } = runs.create(archived, config);
    const discovery = new DiscoveryRepository(db);
    discovery.persistScope(runId, scope);
    discovery.persistProblems(runId, [], [{ id: "synthetic-v1-problem", statement: "Synthetic couriers lack arrival windows.",
      whyItPersists: "Carriers publish broad ranges.", affected: "Independent repair desks", scaleEstimate: "Not measured",
      scaleBasisFactorId: null, factorIds: [], verdict: "user-asserted", verdictReason: "Historical user assertion.", verdictSourceIds: [] }]);
    runs.finish(runId, "completed");
    const ideaRun = runs.create(archived, config, "synthetic-v1-problem");
    const ideaId = "synthetic-v1-idea";
    db.db.prepare("UPDATE problems SET selected_at = ? WHERE id = 'synthetic-v1-problem'").run(now);
    db.db.prepare(`INSERT INTO solutions (id,problem_id,research_run_id,mechanism,description,respects_off_limits,respects_off_limits_why,created_at)
      VALUES (?,?,?,'Synthetic route board','An invented paper route board with manually entered arrival windows.',1,'Uses existing dispatch data.',?)`)
      .run(ideaId, "synthetic-v1-problem", ideaRun.runId, now);
    runs.finish(ideaRun.runId, "completed");

    // This admitted contract predates research frames. Reading/exporting it must
    // retain its original instructions and must never upgrade or restart it.
    const olderConfig = { ...config, workflowVersion: 2 as const };
    const resolvedInstructions = { research: "Saved synthetic research instructions.", ideas: "Saved synthetic idea instructions.", review: "Saved synthetic review instructions." };
    const contract = WorkflowLaunchContractSchema.parse({ contractVersion: 1, purpose: "discovery", mode: "babysit",
      brief: "Synthetic dispatch archive", scope, runConfig: olderConfig, targets: { kind: "per-problem", ideaCount: 1 },
      limits: { enforced: true, maxMinutes: 10, maxModelCalls: 4, maxSearches: 2 }, instructions: {}, resolvedInstructions,
      instructionHashes: Object.fromEntries(Object.entries(resolvedInstructions).map(([kind, text]) => [kind, sha256(text)])),
    });
    const session = db.immediateTransaction(() => {
      const workflows = new WorkflowRepository(db);
      const saved = workflows.createSession({ id: "synthetic-pre-frame-session", threadId: archived, purpose: "discovery", mode: "babysit", contract, remainingMs: 60_000, startedAt: now });
      return workflows.updateSession(saved.id, saved.revision, { state: "finished", outcome: "partial", finishedAt: now });
    });
    const storedContract = canonicalJson(contract);
    return { active, archived, duplicateA, duplicateB, runId, ideaId, sessionId: session.id, storedContract };
  } finally { db.close(); }
}

describe("standalone CLI saved-work compatibility and ownership", () => {
  test("v1 ideas and pre-frame contracts list and export through an archived project without changing the selected default", async () => {
    const item = createCliFixture({ search: "none" });
    fixtures.push(item);
    const saved = seedHistory(item);
    await item.start();
    const listed = await item.json(["project", "list"], ListProjectsResultSchema);
    expect(listed.projects.some(project => project.id === saved.archived)).toBe(false);
    expect(listed.activeThreadId).toBe(saved.active);
    const archived = await item.json(["project", "list", "--archived"], ListProjectsResultSchema);
    expect(archived.projects.some(project => project.id === saved.archived)).toBe(true);
    for (const selector of [saved.archived, "synthetic-history", "Amber saved route"]) {
      const project = await item.json(["project", "show", selector], ProjectDetailSchema);
      expect(project.thread.id).toBe(saved.archived);
      expect(project.workspace.activeThreadId).toBe(saved.archived);
    }
    const runs = await item.json(["run", "list", "--project", saved.archived], ListRunsResultSchema);
    expect(runs.runs.some(run => run.kind === "research" && run.runId === saved.runId)).toBe(true);
    expect(runs.runs.some(run => run.kind === "workflow" && run.sessionId === saved.sessionId)).toBe(true);
    const session = await item.json(["run", "show", saved.sessionId], WorkflowDetailSchema);
    expect(session.summary).toMatchObject({ state: "finished", outcome: "partial" });
    const researchPath = join(item.profileDir, "old-research.json");
    await item.json(["export", "research", "--project", saved.archived, "--out", researchPath], z.unknown());
    expect(JSON.stringify(JSON.parse(readFileSync(researchPath, "utf8")) as unknown)).toContain("Synthetic couriers lack arrival windows.");
    for (const format of ["md", "json"]) {
      const directory = join(item.profileDir, `old-ideas-${format}`);
      await item.json(["export", "ideas", "--project", saved.archived, "--format", format, "--out", directory], z.unknown());
      const files = readdirSync(directory);
      expect(files.length).toBeGreaterThan(0);
      const contents = [];
      for (const name of files) {
        const content = readFileSync(join(directory, name), "utf8");
        const parsed: unknown = format === "json" ? JSON.parse(content) : content;
        contents.push(parsed);
      }
      expect(JSON.stringify(contents)).toContain("An invented paper route board");
    }
    expect((await item.json(["project", "list", "--archived"], ListProjectsResultSchema)).activeThreadId).toBe(saved.active);
    expect(item.admissions()).toEqual({ models: [], searches: [], providerProbes: [] });
    await item.stop();
    // Await complete shutdown before inspecting stored bytes, then restart and
    // read again to prove exports did not mutate the historical contract.
    const db = new DatabaseClient(item.dbPath);
    try {
      const row = z.object({ contract_json: z.string() }).parse(db.db.prepare("SELECT contract_json FROM workflow_sessions WHERE id = ?").get(saved.sessionId));
      expect(row.contract_json).toBe(saved.storedContract);
    } finally { db.close(); }
    await item.start();
    expect((await item.json(["project", "list", "--archived"], ListProjectsResultSchema)).activeThreadId).toBe(saved.active);
    expect(item.admissions()).toEqual({ models: [], searches: [], providerProbes: [] });
  }, 45_000);

  test("exact IDs win, duplicate titles and shared prefixes fail with candidates, and free reads retain the default", async () => {
    const item = createCliFixture();
    fixtures.push(item);
    const saved = seedHistory(item);
    await item.start();
    expect((await item.json(["project", "show", saved.duplicateA], ProjectDetailSchema)).thread.id).toBe(saved.duplicateA);
    for (const reference of ["Birch shared title", "synthetic-duplicate-"]) {
      const rejected = await item.run(["project", "show", reference]);
      expect(rejected.code).toBe(1);
      const response = CliEnvelopeSchema.parse(JSON.parse(rejected.stdout));
      if (response.ok) throw new Error("Ambiguous project unexpectedly resolved.");
      const recovery = z.object({ candidates: z.array(z.object({ id: z.string() })) }).parse(response.error.recovery);
      expect(recovery.candidates.map(candidate => candidate.id).sort()).toEqual([saved.duplicateA, saved.duplicateB]);
    }
    await item.json(["brief", "show", "--project", saved.archived], z.unknown());
    await item.json(["config", "show", "--project", saved.duplicateA], z.unknown());
    await item.json(["idea", "list", "--project", saved.archived], z.unknown());
    expect((await item.json(["project", "list", "--archived"], ListProjectsResultSchema)).activeThreadId).toBe(saved.active);
    await item.json(["project", "select", saved.duplicateB], z.unknown());
    expect((await item.json(["project", "list"], ListProjectsResultSchema)).activeThreadId).toBe(saved.duplicateB);
    expect(item.admissions()).toEqual({ models: [], searches: [], providerProbes: [] });
  }, 30_000);

  test("a competing process cannot initialize an app and a mismatched client cannot invoke an existing owner", async () => {
    const item = createCliFixture();
    fixtures.push(item);
    await item.start();
    const metadata = await readOwnerMetadata(item.profileDir);
    if (!metadata) throw new Error("The fixture owner has no metadata.");
    const before = readFileSync(join(item.dataDir, "factory-started.txt"), "utf8");
    const contender = await item.contend();
    expect(contender.code).not.toBe(0);
    expect(contender.stderr).toContain("Another Scraply owner");
    expect(readFileSync(join(item.dataDir, "factory-started.txt"), "utf8")).toBe(before);
    const mismatched = await item.owner("99.0.0-synthetic");
    await expect(mismatched.invoke(APP_CHANNELS.LIST_PROJECTS, {})).rejects.toMatchObject({ code: "OWNER_VERSION_MISMATCH" });
    expect((await item.json(["host", "status"], z.object({ owner: z.object({ version: z.string(), pid: z.number() }) }))).owner.pid).toBe(metadata.pid);
    expect(item.admissions()).toEqual({ models: [], searches: [], providerProbes: [] });
  }, 30_000);
});
