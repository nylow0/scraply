<script lang="ts">
  import SetupScreen from "./components/SetupScreen.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import Conversation from "./components/Conversation.svelte";
  import Composer from "./components/Composer.svelte";
  import BriefPanel from "./components/BriefPanel.svelte";
  import RunConfigPanel from "./components/RunConfigPanel.svelte";
  import ResearchDrawer from "./components/ResearchDrawer.svelte";
  import IdeaWorkspace from "./components/IdeaWorkspace.svelte";
  import UserGuide from "./components/UserGuide.svelte";
  import ReportViewer from "./components/ReportViewer.svelte";
  import ResumeBanner from "./components/ResumeBanner.svelte";
  import type { AppState } from "./lib/state";
  import { initialState } from "./lib/state";
  import type { ProjectBrief } from "@shared/schemas";
  import { DEFAULT_RUN_CONFIG } from "@shared/intake";

  let state: AppState = $state({ ...initialState });
  let setupKeys = $state({ opencode: "", exa: "" });

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

  $effect(() => {
    void refresh();
    return window.scraply.onBackendEvent((event) => {
      state.researchEvents = [...state.researchEvents, event];
      if (event.type === "run-started") state.activeRunId = event.runId;
      if (event.type === "run-completed" || event.type === "run-cancelled") {
        state.activeRunId = null;
        void refresh();
      }
      if (event.type === "stream-completed" || event.type === "synthesis-completed") void refresh();
      if (event.type === "run-resumed") {
        state.activeRunId = event.runId;
        state.showDrawer = true;
        void refresh();
      }
      if (event.type === "ideas-generated") void refresh();
    });
  });

  async function saveSetup() {
    state.error = null;
    try {
      state.validation = await window.scraply.saveSecrets(setupKeys.opencode.trim(), setupKeys.exa.trim());
      await refresh();
    } catch (error) {
      state.error = error instanceof Error ? error.message : "Failed to save keys";
    }
  }

  async function importEnv() {
    state.validation = await window.scraply.importEnv();
    await refresh();
  }

  async function newThread() {
    const result = await window.scraply.createThread();
    state.workspace = result.workspace;
    state.composer = "";
  }

  async function selectThread(threadId: string) {
    state.workspace = await window.scraply.selectThread(threadId);
  }

  async function submitMessage() {
    const threadId = state.workspace?.activeThreadId;
    const text = state.composer.trim();
    if (!threadId || !text) return;

    const thread = state.workspace?.threads.find((t) => t.id === threadId);
    if (!thread) return;

    if (thread.status === "intake") {
      const lastAssistant = [...(state.workspace?.messages ?? [])].reverse().find((m) => m.role === "assistant");
      const questionId = mapPromptToQuestion(lastAssistant?.content ?? "");
      if (!questionId) return;
      const skipped = /^(skip|skipped)$/i.test(text);
      const result = await window.scraply.submitIntake({
        threadId,
        questionId,
        answer: skipped ? "" : text,
        skipped,
      });
      state.workspace = result.workspace;
      state.composer = "";
      return;
    }

    state.composer = "";
  }

  function mapPromptToQuestion(content: string): string | null {
    const questions: Array<[RegExp, string]> = [
      [/trying to generate ideas/i, "goal"],
      [/broad theme/i, "theme"],
      [/make an idea good/i, "good-idea"],
      [/final output/i, "output"],
      [/decides whether this succeeds/i, "success-decider"],
      [/why do you want/i, "motivation"],
      [/deadline or ideal window/i, "deadline"],
      [/skills, tools, resources/i, "resources"],
      [/must be avoided/i, "avoid"],
      [/decision must be made/i, "final-decision"],
      [/safe versus weird/i, "style-balance"],
      [/existing examples/i, "examples"],
      [/research requirements/i, "research-needs"],
      [/scoring criteria/i, "scoring-criteria"],
      [/still missing/i, "anything-else"],
    ];
    for (const [pattern, id] of questions) {
      if (pattern.test(content)) return id;
    }
    return "goal";
  }

  async function confirmBrief(brief: ProjectBrief) {
    const threadId = state.workspace?.activeThreadId;
    if (!threadId) return;
    state.workspace = await window.scraply.confirmBrief({ threadId, brief });
  }

  async function saveRunConfig(config = state.workspace?.runConfig ?? DEFAULT_RUN_CONFIG, presetName?: string) {
    const threadId = state.workspace?.activeThreadId;
    if (!threadId) return;
    state.workspace = await window.scraply.saveRunConfig({ threadId, config, presetName });
  }

  async function startResearch() {
    const threadId = state.workspace?.activeThreadId;
    if (!threadId) return;
    if (!state.workspace?.runConfig) await saveRunConfig();
    const result = await window.scraply.startResearch(threadId);
    state.workspace = result.workspace;
    state.showDrawer = true;
  }

  async function generateIdeas() {
    const threadId = state.workspace?.activeThreadId;
    if (!threadId) return;
    const result = await window.scraply.generateIdeas(threadId);
    state.workspace = result.workspace;
  }

  async function resumeResearch(runId: string) {
    state.workspace = await window.scraply.resumeResearch(runId);
    state.showDrawer = true;
  }

  async function cancelIncompleteResearch(runId: string) {
    state.workspace = await window.scraply.cancelIncompleteResearch(runId);
  }

  const activeThread = $derived(state.workspace?.threads.find((t) => t.id === state.workspace?.activeThreadId) ?? null);
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
      onNew={newThread}
      onSelect={selectThread}
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
          {#if activeThread?.status === "configuring"}
            <button class="primary" onclick={startResearch}>Start research</button>
          {/if}
          {#if activeThread?.status === "research-complete" || activeThread?.status === "research-running"}
            <button class="primary" onclick={generateIdeas}>Generate ideas</button>
          {/if}
        </div>
      </header>

      <Conversation messages={state.workspace?.messages ?? []} />

      {#if activeThread?.status === "brief-draft" && state.workspace?.brief}
        <BriefPanel brief={state.workspace.brief} onConfirm={confirmBrief} />
      {/if}

      {#if activeThread?.status === "brief-confirmed" || activeThread?.status === "configuring"}
        <RunConfigPanel
          models={state.workspace?.models ?? []}
          config={state.workspace?.runConfig ?? DEFAULT_RUN_CONFIG}
          presets={state.workspace?.presets ?? []}
          onSave={(config, presetName) => saveRunConfig(config, presetName)}
        />
      {/if}

      {#if (state.workspace?.reports?.length ?? 0) > 0}
        {#each state.workspace?.reports ?? [] as report (report.id)}
          <ReportViewer title={report.title} html={report.html} />
        {/each}
      {/if}

      {#if activeThread?.status === "ideas-ready"}
        <IdeaWorkspace ideas={state.workspace?.ideas ?? []} threadId={activeThread?.id ?? ""} onRefresh={refresh} />
      {/if}

      <Composer
        value={state.composer}
        disabled={!activeThread || !["intake"].includes(activeThread.status)}
        placeholder={activeThread?.status === "intake" ? "Answer the question… (type skip for optional questions)" : "Research controls are in the header"}
        onChange={(value) => (state.composer = value)}
        onSubmit={submitMessage}
      />
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

  @media (max-width: 960px) {
    .shell {
      grid-template-columns: 1fr;
    }
  }
</style>
