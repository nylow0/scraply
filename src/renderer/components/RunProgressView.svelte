<script lang="ts">
  import type { ResearchEvent } from "../../shared/ipc";
  import {
    countCompletedLanes,
    derivePhase,
    deriveStreamLanes,
    isRunFinished,
    laneStatusLabel,
    type RunSnapshot,
  } from "../lib/run-progress";

  let {
    events,
    snapshot = null,
    variant = "page",
  }: {
    events: ResearchEvent[];
    snapshot?: RunSnapshot | null;
    variant?: "page" | "drawer";
  } = $props();

  const lanes = $derived(deriveStreamLanes(events, snapshot));
  const phase = $derived(derivePhase(events, snapshot));
  const completed = $derived(countCompletedLanes(lanes));
  const failed = $derived(lanes.filter((lane) => lane.status === "failed").length);
  const incomplete = $derived(lanes.filter((lane) => lane.status === "incomplete").length);
  const awaitingFirstUpdate = $derived(events.length === 0 && !isRunFinished(snapshot));
</script>

<div class="progress" class:drawer={variant === "drawer"}>
  <div class="phase" data-tone={phase.tone} aria-live="polite">
    <span class="dot" aria-hidden="true"></span>
    <span class="phase-text">{phase.label}</span>
  </div>

  <div class="meter">
    <div class="track" role="progressbar" aria-valuemin="0" aria-valuemax={lanes.length} aria-valuenow={completed} aria-label="Research streams complete">
      <span style={`--filled: ${(completed / lanes.length) * 100}%`}></span>
    </div>
    <p class="meter-copy">
      {completed}/{lanes.length} streams complete{#if failed} · {failed} failed{/if}{#if incomplete} · {incomplete} not completed{/if}
    </p>
  </div>

  {#if awaitingFirstUpdate}
    <p class="waiting">
      No live updates have arrived for this run yet. Progress appears here as each stream reports in.
    </p>
  {/if}

  <ul class="lanes">
    {#each lanes as lane (lane.id)}
      <li class="lane" data-status={lane.status}>
        <div class="lane-head">
          <span class="lane-name">{lane.name}</span>
          <span class="lane-status">{laneStatusLabel(lane.status)}</span>
        </div>
        {#if variant === "page"}
          <p class="lane-focus">{lane.focus}</p>
        {/if}
        {#if lane.followUpRound > 0}
          <p class="lane-meta">Follow-up round {lane.followUpRound}</p>
        {/if}
        {#if lane.detail}
          <p class="lane-detail">{lane.detail}</p>
        {/if}
      </li>
    {/each}
  </ul>
</div>

<style>
  .progress {
    display: grid;
    gap: 16px;
    min-width: 0;
  }

  .phase {
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
    color: var(--text);
    font-size: 13px;
  }

  .phase-text {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .dot {
    flex: 0 0 auto;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--subtle);
  }

  .phase[data-tone="active"] .dot {
    background: var(--accent-strong);
    animation: pulse 1.4s var(--ease) infinite alternate;
  }

  .phase[data-tone="done"] .dot {
    background: var(--success);
  }

  .phase[data-tone="failed"] .dot {
    background: var(--danger);
  }

  .phase[data-tone="failed"] {
    color: var(--danger);
  }

  @keyframes pulse {
    to { opacity: 0.35; transform: scale(0.8); }
  }

  .meter {
    display: grid;
    gap: 7px;
  }

  .track {
    height: 3px;
    overflow: hidden;
    border-radius: 999px;
    background: var(--border);
  }

  .track > span {
    display: block;
    width: var(--filled);
    height: 100%;
    background: var(--accent);
    transition: width 320ms var(--ease);
  }

  .meter-copy,
  .waiting {
    margin: 0;
    color: var(--muted);
    font-size: 11px;
  }

  .waiting {
    max-width: 62ch;
    line-height: 1.5;
  }

  .lanes {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .drawer .lanes {
    grid-template-columns: 1fr;
    gap: 8px;
  }

  .lane {
    min-width: 0;
    padding: 12px 13px;
    border: 1px solid var(--border);
    border-left: 2px solid var(--border-strong);
    border-radius: 10px;
    background: var(--surface-2);
    transition: border-color 200ms var(--ease);
  }

  .lane[data-status="running"] {
    border-left-color: var(--accent-strong);
  }

  .lane[data-status="completed"] {
    border-left-color: var(--success);
  }

  .lane[data-status="failed"] {
    border-left-color: var(--danger);
  }

  .lane[data-status="incomplete"] {
    border-left-color: var(--subtle);
  }

  .lane-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
  }

  .lane-name {
    font-size: 13px;
    font-weight: 600;
  }

  .lane-status {
    flex: 0 0 auto;
    color: var(--subtle);
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .lane[data-status="running"] .lane-status {
    color: var(--accent-strong);
  }

  .lane[data-status="completed"] .lane-status {
    color: var(--success);
  }

  .lane[data-status="failed"] .lane-status {
    color: var(--danger);
  }

  .lane-focus,
  .lane-meta,
  .lane-detail {
    margin: 6px 0 0;
    color: var(--muted);
    font-size: 11px;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }

  .lane-meta {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--subtle);
  }

  .lane[data-status="failed"] .lane-detail {
    color: var(--danger);
  }

  @media (max-width: 860px) {
    .lanes {
      grid-template-columns: 1fr;
    }
  }
</style>
