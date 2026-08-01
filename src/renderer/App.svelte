<script lang="ts">
  import Sidebar from "./components/Sidebar.svelte";
  import Conversation from "./components/Conversation.svelte";
  import ResearchSetupForm from "./components/ResearchSetupForm.svelte";
  import SmartBriefEntry from "./components/SmartBriefEntry.svelte";
  import BriefReviewPanel from "./components/BriefReviewPanel.svelte";
  import RunReviewPanel from "./components/RunReviewPanel.svelte";
  import ResearchDrawer from "./components/ResearchDrawer.svelte";
  import RunProgressPanel from "./components/RunProgressPanel.svelte";
  import IdeaWorkspace from "./components/IdeaWorkspace.svelte";
  import UserGuide from "./components/UserGuide.svelte";
  import ReportViewer from "./components/ReportViewer.svelte";
  import ResumeBanner from "./components/ResumeBanner.svelte";
  import FocusedBranchSetup from "./components/FocusedBranchSetup.svelte";
  import type { AppState } from "./lib/state";
  import { initialState } from "./lib/state";
  import { toFavoriteModelPayload, toProjectBriefPayload, toRunConfigPayload } from "./lib/ipc-payloads";
  import { isResearchStatus, statusLabel, statusTone } from "./lib/status";
  import type { ModelRef, ProjectBrief, RunConfig } from "@shared/schemas";
  import type { IdeaGenerationCompleteness } from "@shared/ipc";
  import { DEFAULT_RUN_CONFIG } from "@shared/intake";

  let appState: AppState = $state({ ...initialState });
  let intakeSubmitting = $state(false);
  let briefConfirming = $state(false);
  let researchStarting = $state(false);
  let ideasGenerating = $state(false);
  let recoveryPendingRunId: string | null = $state(null);
  let runCancelling = $state(false);
  let partialIdeaNotice: IdeaGenerationCompleteness | null = $state(null);
  let deletingThreadId: string | null = $state(null);
  let intakeMode: "smart" | "guided" = $state("smart");
  let starterText = $state("");
  let editingConfirmedBrief = $state(false);
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  let mainContent: HTMLDivElement | undefined = $state();

  async function refreshWorkspace(options: { preserveError?: boolean } = {}) {
    try {
      const workspace = await window.scraply.getWorkspace();
      appState.workspace = workspace;
      appState.validation = workspace.validation;
      if (!options.preserveError) appState.error = null;
    } catch (error) {
      appState.error = error instanceof Error ? error.message : "Failed to load workspace";
    } finally {
      appState.loading = false;
    }
  }

  function errorMessage(error: unknown, fallback: string): string {
    if (!(error instanceof Error)) return fallback;
    return error.message.replace(/^Error invoking remote method '[^']+':\s*(?:AppError:\s*)?/, "");
  }

  function providerError(): string {
    const validation = appState.validation;
    if (!validation?.exa.valid) {
      return `Exa failed to connect: ${validation?.exa.error ?? "EXA_API_KEY is missing or invalid."}`;
    }
    if (!validation.codex.compatible) {
      return `Codex failed to connect: ${validation.codex.error ?? "A compatible local Codex installation was not detected."}`;
    }
    return "Scraply could not connect to its required services.";
  }

  async function initialLoad() {
    appState.loading = true;
    appState.error = null;
    try {
      appState.validation = await window.scraply.getValidation();
      if (!appState.validation.setupComplete) {
        appState.workspace = null;
        appState.error = providerError();
        return;
      }
      const workspace = await window.scraply.getWorkspace();
      appState.workspace = workspace;
      appState.validation = workspace.validation;
    } catch (error) {
      appState.workspace = null;
      appState.error = errorMessage(error, "Scraply failed to start.");
    } finally {
      appState.loading = false;
    }
  }

  async function retryStartup() {
    appState.loading = true;
    appState.error = null;
    try {
      await window.scraply.retryConnection();
    } catch (error) {
      appState.error = errorMessage(error, "Scraply failed to reconnect.");
      appState.loading = false;
      return;
    }
    await initialLoad();
  }

  function reconcileSoon() {
    if (reconcileTimer) clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(() => void refreshWorkspace({ preserveError: true }), 150);
  }

  function resetIntakeEntry() {
    intakeMode = "smart";
    starterText = "";
    editingConfirmedBrief = false;
    partialIdeaNotice = null;
  }

  $effect(() => {
    void initialLoad();
    const unsubscribe = window.scraply.onBackendEvent((event) => {
      if (event.threadId !== appState.workspace?.activeThreadId) return;
      if (appState.activeRunId && event.runId !== appState.activeRunId) return;
      // A fresh run replaces the timeline so stream lanes never mix two runs.
      if (event.type === "run-started" && event.runId !== appState.activeRunId) appState.researchEvents = [];
      appState.researchEvents = [...appState.researchEvents, event];
      if (event.type === "run-started") appState.activeRunId = event.runId;
      if (event.type === "run-completed" || event.type === "run-cancelled" || event.type === "run-failed") {
        appState.activeRunId = null;
        if (event.type === "run-failed") appState.error = event.error;
        reconcileSoon();
      }
      if (event.type === "stream-completed" || event.type === "synthesis-completed") reconcileSoon();
      if (event.type === "run-resumed") {
        appState.activeRunId = event.runId;
        reconcileSoon();
      }
      if (event.type === "ideas-generated") reconcileSoon();
    });
    return () => {
      unsubscribe();
      if (reconcileTimer) clearTimeout(reconcileTimer);
    };
  });

  async function newThread() {
    appState.error = null;
    try {
      const result = await window.scraply.createThread();
      appState.workspace = result.workspace;
      resetIntakeEntry();
    } catch (error) {
      appState.error = error instanceof Error ? error.message : "Failed to create research";
    }
  }

  async function selectThread(threadId: string) {
    appState.error = null;
    try {
      appState.workspace = await window.scraply.selectThread(threadId);
      appState.researchEvents = [];
      appState.activeRunId = null;
      resetIntakeEntry();
    } catch (error) {
      appState.error = error instanceof Error ? error.message : "Failed to open research";
    }
  }

  async function deleteThread(threadId: string) {
    if (deletingThreadId) return;
    deletingThreadId = threadId;
    appState.error = null;
    try {
      const previousActiveThreadId = appState.workspace?.activeThreadId;
      appState.workspace = await window.scraply.deleteThread(threadId);
      if (appState.workspace.activeThreadId !== previousActiveThreadId) resetIntakeEntry();
    } catch (error) {
      appState.error = error instanceof Error ? error.message : "Failed to delete research";
    } finally {
      deletingThreadId = null;
    }
  }

  async function submitStarterBrief(text: string) {
    const threadId = appState.workspace?.activeThreadId;
    if (!threadId || intakeSubmitting) return;
    intakeSubmitting = true;
    appState.error = null;
    try {
      const result = await window.scraply.startBriefIntake({ threadId, text });
      if (!result.workspace?.brief) throw new Error("Brief was not generated from your prompt");
      appState.workspace = result.workspace;
    } catch (error) {
      appState.error = error instanceof Error ? error.message : "Failed to build research brief";
    } finally {
      intakeSubmitting = false;
    }
  }

  async function submitIntakeAnswers(answers: Array<{ questionId: string; answer: string; skipped: boolean }>) {
    const threadId = appState.workspace?.activeThreadId;
    if (!threadId || intakeSubmitting) return;
    intakeSubmitting = true;
    appState.error = null;
    try {
      for (const answer of answers) {
        const result = await window.scraply.submitIntake({
          threadId,
          questionId: answer.questionId,
          answer: answer.answer,
          skipped: answer.skipped,
        });
        appState.workspace = result.workspace;
      }
      if (!appState.workspace?.brief) throw new Error("Brief was not generated from your answers");
    } catch (error) {
      appState.error = error instanceof Error ? error.message : "Failed to draft brief";
    } finally {
      intakeSubmitting = false;
    }
  }

  async function confirmBrief(brief: ProjectBrief) {
    const threadId = appState.workspace?.activeThreadId;
    if (!threadId || briefConfirming) return;
    briefConfirming = true;
    appState.error = null;
    try {
      appState.workspace = await window.scraply.confirmBrief({ threadId, brief: toProjectBriefPayload(brief) });
      editingConfirmedBrief = false;
    } catch (error) {
      appState.error = error instanceof Error ? error.message : "Failed to confirm brief";
    } finally {
      briefConfirming = false;
    }
  }

  async function saveRunConfig(config = appState.workspace?.runConfig ?? DEFAULT_RUN_CONFIG, presetName?: string) {
    const threadId = appState.workspace?.activeThreadId;
    if (!threadId) return;
    appState.error = null;
    try {
      appState.workspace = await window.scraply.saveRunConfig({
        threadId,
        config: toRunConfigPayload(config),
        ...(presetName ? { presetName } : {}),
      });
    } catch (error) {
      appState.error = error instanceof Error ? error.message : "Failed to save configuration";
    }
  }

  async function saveFavoriteModel(model: ModelRef, favorite: boolean) {
    appState.error = null;
    try {
      appState.workspace = await window.scraply.saveFavoriteModel(toFavoriteModelPayload({ model, favorite }));
    } catch (error) {
      appState.error = error instanceof Error ? error.message : "Failed to update favorite";
    }
  }

  async function startResearch(config: RunConfig) {
    const threadId = appState.workspace?.activeThreadId;
    if (!threadId || researchStarting) return;
    researchStarting = true;
    appState.error = null;
    try {
      appState.workspace = await window.scraply.saveRunConfig({ threadId, config: toRunConfigPayload(config) });
      appState.researchEvents = [];
      const result = await window.scraply.startResearch(threadId);
      appState.workspace = result.workspace;
      appState.activeRunId = result.runId;
    } catch (error) {
      appState.error = error instanceof Error ? error.message : "Failed to start research";
    } finally {
      researchStarting = false;
    }
  }

  async function generateIdeas(allowPartial = false) {
    if (ideasGenerating) return;
    const runId = appState.workspace?.latestResearchRun?.runId;
    if (!runId) {
      appState.error = "A completed research synthesis is required before generating ideas.";
      return;
    }
    ideasGenerating = true;
    appState.error = null;
    try {
      const result = await window.scraply.generateIdeas(runId, allowPartial);
      appState.workspace = result.workspace;
      partialIdeaNotice = result.completeness.mode === "partial" ? result.completeness : null;
    } catch (error) {
      appState.error = error instanceof Error ? error.message : "Failed to generate ideas";
    } finally {
      ideasGenerating = false;
    }
  }

  async function generatePartialIdeas() {
    const coverage = partialCoverage;
    if (!coverage) return;
    if (!window.confirm(`Generate ideas from partial research? Missing coverage: ${coverage}`)) return;
    await generateIdeas(true);
  }

  async function resumeResearch(runId: string) {
    if (recoveryPendingRunId) return;
    const pending = appState.workspace?.pendingRuns.find((run) => run.runId === runId) ?? null;
    recoveryPendingRunId = runId;
    appState.error = null;
    try {
      appState.researchEvents = [];
      appState.workspace = await window.scraply.resumeResearch(runId);
      // Resuming never moves the active thread, so follow the run to the thread that owns it.
      if (pending && pending.threadId !== appState.workspace.activeThreadId) {
        appState.workspace = await window.scraply.selectThread(pending.threadId);
        resetIntakeEntry();
      }
      appState.activeRunId = runId;
    } catch (error) {
      appState.error = error instanceof Error ? error.message : "Failed to resume research";
    } finally {
      recoveryPendingRunId = null;
    }
  }

  async function cancelIncompleteResearch(runId: string) {
    if (recoveryPendingRunId) return;
    recoveryPendingRunId = runId;
    appState.error = null;
    try {
      appState.workspace = await window.scraply.cancelIncompleteResearch(runId);
    } catch (error) {
      appState.error = error instanceof Error ? error.message : "Failed to cancel interrupted research";
    } finally {
      recoveryPendingRunId = null;
    }
  }

  async function cancelResearch() {
    if (!appState.activeRunId || runCancelling) return;
    runCancelling = true;
    appState.error = null;
    try {
      appState.workspace = await window.scraply.cancelResearch(appState.activeRunId);
      appState.activeRunId = null;
    } catch (error) {
      appState.error = error instanceof Error ? error.message : "Failed to cancel research";
    } finally {
      runCancelling = false;
    }
  }

  const activeThread = $derived(appState.workspace?.threads.find((t) => t.id === appState.workspace?.activeThreadId) ?? null);
  const partialRunAvailable = $derived(Boolean(appState.workspace?.latestResearchRun?.canGeneratePartialIdeas));
  const providersReady = $derived(Boolean(appState.validation?.setupComplete));
  const synthesisReady = $derived(Boolean(appState.workspace?.latestResearchRun?.synthesisReportId));
  const runSnapshot = $derived(appState.workspace?.latestResearchRun ?? null);
  const onRunPage = $derived(isResearchStatus(activeThread?.status));
  // The run page already shows the lanes, so the side panel would only duplicate
  // it. It exists for the pages that don't show progress themselves.
  const drawerOpen = $derived(appState.showDrawer && !onRunPage);
  // Cancelling needs both a run to target and a run that has not already ended.
  const canCancelRun = $derived(
    Boolean(appState.activeRunId) &&
      (activeThread?.status === "research-queued" || activeThread?.status === "research-running"),
  );
  const reports = $derived(appState.workspace?.reports ?? []);
  /**
   * Identifies which page is rendered, so the shared scroll container can be
   * reset when the page changes without yanking the user when only the run
   * status advances underneath the same page.
   */
  const pageId = $derived.by(() => {
    const status = activeThread?.status;
    if (status === "intake") return `intake:${intakeMode}`;
    if (status === "brief-draft") return "brief-draft";
    if (status === "brief-confirmed" || status === "configuring") {
      return editingConfirmedBrief ? "brief-edit" : "run-review";
    }
    if (onRunPage) return "run";
    if (status === "ideas-ready") return "ideas";
    return "conversation";
  });

  $effect(() => {
    const key = `${appState.workspace?.activeThreadId ?? ""}:${pageId}`;
    void key;
    mainContent?.scrollTo({ top: 0 });
  });

  // Missing coverage for a run that ended without a synthesis. Surfaced as a
  // notice because a failed run resets the thread to "configuring", so the run
  // page is not where the user lands.
  const partialCoverage = $derived.by(() => {
    const run = appState.workspace?.latestResearchRun;
    if (!run || !partialRunAvailable) return null;
    return [...run.missingLenses, ...run.gaps].join("; ") || "Synthesis was not completed.";
  });

  const hasNotices = $derived(
    (appState.workspace?.pendingRuns?.length ?? 0) > 0 ||
      Boolean(appState.error && activeThread?.status !== "intake") ||
      Boolean(partialIdeaNotice) ||
      Boolean(partialCoverage) ||
      Boolean(appState.workspace?.branchContext),
  );
