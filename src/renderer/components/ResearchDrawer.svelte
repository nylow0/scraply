<script lang="ts">
  import type { ResearchEvent } from "../../shared/ipc";
  import type { RunSnapshot } from "../lib/run-progress";
  import RunProgressView from "./RunProgressView.svelte";

  let {
    events,
    snapshot = null,
    canCancel = false,
    cancelling = false,
    onCancel,
    onClose,
  }: {
    events: ResearchEvent[];
    snapshot?: RunSnapshot | null;
    canCancel?: boolean;
    cancelling?: boolean;
    onCancel: () => void | Promise<void>;
    onClose: () => void;
  } = $props();

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") onClose();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<aside class="drawer" aria-label="Research progress">
  <header>
    <div>
      <h2>Research progress</h2>
      <p>{canCancel ? "Live run" : "Last known state"}</p>
    </div>
    <div class="header-actions">
      {#if canCancel}
        <button class="danger" disabled={cancelling} onclick={onCancel}>
          {cancelling ? "Cancelling…" : "Cancel run"}
        </button>
      {/if}
      <button aria-label="Close research drawer" onclick={onClose}>Close</button>
    </div>
  </header>
  <div class="body">
    <RunProgressView {events} {snapshot} variant="drawer" />
  </div>
</aside>

<style>
  /* Docked as the shell's third column at desktop widths. */
  .drawer {
    min-width: 0;
    height: 100%;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    background: var(--surface);
    border-left: 1px solid var(--border);
  }

  /* Not enough room to dock, so overlay the page instead. */
  @media (max-width: 1180px) {
    .drawer {
      position: fixed;
      top: 0;
      right: 0;
      width: min(380px, 100%);
      box-shadow: -12px 0 40px rgba(0, 0, 0, 0.35);
      z-index: 20;
    }
  }

  header {
    display: flex;
    justify-content: space-between;
    align-items: start;
    gap: 12px;
    padding: 16px;
    border-bottom: 1px solid var(--border);
  }

  h2 {
    margin: 0;
    font-size: 14px;
  }

  header p {
    margin: 3px 0 0;
    color: var(--subtle);
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .header-actions {
    flex: 0 0 auto;
    display: flex;
    gap: 8px;
  }

  .body {
    min-height: 0;
    overflow: auto;
    padding: 16px;
  }

  button {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: 8px;
    padding: 6px 10px;
  }

  button:hover:not(:disabled) {
    border-color: var(--border-strong);
    background: var(--surface-2);
  }

  button.danger {
    border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
    color: var(--danger);
  }

  button:focus-visible {
    outline: 2px solid var(--accent-strong);
    outline-offset: 2px;
  }
</style>
