import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { ApiResponseSchema, IPC_CHANNELS, WorkspaceStateSchema } from "../src/shared/ipc";
import { discoveryRunProjection } from "../src/shared/discovery-projection";
import { ModelRefSchema, ReasoningEffortSchema, sameModelRef } from "../src/shared/schemas";
import { ScopeSchema } from "../src/shared/structured-output-schemas";
import {
  PreviewWorkflowResultSchema, WorkflowAdmissionReceiptSchema, WorkflowDetailSchema,
  WorkflowLaunchContractSchema, WorkflowLaunchDraftSchema,
} from "../src/shared/workflow-contracts";
import { InstalledIdentitySchema, installedPackageIdentity, openInstalledDriver, type InstalledMethod } from "./eval-installed-driver";

export const EvaluationBriefSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  goalKind: z.enum(["market-opportunity", "competition-entry", "research-question", "community-or-personal", "process-improvement", "other"]),
  provenance: z.object({ kind: z.enum(["saved-scope", "plan"]), source: z.string().min(1) }).strict(),
  scope: ScopeSchema,
  runSettings: z.object({
    model: ModelRefSchema, reasoningEffort: ReasoningEffortSchema,
    searchProvider: z.enum(["exa", "perplexity", "auto"]),
    explorationPurpose: z.enum(["general-solutions", "startup-opportunities"]),
    ideaCount: z.number().int().min(1).max(20), automaticProblemCap: z.number().int().min(1).max(20),
  }).strict(),
}).strict();
export type EvaluationBrief = z.infer<typeof EvaluationBriefSchema>;
export type EvaluationCase = { key: string; brief: EvaluationBrief; depth: "quick" | "standard" | "deep"; repeat: number };

export function loadEvaluationBriefs(directory: string): EvaluationBrief[] {
  const briefs = readdirSync(directory).filter(file => file.endsWith(".json")).sort()
    .map(file => EvaluationBriefSchema.parse(JSON.parse(readFileSync(join(directory, file), "utf8"))));
  if (!briefs.length || new Set(briefs.map(brief => brief.id)).size !== briefs.length) throw new Error("Evaluation brief IDs must be nonempty and unique.");
  return briefs;
}

export function evaluationMatrix(briefs: EvaluationBrief[], matrix: "baseline" | "quick" | "acceptance"): EvaluationCase[] {
  const rows: EvaluationCase[] = [];
  for (const brief of briefs) {
    const depths = matrix === "acceptance" ? ["standard", ...(["genius", "clinics"].includes(brief.id) ? ["deep"] : [])]
      : ["quick", ...(matrix === "baseline" && ["genius", "bookkeepers", "dorm-kitchen"].includes(brief.id) ? ["standard"] : [])];
    for (const depth of depths) {
      const parsedDepth = z.enum(["quick", "standard", "deep"]).parse(depth);
      for (let repeat = 1; repeat <= (parsedDepth === "quick" ? 2 : 1); repeat++) {
        rows.push({ key: `${brief.id}-${parsedDepth}-${repeat}`, brief, depth: parsedDepth, repeat });
      }
    }
  }
  return rows;
}

export function evaluationDraft(item: EvaluationCase) {
  const projection = discoveryRunProjection(item.depth);
  const settings = item.brief.runSettings;
  const { automaticProblemCap, ...runSettings } = settings;
  return WorkflowLaunchDraftSchema.parse({
    contractVersion: 1, purpose: "discovery", mode: "vibe", brief: item.brief.scope.domain,
    scope: item.brief.scope,
    runConfig: { configVersion: 2, workflowVersion: 2, audienceSourcePolicy: "web", ...runSettings,
      discoveryDepth: item.depth, maxRunMinutes: 240, researchMode: "explore-market", knownProblem: "" },
    ideas: { model: settings.model, reasoningEffort: settings.reasoningEffort },
    targets: { kind: "per-problem", ideaCount: settings.ideaCount, automaticProblemCap },
    limits: { enforced: false, maxMinutes: 240, maxModelCalls: projection.modelCalls * 2 + settings.automaticProblemCap * Math.ceil(settings.ideaCount / 5) * 4,
      maxSearches: projection.searches }, instructions: {},
  });
}

