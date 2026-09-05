import { fireEvent, render } from "@testing-library/svelte";
import { describe, expect, test } from "vitest";
import RunUsage from "../../src/renderer/components/RunUsage.svelte";
import type { RunUsage as RunUsageValue } from "../../src/shared/ipc";

describe("RunUsage", () => {
  test("keeps the compact summary closed until expanded", async () => {
    const view = render(RunUsage, { usage: sampleUsage() });
    const details = view.container.querySelector("details");
    expect(details?.open).toBe(false);
    expect(view.getByText(/2 attempts/)).toBeTruthy();
    expect(view.getByText(/20 tokens/)).toBeTruthy();
    expect(view.getByText("Not reported")).toBeTruthy();

    await fireEvent.click(view.getByText(/2 attempts/));
    expect(details?.open).toBe(true);
    expect(view.getByText("Input tokens")).toBeTruthy();
    expect(view.getByText("13 + 1 unknown")).toBeTruthy();
    expect(view.getByText("luna")).toBeTruthy();
  });

  test("labels an old run with no usage records as unavailable", () => {
    const usage = sampleUsage();
    usage.availability = "unavailable";
    usage.attemptCount = 0;
    const view = render(RunUsage, { usage });
    expect(view.getByText("Unavailable")).toBeTruthy();
    expect(view.getByText("No generation record is available for this run.")).toBeTruthy();
  });

  test("keeps small reported amounts precise and labels missing currency", () => {
    const usage = sampleUsage();
    usage.costs = {
      status: "mixed", reported: [{ currency: "EUR", amount: 0.000001 }], reportedWithoutCurrencyAttempts: 1,
      reportedWithoutCurrencyAmounts: [7], notReportedAttempts: 0, unknownAttempts: 1,
    };
    const view = render(RunUsage, { usage });
    expect(view.getAllByText(/0\.000001 EUR, 7 \(currency not reported\)/).length).toBeGreaterThan(0);
  });
});

function sampleUsage(): RunUsageValue {
  const dimension = (known: number, unknownAttempts = 0) => ({ known, unknownAttempts });
  return {
    schemaVersion: 1,
    availability: "available",
    attemptCount: 2,
    unknownAttemptCount: 1,
    models: [{ providerId: "openai-subscription", modelId: "luna" }],
    tokens: { input: dimension(13, 1), output: dimension(7), total: dimension(20), cachedInput: dimension(3), reasoning: dimension(7, 1) },
    latencyMs: dimension(16, 1),
    repairCount: dimension(1),
    costs: { status: "not_reported", reported: [], reportedWithoutCurrencyAttempts: 0, reportedWithoutCurrencyAmounts: [], notReportedAttempts: 2, unknownAttempts: 0 },
  };
}
