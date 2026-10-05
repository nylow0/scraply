<script lang="ts">
  import { tick, untrack, type Snippet } from "svelte";
  import type { IdeaGroupView, SolutionView, WorkspaceState } from "../../shared/ipc";
  import BackLink from "./BackLink.svelte";
  import AnalysisProgress from "./AnalysisProgress.svelte";
  import type { SolutionsRoute } from "../lib/navigation-history";
  import { ideaContent } from "../lib/idea-content";
  import type { IdeaConversation as ConversationView, SubmitIdeaTurnRequest } from "../../shared/workflow-contracts";
  import SolutionListItem from "./SolutionListItem.svelte";
  import DecisionOption from "./DecisionOption.svelte";
  import IdeaConversation from "./IdeaConversation.svelte";
  import OpportunityFamilies from "./OpportunityFamilies.svelte";
  import type { OpportunityFamiliesView, OpportunityMembershipCommand } from "../../shared/opportunity-review";
  import type { ModelOption, ModelRef, RunConfig } from "../../shared/schemas";

  let {
    solutions,
    route = $bindable<SolutionsRoute>({ kind: "list" }),
    onNavigate,
    onBack,
    interactive = true,
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
    run = null,
    elapsed = "",
    runStage = "Preparing",
    onStop,
    onLoadMoreConversation,
    onFocusChange,
    footer,
  }: {
    solutions: SolutionView[];
    route?: SolutionsRoute;
    onNavigate?: (route: SolutionsRoute) => void;
    onBack?: (parent: SolutionsRoute) => void;
    interactive?: boolean;
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
    run?: WorkspaceState["latestResearchRun"];
    elapsed?: string;
    runStage?: string;
    onStop?: (runId: string) => Promise<void>;
    onLoadMoreConversation?: (cursor: string) => Promise<void>;
    onFocusChange?: (focused: boolean) => void;
    /** Shown under the idea groups, above the export links (the run details panel). */
    footer?: Snippet | undefined;
  } = $props();

  let selectedIdeaId = $derived(route.kind === "list" ? null : route.ideaId);
  let activeConversationId = $derived(route.kind === "conversation" ? route.ideaId : null);
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
    if (!onOpenConversation && !onNavigate) return;
    if (activeConversationId === null) openingButton = event.currentTarget as HTMLButtonElement;
    if (onNavigate) {
      if (activeConversationId === ideaId) await onOpenConversation?.(ideaId);
      else onNavigate({ kind: "conversation", ideaId });
      return;
    }
    route = { kind: "conversation", ideaId };
    openingConversation = true;
    openError = null;
    const request = ++openRequest;
    try {
      await onOpenConversation?.(ideaId);
    } catch (cause) {
      if (request === openRequest) openError = cause instanceof Error ? cause.message : "Could not open this conversation.";
    } finally {
      if (request === openRequest) openingConversation = false;
    }
  }

  function closeConversation() {
    openRequest += 1;
    if (route.kind !== "conversation") return;
    const parent: SolutionsRoute = { kind: "idea", ideaId: route.ideaId };
    if (onBack) onBack(parent); else route = parent;
    openingConversation = false;
    openError = null;
    onCloseConversation?.();
    void tick().then(() => openingButton?.focus({ preventScroll: true }));
  }
  function openIdea(event: MouseEvent, ideaId: string) {
    ideaButton = event.currentTarget as HTMLButtonElement;
    if (onNavigate) onNavigate({ kind: "idea", ideaId }); else route = { kind: "idea", ideaId };
  }
  function closeIdea() {
    if (onBack) onBack({ kind: "list" }); else route = { kind: "list" };
    void tick().then(() => ideaButton?.focus({ preventScroll: true }));
  }
  let previousRoute: SolutionsRoute = untrack(() => route);
  $effect(() => {
    if (previousRoute.kind === "conversation" && route.kind === "idea") {
      void tick().then(() => (openingButton ?? document.querySelector<HTMLButtonElement>(".explore-button"))?.focus({ preventScroll: true }));
    } else if (previousRoute.kind !== "list" && route.kind === "list") {
      const ideaId = previousRoute.ideaId;
      void tick().then(() => (ideaButton ?? Array.from(document.querySelectorAll<HTMLButtonElement>(".idea-row")).find(button => button.dataset.ideaId === ideaId))?.focus({ preventScroll: true }));
    }
    previousRoute = route;
  });
  let selectedIdea = $derived(solutions.find((idea) => idea.id === selectedIdeaId) ?? null);
  let runBusy = $derived(!!run && ["queued", "running"].includes(run.status));
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
</script>

