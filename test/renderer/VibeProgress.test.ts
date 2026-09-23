import { fireEvent, render, waitFor } from "@testing-library/svelte";
import type { z } from "zod";
import { describe, expect, test, vi } from "vitest";
import VibeProgress from "../../src/renderer/components/VibeProgress.svelte";
import { PreviewWorkflowResultSchema, type WorkflowDetail, type WorkflowSummary } from "../../src/shared/workflow-contracts";

function detail(summaryChanges: Partial<WorkflowSummary> = {}): WorkflowDetail {
  return {
    summary: {
      sessionId: "session-1", threadId: "thread-1", purpose: "discovery", mode: "vibe", targetKind: "per-problem",
      state: "running", outcome: null, revision: 3, activeSnapshotId: "snapshot-1",
      selectedProblemIds: ["problem-1"],
      counts: { requested: 20, attempted: 16, validated: 15, accepted: 14, duplicate: 2,
        unresolved: 0, failed: 0, missing: 6, existing: 0, addedBySession: 14, total: 14 },
      limits: { maxMinutes: 30, maxModelCalls: 10, maxSearches: 4 },
      budget: { modelCalls: { limit: 10, spent: 5, reserved: 1, uncertain: 1 },
        searches: { limit: 4, spent: 2, reserved: 0, uncertain: 0 }, remainingMs: 120_000 },
      currentStage: "Checking alternatives", stopReason: null,
      startedAt: "2026-09-23T12:00:00.000Z", finishedAt: null,
      ...summaryChanges,
    },
    tasks: [
      { id: "research-1", parentItemId: null, kind: "research-request", scopeKey: "problem-1",
        state: "running", question: "Check buyer workflow", createdAt: "2026-09-23T12:00:00.000Z", finishedAt: null },
      { id: "search-1", parentItemId: "research-1", kind: "search", scopeKey: "buyer-source",
        state: "unknown", error: "One result may have reached the provider", createdAt: "2026-09-23T12:01:00.000Z", finishedAt: null },
    ],
    nextCursor: null,
  };
}

