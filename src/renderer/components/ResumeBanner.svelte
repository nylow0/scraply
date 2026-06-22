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

  function progressPct(run: PendingRun): number {
    if (run.totalStreams <= 0) return 0;
    return Math.round((run.completedStreams / run.totalStreams) * 100);
  }
</script>

{#if pendingRuns.length > 0}
  <section class="resume-banner" aria-live="polite">
    <div class="content">
      <p class="eyebrow">
        {pendingRuns.length === 1 ? "Interrupted research" : `${pendingRuns.length} interrupted runs`}
      </p>

      {#each pendingRuns as run, index (run.runId)}
        <article class="run-card" class:primary={index === 0}>
          <div class="run-head">
            <strong class="title">{run.threadTitle}</strong>
            <span class="pct">{progressPct(run)}%</span>
          </div>
          <div class="progress" role="progressbar" aria-valuenow={run.completedStreams} aria-valuemin={0} aria-valuemax={run.totalStreams} aria-label="Research stream progress">
            <span class="bar" style={`width: ${progressPct(run)}%`}></span>
          </div>
          <p class="meta">
            {run.completedStreams} of {run.totalStreams} streams complete
            {#if run.hasSynthesis}· synthesis saved{/if}
          </p>
          {#if index === 0}
            <p class="hint">Resume continues unfinished streams. Cancel keeps reports already saved.</p>
          {/if}
          {#if index > 0}
            <div class="run-actions">
              <button class="primary" aria-label={`Resume ${run.threadTitle}`} onclick={() => onResume(run.runId)}>
                Resume
              </button>
              <button class="ghost" aria-label={`Cancel ${run.threadTitle} and keep partial reports`} onclick={() => onCancel(run.runId)}>
                Cancel
              </button>
            </div>
          {/if}
        </article>
      {/each}
    </div>

    <div class="actions">
      <button class="primary" aria-label="Resume most recent interrupted research" onclick={() => onResume(pendingRuns[0]!.runId)}>
        Resume{pendingRuns.length > 1 ? " latest" : ""}
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
    gap: var(--space-4);
    align-items: flex-start;
    padding: var(--space-3) var(--space-5);
    border-bottom: 1px solid var(--accent-border);
    background:
      linear-gradient(90deg, var(--accent-faint), transparent 70%),
      var(--surface);
  }

  .content {
    flex: 1;
    min-width: 0;
    display: grid;
    gap: var(--space-3);
  }

  .eyebrow {
    margin: 0;
    font-family: var(--mono);
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--accent-strong);
  }

  .run-card {
    display: grid;
    gap: 6px;
  }

  .run-card.primary {
    padding-bottom: 2px;
  }

  .run-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .title {
    color: var(--text);
    font-weight: 600;
    font-size: 13px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .pct {
    flex-shrink: 0;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--accent-strong);
  }

  .progress {
    height: 4px;
    border-radius: 999px;
    background: var(--surface-3);
    overflow: hidden;
  }

  .bar {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--accent-strong);
    transition: width var(--dur) var(--ease);
  }

  .meta,
  .hint {
    margin: 0;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.45;
  }

  .hint {
    color: var(--text-2);
  }

  .run-actions {
    display: flex;
    gap: var(--space-2);
    margin-top: 2px;
  }

  .actions {
    display: flex;
    gap: var(--space-2);
    flex-shrink: 0;
    padding-top: 18px;
  }

  button {
    border: 1px solid var(--border-strong);
    background: var(--surface-2);
    color: var(--text-2);
    border-radius: var(--r-md);
    padding: 8px 14px;
    font-size: 13px;
    font-weight: 500;
    transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease),
      color var(--dur) var(--ease), transform var(--dur-fast) var(--ease);
  }

  button:hover:not(:disabled) {
    border-color: var(--border-strong);
    color: var(--text);
    background: var(--surface-3);
  }

  button:active:not(:disabled) { transform: translateY(1px); }

  button:focus-visible,
  button.primary:focus-visible,
  button.ghost:focus-visible {
    outline: 2px solid var(--accent-strong);
    outline-offset: 2px;
  }

  button.primary {
    background: var(--accent-bg);
    border-color: var(--accent-border);
    color: var(--accent-strong);
  }

  button.primary:hover:not(:disabled) {
    background: var(--accent-bg-hover);
    color: var(--accent-strong);
  }

  button.ghost {
    background: transparent;
    border-color: transparent;
    color: var(--muted);
  }

  button.ghost:hover:not(:disabled) {
    background: var(--surface-2);
    border-color: var(--border);
    color: var(--text);
  }

  .run-actions button {
    padding: 6px 10px;
    font-size: 12px;
  }

  @media (max-width: 720px) {
    .resume-banner { flex-direction: column; }
    .actions { width: 100%; padding-top: 0; }
    .actions button { flex: 1; }
  }
</style>
