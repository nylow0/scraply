import { describe, expect, test } from "bun:test";
import { summarizeRunUsage, type GenerationAttemptUsageRow } from "../../src/backend/run-usage";

describe("run usage summaries", () => {
  test("sums attempts once and keeps optional token dimensions explicit", () => {
    const row = usageRow({
      status: "completed",
      provider_id: "openai-subscription",
      model_id: "luna",
      attempt_metadata_json: JSON.stringify({
        usage: { status: "known", value: { inputTokens: 999, outputTokens: 999, totalTokens: 1_998 } },
        attempts: [
          attempt("initial", { status: "known", value: { inputTokens: 10, outputTokens: 4, totalTokens: 14, cachedInputTokens: 2, reasoningTokens: 7 } }, 12, { status: "not_reported" }),
          attempt("schema_repair", { status: "known", value: { inputTokens: 3, outputTokens: 3, totalTokens: 6, cachedInputTokens: 1 } }, 4, { status: "not_reported" }),
        ],
      }),
    });

    const summary = summarizeRunUsage([row]);
    expect(summary.attemptCount).toBe(2);
    expect(summary.tokens.input).toEqual({ known: 13, unknownAttempts: 0 });
    expect(summary.tokens.total).toEqual({ known: 20, unknownAttempts: 0 });
    expect(summary.tokens.cachedInput).toEqual({ known: 3, unknownAttempts: 0 });
    expect(summary.tokens.reasoning).toEqual({ known: 7, unknownAttempts: 1 });
    expect(summary.latencyMs).toEqual({ known: 16, unknownAttempts: 0 });
    expect(summary.repairCount).toEqual({ known: 1, unknownAttempts: 0 });
    expect(summary.costs.status).toBe("not_reported");
  });

  test("retains known initial coverage when a schema repair fails", () => {
    const summary = summarizeRunUsage([usageRow({
      status: "failed",
      provider_id: "openai-subscription",
      model_id: "luna",
      attempt_metadata_json: JSON.stringify({
        attempts: [
          attempt("initial", { status: "known", value: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } }, 9, { status: "not_reported" }),
          attempt("schema_repair", { status: "unknown" }, 8, { status: "unknown" }),
        ],
      }),
    })]);

    expect(summary.attemptCount).toBe(2);
    expect(summary.unknownAttemptCount).toBe(1);
    expect(summary.tokens.input).toEqual({ known: 20, unknownAttempts: 1 });
    expect(summary.latencyMs).toEqual({ known: 17, unknownAttempts: 0 });
    expect(summary.repairCount).toEqual({ known: 1, unknownAttempts: 0 });
  });

  test("does not infer zero usage from legacy rows and keeps currencies separate", () => {
    const legacy = usageRow({ status: "completed", provider_id: "legacy-codex-cli", model_id: "old-model", attempt_metadata_json: null });
    const reported = usageRow({
      status: "completed", provider_id: "openrouter", model_id: "terra",
      attempt_metadata_json: JSON.stringify({ attempts: [
        attempt("initial", { status: "unknown" }, 3, { status: "reported", value: { amount: 2, currency: "EUR" } }),
        attempt("initial", { status: "unknown" }, 4, { status: "reported", value: { amount: 5, currency: "USD" } }),
        attempt("initial", { status: "unknown" }, 5, { status: "reported", value: { amount: 7 } }),
      ] }),
    });

    const summary = summarizeRunUsage([legacy, reported]);
    expect(summary.tokens.total).toEqual({ known: 0, unknownAttempts: 4 });
    expect(summary.costs.reported).toEqual([{ currency: "EUR", amount: 2 }, { currency: "USD", amount: 5 }]);
    expect(summary.costs.reportedWithoutCurrencyAmounts).toEqual([7]);
    expect(summary.costs.status).toBe("mixed");
  });

  test("marks a run without generation records unavailable", () => {
    const summary = summarizeRunUsage([]);
    expect(summary.availability).toBe("unavailable");
    expect(summary.attemptCount).toBe(0);
  });

  test("uses legacy usage arrays when an old parent record has no attempt list", () => {
    const summary = summarizeRunUsage([usageRow({
      status: "completed",
      attempt_metadata_json: JSON.stringify({ attempts: [] }),
      usage_json: JSON.stringify([{ status: "known", value: { inputTokens: 6, outputTokens: 2, totalTokens: 8 } }]),
    })]);
    expect(summary.tokens.total).toEqual({ known: 8, unknownAttempts: 0 });
  });

  test("shows dispatched work as unknown while excluding prepared work", () => {
    const summary = summarizeRunUsage([
      usageRow({ status: "prepared" }),
      usageRow({ status: "dispatched" }),
    ]);
    expect(summary.availability).toBe("available");
    expect(summary.attemptCount).toBe(1);
    expect(summary.unknownAttemptCount).toBe(1);
  });
});

function usageRow(overrides: Partial<GenerationAttemptUsageRow>): GenerationAttemptUsageRow {
  return {
    status: "completed", provider_id: "openai-subscription", model_id: "luna",
    attempt_metadata_json: null, usage_json: null, ...overrides,
  };
}

function attempt(
  kind: "initial" | "schema_repair",
  usage: unknown,
  latencyMs: number,
  cost: unknown,
): Record<string, unknown> {
  return { attempt: kind, model: { providerId: "openai-subscription", modelId: "luna" }, usage, cost, latencyMs };
}
