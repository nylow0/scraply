<script lang="ts">
  import Sidebar from "./components/Sidebar.svelte";
  import Conversation from "./components/Conversation.svelte";
  import ResearchSetupForm from "./components/ResearchSetupForm.svelte";
  import SmartBriefEntry from "./components/SmartBriefEntry.svelte";
  import BriefReviewPanel from "./components/BriefReviewPanel.svelte";
  import RunReviewPanel from "./components/RunReviewPanel.svelte";
  import ResearchDrawer from "./components/ResearchDrawer.svelte";
  import IdeaWorkspace from "./components/IdeaWorkspace.svelte";
  import UserGuide from "./components/UserGuide.svelte";
  import ReportViewer from "./components/ReportViewer.svelte";
  import ResumeBanner from "./components/ResumeBanner.svelte";
  import FocusedBranchSetup from "./components/FocusedBranchSetup.svelte";
  import SetupScreen from "./components/SetupScreen.svelte";
  import type { AppState } from "./lib/state";
  import { initialState } from "./lib/state";
  import { toFavoriteModelPayload, toProjectBriefPayload, toRunConfigPayload } from "./lib/ipc-payloads";
  import type { ModelRef, ProjectBrief, RunConfig } from "@shared/schemas";
  import type { IdeaGenerationCompleteness } from "@shared/ipc";
  import { DEFAULT_RUN_CONFIG } from "@shared/intake";

  let appState: AppState = $state({ ...initialState });
  let intakeSubmitting = $state(false);
  let briefConfirming = $state(false);
  let researchStarting = $state(false);
  let ideasGenerating = $state(false);
  let setupSaving = $state(false);
  let recoveryPendingRunId: string | null = $state(null);
  let runCancelling = $state(false);
  let partialIdeaNotice: IdeaGenerationCompleteness | null = $state(null);
  let deletingThreadId: string | null = $state(null);
  let intakeMode: "smart" | "guided" = $state("smart");
  let starterText = $state("");
  let editingConfirmedBrief = $state(false);
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;

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

  async function initialLoad() {
    try {
      appState.validation = await window.scraply.getValidation();
    } catch (error) {
      appState.error = error instanceof Error ? error.message : "Failed to validate setup";
    }
    await refreshWorkspace({ preserveError: Boolean(appState.error) });
  }

  async function saveSetup(opencodeApiKey: string, exaApiKey: string) {
    if (setupSaving) return;
    setupSaving = true;
    appState.error = null;
    try {
      appState.validation = await window.scraply.saveSecrets(opencodeApiKey, exaApiKey);
      if (appState.validation.setupComplete) await refreshWorkspace();
    } catch (error) {
      appState.error = error instanceof Error ? error.message : "Failed to save provider keys";
    } finally {
      setupSaving = false;
    }
  }

  async function importSetupFromEnv() {
    if (setupSaving) return;
    setupSaving = true;
    appState.error = null;
    try {
      appState.validation = await window.scraply.importEnv();
      if (appState.validation.setupComplete) await refreshWorkspace();
    } catch (error) {
      appState.error = error instanceof Error ? error.message : "Failed to import development keys";
    } finally {
      setupSaving = false;
    }
  }

  function reconcileSoon() {
    if (reconcileTimer) clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(() => void refreshWorkspace({ preserveError: true }), 150);
  }

  function resetIntakeEntry() {
    intakeMode = "smart";
    starterText = "";
    editingConfirmedBrief = false;
  }

  $effect(() => {
    void initialLoad();
    const unsubscribe = window.scraply.onBackendEvent((event) => {
      if (event.threadId !== appState.workspace?.activeThreadId) return;
      if (appState.activeRunId && event.runId !== appState.activeRunId) return;
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
        appState.showDrawer = true;
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
      const result = await window.scraply.startResearch(threadId);
      appState.workspace = result.workspace;
      appState.activeRunId = result.runId;
      appState.showDrawer = true;
    } catch (error) {
      appState.error = error instanceof Error ? error.message : "Failed to start research";
    } finally {
      researchStarting = false;
    }
  }

  async function generateIdeas(allowPartial = false) {
    const runId = appState.workspace?.latestResearchRun?.runId;
    if (!runId || ideasGenerating) {
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
    const run = appState.workspace?.latestResearchRun;
    if (!run || !partialRunAvailable) return;
    const coverage = [...run.missingLenses, ...run.gaps].join("; ") || "Synthesis was not completed.";
    if (!window.confirm(`Generate ideas from partial research? Missing coverage: ${coverage}`)) return;
    await generateIdeas(true);
  }

  async function resumeResearch(runId: string) {
    if (recoveryPendingRunId) return;
    recoveryPendingRunId = runId;
    appState.error = null;
    try {
      appState.workspace = await window.scraply.resumeResearch(runId);
      appState.showDrawer = true;
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
</script>

{#if appState.loading}
  <div class="boot"><span class="boot-mark" aria-hidden="true"></span><span>Connecting Scraply…</span></div>
{:else if !appState.validation?.setupComplete}
  <SetupScreen
    validation={appState.validation}
    error={appState.error}
    saving={setupSaving}
    canImportEnv={window.scraply.canImportEnv}
    onSave={saveSetup}
    onImportEnv={importSetupFromEnv}
    onOpenData={() => window.scraply.openDataFolder()}
    onOpenLogs={() => window.scraply.openLogsFolder()}
  />
{:else}
  <div class="shell">
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
      {#if (appState.workspace?.pendingRuns?.length ?? 0) > 0}
        <ResumeBanner
          pendingRuns={appState.workspace?.pendingRuns ?? []}
          pendingRunId={recoveryPendingRunId}
          onResume={resumeResearch}
          onCancel={cancelIncompleteResearch}
        />
      {/if}
      <header class="topbar">
        <div>
          <h1>{activeThread?.title ?? "Scraply"}</h1>
          <p class="status">{activeThread?.status ?? "ready"}</p>
        </div>
        <div class="top-actions">
          <span class:ready={providersReady} class="connection" role="status">
            <span aria-hidden="true"></span>{providersReady ? "Providers ready" : "Limited connection"}
          </span>
          <button class="ghost" aria-label="Toggle research progress drawer" onclick={() => (appState.showDrawer = !appState.showDrawer)}>Research</button>
          {#if appState.workspace?.latestResearchRun?.synthesisReportId}
            <button class="primary" disabled={ideasGenerating} onclick={() => generateIdeas(false)}>
              {ideasGenerating ? "Generating…" : "Generate ideas"}
            </button>
          {/if}
          {#if partialRunAvailable}
            <button class="ghost" disabled={ideasGenerating} onclick={generatePartialIdeas}>
              Generate from partial research
            </button>
          {/if}
        </div>
      </header>

      <div class="main-content">
      {#if appState.error && activeThread?.status !== "intake"}
        <p class="global-error" role="alert">{appState.error}</p>
      {/if}
      {#if partialIdeaNotice}
        <p class="partial-notice" role="status">
          <strong>Partial ideas</strong> · Missing: {partialIdeaNotice.missingLenses.join(", ") || "none"}
          {#if partialIdeaNotice.gaps.length} · Gaps: {partialIdeaNotice.gaps.join("; ")}{/if}
        </p>
      {/if}

      {#if appState.workspace?.branchContext}
        <FocusedBranchSetup context={appState.workspace.branchContext} />
      {/if}

      {#if activeThread?.status === "intake"}
        <section class="intake-workspace" aria-label="Research setup">
          <div class="intake-pane">
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
          </div>
        </section>
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
      {:else if activeThread?.status !== "ideas-ready"}
        <Conversation messages={appState.workspace?.messages ?? []} />
      {/if}

      {#if activeThread?.status === "ideas-ready"}
        <div class="results-workspace">
          {#if (appState.workspace?.reports?.length ?? 0) > 0}
            <section class="report-library" aria-labelledby="report-library-title">
              <div class="section-heading">
                <p class="eyebrow">Source material</p>
                <h2 id="report-library-title">Research reports</h2>
                <p>Open a report when you need to trace an idea back to the underlying research.</p>
              </div>
              <div class="report-list">
                {#each appState.workspace?.reports ?? [] as report (report.id)}
                  <ReportViewer reportId={report.id} title={report.title} />
                {/each}
              </div>
            </section>
          {/if}

          <IdeaWorkspace ideas={appState.workspace?.ideas ?? []} threadId={activeThread?.id ?? ""} onRefresh={refreshWorkspace} />
        </div>
      {:else if (appState.workspace?.reports?.length ?? 0) > 0}
        <div class="report-stack">
          {#each appState.workspace?.reports ?? [] as report (report.id)}
            <ReportViewer reportId={report.id} title={report.title} />
          {/each}
        </div>
      {/if}
      </div>
    </main>

    {#if appState.showDrawer}
      <ResearchDrawer
        events={appState.researchEvents}
        activeRunId={appState.activeRunId}
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
  .boot {
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    place-items: center;
    color: var(--muted);
    font-size: 13px;
  }

  .boot-mark {
    width: 10px;
    height: 10px;
    border: 2px solid var(--accent);
    border-radius: 3px 3px 3px 1px;
    animation: boot-pulse 1.2s var(--ease) infinite alternate;
  }

  @keyframes boot-pulse {
    to { transform: rotate(12deg) scale(0.84); opacity: 0.55; }
  }

  .shell {
    height: 100%;
    display: grid;
    grid-template-columns: 248px minmax(0, 1fr);
    background: var(--bg);
    overflow: hidden;
  }

  .main {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    border-left: 1px solid var(--border);
  }

  .main-content {
    flex: 1;
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
  }

  .topbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    min-height: 60px;
    padding: 10px clamp(20px, 3vw, 36px);
    border-bottom: 1px solid var(--border);
    background: color-mix(in srgb, var(--surface) 88%, transparent);
    backdrop-filter: blur(14px);
  }

  h1 {
    margin: 0;
    font-size: 15px;
    font-weight: 650;
    letter-spacing: -0.02em;
  }

  .status {
    margin: 4px 0 0;
    color: var(--subtle);
    font-family: var(--mono);
    font-size: 12px;
    text-transform: lowercase;
  }

  .top-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
  }

  .intake-workspace {
    flex: 1;
    min-height: 0;
    display: block;
    background: var(--bg);
  }

  .intake-pane {
    height: 100%;
    min-height: 0;
    overflow: hidden;
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

  .global-error {
    margin: 12px 20px 0;
    padding: 10px 12px;
    border: 1px solid color-mix(in srgb, var(--danger) 45%, var(--border));
    border-radius: 8px;
    color: var(--danger);
    background: color-mix(in srgb, var(--danger) 8%, var(--surface));
  }

  .partial-notice {
    margin: 12px 20px 0;
    padding: 10px 12px;
    border: 1px solid color-mix(in srgb, #d89b2b 45%, var(--border));
    border-radius: 8px;
    color: var(--text);
    background: color-mix(in srgb, #d89b2b 9%, var(--surface));
  }

  .results-workspace {
    width: min(100%, 1440px);
    margin: 0 auto;
    padding: clamp(22px, 3vw, 38px);
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
    padding: 12px 20px 20px;
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

  button.primary {
    background: var(--accent-strong);
    border-color: var(--accent-strong);
    color: var(--accent-ink);
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

  @media (max-width: 960px) {
    .shell {
      grid-template-columns: 1fr;
    }

    .report-library {
      grid-template-columns: 1fr;
    }
  }
</style>
