import { fireEvent, render, waitFor, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { describe, expect, test, vi } from "vitest";
import type { ScraplyApi } from "../../src/preload/index";
import App from "../../src/renderer/App.svelte";
import type { ResearchEvent, WorkspaceState } from "../../src/shared/ipc";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";
import type { WorkflowDetail, WorkflowSummary } from "../../src/shared/workflow-contracts";
import { ResearchFrameSchema } from "../../src/shared/research-frame";
import { summarizeRunUsage } from "../../src/backend/run-usage";

describe("App workspace coordination", () => {
  test("previews a not-assessed candidate from the Controlled checkpoint before starting its assessment", async () => {
    const current = frameWorkflow({ approved: true });
    current.summary = { ...current.summary, state: "waiting-for-review", reviewKind: "research", outcome: null, revision: 4, finishedAt: null };
    const state = frameWorkspace(current);
    state.activeWorkflow = { ...current.summary, revision: 1 };
    state.rejectedProblemCandidates = [{ id: "saved-candidate", statement: "Bookkeepers repeat manual matching", reason: "Depth limit", disposition: "not-assessed",
      candidate: { statement: "Bookkeepers repeat manual matching", whyItPersists: "Rules lose context", affected: "Bookkeepers", scaleEstimate: "Unknown", scaleBasisFactorId: null, factorIds: [] } }];
    const preview = { type: "candidate-assessment" as const, proposal: { candidateId: "saved-candidate", sourceRunId: "saved-run", depth: "standard" as const, modelCalls: 6, searches: 3 },
      previewHash: "candidate-preview", capabilityFingerprint: "models", minimumWork: { modelCalls: 6, searches: 3 },
      upperLimits: { maxModelCalls: 20, maxSearches: 10, maxMinutes: 30 }, fieldErrors: [], expiresAt: "2099-01-01T00:00:00.000Z" };
    const previewWorkflow = vi.fn(async () => preview);
    const commandWorkflow = vi.fn(async () => {
      current.summary = { ...current.summary, state: "running", revision: 5 };
      state.activeWorkflow = current.summary;
      return { sessionId: current.summary.sessionId, revision: 5, summary: current.summary };
    });
    installApi({ getWorkspace: async () => state, getWorkflow: async () => structuredClone(current), previewWorkflow, commandWorkflow });
    const view = render(App);
    await view.findByRole("heading", { name: "Choose problems to develop" });
    await fireEvent.click(view.getByRole("button", { name: /^Show \d+ more leads?$/ }));
    await fireEvent.click(view.getByRole("button", { name: "Check this lead" }));
    await view.findByText(/6 model calls and 3 searches/);
    expect(previewWorkflow).toHaveBeenCalledWith({ type: "candidate-assessment", threadId: "alpha", sessionId: "frame-session", expectedRevision: 4, candidateId: "saved-candidate" });
    expect(commandWorkflow).not.toHaveBeenCalled();
    expect(state.rejectedProblemCandidates[0]?.disposition).toBe("not-assessed");
    await fireEvent.click(view.getByRole("button", { name: "Start check" }));
    await waitFor(() => expect(commandWorkflow).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 4,
      action: { type: "assess-not-assessed", candidateId: "saved-candidate", previewHash: "candidate-preview", capabilityFingerprint: "models", previewExpiresAt: "2099-01-01T00:00:00.000Z" },
    })));
    await waitFor(() => expect(view.queryByRole("button", { name: "Start check" })).toBeNull());
  });

  test("pauses Controlled research on the frame and approves exactly the user's edits", async () => {
    const current = frameWorkflow();
    const state = frameWorkspace(current);
    const commandWorkflow = vi.fn(async (request: Parameters<ScraplyApi["commandWorkflow"]>[0]) => {
      if (request.action.type !== "approve-frame") throw new Error("Unexpected frame action");
      current.researchFrame!.approved = request.action.frame;
      current.summary = { ...current.summary, state: "running", revision: 2 };
      state.activeWorkflow = current.summary;
      return { sessionId: current.summary.sessionId, revision: 2, summary: current.summary };
    });
    installApi({ getWorkspace: async () => state, getWorkflow: async () => structuredClone(current), commandWorkflow });
    const view = render(App);
    await view.findByRole("heading", { name: "Review research frame" });
    await fireEvent.input(view.getByLabelText("Goal"), { target: { value: "Find a workflow for solo bookkeepers." } });
    await fireEvent.input(view.getByLabelText("Language code"), { target: { value: "uk" } });
    await fireEvent.click(view.getByRole("button", { name: "Add language" }));
    await fireEvent.click(view.getByRole("button", { name: "Start research with this frame" }));
    await waitFor(() => expect(commandWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      expectedRevision: 1, action: { type: "approve-frame", frameId: "frame-1", frame: { ...frameWorkflow().researchFrame!.draft,
        goal: "Find a workflow for solo bookkeepers.", languages: ["en", "uk"] } },
    })));
    await waitFor(() => expect(view.queryByLabelText("Goal")).toBeNull());
  });

  test("regenerates a draft with one call and shows the returned version for review", async () => {
    const current = frameWorkflow();
    const state = frameWorkspace(current);
    const commandWorkflow = vi.fn(async (request: Parameters<ScraplyApi["commandWorkflow"]>[0]) => {
      if (request.action.type !== "regenerate-frame") throw new Error("Unexpected frame action");
      current.researchFrame = { ...current.researchFrame!, id: "frame-2", version: 2,
        draft: { ...request.action.frame, goal: "The regenerated goal." } };
      current.summary.revision += 1;
      current.summary.budget.modelCalls.spent += 1;
      state.activeWorkflow = current.summary;
      return { sessionId: current.summary.sessionId, revision: current.summary.revision, summary: current.summary };
    });
    installApi({ getWorkspace: async () => state, getWorkflow: async () => structuredClone(current), commandWorkflow });
    const view = render(App);
    await view.findByRole("heading", { name: "Review research frame" });
    await fireEvent.click(view.getByRole("button", { name: "Regenerate frame (1 call)" }));
    await waitFor(() => expect((view.getByLabelText("Goal") as HTMLTextAreaElement).value).toBe("The regenerated goal."));
    expect(commandWorkflow).toHaveBeenCalledOnce();
    expect(view.getByText("Spent so far: 3 model calls, 0 searches")).toBeTruthy();
  });

  test("reviews a known problem without research areas or a configured search provider", async () => {
    const current = frameWorkflow({ knownProblem: true });
    const state = frameWorkspace(current);
    state.validation.exa = { valid: false, error: "Exa key missing" };
    state.validation.native = { available: true, connected: true, accounts: [{ providerId: "openai-subscription" }] };
    const commandWorkflow = vi.fn(async () => ({ sessionId: current.summary.sessionId, revision: 2, summary: current.summary }));
    installApi({ getWorkspace: async () => state, getWorkflow: async () => structuredClone(current), commandWorkflow });
    const view = render(App);
    await view.findByRole("heading", { name: "Review research frame" });
    expect(view.queryByRole("button", { name: "Add your own area" })).toBeNull();
    expect(view.queryByRole("heading", { name: "Add web search" })).toBeNull();
    await fireEvent.click(view.getByRole("button", { name: "Continue with this frame" }));
    await waitFor(() => expect(commandWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      action: { type: "approve-frame", frameId: "frame-1", frame: current.researchFrame!.draft },
    })));
  });

  test("ends the draft when editing the brief and marks the replacement launch for the frame workflow", async () => {
    const current = frameWorkflow();
    const state = frameWorkspace(current);
    state.validation.native = { available: true, connected: true, accounts: [{ providerId: "openai-subscription" }] };
    const commandWorkflow = vi.fn(async (request: Parameters<ScraplyApi["commandWorkflow"]>[0]) => {
      if (request.action.type !== "stop") throw new Error("Unexpected frame action");
      current.summary = { ...current.summary, state: "finished", outcome: "cancelled", revision: 2, finishedAt: current.summary.startedAt };
      state.activeWorkflow = current.summary;
      return { sessionId: current.summary.sessionId, revision: 2, summary: current.summary };
    });
    const previewWorkflow = vi.fn(async (request: Parameters<ScraplyApi["previewWorkflow"]>[0]) => {
      if (request.type !== "launch") throw new Error("Unexpected preview");
      return { type: "launch" as const, proposal: { ...request.draft, resolvedInstructions: { research: "research", ideas: "ideas", review: "review" }, instructionHashes: { research: "r", ideas: "i", review: "v" } },
        previewHash: "frame-restart", capabilityFingerprint: "fixture", minimumWork: { modelCalls: 1, searches: 0 }, upperLimits: request.draft.limits, fieldErrors: [], expiresAt: "2099-01-01T00:00:00.000Z" };
    });
    const startWorkflow = vi.fn(async () => ({ sessionId: current.summary.sessionId, revision: 2, summary: current.summary }));
    installApi({ getWorkspace: async () => state, getWorkflow: async () => structuredClone(current), commandWorkflow, previewWorkflow, startWorkflow,
      saveScope: async ({ scope }) => { state.scope = scope; return state; }, saveRunConfig: async ({ config }) => { state.runConfig = config; return state; } });
    const view = render(App);
    await view.findByRole("heading", { name: "Review research frame" });
    await fireEvent.click(view.getByRole("button", { name: "Edit brief" }));
    await view.findByLabelText("What do you want to explore?");
    expect(commandWorkflow).toHaveBeenCalledWith(expect.objectContaining({ action: { type: "stop", reason: "Brief reopened for editing." } }));
    await fireEvent.input(view.getByLabelText("What do you want to explore?"), { target: { value: "A revised bookkeeping brief" } });
    await waitFor(() => expect((view.getByRole("button", { name: /^Start$/ }) as HTMLButtonElement).disabled).toBe(false));
    await fireEvent.click(view.getByRole("button", { name: /^Start$/ }));
    await waitFor(() => expect(startWorkflow).toHaveBeenCalledWith(expect.objectContaining({ contract: expect.objectContaining({ frameWorkflowVersion: 1, brief: "A revised bookkeeping brief" }) })));
    expect(current.researchFrame!.draft.goal).toBe("Find a useful bookkeeping workflow.");
  });

  test("saves an approved frame as a future version while keeping this run's frame unchanged", async () => {
    const current = frameWorkflow({ approved: true });
    const state = frameWorkspace(current);
    const original = structuredClone(current.researchFrame);
    const commandWorkflow = vi.fn(async (request: Parameters<ScraplyApi["commandWorkflow"]>[0]) => {
      if (request.action.type !== "edit-approved-frame") throw new Error("Unexpected frame action");
      current.latestResearchFrame = { ...current.latestResearchFrame!, id: "frame-2", version: 2, draft: request.action.frame, approved: request.action.frame };
      return { sessionId: current.summary.sessionId, revision: 1, summary: current.summary };
    });
    installApi({ getWorkspace: async () => state, getWorkflow: async () => structuredClone(current), commandWorkflow });
    const view = render(App);
    await view.findByRole("heading", { name: "Research stopped" });
    await fireEvent.click(view.getByRole("tab", { name: "Setup" }));
    await fireEvent.click(view.getByRole("button", { name: "Edit approved frame" }));
    await view.findByLabelText("Goal");
    await fireEvent.input(view.getByLabelText("Goal"), { target: { value: "A goal for future runs." } });
    expect(view.queryByRole("button", { name: "Regenerate frame (1 call)" })).toBeNull();
    await fireEvent.click(view.getByRole("button", { name: "Save new version" }));
    await view.findByText("Approved research frame, version 2");
    expect(view.getByText("This run uses version 1. New runs use version 2.")).toBeTruthy();
    expect(current.researchFrame).toEqual(original);
    await fireEvent.click(view.getByRole("button", { name: "Edit approved frame" }));
    await waitFor(() => expect((view.getByLabelText("Goal") as HTMLTextAreaElement).value).toBe("A goal for future runs."));
  });

  test("renders investigator lanes from actual workflow task records", async () => {
    const current = frameWorkflow({ approved: true });
    current.summary.state = "running";
    current.summary.outcome = null;
    current.tasks = [{ id: "investigator", parentItemId: null, kind: "investigate-area", scopeKey: "investigate-area:bank", state: "running", createdAt: current.summary.startedAt, finishedAt: null,
      investigator: { areaId: "bank", areaName: "Bank matching", currentStep: "Checking independent sources", confirmedCount: 1, insufficientCount: 2, droppedCount: 0 } }];
    const state = frameWorkspace(current);
    installApi({ getWorkspace: async () => state, getWorkflow: async () => structuredClone(current) });
    const view = render(App);
    const lane = await view.findByRole("listitem", { name: "Bank matching investigator" });
    expect(lane.textContent).toContain("Checking independent sources");
    expect(within(lane).getByText("Problems").nextElementSibling?.textContent).toBe("1");
    expect(view.queryByRole("progressbar")).toBeNull();
  });

  test("retries using the finished task revision shown in the detail panel", async () => {
    const state = workspace("alpha");
    const summary: WorkflowSummary = {
      sessionId: "interrupted", threadId: "alpha", purpose: "discovery", mode: "vibe", targetKind: "per-problem",
      state: "finished", outcome: "needs-attention", revision: 1, activeSnapshotId: null, selectedProblemIds: [],
      ideaTargetReady: false,
      counts: { requested: 0, attempted: 0, validated: 0, accepted: 0, duplicate: 0, unresolved: 0,
        failed: 1, missing: 0, existing: 0, addedBySession: 0, total: 0 },
      limits: { enforced: false, maxMinutes: 30, maxModelCalls: 44, maxSearches: 18 },
      budget: { modelCalls: { limit: 44, spent: 2, reserved: 0, uncertain: 1 },
        searches: { limit: 18, spent: 2, reserved: 0, uncertain: 0 }, remainingMs: 1_800_000 },
      currentStage: null, stopReason: "Response stream interrupted",
      startedAt: "2026-09-23T00:00:00.000Z", finishedAt: "2026-09-23T00:01:00.000Z",
    };
    state.activeWorkflow = summary;
    const commandWorkflow = vi.fn(async () => ({ sessionId: summary.sessionId, revision: 3, summary: { ...summary, revision: 3 } }));
    installApi({ getWorkspace: async () => state, commandWorkflow,
      getWorkflow: async () => ({ summary: { ...summary, revision: 3 }, tasks: [{ id: "failed-task", parentItemId: null,
        kind: "discovery", scopeKey: "initial-research", state: "unknown", terminalAttemptId: "attempt",
        createdAt: summary.startedAt, finishedAt: summary.finishedAt }], nextCursor: null }) });
    const view = render(App);
    await view.findByRole("heading", { name: "Research stopped" });
    await fireEvent.click(view.getByText("Run details"));
    await fireEvent.click(view.getByText("Task details"));
    await fireEvent.click(view.getByRole("checkbox", { name: /may have completed/ }));
    await fireEvent.click(view.getByRole("button", { name: "Retry task" }));
    await waitFor(() => expect(commandWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "interrupted", expectedRevision: 3, action: { type: "retry-task", taskId: "failed-task",
        expectedTerminalAttemptId: "attempt", acknowledgeUnknownCompletion: true },
    })));
  });

  test("keeps an icon rail in compact windows and opens the full list as a drawer", async () => {
    let compact = false;
    let resize: ((event: { matches: boolean }) => void) | undefined;
    vi.stubGlobal("matchMedia", vi.fn().mockImplementation(() => ({
      get matches() { return compact; },
      addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => { resize = listener; },
      removeEventListener: vi.fn(),
    })));
    installApi({ getWorkspace: async () => workspace("alpha") });
    const view = render(App);
    try {
      const navigation = view.container.querySelector("#research-navigation aside") as HTMLElement;
      await view.findByRole("button", { name: "Toggle sidebar" });
      await fireEvent.click(view.getByRole("button", { name: "Toggle sidebar" }));
      expect(navigation.classList.contains("collapsed")).toBe(true);
      // The rail keeps every destination reachable by name.
      expect(within(navigation).getByRole("button", { name: "Create new research thread" })).toBeTruthy();
      expect(within(navigation).getByRole("button", { name: "Settings" })).toBeTruthy();

      await fireEvent.keyDown(window, { key: "k", ctrlKey: true });
      expect(view.getByRole("dialog", { name: "All research" })).toBeTruthy();
      expect(document.activeElement).toBe(view.getByRole("textbox", { name: "Search research" }));
      await fireEvent.click(view.getByRole("button", { name: "Close search" }));

      compact = true;
      resize?.({ matches: true });
      await waitFor(() => expect(view.getByRole("button", { name: "Open navigation" })).toBeTruthy());
      expect(navigation.classList.contains("collapsed")).toBe(true);
      await fireEvent.click(view.getByRole("button", { name: "Open navigation" }));
      expect(navigation.classList.contains("collapsed")).toBe(false);
      expect(view.container.querySelector(".sidebar-backdrop")).not.toBeNull();
      const underlyingEscape = vi.fn();
      window.addEventListener("keydown", underlyingEscape);
      await fireEvent.keyDown(window, { key: "Escape" });
      window.removeEventListener("keydown", underlyingEscape);
      expect(navigation.classList.contains("collapsed")).toBe(true);
      expect(view.container.querySelector(".sidebar-backdrop")).toBeNull();
      expect(underlyingEscape).not.toHaveBeenCalled();

      compact = false;
      resize?.({ matches: false });
      // Leaving compact mode restores the wide-window choice, which was the rail.
      await waitFor(() => expect(view.getByRole("button", { name: "Toggle sidebar" })).toBeTruthy());
      expect(navigation.classList.contains("collapsed")).toBe(true);
    } finally {
      view.unmount();
      vi.unstubAllGlobals();
    }
  });

  test("starts a previewed Vibe run and shows its persisted progress", async () => {
    const state = workspace("alpha");
    state.validation.native = { available: true, connected: true, accounts: [{ providerId: "openai-subscription" }] };
    const summary: WorkflowSummary = {
      sessionId: "session-vibe", threadId: "alpha", purpose: "discovery", mode: "vibe", targetKind: "per-problem",
      state: "running", outcome: null, revision: 1, activeSnapshotId: null, selectedProblemIds: [],
      counts: { requested: 3, attempted: 0, validated: 0, accepted: 0, duplicate: 0, unresolved: 0,
        failed: 0, missing: 3, existing: 0, addedBySession: 0, total: 0 },
      limits: { maxMinutes: 30, maxModelCalls: 44, maxSearches: 18 },
      budget: { modelCalls: { limit: 44, spent: 0, reserved: 0, uncertain: 0 },
        searches: { limit: 18, spent: 0, reserved: 0, uncertain: 0 }, remainingMs: 1_800_000 },
      currentStage: "Researching direct buyer evidence", stopReason: null,
      startedAt: "2026-09-23T00:00:00.000Z", finishedAt: null,
    };
    const previewWorkflow = vi.fn(async (request: Parameters<ScraplyApi["previewWorkflow"]>[0]) => {
      structuredClone(request);
      if (request.type === "budget-extension") return {
        type: "budget-extension" as const, proposal: request.extension,
        previewHash: "extension-1", capabilityFingerprint: "models-1",
        minimumWork: { modelCalls: 0, searches: 0 },
        upperLimits: { maxMinutes: 30, maxModelCalls: 46, maxSearches: 18 },
        fieldErrors: [], expiresAt: "2099-01-01T00:00:00.000Z",
      };
      if (request.type !== "launch") throw new Error("This test previews only a launch.");
      return {
        type: "launch" as const,
        proposal: { ...request.draft,
          resolvedInstructions: { research: "research", ideas: "ideas", review: "review" },
          instructionHashes: { research: "r", ideas: "i", review: "v" } },
        previewHash: "preview-1", capabilityFingerprint: "models-1",
        minimumWork: { modelCalls: 36, searches: 16 }, upperLimits: request.draft.limits,
        fieldErrors: [], expiresAt: "2099-01-01T00:00:00.000Z",
      };
    });
    const startWorkflow = vi.fn(async (request: Parameters<ScraplyApi["startWorkflow"]>[0]) => {
      structuredClone(request);
      if (request.threadId !== "alpha") throw new Error("Wrong thread for launch");
      state.activeWorkflow = summary;
      return { sessionId: summary.sessionId, revision: summary.revision, summary };
    });
    const commandWorkflow = vi.fn(async (request: Parameters<ScraplyApi["commandWorkflow"]>[0]) => {
      structuredClone(request);
      if (request.action.type === "extend-budget") {
        const extended = { ...summary, revision: 2,
          limits: { ...summary.limits, maxModelCalls: 46 },
          budget: { ...summary.budget, modelCalls: { ...summary.budget.modelCalls, limit: 46 } } };
        state.activeWorkflow = extended;
        return { sessionId: extended.sessionId, revision: extended.revision, summary: extended };
      }
      if (request.action.type === "pause") {
        const paused = { ...(state.activeWorkflow ?? summary), state: "paused" as const, revision: 3 };
        state.activeWorkflow = paused;
        return { sessionId: paused.sessionId, revision: paused.revision, summary: paused };
      }
      throw new Error("Unexpected command");
    });
    installApi({
      getWorkspace: async () => structuredClone(state),
      saveScope: async (request) => { const { scope } = structuredClone(request); state.scope = scope; return structuredClone(state); },
      saveRunConfig: async (request) => { const { config } = structuredClone(request); state.runConfig = config; return structuredClone(state); },
      previewWorkflow, startWorkflow, commandWorkflow,
      getWorkflow: async () => ({ summary: state.activeWorkflow ?? summary, tasks: [], nextCursor: null }),
    });
    const view = render(App);
    await fireEvent.input(await view.findByPlaceholderText("Your topic or idea"), { target: { value: "Independent repair shops" } });
    await fireEvent.click(view.getByRole("radio", { name: /Vibe/ }));
    await waitFor(() => expect(previewWorkflow).toHaveBeenCalled());
    const launch = view.getByRole("button", { name: "Start" }) as HTMLButtonElement;
    await waitFor(() => expect(launch.disabled).toBe(false));
    await fireEvent.click(launch);
    await waitFor(() => expect(startWorkflow.mock.calls.length + Number(Boolean(view.queryByRole("alert")))).toBeGreaterThan(0));
    expect(view.queryByRole("alert")?.textContent).toBeFalsy();
    await waitFor(() => expect(startWorkflow).toHaveBeenCalledOnce());
    expect(startWorkflow.mock.calls[0]?.[0]).toMatchObject({ threadId: "alpha", contract: {
      mode: "vibe", brief: "Independent repair shops",
    } });
    expect(startWorkflow.mock.calls[0]?.[0].contract.targets.automaticProblemCap).toBeUndefined();
    expect(await view.findByLabelText("Vibe run progress")).toBeTruthy();
    expect(view.getByRole("heading", { name: "Researching your brief" })).toBeTruthy();
    expect(view.queryByText(/distinct ideas/)).toBeNull();
    expect(view.queryByRole("button", { name: "Add research" })).toBeNull();
    await fireEvent.click(view.getByText("Run details"));
    await fireEvent.click(view.getByText("Extend work allowance"));
    await fireEvent.input(view.getByLabelText("Additional model calls"), { target: { value: "2" } });
    await fireEvent.click(view.getByRole("button", { name: "Preview extension" }));
    await waitFor(() => expect((view.getByRole("button", { name: "Apply extension" }) as HTMLButtonElement).disabled).toBe(false));
    await fireEvent.click(view.getByRole("button", { name: "Apply extension" }));
    await waitFor(() => expect(commandWorkflow).toHaveBeenCalledTimes(1));
    expect(commandWorkflow.mock.calls[0]?.[0]).toMatchObject({ expectedRevision: 1,
      action: { type: "extend-budget", previewHash: "extension-1", extension: { additionalModelCalls: 2 } } });
    expect(view.getByText("Model calls left").nextElementSibling?.textContent).toContain("46 of 46");
    await fireEvent.click(view.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(commandWorkflow).toHaveBeenCalledTimes(2));
    expect(commandWorkflow.mock.calls[1]?.[0]).toMatchObject({ sessionId: "session-vibe", expectedRevision: 2, action: { type: "pause" } });
    expect(await view.findByRole("button", { name: "Resume" })).toBeTruthy();

    view.unmount();
    state.activeWorkflow = { ...summary, purpose: "known-problem", mode: "babysit", state: "waiting-for-review" };
    state.problemCandidates = [{ id: "problem-known", statement: "A buyer workflow problem", whyItPersists: "Manual coordination",
      affected: "Repair shops", scaleEstimate: "Several shops", verdict: "user-asserted", verdictReason: "Stated by the user",
      selected: true, factors: [], intendedBuyerEvidenceFactorIds: [], evidenceGap: null,
      singleHarvestModeWarning: false, developmentCompleted: false }];
    state.latestResearchRun = { runId: "old-run", status: "completed", problemId: "problem-known",
      codexCalls: 0, searches: 0, projectedCodexCalls: 0, projectedSearches: 0, lastActivity: "Completed",
      runConfig: { ...state.runConfig!, explorationPurpose: "startup-opportunities" } };
    const restored = render(App);
    await waitFor(() => expect(restored.getByRole("tab", { name: "Research" }).getAttribute("aria-selected")).toBe("true"));
    expect(restored.getByText("Ideas will follow your brief and each selected problem.")).toBeTruthy();
    expect(restored.queryByRole("combobox", { name: "Option type" })).toBeNull();
    expect(restored.queryByRole("textbox", { name: "Or state the problem yourself." })).toBeNull();
    restored.unmount();
    state.activeWorkflow = { ...summary, purpose: "research-followup", mode: "babysit", state: "running" };
    state.threads[0]!.status = "solutions-ready";
    const followUp = render(App);
    await waitFor(() => expect(followUp.getByRole("tab", { name: "Research" }).getAttribute("aria-selected")).toBe("true"));
  });
  test.each(["archived", "deleted"] as const)("skips %s research in both history directions and disables unreachable navigation", async (unavailable) => {
    let state = workspace("alpha");
    state.threads.push({ ...state.threads[0]!, id: "gamma", title: "Gamma" });
    let backendEvent: ((event: ResearchEvent) => void) | undefined;
    installApi({
      getWorkspace: async () => structuredClone(state),
      selectThread: async (threadId) => {
        state = { ...state, activeThreadId: threadId };
        return structuredClone(state);
      },
      archiveThread: async (threadId) => {
        state = { ...state, threads: state.threads.map((thread) => thread.id === threadId
          ? { ...thread, archivedAt: "2026-09-12T00:00:00.000Z" } : thread) };
        return structuredClone(state);
      },
      onBackendEvent(listener) { backendEvent = listener; return () => { backendEvent = undefined; }; },
    });
    const view = render(App);
    await view.findByRole("button", { name: "Open thread Alpha" });
    const back = view.getByRole("button", { name: "Go back" }) as HTMLButtonElement;
    const forward = view.getByRole("button", { name: "Go forward" }) as HTMLButtonElement;
    expect(back.disabled).toBe(true);

    for (const title of ["Beta", "Gamma"]) {
      const button = view.getByRole("button", { name: `Open thread ${title}` });
      await fireEvent.click(button);
      await waitFor(() => expect(button.getAttribute("aria-current")).toBe("true"));
    }
    await fireEvent.click(view.getByRole("button", { name: "Archive research Beta" }));
    await waitFor(() => expect(view.queryByRole("button", { name: "Open thread Beta" })).toBeNull());
    if (unavailable === "deleted") {
      // A reconciled workspace can remove an archived entry permanently.
      state = { ...state, threads: state.threads.filter((thread) => thread.id !== "beta") };
      backendEvent?.({ type: "run-completed", threadId: "gamma", runId: "run-gamma", problemId: null });
      await waitFor(() => expect(view.queryByRole("button", { name: "Restore Beta", hidden: true })).toBeNull());
    }

    await fireEvent.click(back);
    await waitFor(() => expect(view.getByRole("button", { name: "Open thread Alpha" }).getAttribute("aria-current")).toBe("true"));
    await tick();
    expect(back.disabled).toBe(true);
    expect(forward.disabled).toBe(false);
    await fireEvent.click(forward);
    await waitFor(() => expect(view.getByRole("button", { name: "Open thread Gamma" }).getAttribute("aria-current")).toBe("true"));
    await tick();
    expect(forward.disabled).toBe(true);

    await fireEvent.click(view.getByRole("button", { name: "Archive research Alpha" }));
    await waitFor(() => expect(back.disabled).toBe(true));
    expect(forward.disabled).toBe(true);
  });

  test("updates live usage without loading the whole workspace on progress", async () => {
    const state = workspace("alpha");
    const usage = summarizeRunUsage([]);
    usage.availability = "available";
    usage.attemptCount = 1;
    usage.tokens.total.known = 25;
    state.threads[0]!.status = "discovery-running";
    state.latestResearchRun = {
      runId: "run-alpha", status: "running", problemId: null, codexCalls: 1, searches: 0,
      projectedCodexCalls: 11, projectedSearches: 10, lastActivity: "Searching", usage,
    };
    let backendEvent: ((event: ResearchEvent) => void) | undefined;
    const getWorkspace = vi.fn().mockResolvedValue(state);
    installApi({ getWorkspace, onBackendEvent(listener) { backendEvent = listener; return () => { backendEvent = undefined; }; } });
    const view = render(App);
    expect(await view.findByText(/25 tokens/)).toBeTruthy();
    const updated = structuredClone(usage);
    updated.attemptCount = 2;
    updated.tokens.total.known = 125;
    backendEvent?.({ type: "run-progress", runId: "run-alpha", threadId: "alpha", message: "Model call completed", codexCalls: 2, searches: 1, usage: updated });
    expect(await view.findByText(/125 tokens/)).toBeTruthy();
    expect(view.getByText(/2 attempts/)).toBeTruthy();
    expect(getWorkspace).toHaveBeenCalledTimes(1);
  });

  test("refreshes sidebar state when an inactive thread finishes", async () => {
    const running = workspace("alpha");
    running.threads[1]!.status = "development-running";
    const completed = structuredClone(running);
    completed.threads[1]!.status = "solutions-ready";
    let backendEvent: ((event: ResearchEvent) => void) | undefined;
    const getWorkspace = vi.fn()
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(completed);
    installApi({
      getWorkspace,
      onBackendEvent(listener) { backendEvent = listener; return () => { backendEvent = undefined; }; },
    });
    const rerendered = render(App);
    expect((await rerendered.findAllByText("Developing")).length).toBeGreaterThan(0);
    backendEvent?.({ type: "run-completed", threadId: "beta", runId: "run-beta", problemId: "problem-1" });
    await waitFor(() => expect(rerendered.getAllByText("Solutions ready").length).toBeGreaterThan(0));
  });

  test("keeps completed options visible while another batch runs", async () => {
    const state = workspace("alpha");
    state.threads[0]!.status = "development-running";
    state.latestResearchRun = {
      runId: "run-alpha", status: "running", problemId: "problem-2", workflowVersion: 2,
      codexCalls: 1, searches: 0, projectedCodexCalls: 3, projectedSearches: 0,
      lastActivity: "Generating options",
    };
    state.solutions = [{
      id: "solution-1", problemId: "problem-1", problemStatement: "A problem", problemVerdict: "user-asserted",
      factors: [], mechanism: "Full synchronization mechanism", description: "Shared repair status",
      respectsOffLimits: true, respectsOffLimitsWhy: "Within scope", outcomes: [], risks: [],
      confirmedCoreOutcomes: 0, unaddressedCatastrophicRisks: 0, workflowVersion: 2,
    }];
    installApi({ getWorkspace: vi.fn().mockResolvedValue(state) });
    const view = render(App);

    expect(await view.findByText("Generating the next options.")).toBeTruthy();
    expect(view.getByRole("button", { name: "Open idea: Shared repair status" })).toBeTruthy();
  });

  test("keeps saved ideas separate from follow-up counts and records a keep-current decision", async () => {
    const state = workspace("alpha");
    state.threads[0]!.status = "solutions-ready";
    state.solutions = [{
      id: "solution-1", problemId: "problem-1", problemStatement: "A problem", problemVerdict: "confirmed",
      factors: [], mechanism: "Share repair status", description: "A shared repair status for customers",
      respectsOffLimits: true, respectsOffLimitsWhy: "Within scope", outcomes: [], risks: [],
      confirmedCoreOutcomes: 1, unaddressedCatastrophicRisks: 0, workflowVersion: 2,
    }];
    state.activeWorkflow = {
      sessionId: "follow-up", threadId: "alpha", purpose: "research-followup", mode: "babysit",
      targetKind: "per-problem", state: "waiting-for-review", outcome: null, revision: 2,
      activeSnapshotId: "snapshot-1", selectedProblemIds: ["problem-1"],
      counts: { requested: 1, attempted: 0, validated: 0, accepted: 0, duplicate: 0,
        unresolved: 0, failed: 0, missing: 1, existing: 1, addedBySession: 0, total: 1 },
      limits: { maxMinutes: 10, maxModelCalls: 2, maxSearches: 0 },
      budget: { modelCalls: { limit: 2, spent: 1, reserved: 0, uncertain: 0 },
        searches: { limit: 0, spent: 0, reserved: 0, uncertain: 0 }, remainingMs: 0 },
      currentStage: null, stopReason: null,
      startedAt: "2026-09-23T12:00:00.000Z", finishedAt: null,
    };
    state.researchRequests = [{
      id: "request-1", kind: "redo", question: "Recheck buyer evidence", status: "completed",
      targetFindingId: "problem-1", resultFindings: [], previousFinding: {
        id: "problem-1", statement: "A problem", verdict: "confirmed", verdictReason: "Saved buyer evidence",
        evidenceGap: null, supportingSources: [], verdictSources: [],
      },
    }];
    const commandWorkflow = vi.fn(async (request: Parameters<ScraplyApi["commandWorkflow"]>[0]) => {
      if (request.action.type !== "keep-research") throw new Error("Unexpected workflow command");
      state.researchRequests[0] = { ...state.researchRequests[0]!, reviewDecision: "kept-current" };
      state.activeWorkflow = { ...state.activeWorkflow!, state: "finished", outcome: "partial", revision: 3,
        stopReason: "Current research was kept after reviewing the follow-up.",
        finishedAt: "2026-09-23T12:03:00.000Z" };
      return { sessionId: "follow-up", revision: 3, summary: state.activeWorkflow };
    });
    installApi({ getWorkspace: async () => structuredClone(state),
      getWorkflow: async () => ({ summary: state.activeWorkflow!, tasks: [], nextCursor: null }), commandWorkflow });
    const view = render(App);
    await fireEvent.click(await view.findByRole("tab", { name: "Solutions" }));
    expect(await view.findByRole("heading", { level: 1, name: "1 idea" })).toBeTruthy();
    expect(view.queryByText(/0 accepted toward the run target/)).toBeNull();
    await fireEvent.click(view.getByRole("tab", { name: "Research" }));
    await fireEvent.click(view.getByRole("button", { name: /Recheck buyer evidence/ }));
    expect(view.getByText("No finding met the evidence requirements. Current research remains unchanged.")).toBeTruthy();
    await fireEvent.click(view.getByRole("button", { name: "Keep current research" }));
    await waitFor(() => expect(commandWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "follow-up", expectedRevision: 2,
      action: { type: "keep-research", requestId: "request-1", baseSnapshotId: "snapshot-1" },
    })));
    expect((await view.findAllByText("Current research was kept after reviewing the follow-up.")).length).toBeGreaterThan(0);
    await fireEvent.click(view.getByRole("button", { name: /Recheck buyer evidence/ }));
    expect(view.getAllByText("Kept current research").length).toBeGreaterThan(0);
    expect(view.queryByRole("button", { name: "Keep current research" })).toBeNull();
  });

  test("exports a finished zero-idea result and a stopped research record", async () => {
    const state = workspace("alpha");
    state.threads[0]!.status = "solutions-ready";
    state.activeWorkflow = {
      sessionId: "session-zero", threadId: "alpha", purpose: "discovery", mode: "vibe", targetKind: "per-problem",
      state: "finished", outcome: "no-qualifying-ideas", revision: 2, activeSnapshotId: null, selectedProblemIds: [],
      counts: { requested: 3, attempted: 0, validated: 0, accepted: 0, duplicate: 0, unresolved: 0,
        failed: 0, missing: 3, existing: 0, addedBySession: 0, total: 0 },
      limits: { maxMinutes: 30, maxModelCalls: 10, maxSearches: 4 },
      budget: { modelCalls: { limit: 10, spent: 2, reserved: 0, uncertain: 0 },
        searches: { limit: 4, spent: 1, reserved: 0, uncertain: 0 }, remainingMs: 0 },
      currentStage: null, stopReason: "No buyer evidence supported generation.",
      startedAt: "2026-09-23T00:00:00.000Z", finishedAt: "2026-09-23T00:04:00.000Z",
    };
    state.latestResearchRun = { runId: "run-zero", status: "completed", problemId: null, workflowVersion: 2,
      codexCalls: 2, searches: 1, projectedCodexCalls: 10, projectedSearches: 4,
      lastActivity: "Completed" };
    const exportIdeas = vi.fn(async () => ({ cancelled: true as const, files: [] }));
    const exportResearch = vi.fn(async () => ({ cancelled: true as const }));
    installApi({ getWorkspace: async () => structuredClone(state),
      getWorkflow: async () => ({ summary: state.activeWorkflow!, tasks: [], nextCursor: null }),
      exportIdeas, exportResearch });
    const view = render(App);
    await view.findByText("No buyer evidence supported generation.");
    await fireEvent.click(view.getByRole("button", { name: "Export ideas" }));
    await waitFor(() => expect(exportIdeas).toHaveBeenCalledWith("alpha", "markdown"));
    await fireEvent.click(view.getByRole("tab", { name: "Research" }));
    await fireEvent.click(view.getByRole("button", { name: "Export research JSON" }));
    await waitFor(() => expect(exportResearch).toHaveBeenCalledWith("alpha"));
  });

  test("anchors elapsed time when switching to a run after browsing another thread", async () => {
    let now = 1_000;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const alpha = workspace("alpha");
      const beta = workspace("beta");
      beta.threads[1]!.status = "development-running";
      beta.latestResearchRun = {
        runId: "run-beta", status: "running", problemId: "problem-1", workflowVersion: 2,
        codexCalls: 1, searches: 0, projectedCodexCalls: 3, projectedSearches: 0,
        lastActivity: "Generating options", stage: "generating-options", modelState: "accepted",
        elapsedMs: 270_000, operationStartedAt: "2026-09-14T00:00:00.000Z", operationElapsedMs: 30_000,
        lastSuccessfulCheckpoint: "Problem saved",
      };
      installApi({ getWorkspace: vi.fn().mockResolvedValue(alpha), selectThread: vi.fn().mockResolvedValue(beta) });
      const view = render(App);
      const betaButton = await view.findByRole("button", { name: "Open thread Beta" });
      now += 240_000;
      await fireEvent.click(betaButton);

      expect(await view.findByText("30s elapsed")).toBeTruthy();
      expect(view.queryByText("Total run: 4m 30s")).toBeNull();
    } finally {
      dateNow.mockRestore();
    }
  });

  test.each(["discovery-running", "development-running"] as const)("allows cancellation but does not offer resume during %s", async (status) => {
    const state = workspace("alpha");
    state.threads[0]!.status = status;
    state.latestResearchRun = {
      runId: "run-alpha", status: "running", problemId: status === "development-running" ? "problem-1" : null,
      codexCalls: 1, searches: 0, projectedCodexCalls: 2, projectedSearches: 0,
      lastActivity: "Generating options", canResume: true,
    };
    installApi({ getWorkspace: vi.fn().mockResolvedValue(state) });
    const view = render(App);
    expect(await view.findByRole("button", { name: "Cancel run" })).toBeTruthy();
    expect(view.queryByRole("button", { name: "Resume attempt" })).toBeNull();
  });

  test("shows the saved failure reason instead of the last progress message after reopening", async () => {
    const state = workspace("alpha");
    state.threads[0]!.status = "failed";
    state.latestResearchRun = {
      runId: "run-alpha", status: "failed", problemId: null,
      codexCalls: 2, searches: 3, projectedCodexCalls: 11, projectedSearches: 10,
      lastActivity: "Search: study planning", completionReason: "Evidence identifiers exceeded the runtime limit.",
      canResume: true,
    };
    installApi({ getWorkspace: vi.fn().mockResolvedValue(state) });
    const view = render(App);
    expect(await view.findByText("Evidence identifiers exceeded the runtime limit.")).toBeTruthy();
    expect(view.getByRole("button", { name: "Resume attempt" })).toBeTruthy();
  });

  test("ignores a stale reconciliation response after thread selection", async () => {
    const staleLoad = deferred<WorkspaceState>();
    let backendEvent: ((event: ResearchEvent) => void) | undefined;
    const alpha = workspace("alpha");
    const beta = workspace("beta");
    const getWorkspace = vi.fn()
      .mockResolvedValueOnce(alpha)
      .mockReturnValueOnce(staleLoad.promise);
    const selectThread = vi.fn().mockResolvedValue(beta);
    installApi({
      getWorkspace,
      selectThread,
      onBackendEvent(listener) {
        backendEvent = listener;
        return () => { backendEvent = undefined; };
      },
    });
    const view = render(App);
    const betaButton = await view.findByRole("button", { name: "Open thread Beta" });

    backendEvent?.({
      type: "run-progress",
      runId: "run-alpha",
      threadId: "alpha",
      message: "Progress",
      codexCalls: 1,
      searches: 1,
    });
    await waitFor(() => expect(getWorkspace).toHaveBeenCalledTimes(2), { timeout: 1_000 });
    await fireEvent.click(betaButton);
    await waitFor(() => expect(betaButton.getAttribute("aria-current")).toBe("true"));

    staleLoad.resolve(alpha);
    await tick();
    await waitFor(() => expect(betaButton.getAttribute("aria-current")).toBe("true"));
  });

  test("blocks overlapping thread mutations while a selection is pending", async () => {
    const selection = deferred<WorkspaceState>();
    const selectThread = vi.fn().mockReturnValue(selection.promise);
    installApi({ getWorkspace: vi.fn().mockResolvedValue(workspace("alpha")), selectThread });
    const view = render(App);
    const alphaButton = await view.findByRole("button", { name: "Open thread Alpha" }) as HTMLButtonElement;
    const betaButton = view.getByRole("button", { name: "Open thread Beta" }) as HTMLButtonElement;

    await fireEvent.click(betaButton);
    expect(selectThread).toHaveBeenCalledTimes(1);
    expect(alphaButton.disabled).toBe(true);
    expect(betaButton.disabled).toBe(true);
    await fireEvent.click(alphaButton);
    expect(selectThread).toHaveBeenCalledTimes(1);

    selection.resolve(workspace("beta"));
    await waitFor(() => expect(betaButton.getAttribute("aria-current")).toBe("true"));
  });

  test("routes an all-rejected discovery result to the research checkpoint", async () => {
    const state = workspace("alpha");
    state.threads[0]!.status = "problems-ready";
    state.rejectedProblemCandidates = [{
      id: "rejected-1",
      statement: "Independent shops cannot compare supplier reliability.",
      reason: "The candidate cited factors from only one source hostname.",
    }];
    installApi({ getWorkspace: vi.fn().mockResolvedValue(state) });
    const view = render(App);

    expect(await view.findByText("Choose problems to develop")).toBeTruthy();
    expect(view.getByRole("button", { name: /^Show \d+ more leads?$/ })).toBeTruthy();
    expect(view.getByText("No problems yet")).toBeTruthy();
  });

  test("cancels an in-flight device-code poll from the setup UI", async () => {
    const state = workspace("alpha");
    state.validation.native = { available: true, connected: false, version: "0.1.0", accounts: [] };
    const neverCompletes = new Promise<never>(() => undefined);
    const cancelNativeLogin = vi.fn().mockResolvedValue(state);
    installApi({
      getWorkspace: vi.fn().mockResolvedValue(state),
      startNativeLogin: vi.fn().mockResolvedValue({
        loginId: "login-device",
        providerId: "openai-subscription",
        method: "device" as const,
        verificationUrl: "https://example.test/device",
        userCode: "ABCD-1234",
      }),
      completeNativeLogin: vi.fn().mockReturnValue(neverCompletes),
      cancelNativeLogin,
    });
    const view = render(App);
    await fireEvent.click(await view.findByRole("button", { name: "Settings" }));
    await fireEvent.click(await view.findByRole("button", { name: "Use device code" }));
    expect(await view.findByText("ABCD-1234")).toBeTruthy();

    await fireEvent.click(view.getByRole("button", { name: "Cancel sign-in" }));
    await waitFor(() => expect(cancelNativeLogin).toHaveBeenCalledWith({
      loginId: "login-device",
      providerId: "openai-subscription",
    }));
    expect(await view.findByText("Native account sign-in cancelled.")).toBeTruthy();
  });

  test("replaces a rejected native session through sign-in and restores usable models", async () => {
    const rejected = workspace("alpha");
    rejected.models = [];
    rejected.modelOptions = [];
    rejected.validation.native = {
      available: true,
      connected: false,
      version: "0.2.0",
      accounts: [{ providerId: "openai-subscription", email: "dany@example.test" }],
      error: "provider request failed with HTTP 401",
    };
    const connected = workspace("alpha");
    connected.validation.native = {
      available: true,
      connected: true,
      version: "0.2.0",
      accounts: [{ providerId: "openai-subscription", email: "dany@example.test" }],
    };
    const startNativeLogin = vi.fn().mockResolvedValue({
      loginId: "login-replacement",
      providerId: "openai-subscription",
      method: "browser" as const,
    });
    installApi({
      getWorkspace: vi.fn().mockResolvedValue(rejected),
      startNativeLogin,
      completeNativeLogin: vi.fn().mockResolvedValue({ pending: false as const, workspace: connected }),
    });
    const view = render(App);
    await fireEvent.click(await view.findByRole("button", { name: "Settings" }));

    expect(await within(view.getByRole("region", { name: "Settings" })).findByText("provider request failed with HTTP 401")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Try again" })).toBeNull();
    await fireEvent.click(view.getByRole("button", { name: "Sign in with OpenAI" }));

    expect(startNativeLogin).toHaveBeenCalledWith({ providerId: "openai-subscription", method: "browser" });
    expect(await view.findByText("Native model account connected.")).toBeTruthy();
    expect(view.queryByText("provider request failed with HTTP 401")).toBeNull();
    expect(within(view.getByLabelText("Model", { exact: true })).getByRole("option", { name: "GPT-6 Sol", hidden: true })).toBeTruthy();
  });

  test("shows discovered models as soon as browser sign-in completes", async () => {
    const disconnected = workspace("alpha");
    disconnected.models = [];
    disconnected.modelOptions = [];
    disconnected.validation.native = { available: true, connected: false, accounts: [] };
    const connected = workspace("alpha");
    connected.validation.native = {
      available: true, connected: true,
      accounts: [{ providerId: "openai-subscription", email: "dany@example.test" }],
    };
    installApi({
      getWorkspace: vi.fn().mockResolvedValue(disconnected),
      startNativeLogin: vi.fn().mockResolvedValue({
        loginId: "login-browser", providerId: "openai-subscription", method: "browser" as const,
      }),
      completeNativeLogin: vi.fn().mockResolvedValue({ pending: false as const, workspace: connected }),
    });
    const view = render(App);
    await fireEvent.click(await view.findByRole("button", { name: "Settings" }));

    await fireEvent.click(await view.findByRole("button", { name: "Sign in with OpenAI" }));
    expect(await view.findByText("Native model account connected.")).toBeTruthy();
    expect(within(view.getByLabelText("Model", { exact: true })).getByRole("option", { name: "GPT-6 Sol", hidden: true })).toBeTruthy();
    // The connected account is listed, with its email hidden until the user reveals it.
    expect(within(view.getByLabelText("OpenAI account")).getByRole("button", { name: "Show account email" })).toBeTruthy();
    expect(view.queryByText("dany@example.test")).toBeNull();
  });

  test("shows confirmations as a corner toast that clears itself, while errors stay in place", async () => {
    const signedOut = workspace("alpha");
    signedOut.validation.native = { available: true, connected: false, accounts: [] };
    const connected = workspace("alpha");
    connected.validation.native = { available: true, connected: true, accounts: [{ providerId: "openai-subscription" }] };
    const logoutNativeAccount = vi.fn().mockRejectedValue(new Error("Sign-out failed"));
    installApi({
      getWorkspace: vi.fn().mockResolvedValue(signedOut),
      startNativeLogin: vi.fn().mockResolvedValue({ loginId: "login-toast", providerId: "openai-subscription", method: "browser" as const }),
      completeNativeLogin: vi.fn().mockResolvedValue({ pending: false as const, workspace: connected }),
      logoutNativeAccount,
    });
    const view = render(App);
    await fireEvent.click(await view.findByRole("button", { name: "Settings" }));
    await fireEvent.click(await view.findByRole("button", { name: "Sign in with OpenAI" }));

    const toast = await view.findByText("Native model account connected.");
    expect(toast.closest(".toasts")).not.toBeNull();
    expect(within(view.getByRole("region", { name: "Settings" })).queryByText("Native model account connected.")).toBeNull();
    await waitFor(() => expect(view.queryByText("Native model account connected.")).toBeNull(), { timeout: 4_000 });

    await fireEvent.click(view.getByRole("button", { name: "Sign out" }));
    const error = await within(view.getByRole("region", { name: "Settings" })).findByText("Sign-out failed");
    expect(error.closest(".toasts")).toBeNull();
  });

  test("keeps sign-in instructions visible while the account callback is pending", async () => {
    const signedOut = workspace("alpha");
    signedOut.validation.native = { available: true, connected: false, accounts: [] };
    installApi({
      getWorkspace: vi.fn().mockResolvedValue(signedOut),
      startNativeLogin: vi.fn().mockResolvedValue({ loginId: "login-pending", providerId: "openai-subscription", method: "browser" as const }),
      completeNativeLogin: vi.fn(() => new Promise<Awaited<ReturnType<ScraplyApi["completeNativeLogin"]>>>(() => undefined)),
    });
    const view = render(App);
    await fireEvent.click(await view.findByRole("button", { name: "Settings" }));
    await fireEvent.click(await view.findByRole("button", { name: "Sign in with OpenAI" }));
    const instructions = "Finish signing in in your browser. Scraply is waiting for the account callback.";
    expect(await within(view.getByRole("region", { name: "Settings" })).findByText(instructions)).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 3_200));
    expect(within(view.getByRole("region", { name: "Settings" })).getByText(instructions)).toBeTruthy();
    expect(view.container.querySelector(".toasts")?.textContent).toBe("");
  }, 10_000);

  test("starts the toast countdown after the welcome prompt closes", async () => {
    const noSearch = (state: WorkspaceState) => {
      state.validation.exa = { valid: false, error: "Exa key missing" };
      state.validation.perplexity = { valid: false, error: "Perplexity key missing" };
      return state;
    };
    const signedOut = noSearch(workspace("alpha"));
    signedOut.validation.native = { available: true, connected: false, accounts: [] };
    const connected = noSearch(workspace("alpha"));
    connected.validation.native = { available: true, connected: true, accounts: [{ providerId: "openai-subscription" }] };
    installApi({
      getWorkspace: vi.fn().mockResolvedValue(signedOut),
      startNativeLogin: vi.fn().mockResolvedValue({ loginId: "login-welcome-toast", providerId: "openai-subscription", method: "browser" as const }),
      completeNativeLogin: vi.fn().mockResolvedValue({ pending: false as const, workspace: connected }),
    });
    const view = render(App);
    await fireEvent.click(within(await view.findByRole("dialog", { name: "Welcome to Scraply" })).getByRole("button", { name: "Sign in with OpenAI" }));
    const prompt = await view.findByRole("dialog", { name: "Add web search" });
    await new Promise((resolve) => setTimeout(resolve, 3_200));
    expect(view.container.querySelector(".toasts")?.textContent).toBe("");
    await fireEvent.click(within(prompt).getByRole("button", { name: "Not now" }));
    const toast = await view.findByText("Native model account connected.");
    expect(toast.closest(".toasts")).not.toBeNull();
    await waitFor(() => expect(view.queryByText("Native model account connected.")).toBeNull(), { timeout: 4_000 });
  }, 12_000);

  test("welcomes a first-time user and signs in from the prompt", async () => {
    // An empty profile: the app creates a first draft thread on load.
    const empty = workspace("alpha");
    empty.threads = [];
    empty.activeThreadId = null;
    empty.validation.native = { available: true, connected: false, accounts: [] };
    const draft = workspace("alpha");
    draft.threads = draft.threads.slice(0, 1);
    draft.validation.native = { available: true, connected: false, accounts: [] };
    const connected = workspace("alpha");
    connected.validation.native = { available: true, connected: true, accounts: [{ providerId: "openai-subscription" }] };
    const startNativeLogin = vi.fn().mockResolvedValue({ loginId: "login-welcome", providerId: "openai-subscription", method: "browser" as const });
    installApi({
      getWorkspace: vi.fn().mockResolvedValue(empty),
      createThread: async () => ({ workspace: draft }),
      startNativeLogin,
      completeNativeLogin: vi.fn().mockResolvedValue({ pending: false as const, workspace: connected }),
    });
    const view = render(App);

    const welcome = await view.findByRole("dialog", { name: "Welcome to Scraply" });
    await fireEvent.click(within(welcome).getByRole("button", { name: "Sign in with OpenAI" }));
    expect(startNativeLogin).toHaveBeenCalledWith({ providerId: "openai-subscription", method: "browser" });
    await waitFor(() => expect(view.queryByRole("dialog", { name: "Welcome to Scraply" })).toBeNull());
  });

  test("continues from sign-in to web search keys and stays open until every entered key is saved", async () => {
    const noSearch = (state: WorkspaceState) => {
      state.validation.exa = { valid: false, error: "Exa key missing" };
      state.validation.perplexity = { valid: false, error: "Perplexity key missing" };
      return state;
    };
    const signedOut = noSearch(workspace("alpha"));
    signedOut.validation.native = { available: true, connected: false, accounts: [] };
    const connected = noSearch(workspace("alpha"));
    connected.validation.native = { available: true, connected: true, accounts: [{ providerId: "openai-subscription" }] };
    const withExa = structuredClone(connected);
    withExa.validation.exa = { valid: true, maskedKey: "••••3f9a" };
    const withBoth = structuredClone(withExa);
    withBoth.validation.perplexity = { valid: true, maskedKey: "••••77c1" };
    const saveSearchKey = vi.fn(async ({ provider, apiKey }: { provider: "exa" | "perplexity"; apiKey: string }) => {
      if (provider === "exa") return withExa;
      if (apiKey === "pplx-rejected") throw new Error("Perplexity API key was rejected");
      return withBoth;
    });
    installApi({
      getWorkspace: vi.fn().mockResolvedValue(signedOut),
      startNativeLogin: vi.fn().mockResolvedValue({ loginId: "login-welcome", providerId: "openai-subscription", method: "browser" as const }),
      completeNativeLogin: vi.fn().mockResolvedValue({ pending: false as const, workspace: connected }),
      saveSearchKey,
    });
    const view = render(App);

    await fireEvent.click(within(await view.findByRole("dialog", { name: "Welcome to Scraply" })).getByRole("button", { name: "Sign in with OpenAI" }));
    const prompt = await view.findByRole("dialog", { name: "Add web search" });
    expect(within(prompt).getByText("OpenAI connected")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(within(prompt).getByLabelText("Exa API key")));

    await fireEvent.input(within(prompt).getByLabelText("Exa API key"), { target: { value: "fake-exa-key" } });
    await fireEvent.input(within(prompt).getByLabelText("Perplexity API key"), { target: { value: "pplx-rejected" } });
    await fireEvent.click(within(prompt).getByRole("button", { name: "Save and continue" }));

    // Exa is saved and connected, yet the prompt stays so the Perplexity rejection can be read and fixed.
    expect(await within(prompt).findByRole("alert")).toHaveProperty("textContent", "Perplexity API key was rejected");
    expect(saveSearchKey.mock.calls.map(([call]) => call)).toEqual([
      { provider: "exa", apiKey: "fake-exa-key" }, { provider: "perplexity", apiKey: "pplx-rejected" },
    ]);
    expect(within(prompt).getByText("Saved")).toBeTruthy();
    expect(within(prompt).queryByLabelText("Exa API key")).toBeNull();
    expect(within(prompt).getByRole("button", { name: "Done" })).toBeTruthy();
    expect(document.activeElement).toBe(within(prompt).getByLabelText("Perplexity API key"));

    await fireEvent.input(within(prompt).getByLabelText("Perplexity API key"), { target: { value: "fake-pplx-key" } });
    await fireEvent.click(within(prompt).getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(view.queryByRole("dialog", { name: "Add web search" })).toBeNull());
    expect(saveSearchKey).toHaveBeenLastCalledWith({ provider: "perplexity", apiKey: "fake-pplx-key" });
  });

  test("asks a signed-in user without a search key to add one, but not one whose saved key is failing", async () => {
    const noKey = workspace("alpha");
    noKey.validation.native = { available: true, connected: true, accounts: [{ providerId: "openai-subscription" }] };
    noKey.validation.exa = { valid: false, error: "Exa key missing" };
    installApi({ getWorkspace: vi.fn().mockResolvedValue(noKey) });
    const view = render(App);
    const prompt = await view.findByRole("dialog", { name: "Add web search" });
    expect((within(prompt).getByRole("button", { name: "Save and continue" }) as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.click(within(prompt).getByRole("button", { name: "Not now" }));
    expect(view.queryByRole("dialog", { name: "Add web search" })).toBeNull();
    view.unmount();

    // A saved key that is currently rejected is fixed from Settings or setup, not by the first-run prompt.
    const failing = structuredClone(noKey);
    failing.validation.exa = { valid: false, error: "Exa API key was rejected", maskedKey: "••••3f9a" };
    installApi({ getWorkspace: vi.fn().mockResolvedValue(failing) });
    const next = render(App);
    await next.findByRole("button", { name: "Settings" });
    await tick();
    expect(next.queryByRole("dialog", { name: "Add web search" })).toBeNull();
  });

  test("Escape dismisses the welcome prompt and cancels an active sign-in", async () => {
    const signedOut = workspace("alpha");
    signedOut.validation.native = { available: true, connected: false, accounts: [] };
    const login = { loginId: "login-welcome", providerId: "openai-subscription", method: "browser" as const };
    const pending = deferred<{ pending: true }>();
    const cancelNativeLogin = vi.fn().mockResolvedValue(signedOut);
    installApi({
      getWorkspace: vi.fn().mockResolvedValue(signedOut),
      startNativeLogin: vi.fn().mockResolvedValue(login),
      completeNativeLogin: vi.fn().mockReturnValue(pending.promise),
      cancelNativeLogin,
    });
    const view = render(App);
    const welcome = await view.findByRole("dialog", { name: "Welcome to Scraply" });
    await fireEvent.click(within(welcome).getByRole("button", { name: "Sign in with OpenAI" }));
    await within(welcome).findByText("Finish signing in in your browser");
    await fireEvent(welcome, new Event("cancel", { cancelable: true }));

    await waitFor(() => expect(cancelNativeLogin).toHaveBeenCalledWith({ loginId: login.loginId, providerId: login.providerId }));
    await waitFor(() => expect(view.queryByRole("dialog", { name: "Welcome to Scraply" })).toBeNull());
    pending.resolve({ pending: true });
  });

  test("asks a returning user to sign in again after signing out, until they choose not now", async () => {
    const connected = workspace("alpha");
    connected.validation.native = { available: true, connected: true, accounts: [{ providerId: "openai-subscription", email: "dany@example.test" }] };
    const signedOut = workspace("alpha");
    signedOut.threads[0]!.status = "problems-ready";
    signedOut.validation.native = { available: true, connected: false, accounts: [] };
    installApi({ getWorkspace: vi.fn().mockResolvedValue(connected), logoutNativeAccount: vi.fn().mockResolvedValue(signedOut) });
    const view = render(App);
    await fireEvent.click(await view.findByRole("button", { name: "Settings" }));
    expect(view.queryByRole("dialog", { name: "Welcome back" })).toBeNull();

    await fireEvent.click(await view.findByRole("button", { name: "Sign out" }));
    // The prompt waits for Settings to close rather than stacking on top of it.
    await waitFor(() => expect(view.getByText("Connect OpenAI to start research")).toBeTruthy());
    expect(view.queryByRole("dialog", { name: "Welcome back" })).toBeNull();
    await fireEvent.click(view.getByRole("button", { name: "Back" }));

    const welcome = await view.findByRole("dialog", { name: "Welcome back" });
    await fireEvent.click(within(welcome).getByRole("button", { name: "Not now" }));
    expect(view.queryByRole("dialog", { name: "Welcome back" })).toBeNull();
  });

  test("reconciles model discovery that is still pending when sign-in finishes", async () => {
    const disconnected = workspace("alpha");
    disconnected.models = [];
    disconnected.modelOptions = [];
    disconnected.validation.native = { available: true, connected: false, accounts: [] };
    const checking = workspace("alpha");
    checking.models = [];
    checking.modelOptions = [];
    checking.validation.native = {
      available: true,
      connected: true,
      accounts: [{ providerId: "openai-subscription", email: "dany@example.test" }],
      error: "Checking available OpenAI models",
    };
    const connected = workspace("alpha");
    connected.validation.native = {
      available: true,
      connected: true,
      accounts: [{ providerId: "openai-subscription", email: "dany@example.test" }],
    };
    installApi({
      getWorkspace: vi.fn().mockResolvedValueOnce(disconnected).mockResolvedValue(connected),
      startNativeLogin: vi.fn().mockResolvedValue({
        loginId: "login-checking", providerId: "openai-subscription", method: "browser" as const,
      }),
      completeNativeLogin: vi.fn().mockResolvedValue({ pending: false as const, workspace: checking }),
    });
    const view = render(App);
    await fireEvent.click(await view.findByRole("button", { name: "Settings" }));

    await fireEvent.click(await view.findByRole("button", { name: "Sign in with OpenAI" }));

    expect(await view.findByText("OpenAI sign-in finished.")).toBeTruthy();
    expect(await within(view.getByLabelText("Model", { exact: true })).findByRole("option", { name: "GPT-6 Sol", hidden: true }, { timeout: 1_500 })).toBeTruthy();
    expect(view.queryByText("Checking available OpenAI models")).toBeNull();
  });

  test("shows a sign-in error and leaves the connection action available", async () => {
    const state = workspace("alpha");
    state.models = [];
    state.modelOptions = [];
    state.validation.native = { available: true, connected: false, accounts: [] };
    installApi({
      getWorkspace: vi.fn().mockResolvedValue(state),
      startNativeLogin: vi.fn().mockRejectedValue(new Error("Browser sign-in could not start")),
    });
    const view = render(App);
    await fireEvent.click(await view.findByRole("button", { name: "Settings" }));

    await fireEvent.click(await view.findByRole("button", { name: "Sign in with OpenAI" }));
    expect((await view.findByRole("alert")).textContent).toContain("Browser sign-in could not start");
    expect((view.getByRole("button", { name: "Sign in with OpenAI" }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("does not report a connected account when post-login validation is rejected", async () => {
    const disconnected = workspace("alpha");
    disconnected.models = [];
    disconnected.modelOptions = [];
    disconnected.validation.native = { available: true, connected: false, accounts: [] };
    const rejected = workspace("alpha");
    rejected.models = [];
    rejected.modelOptions = [];
    rejected.validation.native = {
      available: true,
      connected: false,
      accounts: [],
      error: "provider request failed with HTTP 401",
    };
    installApi({
      getWorkspace: vi.fn().mockResolvedValue(disconnected),
      startNativeLogin: vi.fn().mockResolvedValue({
        loginId: "login-rejected", providerId: "openai-subscription", method: "browser" as const,
      }),
      completeNativeLogin: vi.fn().mockResolvedValue({ pending: false as const, workspace: rejected }),
    });
    const view = render(App);
    await fireEvent.click(await view.findByRole("button", { name: "Settings" }));

    await fireEvent.click(await view.findByRole("button", { name: "Sign in with OpenAI" }));

    expect((await view.findByRole("alert")).textContent).toContain("provider request failed with HTTP 401");
    expect(view.queryByText("Native model account connected.")).toBeNull();
    expect((view.getByRole("button", { name: "Sign in with OpenAI" }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("keeps reconciling a pending retry without resetting the setup draft", async () => {
    const unavailable = workspace("alpha");
    unavailable.validation.native = {
      available: false, connected: false, accounts: [], error: "OpenAI runtime could not start",
    };
    const checking = workspace("alpha");
    checking.validation.native = {
      available: false, connected: false, accounts: [], error: "Checking native runtime",
    };
    checking.validation.exa = { valid: false, error: "Checking Exa connection" };
    const ready = workspace("alpha");
    ready.validation.native = { available: true, connected: false, accounts: [] };
    const getWorkspace = vi.fn()
      .mockResolvedValueOnce(unavailable)
      .mockResolvedValueOnce(checking)
      .mockResolvedValueOnce(ready);
    installApi({ getWorkspace, retryConnection: vi.fn().mockResolvedValue(undefined) });
    const view = render(App);
    await fireEvent.click(await view.findByRole("button", { name: "Settings" }));

    const brief = await view.findByPlaceholderText("Your topic or idea") as HTMLTextAreaElement;
    await fireEvent.input(brief, { target: { value: "My unsaved research" } });
    await fireEvent.click(view.getByRole("button", { name: "Try again" }));

    expect(await view.findByText("Checking connections…")).toBeTruthy();
    expect((view.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(true);
    expect(await view.findByRole("button", { name: "Sign in with OpenAI" }, { timeout: 1_500 })).toBeTruthy();
    expect(getWorkspace).toHaveBeenCalledTimes(3);
    expect(brief.value).toBe("My unsaved research");
  });

  test("shows the saved reason and hides resume when completion is unknown", async () => {
    const state = workspace("alpha");
    state.threads[0]!.status = "failed";
    state.latestResearchRun = {
      runId: "run-alpha", status: "failed", problemId: null, workflowVersion: 2,
      codexCalls: 1, searches: 0, projectedCodexCalls: 2, projectedSearches: 0,
      lastActivity: "Request interrupted", canResume: false,
      resumeBlockedReason: "A previous model request may have completed before its terminal result was saved.",
    };
    installApi({ getWorkspace: vi.fn().mockResolvedValue(state) });
    const view = render(App);

    expect(await view.findByText("A previous model request may have completed before its terminal result was saved.")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Resume attempt" })).toBeNull();
    expect(view.getByRole("button", { name: "Edit setup" })).toBeTruthy();
  });
});

function frameWorkflow({ knownProblem = false, approved = false } = {}): WorkflowDetail {
  const draft = ResearchFrameSchema.parse({ goal: "Find a useful bookkeeping workflow.", goalKind: "market-opportunity", contextFacts: [],
    successCriteria: [{ id: "criterion", name: "Observed pain", weight: "must", howJudged: "Two independent firsthand accounts.", basis: "brief" }],
    constraints: [], languages: ["en"], areas: knownProblem ? [] : [{ id: "bank", name: "Bank matching", whyRelevant: "Repeated reconciliation work.", affectedPeople: "Solo bookkeepers", venues: [{ name: "Bookkeeping forums", kind: "community" }], exampleProblems: [], included: true, priority: 1 }],
    exclusions: [], openQuestions: [] });
  const now = "2026-09-23T00:00:00.000Z";
  const saved = { id: "frame-1", version: 1, knownProblem, draft, approved: approved ? structuredClone(draft) : null, sources: [], createdAt: now, approvedAt: approved ? now : null };
  return { summary: {
    sessionId: "frame-session", threadId: "alpha", purpose: knownProblem ? "known-problem" : "discovery", mode: "babysit", targetKind: "per-problem",
    state: approved ? "finished" : "waiting-for-review", outcome: approved ? "partial" : null, revision: 1, activeSnapshotId: null, selectedProblemIds: [], ideaTargetReady: false,
    ...(approved ? {} : { reviewKind: "frame" as const }), counts: { requested: 0, attempted: 0, validated: 0, accepted: 0, duplicate: 0, unresolved: 0, failed: 0, missing: 0, existing: 0, addedBySession: 0, total: 0 },
    limits: { enforced: false, maxMinutes: 90, maxModelCalls: 200, maxSearches: 200 }, budget: { modelCalls: { limit: 200, spent: 2, reserved: 0, uncertain: 0 }, searches: { limit: 200, spent: 0, reserved: 0, uncertain: 0 }, remainingMs: 90 * 60_000 },
    currentStage: "frame", stopReason: null, startedAt: now, finishedAt: approved ? now : null }, researchFrame: saved, ...(approved ? { latestResearchFrame: structuredClone(saved) } : {}), tasks: [], nextCursor: null };
}

function frameWorkspace(detail: WorkflowDetail): WorkspaceState {
  const state = workspace("alpha");
  state.activeWorkflow = detail.summary;
  state.scope = { title: "Bookkeeping", domain: "Bookkeeping workflows", audience: "", observations: "", offLimits: [] };
  state.runConfig = { ...DEFAULT_RUN_CONFIG, researchMode: detail.researchFrame?.knownProblem ? "known-problem" : "explore-market", knownProblem: detail.researchFrame?.knownProblem ? "Bookkeepers repeat reconciliation work." : "" };
  state.threads[0] = { ...state.threads[0]!, status: detail.summary.state === "finished" ? "problems-ready" : "discovery-running" };
  return state;
}

function workspace(activeThreadId: "alpha" | "beta"): WorkspaceState {
  const now = "2026-08-23T00:00:00.000Z";
  return {
    validation: { exa: { valid: true }, perplexity: { valid: false, error: "Perplexity key missing" }, native: { available: false, connected: false, accounts: [] }, setupComplete: true },
    threads: [
      { id: "alpha", title: "Alpha", status: "configuring", createdAt: now, updatedAt: now },
      { id: "beta", title: "Beta", status: "configuring", createdAt: now, updatedAt: now },
    ],
    activeThreadId,
    messages: [],
    scope: null,
    runConfig: DEFAULT_RUN_CONFIG,
    models: [DEFAULT_RUN_CONFIG.model],
    modelOptions: [{
      ...DEFAULT_RUN_CONFIG.model,
      displayName: DEFAULT_RUN_CONFIG.model.modelId,
      defaultReasoningEffort: "medium",
      reasoningEfforts: [{ id: "medium", description: "Balanced reasoning" }],
    }],
    modelCatalog: { models: [DEFAULT_RUN_CONFIG.model], favorites: [] },
    presets: [],
    problemCandidates: [],
    rejectedProblemCandidates: [],
    researchRequests: [],
    researchFindings: [],
    solutions: [],
    latestResearchRun: null,
    pendingRuns: [],
  };
}

function installApi(overrides: Partial<ScraplyApi>): void {
  const noWorkspace = async () => workspace("alpha");
  const api = {
    getValidation: async () => workspace("alpha").validation,
    retryConnection: async () => undefined,
    getWorkspace: noWorkspace,
    getAdvancedSettings: async () => ({ reasoningSummaries: true, maxConcurrentModelCalls: 1 }),
    saveAdvancedSettings: async (settings: { reasoningSummaries: boolean; maxConcurrentModelCalls: number }) => settings,
    openDataFolder: async () => undefined,
    openLogsFolder: async () => undefined,
    createThread: async () => ({ workspace: workspace("alpha") }),
    selectThread: noWorkspace,
    archiveThread: noWorkspace,
    discardIdea: noWorkspace,
    onAppCommand: () => () => undefined,
    generateTitle: vi.fn(async () => ({ title: "Generated research title" })),
    deleteThread: noWorkspace,
    saveScope: noWorkspace,
    saveRunConfig: noWorkspace,
    saveFavoriteModel: noWorkspace,
    startNativeLogin: async () => ({ loginId: "login-1", providerId: "openai-subscription", method: "browser" as const }),
    completeNativeLogin: async () => ({ pending: true as const }),
    cancelNativeLogin: noWorkspace,
    refreshNativeAccount: noWorkspace,
    logoutNativeAccount: noWorkspace,
    saveSearchKey: noWorkspace,
    removeSearchKey: noWorkspace,
    startResearch: async () => ({ workspace: workspace("alpha") }),
    previewWorkflow: async () => { throw new Error("unused"); },
    startWorkflow: async () => { throw new Error("unused"); },
    getWorkflow: async () => { throw new Error("unused"); },
    getRunTrace: async () => { throw new Error("unused"); },
    getRunTraceStep: async () => { throw new Error("unused"); },
    commandWorkflow: async () => { throw new Error("unused"); },
    getIdeaConversation: async () => { throw new Error("unused"); },
    submitIdeaTurn: async () => { throw new Error("unused"); },
    selectIdeaVersion: async () => { throw new Error("unused"); },
    cancelResearch: noWorkspace,
    resumeResearch: noWorkspace,
    selectProblems: noWorkspace,
    selectOption: noWorkspace,
    saveDecision: noWorkspace,
    requestEvidenceFollowUp: noWorkspace,
    requestEvidenceReassessment: noWorkspace,
    reviewSavedOpportunities: noWorkspace,
    editOpportunityMembership: noWorkspace,
    requestFocusedExperiment: noWorkspace,
    startOpportunityExploration: noWorkspace,
    pauseOpportunityExploration: noWorkspace,
    resumeOpportunityExploration: noWorkspace,
    applyOpportunityBudgetExtension: noWorkspace,
    previewOpportunityBudgetExtension: async () => { throw new Error("unused"); },
    exportResearch: async () => ({ cancelled: true as const }),
    exportIdeas: async () => ({ cancelled: true as const, files: [] }),
    getSourceDetail: async () => { throw new Error("unused"); },
    getIdeaDetail: async () => { throw new Error("unused"); },
    openExternalUrl: async () => undefined,
    onBackendEvent: () => () => undefined,
    ...overrides,
  } satisfies ScraplyApi;
  Object.defineProperty(window, "scraply", { configurable: true, value: api });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => { resolve = fulfill; });
  return { promise, resolve };
}
