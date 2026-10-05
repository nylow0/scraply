<script lang="ts">
  import { tick, type Snippet } from "svelte";
  import type { IdeaGroupView, SolutionView } from "../../shared/ipc";
  import type { IdeaConversation as ConversationView, SubmitIdeaTurnRequest } from "../../shared/workflow-contracts";
  import SolutionListItem from "./SolutionListItem.svelte";
  import DecisionOption from "./DecisionOption.svelte";
  import IdeaConversation from "./IdeaConversation.svelte";
  import OpportunityFamilies from "./OpportunityFamilies.svelte";
  import type { OpportunityFamiliesView, OpportunityMembershipCommand } from "../../shared/opportunity-review";
  import type { ModelOption, ModelRef, RunConfig } from "../../shared/schemas";

  let {
    solutions,
    ideaGroups = [],
    busy,
    onExport,
    onOpenSource,
    onSelect,
    onSave,
    workflowVersion,
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
    footer,
  }: {
    solutions: SolutionView[];
    ideaGroups?: IdeaGroupView[] | undefined;
    busy: boolean;
    analysisBlocked?: boolean;
    opportunities?: OpportunityFamiliesView | undefined;
    modelOptions?: ModelOption[];
    initialConfig?: RunConfig | null;
    onReviewOpportunities?: (model: ModelRef, reasoningEffort: string, allowAmbiguousRetry?: boolean) => Promise<void>;
    onEditMembership?: (command: OpportunityMembershipCommand) => Promise<void>;
    onPlanExperiment?: (idea: SolutionView) => Promise<void>;
    opportunityReviewRunning?: boolean | undefined;
    onExport: (format: "markdown" | "json") => Promise<void>;
    onOpenSource: (url: string) => Promise<void>;
    onSelect?: (idea: SolutionView) => Promise<void>;
    onSave?: (solutionId: string, decision: string, observed: string, outcome: "not-run" | "pass" | "fail" | "inconclusive") => Promise<void>;
    workflowVersion?: 1 | 2 | undefined;
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
    /** Shown under the idea groups, above the export links (the run details panel). */
    footer?: Snippet | undefined;
  } = $props();

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
  /** One group per problem, in saved order. Ranked ideas come best first; ideas saved before ranking keep their order. */
  let groups = $derived.by(() => {
    const all = solutions.reduce<Array<{ problemId: string; statement: string; ideas: SolutionView[]; returns: IdeaGroupView[] }>>((groups, idea) => {
      const group = groups.find((item) => item.problemId === idea.problemId);
      if (group) group.ideas.push(idea);
      else groups.push({ problemId: idea.problemId, statement: idea.problemStatement, ideas: [idea], returns: [] });
      return groups;
    }, []);
    for (const result of ideaGroups) {
      const group = all.find((item) => item.problemId === result.problemId);
      // Counts describe the saved writer answer, not a filtered list or later idea versions.
      if (group && (result.returnedIdeaCount === 0 || group.ideas.some((idea) => idea.runId === result.runId))) group.returns.push(result);
      else if (result.returnedIdeaCount === 0) all.push({ problemId: result.problemId, statement: result.problemStatement, ideas: [], returns: [result] });
    }
    return all.map((group) => ({ ...group,
      ideas: group.ideas.sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER)) }));
  });
  // The short name is the description's text before its first colon ("History access and provenance pack: ...").
  // Ideas written without one fall back to the description's first sentence.
  function ideaName(idea: SolutionView): string {
    return idea.description.trim().match(/^([^:.!?\n]{2,80}):\s/)?.[1]?.trim() ?? preview(idea.description);
  }
  function preview(description: string): string {
    const firstParagraph = description.trim().split(/\n\s*\n/)[0] ?? "";
    const firstSentence = firstParagraph.match(/^.*?[.!?](?=\s|$)/s)?.[0];
    return firstSentence?.trim() || firstParagraph.trim();
  }
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
    <h1>{solutions.length} {solutions.length === 1 ? "idea" : "ideas"}</h1>
  </header>

  <div class="groups">
    {#each groups as group (group.problemId)}
      <details class="problem-group" open>
        <summary>{group.statement}
          {#each group.returns.filter((result) => result.returnedIdeaCount < result.requestedIdeaCount) as result (result.runId)}
            <span class="return-count">{#if group.returns.length > 1 || group.ideas.some((idea) => idea.runId !== result.runId)}One run returned {result.returnedIdeaCount} of {result.requestedIdeaCount} {result.requestedIdeaCount === 1 ? "idea" : "ideas"}{:else}{result.returnedIdeaCount} of {result.requestedIdeaCount} {result.requestedIdeaCount === 1 ? "idea" : "ideas"} returned{/if}</span>
          {/each}
        </summary>
        <ol>
          {#each group.ideas as idea (idea.id)}
            <li><button class="idea-row" aria-label={`Open idea: ${ideaName(idea)}`} onclick={(event) => openIdea(event, idea.id)}>
              <span class="idea-name">{ideaName(idea)}</span>{#if idea.weakFitReason}<span class="weak-fit">Weak fit</span>{/if}
            </button></li>
          {/each}
        </ol>
      </details>
    {:else}
      <div class="empty"><h2>{hasV2 ? "No ideas were returned." : "No useful new idea was proposed."}</h2></div>
    {/each}
  </div>

  <!-- Business families come from the older review; ranked ideas are never grouped into families, so they skip it. -->
  {#if opportunities && onReviewOpportunities && onEditMembership && solutions.some((idea) => idea.rank == null) && (initialConfig?.explorationPurpose === "startup-opportunities" || opportunities.rawOptionCount > 0 || opportunities.families.some((family) => family.active) || opportunities.unresolved.length > 0)}
    <details class="grouping"><summary>Review idea grouping <span>{opportunities.acceptedFamilyCount} accepted families, {opportunities.unreviewedOptionIds.length + opportunities.unresolved.length} need review</span></summary>
      <OpportunityFamilies {opportunities} {modelOptions} initialConfig={initialConfig ?? null} busy={busy || analysisBlocked || opportunityReviewRunning} onReview={onReviewOpportunities} onEdit={onEditMembership} />
    </details>
  {/if}
  {#if footer}<div class="run-footer">{@render footer()}</div>{/if}
  <div class="export-links">
    <button class="link-button" disabled={busy} onclick={() => onExport("markdown")}>Export ideas</button>
    <button class="link-button" disabled={busy} onclick={() => onExport("json")}>Export JSON</button>
  </div>
  </div>

  <div class="idea-detail" hidden={activeConversationId !== null || selectedIdeaId === null}>
    {#if selectedIdea}
      <div class="detail-navigation"><button class="back-button" onclick={closeIdea}>{returnToConversationId ? "Back to conversation" : "Back to ideas"}</button><span>Idea details</span></div>
      <div class="detail-heading"><h1>{ideaName(selectedIdea)}</h1>
        {#if selectedIdea.workflowVersion === 2 && onOpenConversation && !returnToConversationId}<button class="explore-button" aria-label={`Explore idea: ${selectedIdea.description}`} onclick={(event) => openConversation(event, selectedIdea.id)}>Explore this idea</button>{/if}
      </div>
      {#if selectedIdea.weakFitReason}<p class="rank-note"><span class="weak-fit">Weak fit</span> {selectedIdea.weakFitReason}</p>{/if}
      {#if selectedIdea.rankReason}<p class="rank-note">Ranked {selectedIdea.rank} for this problem: {selectedIdea.rankReason}</p>{/if}
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
  .workspace { max-width:var(--page-max);margin:0 auto;padding:var(--page-top) var(--page-inline) 80px;min-width:0; }
  header { display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:16px 24px; }
  h1 { font-size:clamp(27px,3vw,34px);font-weight:650;letter-spacing:-.035em;margin:0;line-height:1.2; }
  .groups { display:grid;gap:12px;margin-top:28px; }
  .problem-group { border:1px solid var(--border);border-radius:12px;background:var(--surface); }
  .problem-group > summary { padding:16px 20px;color:var(--text);font-size:15px;font-weight:600;line-height:1.45;cursor:pointer; }
  .return-count { display:block;margin-top:4px;color:var(--muted);font-size:12px;font-weight:400; }
  .problem-group ol { margin:0;padding:0 8px 8px;list-style:none; }
  .idea-row { display:flex;align-items:center;gap:12px;width:100%;min-height:46px;padding:10px 12px;border:0;border-radius:8px;background:transparent;color:var(--text);text-align:left;font-size:15px;font-weight:550; }
  .idea-row:hover,.idea-row:focus-visible { background:var(--surface-2); }
  .idea-name { flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
  .weak-fit { flex:none;padding:3px 8px;border:1px solid #b986455c;border-radius:6px;color:#e4b46f;font-size:12px;font-weight:500; }
  .grouping { margin:22px 0 0;border:1px solid var(--border);border-radius:9px;background:var(--surface); }
  .grouping > summary { display:flex;align-items:center;gap:12px;padding:13px 16px;color:var(--text);font-size:14px;font-weight:600;cursor:pointer; }
  .grouping > summary span { margin-left:auto;color:var(--muted);font-size:12px;font-weight:400;text-align:right; }
  .grouping :global(.opportunity-families) { border:0; }
  .run-footer { margin-top:12px; }
  .export-links { display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:28px; }
  .link-button { padding:0;border:0;background:transparent;color:var(--subtle);font-size:12px; }
  .link-button:hover:not(:disabled) { color:var(--text);text-decoration:underline; }
  .rank-note { max-width:75ch;margin:0 0 14px;color:var(--muted);font-size:14px;line-height:1.6; }
  .rank-note .weak-fit { margin-right:6px; }
  .empty { display:grid;justify-items:start;gap:8px;padding:44px 0; }.empty h2 { font-size:18px;margin:0; }
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
  .explore-button { min-height:40px;padding:9px 14px;border:1px solid var(--accent);border-radius:8px;background:var(--accent);color:var(--accent-ink);font-size:13px;font-weight:650; }
  .explore-button:hover { background:var(--accent-strong); }
  @container page (max-width:700px) { .workspace { padding:28px 22px 60px; }.problem-group > summary { padding:14px 16px; } }
  @container page (max-width:440px) { .workspace { padding-inline:16px; } }
</style>
