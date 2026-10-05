<script lang="ts">
  import { tick } from "svelte";
  import type { SolutionView, WorkspaceState } from "../../shared/ipc";
  import { loadIdeaDetail } from "../lib/idea-details";
  import { ideaContent, EXPLAIN_IDEA_PROMPT } from "../lib/idea-content";
  import IdeaMechanism from "./IdeaMechanism.svelte";
  import AnalysisProgress from "./AnalysisProgress.svelte";
  import RiskAnalysis from "./RiskAnalysis.svelte";
  import ModelPicker from "./ModelPicker.svelte";
  import type { IdeaConversation as ConversationView, SubmitIdeaTurnRequest } from "../../shared/workflow-contracts";
  import type { ModelOption, ModelRef } from "../../shared/schemas";

  type Draft = Omit<SubmitIdeaTurnRequest, "threadId" | "rootSolutionId">;

  let {
    conversation,
    modelOptions,
    activeResearchSnapshotId = null,
    busy = false,
    analysisBlocked = false,
    solutions = [],
    run = null,
    elapsed = "",
    runStage = "Preparing",
    onStop,
    onAnalyze,
    onSubmit,
    onSelectVersion,
    onLoadMore,
  }: {
    conversation: ConversationView;
    modelOptions: ModelOption[];
    activeResearchSnapshotId?: string | null;
    busy?: boolean;
    analysisBlocked?: boolean;
    solutions?: SolutionView[];
    run?: WorkspaceState["latestResearchRun"];
    elapsed?: string;
    runStage?: string;
    onStop?: ((runId: string) => Promise<void>) | undefined;
    onAnalyze?: ((idea: SolutionView) => Promise<void>) | undefined;
    onSubmit: (draft: Draft) => Promise<void>;
    onSelectVersion?: (solutionId: string) => Promise<void>;
    onLoadMore?: (cursor: string) => Promise<void>;
  } = $props();

  let selectedVersionId = $state("");
  let selectedBranchId = $state<string | null>(null);
  let mobilePane = $state<"idea" | "conversation">("conversation");
  let intent = $state<Draft["intent"]>("explore-directions");
  let draft = $state("");
  let modelKey = $state<string | null>(null);
  let effort = $state<string | null>(null);
  let replyToTurnId = $state<string | null>(null);
  let retryParentTurnId = $state<string | null | undefined>(undefined);
  let sending = $state(false);
  let useNewerResearch = $state(false);
  let error = $state<string | null>(null);
  let detail = $state<SolutionView | null>(null);
  let detailError = $state<string | null>(null);
  let loadingDetail = $state(false);
  let activeDetailKey = "";
  let detailEpoch = 0;
  let selectedSummary = $derived(solutions.find(idea => idea.id === selectedVersionId));
  let runBusy = $derived(!!run && ["queued", "running"].includes(run.status));
  let analysisError = $derived(detail?.analysisError ?? (run?.status === "failed" && run.runId === detail?.runId && !detail?.decisionAnalysis ? run.completionReason ?? "The analysis failed." : null));
  let turnBusy = $derived(conversation.turns.some(turn => turn.state === "pending" || turn.state === "running"));
  let controlsBusy = $derived(busy || sending || analysisBlocked || runBusy || turnBusy);
  let analysisAvailable = $derived(!!detail?.selectable && !!onAnalyze && !solutions.some(idea => idea.id !== detail?.id && idea.runId === detail?.runId && idea.selected));
  let canAnalyze = $derived(analysisAvailable && !controlsBusy && !loadingDetail);
  $effect(() => {
    const key = `${selectedVersionId}:${selectedSummary?.detailRevision ?? ""}`;
    if (selectedVersionId && onAnalyze && key !== activeDetailKey) {
      activeDetailKey = key;
      void refreshDetail(selectedVersionId, selectedSummary);
    }
  });
  async function refreshDetail(id: string, summary?: SolutionView) {
    const epoch = ++detailEpoch;
    if (detail?.id !== id) detail = null;
    loadingDetail = true;
    detailError = null;
    try {
      const saved = summary ? await loadIdeaDetail(summary) : await window.scraply.getIdeaDetail(id);
      if (epoch === detailEpoch) detail = saved;
    } catch (cause) {
      if (epoch === detailEpoch) detailError = cause instanceof Error ? cause.message : "Could not load this idea.";
    } finally { if (epoch === detailEpoch) loadingDetail = false; }
  }
  async function analyze() {
    if (!canAnalyze || !detail) return;
    sending = true;
    error = null;
    try { await onAnalyze?.(detail); }
    catch (cause) { error = cause instanceof Error ? cause.message : "Could not start the analysis."; }
    finally { sending = false; }
  }

  let selectedVersion = $derived(conversation.versions.find((version) => version.solutionId === selectedVersionId));
  let parentVersion = $derived(conversation.versions.find((version) => version.solutionId === selectedVersion?.parentSolutionId));
  let newerResearchAvailable = $derived(!!activeResearchSnapshotId && selectedVersion?.evidenceSnapshotId !== activeResearchSnapshotId);
  let changedFields = $derived(parentVersion && selectedVersion ? [
    ...(parentVersion.mechanism !== selectedVersion.mechanism ? ["How it works"] : []),
    ...(parentVersion.description !== selectedVersion.description ? ["Description"] : []),
  ] : []);
  let branchId = $derived(selectedBranchId ?? conversation.branches.at(-1)?.branchId ?? null);
  let branch = $derived(conversation.branches.find((item) => item.branchId === branchId));
  let visibleTurns = $derived(conversation.turns.filter((turn) => !branchId || turn.branchId === branchId));
  let originalModel = $derived(selectedVersion?.model ?? conversation.defaultModel);
  let originalModelKey = $derived(originalModel ? `${originalModel.providerId}:${originalModel.modelId}` : null);
  let effectiveModelKey = $derived(modelKey ?? originalModelKey);
  let selectedModelOption = $derived(modelOptions.find((option) => `${option.providerId}:${option.modelId}` === effectiveModelKey));
  let effectiveEffort = $derived(effort ?? (modelKey === null && selectedVersion?.reasoningEffort && selectedModelOption?.reasoningEfforts.some((item) => item.id === selectedVersion.reasoningEffort)
    ? selectedVersion.reasoningEffort : selectedModelOption?.defaultReasoningEffort ?? ""));
  let canAct = $derived(!controlsBusy && !!selectedVersion && !!selectedModelOption && !!effectiveEffort);
  let canSend = $derived(canAct && draft.trim().length > 0 && draft.trim().length <= 4_000);

  $effect(() => {
    if (!selectedVersionId || !conversation.versions.some((version) => version.solutionId === selectedVersionId)) {
      selectedVersionId = conversation.selectedVersionId;
    }
    if (selectedBranchId && !conversation.branches.some((item) => item.branchId === selectedBranchId)) {
      selectedBranchId = null;
    }
  });

  async function selectVersion(solutionId: string) {
    if (solutionId === selectedVersionId) return;
    const previous = selectedVersionId;
    selectedVersionId = solutionId;
    modelKey = null;
    effort = null;
    replyToTurnId = null;
    retryParentTurnId = undefined;
    useNewerResearch = false;
    error = null;
    try {
      await onSelectVersion?.(solutionId);
    } catch (cause) {
      selectedVersionId = previous;
      error = cause instanceof Error ? cause.message : "Could not select this version.";
    }
  }

  function modelFromOption(option: ModelOption): ModelRef {
    return { providerId: option.providerId, modelId: option.modelId };
  }
  async function submit(text = draft.trim(), turnIntent: Draft["intent"] = intent) {
    if (!canAct || !text || text.length > 4_000 || !selectedVersion || !selectedModelOption) return;
    error = null;
    sending = true;
    const retrying = retryParentTurnId !== undefined;
    const parentTurnId = retrying ? retryParentTurnId ?? null : replyToTurnId ?? branch?.headTurnId ?? null;
    const branchFromEarlier = parentTurnId !== null && (retrying || (replyToTurnId !== null && replyToTurnId !== branch?.headTurnId));
    try {
      await onSubmit({
        baseSolutionId: selectedVersion.solutionId,
        ...(branchId && !retrying && !branchFromEarlier ? { branchId } : {}),
        expectedHeadTurnId: retrying || branchFromEarlier ? null : branch?.headTurnId ?? null,
        parentTurnId,
        clientMessageId: crypto.randomUUID(),
        intent: turnIntent,
        text,
        ...((useNewerResearch && newerResearchAvailable ? activeResearchSnapshotId : selectedVersion.evidenceSnapshotId)
          ? { evidenceSnapshotId: (useNewerResearch && newerResearchAvailable ? activeResearchSnapshotId : selectedVersion.evidenceSnapshotId)! } : {}),
        model: modelFromOption(selectedModelOption),
        reasoningEffort: effectiveEffort,
        allowance: { maxModelCalls: 2, maxMinutes: 2 },
        ...(branchFromEarlier ? { branchFromEarlier: true } : {}),
      });
      if (text === draft.trim()) draft = "";
      useNewerResearch = false;
      replyToTurnId = null;
      retryParentTurnId = undefined;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "The follow-up could not be sent. Your draft is still here.";
    } finally {
      sending = false;
    }
  }

  async function retryTurn(turn: ConversationView["turns"][number], edit: boolean) {
    const fixedExplanation = turn.intent === "explain" && turn.userText === EXPLAIN_IDEA_PROMPT;
    draft = fixedExplanation ? (edit ? "Explain this idea" : "") : turn.userText;
    intent = turn.intent === "explain" ? "explore-directions" : turn.intent;
    replyToTurnId = null;
    retryParentTurnId = turn.parentTurnId;
    selectedVersionId = turn.baseSolutionId;
    mobilePane = "conversation";
    error = null;
    if (!edit) { await tick(); await submit(turn.userText, turn.intent); }
    document.getElementById("idea-follow-up-draft")?.focus();
  }
