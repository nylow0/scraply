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
});

function workspace(activeThreadId: "alpha" | "beta"): WorkspaceState {
  const now = "2026-08-23T00:00:00.000Z";
  return {
    validation: { exa: { valid: true }, perplexity: { valid: false, error: "Perplexity key missing" }, codex: { detected: true, compatible: true, authenticated: true }, native: { available: false, connected: false, accounts: [] }, setupComplete: true },
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
    refreshNativeAccount: noWorkspace,
    logoutNativeAccount: noWorkspace,
    startResearch: async () => ({ workspace: workspace("alpha") }),
    cancelResearch: noWorkspace,
    resumeResearch: noWorkspace,
    selectProblems: noWorkspace,
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
