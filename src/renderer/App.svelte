<script lang="ts">
  import { onMount } from "svelte";
  import type { ResearchEvent, WorkspaceState } from "../shared/ipc";
  import Sidebar from "./components/Sidebar.svelte";
  import ScopeForm from "./components/ScopeForm.svelte";
  import ProblemCheckpoint from "./components/ProblemCheckpoint.svelte";
  import SolutionWorkspace from "./components/SolutionWorkspace.svelte";

  let workspace = $state<WorkspaceState | null>(null);
  let loading = $state(true);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let deletingThreadId = $state<string | null>(null);
  let latestEvent = $state<ResearchEvent | null>(null);
  let reviewSelection = $state(false);
  let editingScopeThreadId = $state<string | null>(null);
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  let activeThread = $derived(workspace?.threads.find((item) => item.id === workspace?.activeThreadId) ?? null);
  let activeRun = $derived(workspace?.latestResearchRun ?? null);
  // Local-only override: lets the user reopen the scope form from a failed run without touching server state.
  let editingScope = $derived(editingScopeThreadId !== null && editingScopeThreadId === activeThread?.id);

  onMount(() => {
    void load();
    const dispose = window.scraply.onBackendEvent((event) => {
      latestEvent = event;
      if (event.threadId === workspace?.activeThreadId) reconcileSoon();
    });
    return () => { dispose(); if (reconcileTimer) clearTimeout(reconcileTimer); };
  });

  async function load() {
    try { workspace = await window.scraply.getWorkspace(); error = null; }
    catch (cause) { error = message(cause); }
    finally { loading = false; }
  }
  function reconcileSoon() {
    if (reconcileTimer) clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(() => { reconcileTimer = null; void load(); }, 180);
  }
  async function action(work: () => Promise<void>) {
    busy = true; error = null;
    try { await work(); }
    catch (cause) { error = message(cause); }
    finally { busy = false; }
  }
  async function createThread() { await action(async () => { const result = await window.scraply.createThread(); workspace = result.workspace; }); }
  async function selectThread(id: string) { await action(async () => { workspace = await window.scraply.selectThread(id); latestEvent = null; reviewSelection = false; }); }
  async function deleteThread(id: string) {
    deletingThreadId = id;
    try { workspace = await window.scraply.deleteThread(id); }
    catch (cause) { error = message(cause); }
    finally { deletingThreadId = null; }
  }
  async function saveScope(scope: NonNullable<WorkspaceState["scope"]>, config: NonNullable<WorkspaceState["runConfig"]>) {
    if (!workspace?.activeThreadId) return;
    busy = true; error = null;
    try {
      workspace = await window.scraply.saveScope({ threadId: workspace!.activeThreadId!, scope });
      workspace = await window.scraply.saveRunConfig({ threadId: workspace!.activeThreadId!, config });
      editingScopeThreadId = null;
    } catch (cause) {
      error = message(cause);
      throw cause;
    } finally {
      busy = false;
    }
  }
  async function startResearch() {
    if (!workspace?.activeThreadId) return;
    await action(async () => { const result = await window.scraply.startResearch(workspace!.activeThreadId!); workspace = result.workspace; editingScopeThreadId = null; });
  }
  async function retryConnections() {
    await action(async () => {
      await window.scraply.retryConnection();
      workspace = await window.scraply.getWorkspace();
    });
  }
  async function selectProblems(ids: string[], userProblem: string | null) {
    if (!workspace?.activeThreadId) return;
    await action(async () => { workspace = await window.scraply.selectProblems({ threadId: workspace!.activeThreadId!, problemIds: ids, userProblem }); reviewSelection = false; });
  }
  async function exportIdeas(format: "markdown" | "json") {
    if (!workspace?.activeThreadId) return;
    await action(async () => {
      const result = await window.scraply.exportIdeas(workspace!.activeThreadId!, format) as { cancelled: boolean; directory?: string; files: string[] };
      if (!result.cancelled) error = `${result.files.length} ${format === "markdown" ? "Markdown" : "JSON"} file${result.files.length === 1 ? "" : "s"} exported to ${result.directory}.`;
    });
  }
  function message(value: unknown) { return value instanceof Error ? value.message : "Something went wrong."; }
