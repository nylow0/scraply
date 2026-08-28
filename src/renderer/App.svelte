<script lang="ts">
  import { onMount } from "svelte";
  import type { ResearchEvent, WorkspaceState } from "../shared/ipc";
  import Sidebar from "./components/Sidebar.svelte";
  import ScopeForm from "./components/ScopeForm.svelte";
  import ProblemCheckpoint from "./components/ProblemCheckpoint.svelte";
  import ResearchArchive from "./components/ResearchArchive.svelte";
  import SetupArchive from "./components/SetupArchive.svelte";
  import SolutionWorkspace from "./components/SolutionWorkspace.svelte";
  import WorkflowTabs, { type WorkflowStep } from "./components/WorkflowTabs.svelte";

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
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  let reconcilePending = false;
  let loadEpoch = 0;
  let activeThread = $derived(workspace?.threads.find((item) => item.id === workspace?.activeThreadId) ?? null);
  let activeRun = $derived(workspace?.latestResearchRun ?? null);
  // Local-only override: lets the user reopen the scope form from a failed run without touching server state.
  let editingScope = $derived(editingScopeThreadId !== null && editingScopeThreadId === activeThread?.id);
  let researchReady = $derived(Boolean(activeThread && (workspace?.problemCandidates.length || activeThread.status === "discovery-running")));
  let ideasReady = $derived(Boolean(activeThread && (workspace?.solutions.length || activeThread.status === "development-running" || activeThread.status === "solutions-ready")));

  onMount(() => {
    void load();
    const dispose = window.scraply.onBackendEvent((event) => {
      if (event.threadId !== workspace?.activeThreadId) return;
      latestEvent = event;
      reconcileSoon();
    });
    return () => { dispose(); if (reconcileTimer) clearTimeout(reconcileTimer); };
  });

  async function load() {
    const requestEpoch = ++loadEpoch;
    try {
      const next = await window.scraply.getWorkspace();
      if (requestEpoch !== loadEpoch) return;
      const changedThread = next.activeThreadId !== workspace?.activeThreadId;
      workspace = next;
      if (changedThread) activeStep = defaultStep(next);
      if (feedback?.source === "workspace-load") feedback = null;
    }
    catch (cause) {
      if (requestEpoch === loadEpoch) feedback = { text: message(cause), tone: "error", source: "workspace-load" };
    }
    finally {
      if (requestEpoch === loadEpoch) loading = false;
    }
  }
  function setWorkspace(next: WorkspaceState) {
    loadEpoch += 1;
    loading = false;
    workspace = next;
  }
  function reconcileSoon() {
    reconcilePending = true;
    if (reconcileTimer) clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(() => {
      reconcileTimer = null;
      if (busy) return;
      reconcilePending = false;
      void load();
    }, 180);
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
    if (thread?.status === "discovery-running" || state.problemCandidates.length > 0) return "research";
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
  async function saveScope(scope: NonNullable<WorkspaceState["scope"]>, config: NonNullable<WorkspaceState["runConfig"]>) {
    const threadId = workspace?.activeThreadId;
    if (!threadId || busy) return;
    busy = true;
    feedback = null;
    try {
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
  async function resumeResearch(runId: string) {
    await action(async () => setWorkspace(await window.scraply.resumeResearch(runId)));
  }
  async function cancelResearch(runId: string) {
    await action(async () => setWorkspace(await window.scraply.cancelResearch(runId)));
  }
  async function selectProblems(ids: string[], userProblem: string | null) {
    const threadId = workspace?.activeThreadId;
    if (!threadId) return;
    await action(async () => {
      setWorkspace(await window.scraply.selectProblems({ threadId, problemIds: ids, userProblem }));
      activeStep = "ideas";
      reviewSelection = false;
    });
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

<div class="app-shell">
  <Sidebar
    threads={workspace?.threads ?? []}
    activeThreadId={workspace?.activeThreadId ?? null}
    {busy}
    {deletingThreadId}
    onNew={createThread}
    onSelect={selectThread}
    onDelete={deleteThread}
    onOpenGuide={() => { feedback = { text: "Workflow: start from any context and choose discovered problems, or start with a known problem and go directly to solutions.", tone: "info" }; }}
    onOpenData={openDataFolder}
    onOpenLogs={openLogsFolder}
  />

  <main class="main-content">
    {#if workspace && activeThread}
      <div class="topbar">
        <div><span class="status-dot" class:live={activeThread.status.endsWith("running")}></span>{activeThread.title}</div>
        {#if activeRun}<div class="calls"><strong>{activeRun.codexCalls}</strong> Codex calls / ~{activeRun.projectedCodexCalls} · <strong>{activeRun.exaSearches}</strong> Exa searches / ~{activeRun.projectedExaSearches}</div>{/if}
      </div>
      <WorkflowTabs
        active={activeStep}
        setupReady={true}
        {researchReady}
        {ideasReady}
        onSelect={openStep}
      />
      {#if activeThread.status === "failed"}
        <div class="run-stopped" role="status">
          <div><strong>Run stopped</strong><span>{activeRun?.lastActivity ?? "The last run failed or was cancelled. Review the setup, then retry explicitly."}</span></div>
          <div class="run-stopped-actions">
            {#if activeRun && ["queued", "running"].includes(activeRun.status)}
              <button disabled={busy} onclick={() => resumeResearch(activeRun.runId)}>Resume attempt</button>
              <button class="cancel" disabled={busy} onclick={() => cancelResearch(activeRun.runId)}>Cancel run</button>
            {/if}
            {#if workspace.problemCandidates.length > 0}<button disabled={busy} onclick={() => { activeStep = "research"; reviewSelection = true; }}>Review problems</button>{/if}
            <button disabled={busy} onclick={() => { activeStep = "setup"; editingScopeThreadId = activeThread?.id ?? null; }}>Edit setup</button>
          </div>
        </div>
      {/if}
    {/if}

    {#if feedback}<div class:error={feedback.tone === "error"} class="notice" role={feedback.tone === "error" ? "alert" : "status"}>{feedback.text}<button aria-label="Dismiss" onclick={() => feedback = null}>×</button></div>{/if}

    {#if loading}
      <div class="skeleton" role="status" aria-label="Loading workspace"><i></i><i></i><i></i></div>
    {:else if !workspace || !activeThread}
      <section class="welcome"><p class="eyebrow">Local-first research</p><h1>Find problems worth solving before generating solutions.</h1><p>Start with whatever context you have. Scraply will gather evidence, try to kill each candidate, and stop for your judgment.</p><button disabled={busy} onclick={createThread}>{busy ? "Creating…" : "Create research"}</button></section>
    {:else if activeStep === "setup"}
      {#if activeThread.status === "configuring" || editingScope || !workspace.scope}
        <div id="workflow-panel-setup" role="tabpanel" aria-label="Research setup">
          {#key workspace.activeThreadId}
            <ScopeForm {workspace} {busy} onSave={saveScope} onStart={startResearch} onRetry={retryConnections} />
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
          <p class="eyebrow">Discovery in progress</p>
          <h1>Reading the field before naming the problem.</h1>
          <div class="activity"><span></span><p>{latestEvent?.type === "run-progress" ? latestEvent.message : activeRun?.lastActivity ?? "Preparing the next provider call…"}</p></div>
          {#if activeRun}<div class="run-actions"><button disabled={busy} onclick={() => resumeResearch(activeRun.runId)}>Resume attempt</button><button class="cancel" disabled={busy} onclick={() => cancelResearch(activeRun.runId)}>Cancel run</button></div>{/if}
        </div>
      {:else if (activeThread.status === "problems-ready" || reviewSelection) && workspace.problemCandidates.length > 0}
        <div id="workflow-panel-research" role="tabpanel" aria-label="Research">
          {#key workspace.activeThreadId}
            <ProblemCheckpoint problems={workspace.problemCandidates} {busy} onCommit={selectProblems} onExport={exportResearch} onOpenSource={openExternalUrl} />
          {/key}
        </div>
      {:else if workspace.problemCandidates.length > 0}
        <ResearchArchive problems={workspace.problemCandidates} {busy} onExport={exportResearch} onOpenSource={openExternalUrl} />
      {:else}
        <div class="failed" id="workflow-panel-research" role="tabpanel" aria-label="Research" tabindex="0"><p class="eyebrow">Research unavailable</p><h1>No completed research is ready yet.</h1><p>Return to setup and start a research run.</p></div>
      {/if}
    {:else if activeThread.status === "development-running"}
      <div class="running" id="workflow-panel-ideas" role="tabpanel" aria-label="Ideas" tabindex="0">
        <p class="eyebrow">Development in progress</p>
        <h1>Building the selected chain one problem at a time.</h1>
        <p class="research-export-hint">The research archive is already available. Open the Research tab to inspect or export it while ideas are generated.</p>
        <div class="activity"><span></span><p>{latestEvent?.type === "run-progress" ? latestEvent.message : activeRun?.lastActivity ?? "Preparing the next provider call…"}</p></div>
        {#if activeRun}<div class="run-actions"><button disabled={busy} onclick={() => resumeResearch(activeRun.runId)}>Resume attempt</button><button class="cancel" disabled={busy} onclick={() => cancelResearch(activeRun.runId)}>Cancel run</button></div>{/if}
      </div>
    {:else if activeThread.status === "solutions-ready" || workspace.solutions.length > 0}
      <div id="workflow-panel-ideas" role="tabpanel" aria-label="Ideas">
        <SolutionWorkspace solutions={workspace.solutions} {busy} onExport={exportIdeas} onReview={() => { activeStep = "research"; reviewSelection = true; }} />
      </div>
    {:else if activeThread.status === "failed"}
      <div class="failed" id="workflow-panel-ideas" role="tabpanel" aria-label="Ideas" tabindex="0"><p class="eyebrow">No ideas</p><h1>The run stopped before any ideas were built.</h1><p>Use the controls above to resume the attempt or edit the setup.</p></div>
    {:else}
      <div class="failed" id="workflow-panel-ideas" role="tabpanel" aria-label="Ideas" tabindex="0"><p class="eyebrow">Ideas not ready</p><h1>Complete the research step first.</h1></div>
    {/if}
  </main>
</div>

<style>
  .app-shell{height:100%;display:grid;grid-template-columns:250px minmax(0,1fr);background:var(--bg)}.main-content{min-width:0;overflow:auto;position:relative;border-left:1px solid var(--border)}.topbar{position:sticky;top:0;z-index:3;height:48px;padding:0 20px;display:flex;align-items:center;justify-content:space-between;background:color-mix(in srgb,var(--bg) 91%,transparent);backdrop-filter:blur(12px);border-bottom:1px solid var(--border);font-size:12px;color:var(--muted)}.status-dot{display:inline-block;width:6px;height:6px;background:var(--subtle);border-radius:50%;margin-right:8px}.status-dot.live{background:var(--accent-strong);animation:pulse 1.2s var(--ease) infinite alternate}.calls{font:500 11px var(--mono)}.calls strong{color:var(--text)}.notice{position:sticky;top:106px;z-index:3;margin:10px 18px 0;padding:11px 14px;border:1px solid var(--border-strong);background:var(--surface-2);display:flex;justify-content:space-between;color:var(--muted)}.notice.error{border-color:color-mix(in srgb,var(--danger) 55%,var(--border));color:var(--danger)}.notice button{border:0;background:transparent;color:inherit}.welcome,.running,.failed{max-width:920px;min-height:calc(100dvh - 48px);padding:clamp(70px,12vh,140px) var(--page-inline);display:flex;flex-direction:column;align-items:flex-start}.welcome h1,.running h1,.failed h1{font-size:clamp(38px,6vw,70px);letter-spacing:-.055em;line-height:.98;max-width:850px;margin:12px 0 22px}.welcome>p:not(.eyebrow),.failed>p:not(.eyebrow){color:var(--muted);max-width:610px;font-size:16px}.eyebrow{font:600 11px var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--accent-strong)}.welcome button{margin-top:26px;border:1px solid var(--accent);background:var(--accent-strong);color:var(--accent-ink);padding:12px 17px;border-radius:8px;font-weight:700}.activity{margin-top:40px;border-top:1px solid var(--border);width:min(720px,100%);padding:20px 0;display:flex;gap:12px;color:var(--muted)}.activity span{width:8px;height:8px;margin-top:6px;background:var(--accent-strong);border-radius:50%;animation:pulse 1.2s var(--ease) infinite alternate}.run-actions{margin-top:auto;display:flex;gap:9px}.run-actions button{border:1px solid var(--border-strong);background:transparent;color:var(--text);padding:10px 14px;border-radius:8px}.run-actions .cancel{color:var(--danger)}.skeleton{padding:90px var(--page-inline);display:grid;gap:18px}.skeleton i{display:block;height:24px;max-width:720px;background:linear-gradient(90deg,var(--surface),var(--surface-2),var(--surface));background-size:200% 100%;animation:shimmer 1.2s infinite}.skeleton i:first-child{height:58px;width:60%}.skeleton i:last-child{width:40%}@keyframes shimmer{to{background-position:-200% 0}}@keyframes pulse{to{opacity:.3;transform:scale(.8)}}@media(max-width:720px){.app-shell{grid-template-columns:1fr}.app-shell :global(.sidebar){display:none}.main-content{border-left:0}.topbar{padding:0 14px}.calls{display:none}.welcome,.running,.failed{padding:70px 20px}.welcome h1,.running h1,.failed h1{font-size:42px}}
  .research-export-hint{max-width:650px;margin:0;color:var(--muted)}.run-stopped{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px;margin:14px var(--page-inline) 0;padding:14px 16px;border:1px solid color-mix(in srgb,var(--danger) 45%,var(--border));border-radius:8px;background:color-mix(in srgb,var(--danger) 7%,var(--surface))}.run-stopped>div:first-child{display:grid;gap:4px}.run-stopped strong{font-size:13px}.run-stopped span{color:var(--muted);font-size:12px}.run-stopped-actions{display:flex;flex-wrap:wrap;gap:8px}.run-stopped-actions button{border:1px solid var(--border-strong);border-radius:8px;background:transparent;color:var(--text);padding:9px 13px;font-weight:650}.run-stopped-actions .cancel{color:var(--danger)}
</style>