const Count = z.number().int().nonnegative();
export const EvaluationMetricsSchema = z.object({
  factors: Count, totalSources: Count, evidenceMix: z.record(Count), sourceMix: z.record(Count),
  qualifyingPerAssessedCandidate: z.number().nonnegative().nullable(),
  candidateFunnel: z.object({ total: Count, assessed: Count, confirmed: Count, insufficient: Count, dropped: Count, notAssessed: Count }).passthrough(),
  coverage: z.object({ kind: z.enum(["areas", "phases"]), groups: z.array(z.object({ id: z.string(), confirmed: Count }).passthrough()) }).passthrough(),
  acceptedIdeas: Count, modelCalls: Count, searches: Count, wallTimeMs: z.number().nonnegative(), interruptions: Count,
  // Before Step 7, absence means not assessed. It must never be reported as zero failures.
  acceptedIdeasFailingMustHave: Count.nullable().optional(),
}).passthrough();
export type EvaluationMetrics = z.infer<typeof EvaluationMetricsSchema>;
const RowSchema = z.object({
  key: z.string(), briefId: z.string(), depth: z.enum(["quick", "standard", "deep"]), repeat: Count,
  threadId: z.string().nullable(), sessionId: z.string().nullable(), runId: z.string().nullable(),
  status: z.enum(["planned", "launching", "running", "finished", "blocked"]), outcome: z.string().nullable(),
  stopReason: z.string().nullable(), metrics: EvaluationMetricsSchema.nullable(),
  // Retain the actual launch estimate before dispatch; older manifests may lack it.
  launchPreview: PreviewWorkflowResultSchema.extend({ type: z.literal("launch"), proposal: WorkflowLaunchContractSchema }).optional(),
}).strict();
export type EvaluationRow = z.infer<typeof RowSchema>;
const ManifestSchema = z.object({
  schemaVersion: z.literal(1), origin: z.enum(["live", "offline-fixture"]), appCommit: z.string(),
  fixtureSha256: z.string(), matrix: z.enum(["baseline", "quick", "acceptance"]), createdAt: z.string(),
  profile: z.string(), rows: z.array(RowSchema),
  transport: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("browser-dev"), origin: z.string() }).strict(),
    z.object({ kind: z.literal("installed-preload"), driver: z.literal("node-playwright-electron-pipe"),
      credentialSourceProfile: z.string(), package: InstalledIdentitySchema }).strict(),
  ]).optional(),
}).strict();
type Manifest = z.infer<typeof ManifestSchema>;

/** One observer owns progression, so two monitors cannot launch the next paid case twice. */
export function acquireEvaluationLock(output: string): () => void {
  const lockPath = join(output, "observer.lock");
  const owner = { pid: process.pid, id: randomUUID() };
  const ownerSchema = z.object({ pid: z.number().int().positive(), id: z.string().uuid() }).strict();
  if (existsSync(lockPath)) {
    const previous = ownerSchema.parse(JSON.parse(readFileSync(lockPath, "utf8")));
    let alive = true;
    try { process.kill(previous.pid, 0); } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") alive = false;
    }
    if (alive) throw new Error(`Evaluation observer ${previous.pid} already owns this output. Use --report-only to inspect it.`);
    // Recover only a dead observer's unchanged lock, never its saved workflow or provider call.
    if (readFileSync(lockPath, "utf8") !== JSON.stringify(previous)) throw new Error("Evaluation observer lock changed during recovery.");
    unlinkSync(lockPath);
  }
  const file = openSync(lockPath, "wx");
  try { writeFileSync(file, JSON.stringify(owner)); } finally { closeSync(file); }
  return () => {
    if (existsSync(lockPath) && readFileSync(lockPath, "utf8") === JSON.stringify(owner)) unlinkSync(lockPath);
  };
}

export function median(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null).sort((left, right) => left - right);
  if (!present.length) return null;
  const middle = Math.floor(present.length / 2);
  return present.length % 2 ? present[middle]! : (present[middle - 1]! + present[middle]!) / 2;
}

