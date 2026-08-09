import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { renderPhase1AblationMarkdown } from "../src/core/discovery-markdown";
import { runPhase1Ablation, type DiscoveryDepth } from "../src/core/discovery";
import { configurePromptPaths } from "../src/core/prompts";
import { DatabaseClient } from "../src/db/client";
import { DiscoveryRepository } from "../src/db/repositories/discovery";
import { CodexClient } from "../src/providers/codex";
import { EXA_CATEGORIES, ExaClient, type ExaCategory } from "../src/providers/exa";
import { ScopeSchema, type Scope } from "../src/shared/structured-output-schemas";

const [scopeArgument, outputArgument] = process.argv.slice(2);
if (!scopeArgument) {
  throw new Error("Usage: bun run phase1:gate -- <scope.json> [output-directory]");
}
if (process.env.SCRAPLY_PHASE1_GATE_AUTHORIZED !== "1") {
  throw new Error(
    "Live provider use is disabled. Clear the prompt cache with explicit approval, then set SCRAPLY_PHASE1_GATE_AUTHORIZED=1.",
  );
}

const exaKey = process.env.EXA_API_KEY;
if (!exaKey) throw new Error("EXA_API_KEY is required for the live Phase 1 gate");
const appData = process.env.APPDATA;
if (!appData) throw new Error("APPDATA is required to resolve Scraply's prompt cache");

const scopePath = resolve(scopeArgument);
const outputDirectory = resolve(outputArgument ?? join("artifacts", `phase1-gate-${timestamp()}`));
const promptCache = join(appData, "scraply", "scraply", "prompts");
const scope = ScopeSchema.parse(JSON.parse(await readFile(scopePath, "utf8"))) as Scope;
const depth = parseDepth(process.env.SCRAPLY_DISCOVERY_DEPTH);
const model = process.env.SCRAPLY_CODEX_MODEL ?? "gpt-5.2-codex";
const seed = parseSeed(process.env.SCRAPLY_DISCOVERY_SEED);

await mkdir(outputDirectory, { recursive: true });
configurePromptPaths({ bundledDir: resolve("prompts"), overrideDir: promptCache });
console.log(`Prompt cache: ${promptCache}`);
console.log(`Output directory: ${outputDirectory}`);
console.log(`Factor shuffle seed: ${seed} (replay with SCRAPLY_DISCOVERY_SEED=${seed})`);

const database = new DatabaseClient(join(outputDirectory, "phase1-gate.sqlite"));
const repository = new DiscoveryRepository(database);
const armARunId = crypto.randomUUID();
const armCRunId = crypto.randomUUID();
try {
  createGateRun(database, armARunId, "Phase 1 Arm A", depth, model);
  createGateRun(database, armCRunId, "Phase 1 Arm C", depth, model);
  repository.persistScope(armARunId, scope);
  repository.persistScope(armCRunId, scope);

  const result = await runPhase1Ablation(scope, {
    modelClient: new CodexClient(),
    exa: new ExaClient(exaKey),
    model,
    depth,
    audienceSearch: parseAudienceSearch(),
    random: seededRandom(seed),
    onProjection: (message) => console.log(message),
  });

  repository.persistFactors(
    armARunId,
    result.harvest.sources,
    result.harvest.factors,
  );
  repository.persistProblems(armARunId, result.armA.killSources, result.armA.problems);
  repository.persistProblems(armCRunId, result.armC.killSources, result.armC.problems);
  finishGateRun(database, armARunId, "completed");
  finishGateRun(database, armCRunId, "completed");

  const artifacts = renderPhase1AblationMarkdown(result);
  await Promise.all([
    writeFile(join(outputDirectory, "arm-a.md"), artifacts.armA, "utf8"),
    writeFile(join(outputDirectory, "arm-c.md"), artifacts.armC, "utf8"),
    writeFile(join(outputDirectory, "metrics.json"), JSON.stringify({
      depth,
      model,
      seed,
      harvest: result.harvest.metrics,
      rejections: result.harvest.rejections,
      armAFactorUtilizationRate: result.armA.factorUtilizationRate,
    }, null, 2), "utf8"),
  ]);
  console.log("Gate artifacts written: arm-a.md, arm-c.md, metrics.json, phase1-gate.sqlite");
  console.log("PASS/FAIL requires human comparison of Arm A with Arm C; no overlap score was computed.");
} catch (error) {
  finishGateRun(database, armARunId, "failed");
  finishGateRun(database, armCRunId, "failed");
  throw error;
} finally {
  database.close();
}

function createGateRun(
  client: DatabaseClient,
  runId: string,
  title: string,
  depth: DiscoveryDepth,
  model: string,
): void {
  const threadId = crypto.randomUUID();
  const now = new Date().toISOString();
  client.db.prepare(`
    INSERT INTO threads (id, title, status, created_at, updated_at)
    VALUES (?, ?, 'research-running', ?, ?)
  `).run(threadId, title, now, now);
  client.db.prepare(`
    INSERT INTO research_runs (id, thread_id, status, config_json, created_at, updated_at)
    VALUES (?, ?, 'running', ?, ?, ?)
  `).run(runId, threadId, JSON.stringify({ model, discoveryDepth: depth }), now, now);
}

function finishGateRun(client: DatabaseClient, runId: string, status: "completed" | "failed"): void {
  client.db.prepare(`
    UPDATE research_runs SET status = ?, updated_at = ? WHERE id = ?
  `).run(status, new Date().toISOString(), runId);
}

function parseDepth(value: string | undefined): DiscoveryDepth {
  if (!value) return "standard";
  if (value === "quick" || value === "standard" || value === "deep") return value;
  throw new Error(`SCRAPLY_DISCOVERY_DEPTH must be quick, standard, or deep; received ${value}`);
}

function parseAudienceSearch(): {
  includeDomains?: string[];
  category?: ExaCategory;
  startPublishedDate?: string;
} {
  const includeDomains = process.env.SCRAPLY_AUDIENCE_DOMAINS
    ?.split(",")
    .map((domain) => domain.trim())
    .filter(Boolean);
  return {
    ...(includeDomains?.length ? { includeDomains } : {}),
    ...(process.env.SCRAPLY_AUDIENCE_CATEGORY
      ? { category: parseCategory(process.env.SCRAPLY_AUDIENCE_CATEGORY) }
      : {}),
    ...(process.env.SCRAPLY_AUDIENCE_START_DATE
      ? { startPublishedDate: process.env.SCRAPLY_AUDIENCE_START_DATE }
      : {}),
  };
}

function parseCategory(value: string): ExaCategory {
  const category = EXA_CATEGORIES.find((candidate) => candidate === value);
  if (!category) {
    throw new Error(
      `SCRAPLY_AUDIENCE_CATEGORY must be one of: ${EXA_CATEGORIES.join(", ")}; received ${value}`,
    );
  }
  return category;
}

function parseSeed(value: string | undefined): number {
  if (!value) return Math.floor(Math.random() * 2 ** 32);
  const seed = Number(value);
  if (!Number.isInteger(seed) || seed < 0) {
    throw new Error(`SCRAPLY_DISCOVERY_SEED must be a non-negative integer; received ${value}`);
  }
  return seed;
}

/** mulberry32 — the factor shuffle must be replayable so two gate runs can be compared. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 2 ** 32;
  };
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