</script>

<section class="idea-conversation" aria-label="Idea versions and conversation">
  <div class="mobile-tabs" role="tablist" aria-label="Idea workspace">
    <button role="tab" aria-selected={mobilePane === "idea"} onclick={() => mobilePane = "idea"}>Idea</button>
    <button role="tab" aria-selected={mobilePane === "conversation"} onclick={() => mobilePane = "conversation"}>Conversation</button>
  </div>
  <div class="columns">
    <section class:mobile-hidden={mobilePane !== "idea"} class="version-panel" aria-label="Idea">
      {#if selectedVersion}
        <h2>{ideaContent(selectedVersion.description).name}</h2>
        {#if ideaContent(selectedVersion.description).summary}<p class="lead">{ideaContent(selectedVersion.description).summary}</p>{/if}
        <IdeaMechanism mechanism={selectedVersion.mechanism} />
      {/if}
      <h3>Version history</h3>
      <ol class="versions">
        {#each conversation.versions as version (version.solutionId)}
          <li><button aria-label={`v${version.versionNumber} ${ideaContent(version.description).name}`} class:selected={version.solutionId === selectedVersionId} aria-current={version.solutionId === selectedVersionId ? "true" : undefined} onclick={() => selectVersion(version.solutionId)}>
            <span class="version-title"><strong>v{version.versionNumber}</strong><span>{ideaContent(version.description).name}</span></span>
            {#if version.changeSummary}<span class="change-summary">{version.changeSummary}</span>{/if}
          </button></li>
        {/each}
      </ol>
      {#if parentVersion && selectedVersion}
        <details class="version-comparison"><summary>Compare with v{parentVersion.versionNumber}</summary>
          {#if changedFields.includes("How it works")}<div><IdeaMechanism heading="How it worked before" mechanism={parentVersion.mechanism} /><IdeaMechanism heading="How it works now" mechanism={selectedVersion.mechanism} /></div>{/if}
          {#if changedFields.includes("Description")}<div><h4>Description before</h4><p>{parentVersion.description}</p><h4>Description now</h4><p>{selectedVersion.description}</p></div>{/if}
        </details>
      {/if}
    </section>

    <section class:mobile-hidden={mobilePane !== "conversation"} class="conversation-panel" aria-label="Idea conversation">
      <h2>Conversation</h2>
      {#if conversation.branches.length > 1}
        <label class="branch-picker">Branch
          <select value={branchId ?? ""} disabled={controlsBusy} onchange={(event) => { selectedBranchId = event.currentTarget.value; replyToTurnId = null; retryParentTurnId = undefined; }}>
            {#each conversation.branches as item, index (item.branchId)}<option value={item.branchId}>Branch {index + 1} · {item.turnCount} turns</option>{/each}
          </select>
        </label>
      {/if}
      <div class="turns" aria-live="polite">
        {#each visibleTurns as turn (turn.id)}
          <article class="turn">
            <div class="message user"><p>{turn.intent === "explain" && turn.userText === EXPLAIN_IDEA_PROMPT ? "Explain this idea" : turn.userText}</p></div>
            {#if turn.assistant}
              <div class="message assistant"><p>{turn.assistant.text}</p>
                {#if turn.assistant.citedEvidenceIds.length}<p class="citations">Evidence: {turn.assistant.citedEvidenceIds.join(", ")}</p>{/if}
                {#if turn.assistant.assumptions.length}<details><summary>Assumptions</summary><ul>{#each turn.assistant.assumptions as assumption, index (index)}<li>{assumption}</li>{/each}</ul></details>{/if}
              </div>
            {:else if turn.state === "pending" || turn.state === "running"}
              <p class="turn-state" role="status">{turn.state === "pending" ? "Waiting to start" : "Preparing a reply"}</p>
            {:else}<div class="turn-error"><p>{turn.error ?? "This turn did not complete."}</p><button disabled={controlsBusy} onclick={() => retryTurn(turn, false)}>Retry</button><button disabled={controlsBusy} onclick={() => retryTurn(turn, true)}>Edit and retry</button></div>{/if}
            <button class="reply-here" disabled={controlsBusy} onclick={() => { replyToTurnId = turn.id; retryParentTurnId = undefined; mobilePane = "conversation"; }}>Reply from here</button>
          </article>
        {/each}
        {#if runBusy && run && onStop}<AnalysisProgress {run} {elapsed} stage={runStage} {onStop} {busy} />
        {:else if analysisError}<div class="analysis-error" role="alert"><p>{analysisError}</p><button disabled={!canAnalyze} onclick={analyze}>Retry</button></div>
        {:else if detail?.decisionAnalysis}<RiskAnalysis analysis={detail.decisionAnalysis} />{/if}
      </div>
      {#if conversation.nextCursor && onLoadMore}<button class="load-more" onclick={() => onLoadMore?.(conversation.nextCursor!)}>Load more turns</button>{/if}
      <div class="composer" class:analysis-running={runBusy && !!onStop}>
        <div class="one-click-actions">
          <button disabled={!canAct} onclick={() => submit(EXPLAIN_IDEA_PROMPT, "explain")}>Explain</button>
          {#if analysisAvailable && !detail?.decisionAnalysis && !analysisError}<button disabled={!canAnalyze} onclick={analyze}>Analyze risks</button>{/if}
        </div>
        {#if detailError}<div class="error" role="alert">{detailError} <button onclick={() => refreshDetail(selectedVersionId, selectedSummary)}>Retry details</button></div>{/if}
        {#if retryParentTurnId !== undefined}<div class="reply-context">Retrying from before the failed turn <button onclick={() => { retryParentTurnId = undefined; replyToTurnId = null; }}>Use latest</button></div>
        {:else if replyToTurnId}<div class="reply-context">{replyToTurnId !== branch?.headTurnId ? "Replying from an earlier turn" : "Replying to the latest turn"} <button onclick={() => replyToTurnId = null}>Use latest</button></div>{/if}
        <label for="idea-follow-up-draft" class="visually-hidden">Follow-up message</label>
        <textarea id="idea-follow-up-draft" bind:value={draft} disabled={controlsBusy} maxlength="4000" rows="3" placeholder="Ask a follow-up…"></textarea>
        {#if newerResearchAvailable}<label class="research-choice"><input type="checkbox" bind:checked={useNewerResearch} disabled={controlsBusy} /><span>Use newer research</span></label>{/if}
        <div class="send-controls">
          <div class="intent-buttons" role="group" aria-label="Follow-up intent">
            <button disabled={controlsBusy} class:active={intent === "explore-directions"} aria-pressed={intent === "explore-directions"} onclick={() => intent = "explore-directions"}>Explore directions</button>
            <button disabled={controlsBusy} class:active={intent === "rethink"} aria-pressed={intent === "rethink"} onclick={() => intent = "rethink"}>Rethink</button>
          </div>
          <div class="model-control"><ModelPicker label="Model" options={modelOptions} value={effectiveModelKey ?? ""} disabled={controlsBusy} missingLabel="Choose a model" onchange={(key) => { modelKey = key; effort = null; }} /></div>
          <select aria-label="Effort" value={effectiveEffort} onchange={(event) => effort = event.currentTarget.value} disabled={controlsBusy || !selectedModelOption}>
            {#each selectedModelOption?.reasoningEfforts ?? [] as choice (choice.id)}<option value={choice.id}>{choice.id.charAt(0).toUpperCase() + choice.id.slice(1)}</option>{/each}
          </select>
          <button class="send" disabled={!canSend} onclick={() => submit()}>{sending ? "Sending…" : "Send"}</button>
        </div>
        {#if error}<p class="error" role="alert">{error}</p>{/if}
      </div>
    </section>
  </div>
</section>

<style>
  .idea-conversation { color:var(--text);background:var(--bg);min-width:0; }
  .columns { display:grid;grid-template-columns:minmax(0,.9fr) minmax(0,1.1fr);gap:40px; }
  .version-panel,.conversation-panel { min-width:0; }
  .version-panel { padding-right:32px;border-right:1px solid var(--border); }
  h2 { margin:0 0 24px;font-size:24px;font-weight:600;letter-spacing:-.025em;line-height:1.4; }
  h3 { margin:30px 0 14px;font-size:17px;font-weight:600; }h4 { margin:20px 0 8px;font-size:15px;font-weight:600; }
  .lead,p { font-size:15px;line-height:1.6;max-width:68ch;white-space:pre-wrap;overflow-wrap:anywhere; }
  .lead { margin:0;color:var(--text); }
  .versions { list-style:none;padding:0;margin:0; }
  .versions li + li { border-top:1px solid var(--border); }
  .versions button { display:block;width:100%;padding:14px 10px;text-align:left;border:0;border-radius:5px;background:transparent;color:var(--text);font-size:15px;cursor:pointer; }
  .versions button.selected,.versions button:hover,.versions button:focus-visible { background:var(--surface-2); }
  .version-title { display:flex;gap:12px;line-height:1.6; }.version-title strong { flex:none;color:var(--muted);font-weight:500; }
  .change-summary { display:block;margin:6px 0 0 30px;font-size:14px;color:var(--muted);line-height:1.6; }
  .version-comparison { margin-top:20px;padding-top:16px;border-top:1px solid var(--border); }
  summary { color:var(--text);cursor:pointer;font-size:15px;line-height:1.6; }
  .version-comparison p { margin:8px 0; }
  .turns { display:grid;gap:24px; }
  .message { padding:18px 20px;border-radius:10px;max-width:68ch; }
  .message.user { width:fit-content;max-width:80%;margin:0 0 12px auto;background:var(--surface-2); }
  .message.assistant { margin:0 32px 0 0;background:var(--surface); }
  .message p { margin:0;font-size:15px;line-height:1.6; }
  .message .citations { margin-top:12px;color:var(--muted);font-size:13px; }
  .message details { margin-top:18px; }.message ul { list-style:disc;padding-left:22px;font-size:15px;line-height:1.6; }
  .turn-state,.turn-error,.analysis-error { color:var(--muted);font-size:15px;line-height:1.6; }
  .turn-error,.analysis-error { border-left:2px solid var(--danger);padding-left:16px; }
  .reply-here,.load-more,.reply-context button { color:var(--muted);background:transparent;border:0;padding:8px 0;font-size:13px;cursor:pointer; }
  .reply-here:hover,.load-more:hover,.reply-context button:hover { color:var(--text); }
  .composer { border-top:1px solid var(--border);margin-top:28px;padding-top:20px; }
  .composer.analysis-running { border-top:0; }
  .one-click-actions { display:flex;gap:10px;margin-bottom:16px; }
  button { cursor:pointer; }button:disabled { opacity:.45;cursor:default; }
  .one-click-actions button,.turn-error button,.analysis-error button,.error button { background:transparent;border:1px solid var(--border-strong);border-radius:7px;padding:8px 14px;color:var(--text);font-size:13px; }
  .one-click-actions button:hover:not(:disabled) { background:var(--surface-2); }
  textarea { width:100%;min-height:100px;background:var(--surface);border:1px solid var(--border-strong);border-radius:8px;padding:14px;color:var(--text);font-size:15px;line-height:1.6;resize:vertical; }
  textarea::placeholder { color:var(--muted); }
  .research-choice { display:flex;align-items:center;gap:10px;margin:14px 0;color:var(--text);font-size:13px; }
  .research-choice input { width:16px;height:16px;accent-color:var(--accent); }
  .send-controls { display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:12px; }
  .intent-buttons { display:flex;border:1px solid var(--border-strong);border-radius:7px;overflow:hidden; }
  .intent-buttons button { background:transparent;border:0;padding:8px 10px;color:var(--muted);font-size:13px;white-space:nowrap; }
  .intent-buttons button.active { color:var(--text);background:var(--surface-2); }
  .model-control { max-width:190px;min-width:140px; }
  .model-control :global(.trigger) { min-height:36px;font-size:13px; }
  .send-controls select,.branch-picker select { min-height:36px;background:var(--surface);border:1px solid var(--border-strong);border-radius:7px;color:var(--text);padding:7px 10px;font-size:13px; }
  .send { margin-left:auto;min-height:36px;padding:8px 16px;background:var(--accent);border:0;border-radius:7px;color:var(--accent-ink);font-weight:600;font-size:13px; }
  .branch-picker { display:flex;align-items:center;gap:10px;margin:0 0 20px;color:var(--muted);font-size:13px; }
  .error { color:var(--danger);font-size:15px;line-height:1.6; }.reply-context { color:var(--muted);font-size:13px;margin-bottom:12px; }
  .reply-context button { margin-left:8px; }
  .mobile-tabs { display:none; }.visually-hidden { position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap; }
  @container page (max-width:800px) { .columns { gap:24px; }.version-panel { padding-right:24px; } }
  @container page (max-width:800px) { .columns { display:block; }.version-panel { border-right:0;padding-right:0; }.mobile-tabs { display:flex;gap:24px;border-bottom:1px solid var(--border);margin-bottom:24px; }.mobile-tabs button { min-height:44px;padding:0 4px;background:transparent;border:0;color:var(--muted);font-size:15px; }.mobile-tabs button[aria-selected="true"] { color:var(--text);border-bottom:2px solid var(--text); }.mobile-hidden { display:none; } }
</style>