export function summarizeEvaluation(rows: EvaluationRow[]) {
  return [...new Set(rows.map(row => `${row.briefId}/${row.depth}`))].map(key => {
    const group = rows.filter(row => `${row.briefId}/${row.depth}` === key);
    const completed = group.filter(row => row.status === "finished");
    const metrics = completed.flatMap(row => row.metrics ? [row.metrics] : []);
    const qualityRows = completed.filter(row => ["target-met", "partial", "no-qualifying-ideas"].includes(row.outcome ?? ""));
    const quality = qualityRows.flatMap(row => row.metrics ? [row.metrics] : []);
    return {
      key, plannedRuns: group.length, terminalRuns: completed.length, measuredRuns: metrics.length, qualityRuns: quality.length,
      failedRuns: completed.filter(row => ["failed", "cancelled", "needs-attention"].includes(row.outcome ?? "")).length,
      medianConfirmed: median(quality.map(value => value.candidateFunnel.confirmed)),
      medianConfirmedAreas: median(quality.map(value => value.coverage.kind === "areas" ? value.coverage.groups.filter(area => area.confirmed > 0).length : null)),
      medianQualifyingPerCandidate: median(quality.map(value => value.qualifyingPerAssessedCandidate)),
      medianFirsthandMeasuredShare: median(quality.map(value => value.factors ? ((value.evidenceMix.firsthand ?? 0) + (value.evidenceMix.measured ?? 0)) / value.factors : null)),
      medianVendorAdviceIllustrationShare: median(quality.map(value => value.factors ? ((value.evidenceMix.vendor ?? 0) + (value.evidenceMix.recommendation ?? 0) + (value.evidenceMix.illustration ?? 0)) / value.factors : null)),
      medianCommunitySourceShare: median(quality.map(value => value.totalSources ? Object.entries(value.sourceMix)
        .filter(([kind]) => ["forum", "qa", "q-and-a", "issue-tracker", "social"].includes(kind)).reduce((sum, [, count]) => sum + count, 0) / value.totalSources : null)),
      medianNotAssessed: median(quality.map(value => value.candidateFunnel.notAssessed)),
      medianAcceptedIdeas: median(quality.map(value => value.acceptedIdeas)),
      medianMustHaveFailures: median(quality.map(value => value.acceptedIdeasFailingMustHave ?? null)),
      zeroIdeaRuns: qualityRows.filter(row => row.metrics?.acceptedIdeas === 0).length,
      medianModelCalls: median(metrics.map(value => value.modelCalls)), medianSearches: median(metrics.map(value => value.searches)),
      medianWallTimeMs: median(metrics.map(value => value.wallTimeMs)), medianInterruptions: median(metrics.map(value => value.interruptions)),
    };
  });
}

export function evaluationMarkdown(manifest: Manifest): string {
  const format = (value: number | null) => value === null ? "unknown" : Number(value.toFixed(3)).toString();
  const rows = summarizeEvaluation(manifest.rows).map(row => `| ${row.key} | ${row.terminalRuns}/${row.plannedRuns} | ${row.qualityRuns} | ${format(row.medianConfirmed)} | ${format(row.medianConfirmedAreas)} | ${format(row.medianQualifyingPerCandidate)} | ${format(row.medianFirsthandMeasuredShare)} | ${format(row.medianVendorAdviceIllustrationShare)} | ${format(row.medianCommunitySourceShare)} | ${format(row.medianNotAssessed)} | ${format(row.medianAcceptedIdeas)} | ${format(row.medianMustHaveFailures)} | ${row.zeroIdeaRuns} | ${format(row.medianModelCalls)} | ${format(row.medianSearches)} | ${format(row.medianWallTimeMs === null ? null : row.medianWallTimeMs / 60_000)} | ${format(row.medianInterruptions)} | ${row.failedRuns} |`);
  return ["# Research workflow evaluation", "", `App commit: ${manifest.appCommit}. Origin: ${manifest.origin}. Matrix: ${manifest.matrix}.`,
    `Transport: ${manifest.transport?.kind ?? "browser-dev"}.${manifest.transport?.kind === "installed-preload"
      ? ` Installed executable SHA256: ${manifest.transport.package.executableSha256}. App ASAR SHA256: ${manifest.transport.package.asarSha256}.` : ""}`,
    `Fixture SHA256: ${manifest.fixtureSha256}. Started: ${manifest.createdAt}.`, "",
    "Quality medians use completed target-met, partial, and no-qualifying-ideas runs; Quality N shows their measured count. Failed, cancelled, interrupted, running, and planned cases do not contribute quality measurements. Calls, searches, time, and interruptions retain all measured terminal runs. Shares are fractions. Unknown values are excluded from medians and never replaced with zero.",
    "Qualifying/candidate is the median of each run's mean qualifying observations per assessed candidate, not the median of individual candidate counts. New rows retain the actual launch preview before dispatch; older rows may lack it.",
    "Area coverage is unknown for historical phase-based runs. Must-have failures are unknown before criterion assessments exist.",
    "Benchmark settings use one idea per selected problem, at most three automatic problems, gpt-6-sol/xhigh, and the fixture's selected provider. They stay identical across comparisons.", "",
    "| Brief/depth | Terminal | Quality N | Confirmed | Areas | Qualifying/candidate | Firsthand+measured | Vendor+advice+illustration | Community sources | Not assessed | Accepted ideas | Must-have failures | Zero ideas | Calls | Searches | Minutes | Interruptions | Failed |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |", ...rows, "",
    "## Outcomes", "", ...manifest.rows.map(row => `- ${row.key}: ${row.status}, ${row.outcome ?? "pending"}. ${row.stopReason ?? ""}`), ""].join("\n");
}

