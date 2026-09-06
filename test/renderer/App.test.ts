import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { describe, expect, test, vi } from "vitest";
import type { ScraplyApi } from "../../src/preload/index";
import App from "../../src/renderer/App.svelte";
import type { ResearchEvent, WorkspaceState } from "../../src/shared/ipc";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";

describe("App workspace coordination", () => {
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

    expect(await view.findByText("Which problems deserve development?")).toBeTruthy();
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
    await fireEvent.click(await view.findByRole("button", { name: "Use device code" }));
    expect(await view.findByText("ABCD-1234")).toBeTruthy();

    await fireEvent.click(view.getByRole("button", { name: "Cancel sign-in" }));
    await waitFor(() => expect(cancelNativeLogin).toHaveBeenCalledWith({
      loginId: "login-device",
      providerId: "openai-subscription",
    }));
    expect(await view.findByText("Native account sign-in cancelled.")).toBeTruthy();
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

    await fireEvent.click(await view.findByRole("button", { name: "Sign in with OpenAI" }));
    expect(await view.findByText("Native model account connected.")).toBeTruthy();
    expect(view.getByRole("option", { name: DEFAULT_RUN_CONFIG.model.modelId })).toBeTruthy();
    expect(view.getByText("dany@example.test")).toBeTruthy();
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

    await fireEvent.click(await view.findByRole("button", { name: "Sign in with OpenAI" }));
    expect((await view.findByRole("alert")).textContent).toContain("Browser sign-in could not start");
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

    const title = await view.findByLabelText("Research name") as HTMLInputElement;
    await fireEvent.input(title, { target: { value: "My unsaved research" } });
    await fireEvent.click(view.getByRole("button", { name: "Try again" }));

    expect(await view.findByText("Checking required connections")).toBeTruthy();
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
    cancelResearch: noWorkspace,
    resumeResearch: noWorkspace,
    selectProblems: noWorkspace,
    selectOption: noWorkspace,
    saveDecision: noWorkspace,
    requestEvidenceFollowUp: noWorkspace,
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
