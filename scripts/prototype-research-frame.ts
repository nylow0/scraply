import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { createCredentialStore } from "../src/main/credential-store";
import { ExaClient } from "../src/providers/exa";
import { PerplexityClient } from "../src/providers/perplexity";
import { RuntimeClient } from "../src/providers/runtime";
import { ProviderFailure, type StructuredStageResult } from "../src/providers/structured";
import { deriveJsonSchema } from "../src/shared/json-schema";
import {
  FrameSearchPlanSchema, parseResearchFrame, ResearchFrameOutputSchema, ResearchFrameSchema, ResearchGoalKindSchema,
  type ResearchFrame,
} from "../src/shared/research-frame";
import { GenerationMetadataSchema } from "../src/shared/runtime-protocol";
import { ModelRefSchema, ReasoningEffortSchema, SourceSchema } from "../src/shared/schemas";
import { ScopeSchema } from "../src/shared/structured-output-schemas";

const FixtureSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  goalKind: ResearchGoalKindSchema,
  scope: ScopeSchema,
  runSettings: z.object({
    model: ModelRefSchema,
    reasoningEffort: ReasoningEffortSchema,
    searchProvider: z.enum(["exa", "perplexity"]),
    explorationPurpose: z.enum(["general-solutions", "startup-opportunities"]),
  }),
});
const ArtifactSchema = z.object({ version: z.string(), sourceCommit: z.string(), sha256: z.string() });
const MechanicalCheckSchema = z.object({ name: z.string(), passed: z.boolean(), note: z.string() }).strict();
const ResultSchema = z.object({
  fixtureId: z.string(), expectedGoalKind: ResearchGoalKindSchema, frame: ResearchFrameSchema,
  searches: z.number().int().nonnegative().max(5), modelCalls: z.literal(2), sourceCount: z.number().int().nonnegative(),
  wallMs: z.number().nonnegative(), searchMs: z.number().nonnegative(),
  generationMetadata: z.array(GenerationMetadataSchema).length(2),
  mechanicalChecks: z.array(MechanicalCheckSchema),
}).strict();
const MANUAL_CHECKS = ["goal and buyer lens", "area breadth and distinctness", "affected people and real venues", "context facts supported by cited text", "criteria and constraints grounded", "useful open questions", "languages and regions appropriate"] as const;
class PrototypeError extends Error {}
const ManualReviewSchema = z.object({
  reviewer: z.string().trim().min(1),
  reviewedAt: z.string().datetime(),
  fixtures: z.array(z.object({
    fixtureId: z.string(),
    checks: z.array(z.object({
      name: z.enum(MANUAL_CHECKS), status: z.enum(["pass", "fail", "pending"]), note: z.string().trim().min(1),
    }).strict()).length(MANUAL_CHECKS.length),
  }).strict()),
}).strict();

// The runner and its windowless Electron host use one entrypoint. Credentials never leave that host's memory.
const { values } = parseArgs({ options: {
  live: { type: "boolean", default: false }, host: { type: "boolean", default: false },
  "continue-untouched": { type: "boolean", default: false },
  "only-fixture": { type: "string" },
  checkout: { type: "string" }, fixtures: { type: "string" }, output: { type: "string" },
  revision: { type: "string", default: "1" }, review: { type: "string" },
  "runtime-path": { type: "string" }, "runtime-lock": { type: "string" },
  help: { type: "boolean", default: false },
} });

