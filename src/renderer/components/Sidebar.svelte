<script lang="ts">
  import { tick, type Snippet } from "svelte";
  import Icon from "./Icon.svelte";
  import type { Thread } from "../../shared/schemas";
  import { statusLabel, statusTone } from "../lib/status";
  import BrandMark from "./BrandMark.svelte";

  let {
    threads,
    activeThreadId,
    busy,
    deletingThreadId = null,
    onNew,
    onSelect,
    onArchive,
    settingsControl,
  }: {
    threads: Thread[];
    activeThreadId: string | null;
    busy: boolean;
    deletingThreadId?: string | null;
    onNew: () => void;
    onSelect: (id: string) => void;
    onArchive: (id: string) => void;
    settingsControl: Snippet;
  } = $props();

  let search = $state("");
  let finder: HTMLDialogElement;
  let searchInput: HTMLInputElement;
  let searchTrigger: HTMLButtonElement;
  let matches = $derived(threads.filter((thread) => thread.title.toLowerCase().includes(search.trim().toLowerCase())));
  async function showFinder() {
    if (document.querySelector("dialog[open], .settings-screen:not([hidden])")) return;
    search = "";
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
    if (event.key === "Enter" && matches[0]) { event.preventDefault(); openResult(matches[0].id); }
    if (event.key === "ArrowDown") { event.preventDefault(); finder.querySelector<HTMLButtonElement>(".search-result")?.focus(); }
  }
</script>

