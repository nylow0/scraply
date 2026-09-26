<script lang="ts">
  import type { IdeaConversation as ConversationView, SubmitIdeaTurnRequest } from "../../shared/workflow-contracts";
  import type { ModelOption, ModelRef } from "../../shared/schemas";
  import { modelDisplayName } from "../lib/research-defaults";

  type Draft = Omit<SubmitIdeaTurnRequest, "threadId" | "rootSolutionId">;

  let {
    conversation,
    modelOptions,
    activeResearchSnapshotId = null,
    busy = false,
    busyReason = "Wait for the current work to finish before sending a follow-up.",
    onSubmit,
    onSelectVersion,
    onViewVersion,
    onLoadMore,
  }: {
    conversation: ConversationView;
    modelOptions: ModelOption[];
    activeResearchSnapshotId?: string | null;
    busy?: boolean;
    busyReason?: string;
    onSubmit: (draft: Draft) => Promise<void>;
    onSelectVersion?: (solutionId: string) => Promise<void>;
    onViewVersion?: (solutionId: string) => Promise<void>;
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
  let versionError = $state<string | null>(null);

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
  let canSend = $derived(!busy && !sending && !!selectedVersion && !!selectedModelOption && !!effectiveEffort && draft.trim().length > 0 && draft.trim().length <= 4_000);

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
    versionError = null;
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
  function versionTitle(text: string): string {
    const firstLine = text.trim().split(/\n/)[0] ?? "";
    const lead = firstLine.match(/^.{1,110}?(?=[:,;]\s)/s)?.[0];
    if (lead) return lead.trim();
    const sentence = firstLine.match(/^.*?[.!?](?=\s|$)/s)?.[0];
    if (sentence && sentence.length <= 110) return sentence.trim();
    if (firstLine.length <= 110) return firstLine;
    const words = firstLine.slice(0, 110).trimEnd();
    return `${words.slice(0, words.lastIndexOf(" "))}…`;
  }

  async function submit() {
    if (!canSend || !selectedVersion || !selectedModelOption) return;
    error = null;
    sending = true;
    const text = draft.trim();
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
        intent,
        text,
        ...((useNewerResearch && newerResearchAvailable ? activeResearchSnapshotId : selectedVersion.evidenceSnapshotId)
          ? { evidenceSnapshotId: (useNewerResearch && newerResearchAvailable ? activeResearchSnapshotId : selectedVersion.evidenceSnapshotId)! } : {}),
        model: modelFromOption(selectedModelOption),
        reasoningEffort: effectiveEffort,
        allowance: { maxModelCalls: 2, maxMinutes: 2 },
        ...(branchFromEarlier ? { branchFromEarlier: true } : {}),
      });
      draft = "";
      useNewerResearch = false;
      replyToTurnId = null;
      retryParentTurnId = undefined;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "The follow-up could not be sent. Your draft is still here.";
    } finally {
      sending = false;
    }
  }

  function retryTurn(turn: ConversationView["turns"][number], edit: boolean) {
    draft = turn.userText;
    intent = turn.intent;
    replyToTurnId = null;
    retryParentTurnId = turn.parentTurnId;
    selectedVersionId = turn.baseSolutionId;
    mobilePane = "conversation";
    error = edit ? "Edit the message, then send it as a new turn. The failed turn stays in history." : null;
    document.getElementById("idea-follow-up-draft")?.focus();
  }
</script>