async function main() {
  const checkout = resolve(values.checkout ?? resolve(dirname(process.argv[1]!), ".."));
  const fixtureDirectory = resolve(values.fixtures ?? join(checkout, "test/eval/briefs"));
  const revision = Number(values.revision);
  if (!Number.isInteger(revision) || revision < 1 || revision > 3) throw new PrototypeError("Prototype prompt revision must be 1, 2 or 3. Redesign after the third failed gate.");
  if (values.help) {
    console.log("bun scripts/prototype-research-frame.ts [--live] [--fixtures DIRECTORY] [--revision 1..3] [--output build/prototypes/RUN] [--continue-untouched | --only-fixture ID] [--runtime-path EXE --runtime-lock JSON]");
    console.log("Without --live: validate the eight fixture briefs and print the bounded call/search estimate. --review FILE rechecks saved results and records explicit semantic review.");
    console.log("--continue-untouched requires an existing run and skips every fixture with any generation ledger, including failed or uncertain calls. It never retries them.");
    console.log("--only-fixture creates a separate bounded probe for one suite brief. An incomplete earlier request needs explicit user authorization before a fresh probe.");
    return;
  }
  const output = resolve(values.output ?? join(checkout, "build/prototypes", `research-frame-r${revision}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`));
  const outputRelative = relative(join(checkout, "build/prototypes"), output);
  if (!outputRelative || outputRelative === ".." || outputRelative.startsWith(`..${sep}`) || resolve(outputRelative) === outputRelative) throw new PrototypeError("Output must be a run directory under this checkout's build/prototypes/.");
  if (values.review) {
    if (!values.output) throw new PrototypeError("--review requires --output pointing to the saved prototype run.");
    summarize(output, ManualReviewSchema.parse(JSON.parse(readFileSync(resolve(values.review), "utf8"))));
    return;
  }
  const suite = readdirSync(fixtureDirectory).filter(file => file.endsWith(".json")).sort()
    .map(file => FixtureSchema.parse(JSON.parse(readFileSync(join(fixtureDirectory, file), "utf8"))));
  if (suite.length !== 8 || new Set(suite.map(fixture => fixture.id)).size !== 8) throw new PrototypeError("The gate requires all eight distinct suite briefs.");
  if (values["only-fixture"] && values["continue-untouched"]) throw new PrototypeError("A fresh single-brief probe cannot continue an earlier run.");
  const fixtures = values["only-fixture"] ? suite.filter(fixture => fixture.id === values["only-fixture"]) : suite;
  if (fixtures.length === 0) throw new PrototypeError("--only-fixture must name one of the eight saved suite briefs.");
  if (!values.live) {
    console.log(JSON.stringify({ fixtures: fixtures.map(fixture => fixture.id), upperBound: { modelCalls: fixtures.length * 2, searches: fixtures.length * 5 }, promptRevision: revision, live: false }));
    return;
  }
  if (values.host) {
    await runHost(checkout, output, fixtures, revision);
    return;
  }
  if (values["continue-untouched"] && !existsSync(join(output, "manifest.json"))) throw new PrototypeError("--continue-untouched requires an existing prototype manifest.");
  if (existsSync(output) && !values["continue-untouched"]) throw new PrototypeError("This prototype run already exists. Incomplete calls are never replayed. Inspect its saved checkpoints before choosing a new explicit run.");
  mkdirSync(output, { recursive: true });
  const built = await Bun.build({ entrypoints: [join(checkout, "scripts/prototype-research-frame.ts")], outdir: output, target: "node", format: "cjs", external: ["electron"], naming: "prototype-host.cjs" });
  if (!built.success) throw new PrototypeError("Could not compile the windowless prototype host.");
  const { default: electronPath } = await import("electron");
  const environment: NodeJS.ProcessEnv = { ...process.env, EXA_API_KEY: "", PERPLEXITY_API_KEY: "" };
  delete environment.ELECTRON_RUN_AS_NODE;
  const args = [join(output, "prototype-host.cjs"), "--host", "--live", "--checkout", checkout, "--fixtures", fixtureDirectory, "--output", output, "--revision", String(revision)];
  if (values["continue-untouched"]) args.push("--continue-untouched");
  if (values["only-fixture"]) args.push("--only-fixture", values["only-fixture"]);
  if (values["runtime-path"]) args.push("--runtime-path", resolve(values["runtime-path"]));
  if (values["runtime-lock"]) args.push("--runtime-lock", resolve(values["runtime-lock"]));
  const host = spawn(String(electronPath), args, { windowsHide: true, shell: false, env: environment, stdio: "inherit" });
  const status = await new Promise<number | null>((resolveStatus, reject) => { host.once("error", reject); host.once("exit", resolveStatus); });
  if (status !== 0) throw new PrototypeError(`Prototype host stopped with exit code ${status}. Its saved checkpoints are in ${output}. No calls were retried.`);
  console.log(JSON.stringify({ output, summary: join(output, "summary.md"), semanticReview: "pending" }));
}

