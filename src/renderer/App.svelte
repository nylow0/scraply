<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import type { NativeLoginStartResult, ResearchEvent, SolutionView, WorkspaceState } from "../shared/ipc";
  import type { ExplorationPurpose, ModelRef } from "../shared/schemas";
  import type { ResearchReplacement, ResearchRequestDraft } from "../shared/research-revisions";
  import {
    PreviewWorkflowResultSchema,
    type WorkflowAction, type WorkflowDetail, type WorkflowLaunchDraft,
    type IdeaConversation as IdeaConversationView, type SubmitIdeaTurnRequest,
  } from "../shared/workflow-contracts";
  import type { z } from "zod";
  import { readResearchDefaults } from "./lib/research-defaults";
  import DesktopBar from "./components/DesktopBar.svelte";
  import Icon from "./components/Icon.svelte";
  import Settings from "./components/Settings.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import ScopeForm from "./components/ScopeForm.svelte";
  import ProblemCheckpoint from "./components/ProblemCheckpoint.svelte";
  import ResearchArchive from "./components/ResearchArchive.svelte";
  import SetupArchive from "./components/SetupArchive.svelte";
  import SolutionWorkspace from "./components/SolutionWorkspace.svelte";
  import OpportunityProgress from "./components/OpportunityProgress.svelte";
  import WorkflowTabs, { type WorkflowStep } from "./components/WorkflowTabs.svelte";
  import RunUsage from "./components/RunUsage.svelte";
  import VibeProgress from "./components/VibeProgress.svelte";
  import ResearchRevisions from "./components/ResearchRevisions.svelte";

  type Feedback = { text: string; tone: "error" | "info"; source?: "workspace-load" };
  type WorkspaceResult = { workspace: WorkspaceState };
  type ResearchExportResult = { cancelled: true } | { cancelled: false; file: string };
  type IdeasExportResult = { cancelled: true } | { cancelled: false; directory: string; files: string[] };
  type WorkflowPreview = z.infer<typeof PreviewWorkflowResultSchema>;

  let workspace = $state<WorkspaceState | null>(null);
  let loading = $state(true);
  let busy = $state(false);
  let feedback = $state<Feedback | null>(null);
  let deletingThreadId = $state<string | null>(null);
  let latestEvent = $state<ResearchEvent | null>(null);
  let workflowDetail = $state<WorkflowDetail | null>(null);
  let conversation = $state<IdeaConversationView | null>(null);
  let conversationIdeaId = $state<string | null>(null);
  let conversationLoading = $state(false);
  let conversationError = $state<string | null>(null);
  let ideaFocused = $state(false);
  let workflowLoadEpoch = 0;
  let conversationLoadEpoch = 0;
  let reviewSelection = $state(false);
  let activeStep = $state<WorkflowStep>("setup");
  let editingScopeThreadId = $state<string | null>(null);
  let nativeLogin = $state<NativeLoginStartResult | null>(null);
  let nativeLoginEpoch = 0;
  let settings: Settings | undefined;
  let settingsOpen = $state(false);
  let sidebarVisible = $state(true);
  let narrowViewport = $state(typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 720px)").matches);
  let mobileSidebarOpen = $state(false);
  let navigationOpen = $derived(narrowViewport ? mobileSidebarOpen : sidebarVisible);
  function toggleNavigation() {
    if (narrowViewport) mobileSidebarOpen = !mobileSidebarOpen;
    else sidebarVisible = !sidebarVisible;
  }
  function closeMobileNavigation() {
    mobileSidebarOpen = false;
    void tick().then(() => document.getElementById("navigation-toggle")?.focus());
  }
  type NavigationTarget = { threadId: string; step: WorkflowStep; settings: boolean };
  let navigation = $state<NavigationTarget[]>([]);
  let navigationIndex = $state(-1);
  let traversingHistory = false;
  let backIndex = $derived(findHistoryIndex(-1));
  let forwardIndex = $derived(findHistoryIndex(1));
  $effect(() => {
    const route = { threadId: workspace?.activeThreadId, step: activeStep, settings: settingsOpen };
    if (loading || busy || !route.threadId) return;
    untrack(() => {
      if (traversingHistory) return;
      const previous = navigation[navigationIndex];
      if (previous && previous.threadId === route.threadId && previous.step === route.step && previous.settings === route.settings) return;
      navigation = [...navigation.slice(0, navigationIndex + 1), { ...route, threadId: route.threadId! }];
      navigationIndex = navigation.length - 1;
    });
  });
  function findHistoryIndex(direction: -1 | 1): number {
    // Archived and deleted research can leave gaps in either direction.
    for (let index = navigationIndex + direction; index >= 0 && index < navigation.length; index += direction) {
      const route = navigation[index];
      if (workspace?.threads.some((thread) => thread.id === route?.threadId && !thread.archivedAt)) return index;
    }
    return -1;
  }
  async function navigateHistory(direction: -1 | 1) {
    const index = direction === -1 ? backIndex : forwardIndex;
    const route = navigation[index];
    if (!route || !workspace || busy || traversingHistory) return;
    traversingHistory = true;
    try {
      if (route.threadId !== workspace.activeThreadId) await selectThread(route.threadId);
      if (workspace?.activeThreadId !== route.threadId) return;
      activeStep = route.step; settingsOpen = route.settings; navigationIndex = index;
      await tick();
    } finally { traversingHistory = false; }
  }
  async function discardIdea(ideaId: string, discarded: boolean) {
    const threadId = workspace?.activeThreadId;
    if (threadId) await action(async () => setWorkspace(await window.scraply.discardIdea(threadId, ideaId, discarded)));
  }
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  let reconcilePending = false;
  let loadEpoch = 0;
  let workspaceInFlight = false;
  let progressMeasureId = 0;
  let clockNow = $state(Date.now());
  let progressReceivedAt = $state(Date.now());
  let activeThread = $derived(workspace?.threads.find((item) => item.id === workspace?.activeThreadId) ?? null);
  let activeRun = $derived(workspace?.latestResearchRun ?? null);
  let activeWorkflow = $derived(workspace?.activeWorkflow ?? null);
  let appliedResearchSnapshotId = $derived(activeWorkflow?.activeSnapshotId && workspace?.researchRequests.some((request) => request.appliedSnapshotId === activeWorkflow.activeSnapshotId)
    ? activeWorkflow.activeSnapshotId : null);
  type RuntimeProgress = {
    stage?: string;
    modelState?: "waiting" | "dispatched" | "accepted" | null;
    elapsedMs?: number;
    operationStartedAt?: string;
    operationElapsedMs?: number;
    lastSuccessfulCheckpoint?: string | null;
  };
  let runtimeProgress = $derived((activeRun ?? {}) as RuntimeProgress);
  let clockDelta = $derived(["queued", "running"].includes(activeRun?.status ?? "") ? Math.max(0, clockNow - progressReceivedAt) : 0);
  let visibleElapsedMs = $derived((runtimeProgress.operationElapsedMs ?? runtimeProgress.elapsedMs) === undefined ? undefined
    : (runtimeProgress.operationElapsedMs ?? runtimeProgress.elapsedMs ?? 0) + clockDelta);
  let elapsedStatus = $derived(elapsedLabel(visibleElapsedMs, runtimeProgress.operationElapsedMs === undefined));
  let runActivity = $derived(latestEvent?.type === "run-progress" && latestEvent.runId === activeRun?.runId
    ? latestEvent.message
    : activeRun?.lastActivity ?? "Preparing the next provider call...");
  // Local-only override: lets the user reopen the scope form from a failed run without touching server state.
  let editingScope = $derived(editingScopeThreadId !== null && editingScopeThreadId === activeThread?.id);
  let researchReady = $derived(Boolean(activeThread && (activeWorkflow || workspace?.problemCandidates.length || workspace?.rejectedProblemCandidates.length || activeThread.status === "discovery-running")));
  let ideasReady = $derived(Boolean(activeThread && (workspace?.solutions.length || activeThread.status === "development-running" || activeThread.status === "solutions-ready"
    || activeWorkflow?.purpose === "known-problem" || activeWorkflow?.state === "finished")));

  onMount(() => {
    const viewport = window.matchMedia?.("(max-width: 720px)");
    const resizeNavigation = (event: MediaQueryListEvent) => {
      narrowViewport = event.matches;
      mobileSidebarOpen = false;
    };
    viewport?.addEventListener("change", resizeNavigation);
    const closeDrawerOnEscape = (event: KeyboardEvent) => {
      if (!narrowViewport || !mobileSidebarOpen || event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeMobileNavigation();
    };
    window.addEventListener("keydown", closeDrawerOnEscape, { capture: true });
    void load();
    const clock = setInterval(() => clockNow = Date.now(), 1_000);
    // A development host restart or a dropped event stream can miss the terminal event.
    // Reconcile active sessions periodically so progress and completion still reach the UI.
    const workflowRefresh = setInterval(() => {
      if (activeWorkflow && ["running", "pause-requested", "stop-requested"].includes(activeWorkflow.state)) reconcileSoon();
    }, 5_000);
    const stopCommands = window.scraply.onAppCommand((command) => {
      if (command === "toggle-sidebar") toggleNavigation();
      else if (command === "back") void navigateHistory(-1);
      else if (command === "forward") void navigateHistory(1);
      else if (command === "settings") void settings?.show();
      else if (command === "new-research") { settingsOpen = false; void createThread(); }
      else if (command === "export-research" && workspace?.activeThreadId) void exportResearch();
    });
    const dispose = window.scraply.onBackendEvent((event) => {
      if (event.type === "workflow-progress") {
        if (event.threadId === workspace?.activeThreadId) {
          if (event.sessionId === workspace?.activeWorkflow?.sessionId) {
            if (event.state === "finished" && workspace.activeWorkflow.mode === "vibe") activeStep = "ideas";
            else if (event.state === "waiting-for-review") activeStep = "research";
          }
          if (conversationIdeaId && event.sessionId !== workspace?.activeWorkflow?.sessionId) void refreshConversation(conversationIdeaId);
        }
        reconcileSoon();
        return;
      }
      if (event.type === "opportunity-progress") {
        if (event.threadId === workspace?.activeThreadId && event.error) feedback = { text: event.error, tone: "error" };
        reconcileSoon();
        return;
      }
      if (event.threadId !== workspace?.activeThreadId) {
        // Terminal events change sidebar state even when another thread is open.
        if (["run-completed", "run-cancelled", "run-failed"].includes(event.type)) reconcileSoon();
        return;
      }
      latestEvent = event;
      if (event.type === "run-progress" && workspace?.latestResearchRun?.runId === event.runId) {
        const latestRun = workspace.latestResearchRun;
        const measureId = progressMeasureId++;
        const startMark = `scraply-progress-received-${measureId}`;
        const visibleMark = `scraply-progress-rendered-${measureId}`;
        performance.mark(startMark);
        latestRun.lastActivity = event.message;
        latestRun.codexCalls = event.codexCalls;
        latestRun.searches = event.searches;
        if (event.usage) latestRun.usage = event.usage;
        const progress = event as typeof event & RuntimeProgress;
        if (progress.stage !== undefined) latestRun.stage = progress.stage as NonNullable<typeof latestRun.stage>;
        if (progress.modelState !== undefined) latestRun.modelState = progress.modelState;
        if (progress.elapsedMs !== undefined) latestRun.elapsedMs = progress.elapsedMs;
        if (progress.operationStartedAt !== undefined) latestRun.operationStartedAt = progress.operationStartedAt;
        if (progress.operationElapsedMs !== undefined) latestRun.operationElapsedMs = progress.operationElapsedMs;
        if (progress.lastSuccessfulCheckpoint !== undefined) latestRun.lastSuccessfulCheckpoint = progress.lastSuccessfulCheckpoint;
        progressReceivedAt = Date.now();
        void tick().then(() => {
          try {
            const values = document.querySelectorAll(".calls strong");
            if (values[0]?.textContent !== String(event.codexCalls) || values[1]?.textContent !== String(event.searches)) return;
            performance.mark(visibleMark);
            performance.measure("scraply-progress-visible", startMark, visibleMark);
            const measures = performance.getEntriesByName("scraply-progress-visible");
            if (measures.length > 100) {
              const latest = measures.slice(-100).map((entry) => entry.duration);
              performance.clearMeasures("scraply-progress-visible");
              for (const duration of latest) performance.measure("scraply-progress-visible", { start: 0, duration });
            }
          } finally {
            performance.clearMarks(startMark);
            performance.clearMarks(visibleMark);
          }
        });
        return;
      }
      reconcileSoon();
    });
    return () => { window.removeEventListener("keydown", closeDrawerOnEscape, { capture: true }); viewport?.removeEventListener("change", resizeNavigation); stopCommands(); dispose(); clearInterval(clock); clearInterval(workflowRefresh); if (reconcileTimer) clearTimeout(reconcileTimer); };
  });

  async function load() {
    if (workspaceInFlight) { reconcilePending = true; return; }
    workspaceInFlight = true;
    reconcilePending = false;
    const requestEpoch = ++loadEpoch;
    try {
      let next = await window.scraply.getWorkspace();
      if (requestEpoch !== loadEpoch) return;
      if (loading && next.threads.length === 0) {
        next = (await window.scraply.createThread()).workspace;
        if (requestEpoch !== loadEpoch) return;
      }
      const changedThread = next.activeThreadId !== workspace?.activeThreadId;
      workspace = next;
      if (changedThread) {
        conversationLoadEpoch += 1;
        conversation = null;
        conversationIdeaId = null;
        conversationError = null;
      }
      void refreshWorkflowDetail(next.activeWorkflow?.sessionId ?? null, next.activeWorkflow?.revision ?? null);
      progressReceivedAt = Date.now();
      if (changedThread) activeStep = defaultStep(next);
      if (feedback?.source === "workspace-load") feedback = null;
      if (validationPending(next)) reconcileSoon(500);
    }
    catch (cause) {
      if (requestEpoch === loadEpoch) feedback = { text: message(cause), tone: "error", source: "workspace-load" };
    }
    finally {
      workspaceInFlight = false;
      if (requestEpoch === loadEpoch) loading = false;
      if (reconcilePending) reconcileSoon();
    }
  }
  function setWorkspace(next: WorkspaceState) {
    loadEpoch += 1;
    loading = false;
    if (next.activeThreadId !== workspace?.activeThreadId) {
      conversationLoadEpoch += 1;
      conversation = null;
      conversationIdeaId = null;
      conversationError = null;
    }
    workspace = next;
    void refreshWorkflowDetail(next.activeWorkflow?.sessionId ?? null, next.activeWorkflow?.revision ?? null);
    progressReceivedAt = Date.now();
    if (validationPending(next)) reconcileSoon(500);
  }
  async function refreshWorkflowDetail(sessionId: string | null, revision: number | null, force = false) {
    if (!sessionId) {
      workflowLoadEpoch += 1;
      workflowDetail = null;
      return;
    }
    if (!force && workflowDetail?.summary.sessionId === sessionId && workflowDetail.summary.revision >= (revision ?? 0)) return;
    const epoch = ++workflowLoadEpoch;
    try {
      const next = await window.scraply.getWorkflow({ sessionId });
      if (epoch === workflowLoadEpoch && workspace?.activeWorkflow?.sessionId === sessionId) workflowDetail = next;
    } catch (cause) {
      if (epoch === workflowLoadEpoch && workspace?.activeWorkflow?.sessionId === sessionId) feedback = { text: message(cause), tone: "error" };
    }
  }
  async function loadMoreWorkflowTasks(cursor: string) {
    const sessionId = workflowDetail?.summary.sessionId;
    if (!sessionId) return;
    try {
      const page = await window.scraply.getWorkflow({ sessionId, cursor });
      if (workflowDetail?.summary.sessionId !== sessionId) return;
      const savedIds = new Set(workflowDetail.tasks.map((task) => task.id));
      workflowDetail = { ...page,
        summary: workflowDetail.summary.revision > page.summary.revision ? workflowDetail.summary : page.summary,
        tasks: [...workflowDetail.tasks, ...page.tasks.filter((task) => !savedIds.has(task.id))] };
    } catch (cause) {
      feedback = { text: message(cause), tone: "error" };
    }
  }
  function reconcileSoon(delayMs = 180) {
    reconcilePending = true;
    if (reconcileTimer) return;
    reconcileTimer = setTimeout(() => {
      reconcileTimer = null;
      if (busy) return;
      reconcilePending = false;
      void load();
    }, delayMs);
  }
  function validationPending(state: WorkspaceState): boolean {
    return [state.validation.exa.error, state.validation.perplexity.error, state.validation.native.error]
      .some((error) => error?.startsWith("Checking ") || error === "Native runtime is starting");
  }
  async function action(work: () => Promise<void>) {
    if (busy) return;
    busy = true;
    feedback = null;
    try { await work(); }
    catch (cause) { feedback = { text: message(cause), tone: "error" }; }
    finally {
      busy = false;
      if (reconcilePending) reconcileSoon();
    }
  }
  function defaultStep(state: WorkspaceState): WorkflowStep {
    const thread = state.threads.find((item) => item.id === state.activeThreadId);
    const workflow = state.activeWorkflow;
    if (workflow) {
      if (workflow.purpose === "research-followup" || workflow.state === "waiting-for-review") return "research";
      if (workflow.selectedProblemIds.length > 0 && workflow.state === "running") return "ideas";
      if (workflow.mode === "vibe" && (workflow.state === "finished" || workflow.purpose === "known-problem")) return "ideas";
      if (workflow.state === "finished" && state.solutions.length > 0) return "ideas";
      return "research";
    }
    if (state.solutions.length > 0 || thread?.status === "solutions-ready") return "ideas";
    if (thread?.status === "development-running") return "ideas";
    if (thread?.status === "discovery-running" || state.problemCandidates.length > 0 || state.rejectedProblemCandidates.length > 0) return "research";
    return "setup";
  }
  function openStep(step: WorkflowStep) {
    if (step === "research" && !researchReady) return;
    if (step === "ideas" && !ideasReady) return;
    activeStep = step;
    reviewSelection = false;
  }
  async function createThread() {
    await action(async () => {
      const result: WorkspaceResult = await window.scraply.createThread();
      setWorkspace(result.workspace);
      activeStep = "setup";
      latestEvent = null;
      reviewSelection = false;
      editingScopeThreadId = null;
    });
  }
  async function selectThread(id: string) {
    await action(async () => {
      const next = await window.scraply.selectThread(id);
      setWorkspace(next);
      activeStep = defaultStep(next);
      latestEvent = null;
      reviewSelection = false;
      editingScopeThreadId = null;
    });
  }
  async function deleteThread(id: string) {
    if (busy) return;
    busy = true;
    deletingThreadId = id;
    feedback = null;
    try {
      const next = await window.scraply.deleteThread(id);
      setWorkspace(next);
      activeStep = defaultStep(next);
      latestEvent = null;
      reviewSelection = false;
      editingScopeThreadId = null;
    }
    catch (cause) { feedback = { text: message(cause), tone: "error" }; }
    finally {
      deletingThreadId = null;
      busy = false;
      if (reconcilePending) reconcileSoon();
    }
  }
  async function archiveThread(id: string, archived = true) {
    await action(async () => {
      const next = await window.scraply.archiveThread(id, archived);
      setWorkspace(next);
      activeStep = defaultStep(next);
      editingScopeThreadId = null;
      reviewSelection = false;
    });
  }
  async function saveScope(scope: NonNullable<WorkspaceState["scope"]>, config: NonNullable<WorkspaceState["runConfig"]>) {
    const threadId = workspace?.activeThreadId;
    if (!threadId || busy) return;
    busy = true;
    feedback = null;
    try {
      if (!scope.title.trim()) {
        const defaults = readResearchDefaults();
        const result = await window.scraply.generateTitle({
          context: [config.knownProblem, scope.domain, scope.audience, scope.observations].filter(Boolean).join("\n").slice(0,20000),
          model: defaults.titleModel, reasoningEffort: defaults.titleReasoningEffort,
        });
        scope = { ...scope, title: result.title };
      }
      setWorkspace(await window.scraply.saveScope({ threadId, scope }));
      setWorkspace(await window.scraply.saveRunConfig({ threadId, config }));
      editingScopeThreadId = null;
    } catch (cause) {
      feedback = { text: message(cause), tone: "error" };
      throw cause;
    } finally {
      busy = false;
      if (reconcilePending) reconcileSoon();
    }
  }
  async function startResearch() {
    const threadId = workspace?.activeThreadId;
    if (!threadId) return;
    await action(async () => {
      const result: WorkspaceResult = await window.scraply.startResearch(threadId);
      const next = result.workspace;
      setWorkspace(next);
      activeStep = defaultStep(next);
      editingScopeThreadId = null;
    });
  }
  async function previewWorkflow(draft: WorkflowLaunchDraft): Promise<WorkflowPreview> {
    const threadId = workspace?.activeThreadId;
    if (!threadId) throw new Error("Choose a project before previewing this run.");
    return window.scraply.previewWorkflow({ type: "launch", threadId, draft: $state.snapshot(draft) });
  }
  async function previewWorkflowExtension(extension: { additionalModelCalls: number; additionalSearches: number; additionalMinutes: number }): Promise<WorkflowPreview> {
    const threadId = workspace?.activeThreadId;
    const summary = workspace?.activeWorkflow;
    if (!threadId || !summary) throw new Error("Open an active workflow to extend its limits.");
    return window.scraply.previewWorkflow({ type: "budget-extension", threadId,
      sessionId: summary.sessionId, expectedRevision: summary.revision, extension: $state.snapshot(extension) });
  }
  async function applyWorkflowExtension(preview: WorkflowPreview) {
    if (preview.type !== "budget-extension" || !("additionalModelCalls" in preview.proposal) || preview.fieldErrors.length > 0) {
      throw new Error("Preview a valid allowance extension first.");
    }
    await commandWorkflow({ type: "extend-budget", previewHash: preview.previewHash,
      capabilityFingerprint: preview.capabilityFingerprint, previewExpiresAt: preview.expiresAt,
      extension: preview.proposal });
  }
  async function startWorkflow(preview: WorkflowPreview) {
    const threadId = workspace?.activeThreadId;
    if (!threadId || busy || preview.type !== "launch") throw new Error("This launch is no longer available. Preview it again.");
    const contract = $state.snapshot(preview.proposal);
    if (!("contractVersion" in contract)) throw new Error("This launch preview is invalid.");
    busy = true;
    feedback = null;
    try {
      setWorkspace(await window.scraply.saveScope({ threadId, scope: contract.scope }));
      setWorkspace(await window.scraply.saveRunConfig({ threadId, config: contract.runConfig }));
      const receipt = await window.scraply.startWorkflow({
        threadId, clientCommandId: crypto.randomUUID(), contract,
        previewHash: preview.previewHash, capabilityFingerprint: preview.capabilityFingerprint,
        previewExpiresAt: preview.expiresAt,
      });
      setWorkspace(await window.scraply.getWorkspace());
      await refreshWorkflowDetail(receipt.sessionId, receipt.revision, true);
      activeStep = contract.purpose === "known-problem" && contract.mode === "vibe" ? "ideas" : "research";
      editingScopeThreadId = null;
    } catch (cause) {
      feedback = { text: message(cause), tone: "error" };
      throw cause;
    } finally {
      busy = false;
      if (reconcilePending) reconcileSoon();
    }
  }
  async function commandWorkflow(command: WorkflowAction) {
    const threadId = workspace?.activeThreadId;
    const summary = workspace?.activeWorkflow;
    if (!threadId || !summary || busy) throw new Error("Wait for the current workflow action to finish.");
    busy = true;
    feedback = null;
    try {
      const receipt = await window.scraply.commandWorkflow({
        threadId, sessionId: summary.sessionId, clientCommandId: crypto.randomUUID(),
        expectedRevision: summary.revision, action: $state.snapshot(command),
      });
      setWorkspace(await window.scraply.getWorkspace());
      await refreshWorkflowDetail(workspace?.activeWorkflow?.sessionId ?? receipt.sessionId,
        workspace?.activeWorkflow?.revision ?? receipt.revision, true);
    } catch (cause) {
      feedback = { text: message(cause), tone: "error" };
      throw cause;
    } finally {
      busy = false;
      if (reconcilePending) reconcileSoon();
    }
  }
  async function requestResearch(draft: ResearchRequestDraft & { model: ModelRef; reasoningEffort: string; baseSnapshotId: string | null }) {
    await commandWorkflow({
      type: "request-research", kind: draft.kind, question: draft.question,
      ...(draft.baseSnapshotId ? { baseSnapshotId: draft.baseSnapshotId } : {}),
      ...(draft.targetFindingId ? { targetFindingId: draft.targetFindingId } : {}),
      ...(draft.targetRequestId ? { targetRequestId: draft.targetRequestId } : {}),
      model: draft.model, reasoningEffort: draft.reasoningEffort,
      allowance: draft.allowance, ...(draft.angles?.length ? { angles: draft.angles } : {}),
      ...(draft.instructions?.trim() ? { instructions: draft.instructions.trim() } : {}),
    });
  }
  async function applyResearch(baseSnapshotId: string | null, includedRequestIds: string[], replacements: ResearchReplacement[]) {
    await commandWorkflow({ type: "apply-research", ...(baseSnapshotId ? { baseSnapshotId } : {}), includedRequestIds, replacements });
  }
  async function keepResearch(requestId: string, baseSnapshotId: string | null) {
    await commandWorkflow({ type: "keep-research", requestId, ...(baseSnapshotId ? { baseSnapshotId } : {}) });
  }
  async function refreshConversation(ideaId: string, cursor?: string) {
    const epoch = ++conversationLoadEpoch;
    const threadId = workspace?.activeThreadId;
    conversationLoading = true;
    conversationError = null;
    try {
      const next = await window.scraply.getIdeaConversation({ ideaId, ...(cursor ? { cursor } : {}) });
      if (epoch !== conversationLoadEpoch || workspace?.activeThreadId !== threadId) return;
      conversation = cursor && conversation?.rootSolutionId === next.rootSolutionId
        ? { ...next, turns: [...conversation.turns, ...next.turns.filter((turn) => !conversation?.turns.some((old) => old.id === turn.id))] }
        : next;
    } catch (cause) {
      if (epoch === conversationLoadEpoch) conversationError = message(cause);
    } finally {
      if (epoch === conversationLoadEpoch) conversationLoading = false;
    }
  }
  async function openConversation(ideaId: string) {
    conversationIdeaId = ideaId;
    await refreshConversation(ideaId);
  }
  function closeConversation() {
    conversationIdeaId = null;
    conversationLoadEpoch += 1;
  }
  async function submitIdeaTurn(draft: Omit<SubmitIdeaTurnRequest, "threadId" | "rootSolutionId">) {
    const threadId = workspace?.activeThreadId;
    const rootSolutionId = conversation?.rootSolutionId;
    if (!threadId || !rootSolutionId) throw new Error("Open an idea before adding a turn.");
    await window.scraply.submitIdeaTurn($state.snapshot({ ...draft, threadId, rootSolutionId }));
    await refreshConversation(conversationIdeaId ?? rootSolutionId);
    reconcileSoon();
  }
  async function selectConversationVersion(solutionId: string) {
    const threadId = workspace?.activeThreadId;
    const rootSolutionId = conversation?.rootSolutionId;
    if (!threadId || !rootSolutionId) throw new Error("Open an idea before choosing its version.");
    conversation = await window.scraply.selectIdeaVersion({ threadId, rootSolutionId, solutionId });
    setWorkspace(await window.scraply.getWorkspace());
  }
  async function retryConnections() {
    await action(async () => {
      await window.scraply.retryConnection();
      setWorkspace(await window.scraply.getWorkspace());
    });
  }
  async function connectNativeAccount(providerId: string, method: "browser" | "device") {
    if (busy) return;
    busy = true;
    feedback = null;
    const epoch = ++nativeLoginEpoch;
    try {
      const login = await window.scraply.startNativeLogin({ providerId, method });
      if (epoch !== nativeLoginEpoch) return;
      nativeLogin = login;
      feedback = { text: login.method === "device"
        ? "Enter the device code shown below in the browser to finish signing in."
        : "Finish signing in in your browser. Scraply is waiting for the account callback.", tone: "info" };
      for (let attempt = 0; attempt < 300; attempt += 1) {
        if (epoch !== nativeLoginEpoch) return;
        const result = await window.scraply.completeNativeLogin({ loginId: login.loginId });
        if (epoch !== nativeLoginEpoch) return;
        if (!result.pending) {
          const next = result.workspace;
          setWorkspace(next);
          const nativeError = next.validation.native.error;
          const nativeValidationPending = nativeError?.startsWith("Checking ") === true
            || nativeError === "Native runtime is starting";
          const hasNativeModel = next.models.some((model) => model.providerId === providerId);
          feedback = next.validation.native.connected && hasNativeModel
            ? { text: "Native model account connected.", tone: "info" }
            : nativeValidationPending
              ? { text: "OpenAI sign-in finished.", tone: "info" }
              : {
                  text: nativeError ?? (next.validation.native.connected
                    ? "OpenAI connected, but no compatible models were found."
                    : "OpenAI sign-in did not establish a usable connection."),
                  tone: "error",
                };
          return;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
      }
      throw new Error("Account sign-in timed out. Start the connection again.");
    } catch (cause) {
      if (epoch !== nativeLoginEpoch) return;
      feedback = { text: message(cause), tone: "error" };
      if (nativeLogin) {
        try {
          setWorkspace(await window.scraply.cancelNativeLogin({
            loginId: nativeLogin.loginId,
            providerId: nativeLogin.providerId,
          }));
        } catch { /* preserve the original sign-in error */ }
      }
    } finally {
      if (epoch === nativeLoginEpoch) {
        nativeLogin = null;
        busy = false;
        if (reconcilePending) reconcileSoon();
      }
    }
  }
  async function cancelNativeLogin() {
    const login = nativeLogin;
    if (!login) return;
    nativeLoginEpoch += 1;
    nativeLogin = null;
    feedback = { text: "Cancelling native account sign-in…", tone: "info" };
    try {
      setWorkspace(await window.scraply.cancelNativeLogin({ loginId: login.loginId, providerId: login.providerId }));
      feedback = { text: "Native account sign-in cancelled.", tone: "info" };
    } catch (cause) {
      feedback = { text: message(cause), tone: "error" };
    } finally {
      busy = false;
      if (reconcilePending) reconcileSoon();
    }
  }
  async function refreshNativeAccount(providerId: string) {
    await action(async () => setWorkspace(await window.scraply.refreshNativeAccount(providerId)));
  }
  async function logoutNativeAccount(providerId: string) {
    await action(async () => setWorkspace(await window.scraply.logoutNativeAccount(providerId)));
  }
  async function resumeResearch(runId: string) {
    await action(async () => {
      const next = await window.scraply.resumeResearch(runId);
      setWorkspace(next);
      activeStep = defaultStep(next);
    });
  }
  async function cancelResearch(runId: string) {
    await action(async () => setWorkspace(await window.scraply.cancelResearch(runId)));
  }
  async function selectProblems(ids: string[], userProblem: string | null, model: ModelRef, reasoningEffort: string, explorationPurpose: ExplorationPurpose) {
    const threadId = workspace?.activeThreadId;
    if (!threadId) return;
    if (activeWorkflow) {
      if (userProblem?.trim()) {
        feedback = { text: "This workflow can only develop problems saved in its research snapshot. Start a new known-problem run to use your own statement.", tone: "error" };
        return;
      }
      const savedPurpose = workspace?.runConfig?.explorationPurpose ?? "general-solutions";
      if (explorationPurpose !== savedPurpose) {
        feedback = { text: "The option type changed since this workflow started. Review the saved setup before generating ideas.", tone: "error" };
        return;
      }
      const problemIds = ids.length ? ids : activeWorkflow.selectedProblemIds;
      if (!activeWorkflow.activeSnapshotId || problemIds.length === 0) throw new Error("Choose at least one problem from the current research snapshot.");
      const target = workspace?.runConfig?.opportunityExploration
        ? { kind: "project" as const, count: workspace.runConfig.opportunityExploration.targetFamilies }
        : { kind: "per-problem" as const, count: workspace?.runConfig?.ideaCount ?? 3 };
      await commandWorkflow({ type: "generate-ideas", snapshotId: activeWorkflow.activeSnapshotId, problemIds,
        model, reasoningEffort, target });
      activeStep = "ideas";
      reviewSelection = false;
      return;
    }
    await action(async () => {
      const api = window.scraply as typeof window.scraply & {
        selectProblems(request: { threadId: string; problemIds: string[]; userProblem: string|null; model: ModelRef; reasoningEffort: string; explorationPurpose: ExplorationPurpose }): Promise<WorkspaceState>;
      };
      setWorkspace(await api.selectProblems({ threadId, problemIds: ids, userProblem, model, reasoningEffort, explorationPurpose }));
      activeStep = "ideas";
      reviewSelection = false;
    });
  }
  async function selectOption(idea: SolutionView) {
    const threadId = workspace?.activeThreadId;
    if (!threadId || !idea.runId) return;
    const runId = idea.runId;
    await action(async () => setWorkspace(await window.scraply.selectOption({ threadId, runId, solutionId: idea.id })));
  }
  async function saveDecision(solutionId: string, userDecision: string, observedResult: string, experimentOutcome: "not-run" | "pass" | "fail" | "inconclusive") {
    const threadId = workspace?.activeThreadId;
    if (!threadId || busy) throw new Error("Wait for the current action before saving.");
    busy = true;
    const api = window.scraply as typeof window.scraply & {
      saveDecision(request: { threadId: string; solutionId: string; userDecision: string; observedResult: string; experimentOutcome: "not-run" | "pass" | "fail" | "inconclusive" }): Promise<WorkspaceState>;
    };
    try { setWorkspace(await api.saveDecision({ threadId, solutionId, userDecision, observedResult, experimentOutcome })); }
    finally { busy = false; if (reconcilePending) reconcileSoon(); }
  }
  async function reviewSavedOpportunities(model: import("../shared/schemas").ModelRef, reasoningEffort: string, allowAmbiguousRetry = false) {
    const threadId = workspace?.activeThreadId;
    if (!threadId) return;
    await action(async () => setWorkspace(await window.scraply.reviewSavedOpportunities({ threadId, model, reasoningEffort, allowAmbiguousRetry })));
  }
  async function editOpportunityMembership(command: import("../shared/opportunity-review").OpportunityMembershipCommand) {
    const threadId = workspace?.activeThreadId;
    if (!threadId) return;
    await action(async () => setWorkspace(await window.scraply.editOpportunityMembership({ threadId, command })));
  }
  async function requestFocusedExperiment(idea: SolutionView) {
    const threadId = workspace?.activeThreadId;
    if (!threadId || !idea.runId) return;
    const runId = idea.runId;
    await action(async () => setWorkspace(await window.scraply.requestFocusedExperiment({ threadId, runId, solutionId: idea.id })));
  }
  async function startOrResumeOpportunities() {
    const threadId = workspace?.activeThreadId;
    const config = workspace?.runConfig;
    if (!threadId || !config) return;
    const request = { threadId, model: config.model, reasoningEffort: config.reasoningEffort };
    await action(async () => setWorkspace(await (workspace?.opportunityExploration
      ? window.scraply.resumeOpportunityExploration(request)
      : window.scraply.startOpportunityExploration(request))));
  }
  async function pauseOpportunities() {
    const threadId = workspace?.activeThreadId;
    if (!threadId) return;
    await action(async () => setWorkspace(await window.scraply.pauseOpportunityExploration(threadId)));
  }
  async function previewOpportunityExtension(extension: import("../shared/opportunity-exploration").OpportunityBudgetExtension) {
    const threadId = workspace?.activeThreadId;
    if (!threadId) throw new Error("Choose a project before extending its budget.");
    return window.scraply.previewOpportunityBudgetExtension({ threadId, extension });
  }
  async function applyOpportunityExtension(preview: import("../shared/opportunity-exploration").OpportunityBudgetExtensionPreview) {
    const threadId = workspace?.activeThreadId;
    if (!threadId) return;
    await action(async () => setWorkspace(await window.scraply.applyOpportunityBudgetExtension({ threadId, preview })));
  }
  async function exportResearch() {
    const threadId = workspace?.activeThreadId;
    if (!threadId) return;
    await action(async () => {
      const result: ResearchExportResult = await window.scraply.exportResearch(threadId);
      if (!result.cancelled) feedback = { text: `Research JSON exported to ${result.file}.`, tone: "info" };
    });
  }
  async function exportIdeas(format: "markdown" | "json") {
    const threadId = workspace?.activeThreadId;
    if (!threadId) return;
    await action(async () => {
      const result: IdeasExportResult = await window.scraply.exportIdeas(threadId, format);
      if (!result.cancelled) {
        feedback = {
          text: `${result.files.length} ${format === "markdown" ? "Markdown" : "JSON"} file${result.files.length === 1 ? "" : "s"} exported to ${result.directory}.`,
          tone: "info",
        };
      }
    });
  }
  async function requestEvidenceFollowUp(runId: string, question: string) {
    const threadId = activeThread?.id;
    if (!threadId || !runId || !question.trim()) return;
    await action(async () => setWorkspace(await window.scraply.requestEvidenceFollowUp({ threadId, runId, question })));
  }
  async function openExternalUrl(url: string) {
    await action(() => window.scraply.openExternalUrl(url));
  }
  async function openDataFolder() {
    await action(() => window.scraply.openDataFolder());
  }
  async function openLogsFolder() {
    await action(() => window.scraply.openLogsFolder());
  }
  function message(value: unknown) { return value instanceof Error ? value.message : "Something went wrong."; }
  function stageLabel(stage: string | undefined): string {
    if (!stage) return "Working";
    return stage.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
  }
  async function requestEvidenceReassessment(runId: string) {
    const threadId = activeThread?.id;
    if (!threadId || !runId) return;
    const api = window.scraply as typeof window.scraply & {
      requestEvidenceReassessment(request: { threadId: string; runId: string }): Promise<WorkspaceState>;
    };
    await action(async () => setWorkspace(await api.requestEvidenceReassessment({ threadId, runId })));
  }
  function elapsedLabel(elapsedMs: number | undefined, totalRun = false): string | null {
    if (elapsedMs === undefined) return null;
    const seconds = Math.max(0, Math.floor(elapsedMs / 1_000));
    const minutes = Math.floor(seconds / 60);
    const duration = minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
    return totalRun ? `Total run: ${duration}` : `${duration} elapsed`;
  }
  function activeSolutionRunLabel(): string {
    const activity = runActivity.toLowerCase();
    if (activity.includes("reassess")) return "Reassessing with new evidence";
    if (runtimeProgress.stage === "evidence-follow-up") return "Researching follow-up evidence";
    if (runtimeProgress.stage === "evaluating-risk" || runtimeProgress.stage === "analyzing-option") return "Analyzing the selected option";
    return stageLabel(runtimeProgress.stage);
  }
</script>

<DesktopBar canBack={backIndex !== -1 && !busy} canForward={forwardIndex !== -1 && !busy} onBack={() => navigateHistory(-1)} onForward={() => navigateHistory(1)} onToggle={toggleNavigation} navigationOpen={navigationOpen} compact={narrowViewport} />
<div class="app-shell" class:sidebar-hidden={!navigationOpen}>
  {#if narrowViewport && mobileSidebarOpen}<button class="sidebar-backdrop" aria-label="Close navigation" onclick={closeMobileNavigation}></button>{/if}
  <div id="research-navigation" class="sidebar-area" hidden={!navigationOpen} inert={settingsOpen}>
  <Sidebar
    threads={workspace?.threads.filter((thread) => !thread.archivedAt) ?? []}
    activeThreadId={workspace?.activeThreadId ?? null}
    {busy}
    {deletingThreadId}
    onNew={() => { mobileSidebarOpen = false; void createThread(); }}
    onSelect={(id) => { mobileSidebarOpen = false; void selectThread(id); }}
    onArchive={archiveThread}
  >
    {#snippet settingsControl()}
      <button id="settings-button" class="settings-button" onclick={() => { mobileSidebarOpen = false; settings?.show(); }}><Icon name="settings" size={20} />Settings</button>
    {/snippet}
  </Sidebar>
  </div>

  <main class="main-content" inert={settingsOpen}>
    {#if workspace && activeThread}
      <div class="topbar">
        <h1 class="location" title={activeThread.title}>{activeThread.title}</h1>
        {#if activeRun && !activeWorkflow}<div class="calls"><strong>{activeRun.codexCalls}</strong> model calls / ~{activeRun.projectedCodexCalls} · <strong>{activeRun.searches}</strong> searches / ~{activeRun.projectedSearches}</div>{/if}
      </div>
      <WorkflowTabs
        active={activeStep}
        setupReady={true}
        {researchReady}
        {ideasReady}
        onSelect={openStep}
      />
      {#if !activeWorkflow}<RunUsage usage={activeRun?.usage} />{/if}
      {#if workflowDetail && activeWorkflow && workflowDetail.summary.sessionId === activeWorkflow.sessionId && !(activeStep === "ideas" && ideaFocused && activeWorkflow.state === "finished")}
        <div class="workflow-progress-wrap"><VibeProgress detail={workflowDetail} {busy}
          onPause={() => commandWorkflow({ type: "pause" })}
          onResume={() => commandWorkflow({ type: "resume" })}
          onStop={() => commandWorkflow({ type: "stop" })}
          onRetryTask={(taskId, expectedTerminalAttemptId, acknowledgeUnknownCompletion) => commandWorkflow({ type: "retry-task", taskId, expectedTerminalAttemptId, acknowledgeUnknownCompletion })}
          onLoadMoreTasks={loadMoreWorkflowTasks}
          onPreviewExtension={previewWorkflowExtension} onApplyExtension={applyWorkflowExtension} /></div>
      {/if}
      {#if !activeWorkflow && workspace.opportunityExploration}
        <OpportunityProgress progress={workspace.opportunityExploration} {busy} onPause={pauseOpportunities} onResume={startOrResumeOpportunities} onPreviewExtension={previewOpportunityExtension} onApplyExtension={applyOpportunityExtension} />
      {:else if !activeWorkflow && workspace.runConfig?.opportunityExploration && workspace.solutions.length > 0}
        <div class="notice"><button disabled={busy || workspace.opportunityReviewStatus?.running} onclick={startOrResumeOpportunities}>Continue toward {workspace.runConfig.opportunityExploration.targetFamilies} distinct hypotheses</button></div>
      {/if}
      {#if workspace.opportunityReviewStatus?.kind === "review" && workspace.opportunityReviewStatus.running}<div class="notice" role="status">Reviewing saved business ideas. Completed comparisons are being saved.</div>{/if}
      {#if workspace.opportunityReviewStatus?.kind === "experiment" && workspace.opportunityReviewStatus.running}<div class="notice" role="status">Planning and reviewing a focused experiment. No customer test is being run.</div>{/if}
      {#if activeThread.status === "failed" && !activeWorkflow}
        <div class="run-stopped" role="status">
          <div><strong>Run stopped</strong><span>{activeRun?.resumeBlockedReason ?? activeRun?.completionReason ?? activeRun?.lastActivity ?? "The last run failed or was cancelled. Review the setup, then retry explicitly."}</span></div>
          <div class="run-stopped-actions">
            {#if activeRun?.canResume}
              <button disabled={busy} onclick={() => resumeResearch(activeRun.runId)}>Resume attempt</button>
            {/if}
            {#if activeRun && ["queued", "running"].includes(activeRun.status)}<button class="cancel" disabled={busy} onclick={() => cancelResearch(activeRun.runId)}>Cancel run</button>{/if}
            {#if workspace.problemCandidates.length > 0 || workspace.rejectedProblemCandidates.length > 0}<button disabled={busy} onclick={() => { activeStep = "research"; reviewSelection = true; }}>Review problems</button>{/if}
            <button disabled={busy} onclick={() => { activeStep = "setup"; editingScopeThreadId = activeThread?.id ?? null; }}>Edit setup</button>
          </div>
        </div>
      {/if}
    {/if}

    {#if feedback && !settingsOpen}<div class:error={feedback.tone === "error"} class="notice" role={feedback.tone === "error" ? "alert" : "status"}>{feedback.text}<button aria-label="Dismiss" onclick={() => feedback = null}>×</button></div>{/if}

    {#if loading}
      <div class="skeleton" role="status" aria-label="Loading workspace"><i></i><i></i><i></i></div>
    {:else if !workspace || !activeThread}
      <div class="empty-workspace"><button disabled={busy} onclick={createThread}>New research</button></div>
    {:else if activeStep === "setup"}
      {#if activeThread.status === "configuring" || editingScope || !workspace.scope}
        <div id="workflow-panel-setup" role="tabpanel" aria-label="Research setup">
          {#key workspace.activeThreadId}
            <ScopeForm {workspace} {busy} onSave={saveScope} onStart={startResearch} onPreviewWorkflow={previewWorkflow} onStartWorkflow={startWorkflow} onRetry={retryConnections} onOpenSettings={() => settings?.show()} />
          {/key}
        </div>
      {:else}
        {#if activeThread.status === "failed" || activeWorkflow?.state === "finished"}
          <SetupArchive {workspace} onEdit={() => { editingScopeThreadId = activeThread?.id ?? null; }} />
        {:else}
          <SetupArchive {workspace} />
        {/if}
      {/if}
    {:else if activeStep === "research"}
      {#if activeWorkflow && ["running", "paused", "pause-requested", "stop-requested"].includes(activeWorkflow.state)}
        <div class="managed-research" id="workflow-panel-research" role="tabpanel" aria-label="Research">
          <p class="eyebrow">{activeWorkflow.mode === "vibe" ? "Vibe research" : "Babysit research"}</p>
          <h1>{activeWorkflow.state === "paused" ? "Research paused." : "Following the evidence."}</h1>
          <p>Research tasks and their outcomes appear above.</p>
        </div>
      {:else if activeThread.status === "discovery-running" && !activeWorkflow}
        <div class="running" id="workflow-panel-research" role="tabpanel" aria-label="Research" tabindex="0">
          <div class="activity-symbol"><Icon name="research" size={30} /></div><p class="eyebrow">Discovery in progress</p>
          <h1>Following the evidence.</h1>
          <div class="activity"><span></span><p>{runActivity}</p></div>
          {#if activeRun}<div class="progress-facts" aria-label="Run progress"><strong>{stageLabel(runtimeProgress.stage)}</strong>{#if runtimeProgress.modelState}<span>{runtimeProgress.modelState === "waiting" ? "Queued for model" : runtimeProgress.modelState === "dispatched" ? "Sent to model" : "Accepted by model"}</span>{/if}{#if elapsedStatus}<span>{elapsedStatus}</span>{/if}{#if runtimeProgress.lastSuccessfulCheckpoint}<span>Last checkpoint: {runtimeProgress.lastSuccessfulCheckpoint}</span>{/if}</div>{/if}
          {#if activeRun}<div class="run-actions"><button class="cancel" disabled={busy} onclick={() => cancelResearch(activeRun.runId)}>Cancel run</button></div>{/if}
        </div>
      {:else if (activeWorkflow ? activeWorkflow.state === "waiting-for-review" : activeThread.status === "problems-ready" || reviewSelection) && (workspace.problemCandidates.length > 0 || workspace.rejectedProblemCandidates.length > 0)}
        <div id="workflow-panel-research" role="tabpanel" aria-label="Research">
          {#key workspace.activeThreadId}
            <ProblemCheckpoint problems={workspace.problemCandidates} rejectedCandidates={workspace.rejectedProblemCandidates} modelOptions={workspace.modelOptions} initialConfig={activeRun?.problemId ? activeRun.runConfig ?? workspace.runConfig : workspace.runConfig} fixedExplorationPurpose={activeWorkflow ? workspace.runConfig?.explorationPurpose ?? "general-solutions" : undefined} workflowVersion={activeRun?.workflowVersion} ideaCount={workspace.runConfig?.ideaCount} {busy} onCommit={selectProblems} onExport={exportResearch} onOpenSource={openExternalUrl} />
          {/key}
        </div>
      {:else if workspace.problemCandidates.length > 0 || workspace.rejectedProblemCandidates.length > 0}
        <ResearchArchive problems={workspace.problemCandidates} rejectedCandidates={workspace.rejectedProblemCandidates} {busy} onExport={exportResearch} onOpenSource={openExternalUrl} />
      {:else}
        <div class="failed" id="workflow-panel-research" role="tabpanel" aria-label="Research" tabindex="0"><p class="eyebrow">{activeWorkflow ? "Research outcome" : "Research unavailable"}</p><h1>{activeWorkflow?.stopReason ?? "No completed research is ready yet."}</h1><p>{activeWorkflow ? "You can inspect the task record above or start a new run from setup." : "Return to setup and start a research run."}</p>{#if activeRun || activeWorkflow}<div class="zero-idea-actions"><button disabled={busy} onclick={exportResearch}>Export research JSON</button></div>{/if}</div>
      {/if}
      {#if activeWorkflow}
        {#if activeWorkflow.mode === "vibe" && activeWorkflow.state === "finished" && activeWorkflow.activeSnapshotId}
          <p class="followup-note">You can start a separate research follow-up. The finished Vibe result and its ideas stay saved; apply the new research when you want to use it in a later idea conversation.</p>
        {/if}
        <ResearchRevisions requests={workspace.researchRequests} findings={workspace.researchFindings}
          readOnly={(activeWorkflow.mode === "vibe" && activeWorkflow.state !== "finished") || !(["running", "waiting-for-review"].includes(activeWorkflow.state)
            || (activeWorkflow.state === "finished" && !!activeWorkflow.activeSnapshotId))}
          activeSnapshotId={activeWorkflow.activeSnapshotId} modelOptions={workspace.modelOptions}
          researchModel={workspace.runConfig?.model ?? null} researchReasoningEffort={workspace.runConfig?.reasoningEffort ?? "medium"}
          {busy} onRequest={requestResearch} onApply={applyResearch} onKeep={keepResearch} onOpenSource={openExternalUrl} />
      {/if}
    {:else if activeThread.status === "development-running" && !activeWorkflow}
      <div id="workflow-panel-ideas" role="tabpanel" aria-label="Solutions" tabindex="0">
      <div class="running development-progress">
        <div class="activity-symbol"><Icon name="ideas" size={30} /></div><p class="eyebrow">Development in progress</p>
        <h1>{runtimeProgress.stage === "analyzing-option" || runtimeProgress.stage === "evaluating-risk" ? "Analyzing the selected option." : workspace.solutions.length ? "Generating the next options." : "Turning problems into possibilities."}</h1>
        <p class="research-export-hint">The research archive is already available. Open the Research tab to inspect or export it while solutions are generated.</p>
        <div class="activity"><span></span><p>{runActivity}</p></div>
        {#if activeRun}<div class="progress-facts" aria-label="Run progress"><strong>{stageLabel(runtimeProgress.stage)}</strong>{#if runtimeProgress.modelState}<span>{runtimeProgress.modelState === "waiting" ? "Queued for model" : runtimeProgress.modelState === "dispatched" ? "Sent to model" : "Accepted by model"}</span>{/if}{#if elapsedStatus}<span>{elapsedStatus}</span>{/if}{#if runtimeProgress.lastSuccessfulCheckpoint}<span>Last checkpoint: {runtimeProgress.lastSuccessfulCheckpoint}</span>{/if}</div>{/if}
        {#if activeRun}<div class="run-actions"><button class="cancel" disabled={busy} onclick={() => cancelResearch(activeRun.runId)}>Cancel run</button></div>{/if}
      </div>
      {#if workspace.solutions.length > 0}<SolutionWorkspace solutions={workspace.solutions} {busy} analysisBlocked={true} opportunities={workspace.opportunityFamilies} opportunityReviewRunning={workspace.opportunityReviewStatus?.running} modelOptions={workspace.modelOptions} initialConfig={workspace.runConfig} acceptedCount={null} activeResearchSnapshotId={appliedResearchSnapshotId} onFocusChange={(focused) => ideaFocused = focused} onReviewOpportunities={reviewSavedOpportunities} onEditMembership={editOpportunityMembership} onPlanExperiment={requestFocusedExperiment} onDiscard={discardIdea} workflowVersion={activeRun?.workflowVersion} onSelect={selectOption} onSave={saveDecision} onExport={exportIdeas} onOpenSource={openExternalUrl} onEvidenceFollowUp={requestEvidenceFollowUp} onEvidenceReassessment={requestEvidenceReassessment} onReview={() => { activeStep = "research"; reviewSelection = true; }} {conversation} {conversationLoading} {conversationError} onOpenConversation={openConversation} onCloseConversation={closeConversation} onSubmitIdeaTurn={submitIdeaTurn} onSelectConversationVersion={selectConversationVersion} onLoadMoreConversation={(cursor) => refreshConversation(conversationIdeaId ?? "", cursor)} />{/if}
      </div>
    {:else if activeThread.status === "solutions-ready" || workspace.solutions.length > 0}
      <div id="workflow-panel-ideas" role="tabpanel" aria-label="Solutions">
        {#if activeRun && !activeWorkflow && ["queued", "running"].includes(activeRun.status)}
          <section class="compact-progress" aria-label="Active solution work">
            <div><strong>{activeSolutionRunLabel()}</strong><p>{runActivity}</p></div>
            <div class="progress-facts" aria-label="Run progress">{#if runtimeProgress.modelState}<span>{runtimeProgress.modelState === "waiting" ? "Queued for model" : runtimeProgress.modelState === "dispatched" ? "Sent to model" : "Accepted by model"}</span>{/if}{#if elapsedStatus}<span>{elapsedStatus}</span>{/if}{#if runtimeProgress.lastSuccessfulCheckpoint}<span>Last checkpoint: {runtimeProgress.lastSuccessfulCheckpoint}</span>{/if}</div>
          </section>
        {/if}
        <SolutionWorkspace solutions={workspace.solutions} {busy} opportunities={workspace.opportunityFamilies} opportunityReviewRunning={workspace.opportunityReviewStatus?.running} modelOptions={workspace.modelOptions} initialConfig={workspace.runConfig} acceptedCount={activeWorkflow?.purpose === "research-followup" ? null : activeWorkflow?.counts.accepted ?? null} activeResearchSnapshotId={appliedResearchSnapshotId} onFocusChange={(focused) => ideaFocused = focused} onReviewOpportunities={reviewSavedOpportunities} onEditMembership={editOpportunityMembership} onPlanExperiment={requestFocusedExperiment} onDiscard={discardIdea} workflowVersion={activeRun?.workflowVersion} onSelect={selectOption} onSave={saveDecision} onExport={exportIdeas} onOpenSource={openExternalUrl} onEvidenceFollowUp={requestEvidenceFollowUp} onEvidenceReassessment={requestEvidenceReassessment} onReview={() => { activeStep = "research"; reviewSelection = true; }} {conversation} {conversationLoading} {conversationError} onOpenConversation={openConversation} onCloseConversation={closeConversation} onSubmitIdeaTurn={submitIdeaTurn} onSelectConversationVersion={selectConversationVersion} onLoadMoreConversation={(cursor) => refreshConversation(conversationIdeaId ?? "", cursor)} />
      </div>
    {:else if activeWorkflow}
      <div class="failed" id="workflow-panel-ideas" role="tabpanel" aria-label="Solutions" tabindex="0">
        <p class="eyebrow">{activeWorkflow.state === "finished" ? "Idea outcome" : "Idea development"}</p>
        <h1>{activeWorkflow.stopReason ?? (activeWorkflow.state === "finished" ? "No qualifying ideas were produced." : "Ideas are being developed.")}</h1>
        <p>{activeWorkflow.state === "finished" ? "Research and task details remain available in the Research tab." : "Progress and remaining limits are shown above."}</p>
        {#if activeWorkflow.state === "finished"}<div class="zero-idea-actions"><button disabled={busy} onclick={() => exportIdeas("markdown")}>Export result</button><button disabled={busy} onclick={() => exportIdeas("json")}>Export JSON</button></div>{/if}
      </div>
    {:else if activeThread.status === "failed"}
      <div class="failed" id="workflow-panel-ideas" role="tabpanel" aria-label="Solutions" tabindex="0"><p class="eyebrow">No solutions</p><h1>The run stopped before any solutions were generated.</h1><p>{activeRun?.canResume ? "Resume the saved attempt or edit the setup." : "Edit the setup to start a new run."}</p></div>
    {:else}
      <div class="failed" id="workflow-panel-ideas" role="tabpanel" aria-label="Solutions" tabindex="0"><p class="eyebrow">Solutions not ready</p><h1>Complete the research step first.</h1></div>
    {/if}
  </main>
  <Settings bind:this={settings} bind:open={settingsOpen} {feedback} {workspace} {busy} {nativeLogin}
    onRetry={retryConnections} onConnectNative={connectNativeAccount} onCancelNative={cancelNativeLogin}
    onRefreshNative={refreshNativeAccount} onLogoutNative={logoutNativeAccount}
    onOpenData={openDataFolder} onOpenLogs={openLogsFolder} onRestore={(id) => archiveThread(id, false)} onDelete={deleteThread} />
</div>

<style>
  .workflow-progress-wrap { padding:18px var(--page-inline) 0; }
  .managed-research { max-width:900px; margin:auto; padding:44px var(--page-inline) 20px; }
  .managed-research h1 { margin:8px 0 12px; font-size:clamp(24px,4vw,36px); letter-spacing:-.035em; }
  .managed-research p:last-child { color:var(--muted); font-size:13px; line-height:1.7; }
  .sidebar-area { display:contents; }.sidebar-area[hidden] { display:none; }
  .app-shell.sidebar-hidden { grid-template-columns:minmax(0,1fr); }
  .settings-button { display:flex;align-items:center;gap:10px;width:100%;padding:9px 12px;min-height:38px;border:0;border-radius:7px;background:transparent;color:var(--muted);font-size:13px;text-align:left;transition:background 180ms ease,color 180ms ease; }
  .settings-button:hover { background:var(--surface-2);color:var(--text); }

  .app-shell { height:calc(100% - 36px);display:grid;grid-template-columns:248px minmax(0,1fr);background:#000;padding:10px 10px 10px 0; }
  .main-content { min-width:0;overflow-y:auto;overflow-x:hidden;scrollbar-gutter:stable;position:relative;border-left:1px solid var(--border);background:var(--bg); }
  .topbar { position:sticky;top:0;z-index:3;height:54px;padding:0 24px;display:flex;align-items:center;justify-content:space-between;background:color-mix(in srgb,var(--bg) 94%,transparent);backdrop-filter:blur(18px);border-bottom:1px solid var(--border);font-size:13px;color:var(--muted); }
  .location { display:block;margin:0;color:var(--text);font-size:20px;font-weight:600;letter-spacing:-.025em;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
  .calls { white-space:nowrap;margin-left:16px;font:500 13px var(--sans); }.calls strong { color:var(--text);font-weight:600; }
  .notice { position:sticky;top:122px;z-index:3;margin:12px var(--page-inline) 0;padding:12px 16px;border:1px solid var(--border-strong);border-radius:10px;background:var(--surface-2);display:flex;justify-content:space-between;gap:16px;color:var(--muted);font-size:13px;overflow-wrap:anywhere; }
  .notice.error { border-color:#df929260;color:var(--danger); }.notice button { border:0;background:transparent;color:inherit; }
  .empty-workspace { padding:var(--page-top) var(--page-inline); }
  .empty-workspace button { padding:10px 16px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text); }
  .activity-symbol { display:grid;place-items:center;width:76px;height:76px;border:1px solid #71cfba30;border-radius:24px;color:var(--accent-strong);background:#71cfba08;box-shadow:inset 0 1px #92ead515; }
  .eyebrow { font:500 13px var(--sans);color:var(--muted);margin:28px 0 0; }
  .running,.failed { display:flex;flex-direction:column;align-items:start;max-width:900px;min-height:calc(100dvh - 160px);margin:auto;justify-content:center;padding:60px var(--page-inline); }
  .running h1,.failed h1 { font-size:38px;font-weight:600;letter-spacing:-.035em;line-height:1.25;max-width:620px;margin:10px 0 20px; }
  .failed > p:not(.eyebrow),.research-export-hint { color:var(--muted);font-size:13px;line-height:1.8;max-width:650px;margin:0; }
  .zero-idea-actions { display:flex;flex-wrap:wrap;gap:8px;margin-top:22px; }
  .zero-idea-actions button { min-height:38px;padding:8px 12px;border:1px solid var(--border-strong);border-radius:8px;background:#000;color:var(--text);font-size:13px; }
  .followup-note { max-width:75ch;margin:20px var(--page-inline) 0;color:var(--muted);font-size:13px;line-height:1.6; }
  .activity-symbol { position:relative; }.activity-symbol::after { content:"";position:absolute;inset:-5px;border:1px solid transparent;border-top-color:var(--accent);border-radius:28px;animation:orbit 4s linear infinite; }
  .activity { width:100%;display:flex;gap:14px;border:1px solid var(--border);border-radius:14px;padding:20px;background:var(--surface);margin:24px 0;align-items:center; }
  .activity p { margin:0;font-size:13px;color:var(--muted); }.activity span { width:7px;height:7px;border-radius:50%;background:var(--accent);flex:none;animation:pulse 1.5s ease infinite alternate; }
  .progress-facts { display:flex;flex-wrap:wrap;gap:8px 18px;color:var(--subtle);font-size:13px; }
  .progress-facts strong { color:var(--text);font-weight:600; }
  .development-progress { min-height:auto;padding-bottom:32px;border-bottom:1px solid var(--border); }
  .compact-progress { display:flex;justify-content:space-between;gap:20px;padding:16px var(--page-inline);border-bottom:1px solid var(--border);background:#000; }
  .compact-progress strong { font-size:13px;color:var(--text); }
  .compact-progress p { margin:4px 0 0;color:var(--muted);font-size:13px; }
  .compact-progress .progress-facts { justify-content:flex-end;align-items:center; }
  .run-actions { display:flex;gap:9px; }.run-actions button { border:1px solid var(--border-strong);background:transparent;color:var(--text);padding:10px 14px;border-radius:8px;font-size:13px; }.run-actions .cancel { color:var(--danger); }
  .run-stopped { display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px;margin:14px var(--page-inline) 0;padding:16px;border:1px solid #df92924a;border-radius:12px;background:#df929208; }
  .run-stopped > div:first-child { display:grid;gap:5px; }.run-stopped strong { font-size:13px; }.run-stopped span { color:var(--muted);font-size:13px; }.run-stopped-actions { display:flex;flex-wrap:wrap;gap:8px; }.run-stopped-actions button { border:1px solid var(--border-strong);border-radius:8px;background:transparent;color:var(--text);padding:9px 13px;font-size:13px; }.run-stopped-actions .cancel { color:var(--danger); }
  .skeleton { padding:90px var(--page-inline);display:grid;gap:18px; }.skeleton i { display:block;height:24px;max-width:720px;border-radius:8px;background:linear-gradient(90deg,var(--surface),var(--surface-2),var(--surface));background-size:200% 100%;animation:shimmer 1.2s infinite; }.skeleton i:first-child { height:58px;width:60%; }.skeleton i:last-child { width:40%; }
  .main-content > :global([role="tabpanel"]) { animation:page-reveal 200ms var(--ease); }
  @keyframes page-reveal { from { opacity:.6;transform:translateY(4px); }to { opacity:1;transform:none; } }
  @keyframes shimmer { to { background-position:-200% 0; } }@keyframes pulse { to { opacity:.3; } }@keyframes orbit { to { transform:rotate(360deg); } }
  @media(max-width:950px) { .calls { display:none; } }
  @media(max-width:720px) {
    .app-shell { grid-template-columns:minmax(0,1fr);padding:0; }
    .sidebar-backdrop { position:fixed;inset:36px 0 0;z-index:10;width:100%;border:0;background:#000a; }
    .sidebar-area { position:fixed;top:36px;bottom:0;left:0;z-index:11;display:block;width:min(280px,calc(100vw - 56px));background:#000;border-right:1px solid var(--border-strong);box-shadow:12px 0 32px #0009; }
    .sidebar-area[hidden] { display:none; }
    .sidebar-area :global(.sidebar) { height:100%; }
    .main-content { border-radius:0; }
    .topbar { padding:0 16px; }
    .running h1,.failed h1 { font-size:28px; }
  }
</style>
