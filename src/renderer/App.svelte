<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import type { NativeLoginStartResult, ResearchEvent, SolutionView, WorkspaceState } from "../shared/ipc";
  import type { ExplorationPurpose, ModelRef, SearchProvider } from "../shared/schemas";
  import type { ResearchReplacement, ResearchRequestDraft } from "../shared/research-revisions";
  import {
    PreviewWorkflowResultSchema,
    type WorkflowAction, type WorkflowDetail, type WorkflowLaunchDraft,
    type IdeaConversation as IdeaConversationView, type SubmitIdeaTurnRequest,
  } from "../shared/workflow-contracts";
  import type { z } from "zod";
  import { readResearchDefaults } from "./lib/research-defaults";
  import { hasSearchKey, SEARCH_PROVIDERS } from "./lib/search-providers";
  import { findHistoryIndex, parentHistory, pushHistory, replaceHistory, rememberScroll, sameRoute, traverseHistory, reconcileHistory, routeResolver,
    type NavigationRoute, type NavigationHistory, type SolutionsRoute } from "./lib/navigation-history";
  import DesktopBar from "./components/DesktopBar.svelte";
  import Icon from "./components/Icon.svelte";
  import Settings from "./components/Settings.svelte";
  import WelcomeSignIn from "./components/WelcomeSignIn.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import ScopeForm from "./components/ScopeForm.svelte";
  import ProblemCheckpoint from "./components/ProblemCheckpoint.svelte";
  import ResearchArchive from "./components/ResearchArchive.svelte";
  import SetupArchive from "./components/SetupArchive.svelte";
  import SolutionWorkspace from "./components/SolutionWorkspace.svelte";
  import OpportunityProgress, { TERMINAL_OPPORTUNITY_STATUSES } from "./components/OpportunityProgress.svelte";
  import WorkflowTabs, { type WorkflowStep } from "./components/WorkflowTabs.svelte";
  import RunUsage from "./components/RunUsage.svelte";
  import VibeProgress from "./components/VibeProgress.svelte";
  import ResearchRevisions from "./components/ResearchRevisions.svelte";
  import FrameReview from "./components/FrameReview.svelte";
  import type { ResearchFrame } from "../shared/research-frame";

  type Feedback = { text: string; source?: "workspace-load" } & (
    { tone: "error"; lifetime?: never } | { tone: "info"; lifetime: "progress" | "confirmation" }
  );
  type WorkspaceResult = { workspace: WorkspaceState };
  type ResearchExportResult = { cancelled: true } | { cancelled: false; file: string };
  type IdeasExportResult = { cancelled: true } | { cancelled: false; directory: string; files: string[] };
  type WorkflowPreview = z.infer<typeof PreviewWorkflowResultSchema>;

  let workspace = $state<WorkspaceState | null>(null);
  let loading = $state(true);
  let busy = $state(false);
  // Confirmations appear briefly as toasts. Progress and errors remain inline until replaced.
  let feedback = $state<Feedback | null>(null);
  $effect(() => {
    if (feedback?.tone !== "info" || feedback.lifetime !== "confirmation" || signInPromptOpen) return;
    const timer = setTimeout(() => feedback = null, 3_000);
    return () => clearTimeout(timer);
  });
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
  let draftThreadId = $state<string | null>(null);
  let setupDraft = $state<ReturnType<ScopeForm["captureDraft"]> | null>(null);
  $effect(() => {
    const thread = workspace?.threads.find((item) => item.id === workspace?.activeThreadId);
    if (thread?.isUnstartedDraft && draftThreadId !== thread.id) {
      draftThreadId = thread.id;
      setupDraft = null;
    }
  });
  function rememberDraft(threadId: string, draft: ReturnType<ScopeForm["captureDraft"]>) {
    if (threadId === draftThreadId) setupDraft = draft;
  }
  let route = $state<NavigationRoute>({ threadId: "", step: "setup", settings: false, solution: { kind: "list" } });
  let activeStep = $derived(route.step);
  let editingScopeThreadId = $state<string | null>(null);
  let editingApprovedFrameId = $state<string | null>(null);
  let nativeLogin = $state<NativeLoginStartResult | null>(null);
  let nativeLoginEpoch = 0;
  let settings: Settings | undefined;
  let settingsOpen = $derived(route.settings);
  // The welcome prompt walks through the accounts research needs: OpenAI sign-in, then a search key.
  // "Not now" hides it until the next launch or the next sign-out.
  let signInDismissed = $state(false);
  // Holds the prompt on its search step while it saves keys, so saving the first of two keys doesn't close it
  // before the second key's result (possibly an error) is shown.
  let holdSearchStep = $state(false);
  let searchKeySaved = $derived(!!workspace && SEARCH_PROVIDERS.some(({ id }) => hasSearchKey(workspace!.validation[id])));
  // Only once the runtime is ready (available), so a signed-in user never sees the prompt flash during startup checks.
  // Masked keys are reported even while keys are still being checked, so saved keys don't flash the search step either.
  let welcomeStep = $derived<"sign-in" | "search" | null>(!workspace?.validation.native.available ? null
    : !workspace.validation.native.connected ? "sign-in"
    : holdSearchStep || (!searchKeySaved && workspace.activeWorkflow?.purpose !== "known-problem" && workspace.runConfig?.researchMode !== "known-problem") ? "search" : null);
  let signInPromptOpen = $derived(welcomeStep !== null && !signInDismissed && !settingsOpen);
  // Navigation is always present: expanded, or as an icon rail. Wide windows dock the expanded sidebar and
  // Ctrl+B toggles it to the rail. Compact windows keep the rail docked and open the full list as an overlay
  // drawer, so the page never loses width to navigation it is not using.
  const COMPACT_NAVIGATION_QUERY = "(max-width: 1099px)";
  let sidebarExpanded = $state(true);
  let compactViewport = $state(typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(COMPACT_NAVIGATION_QUERY).matches);
  let mobileSidebarOpen = $state(false);
  let navigationOpen = $derived(compactViewport ? mobileSidebarOpen : sidebarExpanded);
  function toggleNavigation() {
    if (compactViewport) mobileSidebarOpen = !mobileSidebarOpen;
    else sidebarExpanded = !sidebarExpanded;
  }
  function closeMobileNavigation() {
    mobileSidebarOpen = false;
    void tick().then(() => document.getElementById("navigation-toggle")?.focus());
  }
  let history = $state<NavigationHistory>({ entries: [], index: -1 });
  let knownIdeas = $state<Record<string, string[]>>({});
  let mainContent: HTMLElement | undefined;
  let traversingHistory = $state(false);
  let historyScroll = $state<{ route: NavigationRoute; scrollTop: number } | null>(null);
  let resolveRoute = $derived(routeResolver(workspace?.threads ?? [], knownIdeas));
  let backIndex = $derived(findHistoryIndex(history, -1, resolveRoute));
  let forwardIndex = $derived(findHistoryIndex(history, 1, resolveRoute));
  // Backend reconciliation and run-driven tab changes replace the current entry.
  $effect(() => {
    if (loading || busy || traversingHistory || !workspace?.activeThreadId) return;
    const target = route.threadId === workspace.activeThreadId ? resolveRoute(route)
      : { threadId: workspace.activeThreadId, step: defaultStep(workspace), settings: route.settings, solution: { kind: "list" as const } };
    if (!target) return;
    untrack(() => {
      if (!sameRoute(route, target)) {
        if (route.threadId !== target.threadId) history = replaceHistory(history, target);
        history = reconcileHistory(history, resolveRoute);
        route = target;
      }
      const current = history.entries[history.index];
      if (!current || !sameRoute(current.route, target)) history = replaceHistory(history, target, mainContent?.scrollTop ?? 0);
    });
  });
  function navigateTo(target: NavigationRoute) {
    if (traversingHistory || sameRoute(route, target)) return;
    historyScroll = null;
    // A run-driven route can change before the history effect reconciles it.
    history = replaceHistory(history, route, mainContent?.scrollTop ?? 0);
    const scrollTop = route.threadId === target.threadId && route.step === target.step
      && sameRoute({ ...route, settings: target.settings }, target) ? mainContent?.scrollTop ?? 0 : 0;
    history = pushHistory(history, target, scrollTop);
    route = target;
    void tick().then(() => { if (mainContent) mainContent.scrollTop = scrollTop; });
  }
  function navigateSolutions(solution: SolutionsRoute, parent = false) {
    const target = { ...route, solution };
    if (!parent) { navigateTo(target); return; }
    history = rememberScroll(history, mainContent?.scrollTop ?? 0);
    const next = parentHistory(history, target, resolveRoute);
    void restoreHistory(next);
  }
  async function restoreHistory(next: NavigationHistory) {
    const entry = next.entries[next.index];
    if (!entry || !workspace || busy || traversingHistory) return;
    const leavingSettings = route.settings && !entry.route.settings;
    traversingHistory = true;
    try {
      if (entry.route.threadId !== workspace.activeThreadId) await selectThread(entry.route.threadId, false);
      if (workspace?.activeThreadId !== entry.route.threadId) return;
      const resolved = resolveRoute(entry.route);
      if (!resolved) return;
      history = reconcileHistory(next, resolveRoute);
      route = resolved;
      const scrollTop = history.entries[history.index]!.scrollTop;
      historyScroll = { route: resolved, scrollTop };
      await tick();
      if (route.settings) settings?.focusHeading();
      else if (leavingSettings) document.getElementById("settings-button")?.focus({ preventScroll: true });
    } finally { traversingHistory = false; }
  }
  async function navigateHistory(direction: -1 | 1) {
    if (busy || traversingHistory) return;
    history = rememberScroll(history, historyScroll && sameRoute(route, historyScroll.route) ? historyScroll.scrollTop : mainContent?.scrollTop ?? 0);
    await restoreHistory(traverseHistory(history, direction, resolveRoute));
  }
  // A conversation reload hides its tall content. Wait for the matching request and render before restoring.
  $effect(() => {
    const pending = historyScroll;
    if (!pending || !sameRoute(route, pending.route)) return;
    if (route.step === "ideas" && route.solution.kind === "conversation"
      && (conversationLoading || conversationIdeaId !== route.solution.ideaId
        || !conversation?.versions.some(version => version.solutionId === conversationIdeaId))) return;
    const epoch = conversationLoadEpoch;
    void tick().then(() => {
      if (historyScroll !== pending || !sameRoute(route, pending.route) || epoch !== conversationLoadEpoch) return;
      if (mainContent) mainContent.scrollTop = pending.scrollTop;
      historyScroll = null;
    });
  });
  $effect(() => {
    const solution = route.solution;
    if (busy || traversingHistory || route.threadId !== workspace?.activeThreadId) return;
    if (route.step === "ideas" && solution.kind === "conversation") {
      if (conversationIdeaId !== solution.ideaId) void openConversation(solution.ideaId);
    } else if (conversationIdeaId) closeConversation();
  });
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
  let runFrame = $derived(workflowDetail?.summary.sessionId === activeWorkflow?.sessionId ? workflowDetail?.researchFrame ?? null : null);
  let latestApprovedFrame = $derived(workflowDetail?.summary.sessionId === activeWorkflow?.sessionId
    ? workflowDetail?.latestResearchFrame ?? (runFrame?.approved ? runFrame : null) : null);
  let nextRequestFrame = $derived(latestApprovedFrame?.approved ?? runFrame?.approved ?? null);
  let reviewingFrame = $derived(workflowDetail?.summary.state === "waiting-for-review" && workflowDetail.summary.reviewKind === "frame" && runFrame?.approved === null);
  let investigators = $derived(workflowDetail?.tasks.flatMap(task => task.kind === "investigate-area" && task.investigator
    ? [{ ...task.investigator, taskId: task.id, state: task.state }] : []) ?? []);
  let canRegenerateFrame = $derived(Boolean(workflowDetail && (workflowDetail.summary.limits.enforced === false
    || workflowDetail.summary.budget.modelCalls.limit - workflowDetail.summary.budget.modelCalls.spent
      - workflowDetail.summary.budget.modelCalls.reserved - workflowDetail.summary.budget.modelCalls.uncertain >= 1)));
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
  let showSetupForm = $derived(Boolean(workspace && activeThread && (activeThread.status === "configuring" || editingScope || !workspace.scope)));
  let researchReady = $derived(Boolean(activeThread && (activeWorkflow || workspace?.problemCandidates.length || workspace?.rejectedProblemCandidates.length || activeThread.status === "discovery-running")));
  let ideasReady = $derived(Boolean(activeThread && (workspace?.solutions.length || workspace?.ideaGroups?.length || activeThread.status === "development-running" || activeThread.status === "solutions-ready"
    || activeWorkflow?.purpose === "known-problem" || activeWorkflow?.state === "finished")));
  // The run panel sits on top while a run is active, and stays there when it failed or needs attention so the
  // reason and Retry are in view. A run that ended normally keeps only "Run details" under its ideas.
  let runFinished = $derived(activeWorkflow?.state === "finished" && activeWorkflow.outcome !== "failed" && activeWorkflow.outcome !== "needs-attention");

  onMount(() => {
    const viewport = window.matchMedia?.(COMPACT_NAVIGATION_QUERY);
    const resizeNavigation = (event: MediaQueryListEvent) => {
      compactViewport = event.matches;
      mobileSidebarOpen = false;
    };
    viewport?.addEventListener("change", resizeNavigation);
    const closeDrawerOnEscape = (event: KeyboardEvent) => {
      if (!compactViewport || !mobileSidebarOpen || event.key !== "Escape" || document.querySelector("dialog[open]")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeMobileNavigation();
    };
    window.addEventListener("keydown", closeDrawerOnEscape, { capture: true });
    let composing = false;
    const compositionStart = () => { composing = true; };
    const compositionEnd = () => { composing = false; };
    window.addEventListener("compositionstart", compositionStart);
    window.addEventListener("compositionend", compositionEnd);
    const historyShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || composing || document.querySelector("dialog[open]")) return;
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void navigateHistory(event.key === "ArrowLeft" ? -1 : 1);
    };
    window.addEventListener("keydown", historyShortcut, { capture: true });
    void load();
    const clock = setInterval(() => clockNow = Date.now(), 1_000);
    // A development host restart or a dropped event stream can miss the terminal event.
    // Reconcile active sessions periodically so progress and completion still reach the UI.
    const workflowRefresh = setInterval(() => {
      if (activeWorkflow && ["running", "pause-requested", "stop-requested"].includes(activeWorkflow.state)) reconcileSoon();
    }, 5_000);
    const stopCommands = window.scraply.onAppCommand((command) => {
      if (command === "toggle-sidebar") toggleNavigation();
      else if (command === "back" || command === "forward") {
        if (!composing && !document.querySelector("dialog[open]")) void navigateHistory(command === "back" ? -1 : 1);
      }
      else if (command === "settings") void settings?.show();
      else if (command === "new-research") void createThread();
      else if (command === "export-research" && workspace?.activeThreadId) void exportResearch();
    });
    const dispose = window.scraply.onBackendEvent((event) => {
      if (event.type === "workflow-progress") {
        if (event.threadId === workspace?.activeThreadId) {
          if (event.sessionId === workspace?.activeWorkflow?.sessionId) {
            if (event.state === "finished" && workspace.activeWorkflow.mode === "vibe") route = { ...route, step: "ideas" };
            else if (event.state === "waiting-for-review") route = { ...route, step: "research" };
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
    return () => { window.removeEventListener("compositionstart", compositionStart); window.removeEventListener("compositionend", compositionEnd); window.removeEventListener("keydown", historyShortcut, { capture: true }); window.removeEventListener("keydown", closeDrawerOnEscape, { capture: true }); viewport?.removeEventListener("change", resizeNavigation); stopCommands(); dispose(); clearInterval(clock); clearInterval(workflowRefresh); if (reconcileTimer) clearTimeout(reconcileTimer); };
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
      if (next.activeThreadId) knownIdeas = { ...knownIdeas, [next.activeThreadId]: next.solutions.map(idea => idea.id) };
      if (changedThread) {
        conversationLoadEpoch += 1;
        conversation = null;
        conversationIdeaId = null;
        conversationError = null;
      }
      void refreshWorkflowDetail(next.activeWorkflow?.sessionId ?? null, next.activeWorkflow?.revision ?? null);
      progressReceivedAt = Date.now();
      if (changedThread) route = { threadId: next.activeThreadId ?? "", step: defaultStep(next), settings: route.settings, solution: { kind: "list" } };
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
    if (next.activeThreadId) knownIdeas = { ...knownIdeas, [next.activeThreadId]: next.solutions.map(idea => idea.id) };
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
    // Progress events do not change the workflow revision. Refresh running sessions on reconciliation too.
    if (!force && workflowDetail?.summary.sessionId === sessionId && workflowDetail.summary.revision >= (revision ?? 0)
      && !["running", "pause-requested", "stop-requested"].includes(workflowDetail.summary.state)) return;
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
      if (workflow.state === "finished" && (state.solutions.length > 0 || (state.ideaGroups?.length ?? 0) > 0)) return "ideas";
      return "research";
    }
    if (state.solutions.length > 0 || (state.ideaGroups?.length ?? 0) > 0 || thread?.status === "solutions-ready") return "ideas";
    if (thread?.status === "development-running") return "ideas";
    if (thread?.status === "discovery-running" || state.problemCandidates.length > 0 || state.rejectedProblemCandidates.length > 0) return "research";
    return "setup";
  }
  function openStep(step: WorkflowStep) {
    if (step === "research" && !researchReady) return;
    if (step === "ideas" && !ideasReady) return;
    navigateTo({ ...route, step });
  }
  async function createThread() {
    const remembered = workspace?.threads.find((thread) => thread.id === draftThreadId && !thread.archivedAt && thread.isUnstartedDraft);
    if (remembered) { await selectThread(remembered.id); return; }
    await action(async () => {
      const next = (await window.scraply.createThread()).workspace;
      setWorkspace(next);
      navigateTo({ threadId: next.activeThreadId ?? "", step: "setup", settings: false, solution: { kind: "list" } });
      latestEvent = null;
      editingScopeThreadId = null;
    });
  }
  async function selectThread(id: string, userNavigation = true) {
    await action(async () => {
      const next = await window.scraply.selectThread(id);
      setWorkspace(next);
      if (userNavigation) navigateTo({ threadId: id, step: defaultStep(next), settings: false, solution: { kind: "list" } });
      latestEvent = null;
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
      route = { ...route, step: defaultStep(next) };
      latestEvent = null;
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
      route = { ...route, step: defaultStep(next) };
      editingScopeThreadId = null;
    });
  }
  // Research is always named by the title agent. If it cannot answer (for example, the title model is
  // unavailable), the first line of the brief is used so naming never blocks a start.
  async function generateResearchTitle(context: string): Promise<string> {
    const defaults = readResearchDefaults();
    try {
      const result = await window.scraply.generateTitle({
        context: context.slice(0, 20000), model: defaults.titleModel, reasoningEffort: defaults.titleReasoningEffort,
      });
      return result.title;
    } catch {
      return (context.split("\n")[0] ?? "").slice(0, 80).trim() || "New research";
    }
  }
  async function saveScope(scope: NonNullable<WorkspaceState["scope"]>, config: NonNullable<WorkspaceState["runConfig"]>) {
    const threadId = workspace?.activeThreadId;
    if (!threadId || busy) return;
    busy = true;
    feedback = null;
    try {
      if (!scope.title.trim()) {
        scope = { ...scope, title: await generateResearchTitle([config.knownProblem, scope.domain, scope.audience, scope.observations].filter(Boolean).join("\n")) };
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
      if (threadId === draftThreadId) { draftThreadId = null; setupDraft = null; }
      setWorkspace(next);
      route = { ...route, step: defaultStep(next) };
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
      if (threadId === draftThreadId) { draftThreadId = null; setupDraft = null; }
      setWorkspace(await window.scraply.getWorkspace());
      await refreshWorkflowDetail(receipt.sessionId, receipt.revision, true);
      route = { ...route, step: contract.purpose === "known-problem" && contract.mode === "vibe" ? "ideas" : "research" };
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
    const active = workspace?.activeWorkflow;
    const summary = active && workflowDetail?.summary.sessionId === active.sessionId
      && workflowDetail.summary.revision > active.revision ? workflowDetail.summary : active;
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
  async function approveFrame(frame: ResearchFrame) {
    if (!runFrame) throw new Error("Reload the current research frame before approving it.");
    const knownProblem = runFrame.knownProblem;
    await commandWorkflow({ type: "approve-frame", frameId: runFrame.id, frame });
    route = { ...route, step: knownProblem && activeWorkflow?.mode === "vibe" ? "ideas" : "research" };
  }
  async function regenerateFrame(frame: ResearchFrame) {
    if (!runFrame) throw new Error("Reload the current research frame before regenerating it.");
    await commandWorkflow({ type: "regenerate-frame", frameId: runFrame.id, frame });
  }
  async function editFrameBrief() {
    const threadId = workspace?.activeThreadId;
    if (!threadId) return;
    await commandWorkflow({ type: "stop", reason: "Brief reopened for editing." });
    editingScopeThreadId = threadId;
    navigateTo({ ...route, step: "setup" });
  }
  async function saveApprovedFrame(frame: ResearchFrame) {
    if (!latestApprovedFrame?.approved) throw new Error("Reload the approved frame before editing it.");
    await commandWorkflow({ type: "edit-approved-frame", frameId: latestApprovedFrame.id, frame });
    editingApprovedFrameId = null;
    route = { ...route, step: "setup" };
    feedback = { text: "New frame version saved for future runs.", tone: "info", lifetime: "confirmation" };
  }
  async function previewCandidateAssessment(candidateId: string): Promise<WorkflowPreview> {
    const threadId = workspace?.activeThreadId;
    const summary = workflowDetail?.summary ?? activeWorkflow;
    if (!threadId || !summary) throw new Error("Open the saved workflow before assessing this candidate.");
    return window.scraply.previewWorkflow({ type: "candidate-assessment", threadId, sessionId: summary.sessionId,
      expectedRevision: summary.revision, candidateId });
  }
  async function assessCandidate(preview: WorkflowPreview) {
    if (preview.type !== "candidate-assessment" || !("candidateId" in preview.proposal) || preview.fieldErrors.length) {
      throw new Error("Preview a valid candidate assessment first.");
    }
    await commandWorkflow({ type: "assess-not-assessed", candidateId: preview.proposal.candidateId,
      previewHash: preview.previewHash, capabilityFingerprint: preview.capabilityFingerprint, previewExpiresAt: preview.expiresAt });
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
        : "Finish signing in in your browser. Scraply is waiting for the account callback.", tone: "info", lifetime: "progress" };
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
            ? { text: "Native model account connected.", tone: "info", lifetime: "confirmation" }
            : nativeValidationPending
              ? { text: "OpenAI sign-in finished.", tone: "info", lifetime: "confirmation" }
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
    feedback = { text: "Cancelling native account sign-in…", tone: "info", lifetime: "progress" };
    try {
      setWorkspace(await window.scraply.cancelNativeLogin({ loginId: login.loginId, providerId: login.providerId }));
      feedback = { text: "Native account sign-in cancelled.", tone: "info", lifetime: "confirmation" };
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
    signInDismissed = false;
  }
  // Key changes report failures to the control that made them (inline next to the field), not the page notice.
  async function saveSearchKey(provider: SearchProvider, apiKey: string) {
    setWorkspace(await window.scraply.saveSearchKey({ provider, apiKey }));
  }
  async function removeSearchKey(provider: SearchProvider) {
    setWorkspace(await window.scraply.removeSearchKey(provider));
  }
  // Saves the keys entered in the welcome prompt one at a time and returns each failure by provider.
  async function saveWelcomeSearchKeys(entries: Array<[SearchProvider, string]>): Promise<Partial<Record<SearchProvider, string>>> {
    holdSearchStep = true;
    const failures: Partial<Record<SearchProvider, string>> = {};
    for (const [provider, apiKey] of entries) {
      try { await saveSearchKey(provider, apiKey); }
      catch (cause) { failures[provider] = message(cause); }
    }
    if (Object.keys(failures).length === 0) holdSearchStep = false;
    return failures;
  }
  function dismissWelcome() {
    signInDismissed = true;
    holdSearchStep = false;
  }
  async function resumeResearch(runId: string) {
    await action(async () => {
      const next = await window.scraply.resumeResearch(runId);
      setWorkspace(next);
      route = { ...route, step: defaultStep(next) };
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
      route = { ...route, step: "ideas" };
      return;
    }
    await action(async () => {
      const api = window.scraply as typeof window.scraply & {
        selectProblems(request: { threadId: string; problemIds: string[]; userProblem: string|null; model: ModelRef; reasoningEffort: string; explorationPurpose: ExplorationPurpose }): Promise<WorkspaceState>;
      };
      setWorkspace(await api.selectProblems({ threadId, problemIds: ids, userProblem, model, reasoningEffort, explorationPurpose }));
      route = { ...route, step: "ideas" };
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
      if (!result.cancelled) feedback = { text: `Research JSON exported to ${result.file}.`, tone: "info", lifetime: "confirmation" };
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
          tone: "info", lifetime: "confirmation",
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
</script>

<div><DesktopBar canBack={backIndex !== -1} canForward={forwardIndex !== -1} onBack={() => navigateHistory(-1)} onForward={() => navigateHistory(1)} onToggle={toggleNavigation} navigationOpen={navigationOpen} compact={compactViewport} /></div>
<div class="app-shell" class:sidebar-rail={compactViewport || !sidebarExpanded}>
  {#if compactViewport && mobileSidebarOpen}<button class="sidebar-backdrop" aria-label="Close navigation" inert={settingsOpen} onclick={closeMobileNavigation}></button>{/if}
  <div id="research-navigation" class="sidebar-area" class:drawer={compactViewport && mobileSidebarOpen} inert={settingsOpen}>
  <Sidebar
    collapsed={!navigationOpen}
    threads={workspace?.threads ?? []}
    activeThreadId={workspace?.activeThreadId ?? null}
    {busy}
    {deletingThreadId}
    onNew={() => { mobileSidebarOpen = false; void createThread(); }}
    onSelect={(id) => { mobileSidebarOpen = false; void selectThread(id); }}
    onArchive={archiveThread}
    onRestore={(id) => archiveThread(id, false)}
  >
    {#snippet settingsControl()}
      <button id="settings-button" class="settings-button" onclick={() => { mobileSidebarOpen = false; settings?.show(); }}><Icon name="settings" size={20} /><span class="label">Settings</span></button>
    {/snippet}
  </Sidebar>
  </div>

  {#snippet runPanel()}
    {#if workflowDetail && activeWorkflow && workflowDetail.summary.sessionId === activeWorkflow.sessionId}
      <VibeProgress detail={workflowDetail} {investigators} {busy}
        onPause={() => commandWorkflow({ type: "pause" })}
        onResume={() => commandWorkflow({ type: "resume" })}
        onStop={() => commandWorkflow({ type: "stop" })}
        onRetryTask={(taskId, expectedTerminalAttemptId, acknowledgeUnknownCompletion) => commandWorkflow({ type: "retry-task", taskId, expectedTerminalAttemptId, acknowledgeUnknownCompletion })}
        onReassessProblems={(taskId) => commandWorkflow({ type: "reassess-problems", taskId })}
        onLoadMoreTasks={loadMoreWorkflowTasks}
        onPreviewExtension={previewWorkflowExtension} onApplyExtension={applyWorkflowExtension} />
    {/if}
  {/snippet}
  <main bind:this={mainContent} class="main-content" class:setup-active={activeStep === "setup" && showSetupForm} inert={settingsOpen}>
    {#if workspace && activeThread}
      <header class="workspace-header">
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
      </header>
      {#if !activeWorkflow}<RunUsage usage={activeRun?.usage} />{/if}
      {#if !runFinished}<div class="workflow-progress-wrap">{@render runPanel()}</div>{/if}
      {#if !activeWorkflow && workspace.opportunityExploration}
        <!-- Like the workflow summary above, a finished exploration steps aside while one idea is open. -->
        {#if !(activeStep === "ideas" && ideaFocused && TERMINAL_OPPORTUNITY_STATUSES.includes(workspace.opportunityExploration.status))}
          <div class="workflow-progress-wrap"><OpportunityProgress progress={workspace.opportunityExploration} {busy} onPause={pauseOpportunities} onResume={startOrResumeOpportunities} onPreviewExtension={previewOpportunityExtension} onApplyExtension={applyOpportunityExtension} /></div>
        {/if}
      {:else if !activeWorkflow && workspace.runConfig?.opportunityExploration && workspace.solutions.length > 0}
        <div class="notice"><button disabled={busy || workspace.opportunityReviewStatus?.running} onclick={startOrResumeOpportunities}>Continue toward {workspace.runConfig.opportunityExploration.targetFamilies} distinct hypotheses</button></div>
      {/if}
      {#if workspace.opportunityReviewStatus?.kind === "review" && workspace.opportunityReviewStatus.running}<div class="notice" role="status">Reviewing saved business ideas</div>{/if}
      {#if workspace.opportunityReviewStatus?.kind === "experiment" && workspace.opportunityReviewStatus.running}<div class="notice" role="status">Planning and reviewing a focused experiment</div>{/if}
      {#if activeThread.status === "failed" && !activeWorkflow}
        <div class="run-stopped" role="status">
          <div><strong>Run stopped</strong><span>{activeRun?.resumeBlockedReason ?? activeRun?.completionReason ?? activeRun?.lastActivity ?? "The last run failed or was cancelled. Review the setup, then retry explicitly."}</span></div>
          <div class="run-stopped-actions">
            {#if activeRun?.canResume}
              <button disabled={busy} onclick={() => resumeResearch(activeRun.runId)}>Resume attempt</button>
            {/if}
            {#if activeRun && ["queued", "running"].includes(activeRun.status)}<button class="cancel" disabled={busy} onclick={() => cancelResearch(activeRun.runId)}>Cancel run</button>{/if}
            <button disabled={busy} onclick={() => { openStep("setup"); editingScopeThreadId = activeThread?.id ?? null; }}>Edit setup</button>
          </div>
        </div>
      {/if}
    {/if}

    {#if feedback && (feedback.tone === "error" || feedback.lifetime === "progress") && !settingsOpen && !signInPromptOpen}<div class="notice" class:error={feedback.tone === "error"} role={feedback.tone === "error" ? "alert" : "status"}>{feedback.text}{#if feedback.tone === "error"}<button aria-label="Dismiss" onclick={() => feedback = null}>×</button>{/if}</div>{/if}

    {#if loading}
      <div class="skeleton" role="status" aria-label="Loading workspace"><i></i><i></i><i></i></div>
    {:else if !workspace || !activeThread}
      <div class="empty-workspace"><button disabled={busy} onclick={createThread}>New research</button></div>
    {:else if activeStep === "setup"}
      {#if showSetupForm}
        <div id="workflow-panel-setup" role="tabpanel" aria-label="Research setup">
          {#key workspace.activeThreadId}
            <ScopeForm {workspace} {busy} initialDraft={workspace.activeThreadId === draftThreadId ? setupDraft : null} onRememberDraft={rememberDraft} frameLanguages={latestApprovedFrame?.approved?.languages} onSave={saveScope} onStart={startResearch} onPreviewWorkflow={previewWorkflow} onStartWorkflow={startWorkflow} onGenerateTitle={generateResearchTitle} onRetry={retryConnections} onOpenSettings={() => settings?.show()} />
          {/key}
        </div>
      {:else}
        {#if activeThread.status === "failed" || activeWorkflow?.state === "finished"}
          <SetupArchive {workspace} onEdit={() => { editingScopeThreadId = activeThread?.id ?? null; }} />
        {:else}
          <SetupArchive {workspace} />
        {/if}
      {/if}
      {#if latestApprovedFrame?.approved}
        <section class="approved-frame" aria-label="Approved research frame">
          <details><summary>Approved research frame, version {latestApprovedFrame.version}</summary>
            <div class="approved-frame-content"><h2>Goal</h2><p>{latestApprovedFrame.approved.goal}</p><h2>Success criteria</h2><ul>{#each latestApprovedFrame.approved.successCriteria as criterion (criterion.id)}<li>{criterion.name} <span>{criterion.weight}</span></li>{/each}</ul>
              <h2>Search languages</h2><p>{latestApprovedFrame.approved.languages.join(", ")}</p>
              {#if latestApprovedFrame.approved.areas.length}<h2>Research areas</h2><ul>{#each latestApprovedFrame.approved.areas as area (area.id)}<li>{area.name}{area.included ? "" : " (excluded)"}</li>{/each}</ul>{/if}
            </div>
          </details>
          {#if runFrame?.version !== latestApprovedFrame.version}<p>This run uses version {runFrame?.version}. New runs use version {latestApprovedFrame.version}.</p>{/if}
          <button type="button" disabled={busy || !["finished", "waiting-for-review"].includes(activeWorkflow?.state ?? "")} onclick={() => { editingApprovedFrameId = latestApprovedFrame!.id; openStep("research"); }}>Edit approved frame</button>
        </section>
      {/if}
    {:else if activeStep === "research"}
      {#if latestApprovedFrame?.approved && editingApprovedFrameId === latestApprovedFrame.id}
        <div id="workflow-panel-research" role="tabpanel" aria-label="Research frame editing">
          <div class="frame-edit-note"><button type="button" disabled={busy} onclick={() => editingApprovedFrameId = null}>Cancel frame edits</button></div>
          <FrameReview frame={latestApprovedFrame.approved} sources={latestApprovedFrame.sources} purpose={latestApprovedFrame.knownProblem ? "known-problem" : "discovery"} {busy} commitLabel="Save new version" onCommit={saveApprovedFrame} onOpenSource={openExternalUrl} />
        </div>
      {:else if reviewingFrame && runFrame && workflowDetail}
        <div id="workflow-panel-research" role="tabpanel" aria-label="Research frame review">
          {#key runFrame.id}<FrameReview frame={runFrame.draft} sources={runFrame.sources} purpose={runFrame.knownProblem ? "known-problem" : "discovery"}
            usage={{ modelCalls: workflowDetail.summary.budget.modelCalls.spent, searches: workflowDetail.summary.budget.searches.spent }}
            {busy} canRegenerate={canRegenerateFrame} onCommit={approveFrame} onRegenerate={regenerateFrame} onEditBrief={editFrameBrief} onOpenSource={openExternalUrl} />{/key}
        </div>
      {:else if activeWorkflow && ["running", "paused", "pause-requested", "stop-requested"].includes(activeWorkflow.state)}
        <div id="workflow-panel-research" role="tabpanel" aria-label="Research"></div>
      {:else if activeThread.status === "discovery-running" && !activeWorkflow}
        <div class="running" id="workflow-panel-research" role="tabpanel" aria-label="Research" tabindex="0">
          <div class="activity-symbol"><Icon name="research" size={30} /></div><p class="eyebrow">Discovery in progress</p>
          <h1>Following the evidence.</h1>
          <div class="activity"><span></span><p>{runActivity}</p></div>
          {#if activeRun}<div class="progress-facts" aria-label="Run progress"><strong>{stageLabel(runtimeProgress.stage)}</strong>{#if runtimeProgress.modelState}<span>{runtimeProgress.modelState === "waiting" ? "Queued for model" : runtimeProgress.modelState === "dispatched" ? "Sent to model" : "Accepted by model"}</span>{/if}{#if elapsedStatus}<span>{elapsedStatus}</span>{/if}{#if runtimeProgress.lastSuccessfulCheckpoint}<span>Last checkpoint: {runtimeProgress.lastSuccessfulCheckpoint}</span>{/if}</div>{/if}
          {#if activeRun}<div class="run-actions"><button class="cancel" disabled={busy} onclick={() => cancelResearch(activeRun.runId)}>Cancel run</button></div>{/if}
        </div>
      {:else if (activeWorkflow ? activeWorkflow.state === "waiting-for-review" : activeThread.status === "problems-ready") && (workspace.problemCandidates.length > 0 || workspace.rejectedProblemCandidates.length > 0)}
        <div id="workflow-panel-research" role="tabpanel" aria-label="Research">
          {#key workspace.activeThreadId}
            <ProblemCheckpoint problems={workspace.problemCandidates} rejectedCandidates={workspace.rejectedProblemCandidates} modelOptions={workspace.modelOptions} initialConfig={activeRun?.problemId ? activeRun.runConfig ?? workspace.runConfig : workspace.runConfig} priorDevelopment={Boolean(activeRun?.problemId)} fixedExplorationPurpose={activeWorkflow ? workspace.runConfig?.explorationPurpose ?? "general-solutions" : undefined} workflowVersion={activeRun?.workflowVersion} ideaCount={workspace.runConfig?.ideaCount} {busy} onCommit={selectProblems} onExport={exportResearch} onOpenSource={openExternalUrl}
              {...(activeWorkflow ? { previewCandidateAssessment, onAssessCandidate: assessCandidate } : {})} />
          {/key}
        </div>
      {:else if workspace.problemCandidates.length > 0 || workspace.rejectedProblemCandidates.length > 0}
        <ResearchArchive problems={workspace.problemCandidates} rejectedCandidates={workspace.rejectedProblemCandidates} extraLeads={workspace.problemLeads} {busy} onExport={exportResearch} onOpenSource={openExternalUrl}
          {...(activeWorkflow ? { previewCandidateAssessment, onAssessCandidate: assessCandidate } : {})} />
      {:else}
        <div class="failed" class:after-summary={Boolean(activeWorkflow)} id="workflow-panel-research" role="tabpanel" aria-label="Research" tabindex="0"><p class="eyebrow">{activeWorkflow ? "Research outcome" : "Research unavailable"}</p><h1>{activeWorkflow?.stopReason ?? "No completed research is ready yet."}</h1>{#if activeRun || activeWorkflow}<div class="zero-idea-actions"><button disabled={busy} onclick={exportResearch}>Export research JSON</button></div>{/if}</div>
      {/if}
      {#if activeWorkflow}
        <ResearchRevisions requests={workspace.researchRequests} findings={workspace.researchFindings}
          readOnly={reviewingFrame || editingApprovedFrameId === latestApprovedFrame?.id || (activeWorkflow.mode === "vibe" && activeWorkflow.state !== "finished") || !(["running", "waiting-for-review"].includes(activeWorkflow.state)
            || (activeWorkflow.state === "finished" && !!activeWorkflow.activeSnapshotId))}
          activeSnapshotId={activeWorkflow.activeSnapshotId} modelOptions={workspace.modelOptions}
          researchModel={workspace.runConfig?.model ?? null} researchReasoningEffort={workspace.runConfig?.reasoningEffort ?? "medium"}
          {...(nextRequestFrame ? { goalKind: nextRequestFrame.goalKind } : {})}
          languageCount={nextRequestFrame?.languages.length ?? 1} depth="quick"
          {busy} onRequest={requestResearch} onApply={applyResearch} onKeep={keepResearch} onOpenSource={openExternalUrl} />
      {/if}
    {:else if activeThread.status === "development-running" || activeThread.status === "solutions-ready" || workspace.solutions.length > 0 || (workspace.ideaGroups?.length ?? 0) > 0}
      <div id="workflow-panel-ideas" role="tabpanel" aria-label="Solutions">
        {#key workspace.activeThreadId}
        <SolutionWorkspace route={route.solution} onNavigate={navigateSolutions} onBack={(parent) => navigateSolutions(parent, true)} interactive={!settingsOpen} footer={runFinished ? runPanel : undefined} solutions={workspace.solutions} ideaGroups={workspace.ideaGroups} {busy} run={activeRun} elapsed={elapsedStatus ?? ""} runStage={stageLabel(runtimeProgress.stage)} onStop={cancelResearch} analysisBlocked={!!activeRun && ["queued", "running"].includes(activeRun.status)} opportunities={workspace.opportunityFamilies} opportunityReviewRunning={workspace.opportunityReviewStatus?.running} modelOptions={workspace.modelOptions} initialConfig={workspace.runConfig} activeResearchSnapshotId={appliedResearchSnapshotId} onFocusChange={(focused) => ideaFocused = focused} onReviewOpportunities={reviewSavedOpportunities} onEditMembership={editOpportunityMembership} onPlanExperiment={requestFocusedExperiment} workflowVersion={activeRun?.workflowVersion} onSelect={selectOption} onSave={saveDecision} onExport={exportIdeas} onOpenSource={openExternalUrl} onEvidenceFollowUp={requestEvidenceFollowUp} onEvidenceReassessment={requestEvidenceReassessment} {conversation} {conversationLoading} {conversationError} onOpenConversation={openConversation} onSubmitIdeaTurn={submitIdeaTurn} onSelectConversationVersion={selectConversationVersion} onLoadMoreConversation={(cursor) => refreshConversation(conversationIdeaId ?? "", cursor)} />
        {/key}
      </div>
    {:else if activeWorkflow}
      <div class="failed" id="workflow-panel-ideas" role="tabpanel" aria-label="Solutions" tabindex="0">
        <h1>{activeWorkflow.stopReason ?? (activeWorkflow.state === "finished" ? "No qualifying ideas were produced." : "Ideas are being developed.")}</h1>
        {#if activeWorkflow.state === "finished"}<div class="zero-idea-actions"><button disabled={busy} onclick={() => exportIdeas("markdown")}>Export result</button><button disabled={busy} onclick={() => exportIdeas("json")}>Export JSON</button></div>{/if}
        {#if runFinished}{@render runPanel()}{/if}
      </div>
    {:else if activeThread.status === "failed"}
      <div class="failed" id="workflow-panel-ideas" role="tabpanel" aria-label="Solutions" tabindex="0"><h1>The run stopped before any solutions were generated.</h1></div>
    {:else}
      <div class="failed" id="workflow-panel-ideas" role="tabpanel" aria-label="Solutions" tabindex="0"><h1>Complete the research step first.</h1></div>
    {/if}
  </main>
  <Settings bind:this={settings} open={settingsOpen} onOpenChange={(open) => navigateTo({ ...route, settings: open })} feedback={feedback?.tone === "error" || feedback?.lifetime === "progress" ? feedback : null} {workspace} {busy} {nativeLogin}
    onRetry={retryConnections} onConnectNative={connectNativeAccount} onCancelNative={cancelNativeLogin}
    onRefreshNative={refreshNativeAccount} onLogoutNative={logoutNativeAccount}
    onSaveSearchKey={saveSearchKey} onRemoveSearchKey={removeSearchKey} onOpenUrl={(url) => void openExternalUrl(url)}
    onOpenData={openDataFolder} onOpenLogs={openLogsFolder} onRestore={(id) => archiveThread(id, false)} onDelete={deleteThread} />
  {#if signInPromptOpen && workspace && welcomeStep}
    <!-- First launch creates an empty draft, so "returning" means some research has moved past setup. -->
    <WelcomeSignIn step={welcomeStep} validation={workspace.validation} returning={workspace.threads.some((thread) => thread.status !== "configuring")} {busy} {nativeLogin}
      error={feedback?.tone === "error" ? feedback.text : null}
      onConnect={(method) => void connectNativeAccount("openai-subscription", method)}
      onCancel={() => void cancelNativeLogin()} onSaveSearchKeys={saveWelcomeSearchKeys} onOpenUrl={(url) => void openExternalUrl(url)}
      onDismiss={dismissWelcome} />
  {/if}
  <!-- The region remains present for screen readers. A confirmation waits while the welcome prompt is open. -->
  <div class="toasts" role="status" aria-live="polite">
    {#if feedback?.tone === "info" && feedback.lifetime === "confirmation" && !signInPromptOpen}<p class="toast">{feedback.text}</p>{/if}
  </div>
</div>

<style>
  .workflow-progress-wrap { padding:18px var(--page-gutter) 0; }
  .approved-frame { margin:24px var(--page-gutter);padding:20px 0;border-top:1px solid var(--border); }.approved-frame summary { cursor:pointer;font-size:15px; }.approved-frame p { color:var(--muted);font-size:13px;max-width:76ch; }.approved-frame-content { padding-top:12px; }.approved-frame-content h2 { margin:16px 0 7px;font-size:14px;font-weight:550; }.approved-frame-content ul { list-style:disc;padding-left:20px;color:var(--muted);font-size:13px; }.approved-frame-content li { margin:6px 0; }.approved-frame-content li span { margin-left:10px;color:var(--subtle); }.approved-frame button,.frame-edit-note button { padding:9px 12px;border:1px solid var(--border-strong);border-radius:8px;background:var(--surface);color:var(--text);font-size:13px; }.frame-edit-note { display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px var(--page-gutter) 0; }
  /* Research requests follow the problem list as the next section, so the list drops its end-of-page padding. */
  .main-content > :global(.archive:has(~ .research-revisions)),
  .main-content > :global(#workflow-panel-research:has(~ .research-revisions) > .checkpoint) { padding-bottom:24px; }
  .sidebar-area { display:contents; }
  .app-shell.sidebar-rail { --sidebar-width:60px; }
  .settings-button { display:flex;align-items:center;gap:10px;width:100%;padding:9px 12px;min-height:38px;border:0;border-radius:7px;background:transparent;color:var(--muted);font-size:13px;text-align:left;transition:background 180ms ease,color 180ms ease; }
  .settings-button:hover { background:var(--surface-2);color:var(--text); }

  /* The navigation sits flush on the window's left edge as part of the black window chrome, like the title bar above it;
     only the page floats as a panel. The shell therefore has no left padding, so no width is spent on an outer gutter. */
  .app-shell { --sidebar-width:var(--sidebar-expanded-width);height:calc(100% - 36px);display:grid;grid-template-columns:var(--sidebar-width) minmax(0,1fr);gap:10px;padding:2px 10px 10px 0; }
  /* The page is a black panel with the same hairline edge as the glass around it.
     It is also the `page` size container: page components use @container page queries so their
     breakpoints follow the width they actually get, whatever the navigation is doing. */
  .main-content { grid-column:2;container:page / inline-size;min-width:0;overflow-y:auto;overflow-x:hidden;scrollbar-gutter:stable;position:relative;border:1px solid var(--glass-edge);border-radius:var(--panel-radius);background:var(--bg);box-shadow:var(--glass-rim); }
  /* The title sits at the page's left edge and the tabs at its right edge, whatever the window width.
     When the title would get narrower than its flex-basis, the tabs wrap onto their own row instead of squeezing it. */
  .workspace-header { position:sticky;top:0;z-index:3;flex:none;min-height:72px;padding:12px 24px;display:flex;flex-wrap:wrap;align-items:center;gap:6px 24px;background:rgb(0 0 0 / .55);backdrop-filter:blur(20px) saturate(150%);border-bottom:1px solid var(--border); }
  .topbar { display:flex;align-items:center;flex:1 1 300px;min-width:0;gap:16px;color:var(--muted); }
  .location { display:block;margin:0;color:var(--text);font-size:clamp(20px,2.6cqi,24px);font-weight:600;letter-spacing:-.6px;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
  .main-content.setup-active { display:flex;flex-direction:column; }
  .setup-active > :global(:not(#workflow-panel-setup)) { flex:none; }
  .setup-active > #workflow-panel-setup { flex:1 0 0;min-height:420px; }
  .calls { white-space:nowrap;margin-left:16px;font:500 13px var(--sans); }.calls strong { color:var(--text);font-weight:600; }
  .notice { flex:none;margin:12px var(--page-gutter) 0;padding:12px 16px;border:1px solid var(--border-strong);border-radius:10px;background:var(--surface-2);display:flex;justify-content:space-between;gap:16px;color:var(--muted);font-size:13px;overflow-wrap:anywhere; }
  .notice.error { border-color:#df929260;color:var(--danger); }
  .notice button { border:0;background:transparent;color:inherit; }
  /* Above Settings (z-index 20); pointer events pass through the empty region. */
  .toasts { position:fixed;right:20px;bottom:20px;z-index:40;display:grid;justify-items:end;max-width:min(380px,calc(100vw - 40px));pointer-events:none; }
  .toast { margin:0;padding:12px 16px;border:1px solid var(--glass-edge);border-radius:12px;background:var(--glass-fill-dense);box-shadow:var(--glass-shadow);backdrop-filter:var(--glass-blur);color:var(--text);font-size:13px;line-height:1.5;overflow-wrap:anywhere;animation:toast-in 220ms var(--ease); }
  @keyframes toast-in { from { opacity:0;transform:translateY(8px); } }
  @media (prefers-reduced-motion: reduce) { .toast { animation:none; } }
  .empty-workspace { padding:var(--page-top) var(--page-inline); }
  .empty-workspace button { padding:10px 16px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text); }
  .activity-symbol { display:grid;place-items:center;width:76px;height:76px;border:1px solid #bdbdbd30;border-radius:24px;color:var(--accent-strong);background:#bdbdbd08;box-shadow:inset 0 1px #ffffff15; }
  .eyebrow { font:500 13px var(--sans);color:var(--muted);margin:28px 0 0; }
  .running,.failed { display:flex;flex-direction:column;align-items:start;max-width:900px;min-height:calc(100dvh - 160px);margin:auto;justify-content:center;padding:60px var(--page-inline); }
  /* Under a run summary the outcome follows it at the page edge instead of centering in the window. */
  .failed.after-summary { min-height:0;max-width:none;margin:0;justify-content:flex-start;padding:36px var(--page-gutter) 48px; }
  .running h1,.failed h1 { font-size:38px;font-weight:600;letter-spacing:-.035em;line-height:1.25;max-width:620px;margin:10px 0 20px; }
  .failed > p:not(.eyebrow) { color:var(--muted);font-size:13px;line-height:1.8;max-width:650px;margin:0; }
  .zero-idea-actions { display:flex;flex-wrap:wrap;gap:8px;margin-top:22px; }
  .zero-idea-actions button { min-height:38px;padding:8px 12px;border:1px solid var(--border-strong);border-radius:8px;background:#000;color:var(--text);font-size:13px; }
  .activity-symbol { position:relative; }.activity-symbol::after { content:"";position:absolute;inset:-5px;border:1px solid transparent;border-top-color:var(--accent);border-radius:28px;animation:orbit 4s linear infinite; }
  .activity { width:100%;display:flex;gap:14px;border:1px solid var(--border);border-radius:14px;padding:20px;background:var(--surface);margin:24px 0;align-items:center; }
  .activity p { margin:0;font-size:13px;color:var(--muted); }.activity span { width:7px;height:7px;border-radius:50%;background:var(--accent);flex:none;animation:pulse 1.5s ease infinite alternate; }
  .progress-facts { display:flex;flex-wrap:wrap;gap:8px 18px;color:var(--subtle);font-size:13px; }
  .progress-facts strong { color:var(--text);font-weight:600; }
  .run-actions { display:flex;gap:9px; }.run-actions button { border:1px solid var(--border-strong);background:transparent;color:var(--text);padding:10px 14px;border-radius:8px;font-size:13px; }.run-actions .cancel { color:var(--danger); }
  .run-stopped { display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px;margin:14px var(--page-gutter) 0;padding:16px;border:1px solid #df92924a;border-radius:12px;background:#df929208; }
  .run-stopped > div:first-child { display:grid;gap:5px; }.run-stopped strong { font-size:13px; }.run-stopped span { color:var(--muted);font-size:13px; }.run-stopped-actions { display:flex;flex-wrap:wrap;gap:8px; }.run-stopped-actions button { border:1px solid var(--border-strong);border-radius:8px;background:transparent;color:var(--text);padding:9px 13px;font-size:13px; }.run-stopped-actions .cancel { color:var(--danger); }
  .skeleton { padding:90px var(--page-inline);display:grid;gap:18px; }.skeleton i { display:block;height:24px;max-width:720px;border-radius:8px;background:linear-gradient(90deg,var(--surface),var(--surface-2),var(--surface));background-size:200% 100%;animation:shimmer 1.2s infinite; }.skeleton i:first-child { height:58px;width:60%; }.skeleton i:last-child { width:40%; }
  .main-content > :global([role="tabpanel"]) { animation:page-reveal 200ms var(--ease); }
  @keyframes page-reveal { from { opacity:.6;transform:translateY(4px); }to { opacity:1;transform:none; } }
  @keyframes shimmer { to { background-position:-200% 0; } }@keyframes pulse { to { opacity:.3; } }@keyframes orbit { to { transform:rotate(360deg); } }
  /* Compact windows: the expanded list floats over the page while the rail keeps its grid column. */
  .sidebar-backdrop { position:fixed;inset:36px 0 0;z-index:10;width:100%;border:0;background:var(--glass-backdrop);backdrop-filter:blur(8px); }
  .sidebar-area.drawer { position:fixed;top:38px;bottom:10px;left:10px;z-index:11;display:block;width:min(288px,calc(100vw - 40px)); }
  /* The drawer floats over the page, so it takes the dense glass panel treatment the docked navigation does not need. */
  .sidebar-area.drawer :global(.sidebar) { height:100%;border:1px solid var(--glass-edge);border-radius:var(--panel-radius);background:var(--glass-fill-dense);box-shadow:var(--glass-shadow);backdrop-filter:var(--glass-blur); }
  @media(max-width:720px) { .app-shell { gap:8px;padding:0 8px 8px 0; }.sidebar-area.drawer { top:36px;bottom:8px;left:8px; } }
  @container page (max-width:760px) { .calls { display:none; } }
  @container page (max-width:600px) { .running h1,.failed h1 { font-size:28px; } }
  /* Short windows (or high zoom) give the page every row: the header scrolls away with it. */
  @media(max-height:600px) { .main-content.setup-active { display:block; }.workspace-header { position:static; } }
</style>
