<script lang="ts">
  import { tick } from "svelte";
  import ResultsToolbar from "./ResultsToolbar.svelte";
  import type { SolutionView } from "../../shared/ipc";
  import type { IdeaConversation as ConversationView, SubmitIdeaTurnRequest } from "../../shared/workflow-contracts";
  import SolutionListItem from "./SolutionListItem.svelte";
  import DecisionOption from "./DecisionOption.svelte";
  import IdeaConversation from "./IdeaConversation.svelte";
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
    acceptedCount = null,
    activeResearchSnapshotId = null,
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
    conversation = null,
    conversationLoading = false,
    conversationError = null,
    onOpenConversation,
    onCloseConversation,
    onSubmitIdeaTurn,
    onSelectConversationVersion,
    onLoadVersionDetail,
    onLoadMoreConversation,
    onFocusChange,
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
    acceptedCount?: number | null;
    activeResearchSnapshotId?: string | null;
    onEvidenceFollowUp?: ((runId: string, question: string) => Promise<void>) | undefined;
    onEvidenceReassessment?: ((runId: string) => Promise<void>) | undefined;
    conversation?: ConversationView | null;
    conversationLoading?: boolean;
    conversationError?: string | null;
    onOpenConversation?: (ideaId: string) => Promise<void>;
    onCloseConversation?: () => void;
    onSubmitIdeaTurn?: (draft: Omit<SubmitIdeaTurnRequest, "threadId" | "rootSolutionId">) => Promise<void>;
    onSelectConversationVersion?: (solutionId: string) => Promise<void>;
    onLoadVersionDetail?: (solutionId: string) => Promise<SolutionView>;
    onLoadMoreConversation?: (cursor: string) => Promise<void>;
    onFocusChange?: (focused: boolean) => void;
  } = $props();

  let query = $state("");
  let showDiscarded = $state(false);
  let discardedCount = $derived(solutions.filter((idea) => idea.discarded).length);
  let unaddressedOnly = $state(false);
  let selectedIdeaId = $state<string | null>(null);
  let selectedVersionDetail = $state<SolutionView | null>(null);
  let returnToConversationId = $state<string | null>(null);
  let activeConversationId = $state<string | null>(null);
  let retainedConversation = $state<ConversationView | null>(null);
  let openingConversation = $state(false);
  let openError = $state<string | null>(null);
  let openingButton: HTMLButtonElement | null = null;
  let ideaButton: HTMLButtonElement | null = null;
  let openRequest = 0;
  let conversationMatchesSelection = $derived(
    !!activeConversationId && !!retainedConversation
      && retainedConversation.versions.some((version) => version.solutionId === activeConversationId),
  );
  $effect(() => { onFocusChange?.(selectedIdeaId !== null || activeConversationId !== null); });

  $effect(() => {
    if (conversation) retainedConversation = conversation;
  });

  async function openConversation(event: MouseEvent, ideaId: string) {
    if (!onOpenConversation) return;
    if (activeConversationId === null) openingButton = event.currentTarget as HTMLButtonElement;
    activeConversationId = ideaId;
    openingConversation = true;
    openError = null;
    const request = ++openRequest;
    try {
      await onOpenConversation(ideaId);
    } catch (cause) {
      if (request === openRequest) openError = cause instanceof Error ? cause.message : "Could not open this conversation.";
    } finally {
      if (request === openRequest) openingConversation = false;
    }
  }

  function closeConversation() {
    openRequest += 1;
    activeConversationId = null;
    openingConversation = false;
    openError = null;
    onCloseConversation?.();
    void tick().then(() => openingButton?.focus());
  }
  function openIdea(event: MouseEvent, ideaId: string) {
    ideaButton = event.currentTarget as HTMLButtonElement;
    selectedVersionDetail = null;
    returnToConversationId = null;
    selectedIdeaId = ideaId;
  }
  function closeIdea() {
    selectedIdeaId = null;
    selectedVersionDetail = null;
    if (returnToConversationId) {
      activeConversationId = returnToConversationId;
      returnToConversationId = null;
    } else void tick().then(() => ideaButton?.focus());
  }
  async function viewVersionDetail(solutionId: string) {
    if (!onLoadVersionDetail || !activeConversationId) return;
    const conversationId = activeConversationId;
    const detail = await onLoadVersionDetail(solutionId);
    if (activeConversationId !== conversationId) return;
    selectedVersionDetail = detail;
    returnToConversationId = conversationId;
    selectedIdeaId = solutionId;
    activeConversationId = null;
  }
  let selectedIdea = $derived(selectedVersionDetail?.id === selectedIdeaId
    ? selectedVersionDetail : solutions.find((idea) => idea.id === selectedIdeaId) ?? null);
  let hasV2 = $derived(workflowVersion === 2 || solutions.some((idea) => idea.workflowVersion === 2));
  let rankedSolutions = $derived(solutions.map((idea, index) => ({ idea, rank: index + 1 })));
  function matchesQuery(idea: SolutionView): boolean {
    const normalized = query.trim().toLowerCase();
    return idea.description.toLowerCase().includes(normalized) || idea.mechanism.toLowerCase().includes(normalized) || idea.problemStatement.toLowerCase().includes(normalized);
  }
  function preview(description: string): string {
    const firstParagraph = description.trim().split(/\n\s*\n/)[0] ?? "";
    const firstSentence = firstParagraph.match(/^.*?[.!?](?=\s|$)/s)?.[0];
    return firstSentence?.trim() || firstParagraph.trim();
  }
  function shortTitle(mechanism: string): string {
    const firstLine = mechanism.trim().split(/\n/)[0] ?? "";
    const firstSentence = firstLine.match(/^.*?[.!?](?=\s|$)/s)?.[0];
    if (firstSentence && firstSentence.length <= 130) return firstSentence.trim();
    const clause = firstLine.match(/^.{1,130}?(?=[,;:]\s)/s)?.[0];
    if (clause && clause.length >= 25) return clause.trim();
    if (firstLine.length <= 130) return firstLine;
    const words = firstLine.slice(0, 130).trimEnd();
    return `${words.slice(0, words.lastIndexOf(" "))}…`;
  }
  function evidenceLabel(idea: SolutionView): string {
    if (idea.problemVerdict === "confirmed") return "Problem evidence reviewed";
    if (idea.problemVerdict === "user-asserted") return "Problem supplied by you";
    if (idea.problemVerdict === "insufficient-evidence") return "Problem evidence is thin";
    if (idea.problemVerdict === "attempted-and-failed") return "Earlier attempts did not work";
    if (idea.problemVerdict === "overstated") return "Problem may be overstated";
    return "Problem evidence needs review";
  }
  function reviewLabel(idea: SolutionView): string {
    if (idea.selected) return "Selected for analysis";
    return idea.selectable ? "Not selected for analysis" : "Analysis pending";
  }
  let visible = $derived(
    unaddressedOnly
      ? rankedSolutions.filter(({ idea }) => idea.unaddressedCatastrophicRisks > 0)
      : rankedSolutions,
  );
  let matchCount = $derived(visible.filter(({ idea }) => !!idea.discarded === showDiscarded && matchesQuery(idea)).length);
