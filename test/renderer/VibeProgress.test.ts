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
  test("an uncertain search retry requires acknowledgment and sends its exact search ID", async () => {
    const state = detail({ state: "finished", outcome: "needs-attention" });
    state.tasks = [{ ...state.tasks[1]!, kind: "discovery", terminalAttemptKind: "search",
      terminalAttemptId: "search-request-uuid" }];
    const onRetryTask = vi.fn(async () => {});
    const view = render(VibeProgress, { detail: state, busy: false,
      onPause: vi.fn(async () => {}), onStop: vi.fn(async () => {}), onRetryTask });
    const button = view.getByRole("button", { name: "Retry search" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await fireEvent.click(view.getByRole("checkbox", { name: /this search may have completed/ }));
    expect(button.disabled).toBe(false);
    await fireEvent.click(button);
    expect(onRetryTask).toHaveBeenCalledWith("search-1", "search-request-uuid", true);
  });

  test("shows area investigators alongside live research and keeps run controls accessible", async () => {
    const onPause = vi.fn(async () => {});
    const view = render(VibeProgress, { detail: detail({ ideaTargetReady: false }), busy: false,
      investigators: [{ areaId: "bank", areaName: "Bank matching", state: "running", currentStep: "Checking evidence gaps", confirmedCount: 1, insufficientCount: 2, droppedCount: 0 }],
      onPause, onStop: vi.fn(async () => {}) });
    expect(view.getByRole("region", { name: "Area investigators" })).toBeTruthy();
    expect(view.getByRole("listitem", { name: "Bank matching investigator" }).textContent).toContain("Checking evidence gaps");
    expect(view.getByText("Problems").nextElementSibling?.textContent).toBe("1");
    await fireEvent.click(view.getByRole("button", { name: "Pause" }));
    expect(onPause).toHaveBeenCalledOnce();
    expect(view.queryByRole("progressbar")).toBeNull();
  });

  test("resumes server-verified paused work while retaining historical uncertain budget entries", async () => {
    const state = detail({ state: "paused", canResume: true });
    state.tasks = [state.tasks[0]!];
    const onResume = vi.fn(async () => {});
    const view = render(VibeProgress, { detail: state, busy: false, onPause: vi.fn(async () => {}), onStop: vi.fn(async () => {}), onResume });
    await fireEvent.click(view.getByRole("button", { name: "Resume" }));
    expect(onResume).toHaveBeenCalledOnce();
  });

  test("offers the explicit saved-problem reassessment for an eligible completed discovery", async () => {
    const state = detail({ state: "finished", outcome: "no-qualifying-ideas" });
    state.tasks = [{ ...state.tasks[0]!, id: "discovery-1", kind: "discovery", state: "succeeded", canReassessProblems: true }];
    const onReassessProblems = vi.fn(async () => {});
    const view = render(VibeProgress, { detail: state, busy: false, onPause: vi.fn(async () => {}),
      onStop: vi.fn(async () => {}), onReassessProblems });
    await fireEvent.click(view.getByRole("button", { name: "Re-evaluate problems" }));
    expect(onReassessProblems).toHaveBeenCalledWith("discovery-1");
    expect(view.queryByRole("button", { name: "Retry task" })).toBeNull();
  });

  test("shows one activity row for consecutive events describing the same action", () => {
    const state = detail({ ideaTargetReady: false });
    state.activity = ["Model request dispatched", "Model request accepted", "Model request accepted"]
      .map((message, index) => ({ id: `event-${index}`, message, stage: "extracting", createdAt: `2026-09-23T12:00:0${index}.000Z` }));
    const view = render(VibeProgress, { detail: state, busy: false, onPause: vi.fn(async () => {}), onStop: vi.fn(async () => {}) });
    expect(view.getAllByText("Reading sources and extracting evidence")).toHaveLength(1);
    expect(view.getByRole("log").querySelector("time")?.dateTime).toBe("2026-09-23T12:00:02.000Z");
  });

  test("shows research activity and accessible controls until the idea assignments exist", async () => {
    const state = detail({ ideaTargetReady: false, selectedProblemIds: [] });
    state.activity = [{ id: "event-1", message: "Searching Perplexity: repair shop warranty delays", stage: "searching", createdAt: "2026-09-23T12:00:00.000Z" }];
    const onPause = vi.fn(async () => {});
    const onStop = vi.fn(async () => {});
    const view = render(VibeProgress, { detail: state, busy: false, onPause, onStop });
    expect(view.getByRole("heading", { name: "Researching your brief" })).toBeTruthy();
    expect(view.getByRole("log").textContent).toContain("repair shop warranty delays");
    expect(view.queryByRole("progressbar")).toBeNull();
    expect(view.queryByLabelText("Idea review counts")).toBeNull();
    expect(view.container.querySelector("details")?.open).toBe(false);
    await fireEvent.click(view.getByRole("button", { name: "Pause" }));
    await fireEvent.click(view.getByRole("button", { name: "Stop" }));
    expect(onPause).toHaveBeenCalledOnce();
    expect(onStop).toHaveBeenCalledOnce();
    await view.rerender({ detail: { ...state, summary: { ...state.summary, ideaTargetReady: true,
      selectedProblemIds: ["problem-1", "problem-2"], counts: { ...state.summary.counts, requested: 6, accepted: 0, missing: 6 } } } });
    expect(view.getByRole("heading", { name: "Writing and ranking ideas" })).toBeTruthy();
    expect(view.queryByRole("progressbar")).toBeNull();
    expect(view.queryByText(/distinct ideas/)).toBeNull();
  });

  test("failed discovery keeps its error without presenting an unallocated idea target", () => {
    const state = detail({ ideaTargetReady: false, state: "finished", outcome: "failed",
      stopReason: "Search provider is unavailable.", finishedAt: "2026-09-23T12:01:00.000Z" });
    const view = render(VibeProgress, { detail: state, busy: false, onPause: vi.fn(async () => {}), onStop: vi.fn(async () => {}) });
    expect(view.queryByRole("heading", { level: 2 })).toBeNull();
    expect(view.getByRole("status").textContent).toContain("Search provider is unavailable.");
    expect(view.queryByText(/distinct ideas/)).toBeNull();
    expect(view.queryByRole("button", { name: "Pause" })).toBeNull();
  });

  test("shows actual usage without remaining limits for depth-guided research", () => {
    const state = detail();
    state.summary.limits.enforced = false;
    const view = render(VibeProgress, { detail: state, busy: false,
      onPause: vi.fn(async () => {}), onStop: vi.fn(async () => {}) });
    expect(view.getByLabelText("Work completed")).toBeTruthy();
    expect(view.getByText("Model calls").nextElementSibling?.textContent).toBe("5");
    expect(view.queryByText("Model calls left")).toBeNull();
    expect(view.queryByText("Time left")).toBeNull();
    expect(view.queryByText("Extend work allowance")).toBeNull();
  });

  test("shows the current stage, remaining allowance, and current task without idea counters", async () => {
    const onPause = vi.fn(async () => {});
    const onStop = vi.fn(async () => {});
    const view = render(VibeProgress, { detail: detail(), busy: false, onPause, onStop });

    expect(view.getByText("Checking alternatives")).toBeTruthy();
    expect(view.queryByRole("progressbar")).toBeNull();
    for (const gone of ["Requested", "Validated", "Duplicates", "Missing"]) expect(view.queryByText(gone)).toBeNull();
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

  test("a finished run keeps only Run details: calls, searches, time taken and a session ID to copy", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const state = detail({ state: "finished", outcome: "partial", currentStage: null,
      stopReason: "Short by 2 distinct ideas.", finishedAt: "2026-09-23T12:33:00.000Z" });
    state.summary.limits.enforced = false;
    const view = render(VibeProgress, { detail: state, busy: false, onPause: vi.fn(async () => {}), onStop: vi.fn(async () => {}),
      investigators: [{ areaId: "bank", areaName: "Bank matching", state: "succeeded", currentStep: null, confirmedCount: 1, insufficientCount: 0, droppedCount: 0 }] });
    expect(view.queryByRole("heading", { level: 2 })).toBeNull();
    expect(view.queryByText(/Run result|distinct ideas|Partial result/)).toBeNull();
    expect(view.queryByRole("region", { name: "Area investigators" })).toBeNull();
    const details = view.container.querySelector("details.run-details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(view.getByText("Model calls").nextElementSibling?.textContent).toBe("5");
    expect(view.getByText("Searches").nextElementSibling?.textContent).toBe("2");
    expect(view.getByText("Time taken").nextElementSibling?.textContent).toBe("33 min");
    expect(view.getByText("session-1")).toBeTruthy();
    await fireEvent.click(view.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("session-1");
    await waitFor(() => expect(view.getByRole("button", { name: "Copied" })).toBeTruthy());
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

  test("requires fresh acknowledgement when the same task has a new unknown attempt", async () => {
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

    await view.rerender({ detail: { ...run, tasks: run.tasks.map(task => task.id === "search-1"
      ? { ...task, terminalAttemptId: "attempt-unknown-again" } : task) } });
    const checkbox = view.getByRole("checkbox", { name: /may have completed/ }) as HTMLInputElement;
    const retryAgain = view.getByRole("button", { name: "Retry task" }) as HTMLButtonElement;
    expect(checkbox.checked).toBe(false);
    expect(retryAgain.disabled).toBe(true);
    retryAgain.click();
    expect(onRetryTask).toHaveBeenCalledOnce();
    await fireEvent.click(checkbox);
    expect(retryAgain.disabled).toBe(false);
    await fireEvent.click(retryAgain);
    expect(onRetryTask).toHaveBeenLastCalledWith("search-1", "attempt-unknown-again", true);
    expect(onRetryTask).toHaveBeenCalledTimes(2);
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
