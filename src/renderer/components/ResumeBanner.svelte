<script lang="ts">
  import type { PendingRun } from "../../shared/ipc";

  let {
    pendingRuns,
    onResume,
    onCancel,
  }: {
    pendingRuns: PendingRun[];
    onResume: (runId: string) => void;
    onCancel: (runId: string) => void;
  } = $props();
</script>

{#if pendingRuns.length > 0}
  <section class="resume-banner" aria-live="polite">
    <div>
      <p class="eyebrow">Interrupted research</p>
      <p class="copy">
        {#each pendingRuns as run (run.runId)}
          <span class="run">
            <strong>{run.threadTitle}</strong>
            — {run.completedStreams}/{run.totalStreams} streams
            {#if run.hasSynthesis}· synthesis saved{/if}
          </span>
        {/each}
      </p>
    </div>
    <div class="actions">
      <button class="primary" aria-label="Resume interrupted research" onclick={() => onResume(pendingRuns[0]!.runId)}>
        Resume
      </button>
      <button class="ghost" aria-label="Cancel interrupted research and keep partial reports" onclick={() => onCancel(pendingRuns[0]!.runId)}>
        Cancel run
      </button>
    </div>
  </section>
{/if}

<style>
  .resume-banner {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    align-items: center;
    padding: 12px 20px;
    border-bottom: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
    background: color-mix(in srgb, var(--accent) 10%, var(--surface));
  }

  .eyebrow {
    margin: 0 0 4px;
    font-family: var(--mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--accent-strong);
  }

  .copy {
    margin: 0;
    color: var(--muted);
    font-size: 13px;
  }

  .run {
    display: block;
  }

  .actions {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
  }

  button {
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    border-radius: 8px;
    padding: 8px 12px;
  }

  button:focus-visible,
  button.primary:focus-visible,
  button.ghost:focus-visible {
    outline: 2px solid var(--accent-strong);
    outline-offset: 2px;
  }

  button.primary {
    background: color-mix(in srgb, var(--accent) 24%, var(--surface));
  }

  button.ghost {
    background: transparent;
  }
</style>
