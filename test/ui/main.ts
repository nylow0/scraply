import "@fontsource-variable/plus-jakarta-sans";
import "../../src/renderer/app.css";
import { mount } from "svelte";
import App from "../../src/renderer/App.svelte";
import { createScraplyApi } from "../../src/shared/scraply-api";
import { DEFAULT_RUN_CONFIG, type Thread } from "../../src/shared/schemas";
import { IPC_CHANNELS, RemoveSearchKeySchema, SaveScopeSchema, SaveRunConfigSchema, SaveSearchKeySchema, type WorkspaceState } from "../../src/shared/ipc";
import { CommandWorkflowRequestSchema, PreviewWorkflowRequestSchema, type WorkflowDetail } from "../../src/shared/workflow-contracts";
import { GetRunTraceRequestSchema, GetRunTraceStepRequestSchema, type RunTrace, type RunTraceStepDetail } from "../../src/shared/run-trace";

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

if (params.has("unassessed") && state.activeThreadId) {
  const extras = Math.min(20, Math.max(1, Number(params.get("unassessed") || 5)));
  state.runConfig = DEFAULT_RUN_CONFIG;
  state.scope = { title: "Candidate limit fixture", audience: "Operators", domain: "Filing", observations: "", offLimits: [] };
  state.threads = state.threads.map((thread) => thread.id === state.activeThreadId ? { ...thread, status: "solutions-ready" } : thread);
  state.rejectedProblemCandidates = Array.from({ length: extras }, (_, index) => ({
    id: `unassessed-${index}`, statement: `Operators repeat filing step ${index + 1}`,
    reason: "Not assessed: this standard-depth run assesses up to 4 problem candidates.", disposition: "not-assessed",
    candidate: {
      statement: `Operators repeat filing step ${index + 1}`, whyItPersists: "Their systems do not share state.",
      affected: "Operators", scaleEstimate: "Frequency has not been measured", scaleBasisFactorId: null,
      factorIds: [`fixture-factor-${index}`], alternativeExplanations: ["An existing export may suffice"],
      unknowns: ["Workflow frequency"], intendedBuyerEvidenceFactorIds: [], evidenceGap: "Needs evidence assessment",
    },
  }));
}

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
  if (["completed-handoff", "acknowledged-restart"].includes(params.get("phase") ?? "")) {
    guidedProgress.summary.state = "paused";
    guidedProgress.summary.canResume = true;
    guidedProgress.summary.budget.modelCalls.uncertain = 50;
    guidedProgress.summary.budget.searches.uncertain = 24;
  }
  if (params.get("activity") === "long") {
    guidedProgress.activity = Array.from({ length: 16 }, (_, index) => ({ id: `long-activity-${index}`,
      message: `Reading source packet ${index + 1}: checking firsthand accounts of repair shops coordinating warranty approvals, supplier follow-ups, uncertain parts delivery windows, and customer expectations across locations.`,
      stage: "extracting", createdAt: new Date(Date.parse(now) + index * 60_000).toISOString() }));
  }
  state.activeWorkflow = guidedProgress.summary;
  state.threads = state.threads.map(thread => thread.id === state.activeThreadId ? { ...thread, status: params.get("phase") === "failed" ? "failed" : "discovery-running" } : thread);
}