describe("VibeProgress", () => {
  test("shows accepted work, requested and reviewed counts, remaining allowance, and current task", async () => {
    const onPause = vi.fn(async () => {});
    const onStop = vi.fn(async () => {});
    const view = render(VibeProgress, { detail: detail(), busy: false, onPause, onStop });

    expect(view.getByText("Checking alternatives")).toBeTruthy();
    expect(view.getByRole("progressbar").getAttribute("aria-valuetext")).toBe("14 of 20 distinct ideas accepted");
    expect(view.getByText("Validated").nextElementSibling?.textContent).toBe("15");
    expect(view.getByText("Duplicates").nextElementSibling?.textContent).toBe("2");
    expect(view.getByText("Missing").nextElementSibling?.textContent).toBe("6");
    expect(view.getByText("Model calls left").nextElementSibling?.textContent).toContain("3 of 10");
    expect(view.getByText("Searches left").nextElementSibling?.textContent).toContain("2 of 4");
    expect(view.getByText("Time left").nextElementSibling?.textContent).toBe("2 min");
    expect(view.getAllByText("Check buyer workflow")).toHaveLength(2);

    await fireEvent.click(view.getByRole("button", { name: "Pause" }));
    await fireEvent.click(view.getByRole("button", { name: "Stop" }));
    expect(onPause).toHaveBeenCalledOnce();
    expect(onStop).toHaveBeenCalledOnce();
  });

  test("shows a settled zero-idea reason without live controls and keeps task diagnostics", async () => {
    const zeroCounts = { ...detail().summary.counts, accepted: 0, missing: 20, validated: 0, total: 0, addedBySession: 0 };
    const view = render(VibeProgress, { detail: detail({
      state: "finished", outcome: "no-qualifying-ideas", counts: zeroCounts,
      currentStage: null, stopReason: "No problem had direct intended-buyer evidence.",
      finishedAt: "2026-09-23T12:03:00.000Z",
    }), busy: false, onPause: vi.fn(async () => {}), onStop: vi.fn(async () => {}) });
    expect(view.getByRole("status").textContent).toContain("No problem had direct intended-buyer evidence.");
    expect(view.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(view.queryByRole("button", { name: "Stop" })).toBeNull();

    const diagnostics = view.container.querySelector("details.diagnostics") as HTMLDetailsElement | null;
    expect(diagnostics?.open).toBe(false);
    await fireEvent.click(view.getByText("Run details"));
    await fireEvent.click(view.getByText(/Task details/));
    expect(diagnostics?.open).toBe(true);
    expect(view.getByText("One result may have reached the provider")).toBeTruthy();
    expect(view.getByText("buyer-source")).toBeTruthy();
  });

  test("describes a completed research follow-up without an idea target", () => {
    const view = render(VibeProgress, { detail: detail({
      purpose: "research-followup", state: "finished", outcome: "partial",
      activeSnapshotId: "snapshot-new", researchApplied: true, currentStage: null,
      stopReason: "Selected research was applied to a new evidence snapshot.",
      finishedAt: "2026-09-23T12:03:00.000Z",
    }), busy: false, onPause: vi.fn(async () => {}), onStop: vi.fn(async () => {}) });
    expect(view.getByText("Research follow-up")).toBeTruthy();
    expect(view.getByRole("status").textContent).toContain("Research updated");
    expect(view.queryByRole("progressbar", { name: /Accepted/ })).toBeNull();
  });

  test("omits inherited idea shortfall and review counts while a research follow-up runs", () => {
    const view = render(VibeProgress, { detail: detail({ purpose: "research-followup" }), busy: false,
      onPause: vi.fn(async () => {}), onStop: vi.fn(async () => {}) });
    expect(view.getByText("Research follow-up")).toBeTruthy();
    expect(view.queryByText("6 still needed")).toBeNull();
    expect(view.queryByLabelText("Idea review counts")).toBeNull();
    expect(view.queryByRole("progressbar", { name: /Accepted/ })).toBeNull();
  });

  test("does not call an inherited snapshot an update after cancellation", () => {
    const view = render(VibeProgress, { detail: detail({
      purpose: "research-followup", state: "finished", outcome: "cancelled",
      activeSnapshotId: "snapshot-inherited", currentStage: null,
      stopReason: "The request was cancelled before applying new research.",
      finishedAt: "2026-09-23T12:03:00.000Z",
    }), busy: false, onPause: vi.fn(async () => {}), onStop: vi.fn(async () => {}) });
    expect(view.getByRole("status").textContent).toContain("Stopped.");
    expect(view.getByRole("status").textContent).toContain("cancelled before applying");
    expect(view.queryByText("Research updated")).toBeNull();
    expect(view.queryByRole("progressbar", { name: /Accepted/ })).toBeNull();
  });

  test("does not call partial follow-up work an applied update", () => {
    const view = render(VibeProgress, { detail: detail({
      purpose: "research-followup", state: "finished", outcome: "partial",
      activeSnapshotId: "snapshot-inherited", currentStage: null,
      stopReason: "The request ended before new research was selected.",
      finishedAt: "2026-09-23T12:03:00.000Z",
    }), busy: false, onPause: vi.fn(async () => {}), onStop: vi.fn(async () => {}) });
    expect(view.getByRole("status").textContent).toContain("Partial result.");
    expect(view.queryByText("Research updated")).toBeNull();
  });

  test("paused runs offer Resume while pending stop and busy states cannot dispatch another action", async () => {
    const onResume = vi.fn(async () => {});
    const safePaused = detail({ state: "paused", budget: { ...detail().summary.budget,
      modelCalls: { ...detail().summary.budget.modelCalls, uncertain: 0 } } });
    safePaused.tasks[1] = { ...safePaused.tasks[1]!, state: "succeeded" };
    const paused = render(VibeProgress, { detail: safePaused, busy: false,
      onPause: vi.fn(async () => {}), onStop: vi.fn(async () => {}), onResume });
    expect(paused.queryByRole("button", { name: "Pause" })).toBeNull();
    await fireEvent.click(paused.getByRole("button", { name: "Resume" }));
    expect(onResume).toHaveBeenCalledOnce();

    paused.unmount();
    const uncertain = render(VibeProgress, { detail: detail({ state: "paused" }), busy: false,
      onPause: vi.fn(async () => {}), onStop: vi.fn(async () => {}), onResume });
    expect(uncertain.queryByRole("button", { name: "Resume" })).toBeNull();
    uncertain.unmount();
    const stopping = render(VibeProgress, { detail: detail({ state: "stop-requested" }), busy: true,
      onPause: vi.fn(async () => {}), onStop: vi.fn(async () => {}), onResume });
    expect(stopping.queryByRole("button", { name: "Resume" })).toBeNull();
    expect(stopping.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(stopping.getByRole("status").textContent).toContain("Stopping current request");

    stopping.unmount();
    const busy = render(VibeProgress, { detail: detail(), busy: true,
      onPause: vi.fn(async () => {}), onStop: vi.fn(async () => {}) });
    expect((busy.getByRole("button", { name: "Pause" }) as HTMLButtonElement).disabled).toBe(true);
    expect((busy.getByRole("button", { name: "Stop" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("requires acknowledgement before retrying an unknown task attempt", async () => {
    const onRetryTask = vi.fn(async () => {});
    const run = detail({ state: "finished", outcome: "needs-attention" });
    run.tasks[1] = { ...run.tasks[1]!, terminalAttemptId: "attempt-unknown" };
    const view = render(VibeProgress, { detail: run, busy: false,
      onPause: vi.fn(async () => {}), onStop: vi.fn(async () => {}), onRetryTask });
    const retry = view.getByRole("button", { name: "Retry task" }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    await fireEvent.click(view.getByRole("checkbox", { name: /may have completed/ }));
    expect(retry.disabled).toBe(false);
    await fireEvent.click(retry);
    expect(onRetryTask).toHaveBeenCalledWith("search-1", "attempt-unknown", true);
  });

  test("shows startup family totals and applies only a previewed extension", async () => {
    const onPreviewExtension = vi.fn(async (extension: { additionalModelCalls: number; additionalSearches: number; additionalMinutes: number }) => ({
      type: "budget-extension" as const, proposal: extension, previewHash: "preview-extension",
      capabilityFingerprint: "models", minimumWork: { modelCalls: 0, searches: 0 },
      upperLimits: { maxMinutes: 30, maxModelCalls: 12, maxSearches: 4 },
      fieldErrors: [], expiresAt: "2099-01-01T00:00:00.000Z",
    }));
    const onApplyExtension = vi.fn(async (preview: z.infer<typeof PreviewWorkflowResultSchema>) => {
      if (preview.type !== "budget-extension") throw new Error("Unexpected preview");
    });
    const counts = { ...detail().summary.counts, accepted: 19, existing: 5, addedBySession: 14, total: 19, missing: 1 };
    const view = render(VibeProgress, { detail: detail({ counts, targetKind: "project" }), busy: false,
      onPause: vi.fn(async () => {}), onStop: vi.fn(async () => {}), onPreviewExtension, onApplyExtension });
    expect(view.getByRole("progressbar").getAttribute("aria-valuetext")).toBe("19 of 20 distinct business families accepted");
    expect(view.getByText("Existing families").nextElementSibling?.textContent).toBe("5");
    expect(view.getByText("Added this run").nextElementSibling?.textContent).toBe("14");
    expect(view.getByText("Total families").nextElementSibling?.textContent).toBe("19");

    await fireEvent.click(view.getByText("Extend work allowance"));
    const apply = view.getByRole("button", { name: "Apply extension" }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    await fireEvent.input(view.getByLabelText("Additional model calls"), { target: { value: "2" } });
    await fireEvent.click(view.getByRole("button", { name: "Preview extension" }));
    await waitFor(() => expect(apply.disabled).toBe(false));
    expect(view.getByText("New limits: 12 model calls, 4 searches, 30 minutes.")).toBeTruthy();
    await fireEvent.click(apply);
    await waitFor(() => expect(onApplyExtension).toHaveBeenCalledOnce());
    expect(onApplyExtension.mock.calls[0]?.[0]).toMatchObject({ previewHash: "preview-extension", proposal: { additionalModelCalls: 2 } });
  });
});
