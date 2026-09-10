<script lang="ts">
  import type { SolutionView } from "../../shared/ipc";
  import { optionEvidenceReferences } from "../../shared/option-evidence";
  import { loadIdeaDetail } from "../lib/idea-details";
  let { idea, busy, onSelect, onSave, onOpenSource, onEvidenceFollowUp }: {
    idea: SolutionView; busy: boolean;
    onSelect: (idea: SolutionView) => Promise<void>;
    onSave: (solutionId: string, decision: string, observed: string) => Promise<void>;
    onOpenSource: (url: string) => Promise<void>;
    onEvidenceFollowUp?: ((runId: string, question: string) => Promise<void>) | undefined;
  } = $props();
  let detail = $state<SolutionView | null>(null);
  let error = $state("");
  let loading = $state(false);
  let userDecision = $state("");
  let observedResult = $state("");
  let savedDecision = $state("");
  let savedObservedResult = $state("");
  let saved = $state(false);
  let open = $state(false);
  let revision = "";
  let detailLoadEpoch = 0;
  let wasOpen = false;
  let analysis = $derived(detail?.decisionAnalysis);
  let supportingReferences = $derived(detail ? optionEvidenceReferences(detail, detail.supportingEvidenceIds ?? []) : []);
  let contraryReferences = $derived(detail ? optionEvidenceReferences(detail, detail.contraryEvidenceIds ?? []) : []);
  let followUpSourcesWithoutQuotes = $derived(detail?.evidenceFollowUp?.sources.filter(
    (source) => !detail?.evidenceFollowUp?.factors.some((factor) => factor.sourceId === source.id),
  ) ?? []);
  let formDirty = $derived(userDecision !== savedDecision || observedResult !== savedObservedResult);
  let followUpQuestion = $state("");
  $effect(() => {
    if (open && revision !== `${idea.id}:${idea.detailRevision}`) void loadDetail();
    if (!open && wasOpen) {
      detailLoadEpoch += 1;
      detail = null;
      revision = "";
      loading = false;
    }
    wasOpen = open;
  });
  async function loadDetail() {
    const key = `${idea.id}:${idea.detailRevision}`;
    const requestEpoch = ++detailLoadEpoch;
    revision = key;
    loading = true;
    error = "";
    const draftDecision = userDecision;
    const draftObservedResult = observedResult;
    try {
      const result = await loadIdeaDetail(idea);
      if (requestEpoch !== detailLoadEpoch || !open || key !== `${idea.id}:${idea.detailRevision}`) return;
      const preserveDraft = formDirty || userDecision !== draftDecision || observedResult !== draftObservedResult;
      detail = result;
      const nextDecision = result.userDecision ?? "";
      const nextObservedResult = result.observedResult ?? "";
      savedDecision = nextDecision;
      savedObservedResult = nextObservedResult;
      if (!preserveDraft) {
        userDecision = nextDecision;
        observedResult = nextObservedResult;
      }
    } catch (cause) {
      if (requestEpoch === detailLoadEpoch && open && key === `${idea.id}:${idea.detailRevision}`) error = cause instanceof Error ? cause.message : "Could not load this option";
    }
    finally { if (requestEpoch === detailLoadEpoch) loading = false; }
  }
  async function save() {
    saved = false;
    const submittedDecision = userDecision;
    const submittedObservedResult = observedResult;
    try {
      await onSave(idea.id, submittedDecision, submittedObservedResult);
      if (userDecision === submittedDecision && observedResult === submittedObservedResult) {
        savedDecision = submittedDecision;
        savedObservedResult = submittedObservedResult;
        saved = true;
      }
    }
    catch (cause) { error = cause instanceof Error ? cause.message : "Could not save your decision"; }
  }
</script>

