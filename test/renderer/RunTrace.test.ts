import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import RunTrace from "../../src/renderer/components/RunTrace.svelte";
import WorkflowTabs from "../../src/renderer/components/WorkflowTabs.svelte";
import type { RunTrace as RunTraceValue, RunTraceStepDetail } from "../../src/shared/run-trace";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("RunTrace", () => {
  test("shows the saved funnel, evidence mix, coverage, and unknown usage without loading details", async () => {
    const getRunTraceStep = vi.fn(async () => stepDetail());
    Object.assign(window, { scraply: { getRunTrace: async () => sampleTrace(), getRunTraceStep } });
    const view = render(RunTrace, { runId: "run-1" });

    await view.findByRole("heading", { name: "Candidate funnel" });
    expect(view.getByText("Candidates", { selector: "dt" }).parentElement?.querySelector("dd")?.textContent).toBe("5");
    expect(view.getByText("Assessed").parentElement?.querySelector("dd")?.textContent).toBe("2");
    expect(view.getByText("Not assessed").parentElement?.querySelector("dd")?.textContent).toBe("2");
    expect(view.getByText("50% confirmed among assessed")).toBeTruthy();
    expect(view.getByText("Time lost to interruptions").parentElement?.querySelector("dd")?.textContent).toBe("12s");
    expect(view.getByRole("heading", { name: "Evidence mix" })).toBeTruthy();
    expect(view.getByRole("heading", { name: "Source mix" })).toBeTruthy();
    expect(view.getByRole("heading", { name: "Phases covered" })).toBeTruthy();
    expect(view.getByText("Reasoning tokens").parentElement?.querySelector("dd")?.textContent).toBe("Unknown");
    expect(view.getByText("workflow-v2-factor-harvest.md")).toBeTruthy();
    expect(getRunTraceStep).not.toHaveBeenCalled();
  });

  test("opens saved details on demand and keeps their decisions and quotes visible", async () => {
    const getRunTraceStep = vi.fn(async () => stepDetail());
    Object.assign(window, { scraply: { getRunTrace: async () => sampleTrace(), getRunTraceStep } });
    const view = render(RunTrace, { runId: "run-1" });

    const step = await view.findByRole("button", { name: /Read sources/ });
    await fireEvent.click(step);
    await view.findByText("We lose custom orders when the deposit arrives late.");
    expect(getRunTraceStep).toHaveBeenCalledWith({ runId: "run-1", stepId: "read-1" });
    expect(view.getByText("Find firsthand accounts of missed deposits.")).toBeTruthy();
    expect(view.getByText("This vendor claim does not describe a buyer's experience.")).toBeTruthy();
    expect(view.getByText("Vendor page. 1 facts kept.")).toBeTruthy();
    expect(view.getByText("Not available")).toBeTruthy();

    await fireEvent.click(step);
    await fireEvent.click(step);
    expect(getRunTraceStep).toHaveBeenCalledTimes(1);
  });

  test("exports every saved step, including unopened ones, as local JSON", async () => {
    const trace = sampleTrace();
    trace.steps.push({ ...trace.steps[0]!, id: "review-1", label: "Review ideas", stage: "solution-set-review" });
    const getRunTraceStep = vi.fn(async ({ stepId }: { runId: string; stepId: string }) => ({
      ...stepDetail(), step: trace.steps.find((step) => step.id === stepId)!,
    }));
    Object.assign(window, { scraply: { getRunTrace: async () => trace, getRunTraceStep } });
    const createObjectURL = vi.fn<(blob: Blob) => string>().mockReturnValue("blob:trace-export");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    });
    let download = "";
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      download = this.download;
    });
    const view = render(RunTrace, { runId: "run-1" });

    await view.findByRole("heading", { name: "Candidate funnel" });
    await fireEvent.click(view.getByRole("button", { name: "Export trace JSON" }));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(getRunTraceStep.mock.calls.map(([request]) => request.stepId)).toEqual(["read-1", "review-1"]);
    expect(download).toBe("scraply-run-run-1-trace.json");
    const blob = createObjectURL.mock.calls[0]?.[0];
    expect(blob?.type).toBe("application/json");
    if (!blob) throw new Error("Export did not create a JSON file.");
    const exported = JSON.parse(await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob);
    })) as { runId: string; details: RunTraceStepDetail[] };
    expect(exported.runId).toBe("run-1");
    expect(exported.details.map((detail) => detail.step.id)).toEqual(["read-1", "review-1"]);
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:trace-export"));
  });

  test("keeps a failed export retryable and does not download a partial trace", async () => {
    const getRunTraceStep = vi.fn().mockRejectedValueOnce(new Error("Saved step is unavailable")).mockResolvedValue(stepDetail());
    Object.assign(window, { scraply: { getRunTrace: async () => sampleTrace(), getRunTraceStep } });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const view = render(RunTrace, { runId: "run-1" });

    await view.findByRole("heading", { name: "Candidate funnel" });
    await fireEvent.click(view.getByRole("button", { name: "Export trace JSON" }));
    expect((await view.findByRole("alert")).textContent).toContain("Saved step is unavailable");
    expect(click).not.toHaveBeenCalled();
    expect(view.getByRole("button", { name: "Export trace JSON" }).hasAttribute("disabled")).toBe(false);
  });

  test("shows an empty saved run without inventing steps or assessment rates", async () => {
    const trace = sampleTrace();
    trace.steps = [];
    trace.candidates = [];
    trace.metrics.confirmationRate = null;
    Object.assign(window, { scraply: { getRunTrace: async () => trace } });
    const view = render(RunTrace, { runId: "run-1" });

    expect(await view.findByText("No saved steps are available for this run yet.")).toBeTruthy();
    expect(view.getByText("Unknown confirmed among assessed")).toBeTruthy();
  });

  test("polls a live trace every two seconds and stops after completion", async () => {
    vi.useFakeTimers();
    const live = { ...sampleTrace(), live: true, status: "running", finishedAt: null };
    const getRunTrace = vi.fn().mockResolvedValueOnce(live).mockResolvedValue(sampleTrace());
    Object.assign(window, { scraply: { getRunTrace } });
    const view = render(RunTrace, { runId: "run-1" });
    await tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(getRunTrace).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(getRunTrace).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await tick();
    expect(getRunTrace).toHaveBeenCalledTimes(2);
    expect(view.queryByText("Live")).toBeNull();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(getRunTrace).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  test("discards step details that arrive after navigating to another run", async () => {
    let finish: ((value: RunTraceStepDetail) => void) | undefined;
    const getRunTraceStep = vi.fn(() => new Promise<RunTraceStepDetail>((resolve) => finish = resolve));
    Object.assign(window, { scraply: {
      getRunTrace: async ({ runId }: { runId: string }) => ({ ...sampleTrace(), runId }), getRunTraceStep,
    } });
    const view = render(RunTrace, { runId: "run-1" });
    await fireEvent.click(await view.findByRole("button", { name: /Read sources/ }));
    await view.rerender({ runId: "run-2" });
    await view.findByRole("heading", { name: "Candidate funnel" });
    finish?.(stepDetail());
    await tick();
    expect(view.queryByText("We lose custom orders when the deposit arrives late.")).toBeNull();
    expect(view.getByRole("button", { name: /Read sources/ }).getAttribute("aria-expanded")).toBe("false");
  });
});