export interface EvaluationBackend {
  create(item: EvaluationCase): Promise<string>;
  preview(threadId: string, draft: z.infer<typeof WorkflowLaunchDraftSchema>): Promise<z.infer<typeof PreviewWorkflowResultSchema>>;
  start(threadId: string, commandId: string, preview: z.infer<typeof PreviewWorkflowResultSchema>): Promise<z.infer<typeof WorkflowAdmissionReceiptSchema>>;
  detail(sessionId: string): Promise<z.infer<typeof WorkflowDetailSchema>>;
  measure(sessionId: string): Promise<{ runId: string; metrics: EvaluationMetrics } | null>;
}

/** The manifest is written before dispatch. Missing admission receipts are never resent. */
export async function runEvaluation(matrix: EvaluationCase[], manifest: Manifest, backend: EvaluationBackend,
  save: (manifest: Manifest) => void, wait: () => Promise<void> = () => delay(2000), shouldStopBeforeLaunch?: () => boolean) {
  for (const item of matrix) {
    const row = manifest.rows.find(row => row.key === item.key)!;
    if (row.status === "finished") continue;
    if (row.status === "launching" || row.status === "blocked") throw new Error(`${row.key} needs manual inspection before continuing. No automatic replay.`);
    if (!row.sessionId) {
      if (shouldStopBeforeLaunch?.()) { save(manifest); return; }
      row.threadId = await backend.create(item);
      const preview = await backend.preview(row.threadId, evaluationDraft(item));
      if (preview.fieldErrors.length) throw new Error(`Preview rejected ${row.key}: ${preview.fieldErrors.map(error => error.message).join("; ")}`);
      row.launchPreview = RowSchema.shape.launchPreview.unwrap().parse(preview);
      row.status = "launching"; save(manifest);
      const receipt = await backend.start(row.threadId, randomUUID(), preview);
      row.sessionId = receipt.sessionId; row.status = "running"; save(manifest);
    }
    for (;;) {
      const detail = await backend.detail(row.sessionId);
      row.outcome = detail.summary.outcome; row.stopReason = detail.summary.stopReason;
      const measured = await backend.measure(row.sessionId);
      if (measured) { row.runId = measured.runId; row.metrics = measured.metrics; }
      if (detail.summary.state === "finished") { row.status = "finished"; save(manifest); break; }
      if (["paused", "waiting-for-review"].includes(detail.summary.state)) {
        row.status = "blocked"; save(manifest);
        throw new Error(`${row.key} stopped at ${detail.summary.state}. Review its saved workflow; the runner never resumes or retries it automatically.`);
      }
      save(manifest);
      await wait();
    }
  }
}

async function command(checkout: string, args: string[], environment = process.env): Promise<string> {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(args[0]!, args.slice(1), { cwd: checkout, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { output += String(chunk); });
    child.stderr.on("data", chunk => { output += String(chunk); });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolveCommand(output.trim()) : reject(new Error(`${args[0]} exited ${code}: ${output.slice(-2000)}`)));
  });
}

type EvaluationInvoke = <T extends z.ZodType>(channel: string, schema: T, payload?: unknown) => Promise<z.infer<T>>;

