<script lang="ts">
  import SetupScreen from "./components/SetupScreen.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import Conversation from "./components/Conversation.svelte";
  import ResearchSetupForm from "./components/ResearchSetupForm.svelte";
  import BriefPanel from "./components/BriefPanel.svelte";
  import RunConfigPanel from "./components/RunConfigPanel.svelte";
  import ResearchDrawer from "./components/ResearchDrawer.svelte";
  import IdeaWorkspace from "./components/IdeaWorkspace.svelte";
  import UserGuide from "./components/UserGuide.svelte";
  import ReportViewer from "./components/ReportViewer.svelte";
  import ResumeBanner from "./components/ResumeBanner.svelte";
  import FocusedBranchSetup from "./components/FocusedBranchSetup.svelte";
  import type { AppState } from "./lib/state";
  import { initialState } from "./lib/state";
  import type { ModelRef, ProjectBrief, RunConfig } from "@shared/schemas";
  import type { IdeaGenerationCompleteness } from "@shared/ipc";
  import { DEFAULT_RUN_CONFIG } from "@shared/intake";

  let state: AppState = $state({ ...initialState });
  let setupKeys = $state({ opencode: "", exa: "" });
  let intakeSubmitting = $state(false);
  let briefConfirming = $state(false);
  let researchStarting = $state(false);
  let ideasGenerating = $state(false);
  let partialIdeaNotice = $state<IdeaGenerationCompleteness | null>(null);
  let deletingThreadId = $state<string | null>(null);
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;

  async function refreshWorkspace() {
    state.error = null;
    try {
      state.workspace = await window.scraply.getWorkspace();
    } catch (error) {
      state.error = error instanceof Error ? error.message : "Failed to load workspace";
    } finally {
      state.loading = false;
    }
  }

  async function initialLoad() {
    try {
      state.validation = await window.scraply.getValidation();
    } catch (error) {
      state.error = error instanceof Error ? error.message : "Failed to validate setup";
    }
    await refreshWorkspace();
  }

  function reconcileSoon() {
    if (reconcileTimer) clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(() => void refreshWorkspace(), 150);
  }

  $effect(() => {
    void initialLoad();
    const unsubscribe = window.scraply.onBackendEvent((event) => {
      if ("threadId" in event && event.threadId !== state.workspace?.activeThreadId) return;
      if ("runId" in event && state.activeRunId && event.runId !== state.activeRunId) return;
      state.researchEvents = [...state.researchEvents, event];
      if (event.type === "run-started") state.activeRunId = event.runId;
      if (event.type === "run-completed" || event.type === "run-cancelled") {
        state.activeRunId = null;
        reconcileSoon();
      }
      if (event.type === "stream-completed" || event.type === "synthesis-completed") reconcileSoon();
      if (event.type === "run-resumed") {
        state.activeRunId = event.runId;
        state.showDrawer = true;
        reconcileSoon();
      }
      if (event.type === "ideas-generated") reconcileSoon();
    });
    return () => {
      unsubscribe();
      if (reconcileTimer) clearTimeout(reconcileTimer);
    };
  });

  async function saveSetup() {
    state.error = null;
    try {
      state.validation = await window.scraply.saveSecrets(setupKeys.opencode.trim(), setupKeys.exa.trim());
      await refreshWorkspace();
    } catch (error) {
      state.error = error instanceof Error ? error.message : "Failed to save keys";
    }
  }

  async function importEnv() {
    state.validation = await window.scraply.importEnv();
    await refreshWorkspace();
  }

  async function newThread() {
    state.error = null;
    try {
      const result = await window.scraply.createThread();
      state.workspace = result.workspace;
    } catch (error) {
      state.error = error instanceof Error ? error.message : "Failed to create research";
    }
  }

  async function selectThread(threadId: string) {
    state.error = null;
    try {
      state.workspace = await window.scraply.selectThread(threadId);
      state.researchEvents = [];
      state.activeRunId = null;
    } catch (error) {
      state.error = error instanceof Error ? error.message : "Failed to open research";
    }
  }

  async function deleteThread(threadId: string) {
    if (deletingThreadId) return;
    deletingThreadId = threadId;
    state.error = null;
    try {
      state.workspace = await window.scraply.deleteThread(threadId);
    } catch (error) {
      state.error = error instanceof Error ? error.message : "Failed to delete research";
    } finally {
      deletingThreadId = null;
    }
  }

  async function submitIntakeAnswers(answers: Array<{ questionId: string; answer: string; skipped: boolean }>) {
    const threadId = state.workspace?.activeThreadId;
    if (!threadId || intakeSubmitting) return;
    intakeSubmitting = true;
    state.error = null;
    try {
      for (const answer of answers) {
        const result = await window.scraply.submitIntake({
          threadId,
          questionId: answer.questionId,
          answer: answer.answer,
          skipped: answer.skipped,
        });
        state.workspace = result.workspace;
      }
      if (!state.workspace?.brief) throw new Error("Brief was not generated from your answers");
    } catch (error) {
      state.error = error instanceof Error ? error.message : "Failed to draft brief";
    } finally {
      intakeSubmitting = false;
    }
  }

  async function confirmBrief(brief: ProjectBrief) {
    const threadId = state.workspace?.activeThreadId;
    if (!threadId || briefConfirming) return;
    briefConfirming = true;
    state.error = null;
    try {
      state.workspace = await window.scraply.confirmBrief({ threadId, brief });
    } catch (error) {
      state.error = error instanceof Error ? error.message : "Failed to confirm brief";
    } finally {
      briefConfirming = false;
    }
  }

  async function saveRunConfig(config = state.workspace?.runConfig ?? DEFAULT_RUN_CONFIG, presetName?: string) {
    const threadId = state.workspace?.activeThreadId;
    if (!threadId) return;
    try {
      state.workspace = await window.scraply.saveRunConfig({ threadId, config, presetName });
    } catch (error) {
      state.error = error instanceof Error ? error.message : "Failed to save configuration";
    }
  }

  async function saveFavoriteModel(model: ModelRef, favorite: boolean) {
    try {
      state.workspace = await window.scraply.saveFavoriteModel({ model, favorite });
    } catch (error) {
      state.error = error instanceof Error ? error.message : "Failed to update favorite";
    }
  }

  async function startResearch(config: RunConfig) {
    const threadId = state.workspace?.activeThreadId;
    if (!threadId || researchStarting) return;
    researchStarting = true;
    state.error = null;
    try {
      state.workspace = await window.scraply.saveRunConfig({ threadId, config });
      const result = await window.scraply.startResearch(threadId);
      state.workspace = result.workspace;
      state.activeRunId = result.runId;
      state.showDrawer = true;
    } catch (error) {
      state.error = error instanceof Error ? error.message : "Failed to start research";
    } finally {
      researchStarting = false;
    }
  }

  async function generateIdeas(allowPartial = false) {
    const runId = state.workspace?.latestResearchRun?.runId;
    if (!runId || ideasGenerating) {
      state.error = "A completed research synthesis is required before generating ideas.";
      return;
    }
    ideasGenerating = true;
    state.error = null;
    try {
      const result = await window.scraply.generateIdeas(runId, allowPartial);
      state.workspace = result.workspace;
      partialIdeaNotice = result.completeness.mode === "partial" ? result.completeness : null;
    } catch (error) {
      state.error = error instanceof Error ? error.message : "Failed to generate ideas";
    } finally {
      ideasGenerating = false;
    }
  }

  async function generatePartialIdeas() {
    const run = state.workspace?.latestResearchRun;
    if (!run || !partialRunAvailable) return;
    const coverage = [...run.missingLenses, ...run.gaps].join("; ");
    if (!window.confirm(`Generate ideas from partial research? Missing coverage: ${coverage}`)) return;
    await generateIdeas(true);
  }

  async function resumeResearch(runId: string) {
    state.workspace = await window.scraply.resumeResearch(runId);
    state.showDrawer = true;
  }

  async function cancelIncompleteResearch(runId: string) {
    state.workspace = await window.scraply.cancelIncompleteResearch(runId);
  }

  const activeThread = $derived(state.workspace?.threads.find((t) => t.id === state.workspace?.activeThreadId) ?? null);
  const partialRunAvailable = $derived(Boolean(
    state.workspace?.latestResearchRun
    && ["partial", "failed"].includes(state.workspace.latestResearchRun.status)
    && (state.workspace.latestResearchRun.missingLenses.length > 0 || state.workspace.latestResearchRun.gaps.length > 0),
  ));
  const setupComplete = $derived(Boolean(state.validation?.setupComplete));
