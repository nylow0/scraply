import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { WorkflowModelScheduler } from "../src/core/workflow-scheduler";
import { RuntimeClient } from "../src/providers/runtime";
import { ProviderFailure, type StructuredModelClient } from "../src/providers/structured";
import { type ModelRef } from "../src/shared/schemas";

const OUTPUT_SCHEMA = z.object({
  assessments: z.array(z.object({
    problem: z.string().min(1), supported: z.boolean(), observationIds: z.array(z.string()),
    missingEvidence: z.string(),
  }).strict()).min(1).max(4),
}).strict();
const OUTPUT_JSON_SCHEMA = {
  type: "object", additionalProperties: false, required: ["assessments"], properties: {
    assessments: { type: "array", minItems: 1, maxItems: 4, items: {
      type: "object", additionalProperties: false,
      required: ["problem", "supported", "observationIds", "missingEvidence"], properties: {
        problem: { type: "string" }, supported: { type: "boolean" },
        observationIds: { type: "array", items: { type: "string" } }, missingEvidence: { type: "string" },
      },
    } },
  },
};
const WORK_ORDER = {
  stage: "concurrency-measurement",
  instruction: "Assess the candidate problems against the supplied observations. Support needs two independent firsthand observations. Advice and vendor claims are not evidence. Return at most four assessments. Explain the missing evidence for unsupported candidates. This is a synthetic transport measurement, never a research result.",
  goal: "Measure subscription transport reliability under identical bounded structured xhigh work.",
  inputs: { candidates: ["Late supplier deliveries", "Manual stock reconciliation", "Poor onboarding", "Invoice errors"] },
  definitionOfDone: ["Each assessment cites only the supplied observation IDs.", "Do not invent supporting observations."],
};
const EVIDENCE = [{ sourceId: "synthetic-concurrency-fixture", content: { observations: [
  { id: "a", origin: "owner-one", role: "firsthand", quote: "Two of my last five parts orders arrived a week late." },
  { id: "b", origin: "owner-two", role: "firsthand", quote: "I delayed three repairs this month while waiting for parts." },
  { id: "c", origin: "owner-one", role: "firsthand", quote: "I count shelf stock by hand every Friday." },
  { id: "d", origin: "owner-three", role: "firsthand", quote: "Reconciling our stock spreadsheet takes two hours each week." },
  { id: "e", origin: "vendor", role: "vendor", quote: "Our inventory tool makes stock counting effortless." },
  { id: "f", origin: "consultant", role: "advice", quote: "Shops should streamline onboarding with a checklist." },
  { id: "g", origin: "owner-four", role: "firsthand", quote: "Our new hire asked for help on the first day." },
  { id: "h", origin: "owner-five", role: "firsthand", quote: "I corrected one supplier invoice last quarter." },
  { id: "i", origin: "owner-five", role: "firsthand", quote: "The corrected invoice had one duplicate charge." },
  { id: "j", origin: "vendor-two", role: "vendor", quote: "Invoice mistakes are expensive and our tool catches them." },
] } }];

export const ConcurrencySampleSchema = z.object({
  concurrency: z.number().int().min(1).max(3), index: z.number().int().min(1).max(10),
  generationId: z.string(), startedAt: z.string(), dispatchedAt: z.string().nullable(),
  acceptedAt: z.string().nullable(), finishedAt: z.string(), latencyMs: z.number().nonnegative(),
  dispatchLatencyMs: z.number().nonnegative().nullable(), acceptedLatencyMs: z.number().nonnegative().nullable(),
  outcome: z.enum(["completed", "failed"]), failureCode: z.string().nullable(), runtimeCode: z.string().nullable(),
  streamFailure: z.boolean(), rateLimited: z.boolean(), completionUnknown: z.boolean(),
  usage: z.unknown(), attempts: z.array(z.unknown()),
}).strict();
export type ConcurrencySample = z.infer<typeof ConcurrencySampleSchema>;

export function summarizeConcurrency(samples: ConcurrencySample[], wallTimeMs: number, peakAccepted: number) {
  const completed = samples.filter((sample) => sample.outcome === "completed");
  const latencies = samples.map((sample) => sample.latencyMs).sort((left, right) => left - right);
  const middle = Math.floor(latencies.length / 2);
  return {
    calls: samples.length, completed: completed.length, failures: samples.length - completed.length,
    streamFailures: samples.filter((sample) => sample.streamFailure).length,
    rateLimits: samples.filter((sample) => sample.rateLimited).length,
    unknownCompletions: samples.filter((sample) => sample.completionUnknown).length,
    wallTimeMs, peakAccepted, medianLatencyMs: !latencies.length ? null : latencies.length % 2
      ? latencies[middle]! : (latencies[middle - 1]! + latencies[middle]!) / 2,
    p95LatencyMs: latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1]! : null,
    completedCallsPerMinute: wallTimeMs > 0 ? completed.length * 60_000 / wallTimeMs : null,
  };
}

