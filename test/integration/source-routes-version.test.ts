import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowExecution, workflowSearchKey } from "../../src/core/workflow-execution";
import { prepareWorkflowSearch, UnknownSearchCompletionError } from "../../src/core/workflow-search-attempts";
import { runManagedInvestigatorSearch } from "../../src/core/evidence-investigators";
import { configurePromptPaths } from "../../src/core/prompts";
import { DatabaseClient } from "../../src/db/client";
import { OpportunityExplorationRepository } from "../../src/db/repositories/opportunity-exploration";
import { WorkflowRepository } from "../../src/db/repositories/workflows";
import { routeSearchOptions } from "../../src/providers/source-routes";
import type { SearchOptions } from "../../src/providers/search";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";

const directories: string[] = [];
const source = { id: "saved-study", url: "https://bmchealthservres.biomedcentral.com/articles/saved-study",
  title: "Retrieved study", text: "A saved measured result." };
const venue = { name: "BMC Health Services Research", domain: "bmchealthservres.biomedcentral.com", kind: "publication" as const };
const query = "clinic administration measured study";

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "scraply-routing-version-"));
  directories.push(directory);
  configurePromptPaths({ bundledDir: join(process.cwd(), "prompts"), overrideDir: null });
  const db = new DatabaseClient(join(directory, "scraply.db"));
  const now = new Date().toISOString();
  db.db.prepare("INSERT INTO threads (id,title,status,created_at,updated_at) VALUES ('thread','Clinic','configuring',?,?)").run(now, now);
  db.db.prepare("INSERT INTO research_runs (id,thread_id,status,config_json,workflow_version,created_at,updated_at) VALUES ('run','thread','running',?,2,?,?)")
    .run(JSON.stringify(DEFAULT_RUN_CONFIG), now, now);
  new WorkflowExecution(db, "run");
  // This fixture represents a run admitted before the route correction, with its original prompts.
  db.db.prepare("UPDATE workflow_snapshots SET value_json = ? WHERE research_run_id = 'run' AND snapshot_key = 'source-routes'")
    .run('{"version":1}');
  return db;
}

function studiesOptions(execution: WorkflowExecution): Omit<SearchOptions, "signal"> {
  return { ...routeSearchOptions("studies-official", { venues: [venue], languages: ["en"],
    legacyPublicationDomainCategory: execution.read<{ version: number }>("source-routes")?.version !== 2 }),
    numResults: 4, maxCharacters: 6_000 };
}

test("a completed v1 publication-domain search replays the original canonical receipt without dispatch", async () => {
  const db = fixture();
  try {
    const execution = new WorkflowExecution(db, "run");
    const parameters = studiesOptions(execution);
    let calls = 0;
    const searched = await execution.search({ provider: "exa", async search(_query, options) {
      calls++;
      expect(options).toMatchObject({ includeDomains: [venue.domain], category: "publication" });
      return [source];
    } }).search(query, parameters);
    expect(searched).toEqual([source]);
    const saved = db.db.prepare("SELECT * FROM workflow_snapshots WHERE research_run_id = 'run' ORDER BY snapshot_key").all();
    const restarted = new WorkflowExecution(db, "run");
    const resumedParameters = studiesOptions(restarted);
    expect(workflowSearchKey(query, resumedParameters, "exa")).toBe(workflowSearchKey(query, parameters, "exa"));
    expect(await restarted.search({ provider: "exa", async search() { calls++; throw new Error("Must reuse paid result"); } })
      .search(query, resumedParameters)).toEqual([source]);
    expect(calls).toBe(1);
    expect(restarted.read<{ version: number }>("source-routes")).toEqual({ version: 1 });
    expect(db.db.prepare("SELECT * FROM workflow_snapshots WHERE research_run_id = 'run' ORDER BY snapshot_key").all()).toEqual(saved);
  } finally { db.close(); }
});

test("a known failed v1 publication-domain search keeps its identity until an explicit retry", async () => {
  const db = fixture();
  try {
    const execution = new WorkflowExecution(db, "run");
    const parameters = studiesOptions(execution);
    let calls = 0;
    await expect(execution.search({ provider: "exa", async search() {
      calls++;
      throw new Error("UNSUPPORTED_PUBLICATION_INCLUDE_FILTER");
    } }).search(query, parameters)).rejects.toThrow("UNSUPPORTED_PUBLICATION_INCLUDE_FILTER");
    const failed = db.db.prepare("SELECT * FROM workflow_snapshots WHERE research_run_id = 'run' AND snapshot_key LIKE 'search-terminal:%'").get();
    const restarted = new WorkflowExecution(db, "run");
    expect(calls).toBe(1);
    expect(restarted.read<{ version: number }>("source-routes")).toEqual({ version: 1 });
    expect(workflowSearchKey(query, studiesOptions(restarted), "exa")).toBe(workflowSearchKey(query, parameters, "exa"));
    expect(await restarted.search({ provider: "exa", async search(_query, options) {
      calls++;
      expect(options).toMatchObject({ includeDomains: [venue.domain], category: "publication" });
      return [source];
    } }).search(query, studiesOptions(restarted))).toEqual([source]);
    expect(calls).toBe(2);
    expect(db.db.prepare("SELECT * FROM workflow_snapshots WHERE research_run_id = 'run' AND snapshot_key = ?")
      .get((failed as { snapshot_key: string }).snapshot_key)).toEqual(failed);
    expect(db.db.prepare("SELECT count(*) AS count FROM workflow_snapshots WHERE research_run_id = 'run' AND snapshot_key LIKE 'search-attempt:%'").get())
      .toEqual({ count: 2 });
  } finally { db.close(); }
});