let progressReads = 0;
const traceFixture: RunTrace | null = params.has("trace") && state.activeThreadId ? {
  runId: "fixture-trace", threadId: state.activeThreadId, sessionId: guidedProgress?.summary.sessionId ?? null,
  status: params.get("trace") === "live" ? "running" : "completed", purpose: "discovery", startedAt: now,
  finishedAt: params.get("trace") === "live" ? null : "2026-09-23T12:08:00.000Z", live: params.get("trace") === "live",
  warnings: ["Older searches are linked from their saved query and parameters. Missing usage remains unknown."],
  metrics: {
    factors: 8, totalSources: 5, evidenceMix: { firsthand: 2, vendor: 6 }, audienceFit: { "intended-buyer": 2, general: 6 },
    sourceMix: { forum: 2, vendor: 3 }, qualifyingObservations: 2, qualifyingPerAssessedCandidate: 1,
    candidateFunnel: { total: 5, assessed: 2, confirmed: 1, insufficient: 1, dropped: 1, notAssessed: 2, userAsserted: 0 },
    confirmationRate: 0.5, coverage: { kind: "phases", groups: [{ id: "domain", factors: 4, problems: 2, confirmed: 0 }, { id: "audience", factors: 4, problems: 3, confirmed: 1 }] },
    modelCalls: 3, searches: 1, wallTimeMs: 480_000, modelTimeMs: 275_000, interruptionTimeMs: 45_000, interruptions: 1, ideas: 3, acceptedIdeas: 1,
  },
  steps: [
    { id: "fixture-search", kind: "search", stage: "search", label: "Search for deposit problems", phase: "audience", status: "completed", startedAt: now, finishedAt: "2026-09-23T12:00:06.000Z", durationMs: 6_000, attempts: [], prompt: null,
      search: { key: "fixture-search-key", query: "bakery custom orders deposit delays", intent: "complaints", reason: "Find firsthand accounts of missed deposits and lost custom orders.", expectedSourceType: "community", provider: "exa", route: null, parameters: { query: "bakery custom orders deposit delays", numResults: 5 }, status: "completed",
        results: [{ sourceId: "fixture-source-1", title: "Keeping track of custom orders", url: "https://example.test/community/custom-orders", sourceClass: "forum", factsKept: 2 }, { sourceId: "fixture-source-2", title: "Bakery order management", url: "https://example.test/vendor/orders", sourceClass: "vendor", factsKept: 6 }] } },
    { id: "fixture-reading", kind: "model", stage: "factor-harvest", label: "Read source observations", phase: "audience", status: "succeeded", startedAt: "2026-09-23T12:00:07.000Z", finishedAt: "2026-09-23T12:04:42.000Z", durationMs: 275_000,
      prompt: { filename: "workflow-v2-factor-harvest.md", source: "bundled", sha256: "8b6cbf64fe4e172df675659b7c3ad28e9e3d42384658a8a9e5a98372b7357736" }, search: null,
      attempts: [{ id: "fixture-attempt-1", status: "interrupted", model: "gpt-6-luna", effort: "high", provider: "openai-subscription", startedAt: "2026-09-23T12:00:07.000Z", finishedAt: "2026-09-23T12:00:52.000Z", durationMs: 45_000, inputTokens: null, outputTokens: null, reasoningTokens: null, costUsd: null, errorCode: "UNKNOWN_COMPLETION", message: "The application restarted before completion was saved. The user explicitly retried this step.", reasoningSummary: null },
        { id: "fixture-attempt-2", status: "succeeded", model: "gpt-6-luna", effort: "high", provider: "openai-subscription", startedAt: "2026-09-23T12:00:53.000Z", finishedAt: "2026-09-23T12:04:42.000Z", durationMs: 229_000, inputTokens: 12_450, outputTokens: 2_080, reasoningTokens: 680, costUsd: null, errorCode: null, message: null, reasoningSummary: "Checked who described each problem and kept the source's own wording." }] },
    { id: "fixture-verdict", kind: "model", stage: "problem-verdict", label: "Assess deposit friction", phase: "audience", status: "succeeded", startedAt: "2026-09-23T12:04:43.000Z", finishedAt: "2026-09-23T12:06:00.000Z", durationMs: 77_000,
      prompt: { filename: "workflow-v2-problem-kill.md", source: "overridden", sha256: "6c94a4ee39e2c5a67cb8dc0da3be5e055b7ee5a8fa20baef7be0b276fbc73d79" }, search: null, attempts: [] },
  ],
  candidates: [
    { id: "fixture-candidate-1", statement: "Bakery owners lose custom orders when deposits arrive late", state: "confirmed", reason: "Two firsthand accounts describe the same order and deposit failure.", derived: false, factorIds: ["fixture-fact-1", "fixture-fact-2"], qualifyingObservations: 2, independentSources: 2,
      assessments: [{ factorId: "fixture-fact-1", sourceRole: "firsthand", audienceFit: "intended-buyer", independentSourceKey: "bakery-owner-1", reason: "The owner describes their own missed order." }], candidate: { contraryEvidence: { summary: "Small order volumes can be managed with a shared sheet." } } },
    { id: "fixture-candidate-2", statement: "Existing order tools fail to support every local payment method", state: "insufficient", reason: "Only a vendor claim was saved. No affected buyer described this limitation.", derived: false, factorIds: ["fixture-fact-3"], qualifyingObservations: 0, independentSources: 0, assessments: [], candidate: null },
    { id: "fixture-candidate-3", statement: "Automatic reminders would prevent every missed deposit", state: "dropped", reason: "The source supports late deposits, but not the proposed cause.", derived: true, factorIds: [], qualifyingObservations: 0, independentSources: 0, assessments: [], candidate: null },
    { id: "fixture-candidate-4", statement: "Staff re-enter custom orders from messages", state: "not-assessed", reason: "No saved verdict was found for this candidate.", derived: true, factorIds: [], qualifyingObservations: 0, independentSources: 0, assessments: [], candidate: null },
    { id: "fixture-candidate-5", statement: "Customers ask for deposits to be split across payments", state: "not-assessed", reason: "No saved verdict was found for this candidate.", derived: true, factorIds: [], qualifyingObservations: 0, independentSources: 0, assessments: [], candidate: null },
  ],
} : null;
if (traceFixture) {
  state.latestResearchRun = { runId: traceFixture.runId, status: traceFixture.live ? "running" : "completed", problemId: null,
    codexCalls: traceFixture.metrics.modelCalls, searches: traceFixture.metrics.searches, projectedCodexCalls: 3, projectedSearches: 1, lastActivity: "Saved trace fixture", workflowVersion: 2 };
  if (params.get("trace") === "empty") {
    traceFixture.steps = []; traceFixture.candidates = []; traceFixture.warnings = [];
    traceFixture.metrics = { ...traceFixture.metrics, factors: 0, totalSources: 0, evidenceMix: {}, audienceFit: {}, sourceMix: {}, qualifyingObservations: 0,
      qualifyingPerAssessedCandidate: null, confirmationRate: null, candidateFunnel: { total: 0, assessed: 0, confirmed: 0, insufficient: 0, dropped: 0, notAssessed: 0, userAsserted: 0 },
      coverage: { kind: "phases", groups: [] }, modelCalls: 0, searches: 0, wallTimeMs: 0, modelTimeMs: 0, interruptionTimeMs: 0, interruptions: 0, ideas: 0, acceptedIdeas: 0 };
  }
}

