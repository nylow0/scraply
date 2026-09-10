<script lang="ts">
  import ResultsToolbar from "./ResultsToolbar.svelte";
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

  let query = $state("");
  let unaddressedOnly = $state(false);
  let hasV2 = $derived(workflowVersion === 2 || solutions.some((idea) => idea.workflowVersion === 2));
  let rankedSolutions = $derived(solutions.map((idea, index) => ({ idea, rank: index + 1 })));
  let visible = $derived(
    unaddressedOnly
      ? rankedSolutions.filter(({ idea }) => idea.unaddressedCatastrophicRisks > 0)
      : rankedSolutions,
  );
  let matchCount = $derived(visible.filter(({ idea }) => idea.mechanism.toLowerCase().includes(query.trim().toLowerCase())).length);
</script>

<section class="workspace">
  <header>
    <div>
      <h1>{solutions.length} solution {solutions.length === 1 ? "idea" : "ideas"}</h1>
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


  <ResultsToolbar bind:query label="Search ideas" count={matchCount} />
  {#if visible.length > 0 && matchCount === 0}<p class="filter-empty">No ideas match "{query}".</p>{/if}
  <div class="solutions">
    {#each visible as item (item.idea.id)}
      <div hidden={!item.idea.mechanism.toLowerCase().includes(query.trim().toLowerCase())}>
      {#if item.idea.workflowVersion === 2 && onSelect && onSave}
        <DecisionOption idea={item.idea} {busy} {onSelect} {onSave} {onOpenSource} {onEvidenceFollowUp} />
      {:else}<SolutionListItem idea={item.idea} rank={item.rank} {onOpenSource} />{/if}
      </div>
    {:else}
      <div class="empty">
        <h2>{solutions.length ? "No ideas match this filter." : hasV2 ? "No solution options were returned." : "No useful new option was proposed."}</h2>
        {#if solutions.length}<p>Clear "Unaddressed project-ending" to return to the complete solution list.</p><button onclick={() => unaddressedOnly = false}>Show every idea</button>{:else if hasV2}<p>The model returned zero options for the selected problem. Review the evidence and try another problem or run.</p>{/if}
      </div>
    {/each}
  </div>

  <p class="legend">Options are not ranked. Dotted labels are model-estimated. Amber marks ideas developed from weak or adverse problem evidence.</p>
</section>

<style>
  .workspace { max-width:1120px;margin:0 auto;padding:var(--page-top) var(--page-inline) 80px; }
  header { display:flex;align-items:start;flex-wrap:wrap;gap:22px; }
  header > div:first-child { flex:1;min-width:230px; }
  h1 { font-size:32px;font-weight:650;letter-spacing:-.035em;margin:0 0 10px;line-height:1.2; }
  .actions { display:flex;flex-wrap:wrap;justify-content:flex-end;gap:5px; }
  .actions button,.empty button { min-height:34px;padding:8px 10px;background:transparent;border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:10px; }
  .actions button:hover,.empty button:hover { background:var(--surface-2);border-color:var(--border-strong); }
  .actions button.active { border-color:#b98645;color:#e4b46f;background:#b9864510; }
  .solutions { display:grid;gap:10px; }
  .empty { display:grid;justify-items:start;gap:8px;padding:44px 20px; }.empty h2 { font-size:18px; }.empty h2,.empty p { margin:0; }.empty p { color:var(--muted);font-size:13px; }
  .legend { margin:24px 0 0;max-width:70ch;color:var(--subtle);font-size:10px;line-height:1.8; }
  .filter-empty { padding:24px;border:1px dashed var(--border-strong);border-radius:12px;color:var(--muted);font-size:13px; }
  [hidden] { display:none; }
  @media(max-width:850px) { .workspace { padding:28px 22px 60px; }.actions { justify-content:flex-start; } }
</style>
