<script lang="ts">
  import type { SolutionView } from "../../shared/ipc";
  import { optionEvidenceReferences } from "../../shared/option-evidence";
  import { loadIdeaDetail } from "../lib/idea-details";
  import FocusedExperiment from "./FocusedExperiment.svelte";
  import IdeaMechanism from "./IdeaMechanism.svelte";
  type ExperimentOutcome = "not-run" | "pass" | "fail" | "inconclusive";
  let { idea, busy, onSave, onOpenSource, onEvidenceFollowUp, onEvidenceReassessment, onPlanExperiment }: {
    idea: SolutionView; busy: boolean;
    onSave: (solutionId: string, decision: string, observed: string, outcome: ExperimentOutcome) => Promise<void>;
    onOpenSource: (url: string) => Promise<void>;
    onEvidenceFollowUp?: ((runId: string, question: string) => Promise<void>) | undefined;
    onEvidenceReassessment?: ((runId: string) => Promise<void>) | undefined;
    onPlanExperiment?: ((idea: SolutionView) => Promise<void>) | undefined;
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
  let revision = "";
  let detailLoadEpoch = 0;
  let analysis = $derived(detail?.decisionAnalysis);
  let focusedExperiment = $derived(detail?.focusedExperiment ?? idea.focusedExperiment);
  let opportunityOrigin = $derived(idea.opportunityOrigin);
  let supportingReferences = $derived(detail ? optionEvidenceReferences(detail, detail.supportingEvidenceIds ?? []) : []);
  let contraryReferences = $derived(detail ? optionEvidenceReferences(detail, detail.contraryEvidenceIds ?? []) : []);
  let followUpSourcesWithoutQuotes = $derived(detail?.evidenceFollowUp?.sources.filter(
    (source) => !detail?.evidenceFollowUp?.factors.some((factor) => factor.sourceId === source.id),
  ) ?? []);
  let formDirty = $derived(userDecision !== savedDecision || observedResult !== savedObservedResult || experimentOutcome !== savedExperimentOutcome);
  let followUpQuestion = $state("");
  let enhancedFollowUp = $derived(detail?.evidenceFollowUp);
  type EvidenceMetadata = { sourceRole?: string; audienceFit?: string; independentSourceKey?: string|null; supportsDemand?: boolean; demandEvidenceUncertainty?: string };
  function evidenceSummary(factor: SolutionView["factors"][number]): string {
    const evidence = factor as typeof factor & EvidenceMetadata;
    return `Source role: ${evidence.sourceRole ?? "unknown"} · Audience: ${evidence.audienceFit ?? "unknown"} · ${evidence.independentSourceKey ? "Independent origin identified" : "Independence unknown"}${evidence.supportsDemand ? " · Supports demand" : ""}`;
  }
  function reassessedRiskLabel(risk: NonNullable<SolutionView["decisionAnalysis"]>["risks"][number]): string {
    if (enhancedFollowUp?.riskReassessment?.newRisks.some((item) => item.riskId === risk.riskId)) {
      return `New risk: ${risk.description}`;
    }
    const change = enhancedFollowUp?.riskReassessment?.affectedRisks.find((item) => item.riskId === risk.riskId);
    return change ? `${change.effect === "strengthened" ? "Strengthened" : "Weakened"} risk: ${risk.description}` : risk.description;
  }
  function reassessedRiskChange(riskId: string): string | null {
    return enhancedFollowUp?.riskReassessment?.affectedRisks.find((item) => item.riskId === riskId)?.rationale ?? null;
  }
  function isNewReassessmentUnknown(unknown: string): boolean {
    return enhancedFollowUp?.riskReassessment?.additionalUnknowns.includes(unknown) ?? false;
  }
  $effect(() => {
    if (revision !== `${idea.id}:${idea.detailRevision}`) void loadDetail();
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
      if (requestEpoch !== detailLoadEpoch || key !== `${idea.id}:${idea.detailRevision}`) return;
      const preserveDraft = formDirty || userDecision !== draftDecision || observedResult !== draftObservedResult || experimentOutcome !== draftExperimentOutcome;
      detail = result;
      const nextExperimentOutcome = result.experimentOutcome ?? "not-run";
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
      if (requestEpoch === detailLoadEpoch && key === `${idea.id}:${idea.detailRevision}`) error = cause instanceof Error ? cause.message : "Could not load this option";
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

<article class="detail-page">
    <div class="disclosure-content" id={`option-body-${idea.id}`}>
    <IdeaMechanism mechanism={idea.mechanism} />
    <details class="option-overview"><summary>Problem and fit</summary>
    {#if idea.rankReason}<h3>Why it ranks here</h3><p>{idea.rankReason}</p>{/if}
    {#if opportunityOrigin}<p>{opportunityOrigin.kind === "exploratory-hypothesis" ? opportunityOrigin.disclosure : opportunityOrigin.evidenceGap ?? ""}</p>{/if}
    {#if (detail?.criteriaFit ?? idea.criteriaFit)?.length}<dl>{#each detail?.criteriaFit ?? idea.criteriaFit ?? [] as entry (entry.criterionId)}
      <div><dt>{entry.criterionName}{entry.mustHave ? " · must-have" : ""}: {entry.status}</dt><dd>{entry.note}
        {#if detail && entry.evidenceIds.length > 0}<div class="criterion-sources">
          {#each optionEvidenceReferences(detail, entry.evidenceIds) as source (source.id)}
            {#if source.url}<a href={source.url} onclick={(event) => { event.preventDefault(); void onOpenSource(source.url!); }}>{source.title}</a>{:else}<span>{source.title}</span>{/if}
          {/each}
        </div>{/if}
      </dd></div>
    {/each}</dl>{/if}
    {#if idea.biggerProblem}<h3>Wider problem</h3><p>{idea.biggerProblem.statement}</p><p>{idea.biggerProblem.affected}. {idea.biggerProblem.scale}{idea.biggerProblem.scaleKnown ? "" : " · scale unknown"}</p>
      {#if detail && idea.biggerProblem.scaleEvidenceIds.length > 0}<ul aria-label="Problem scale evidence">
        {#each optionEvidenceReferences(detail, idea.biggerProblem.scaleEvidenceIds) as source (source.id)}<li>{#if source.url}<a href={source.url} onclick={(event) => { event.preventDefault(); void onOpenSource(source.url!); }}>{source.title}</a>{:else}{source.title}{/if}</li>{/each}
      </ul>{/if}
    {/if}
    {#if idea.slice}<h3>Buildable slice</h3><p>{idea.slice.description}</p><p>{idea.slice.connectionToBiggerProblem}</p><p>{idea.slice.feasibilityWithinConstraints}</p>{/if}
    {#if idea.biggerProblem?.statement !== idea.problemStatement}<p class="problem">{idea.problemStatement}</p>{/if}
    <dl>
      <div><dt>Key assumption</dt><dd>{idea.keyAssumption}</dd></div>
      <div><dt>When the current approach may suffice</dt><dd>{idea.whyCurrentApproachMaySuffice}</dd></div>
      <div><dt>Constraints</dt><dd>{idea.respectsOffLimits ? "" : "Possible conflict. "}{idea.respectsOffLimitsWhy}</dd></div>
    </dl>
    {#if idea.unknowns?.length}<h3>Still uncertain</h3><ul>{#each idea.unknowns as unknown, index (index)}<li>{unknown}</li>{/each}</ul>{/if}
    </details>
    {#if idea.firstTest}<details class="option-overview first-test"><summary>First test</summary>
      <p>{idea.firstTest.question}</p><p>{idea.firstTest.method}</p>
      <dl><div><dt>Metric</dt><dd>{idea.firstTest.metric}</dd></div><div><dt>Sample and duration</dt><dd>{idea.firstTest.sample} observations over {idea.firstTest.observationWindow}</dd></div><div><dt>Cost</dt><dd>{idea.firstTest.cost}</dd></div><div><dt>Pass</dt><dd>{idea.firstTest.passCriterion}</dd></div><div><dt>Fail</dt><dd>{idea.firstTest.failCriterion}</dd></div><div><dt>Inconclusive</dt><dd>{idea.firstTest.inconclusiveCriterion}</dd></div></dl>
    </details>{/if}
    {#if idea.startupOpportunity}
      <details class="startup-details"><summary>Startup opportunity</summary>
        <dl>
          <div><dt>Category</dt><dd>{idea.startupOpportunity.opportunityType.replaceAll("-", " ")}</dd></div>
          <div><dt>Paying customer</dt><dd>{idea.startupOpportunity.payingCustomerSegment}</dd></div>
          <div><dt>Trigger</dt><dd>{idea.startupOpportunity.trigger}</dd></div>
          <div><dt>Current substitute</dt><dd>{idea.startupOpportunity.existingSubstitute}</dd></div>
          <div><dt>Gap assessment</dt><dd>{idea.startupOpportunity.gapAssessment.kind}: {idea.startupOpportunity.gapAssessment.description}</dd></div>
          <div><dt>Smallest sellable workflow</dt><dd>{idea.startupOpportunity.smallestSellableWorkflow}</dd></div>
          <div><dt>First customer route</dt><dd>{idea.startupOpportunity.firstCustomerRoute}</dd></div>
          {#if idea.focusedDemandTest}
            <div><dt>Primary demand assumption</dt><dd>{idea.focusedDemandTest.assumption.category.replaceAll("-", " ")}: {idea.focusedDemandTest.assumption.testableClaim}</dd></div>
            <div><dt>Short demand test</dt><dd>{idea.focusedDemandTest.methodSummary}</dd></div>
            <div><dt>Disconfirming observation</dt><dd>{idea.focusedDemandTest.disconfirmingObservation}</dd></div>
            {#if idea.focusedDemandTest.paymentTerms}<div><dt>Price and commitment</dt><dd>{idea.focusedDemandTest.paymentTerms.amount} {idea.focusedDemandTest.paymentTerms.currency}. {idea.focusedDemandTest.paymentTerms.commitmentAction}</dd></div>{/if}
          {:else}
            <div><dt>Demand test that could disconfirm this</dt><dd>{idea.startupOpportunity.disconfirmingDemandTest}</dd></div>
          {/if}
        </dl>
      </details>
    {/if}
      {#if loading}<p role="status">Loading saved details…</p>{/if}
      {#if error}<p role="alert">{error}</p><button onclick={loadDetail}>Retry details</button>{/if}
      {#if detail}
        {#if supportingReferences.length || contraryReferences.length || detail.factors.length || detail.contrarySources?.length}
        <details class="deep-review"><summary>Evidence and sources</summary>
        <div class="source-columns">
        {#if supportingReferences.length}<section aria-label="Sources supporting this option"><h3>Supporting sources</h3>
          <ul>{#each supportingReferences as source (source.id)}<li>{#if source.url}<a href={source.url} onclick={(event) => { event.preventDefault(); void onOpenSource(source.url!); }}>{source.title}</a>{:else}{source.title}{/if}</li>{/each}</ul>
        </section>{/if}
        {#if contraryReferences.length}<section aria-label="Sources challenging this option"><h3>Challenging sources</h3>
          <ul>{#each contraryReferences as source (source.id)}<li>{#if source.url}<a href={source.url} onclick={(event) => { event.preventDefault(); void onOpenSource(source.url!); }}>{source.title}</a>{:else}{source.title}{/if}</li>{/each}</ul>
        </section>{/if}
        </div>
        {#if detail.factors.length}<h3>Observations</h3>
        {#each detail.factors as factor (factor.id)}
          <blockquote>{factor.quote}<p class="status">{evidenceSummary(factor)}</p>{#if factor.uncertainty}<p class="status">Uncertainty: {factor.uncertainty}</p>{/if}{#if (factor as typeof factor & EvidenceMetadata).demandEvidenceUncertainty}<p class="status">Demand evidence gap: {(factor as typeof factor & EvidenceMetadata).demandEvidenceUncertainty}</p>{/if}<footer><a href={factor.sourceUrl} onclick={(event) => { event.preventDefault(); void onOpenSource(factor.sourceUrl); }}>{factor.sourceTitle}</a></footer></blockquote>
        {/each}{/if}
        {#if detail.contrarySources?.length}<h3>Problem sources</h3>
        {#each detail.contrarySources ?? [] as source (source.id)}
          <details><summary>{source.title}</summary><a href={source.url} onclick={(event) => { event.preventDefault(); void onOpenSource(source.url); }}>Open source</a><p class="source-text">{source.text}</p></details>
        {/each}{/if}
        </details>
        {/if}
        {#if !analysis && detail.riskEvaluation}
          <details class="deep-review"><summary>Risks</summary>
            {#each detail.riskEvaluation.risks as risk (risk.riskId)}<div class="finding"><strong>{risk.description}</strong><p>{risk.whyDecisive}</p></div>{/each}
            {#if detail.riskEvaluation.unknowns.length}<h3>Open questions</h3><ul>{#each detail.riskEvaluation.unknowns as unknown, index (index)}<li>{unknown}</li>{/each}</ul>{/if}
          </details>
        {/if}
        {#if analysis || focusedExperiment}
          <details class="next-experiment" open><summary>Next experiment</summary>
          {#if focusedExperiment}<FocusedExperiment experiment={focusedExperiment} quiet />{:else if analysis}<strong>{analysis.experiment.question}</strong><p>{analysis.experiment.method}</p>
            <dl><div><dt>Cost</dt><dd>{analysis.experiment.cost}</dd></div><div><dt>Pass</dt><dd>{analysis.experiment.passCriterion}</dd></div><div><dt>Fail</dt><dd>{analysis.experiment.failCriterion}</dd></div><div><dt>Inconclusive</dt><dd>{"inconclusiveCriterion" in analysis.experiment ? String(analysis.experiment.inconclusiveCriterion) : "The result does not clearly meet the pass or fail criterion."}</dd></div></dl>
          {/if}</details>
        {/if}
        {#if analysis}
          {#if idea.selected && !focusedExperiment && onPlanExperiment}
            <button class="plan-experiment" disabled={busy} onclick={() => onPlanExperiment?.(idea)}>Plan a focused experiment</button>
          {/if}
          {#if analysis.risks.length || analysis.proposedResponses.length || analysis.unknowns.length}<details class="deep-review"><summary>Risks and responses</summary>
          {#each analysis.risks as risk (risk.riskId)}<div class="finding"><strong>{risk.description}</strong><p>{risk.whyDecisive}</p></div>{/each}
          {#if analysis.proposedResponses.length}<h3>What to try</h3>{/if}
          {#each analysis.proposedResponses as response, index (index)}<div class="finding response"><strong>{response.approach}</strong><p>Addresses: {analysis.risks.filter((risk) => response.riskIds.includes(risk.riskId)).map((risk) => risk.description).join("; ")}</p><p>Cost: {response.cost}</p><p>Fails if: {response.failsIf}</p></div>{/each}
          {#if analysis.unknowns.length}<h3>Open questions</h3><ul>{#each analysis.unknowns as unknown, index (index)}<li>{unknown}</li>{/each}</ul>{/if}
          </details>{/if}
          {#if analysis.consequences.length}<details class="deep-review"><summary>Possible outcomes</summary>
          {#each analysis.consequences as consequence, index (index)}<div class="finding"><span class="outcome-direction">{consequence.direction.replaceAll("-", " ").replace(/^./, (letter) => letter.toUpperCase())}</span><strong>{consequence.description}</strong><p>Affects {consequence.affects}. {consequence.rationale}</p></div>{/each}
          </details>{/if}
          {#if detail.evidenceFollowUp}
            <section class="follow-up" aria-label="Evidence follow-up result">
              <h3>Evidence follow-up</h3>
              <p><strong>Question:</strong> {detail.evidenceFollowUp.question}</p>
              {#if detail.evidenceFollowUp.status === "running"}<p role="status">Checking saved sources for this question...</p>{/if}
              {#each detail.evidenceFollowUp.factors as factor (factor.id)}
                <blockquote>{factor.quote}{#if factor.uncertainty}<p class="status">Uncertainty: {factor.uncertainty}</p>{/if}<footer><a href={factor.sourceUrl} onclick={(event) => { event.preventDefault(); void onOpenSource(factor.sourceUrl); }}>{factor.sourceTitle}</a></footer></blockquote>
              {/each}
              {#if followUpSourcesWithoutQuotes.length}
                <h3>Other sources checked</h3>
                <ul>{#each followUpSourcesWithoutQuotes as source (source.id)}<li><a href={source.url} onclick={(event) => { event.preventDefault(); void onOpenSource(source.url); }}>{source.title}</a></li>{/each}</ul>
              {/if}
              {#if detail.evidenceFollowUp.status === "completed" && !detail.evidenceFollowUp.factors.length}<p role="status">The follow-up completed without a quote-verified observation.</p>{/if}
              {#if detail.evidenceFollowUp.status === "failed"}<p role="alert">{detail.evidenceFollowUp.error ?? "The evidence follow-up failed."}</p>{/if}
              {#if enhancedFollowUp?.reassessmentStatus === "running"}<p role="status">Reassessing with the follow-up evidence...</p>{/if}
              {#if enhancedFollowUp?.reassessmentStatus === "failed"}<p role="alert">{enhancedFollowUp.reassessmentError ?? "The reassessment failed."}</p>{/if}
              {#if enhancedFollowUp?.reassessmentAnalysis}
                <details class="reassessment"><summary>Reassessment with new evidence</summary>
                  <h3>Updated consequences</h3>
                  {#each enhancedFollowUp.reassessmentAnalysis.consequences as consequence, index (index)}<div class="finding"><span class="outcome-direction">{consequence.direction.replaceAll("-", " ").replace(/^./, (letter) => letter.toUpperCase())}</span><strong>{consequence.description}</strong><p>{consequence.rationale}</p></div>{/each}
                  <h3>Reassessed risks</h3>
                  {#each enhancedFollowUp.reassessmentAnalysis.risks as risk (risk.riskId)}
                    <div class="finding"><strong>{reassessedRiskLabel(risk)}</strong><p>{risk.whyDecisive}</p>{#if reassessedRiskChange(risk.riskId)}<p class="status">Evidence change: {reassessedRiskChange(risk.riskId)}</p>{/if}</div>
                  {/each}
                  <h3>Updated proposed responses</h3>
                  {#each enhancedFollowUp.reassessmentAnalysis.proposedResponses as response, index (index)}<div class="finding response"><strong>{response.approach}</strong><p>Cost: {response.cost}</p><p>Fails if: {response.failsIf}</p></div>{/each}
                  {#if enhancedFollowUp.reassessmentAnalysis.unknowns.length}<h3>Reassessed open questions</h3><ul>{#each enhancedFollowUp.reassessmentAnalysis.unknowns as unknown, index (index)}<li>{#if isNewReassessmentUnknown(unknown)}<strong>New question:</strong> {/if}{unknown}</li>{/each}</ul>{/if}
                  <section class="experiment"><h3>Updated experiment</h3><strong>{enhancedFollowUp.reassessmentAnalysis.experiment.question}</strong><p>{enhancedFollowUp.reassessmentAnalysis.experiment.method}</p><dl><div><dt>Cost</dt><dd>{enhancedFollowUp.reassessmentAnalysis.experiment.cost}</dd></div><div><dt>Pass</dt><dd>{enhancedFollowUp.reassessmentAnalysis.experiment.passCriterion}</dd></div><div><dt>Fail</dt><dd>{enhancedFollowUp.reassessmentAnalysis.experiment.failCriterion}</dd></div><div><dt>Inconclusive</dt><dd>{enhancedFollowUp.reassessmentAnalysis.experiment.inconclusiveCriterion}</dd></div></dl></section>
                </details>
              {:else if detail.evidenceFollowUp.status === "completed" && detail.canReassessEvidence && idea.runId && onEvidenceReassessment}
                <button class="reassess" disabled={busy} onclick={() => onEvidenceReassessment?.(idea.runId!)}>Reassess with new evidence</button>
              {/if}
            </section>
          {:else if idea.selected && idea.runId && analysis && idea.canRequestEvidenceFollowUp && onEvidenceFollowUp}
            <form onsubmit={(event) => { event.preventDefault(); void onEvidenceFollowUp(idea.runId!, followUpQuestion.trim()); }}>
              <h3>Evidence follow-up</h3>
              <label>Question<textarea rows="2" maxlength="500" bind:value={followUpQuestion} placeholder="What should we verify next?"></textarea></label>
              <button disabled={busy || !followUpQuestion.trim()}>Check evidence</button>
            </form>
          {/if}
          <form class="decision-editor" onsubmit={(event) => { event.preventDefault(); void save(); }}>
            <h3>Decision and result</h3>            <label>Your decision<textarea rows="3" maxlength="8000" bind:value={userDecision} oninput={() => saved = false} placeholder="What did you decide?"></textarea></label>
            <label>Observed test result<textarea rows="3" maxlength="8000" bind:value={observedResult} oninput={() => saved = false} placeholder="What happened?"></textarea></label>
            <label>Experiment outcome<select bind:value={experimentOutcome} oninput={() => saved = false}><option value="not-run">Not run</option><option value="pass">Pass</option><option value="fail">Fail</option><option value="inconclusive">Inconclusive</option></select></label>
            <button disabled={busy}>Save decision and result</button>{#if saved}<span role="status">Saved</span>{/if}
          </form>
        {/if}
      {/if}
    </div>
</article>

<style>
  article { min-width:0;overflow-wrap:anywhere;background:var(--bg);max-width:900px; }
  .detail-page .disclosure-content { padding:0;background:var(--bg); }
  h3 { margin:24px 0 12px;font-size:16px;font-weight:600;line-height:1.4;color:var(--text); }
  p,li { line-height:1.6;font-size:15px;max-width:68ch;color:var(--text); }
  p { margin:12px 0; }ul { list-style:disc;padding-left:22px; }li + li { margin-top:8px; }
  .status { color:var(--muted);font-size:13px;line-height:1.6; }
  .problem { color:var(--text); }
  dl { display:grid;grid-template-columns:1fr;margin:16px 0;max-width:68ch; }
  dl > div { padding:14px 0;border-bottom:1px solid var(--border); }
  dt { color:var(--muted);font-size:13px;margin-bottom:6px;line-height:1.6; }
  dd { margin:0;color:var(--text);font-size:15px;line-height:1.6; }
  button { padding:9px 14px;border:1px solid var(--border-strong);border-radius:7px;background:transparent;color:var(--text);font-size:13px;cursor:pointer; }
  button:hover { background:var(--surface-2); }button:disabled { opacity:.5; }
  details { border-top:1px solid var(--border);padding:0 0 0 24px; }
  summary { position:relative;list-style:none;cursor:pointer;padding:20px 0;font-size:15px;font-weight:600;color:var(--text);line-height:1.6; }
  summary::-webkit-details-marker { display:none; }
  summary::before { content:"";position:absolute;left:-22px;top:28px;width:7px;height:7px;border-right:1px solid var(--muted);border-bottom:1px solid var(--muted);transform:rotate(-45deg);transition:transform 120ms; }
  details[open] > summary::before { transform:rotate(45deg); }
  details[open] { padding-bottom:20px; }
  .source-columns { display:grid;gap:12px; }.source-columns h3 { margin-top:8px; }
  blockquote { margin:20px 0;padding:4px 0 4px 20px;border-left:2px solid var(--border-strong);font-size:15px;line-height:1.6;color:var(--text);max-width:68ch; }
  footer { margin-top:12px;font-size:13px;color:var(--muted); }
  a { color:var(--text);text-decoration:underline;text-underline-offset:3px; }
  .finding { border-bottom:1px solid var(--border);padding:16px 0;max-width:68ch; }
  .finding strong { font-size:15px;font-weight:600;line-height:1.6; }.finding p { margin-bottom:0; }
  .outcome-direction { display:block;margin-bottom:6px;font-size:13px;color:var(--muted);line-height:1.6; }
  .finding strong { color:var(--text); }
  .response p { font-size:14px;color:var(--muted); }
  .criterion-sources { display:flex;flex-direction:column;align-items:flex-start;gap:6px;margin-top:8px; }
  .next-experiment > strong { display:block;font-size:16px;line-height:1.6;max-width:68ch; }
  form { padding:24px 0;border-top:1px solid var(--border);margin-top:24px;max-width:68ch; }
  form h3 { margin-top:0; }
  label { display:grid;gap:8px;margin:20px 0;font-size:13px;color:var(--muted); }
  textarea,select { width:100%;background:var(--surface);color:var(--text);border:1px solid var(--border-strong);border-radius:7px;padding:12px;font-size:15px;line-height:1.6; }
  textarea { resize:vertical;min-height:90px; }
  .reassess,.plan-experiment { margin:14px 0; }
  .source-text { white-space:pre-wrap; }form span { margin-left:12px;font-size:13px;color:var(--muted); }
  @media (min-width:900px) { .first-test dl { grid-template-columns:repeat(2,minmax(0,1fr));column-gap:32px; } }
  @media (prefers-reduced-motion:reduce) { summary::before { transition:none; } }
</style>
