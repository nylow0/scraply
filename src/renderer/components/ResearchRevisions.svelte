<script lang="ts">
  import type {
    ResearchFindingView, ResearchReplacement, ResearchRequestDraft, ResearchRequestKind,
    ResearchRequestView,
  } from "../../shared/research-revisions";
  import { previewResearchAngles, researchSearchAllocation } from "../../shared/research-revisions";
  import { modelRefKey, type ModelOption, type ModelRef } from "../../shared/schemas";
  import { modelDisplayName } from "../lib/research-defaults";
  import { verdictLabel } from "../lib/status";
  import { untrack } from "svelte";

  let {
    requests, findings, activeSnapshotId, modelOptions, researchModel, researchReasoningEffort,
    busy, readOnly = false, onRequest, onApply, onKeep, onOpenSource,
  }: {
    requests: ResearchRequestView[];
    findings: ResearchFindingView[];
    activeSnapshotId: string | null;
    modelOptions: ModelOption[];
    researchModel: ModelRef | null;
    researchReasoningEffort: string;
    busy: boolean;
    readOnly?: boolean;
    onRequest: (draft: ResearchRequestDraft & {
      model: ModelRef; reasoningEffort: string; baseSnapshotId: string | null;
    }) => Promise<void>;
    onApply: (baseSnapshotId: string | null, includedRequestIds: string[], replacements: ResearchReplacement[]) => Promise<void>;
    onKeep: (requestId: string, baseSnapshotId: string | null) => Promise<void>;
    onOpenSource: (url: string) => Promise<void>;
  } = $props();

  const availableModels = $derived(modelOptions.filter((item) => item.providerId === "openai-subscription"));
  const initialResearchModel = untrack(() => researchModel);
  let modelKey = $state(initialResearchModel ? modelRefKey(initialResearchModel) : "");
  let selectedModel = $derived(availableModels.find((item) => modelRefKey(item) === modelKey));
  let reasoningEffort = $state(untrack(() => researchReasoningEffort));
  let drafting = $state(false);
  let kind = $state<ResearchRequestKind>("new-question");
  let targetFindingId = $state("");
  let targetRequestId = $state("");
  let question = $state("");
  let anglesText = $state("");
  let instructionsText = $state("");
  let maxModelCalls = $state(12);
  let maxSearches = $state(10);
  let maxMinutes = $state(10);
  let submitting = $state(false);
  let applying = $state(false);
  let keeping = $state(false);
  let localError = $state("");
  let selectedRequestId = $state<string | null>(null);
  let includedIds = $state<string[]>([]);
  let chosenReplacements = $state<Record<string, string>>({});
  let selectedRequest = $derived(requests.find((item) => item.id === selectedRequestId) ?? null);
  let enteredAngles = $derived(anglesText.split("\n").map((angle) => angle.trim()).filter(Boolean));
  let anglePreview = $derived(previewResearchAngles(kind, enteredAngles,
    { maxSearches: kind === "reevaluate" ? 0 : maxSearches }));
  let minimumModelCalls = $derived(kind === "reevaluate" ? 1 : researchSearchAllocation(maxSearches).modelCalls);
  let includedRequests = $derived(requests.filter((item) => !item.archived && !item.reviewDecision && includedIds.includes(item.id)));
  let pendingCount = $derived(requests.filter((item) => !item.archived && item.status === "completed" && !item.appliedSnapshotId && !item.reviewDecision).length);
  let missingReplacement = $derived(includedRequests.some((item) =>
    item.kind !== "new-question" && (!item.targetFindingId || !chosenReplacements[item.id])));
  let canApply = $derived(includedRequests.length > 0 && !missingReplacement && !busy && !applying && !keeping);

  function chooseKind(next: ResearchRequestKind) {
    kind = next;
    if (next === "reevaluate") { maxSearches = 0; maxModelCalls = 1; }
    else { if (maxSearches === 0) maxSearches = 10; if (maxModelCalls === 1) maxModelCalls = 12; }
    localError = "";
  }

  function chooseModel() {
    reasoningEffort = selectedModel?.defaultReasoningEffort ?? researchReasoningEffort;
  }

  function startRedo(finding: ResearchFindingView, next: ResearchRequestKind) {
    targetFindingId = finding.id;
    question = next === "redo"
      ? `Find new evidence about: ${finding.statement}`
      : `Reevaluate the saved evidence for: ${finding.statement}`;
    chooseKind(next);
    drafting = true;
  }

  function toggleIncluded(id: string) {
    includedIds = includedIds.includes(id) ? includedIds.filter((item) => item !== id) : [...includedIds, id];
  }

  async function submitRequest() {
    localError = "";
    if (!selectedModel) { localError = "Choose an available research model."; return; }
    if (!question.trim()) { localError = "Enter what this request should investigate."; return; }
    if (kind !== "new-question" && !targetFindingId) { localError = "Choose a finding to revisit."; return; }
    const angles = enteredAngles;
    if (angles.length > 4) { localError = "Use no more than four research angles."; return; }
    if (kind !== "reevaluate" && maxSearches < 2) { localError = "Reserve at least two searches to investigate a new question."; return; }
    if (maxModelCalls < minimumModelCalls) { localError = `Reserve at least ${minimumModelCalls} model calls for this search plan.`; return; }
    submitting = true;
    try {
      await onRequest({
        kind, question: question.trim(),
        ...(kind === "new-question" ? {} : { targetFindingId }),
        ...(targetRequestId ? { targetRequestId } : {}),
        angles,
        ...(instructionsText.trim() ? { instructions: instructionsText.trim() } : {}),
        allowance: { maxModelCalls, maxSearches: kind === "reevaluate" ? 0 : maxSearches, maxMinutes },
        model: { providerId: selectedModel.providerId, modelId: selectedModel.modelId },
        reasoningEffort,
        baseSnapshotId: activeSnapshotId,
      });
      drafting = false;
      question = "";
      anglesText = "";
      instructionsText = "";
      targetFindingId = "";
      targetRequestId = "";
    } catch (error) {
      localError = error instanceof Error ? error.message : "The request could not be saved.";
    } finally {
      submitting = false;
    }
  }

  async function applyResults() {
    if (!canApply || readOnly) return;
    localError = "";
    const replacements: ResearchReplacement[] = [];
    for (const item of includedRequests) {
      if (item.kind === "new-question") continue;
      const newFindingId = chosenReplacements[item.id];
      if (!item.targetFindingId || !newFindingId) {
        localError = "Choose a result for each finding being replaced.";
        return;
      }
      replacements.push({ oldFindingId: item.targetFindingId, newFindingId });
    }
    applying = true;
    try {
      await onApply(activeSnapshotId, includedRequests.map((item) => item.id), replacements);
      includedIds = [];
      selectedRequestId = null;
    } catch (error) {
      localError = error instanceof Error ? error.message : "The research update could not be applied.";
    } finally {
      applying = false;
    }
  }

  async function keepCurrent(requestId: string) {
    if (busy || keeping || readOnly) return;
    localError = "";
    keeping = true;
    try {
      await onKeep(requestId, activeSnapshotId);
      includedIds = includedIds.filter((id) => id !== requestId);
      selectedRequestId = null;
    } catch (error) {
      localError = error instanceof Error ? error.message : "The review decision could not be saved.";
    } finally {
      keeping = false;
    }
  }
