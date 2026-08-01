<script lang="ts">
  import type { Thread } from "../../shared/schemas";
  import { statusLabel, statusTone } from "../lib/status";
  import BrandMark from "./BrandMark.svelte";

  let {
    threads,
    activeThreadId,
    deletingThreadId = null,
    onNew,
    onSelect,
    onDelete,
    onOpenGuide,
    onOpenData,
    onOpenLogs,
  }: {
    threads: Thread[];
    activeThreadId: string | null;
    deletingThreadId?: string | null;
    onNew: () => void;
    onSelect: (id: string) => void;
    onDelete: (id: string) => void;
    onOpenGuide: () => void;
    onOpenData: () => void | Promise<void>;
    onOpenLogs: () => void | Promise<void>;
  } = $props();

  function confirmDelete(thread: Thread) {
    if (confirm(`Delete "${thread.title}"?\n\nThis permanently removes its brief, reports, and ideas.`)) {
      onDelete(thread.id);
    }
  }
</script>

<aside class="sidebar">
  <div class="brand"><BrandMark size={21} /><span>Scraply</span></div>
  <button class="new" aria-label="Create new research thread" onclick={onNew}><span aria-hidden="true">+</span>New research</button>
  <div class="list-head"><span>Workspace</span><span>{threads.length}</span></div>
  <div class="list" role="list" aria-label="Research threads">
    {#each threads as thread (thread.id)}
      <div class="thread-row" class:active={thread.id === activeThreadId} role="listitem">
        <button
          class="thread"
          aria-current={thread.id === activeThreadId ? "true" : undefined}
          aria-label={`Open thread ${thread.title}`}
          onclick={() => onSelect(thread.id)}
        >
          <span class="title">{thread.title}</span>
          <span class="meta" data-tone={statusTone(thread.status)}>
            <span class="meta-dot" aria-hidden="true"></span>{statusLabel(thread.status)}
          </span>
        </button>
        <button
          class="delete"
          class:busy={deletingThreadId === thread.id}
          title="Delete research"
          aria-label={`Delete research ${thread.title}`}
          disabled={deletingThreadId !== null}
          onclick={() => confirmDelete(thread)}
        >
          {#if deletingThreadId === thread.id}
            <span class="spinner" aria-hidden="true"></span>
          {:else}
            <svg aria-hidden="true" viewBox="0 0 20 20" width="15" height="15" fill="none">
              <path d="M4.75 6.25h10.5M8 3.75h4M6.25 6.25l.5 9h6.5l.5-9M8.25 8.5v4.5M11.75 8.5v4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          {/if}
        </button>
      </div>
    {:else}
      <p class="empty">No threads yet</p>
    {/each}
  </div>
  <div class="footer">
    <button class="link" onclick={onOpenGuide}>User guide</button>
    <button class="link" onclick={onOpenData}>Open data folder</button>
    <button class="link" onclick={onOpenLogs}>Open logs folder</button>
  </div>
</aside>

<style>
  .sidebar {
    display: grid;
    grid-template-rows: auto auto auto 1fr auto;
    gap: 14px;
    padding: 20px 16px 16px;
    background: var(--surface);
    min-height: 0;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 0 4px 4px;
    font-size: 15px;
    font-weight: 650;
    letter-spacing: -0.025em;
  }

  .new {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 9px;
    border: 1px solid color-mix(in srgb, var(--accent) 50%, var(--border));
    background: color-mix(in srgb, var(--accent) 13%, var(--surface));
    color: var(--text);
    border-radius: 9px;
    padding: 10px 11px;
    font-weight: 600;
  }

  .new:hover {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 19%, var(--surface));
  }

  .new span {
    color: var(--accent-strong);
    font-size: 18px;
    font-weight: 400;
    line-height: 0;
  }

  .list-head {
    display: flex;
    justify-content: space-between;
    padding: 8px 5px 0;
    color: var(--subtle);
    font-family: var(--mono);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .list {
    overflow: auto;
    display: grid;
    gap: 4px;
    align-content: start;
  }

  .thread-row {
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    border: 1px solid transparent;
    border-radius: 8px;
  }

  .thread-row:hover {
    background: var(--surface-2);
  }

  .thread-row.active {
    background: var(--surface-2);
    border-color: var(--border-strong);
  }

  .thread {
    text-align: left;
    border: none;
    background: transparent;
    color: var(--text);
    border-radius: 8px;
    padding: 10px 12px;
    display: grid;
    gap: 4px;
    min-width: 0;
  }

  .thread .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .delete {
    border: none;
    background: transparent;
    color: var(--muted);
    display: grid;
    width: 32px;
    height: 32px;
    place-items: center;
    padding: 0;
    margin-right: 4px;
    border-radius: 6px;
    opacity: 0;
    transition: opacity 150ms ease, color 150ms ease, background 150ms ease;
  }

  .thread-row:hover .delete,
  .thread-row:focus-within .delete,
  .delete.busy {
    opacity: 1;
  }

  .spinner {
    width: 12px;
    height: 12px;
    border: 1.5px solid color-mix(in srgb, var(--muted) 40%, transparent);
    border-top-color: var(--muted);
    border-radius: 50%;
    animation: spin 700ms linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .delete:hover {
    color: var(--danger);
    background: color-mix(in srgb, var(--danger) 18%, transparent);
  }

  .thread:focus-visible,
  .delete:focus-visible,
  .new:focus-visible,
  .link:focus-visible {
    outline: 2px solid var(--accent-strong);
    outline-offset: 2px;
  }

  .title {
    font-size: 13px;
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--muted);
    font-size: 11px;
  }

  .meta-dot {
    flex: 0 0 auto;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--subtle);
  }

  .meta[data-tone="active"] {
    color: var(--accent-strong);
  }

  .meta[data-tone="active"] .meta-dot {
    background: var(--accent-strong);
    animation: meta-pulse 1.4s var(--ease) infinite alternate;
  }

  .meta[data-tone="done"] {
    color: var(--success);
  }

  .meta[data-tone="done"] .meta-dot {
    background: var(--success);
  }

  @keyframes meta-pulse {
    to { opacity: 0.3; }
  }

  .empty {
    color: var(--muted);
    padding: 8px 4px;
  }

  .footer {
    display: grid;
    gap: 6px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }

  .link {
    background: transparent;
    border: none;
    color: var(--muted);
    text-align: left;
    padding: 5px 4px;
    font-size: 12px;
  }

  .link:hover {
    color: var(--text);
  }
</style>