</script>

<div class="app-shell">
  <Sidebar
    threads={workspace?.threads ?? []}
    activeThreadId={workspace?.activeThreadId ?? null}
    {deletingThreadId}
    onNew={createThread}
    onSelect={selectThread}
    onDelete={deleteThread}
    onOpenGuide={() => { error = "Workflow: define scope → run discovery → choose problems → read solutions and risks."; }}
    onOpenData={() => window.scraply.openDataFolder()}
    onOpenLogs={() => window.scraply.openLogsFolder()}
  />

  <main class="main-content">
    {#if workspace && activeThread}
      <div class="topbar">
        <div><span class="status-dot" class:live={activeThread.status.endsWith("running")}></span>{activeThread.title}</div>
        {#if activeRun}<div class="calls"><strong>{activeRun.codexCalls}</strong> Codex calls / ~{activeRun.projectedCodexCalls} · <strong>{activeRun.exaSearches}</strong> Exa searches / ~{activeRun.projectedExaSearches}</div>{/if}
      </div>
    {/if}

    {#if error}<div class="notice" role="status">{error}<button aria-label="Dismiss" onclick={() => error = null}>×</button></div>{/if}

    {#if loading}
      <div class="skeleton" aria-label="Loading workspace"><i></i><i></i><i></i></div>
    {:else if !workspace || !activeThread}
      <section class="welcome"><p class="eyebrow">Local-first research</p><h1>Find problems worth solving before generating solutions.</h1><p>Start with a domain and an audience. Scraply will gather evidence, try to kill each candidate, and stop for your judgment.</p><button onclick={createThread}>Create research</button></section>
    {:else if activeThread.status === "problems-ready" || reviewSelection}
      {#key workspace.activeThreadId}
        <ProblemCheckpoint problems={workspace.problemCandidates} {busy} onCommit={selectProblems} />
      {/key}
    {:else if activeThread.status === "solutions-ready"}
      <SolutionWorkspace solutions={workspace.solutions} {busy} onExport={exportIdeas} onReview={() => reviewSelection = true} />
    {:else if activeThread.status === "discovery-running" || activeThread.status === "development-running"}
      <section class="running">
        <p class="eyebrow">{activeThread.status === "discovery-running" ? "Discovery in progress" : "Development in progress"}</p>
        <h1>{activeThread.status === "discovery-running" ? "Reading the field before naming the problem." : "Building the selected chain one problem at a time."}</h1>
        <div class="activity"><span></span><p>{latestEvent?.type === "run-progress" ? latestEvent.message : activeRun?.lastActivity ?? "Preparing the next provider call…"}</p></div>
        {#if activeRun}<div class="run-actions"><button disabled={busy} onclick={() => action(async () => { workspace = await window.scraply.resumeResearch(activeRun!.runId); })}>Resume attempt</button><button class="cancel" disabled={busy} onclick={() => action(async () => { workspace = await window.scraply.cancelResearch(activeRun!.runId); })}>Cancel run</button></div>{/if}
      </section>
    {:else if activeThread.status === "failed" && !editingScope}
      <section class="failed"><p class="eyebrow">Run stopped</p><h1>The queue needs your attention.</h1><p>{activeRun?.lastActivity ?? "The last run failed or was cancelled. Review the scope, then retry explicitly."}</p>{#if activeRun && ["queued","running"].includes(activeRun.status)}<button onclick={() => action(async () => { workspace = await window.scraply.resumeResearch(activeRun!.runId); })}>Resume attempt</button>{/if}{#if workspace.problemCandidates.length > 0}<button class="secondary" onclick={() => reviewSelection = true}>Review problem selection</button>{/if}<button class="secondary" onclick={() => { editingScopeThreadId = activeThread?.id ?? null; }}>Edit scope</button></section>
    {:else}
      {#key workspace.activeThreadId}
        <ScopeForm {workspace} {busy} onSave={saveScope} onStart={startResearch} onRetry={retryConnections} />
      {/key}
    {/if}
  </main>
</div>

<style>
  .app-shell{height:100%;display:grid;grid-template-columns:250px minmax(0,1fr);background:var(--bg)}.main-content{min-width:0;overflow:auto;position:relative;border-left:1px solid var(--border)}.topbar{position:sticky;top:0;z-index:2;height:48px;padding:0 20px;display:flex;align-items:center;justify-content:space-between;background:color-mix(in srgb,var(--bg) 91%,transparent);backdrop-filter:blur(12px);border-bottom:1px solid var(--border);font-size:12px;color:var(--muted)}.status-dot{display:inline-block;width:6px;height:6px;background:var(--subtle);border-radius:50%;margin-right:8px}.status-dot.live{background:var(--accent-strong);animation:pulse 1.2s var(--ease) infinite alternate}.calls{font:500 11px var(--mono)}.calls strong{color:var(--text)}.notice{position:sticky;top:58px;z-index:3;margin:10px 18px 0;padding:11px 14px;border:1px solid var(--border-strong);background:var(--surface-2);display:flex;justify-content:space-between;color:var(--muted)}.notice button{border:0;background:transparent;color:var(--muted)}.welcome,.running,.failed{max-width:920px;min-height:calc(100dvh - 48px);padding:clamp(70px,12vh,140px) var(--page-inline);display:flex;flex-direction:column;align-items:flex-start}.welcome h1,.running h1,.failed h1{font-size:clamp(38px,6vw,70px);letter-spacing:-.055em;line-height:.98;max-width:850px;margin:12px 0 22px}.welcome>p:not(.eyebrow),.failed>p:not(.eyebrow){color:var(--muted);max-width:610px;font-size:16px}.eyebrow{font:600 11px var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--accent-strong)}.welcome button,.failed button{margin-top:26px;border:1px solid var(--accent);background:var(--accent-strong);color:var(--accent-ink);padding:12px 17px;border-radius:8px;font-weight:700}.failed .secondary{margin-left:8px;background:transparent;color:var(--text);border-color:var(--border-strong)}.activity{margin-top:40px;border-top:1px solid var(--border);width:min(720px,100%);padding:20px 0;display:flex;gap:12px;color:var(--muted)}.activity span{width:8px;height:8px;margin-top:6px;background:var(--accent-strong);border-radius:50%;animation:pulse 1.2s var(--ease) infinite alternate}.run-actions{margin-top:auto;display:flex;gap:9px}.run-actions button{border:1px solid var(--border-strong);background:transparent;color:var(--text);padding:10px 14px;border-radius:8px}.run-actions .cancel{color:var(--danger)}.skeleton{padding:90px var(--page-inline);display:grid;gap:18px}.skeleton i{display:block;height:24px;max-width:720px;background:linear-gradient(90deg,var(--surface),var(--surface-2),var(--surface));background-size:200% 100%;animation:shimmer 1.2s infinite}.skeleton i:first-child{height:58px;width:60%}.skeleton i:last-child{width:40%}@keyframes shimmer{to{background-position:-200% 0}}@keyframes pulse{to{opacity:.3;transform:scale(.8)}}@media(max-width:720px){.app-shell{grid-template-columns:1fr}.app-shell :global(.sidebar){display:none}.main-content{border-left:0}.topbar{padding:0 14px}.calls{display:none}.welcome,.running,.failed{padding:70px 20px}.welcome h1,.running h1,.failed h1{font-size:42px}}
</style>