type BatchSummary = ReturnType<typeof summarizeConcurrency>;

/** A small probe can support two slots, but cannot prove long research streams reliable. */
export function recommendModelConcurrency(batches: Array<{ concurrency: number; summary: BatchSummary }>) {
  const serial = batches.find((batch) => batch.concurrency === 1)?.summary;
  const parallel = batches.find((batch) => batch.concurrency === 2)?.summary;
  const third = batches.find((batch) => batch.concurrency === 3)?.summary;
  const reasons: string[] = [];
  if (!serial || !parallel || !third || [serial, parallel, third].some((batch) => batch.calls !== 10)) {
    reasons.push("The required ten calls at each of one, two and three slots are incomplete.");
  }
  if (!serial || !parallel || [serial, parallel].some((batch) => batch.completed !== 10
    || batch.failures > 0 || batch.streamFailures > 0 || batch.rateLimits > 0 || batch.unknownCompletions > 0)) {
    reasons.push("Both the serial baseline and two-slot batch need ten confirmed completions with no failures or rate limits.");
  }
  if (parallel?.peakAccepted !== 2) reasons.push("Two overlapping accepted native generations were not observed.");
  if (!serial || !parallel || parallel.wallTimeMs > serial.wallTimeMs * 0.8) {
    reasons.push("Two slots did not reduce batch wall time by at least twenty percent.");
  }
  if (!serial?.p95LatencyMs || !parallel?.p95LatencyMs || parallel.p95LatencyMs > serial.p95LatencyMs * 1.5) {
    reasons.push("Two-slot p95 latency must stay within one and a half times the serial baseline.");
  }
  return { recommendedMaxActive: reasons.length ? 1 : 2, reasons: reasons.length ? reasons
    : ["Two slots completed all ten calls without transport failure or rate limit, with overlapping native acceptance and useful throughput."],
  };
}

