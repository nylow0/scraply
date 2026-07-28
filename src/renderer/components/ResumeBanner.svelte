<script lang="ts">
  import type { PendingRun } from "../../shared/ipc";

  let {
    pendingRuns,
    pendingRunId = null,
    onResume,
    onCancel,
  }: {
    pendingRuns: PendingRun[];
    pendingRunId?: string | null;
    onResume: (runId: string) => void | Promise<void>;
    onCancel: (runId: string) => void | Promise<void>;
  } = $props();
</script>

{#if pendingRuns.length > 0}
  <section class="resume-banner" aria-labelledby="resume-banner-title">
    <div class="head">
      <p class="eyebrow">Interrupted research</p>
      <h2 id="resume-banner-title">
        {pendingRuns.length === 1
          ? "One run stopped before it finished"
          : `${pendingRuns.length} runs stopped before they finished`}
      </h2>
      <p class="copy">Resume to continue from the completed streams, or cancel to keep the partial reports and stop.</p>
    </div>

    <ul>
      {#each pendingRuns as run (run.runId)}
        {@const busy = pendingRunId === run.runId}
        <li>
          <div class="run">
            <strong>{run.threadTitle}</strong>
            <span>
              {run.completedStreams}/{run.totalStreams} streams{#if run.hasSynthesis} · synthesis saved{/if}
            </span>
          </div>
          <div class="actions">
            <button
              class="primary"
              type="button"
              aria-label={`Resume research for ${run.threadTitle}`}
              disabled={pendingRunId !== null}
              onclick={() => onResume(run.runId)}
            >{busy ? "Resuming…" : "Resume"}</button>
            <button
              class="ghost"
              type="button"
              aria-label={`Cancel interrupted research for ${run.threadTitle} and keep partial reports`}
              disabled={pendingRunId !== null}
              onclick={() => onCancel(run.runId)}
            >{busy ? "Working…" : "Cancel"}</button>
          </div>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .resume-banner {
    display: grid;
    gap: 14px;
    padding: 15px 16px;
    border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--border));
    border-radius: 10px;
    background: color-mix(in srgb, var(--accent) 9%, var(--surface));
  }

  .eyebrow {
    margin: 0 0 5px;
    color: var(--accent-strong);
    font-family: var(--mono);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.09em;
    text-transform: uppercase;
  }

  h2 {
    margin: 0 0 5px;
    font-size: 14px;
    letter-spacing: -0.02em;
  }

  .copy {
    max-width: 72ch;
    margin: 0;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.5;
  }

  ul {
    display: grid;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 9px;
    background: var(--surface);
  }

  .run {
    min-width: 0;
    display: grid;
    gap: 3px;
  }

  .run strong {
    overflow: hidden;
    font-size: 13px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .run span {
    color: var(--muted);
    font-family: var(--mono);
    font-size: 11px;
  }

  .actions {
    flex: 0 0 auto;
    display: flex;
    gap: 7px;
  }

  button {
    min-height: 34px;
    padding: 7px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface-2);
    color: var(--text);
    font-size: 12px;
    font-weight: 650;
  }

  button.primary {
    border-color: var(--accent-strong);
    background: var(--accent-strong);
    color: var(--accent-ink);
  }

  button.ghost {
    background: transparent;
    color: var(--muted);
  }

  button.ghost:hover:not(:disabled) {
    border-color: var(--border-strong);
    color: var(--text);
  }

  button:disabled {
    opacity: 0.55;
  }

  button:focus-visible {
    outline: 2px solid var(--accent-strong);
    outline-offset: 2px;
  }

  @media (max-width: 620px) {
    li {
      align-items: stretch;
      flex-direction: column;
    }

    .actions button {
      flex: 1 1 0;
    }
  }
</style>
