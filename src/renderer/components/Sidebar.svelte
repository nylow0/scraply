<script lang="ts">
  import type { Thread } from "../../shared/schemas";

  let {
    threads,
    activeThreadId,
    onNew,
    onSelect,
    onOpenGuide,
    onOpenData,
  }: {
    threads: Thread[];
    activeThreadId: string | null;
    onNew: () => void;
    onSelect: (id: string) => void;
    onOpenGuide: () => void;
    onOpenData: () => void;
  } = $props();
</script>

<aside class="sidebar">
  <div class="brand">Scraply</div>
  <button class="new" aria-label="Create new research thread" onclick={onNew}>New research</button>
  <div class="list" role="list" aria-label="Research threads">
    {#each threads as thread (thread.id)}
      <button
        class="thread"
        class:active={thread.id === activeThreadId}
        aria-current={thread.id === activeThreadId ? "true" : undefined}
        aria-label={`Open thread ${thread.title}`}
        onclick={() => onSelect(thread.id)}
      >
        <span class="title">{thread.title}</span>
        <span class="meta">{thread.status}</span>
      </button>
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

  .thread {
    text-align: left;
    border: 1px solid transparent;
    background: transparent;
    color: var(--text);
    border-radius: 8px;
    padding: 10px 12px;
    display: grid;
    gap: 4px;
  }

  .thread.active {
    background: var(--surface-2);
    border-color: var(--border);
  }

  .thread:focus-visible,
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