function traceStepDetail(stepId: string): RunTraceStepDetail {
  const step = traceFixture?.steps.find((item) => item.id === stepId);
  if (!traceFixture || !step) throw new Error("No saved step exists in this trace fixture.");
  return {
    runId: traceFixture.runId, step, inputs: { scope: { audience: "Independent bakery owners", domain: "Custom orders and deposits" } },
    output: step.kind === "search" ? { results: step.search?.results } : { factsKept: 8 }, evidence: [],
    searches: step.search ? [step.search] : [], candidates: step.id === "fixture-verdict" ? traceFixture.candidates.slice(0, 2) : [],
    facts: step.id === "fixture-reading" ? [
      { id: "fixture-fact-1", sourceId: "fixture-source-1", subject: "Bakery owner", behavior: "Lost a custom order after waiting for a deposit", quote: "I kept the order in messages, and by the time they paid the deposit I had filled that weekend.", sourceRole: "firsthand", audienceFit: "intended-buyer", kept: true, reason: "The affected owner describes an actual missed order." },
      { id: null, sourceId: "fixture-source-2", subject: "Order management vendor", behavior: "Claims reminders remove deposit delays", quote: "Never lose another custom order with automated reminders.", sourceRole: "vendor", audienceFit: "general", kept: false, reason: "This claim does not describe a saved customer's experience." },
    ] : [],
    events: step.id === "fixture-reading" ? [{ type: "interrupted", createdAt: "2026-09-23T12:00:52.000Z", payload: { message: "Application restart left provider completion unknown." } }] : [],
  };
}

const fixtureApi = createScraplyApi({
  async invoke<T>(channel: string, payload?: unknown): Promise<T> {
    let result: unknown;
    switch (channel) {
      case IPC_CHANNELS.GET_WORKSPACE: result = state; break;
      case IPC_CHANNELS.GET_RUN_TRACE: {
        const request = GetRunTraceRequestSchema.parse(payload);
        if (!traceFixture || request.runId !== traceFixture.runId) throw new Error("No trace fixture is selected. Add ?trace=1 to the URL.");
        result = { ok: true, data: traceFixture }; break;
      }
      case IPC_CHANNELS.GET_RUN_TRACE_STEP: {
        const request = GetRunTraceStepRequestSchema.parse(payload);
        if (request.runId !== traceFixture?.runId) throw new Error("No saved trace exists for this run.");
        result = { ok: true, data: traceStepDetail(request.stepId) }; break;
      }
      case IPC_CHANNELS.COMMAND_WORKFLOW: {
        const request = CommandWorkflowRequestSchema.parse(payload);
        const supported = request.action.type === "reassess-problems" && params.get("phase") === "audience-recovery"
          || request.action.type === "resume" && ["completed-handoff", "acknowledged-restart"].includes(params.get("phase") ?? "");
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