async function runHost(checkout: string, output: string, fixtures: z.infer<typeof FixtureSchema>[], revision: number) {
  const { app, safeStorage } = await import("electron");
  const profile = join(output, "electron-profile");
  mkdirSync(profile, { recursive: true });
  app.setPath("userData", profile);
  const credentialDirectory = join(app.getPath("appData"), "scraply");
  // Copy only the encrypted Windows key context; Electron may write its own profile, never the installed one.
  const installedLocalState = join(credentialDirectory, "Local State");
  if (existsSync(installedLocalState)) copyFileSync(installedLocalState, join(profile, "Local State"));
  app.setPath("sessionData", profile);
  await app.whenReady();
  let runtime: RuntimeClient | undefined;
  let exitCode = 0;
  try {
    if (existsSync(join(output, "manifest.json")) && !values["continue-untouched"]) throw new PrototypeError("Existing prototype runs are never replayed.");
    const credentials = createCredentialStore(join(credentialDirectory, "secrets.bin"), safeStorage).load();
    const nativeCredential = credentials.providerCredentials["openai-subscription"];
    if (!nativeCredential) throw new PrototypeError("A saved Scraply OpenAI account is required.");
    if (fixtures.some(fixture => fixture.runSettings.model.providerId !== "openai-subscription")) throw new PrototypeError("The prototype gate uses the native subscription model for every brief.");
    const runtimePath = resolve(values["runtime-path"] ?? process.env.SCRAPLY_AGENT_PATH ?? join(checkout, "build/runtime/scraply-agent.exe"));
    const lockPath = resolve(values["runtime-lock"] ?? process.env.SCRAPLY_AGENT_LOCK_PATH ?? join(checkout, "build/runtime/scraply-agent.lock.json"));
    const artifact = ArtifactSchema.parse(JSON.parse(readFileSync(lockPath, "utf8")));
    const packageVersion = z.object({ version: z.string() }).parse(JSON.parse(readFileSync(join(checkout, "package.json"), "utf8"))).version;
    runtime = new RuntimeClient({ executablePath: runtimePath, artifact, appVersion: packageVersion });
    runtime.setSessionInitializer(async session => { await session.restoreCredential("openai-subscription", nativeCredential); });
    await runtime.prepareIdentity();
    const searchClients = {
      exa: credentials.exaApiKey ? new ExaClient(credentials.exaApiKey) : undefined,
      perplexity: credentials.perplexityApiKey ? new PerplexityClient(credentials.perplexityApiKey) : undefined,
    };
    const prompts = {
      search: readFileSync(join(checkout, "prompts/workflow-v2-frame-search.md"), "utf8"),
      frame: readFileSync(join(checkout, "prompts/workflow-v2-frame.md"), "utf8"),
    };
    const promptHashes = { search: sha256(prompts.search), frame: sha256(prompts.frame) };
    if (values["continue-untouched"]) {
      const existing = z.object({ promptRevision: z.number(), promptHashes: z.object({ search: z.string(), frame: z.string() }),
        fixtures: z.array(z.string()), runtimeArtifact: ArtifactSchema }).passthrough()
        .parse(JSON.parse(readFileSync(join(output, "manifest.json"), "utf8")));
      if (existing.promptRevision !== revision || JSON.stringify(existing.promptHashes) !== JSON.stringify(promptHashes)
        || JSON.stringify(existing.fixtures) !== JSON.stringify(fixtures.map(fixture => fixture.id))
        || existing.runtimeArtifact.sha256 !== artifact.sha256) throw new PrototypeError("Continuation must preserve the original prompts, fixture IDs, revision and native artifact.");
      save(output, "manifest.json", { ...existing, continuedAt: new Date().toISOString() });
    } else {
      save(output, "manifest.json", { promptRevision: revision, startedAt: new Date().toISOString(), runtimeArtifact: artifact,
        promptHashes, fixtures: fixtures.map(fixture => fixture.id), runKind: values["only-fixture"] ? "single-brief-probe" : "suite",
        limits: { perBriefModelCalls: 2, perBriefSearches: 5, repairPolicy: "disabled" }, credentials: "installed safeStorage, read-only, host memory only" });
    }
    for (const fixture of fixtures) {
      const directory = join(output, fixture.id);
      if (values["continue-untouched"] && existsSync(join(directory, "frame-search-plan-status.json"))) {
        console.log(JSON.stringify({ fixtureId: fixture.id, status: existsSync(join(directory, "result.json")) ? "reused-completed" : "blocked-existing-ledger", replayed: false }));
        continue;
      }
      const started = Date.now();
      const client = searchClients[fixture.runSettings.searchProvider];
      if (!client) throw new PrototypeError(`The ${fixture.runSettings.searchProvider} search key required by ${fixture.id} is not configured.`);
      mkdirSync(directory, { recursive: true });
      save(directory, "fixture.json", fixture);
      console.log(JSON.stringify({ fixtureId: fixture.id, stage: "frame-search-plan", status: "starting" }));
      const searchPlan = await callStage(runtime, fixture, "frame-search-plan", prompts.search, FrameSearchPlanSchema, [], directory);
      save(directory, "search-plan.json", searchPlan);
      const sources = new Map<string, z.infer<typeof SourceSchema>>();
      const searchStarted = Date.now();
      for (const [index, query] of searchPlan.output.queries.entries()) {
        save(directory, `search-${index + 1}-status.json`, { status: "dispatched", query: query.query, reason: query.reason, startedAt: new Date().toISOString() });
        const result = await client.search(query.query, { numResults: 3, maxCharacters: 5_000 });
        for (const source of result) {
          const normalized = { ...source, id: `context-${sha256(source.url).slice(0, 20)}` };
          if (!sources.has(normalized.id)) sources.set(normalized.id, normalized);
        }
        save(directory, `search-${index + 1}.json`, { query, sources: result });
        save(directory, `search-${index + 1}-status.json`, { status: "completed", sourceCount: result.length, completedAt: new Date().toISOString() });
      }
      const searchMs = Date.now() - searchStarted;
      const sourceArray = [...sources.values()];
      save(directory, "sources.json", sourceArray);
      console.log(JSON.stringify({ fixtureId: fixture.id, stage: "frame", searches: searchPlan.output.queries.length, sourceCount: sources.size, status: "starting" }));
      const generated = await callStage(runtime, fixture, "frame", prompts.frame, ResearchFrameOutputSchema,
        sourceArray.map(source => ({ sourceId: source.id, content: { url: source.url, title: source.title, text: source.text } })), directory);
      save(directory, "frame-generation.json", generated);
      const frame = parseResearchFrame(generated.output.frame, { sourceIds: [...sources.keys()], purpose: "discovery" });
      const mechanicalChecks = mechanicalFrameChecks(fixture, frame, sourceArray.map(source => source.id));
      save(directory, "result.json", ResultSchema.parse({ fixtureId: fixture.id, expectedGoalKind: fixture.goalKind, frame,
        searches: searchPlan.output.queries.length, modelCalls: 2, sourceCount: sources.size, wallMs: Date.now() - started,
        searchMs, generationMetadata: [searchPlan.metadata, generated.metadata], mechanicalChecks }));
      console.log(JSON.stringify({ fixtureId: fixture.id, status: "completed", goalKind: frame.goalKind, areas: frame.areas.length, languages: frame.languages,
        searches: searchPlan.output.queries.length, wallMs: Date.now() - started, mechanicalChecksPassed: mechanicalChecks.every(check => check.passed) }));
      summarize(output);
    }
    save(output, "manual-review-template.json", {
      reviewer: "REPLACE_WITH_REVIEWER", reviewedAt: new Date().toISOString(), fixtures: fixtures.map(fixture => ({ fixtureId: fixture.id,
        checks: MANUAL_CHECKS.map(name => ({ name, status: "pending", note: "Inspect the saved frame and cited source text before recording a judgment." })) })),
    });
  } catch (error) {
    const failure = safeFailure(error);
    const recorded = { ...failure, at: new Date().toISOString(), replayed: false };
    save(output, `failure-${randomUUID()}.json`, recorded);
    if (!existsSync(join(output, "failure.json"))) save(output, "failure.json", recorded);
    console.error(JSON.stringify({ type: "prototype-failed", ...failure, output }));
    exitCode = 1;
  } finally {
    await runtime?.close();
    app.exit(exitCode);
  }
}

