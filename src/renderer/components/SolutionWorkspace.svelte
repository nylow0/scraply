<script lang="ts">
  import ResultsToolbar from "./ResultsToolbar.svelte";
  import type { SolutionView } from "../../shared/ipc";
  import SolutionListItem from "./SolutionListItem.svelte";
  import DecisionOption from "./DecisionOption.svelte";
  import OpportunityFamilies from "./OpportunityFamilies.svelte";
  import type { OpportunityFamiliesView, OpportunityMembershipCommand } from "../../shared/opportunity-review";
  import type { ModelOption, ModelRef, RunConfig } from "../../shared/schemas";

  let {
    solutions,
    busy,
    onExport,
    onDiscard,
    onOpenSource,
    onReview,
    onSelect,
    onSave,
    workflowVersion,
    onEvidenceFollowUp,
    onEvidenceReassessment,
    analysisBlocked = false,
    opportunities,
    modelOptions = [],
    initialConfig,
    onReviewOpportunities,
    onEditMembership,
    onPlanExperiment,
    opportunityReviewRunning = false,
  }: {
    solutions: SolutionView[];
    busy: boolean;
    analysisBlocked?: boolean;
    opportunities?: OpportunityFamiliesView | undefined;
    modelOptions?: ModelOption[];
    initialConfig?: RunConfig | null;
    onReviewOpportunities?: (model: ModelRef, reasoningEffort: string, allowAmbiguousRetry?: boolean) => Promise<void>;
    onEditMembership?: (command: OpportunityMembershipCommand) => Promise<void>;
    onPlanExperiment?: (idea: SolutionView) => Promise<void>;
    opportunityReviewRunning?: boolean | undefined;
    onDiscard?: (ideaId: string, discarded: boolean) => Promise<void>;
    onExport: (format: "markdown" | "json") => Promise<void>;
    onOpenSource: (url: string) => Promise<void>;
    onReview: () => void;
    onSelect?: (idea: SolutionView) => Promise<void>;
    onSave?: (solutionId: string, decision: string, observed: string, outcome: "not-run" | "pass" | "fail" | "inconclusive") => Promise<void>;
    workflowVersion?: 1 | 2 | undefined;
    onEvidenceFollowUp?: ((runId: string, question: string) => Promise<void>) | undefined;
    onEvidenceReassessment?: ((runId: string) => Promise<void>) | undefined;
  } = $props();

  let query = $state("");
  let showDiscarded = $state(false);
  let discardedCount = $derived(solutions.filter((idea) => idea.discarded).length);
  let unaddressedOnly = $state(false);
  let hasV2 = $derived(workflowVersion === 2 || solutions.some((idea) => idea.workflowVersion === 2));
  let rankedSolutions = $derived(solutions.map((idea, index) => ({ idea, rank: index + 1 })));
  function matchesQuery(idea: SolutionView): boolean {
    const normalized = query.trim().toLowerCase();
    return idea.description.toLowerCase().includes(normalized) || idea.mechanism.toLowerCase().includes(normalized);
  }
  let visible = $derived(
    unaddressedOnly
      ? rankedSolutions.filter(({ idea }) => idea.unaddressedCatastrophicRisks > 0)
      : rankedSolutions,
  );
  let matchCount = $derived(visible.filter(({ idea }) => !!idea.discarded === showDiscarded && matchesQuery(idea)).length);
</script>