function browserInvoke(origin: string): EvaluationInvoke {
  async function invoke<T extends z.ZodType>(channel: string, schema: T, payload?: unknown): Promise<z.infer<T>> {
    const response = await fetch(`${origin}/__scraply_dev/invoke`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ channel, args: payload === undefined ? [] : [payload] }), signal: AbortSignal.timeout(15_000) });
    const envelope = z.object({ data: z.unknown().optional(), error: z.string().optional() }).parse(await response.json());
    if (!response.ok) throw new Error(envelope.error ?? `Local backend returned HTTP ${response.status}.`);
    return schema.parse(envelope.data);
  }
  return invoke;
}

type ReadinessClock = { now(): number; wait(ms: number): Promise<void> };

/** Read startup validation only. Pending checks may settle; settled failures never trigger retries. */
async function waitForEvaluationReadiness(invoke: EvaluationInvoke, item: EvaluationCase, clock: ReadinessClock) {
  const deadline = clock.now() + 45_000;
  const timeout = () => new Error("Startup validation did not become ready within 45 seconds. No evaluation project was created.");
  while (clock.now() < deadline) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const workspace = await Promise.race([
      invoke(IPC_CHANNELS.GET_WORKSPACE, WorkspaceStateSchema),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(timeout()), deadline - clock.now()); }),
    ]).finally(() => clearTimeout(timer));
    const native = workspace.validation.native;
    const nativePending = native.error === "Checking native runtime" || native.error === "Native runtime is starting";
    if (!nativePending && (!native.available || !native.connected)) {
      throw new Error("Existing OpenAI credentials must be connected and the native runtime available. Evaluation never changes accounts.");
    }
    const selectedSearch = item.brief.runSettings.searchProvider;
    const searches = selectedSearch === "auto" ? [workspace.validation.exa, workspace.validation.perplexity] : [workspace.validation[selectedSearch]];
    const searchReady = searches.some(search => search.valid && !search.checking);
    if (!searchReady && !searches.some(search => search.checking)) {
      throw new Error(`Existing ${selectedSearch === "auto" ? "search" : selectedSearch === "exa" ? "Exa" : "Perplexity"} credentials must be connected. Evaluation never changes keys.`);
    }
    if (!nativePending) {
      const settings = item.brief.runSettings;
      const model = workspace.modelOptions.find(option => sameModelRef(option, settings.model));
      if (!model) throw new Error(`Evaluation model ${settings.model.providerId}:${settings.model.modelId} is unavailable.`);
      if (!model.reasoningEfforts.some(effort => effort.id === settings.reasoningEffort)) {
        throw new Error(`Evaluation model ${settings.model.modelId} does not support ${settings.reasoningEffort} reasoning.`);
      }
      if (searchReady) return workspace;
    }
    await clock.wait(Math.min(500, Math.max(0, deadline - clock.now())));
  }
  throw timeout();
}

