<script lang="ts">
  import { tick, type Snippet } from "svelte";
  import Icon, { type IconName } from "./Icon.svelte";
  import type { Thread } from "../../shared/schemas";
  import { isArchived, needsAttention, statusLabel, statusTone } from "../lib/status";

  // `collapsed` renders the icon rail: labels stay in the accessibility tree but are visually hidden,
  // and row titles move into tooltips.
  let { threads, activeThreadId, busy, collapsed = false, deletingThreadId = null, onNew, onSelect, onArchive, onRestore, settingsControl }: {
    threads: Thread[]; activeThreadId: string | null; busy: boolean; collapsed?: boolean; deletingThreadId?: string | null;
    onNew: () => void; onSelect: (id: string) => void; onArchive: (id: string) => void; onRestore: (id: string) => void;
    settingsControl: Snippet;
  } = $props();

  type CollectionFilter = "all" | "attention" | "archived";
  let search = $state("");
  let filter = $state<CollectionFilter>("all");
  let finder: HTMLDialogElement;
  let searchInput: HTMLInputElement;
  let searchTrigger: HTMLButtonElement;
  let returnFocus: HTMLElement | null = null;
  let activeThreads = $derived(threads.filter((thread) => !isArchived(thread)));
  let archivedThreads = $derived(threads.filter(isArchived));
  let attentionThreads = $derived(activeThreads.filter((thread) => needsAttention(thread.status)));
  let recentThreads = $derived.by(() => {
    const recent = [...activeThreads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const current = recent.find((thread) => thread.id === activeThreadId);
    return (current ? [current, ...recent.filter((thread) => thread.id !== current.id)] : recent).slice(0, 6);
  });
  let matches = $derived((filter === "archived" ? archivedThreads : filter === "attention" ? attentionThreads : activeThreads)
    .filter((thread) => thread.title.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));

  async function showFinder(nextFilter: CollectionFilter = "all") {
    if (document.querySelector("dialog[open], .settings-screen:not([hidden])")) return;
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    search = "";
    filter = nextFilter;
    finder.showModal();
    await tick();
    searchInput.focus();
  }
  function openResult(id: string) {
    if (busy) return;
    finder.close();
    onSelect(id);
  }
  function searchKeys(event: KeyboardEvent) {
    if (event.key === "Enter" && matches[0] && filter !== "archived") { event.preventDefault(); openResult(matches[0].id); }
    if (event.key === "ArrowDown") { event.preventDefault(); finder.querySelector<HTMLButtonElement>(".search-result, .restore")?.focus(); }
  }
  function threadIcon(thread: Thread): IconName {
    if (thread.status === "failed") return "alert";
    if (thread.status.endsWith("running")) return "progress";
    if (thread.status === "problems-ready") return "research";
    if (thread.status === "solutions-ready") return "ideas";
    return "brief";
  }
</script>

<svelte:window onkeydown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); void showFinder(); } }} />
<aside class="sidebar" class:collapsed aria-label="Research navigation">
  <button class="new" aria-label="Create new research thread" title={collapsed ? "New research" : undefined} disabled={busy} onclick={onNew}><Icon name="plus" size={18} /><span class="label">New research</span></button>
  <button bind:this={searchTrigger} class="find" aria-label="All research" title={collapsed ? "All research (Ctrl+K)" : undefined} onclick={() => showFinder()}><Icon name="search" size={18} /><span class="label">All research</span><kbd aria-hidden="true">Ctrl K</kbd></button>
  <div class="recent">
    <div class="list-head"><span class="label">Recent research</span></div>
    <div class="list" role="list" aria-label="Research threads">
      {#each recentThreads as thread (thread.id)}
        <div class="thread-row" class:active={thread.id === activeThreadId} role="listitem">
          <button class="thread" aria-current={thread.id === activeThreadId ? "true" : undefined} aria-label={`Open thread ${thread.title}`} aria-describedby={`thread-status-${thread.id}`} title={`${thread.title} · ${statusLabel(thread.status)}`} disabled={busy} onclick={() => onSelect(thread.id)}>
            <span class="status-icon" data-tone={statusTone(thread.status)} aria-hidden="true"><Icon name={threadIcon(thread)} size={16} /></span>
            <span class="title label">{thread.title}</span><span class="sr-only" id={`thread-status-${thread.id}`}>{statusLabel(thread.status)}</span>
          </button>
          <button class="archive" title="Archive research" aria-label={`Archive research ${thread.title}`} disabled={busy || deletingThreadId !== null} onclick={() => onArchive(thread.id)}><Icon name={deletingThreadId === thread.id ? "progress" : "archive"} size={15} /></button>
        </div>
      {:else}<p class="empty">No research yet.</p>{/each}
    </div>
    {#if attentionThreads.length}<button class="attention-link" aria-label={`Running & attention ${attentionThreads.length}`} title={collapsed ? "Running & attention" : undefined} onclick={() => showFinder("attention")}><Icon name="progress" size={16} /><span class="label">Running & attention</span><span class="count">{attentionThreads.length}</span></button>{/if}
  </div>
  <div class="footer">{@render settingsControl()}</div>
</aside>

<dialog bind:this={finder} class="finder glass-dense" aria-label="All research" onclose={() => (returnFocus?.isConnected ? returnFocus : searchTrigger)?.focus({ preventScroll: true })}>
  <header><h2>All research</h2><button aria-label="Close search" onclick={() => finder.close()}><Icon name="close" /></button></header>
  <div class="search-heading"><Icon name="search" size={18} /><input bind:this={searchInput} bind:value={search} aria-label="Search research" placeholder="Search research by name" onkeydown={searchKeys} /></div>
  <nav aria-label="Research filters">
    <button aria-pressed={filter === "all"} onclick={() => filter = "all"}>All</button>
    <button aria-pressed={filter === "attention"} onclick={() => filter = "attention"}>Running & attention</button>
    <button aria-pressed={filter === "archived"} onclick={() => filter = "archived"}>Archived</button>
  </nav>
  <div class="search-results">
    <p>{matches.length} {matches.length === 1 ? "result" : "results"}</p>
    {#each matches as thread (thread.id)}
      <div class="result-row">
        {#if filter === "archived"}
          <div class="archived-result"><strong>{thread.title}</strong><small>Archived · {statusLabel(thread.status)}</small></div>
          <button class="restore" disabled={busy} aria-label={`Restore ${thread.title}`} onclick={() => onRestore(thread.id)}>Restore</button>
        {:else}
          <button class="search-result" disabled={busy} onclick={() => openResult(thread.id)}><Icon name={threadIcon(thread)} /><span><strong>{thread.title}</strong><small>{statusLabel(thread.status)}</small></span></button>
          <button class="archive" disabled={busy || deletingThreadId !== null} aria-label={`Archive research ${thread.title}`} onclick={() => onArchive(thread.id)}><Icon name="archive" size={16} /></button>
        {/if}
      </div>
    {:else}<div class="no-results">{filter === "archived" ? "No archived research found." : filter === "attention" ? "Nothing running or needing attention." : "No research found."}{#if search} Try a different name.{/if}</div>{/each}
  </div>
  <footer><span>Enter to open</span><span>Esc to close</span></footer>
</dialog>

<style>
  /* Docked navigation has no panel of its own: it is part of the window chrome, flush with the left edge.
     The 8px inset puts the row icons under the brand mark in the title bar. */
  .sidebar { display:flex;flex-direction:column;gap:6px;padding:12px 0 8px 8px;min-height:0;overflow:auto;scroll-padding-block:12px; }
  .sidebar > * { flex-shrink:0; }
  button { color:var(--text);font-size:14px; }
  .new,.find,.attention-link { width:100%;display:flex;align-items:center;gap:10px;border:0;border-radius:7px;padding:10px;min-height:42px;font-weight:500;text-align:left; }
  .new { background:rgb(255 255 255 / .07);color:var(--text); }
  .find,.attention-link { background:none;color:var(--muted); }
  .find kbd,.attention-link .count { margin-left:auto;font:12px var(--sans);color:var(--muted); }
  .new:hover:not(:disabled),.find:hover,.attention-link:hover { background:var(--surface-2);color:var(--text); }
  .new :global(svg),.find :global(svg),.attention-link :global(svg) { flex:none; }
  .recent { padding-top:14px; }
  .list-head { padding:6px 10px 10px;color:var(--subtle);font-size:13px; }
  .list { display:grid;gap:3px; }
  .thread-row { display:grid;grid-template-columns:minmax(0,1fr) 32px;align-items:start;border-radius:7px; }
  .thread-row:hover { background:#ffffff07; }
  .thread-row.active { background:var(--surface-2); }
  .thread { display:flex;align-items:center;gap:9px;min-height:40px;padding:10px 4px 10px 10px;min-width:0;text-align:left;border:0;border-radius:7px;background:none;color:var(--muted); }
  .active .thread { color:var(--text); }
  .title { min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.45; }
  .status-icon { flex:none;display:flex;color:var(--muted); }
  .status-icon[data-tone="attention"] { color:#e9bd7a; }.status-icon[data-tone="active"] { color:var(--accent); }
  .archive { display:grid;place-items:center;width:32px;min-height:40px;padding:0;border:0;border-radius:6px;background:none;color:var(--subtle); }
  .archive:hover:not(:disabled) { color:var(--text);background:var(--surface-2); }
  .attention-link { margin-top:12px;font-size:13px; }
  .footer { margin-top:auto;padding-top:18px; }
  .empty { margin:0;padding:10px;color:var(--muted);font-size:14px; }
  /* Icon rail: rows keep their expanded height so icons stay where they were in the list. */
  .collapsed { padding-inline:8px; }
  .collapsed .new,.collapsed .find,.collapsed .attention-link,.collapsed .thread { justify-content:center;padding-inline:0;gap:0; }
  .collapsed .footer :global(button) { justify-content:center;padding-inline:0;gap:0; }
  .collapsed .label,.collapsed kbd,.collapsed .footer :global(.label) { position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap; }
  .collapsed .thread-row { grid-template-columns:minmax(0,1fr); }
  .collapsed .archive { display:none; }
  .collapsed .recent { padding-top:8px; }
  .collapsed .list-head { height:1px;margin:0 6px 10px;padding:0;background:var(--border); }
  .collapsed .attention-link { position:relative; }
  .collapsed .attention-link .count { position:absolute;top:3px;right:3px;min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:var(--surface-2);color:var(--text);font-size:10px;line-height:16px;text-align:center; }
  .sr-only { position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap; }
  .finder { width:min(680px,calc(100vw - 32px));max-height:calc(100dvh - 48px);padding:0;margin:auto;border-radius:16px;color:var(--text); }
  .finder[open] { display:flex;flex-direction:column; }
  .finder header { display:flex;align-items:center;justify-content:space-between;padding:20px 24px 12px; }
  h2 { margin:0;font-size:22px; }
  .finder header button { display:grid;place-items:center;width:40px;height:40px;border:0;background:none;color:var(--muted);border-radius:7px; }
  .search-heading { display:flex;align-items:center;gap:12px;margin:0 24px 16px;padding:0 12px;border:1px solid var(--border-strong);border-radius:7px;background:var(--surface);color:var(--muted); }
  .search-heading input { flex:1;min-width:0;min-height:44px;border:0;background:none;color:var(--text);font-size:15px;outline:none;box-shadow:none; }
  /* Focus rings the whole field (icon included), not just the text box inside it. */
  .search-heading:focus-within { border-color:rgb(255 255 255 / .38);box-shadow:0 0 0 3px rgb(255 255 255 / .05); }
  .finder nav { display:flex;flex-wrap:wrap;gap:4px;padding:0 24px 12px;border-bottom:1px solid var(--border); }
  .finder nav button { min-height:36px;padding:6px 12px;border:0;border-radius:6px;background:none;color:var(--muted);font-size:13px; }
  .finder nav button[aria-pressed="true"] { background:rgb(255 255 255 / .09);color:var(--text); }
  .search-results { min-height:0;overflow:auto;padding:12px 16px; }
  .search-results > p { margin:0;padding:0 8px 10px;font-size:13px;color:var(--muted); }
  .result-row { display:flex;align-items:center;gap:8px;border-radius:8px; }
  .result-row:hover { background:var(--surface); }
  .search-result { flex:1;min-width:0;display:flex;align-items:center;gap:12px;padding:12px 8px;border:0;border-radius:7px;background:none;text-align:left; }
  .search-result > span,.archived-result { display:grid;gap:5px;min-width:0; }
  .search-result :global(svg) { flex:none;color:var(--muted); }
  .search-result strong,.archived-result strong { font-size:14px;font-weight:500;overflow-wrap:anywhere; }
  .search-result small,.archived-result small { color:var(--muted);font-size:13px; }
  .archived-result { flex:1;padding:12px 8px; }
  .restore { min-height:40px;padding:8px 12px;border:1px solid var(--border-strong);border-radius:7px;background:var(--surface); }
  .no-results { padding:24px 8px;color:var(--muted);font-size:14px; }
  .finder footer { display:flex;gap:20px;padding:14px 24px;border-top:1px solid var(--border);color:var(--muted);font-size:13px; }
  @media(max-width:420px) { .finder header { padding:12px 16px; }.search-heading { margin-inline:16px; }.finder nav { padding-inline:12px; } }
</style>