<section class="workspace">
  <header>
    <div>
      <h1>{solutions.length - discardedCount} {solutions.length - discardedCount === 1 ? "solution" : "solutions"}</h1>
    </div>
    <div class="actions" aria-label="Solution actions">
      <button onclick={onReview}>Review problems</button>
      {#if discardedCount > 0 || showDiscarded}<button class:active={showDiscarded} aria-pressed={showDiscarded} onclick={() => showDiscarded = !showDiscarded}>Discarded {discardedCount}</button>{/if}
      <button disabled={busy} onclick={() => onExport("markdown")}>Export Markdown</button>
      <button disabled={busy} onclick={() => onExport("json")}>JSON</button>
    </div>
  </header>

  {#if opportunities && onReviewOpportunities && onEditMembership}
    <OpportunityFamilies {opportunities} {modelOptions} initialConfig={initialConfig ?? null} busy={busy || analysisBlocked || opportunityReviewRunning} onReview={onReviewOpportunities} onEdit={onEditMembership} />
  {/if}

  <ResultsToolbar bind:query label="Search solutions" count={matchCount} />
  {#if solutions.length > 0 && matchCount === 0}<p class="filter-empty">{query ? `No solutions match "${query}".` : showDiscarded ? "No discarded solutions." : discardedCount === solutions.length ? "All solutions discarded. Open Discarded to review or restore them." : "No solutions match this filter."}</p>{/if}
  <div class="solutions">
    {#each rankedSolutions as item (item.idea.id)}
      <div class="idea-row" hidden={!!item.idea.discarded !== showDiscarded || (unaddressedOnly && item.idea.unaddressedCatastrophicRisks === 0) || !matchesQuery(item.idea)}>
      {#if onDiscard}<button class="dismiss" disabled={busy} aria-label={`${item.idea.discarded ? "Restore" : "Discard"} solution: ${item.idea.description}`} onclick={() => onDiscard?.(item.idea.id, !item.idea.discarded)}>{item.idea.discarded ? "Restore" : "Discard"}</button>{/if}
      {#if item.idea.workflowVersion === 2 && onSelect && onSave}
        <DecisionOption idea={item.idea} busy={busy || opportunityReviewRunning} {analysisBlocked} {onSelect} {onSave} {onOpenSource} {onEvidenceFollowUp} {onEvidenceReassessment} {onPlanExperiment} />
      {:else}<SolutionListItem idea={item.idea} rank={item.rank} {onOpenSource} />{/if}
      </div>
    {:else}
      <div class="empty">
        <h2>{solutions.length ? "No solutions match this filter." : hasV2 ? "No solutions were returned." : "No useful new solution was proposed."}</h2>
        {#if solutions.length}<p>Clear "Unaddressed project-ending" to return to the complete solution list.</p><button onclick={() => unaddressedOnly = false}>Show every solution</button>{:else if hasV2}<p>The model returned zero solutions for the selected problem. Review the evidence and try another problem or run.</p>{/if}
      </div>
    {/each}
  </div>

  <div class="secondary-actions">      {#if !hasV2}<button
        class:active={unaddressedOnly}
        aria-pressed={unaddressedOnly}
        onclick={() => unaddressedOnly = !unaddressedOnly}
      >Unaddressed project-ending</button>{/if}
</div>
  <p class="legend">Solutions are not ranked. Dotted labels are model-estimated. Amber marks solutions developed from weak or adverse problem evidence.</p>
</section>

<style>
  .workspace { max-width:1120px;margin:0 auto;padding:var(--page-top) var(--page-inline) 80px; }
  header { display:flex;align-items:start;flex-wrap:wrap;gap:22px; }
  header > div:first-child { flex:1;min-width:230px; }
  h1 { font-size:32px;font-weight:650;letter-spacing:-.035em;margin:0 0 10px;line-height:1.2; }
  .actions { display:flex;flex-wrap:wrap;justify-content:flex-end;gap:5px; }
  .actions button,.empty button { min-height:34px;padding:8px 10px;background:transparent;border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px; }
  .actions button:hover,.empty button:hover { background:var(--surface-2);border-color:var(--border-strong); }
  .actions button.active { border-color:#b98645;color:#e4b46f;background:#b9864510; }
  .solutions { display:grid;grid-template-columns:minmax(0,1fr);gap:10px; }
  .workspace,.idea-row { min-width:0;max-width:100%; }
  .idea-row { position:relative; }
  .idea-row :global(.disclosure-title) { padding-right:102px; }
  .idea-row :global(.disclosure-label) { display:-webkit-box;-webkit-line-clamp:2;line-clamp:2;-webkit-box-orient:vertical;white-space:normal;overflow-wrap:anywhere;line-height:1.5; }
  .dismiss { position:absolute;right:14px;top:17px;z-index:1;padding:6px 8px;border:0;border-radius:6px;background:transparent;color:var(--subtle);font-size:13px;transition:background 180ms,color 180ms; }
  .dismiss:hover { color:var(--text);background:#ffffff0d; }
  .secondary-actions { margin-top:20px; }
  .secondary-actions button { background:transparent;border:0;color:var(--subtle);font-size:13px;padding:6px 0; }
  .secondary-actions button.active { color:var(--text); }
  .idea-row :global(details[open] > .disclosure-title .disclosure-label),.idea-row :global(.disclosure-title.expanded .disclosure-label) { -webkit-line-clamp:unset;line-clamp:unset; }
  .dismiss:focus-visible { outline:2px solid var(--accent); }
  .empty { display:grid;justify-items:start;gap:8px;padding:44px 20px; }.empty h2 { font-size:18px; }.empty h2,.empty p { margin:0; }.empty p { color:var(--muted);font-size:13px; }
  .legend { margin:24px 0 0;max-width:70ch;color:var(--subtle);font-size:13px;line-height:1.8; }
  .filter-empty { padding:24px;border:1px dashed var(--border-strong);border-radius:12px;color:var(--muted);font-size:13px; }
  [hidden] { display:none; }
  @media(max-width:850px) { .workspace { padding:28px 22px 60px; }.actions { justify-content:flex-start; } }
</style>