export function evaluationBackend(invoke: EvaluationInvoke, databasePath: string, traceModule: string,
  readinessClock: ReadinessClock = { now: Date.now, wait: delay }): EvaluationBackend {
  return {
    async create(item) {
      const workspace = await waitForEvaluationReadiness(invoke, item, readinessClock);
      if (!existsSync(databasePath)) throw new Error("The isolated profile database was not created. The running app must use the evaluation profile before research.");
      const profileDb = new Database(databasePath, { readonly: true });
      try {
        const storedIds = new Set(z.array(z.object({ id: z.string() })).parse(profileDb.query("SELECT id FROM threads").all()).map(thread => thread.id));
        if (workspace.threads.some(thread => !storedIds.has(thread.id))) throw new Error("The running backend does not use the evaluation profile. No evaluation project was created.");
      } finally { profileDb.close(); }
      const created = await invoke(IPC_CHANNELS.CREATE_THREAD, z.object({ workspace: WorkspaceStateSchema }), { title: `Evaluation ${item.key}` });
      const threadId = created.workspace.activeThreadId;
      if (!threadId) throw new Error("The backend did not select the new evaluation project.");
      return threadId;
    },
    async preview(threadId, draft) {
      const result = await invoke(IPC_CHANNELS.PREVIEW_WORKFLOW, ApiResponseSchema(PreviewWorkflowResultSchema), { type: "launch", threadId, draft });
      if (!result.ok) throw new Error(`Preview rejected: ${result.error.code}`);
      return result.data;
    },
    async start(threadId, commandId, preview) {
      const result = await invoke(IPC_CHANNELS.START_WORKFLOW, ApiResponseSchema(WorkflowAdmissionReceiptSchema), {
        threadId, clientCommandId: commandId, contract: WorkflowLaunchContractSchema.parse(preview.proposal),
        previewHash: preview.previewHash, capabilityFingerprint: preview.capabilityFingerprint, previewExpiresAt: preview.expiresAt,
      });
      if (!result.ok) throw new Error(`Launch rejected: ${result.error.code}`);
      return result.data;
    },
    async detail(sessionId) {
      const result = await invoke(IPC_CHANNELS.GET_WORKFLOW, ApiResponseSchema(WorkflowDetailSchema), { sessionId });
      if (!result.ok) throw new Error(`Workflow read rejected: ${result.error.code}`);
      return result.data;
    },
    async measure(sessionId) {
      // Trace readers can be taken from the new checkout while the baseline app stays on clean master.
      if (!existsSync(traceModule)) return null;
      const db = new Database(databasePath, { readonly: true });
      try {
        const module = await import(pathToFileURL(traceModule).href) as {
          getRunTrace: (reader: { db: Database }, runId: string) => unknown;
          selectSessionEvidenceRunId?: (reader: { db: Database }, sessionId: string) => string | null;
        };
        // Older baseline readers have no selector; keep their original unframed discovery lookup.
        const runId = module.selectSessionEvidenceRunId
          ? module.selectSessionEvidenceRunId({ db }, sessionId)
          : z.object({ id: z.string() }).nullable().parse(db.prepare("SELECT id FROM research_runs WHERE workflow_session_id = ? AND purpose = 'discovery' ORDER BY created_at LIMIT 1").get(sessionId) ?? null)?.id;
        if (!runId) return null;
        const trace = z.object({ metrics: EvaluationMetricsSchema }).parse(module.getRunTrace({ db }, runId));
        return { runId, metrics: trace.metrics };
      } finally { db.close(); }
    },
  };
}

/** Copy only the encrypted credential file and its Electron context. Existing evaluation state is never overwritten. */
export function prepareInstalledEvaluationProfile(sourceProfile: string, profile: string): string {
  const source = realpathSync(resolve(sourceProfile));
  const target = existsSync(profile) ? realpathSync(profile) : join(realpathSync(dirname(profile)), basename(profile));
  const separation = relative(source, target);
  if (!separation || !isAbsolute(separation) && !separation.startsWith("..")) {
    throw new Error("The evaluation profile must be outside the installed credential profile.");
  }
  const files = ["secrets.bin", "Local State"];
  if (files.some(file => !existsSync(join(source, file)))) throw new Error("Installed profile must contain secrets.bin and Local State. No credentials were changed.");
  const copied = files.filter(file => existsSync(join(target, file)));
  if (copied.length && copied.length !== files.length) throw new Error("The evaluation credential copy is incomplete. Use a new output directory.");
  if (!copied.length) {
    mkdirSync(target, { recursive: true });
    for (const file of files) copyFileSync(join(source, file), join(target, file));
  }
  return source;
}

export function installedEvaluationInvoke(driver: { invoke(method: InstalledMethod, payload?: unknown): Promise<unknown> }): EvaluationInvoke {
  const methods: Record<string, InstalledMethod> = {
    [IPC_CHANNELS.GET_WORKSPACE]: "getWorkspace", [IPC_CHANNELS.CREATE_THREAD]: "createThread",
    [IPC_CHANNELS.PREVIEW_WORKFLOW]: "previewWorkflow", [IPC_CHANNELS.START_WORKFLOW]: "startWorkflow", [IPC_CHANNELS.GET_WORKFLOW]: "getWorkflow",
  };
  return async (channel, schema, payload) => {
    const method = methods[channel];
    if (!method) throw new Error("This evaluation channel is unavailable through the installed driver.");
    const data = await driver.invoke(method, payload);
    return schema.parse(["previewWorkflow", "startWorkflow", "getWorkflow"].includes(method) ? { ok: true, data } : data);
  };
}