</script>

{#if state.loading}
  <div class="boot">Starting Scraply…</div>
{:else if !setupComplete}
  <SetupScreen
    validation={state.validation}
    bind:opencode={setupKeys.opencode}
    bind:exa={setupKeys.exa}
    error={state.error}
    onSave={saveSetup}
    onImportEnv={importEnv}
  />
{:else}
  <div class="shell">
    <Sidebar
      threads={state.workspace?.threads ?? []}
      activeThreadId={state.workspace?.activeThreadId ?? null}
      {deletingThreadId}
      onNew={newThread}
      onSelect={selectThread}
      onDelete={deleteThread}
      onOpenGuide={() => (state.showGuide = true)}
      onOpenData={() => window.scraply.openDataFolder()}
    />

    <main class="main">
      {#if (state.workspace?.pendingRuns?.length ?? 0) > 0}
        <ResumeBanner
          pendingRuns={state.workspace?.pendingRuns ?? []}
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
          <button class="ghost" aria-label="Toggle research progress drawer" onclick={() => (state.showDrawer = !state.showDrawer)}>Research</button>
          {#if activeThread?.status === "brief-confirmed" || activeThread?.status === "configuring"}
            <button class="ghost" onclick={() => saveRunConfig()}>Save config</button>
          {/if}
          {#if state.workspace?.latestResearchRun?.synthesisReportId}
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

      {#if state.error}
        <p class="global-error" role="alert">{state.error}</p>
      {/if}
      {#if partialIdeaNotice}
        <p class="partial-notice" role="status">
          <strong>Partial ideas</strong> · Missing: {partialIdeaNotice.missingLenses.join(", ") || "none"}
          {#if partialIdeaNotice.gaps.length} · Gaps: {partialIdeaNotice.gaps.join("; ")}{/if}
        </p>
      {/if}

      {#if state.workspace?.branchContext}
        <FocusedBranchSetup context={state.workspace.branchContext} />
      {/if}

      {#if activeThread?.status === "intake"}
        <ResearchSetupForm
          submitting={intakeSubmitting}
          error={state.error}
          onSubmit={submitIntakeAnswers}
        />
      {:else}
        <Conversation messages={state.workspace?.messages ?? []} />
      {/if}

      {#if activeThread?.status === "brief-draft" && state.workspace?.brief}
        <BriefPanel brief={state.workspace.brief} confirming={briefConfirming} onConfirm={confirmBrief} />
      {/if}

      {#if activeThread?.status === "brief-confirmed" || activeThread?.status === "configuring"}
        <RunConfigPanel
          models={state.workspace?.models ?? []}
          modelCatalog={state.workspace?.modelCatalog}
          config={state.workspace?.runConfig ?? DEFAULT_RUN_CONFIG}
          presets={state.workspace?.presets ?? []}
          onSave={(config, presetName) => saveRunConfig(config, presetName)}
          onStart={startResearch}
          starting={researchStarting}
          onFavorite={saveFavoriteModel}
        />
      {/if}

      {#if (state.workspace?.reports?.length ?? 0) > 0}
        {#each state.workspace?.reports ?? [] as report (report.id)}
          <ReportViewer reportId={report.id} title={report.title} />
        {/each}
      {/if}

      {#if activeThread?.status === "ideas-ready"}
        <IdeaWorkspace ideas={state.workspace?.ideas ?? []} threadId={activeThread?.id ?? ""} onRefresh={refreshWorkspace} />
      {/if}
    </main>

    {#if state.showDrawer}
      <ResearchDrawer events={state.researchEvents} onClose={() => (state.showDrawer = false)} />
    {/if}

    {#if state.showGuide}
      <UserGuide onClose={() => (state.showGuide = false)} />
    {/if}
  </div>
{/if}

<style>
  .boot {
    height: 100%;
    display: grid;
    place-items: center;
    color: var(--muted);
  }

  .shell {
    height: 100%;
    display: grid;
    grid-template-columns: 280px 1fr;
    background: var(--bg);
  }

  .main {
    display: grid;
    grid-template-rows: auto 1fr auto auto auto auto;
    min-width: 0;
    border-left: 1px solid var(--border);
  }

  .topbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border);
    background: rgba(18, 18, 18, 0.8);
    backdrop-filter: blur(8px);
  }

  h1 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
  }

  .status {
    margin: 4px 0 0;
    color: var(--muted);
    font-family: var(--mono);
    font-size: 12px;
    text-transform: lowercase;
  }

  .top-actions {
    display: flex;
    gap: 8px;
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

  button {
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    border-radius: 8px;
    padding: 8px 12px;
  }

  button:focus-visible {
    outline: 2px solid var(--accent-strong);
    outline-offset: 2px;
  }

  button.primary {
    background: color-mix(in srgb, var(--accent) 24%, var(--surface));
    border-color: color-mix(in srgb, var(--accent) 50%, var(--border));
  }

  button.ghost {
    background: transparent;
  }

  button:disabled {
    cursor: wait;
    opacity: 0.6;
  }

  @media (max-width: 960px) {
    .shell {
      grid-template-columns: 1fr;
    }
  }
</style>
