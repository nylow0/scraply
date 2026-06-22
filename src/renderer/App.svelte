<script lang="ts">
  import SetupScreen from "./components/SetupScreen.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import Configurator from "./components/Configurator.svelte";
  import ResearchProgress from "./components/ResearchProgress.svelte";
  import ReportViewer from "./components/ReportViewer.svelte";
  import ResumeBanner from "./components/ResumeBanner.svelte";
  import type { AppState } from "./lib/state";
  import { initialState, isRunActive, shouldHighlightActivity } from "./lib/state";
  import { hasSeenGuide, markGuideSeen } from "./lib/onboarding";
  import { threadStatusLabel, threadStatusTone } from "./lib/thread-status";
  import { ipcPayload } from "./lib/ipc-payload";
  import type { ProjectBrief, RunConfig } from "@shared/schemas";
  import type { ModelTestResult, ResearchEvent } from "@shared/ipc";

  const MAX_RESEARCH_EVENTS = 400;

  let state: AppState = $state({ ...initialState });
  let modelTests: ModelTestResult[] | null = $state(null);
  let modelTestBusy = $state(false);
  let launching = $state(false);
  let generatingIdeas = $state(false);
  let setupKeys = $state({ opencode: "", exa: "" });
  let setupBusy: "save" | "import" | null = $state(null);
  let errorDismissed = $state(false);
  let guideAutoOpened = $state(false);

  $effect(() => {
    if (state.error) errorDismissed = false;
  });

  async function refreshWorkspace() {
    try {
      state.workspace = await window.scraply.getWorkspace();
    } catch (error) {
      state.error = error instanceof Error ? error.message : "Failed to load workspace";
    }
  }

  async function refresh() {
    state.error = null;
    try {
      state.validation = await window.scraply.getValidation();
      state.workspace = await window.scraply.getWorkspace();
    } catch (error) {
      state.error = error instanceof Error ? error.message : "Failed to load workspace";
    } finally {
      state.loading = false;
    }
  }

  function appendResearchEvent(event: ResearchEvent) {
    let next: ResearchEvent[];
    if (event.type === "stream-progress") {
      const withoutStale = state.researchEvents.filter(
        (existing) => !(existing.type === "stream-progress" && existing.streamId === event.streamId),
      );
      next = [...withoutStale, event];
    } else {
      next = [...state.researchEvents, event];
    }
    state.researchEvents = next.length > MAX_RESEARCH_EVENTS ? next.slice(-MAX_RESEARCH_EVENTS) : next;
  }

  $effect(() => {
    void refresh();
    return window.scraply.onBackendEvent((event) => {
      appendResearchEvent(event);
      if (event.type === "run-started") state.activeRunId = event.runId;
      if (event.type === "run-completed") {
        generatingIdeas = true;
        void refreshWorkspace();
      }
      if (event.type === "run-cancelled") {
        state.activeRunId = null;
        generatingIdeas = false;
        void refreshWorkspace();
      }
      if (event.type === "run-failed") {
        state.activeRunId = null;
        generatingIdeas = false;
        state.error = `Research paused: ${event.error}`;
        void refreshWorkspace();
      }
      if (event.type === "run-resumed") {
        state.activeRunId = event.runId;
        void refreshWorkspace();
      }
      if (event.type === "ideas-generated") {
        generatingIdeas = false;
        state.activeRunId = null;
        void refreshWorkspace();
      }
      if (event.type === "ideas-failed") {
        generatingIdeas = false;
        state.activeRunId = null;
        state.error = `Idea generation failed: ${event.error}. Use “Generate ideas” to retry.`;
        void refreshWorkspace();
      }
    });
  });

  async function saveSetup() {
    state.error = null;
    setupBusy = "save";
    try {
      state.validation = await window.scraply.saveSecrets(setupKeys.opencode.trim(), setupKeys.exa.trim());
      await refresh();
    } catch (error) {
      state.error = error instanceof Error ? error.message : "Failed to save keys";
    } finally {
      setupBusy = null;
    }
  }

  async function importEnv() {
    state.error = null;
    setupBusy = "import";
    try {
      state.validation = await window.scraply.importEnv();
      await refresh();
    } catch (error) {
      state.error = error instanceof Error ? error.message : "Failed to import keys from .env";
    } finally {
      setupBusy = null;
    }
  }

  async function newThread() {
    const result = await window.scraply.createThread();
    state.workspace = result.workspace;
    state.researchEvents = [];
    generatingIdeas = false;
  }

  async function selectThread(threadId: string) {
    state.workspace = await window.scraply.selectThread(threadId);
    state.researchEvents = [];
    generatingIdeas = false;
  }

  async function deleteThread(threadId: string) {
    const thread = state.workspace?.threads.find((t) => t.id === threadId);
    if (!thread) return;
    if (!confirm(`Delete "${thread.title}"? This cannot be undone.`)) return;
    state.error = null;
    try {
      state.workspace = await window.scraply.deleteThread(threadId);
    } catch (error) {
      state.error = error instanceof Error ? error.message : "Failed to delete thread";
    }
  }

  async function testModels(models: string[]) {
    state.error = null;
    modelTestBusy = true;
    modelTests = null;
    try {
      const unique = [...new Set(models.filter(Boolean))];
      const result = await window.scraply.testModels(unique);
      modelTests = result.results;
    } catch (error) {
      state.error = error instanceof Error ? error.message : "Failed to test models";
    } finally {
      modelTestBusy = false;
    }
  }

  async function launch(brief: ProjectBrief, config: RunConfig) {
    const threadId = state.workspace?.activeThreadId;
    if (!threadId) return;
    state.error = null;
    launching = true;
    state.researchEvents = [];
    generatingIdeas = false;
    try {
      const result = await window.scraply.launchResearch({
        threadId,
        brief: ipcPayload(brief),
        config: ipcPayload(config),
      }) as { runId: string; workspace: typeof state.workspace };
      state.workspace = result.workspace;
      state.activeRunId = result.runId;
    } catch (error) {
      state.error = error instanceof Error ? error.message : "Failed to launch research";
    } finally {
      launching = false;
    }
  }

  async function saveConfigPreset(config: RunConfig, name: string) {
    const threadId = state.workspace?.activeThreadId;
    if (!threadId) return;
    state.error = null;
    try {
      state.workspace = await window.scraply.saveRunConfig({ threadId, config: ipcPayload(config), presetName: name });
    } catch (error) {
      state.error = error instanceof Error ? error.message : "Failed to save preset";
    }
  }

  async function generateIdeas() {
    const threadId = state.workspace?.activeThreadId;
    if (!threadId) return;
    state.error = null;
    generatingIdeas = true;
    try {
      const result = await window.scraply.generateIdeas(threadId);
      state.workspace = result.workspace;
    } catch (error) {
      state.error = error instanceof Error ? error.message : "Failed to generate ideas";
    } finally {
      generatingIdeas = false;
    }
  }

  async function resumeResearch(runId: string) {
    state.workspace = await window.scraply.resumeResearch(runId);
  }

  async function cancelIncompleteResearch(runId: string) {
    state.workspace = await window.scraply.cancelIncompleteResearch(runId);
  }

  async function cancelActiveResearch() {
    const runId = state.activeRunId;
    if (!runId) return;
    if (!confirm("Cancel this research run? Partial reports may still be saved.")) return;
    state.error = null;
    try {
      await window.scraply.cancelResearch(runId);
    } catch (error) {
      state.error = error instanceof Error ? error.message : "Failed to cancel research";
    }
  }

  function scrollToReport(reportId: string) {
    document.getElementById(`report-${reportId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const activeThread = $derived(state.workspace?.threads.find((t) => t.id === state.workspace?.activeThreadId) ?? null);
  const setupComplete = $derived(Boolean(state.validation?.setupComplete));

  $effect(() => {
    if (!setupComplete || hasSeenGuide()) return;
    state.showGuide = true;
    guideAutoOpened = true;
  });

  function closeGuide() {
    state.showGuide = false;
    if (guideAutoOpened) {
      markGuideSeen();
      guideAutoOpened = false;
    }
  }
  const status = $derived(activeThread?.status ?? null);

  const isConfigPhase = $derived(
    status === "draft" || status === "intake" || status === "brief-draft" ||
    status === "brief-confirmed" || status === "configuring",
  );
  const isWorking = $derived(
    status === "research-queued" || status === "research-running" ||
    status === "ideas-generating" || generatingIdeas,
  );
  const activeResearchers = $derived(
    (state.workspace?.runConfig?.researchers ?? []).filter((r) => r.enabled),
  );
  const reports = $derived(state.workspace?.reports ?? []);
  const activityAlert = $derived(shouldHighlightActivity(state.researchEvents, state.showDrawer));
  const runLive = $derived(isRunActive(state.activeRunId, state.researchEvents));
</script>

{#if state.loading}
  <div class="boot" role="status" aria-live="polite">
    <div class="boot-spinner" aria-hidden="true"></div>
    Starting Scraply…
  </div>
{:else if state.error && !state.validation}
  <div class="boot" role="alert">
    <p>{state.error}</p>
    <p class="boot-hint">Restart the app. If this persists, check that port 127.0.0.1 is available.</p>
  </div>
{:else if !setupComplete}
  <SetupScreen
    validation={state.validation}
    bind:opencode={setupKeys.opencode}
    bind:exa={setupKeys.exa}
    error={state.error}
    busy={setupBusy}
    onSave={saveSetup}
    onImportEnv={importEnv}
  />
{:else}
  <div class="shell">
    <Sidebar
      threads={state.workspace?.threads ?? []}
      activeThreadId={state.workspace?.activeThreadId ?? null}
      onNew={newThread}
      onSelect={selectThread}
      onDelete={deleteThread}
      onOpenGuide={() => (state.showGuide = true)}
      onOpenData={() => window.scraply.openDataFolder()}
    />

    <main class="main">
      <div class="main-head">
        {#if (state.workspace?.pendingRuns?.length ?? 0) > 0}
          <ResumeBanner
            pendingRuns={state.workspace?.pendingRuns ?? []}
            onResume={resumeResearch}
            onCancel={cancelIncompleteResearch}
          />
        {/if}
        <header class="topbar">
          <div class="title-block">
            <span class="title-mark" aria-hidden="true"></span>
            <div class="title-text">
              <h1>{activeThread?.title ?? "Scraply"}</h1>
              {#if status}
                <span class="status-badge" data-tone={threadStatusTone(status)}>{threadStatusLabel(status)}</span>
              {/if}
            </div>
          </div>
          <div class="top-actions">
            {#if isWorking || status === "research-complete" || status === "ideas-ready"}
              <button
                class="ghost activity-btn"
                class:alert={activityAlert}
                class:live={runLive}
                onclick={() => (state.showDrawer = !state.showDrawer)}
                aria-pressed={state.showDrawer}
              >
                Activity log
                {#if runLive}<span class="live-dot" aria-hidden="true"></span>{/if}
              </button>
            {/if}
            {#if status === "research-complete"}
              <button class="primary" disabled={generatingIdeas} onclick={generateIdeas}>
                {generatingIdeas ? "Generating…" : "Generate ideas"}
              </button>
            {/if}
            {#if status === "ideas-ready"}
              <button class="ghost" disabled={generatingIdeas} onclick={generateIdeas}>Generate more</button>
              <button class="primary" onclick={newThread}>New research</button>
            {/if}
          </div>
        </header>

        {#if state.error && !errorDismissed}
          <div class="banner-error" role="alert">
            <p>{state.error}</p>
            <button class="dismiss" aria-label="Dismiss error" onclick={() => (errorDismissed = true)}>×</button>
          </div>
        {/if}
      </div>

      <div class="main-body">
        {#if !activeThread}
          <div class="empty">
            <div class="empty-card">
              <h2>Start a research run</h2>
              <p>Scraply researches a topic from many angles and hands you a ranked shortlist of ideas.</p>
              <div class="empty-actions">
                <button class="primary" onclick={newThread}>New research</button>
                <button class="ghost" onclick={() => (state.showGuide = true)}>How it works</button>
              </div>
            </div>
          </div>
        {:else if isWorking}
          <ResearchProgress
            events={state.researchEvents}
            researchers={activeResearchers}
            generatingIdeas={generatingIdeas || status === "ideas-generating"}
            onCancel={state.activeRunId ? cancelActiveResearch : undefined}
            onOpenActivity={() => (state.showDrawer = true)}
          />
        {:else if isConfigPhase}
          {#key activeThread.id}
            <Configurator
              brief={state.workspace?.brief ?? null}
              config={state.workspace?.runConfig ?? null}
              models={state.workspace?.models ?? []}
              presets={state.workspace?.presets ?? []}
              testResults={modelTests}
              testBusy={modelTestBusy}
              {launching}
              onTest={(models) => testModels(models)}
              onLaunch={launch}
              onSavePreset={saveConfigPreset}
            />
          {/key}
        {:else if status === "ideas-ready"}
          {#await import("./components/IdeaWorkspace.svelte") then { default: IdeaWorkspace }}
            <IdeaWorkspace
              ideas={state.workspace?.ideas ?? []}
              threadId={activeThread.id}
              reportCount={reports.length}
              onRefresh={refresh}
            />
          {/await}
          {#if reports.length > 1}
            <nav class="report-nav" aria-label="Jump to report">
              <span class="report-nav-label">Reports</span>
              {#each reports as report (report.id)}
                <button class="report-link" onclick={() => scrollToReport(report.id)}>{report.title}</button>
              {/each}
            </nav>
          {/if}
          {#each reports as report, i (report.id)}
            <ReportViewer reportId={report.id} title={report.title} defaultCollapsed={i > 0} />
          {/each}
        {:else if status === "research-complete"}
          <div class="complete">
            <div class="complete-head">
              <h2>Research complete</h2>
              <p>
                {reports.length} report{reports.length === 1 ? "" : "s"} ready.
                Generate your idea shortlist, or review the evidence below.
              </p>
              <button class="primary" disabled={generatingIdeas} onclick={generateIdeas}>
                {generatingIdeas ? "Generating…" : "Generate ideas →"}
              </button>
            </div>
            {#if reports.length > 1}
              <nav class="report-nav" aria-label="Jump to report">
                <span class="report-nav-label">Reports</span>
                {#each reports as report (report.id)}
                  <button class="report-link" onclick={() => scrollToReport(report.id)}>{report.title}</button>
                {/each}
              </nav>
            {/if}
            {#each reports as report, i (report.id)}
              <ReportViewer reportId={report.id} title={report.title} defaultCollapsed={i > 0} />
            {/each}
          </div>
        {/if}
      </div>
    </main>

    {#if state.showDrawer}
      {#await import("./components/ResearchDrawer.svelte") then { default: ResearchDrawer }}
        <ResearchDrawer
          events={state.researchEvents}
          researchers={activeResearchers}
          onClose={() => (state.showDrawer = false)}
        />
      {/await}
    {/if}

    {#if state.showGuide}
      {#await import("./components/UserGuide.svelte") then { default: UserGuide }}
        <UserGuide onClose={closeGuide} />
      {/await}
    {/if}
  </div>
{/if}

<style>
  :global(html),
  :global(body),
  :global(#app) {
    width: 100%;
    height: 100%;
    overflow: hidden;
  }

  .boot {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: var(--muted);
    padding: var(--space-6);
    text-align: center;
    font-family: var(--mono);
    font-size: 13px;
    letter-spacing: 0.01em;
  }

  .boot-hint {
    margin-top: var(--space-2);
    font-size: 13px;
    color: var(--faint);
    font-family: var(--sans);
    max-width: 42ch;
  }

  .shell {
    position: absolute;
    inset: 0;
    display: flex;
    overflow: hidden;
    background: var(--bg);
  }

  .main {
    flex: 1 1 0;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    height: 100%;
    overflow: hidden;
    border-left: 1px solid var(--border);
  }

  .main-head {
    flex: 0 0 auto;
  }

  .main-body {
    flex: 1 1 0;
    overflow-y: auto;
    overflow-x: hidden;
    min-height: 0;
    overscroll-behavior: contain;
  }

  .topbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-3) var(--space-5);
    border-bottom: 1px solid var(--border);
    background: color-mix(in srgb, var(--bg) 76%, transparent);
    backdrop-filter: blur(14px) saturate(1.2);
    z-index: 5;
  }

  .title-block {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 0;
  }

  .title-mark {
    width: 4px;
    height: 16px;
    flex-shrink: 0;
    border-radius: 999px;
    background: var(--accent-strong);
  }

  .title-text {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  h1 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    letter-spacing: -0.01em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .status-badge {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.02em;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .status-badge[data-tone="active"] {
    color: var(--accent-strong);
  }

  .status-badge[data-tone="success"] {
    color: var(--accent);
  }

  .status-badge[data-tone="warn"] {
    color: var(--warn);
  }

  .banner-error {
    margin: 0;
    padding: var(--space-3) var(--space-5);
    border-bottom: 1px solid color-mix(in srgb, var(--danger) 40%, var(--border));
    background: var(--danger-bg);
    color: var(--danger);
    font-size: 13px;
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .banner-error p {
    margin: 0;
    flex: 1;
    min-width: 0;
  }

  .dismiss {
    flex-shrink: 0;
    background: transparent;
    border: none;
    color: var(--danger);
    font-size: 18px;
    line-height: 1;
    padding: 2px 6px;
    border-radius: var(--r-sm);
    opacity: 0.7;
  }

  .dismiss:hover {
    opacity: 1;
    background: color-mix(in srgb, var(--danger) 12%, transparent);
  }

  .top-actions {
    display: flex;
    gap: var(--space-2);
  }

  .empty {
    height: 100%;
    display: grid;
    place-items: center;
    padding: var(--space-6);
  }
  .empty-card {
    text-align: center;
    max-width: 42ch;
  }
  .empty-card h2 {
    margin: 0 0 var(--space-2);
    font-size: 20px;
  }
  .empty-card p {
    margin: 0 0 var(--space-5);
    color: var(--muted);
    font-size: 13.5px;
    line-height: 1.55;
  }

  .empty-actions {
    display: flex;
    gap: var(--space-2);
    justify-content: center;
    flex-wrap: wrap;
  }

  .complete {
    max-width: 820px;
    margin: 0 auto;
    padding: var(--space-6) var(--space-5);
  }
  .complete-head {
    text-align: center;
    margin-bottom: var(--space-6);
  }
  .complete-head h2 {
    margin: 0 0 var(--space-2);
    font-size: 20px;
  }
  .complete-head p {
    margin: 0 0 var(--space-4);
    color: var(--muted);
    font-size: 13.5px;
  }

  button {
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text-2);
    border-radius: var(--r-md);
    padding: 7px 13px;
    font-size: 13px;
    font-weight: 500;
    transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease),
      color var(--dur) var(--ease), transform var(--dur-fast) var(--ease);
  }

  button:hover:not(:disabled) {
    border-color: var(--border-strong);
    color: var(--text);
    background: var(--surface-3);
  }

  button:active:not(:disabled) {
    transform: translateY(1px);
  }

  button.primary {
    background: var(--accent);
    border-color: var(--accent-strong);
    color: #1a1500;
    font-weight: 600;
  }

  button.primary:hover:not(:disabled) {
    filter: brightness(1.08);
    color: #1a1500;
  }

  button.primary:disabled {
    opacity: 0.65;
    cursor: wait;
  }

  button.ghost {
    background: transparent;
    border-color: transparent;
    color: var(--muted);
  }

  button.ghost:hover:not(:disabled) {
    background: var(--surface-2);
    border-color: var(--border);
    color: var(--text);
  }

  .activity-btn {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .activity-btn.alert {
    color: var(--danger);
    border-color: color-mix(in srgb, var(--danger) 35%, var(--border));
  }

  .activity-btn.live .live-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent-strong);
    animation: live-pulse 1.5s var(--ease) infinite;
  }

  @keyframes live-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }

  .report-nav {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    margin: 0 var(--space-5) var(--space-3);
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    background: var(--surface);
  }

  .report-nav-label {
    font-family: var(--mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--faint);
    margin-right: var(--space-1);
  }

  .report-link {
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text-2);
    border-radius: 999px;
    padding: 4px 10px;
    font-size: 12px;
    font-weight: 500;
  }

  .report-link:hover {
    border-color: var(--accent-border);
    color: var(--accent-strong);
  }

  @media (max-width: 960px) {
    .shell {
      flex-direction: column;
    }

    .topbar {
      align-items: flex-start;
    }

    .top-actions {
      flex-wrap: wrap;
      justify-content: flex-end;
    }
  }
</style>
