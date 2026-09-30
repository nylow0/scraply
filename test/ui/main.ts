import "@fontsource-variable/plus-jakarta-sans";
import "../../src/renderer/app.css";
import { mount } from "svelte";
import App from "../../src/renderer/App.svelte";
import { createScraplyApi } from "../../src/shared/scraply-api";
import { DEFAULT_RUN_CONFIG, type Thread } from "../../src/shared/schemas";
import { IPC_CHANNELS, RemoveSearchKeySchema, SaveScopeSchema, SaveRunConfigSchema, SaveSearchKeySchema, type WorkspaceState } from "../../src/shared/ipc";
import { CommandWorkflowRequestSchema, PreviewWorkflowRequestSchema, type WorkflowDetail } from "../../src/shared/workflow-contracts";

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
const noSearch = params.get("search") === "none";
const connectedNative: WorkspaceState["validation"]["native"] = {
  available: true, connected: true, accounts: [{ providerId: "openai-subscription", email: "dany@example.test", plan: "pro" }],
};
let state: WorkspaceState = {
  validation: {
    exa: noSearch ? { valid: false, error: "Exa key missing" }
      : { valid: params.get("connection") !== "offline", maskedKey: "••••3f9a", ...(params.get("connection") === "offline" ? { error: "Search provider is disconnected" } : {}) },
    perplexity: noSearch ? { valid: false, error: "Perplexity key missing" } : { valid: true, maskedKey: "••••77c1" },
    native: params.get("account") === "signed-out" ? { available: true, connected: false, accounts: [] } : connectedNative,
    setupComplete: !noSearch && params.get("account") !== "signed-out",
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

const guidedProgress: WorkflowDetail | null = params.get("progress") === "guided" && state.activeThreadId ? {
  summary: {
    sessionId: "fixture-guided", threadId: state.activeThreadId, purpose: "discovery", mode: "vibe", targetKind: "per-problem",
    state: "running", outcome: null, revision: 1, activeSnapshotId: null, selectedProblemIds: [],
    ideaTargetReady: false,
    counts: { requested: 0, attempted: 0, validated: 0, accepted: 0, duplicate: 0, unresolved: 0, failed: 0, missing: 0, existing: 0, addedBySession: 0, total: 0 },
    limits: { enforced: false, maxMinutes: 90, maxModelCalls: 72, maxSearches: 38 },
    budget: { modelCalls: { limit: 72, spent: 1, reserved: 50, uncertain: 0 }, searches: { limit: 38, spent: 0, reserved: 24, uncertain: 0 }, remainingMs: 89 * 60_000 },
    currentStage: "discovery", stopReason: null, startedAt: now, finishedAt: null,
  },
  tasks: [{ id: "fixture-discovery", parentItemId: null, kind: "discovery", scopeKey: "initial-research", state: "running", createdAt: now, finishedAt: null }],
  activity: [
    { id: "1", message: "Model call completed", stage: "searching", createdAt: now },
    { id: "2", message: "Searching Perplexity: repair shop warranty approval delays", stage: "searching", createdAt: now },
    { id: "3", message: "Found 8 sources for: repair shop warranty approval delays", stage: "searching", createdAt: now },
    { id: "4", message: "Model request accepted", stage: "extracting", createdAt: now },
  ],
  nextCursor: null,
} : null;
if (guidedProgress) {
  if (params.get("phase") === "ideas") {
    guidedProgress.summary.ideaTargetReady = true;
    guidedProgress.summary.selectedProblemIds = ["problem-1", "problem-2"];
    guidedProgress.summary.counts.requested = 6;
    guidedProgress.summary.counts.missing = 6;
    guidedProgress.summary.currentStage = "generate-ideas";
  }
  if (params.get("phase") === "failed") {
    guidedProgress.summary.state = "finished";
    guidedProgress.summary.outcome = "failed";
    guidedProgress.summary.stopReason = "Search provider is unavailable.";
    guidedProgress.summary.finishedAt = now;
    guidedProgress.tasks[0]!.state = "failed";
  }
  if (params.get("phase") === "audience-recovery") {
    guidedProgress.summary.state = "finished";
    guidedProgress.summary.outcome = "no-qualifying-ideas";
    guidedProgress.summary.finishedAt = now;
    guidedProgress.tasks[0]!.state = "succeeded";
    guidedProgress.tasks[0]!.canReassessProblems = true;
  }
  if (params.get("phase") === "completed-handoff") {
    guidedProgress.summary.state = "paused";
    guidedProgress.summary.canResume = true;
    guidedProgress.summary.budget.modelCalls.uncertain = 50;
    guidedProgress.summary.budget.searches.uncertain = 24;
  }
  state.activeWorkflow = guidedProgress.summary;
  state.threads = state.threads.map(thread => thread.id === state.activeThreadId ? { ...thread, status: params.get("phase") === "failed" ? "failed" : "discovery-running" } : thread);
}

let progressReads = 0;
const fixtureApi = createScraplyApi({
  async invoke<T>(channel: string, payload?: unknown): Promise<T> {
    let result: unknown;
    switch (channel) {
      case IPC_CHANNELS.GET_WORKSPACE: result = state; break;
      case IPC_CHANNELS.COMMAND_WORKFLOW: {
        const request = CommandWorkflowRequestSchema.parse(payload);
        const supported = request.action.type === "reassess-problems" && params.get("phase") === "audience-recovery"
          || request.action.type === "resume" && params.get("phase") === "completed-handoff";
        if (!guidedProgress || !supported) {
          throw new Error("This fixture only simulates saved discovery recovery.");
        }
        guidedProgress.summary.state = "running";
        guidedProgress.summary.outcome = null;
        guidedProgress.summary.finishedAt = null;
        guidedProgress.summary.revision += 1;
        guidedProgress.tasks[0]!.state = "running";
        guidedProgress.tasks[0]!.canReassessProblems = false;
        result = { ok: true, data: { sessionId: guidedProgress.summary.sessionId,
          revision: guidedProgress.summary.revision, summary: guidedProgress.summary } };
        break;
      }
      case IPC_CHANNELS.GET_WORKFLOW:
        if (guidedProgress && params.has("live") && ++progressReads === 2) {
          guidedProgress.activity?.push({ id: "5", message: "12 observations from 8 sources", stage: "extracting", createdAt: now });
        }
        result = { ok: true, data: guidedProgress }; break;
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
            ...(draft.limits.enforced !== false && draft.limits.maxModelCalls < minimum.modelCalls ? [{ path: ["limits", "maxModelCalls"], code: "BUDGET_TOO_SMALL", message: `Allow at least ${minimum.modelCalls} model calls.` }] : []),
            ...(draft.limits.enforced !== false && draft.limits.maxSearches < minimum.searches ? [{ path: ["limits", "maxSearches"], code: "BUDGET_TOO_SMALL", message: `Allow at least ${minimum.searches} searches.` }] : []),
          ], expiresAt: "2099-01-01T00:00:00.000Z",
        } }; break;
      }
      case IPC_CHANNELS.RETRY_CONNECTION: result = undefined; break;
      // Sign-in succeeds at once; nothing leaves the page.
      case IPC_CHANNELS.NATIVE_LOGIN_START: result = { loginId: "fixture-login", providerId: "openai-subscription", method: "browser" }; break;
      case IPC_CHANNELS.NATIVE_LOGIN_COMPLETE:
        state = { ...state, validation: { ...state.validation, native: connectedNative } };
        result = { pending: false, workspace: state }; break;
      case IPC_CHANNELS.OPEN_EXTERNAL_URL: result = undefined; break;
      // Keys containing "invalid" are rejected the way a provider would; others save after a short check.
      case IPC_CHANNELS.SAVE_SEARCH_KEY: {
        const { provider, apiKey } = SaveSearchKeySchema.parse(payload);
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (apiKey.includes("invalid")) {
          result = { ok: false, error: { code: "validation_error", message: `${provider === "exa" ? "Exa" : "Perplexity"} API key was rejected` } };
          break;
        }
        state = { ...state, validation: { ...state.validation, [provider]: { valid: true, maskedKey: `••••${apiKey.slice(-4)}` } } };
        result = { ok: true, data: state }; break;
      }
      case IPC_CHANNELS.REMOVE_SEARCH_KEY: {
        const { provider } = RemoveSearchKeySchema.parse(payload);
        state = { ...state, validation: { ...state.validation, [provider]: { valid: false, error: `${provider === "exa" ? "Exa" : "Perplexity"} key missing` } } };
        result = { ok: true, data: state }; break;
      }
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