export async function measureModelConcurrency(client: StructuredModelClient & { setMaxConcurrentGenerations(maxActive: number): void },
  model: ModelRef, onSample: (sample: ConcurrencySample) => void = () => undefined) {
  const batches: Array<{ concurrency: number; summary: BatchSummary; samples: ConcurrencySample[] }> = [];
  const startedAt = new Date().toISOString();
  for (const concurrency of [1, 2, 3]) {
    client.setMaxConcurrentGenerations(concurrency);
    const scheduler = new WorkflowModelScheduler(concurrency);
    let activeAccepted = 0;
    let peakAccepted = 0;
    const batchStarted = performance.now();
    const samples = await Promise.all(Array.from({ length: 10 }, (_, index) => scheduler.schedule("measurement", async () => {
      const generationId = randomUUID();
      const started = performance.now();
      const sampleStartedAt = new Date().toISOString();
      let dispatchedAt: string | null = null;
      let acceptedAt: string | null = null;
      let accepted = false;
      let dispatchLatencyMs: number | null = null;
      let acceptedLatencyMs: number | null = null;
      const base = { concurrency, index: index + 1, generationId, startedAt: sampleStartedAt };
      let sample: ConcurrencySample;
      try {
        const result = await client.structuredCompletion({ generationId, stage: WORK_ORDER.stage, model,
          reasoningEffort: "xhigh", workOrder: WORK_ORDER, evidence: EVIDENCE, schema: OUTPUT_SCHEMA,
          jsonSchema: OUTPUT_JSON_SCHEMA, repairPolicy: "disabled", deadlineMs: 180_000,
          onDispatched: () => { dispatchedAt = new Date().toISOString(); dispatchLatencyMs = performance.now() - started; },
          onAccepted: () => {
            accepted = true; acceptedAt = new Date().toISOString(); acceptedLatencyMs = performance.now() - started;
            peakAccepted = Math.max(peakAccepted, ++activeAccepted);
          },
        });
        sample = { ...base, dispatchedAt, acceptedAt, dispatchLatencyMs, acceptedLatencyMs,
          finishedAt: new Date().toISOString(), latencyMs: performance.now() - started, outcome: "completed",
          failureCode: null, runtimeCode: null, streamFailure: false, rateLimited: false,
          completionUnknown: result.metadata.attempts.some((attempt) => attempt.providerCompletion === "unknown"),
          usage: result.metadata.usage, attempts: result.metadata.attempts };
      } catch (error) {
        const failure = error instanceof ProviderFailure ? error : null;
        const attempts = failure?.attempts ?? [];
        const completionUnknown = attempts.some((attempt) => attempt.providerCompletion === "unknown")
          || Boolean(acceptedAt && !attempts.length);
        sample = { ...base, dispatchedAt, acceptedAt, dispatchLatencyMs, acceptedLatencyMs,
          finishedAt: new Date().toISOString(), latencyMs: performance.now() - started, outcome: "failed",
          failureCode: failure?.code ?? "unexpected", runtimeCode: failure?.runtimeCode ?? null,
          streamFailure: completionUnknown && Boolean(acceptedAt) && (failure?.runtimeCode === "provider_unavailable"
            || failure?.code === "interrupted" && !failure.runtimeCode),
          rateLimited: failure?.code === "rate-limit" || failure?.runtimeCode === "rate_limited",
          completionUnknown, usage: { status: "unknown" }, attempts };
      } finally {
        if (accepted) activeAccepted--;
      }
      ConcurrencySampleSchema.parse(sample);
      onSample(sample);
      return sample;
    })));
    batches.push({ concurrency, summary: summarizeConcurrency(samples, performance.now() - batchStarted, peakAccepted), samples });
  }
  return { schemaVersion: 1, kind: "synthetic-subscription-transport-measurement", startedAt,
    finishedAt: new Date().toISOString(), model, reasoningEffort: "xhigh", callsPerConcurrency: 10,
    deadlineMs: 180_000, automaticReplay: false,
    workloadSha256: createHash("sha256").update(JSON.stringify({ WORK_ORDER, EVIDENCE, OUTPUT_JSON_SCHEMA })).digest("hex"),
    limits: "Thirty bounded synthetic calls measure account transport, not deep workflow wall time or long-stream reliability.",
    batches, recommendation: recommendModelConcurrency(batches),
  };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { live: { type: "boolean", default: false },
    runtime: { type: "string" }, lock: { type: "string" }, model: { type: "string" }, out: { type: "string" },
    help: { type: "boolean", default: false } } });
  if (values.help || !values.live) {
    console.log("bun scripts/measure-model-concurrency.ts --live --runtime PATH --lock PATH --model ID --out build/concurrency.json");
    console.log("Requires an exclusive account interval. An Electron safeStorage helper must pipe the subscription credential as one JSON string through stdin. No credentials are read from environment variables or printed. Runs ten bounded xhigh calls per level, without retries.");
  } else {
    if (!values.runtime || !values.lock || !values.out) throw new Error("--runtime, --lock and --out are required.");
    const lock = z.object({ version: z.string(), sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
      sha256: z.string().regex(/^[a-f0-9]{64}$/) }).parse(JSON.parse(await readFile(values.lock, "utf8")));
    const credentialInput = await Bun.stdin.text();
    let credential: string;
    try { credential = z.string().min(1).max(128 * 1024).parse(JSON.parse(credentialInput)); }
    catch { throw new Error("A subscription credential must arrive through the helper's private stdin pipe."); }
    const runtime = new RuntimeClient({ executablePath: resolve(values.runtime), artifact: lock,
      appVersion: "concurrency-measurement", maxConcurrentGenerations: 1 });
    runtime.setSessionInitializer(async (session) => session.restoreCredential("openai-subscription", credential));
    try {
      const models = await runtime.listModels("openai-subscription");
      const model = models.find((candidate) => (!values.model || candidate.identity.modelId === values.model)
        && candidate.supportedReasoningEfforts?.includes("xhigh"));
      if (!model) throw new Error("Choose an available subscription model supporting xhigh.");
      const runtimeIdentity = runtime.preparedIdentity();
      const report = await measureModelConcurrency(runtime, model.identity, (sample) => {
        console.log(JSON.stringify({ concurrency: sample.concurrency, index: sample.index, outcome: sample.outcome,
          latencyMs: Math.round(sample.latencyMs), failureCode: sample.failureCode,
          streamFailure: sample.streamFailure, rateLimited: sample.rateLimited }));
      });
      const outputPath = resolve(values.out);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, `${JSON.stringify({ ...report, runtime: runtimeIdentity }, null, 2)}\n`);
      console.log(JSON.stringify({ reportPath: outputPath, recommendation: report.recommendation,
        batches: report.batches.map(({ concurrency, summary }) => ({ concurrency, ...summary })) }));
    } finally { await runtime.close(); }
  }
}
