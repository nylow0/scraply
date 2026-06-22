<script lang="ts">
  import type { ResearchEvent } from "../../shared/ipc";
  import type { Researcher } from "../../shared/schemas";
  import {
    countStreamStatuses,
    coveragePercent,
    deriveResearchPhase,
    deriveStreamStates,
    hasOrchestratorFailure,
    streamStatusLabel,
  } from "../lib/research-ui";

  let {
    events,
    researchers,
    generatingIdeas = false,
    onCancel,
    onOpenActivity,
  }: {
    events: ResearchEvent[];
    researchers: Researcher[];
    generatingIdeas?: boolean;
    onCancel?: () => void;
    onOpenActivity?: () => void;
  } = $props();

  const streamStates = $derived(deriveStreamStates(events, researchers));
  const counts = $derived(countStreamStatuses(streamStates));
  const phase = $derived(deriveResearchPhase(events));
  const coverage = $derived(coveragePercent(events));
  const hasFailures = $derived(hasOrchestratorFailure(events));

  const phases = [
    { id: "research", label: "Researching" },
    { id: "review", label: "Reviewing coverage" },
    { id: "synthesis", label: "Synthesising" },
    { id: "ideas", label: "Finishing up" },
    { id: "complete", label: "Ideas ready" },
  ] as const;

  const phaseIndex = $derived(phases.findIndex((p) => p.id === phase));

  const headline = $derived.by(() => {
    if (generatingIdeas) return "Generating your idea shortlist";
    if (phase === "cancelled") return "Research cancelled";
    if (phase === "complete") return "Research finished";
    if (phase === "ideas") return "Wrapping up — almost there";
    if (phase === "synthesis") return "Synthesising findings";
    if (phase === "review") return "Reviewing coverage";
    return "Research in progress";
  });

  const subline = $derived.by(() => {
    if (generatingIdeas) return "Scoring and ranking ideas from the research evidence. This usually takes under a minute.";
    if (phase === "cancelled") return "Partial reports may still be available in the activity log.";
    if (counts.failed > 0) {
      return `${counts.failed} stream${counts.failed === 1 ? "" : "s"} failed — others may still complete. Check the activity log for details.`;
    }
    if (coverage !== null && phase !== "research") return `Overall coverage: ${coverage}%`;
    if (counts.running > 0) return `${counts.running} researcher${counts.running === 1 ? "" : "s"} active · ${counts.completed}/${counts.total} done`;
    return "Your researchers are working in parallel. This usually takes a couple of minutes.";
  });
</script>