<article class:selected={idea.selected}>
  <button class="disclosure-title" class:expanded={open} title={idea.mechanism} aria-expanded={open} aria-controls={`option-body-${idea.id}`} onclick={() => open = !open}>
    <span class="disclosure-label">{idea.mechanism}</span>
  </button>
  {#if open}
    <div class="disclosure-content" id={`option-body-${idea.id}`}>
    <header>
      <div><p class="status">{idea.selected ? "Your selected option" : "Option"} · Problem evidence: {idea.problemVerdict}</p>
        <p>{idea.description}</p></div>
      {#if idea.selectable}<button class="primary" disabled={busy} onclick={() => onSelect(idea)}>Choose and analyze</button>{/if}
    </header>
    <div class="option-overview">
    <p class="problem">{idea.problemStatement}</p>
    <dl>
      <div><dt>Key assumption</dt><dd>{idea.keyAssumption}</dd></div>
      <div><dt>When the current approach may suffice</dt><dd>{idea.whyCurrentApproachMaySuffice}</dd></div>
      <div><dt>Constraints</dt><dd>{idea.respectsOffLimits ? "" : "Possible conflict. "}{idea.respectsOffLimitsWhy}</dd></div>
    </dl>
    {#if idea.unknowns?.length}<h3>Still uncertain</h3><ul>{#each idea.unknowns as unknown, index (index)}<li>{unknown}</li>{/each}</ul>{/if}
    </div>
      {#if loading}<p role="status">Loading saved details…</p>{/if}
      {#if error}<p role="alert">{error}</p><button onclick={loadDetail}>Retry details</button>{/if}
      {#if detail}
        <div class="source-columns">
        <section aria-label="Sources supporting this option"><h3>Sources supporting this option</h3>
          <ul>{#each supportingReferences as source (source.id)}<li>{#if source.url}<a href={source.url} onclick={(event) => { event.preventDefault(); void onOpenSource(source.url!); }}>{source.title}</a>{:else}{source.title}{/if}</li>{:else}<li>No supporting sources cited for this option.</li>{/each}</ul>
        </section>
        <section aria-label="Sources challenging this option"><h3>Sources challenging this option</h3>
          <ul>{#each contraryReferences as source (source.id)}<li>{#if source.url}<a href={source.url} onclick={(event) => { event.preventDefault(); void onOpenSource(source.url!); }}>{source.title}</a>{:else}{source.title}{/if}</li>{:else}<li>No contrary sources cited for this option.</li>{/each}</ul>
        </section>
        </div>
        <p class="status">These roles are the model's assessment of this option. The original problem evidence follows.</p>
        <h3>Observations about the problem</h3>
        {#each detail.factors as factor (factor.id)}
          <blockquote>{factor.quote}{#if factor.uncertainty}<p class="status">Uncertainty: {factor.uncertainty}</p>{/if}<small class="estimated">Model confidence is uncalibrated.</small><footer><a href={factor.sourceUrl} onclick={(event) => { event.preventDefault(); void onOpenSource(factor.sourceUrl); }}>{factor.sourceTitle}</a></footer></blockquote>
        {:else}<p>No source-backed observations. Treat the problem as an assertion to test.</p>{/each}
        <h3>Sources used to assess the problem</h3>
        {#each detail.contrarySources ?? [] as source (source.id)}
          <details><summary>{source.title}</summary><a href={source.url} onclick={(event) => { event.preventDefault(); void onOpenSource(source.url); }}>Open source</a><p class="source-text">{source.text}</p></details>
        {:else}<p>No contrary sources were collected. Their absence does not confirm the premise.</p>{/each}
        {#if detail.riskEvaluation && !analysis}
          <section aria-label="Independent risk evaluation">
            <h3>Independent risk evaluation</h3>
            <p class="status">Evaluated against: {detail.riskEvaluationCriteria || "The research goal and boundaries."}</p>
            {#each detail.riskEvaluation.risks as risk (risk.riskId)}<div class="finding"><strong>{risk.description}</strong><p>{risk.whyDecisive}</p></div>{:else}<p>The evaluator identified no decisive risk.</p>{/each}
            {#if detail.riskEvaluation.unknowns.length}<h3>Open questions</h3><ul>{#each detail.riskEvaluation.unknowns as unknown, index (index)}<li>{unknown}</li>{/each}</ul>{/if}
            <p class="status">Risk review saved. The final analysis is not complete.</p>
          </section>
        {/if}
        {#if analysis}
          <h3>Possible consequences</h3><p class="status">Model judgments. These have not been observed.</p>
          {#each analysis.consequences as consequence, index (index)}<div class="finding"><strong>{consequence.direction}: {consequence.description}</strong><p>Affects {consequence.affects}. {consequence.rationale}</p></div>{/each}
          <h3>{detail.riskEvaluation ? "Independent risk evaluation" : "Decisive risks"}</h3>
          <p class="status">Evaluated against: {detail.riskEvaluationCriteria || "The research goal and boundaries."}</p>
          {#each analysis.risks as risk (risk.riskId)}<div class="finding"><strong>{risk.description}</strong><p>{risk.whyDecisive}</p></div>{:else}<p>No decisive risk identified by the model. This is not a safety guarantee.</p>{/each}
          <h3>Proposed responses, untested</h3>
          {#each analysis.proposedResponses as response, index (index)}<div class="finding"><strong>{response.approach}</strong><p>Addresses: {analysis.risks.filter((risk) => response.riskIds.includes(risk.riskId)).map((risk) => risk.description).join("; ")}</p><p>Cost: {response.cost}</p><p>Fails if: {response.failsIf}</p></div>{/each}
          {#if analysis.unknowns.length}<h3>Open questions</h3><ul>{#each analysis.unknowns as unknown, index (index)}<li>{unknown}</li>{/each}</ul>{/if}
          <section class="experiment"><h3>Next experiment</h3><strong>{analysis.experiment.question}</strong><p>{analysis.experiment.method}</p>
            <dl><div><dt>Cost</dt><dd>{analysis.experiment.cost}</dd></div><div><dt>Pass</dt><dd>{analysis.experiment.passCriterion}</dd></div><div><dt>Fail</dt><dd>{analysis.experiment.failCriterion}</dd></div></dl>
          </section>
          {#if detail.evidenceFollowUp}
            <section class="follow-up" aria-label="Evidence follow-up result">
              <h3>Evidence follow-up</h3>
              <p><strong>Question:</strong> {detail.evidenceFollowUp.question}</p>
              {#if detail.evidenceFollowUp.status === "running"}<p role="status">Checking saved sources for this question...</p>{/if}
              {#each detail.evidenceFollowUp.factors as factor (factor.id)}
                <blockquote>{factor.quote}{#if factor.uncertainty}<p class="status">Uncertainty: {factor.uncertainty}</p>{/if}<footer><a href={factor.sourceUrl} onclick={(event) => { event.preventDefault(); void onOpenSource(factor.sourceUrl); }}>{factor.sourceTitle}</a></footer></blockquote>
              {/each}
              {#if followUpSourcesWithoutQuotes.length}
                <p class="status">Other sources checked</p>
                <ul>{#each followUpSourcesWithoutQuotes as source (source.id)}<li><a href={source.url} onclick={(event) => { event.preventDefault(); void onOpenSource(source.url); }}>{source.title}</a></li>{/each}</ul>
              {/if}
              {#if detail.evidenceFollowUp.status === "completed" && !detail.evidenceFollowUp.factors.length}<p role="status">The follow-up completed without a quote-verified observation.</p>{/if}
              {#if detail.evidenceFollowUp.status === "failed"}<p role="alert">{detail.evidenceFollowUp.error ?? "The evidence follow-up failed."}</p>{/if}
              {#if detail.evidenceFollowUp.status !== "running"}<p class="status">This option has used its one evidence follow-up.</p>{/if}
            </section>
          {:else if idea.selected && idea.runId && analysis && idea.canRequestEvidenceFollowUp && onEvidenceFollowUp}
            <form onsubmit={(event) => { event.preventDefault(); void onEvidenceFollowUp(idea.runId!, followUpQuestion.trim()); }}>
              <h3>Ask one evidence question</h3>
              <p>Run one focused follow-up search. The saved result will appear here.</p>
              <label>Question<textarea rows="2" maxlength="500" bind:value={followUpQuestion} placeholder="What should we verify next?"></textarea></label>
              <button disabled={busy || !followUpQuestion.trim()}>Check evidence</button>
            </form>
          {/if}
          <form class="decision-editor" onsubmit={(event) => { event.preventDefault(); void save(); }}>
            <h3>Your decision and actual result</h3><p>Keep observations separate from the model's proposals.</p>
            <label>Your decision<textarea rows="3" maxlength="8000" bind:value={userDecision} oninput={() => saved = false}></textarea></label>
            <label>Observed test result<textarea rows="3" maxlength="8000" bind:value={observedResult} oninput={() => saved = false} placeholder="Leave empty until you have an observation."></textarea></label>
            <button disabled={busy}>Save decision and result</button>{#if saved}<span role="status">Saved</span>{/if}
          </form>
        {:else if idea.selected}<p>The analysis has not completed. Saved options remain available.</p>{/if}
      {/if}
    </div>
  {/if}
</article>

<style>
  article { border:1px solid var(--border);border-radius:13px;padding:0;overflow:hidden;background:linear-gradient(120deg,#1b202377,var(--surface));box-shadow:inset 0 1px #ffffff04; }
  article.selected { border-color:#71cfba60; }
  .disclosure-title.expanded { background:var(--surface-2); }
  .disclosure-content { background:var(--bg);padding:24px 28px 30px; }
  header { display:flex;justify-content:space-between;gap:24px;align-items:start;padding-bottom:22px; }
  header > div { min-width:0; }header p { margin:8px 0 0;max-width:70ch;font-size:15px;line-height:1.8; }
  header .status { margin:0;font-size:10px;color:var(--accent); }
  h3 { margin:28px 0 12px;font-size:14px;font-weight:650;letter-spacing:-.015em; }
  p,li { line-height:1.8;font-size:12px;max-width:78ch;color:var(--muted); }
  ul { padding-left:20px; }li + li { margin-top:7px; }
  .status,.problem { color:var(--subtle);font-size:11px;line-height:1.7; }
  .option-overview { padding:20px 22px;background:var(--surface);border:1px solid var(--border);border-radius:12px; }
  .option-overview .problem { margin:0 0 18px;padding-bottom:16px;border-bottom:1px solid var(--border);color:var(--text);font-size:12px; }
  dl { display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:22px;margin:0; }
  dt { color:var(--subtle);font-size:10px;margin-bottom:8px; }dd { margin:0;color:var(--muted);font-size:12px;line-height:1.8; }
  button:not(.disclosure-title) { padding:10px 14px;border:1px solid var(--border-strong);border-radius:8px;background:var(--surface-2);color:var(--text);font-size:11px;font-weight:550; }
  button.primary { background:var(--accent-strong);color:var(--accent-ink);border-color:transparent;flex-shrink:0; }
  summary { cursor:pointer;padding:14px 0;font-size:12px;color:var(--muted); }details { border-top:1px solid var(--border);margin-top:18px; }
  .source-columns { display:grid;grid-template-columns:1fr 1fr;gap:24px;border-bottom:1px solid var(--border);padding-bottom:18px; }
  .source-columns section { min-width:0; }.source-columns h3 { font-size:12px; }.source-columns ul { padding-left:16px; }.source-columns a { overflow-wrap:anywhere; }
  blockquote { margin:16px 0;padding:18px 20px;border:1px solid var(--border);border-left:2px solid #71cfba55;border-radius:0 10px 10px 0;background:var(--surface);font-size:13px;line-height:1.8;max-width:78ch; }
  footer { margin-top:10px;font-size:11px; }.estimated { display:block;color:var(--subtle);font-size:10px;margin-top:8px; }
  .finding { border-bottom:1px solid var(--border);padding:18px 0; }.finding strong { font-size:13px;font-weight:550; }.finding p { margin-bottom:0; }
  .experiment { border:1px solid #71cfba38;border-radius:14px;padding:22px;margin-top:28px;background:#71cfba05; }
  .experiment h3 { margin:0 0 14px;color:var(--accent-strong);font-size:12px; }.experiment > strong { font-size:16px;font-weight:600;line-height:1.6;display:block;max-width:70ch; }
  .experiment dl { padding-top:18px;border-top:1px solid var(--border);margin-top:18px; }
  form { border:1px solid var(--border);padding:22px;border-radius:14px;background:var(--surface);margin-top:24px; }
  form h3 { margin:0 0 8px; }form > p { margin:0 0 20px; }
  label { display:grid;gap:8px;margin:16px 0;font-size:12px;color:var(--muted); }
  textarea { width:100%;background:var(--bg);color:var(--text);border:1px solid var(--border-strong);border-radius:9px;padding:12px;resize:vertical;font-size:12px; }
  .decision-editor { display:grid;grid-template-columns:1fr 1fr;gap:0 20px; }.decision-editor h3,.decision-editor > p { grid-column:1/-1; }.decision-editor button { width:fit-content; }.decision-editor label { margin-top:0; }
  .source-text { white-space:pre-wrap;max-height:360px;overflow:auto; }form span { margin-left:12px;font-size:11px;color:var(--success); }
  @media(max-width:850px) { dl { grid-template-columns:1fr;gap:16px; }.source-columns { grid-template-columns:1fr;gap:0; }.decision-editor { grid-template-columns:1fr; }.disclosure-content { padding:20px; }header { flex-direction:column;gap:16px; } }
</style>
