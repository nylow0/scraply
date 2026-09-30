import { describe, expect, test } from "bun:test";
import { measureModelConcurrency, recommendModelConcurrency, summarizeConcurrency,
  type ConcurrencySample } from "../../scripts/measure-model-concurrency";
import { ProviderFailure, type StructuredModelClient } from "../../src/providers/structured";

function samples(concurrency: number, failures = 0): ConcurrencySample[] {
  return Array.from({ length: 10 }, (_, index) => ({ concurrency, index: index + 1, generationId: `${concurrency}-${index}`,
    startedAt: "2026-09-30T12:00:00.000Z", dispatchedAt: "2026-09-30T12:00:00.000Z",
    acceptedAt: "2026-09-30T12:00:00.001Z", finishedAt: "2026-09-30T12:00:01.000Z",
    dispatchLatencyMs: 0, acceptedLatencyMs: 1, latencyMs: 1_000,
    outcome: index < failures ? "failed" : "completed", failureCode: index < failures ? "interrupted" : null,
    runtimeCode: index < failures ? "provider_unavailable" : null, streamFailure: index < failures,
    rateLimited: false, completionUnknown: index < failures, usage: { status: "unknown" }, attempts: [],
  }));
}

describe("model concurrency measurement", () => {
  test("reports the median of both middle calls in an even batch", () => {
    const measured = samples(1).map((sample, index) => ({ ...sample, latencyMs: index * 100 }));
    expect(summarizeConcurrency(measured, 10_000, 1)).toMatchObject({ medianLatencyMs: 450, p95LatencyMs: 900 });
  });

  test("recommends two only after a complete reliable overlapping comparison", () => {
    const batches = [
      { concurrency: 1, summary: summarizeConcurrency(samples(1), 10_000, 1) },
      { concurrency: 2, summary: summarizeConcurrency(samples(2), 6_000, 2) },
      { concurrency: 3, summary: summarizeConcurrency(samples(3, 1), 5_000, 3) },
    ];
    expect(recommendModelConcurrency(batches).recommendedMaxActive).toBe(2);
    expect(recommendModelConcurrency(batches.slice(0, 2)).recommendedMaxActive).toBe(1);
    expect(recommendModelConcurrency(batches.map((batch) => batch.concurrency === 2
      ? { ...batch, summary: summarizeConcurrency(samples(2, 1), 6_000, 2) } : batch)).recommendedMaxActive).toBe(1);
    expect(recommendModelConcurrency(batches.map((batch) => batch.concurrency === 2
      ? { ...batch, summary: { ...batch.summary, peakAccepted: 1 } } : batch)).recommendedMaxActive).toBe(1);
  });

  test("throughput without stable latency or without a speedup keeps one slot", () => {
    const batches = [1, 2, 3].map((concurrency) => ({ concurrency,
      summary: summarizeConcurrency(samples(concurrency), concurrency === 1 ? 10_000 : 9_000, concurrency) }));
    expect(recommendModelConcurrency(batches).recommendedMaxActive).toBe(1);
    batches[1]!.summary.wallTimeMs = 6_000;
    batches[1]!.summary.p95LatencyMs = 1_501;
    expect(recommendModelConcurrency(batches).recommendedMaxActive).toBe(1);
  });

  test("runs exactly thirty distinct xhigh native requests and records actual overlap", async () => {
    const requests: Array<{ generationId: string; concurrency: number; reasoningEffort: string; repairPolicy: string }> = [];
    let capacity = 1;
    let active = 0;
    const client: StructuredModelClient & { setMaxConcurrentGenerations(maxActive: number): void } = {
      setMaxConcurrentGenerations(maxActive) { capacity = maxActive; },
      async structuredCompletion(request) {
        requests.push({ generationId: request.generationId, concurrency: capacity,
          reasoningEffort: request.reasoningEffort, repairPolicy: request.repairPolicy });
        expect(++active).toBeLessThanOrEqual(capacity);
        request.onDispatched?.();
        request.onAccepted?.({});
        await Bun.sleep(2);
        active--;
        return { output: request.schema.parse({ assessments: [{ problem: "Late delivery", supported: true,
          observationIds: ["a", "b"], missingEvidence: "" }] }), metadata: {
          model: request.model, usage: { status: "unknown" }, latencyMs: 2, repairCount: 0, providerRequestIds: [],
          attempts: [{ attempt: "initial", outcome: "completed", providerCompletion: "confirmed", model: request.model,
            usage: { status: "unknown" }, cost: { status: "not_reported" }, latencyMs: 2 }],
        } };
      },
    };
    const report = await measureModelConcurrency(client, { providerId: "openai-subscription", modelId: "gpt-fixture" });
    expect(requests).toHaveLength(30);
    expect(new Set(requests.map((request) => request.generationId)).size).toBe(30);
    expect(requests.every((request) => request.reasoningEffort === "xhigh" && request.repairPolicy === "disabled")).toBe(true);
    expect(report.batches.map((batch) => [batch.concurrency, batch.summary.calls, batch.summary.peakAccepted]))
      .toEqual([[1, 10, 1], [2, 10, 2], [3, 10, 3]]);
    expect(report.batches.every((batch) => batch.samples.every((sample) => sample.usage
      && JSON.stringify(sample.usage) === '{"status":"unknown"}'))).toBe(true);
  });

  test("records unknown rate limits separately from lost streams without replaying either request", async () => {
    const generationIds: string[] = [];
    const client: StructuredModelClient & { setMaxConcurrentGenerations(maxActive: number): void } = {
      setMaxConcurrentGenerations() {},
      async structuredCompletion(request) {
        generationIds.push(request.generationId);
        const index = generationIds.length;
        request.onDispatched?.();
        request.onAccepted?.({});
        await Bun.sleep(1);
        const attempts = [{ attempt: "initial" as const, outcome: "failed" as const,
          providerCompletion: "unknown" as const, model: request.model,
          usage: { status: "unknown" as const }, cost: { status: "unknown" as const }, latencyMs: 1 }];
        if (index === 11 || index === 12) throw new ProviderFailure("interrupted", "private provider detail", false,
          { runtimeCode: index === 11 ? "rate_limited" : "provider_unavailable", attempts });
        return { output: request.schema.parse({ assessments: [{ problem: "Delivery", supported: true,
          observationIds: ["a", "b"], missingEvidence: "" }] }), metadata: {
          model: request.model, usage: { status: "unknown" }, latencyMs: 1, repairCount: 0, providerRequestIds: [],
          attempts: [{ ...attempts[0]!, outcome: "completed", providerCompletion: "confirmed" }],
        } };
      },
    };
    const report = await measureModelConcurrency(client, { providerId: "openai-subscription", modelId: "gpt-fixture" });
    expect(generationIds).toHaveLength(30);
    expect(new Set(generationIds).size).toBe(30);
    expect(report.batches[1]?.summary).toMatchObject({ failures: 2, streamFailures: 1, rateLimits: 1, unknownCompletions: 2 });
    expect(report.recommendation.recommendedMaxActive).toBe(1);
    expect(JSON.stringify(report)).not.toContain("private provider detail");
  });
});