describe("Trace navigation", () => {
  test("enables the Trace tab for a saved run and includes it in keyboard navigation", async () => {
    const onSelect = vi.fn();
    const view = render(WorkflowTabs, { active: "ideas", setupReady: true, researchReady: true, ideasReady: true, traceReady: true, onSelect });
    await fireEvent.keyDown(view.getByRole("tab", { name: "Solutions" }), { key: "ArrowRight" });
    expect(onSelect).toHaveBeenCalledWith("trace");
    await fireEvent.click(view.getByRole("tab", { name: "Trace" }));
    expect(onSelect).toHaveBeenLastCalledWith("trace");
    await view.rerender({ active: "setup", setupReady: true, researchReady: false, ideasReady: false, traceReady: false, onSelect });
    expect(view.getByRole("tab", { name: "Trace" }).hasAttribute("disabled")).toBe(true);
  });
});

function sampleTrace(): RunTraceValue {
  return {
    runId: "run-1", threadId: "thread-1", sessionId: "session-1", status: "completed", purpose: "discovery",
    startedAt: "2026-09-30T08:00:00.000Z", finishedAt: "2026-09-30T08:01:30.000Z", live: false, warnings: [],
    metrics: {
      factors: 8, totalSources: 5, evidenceMix: { firsthand: 2, vendor: 6 }, audienceFit: { "intended-buyer": 2, general: 6 },
      sourceMix: { forum: 2, "vendor-page": 3 }, qualifyingObservations: 2, qualifyingPerAssessedCandidate: 1,
      candidateFunnel: { total: 5, assessed: 2, confirmed: 1, insufficient: 1, dropped: 1, notAssessed: 2, userAsserted: 0 },
      confirmationRate: 0.5, coverage: { kind: "phases", groups: [{ id: "audience", factors: 8, problems: 5, confirmed: 1 }] },
      modelCalls: 2, searches: 3, wallTimeMs: 90_000, modelTimeMs: 70_000, interruptionTimeMs: 12_000, interruptions: 1, ideas: 3, acceptedIdeas: 1,
    },
    steps: [{
      id: "read-1", kind: "model", stage: "factor-harvest", label: "Read sources", phase: "audience", status: "succeeded",
      startedAt: "2026-09-30T08:00:00.000Z", finishedAt: "2026-09-30T08:00:50.000Z", durationMs: 50_000,
      attempts: [{ id: "attempt-1", status: "succeeded", model: "gpt-6-luna", effort: "high", provider: "openai-subscription",
        startedAt: "2026-09-30T08:00:00.000Z", finishedAt: "2026-09-30T08:00:50.000Z", durationMs: 50_000,
        inputTokens: 100, outputTokens: 50, reasoningTokens: null, costUsd: null, errorCode: null, message: null, reasoningSummary: null }],
      prompt: { filename: "workflow-v2-factor-harvest.md", source: "bundled", sha256: "fixture-hash" }, search: null,
    }], candidates: [],
  };
}

function stepDetail(): RunTraceStepDetail {
  return {
    runId: "run-1", step: sampleTrace().steps[0]!, inputs: { sourceIds: ["source-1"] }, output: { facts: [] }, evidence: [], candidates: [], events: [],
    searches: [{ key: "query-1", query: "bakery deposit delays", intent: "complaints", reason: "Find firsthand accounts of missed deposits.",
      expectedSourceType: "forum", provider: "exa", route: null, parameters: { query: "bakery deposit delays" }, status: "completed",
      results: [{ sourceId: "source-1", url: "https://example.test/deposits", title: "Bakery orders", sourceClass: "vendor-page", factsKept: 1 }] }],
    facts: [{ id: "fact-1", sourceId: "source-1", subject: "Bakery owners", behavior: "Lose custom orders",
      quote: "We lose custom orders when the deposit arrives late.", sourceRole: "vendor", audienceFit: "general", kept: false,
      reason: "This vendor claim does not describe a buyer's experience." }],
  };
}
