<script lang="ts">
  import type { Thread } from "../../shared/schemas";

  let {
    threads,
    activeThreadId,
    deletingThreadId = null,
    onNew,
    onSelect,
    onDelete,
    onOpenGuide,
    onOpenData,
  }: {
    threads: Thread[];
    activeThreadId: string | null;
    deletingThreadId?: string | null;
    onNew: () => void;
    onSelect: (id: string) => void;
    onDelete: (id: string) => void;
    onOpenGuide: () => void;
    onOpenData: () => void;
  } = $props();

  function confirmDelete(thread: Thread) {
    if (confirm(`Delete "${thread.title}"?\n\nThis permanently removes its brief, reports, and ideas.`)) {
      onDelete(thread.id);
    }
  }
</script>

<aside class="sidebar">
  <div class="brand">Scraply</div>
  <button class="new" aria-label="Create new research thread" onclick={onNew}>New research</button>
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
          <span class="meta">{thread.status}</span>
        </button>
        <button
          class="delete"
          title="Delete research"
          aria-label={`Delete research ${thread.title}`}
          disabled={deletingThreadId !== null}
          onclick={() => confirmDelete(thread)}
        >🗑</button>
      </div>
    {:else}
      <p class="empty">No threads yet</p>
    {/each}
  </div>
  <div class="footer">
    <button class="link" onclick={onOpenGuide}>User guide</button>
    <button class="link" onclick={onOpenData}>Open data folder</button>
  </div>
</aside>

<style>
  .sidebar {
    display: grid;
    grid-template-rows: auto auto 1fr auto;
    gap: 12px;
    padding: 16px;
    background: var(--surface);
    min-height: 0;
  }

  .brand {
    font-weight: 600;
    letter-spacing: -0.02em;
  }

  .new {
    width: 100%;
    border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--border));
    background: color-mix(in srgb, var(--accent) 16%, var(--surface));
    color: var(--text);
    border-radius: 8px;
    padding: 10px 12px;
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
    background: color-mix(in srgb, var(--surface-2) 60%, transparent);
  }

  .thread-row.active {
    background: var(--surface-2);
    border-color: var(--border);
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
    font-size: 13px;
    line-height: 1;
    padding: 6px 10px;
    margin-right: 4px;
    border-radius: 6px;
    opacity: 0;
    transition: opacity 150ms ease, color 150ms ease, background 150ms ease;
  }

  .thread-row:hover .delete,
  .thread-row:focus-within .delete {
    opacity: 1;
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
    color: var(--muted);
    font-family: var(--mono);
    font-size: 11px;
    text-transform: lowercase;
  }

  .empty {
    color: var(--muted);
    padding: 8px 4px;
  }

  .footer {
    display: grid;
    gap: 6px;
  }

  .link {
    background: transparent;
    border: none;
    color: var(--muted);
    text-align: left;
    padding: 4px 0;
  }
</style>