test("an unknown v1 publication-domain search cannot bypass the exact acknowledgment through new routing", async () => {
  const db = fixture();
  try {
    const execution = new WorkflowExecution(db, "run");
    const parameters = studiesOptions(execution);
    const previous = prepareWorkflowSearch(db, "run", { key: workflowSearchKey(query, parameters, "exa"),
      query, parameters, provider: "exa" }, []);
    const priorRow = db.db.prepare("SELECT * FROM workflow_snapshots WHERE research_run_id = 'run' AND snapshot_key LIKE 'search-attempt:%'").get();
    let calls = 0;
    const client = { provider: "exa" as const, async search(_query: string, options?: SearchOptions) {
      calls++;
      expect(options).toMatchObject({ includeDomains: [venue.domain], category: "publication" });
      return [source];
    } };
    for (const acknowledgment of [[], ["unrelated-attempt"]]) {
      const restarted = new WorkflowExecution(db, "run", acknowledgment);
      await expect(restarted.search(client).search(query, studiesOptions(restarted))).rejects.toBeInstanceOf(UnknownSearchCompletionError);
      expect(calls).toBe(0);
      expect(db.db.prepare("SELECT * FROM workflow_snapshots WHERE research_run_id = 'run' AND snapshot_key LIKE 'search-attempt:%'").get()).toEqual(priorRow);
    }
    const acknowledged = new WorkflowExecution(db, "run", [previous.id]);
    expect(await acknowledged.search(client).search(query, studiesOptions(acknowledged))).toEqual([source]);
    expect(calls).toBe(1);
    expect(acknowledged.read(`search-acknowledged:${previous.id}`)).toMatchObject({ attemptId: previous.id });
    expect(db.db.prepare("SELECT * FROM workflow_snapshots WHERE research_run_id = 'run' AND snapshot_key = ?")
      .get((priorRow as { snapshot_key: string }).snapshot_key)).toEqual(priorRow);
    expect(acknowledged.read<{ version: number }>("source-routes")).toEqual({ version: 1 });
  } finally { db.close(); }
});

test("prepared and completed investigator study searches retain their frozen v1 parameters under v2 routing", async () => {
  const db = fixture();
  try {
    db.immediateTransaction(() => {
      const repository = new WorkflowRepository(db);
      repository.createSession({ id: "session", threadId: "thread", purpose: "discovery", mode: "vibe", contract: {}, remainingMs: 60_000 });
      repository.createWorkItem({ id: "item", sessionId: "session", kind: "evidence-check", scopeKey: "study-gap", input: {}, state: "ready" });
      repository.updateWorkItem("item", "running");
    });
    const input = { db, threadId: "thread", sessionId: "session", workItemId: "item", searchProvider: "exa" as const,
      request: { key: "study-gap", query, route: "studies-official" as const, evidenceNeeded: "A measured observation" },
      signal: new AbortController().signal };
    await expect(runManagedInvestigatorSearch({ ...input,
      sourceRouting: { venues: [venue], legacyPublicationDomainCategory: true } })).rejects.toThrow("unavailable");
    const repository = new OpportunityExplorationRepository(db);
    const prepared = repository.loadAttempt("thread", "investigator-search:study-gap", "session")!;
    expect(prepared.input).toMatchObject({ parameters: { includeDomains: [venue.domain], category: "publication" } });
    let calls = 0;
    const result = await runManagedInvestigatorSearch({ ...input,
      sourceRouting: { venues: [venue], legacyPublicationDomainCategory: false },
      searchClient: { provider: "exa", async search(_query, options) {
        calls++;
        expect(options).toMatchObject({ includeDomains: [venue.domain], category: "publication" });
        return [source];
      } } });
    const completed = repository.loadAttempt("thread", "investigator-search:study-gap", "session")!;
    expect(completed.input).toEqual(prepared.input);
    expect(completed.attemptId).toBe(prepared.attemptId);
    expect(await runManagedInvestigatorSearch({ ...input, sourceRouting: { venues: [venue], legacyPublicationDomainCategory: false } }))
      .toEqual({ ...result, replayed: true });
    expect(calls).toBe(1);
    expect(repository.loadAttempt("thread", "investigator-search:study-gap", "session")).toEqual(completed);
  } finally { db.close(); }
});
