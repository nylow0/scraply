<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import type { NativeLoginStartResult, ResearchEvent, SolutionView, WorkspaceState } from "../shared/ipc";
  import type { ModelRef } from "../shared/schemas";
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
  import WorkflowTabs, { type WorkflowStep } from "./components/WorkflowTabs.svelte";
  import RunUsage from "./components/RunUsage.svelte";

  type Feedback = { text: string; tone: "error" | "info"; source?: "workspace-load" };
  type WorkspaceResult = { workspace: WorkspaceState };
  type ResearchExportResult = { cancelled: true } | { cancelled: false; file: string };
  type IdeasExportResult = { cancelled: true } | { cancelled: false; directory: string; files: string[] };

  let workspace = $state<WorkspaceState | null>(null);
  let loading = $state(true);
  let busy = $state(false);
  let feedback = $state<Feedback | null>(null);
  let deletingThreadId = $state<string | null>(null);
  let latestEvent = $state<ResearchEvent | null>(null);
  let reviewSelection = $state(false);
  let activeStep = $state<WorkflowStep>("setup");
  let editingScopeThreadId = $state<string | null>(null);
  let nativeLogin = $state<NativeLoginStartResult | null>(null);
  let nativeLoginEpoch = 0;
  let settings: Settings | undefined;
  let settingsOpen = $state(false);
  let sidebarVisible = $state(true);
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
  let activeThread = $derived(workspace?.threads.find((item) => item.id === workspace?.activeThreadId) ?? null);
  let activeRun = $derived(workspace?.latestResearchRun ?? null);
  // Local-only override: lets the user reopen the scope form from a failed run without touching server state.
  let editingScope = $derived(editingScopeThreadId !== null && editingScopeThreadId === activeThread?.id);
  let researchReady = $derived(Boolean(activeThread && (workspace?.problemCandidates.length || workspace?.rejectedProblemCandidates.length || activeThread.status === "discovery-running")));
  let ideasReady = $derived(Boolean(activeThread && (workspace?.solutions.length || activeThread.status === "development-running" || activeThread.status === "solutions-ready")));

  onMount(() => {
    void load();
    const stopCommands = window.scraply.onAppCommand((command) => {
      if (command === "toggle-sidebar") sidebarVisible = !sidebarVisible;
      else if (command === "back") void navigateHistory(-1);
      else if (command === "forward") void navigateHistory(1);
      else if (command === "settings") void settings?.show();
      else if (command === "new-research") { settingsOpen = false; void createThread(); }
      else if (command === "export-research" && workspace?.activeThreadId) void exportResearch();
    });
    const dispose = window.scraply.onBackendEvent((event) => {
      if (event.threadId !== workspace?.activeThreadId) return;
      latestEvent = event;
      if (event.type === "run-progress" && workspace?.latestResearchRun?.runId === event.runId) {
        const measureId = progressMeasureId++;
        const startMark = `scraply-progress-received-${measureId}`;
        const visibleMark = `scraply-progress-rendered-${measureId}`;
        performance.mark(startMark);
        workspace.latestResearchRun.lastActivity = event.message;
        workspace.latestResearchRun.codexCalls = event.codexCalls;
        workspace.latestResearchRun.searches = event.searches;
        if (event.usage) workspace.latestResearchRun.usage = event.usage;
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
    return () => { stopCommands(); dispose(); if (reconcileTimer) clearTimeout(reconcileTimer); };
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
    workspace = next;
    if (validationPending(next)) reconcileSoon(500);
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
    if (thread?.status === "development-running" || thread?.status === "solutions-ready" || state.solutions.length > 0) return "ideas";
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
    await action(async () => setWorkspace(await window.scraply.resumeResearch(runId)));
  }
  async function cancelResearch(runId: string) {
    await action(async () => setWorkspace(await window.scraply.cancelResearch(runId)));
  }
  async function selectProblems(ids: string[], userProblem: string | null, model: ModelRef, reasoningEffort: string) {
    const threadId = workspace?.activeThreadId;
    if (!threadId) return;
    await action(async () => {
      setWorkspace(await window.scraply.selectProblems({ threadId, problemIds: ids, userProblem, model, reasoningEffort }));
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
  async function saveDecision(solutionId: string, userDecision: string, observedResult: string) {
    const threadId = workspace?.activeThreadId;
    if (!threadId || busy) throw new Error("Wait for the current action before saving.");
    busy = true;
    try { setWorkspace(await window.scraply.saveDecision({ threadId, solutionId, userDecision, observedResult })); }
    finally { busy = false; if (reconcilePending) reconcileSoon(); }
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
</script>

<DesktopBar canBack={backIndex !== -1 && !busy} canForward={forwardIndex !== -1 && !busy} onBack={() => navigateHistory(-1)} onForward={() => navigateHistory(1)} onToggle={() => sidebarVisible = !sidebarVisible} />
<div class="app-shell" class:sidebar-hidden={!sidebarVisible}>
  <div class="sidebar-area" hidden={!sidebarVisible} inert={settingsOpen}>
  <Sidebar
    threads={workspace?.threads.filter((thread) => !thread.archivedAt) ?? []}
    activeThreadId={workspace?.activeThreadId ?? null}
    {busy}
    {deletingThreadId}
    onNew={createThread}
    onSelect={selectThread}
    onArchive={archiveThread}
  >
    {#snippet settingsControl()}
      <button id="settings-button" class="settings-button" onclick={() => settings?.show()}><Icon name="settings" size={20} />Settings</button>
    {/snippet}
  </Sidebar>
  </div>

  <main class="main-content" inert={settingsOpen}>
    {#if workspace && activeThread}
      <div class="topbar">
        <h1 class="location" title={activeThread.title}>{activeThread.title}</h1>
        {#if activeRun}<div class="calls"><strong>{activeRun.codexCalls}</strong> model calls / ~{activeRun.projectedCodexCalls} · <strong>{activeRun.searches}</strong> searches / ~{activeRun.projectedSearches}</div>{/if}
      </div>
      <WorkflowTabs
        active={activeStep}
        setupReady={true}
        {researchReady}
        {ideasReady}
        onSelect={openStep}
      />
      <RunUsage usage={activeRun?.usage} />
      {#if activeThread.status === "failed"}
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
            <ScopeForm {workspace} {busy} onSave={saveScope} onStart={startResearch} onRetry={retryConnections} onOpenSettings={() => settings?.show()} />
          {/key}
        </div>
      {:else}
        {#if activeThread.status === "failed"}
          <SetupArchive {workspace} onEdit={() => { editingScopeThreadId = activeThread?.id ?? null; }} />
        {:else}
          <SetupArchive {workspace} />
        {/if}
      {/if}
    {:else if activeStep === "research"}
      {#if activeThread.status === "discovery-running"}
        <div class="running" id="workflow-panel-research" role="tabpanel" aria-label="Research" tabindex="0">
          <div class="activity-symbol"><Icon name="research" size={30} /></div><p class="eyebrow">Discovery in progress</p>
          <h1>Following the evidence.</h1>
          <div class="activity"><span></span><p>{latestEvent?.type === "run-progress" ? latestEvent.message : activeRun?.lastActivity ?? "Preparing the next provider call…"}</p></div>
          {#if activeRun}<div class="run-actions"><button class="cancel" disabled={busy} onclick={() => cancelResearch(activeRun.runId)}>Cancel run</button></div>{/if}
        </div>
      {:else if (activeThread.status === "problems-ready" || reviewSelection) && (workspace.problemCandidates.length > 0 || workspace.rejectedProblemCandidates.length > 0)}
        <div id="workflow-panel-research" role="tabpanel" aria-label="Research">
          {#key workspace.activeThreadId}
            <ProblemCheckpoint problems={workspace.problemCandidates} rejectedCandidates={workspace.rejectedProblemCandidates} modelOptions={workspace.modelOptions} initialConfig={activeRun?.problemId ? activeRun.runConfig ?? workspace.runConfig : workspace.runConfig} workflowVersion={activeRun?.workflowVersion} ideaCount={workspace.runConfig?.ideaCount} {busy} onCommit={selectProblems} onExport={exportResearch} onOpenSource={openExternalUrl} />
          {/key}
        </div>
      {:else if workspace.problemCandidates.length > 0 || workspace.rejectedProblemCandidates.length > 0}
        <ResearchArchive problems={workspace.problemCandidates} rejectedCandidates={workspace.rejectedProblemCandidates} {busy} onExport={exportResearch} onOpenSource={openExternalUrl} />
      {:else}
        <div class="failed" id="workflow-panel-research" role="tabpanel" aria-label="Research" tabindex="0"><p class="eyebrow">Research unavailable</p><h1>No completed research is ready yet.</h1><p>Return to setup and start a research run.</p></div>
      {/if}
    {:else if activeThread.status === "development-running"}
      <div class="running" id="workflow-panel-ideas" role="tabpanel" aria-label="Solutions" tabindex="0">
        <div class="activity-symbol"><Icon name="ideas" size={30} /></div><p class="eyebrow">Development in progress</p>
        <h1>Turning problems into possibilities.</h1>
        <p class="research-export-hint">The research archive is already available. Open the Research tab to inspect or export it while solutions are generated.</p>
        <div class="activity"><span></span><p>{latestEvent?.type === "run-progress" ? latestEvent.message : activeRun?.lastActivity ?? "Preparing the next provider call…"}</p></div>
        {#if activeRun}<div class="run-actions"><button class="cancel" disabled={busy} onclick={() => cancelResearch(activeRun.runId)}>Cancel run</button></div>{/if}
      </div>
    {:else if activeThread.status === "solutions-ready" || workspace.solutions.length > 0}
      <div id="workflow-panel-ideas" role="tabpanel" aria-label="Solutions">
        <SolutionWorkspace solutions={workspace.solutions} {busy} onDiscard={discardIdea} workflowVersion={activeRun?.workflowVersion} onSelect={selectOption} onSave={saveDecision} onExport={exportIdeas} onOpenSource={openExternalUrl} onEvidenceFollowUp={requestEvidenceFollowUp} onReview={() => { activeStep = "research"; reviewSelection = true; }} />
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
  .activity-symbol { position:relative; }.activity-symbol::after { content:"";position:absolute;inset:-5px;border:1px solid transparent;border-top-color:var(--accent);border-radius:28px;animation:orbit 4s linear infinite; }
  .activity { width:100%;display:flex;gap:14px;border:1px solid var(--border);border-radius:14px;padding:20px;background:var(--surface);margin:24px 0;align-items:center; }
  .activity p { margin:0;font-size:13px;color:var(--muted); }.activity span { width:7px;height:7px;border-radius:50%;background:var(--accent);flex:none;animation:pulse 1.5s ease infinite alternate; }
  .run-actions { display:flex;gap:9px; }.run-actions button { border:1px solid var(--border-strong);background:transparent;color:var(--text);padding:10px 14px;border-radius:8px;font-size:13px; }.run-actions .cancel { color:var(--danger); }
  .run-stopped { display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px;margin:14px var(--page-inline) 0;padding:16px;border:1px solid #df92924a;border-radius:12px;background:#df929208; }
  .run-stopped > div:first-child { display:grid;gap:5px; }.run-stopped strong { font-size:13px; }.run-stopped span { color:var(--muted);font-size:13px; }.run-stopped-actions { display:flex;flex-wrap:wrap;gap:8px; }.run-stopped-actions button { border:1px solid var(--border-strong);border-radius:8px;background:transparent;color:var(--text);padding:9px 13px;font-size:13px; }.run-stopped-actions .cancel { color:var(--danger); }
  .skeleton { padding:90px var(--page-inline);display:grid;gap:18px; }.skeleton i { display:block;height:24px;max-width:720px;border-radius:8px;background:linear-gradient(90deg,var(--surface),var(--surface-2),var(--surface));background-size:200% 100%;animation:shimmer 1.2s infinite; }.skeleton i:first-child { height:58px;width:60%; }.skeleton i:last-child { width:40%; }
  .main-content > :global([role="tabpanel"]) { animation:page-reveal 200ms var(--ease); }
  @keyframes page-reveal { from { opacity:.6;transform:translateY(4px); }to { opacity:1;transform:none; } }
  @keyframes shimmer { to { background-position:-200% 0; } }@keyframes pulse { to { opacity:.3; } }@keyframes orbit { to { transform:rotate(360deg); } }
  @media(max-width:950px) { .calls { display:none; } }
  @media(max-width:720px) { .app-shell { grid-template-columns:180px minmax(0,1fr);padding:0; }.main-content { border-radius:0; }.topbar { padding:0 16px; }.running h1,.failed h1 { font-size:28px; } }
</style>
