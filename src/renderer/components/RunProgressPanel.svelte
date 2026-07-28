<script lang="ts">
  import type { ResearchEvent } from "../../shared/ipc";
  import type { ThreadStatus } from "../../shared/schemas";
  import type { RunSnapshot } from "../lib/run-progress";
  import { statusLabel } from "../lib/status";
  import RunProgressView from "./RunProgressView.svelte";

  let {
    events,
    status,
    snapshot = null,
    canCancel = false,
    cancelling = false,
    ideasGenerating = false,
    canGenerateIdeas = false,
    onCancel,
    onGenerateIdeas,
  }: {
    events: ResearchEvent[];
    status: ThreadStatus;
    snapshot?: RunSnapshot | null;
    canCancel?: boolean;
    cancelling?: boolean;
    ideasGenerating?: boolean;
    canGenerateIdeas?: boolean;
    onCancel: () => void | Promise<void>;
    onGenerateIdeas: () => void | Promise<void>;
  } = $props();

  const heading = $derived(
    status === "ideas-generating"
      ? "Generating ideas from the research"
      : status === "research-complete"
        ? "Research finished"
        : "Research in progress",
  );

  const lede = $derived(
    status === "ideas-generating"
      ? "Ideas are being written from the synthesised evidence. This page updates as the batch lands."
      : status === "research-complete"
        ? "Every stream has reported. Generate ideas when you are ready, or open the reports below to read the source material first."
        : "Six streams research in parallel. This page updates live, and partial results are kept even if a stream fails.",
  );
</script>

<section class="run-progress" aria-labelledby="run-progress-title">
  <header>
    <div>
      <p class="eyebrow">{statusLabel(status)}</p>
      <h2 id="run-progress-title">{heading}</h2>
      <p class="lede">{lede}</p>
    </div>
    <div class="actions">
      {#if canCancel}
        <button type="button" class="danger" disabled={cancelling} onclick={onCancel}>
          {cancelling ? "Cancelling…" : "Cancel run"}
        </button>
      {/if}
      {#if canGenerateIdeas}
        <button type="button" class="primary" disabled={ideasGenerating} onclick={onGenerateIdeas}>
          {ideasGenerating ? "Generating…" : "Generate ideas"}
        </button>
      {/if}
    </div>
  </header>

  <RunProgressView {events} {snapshot} />
</section>

<style>
  .run-progress {
    display: grid;
    gap: 24px;
    align-content: start;
    width: min(100%, var(--page-max));
    padding: var(--page-top) var(--page-inline) 44px;
  }

  header {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: 28px;
  }

  .eyebrow {
    margin: 0 0 7px;
    color: var(--accent);
    font-family: var(--mono);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.11em;
    text-transform: uppercase;
  }

  h2 {
    margin: 0 0 8px;
    font-size: clamp(23px, 2.6vw, 32px);
    font-weight: 650;
    letter-spacing: -0.04em;
    line-height: 1.08;
  }

  .lede {
    max-width: 68ch;
    margin: 0;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.55;
  }

  .actions {
    flex: 0 0 auto;
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
  }

  button {
    min-height: 39px;
    padding: 8px 14px;
    border: 1px solid var(--border);
    border-radius: 9px;
    background: var(--surface-2);
    color: var(--text);
    font-weight: 650;
  }

  button.primary {
    border-color: var(--accent-strong);
    background: var(--accent-strong);
    color: var(--accent-ink);
  }

  button.danger {
    border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
    background: transparent;
    color: var(--danger);
  }

  button:disabled {
    opacity: 0.55;
  }

  @media (max-width: 720px) {
    header {
      align-items: stretch;
      flex-direction: column;
    }

    .actions {
      justify-content: flex-start;
    }
  }
</style>