<svelte:window onkeydown={(event) => {
  if (!interactive || event.defaultPrevented || document.querySelector("dialog[open]")) return;
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
  {#if runBusy && run && onStop}<AnalysisProgress {run} {elapsed} stage={runStage} {busy} {onStop} />{/if}

  <div class="groups">
    {#each groups as group (group.problemId)}
      <details class="problem-group" open>
        <summary><span class="problem-label">Problem:</span> {group.statement}
          {#each group.returns.filter((result) => result.returnedIdeaCount < result.requestedIdeaCount) as result (result.runId)}
            <span class="return-count">{#if group.returns.length > 1 || group.ideas.some((idea) => idea.runId !== result.runId)}One run returned {result.returnedIdeaCount} of {result.requestedIdeaCount} {result.requestedIdeaCount === 1 ? "idea" : "ideas"}{:else}{result.returnedIdeaCount} of {result.requestedIdeaCount} {result.requestedIdeaCount === 1 ? "idea" : "ideas"} returned{/if}</span>
          {/each}
        </summary>
        <ol>
          {#each group.ideas as idea, index (idea.id)}
            {@const content = ideaContent(idea.description)}
            <li><button data-idea-id={idea.id} class="idea-row" aria-label={`Open idea: ${content.name}`} onclick={(event) => openIdea(event, idea.id)}>
              <span class="idea-number" aria-hidden="true">{index + 1}.</span>
              <span class="idea-text"><span class="idea-name">{content.name}</span>{#if content.summary}<span class="idea-summary">{content.summary}</span>{/if}</span>
              {#if idea.weakFitReason}<span class="weak-fit">Weak fit</span>{/if}
              <svg class="row-chevron" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg>
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
      <OpportunityFamilies quiet {opportunities} {modelOptions} initialConfig={initialConfig ?? null} busy={busy || analysisBlocked || opportunityReviewRunning} onReview={onReviewOpportunities} onEdit={onEditMembership} />
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
      <div class="detail-navigation"><BackLink destination="ideas" onclick={closeIdea} /></div>
      {#if runBusy && run && onStop}<AnalysisProgress {run} {elapsed} stage={runStage} {busy} {onStop} />{/if}
      <div class="detail-heading"><h1>{ideaContent(selectedIdea.description).name}</h1>
        {#if selectedIdea.workflowVersion === 2 && (onOpenConversation || onNavigate)}<button class="explore-button" onclick={(event) => openConversation(event, selectedIdea.id)}>Explore this idea</button>{/if}
      </div>
      {#if ideaContent(selectedIdea.description).summary}<p class="lead">{ideaContent(selectedIdea.description).summary}</p>{/if}
      {#if selectedIdea.weakFitReason}<p class="rank-note"><span class="weak-fit">Weak fit</span> {selectedIdea.weakFitReason}</p>{/if}
      {#if selectedIdea.workflowVersion === 2 && onSave}
        <DecisionOption idea={selectedIdea} busy={busy || opportunityReviewRunning} {onSave} {onOpenSource} {onEvidenceFollowUp} {onEvidenceReassessment} {onPlanExperiment} />
      {:else}<SolutionListItem idea={selectedIdea} rank={solutions.findIndex((idea) => idea.id === selectedIdea.id) + 1} initiallyOpen={true} inDetailView={true} {onOpenSource} />{/if}
    {/if}
  </div>

  <div class="conversation-view" hidden={activeConversationId === null}>
    <div class="detail-navigation"><BackLink destination="idea" onclick={closeConversation} /></div>
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
          <IdeaConversation conversation={retainedConversation} {solutions} {modelOptions} {activeResearchSnapshotId} {run} {elapsed} {runStage} {onStop} onAnalyze={onSelect} busy={busy || opportunityReviewRunning} {analysisBlocked} onSubmit={onSubmitIdeaTurn} {...(onSelectConversationVersion ? { onSelectVersion: onSelectConversationVersion } : {})} {...(onLoadMoreConversation ? { onLoadMore: onLoadMoreConversation } : {})} />
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
  .problem-label { color:var(--muted);font-weight:500; }
  .return-count { display:block;margin-top:4px;color:var(--muted);font-size:13px;font-weight:400; }
  .problem-group ol { margin:0;padding:0 8px 8px;list-style:none; }
  .idea-row { display:flex;align-items:center;gap:14px;width:100%;padding:18px 12px;border:0;border-radius:0;background:transparent;color:var(--text);text-align:left;font-size:15px;cursor:pointer; }
  li + li { position:relative; }li + li::before { content:"";position:absolute;top:0;left:54px;right:12px;height:1px;background:var(--border); }
  .idea-number { width:28px;flex:none;color:var(--subtle);font-variant-numeric:tabular-nums;align-self:flex-start;line-height:1.6; }
  .idea-row:hover,.idea-row:focus-visible { background:var(--surface-2); }
  .idea-text { flex:1;min-width:0; }.idea-name { display:block;font-weight:600;line-height:1.6; }
  .idea-summary { display:-webkit-box;-webkit-line-clamp:2;line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-top:5px;max-width:68ch;color:var(--muted);font-size:14px;font-weight:400;line-height:1.6; }
  .row-chevron { flex:none;color:var(--subtle);transition:transform 120ms,color 120ms; }
  .idea-row:hover .row-chevron,.idea-row:focus-visible .row-chevron { color:var(--text);transform:translateX(3px); }
  .weak-fit { flex:none;padding:3px 8px;border:1px solid #b986455c;border-radius:6px;color:#e4b46f;font-size:13px;font-weight:500; }
  .grouping { margin:22px 0 0;border:1px solid var(--border);border-radius:9px;background:var(--surface); }
  .grouping > summary { display:flex;align-items:center;gap:12px;padding:13px 16px;color:var(--text);font-size:15px;font-weight:600;cursor:pointer; }
  .grouping > summary span { margin-left:auto;color:var(--muted);font-size:13px;font-weight:400;text-align:right; }
  .grouping :global(.opportunity-families) { border:0; }
  .run-footer { margin-top:12px; }
  .export-links { display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:28px; }
  .link-button { padding:0;border:0;background:transparent;color:var(--subtle);font-size:12px; }
  .link-button:hover:not(:disabled) { color:var(--text);text-decoration:underline; }
  .empty { display:grid;justify-items:start;gap:8px;padding:44px 0; }.empty h2 { font-size:18px;margin:0; }
  .detail-navigation { margin:0 0 24px -12px; }
  .conversation-error button { min-height:38px;padding:8px 12px;border:1px solid var(--border-strong);border-radius:8px;background:#000;color:var(--text);font-size:13px; }
  .conversation-error button:hover { background:var(--surface-2); }
  /* The title and its main action share a row; the action wraps under a long title. */
  .detail-heading { display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px 20px;margin-bottom:24px; }
  .conversation-view { min-width:0; }
  .lead { max-width:68ch;margin:0 0 24px;color:var(--text);font-size:16px;line-height:1.6; }
  .idea-detail :global(.analysis-progress) { margin-bottom:24px; }
  .conversation-status,.conversation-error { margin:0 0 18px;padding:18px;border:1px solid var(--border);border-radius:10px;color:var(--muted);font-size:14px; }
  .conversation-error p { margin:0 0 12px; }
  [hidden] { display:none; }
  .explore-button { min-height:40px;padding:9px 14px;border:1px solid var(--accent);border-radius:8px;background:var(--accent);color:var(--accent-ink);font-size:13px;font-weight:650; }
  .explore-button:hover { background:var(--accent-strong); }
  @container page (max-width:700px) { .workspace { padding:28px 22px 60px; }.problem-group > summary { padding:14px 16px; } }
  @container page (max-width:440px) { .workspace { padding-inline:16px; } }
  @media (prefers-reduced-motion:reduce) { .row-chevron { transition:none; } }
</style>
