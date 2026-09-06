import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { describe, expect, test, vi } from "vitest";
import ScopeForm from "../../src/renderer/components/ScopeForm.svelte";
import type { WorkspaceState } from "../../src/shared/ipc";
import { DEFAULT_RUN_CONFIG, RunConfigSchema, modelRefKey } from "../../src/shared/schemas";

describe("ScopeForm search provider selection", () => {
  test("offers only native OpenAI models and saves the selected model", async () => {
    const state = workspace();
    const nativeModel = { providerId: "openai-subscription", modelId: DEFAULT_RUN_CONFIG.model.modelId };
    state.validation.native = { available: true, connected: true, accounts: [{ providerId: nativeModel.providerId }] };
    state.runConfig = { ...DEFAULT_RUN_CONFIG, searchProvider: "perplexity" };
    const legacyModel = { providerId: "legacy-codex-cli", modelId: DEFAULT_RUN_CONFIG.model.modelId };
    state.models = [nativeModel, legacyModel];
    state.modelOptions = [
      { ...state.modelOptions[0]!, ...nativeModel, displayName: "Luna" },
      { ...state.modelOptions[0]!, ...legacyModel, displayName: "Luna legacy" },
    ];
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onStart = vi.fn().mockResolvedValue(undefined);
    const view = render(ScopeForm, { workspace: state, busy: false, onSave, onStart, onRetry: vi.fn() });
    expect(view.getByRole("option", { name: "Luna" })).toBeTruthy();
    expect(view.queryByRole("option", { name: "Luna legacy" })).toBeNull();
    const select = view.getByRole("combobox", { name: /Model/ }) as HTMLSelectElement;
    expect(select.value).toBe(modelRefKey(DEFAULT_RUN_CONFIG.model));
    await fireEvent.change(select, { target: { value: modelRefKey(nativeModel) } });
    await fireEvent.click(view.getByRole("button", { name: "Discover problems" }));
    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1));
    expect(RunConfigSchema.parse(onSave.mock.calls[0]?.[1]).model).toEqual(nativeModel);
  });

  test("warns for only the selected provider and saves a connected replacement", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onStart = vi.fn().mockResolvedValue(undefined);
    const view = render(ScopeForm, {
      workspace: workspace(),
      busy: false,
      onSave,
      onStart,
      onRetry: vi.fn().mockResolvedValue(undefined),
    });

    expect(view.getAllByText("Exa: Exa unavailable").length).toBeGreaterThan(0);
    expect(view.queryByText("Perplexity: Perplexity unavailable")).toBeNull();
    expect((view.getByRole("button", { name: "Discover problems" }) as HTMLButtonElement).disabled).toBe(true);

    await fireEvent.change(view.getByLabelText("Search provider"), { target: { value: "perplexity" } });
    await waitFor(() => expect(view.getByText("Perplexity: Connected")).toBeTruthy());
    const submit = view.getByRole("button", { name: "Discover problems" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    await fireEvent.click(submit);

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const submittedConfig = onSave.mock.calls[0]?.[1];
    expect(RunConfigSchema.parse(submittedConfig)).toMatchObject({
      configVersion: 2,
      searchProvider: "perplexity",
    });
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  test("offers main-owned native account setup and account maintenance", async () => {
    const disconnected = workspace();
    disconnected.validation.native = { available: true, connected: false, version: "0.1.0", accounts: [] };
    const connect = vi.fn().mockResolvedValue(undefined);
    const view = render(ScopeForm, {
      workspace: disconnected,
      busy: false,
      onSave: vi.fn(), onStart: vi.fn(), onRetry: vi.fn(),
      onConnectNative: connect,
    });

    await fireEvent.click(view.getByRole("button", { name: "Sign in with OpenAI" }));
    expect(connect).toHaveBeenCalledWith("openai-subscription", "browser");
    await fireEvent.click(view.getByRole("button", { name: "Use device code" }));
    expect(connect).toHaveBeenCalledWith("openai-subscription", "device");

    const connected = workspace();
    connected.validation.native = {
      available: true, connected: true, version: "0.1.0",
      accounts: [{ providerId: "openai-subscription", email: "dany@example.test", plan: "plus" }],
    };
    const refresh = vi.fn().mockResolvedValue(undefined);
    const logout = vi.fn().mockResolvedValue(undefined);
    const accountView = render(ScopeForm, {
      workspace: connected,
      busy: false,
      onSave: vi.fn(), onStart: vi.fn(), onRetry: vi.fn(),
      onRefreshNative: refresh, onLogoutNative: logout,
    });
    expect(accountView.getByText("dany@example.test · plus")).toBeTruthy();
    await fireEvent.click(accountView.getByRole("button", { name: "Refresh" }));
    await fireEvent.click(accountView.getByRole("button", { name: "Sign out" }));
    expect(refresh).toHaveBeenCalledWith("openai-subscription");
    expect(logout).toHaveBeenCalledWith("openai-subscription");
  });

  test("keeps sign-in recovery visible when the native runtime is unavailable", async () => {
    const state = workspace();
    state.validation.native = {
      available: false, connected: false, accounts: [], error: "OpenAI runtime could not start",
    };
    state.models = [];
    state.modelOptions = [];
    const retry = vi.fn().mockResolvedValue(undefined);
    const view = render(ScopeForm, {
      workspace: state, busy: false, onSave: vi.fn(), onStart: vi.fn(), onRetry: retry,
    });

    expect(view.getByLabelText("OpenAI account")).toBeTruthy();
    expect(view.getByText("OpenAI runtime could not start")).toBeTruthy();
    expect(view.getByRole("option", { name: "Connect OpenAI to choose a model" })).toBeTruthy();
    expect(view.queryByText(/Legacy Codex CLI/)).toBeNull();
    await fireEvent.click(view.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test("explains an empty model list after account connection", () => {
    const state = workspace();
    state.validation.native = {
      available: true, connected: true, accounts: [{ providerId: "openai-subscription", email: "dany@example.test" }],
    };
    state.models = [];
    state.modelOptions = [];
    const view = render(ScopeForm, {
      workspace: state, busy: false, onSave: vi.fn(), onStart: vi.fn(), onRetry: vi.fn(),
      onRefreshNative: vi.fn(), onLogoutNative: vi.fn(),
    });

    expect(view.getByText("Your available models appear here after you sign in.")).toBeTruthy();
    expect(view.getByText("No compatible models were found. Refresh the account to try again.")).toBeTruthy();
    expect((view.getByRole("combobox", { name: /Model/ }) as HTMLSelectElement).disabled).toBe(true);
  });

  test("requires an explicit model choice for a project saved with the removed CLI", async () => {
    const state = workspace();
    state.runConfig = {
      ...DEFAULT_RUN_CONFIG,
      model: { providerId: "legacy-codex-cli", modelId: "gpt-old" },
    };
    state.validation.exa = { valid: true };
    const onSave = vi.fn();
    const onStart = vi.fn();
    const view = render(ScopeForm, {
      workspace: state, busy: false, onSave, onStart, onRetry: vi.fn(),
    });

    const modelSelect = view.getByRole("combobox", { name: /Model/ }) as HTMLSelectElement;
    expect(modelSelect.value).toBe("");
    expect(view.getByRole("option", { name: "Choose an OpenAI model" })).toBeTruthy();
    expect(view.getByText("This project used the removed CLI integration. Choose a model and save to start a new run.")).toBeTruthy();
    expect((view.getByRole("button", { name: "Discover problems" }) as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.submit(view.container.querySelector("form")!);
    expect(onSave).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();

    await fireEvent.change(modelSelect, { target: { value: modelRefKey(DEFAULT_RUN_CONFIG.model) } });
    expect((view.getByRole("button", { name: "Discover problems" }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("shows device-code instructions and leaves cancellation enabled while setup is busy", async () => {
    const state = workspace();
    state.validation.native = { available: true, connected: false, version: "0.1.0", accounts: [] };
    const cancel = vi.fn().mockResolvedValue(undefined);
    const view = render(ScopeForm, {
      workspace: state,
      busy: true,
      nativeLogin: {
        loginId: "login-device",
        providerId: "openai-subscription",
        method: "device" as const,
        verificationUrl: "https://example.test/device",
        userCode: "ABCD-1234",
      },
      onSave: vi.fn(), onStart: vi.fn(), onRetry: vi.fn(), onCancelNative: cancel,
    });

    expect(view.getByText("ABCD-1234")).toBeTruthy();
    const button = view.getByRole("button", { name: "Cancel sign-in" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    await fireEvent.click(button);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

function workspace(): WorkspaceState {
  const now = "2026-08-28T00:00:00.000Z";
  return {
    validation: {
      exa: { valid: false, error: "Exa unavailable" },
      perplexity: { valid: true },
      native: { available: true, connected: true, accounts: [{ providerId: "openai-subscription" }] },
      setupComplete: true,
    },
    threads: [{ id: "thread-1", title: "Research", status: "configuring", createdAt: now, updatedAt: now }],
    activeThreadId: "thread-1",
    messages: [],
    scope: { title: "Repair shops", audience: "Shops", domain: "Parts sourcing", observations: "", offLimits: [] },
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
