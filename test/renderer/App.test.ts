import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { describe, expect, test, vi } from "vitest";
import type { ScraplyApi } from "../../src/preload/index";
import App from "../../src/renderer/App.svelte";
import type { ResearchEvent, WorkspaceState } from "../../src/shared/ipc";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";
import type { WorkflowSummary } from "../../src/shared/workflow-contracts";
import { summarizeRunUsage } from "../../src/backend/run-usage";

describe("App workspace coordination", () => {
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
    const launch = view.getByRole("button", { name: "Start Vibe" }) as HTMLButtonElement;
    await waitFor(() => expect(launch.disabled).toBe(false));
    await fireEvent.click(launch);
    await waitFor(() => expect(startWorkflow.mock.calls.length + Number(Boolean(view.queryByRole("alert")))).toBeGreaterThan(0));
    expect(view.queryByRole("alert")?.textContent).toBeFalsy();
    await waitFor(() => expect(startWorkflow).toHaveBeenCalledOnce());
    expect(startWorkflow.mock.calls[0]?.[0]).toMatchObject({ threadId: "alpha", contract: {
      mode: "vibe", brief: "Independent repair shops", targets: { automaticProblemCap: 3 },
    } });
    expect(await view.findByLabelText("Vibe run progress")).toBeTruthy();
    expect(view.getByText("Researching direct buyer evidence")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Add research" })).toBeNull();
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
    expect(view.getByRole("button", { name: "Shared repair status" })).toBeTruthy();
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
    expect(view.getByText("Failed evidence requirements")).toBeTruthy();
    expect(view.getByText("No candidates passed the evidence requirements.")).toBeTruthy();
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

    expect(await view.findByText("provider request failed with HTTP 401")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Try again" })).toBeNull();
    await fireEvent.click(view.getByRole("button", { name: "Sign in with OpenAI" }));

    expect(startNativeLogin).toHaveBeenCalledWith({ providerId: "openai-subscription", method: "browser" });
    expect(await view.findByText("Native model account connected.")).toBeTruthy();
    expect(view.queryByText("provider request failed with HTTP 401")).toBeNull();
    expect(view.getByRole("option", { name: "GPT-5.6 Sol" })).toBeTruthy();
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
    expect(view.getByRole("option", { name: "GPT-5.6 Sol" })).toBeTruthy();
    expect(view.getByText("dany@example.test")).toBeTruthy();
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
    expect(await view.findByRole("option", { name: "GPT-5.6 Sol" }, { timeout: 1_500 })).toBeTruthy();
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

    const title = await view.findByLabelText("Research name") as HTMLInputElement;
    await fireEvent.input(title, { target: { value: "My unsaved research" } });
    await fireEvent.click(view.getByRole("button", { name: "Try again" }));

    expect(await view.findByText("Checking connections")).toBeTruthy();
    expect((view.getByRole("button", { name: "Checking connections" }) as HTMLButtonElement).disabled).toBe(true);
    expect(await view.findByRole("button", { name: "Sign in with OpenAI" }, { timeout: 1_500 })).toBeTruthy();
    expect(getWorkspace).toHaveBeenCalledTimes(3);
    expect(title.value).toBe("My unsaved research");
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
    openDataFolder: async () => undefined,
    openLogsFolder: async () => undefined,
    createThread: async () => ({ workspace: workspace("alpha") }),
    selectThread: noWorkspace,
    archiveThread: noWorkspace,
    discardIdea: noWorkspace,
    showAppMenu: async () => undefined,
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
    startResearch: async () => ({ workspace: workspace("alpha") }),
    previewWorkflow: async () => { throw new Error("unused"); },
    startWorkflow: async () => { throw new Error("unused"); },
    getWorkflow: async () => { throw new Error("unused"); },
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
