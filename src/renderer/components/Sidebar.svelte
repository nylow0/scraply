<script lang="ts">
  import type { Thread } from "../../shared/schemas";
  import { threadStatusLabel, threadStatusTone } from "../lib/thread-status";

  let {
    threads,
    activeThreadId,
    onNew,
    onSelect,
    onDelete,
    onOpenGuide,
    onOpenData,
  }: {
    threads: Thread[];
    activeThreadId: string | null;
    onNew: () => void;
    onSelect: (id: string) => void;
    onDelete: (id: string) => void;
    onOpenGuide: () => void;
    onOpenData: () => void;
  } = $props();
</script>

<aside class="sidebar">
  <div class="brand">
    <span class="mark" aria-hidden="true"></span>
    <span class="wordmark">Scraply</span>
  </div>

  <button class="new" aria-label="Create new research thread" onclick={onNew}>
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
    New research
  </button>

  <div class="list-wrap">
    <div class="list-head">
      <span>Threads</span>
      {#if threads.length}<span class="count">{threads.length}</span>{/if}
    </div>
    <div class="list" role="list" aria-label="Research threads">
      {#each threads as thread (thread.id)}
        <div class="thread-row" class:active={thread.id === activeThreadId}>
          <button
            class="thread"
            aria-current={thread.id === activeThreadId ? "true" : undefined}
            aria-label={`Open thread ${thread.title}`}
            onclick={() => onSelect(thread.id)}
          >
            <span class="title">{thread.title}</span>
            <span class="meta" data-tone={threadStatusTone(thread.status)}>
              {#if thread.parentThreadId}<span class="branch">branch · </span>{/if}
              {threadStatusLabel(thread.status)}
            </span>
          </button>
          <button
            class="delete"
            aria-label={`Delete thread ${thread.title}`}
            onclick={() => onDelete(thread.id)}
          >
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3.5 4h9" /><path d="M6 4V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1" /><path d="M5.5 4l.5 9h4l.5-9" />
            </svg>
          </button>
        </div>
      {:else}
        <div class="empty">
          <p class="empty-title">No threads yet</p>
          <p class="empty-hint">Click <strong>New research</strong> above, or open <strong>How it works</strong> in the footer.</p>
        </div>
      {/each}
    </div>
  </div>

  <div class="footer">
    <button class="link" onclick={onOpenGuide}>How it works</button>
    <button class="link" onclick={onOpenData}>Open data folder</button>
  </div>
</aside>

<style>
  .sidebar {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-4) var(--space-3);
    background: var(--surface);
    width: 268px;
    flex: 0 0 268px;
    height: 100%;
    min-height: 0;
    overflow: hidden;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0 var(--space-2);
  }

  .mark {
    width: 18px;
    height: 18px;
    border-radius: 5px;
    background: linear-gradient(150deg, var(--accent-strong), var(--accent));
    box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 18%, transparent);
  }

  .wordmark {
    font-weight: 600;
    font-size: 15px;
    letter-spacing: -0.02em;
  }

  .new {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    width: 100%;
    border: 1px solid var(--accent-border);
    background: var(--accent-bg);
    color: var(--accent-strong);
    border-radius: var(--r-md);
    padding: 9px 12px;
    font-size: 13px;
    font-weight: 500;
    transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease),
      transform var(--dur-fast) var(--ease);
  }

  .new:hover {
    background: var(--accent-bg-hover);
  }

  .new:active {
    transform: translateY(1px);
  }

  .new svg {
    flex-shrink: 0;
  }

  .list-wrap {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    flex: 1 1 0;
    min-height: 0;
    overflow: hidden;
  }

  .list-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 var(--space-2);
    color: var(--faint);
    font-family: var(--mono);
    font-size: 10px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }

  .count {
    color: var(--accent-strong);
  }

  .list {
    flex: 1 1 0;
    overflow-y: auto;
    overflow-x: hidden;
    min-height: 0;
    display: grid;
    gap: 2px;
    align-content: start;
    margin: 0 -2px;
    padding: 0 2px;
    overscroll-behavior: contain;
  }

  .thread-row {
    position: relative;
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: stretch;
    border-radius: var(--r-md);
    transition: background var(--dur) var(--ease);
  }

  .thread-row:hover,
  .thread-row:focus-within {
    background: var(--surface-2);
  }

  .thread-row.active {
    background: var(--surface-2);
  }

  .thread-row.active::before {
    content: "";
    position: absolute;
    left: 4px;
    top: 50%;
    transform: translateY(-50%);
    width: 3px;
    height: 16px;
    border-radius: 999px;
    background: var(--accent-strong);
    pointer-events: none;
  }

  .thread {
    position: relative;
    text-align: left;
    border: 1px solid transparent;
    background: transparent;
    color: var(--text-2);
    border-radius: var(--r-md);
    padding: 8px 4px 8px 13px;
    display: grid;
    gap: 3px;
    min-width: 0;
    transition: color var(--dur) var(--ease);
  }

  .thread-row:hover .thread,
  .thread-row.active .thread {
    color: var(--text);
  }

  .thread-row.active .title {
    color: var(--accent-strong);
  }

  .delete {
    display: grid;
    place-items: center;
    align-self: center;
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    margin-right: 4px;
    border: none;
    border-radius: var(--r-sm);
    background: transparent;
    color: var(--faint);
    opacity: 0;
    transition: opacity var(--dur) var(--ease), color var(--dur) var(--ease), background var(--dur) var(--ease);
  }

  .thread-row:hover .delete,
  .thread-row:focus-within .delete {
    opacity: 1;
  }

  .delete:hover {
    color: var(--danger);
    background: var(--danger-bg);
  }

  .delete:focus-visible {
    opacity: 1;
    outline: 2px solid var(--accent-strong);
    outline-offset: 2px;
  }

  .thread:focus-visible,
  .new:focus-visible,
  .link:focus-visible {
    outline: 2px solid var(--accent-strong);
    outline-offset: 2px;
  }

  .title {
    font-size: 13px;
    font-weight: 450;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .meta {
    color: var(--muted);
    font-family: var(--mono);
    font-size: 10.5px;
    letter-spacing: 0.01em;
  }

  .meta[data-tone="active"] {
    color: var(--accent-strong);
  }

  .meta[data-tone="success"] {
    color: var(--accent);
  }

  .meta[data-tone="warn"] {
    color: var(--warn);
  }

  .branch {
    color: var(--accent-strong);
  }

  .empty {
    padding: var(--space-4) var(--space-2);
  }

  .empty-title {
    margin: 0;
    color: var(--muted);
    font-size: 13px;
  }

  .empty-hint {
    margin: 4px 0 0;
    color: var(--faint);
    font-size: 12px;
  }

  .footer {
    display: grid;
    gap: 2px;
    padding-top: var(--space-2);
    border-top: 1px solid var(--hairline);
    flex: 0 0 auto;
  }

  .link {
    background: transparent;
    border: none;
    color: var(--muted);
    text-align: left;
    padding: 6px var(--space-2);
    border-radius: var(--r-sm);
    font-size: 12.5px;
    transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
  }

  .link:hover {
    background: var(--surface-2);
    color: var(--text);
  }

  @media (max-width: 960px) {
    .sidebar {
      width: 100%;
      flex: 0 0 auto;
      max-height: 38vh;
      border-bottom: 1px solid var(--border);
    }

    .list-wrap {
      max-height: 120px;
    }
  }
</style>
