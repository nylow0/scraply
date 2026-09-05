import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { describe, expect, test, vi } from "vitest";
import ScopeForm from "../../src/renderer/components/ScopeForm.svelte";
import type { WorkspaceState } from "../../src/shared/ipc";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";

describe("ScopeForm search provider selection", () => {
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
    expect(onSave.mock.calls[0]?.[1]).toMatchObject({ searchProvider: "perplexity" });
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

    await fireEvent.click(view.getByRole("button", { name: "Connect OpenAI" }));
    expect(connect).toHaveBeenCalledWith("openai-subscription");

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
});

function workspace(): WorkspaceState {
  const now = "2026-08-28T00:00:00.000Z";
  return {
    validation: {
      exa: { valid: false, error: "Exa unavailable" },
      perplexity: { valid: true },
      codex: { detected: true, compatible: true, authenticated: true },
      native: { available: false, connected: false, accounts: [] },
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
