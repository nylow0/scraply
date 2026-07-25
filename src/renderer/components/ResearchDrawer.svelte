<script lang="ts">
  import type { ResearchEvent } from "../../shared/ipc";
  import { RESEARCH_STREAMS } from "../../research/streams";

  let {
    events,
    activeRunId = null,
    cancelling = false,
    onCancel,
    onClose,
  }: {
    events: ResearchEvent[];
    activeRunId?: string | null;
    cancelling?: boolean;
    onCancel: () => void | Promise<void>;
    onClose: () => void;
  } = $props();

  const streamState = $derived.by(() => {
    const map = new Map<string, { name: string; status: string; detail: string }>(
      RESEARCH_STREAMS.map((stream) => [stream.id, { name: stream.name, status: "idle", detail: "" }]),
    );
    for (const event of events) {
      if (!("streamId" in event)) continue;
      const current = map.get(event.streamId);
      if (!current) continue;
      if (event.type === "stream-started") current.status = "running";
      if (event.type === "stream-progress") current.detail = event.message;
      if (event.type === "stream-completed") current.status = "completed";
      if (event.type === "stream-failed") {
        current.status = "failed";
        current.detail = event.error;
      }
    }
    return [...map.values()];
  });

  const orchestratorPhase = $derived.by(() => {
    for (const event of [...events].reverse()) {
      if (event.type === "run-failed") return `Run failed · ${event.error}`;
      if (event.type === "run-cancelled") return "Run cancelled";
      if (event.type === "synthesis-completed") return "Synthesis complete";
      if (event.type === "synthesis-started") return "Generating composite synthesis…";
      if (event.type === "coverage-review-completed") return `Coverage review · ${Math.round(event.overallCoverage * 100)}%`;
      if (event.type === "coverage-review-started") return "Reviewing coverage across streams…";
      if (event.type === "run-completed") return event.partial ? "Run finished with partial results" : "Run complete";
    }
    return "Waiting for stream updates";
  });
</script>

<aside class="drawer" aria-label="Research progress">
  <header>
    <h2>Research</h2>
    <div class="header-actions">
      {#if activeRunId}
        <button class="danger" disabled={cancelling} onclick={onCancel}>
          {cancelling ? "Cancelling…" : "Cancel run"}
        </button>
      {/if}
      <button aria-label="Close research drawer" onclick={onClose}>Close</button>
    </div>
  </header>
  <p class="phase" aria-live="polite">{orchestratorPhase}</p>
  <div class="lanes">
    {#each streamState as lane}
      <div class="lane" data-status={lane.status}>
        <div class="name">{lane.name}</div>
        <div class="status">{lane.status}</div>
        {#if lane.detail}<div class="detail">{lane.detail}</div>{/if}
      </div>
    {/each}
  </div>
</aside>

<style>
  .drawer {
    position: fixed;
    top: 0;
    right: 0;
    width: min(360px, 100%);
    height: 100%;
    background: var(--surface);
    border-left: 1px solid var(--border);
    box-shadow: -12px 0 40px rgba(0, 0, 0, 0.35);
    display: grid;
    grid-template-rows: auto auto 1fr;
    z-index: 20;
  }

  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px;
    border-bottom: 1px solid var(--border);
  }

  h2 {
    margin: 0;
    font-size: 14px;
  }

  .header-actions {
    display: flex;
    gap: 8px;
  }

  .danger {
    border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
    color: var(--danger);
  }

  .phase {
    margin: 0;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    color: var(--muted);
    font-size: 12px;
  }

  button {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: 8px;
    padding: 6px 10px;
  }

  button:focus-visible {
    outline: 2px solid var(--accent-strong);
    outline-offset: 2px;
  }

  .lanes {
    overflow: auto;
    padding: 12px;
    display: grid;
    gap: 8px;
  }

  .lane {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 10px 12px;
    background: var(--surface-2);
  }

  .name {
    font-weight: 500;
  }

  .status {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
    text-transform: lowercase;
    margin-top: 4px;
  }

  .detail {
    margin-top: 6px;
    color: var(--muted);
    font-size: 12px;
  }

  .lane[data-status="completed"] .status { color: var(--accent-strong); }
  .lane[data-status="failed"] .status { color: var(--danger); }
</style>
