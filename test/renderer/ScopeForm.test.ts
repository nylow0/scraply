import { fireEvent, render, waitFor } from "@testing-library/svelte";
import type { ComponentProps } from "svelte";
import { describe, expect, test, vi } from "vitest";
import Settings from "../../src/renderer/components/Settings.svelte";
import ScopeForm from "../../src/renderer/components/ScopeForm.svelte";
import type { WorkspaceState } from "../../src/shared/ipc";
import { DEFAULT_RUN_CONFIG, RunConfigSchema, modelRefKey } from "../../src/shared/schemas";
import type { WorkflowLaunchDraft } from "../../src/shared/workflow-contracts";

describe("ScopeForm search provider selection", () => {
  test("keeps context fields visible and preserves edits on launch", async () => {
    const state = workspace();
    state.validation.exa = { valid: true };
    state.scope = { ...state.scope!, observations: "Shared inbox", riskEvaluationCriteria: "One-week setup", offLimits: ["No hardware"] };
    const onSave = vi.fn().mockResolvedValue(undefined);
    const view = render(ScopeForm, { workspace: state, busy: false, onSave, onStart: vi.fn(), onRetry: vi.fn() });
    expect(view.getByLabelText("Risk priorities").closest("details")).toBeNull();
    expect(view.getByLabelText("Boundaries").closest("details")).toBeNull();
    await fireEvent.input(view.getByLabelText("Risk priorities"), { target: { value: "Two-week setup" } });
    await fireEvent.click(view.getByRole("button", { name: "Discover problems" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      observations: "Shared inbox", riskEvaluationCriteria: "Two-week setup", offLimits: ["No hardware"],
    }), expect.anything()));
  });

  test("keeps untouched brief fields calm and hides the problem cap for a stated problem", async () => {
    const state = workspace();
    state.scope = null;
    state.runConfig = null;
    state.validation.exa = { valid: true };
    const view = render(ScopeForm, {
      workspace: state, busy: false, onSave: vi.fn(), onStart: vi.fn(), onRetry: vi.fn(),
      onPreviewWorkflow: vi.fn(), onStartWorkflow: vi.fn(),
    });

    const startingContext = view.getByPlaceholderText("Your topic or idea");
    expect(startingContext.getAttribute("aria-invalid")).toBe("false");
    expect(view.queryByText("A starting context is required.", { selector: ".field-error" })).toBeNull();
    expect(view.queryByRole("radio", { name: /Startup opportunities/ })).toBeNull();
    await fireEvent.blur(startingContext);
    expect(startingContext.getAttribute("aria-invalid")).toBe("true");

    await fireEvent.click(view.getByRole("radio", { name: /I have a problem to solve/ }));
    await fireEvent.click(view.getByRole("radio", { name: /Vibe/ }));
    expect(view.getByPlaceholderText("Describe the problem.").getAttribute("aria-invalid")).toBe("false");
    expect(view.queryByLabelText("Automatic problem cap")).toBeNull();
    expect(view.getByText("Describe the problem to start.")).toBeTruthy();
  });

  test("defaults to Vibe first and invalidates its launch preview when limits change", async () => {
    const state = workspace();
    state.validation.exa = { valid: true };
    const onPreviewWorkflow = vi.fn(async (draft: WorkflowLaunchDraft) => ({
      type: "launch" as const,
      proposal: { ...draft,
        resolvedInstructions: { research: "research", ideas: "ideas", review: "review" },
        instructionHashes: { research: "r", ideas: "i", review: "v" },
      },
      previewHash: `preview-${draft.limits.maxModelCalls}`,
      capabilityFingerprint: "catalogue", minimumWork: { modelCalls: 36, searches: 16 },
      upperLimits: draft.limits,
      fieldErrors: draft.limits.maxModelCalls < 36
        ? [{ path: ["limits", "maxModelCalls"], code: "BUDGET_TOO_SMALL", message: "Allow at least 36 model calls." }]
        : [],
      expiresAt: "2099-01-01T00:00:00.000Z",
    }));
    const onStartWorkflow = vi.fn(async () => {});
    const onSave = vi.fn(async () => {});
    const onStart = vi.fn(async () => {});
    const view = render(ScopeForm, { workspace: state, busy: false, onSave, onStart,
      onPreviewWorkflow, onStartWorkflow, onRetry: vi.fn(async () => {}) });
    const defaultMode = view.getByRole("group", { name: "Run mode" }).querySelector<HTMLInputElement>('input[type="radio"]');
    expect(defaultMode?.value).toBe("vibe");
    expect(defaultMode?.checked).toBe(true);
    await waitFor(() => expect(onPreviewWorkflow).toHaveBeenCalled());
    const latestDraft = onPreviewWorkflow.mock.lastCall?.[0];
    expect(latestDraft).toMatchObject({ mode: "vibe", ideas: { model: DEFAULT_RUN_CONFIG.model }, targets: { automaticProblemCap: 3 } });
    expect(view.getByLabelText("Ideas model")).toBeTruthy();
    await waitFor(() => expect((view.getByRole("button", { name: "Start Vibe" }) as HTMLButtonElement).disabled).toBe(false));

    await fireEvent.input(view.getByLabelText("Maximum model calls"), { target: { value: "1" } });
    expect((view.getByRole("button", { name: "Start Vibe" }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(view.getByText("Allow at least 36 model calls.", { selector: ".launch-status span" })).toBeTruthy());
    await fireEvent.input(view.getByLabelText("Maximum model calls"), { target: { value: "44" } });
    await waitFor(() => expect((view.getByRole("button", { name: "Start Vibe" }) as HTMLButtonElement).disabled).toBe(false));
    await fireEvent.click(view.getByRole("button", { name: "Start Vibe" }));
    await waitFor(() => expect(onStartWorkflow).toHaveBeenCalledOnce());
    expect(onSave).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
  });

  test("sets one managed project allowance for research and opportunity work and rejects a short total", async () => {
    const state = workspace();
    state.validation.exa = { valid: true };
    const onPreviewWorkflow = vi.fn(async (draft: WorkflowLaunchDraft) => ({
      type: "launch" as const,
      proposal: { ...draft,
        resolvedInstructions: { research: "research", ideas: "ideas", review: "review" },
        instructionHashes: { research: "r", ideas: "i", review: "v" },
      },
      previewHash: `preview-${draft.limits.maxModelCalls}-${draft.limits.maxSearches}`,
      capabilityFingerprint: "catalogue", minimumWork: { modelCalls: 56, searches: 16 },
      upperLimits: draft.limits, fieldErrors: [], expiresAt: "2099-01-01T00:00:00.000Z",
    }));
    const onStartWorkflow = vi.fn().mockResolvedValue(undefined);
    const view = render(ScopeForm, {
      workspace: state, busy: false, onSave: vi.fn(), onStart: vi.fn(), onRetry: vi.fn(),
      onPreviewWorkflow, onStartWorkflow,
    });

    await fireEvent.click(view.getByRole("radio", { name: /Vibe/ }));
    await fireEvent.click(view.getByText("Distinct business target (optional)"));
    await fireEvent.click(view.getByRole("checkbox", { name: /Find distinct businesses across this project/ }));
    expect(view.queryByLabelText("Opportunity model-call limit")).toBeNull();
    expect(view.queryByLabelText("Opportunity search limit")).toBeNull();
    expect(view.getByText(/Work limits cover research, ideas, review, and added searches/)).toBeTruthy();
    expect((view.getByLabelText("Maximum model calls") as HTMLInputElement).value).toBe("56");
    expect((view.getByLabelText("Maximum searches") as HTMLInputElement).value).toBe("22");
    await waitFor(() => expect(onPreviewWorkflow.mock.lastCall?.[0]).toMatchObject({
      targets: { kind: "project", distinctBusinessCount: 30 },
      limits: { maxModelCalls: 56, maxSearches: 22 },
      runConfig: { opportunityExploration: { maxModelCalls: 24, maxSearches: 6 } },
    }));

    await fireEvent.input(view.getByLabelText("Maximum model calls"), { target: { value: "55" } });
    expect(view.getByText("Allow at least 56 model calls for projected research, generation, and review.", { selector: ".launch-status span" })).toBeTruthy();
    expect((view.getByRole("button", { name: "Start Vibe" }) as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.input(view.getByLabelText("Maximum model calls"), { target: { value: "56" } });
    await fireEvent.input(view.getByLabelText("Maximum searches"), { target: { value: "15" } });
    expect(view.getByText("Allow at least 16 searches for projected research.", { selector: ".launch-status span" })).toBeTruthy();
    expect((view.getByRole("button", { name: "Start Vibe" }) as HTMLButtonElement).disabled).toBe(true);

    await fireEvent.input(view.getByLabelText("Maximum searches"), { target: { value: "17" } });
    await waitFor(() => expect(onPreviewWorkflow.mock.lastCall?.[0]).toMatchObject({
      limits: { maxModelCalls: 56, maxSearches: 17 },
      runConfig: { opportunityExploration: { maxModelCalls: 24, maxSearches: 1 } },
    }));
    await waitFor(() => expect((view.getByRole("button", { name: "Start Vibe" }) as HTMLButtonElement).disabled).toBe(false));
    await fireEvent.click(view.getByRole("button", { name: "Start Vibe" }));
    expect(onStartWorkflow).toHaveBeenCalledOnce();
  });

  test("uses singular search wording in a valid one-search launch preview", async () => {
    const state = workspace();
    const onPreviewWorkflow = vi.fn(async (draft: WorkflowLaunchDraft) => ({
      type: "launch" as const,
      proposal: { ...draft,
        resolvedInstructions: { research: "research", ideas: "ideas", review: "review" },
        instructionHashes: { research: "r", ideas: "i", review: "v" },
      },
      previewHash: "one-search", capabilityFingerprint: "catalogue",
      minimumWork: { modelCalls: 4, searches: 1 }, upperLimits: draft.limits,
      fieldErrors: [], expiresAt: "2099-01-01T00:00:00.000Z",
    }));
    const view = render(ScopeForm, {
      workspace: state, busy: false, onSave: vi.fn(), onStart: vi.fn(), onRetry: vi.fn(),
      onPreviewWorkflow, onStartWorkflow: vi.fn().mockResolvedValue(undefined),
    });
    await fireEvent.click(view.getByRole("radio", { name: /I have a problem to solve/ }));
    await fireEvent.input(view.getByPlaceholderText("Describe the problem."), { target: { value: "Repairs arrive late." } });
    await fireEvent.input(view.getByLabelText("Maximum searches"), { target: { value: "1" } });
    await waitFor(() => expect(view.getByText(/90 min.*12 model calls.*1 search/)).toBeTruthy());
    await waitFor(() => expect(view.getByText(/Minimum required: 4 model calls and 1 search/)).toBeTruthy());
  });

  test("saves an explicit family target separately from the per-problem idea count", async () => {
    const state = workspace();
    state.validation.exa = { valid: true };
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onStart = vi.fn().mockResolvedValue(undefined);
    const view = render(ScopeForm, { workspace: state, busy: false, onSave, onStart, onRetry: vi.fn() });
    expect(view.queryByRole("radio", { name: /Startup opportunities/ })).toBeNull();
    await fireEvent.click(view.getByText("Distinct business target (optional)"));
    await fireEvent.click(view.getByRole("checkbox", { name: /Find distinct businesses across this project/ }));
    await fireEvent.input(view.getByLabelText("Distinct family target"), { target: { value: "8" } });
    await fireEvent.input(view.getByLabelText("Opportunity model-call limit"), { target: { value: "10" } });
    await fireEvent.click(view.getByRole("button", { name: "Discover problems" }));
    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1));
    const saved = RunConfigSchema.parse(onSave.mock.calls[0]?.[1]);
    expect(saved.ideaCount).toBe(state.runConfig!.ideaCount);
    expect(saved.opportunityExploration).toMatchObject({ targetFamilies: 8, maxRawCandidates: 16, maxModelCalls: 10, allowExploratoryProblems: false });
    view.unmount();
    const reopened = render(ScopeForm, { workspace: { ...state, runConfig: saved }, busy: false, onSave, onStart, onRetry: vi.fn() });
    expect((reopened.getByRole("checkbox", { name: /Find distinct businesses across this project/ }) as HTMLInputElement).checked).toBe(true);
    expect((reopened.getByLabelText("Distinct family target") as HTMLInputElement).value).toBe("8");
    expect(reopened.getByText("Distinct business target · On (8)")).toBeTruthy();
    await fireEvent.click(reopened.getByRole("checkbox", { name: /Find distinct businesses across this project/ }));
    await fireEvent.click(reopened.getByRole("button", { name: "Discover problems" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    const withoutTarget = RunConfigSchema.parse(onSave.mock.calls[1]?.[1]);
    expect(withoutTarget.explorationPurpose).toBe("auto");
    expect(withoutTarget.opportunityExploration).toBeUndefined();
  });

  test("keeps a saved output rule until the user switches that project to the brief", async () => {
    const state = workspace();
    state.runConfig = { ...DEFAULT_RUN_CONFIG, explorationPurpose: "startup-opportunities" };
    state.validation.exa = { valid: true };
    const onSave = vi.fn().mockResolvedValue(undefined);
    const view = render(ScopeForm, {
      workspace: state, busy: false, onSave, onStart: vi.fn().mockResolvedValue(undefined), onRetry: vi.fn(),
    });

    expect(view.getByText(/This saved project asks for startup opportunities/)).toBeTruthy();
    await fireEvent.click(view.getByRole("button", { name: "Discover problems" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(RunConfigSchema.parse(onSave.mock.calls[0]?.[1]).explorationPurpose).toBe("startup-opportunities");

    await fireEvent.click(view.getByRole("button", { name: "Follow the brief instead" }));
    await fireEvent.click(view.getByRole("button", { name: "Discover problems" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(RunConfigSchema.parse(onSave.mock.calls[1]?.[1]).explorationPurpose).toBe("auto");
  });

  test("persists advanced search defaults for new research and preserves saved setup choices", async () => {
    const storageKey = "scraply.research-defaults.v1";
    const previous = localStorage.getItem(storageKey);
    try {
      localStorage.removeItem(storageKey);
      const settingsView = renderSettings({ workspace: workspace() });
      await fireEvent.click(settingsView.getByRole("button", { name: "Research defaults" }));
      const coverage = settingsView.getByLabelText("Default search coverage") as HTMLSelectElement;
      expect(coverage.value).toBe("web");
      expect(coverage.selectedOptions[0]?.textContent).toBe("Web and communities");
      await fireEvent.change(coverage, { target: { value: "communities" } });
      await fireEvent.change(settingsView.getByLabelText("Default research depth"), { target: { value: "deep" } });
      await fireEvent.click(settingsView.getByRole("button", { name: "Save defaults" }));
      settingsView.unmount();

      const reopened = renderSettings({ workspace: workspace() });
      await fireEvent.click(reopened.getByRole("button", { name: "Research defaults" }));
      expect((reopened.getByLabelText("Default search coverage") as HTMLSelectElement).value).toBe("communities");
      expect((reopened.getByLabelText("Default research depth") as HTMLSelectElement).value).toBe("deep");
      reopened.unmount();

      const state = workspace();
      state.scope = null;
      state.validation.exa = { valid: true };
      const onSave = vi.fn().mockResolvedValue(undefined);
      const view = render(ScopeForm, { workspace: state, busy: false, onSave, onStart: vi.fn(), onRetry: vi.fn() });
      expect((view.getByLabelText("Search coverage") as HTMLSelectElement).value).toBe("communities");
      expect((view.getByLabelText("Research depth") as HTMLSelectElement).value).toBe("deep");
      await fireEvent.input(view.getByLabelText(/What do you want to explore/), { target: { value: "Repair shop delays" } });
      await fireEvent.click(view.getByRole("button", { name: "Discover problems" }));
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
      expect(RunConfigSchema.parse(onSave.mock.calls[0]?.[1])).toMatchObject({ audienceSourcePolicy: "communities", discoveryDepth: "deep" });
      view.unmount();

      const savedView = render(ScopeForm, { workspace: workspace(), busy: false, onSave, onStart: vi.fn(), onRetry: vi.fn() });
      expect((savedView.getByLabelText("Search coverage") as HTMLSelectElement).value).toBe("web");
      expect((savedView.getByLabelText("Research depth") as HTMLSelectElement).value).toBe("standard");
    } finally {
      if (previous === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, previous);
    }
  });

  test("offers only native OpenAI models and saves the selected model", async () => {
    const state = workspace();
    const nativeModel = { providerId: "openai-subscription", modelId: DEFAULT_RUN_CONFIG.model.modelId };
    state.validation.native = { available: true, connected: true, accounts: [{ providerId: nativeModel.providerId }] };
    state.runConfig = { ...DEFAULT_RUN_CONFIG, searchProvider: "perplexity" };
    const legacyModel = { providerId: "legacy-codex-cli", modelId: DEFAULT_RUN_CONFIG.model.modelId };
    state.models = [nativeModel, legacyModel];
    state.modelOptions = [
      { ...state.modelOptions[0]!, ...nativeModel, displayName: "GPT-5.6 Sol" },
      { ...state.modelOptions[0]!, ...legacyModel, displayName: "Sol legacy" },
    ];
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onStart = vi.fn().mockResolvedValue(undefined);
    const view = render(ScopeForm, { workspace: state, busy: false, onSave, onStart, onRetry: vi.fn() });
    expect(view.getByRole("option", { name: "GPT-5.6 Sol" })).toBeTruthy();
    expect(view.queryByRole("option", { name: "Sol legacy" })).toBeNull();
    const select = view.getByRole("combobox", { name: /Model/ }) as HTMLSelectElement;
    expect(select.value).toBe(modelRefKey(DEFAULT_RUN_CONFIG.model));
    await fireEvent.change(select, { target: { value: modelRefKey(nativeModel) } });
    await fireEvent.click(view.getByRole("button", { name: "Discover problems" }));
    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1));
    expect(RunConfigSchema.parse(onSave.mock.calls[0]?.[1]).model).toEqual(nativeModel);
  });

  test("keeps an unavailable GPT-6 default visible without changing the title model", async () => {
    const storageKey = "scraply.research-defaults.v1";
    const previous = localStorage.getItem(storageKey);
    try {
      localStorage.removeItem(storageKey);
      const view = renderSettings({ workspace: workspace() });
      await fireEvent.click(view.getByRole("button", { name: "Research defaults" }));
      const model = view.getByLabelText("Default model") as HTMLSelectElement;
      const titleModel = view.getByLabelText("Title model") as HTMLSelectElement;
      expect([...model.options].map((option) => option.textContent)).toContain("GPT-6 Sol (unavailable)");
      expect([...model.options].map((option) => option.textContent)).toContain("GPT-6 Luna (unavailable)");
      const originalTitle = titleModel.value;
      await fireEvent.change(model, { target: { value: "openai-subscription:gpt-6-sol" } });
      await fireEvent.click(view.getByRole("button", { name: "Save defaults" }));
      view.unmount();

      const reopened = renderSettings({ workspace: workspace() });
      await fireEvent.click(reopened.getByRole("button", { name: "Research defaults" }));
      expect((reopened.getByLabelText("Default model") as HTMLSelectElement).value).toBe("openai-subscription:gpt-6-sol");
      expect((reopened.getByLabelText("Title model") as HTMLSelectElement).value).toBe(originalTitle);
    } finally {
      if (previous === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, previous);
    }
  });

  test("offers live GPT-6 Sol and Luna and uses their catalog reasoning defaults", async () => {
    const state = workspace();
    state.validation.exa = { valid: true };
    const sol = { providerId: "openai-subscription", modelId: "gpt-6-sol" };
    const luna = { providerId: "openai-subscription", modelId: "gpt-6-luna" };
    state.models = [...state.models, sol, luna];
    state.modelOptions = [
      ...state.modelOptions,
      { ...sol, displayName: "Sol", defaultReasoningEffort: "high", reasoningEfforts: [{ id: "low", description: "Fast" }, { id: "high", description: "Thorough" }] },
      { ...luna, displayName: "Luna", defaultReasoningEffort: "minimal", reasoningEfforts: [{ id: "minimal", description: "Brief" }] },
    ];
    const onSave = vi.fn().mockResolvedValue(undefined);
    const view = render(ScopeForm, { workspace: state, busy: false, onSave, onStart: vi.fn(), onRetry: vi.fn() });
    const modelSelect = view.getByRole("combobox", { name: "Model" }) as HTMLSelectElement;
    expect(view.getByRole("option", { name: "GPT-6 Sol" })).toBeTruthy();
    expect(view.getByRole("option", { name: "GPT-6 Luna" })).toBeTruthy();
    await fireEvent.change(modelSelect, { target: { value: modelRefKey(sol) } });
    expect((view.getByRole("combobox", { name: /Reasoning/ }) as HTMLSelectElement).value).toBe("high");
    await fireEvent.change(modelSelect, { target: { value: modelRefKey(luna) } });
    expect((view.getByRole("combobox", { name: /Reasoning/ }) as HTMLSelectElement).value).toBe("minimal");
    await fireEvent.click(view.getByRole("button", { name: "Discover problems" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[1]).toMatchObject({ model: luna, reasoningEffort: "minimal" });
  });

  test("keeps a saved effort visible when the live catalog changes", async () => {
    const state = workspace();
    state.validation.exa = { valid: true };
    state.runConfig = { ...DEFAULT_RUN_CONFIG, reasoningEffort: "medium" };
    state.modelOptions = [{ ...state.modelOptions[0]!, defaultReasoningEffort: "high", reasoningEfforts: [{ id: "high", description: "Thorough" }] }];
    const onSave = vi.fn().mockResolvedValue(undefined);
    const view = render(ScopeForm, { workspace: state, busy: false, onSave, onStart: vi.fn(), onRetry: vi.fn() });
    const reasoning = view.getByRole("combobox", { name: /Reasoning/ }) as HTMLSelectElement;
    expect(reasoning.value).toBe("medium");
    expect(view.getByRole("option", { name: "medium (unavailable)" })).toBeTruthy();
    expect((view.getByRole("button", { name: "Discover problems" }) as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.change(reasoning, { target: { value: "high" } });
    expect((view.getByRole("button", { name: "Discover problems" }) as HTMLButtonElement).disabled).toBe(false);
    await fireEvent.click(view.getByRole("button", { name: "Discover problems" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[1]).toMatchObject({ model: DEFAULT_RUN_CONFIG.model, reasoningEffort: "high" });
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
    const view = renderSettings({
      workspace: disconnected,
      busy: false,
      onRetry: vi.fn(),
      onConnectNative: connect,
    });

    await fireEvent.click(view.getByRole("button", { name: "Sign in with OpenAI" }));
    expect(connect).toHaveBeenCalledWith("openai-subscription", "browser");
    await fireEvent.click(view.getByRole("button", { name: "Use device code" }));
    expect(connect).toHaveBeenCalledWith("openai-subscription", "device");

    const connected = workspace();
    connected.validation.native = {
      available: true, connected: true, version: "0.1.0",
      accounts: [{ providerId: "openai-subscription", email: "dany@example.test", plan: "prolite" }],
    };
    const refresh = vi.fn().mockResolvedValue(undefined);
    const logout = vi.fn().mockResolvedValue(undefined);
    const accountView = renderSettings({
      workspace: connected,
      busy: false,
      onRetry: vi.fn(),
      onRefreshNative: refresh, onLogoutNative: logout,
    });
    expect(accountView.getByText("dany@example.test · ChatGPT Pro")).toBeTruthy();
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
    const view = renderSettings({
      workspace: state, busy: false, onRetry: retry,
    });

    expect(view.getByLabelText("OpenAI account")).toBeTruthy();
    expect(view.getByText("OpenAI runtime could not start")).toBeTruthy();
    expect(view.queryByText(/Legacy Codex CLI/)).toBeNull();
    await fireEvent.click(view.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test("presents pending validation as progress instead of a connection error", () => {
    const state = workspace();
    state.validation.native = {
      available: false, connected: false, accounts: [], error: "Checking native runtime",
    };
    state.validation.exa = { valid: false, error: "Checking Exa connection" };
    const view = render(ScopeForm, {
      workspace: state, busy: false, onSave: vi.fn(), onStart: vi.fn(), onRetry: vi.fn(),
    });

    expect(view.getByText("Checking connections…")).toBeTruthy();
    expect(view.queryByText("Connect to start")).toBeNull();
    expect((view.getByRole("button", { name: "Discover problems" }) as HTMLButtonElement).disabled).toBe(true);
    expect(view.queryByLabelText("OpenAI account")).toBeNull();
  });

  test("explains an empty model list after account connection", async () => {
    const state = workspace();
    state.validation.native = {
      available: true, connected: true, accounts: [{ providerId: "openai-subscription", email: "dany@example.test" }],
    };
    state.models = [];
    state.modelOptions = [];
    const view = render(ScopeForm, {
      workspace: state, busy: false, onSave: vi.fn(), onStart: vi.fn(), onRetry: vi.fn(),
    });

    expect(view.getByText("Your available models appear here after you sign in.")).toBeTruthy();
    expect(view.getByText("No compatible models are available")).toBeTruthy();
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
    expect(view.getByText("This project used the removed CLI integration. Choose an available OpenAI model.")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Retry connections" })).toBeNull();
    await fireEvent.click(view.getByRole("button", { name: "Choose model" }));
    expect(document.activeElement).toBe(modelSelect);
    expect((view.getByRole("button", { name: "Discover problems" }) as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.submit(view.container.querySelector("form")!);
    expect(onSave).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();

    await fireEvent.change(modelSelect, { target: { value: modelRefKey(DEFAULT_RUN_CONFIG.model) } });
    expect(view.queryByText("This project used the removed CLI integration.", { exact: false })).toBeNull();
    expect((view.getByRole("button", { name: "Discover problems" }) as HTMLButtonElement).disabled).toBe(false);
    await fireEvent.click(view.getByRole("button", { name: "Discover problems" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[1]).toMatchObject({ model: DEFAULT_RUN_CONFIG.model });
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  test("treats a retired native model as a selection problem while connections are healthy", async () => {
    const state = workspace();
    state.runConfig = {
      ...DEFAULT_RUN_CONFIG,
      model: { providerId: "openai-subscription", modelId: "gpt-retired" },
    };
    state.validation.exa = { valid: true };
    const view = render(ScopeForm, {
      workspace: state, busy: false, onSave: vi.fn(), onStart: vi.fn(), onRetry: vi.fn(),
    });

    expect(view.getByText("Choose an available model to start.")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Retry connections" })).toBeNull();
    expect(view.getByRole("button", { name: "Choose model" })).toBeTruthy();
    expect((view.getByRole("button", { name: "Discover problems" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("keeps a real search connection failure visible beside a required model choice", () => {
    const state = workspace();
    state.runConfig = {
      ...DEFAULT_RUN_CONFIG,
      model: { providerId: "legacy-codex-cli", modelId: "gpt-old" },
    };
    state.validation.exa = { valid: false, error: "Exa unavailable" };
    const view = render(ScopeForm, {
      workspace: state, busy: false, onSave: vi.fn(), onStart: vi.fn(), onRetry: vi.fn(),
    });

    expect(view.getByRole("button", { name: "Choose model" })).toBeTruthy();
    expect(view.getByText("Exa: Exa unavailable", { selector: ".connection-warning span" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Retry connections" })).toBeTruthy();
  });

  test("shows device-code instructions and leaves cancellation enabled while setup is busy", async () => {
    const state = workspace();
    state.validation.native = { available: true, connected: false, version: "0.1.0", accounts: [] };
    const cancel = vi.fn().mockResolvedValue(undefined);
    const view = renderSettings({
      workspace: state,
      busy: true,
      nativeLogin: {
        loginId: "login-device",
        providerId: "openai-subscription",
        method: "device" as const,
        verificationUrl: "https://example.test/device",
        userCode: "ABCD-1234",
      },
      onRetry: vi.fn(), onCancelNative: cancel,
    });

    expect(view.getByText("ABCD-1234")).toBeTruthy();
    const button = view.getByRole("button", { name: "Cancel sign-in" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    await fireEvent.click(button);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe("settings surfaces preserve launch configuration", () => {
  test("explains run modes on hover or focus without changing the selected mode", async () => {
    const view = render(ScopeForm, { workspace: workspace(), busy: false, onSave: vi.fn(), onStart: vi.fn(), onRetry: vi.fn(), onPreviewWorkflow: vi.fn(), onStartWorkflow: vi.fn() });
    const info = view.getByRole("button", { name: "About Babysit" });
    await fireEvent.mouseEnter(info.parentElement!);
    expect(view.getByRole("tooltip").textContent).toContain("choose which ones become ideas");
    expect((view.getByRole("radio", { name: "Vibe" }) as HTMLInputElement).checked).toBe(true);
    await fireEvent.keyDown(info, { key: "Escape" });
    expect(view.queryByRole("tooltip")).toBeNull();
    await fireEvent.focusIn(info);
    expect(view.getByRole("tooltip")).toBeTruthy();
    await fireEvent.focusOut(info);
    expect(view.queryByRole("tooltip")).toBeNull();
  });

  test.each([
    [["runConfig", "searchProvider"], "Search provider"],
    [["ideas", "reviewModel"], "Ideas model"],
  ])("reveals the field for preflight errors at %s", async (path, label) => {
    const state = workspace();
    state.validation.exa = { valid: true };
    const onPreviewWorkflow = vi.fn(async (draft: WorkflowLaunchDraft) => ({
      type: "launch" as const, proposal: { ...draft,
        resolvedInstructions: { research: "r", ideas: "i", review: "v" }, instructionHashes: { research: "r", ideas: "i", review: "v" } },
      previewHash: "blocked", capabilityFingerprint: "fixture", minimumWork: { modelCalls: 1, searches: 0 },
      upperLimits: draft.limits, fieldErrors: [{ path: path as string[], code: "UNAVAILABLE", message: "This choice became unavailable." }], expiresAt: "2099-01-01T00:00:00.000Z",
    }));
    const view = render(ScopeForm, { workspace: state, busy: false, onSave: vi.fn(), onStart: vi.fn(), onRetry: vi.fn(), onPreviewWorkflow, onStartWorkflow: vi.fn() });
    await waitFor(() => expect(view.getByRole("button", { name: "Review settings" })).toBeTruthy());
    await fireEvent.click(view.getByRole("button", { name: "Review settings" }));
    await waitFor(() => expect(document.activeElement).toBe(view.getByLabelText(label as string)));
    expect(view.getByRole("alert").textContent).toBe("This choice became unavailable.");
  });

  test.each([
    ["explore-market", "vibe"], ["explore-market", "babysit"],
    ["known-problem", "vibe"], ["known-problem", "babysit"],
  ] as const)("preserves %s / %s values across settings and disclosure changes", async (researchMode, mode) => {
    const state = workspace();
    state.validation.exa = { valid: true };
    const ideasModel = { providerId: "openai-subscription", modelId: "gpt-6-astra" };
    state.models.push(ideasModel);
    state.modelOptions.push({ ...ideasModel, displayName: "Astra", defaultReasoningEffort: "high", reasoningEfforts: [{ id: "high", description: "Thorough" }] });
    const onPreviewWorkflow = vi.fn(async (draft: WorkflowLaunchDraft) => ({
      type: "launch" as const, proposal: { ...draft,
        resolvedInstructions: { research: "r", ideas: "i", review: "v" }, instructionHashes: { research: "r", ideas: "i", review: "v" } },
      previewHash: JSON.stringify(draft), capabilityFingerprint: "fixture", minimumWork: { modelCalls: 1, searches: 0 },
      upperLimits: draft.limits, fieldErrors: [], expiresAt: "2099-01-01T00:00:00.000Z",
    }));
    const onStartWorkflow = vi.fn().mockResolvedValue(undefined);
    const view = render(ScopeForm, { workspace: state, busy: false, onSave: vi.fn(), onStart: vi.fn(), onRetry: vi.fn(), onPreviewWorkflow, onStartWorkflow });
    if (researchMode === "known-problem") {
      await fireEvent.click(view.getByRole("radio", { name: "I have a problem to solve" }));
      await fireEvent.input(view.getByPlaceholderText("Describe the problem."), { target: { value: "Approvals take too long" } });
    }
    await fireEvent.input(view.getByLabelText("Risk priorities"), { target: { value: "Low setup effort" } });
    await fireEvent.input(view.getByLabelText("Boundaries"), { target: { value: "No hardware\nNo migration" } });
    expect(view.getByLabelText("Solutions per problem").closest("aside")).toBeTruthy();
    await fireEvent.input(view.getByLabelText("Solutions per problem"), { target: { value: "5" } });
    if (researchMode === "explore-market") {
      await fireEvent.change(view.getByLabelText("Research depth"), { target: { value: "deep" } });
      await fireEvent.click(view.getByRole("button", { name: "Advanced settings" }));
      await fireEvent.change(view.getByLabelText("Search coverage"), { target: { value: "communities" } });
      await fireEvent.change(view.getByLabelText("Search provider"), { target: { value: "perplexity" } });
    }
    if (researchMode === "known-problem") await fireEvent.click(view.getByRole("button", { name: "Advanced settings" }));
    await fireEvent.click(view.getByRole("button", { name: "Ideas & review" }));
    await fireEvent.change(view.getByLabelText("Ideas model"), { target: { value: modelRefKey(ideasModel) } });
    await fireEvent.click(view.getByRole("button", { name: "Instructions" }));
    for (const [label, value] of [["Research instructions", "Research context"], ["Ideas instructions", "Generate carefully"], ["Review instructions", "Check evidence"]]) {
      await fireEvent.input(view.getByLabelText(label!), { target: { value } });
    }
    await fireEvent.click(view.getByRole("button", { name: "Work limits" }));
    await fireEvent.input(view.getByLabelText("Time limit"), { target: { value: "80" } });
    await fireEvent.input(view.getByLabelText("Maximum model calls"), { target: { value: "200" } });
    await fireEvent.input(view.getByLabelText("Maximum searches"), { target: { value: "80" } });
    await fireEvent.click(view.getByRole("button", { name: "Done" }));
    expect(view.getByText("Ideas & review: GPT-6 Astra · high reasoning")).toBeTruthy();
    if (mode === "babysit") await fireEvent.click(view.getByRole("radio", { name: /Babysit/ }));
    await waitFor(() => expect(onPreviewWorkflow.mock.lastCall?.[0]).toMatchObject({
      purpose: researchMode === "known-problem" ? "known-problem" : "discovery", mode,
      brief: researchMode === "known-problem" ? "Approvals take too long" : "Parts sourcing",
      scope: { title: "Repair shops", audience: "Shops", domain: "Parts sourcing", riskEvaluationCriteria: "Low setup effort", offLimits: ["No hardware", "No migration"] },
      runConfig: { ...DEFAULT_RUN_CONFIG, ideaCount: 5, maxRunMinutes: 80, researchMode, knownProblem: researchMode === "known-problem" ? "Approvals take too long" : "",
        ...(researchMode === "explore-market" ? { discoveryDepth: "deep", audienceSourcePolicy: "communities", searchProvider: "perplexity" } : {}) },
      limits: { maxMinutes: 80, maxModelCalls: 200, maxSearches: 80 },
      instructions: { research: "Research context", ideas: "Generate carefully", review: "Check evidence" },
      ...(mode === "vibe" ? { ideas: { model: ideasModel, reasoningEffort: "high", reviewModel: ideasModel, reviewReasoningEffort: "high" } } : {}),
    }));
    const expected = structuredClone(onPreviewWorkflow.mock.lastCall![0]);
    if (mode === "babysit") expect(expected.ideas).toBeUndefined();
    await fireEvent.click(view.getByRole("button", { name: "Advanced settings" }));
    await fireEvent.click(view.getByRole("button", { name: "Done" }));
    await fireEvent.click(view.getByRole("button", { name: mode === "vibe" ? "Start Vibe" : "Start Babysit" }));
    await waitFor(() => expect(onStartWorkflow).toHaveBeenCalledOnce());
    expect(onStartWorkflow.mock.calls[0]?.[0].proposal).toMatchObject(expected);
  });

  test("reveals a collapsed invalid limit, focuses it, and retries a failed preview", async () => {
    const state = workspace();
    state.validation.exa = { valid: true };
    const onPreviewWorkflow = vi.fn().mockRejectedValue(new Error("Preview temporarily unavailable"));
    const view = render(ScopeForm, { workspace: state, busy: false, onSave: vi.fn(), onStart: vi.fn(), onRetry: vi.fn(), onPreviewWorkflow, onStartWorkflow: vi.fn() });
    await waitFor(() => expect(view.getByText("Preview temporarily unavailable")).toBeTruthy());
    await fireEvent.click(view.getByRole("button", { name: "Retry preview" }));
    await waitFor(() => expect(onPreviewWorkflow).toHaveBeenCalledTimes(2));
    await fireEvent.click(view.getByRole("button", { name: "Edit limits" }));
    await fireEvent.input(view.getByLabelText("Time limit"), { target: { value: "1" } });
    await fireEvent.click(view.getByRole("button", { name: "Done" }));
    expect(view.queryByRole("dialog")).toBeNull();
    await fireEvent.click(view.getByRole("button", { name: "Review settings" }));
    expect(view.getByRole("dialog", { name: "Advanced settings" })).toBeTruthy();
    expect(document.activeElement).toBe(view.getByLabelText("Time limit"));
    expect((view.getByRole("button", { name: "Start Vibe" }) as HTMLButtonElement).disabled).toBe(true);
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
    researchRequests: [],
    researchFindings: [],
    solutions: [],
    latestResearchRun: null,
    pendingRuns: [],
  };
}

function renderSettings(props: Partial<ComponentProps<typeof Settings>> & { workspace: WorkspaceState }) {
  const view = render(Settings, {
    open: true, busy: false, nativeLogin: null, onRetry: vi.fn(), onConnectNative: vi.fn(), onCancelNative: vi.fn(),
    onRefreshNative: vi.fn(), onLogoutNative: vi.fn(), onOpenData: vi.fn(), onOpenLogs: vi.fn(), onRestore: vi.fn(), onDelete: vi.fn(), ...props,
  });
  return view;
}
