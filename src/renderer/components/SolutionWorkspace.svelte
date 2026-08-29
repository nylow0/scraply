<script lang="ts">
  import type { SolutionView } from "../../shared/ipc";
  import SolutionListItem from "./SolutionListItem.svelte";

  let {
    solutions,
    busy,
    onExport,
    onOpenSource,
    onReview,
  }: {
    solutions: SolutionView[];
    busy: boolean;
    onExport: (format: "markdown" | "json") => Promise<void>;
    onOpenSource: (url: string) => Promise<void>;
    onReview: () => void;
  } = $props();

  let unaddressedOnly = $state(false);
  let rankedSolutions = $derived(solutions.map((idea, index) => ({ idea, rank: index + 1 })));
  let visible = $derived(
    unaddressedOnly
      ? rankedSolutions.filter(({ idea }) => idea.unaddressedCatastrophicRisks > 0)
      : rankedSolutions,
  );
</script>

<section class="workspace">
  <header>
    <div>
      <p class="eyebrow">Development output</p>
      <h1>{solutions.length} solution {solutions.length === 1 ? "idea" : "ideas"}</h1>
      <p class="intro">Ideas are ordered by independently confirmed outcomes that address the core problem.</p>
    </div>
    <div class="actions" aria-label="Solution actions">
      <button onclick={onReview}>Review problems</button>
      <button
        class:active={unaddressedOnly}
        aria-pressed={unaddressedOnly}
        onclick={() => unaddressedOnly = !unaddressedOnly}
      >Unaddressed project-ending</button>
      <button disabled={busy} onclick={() => onExport("markdown")}>Export Markdown</button>
      <button disabled={busy} onclick={() => onExport("json")}>JSON</button>
    </div>
  </header>

  <div class="list-heading" aria-hidden="true">
    <span>Rank and idea</span>
    <span>Highest risk</span>
    <span>Evaluation snapshot</span>
    <span></span>
  </div>

  <div class="solutions">
    {#each visible as item (item.idea.id)}
      <SolutionListItem idea={item.idea} rank={item.rank} {onOpenSource} />
    {:else}
      <div class="empty">
        <h2>No ideas match this filter.</h2>
        <p>Clear "Unaddressed project-ending" to return to the complete solution list.</p>
        <button onclick={() => unaddressedOnly = false}>Show every idea</button>
      </div>
    {/each}
  </div>

  <p class="legend">Dotted labels are model-estimated. Amber marks ideas developed from weak or adverse problem evidence.</p>
</section>

<style>
  .workspace {
    max-width: var(--page-max);
    margin: 0 auto;
    padding: var(--page-top) var(--page-inline) 100px;
  }

  header {
    display: grid;
    grid-template-columns: minmax(280px, 1fr) auto;
    gap: 28px;
    align-items: end;
    padding-bottom: 24px;
  }

  .eyebrow {
    margin: 0;
    font: 600 11px var(--mono);
    letter-spacing: .12em;
    text-transform: uppercase;
    color: var(--accent-strong);
  }

  h1 {
    margin: 7px 0 5px;
    font-size: clamp(28px, 3.3vw, 40px);
    line-height: 1.05;
    letter-spacing: -.04em;
  }

  .intro {
    max-width: 620px;
    margin: 0;
    color: var(--muted);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 7px;
  }

  .actions button,
  .empty button {
    min-height: 36px;
    padding: 8px 11px;
    border: 1px solid var(--border-strong);
    border-radius: 7px;
    background: var(--surface);
    color: var(--text);
  }

  .actions button:hover,
  .empty button:hover {
    border-color: var(--muted);
    background: var(--surface-2);
  }

  .actions button.active {
    border-color: #b98645;
    color: #e4b46f;
    background: color-mix(in srgb, #b98645 10%, var(--surface));
  }

  .list-heading {
    display: grid;
    grid-template-columns: minmax(210px, 1fr) minmax(260px, .9fr) auto 20px;
    gap: 16px;
    padding: 10px 18px 9px 64px;
    border-block: 1px solid var(--border);
    font: 600 10px var(--mono);
    letter-spacing: .08em;
    text-transform: uppercase;
    color: var(--subtle);
  }

  .solutions {
    border-bottom: 1px solid var(--border);
  }

  .empty {
    display: grid;
    justify-items: start;
    gap: 8px;
    padding: 44px 20px;
  }

  .empty h2,
  .empty p {
    margin: 0;
  }

  .empty p,
  .legend {
    color: var(--muted);
  }

  .legend {
    margin: 14px 0 0;
    font-size: 11px;
  }

  @media (max-width: 850px) {
    .workspace {
      padding: 26px 20px 72px;
    }

    header {
      grid-template-columns: 1fr;
    }

    .actions {
      justify-content: flex-start;
    }

    .list-heading {
      display: none;
    }
  }
</style>
