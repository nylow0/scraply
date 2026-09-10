<script lang="ts">
  import type { SolutionView } from "../../shared/ipc";
  import SolutionListItem from "./SolutionListItem.svelte";
  import DecisionOption from "./DecisionOption.svelte";

  let {
    solutions,
    busy,
    onExport,
    onOpenSource,
    onReview,
    onSelect,
    onSave,
    workflowVersion,
    onEvidenceFollowUp,
  }: {
    solutions: SolutionView[];
    busy: boolean;
    onExport: (format: "markdown" | "json") => Promise<void>;
    onOpenSource: (url: string) => Promise<void>;
    onReview: () => void;
    onSelect?: (idea: SolutionView) => Promise<void>;
    onSave?: (solutionId: string, decision: string, observed: string) => Promise<void>;
    workflowVersion?: 1 | 2 | undefined;
    onEvidenceFollowUp?: ((runId: string, question: string) => Promise<void>) | undefined;
  } = $props();

  let unaddressedOnly = $state(false);
  let hasV2 = $derived(workflowVersion === 2 || solutions.some((idea) => idea.workflowVersion === 2));
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
      <h1>{solutions.length} solution {solutions.length === 1 ? "idea" : "ideas"}</h1>
      <p class="intro">Open an idea to explore it. Options are not ranked.</p>
    </div>
    <div class="actions" aria-label="Solution actions">
      <button onclick={onReview}>Review problems</button>
      {#if !hasV2}<button
        class:active={unaddressedOnly}
        aria-pressed={unaddressedOnly}
        onclick={() => unaddressedOnly = !unaddressedOnly}
      >Unaddressed project-ending</button>{/if}
      <button disabled={busy} onclick={() => onExport("markdown")}>Export Markdown</button>
      <button disabled={busy} onclick={() => onExport("json")}>JSON</button>
    </div>
  </header>


  <div class="solutions">
    {#each visible as item (item.idea.id)}
      {#if item.idea.workflowVersion === 2 && onSelect && onSave}
        <DecisionOption idea={item.idea} {busy} {onSelect} {onSave} {onOpenSource} {onEvidenceFollowUp} />
      {:else}<SolutionListItem idea={item.idea} rank={item.rank} {onOpenSource} />{/if}
    {:else}
      <div class="empty">
        <h2>{solutions.length ? "No ideas match this filter." : hasV2 ? "No solution options were returned." : "No useful new option was proposed."}</h2>
        {#if solutions.length}<p>Clear "Unaddressed project-ending" to return to the complete solution list.</p><button onclick={() => unaddressedOnly = false}>Show every idea</button>{:else if hasV2}<p>The model returned zero options for the selected problem. Review the evidence and try another problem or run.</p>{/if}
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



  h1 {
    margin: 7px 0 5px;
    font-size: 28px;
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



  .solutions {
    display: grid;
    gap: 8px;
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
  }
</style>