<svelte:window onkeydown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); void showFinder(); } }} />
<aside class="sidebar">
  <div class="brand"><div class="brand-symbol"><BrandMark size={36} /></div><span>Scraply</span></div>
  <button class="new" aria-label="Create new research thread" disabled={busy} onclick={onNew}><Icon name="plus" size={17} />New research</button>
  <button bind:this={searchTrigger} class="find" onclick={showFinder}><Icon name="search" size={16} /><span>Find research</span><kbd>Ctrl K</kbd></button>
  <div class="list-head"><span>Your research</span><span>{threads.length}</span></div>
  <div class="list" role="list" aria-label="Research threads">
    {#each threads as thread (thread.id)}
      <div class="thread-row" class:active={thread.id === activeThreadId} role="listitem">
        <button
          class="thread"
          aria-current={thread.id === activeThreadId ? "true" : undefined}
          aria-label={`Open thread ${thread.title}`}
          disabled={busy}
          onclick={() => onSelect(thread.id)}
        >
          <span class="title"><span>{thread.title}</span></span>
          <span class="meta" data-tone={statusTone(thread.status)}>
            <Icon name={thread.status === "failed" ? "alert" : thread.status.endsWith("running") ? "progress" : thread.status === "configuring" ? "brief" : "check"} size={11} />{statusLabel(thread.status)}
          </span>
        </button>
        <button
          class="delete"
          class:busy={deletingThreadId === thread.id}
          title="Archive research"
          aria-label={`Archive research ${thread.title}`}
          disabled={busy || deletingThreadId !== null}
          onclick={() => onArchive(thread.id)}
        >
          {#if deletingThreadId === thread.id}
            <span class="spinner" aria-hidden="true"></span>
          {:else}
            <Icon name="archive" size={16} />
          {/if}
        </button>
      </div>
    {:else}
      <p class="empty">No threads yet</p>
    {/each}
  </div>
  <div class="footer">{@render settingsControl()}</div>
</aside>

<dialog bind:this={finder} class="finder" aria-label="Find research" onclose={() => searchTrigger.focus()}>
  <div class="search-heading"><Icon name="search" size={20} /><input bind:this={searchInput} bind:value={search} aria-label="Search research" placeholder="Find a research project..." onkeydown={searchKeys} /><button aria-label="Close search" onclick={() => finder.close()}><kbd>Esc</kbd></button></div>
  <div class="search-results">
    <p>{search ? `${matches.length} results` : "Your research"}</p>
    {#each matches as thread (thread.id)}
      <button class="search-result" disabled={busy} onclick={() => openResult(thread.id)}><Icon name="research" /><span><strong>{thread.title}</strong><small>{statusLabel(thread.status)}</small></span><Icon name="arrow" size={15} /></button>
    {:else}<div class="no-results">No research found.{#if search} Try a different name.{/if}</div>{/each}
  </div>
  <footer><span>Type to search</span><span>Enter to open</span><span>Tab to navigate</span></footer>
</dialog>
<style>
  .sidebar { display:grid;grid-template-rows:auto auto auto auto minmax(0,1fr) auto;gap:5px;padding:6px 12px 8px;background:#000;min-height:0; }
  .brand { display:flex;align-items:center;gap:10px;padding:4px 8px 16px;font-size:26px;font-weight:700;letter-spacing:-.04em; }
  .brand-symbol { color:var(--accent-strong); }
  .new,.find { width:100%;display:flex;align-items:center;gap:10px;border:0;border-radius:7px;padding:8px 12px;min-height:36px;font-size:13px;font-weight:500;transition:background 180ms ease,color 180ms ease; }
  .new { border:1px solid #71cfba28;background:#71cfba0c;color:var(--accent-strong); }
  .new:hover:not(:disabled) { background:#71cfba18;border-color:#71cfba55; }
  .find { border:0;background:transparent;color:var(--muted); }
  .find:hover { background:var(--surface-2);color:var(--text); }
  .find kbd { margin-left:auto;border:0;background:transparent;padding:0;font-size:13px;color:#727b75; }
  .new :global(svg),.find :global(svg) { flex:none;width:16px;height:16px;color:#b2bbb5; }
  kbd { padding:2px 4px;border:1px solid var(--border);border-radius:4px;font:10px var(--sans);color:var(--subtle);white-space:nowrap; }
  .list-head { display:flex;justify-content:space-between;padding:12px 12px 6px;color:var(--subtle);font-size:13px;font-weight:550; }
  .list { min-height:0;overflow-y:auto;overflow-x:hidden;display:grid;gap:4px;align-content:start;padding:0 4px 12px 0;scroll-padding-block:8px;scrollbar-gutter:stable; }
  .thread-row { position:relative;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;border:1px solid transparent;border-radius:10px; }
  .thread-row:hover { background:#ffffff04; }
  .thread-row.active { background:var(--surface-2);border-color:#ffffff06; }
  .thread { text-align:left;border:0;background:transparent;color:var(--muted);padding:13px 10px;display:grid;gap:7px;min-width:0;border-radius:9px; }
  .active .thread { color:var(--text); }
  .title { display:flex;align-items:center;gap:8px;min-width:0;font-size:13px;font-weight:500; }
  .title :global(svg) { flex:none;color:var(--subtle); }
  .title > span { overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
  .meta { display:flex;align-items:center;gap:6px;padding-left:22px;color:var(--subtle);font-size:13px; }
  .delete { border:0;background:transparent;color:var(--muted);display:grid;width:26px;height:30px;place-items:center;padding:0;margin-right:4px;border-radius:6px;opacity:0; }
  .thread-row:hover .delete,.thread-row:focus-within .delete,.delete.busy { opacity:1; }
  .delete:hover { color:var(--danger);background:#df929215; }
  .spinner { width:12px;height:12px;border:1.5px solid var(--border);border-top-color:var(--muted);border-radius:50%;animation:spin 700ms linear infinite; }
  .empty { color:var(--subtle);padding:10px 12px;font-size:13px; }
  .footer { padding:8px 0 0;border-top:1px solid var(--border); }
  .finder { width:min(580px,calc(100vw - 40px));max-height:70vh;margin:14vh auto auto;padding:0;border:1px solid var(--border-strong);border-radius:18px;background:var(--bg);color:var(--text);box-shadow:0 28px 100px #000a; }
  .finder[open] { animation:search-open 200ms var(--ease); }
  .finder::backdrop { background:#0008;backdrop-filter:blur(5px); }
  .search-heading { display:flex;align-items:center;gap:14px;padding:22px;border-bottom:1px solid var(--border);color:var(--muted); }
  .search-heading input { flex:1;min-width:0;border:0;background:transparent;box-shadow:none;color:var(--text);outline:none;font-size:15px; }
  .search-heading button { border:0;background:transparent; }
  .search-results { max-height:45vh;overflow:auto;padding:10px; }
  .search-results > p { padding:0 12px;font-size:13px;color:var(--subtle); }
  .search-result { width:100%;display:flex;align-items:center;gap:14px;border:0;border-radius:10px;background:transparent;padding:14px 12px;text-align:left;color:var(--text); }
  .search-result:hover,.search-result:focus-visible { background:var(--surface-2); }
  .search-result > span { flex:1;display:grid;gap:5px;min-width:0; }
  .search-result strong { font-size:13px;font-weight:550;overflow-wrap:anywhere; }
  .search-result small { color:var(--subtle);font-size:13px; }
  .search-result :global(svg) { flex:none;color:var(--muted); }
  .no-results { padding:28px 12px;color:var(--muted);font-size:13px; }
  .finder footer { display:flex;gap:20px;padding:14px 22px;border-top:1px solid var(--border);color:var(--subtle);font-size:13px; }
  @keyframes search-open { from { opacity:0;transform:scale(.97) translateY(-8px); }to { opacity:1;transform:none; } }
  @keyframes spin { to { transform:rotate(360deg); } }
  @keyframes pulse { to { opacity:.3; } }
  @media(max-width:720px) { .sidebar { padding-inline:10px; }.find kbd { display:none; }.brand { padding-inline:6px;font-size:16px; } }

  .thread .meta { display:inline-flex;align-items:center;gap:5px;width:fit-content;margin:9px 0 0;padding:3px 7px;border:1px solid #3a403d;border-radius:5px;color:#c0c7c3;font-size:13px;line-height:1.2;background:#181b19; }
  .thread .meta[data-tone="done"] { color:#59ffc0;border-color:#21744f;background:#0c3021; }
  .thread .meta[data-tone="active"] { color:#80d5ff;border-color:#286383;background:#0d2939; }
  .thread .meta[data-tone="attention"] { color:#ffc977;border-color:#805725;background:#32220e; }
  .thread-row.active { background:#102a1e;border-color:#2b8b5c; }
  .thread .title { font-size:13px;font-weight:550;line-height:1.4; }
  .delete:hover:not(:disabled) { color:var(--text);background:var(--surface-2); }
  .thread-row { border-color:transparent;border-radius:7px;transition:background 220ms ease,border-color 220ms ease; }
  .thread-row:hover { background:#151817; }
  .thread-row.active { background:#1b211e;border-color:#303a34; }
  .thread-row.active:hover { background:#222a25; }
  .thread { padding:10px 12px;gap:0; }
  .thread .title { font-size:13px;line-height:1.3;font-weight:500; }
  .thread .meta { margin-top:5px;padding:0;border:0;background:transparent;font-size:13px;gap:5px; }
  .thread .meta[data-tone="done"] { background:transparent;border:0;color:#87b99c; }
  .thread .meta[data-tone="attention"] { background:transparent;border:0;color:#c8ad83; }
  .thread .meta[data-tone="active"] { background:transparent;border:0;color:#91b3c5; }
  .list { gap:2px; }
  .list::-webkit-scrollbar { width:5px; }.list::-webkit-scrollbar-button { display:none;height:0; }.list::-webkit-scrollbar-thumb { border:0;border-radius:6px;background:#343b37; }
  .new { color:var(--text);background:#141815;border:0; }.new:hover:not(:disabled),.find:hover { background:#202622;border-color:transparent; }
</style>
