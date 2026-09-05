import type { ModelRef } from "../shared/schemas";
import type { RunUsage } from "../shared/ipc";
import type { AttemptUsage, GenerationAttemptMetadata } from "../providers/structured";

export interface GenerationAttemptUsageRow {
  status: string;
  provider_id: string;
  model_id: string;
  attempt_metadata_json: string | null;
  usage_json: string | null;
}

type ParsedAttempt = {
  attempt: GenerationAttemptMetadata["attempt"] | "unknown";
  model: GenerationAttemptMetadata["model"];
  usage: GenerationAttemptMetadata["usage"];
  cost: GenerationAttemptMetadata["cost"];
  latencyMs: number;
};

const terminalStatuses = new Set(["completed", "failed", "cancelled", "interrupted"]);

export function summarizeRunUsage(rows: readonly GenerationAttemptUsageRow[]): RunUsage {
  const input = dimension();
  const output = dimension();
  const total = dimension();
  const cachedInput = dimension();
  const reasoning = dimension();
  const latency = dimension();
  const repairs = dimension();
  const models = new Map<string, ModelRef>();
  const reportedCosts = new Map<string, number>();
  let attemptCount = 0;
  let unknownAttemptCount = 0;
  let reportedWithoutCurrencyAttempts = 0;
  const reportedWithoutCurrencyAmounts: number[] = [];
  let notReportedAttempts = 0;
  let unknownCostAttempts = 0;

  for (const row of rows) {
    const parsed = parseAttempts(row);
    for (const attempt of parsed) {
      attemptCount += 1;
      models.set(`${attempt.model.providerId}:${attempt.model.modelId}`, attempt.model);
      if (attempt.usage.status === "known") {
        input.known += attempt.usage.value.inputTokens;
        output.known += attempt.usage.value.outputTokens;
        total.known += attempt.usage.value.totalTokens;
        if (attempt.usage.value.cachedInputTokens === undefined) cachedInput.unknownAttempts += 1;
        else cachedInput.known += attempt.usage.value.cachedInputTokens;
        if (attempt.usage.value.reasoningTokens === undefined) reasoning.unknownAttempts += 1;
        else reasoning.known += attempt.usage.value.reasoningTokens;
      } else {
        unknownAttemptCount += 1;
        input.unknownAttempts += 1;
        output.unknownAttempts += 1;
        total.unknownAttempts += 1;
        cachedInput.unknownAttempts += 1;
        reasoning.unknownAttempts += 1;
      }
      if (attempt.latencyMs >= 0) latency.known += attempt.latencyMs;
      else latency.unknownAttempts += 1;
      if (attempt.attempt === "schema_repair") repairs.known += 1;
      else if (attempt.attempt === "initial") repairs.known += 0;
      else repairs.unknownAttempts += 1;
      if (attempt.cost.status === "reported") {
        const currency = attempt.cost.value.currency?.trim();
        if (!currency) {
          reportedWithoutCurrencyAttempts += 1;
          reportedWithoutCurrencyAmounts.push(attempt.cost.value.amount);
        }
        else reportedCosts.set(currency, (reportedCosts.get(currency) ?? 0) + attempt.cost.value.amount);
      } else if (attempt.cost.status === "not_reported") notReportedAttempts += 1;
      else unknownCostAttempts += 1;
    }
  }

  const costStatus = reportedCosts.size > 0 && notReportedAttempts === 0 && unknownCostAttempts === 0 && reportedWithoutCurrencyAttempts === 0
    ? "reported"
    : reportedCosts.size === 0 && notReportedAttempts > 0 && unknownCostAttempts === 0 && reportedWithoutCurrencyAttempts === 0
      ? "not_reported"
      : reportedCosts.size === 0 && notReportedAttempts === 0 && unknownCostAttempts > 0 && reportedWithoutCurrencyAttempts === 0
        ? "unknown"
        : "mixed";

  return {
    schemaVersion: 1,
    availability: attemptCount > 0 ? "available" : "unavailable",
    attemptCount,
    unknownAttemptCount,
    models: [...models.values()],
    tokens: { input, output, total, cachedInput, reasoning },
    latencyMs: latency,
    repairCount: repairs,
    costs: {
      status: costStatus,
      reported: [...reportedCosts.entries()].map(([currency, amount]) => ({ currency, amount })),
      reportedWithoutCurrencyAttempts,
      reportedWithoutCurrencyAmounts,
      notReportedAttempts,
      unknownAttempts: unknownCostAttempts,
    },
  };
}