</script>

<section class="research-revisions" aria-label="Research revisions">
  <header class="section-header">
    <div><h2>Research requests</h2><p>{readOnly ? "Follow-up requests saved with this project." : "Ask another question or revisit a finding. Results stay separate until you use them."}</p></div>
    {#if !readOnly}<button class="add-button" type="button" disabled={busy || submitting} onclick={() => { chooseKind("new-question"); drafting = !drafting; }}>
      {drafting ? "Close request" : "Add research"}
    </button>{/if}
  </header>

  {#if pendingCount > 0}<p class="pending-note" role="status">{pendingCount} completed {pendingCount === 1 ? "result is" : "results are"} ready to review.</p>{/if}
  {#if localError}<p class="error-note" role="alert">{localError}</p>{/if}

  {#if drafting && !readOnly}
    <form class="request-form" onsubmit={(event) => { event.preventDefault(); void submitRequest(); }}>
      <div class="form-heading"><h3>What should Scraply investigate?</h3><p>This creates a saved request in this project. The current research stays active.</p></div>
      <fieldset class="request-kind"><legend>Request type</legend>
        <label class:chosen={kind === "new-question"}><input type="radio" name="request-kind" checked={kind === "new-question"} onchange={() => chooseKind("new-question")} />New question</label>
        <label class:chosen={kind === "redo"}><input type="radio" name="request-kind" checked={kind === "redo"} onchange={() => chooseKind("redo")} />Find new evidence</label>
        <label class:chosen={kind === "reevaluate"}><input type="radio" name="request-kind" checked={kind === "reevaluate"} onchange={() => chooseKind("reevaluate")} />Reevaluate saved evidence</label>
      </fieldset>
      {#if kind !== "new-question"}
        <label class="field"><span>Finding to revisit</span><select bind:value={targetFindingId} required disabled={busy}>
          <option value="">Choose a finding</option>
          {#each findings as finding (finding.id)}<option value={finding.id}>{finding.statement}</option>{/each}
        </select></label>
      {/if}
      <label class="field"><span>{kind === "new-question" ? "Research question" : "What was wrong or should change?"}</span>
        <textarea bind:value={question} rows="3" maxlength="500" required disabled={busy} placeholder={kind === "new-question" ? "What do buyers do today when this problem appears?" : "Describe the gap in the earlier finding."}></textarea>
      </label>
      <div class="field-pair">
        <label class="field"><span>Research model</span><select bind:value={modelKey} onchange={chooseModel} disabled={busy || !availableModels.length} required>
          {#if !modelKey}<option value="">Choose a model</option>{/if}
          {#each availableModels as item (modelRefKey(item))}<option value={modelRefKey(item)}>{modelDisplayName(item)}</option>{/each}
        </select></label>
        <label class="field"><span>Reasoning</span><select bind:value={reasoningEffort} disabled={busy || !selectedModel}>
          {#each selectedModel?.reasoningEfforts ?? [] as effort (effort.id)}<option value={effort.id}>{effort.id.charAt(0).toUpperCase() + effort.id.slice(1)}</option>{/each}
        </select></label>
      </div>
      <details class="advanced"><summary>Angles and work limits</summary>
        <label class="field"><span>Research angles, one per line</span><textarea bind:value={anglesText} rows="3" disabled={busy} placeholder="Buyer reports&#10;Existing alternatives&#10;Contrary evidence"></textarea><small>Up to four distinct angles inside this request.</small></label>
        <label class="field"><span>Focus on a saved request (optional)</span><select bind:value={targetRequestId} disabled={busy}>
          <option value="">No earlier request selected</option>
          {#each requests as request (request.id)}<option value={request.id}>{request.question}</option>{/each}
        </select></label>
        <label class="field"><span>Instructions for this request (optional)</span><textarea bind:value={instructionsText} rows="3" maxlength="20000" disabled={busy} placeholder="Specify a source class, buyer context, or claim to challenge."></textarea><small>Saved with this request and used only for its work.</small></label>
        <div class="allowance-grid">
          <label class="field"><span>Model calls</span><input type="number" min="1" max="100" step="1" bind:value={maxModelCalls} disabled={busy} /></label>
          <label class="field"><span>Searches</span><input type="number" min="0" max="100" step="1" bind:value={maxSearches} disabled={busy || kind === "reevaluate"} /></label>
          <label class="field"><span>Minutes</span><input type="number" min="5" max="90" step="1" bind:value={maxMinutes} disabled={busy} /></label>
        </div>
        {#if kind === "reevaluate"}<p class="quiet">Reevaluation uses only saved evidence and makes no search calls.</p>{/if}
      </details>
      <div class="angle-preview" aria-label="Research plan preview">
        <div class="preview-heading"><strong>Planned research angles</strong><span>Up to {kind === "reevaluate" ? 0 : maxSearches} searches · {maxModelCalls} model calls · {maxMinutes} minutes</span></div>
        {#each anglePreview.planned as angle (angle.name)}
          <div class="preview-row"><span class="preview-dot"></span><span><strong>{angle.name}</strong><small>{angle.sourceClass.replaceAll("-", " ")} · {angle.acceptanceCriterion}</small></span></div>
        {:else}<p class="preview-gap">The search allowance has no slot for an evidence angle.</p>{/each}
        {#if anglePreview.omitted.length > 0}
          <div class="preview-omitted"><strong>Not covered by this allowance</strong><span>{anglePreview.omitted.map((angle) => angle.name).join(", ")}</span></div>
        {/if}
      </div>
      <div class="form-actions"><span>{kind === "reevaluate" ? "0 searches" : `Up to ${maxSearches} searches`} · up to {maxModelCalls} model calls · {maxMinutes} minutes</span><button class="primary" type="submit" disabled={busy || submitting || !selectedModel}>{submitting ? "Saving request…" : "Start research request"}</button></div>
    </form>
  {/if}

  {#if requests.length === 0}
    <div class="requests-empty" role="status">
      <strong>No additional research requests</strong>
      <p>{readOnly ? "This project has no saved follow-up research." : "Add research to ask another question or revisit a finding."}</p>
    </div>
  {:else}
  <div class="revision-layout">
    <div class="request-list" aria-label="Saved research requests">
      <div class="list-heading"><strong>Saved requests</strong><span>{requests.length}</span></div>
      {#each requests as request (request.id)}
        <div class:active={selectedRequestId === request.id} class="request-row">
          <button type="button" class="request-select" onclick={() => { selectedRequestId = request.id; localError = ""; }}>
            <span class="request-name">{request.question}</span>
            <span class="request-meta">{request.kind === "new-question" ? "New question" : request.kind === "redo" ? "New evidence" : "Reevaluation"} · {request.archived ? "Earlier session" : request.appliedSnapshotId ? "Applied" : request.reviewDecision === "kept-current" ? "Kept current research" : request.status === "completed" ? "Ready to review" : request.status}</span>
          </button>
          {#if !readOnly && !request.archived && request.status === "completed" && request.resultFindings.length > 0 && !request.appliedSnapshotId && !request.reviewDecision}
            <label class="include-toggle"><input type="checkbox" checked={includedIds.includes(request.id)} disabled={busy || applying} onchange={() => toggleIncluded(request.id)} /><span>Include</span></label>
          {/if}
        </div>
      {/each}
    </div>

    <div class="request-detail">
      {#if selectedRequest}
        <div class="detail-head"><span class="status-dot" class:complete={selectedRequest.status === "completed"}></span><span>{selectedRequest.appliedSnapshotId ? "Applied research" : selectedRequest.reviewDecision === "kept-current" ? "Kept current research" : selectedRequest.status === "completed" ? "Proposed research update" : "Research request"}</span></div>
        <h3>{selectedRequest.question}</h3>
        {#if selectedRequest.angles?.length}
          <div class="angle-results" aria-label="Angle progress"><strong>Research angles</strong>
            {#each selectedRequest.angles as angle (angle.id)}
              <div class="angle-result"><div><span>{angle.name}</span><small>{angle.sourceClass.replaceAll("-", " ")}</small></div><em>{angle.status}</em>
                {#if angle.query}<p>Search: {angle.query}</p>{/if}
                {#if selectedRequest.kind === "reevaluate"}<p>Uses saved research; no new search.</p>
                {:else if angle.sourceCount !== undefined}<p>{angle.sourceCount} {angle.sourceCount === 1 ? "source" : "sources"} returned</p>{/if}
                {#if angle.sources?.length}<ul class="angle-sources">{#each angle.sources as source (source.url)}<li><button type="button" onclick={() => onOpenSource(source.url)}>{source.title}</button></li>{/each}</ul>{/if}
                {#if selectedRequest.kind !== "reevaluate" && angle.gap}<p class="gap-text">{angle.gap}</p>{/if}
              </div>
            {/each}
          </div>
        {/if}
        {#if selectedRequest.status === "failed" || selectedRequest.status === "cancelled"}
          <p class="detail-message">{selectedRequest.error ?? "This request did not produce a result."} The current research is unchanged.</p>
        {:else if selectedRequest.status !== "completed"}
          <p class="detail-message">This request is {selectedRequest.status}. Its result will appear here when complete. You can continue with the current snapshot without including it.</p>
        {:else}
          {#if selectedRequest.previousFinding}
            <div class="comparison">
              <div class="finding old"><span>Previous finding</span><h4>{selectedRequest.previousFinding.statement}</h4><p>{selectedRequest.previousFinding.verdictReason}</p><small>{verdictLabel(selectedRequest.previousFinding.verdict)}</small></div>
              <div class="finding proposed"><span>New result</span>
                {#each selectedRequest.resultFindings as finding (finding.id)}<h4>{finding.statement}</h4><p>{finding.verdictReason}</p><small>{verdictLabel(finding.verdict)}</small>{:else}<p>No finding met the evidence requirements. Current research remains unchanged.</p>{/each}
              </div>
            </div>
          {:else}
            <div class="new-findings"><span>New findings</span>{#each selectedRequest.resultFindings as finding (finding.id)}<h4>{finding.statement}</h4><p>{finding.verdictReason}</p>{:else}<p>No finding passed the evidence requirements.</p>{/each}</div>
          {/if}
          {#each selectedRequest.resultFindings as finding (finding.id)}
            <details class="evidence-detail"><summary>Evidence for {finding.statement}</summary>
              <div class="evidence-columns">
                <div><strong>Supporting sources</strong>{#each finding.supportingSources as source (source.id)}<button type="button" onclick={() => onOpenSource(source.url)}>{source.title}</button>{:else}<p>No supporting source was saved.</p>{/each}</div>
                <div><strong>Sources cited in the verdict</strong>{#each finding.verdictSources as source (source.id)}<button type="button" onclick={() => onOpenSource(source.url)}>{source.title}</button>{:else}<p>No verdict source was saved.</p>{/each}</div>
              </div>
              {#if finding.evidenceGap}<p class="gap"><strong>Remaining gap</strong> {finding.evidenceGap}</p>{/if}
            </details>
          {/each}
          {#if !readOnly && !selectedRequest.archived && !selectedRequest.appliedSnapshotId && !selectedRequest.reviewDecision}
            {#if selectedRequest.kind !== "new-question" && selectedRequest.resultFindings.length > 0}
              <label class="field replacement-select"><span>Replace the previous finding with</span><select value={chosenReplacements[selectedRequest.id] ?? ""} onchange={(event) => { chosenReplacements = { ...chosenReplacements, [selectedRequest.id]: event.currentTarget.value }; }}>
                <option value="">Choose a result</option>
                {#each selectedRequest.resultFindings as finding (finding.id)}<option value={finding.id}>{finding.statement}</option>{/each}
              </select></label>
            {/if}
            <button class="quiet-button" type="button" disabled={busy || keeping} onclick={() => void keepCurrent(selectedRequest!.id)}>{keeping ? "Saving decision…" : "Keep current research"}</button>
          {/if}
        {/if}
      {:else}
        <div class="detail-empty"><h3>Compare before you use a result.</h3><p>Select a saved request to inspect its findings, sources, and remaining gaps. The current snapshot changes only when you apply selected results.</p></div>
      {/if}
    </div>
  </div>
  {/if}

  {#if !readOnly && includedRequests.length > 0}
    <footer class="apply-bar"><p><strong>{includedRequests.length}</strong> {includedRequests.length === 1 ? "result" : "results"} selected for the next snapshot. Earlier research remains in the archive.</p><button class="primary" type="button" disabled={!canApply} onclick={applyResults}>{applying ? "Applying…" : "Use selected results"}</button></footer>
  {/if}

  {#if !readOnly && findings.length > 0}
    <details class="redo-list"><summary>Revisit a finding</summary><div>{#each findings as finding (finding.id)}<div class="redo-row"><span>{finding.statement}</span><div><button type="button" disabled={busy} onclick={() => startRedo(finding, "redo")}>Find new evidence</button><button type="button" disabled={busy} onclick={() => startRedo(finding, "reevaluate")}>Reevaluate saved evidence</button></div></div>{/each}</div></details>
  {/if}
</section>

<style>
  .research-revisions{max-width:var(--page-max);margin:0 auto;padding:26px var(--page-inline) 32px;color:var(--text)}
  .section-header{display:flex;align-items:start;justify-content:space-between;gap:24px;margin-bottom:18px}
  h2{margin:0;font-size:22px;font-weight:650;letter-spacing:-.035em}h3{font-size:17px;line-height:1.35;letter-spacing:-.025em}h4{font-size:13px;line-height:1.5}
  p{line-height:1.6}.section-header p{margin:5px 0 0;color:var(--muted);font-size:13px}
  button,select,textarea,input{font:inherit}button{cursor:pointer}button:disabled{opacity:.48;cursor:not-allowed}
  button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid var(--accent-strong);outline-offset:3px}
  .add-button,.quiet-button{min-height:36px;border:1px solid var(--border);border-radius:8px;background:transparent;color:var(--text);padding:8px 12px;font-size:13px;white-space:nowrap}
  .add-button:hover:not(:disabled),.quiet-button:hover:not(:disabled){border-color:var(--border-strong);background:var(--surface-2)}
  .pending-note,.error-note{padding:11px 14px;margin:0 0 14px;border-radius:8px;font-size:13px}
  .pending-note{background:#bdbdbd12;border:1px solid #bdbdbd30;color:var(--accent-strong)}
  .error-note{background:#b7555517;border:1px solid #d9777740;color:#f2aaaa}
  .request-form{display:grid;gap:18px;padding:22px;margin-bottom:18px;background:#000;border:1px solid var(--border-strong);border-radius:12px}
  .form-heading h3{margin:0}.form-heading p{font-size:13px;color:var(--muted);margin:5px 0 0}
  .request-kind{display:flex;flex-wrap:wrap;gap:8px;border:0;padding:0;margin:0}.request-kind legend{font-size:12px;color:var(--muted);margin-bottom:8px}
  .request-kind label{display:flex;align-items:center;gap:7px;padding:8px 11px;border:1px solid var(--border-strong);border-radius:8px;color:var(--muted);font-size:13px;cursor:pointer}
  .request-kind label.chosen{border-color:#bdbdbd70;background:#bdbdbd0e;color:var(--text)}.request-kind input{accent-color:var(--accent)}
  .field{display:grid;gap:7px;font-size:13px;color:var(--muted)}.field span{font-weight:550}.field small{font-size:12px;color:var(--subtle)}
  .field textarea,.field select,.field input{width:100%;min-height:38px;padding:10px 11px;background:var(--bg);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)}
  .field textarea{line-height:1.5}.field-pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .advanced{border-top:1px solid var(--border);padding-top:13px}.advanced summary{font-size:13px;color:var(--muted);cursor:pointer}.advanced[open]{display:grid;gap:14px}.advanced .field{margin-top:12px}
  .allowance-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.quiet{color:var(--muted);font-size:12px;margin:0}
  .angle-preview{display:grid;gap:9px;padding:14px;border:1px solid var(--border-strong);border-radius:9px;background:var(--surface)}.preview-heading{display:flex;justify-content:space-between;gap:12px;color:var(--text);font-size:12px}.preview-heading span{color:var(--muted);font-size:11px}.preview-row{display:flex;gap:10px;align-items:start;padding:7px 0;border-top:1px solid var(--border);font-size:12px}.preview-dot{width:6px;height:6px;margin-top:6px;border-radius:50%;background:var(--accent);flex:none}.preview-row strong{display:block;font-weight:600}.preview-row small{display:block;color:var(--subtle);line-height:1.45;margin-top:3px}.preview-gap,.preview-omitted{margin:0;color:var(--muted);font-size:12px}.preview-omitted{display:grid;gap:3px;padding-top:8px;border-top:1px solid var(--border)}.preview-omitted strong{color:#f0b9a1}.angle-results{display:grid;gap:8px;margin:0 0 16px;padding:13px;border:1px solid var(--border);border-radius:9px;background:var(--surface)}.angle-results>strong{font-size:11px}.angle-result{display:grid;grid-template-columns:1fr auto;gap:3px;padding-top:8px;border-top:1px solid var(--border);font-size:12px}.angle-result small{display:block;color:var(--subtle);margin-top:2px}.angle-result em{font-style:normal;color:var(--accent);text-transform:capitalize;font-size:11px}.angle-result p{grid-column:1/-1;margin:2px 0 0;color:var(--muted);font-size:11px}.angle-result .gap-text{color:#f0b9a1}.angle-sources{grid-column:1/-1;display:grid;gap:4px;margin:4px 0 0;padding:0;list-style:none}.angle-sources button{padding:0;border:0;background:transparent;color:var(--accent);font-size:11px;text-align:left;cursor:pointer}.angle-sources button:hover{text-decoration:underline}
  .form-actions{display:flex;align-items:center;justify-content:space-between;gap:14px;color:var(--subtle);font-size:12px;border-top:1px solid var(--border);padding-top:14px}
  .primary{padding:10px 15px;border:0;border-radius:8px;background:var(--accent-strong);color:var(--accent-ink);font-size:13px;font-weight:650;white-space:nowrap}
  .requests-empty{padding:19px 21px;border:1px solid var(--border);border-radius:10px;background:#000}
  .requests-empty strong{font-size:13px}.requests-empty p{margin:4px 0 0;color:var(--muted);font-size:13px}
  .revision-layout{display:grid;grid-template-columns:minmax(240px,.7fr) minmax(0,1.3fr);min-height:260px;border:1px solid var(--border-strong);border-radius:12px;overflow:hidden;background:#000}
  .request-list{border-right:1px solid var(--border-strong);background:var(--surface)}.list-heading{display:flex;justify-content:space-between;padding:15px 17px;border-bottom:1px solid var(--border);font-size:12px;color:var(--muted)}
  .request-row{display:flex;align-items:center;gap:6px;border-bottom:1px solid var(--border)}.request-row.active{background:#bdbdbd0d;box-shadow:inset 2px 0 var(--accent)}
  .request-select{flex:1;min-width:0;text-align:left;background:transparent;border:0;color:var(--text);padding:14px 17px}
  .request-name{display:block;font-size:13px;font-weight:500;line-height:1.45}.request-meta{display:block;margin-top:5px;font-size:11px;color:var(--muted)}
  .include-toggle{display:grid;justify-items:center;gap:2px;padding:7px 10px 7px 0;color:var(--subtle);font-size:10px;cursor:pointer}.include-toggle input{accent-color:var(--accent)}
  .request-detail{padding:22px;min-width:0}.detail-head{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:11px}.status-dot{width:7px;height:7px;border-radius:50%;background:var(--muted)}.status-dot.complete{background:var(--accent)}
  .request-detail h3{margin:8px 0 16px}.detail-empty{max-width:45ch;margin:auto;padding:30px 0}.detail-empty h3{margin:0 0 7px}.detail-empty p,.detail-message{color:var(--muted);font-size:13px;margin:0}
  .comparison{display:grid;grid-template-columns:1fr 1fr;gap:10px}.finding,.new-findings{padding:15px;border:1px solid var(--border);border-radius:9px;background:var(--surface)}.finding.proposed{border-color:#bdbdbd50}
  .finding>span,.new-findings>span{font-size:11px;color:var(--subtle)}.finding h4,.new-findings h4{margin:8px 0}.finding p,.new-findings p{color:var(--muted);font-size:12px;margin:0 0 9px}.finding small{font-size:11px;color:var(--accent)}
  .evidence-detail{border-top:1px solid var(--border);margin-top:16px;padding-top:14px}.evidence-detail summary{font-size:12px;color:var(--muted);cursor:pointer}.evidence-columns{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:14px}
  .evidence-columns strong,.gap strong{display:block;font-size:11px;color:var(--text);margin-bottom:5px}.evidence-columns button{display:block;text-align:left;background:transparent;border:0;padding:4px 0;color:var(--accent-strong);font-size:12px}.evidence-columns p,.gap{font-size:12px;color:var(--muted);margin:0}.gap{border-top:1px solid var(--border);padding-top:12px;margin-top:12px}
  .replacement-select{margin:16px 0}.quiet-button{margin-top:16px}.apply-bar{position:sticky;bottom:16px;display:flex;align-items:center;justify-content:space-between;gap:18px;margin-top:14px;padding:13px 16px;border:1px solid var(--border-strong);border-radius:10px;background:var(--surface);box-shadow:0 8px 30px #0009}.apply-bar p{font-size:12px;color:var(--muted);margin:0}.apply-bar strong{color:var(--text)}
  .redo-list{margin-top:18px;border-top:1px solid var(--border);padding-top:12px}.redo-list summary{color:var(--muted);font-size:13px;cursor:pointer}.redo-list>div{padding-top:11px}.redo-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:11px 0;border-bottom:1px solid var(--border);font-size:12px}.redo-row>div{display:flex;gap:8px;flex-wrap:wrap}.redo-row button{padding:6px 8px;border:1px solid var(--border-strong);border-radius:6px;background:var(--surface);color:var(--muted);font-size:11px}
  @container page (max-width:680px){.research-revisions{padding-inline:22px}.section-header,.form-actions,.apply-bar,.redo-row{align-items:stretch;flex-direction:column}.section-header .add-button{align-self:start}.revision-layout{grid-template-columns:1fr}.request-list{border-right:0;border-bottom:1px solid var(--border-strong)}.field-pair,.comparison,.evidence-columns{grid-template-columns:1fr}.allowance-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.apply-bar .primary{width:100%}}
</style>