</script>

{#if appState.loading}
  <div class="startup" role="status">Loading…</div>
{:else if !appState.workspace}
  <div class="startup startup-failed">
    <p role="alert">{appState.error ?? providerError()}</p>
    <button class="refresh" onclick={retryStartup}>Refresh</button>
  </div>
{:else}
  <div class="shell" class:with-drawer={drawerOpen}>
    <Sidebar
      threads={appState.workspace?.threads ?? []}
      activeThreadId={appState.workspace?.activeThreadId ?? null}
      {deletingThreadId}
      onNew={newThread}
      onSelect={selectThread}
      onDelete={deleteThread}
      onOpenGuide={() => (appState.showGuide = true)}
      onOpenData={() => window.scraply.openDataFolder()}
      onOpenLogs={() => window.scraply.openLogsFolder()}
    />

    <main class="main">
      <header class="topbar">
        <div class="topbar-title">
          <h1>{activeThread?.title ?? "Scraply"}</h1>
          <span class="status-pill" data-tone={statusTone(activeThread?.status)}>
            <span class="status-dot" aria-hidden="true"></span>{statusLabel(activeThread?.status)}
          </span>
        </div>
        <div class="top-actions">
          <span class:ready={providersReady} class="connection" role="status">
            <span aria-hidden="true"></span>{providersReady ? "Providers ready" : "Limited connection"}
          </span>
          {#if !onRunPage && runSnapshot}
            <button
              class="ghost"
              aria-pressed={drawerOpen}
              aria-label="Toggle research progress panel"
              onclick={() => (appState.showDrawer = !appState.showDrawer)}
            >Progress</button>
          {/if}
          {#if activeThread?.status === "ideas-ready" && synthesisReady}
            <button class="ghost" disabled={ideasGenerating} onclick={() => generateIdeas(false)}>
              {ideasGenerating ? "Generating…" : "Regenerate ideas"}
            </button>
          {/if}
        </div>
      </header>

      <div class="main-content" bind:this={mainContent}>
      {#if hasNotices}
        <div class="notices">
          {#if (appState.workspace?.pendingRuns?.length ?? 0) > 0}
            <ResumeBanner
              pendingRuns={appState.workspace?.pendingRuns ?? []}
              pendingRunId={recoveryPendingRunId}
              onResume={resumeResearch}
              onCancel={cancelIncompleteResearch}
            />
          {/if}
          {#if appState.error && activeThread?.status !== "intake"}
            <div class="notice error" role="alert">
              <p>{appState.error}</p>
              <button class="dismiss" aria-label="Dismiss error" onclick={() => (appState.error = null)}>Dismiss</button>
            </div>
          {/if}
          {#if partialCoverage}
            <div class="notice warn" role="status">
              <p>
                <strong>This run ended without a full synthesis.</strong>
                You can still generate ideas from the evidence that was collected. Missing: {partialCoverage}
              </p>
              <button class="dismiss" disabled={ideasGenerating} onclick={generatePartialIdeas}>
                {ideasGenerating ? "Generating…" : "Generate from partial research"}
              </button>
            </div>
          {/if}
          {#if partialIdeaNotice}
            <div class="notice warn" role="status">
              <p>
                <strong>Ideas generated from partial research.</strong>
                Missing: {partialIdeaNotice.missingLenses.join(", ") || "none"}{#if partialIdeaNotice.gaps.length} · Gaps: {partialIdeaNotice.gaps.join("; ")}{/if}
              </p>
              <button class="dismiss" aria-label="Dismiss partial research notice" onclick={() => (partialIdeaNotice = null)}>Dismiss</button>
            </div>
          {/if}
          {#if appState.workspace?.branchContext}
            <FocusedBranchSetup context={appState.workspace.branchContext} />
          {/if}
        </div>
      {/if}

      {#if activeThread?.status === "intake"}
        {#if intakeMode === "smart"}
          <SmartBriefEntry
            value={starterText}
            submitting={intakeSubmitting}
            error={appState.error}
            onChange={(value) => (starterText = value)}
            onSubmit={submitStarterBrief}
            onUseGuidedSetup={() => {
              appState.error = null;
              intakeMode = "guided";
            }}
          />
        {:else}
          <ResearchSetupForm
            submitting={intakeSubmitting}
            error={appState.error}
            onSubmit={submitIntakeAnswers}
            onBack={() => {
              appState.error = null;
              intakeMode = "smart";
            }}
          />
        {/if}
      {:else if activeThread?.status === "brief-draft" && appState.workspace?.brief}
        <BriefReviewPanel
          brief={appState.workspace.brief}
          submitting={briefConfirming}
          onSubmit={confirmBrief}
        />
      {:else if (activeThread?.status === "brief-confirmed" || activeThread?.status === "configuring") && appState.workspace?.brief}
        {#if editingConfirmedBrief}
          <BriefReviewPanel
            brief={appState.workspace.brief}
            submitting={briefConfirming}
            mode="save"
            onSubmit={confirmBrief}
            onCancel={() => {
              appState.error = null;
              editingConfirmedBrief = false;
            }}
          />
        {:else}
          <RunReviewPanel
            brief={appState.workspace.brief}
            models={appState.workspace?.models ?? []}
            modelCatalog={appState.workspace?.modelCatalog}
            config={appState.workspace?.runConfig ?? DEFAULT_RUN_CONFIG}
            presets={appState.workspace?.presets ?? []}
            onEditBrief={() => {
              appState.error = null;
              editingConfirmedBrief = true;
            }}
            onSaveConfig={(config, presetName) => saveRunConfig(config, presetName)}
            onFavorite={saveFavoriteModel}
            onStart={startResearch}
            starting={researchStarting}
          />
        {/if}
      {:else if onRunPage && activeThread}
        <RunProgressPanel
          events={appState.researchEvents}
          status={activeThread.status}
          snapshot={runSnapshot}
          canCancel={canCancelRun}
          cancelling={runCancelling}
          {ideasGenerating}
          canGenerateIdeas={synthesisReady && activeThread.status !== "ideas-generating"}
          onCancel={cancelResearch}
          onGenerateIdeas={() => generateIdeas(false)}
        />
      {:else if activeThread?.status !== "ideas-ready"}
        <Conversation messages={appState.workspace?.messages ?? []} />
      {/if}

      {#if activeThread?.status === "ideas-ready"}
        <div class="results-workspace">
          {#if reports.length > 0}
            <section class="report-library" aria-labelledby="report-library-title">
              <div class="section-heading">
                <p class="eyebrow">Source material</p>
                <h2 id="report-library-title">Research reports</h2>
                <p>Open a report when you need to trace an idea back to the underlying research.</p>
              </div>
              <div class="report-list">
                {#each reports as report (report.id)}
                  <ReportViewer reportId={report.id} title={report.title} />
                {/each}
              </div>
            </section>
          {/if}

          <IdeaWorkspace ideas={appState.workspace?.ideas ?? []} threadId={activeThread?.id ?? ""} onRefresh={refreshWorkspace} />
        </div>
      {:else if reports.length > 0}
        <section class="report-stack" aria-labelledby="report-stack-title">
          <h2 id="report-stack-title">Reports so far</h2>
          {#each reports as report (report.id)}
            <ReportViewer reportId={report.id} title={report.title} />
          {/each}
        </section>
      {/if}
      </div>
    </main>

    {#if drawerOpen}
      <ResearchDrawer
        events={appState.researchEvents}
        snapshot={runSnapshot}
        canCancel={canCancelRun}
        cancelling={runCancelling}
        onCancel={cancelResearch}
        onClose={() => (appState.showDrawer = false)}
      />
    {/if}

    {#if appState.showGuide}
      <UserGuide onClose={() => (appState.showGuide = false)} />
    {/if}
  </div>
{/if}

<style>
  .startup {
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--muted);
    font-size: 13px;
  }

  .startup-failed {
    flex-direction: column;
    gap: 14px;
    padding: 24px;
    text-align: center;
  }

  .startup-failed p {
    max-width: 560px;
    margin: 0;
    color: var(--danger);
  }

  .refresh {
    padding: 9px 14px;
    border: 1px solid var(--border);
    border-radius: 9px;
    background: var(--surface);
    color: var(--text);
    font-weight: 650;
  }

  .refresh:active {
    transform: translateY(1px);
  }

  .shell {
    height: 100%;
    display: grid;
    grid-template-columns: 248px minmax(0, 1fr);
    background: var(--bg);
    overflow: hidden;
  }

  /* The progress panel docks as a third column so it never covers the page. */
  .shell.with-drawer {
    grid-template-columns: 248px minmax(0, 1fr) 380px;
  }

  .main {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    border-left: 1px solid var(--border);
  }

  /* Single scroll owner for every page. Pages must not scroll themselves. */
  .main-content {
    flex: 1;
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
    align-items: start;
  }

  .topbar {
    flex: 0 0 auto;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    min-height: 60px;
    padding: 10px var(--page-inline);
    border-bottom: 1px solid var(--border);
    background: color-mix(in srgb, var(--surface) 88%, transparent);
    backdrop-filter: blur(14px);
  }

  .topbar-title {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  h1 {
    margin: 0;
    overflow: hidden;
    font-size: 15px;
    font-weight: 650;
    letter-spacing: -0.02em;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status-pill {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 9px;
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--muted);
    font-size: 11px;
    white-space: nowrap;
  }

  .status-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--subtle);
  }

  .status-pill[data-tone="active"] {
    border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
    color: var(--accent-strong);
  }

  .status-pill[data-tone="active"] .status-dot {
    background: var(--accent-strong);
    animation: status-pulse 1.4s var(--ease) infinite alternate;
  }

  .status-pill[data-tone="done"] {
    border-color: color-mix(in srgb, var(--success) 35%, var(--border));
    color: var(--success);
  }

  .status-pill[data-tone="done"] .status-dot {
    background: var(--success);
  }

  @keyframes status-pulse {
    to { opacity: 0.3; }
  }

  .top-actions {
    flex: 0 0 auto;
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
  }

  .notices {
    width: min(100%, var(--page-max));
    display: grid;
    gap: 10px;
    padding: 16px var(--page-inline) 0;
  }

  .notice {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: 14px;
    padding: 11px 13px;
    border: 1px solid var(--border);
    border-radius: 10px;
  }

  .notice p {
    margin: 0;
    font-size: 12px;
    line-height: 1.5;
  }

  .notice.error {
    border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
    background: color-mix(in srgb, var(--danger) 8%, var(--surface));
    color: var(--danger);
  }

  .notice.warn {
    border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
    background: color-mix(in srgb, var(--accent) 9%, var(--surface));
    color: var(--text);
  }

  .dismiss {
    flex: 0 0 auto;
    padding: 4px 9px;
    border-color: currentColor;
    border-radius: 7px;
    background: transparent;
    color: inherit;
    font-size: 11px;
    opacity: 0.75;
  }

  .dismiss:hover {
    opacity: 1;
  }

  .connection {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-height: 34px;
    padding: 0 10px;
    color: var(--muted);
    font-size: 11px;
    white-space: nowrap;
  }

  .connection > span {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--danger);
  }

  .connection.ready > span {
    background: var(--success);
  }

  .results-workspace {
    width: min(100%, var(--page-max));
    padding: var(--page-top) var(--page-inline) 48px;
  }

  .report-library {
    display: grid;
    grid-template-columns: minmax(220px, 0.72fr) minmax(0, 1.6fr);
    gap: clamp(24px, 4vw, 56px);
    align-items: start;
    padding-bottom: clamp(24px, 3vw, 36px);
    border-bottom: 1px solid var(--border);
  }

  .section-heading h2,
  .section-heading p {
    margin: 0;
  }

  .section-heading h2 {
    font-size: 17px;
    letter-spacing: -0.02em;
  }

  .section-heading > p:last-child {
    max-width: 44ch;
    margin-top: 7px;
    color: var(--muted);
    font-size: 12px;
  }

  .section-heading .eyebrow {
    margin-bottom: 7px;
    color: var(--accent-strong);
    font-family: var(--mono);
    font-size: 10px;
    font-weight: 650;
    letter-spacing: 0.09em;
    text-transform: uppercase;
  }

  .report-list,
  .report-stack {
    display: grid;
    gap: 8px;
  }

  .report-stack {
    width: min(100%, var(--page-max));
    padding: 4px var(--page-inline) 48px;
  }

  .report-stack h2 {
    margin: 0;
    color: var(--muted);
    font-family: var(--mono);
    font-size: 10px;
    font-weight: 650;
    letter-spacing: 0.09em;
    text-transform: uppercase;
  }

  button {
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text);
    border-radius: 9px;
    padding: 8px 13px;
    font-weight: 600;
  }

  button:focus-visible {
    outline: 2px solid var(--accent-strong);
    outline-offset: 2px;
  }

  button.ghost {
    background: transparent;
  }

  button.ghost:hover:not(:disabled) {
    background: var(--surface-2);
    border-color: var(--border-strong);
  }

  button:disabled {
    cursor: wait;
    opacity: 0.6;
  }

  /* The window cannot go below 960px (main/index.ts minWidth), so the sidebar
     stays a column at every reachable size. Below this width there is no room
     to dock the progress panel, so it overlays instead. */
  @media (max-width: 1180px) {
    .shell,
    .shell.with-drawer {
      grid-template-columns: 216px minmax(0, 1fr);
    }

    .report-library {
      grid-template-columns: 1fr;
    }
  }
</style>