async function main() {
  const { values } = parseArgs({ options: {
    "app-checkout": { type: "string" }, "runtime-dir": { type: "string" }, origin: { type: "string", default: "http://127.0.0.1:5179" },
    output: { type: "string" }, matrix: { type: "string", default: "baseline" }, briefs: { type: "string" },
    "trace-module": { type: "string" }, "require-app-sha": { type: "string" },
    "pause-file": { type: "string" },
    "installed-executable": { type: "string" }, "installed-profile": { type: "string" },
    "verify-transport": { type: "boolean", default: false },
    "report-only": { type: "boolean", default: false }, "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  } });
  if (values.help) {
    console.log("bun scripts/eval-research.ts --app-checkout PATH [--runtime-dir PATH | --installed-executable PATH --installed-profile PATH] [--matrix baseline|quick|acceptance] [--output build/eval/DATE] [--trace-module PATH] [--pause-file PATH] [--dry-run|--report-only|--verify-transport]");
    console.log("Installed mode drives the real preload through a local Playwright pipe and copies encrypted credentials into output/profile. --verify-transport only reads identity and workspace. Observer restarts never resume paused workflows or replay uncertain admissions.");
    return;
  }
  const root = resolve(import.meta.dir, "..");
  const checkout = resolve(values["app-checkout"] ?? root);
  const output = resolve(values.output ?? join(root, "build/eval", new Date().toISOString().replace(/[:.]/g, "-")));
  const profile = join(output, "profile");
  const installed = Boolean(values["installed-executable"]);
  if (installed !== Boolean(values["installed-profile"])) throw new Error("Use --installed-executable and --installed-profile together.");
  if (installed && values["runtime-dir"]) throw new Error("Installed evaluation uses its bundled runtime; --runtime-dir is only for development.");
  if (values["verify-transport"] && !installed) throw new Error("--verify-transport requires an installed executable and credential profile.");
  const origin = new URL(values.origin);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("Evaluation requires a local browser development origin.");
  const matrixName = z.enum(["baseline", "quick", "acceptance"]).parse(values.matrix);
  const briefs = loadEvaluationBriefs(join(root, "test/eval/briefs")).filter(brief => !values.briefs || values.briefs.split(",").includes(brief.id));
  if (!briefs.length) throw new Error("No evaluation briefs selected.");
  const matrix = evaluationMatrix(briefs, matrixName);
  const fixtureSha256 = createHash("sha256").update(JSON.stringify(briefs)).digest("hex");
  const appCommit = await command(checkout, ["git", "rev-parse", "HEAD"]);
  if (values["require-app-sha"] && appCommit !== values["require-app-sha"]) throw new Error("Evaluation checkout does not match the required app commit.");
  if (await command(checkout, ["git", "status", "--porcelain", "--untracked-files=no"])) throw new Error("Evaluation app checkout has uncommitted changes.");
  const packageManifest = join(checkout, "release/manifest.json");
  const packageIdentity = installed ? installedPackageIdentity(values["installed-executable"]!, packageManifest) : null;
  if (packageIdentity && packageIdentity.packageSourceSha !== appCommit) throw new Error("Installed package source does not match the evaluation checkout. Use the frozen packaged checkout.");
  const transport: NonNullable<Manifest["transport"]> = packageIdentity ? { kind: "installed-preload", driver: "node-playwright-electron-pipe",
    credentialSourceProfile: realpathSync(resolve(values["installed-profile"]!)), package: packageIdentity } : { kind: "browser-dev", origin: origin.origin };
  const planned = matrix.map(evaluationDraft);
  console.log(JSON.stringify({ type: "plan", appCommit, runs: matrix.length,
    estimatedModelCalls: planned.reduce((sum, draft) => sum + draft.limits.maxModelCalls, 0), estimatedSearches: planned.reduce((sum, draft) => sum + draft.limits.maxSearches, 0),
    limitsAreEstimates: true, profile, output, transport }));
  if (values["dry-run"]) return;
  mkdirSync(output, { recursive: true });
  const path = join(output, "manifest.json");
  const manifest: Manifest = existsSync(path) ? ManifestSchema.parse(JSON.parse(readFileSync(path, "utf8"))) : {
    schemaVersion: 1, origin: "live", appCommit, fixtureSha256, matrix: matrixName, createdAt: new Date().toISOString(), profile,
    rows: matrix.map(item => ({ key: item.key, briefId: item.brief.id, depth: item.depth, repeat: item.repeat,
      threadId: null, sessionId: null, runId: null, status: "planned", outcome: null, stopReason: null, metrics: null })),
    transport,
  };
  if (manifest.appCommit !== appCommit || manifest.fixtureSha256 !== fixtureSha256 || manifest.matrix !== matrixName) throw new Error("Saved evaluation uses a different app, fixture, or matrix. Use a new output directory.");
  if (JSON.stringify(manifest.transport ?? { kind: "browser-dev", origin: origin.origin }) !== JSON.stringify(transport)) {
    throw new Error("Saved evaluation uses a different transport, installed package, or credential source. No workflow was dispatched.");
  }
  const save = (value: Manifest) => {
    writeFileSync(path, JSON.stringify(value, null, 2));
    writeFileSync(join(output, "report.json"), JSON.stringify({ ...value, summary: summarizeEvaluation(value.rows) }, null, 2));
    writeFileSync(join(output, "report.md"), evaluationMarkdown(value));
  };
  save(manifest);
  const traceModule = resolve(values["trace-module"] ?? join(root, "src/core/run-trace.ts"));
  const databasePath = join(profile, "scraply/scraply.db");
  const backend = evaluationBackend(browserInvoke(origin.origin), databasePath, traceModule);
  if (values["report-only"]) {
    for (const row of manifest.rows) if (row.sessionId) { const measured = await backend.measure(row.sessionId); if (measured) { row.runId = measured.runId; row.metrics = measured.metrics; } }
    save(manifest); return;
  }
  const environment: NodeJS.ProcessEnv = { ...process.env, SCRAPLY_BROWSER_UI_PORT: origin.port, SCRAPLY_DEV_DATA_DIR: profile, SCRAPLY_DEV_SHARED_CREDENTIALS: "1", EXA_API_KEY: "", PERPLEXITY_API_KEY: "" };
  delete environment.ELECTRON_RUN_AS_NODE;
  if (values["runtime-dir"]) {
    Object.assign(environment, { SCRAPLY_AGENT_PATH: join(resolve(values["runtime-dir"]), "scraply-agent.exe"), SCRAPLY_AGENT_LOCK_PATH: join(resolve(values["runtime-dir"]), "scraply-agent.lock.json") });
  }
  const releaseLock = acquireEvaluationLock(output);
  try {
    if (packageIdentity) {
      prepareInstalledEvaluationProfile(values["installed-profile"]!, profile);
      const driver = await openInstalledDriver({ profile, executablePath: packageIdentity.executablePath, manifestPath: packageManifest });
      try {
        const identity = InstalledIdentitySchema.extend({ profile: z.string() }).parse(await driver.invoke("identity"));
        const { profile: activeProfile, ...actualPackage } = identity;
        if (resolve(activeProfile).toLowerCase() !== resolve(profile).toLowerCase() || JSON.stringify(actualPackage) !== JSON.stringify(packageIdentity)) {
          throw new Error("The installed driver is observing another profile or package. No workflow was dispatched.");
        }
        const installedBackend = evaluationBackend(installedEvaluationInvoke(driver), databasePath, traceModule);
        if (values["verify-transport"]) {
          const workspace = WorkspaceStateSchema.parse(await driver.invoke("getWorkspace"));
          const db = new Database(databasePath, { readonly: true });
          try {
            const storedIds = new Set(z.array(z.object({ id: z.string() })).parse(db.query("SELECT id FROM threads").all()).map(thread => thread.id));
            if (workspace.threads.some(thread => !storedIds.has(thread.id))) throw new Error("Installed preload and profile database disagree.");
          } finally { db.close(); }
          console.log(JSON.stringify({ type: "transport-verified", transport: transport.kind, appVersion: identity.appVersion,
            executableSha256: identity.executableSha256, asarSha256: identity.asarSha256, threads: workspace.threads.length, profile, output }));
          await driver.invoke("shutdown"); return;
        }
        await runEvaluation(matrix, manifest, installedBackend, save, () => delay(2000), () => Boolean(values["pause-file"] && existsSync(resolve(values["pause-file"]))));
        await driver.invoke("shutdown");
      } finally { driver.disconnect(); }
    } else {
      console.log(await command(checkout, ["bun", "run", "dev"], environment));
      await runEvaluation(matrix, manifest, backend, save, () => delay(2000), () => Boolean(values["pause-file"] && existsSync(resolve(values["pause-file"]))));
    }
    console.log(JSON.stringify({ type: manifest.rows.every(row => row.status === "finished") ? "complete" : "checkpoint", terminalRuns: manifest.rows.filter(row => row.status === "finished").length, output }));
  } finally { releaseLock(); }
}

if (import.meta.main) await main();