<section class="idea-conversation" aria-label="Idea versions and conversation">
  <div class="mobile-tabs" role="tablist" aria-label="Idea workspace">
    <button role="tab" aria-selected={mobilePane === "idea"} onclick={() => mobilePane = "idea"}>Idea</button>
    <button role="tab" aria-selected={mobilePane === "conversation"} onclick={() => mobilePane = "conversation"}>Conversation</button>
  </div>

  <div class="columns">
    <section class:mobile-hidden={mobilePane !== "idea"} class="version-panel" aria-label="Selected idea version">
      <!-- Same eyebrow-and-title structure as the conversation column, so both headings sit on one line. -->
      <div class="panel-heading"><div><span class="eyebrow">Selected idea version</span><h2>Idea v{selectedVersion?.versionNumber ?? 1}</h2></div></div>
      {#if selectedVersion}
        <h3>How it works</h3><p class="description">{selectedVersion.mechanism}</p>
        <h3>What it does</h3><p class="description">{selectedVersion.description}</p>
        {#if onViewVersion}<button class="full-version" onclick={async () => {
          versionError = null;
          try { await onViewVersion(selectedVersion.solutionId); }
          catch (cause) { versionError = cause instanceof Error ? cause.message : "Could not open the full idea."; }
        }}>View full idea details</button>{/if}
        {#if versionError}<p class="error" role="alert">{versionError}</p>{/if}
        <div class="review-chip" class:current={selectedVersion.reviewFreshness === "current"}>
          {selectedVersion.reviewFreshness === "current" ? "Review applies to this version" : selectedVersion.reviewFreshness === "stale" ? "Review belongs to an earlier version" : "This version has not been reviewed"}
        </div>
      {/if}

      <h3>Version history</h3>
      <ol class="versions">
        {#each conversation.versions as version (version.solutionId)}
          <li>
            <button class:selected={version.solutionId === selectedVersionId} aria-current={version.solutionId === selectedVersionId ? "true" : undefined} onclick={() => selectVersion(version.solutionId)}>
              <span class="version-title"><strong>v{version.versionNumber}</strong> {versionTitle(version.mechanism)}</span>
              <small>{version.changeSummary ?? "Original mechanism"}</small>
            </button>
          </li>
        {/each}
      </ol>
      {#if selectedVersion?.parentSolutionId}
        <p class="lineage">Based on v{conversation.versions.find((item) => item.solutionId === selectedVersion?.parentSolutionId)?.versionNumber ?? "?"}. Its earlier review and conversation remain in history.</p>
        {#if parentVersion}
          <details class="version-comparison"><summary>Compare with v{parentVersion.versionNumber}</summary>
            <p>{selectedVersion.changeSummary ?? "This version changes the saved idea."}</p>
            <p>{changedFields.length ? `Changed: ${changedFields.join(" and ")}.` : "The explanation is unchanged."}</p>
            {#if changedFields.includes("How it works")}<div><strong>Earlier mechanism</strong><p>{parentVersion.mechanism}</p><strong>Current mechanism</strong><p>{selectedVersion.mechanism}</p></div>{/if}
            {#if changedFields.includes("Description")}<div><strong>Earlier description</strong><p>{parentVersion.description}</p><strong>Current description</strong><p>{selectedVersion.description}</p></div>{/if}
          </details>
        {/if}
      {/if}
    </section>

    <section class:mobile-hidden={mobilePane !== "conversation"} class="conversation-panel" aria-label="Idea conversation">
      <div class="panel-heading"><div><span class="eyebrow">Explore this idea</span><h2>Conversation</h2></div><span class="context-label">Using v{selectedVersion?.versionNumber ?? 1}</span></div>
      {#if conversation.branches.length > 1}
        <label class="branch-picker">Branch
          <select value={branchId ?? ""} onchange={(event) => { selectedBranchId = event.currentTarget.value; replyToTurnId = null; retryParentTurnId = undefined; }}>
            {#each conversation.branches as item, index (item.branchId)}<option value={item.branchId}>Branch {index + 1} · {item.turnCount} turns</option>{/each}
          </select>
        </label>
      {/if}
      <div class="turns" aria-live="polite">
        {#if visibleTurns.length === 0}<p class="empty">Ask why this idea might work, explore another direction, or rethink it using the saved research.</p>{/if}
        {#each visibleTurns as turn (turn.id)}
          <article class="turn">
            <div class="message user"><span class="message-label">You · v{conversation.versions.find((version) => version.solutionId === turn.baseSolutionId)?.versionNumber ?? "?"}</span><p>{turn.userText}</p></div>
            {#if turn.assistant}
              <div class="message assistant"><span class="message-label">Assistant</span><p>{turn.assistant.text}</p>
                {#if turn.assistant.citedEvidenceIds.length}<p class="citations">Evidence: {turn.assistant.citedEvidenceIds.join(", ")}</p>{/if}
                {#if turn.assistant.assumptions.length}<details><summary>Assumptions</summary><ul>{#each turn.assistant.assumptions as assumption, index (index)}<li>{assumption}</li>{/each}</ul></details>{/if}
                {#if turn.assistant.generatedSolutionId}<p class="new-version">A new version was saved. Its risk review is still pending.</p>{/if}
              </div>
            {:else if turn.state === "pending" || turn.state === "running"}
              <p class="turn-state" role="status">{turn.state === "pending" ? "Waiting to start" : "Preparing a reply"}</p>
            {:else}<div class="turn-error"><p>{turn.error ?? "This turn did not complete."}</p><button onclick={() => retryTurn(turn, false)}>Retry</button><button onclick={() => retryTurn(turn, true)}>Edit and retry</button></div>{/if}
            <button class="reply-here" onclick={() => { replyToTurnId = turn.id; retryParentTurnId = undefined; mobilePane = "conversation"; }}>Reply from here</button>
          </article>
        {/each}
      </div>
      {#if conversation.nextCursor && onLoadMore}<button class="load-more" onclick={() => onLoadMore?.(conversation.nextCursor!)}>Load more turns</button>{/if}
      <div class="composer">
        <div class="intent-buttons" role="group" aria-label="Follow-up intent">
          <button class:active={intent === "explain"} aria-pressed={intent === "explain"} onclick={() => intent = "explain"}>Explain</button>
          <button class:active={intent === "explore-directions"} aria-pressed={intent === "explore-directions"} onclick={() => intent = "explore-directions"}>Explore directions</button>
          <button class:active={intent === "rethink"} aria-pressed={intent === "rethink"} onclick={() => intent = "rethink"}>Rethink</button>
        </div>
        {#if retryParentTurnId !== undefined}<div class="reply-context">Retrying creates a new branch before the failed turn. <button onclick={() => { retryParentTurnId = undefined; replyToTurnId = null; }}>Use latest</button></div>
        {:else if replyToTurnId}<div class="reply-context">{replyToTurnId !== branch?.headTurnId ? "Replying from an earlier turn creates a branch." : "Replying to the latest turn."} <button onclick={() => replyToTurnId = null}>Use latest</button></div>{/if}
        <label for="idea-follow-up-draft" class="visually-hidden">Follow-up message</label>
        <textarea id="idea-follow-up-draft" bind:value={draft} maxlength="4000" rows="3" placeholder="Write a follow-up…"></textarea>
        {#if newerResearchAvailable}<label class="research-choice"><input type="checkbox" bind:checked={useNewerResearch} /><span><strong>Use newer research</strong><small>Use the current research snapshot for this reply. The saved idea and earlier versions stay as they are.</small></span></label>{/if}
        <div class="send-controls">
          <label>Model
            <select value={effectiveModelKey ?? ""} onchange={(event) => { modelKey = event.currentTarget.value || null; effort = null; }}>
              {#if !selectedModelOption}<option value="">Choose an available model</option>{/if}
              {#each modelOptions as option (`${option.providerId}:${option.modelId}`)}<option value={`${option.providerId}:${option.modelId}`}>{modelDisplayName(option)}</option>{/each}
            </select>
          </label>
          <label>Effort
            <select value={effectiveEffort} onchange={(event) => effort = event.currentTarget.value} disabled={!selectedModelOption}>
              {#each selectedModelOption?.reasoningEfforts ?? [] as choice (choice.id)}<option value={choice.id}>{choice.id.charAt(0).toUpperCase() + choice.id.slice(1)}</option>{/each}
            </select>
          </label>
          <button class="send" disabled={!canSend} onclick={submit}>{sending ? "Sending…" : "Send follow-up"}</button>
        </div>
        {#if originalModel && !selectedModelOption}<p class="notice" role="status">The model used for this version is unavailable. Choose another model for new work.</p>{/if}
        {#if busy}<p class="notice" role="status">{busyReason}</p>{/if}
        {#if error}<p class="error" role="alert">{error}</p>{/if}
        <p class="allowance">Uses saved research. Up to two model calls; no new search.</p>
      </div>
    </section>
  </div>
</section>

<style>
  .idea-conversation { background:#000;color:var(--text);border:1px solid var(--border);border-radius:14px;overflow:hidden; }
  .columns { display:grid;grid-template-columns:minmax(0,.9fr) minmax(0,1.1fr); }
  .version-panel,.conversation-panel { min-width:0;padding:24px; }
  .version-panel { border-right:1px solid var(--border); }
  .panel-heading { display:flex;align-items:start;justify-content:space-between;gap:14px;margin-bottom:14px; }
  .eyebrow { color:var(--muted);font-size:12px;font-weight:600; }
  .context-label { color:var(--subtle);font-size:12px;font-family:var(--sans); }
  h2 { margin:3px 0 10px;font-size:19px;letter-spacing:-.025em;line-height:1.3; }
  h3 { margin:28px 0 12px;font-size:13px;color:var(--muted);font-weight:600; }
  .description,.lineage { color:var(--muted);line-height:1.65;white-space:pre-wrap; }
  /* The button and its review chip share one row, so both use the small control size and centre on the same line. */
  .full-version { margin:14px 8px 0 0;padding:6px 10px;border:1px solid var(--border);border-radius:7px;background:var(--surface);color:var(--accent);font-size:12px;vertical-align:middle; }
  .review-chip { display:inline-block;vertical-align:middle;margin-top:14px;padding:6px 9px;border:1px solid #b9864566;border-radius:6px;color:#e4b46f;font-size:11px; }
  .review-chip.current { border-color:#bdbdbd66;color:var(--accent); }
  .versions { list-style:none;padding:0;margin:0;display:grid;gap:7px; }
  .versions button { display:block;width:100%;padding:12px;text-align:left;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text); }
  .versions button.selected { border-color:#bdbdbd77;background:rgb(255 255 255 / .05); }
  .version-title { display:block;line-height:1.4; }
  .version-title strong { color:var(--accent);margin-right:7px; }
  .versions small { display:block;margin-top:5px;color:var(--subtle);line-height:1.4; }
  .lineage { margin:14px 0 0;font-size:12px; }
  .version-comparison { margin-top:18px;padding-top:14px;border-top:1px solid var(--border);color:var(--muted);font-size:13px; }
  .version-comparison summary { color:var(--text);cursor:pointer;font-weight:600; }
  .version-comparison p { white-space:pre-wrap;line-height:1.55;overflow-wrap:anywhere; }
  .version-comparison div { margin-top:15px;padding-top:12px;border-top:1px solid var(--border); }
  .version-comparison strong { display:block;color:var(--text);font-size:12px; }
  .turns { display:grid;gap:18px;margin-top:16px;max-height:550px;overflow:auto; }
  .empty { color:var(--muted);padding:30px 0;line-height:1.6; }
  .turn { border-top:1px solid var(--border);padding-top:17px; }
  .message { padding:12px 14px;border:1px solid var(--border);border-radius:9px;margin-bottom:8px; }
  .message.user { margin-left:24px;background:rgb(255 255 255 / .05); }
  .message.assistant { margin-right:24px;background:var(--surface); }
  .message p { margin:6px 0 0;white-space:pre-wrap;line-height:1.6;overflow-wrap:anywhere; }
  .message-label,.citations { color:var(--subtle);font-size:11px; }
  .message details { margin-top:12px;font-size:12px;color:var(--muted); }
  .message ul { padding-left:18px; }
  .new-version { color:var(--accent);font-size:12px; }
  .turn-state,.turn-error { color:var(--muted);font-size:12px; }
  .turn-error { border:1px solid #a45d5d66;padding:12px;border-radius:8px; }
  .turn-error button,.reply-here,.load-more,.reply-context button { color:var(--accent);background:transparent;border:0;padding:4px 7px 4px 0;font-size:12px; }
  .reply-here { color:var(--subtle); }
  .composer { border-top:1px solid var(--border);margin-top:20px;padding-top:18px; }
  .intent-buttons { display:flex;gap:7px;flex-wrap:wrap;margin-bottom:12px; }
  .intent-buttons button { background:transparent;border:1px solid var(--border);border-radius:7px;padding:7px 10px;color:var(--muted);font-size:12px; }
  .intent-buttons button.active { border-color:#bdbdbd77;color:var(--accent);background:rgb(255 255 255 / .05); }
  textarea { width:100%;min-height:88px;background:var(--surface);border:1px solid var(--border-strong);border-radius:8px;padding:11px;color:var(--text); }
  .research-choice { display:flex;align-items:flex-start;gap:10px;margin:11px 0;padding:11px 12px;border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;cursor:pointer; }
  .research-choice input { width:16px;height:16px;accent-color:var(--accent);margin:2px 0 0;flex:none; }
  .research-choice span { display:grid;gap:3px; }.research-choice small { color:var(--muted);font-size:12px;line-height:1.45; }
  .send-controls { display:flex;align-items:end;gap:10px;flex-wrap:wrap;margin-top:10px; }
  .send-controls label,.branch-picker { display:grid;gap:4px;color:var(--subtle);font-size:11px; }
  .send-controls select,.branch-picker select { max-width:210px;min-height:34px;background:var(--surface);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:5px 7px; }
  .send { margin-left:auto;min-height:34px;padding:7px 11px;background:var(--accent);border:1px solid var(--accent);border-radius:7px;color:var(--accent-ink);font-weight:650;font-size:12px; }
  .send:disabled { opacity:.48; }
  .notice,.error,.allowance,.reply-context { font-size:12px;line-height:1.5; }
  .notice { color:#e4b46f; }.error { color:var(--danger); }.allowance { color:var(--subtle);margin-bottom:0; }.reply-context { color:var(--muted);margin-bottom:9px; }
  .mobile-tabs { display:none; }.visually-hidden { position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap; }
  @container page (max-width:640px) { .columns { display:block; }.version-panel { border-right:0; }.mobile-tabs { display:grid;grid-template-columns:1fr 1fr;border-bottom:1px solid var(--border); }.mobile-tabs button { min-height:44px;background:#000;border:0;color:var(--muted); }.mobile-tabs button[aria-selected="true"] { color:var(--accent);border-bottom:2px solid var(--accent); }.mobile-hidden { display:none; }.version-panel,.conversation-panel { padding:18px; }.send { margin-left:0; } }
</style>
