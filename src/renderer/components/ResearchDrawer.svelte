<script lang="ts">
  import type { ResearchEvent } from "../../shared/ipc";
  import type { Researcher } from "../../shared/schemas";
  import {
    countStreamStatuses,
    coveragePercent,
    deriveOrchestratorMessage,
    deriveStreamStates,
    formatRecentEvent,
    streamStatusLabel,
  } from "../lib/research-ui";

  let {
    events,
    researchers,
    onClose,
  }: {
    events: ResearchEvent[];
    researchers: Researcher[];
    onClose: () => void;
  } = $props();

  const streamStates = $derived(deriveStreamStates(events, researchers));
  const lanes = $derived(
    researchers.map((r) => ({
      id: r.id,
      name: r.name,
      ...(streamStates.get(r.id) ?? { status: "pending" as const, message: "Waiting to start" }),
    })),
  );
  const counts = $derived(countStreamStatuses(streamStates));
  const progress = $derived(counts.total > 0 ? Math.round((counts.completed / counts.total) * 100) : 0);
  const orchestratorPhase = $derived(deriveOrchestratorMessage(events));
  const coverage = $derived(coveragePercent(events));
  const recentEvents = $derived(events.slice(-8).reverse().map((e) => formatRecentEvent(e)));

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") onClose();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="backdrop" onclick={onClose} aria-hidden="true"></div>

<aside class="drawer" aria-label="Research activity log">
  <header>
    <div class="head-titles">
      <h2>Activity log</h2>
      <span class="counter">{counts.completed}/{counts.total} streams</span>
    </div>
    <button class="close" aria-label="Close activity log" onclick={onClose}>
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
        <path d="M4 4l8 8M12 4l-8 8" />
      </svg>
    </button>
  </header>

  <div class="phase">
    <p aria-live="polite">{orchestratorPhase}</p>
    {#if coverage !== null}
      <p class="coverage">Coverage score: {coverage}%</p>
    {/if}
    <div class="progress" role="progressbar" aria-valuenow={progress} aria-valuemin="0" aria-valuemax="100" aria-label="Stream completion">
      <span class="progress-fill" style={`width:${progress}%`}></span>
    </div>
    {#if counts.failed > 0}
      <p class="fail-note" role="status">{counts.failed} stream{counts.failed === 1 ? "" : "s"} failed — see details below</p>
    {/if}
  </div>

  <div class="lanes">
    <h3 class="section-label">Researchers</h3>
    {#each lanes as lane (lane.id)}
      <div class="lane" data-status={lane.status}>
        <div class="lane-top">
          <span class="dot" aria-hidden="true"></span>
          <span class="name">{lane.name}</span>
          <span class="chip">{streamStatusLabel(lane.status)}</span>
        </div>
        {#if lane.message}<div class="detail" class:error={lane.status === "failed"}>{lane.message}</div>{/if}
      </div>
    {/each}

    {#if recentEvents.length > 0}
      <h3 class="section-label">Recent events</h3>
      <ol class="event-log">
        {#each recentEvents as line, i (i)}
          <li>{line}</li>
        {/each}
      </ol>
    {/if}
  </div>
</aside>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: color-mix(in srgb, var(--bg) 55%, transparent);
    z-index: 19;
    animation: fade-in var(--dur) var(--ease);
  }

  @keyframes fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .drawer {
    position: fixed;
    top: 0;
    right: 0;
    width: min(400px, 100%);
    height: 100%;
    background: var(--surface);
    border-left: 1px solid var(--border-strong);
    box-shadow: var(--shadow-lg);
    display: grid;
    grid-template-rows: auto auto 1fr;
    z-index: 20;
    animation: drawer-in var(--dur) var(--ease);
  }

  @keyframes drawer-in {
    from { transform: translateX(12px); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }

  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--space-4);
    border-bottom: 1px solid var(--border);
  }

  .head-titles {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
  }

  h2 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }

  .counter {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
  }

  .phase {
    display: grid;
    gap: var(--space-2);
    margin: 0;
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border);
  }

  .phase p {
    margin: 0;
    color: var(--text-2);
    font-size: 12.5px;
    line-height: 1.45;
  }

  .coverage {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--accent-strong);
  }

  .fail-note {
    color: var(--danger);
    font-size: 12px;
  }

  .progress {
    height: 3px;
    border-radius: 999px;
    background: var(--surface-3);
    overflow: hidden;
  }

  .progress-fill {
    display: block;
    height: 100%;
    border-radius: 999px;
    background: var(--accent-strong);
    transition: width var(--dur) var(--ease);
  }

  .close {
    display: grid;
    place-items: center;
    background: transparent;
    border: 1px solid transparent;
    color: var(--muted);
    border-radius: var(--r-sm);
    padding: 5px;
    transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
  }

  .close:hover {
    background: var(--surface-2);
    color: var(--text);
    border-color: var(--border);
  }

  .close:focus-visible {
    outline: 2px solid var(--accent-strong);
    outline-offset: 2px;
  }

  .lanes {
    overflow: auto;
    padding: var(--space-3);
    display: grid;
    gap: var(--space-2);
    align-content: start;
  }

  .section-label {
    margin: var(--space-2) 0 0;
    font-size: 10.5px;
    font-family: var(--mono);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--faint);
  }

  .lane {
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    padding: 10px 12px;
    background: var(--surface-2);
    transition: border-color var(--dur) var(--ease);
  }

  .lane[data-status="running"] {
    border-color: var(--accent-border);
  }

  .lane[data-status="failed"] {
    border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
  }

  .lane-top {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 999px;
    background: var(--faint);
    flex-shrink: 0;
  }

  .lane[data-status="running"] .dot {
    background: var(--accent-strong);
    animation: lane-pulse 1.4s var(--ease) infinite;
  }
  .lane[data-status="completed"] .dot { background: var(--accent); }
  .lane[data-status="failed"] .dot { background: var(--danger); }

  @keyframes lane-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }

  .name {
    font-weight: 500;
    font-size: 13px;
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .chip {
    flex-shrink: 0;
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
    padding: 2px 7px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--surface);
  }

  .lane[data-status="running"] .chip { color: var(--accent-strong); border-color: var(--accent-border); }
  .lane[data-status="completed"] .chip { color: var(--accent); }
  .lane[data-status="failed"] .chip { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, var(--border)); }

  .detail {
    margin-top: var(--space-2);
    padding-left: 15px;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.5;
  }

  .empty {
    margin: var(--space-4) 0 0;
    padding: var(--space-5);
    text-align: center;
    color: var(--muted);
    font-size: 13px;
    border: 1px dashed var(--border-strong);
    border-radius: var(--r-md);
  }

  .detail.error {
    color: var(--danger);
  }

  .event-log {
    margin: 0;
    padding: 0 0 0 var(--space-4);
    display: grid;
    gap: 6px;
    font-size: 11.5px;
    color: var(--muted);
    line-height: 1.45;
  }

  .event-log li {
    padding-right: var(--space-2);
  }

  @media (max-width: 600px) {
    .drawer {
      width: 100%;
      top: auto;
      bottom: 0;
      height: min(75dvh, 560px);
      border-left: none;
      border-top: 1px solid var(--border-strong);
      border-radius: var(--r-xl) var(--r-xl) 0 0;
      animation: sheet-in var(--dur) var(--ease);
    }
  }

  @keyframes sheet-in {
    from { transform: translateY(16px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }
</style>
