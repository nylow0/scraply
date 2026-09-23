import "@fontsource-variable/plus-jakarta-sans";
import "../../src/renderer/app.css";
import { mount } from "svelte";
import App from "../../src/renderer/App.svelte";
import { createScraplyApi } from "../../src/shared/scraply-api";
import { DEFAULT_RUN_CONFIG, type Thread } from "../../src/shared/schemas";
import { IPC_CHANNELS, SaveScopeSchema, SaveRunConfigSchema, type WorkspaceState } from "../../src/shared/ipc";
import { PreviewWorkflowRequestSchema } from "../../src/shared/workflow-contracts";

// This standalone renderer has no Electron bridge or network provider. URL parameters
// select deterministic UI scenarios without touching the user's projects or credentials.
const params = new URLSearchParams(location.search);
const count = Math.min(200, Math.max(0, Number(params.get("history") ?? 18)));
const active = Math.min(count - 1, Math.max(0, Number(params.get("active") ?? 0)));
const now = "2026-09-23T12:00:00.000Z";
const names = ["New research", "Repair shop approvals", "Independent educator tools", "Small-team developer tools", "Warranty handoffs", "Parts sourcing"];
const threads: Thread[] = Array.from({ length: count }, (_, i) => ({
  id: `fixture-${i}`, title: i === 2 && params.has("long") ? "Understanding how independent repair businesses coordinate warranty approvals, supplier follow-ups, parts availability, and customer expectations across multiple locations" : names[i] ?? `Research project ${i + 1}`,
  status: i === active ? "configuring" : i === count - 1 ? "failed" : i === count - 2 ? "discovery-running" : i % 2 ? "problems-ready" : "solutions-ready",
  createdAt: now, updatedAt: new Date(Date.parse(now) - i * 60_000).toISOString(),
}));
let state: WorkspaceState = {
  validation: {
    exa: { valid: params.get("connection") !== "offline", ...(params.get("connection") === "offline" ? { error: "Search provider is disconnected" } : {}) },
    perplexity: { valid: true },
    native: { available: true, connected: true, accounts: [{ providerId: "openai-subscription" }] }, setupComplete: true,
  },
  threads, activeThreadId: threads[active]?.id ?? null, messages: [], scope: null, runConfig: null,
  models: [DEFAULT_RUN_CONFIG.model, { providerId: "openai-subscription", modelId: "gpt-6-astra" }],
  modelOptions: [DEFAULT_RUN_CONFIG.model, { providerId: "openai-subscription", modelId: "gpt-6-astra" }].map((model) => ({
    ...model, displayName: model.modelId, defaultReasoningEffort: "medium",
    reasoningEfforts: [{ id: "low", description: "Less reasoning" }, { id: "medium", description: "Balanced reasoning" }, { id: "high", description: "More reasoning" }],
  })),
  modelCatalog: { models: [DEFAULT_RUN_CONFIG.model], favorites: [] }, presets: [], problemCandidates: [], rejectedProblemCandidates: [],
  researchRequests: [], researchFindings: [], solutions: [], latestResearchRun: null, pendingRuns: [],
};

const fixtureApi = createScraplyApi({
  async invoke<T>(channel: string, payload?: unknown): Promise<T> {
    let result: unknown;
    switch (channel) {
      case IPC_CHANNELS.GET_WORKSPACE: result = state; break;
      case IPC_CHANNELS.GET_VALIDATION: result = state.validation; break;
      case IPC_CHANNELS.SELECT_THREAD: {
        const { threadId } = payload as { threadId: string };
        state = { ...state, activeThreadId: threadId, scope: null, runConfig: null };
        result = state; break;
      }
      case IPC_CHANNELS.CREATE_THREAD: {
        const thread = { id: `fixture-new-${state.threads.length}`, title: "New research", status: "configuring" as const, createdAt: now, updatedAt: now };
        state = { ...state, threads: [thread, ...state.threads], activeThreadId: thread.id, scope: null, runConfig: null };
        result = { workspace: state }; break;
      }
      case IPC_CHANNELS.ARCHIVE_THREAD: {
        const { threadId, archived } = payload as { threadId: string; archived: boolean };
        state = { ...state, threads: state.threads.map((thread) => thread.id === threadId ? { ...thread, archivedAt: archived ? now : null } : thread) };
        if (archived && state.activeThreadId === threadId) state.activeThreadId = state.threads.find((thread) => !thread.archivedAt)?.id ?? null;
        result = state; break;
      }
      case IPC_CHANNELS.SAVE_SCOPE: state = { ...state, scope: SaveScopeSchema.parse(payload).scope }; result = state; break;
      case IPC_CHANNELS.SAVE_RUN_CONFIG: state = { ...state, runConfig: SaveRunConfigSchema.parse(payload).config }; result = state; break;
      case IPC_CHANNELS.PREVIEW_WORKFLOW: {
        const request = PreviewWorkflowRequestSchema.parse(payload);
        if (request.type !== "launch") throw new Error("Only launch previews are available in the UI fixture.");
        const { draft } = request;
        const minimum = draft.purpose === "known-problem" ? { modelCalls: 4, searches: 0 } : { modelCalls: draft.mode === "vibe" ? 44 : 32, searches: 16 };
        result = { ok: true, data: {
          type: "launch", proposal: { ...draft, resolvedInstructions: { research: "Fixture research", ideas: "Fixture ideas", review: "Fixture review" }, instructionHashes: { research: "r", ideas: "i", review: "v" } },
          previewHash: JSON.stringify(draft), capabilityFingerprint: "fixture", minimumWork: minimum, upperLimits: draft.limits,
          fieldErrors: [
            ...(draft.limits.maxModelCalls < minimum.modelCalls ? [{ path: ["limits", "maxModelCalls"], code: "BUDGET_TOO_SMALL", message: `Allow at least ${minimum.modelCalls} model calls.` }] : []),
            ...(draft.limits.maxSearches < minimum.searches ? [{ path: ["limits", "maxSearches"], code: "BUDGET_TOO_SMALL", message: `Allow at least ${minimum.searches} searches.` }] : []),
          ], expiresAt: "2099-01-01T00:00:00.000Z",
        } }; break;
      }
      case IPC_CHANNELS.RETRY_CONNECTION: result = undefined; break;
      default: throw new Error(`UI fixture does not execute ${channel}. No research was launched.`);
    }
    return structuredClone(result) as T;
  },
  onAppCommand: () => () => {},
  onBackendEvent: () => () => {},
});
Object.assign(window, { scraply: fixtureApi });
const target = document.getElementById("app");
if (target) mount(App, { target });