async function callStage<T>(runtime: RuntimeClient, fixture: z.infer<typeof FixtureSchema>, stage: string,
  instruction: string, schema: z.ZodType<T>, evidence: Array<{ sourceId: string; content: unknown }>, directory: string): Promise<StructuredStageResult<T>> {
  const generationId = randomUUID();
  const statusFile = `${stage}-status.json`;
  save(directory, statusFile, { generationId, stage, status: "prepared", at: new Date().toISOString() });
  try {
    const generated = await runtime.structuredCompletion({
      generationId, stage, model: fixture.runSettings.model, reasoningEffort: fixture.runSettings.reasoningEffort,
      workOrder: { stage, instruction, goal: "Interpret this brief into a research frame without inventing context or user choices",
        inputs: { scope: fixture.scope, explorationPurpose: fixture.runSettings.explorationPurpose, purpose: "discovery", maxContextSearches: 5 },
        definitionOfDone: ["Return only the requested structured output", "Use only supplied IDs for external citations", "Keep the brief's actual goal and constraints"] },
      evidence, schema, jsonSchema: deriveJsonSchema(schema), repairPolicy: "disabled",
      onDispatched: () => save(directory, statusFile, { generationId, stage, status: "dispatched", at: new Date().toISOString() }),
      onAccepted: () => save(directory, statusFile, { generationId, stage, status: "accepted", at: new Date().toISOString() }),
    });
    save(directory, statusFile, { generationId, stage, status: "completed", at: new Date().toISOString() });
    return generated;
  } catch (error) {
    save(directory, statusFile, { generationId, stage, status: "failed-or-uncertain", ...safeFailure(error), at: new Date().toISOString(), replayed: false });
    throw error;
  }
}