function parseAttempts(row: GenerationAttemptUsageRow): ParsedAttempt[] {
  const metadata = parseJson(row.attempt_metadata_json);
  if (isObject(metadata) && Array.isArray(metadata.attempts)) {
    if (metadata.attempts.length === 0) {
      const usageJson = parseJson(row.usage_json);
      if (Array.isArray(usageJson) && usageJson.length > 0) {
        return usageJson.map((value) => fallbackAttempt(row, parseUsage(value) ?? { status: "unknown" }, -1));
      }
      return terminalStatuses.has(row.status) ? [fallbackAttempt(row, { status: "unknown" }, -1)] : [];
    }
    return metadata.attempts.map((value) => parseAttempt(value) ?? fallbackAttempt(row, { status: "unknown" }, -1));
  }
  if (isObject(metadata)) {
    const parent = parseAttempt(metadata);
    if (parent) return [parent];
    const parentUsage = parseUsage(metadata.usage);
    if (parentUsage) return [fallbackAttempt(row, parentUsage, metadata.latencyMs)];
  }

  const usages = parseJson(row.usage_json);
  if (Array.isArray(usages) && usages.length > 0) {
    return usages.map((value) => fallbackAttempt(row, parseUsage(value) ?? { status: "unknown" }, -1));
  }
  if (row.status === "dispatched" || row.status === "accepted") return [fallbackAttempt(row, { status: "unknown" }, -1)];
  if (terminalStatuses.has(row.status)) return [fallbackAttempt(row, { status: "unknown" }, -1)];
  return [];
}

function parseAttempt(value: unknown): ParsedAttempt | null {
  if (!isObject(value) || (value.attempt !== "initial" && value.attempt !== "schema_repair")) return null;
  const model = value.model;
  const usage = parseUsage(value.usage);
  const cost = parseCost(value.cost);
  if (!isObject(model) || typeof model.providerId !== "string" || typeof model.modelId !== "string" || !usage || !cost || !isNonNegativeInteger(value.latencyMs)) return null;
  return {
    attempt: value.attempt,
    model: { providerId: model.providerId, modelId: model.modelId },
    usage,
    cost,
    latencyMs: value.latencyMs,
  };
}

function fallbackAttempt(
  row: GenerationAttemptUsageRow,
  usage: ParsedAttempt["usage"],
  latencyMs: unknown,
): ParsedAttempt {
  const model = { providerId: row.provider_id, modelId: row.model_id };
  const safeLatency = typeof latencyMs === "number" && Number.isInteger(latencyMs) && latencyMs >= 0 ? latencyMs : -1;
  return {
    attempt: "unknown",
    model,
    usage,
    cost: row.provider_id === "openai-subscription" ? { status: "not_reported" } : { status: "unknown" },
    latencyMs: safeLatency,
  };
}

function parseUsage(value: unknown): AttemptUsage | null {
  if (!isObject(value) || value.status === "unknown") return value === undefined ? null : { status: "unknown" };
  if (value.status !== "known" || !isObject(value.value)) return null;
  const inputTokens = value.value.inputTokens;
  const outputTokens = value.value.outputTokens;
  const totalTokens = value.value.totalTokens;
  if (!isNonNegativeInteger(inputTokens) || !isNonNegativeInteger(outputTokens) || !isNonNegativeInteger(totalTokens)) return null;
  const cachedInputTokens = value.value.cachedInputTokens;
  const reasoningTokens = value.value.reasoningTokens;
  const usage = {
    inputTokens, outputTokens, totalTokens,
    ...(isNonNegativeInteger(cachedInputTokens) ? { cachedInputTokens } : {}),
    ...(isNonNegativeInteger(reasoningTokens) ? { reasoningTokens } : {}),
  };
  return { status: "known", value: usage };
}

function parseCost(value: unknown): ParsedAttempt["cost"] | null {
  if (!isObject(value) || (value.status !== "reported" && value.status !== "not_reported" && value.status !== "unknown")) return null;
  if (value.status !== "reported") return { status: value.status };
  if (!isObject(value.value) || typeof value.value.amount !== "number" || !Number.isFinite(value.value.amount) || value.value.amount < 0) return null;
  if (value.value.currency !== undefined && typeof value.value.currency !== "string") return null;
  return { status: "reported", value: { amount: value.value.amount, ...(value.value.currency === undefined ? {} : { currency: value.value.currency }) } };
}

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try { return JSON.parse(value) as unknown; }
  catch { return null; }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function dimension(): { known: number; unknownAttempts: number } {
  return { known: 0, unknownAttempts: 0 };
}
