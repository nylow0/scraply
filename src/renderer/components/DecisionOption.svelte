<script lang="ts">
  import type { SolutionView } from "../../shared/ipc";
  import { optionEvidenceReferences } from "../../shared/option-evidence";
  import { loadIdeaDetail } from "../lib/idea-details";
  type ExperimentOutcome = "not-run" | "pass" | "fail" | "inconclusive";
  type EnhancedSolution = SolutionView & {
    experimentOutcome?: ExperimentOutcome;
    canReassessEvidence?: boolean;
  };
  type EnhancedFollowUp = NonNullable<SolutionView["evidenceFollowUp"]> & {
    reassessmentStatus?: "running" | "completed" | "failed" | null;
    reassessmentAnalysis?: NonNullable<SolutionView["decisionAnalysis"]> | null;
    reassessmentError?: string | null;
  };
  let { idea, busy, analysisBlocked = false, onSelect, onSave, onOpenSource, onEvidenceFollowUp, onEvidenceReassessment }: {
    idea: SolutionView; busy: boolean;
    analysisBlocked?: boolean;
    onSelect: (idea: SolutionView) => Promise<void>;
    onSave: (solutionId: string, decision: string, observed: string, outcome: ExperimentOutcome) => Promise<void>;
    onOpenSource: (url: string) => Promise<void>;
    onEvidenceFollowUp?: ((runId: string, question: string) => Promise<void>) | undefined;
    onEvidenceReassessment?: ((runId: string) => Promise<void>) | undefined;
  } = $props();
  let detail = $state<SolutionView | null>(null);
  let error = $state("");
  let loading = $state(false);
  let userDecision = $state("");
  let observedResult = $state("");
  let savedDecision = $state("");
  let savedObservedResult = $state("");
  let savedExperimentOutcome = $state<ExperimentOutcome>("not-run");
  let saved = $state(false);
  let experimentOutcome = $state<ExperimentOutcome>("not-run");
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
  let formDirty = $derived(userDecision !== savedDecision || observedResult !== savedObservedResult || experimentOutcome !== savedExperimentOutcome);
  let followUpQuestion = $state("");
  let enhancedFollowUp = $derived(detail?.evidenceFollowUp as EnhancedFollowUp | undefined);
  type EvidenceMetadata = { sourceRole?: string; audienceFit?: string; independentSourceKey?: string|null; supportsDemand?: boolean; demandEvidenceUncertainty?: string };
  function evidenceSummary(factor: SolutionView["factors"][number]): string {
    const evidence = factor as typeof factor & EvidenceMetadata;
    return `Source role: ${evidence.sourceRole ?? "unknown"} · Audience: ${evidence.audienceFit ?? "unknown"} · ${evidence.independentSourceKey ? "Independent origin identified" : "Independence unknown"} · ${evidence.supportsDemand ? "Supports demand" : "Does not establish demand"}`;
  }
  function confirmedEvidenceLabel(solution: SolutionView): string {
    if (solution.problemVerdict !== "confirmed") return solution.problemVerdict;
    const hasIntendedBuyerEvidence = solution.factors.some((factor) => (factor as typeof factor & EvidenceMetadata).audienceFit === "intended-buyer");
    return hasIntendedBuyerEvidence
      ? "confirmed with intended-buyer evidence; demand not established"
      : "research marked confirmed; audience fit unassessed; demand not established";
  }
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
    const draftExperimentOutcome = experimentOutcome;
    try {
      const result = await loadIdeaDetail(idea);
      if (requestEpoch !== detailLoadEpoch || !open || key !== `${idea.id}:${idea.detailRevision}`) return;
      const preserveDraft = formDirty || userDecision !== draftDecision || observedResult !== draftObservedResult || experimentOutcome !== draftExperimentOutcome;
      detail = result;
      const nextExperimentOutcome = (result as EnhancedSolution).experimentOutcome ?? "not-run";
      savedExperimentOutcome = nextExperimentOutcome;
      const nextDecision = result.userDecision ?? "";
      const nextObservedResult = result.observedResult ?? "";
      savedDecision = nextDecision;
      savedObservedResult = nextObservedResult;
      if (!preserveDraft) {
        userDecision = nextDecision;
        observedResult = nextObservedResult;
        experimentOutcome = nextExperimentOutcome;
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
    const submittedExperimentOutcome = experimentOutcome;
    try {
      await onSave(idea.id, submittedDecision, submittedObservedResult, submittedExperimentOutcome);
      if (userDecision === submittedDecision && observedResult === submittedObservedResult && experimentOutcome === submittedExperimentOutcome) {
        savedDecision = submittedDecision;
        savedObservedResult = submittedObservedResult;
        savedExperimentOutcome = submittedExperimentOutcome;
        saved = true;
      }
    }
    catch (cause) { error = cause instanceof Error ? cause.message : "Could not save your decision"; }
  }
</script>

<article class:selected={idea.selected}>
  <button class="disclosure-title" class:expanded={open} title={idea.description} aria-expanded={open} aria-controls={`option-body-${idea.id}`} onclick={() => open = !open}>
    <span class="disclosure-label">{idea.description}</span>
  </button>
  {#if open}
    <div class="disclosure-content" id={`option-body-${idea.id}`}>
    <header>
      <div><p class="status">{idea.selected ? "Your selected option" : "Option"} · Problem evidence: {confirmedEvidenceLabel(idea)}</p>
        <p>{idea.mechanism}</p></div>
      {#if idea.selectable}<button class="primary" disabled={busy || analysisBlocked} title={analysisBlocked ? "Wait for the current generation batch to finish" : undefined} onclick={() => onSelect(idea)}>Choose and analyze</button>{/if}
    </header>
    <details class="option-overview"><summary>Problem and fit</summary>
    <p class="problem">{idea.problemStatement}</p>
    <dl>
      <div><dt>Key assumption</dt><dd>{idea.keyAssumption}</dd></div>
      <div><dt>When the current approach may suffice</dt><dd>{idea.whyCurrentApproachMaySuffice}</dd></div>
      <div><dt>Constraints</dt><dd>{idea.respectsOffLimits ? "" : "Possible conflict. "}{idea.respectsOffLimitsWhy}</dd></div>
    </dl>
    {#if idea.unknowns?.length}<h3>Still uncertain</h3><ul>{#each idea.unknowns as unknown, index (index)}<li>{unknown}</li>{/each}</ul>{/if}
    </details>
    {#if idea.startupOpportunity}
      <details class="startup-details"><summary>Startup opportunity</summary>
        <dl>
          <div><dt>Category</dt><dd>{idea.startupOpportunity.opportunityType.replaceAll("-", " ")}</dd></div>
          <div><dt>Paying customer</dt><dd>{idea.startupOpportunity.payingCustomerSegment}</dd></div>
          <div><dt>Trigger</dt><dd>{idea.startupOpportunity.trigger}</dd></div>
          <div><dt>Current substitute</dt><dd>{idea.startupOpportunity.existingSubstitute}</dd></div>
          <div><dt>Gap assessment</dt><dd><span class="evidence-kind">{idea.startupOpportunity.gapAssessment.kind}</span> {idea.startupOpportunity.gapAssessment.description}</dd></div>
          <div><dt>Smallest sellable workflow</dt><dd>{idea.startupOpportunity.smallestSellableWorkflow}</dd></div>
          <div><dt>First customer route</dt><dd>{idea.startupOpportunity.firstCustomerRoute}</dd></div>
          <div><dt>Demand test that could disconfirm this</dt><dd>{idea.startupOpportunity.disconfirmingDemandTest}</dd></div>
        </dl>
      </details>
    {/if}
      {#if loading}<p role="status">Loading saved details…</p>{/if}
      {#if error}<p role="alert">{error}</p><button onclick={loadDetail}>Retry details</button>{/if}
      {#if detail}
        {#if analysis}<p class="analysis-status" role="status">Analysis completed. The experiment and model judgments are ready to review.</p>{/if}
        <details class="deep-review"><summary>Evidence and sources</summary>
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
          <blockquote>{factor.quote}<p class="status">{evidenceSummary(factor)}</p>{#if factor.uncertainty}<p class="status">Uncertainty: {factor.uncertainty}</p>{/if}{#if (factor as typeof factor & EvidenceMetadata).demandEvidenceUncertainty}<p class="status">Demand evidence gap: {(factor as typeof factor & EvidenceMetadata).demandEvidenceUncertainty}</p>{/if}<small class="estimated">Matched against the saved search excerpt. Model confidence is uncalibrated.</small><footer><a href={factor.sourceUrl} onclick={(event) => { event.preventDefault(); void onOpenSource(factor.sourceUrl); }}>{factor.sourceTitle}</a></footer></blockquote>
        {:else}<p>No source-backed observations. Treat the problem as an assertion to test.</p>{/each}
        <h3>Sources used to assess the problem</h3>
        {#each detail.contrarySources ?? [] as source (source.id)}
          <details><summary>{source.title}</summary><a href={source.url} onclick={(event) => { event.preventDefault(); void onOpenSource(source.url); }}>Open source</a><p class="source-text">{source.text}</p></details>
        {:else}<p>No contrary sources were collected. Their absence does not confirm the premise.</p>{/each}
        </details>
        {#if detail.riskEvaluation && !analysis}
          <details aria-label="Independent risk evaluation"><summary>Risk review</summary>
            <h3>Independent risk evaluation</h3>
            <p class="status">Evaluated against: {detail.riskEvaluationCriteria || "The research goal and boundaries."}</p>
            {#each detail.riskEvaluation.risks as risk (risk.riskId)}<div class="finding"><strong>{risk.description}</strong><p>{risk.whyDecisive}</p></div>{:else}<p>The evaluator identified no decisive risk.</p>{/each}
            {#if detail.riskEvaluation.unknowns.length}<h3>Open questions</h3><ul>{#each detail.riskEvaluation.unknowns as unknown, index (index)}<li>{unknown}</li>{/each}</ul>{/if}
            <p class="status">Risk review saved. The final analysis is not complete.</p>
          </details>
        {/if}
        {#if analysis}
          <section class="experiment"><h3>Next experiment</h3><strong>{analysis.experiment.question}</strong><p>{analysis.experiment.method}</p>
            <dl><div><dt>Cost</dt><dd>{analysis.experiment.cost}</dd></div><div><dt>Pass</dt><dd>{analysis.experiment.passCriterion}</dd></div><div><dt>Fail</dt><dd>{analysis.experiment.failCriterion}</dd></div><div><dt>Inconclusive</dt><dd>{"inconclusiveCriterion" in analysis.experiment ? String(analysis.experiment.inconclusiveCriterion) : "The result does not clearly meet the pass or fail criterion."}</dd></div></dl>
          </section>
          <details class="deep-review"><summary>Possible outcomes</summary>
          <h3>Possible consequences</h3><p class="status">Model judgments. These have not been observed.</p>
          {#each analysis.consequences as consequence, index (index)}<div class="finding"><strong>{consequence.direction}: {consequence.description}</strong><p>Affects {consequence.affects}. {consequence.rationale}</p></div>{/each}
          </details>
          <details class="deep-review"><summary>Risks and responses</summary>
          <h3>{detail.riskEvaluation ? "Independent risk evaluation" : "Decisive risks"}</h3>
          <p class="status">Evaluated against: {detail.riskEvaluationCriteria || "The research goal and boundaries."}</p>
          {#each analysis.risks as risk (risk.riskId)}<div class="finding"><strong>{risk.description}</strong><p>{risk.whyDecisive}</p></div>{:else}<p>No decisive risk identified by the model. This is not a safety guarantee.</p>{/each}
          <h3>Proposed responses, untested</h3>
          {#each analysis.proposedResponses as response, index (index)}<div class="finding"><strong>{response.approach}</strong><p>Addresses: {analysis.risks.filter((risk) => response.riskIds.includes(risk.riskId)).map((risk) => risk.description).join("; ")}</p><p>Cost: {response.cost}</p><p>Fails if: {response.failsIf}</p></div>{/each}
          {#if analysis.unknowns.length}<h3>Open questions</h3><ul>{#each analysis.unknowns as unknown, index (index)}<li>{unknown}</li>{/each}</ul>{/if}
          </details>
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
              {#if enhancedFollowUp?.reassessmentStatus === "running"}<p role="status">Reassessing with the follow-up evidence...</p>{/if}
              {#if enhancedFollowUp?.reassessmentStatus === "failed"}<p role="alert">{enhancedFollowUp.reassessmentError ?? "The reassessment failed."}</p>{/if}
              {#if enhancedFollowUp?.reassessmentAnalysis}
                <details class="reassessment"><summary>Reassessment with new evidence</summary>
                  <p class="status">This is a separate assessment. The original analysis above remains unchanged.</p>
                  <h3>Updated consequences</h3>
                  {#each enhancedFollowUp.reassessmentAnalysis.consequences as consequence, index (index)}<div class="finding"><strong>{consequence.direction}: {consequence.description}</strong><p>{consequence.rationale}</p></div>{/each}
                  <h3>Updated risk assessment</h3>
                  {#if enhancedFollowUp.riskReassessment}
                    {#each enhancedFollowUp.riskReassessment.affectedRisks as risk (risk.riskId)}<div class="finding"><strong>{risk.effect}: {risk.riskId}</strong><p>{risk.rationale}</p></div>{/each}
                    {#each enhancedFollowUp.riskReassessment.newRisks as risk (risk.riskId)}<div class="finding"><strong>New risk: {risk.description}</strong><p>{risk.whyDecisive}</p></div>{/each}
                    {#if enhancedFollowUp.riskReassessment.additionalUnknowns.length}<ul>{#each enhancedFollowUp.riskReassessment.additionalUnknowns as unknown, index (index)}<li>{unknown}</li>{/each}</ul>{/if}
                  {/if}
                  {#each enhancedFollowUp.reassessmentAnalysis.risks as risk (risk.riskId)}<div class="finding"><strong>{risk.description}</strong><p>{risk.whyDecisive}</p></div>{:else}<p>No additional decisive risks were identified.</p>{/each}
                  <h3>Updated proposed responses</h3>
                  {#each enhancedFollowUp.reassessmentAnalysis.proposedResponses as response, index (index)}<div class="finding"><strong>{response.approach}</strong><p>Cost: {response.cost}</p><p>Fails if: {response.failsIf}</p></div>{:else}<p>No additional response was proposed.</p>{/each}
                  {#if enhancedFollowUp.reassessmentAnalysis.unknowns.length}<h3>Updated open questions</h3><ul>{#each enhancedFollowUp.reassessmentAnalysis.unknowns as unknown, index (index)}<li>{unknown}</li>{/each}</ul>{/if}
                  <section class="experiment"><h3>Updated experiment</h3><strong>{enhancedFollowUp.reassessmentAnalysis.experiment.question}</strong><p>{enhancedFollowUp.reassessmentAnalysis.experiment.method}</p><dl><div><dt>Cost</dt><dd>{enhancedFollowUp.reassessmentAnalysis.experiment.cost}</dd></div><div><dt>Pass</dt><dd>{enhancedFollowUp.reassessmentAnalysis.experiment.passCriterion}</dd></div><div><dt>Fail</dt><dd>{enhancedFollowUp.reassessmentAnalysis.experiment.failCriterion}</dd></div><div><dt>Inconclusive</dt><dd>{enhancedFollowUp.reassessmentAnalysis.experiment.inconclusiveCriterion}</dd></div></dl></section>
                </details>
              {:else if detail.evidenceFollowUp.status === "completed" && (detail as EnhancedSolution).canReassessEvidence && idea.runId && onEvidenceReassessment}
                <button class="reassess" disabled={busy} onclick={() => onEvidenceReassessment?.(idea.runId!)}>Reassess with new evidence</button>
                <p class="status">Your prior analysis will remain unchanged and the reassessment will appear separately.</p>
              {/if}
            </section>
          {:else if idea.selected && idea.runId && analysis && idea.canRequestEvidenceFollowUp && onEvidenceFollowUp}
            <form onsubmit={(event) => { event.preventDefault(); void onEvidenceFollowUp(idea.runId!, followUpQuestion.trim()); }}>
              <h3>Ask one evidence question</h3>
              <p>One follow-up search per solution.</p>
              <label>Question<textarea rows="2" maxlength="500" bind:value={followUpQuestion} placeholder="What should we verify next?"></textarea></label>
              <button disabled={busy || !followUpQuestion.trim()}>Check evidence</button>
            </form>
          {/if}
          <form class="decision-editor" onsubmit={(event) => { event.preventDefault(); void save(); }}>
            <h3>Your decision and actual result</h3><p>Record what you decided and observed.</p>
            <label>Your decision<textarea rows="3" maxlength="8000" bind:value={userDecision} oninput={() => saved = false}></textarea></label>
            <label>Observed test result<textarea rows="3" maxlength="8000" bind:value={observedResult} oninput={() => saved = false} placeholder="What happened?"></textarea></label>
            <label>Experiment outcome<select bind:value={experimentOutcome} oninput={() => saved = false}><option value="not-run">Not run</option><option value="pass">Pass</option><option value="fail">Fail</option><option value="inconclusive">Inconclusive</option></select></label>
            <button disabled={busy}>Save decision and result</button>{#if saved}<span role="status">Saved</span>{/if}
          </form>
        {:else if idea.selected}<p>The analysis has not completed. Saved options remain available.</p>{/if}
      {/if}
    </div>
  {/if}
</article>

<style>
  article { min-width:0;max-width:100%;overflow-wrap:anywhere; border:1px solid var(--border);border-radius:13px;padding:0;overflow:hidden;background:linear-gradient(120deg,#1b202377,var(--surface));box-shadow:inset 0 1px #ffffff04; }
  article.selected { border-color:#71cfba60; }
  .disclosure-title.expanded { background:var(--surface-2); }
  .disclosure-content { background:var(--bg);padding:24px 28px 30px; }
  header { display:flex;justify-content:space-between;gap:24px;align-items:start;padding-bottom:22px; }
  header > div { min-width:0; }header p { margin:8px 0 0;max-width:70ch;font-size:15px;line-height:1.8; }
  header .status { margin:0;font-size:13px;color:var(--accent); }
  h3 { margin:28px 0 12px;font-size:14px;font-weight:650;letter-spacing:-.015em; }
  p,li { line-height:1.8;font-size:13px;max-width:78ch;color:var(--muted); }
  ul { padding-left:20px; }li + li { margin-top:7px; }
  .status,.problem { color:var(--subtle);font-size:13px;line-height:1.7; }
  .analysis-status { color:var(--success);font-size:13px; }
  .option-overview { padding:0;background:transparent;border:0;border-top:1px solid var(--border);border-radius:0;margin-top:0; }
  .startup-details { border-top:1px solid var(--border); }
  .startup-details dl { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .evidence-kind { display:inline-block;margin-right:5px;padding:2px 6px;border:1px solid var(--border-strong);border-radius:5px;color:var(--subtle);font-size:11px;text-transform:capitalize; }
  .option-overview .problem { margin:0 0 18px;padding-bottom:16px;border-bottom:1px solid var(--border);color:var(--text);font-size:13px; }
  dl { display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:22px;margin:0; }
  dt { color:var(--subtle);font-size:13px;margin-bottom:8px; }dd { margin:0;color:var(--muted);font-size:13px;line-height:1.8; }
  button:not(.disclosure-title) { padding:10px 14px;border:1px solid var(--border-strong);border-radius:8px;background:var(--surface-2);color:var(--text);font-size:13px;font-weight:550; }
  button.primary { background:var(--accent-strong);color:var(--accent-ink);border-color:transparent;flex-shrink:0; }
  summary { cursor:pointer;padding:18px 0;font-size:14px;color:var(--muted); }details { border-top:1px solid var(--border);margin-top:18px; }
  .source-columns { display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px;border-bottom:1px solid var(--border);padding-bottom:18px; }
  .source-columns section { min-width:0; }.source-columns h3 { font-size:13px; }.source-columns ul { padding-left:16px; }.source-columns a { overflow-wrap:anywhere; }
  blockquote { margin:16px 0;padding:18px 20px;border:1px solid var(--border);border-left:2px solid #71cfba55;border-radius:0 10px 10px 0;background:var(--surface);font-size:13px;line-height:1.8;max-width:78ch; }
  footer { margin-top:10px;font-size:13px; }.estimated { display:block;color:var(--subtle);font-size:13px;margin-top:8px; }
  .finding { border-bottom:1px solid var(--border);padding:18px 0; }.finding strong { font-size:13px;font-weight:550; }.finding p { margin-bottom:0; }
  .experiment { border:1px solid #71cfba38;border-radius:14px;padding:22px;margin-top:28px;background:#71cfba05; }
  .experiment h3 { margin:0 0 14px;color:var(--accent-strong);font-size:13px; }.experiment > strong { font-size:16px;font-weight:600;line-height:1.6;display:block;max-width:70ch; }
  .experiment dl { padding-top:18px;border-top:1px solid var(--border);margin-top:18px; }
  form { border:1px solid var(--border);padding:22px;border-radius:14px;background:var(--surface);margin-top:24px; }
  form h3 { margin:0 0 8px; }form > p { margin:0 0 20px; }
  label { display:grid;gap:8px;margin:16px 0;font-size:13px;color:var(--muted); }
  textarea { width:100%;background:var(--bg);color:var(--text);border:1px solid var(--border-strong);border-radius:9px;padding:12px;resize:none;font-size:13px; }
  select { width:100%;background:#000;color:var(--text);border:1px solid var(--border-strong);border-radius:9px;padding:11px;font-size:13px; }
  .reassess { margin-top:14px; }
  .decision-editor { display:grid;grid-template-columns:1fr 1fr;gap:0 20px; }.decision-editor h3,.decision-editor > p { grid-column:1/-1; }.decision-editor button { width:fit-content; }.decision-editor label { margin-top:0; }
  .source-text { white-space:pre-wrap;max-height:360px;overflow:auto; }form span { margin-left:12px;font-size:13px;color:var(--success); }
  @media(max-width:850px) { dl { grid-template-columns:1fr;gap:16px; }.source-columns { grid-template-columns:1fr;gap:0; }.decision-editor { grid-template-columns:1fr; }.disclosure-content { padding:20px; }header { flex-direction:column;gap:16px; } }
</style>