function mechanicalFrameChecks(fixture: z.infer<typeof FixtureSchema>, frame: ResearchFrame, sourceIds: string[]) {
  parseResearchFrame(frame, { sourceIds, purpose: "discovery" });
  const checks = [
    { name: "goal kind", passed: frame.goalKind === fixture.goalKind, note: `Expected ${fixture.goalKind}, returned ${frame.goalKind}.` },
    { name: "source references and frame invariants", passed: true, note: "Strict schema and all context/criterion/constraint source IDs validated against saved packets." },
    { name: "English language", passed: frame.languages.includes("en"), note: frame.languages.join(", ") },
  ];
  const areaCount = frame.areas.length;
  const narrow = fixture.id === "bakery" || fixture.id === "dorm-kitchen";
  const explicitBookkeeperWorkflows = fixture.id === "bookkeepers" && areaCount === 5;
  checks.push({ name: "suite area breadth", passed: explicitBookkeeperWorkflows || (narrow ? areaCount >= 1 && areaCount <= 3 : areaCount >= 6 && areaCount <= 10),
    note: explicitBookkeeperWorkflows
      ? "Five areas cover the five workflows explicitly requested in this fixture and illustrated in the plan; this suite-specific breadth exception avoids inventing a sixth workflow."
      : `${areaCount} areas; ${narrow ? "1–3 for this narrow brief" : "6–10 for this broad brief"}.` });
  if (fixture.id === "dorm-kitchen" || fixture.id === "science-fair") checks.push({ name: "Ukrainian brief language", passed: frame.languages.includes("uk"), note: "The supplied brief is in Ukrainian." });
  else if (fixture.id === "clinics") checks.push({ name: "regional language grounding", passed: frame.languages.length === 1 || frame.areas.some(area => area.region !== undefined), note: "Extra regional languages require an explicitly regional area; semantic match is checked manually." });
  else checks.push({ name: "English-only brief language", passed: frame.languages.length === 1 && frame.languages[0] === "en", note: "These suite briefs do not request another language or localize to another country." });
  return checks;
}