</script>

<svelte:window onkeydown={(event) => {
  if (activeConversationId && event.key === "Escape") {
    event.preventDefault();
    closeConversation();
  } else if (selectedIdeaId && event.key === "Escape") {
    event.preventDefault();
    closeIdea();
  }
}} />

<section class="workspace">
  <div hidden={activeConversationId !== null || selectedIdeaId !== null}>
  <header>
    <div>
      <h1>Ideas</h1>
      <p class="page-intro">{solutions.length - discardedCount} saved {solutions.length - discardedCount === 1 ? "idea" : "ideas"} to inspect.{#if acceptedCount !== null}&nbsp;{acceptedCount} accepted toward the run target.{/if}</p>
    </div>
    <div class="actions" aria-label="Solution actions">
      <button onclick={onReview}>Review problems</button>
      {#if discardedCount > 0 || showDiscarded}<button class:active={showDiscarded} aria-pressed={showDiscarded} onclick={() => showDiscarded = !showDiscarded}>Discarded {discardedCount}</button>{/if}
      <button disabled={busy} onclick={() => onExport("markdown")}>Export ideas</button>
      <button disabled={busy} onclick={() => onExport("json")}>Export JSON</button>
    </div>
  </header>

  {#if opportunities && onReviewOpportunities && onEditMembership && (initialConfig?.explorationPurpose === "startup-opportunities" || opportunities.rawOptionCount > 0 || opportunities.families.some((family) => family.active) || opportunities.unresolved.length > 0)}
    <details class="grouping"><summary>Review idea grouping <span>{opportunities.acceptedFamilyCount} accepted families, {opportunities.unreviewedOptionIds.length + opportunities.unresolved.length} need review</span></summary>
      <OpportunityFamilies {opportunities} {modelOptions} initialConfig={initialConfig ?? null} busy={busy || analysisBlocked || opportunityReviewRunning} onReview={onReviewOpportunities} onEdit={onEditMembership} />
    </details>
  {/if}

  <ResultsToolbar bind:query label="Search solutions" count={matchCount} />
  {#if solutions.length > 0 && matchCount === 0}<p class="filter-empty">{query ? `No solutions match "${query}".` : showDiscarded ? "No discarded solutions." : discardedCount === solutions.length ? "All solutions discarded. Open Discarded to review or restore them." : "No solutions match this filter."}</p>{/if}
  <div class="solutions">
    {#each rankedSolutions as item (item.idea.id)}
      <div class="idea-row" hidden={!!item.idea.discarded !== showDiscarded || (unaddressedOnly && item.idea.unaddressedCatastrophicRisks === 0) || !matchesQuery(item.idea)}>
        <div class="idea-card">
          <div class="card-copy">
            <h2>{shortTitle(item.idea.mechanism)}</h2>
            <p class="card-summary">{preview(item.idea.description)}</p>
            {#if preview(item.idea.description) !== item.idea.description.trim() || shortTitle(item.idea.mechanism) !== item.idea.mechanism.trim()}<span class="more-copy">Full explanation inside</span>{/if}
            <div class="card-status"><span class:needs-review={item.idea.problemVerdict !== "confirmed"}>{evidenceLabel(item.idea)}</span>{#if item.idea.workflowVersion === 2}<span>{reviewLabel(item.idea)}</span>{/if}</div>
          </div>
          <div class="card-actions">
            <button class="open-idea" aria-label={`Open idea: ${item.idea.description}`} onclick={(event) => openIdea(event, item.idea.id)}>Open idea</button>
            {#if onDiscard}<button class="dismiss" disabled={busy} aria-label={`${item.idea.discarded ? "Restore" : "Discard"} idea: ${item.idea.mechanism}`} onclick={() => onDiscard?.(item.idea.id, !item.idea.discarded)}>{item.idea.discarded ? "Restore" : "Discard"}</button>{/if}
          </div>
        </div>
      </div>
    {:else}
      <div class="empty">
        <h2>{solutions.length ? "No ideas match this filter." : acceptedCount === 0 ? "No ideas met the run target." : hasV2 ? "No solutions were returned." : "No useful new solution was proposed."}</h2>
        {#if solutions.length}<p>Clear "Unaddressed project-ending" to return to the complete idea list.</p><button onclick={() => unaddressedOnly = false}>Show every idea</button>{:else if hasV2}<p>Review the research and run result, then try another problem or run.</p>{/if}
      </div>
    {/each}
  </div>

  <div class="secondary-actions">      {#if !hasV2}<button
        class:active={unaddressedOnly}
        aria-pressed={unaddressedOnly}
        onclick={() => unaddressedOnly = !unaddressedOnly}
      >Unaddressed project-ending</button>{/if}
</div>
  <p class="legend">Ideas are shown in saved order. Evidence labels describe the problem research, not proof of customer demand.</p>
  </div>

  <div class="idea-detail" hidden={activeConversationId !== null || selectedIdeaId === null}>
    {#if selectedIdea}
      <div class="detail-navigation"><button class="back-button" onclick={closeIdea}>{returnToConversationId ? "Back to conversation" : "Back to ideas"}</button><span>Idea details</span></div>
      <div class="detail-heading"><h1>{shortTitle(selectedIdea.mechanism)}</h1>
        {#if selectedIdea.workflowVersion === 2 && onOpenConversation && !returnToConversationId}<button class="explore-button" aria-label={`Explore idea: ${selectedIdea.description}`} onclick={(event) => openConversation(event, selectedIdea.id)}>Explore this idea</button>{/if}
      </div>
      {#if selectedIdea.workflowVersion === 2 && onSelect && onSave}
        <DecisionOption idea={selectedIdea} busy={busy || opportunityReviewRunning} {analysisBlocked} initiallyOpen={true} inDetailView={true} {onSelect} {onSave} {onOpenSource} {onEvidenceFollowUp} {onEvidenceReassessment} {onPlanExperiment} />
      {:else}<SolutionListItem idea={selectedIdea} rank={solutions.findIndex((idea) => idea.id === selectedIdea.id) + 1} initiallyOpen={true} inDetailView={true} {onOpenSource} />{/if}
    {/if}
  </div>

  <div class="conversation-view" hidden={activeConversationId === null}>
    <button class="back-button" onclick={closeConversation}>Back to idea</button>
    {#if activeConversationId && (openingConversation || conversationLoading)}
      <p class="conversation-status" role="status">Opening conversation…</p>
    {:else if activeConversationId && (openError || conversationError)}
      <div class="conversation-error" role="alert"><p>{openError ?? conversationError}</p><button onclick={(event) => openConversation(event, activeConversationId!)}>Try again</button></div>
    {:else if activeConversationId && !conversationMatchesSelection}
      <p class="conversation-status" role="status">Conversation is unavailable.</p>
    {/if}
    {#if retainedConversation && onSubmitIdeaTurn}
      <div hidden={!conversationMatchesSelection || openingConversation || conversationLoading || !!openError || !!conversationError}>
        {#key retainedConversation.rootSolutionId}
          <IdeaConversation conversation={retainedConversation} {modelOptions} {activeResearchSnapshotId} busy={busy || analysisBlocked || opportunityReviewRunning} onSubmit={onSubmitIdeaTurn} {...(onSelectConversationVersion ? { onSelectVersion: onSelectConversationVersion } : {})} {...(onLoadVersionDetail ? { onViewVersion: viewVersionDetail } : {})} {...(onLoadMoreConversation ? { onLoadMore: onLoadMoreConversation } : {})} />
        {/key}
      </div>
    {/if}
  </div>
</section>

<style>
  .workspace { max-width:1120px;margin:0 auto;padding:var(--page-top) var(--page-inline) 80px;min-width:0; }
  header { display:flex;align-items:start;justify-content:space-between;flex-wrap:wrap;gap:24px; }
  header > div:first-child { flex:1;min-width:230px; }
  h1 { font-size:clamp(27px,3vw,34px);font-weight:650;letter-spacing:-.035em;margin:0;line-height:1.2; }
  .page-intro { margin:9px 0 0;color:var(--muted);font-size:14px;line-height:1.55; }
  .actions { display:flex;flex-wrap:wrap;justify-content:flex-end;gap:7px; }
  .actions button,.empty button { min-height:38px;padding:8px 12px;background:transparent;border:1px solid var(--border);border-radius:8px;color:var(--muted);font-size:13px; }
  .actions button:hover,.empty button:hover { color:var(--text);background:var(--surface-2);border-color:var(--border-strong); }
  .actions button.active { border-color:#b98645;color:#e4b46f;background:#b9864510; }
  .grouping { margin:22px 0 0;border:1px solid var(--border);border-radius:9px;background:#050705; }
  .grouping > summary { display:flex;justify-content:space-between;gap:12px;padding:13px 16px;color:var(--text);font-size:14px;font-weight:600;cursor:pointer; }
  .grouping > summary span { color:var(--muted);font-size:12px;font-weight:400;text-align:right; }
  .grouping :global(.opportunity-families) { border:0; }
  .solutions { display:grid;grid-template-columns:minmax(0,1fr);gap:10px; }
  .idea-row { min-width:0;max-width:100%; }
  .idea-card { display:flex;justify-content:space-between;gap:24px;padding:20px 22px;border:1px solid var(--border);border-radius:12px;background:#080b09; }
  .idea-card:hover { border-color:var(--border-strong); }
  .card-copy { min-width:0;max-width:75ch;overflow-wrap:anywhere; }
  .card-copy h2 { margin:0;color:var(--text);font-size:17px;font-weight:620;line-height:1.4;letter-spacing:-.015em; }
  .card-summary { margin:8px 0 0;color:var(--muted);font-size:14px;line-height:1.6; }
  .more-copy { display:block;margin-top:5px;color:var(--subtle);font-size:12px; }
  .card-status { display:flex;flex-wrap:wrap;gap:7px;margin-top:15px; }
  .card-status span { padding:4px 8px;border:1px solid var(--border);border-radius:6px;color:var(--muted);font-size:12px;line-height:1.35; }
  .card-status .needs-review { color:#e4b46f;border-color:#b986455c; }
  .card-actions { display:flex;align-items:flex-start;gap:8px;flex:0 0 auto; }
  .open-idea,.explore-button { min-height:40px;padding:9px 14px;border:1px solid var(--accent);border-radius:8px;background:var(--accent);color:var(--accent-ink);font-size:13px;font-weight:650; }
  .open-idea:hover,.explore-button:hover { background:var(--accent-strong); }
  .dismiss { min-height:40px;padding:8px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--subtle);font-size:13px; }
  .dismiss:hover { color:var(--text);background:var(--surface-2); }
  .secondary-actions { margin-top:18px; }
  .secondary-actions button { background:transparent;border:0;color:var(--subtle);font-size:13px;padding:6px 0; }
  .secondary-actions button.active { color:var(--text); }
  .empty { display:grid;justify-items:start;gap:8px;padding:44px 20px; }.empty h2 { font-size:18px; }.empty h2,.empty p { margin:0; }.empty p { color:var(--muted);font-size:13px; }
  .legend { margin:24px 0 0;max-width:70ch;color:var(--subtle);font-size:13px;line-height:1.6; }
  .filter-empty { padding:24px;border:1px dashed var(--border-strong);border-radius:12px;color:var(--muted);font-size:13px; }
  .detail-navigation { display:flex;align-items:center;gap:16px;margin-bottom:24px;color:var(--subtle);font-size:13px; }
  .back-button,.conversation-error button { min-height:38px;padding:8px 12px;border:1px solid var(--border-strong);border-radius:8px;background:#000;color:var(--text);font-size:13px; }
  .back-button:hover,.conversation-error button:hover { background:var(--surface-2); }
  /* The title and its main action share a row; the action wraps under a long title. */
  .detail-heading { display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px 20px;margin-bottom:24px; }
  .conversation-view { min-width:0; }
  .conversation-view .back-button { margin-bottom:18px; }
  .conversation-status,.conversation-error { margin:0 0 18px;padding:18px;border:1px solid var(--border);border-radius:10px;color:var(--muted);font-size:14px; }
  .conversation-error p { margin:0 0 12px; }
  [hidden] { display:none; }
  @media(max-width:850px) { .workspace { padding:28px 22px 60px; }.actions { justify-content:flex-start; }.idea-card { flex-direction:column;gap:15px; }.card-actions { flex-wrap:wrap; } }
  @media(max-width:480px) { .workspace { padding-inline:16px; }.idea-card { padding:17px; }.card-actions .open-idea { flex:1; } }
</style>
