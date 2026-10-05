import { fireEvent, render, waitFor, within } from "@testing-library/svelte";
import type { ComponentProps } from "svelte";
import { describe, expect, test, vi } from "vitest";
import Settings from "../../src/renderer/components/Settings.svelte";
import ScopeForm from "../../src/renderer/components/ScopeForm.svelte";
import ProblemCheckpoint from "../../src/renderer/components/ProblemCheckpoint.svelte";
import type { WorkspaceState } from "../../src/shared/ipc";
import { DEFAULT_RUN_CONFIG, RunConfigSchema, modelRefKey } from "../../src/shared/schemas";
import type { WorkflowLaunchDraft } from "../../src/shared/workflow-contracts";
import { listedModels, pickModel } from "./model-picker";
import { modelDisplayName } from "../../src/renderer/lib/research-defaults";

describe("ScopeForm search provider selection", () => {
  test("defaults a new setup to automatic when both providers are connected", async () => {
    const state = workspace();
    state.scope = null;
    state.runConfig = null;
    state.validation.exa = { valid: true };
    state.validation.perplexity = { valid: true };
    const view = render(ScopeForm, { workspace: state, busy: false, onSave: vi.fn(), onStart: vi.fn(), onRetry: vi.fn() });
    await waitFor(() => expect((view.getByLabelText("Search provider") as HTMLSelectElement).value).toBe("auto"));
    expect(view.queryByLabelText("Search coverage")).toBeNull();
    expect((view.getByRole("button", { name: "Discover problems" }) as HTMLButtonElement).disabled).toBe(false);
  });
  test("uses the connected provider for a new setup after Perplexity-only onboarding", async () => {
    const storageKey = "scraply.research-defaults.v1";
    const previous = localStorage.getItem(storageKey);
    try {
      localStorage.removeItem(storageKey);
      const state = workspace();
      state.scope = null;
      state.runConfig = null;
      state.validation.perplexity = { valid: false, error: "Perplexity unavailable" };
      const props = { workspace: state, busy: false, onSave: vi.fn(), onStart: vi.fn(), onRetry: vi.fn() };
      const view = render(ScopeForm, props);
      const provider = view.getByLabelText("Search provider") as HTMLSelectElement;
      expect(provider.value).toBe("exa");
      const connected = { ...state, validation: { ...state.validation, perplexity: { valid: true } } };
      await view.rerender({ ...props, workspace: connected });
      await waitFor(() => expect(provider.value).toBe("perplexity"));
      expect((view.getByRole("button", { name: "Discover problems" }) as HTMLButtonElement).disabled).toBe(false);

      await fireEvent.change(provider, { target: { value: "exa" } });
      await view.rerender({ ...props, workspace: { ...connected, validation: { ...connected.validation } } });
      expect(provider.value).toBe("exa");
    } finally {
      if (previous === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, previous);
    }
  });

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

  test("flags an empty brief only after Start is clicked, and hides the problem cap for a stated problem", async () => {
    const state = workspace();
    state.scope = null;
    state.runConfig = null;
    state.validation.exa = { valid: true };

    const view = render(ScopeForm, {
      workspace: state, busy: false, onSave: vi.fn(), onStart: vi.fn(), onRetry: vi.fn(),
      onPreviewWorkflow: vi.fn(), onStartWorkflow: vi.fn(),
    });

    const startingContext = view.getByPlaceholderText("Your topic or idea");
    expect(view.queryByLabelText("Research name")).toBeNull();
    expect(view.queryByRole("radio", { name: /Startup opportunities/ })).toBeNull();
    await fireEvent.blur(startingContext);
    expect(startingContext.getAttribute("aria-invalid")).toBe("false");
    expect(view.queryByText("A starting context is required.", { selector: ".field-error" })).toBeNull();

    // Start stays clickable with an empty brief; clicking it reveals the error instead of launching.
    await fireEvent.click(view.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(startingContext.getAttribute("aria-invalid")).toBe("true"));
    expect(view.getByText("A starting context is required.", { selector: ".field-error" })).toBeTruthy();
    expect(document.activeElement).toBe(startingContext);

    await fireEvent.click(view.getByRole("radio", { name: /I have a problem to solve/ }));
    await fireEvent.click(view.getByRole("radio", { name: /Vibe/ }));
    expect(view.queryByLabelText("Automatic problem cap")).toBeNull();
    expect(view.getByText("Describe the problem to start.")).toBeTruthy();
  });

  test("names a new thread with the title agent before launching it", async () => {
    const state = workspace();
    state.scope = null;
    state.validation.exa = { valid: true };
    const onPreviewWorkflow = vi.fn(async (draft: WorkflowLaunchDraft) => ({
      type: "launch" as const,
      proposal: { ...draft,
        resolvedInstructions: { research: "research", ideas: "ideas", review: "review" },
        instructionHashes: { research: "r", ideas: "i", review: "v" },
      },
      previewHash: `preview-${draft.scope.title}`, capabilityFingerprint: "catalogue",
      minimumWork: { modelCalls: 1, searches: 0 }, upperLimits: draft.limits, fieldErrors: [],
      expiresAt: "2099-01-01T00:00:00.000Z",
    }));
    const onStartWorkflow = vi.fn<(preview: unknown) => Promise<void>>(async () => {});
    const onGenerateTitle = vi.fn(async () => "Faster parts delivery for repair shops");
    const view = render(ScopeForm, { workspace: state, busy: false, onSave: vi.fn(), onStart: vi.fn(),
      onPreviewWorkflow, onStartWorkflow, onGenerateTitle, onRetry: vi.fn(async () => {}) });

    await fireEvent.input(view.getByPlaceholderText("Your topic or idea"), { target: { value: "Repair shops wait days for parts." } });
    await fireEvent.click(view.getByRole("button", { name: "Start" }));

    await waitFor(() => expect(onStartWorkflow).toHaveBeenCalledOnce());
    expect(onGenerateTitle).toHaveBeenCalledWith("Repair shops wait days for parts.");
    expect(onStartWorkflow.mock.lastCall?.[0]).toMatchObject({
      proposal: { scope: { title: "Faster parts delivery for repair shops" } },
      previewHash: "preview-Faster parts delivery for repair shops",
    });
  });

  test("defaults to Vibe and refreshes depth guidance before launch", async () => {
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
    expect(latestDraft).toMatchObject({ mode: "vibe", ideas: { model: DEFAULT_RUN_CONFIG.model } });
    // No cap by default: Vibe develops every qualifying problem. A typed number still limits it.
    expect(latestDraft?.targets.automaticProblemCap).toBeUndefined();
    const cap = view.getByLabelText("Automatic problem cap") as HTMLInputElement;
    expect(cap.placeholder).toBe("All qualifying");
    await fireEvent.input(cap, { target: { value: "2" } });
    await waitFor(() => expect(onPreviewWorkflow.mock.lastCall?.[0].targets.automaticProblemCap).toBe(2));
    expect(view.getByLabelText("Ideas model")).toBeTruthy();
    await waitFor(() => expect((view.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(false));

    expect(latestDraft?.limits.enforced).toBe(false);
    expect(view.getByLabelText("Search provider").closest("dialog")).toBeNull();
    expect(view.queryByLabelText("Maximum model calls")).toBeNull();
    await fireEvent.change(view.getByLabelText("Research depth"), { target: { value: "deep" } });
    expect(view.getByText(/Assess up to 8 problem candidates per selected area/)).toBeTruthy();
    await waitFor(() => expect(onPreviewWorkflow.mock.lastCall?.[0].runConfig.discoveryDepth).toBe("deep"));
    await waitFor(() => expect((view.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(false));
    await fireEvent.click(view.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(onStartWorkflow).toHaveBeenCalledOnce());
    expect(onSave).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
  });

  test("new runs ask for ideas per problem, even in a project that saved a distinct business target", async () => {
    const state = workspace();
    state.validation.exa = { valid: true };
    state.runConfig = { ...state.runConfig!, ideaCount: 3, explorationPurpose: "startup-opportunities",
      opportunityExploration: { targetFamilies: 8, batchSize: 4, maxExpansionRounds: 2, maxRawCandidates: 16, maxModelCalls: 10, maxSearches: 6, allowExploratoryProblems: false } };
    const onPreviewWorkflow = vi.fn(async (draft: WorkflowLaunchDraft) => ({
      type: "launch" as const,
      proposal: { ...draft, resolvedInstructions: { research: "research", ideas: "ideas", review: "review" },
        instructionHashes: { research: "r", ideas: "i", review: "v" } },
      previewHash: "per-problem", capabilityFingerprint: "catalogue", minimumWork: { modelCalls: 12, searches: 4 },
      upperLimits: draft.limits, fieldErrors: [], expiresAt: "2099-01-01T00:00:00.000Z",
    }));
    const view = render(ScopeForm, {
      workspace: state, busy: false, onSave: vi.fn(), onStart: vi.fn(), onRetry: vi.fn(),
      onPreviewWorkflow, onStartWorkflow: vi.fn().mockResolvedValue(undefined),
    });
    expect(view.queryByText(/Distinct business target/)).toBeNull();
    expect(view.queryByLabelText("Distinct family target")).toBeNull();
    await waitFor(() => expect(onPreviewWorkflow.mock.lastCall?.[0]).toMatchObject({ targets: { kind: "per-problem", ideaCount: 3 } }));
    const draft = onPreviewWorkflow.mock.lastCall![0];
    expect(draft.targets).not.toHaveProperty("distinctBusinessCount");
    expect(draft.runConfig.opportunityExploration).toBeUndefined();
    expect(draft.runConfig.explorationPurpose).toBe("startup-opportunities");

    await fireEvent.input(view.getByLabelText("Solutions per problem"), { target: { value: "6" } });
    await fireEvent.click(view.getByRole("button", { name: "Start" }));
    expect(view.getAllByText("Choose a whole number from 1 to 5.").length).toBeGreaterThan(0);
  });

  test("treats preview estimates as guidance without mandatory limit controls", async () => {
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
    await waitFor(() => expect(onPreviewWorkflow).toHaveBeenCalled());
    expect(onPreviewWorkflow.mock.calls.at(-1)?.[0].limits.enforced).toBe(false);
    expect(view.queryByLabelText("Maximum searches")).toBeNull();
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

  test("loads older coverage defaults without offering the retired source setting", async () => {
    const storageKey = "scraply.research-defaults.v1";
    const previous = localStorage.getItem(storageKey);
    try {
      localStorage.setItem(storageKey, JSON.stringify({ model: DEFAULT_RUN_CONFIG.model, searchProvider: "exa", audienceSourcePolicy: "communities" }));
      const settingsView = renderSettings({ workspace: workspace() });
      await fireEvent.click(settingsView.getByRole("button", { name: "Research defaults" }));
      expect(settingsView.queryByLabelText("Default search coverage")).toBeNull();
      await fireEvent.change(settingsView.getByLabelText("Default research depth"), { target: { value: "deep" } });
      await fireEvent.click(settingsView.getByRole("button", { name: "Save defaults" }));
      settingsView.unmount();

      const reopened = renderSettings({ workspace: workspace() });
      await fireEvent.click(reopened.getByRole("button", { name: "Research defaults" }));
      expect(reopened.queryByLabelText("Default search coverage")).toBeNull();
      expect(JSON.parse(localStorage.getItem(storageKey)!).audienceSourcePolicy).toBeUndefined();
      expect((reopened.getByLabelText("Default research depth") as HTMLSelectElement).value).toBe("deep");
      reopened.unmount();

      const state = workspace();
      state.scope = null;
      state.validation.exa = { valid: true };
      const onSave = vi.fn().mockResolvedValue(undefined);
      const view = render(ScopeForm, { workspace: state, busy: false, onSave, onStart: vi.fn(), onRetry: vi.fn() });
      expect(view.queryByLabelText("Search coverage")).toBeNull();
      expect((view.getByLabelText("Research depth") as HTMLSelectElement).value).toBe("deep");
      await fireEvent.input(view.getByLabelText(/What do you want to explore/), { target: { value: "Repair shop delays" } });
      await fireEvent.click(view.getByRole("button", { name: "Discover problems" }));
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
      expect(RunConfigSchema.parse(onSave.mock.calls[0]?.[1])).toMatchObject({ discoveryDepth: "deep" });
      expect(RunConfigSchema.parse(onSave.mock.calls[0]?.[1]).audienceSourcePolicy).toBeUndefined();
      view.unmount();

      const savedView = render(ScopeForm, { workspace: workspace(), busy: false, onSave, onStart: vi.fn(), onRetry: vi.fn() });
      expect(savedView.queryByLabelText("Search coverage")).toBeNull();
      expect((savedView.getByLabelText("Research depth") as HTMLSelectElement).value).toBe("standard");
    } finally {
      if (previous === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, previous);
    }
  });

  test("uses saved research and ideas model efforts in new setups and later idea selection", async () => {
    const storageKey = "scraply.research-defaults.v1";
    const previous = localStorage.getItem(storageKey);
    const sol = DEFAULT_RUN_CONFIG.model;
    const luna = { providerId: "openai-subscription", modelId: "gpt-6-luna" };
    const state = workspace();
    state.validation.exa = { valid: true };
    state.models = [sol, luna];
    state.modelOptions = [
      { ...sol, displayName: "Sol", defaultReasoningEffort: "medium", reasoningEfforts: [
        { id: "low", description: "Fast" }, { id: "medium", description: "Balanced" },
      ] },
      { ...luna, displayName: "Luna", defaultReasoningEffort: "low", reasoningEfforts: [
        { id: "low", description: "Fast" }, { id: "high", description: "Thorough" },
      ] },
    ];
    try {
      localStorage.removeItem(storageKey);
      const settings = renderSettings({ workspace: state });
      await fireEvent.click(settings.getByRole("button", { name: "Research defaults" }));
      await fireEvent.change(settings.getByLabelText("Default reasoning"), { target: { value: "low" } });
      await pickModel(settings.getByLabelText("Default ideas model"), modelRefKey(luna));
      expect((settings.getByLabelText("Default ideas reasoning") as HTMLSelectElement).value).toBe("low");
      await fireEvent.change(settings.getByLabelText("Default ideas reasoning"), { target: { value: "high" } });
      await fireEvent.click(settings.getByRole("button", { name: "Save defaults" }));
      settings.unmount();

      const reopened = renderSettings({ workspace: state });
      await fireEvent.click(reopened.getByRole("button", { name: "Research defaults" }));
      expect((reopened.getByLabelText("Default reasoning") as HTMLSelectElement).value).toBe("low");
      expect((reopened.getByLabelText("Default ideas model") as HTMLSelectElement).value).toBe(modelRefKey(luna));
      expect((reopened.getByLabelText("Default ideas reasoning") as HTMLSelectElement).value).toBe("high");
      reopened.unmount();

      const fresh = { ...state, scope: null, runConfig: null };
      const onPreviewWorkflow = vi.fn().mockRejectedValue(new Error("Preview unavailable"));
      const setup = render(ScopeForm, { workspace: fresh, busy: false, onSave: vi.fn(), onStart: vi.fn(),
        onRetry: vi.fn(), onPreviewWorkflow, onStartWorkflow: vi.fn() });
      expect((setup.getByRole("combobox", { name: "Reasoning" }) as HTMLSelectElement).value).toBe("low");
      expect((setup.getByRole("combobox", { name: "Ideas model" }) as HTMLSelectElement).value).toBe(modelRefKey(luna));
      expect((setup.getByRole("combobox", { name: "Ideas reasoning" }) as HTMLSelectElement).value).toBe("high");
      await fireEvent.input(setup.getByPlaceholderText("Your topic or idea"), { target: { value: "Repair shop delays" } });
      await waitFor(() => expect(onPreviewWorkflow).toHaveBeenCalledWith(expect.objectContaining({
        runConfig: expect.objectContaining({ model: sol, reasoningEffort: "low" }),
        ideas: { model: luna, reasoningEffort: "high", reviewModel: luna, reviewReasoningEffort: "high" },
      })));
      setup.unmount();

      const checkpoint = render(ProblemCheckpoint, { problems: [], rejectedCandidates: [], modelOptions: state.modelOptions,
        initialConfig: DEFAULT_RUN_CONFIG, busy: false, onCommit: vi.fn(), onExport: vi.fn(), onOpenSource: vi.fn() });
      expect((checkpoint.getByLabelText("Development model") as HTMLSelectElement).value).toBe(modelRefKey(luna));
      expect((checkpoint.getByLabelText("Development reasoning") as HTMLSelectElement).value).toBe("high");
      checkpoint.unmount();

      const prior = render(ProblemCheckpoint, { problems: [], rejectedCandidates: [], modelOptions: state.modelOptions,
        initialConfig: DEFAULT_RUN_CONFIG, priorDevelopment: true, busy: false,
        onCommit: vi.fn(), onExport: vi.fn(), onOpenSource: vi.fn() });
      expect((prior.getByLabelText("Development model") as HTMLSelectElement).value).toBe(modelRefKey(sol));
      expect((prior.getByLabelText("Development reasoning") as HTMLSelectElement).value).toBe("medium");
    } finally {
      if (previous === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, previous);
    }
  });

  test("takes older preferences' initial efforts from the model catalog", async () => {
    const storageKey = "scraply.research-defaults.v1";
    const previous = localStorage.getItem(storageKey);
    const state = workspace();
    const sol = DEFAULT_RUN_CONFIG.model;
    state.modelOptions = [{ ...sol, displayName: "Sol", defaultReasoningEffort: "medium", reasoningEfforts: [
      { id: "medium", description: "Balanced" }, { id: "high", description: "Thorough" },
    ] }];
    try {
      localStorage.setItem(storageKey, JSON.stringify({ model: sol, searchProvider: "exa" }));
      const checkpoint = render(ProblemCheckpoint, { problems: [], rejectedCandidates: [], modelOptions: state.modelOptions,
        initialConfig: { ...DEFAULT_RUN_CONFIG, reasoningEffort: "high" }, busy: false,
        onCommit: vi.fn(), onExport: vi.fn(), onOpenSource: vi.fn() });
      expect((checkpoint.getByLabelText("Development reasoning") as HTMLSelectElement).value).toBe("medium");
      checkpoint.unmount();

      const setup = render(ScopeForm, { workspace: { ...state, scope: null, runConfig: null }, busy: false,
        onSave: vi.fn(), onStart: vi.fn(), onRetry: vi.fn(), onPreviewWorkflow: vi.fn(), onStartWorkflow: vi.fn() });
      expect((setup.getByLabelText("Ideas reasoning") as HTMLSelectElement).value).toBe("medium");
      setup.unmount();
    } finally {
      if (previous === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, previous);
    }
  });

  test("waits for model choices before filling missing preference efforts", async () => {
    const storageKey = "scraply.research-defaults.v1";
    const previous = localStorage.getItem(storageKey);
    const ready = workspace();
    const sol = DEFAULT_RUN_CONFIG.model;
    ready.modelOptions = [{ ...sol, displayName: "Sol", defaultReasoningEffort: "high", reasoningEfforts: [
      { id: "medium", description: "Balanced" }, { id: "high", description: "Thorough" },
    ] }];
    const loading = { ...ready, modelOptions: [] };
    try {
      localStorage.setItem(storageKey, JSON.stringify({ model: sol, searchProvider: "exa" }));
      const settingsProps = { workspace: loading, open: true, busy: false, nativeLogin: null,
        onRetry: vi.fn(), onConnectNative: vi.fn(), onCancelNative: vi.fn(), onRefreshNative: vi.fn(),
        onLogoutNative: vi.fn(), onSaveSearchKey: vi.fn(), onRemoveSearchKey: vi.fn(), onOpenUrl: vi.fn(),
        onOpenData: vi.fn(), onOpenLogs: vi.fn(), onRestore: vi.fn(), onDelete: vi.fn() };
      const settings = render(Settings, settingsProps);
      await fireEvent.click(settings.getByRole("button", { name: "Research defaults" }));
      await fireEvent.change(settings.getByLabelText("Default search provider"), { target: { value: "perplexity" } });
      await fireEvent.click(settings.getByRole("button", { name: "Save defaults" }));
      expect(JSON.parse(localStorage.getItem(storageKey) ?? "{}")).toMatchObject({ searchProvider: "perplexity" });
      expect(JSON.parse(localStorage.getItem(storageKey) ?? "{}").reasoningEffort).toBeUndefined();
      await settings.rerender({ ...settingsProps, workspace: ready });
      await waitFor(() => expect((settings.getByLabelText("Default reasoning") as HTMLSelectElement).value).toBe("high"));
      expect((settings.getByLabelText("Default ideas reasoning") as HTMLSelectElement).value).toBe("high");
      await fireEvent.click(settings.getByRole("button", { name: "Save defaults" }));
      expect(JSON.parse(localStorage.getItem(storageKey) ?? "{}")).toMatchObject({ reasoningEffort: "high", ideasReasoningEffort: "high" });
      settings.unmount();

      localStorage.setItem(storageKey, JSON.stringify({ model: sol, searchProvider: "exa" }));
      const setupProps = { workspace: { ...loading, scope: null, runConfig: null }, busy: false,
        onSave: vi.fn(), onStart: vi.fn(), onRetry: vi.fn(), onPreviewWorkflow: vi.fn(), onStartWorkflow: vi.fn() };
      const setup = render(ScopeForm, setupProps);
      await setup.rerender({ ...setupProps, workspace: { ...ready, scope: null, runConfig: null } });
      await waitFor(() => expect((setup.getByLabelText("Reasoning") as HTMLSelectElement).value).toBe("high"));
      expect((setup.getByLabelText("Ideas reasoning") as HTMLSelectElement).value).toBe("high");
    } finally {
      if (previous === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, previous);
    }
  });

  test("saved default models show while the model list loads and take catalog efforts when it arrives", async () => {
    const storageKey = "scraply.research-defaults.v1";
    const previous = localStorage.getItem(storageKey);
    const sol = DEFAULT_RUN_CONFIG.model;
    const luna = { providerId: "openai-subscription", modelId: "gpt-6-luna" };
    const loading = { ...workspace(), modelOptions: [] };
    const ready = { ...loading, modelOptions: [
      { ...sol, displayName: "Sol", defaultReasoningEffort: "high", reasoningEfforts: [{ id: "high", description: "Thorough" }] },
      { ...luna, displayName: "Luna", defaultReasoningEffort: "low", reasoningEfforts: [{ id: "low", description: "Fast" }] },
    ] };
    try {
      localStorage.setItem(storageKey, JSON.stringify({ model: luna, ideasModel: luna, searchProvider: "exa" }));
      const props = { workspace: loading, open: true, busy: false, nativeLogin: null,
        onRetry: vi.fn(), onConnectNative: vi.fn(), onCancelNative: vi.fn(), onRefreshNative: vi.fn(),
        onLogoutNative: vi.fn(), onSaveSearchKey: vi.fn(), onRemoveSearchKey: vi.fn(), onOpenUrl: vi.fn(),
        onOpenData: vi.fn(), onOpenLogs: vi.fn(), onRestore: vi.fn(), onDelete: vi.fn() };
      const settings = render(Settings, props);
      await fireEvent.click(settings.getByRole("button", { name: "Research defaults" }));
      expect((settings.getByLabelText("Default model") as HTMLButtonElement).disabled).toBe(true);
      expect(settings.getByLabelText("Default model").textContent).toContain("GPT-6 Luna");
      await settings.rerender({ ...props, workspace: ready });
      await waitFor(() => expect((settings.getByLabelText("Default reasoning") as HTMLSelectElement).value).toBe("low"));
      expect((settings.getByLabelText("Default ideas reasoning") as HTMLSelectElement).value).toBe("low");
    } finally {
      if (previous === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, previous);
    }
  });

  test("names the selected ideas model when it disappears from the catalog", async () => {
    const storageKey = "scraply.research-defaults.v1";
    const previous = localStorage.getItem(storageKey);
    const sol = DEFAULT_RUN_CONFIG.model;
    const luna = { providerId: "openai-subscription", modelId: "gpt-6-luna" };
    try {
      localStorage.setItem(storageKey, JSON.stringify({ model: sol, ideasModel: luna, searchProvider: "exa" }));
      const state = workspace();
      state.models = [sol];
      state.modelOptions = state.modelOptions.filter((model) => modelRefKey(model) === modelRefKey(sol));
      const props = { workspace: { ...state, scope: null, runConfig: null }, busy: false,
        onSave: vi.fn(), onStart: vi.fn(), onRetry: vi.fn(), onPreviewWorkflow: vi.fn(), onStartWorkflow: vi.fn() };
      const setup = render(ScopeForm, props);
      expect(setup.getByLabelText("Ideas model").textContent).toContain("GPT-6 Luna (unavailable)");
      await pickModel(setup.getByLabelText("Ideas model"), modelRefKey(sol));
      await setup.rerender({ ...props, workspace: { ...props.workspace, models: [], modelOptions: [] } });
      expect(setup.getByLabelText("Ideas model").textContent?.trim()).toBe(`${modelDisplayName(sol)} (unavailable)`);
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
      { ...state.modelOptions[0]!, ...nativeModel, displayName: "GPT-6 Sol" },
      { ...state.modelOptions[0]!, ...legacyModel, displayName: "Sol legacy" },
    ];
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onStart = vi.fn().mockResolvedValue(undefined);
    const view = render(ScopeForm, { workspace: state, busy: false, onSave, onStart, onRetry: vi.fn() });
    const select = view.getByRole("combobox", { name: /Model/ }) as HTMLButtonElement;
    expect(await listedModels(select)).toEqual([modelDisplayName(nativeModel)]);
    expect(select.value).toBe(modelRefKey(DEFAULT_RUN_CONFIG.model));
    await fireEvent.click(view.getByRole("button", { name: "Discover problems" }));
    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1));
    expect(RunConfigSchema.parse(onSave.mock.calls[0]?.[1]).model).toEqual(nativeModel);
  });

  test("saving a default model keeps the title model, even one the account does not offer", async () => {
    const storageKey = "scraply.research-defaults.v1";
    const previous = localStorage.getItem(storageKey);
    try {
      localStorage.removeItem(storageKey);
      const view = renderSettings({ workspace: workspace() });
      await fireEvent.click(view.getByRole("button", { name: "Research defaults" }));
      const model = view.getByLabelText("Default model") as HTMLButtonElement;
      const titleModel = view.getByLabelText("Title model") as HTMLButtonElement;
      const offered = workspace().modelOptions.map((item) => modelRefKey(item));
      expect(titleModel.textContent).toContain(offered.includes("openai-subscription:gpt-6-luna") ? "GPT-6 Luna" : "GPT-6 Luna (unavailable)");
      const originalTitle = titleModel.value;
      await pickModel(model, offered[0]!);
      await fireEvent.click(view.getByRole("button", { name: "Save defaults" }));
      view.unmount();

      const reopened = renderSettings({ workspace: workspace() });
      await fireEvent.click(reopened.getByRole("button", { name: "Research defaults" }));
      expect((reopened.getByLabelText("Default model") as HTMLSelectElement).value).toBe(modelRefKey(workspace().modelOptions[0]!));
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
    state.models = [sol, luna];
    state.modelOptions = [
      { ...sol, displayName: "Sol", defaultReasoningEffort: "high", reasoningEfforts: [{ id: "low", description: "Fast" }, { id: "high", description: "Thorough" }] },
      { ...luna, displayName: "Luna", defaultReasoningEffort: "minimal", reasoningEfforts: [{ id: "minimal", description: "Brief" }] },
    ];
    const onSave = vi.fn().mockResolvedValue(undefined);
    const view = render(ScopeForm, { workspace: state, busy: false, onSave, onStart: vi.fn(), onRetry: vi.fn() });
    const modelSelect = view.getByRole("combobox", { name: "Model" });
    // Luna is a latest model; GPT-6 Sol is now behind "Legacy models".
    expect(await listedModels(modelSelect)).toEqual(["GPT-6 Luna", "Legacy models1", "GPT-6 Sol"]);
    await pickModel(modelSelect, modelRefKey(sol));
    expect((view.getByRole("combobox", { name: /Reasoning/ }) as HTMLSelectElement).value).toBe("high");
    await pickModel(modelSelect, modelRefKey(luna));
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

    expect(view.getAllByText("Exa unavailable").length).toBeGreaterThan(0);
    expect(view.queryByText("Perplexity unavailable")).toBeNull();
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
    // The email is hidden behind blurred look-alike text: it is not in the page at all until clicked.
    const account = within(accountView.container).getByLabelText("OpenAI account");
    expect(account.textContent).toContain("Signed in as");
    expect(account.textContent).toContain("· ChatGPT Pro");
    expect(account.textContent).not.toContain("dany@example.test");
    await fireEvent.click(within(account).getByRole("button", { name: "Show account email" }));
    expect(within(account).getByRole("button", { name: "dany@example.test" })).toBeTruthy();
    await fireEvent.click(within(account).getByRole("button", { name: "dany@example.test" }));
    expect(account.textContent).not.toContain("dany@example.test");
    // Revealing lasts only until Settings closes.
    await fireEvent.click(within(account).getByRole("button", { name: "Show account email" }));
    await accountView.rerender({ open: false });
    await accountView.rerender({ open: true });
    expect(within(accountView.container).getByLabelText("OpenAI account").textContent).not.toContain("dany@example.test");
    await fireEvent.click(accountView.getByRole("button", { name: "Refresh" }));
    await fireEvent.click(accountView.getByRole("button", { name: "Sign out" }));
    expect(refresh).toHaveBeenCalledWith("openai-subscription");
    expect(logout).toHaveBeenCalledWith("openai-subscription");
  });

  test("adds, replaces, and removes search keys from Settings without ever showing a saved key", async () => {
    const state = workspace();
    state.validation.exa = { valid: true, maskedKey: "••••3f9a" };
    state.validation.perplexity = { valid: false, error: "Perplexity key missing" };
    const onSaveSearchKey = vi.fn()
      .mockRejectedValueOnce(new Error("Perplexity API key was rejected"))
      .mockResolvedValue(undefined);
    const onRemoveSearchKey = vi.fn().mockResolvedValue(undefined);
    const onOpenUrl = vi.fn();
    const view = renderSettings({ workspace: state, onSaveSearchKey, onRemoveSearchKey, onOpenUrl });

    const exa = view.getByLabelText("Exa account");
    expect(exa.textContent).toContain("Connected");
    expect(exa.textContent).toContain("Saved key ending in••••3f9a");
    const perplexity = view.getByLabelText("Perplexity account");
    expect(perplexity.textContent).toContain("Not connected");

    await fireEvent.click(within(perplexity).getByRole("button", { name: "Add key for Perplexity" }));
    const field = within(perplexity).getByLabelText("Perplexity API key") as HTMLInputElement;
    expect(field.type).toBe("password");
    expect(document.activeElement).toBe(field);
    await fireEvent.click(within(perplexity).getByRole("link", { name: "Get a Perplexity key" }));
    expect(onOpenUrl).toHaveBeenCalledWith("https://console.perplexity.ai/project/keys");

    await fireEvent.input(field, { target: { value: "pplx-rejected" } });
    await fireEvent.click(within(perplexity).getByRole("button", { name: "Save" }));
    expect(await within(perplexity).findByRole("alert")).toHaveProperty("textContent", "Perplexity API key was rejected");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    await fireEvent.input(field, { target: { value: "fake-pplx-key" } });
    await fireEvent.click(within(perplexity).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(perplexity).queryByLabelText("Perplexity API key")).toBeNull());
    expect(onSaveSearchKey.mock.calls).toEqual([["perplexity", "pplx-rejected"], ["perplexity", "fake-pplx-key"]]);

    // Replacing starts from an empty field; Escape abandons the edit without leaving Settings.
    await fireEvent.click(within(exa).getByRole("button", { name: "Replace Exa key" }));
    const replacement = within(exa).getByLabelText("Exa API key") as HTMLInputElement;
    expect(replacement.value).toBe("");
    await fireEvent.keyDown(replacement, { key: "Escape" });
    expect(within(exa).queryByLabelText("Exa API key")).toBeNull();
    expect(view.getByRole("region", { name: "Settings" }).hidden).toBe(false);

    await fireEvent.click(within(exa).getByRole("button", { name: "Remove Exa key" }));
    const confirmation = within(exa).getByRole("group", { name: "Remove the saved Exa key?" });
    await fireEvent.click(within(confirmation).getByRole("button", { name: "Remove key" }));
    expect(onRemoveSearchKey).toHaveBeenCalledWith("exa");
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

    const modelSelect = view.getByRole("combobox", { name: /Model/ }) as HTMLButtonElement;
    expect(modelSelect.value).toBe("");
    expect(modelSelect.textContent).toContain("Choose an OpenAI model");
    expect(view.getByText("This project used the removed CLI integration. Choose an available OpenAI model.")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Retry connections" })).toBeNull();
    await fireEvent.click(view.getByRole("button", { name: "Choose model" }));
    expect(document.activeElement).toBe(modelSelect);
    expect((view.getByRole("button", { name: "Discover problems" }) as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.submit(view.container.querySelector("form")!);
    expect(onSave).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();

    await pickModel(modelSelect, modelRefKey(DEFAULT_RUN_CONFIG.model));
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
    expect(view.getByText("Exa unavailable", { selector: ".connection-warning span" })).toBeTruthy();
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
    const info = view.getByRole("button", { name: "About Controlled" });
    await fireEvent.mouseEnter(info.parentElement!);
    expect(view.getByRole("tooltip").textContent).toContain("pauses for approval before research");
    expect(view.getByRole("tooltip").textContent).toContain("choose which problems become ideas");
    expect((view.getByRole("radio", { name: "Vibe" }) as HTMLInputElement).checked).toBe(true);
    await fireEvent.keyDown(info, { key: "Escape" });
    expect(view.queryByRole("tooltip")).toBeNull();
    await fireEvent.focusIn(info);
    expect(view.getByRole("tooltip")).toBeTruthy();
    await fireEvent.focusOut(info);
    expect(view.queryByRole("tooltip")).toBeNull();
  });

  test("keeps a clicked mode explanation open and dismisses a hovered one with Escape", async () => {
    const view = render(ScopeForm, { workspace: workspace(), busy: false, onSave: vi.fn(), onStart: vi.fn(), onRetry: vi.fn(), onPreviewWorkflow: vi.fn(), onStartWorkflow: vi.fn() });
    const info = view.getByRole("button", { name: "About Vibe" });
    await fireEvent.mouseEnter(info.parentElement!);
    await fireEvent.keyDown(document.body, { key: "Escape" });
    expect(view.queryByRole("tooltip")).toBeNull();

    info.focus();
    await fireEvent.click(info);
    await fireEvent.mouseLeave(info.parentElement!);
    expect(view.getByRole("tooltip").textContent).toContain("You can pause or stop at any time");
    await fireEvent.keyDown(info, { key: "Escape" });
    expect(view.queryByRole("tooltip")).toBeNull();
  });

  test.each([
    [["runConfig", "searchProvider"], "Search provider"],
    [["ideas", "reviewModel"], "Ideas model"],
  ])("reveals the field for preflight errors at %s after Start", async (path, label) => {
    const state = workspace();
    state.validation.exa = { valid: true };
    const onPreviewWorkflow = vi.fn(async (draft: WorkflowLaunchDraft) => ({
      type: "launch" as const, proposal: { ...draft,
        resolvedInstructions: { research: "r", ideas: "i", review: "v" }, instructionHashes: { research: "r", ideas: "i", review: "v" } },
      previewHash: "blocked", capabilityFingerprint: "fixture", minimumWork: { modelCalls: 1, searches: 0 },
      upperLimits: draft.limits, fieldErrors: [{ path: path as string[], code: "UNAVAILABLE", message: "This choice became unavailable." }], expiresAt: "2099-01-01T00:00:00.000Z",
    }));
    const view = render(ScopeForm, { workspace: state, busy: false, onSave: vi.fn(), onStart: vi.fn(), onRetry: vi.fn(), onPreviewWorkflow, onStartWorkflow: vi.fn() });
    await waitFor(() => expect(onPreviewWorkflow).toHaveBeenCalled());
    expect(view.queryByRole("alert")).toBeNull();
    expect(view.queryByRole("button", { name: "Review settings" })).toBeNull();
    await fireEvent.click(view.getByRole("button", { name: "Start" }));
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
    // Vibe (the default mode) shows the ideas model in the run panel, not in Advanced settings.
    await pickModel(view.getByLabelText("Ideas model"), modelRefKey(ideasModel));
    expect(view.getByLabelText("Ideas model").closest("aside")).toBeTruthy();
    if (researchMode === "explore-market") {
      await fireEvent.change(view.getByLabelText("Research depth"), { target: { value: "deep" } });
      await fireEvent.click(view.getByRole("button", { name: "Advanced settings" }));
      expect(view.queryByLabelText("Search coverage")).toBeNull();
      await fireEvent.change(view.getByLabelText("Search provider"), { target: { value: "perplexity" } });
    }
    if (researchMode === "known-problem") await fireEvent.click(view.getByRole("button", { name: "Advanced settings" }));
    await fireEvent.click(view.getByRole("button", { name: "Instructions" }));
    // Instructions show one stage at a time; each stage keeps its own text.
    for (const [stage, value] of [["Research", "Research context"], ["Ideas", "Generate carefully"], ["Review", "Check evidence"]] as const) {
      await fireEvent.click(view.getByRole("button", { name: stage }));
      await fireEvent.input(view.getByLabelText(`${stage} instructions`), { target: { value } });
    }
    await fireEvent.click(view.getByRole("button", { name: "Research" }));
    expect((view.getByLabelText("Research instructions") as HTMLTextAreaElement).value).toBe("Research context");
    await fireEvent.click(view.getByRole("button", { name: "Research scope" }));
    expect(view.queryByLabelText("Time limit")).toBeNull();
    await fireEvent.click(view.getByRole("button", { name: "Done" }));
    expect((view.getByLabelText("Ideas reasoning") as HTMLSelectElement).value).toBe("high");
    if (mode === "babysit") await fireEvent.click(view.getByRole("radio", { name: /Controlled/ }));
    await waitFor(() => expect(onPreviewWorkflow.mock.lastCall?.[0]).toMatchObject({
      purpose: researchMode === "known-problem" ? "known-problem" : "discovery", mode,
      brief: researchMode === "known-problem" ? "Approvals take too long" : "Parts sourcing",
      scope: { title: "Repair shops", audience: "Shops", domain: "Parts sourcing", riskEvaluationCriteria: "Low setup effort", offLimits: ["No hardware", "No migration"] },
      runConfig: { ...DEFAULT_RUN_CONFIG, ideaCount: 5, maxRunMinutes: DEFAULT_RUN_CONFIG.maxRunMinutes, researchMode, knownProblem: researchMode === "known-problem" ? "Approvals take too long" : "",
        ...(researchMode === "explore-market" ? { discoveryDepth: "deep", searchProvider: "perplexity" } : {}) },
      limits: { enforced: false },
      instructions: { research: "Research context", ideas: "Generate carefully", review: "Check evidence" },
      ...(mode === "vibe" ? { ideas: { model: ideasModel, reasoningEffort: "high", reviewModel: ideasModel, reviewReasoningEffort: "high" } } : {}),
    }));
    const expected = structuredClone(onPreviewWorkflow.mock.lastCall![0]);
    if (mode === "babysit") expect(expected.ideas).toBeUndefined();
    await fireEvent.click(view.getByRole("button", { name: "Advanced settings" }));
    await fireEvent.click(view.getByRole("button", { name: "Done" }));
    await fireEvent.click(view.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(onStartWorkflow).toHaveBeenCalledOnce());
    expect(onStartWorkflow.mock.calls[0]?.[0].proposal).toMatchObject(expected);
  });

  test("hides preview errors before Start and exposes retry after a real preview failure", async () => {
    const state = workspace();
    state.validation.exa = { valid: true };
    const onPreviewWorkflow = vi.fn().mockRejectedValue(new Error("Preview temporarily unavailable"));
    const view = render(ScopeForm, { workspace: state, busy: false, onSave: vi.fn(), onStart: vi.fn(), onRetry: vi.fn(), onPreviewWorkflow, onStartWorkflow: vi.fn() });
    await waitFor(() => expect(onPreviewWorkflow).toHaveBeenCalledTimes(1));
    expect(view.queryByText("Preview temporarily unavailable")).toBeNull();
    expect(view.queryByRole("button", { name: "Retry preview" })).toBeNull();
    await fireEvent.click(view.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(view.getByText("Preview temporarily unavailable")).toBeTruthy());
    expect(view.getByRole("button", { name: "Retry preview" })).toBeTruthy();
    await fireEvent.click(view.getByRole("button", { name: "Retry preview" }));
    await waitFor(() => expect(onPreviewWorkflow.mock.calls.length).toBeGreaterThan(1));
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
    onRefreshNative: vi.fn(), onLogoutNative: vi.fn(), onSaveSearchKey: vi.fn(), onRemoveSearchKey: vi.fn(), onOpenUrl: vi.fn(),
    onOpenData: vi.fn(), onOpenLogs: vi.fn(), onRestore: vi.fn(), onDelete: vi.fn(), ...props,
  });
  return view;
}