function summarize(output: string, review?: z.infer<typeof ManualReviewSchema>) {
  const manifest = z.object({ fixtures: z.array(z.string()) }).parse(JSON.parse(readFileSync(join(output, "manifest.json"), "utf8")));
  const results = manifest.fixtures.flatMap(id => {
    const path = join(output, id, "result.json");
    if (!existsSync(path)) return [];
    const result = ResultSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    const fixture = FixtureSchema.parse(JSON.parse(readFileSync(join(output, id, "fixture.json"), "utf8")));
    const sources = z.array(SourceSchema).parse(JSON.parse(readFileSync(join(output, id, "sources.json"), "utf8")));
    const frame = parseResearchFrame(result.frame, { purpose: "discovery", sourceIds: sources.map(source => source.id) });
    return [{ ...result, frame, mechanicalChecks: mechanicalFrameChecks(fixture, frame, sources.map(source => source.id)) }];
  });
  if (review) {
    if (review.fixtures.length !== manifest.fixtures.length || new Set(review.fixtures.map(fixture => fixture.fixtureId)).size !== manifest.fixtures.length) throw new PrototypeError("Semantic review must cover every fixture exactly once.");
    for (const fixture of review.fixtures) {
      if (!manifest.fixtures.includes(fixture.fixtureId) || new Set(fixture.checks.map(check => check.name)).size !== MANUAL_CHECKS.length) throw new PrototypeError("Semantic review contains an unknown fixture or repeated/missing checks.");
    }
    save(output, "manual-review.json", review);
  } else if (existsSync(join(output, "manual-review.json"))) review = ManualReviewSchema.parse(JSON.parse(readFileSync(join(output, "manual-review.json"), "utf8")));
  const rows = results.map(result => {
    const semantic = review?.fixtures.find(fixture => fixture.fixtureId === result.fixtureId);
    const manualStatus = !semantic || semantic.checks.some(check => check.status === "pending") ? "pending" : semantic.checks.every(check => check.status === "pass") ? "pass" : "fail";
    const usageKnown = result.generationMetadata.every(metadata => metadata.usage.status === "known");
    const tokens = usageKnown ? result.generationMetadata.reduce((total, metadata) => total + (metadata.usage.status === "known" ? metadata.usage.value.totalTokens : 0), 0) : null;
    const costAttempts = result.generationMetadata.flatMap(metadata => metadata.attempts.map(attempt => attempt.cost));
    const cost = costAttempts.every(item => item.status === "reported") ? costAttempts.reduce((total, item) => total + (item.status === "reported" ? item.value.amount : 0), 0) : null;
    return { fixtureId: result.fixtureId, goalKind: result.frame.goalKind, goal: result.frame.goal, areas: result.frame.areas.map(area => area.name), languages: result.frame.languages,
      contextFacts: result.frame.contextFacts.length, sources: result.sourceCount, searches: result.searches, calls: result.modelCalls,
      wallMs: result.wallMs, generationMs: result.generationMetadata.map(metadata => metadata.latencyMs), tokens, reportedCost: cost,
      mechanical: result.mechanicalChecks.every(check => check.passed) ? "pass" : "fail", mechanicalChecks: result.mechanicalChecks, manual: manualStatus };
  });
  const gate = rows.length !== 8 || rows.some(row => row.manual === "pending") ? "pending" : rows.every(row => row.manual === "pass" && row.mechanical === "pass") ? "go" : "no-go";
  const unfinished = manifest.fixtures.filter(id => !results.some(result => result.fixtureId === id)).map(fixtureId => ({ fixtureId,
    stages: ["frame-search-plan", "frame"].flatMap(stage => {
      const path = join(output, fixtureId, `${stage}-status.json`);
      return existsSync(path) ? [z.object({ stage: z.string(), status: z.string(), code: z.string().optional(), message: z.string().optional() })
        .parse(JSON.parse(readFileSync(path, "utf8")))] : [];
    }),
  }));
  save(output, "summary.json", { gate, completedBriefs: rows.length, requiredBriefs: 8, unfinished, rows });
  const escape = (value: string) => value.replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");
  const markdown = ["# Research frame prototype", "", `Gate: ${gate}. ${rows.length}/8 briefs completed. Semantic judgments are recorded explicitly in manual-review.json.`, "",
    "| Brief | Goal kind | Areas | Languages | Facts / sources | Calls / searches | Wall seconds | Tokens | Cost | Mechanical / semantic |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(row => `| ${row.fixtureId} | ${row.goalKind} | ${row.areas.length} | ${row.languages.join(", ")} | ${row.contextFacts} / ${row.sources} | ${row.calls} / ${row.searches} | ${(row.wallMs / 1000).toFixed(1)} | ${row.tokens ?? "unknown"} | ${row.reportedCost ?? "unknown"} | ${row.mechanical} / ${row.manual} |`), "",
    ...unfinished.flatMap(fixture => [`Unfinished: ${fixture.fixtureId}. ${fixture.stages.map(stage => `${stage.stage}: ${stage.status}${stage.code ? ` (${stage.code})` : ""}`).join("; ")}. Existing generation ledgers are never replayed.`, ""]),
    ...rows.flatMap(row => [`## ${row.fixtureId}`, "", escape(row.goal), "", row.areas.map(escape).join("; "), ""]),
    "Each external fact, criterion and constraint cites a saved packet. That proves citation integrity; the manual review checks whether its cited text supports the claim.", "",
    "Calls use repairPolicy disabled, with no transport retries or uncertain-call replay. Search response text and frames remain in this local ignored run directory.", ""];
  writeFileSync(join(output, "summary.md"), markdown.join("\n"));
  console.log(JSON.stringify({ summary: join(output, "summary.md"), gate, completedBriefs: rows.length }));
}

function save(directory: string, filename: string, value: unknown) {
  writeFileSync(join(directory, filename), `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function safeFailure(error: unknown) {
  // Provider failures expose classified local messages. Other errors may contain confidential inputs.
  return error instanceof ProviderFailure
    ? { code: error.code, message: error.message, attempts: error.attempts ?? null,
      ...(error.cause instanceof z.ZodError ? { schemaIssues: error.cause.issues.map(issue => ({ path: issue.path, code: issue.code, message: issue.message })) } : {}) }
    : { code: "local-error", message: error instanceof PrototypeError ? error.message : error instanceof z.ZodError ? "A prototype boundary rejected structured data. Inspect saved packets locally." : "The prototype host failed. Check local paths, configured providers, and saved checkpoints." };
}

void main().catch(error => { console.error(JSON.stringify(safeFailure(error))); process.exitCode = 1; });