<div class="progress">
  <div class="head">
    <div class="pulse" class:done={phase === "complete" || phase === "ideas" || generatingIdeas} class:warn={hasFailures} class:ideas={generatingIdeas}></div>
    <div class="head-text">
      <h2>{headline}</h2>
      <p>{subline}</p>
    </div>
    <div class="head-actions">
      {#if onOpenActivity}
        <button class="ghost" onclick={onOpenActivity}>Activity log</button>
      {/if}
      {#if onCancel && !generatingIdeas && phase !== "cancelled" && phase !== "complete" && phase !== "ideas"}
        <button class="danger" onclick={onCancel}>Cancel</button>
      {/if}
    </div>
  </div>

  {#if hasFailures}
    <div class="alert" role="status">
      Some steps failed. Open the activity log for error details. You can still get partial results when the run finishes.
    </div>
  {/if}

  <ol class="phases" aria-label="Research phases">
    {#each phases as p, i (p.id)}
      <li class:active={i === phaseIndex} class:past={i < phaseIndex && phaseIndex >= 0}>
        <span class="dot"></span>{p.label}
      </li>
    {/each}
  </ol>

  <div class="streams-head">
    <span>Researchers</span>
    <span class="frac">{counts.completed}/{counts.total} done{#if counts.failed > 0} · {counts.failed} failed{/if}</span>
  </div>

  <div class="streams">
    {#if researchers.length === 0}
      <p class="no-streams">Waiting for researcher configuration…</p>
    {:else}
      {#each researchers as r (r.id)}
      {@const st = streamStates.get(r.id) ?? { status: "pending", message: "Waiting to start" }}
      <article class="stream" data-status={st.status}>
        <div class="stream-top">
          <span class="name">{r.name}</span>
          <span class="badge" data-status={st.status}>{streamStatusLabel(st.status)}</span>
        </div>
        <p class="msg">{st.message}</p>
      </article>
      {/each}
    {/if}
  </div>
</div>

<style>
  .progress {
    max-width: 760px;
    margin: 0 auto;
    padding: var(--space-8) var(--space-5);
  }
  .head {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    margin-bottom: var(--space-4);
  }
  .head-text {
    flex: 1;
    min-width: 0;
  }
  .head-actions {
    display: flex;
    gap: var(--space-2);
    flex-shrink: 0;
  }
  .pulse {
    width: 12px;
    height: 12px;
    margin-top: 5px;
    border-radius: 50%;
    background: var(--accent-strong);
    flex-shrink: 0;
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 60%, transparent);
    animation: pulse 1.8s var(--ease) infinite;
  }
  .pulse.done {
    animation: none;
    background: var(--accent);
  }
  .pulse.ideas {
    background: var(--accent);
    animation: pulse 1.2s var(--ease) infinite;
  }
  .pulse.warn {
    background: var(--warn);
    animation: none;
  }
  @keyframes pulse {
    0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 55%, transparent); }
    70% { box-shadow: 0 0 0 10px transparent; }
    100% { box-shadow: 0 0 0 0 transparent; }
  }
  .head h2 {
    margin: 0 0 2px;
    font-size: 18px;
    font-weight: 600;
  }
  .head p {
    margin: 0;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.45;
  }

  .alert {
    margin-bottom: var(--space-5);
    padding: var(--space-3) var(--space-4);
    border: 1px solid color-mix(in srgb, var(--warn) 45%, var(--border));
    border-radius: var(--r-md);
    background: color-mix(in srgb, var(--warn) 10%, var(--surface));
    color: var(--text-2);
    font-size: 12.5px;
    line-height: 1.5;
  }

  .phases {
    list-style: none;
    margin: 0 0 var(--space-6);
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-4);
  }
  .phases li {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: 12.5px;
    color: var(--faint);
  }
  .phases li .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--border-strong);
  }
  .phases li.past {
    color: var(--text-2);
  }
  .phases li.past .dot {
    background: var(--accent);
  }
  .phases li.active {
    color: var(--accent-strong);
  }
  .phases li.active .dot {
    background: var(--accent-strong);
    box-shadow: 0 0 0 3px var(--accent-bg);
  }

  .streams-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: var(--space-3);
    font-size: 12px;
    color: var(--muted);
  }
  .frac {
    font-family: var(--mono);
    font-size: 11px;
  }

  .streams {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-3);
  }
  .stream {
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    background: var(--surface);
    padding: var(--space-3);
    transition: border-color var(--dur) var(--ease);
  }
  .stream[data-status="running"] {
    border-color: var(--accent-border);
  }
  .stream[data-status="failed"] {
    border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
  }
  .stream-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-2);
    margin-bottom: 4px;
  }
  .name {
    font-size: 13px;
    font-weight: 600;
  }
  .badge {
    font-family: var(--mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
    padding: 2px 6px;
    border-radius: var(--r-sm);
    background: var(--surface-2);
  }
  .badge[data-status="running"] {
    color: var(--accent-strong);
    background: var(--accent-bg);
  }
  .badge[data-status="completed"] {
    color: var(--accent);
  }
  .badge[data-status="failed"] {
    color: var(--danger);
    background: var(--danger-bg);
  }
  .msg {
    margin: 0;
    font-size: 12px;
    color: var(--text-2);
    min-height: 1.4em;
    line-height: 1.45;
  }

  .no-streams {
    grid-column: 1 / -1;
    margin: 0;
    padding: var(--space-4);
    text-align: center;
    color: var(--muted);
    font-size: 13px;
    border: 1px dashed var(--border-strong);
    border-radius: var(--r-md);
  }

  .ghost,
  .danger {
    border: 1px solid var(--border);
    background: transparent;
    color: var(--muted);
    border-radius: var(--r-md);
    padding: 6px 10px;
    font-size: 12px;
    font-weight: 500;
    transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease), color var(--dur) var(--ease);
  }
  .ghost:hover {
    background: var(--surface-2);
    border-color: var(--border-strong);
    color: var(--text);
  }
  .danger {
    border-color: color-mix(in srgb, var(--danger) 40%, var(--border));
    color: var(--danger);
  }
  .danger:hover {
    background: var(--danger-bg);
    border-color: color-mix(in srgb, var(--danger) 55%, var(--border));
  }

  @media (max-width: 640px) {
    .head {
      flex-wrap: wrap;
    }
    .head-actions {
      width: 100%;
      justify-content: flex-end;
    }
    .streams {
      grid-template-columns: 1fr;
    }
  }
</style>
