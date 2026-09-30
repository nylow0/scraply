<script lang="ts">
  import type { RunTrace as RunTraceValue, RunTraceCandidate, RunTraceSearch, RunTraceStep, RunTraceStepDetail } from "../../shared/run-trace";
  import { ProblemFactorAssessmentSchema, WorkflowV2SolutionSetReviewOutputSchema } from "../../shared/structured-output-schemas";
  import Icon from "./Icon.svelte";

  let { runId, onOpenSource }: { runId: string; onOpenSource?: (url: string) => void | Promise<void> } = $props();
  let trace = $state<RunTraceValue | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let exporting = $state(false);
  let exportError = $state<string | null>(null);
  let expanded = $state<Record<string, boolean>>({});
  let details = $state<Record<string, RunTraceStepDetail>>({});
  let detailLoading = $state<Record<string, boolean>>({});
  let detailErrors = $state<Record<string, string>>({});
  let refreshRevision = $state(0);
  let detailVersions: Record<string, string> = {};
  let loadEpoch = 0;
  let timelineGroups = $derived.by(() => {
    if (!trace) return [];
    const steps = trace.steps;
    const investigatorSteps = new Set(trace.investigators.flatMap((investigator) => investigator.stepIds));
    const general = { id: "general", investigator: null, steps: steps.filter((step) => !investigatorSteps.has(step.id)) };
    const investigators = trace.investigators.map((investigator) => {
      const stepIds = new Set(investigator.stepIds);
      return { id: `investigator:${investigator.id}`, investigator, steps: steps.filter((step) => stepIds.has(step.id)) };
    });
    return [general, ...investigators].filter((group) => group.investigator || group.steps.length);
  });

  $effect(() => {
    const request = { runId, refreshRevision };
    const requestedRunId = request.runId;
    const epoch = ++loadEpoch;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    trace = null;
    loading = true;
    error = null;
    expanded = {};
    details = {};
    detailLoading = {};
    detailErrors = {};
    detailVersions = {};
    exportError = null;
    exporting = false;

    async function refresh() {
      try {
        const next = await window.scraply.getRunTrace({ runId: requestedRunId });
        if (disposed) return;
        trace = next;
        error = null;
        for (const step of next.steps) {
          if (expanded[step.id] && detailVersions[step.id] !== stepVersion(step)) void loadStep(step);
        }
      } catch (cause) {
        if (!disposed) error = cause instanceof Error ? cause.message : String(cause);
      } finally {
        if (!disposed && epoch === loadEpoch) {
          loading = false;
          // A finished or paused run stays still. Failed refreshes retain the live trace and retry.
          if (trace?.live) timer = setTimeout(refresh, 2_000);
        }
      }
    }
    void refresh();
    return () => {
      disposed = true;
      loadEpoch += 1;
      if (timer) clearTimeout(timer);
    };
  });

  function stepVersion(step: RunTraceStep): string {
    return JSON.stringify([step.status, step.finishedAt, step.attempts.map((attempt) => [attempt.id, attempt.status, attempt.finishedAt])]);
  }

  async function loadStep(step: RunTraceStep) {
    if (detailLoading[step.id]) return;
    const epoch = loadEpoch;
    const requestedRunId = runId;
    detailLoading[step.id] = true;
    delete detailErrors[step.id];
    try {
      const next = await window.scraply.getRunTraceStep({ runId: requestedRunId, stepId: step.id });
      if (epoch !== loadEpoch) return;
      details[step.id] = next;
      detailVersions[step.id] = stepVersion(step);
    } catch (cause) {
      if (epoch === loadEpoch) detailErrors[step.id] = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (epoch === loadEpoch) detailLoading[step.id] = false;
    }
  }

  function toggleStep(step: RunTraceStep) {
    expanded[step.id] = !expanded[step.id];
    if (expanded[step.id] && detailVersions[step.id] !== stepVersion(step)) void loadStep(step);
  }

  async function exportTrace() {
    if (!trace || exporting) return;
    const savedTrace = trace;
    const epoch = loadEpoch;
    exporting = true;
    exportError = null;
    try {
      const savedDetails: RunTraceStepDetail[] = [];
      // Fetch saved details afresh so the export includes steps the user has not opened.
      for (const step of savedTrace.steps) {
        savedDetails.push(await window.scraply.getRunTraceStep({ runId: savedTrace.runId, stepId: step.id }));
        if (epoch !== loadEpoch) return;
      }
      const blob = new Blob([JSON.stringify({ ...savedTrace, details: savedDetails }, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `scraply-run-${savedTrace.runId}-trace.json`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (cause) {
      if (epoch === loadEpoch) exportError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (epoch === loadEpoch) exporting = false;
    }
  }

  function label(value: string): string {
    const words = value.replace(/[-_]/g, " ");
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  function duration(milliseconds: number): string {
    const seconds = Math.floor(milliseconds / 1_000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }

  function time(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
  }

  function percent(value: number | null): string {
    return value === null ? "Unknown" : `${Math.round(value * 100)}%`;
  }

  function json(value: unknown): string {
    return JSON.stringify(value, null, 2) ?? "Not saved";
  }
</script>

{#snippet mix(title: string, values: Record<string, number>)}
  {@const total = Object.values(values).reduce((sum, count) => sum + count, 0)}
  <section class="mix">
    <h3>{title}</h3>
    {#if Object.keys(values).length === 0}
      <p class="muted">No saved classifications.</p>
    {:else}
      <dl class="mix-list">
        {#each Object.entries(values) as [role, count] (role)}
          <div>
            <dt>{label(role)}</dt>
            <dd>{count}<span>{total ? percent(count / total) : "0%"}</span></dd>
            <div class="mix-bar" aria-hidden="true"><i style:width={`${total ? count / total * 100 : 0}%`}></i></div>
          </div>
        {/each}
      </dl>
    {/if}
  </section>
{/snippet}

{#snippet candidateOutcome(candidate: RunTraceCandidate)}
  <details class="candidate">
    <summary><span>{candidate.statement}</span><span class="badge" class:confirmed={candidate.state === "confirmed"}>{label(candidate.state)}</span></summary>
    <div class="candidate-body">
      <p>{candidate.reason || "No assessment reason was saved."}</p>
      {#if candidate.derived}<p class="muted">This state comes from the saved candidate and verdict records.</p>{/if}
      <dl class="inline-metrics">
        <div><dt>Qualifying observations</dt><dd>{candidate.qualifyingObservations}</dd></div>
        <div><dt>Independent sources</dt><dd>{candidate.independentSources}</dd></div>
      </dl>
      {#if candidate.factorIds.length}<p class="muted">Evidence IDs: <code>{candidate.factorIds.join(", ")}</code></p>{/if}
      {#if candidate.assessments.length}
        <h5>Fact assessments</h5>
        <ul class="assessment-list">
          {#each candidate.assessments as assessment, assessmentIndex (assessmentIndex)}
            {@const parsed = ProblemFactorAssessmentSchema.safeParse(assessment)}
            <li>
              {#if parsed.success}
                <strong>{parsed.data.factorId}</strong>
                <span class="muted">{label(parsed.data.sourceRole)}, {label(parsed.data.audienceFit)}</span>
                <p>{parsed.data.reason}</p>
                <p class="muted">Independent source: {parsed.data.independentSourceKey ?? "Unknown"}</p>
              {:else}<pre>{json(assessment)}</pre>{/if}
            </li>
          {/each}
        </ul>
      {/if}
      {#if candidate.candidate !== null}<details class="raw"><summary>Saved candidate</summary><pre>{json(candidate.candidate)}</pre></details>{/if}
    </div>
  </details>
{/snippet}

{#snippet searchDetail(search: RunTraceSearch)}
  <article class="search-detail">
    <h5>{search.query}</h5>
    <dl class="search-context">
      <div><dt>Intent</dt><dd>{label(search.intent) || "Not saved"}</dd></div>
      <div><dt>Planner's reason</dt><dd>{search.reason || "Not saved"}</dd></div>
      <div><dt>Expected source type</dt><dd>{label(search.expectedSourceType) || "Not saved"}</dd></div>
      <div><dt>Provider</dt><dd>{search.provider ? label(search.provider) : "Not saved"}</dd></div>
      {#if search.route}<div><dt>Route</dt><dd>{label(search.route)}</dd></div>{/if}
    </dl>
    {#if search.status === "not-saved"}<p class="muted">No saved results are available for this query.</p>
    {:else if search.results.length === 0}<p class="muted">The saved search returned no results.</p>
    {:else}
      <ul class="source-list">
        {#each search.results as source, sourceIndex (`${source.url}:${sourceIndex}`)}
          <li>
            {#if onOpenSource}<button class="source-title" onclick={() => onOpenSource?.(source.url)}>{source.title || source.url}</button>
            {:else}<strong>{source.title || source.url}</strong>{/if}
            <span class="source-url">{source.url}</span>
            <span class="muted">{label(source.sourceClass)}. {source.factsKept} facts kept.</span>
          </li>
        {/each}
      </ul>
    {/if}
    <details class="raw"><summary>Saved search parameters</summary><pre>{json(search.parameters)}</pre></details>
  </article>
{/snippet}

<section class="run-trace" aria-labelledby="run-trace-title">
  <header class="trace-header">
    <div><h2 id="run-trace-title">Run trace</h2><p>Follow the saved searches, evidence, and decisions behind this run.</p></div>
    <button class="export" disabled={!trace || exporting} onclick={exportTrace}>{exporting ? "Preparing JSON..." : "Export trace JSON"}</button>
  </header>

  {#if error}<div class="trace-error" role="alert">{error}<button onclick={() => refreshRevision += 1}>Reload trace</button></div>{/if}
  {#if exportError}<div class="trace-error" role="alert">Could not export the trace. {exportError}</div>{/if}
  {#if loading}<p class="empty" role="status">Loading run trace...</p>
  {:else if trace}
    <div class="run-identity"><span class="badge" class:live={trace.live}>{trace.live ? "Live" : label(trace.status)}</span><span>{label(trace.purpose)}</span><span>Started {time(trace.startedAt)}</span></div>
    {#each trace.warnings as warning, warningIndex (warningIndex)}<p class="trace-warning">{warning}</p>{/each}

    <section class="funnel" aria-labelledby="candidate-funnel-title">
      <div class="section-heading"><h3 id="candidate-funnel-title">Candidate funnel</h3><span>{percent(trace.metrics.confirmationRate)} confirmed among assessed</span></div>
      <dl class="funnel-counts">
        <div><dt>Candidates</dt><dd>{trace.metrics.candidateFunnel.total}</dd></div>
        <div><dt>Assessed</dt><dd>{trace.metrics.candidateFunnel.assessed}</dd></div>
        <div class="confirmed-count"><dt>Confirmed</dt><dd>{trace.metrics.candidateFunnel.confirmed}</dd></div>
        <div><dt>Insufficient</dt><dd>{trace.metrics.candidateFunnel.insufficient}</dd></div>
        <div><dt>Dropped</dt><dd>{trace.metrics.candidateFunnel.dropped}</dd></div>
        <div><dt>Not assessed</dt><dd>{trace.metrics.candidateFunnel.notAssessed}</dd></div>
        <div><dt>User asserted</dt><dd>{trace.metrics.candidateFunnel.userAsserted}</dd></div>
      </dl>
    </section>

    <dl class="run-metrics">
      <div><dt>Saved observations</dt><dd>{trace.metrics.factors}</dd></div>
      <div><dt>Sources</dt><dd>{trace.metrics.totalSources}</dd></div>
      <div><dt>Qualifying observations</dt><dd>{trace.metrics.qualifyingObservations}</dd></div>
      <div><dt>Qualifying per assessed candidate</dt><dd>{trace.metrics.qualifyingPerAssessedCandidate === null ? "Unknown" : trace.metrics.qualifyingPerAssessedCandidate.toLocaleString(undefined, { maximumFractionDigits: 2 })}</dd></div>
      <div><dt>Ideas</dt><dd>{trace.metrics.ideas}</dd></div>
      <div><dt>Accepted ideas</dt><dd>{trace.metrics.acceptedIdeas}</dd></div>
      <div><dt>Model calls</dt><dd>{trace.metrics.modelCalls}</dd></div>
      <div><dt>Searches</dt><dd>{trace.metrics.searches}</dd></div>
      <div><dt>Wall time</dt><dd>{duration(trace.metrics.wallTimeMs)}</dd></div>
      <div><dt>Model time</dt><dd>{duration(trace.metrics.modelTimeMs)}</dd></div>
      <div><dt>Interruptions</dt><dd>{trace.metrics.interruptions}</dd></div>
      <div><dt>Time lost to interruptions</dt><dd>{duration(trace.metrics.interruptionTimeMs)}</dd></div>
    </dl>

    <div class="mixes">
      {@render mix("Evidence mix", trace.metrics.evidenceMix)}
      {@render mix("Audience fit", trace.metrics.audienceFit)}
      {@render mix("Source mix", trace.metrics.sourceMix)}
    </div>

    {#if trace.metrics.coverage.groups.length}
      <section class="coverage" aria-labelledby="trace-coverage-title">
        <h3 id="trace-coverage-title">{trace.metrics.coverage.kind === "areas" ? "Areas covered" : "Phases covered"}</h3>
        <table><thead><tr><th>{trace.metrics.coverage.kind === "areas" ? "Area" : "Phase"}</th><th>Observations</th><th>Candidates</th><th>Confirmed</th></tr></thead><tbody>
          {#each trace.metrics.coverage.groups as group (group.id)}<tr><th scope="row">{label(group.id)}</th><td>{group.factors}</td><td>{group.problems}</td><td>{group.confirmed}</td></tr>{/each}
        </tbody></table>
      </section>
    {/if}

    {#if trace.candidates.length}
      <section class="candidate-outcomes" aria-labelledby="candidate-outcomes-title"><h3 id="candidate-outcomes-title">Candidate outcomes</h3>{#each trace.candidates as candidate (candidate.id)}{@render candidateOutcome(candidate)}{/each}</section>
    {/if}

    <section class="timeline" aria-labelledby="trace-timeline-title">
      <div class="section-heading"><h3 id="trace-timeline-title">Step timeline</h3><span>{trace.steps.length} saved steps{trace.live ? ", updates every 2 seconds" : ""}</span></div>
      {#if trace.steps.length === 0 && trace.investigators.length === 0}<p class="empty">No saved steps are available for this run yet.</p>
      {:else}
        {#each timelineGroups as group (group.id)}
          <section class="timeline-group" aria-label={group.investigator?.name ?? "General steps"}>
            {#if group.investigator}
              <div class="investigator-heading"><h4>{group.investigator.name}</h4><span class="badge">{label(group.investigator.state)}</span></div>
            {:else if trace.investigators.length}<h4>General steps</h4>{/if}
            {#if group.steps.length === 0}<p class="empty">No saved steps are available for this investigator yet.</p>{/if}
            <ol class="steps">
          {#each group.steps as step, index (step.id)}
            <li>
              <article class="step" class:step-open={expanded[step.id]}>
                <button class="step-toggle" aria-expanded={Boolean(expanded[step.id])} aria-controls={`trace-step-${encodeURIComponent(group.id)}-${encodeURIComponent(step.id)}`} onclick={() => toggleStep(step)}>
                  <span class="step-number">{index + 1}</span>
                  <span class="step-heading"><strong>{step.label}</strong><span>{label(step.kind)}{step.phase ? `, ${label(step.phase)}` : ""}</span></span>
                  <span class="step-state"><span class="badge">{label(step.status)}</span><span>{duration(step.durationMs)}</span></span>
                  <span class="expand-icon" class:rotated={expanded[step.id]}><Icon name="arrow" size={16} /></span>
                </button>
                <div class="step-metadata">
                  {#if step.prompt}<span>Prompt <code>{step.prompt.filename}</code> <span class="muted">{label(step.prompt.source)}</span></span>
                  {:else if step.kind === "model"}<span class="muted">Prompt identity not saved</span>{/if}
                  {#if step.attempts.length > 1}<span>{step.attempts.length - 1} {step.attempts.length === 2 ? "retry" : "retries"}</span>{/if}
                  {#if step.search}<span class="query-preview">{step.search.query}</span>{/if}
                </div>
                {#if step.attempts.length}
                  <ul class="attempts">
                    {#each step.attempts as attempt, attemptIndex (attempt.id)}
                      <li>
                        <div class="attempt-heading"><strong>{attempt.model}</strong><span>{attempt.effort} effort</span><span>{label(attempt.status)}</span><span>{duration(attempt.durationMs)}</span>{#if step.attempts.length > 1}<span>Attempt {attemptIndex + 1}</span>{/if}</div>
                        <dl class="attempt-tokens"><div><dt>Input tokens</dt><dd>{attempt.inputTokens ?? "Unknown"}</dd></div><div><dt>Output tokens</dt><dd>{attempt.outputTokens ?? "Unknown"}</dd></div><div><dt>Reasoning tokens</dt><dd>{attempt.reasoningTokens ?? "Unknown"}</dd></div></dl>
                        {#if attempt.message || attempt.errorCode}<p class="attempt-message">{attempt.errorCode ? `${attempt.errorCode}: ` : ""}{attempt.message ?? "No interruption message was saved."}</p>{/if}
                        {#if expanded[step.id]}<details class="raw"><summary>Reasoning summary</summary><p>{attempt.reasoningSummary ?? "Not available"}</p></details>{/if}
                      </li>
                    {/each}
                  </ul>
                {/if}
                {#if expanded[step.id]}
                  {@const detail = details[step.id]}
                  <div class="step-detail" id={`trace-step-${encodeURIComponent(group.id)}-${encodeURIComponent(step.id)}`}>
                    {#if detailLoading[step.id]}<p role="status" class="muted">Loading saved step details...</p>{/if}
                    {#if detailErrors[step.id]}<div class="trace-error" role="alert">{detailErrors[step.id]}<button onclick={() => loadStep(step)}>Retry loading details</button></div>{/if}
                    {#if detail}
                      {@const review = WorkflowV2SolutionSetReviewOutputSchema.safeParse(detail.output)}
                      {#if detail.searches.length}<section><h4>Searches</h4>{#each detail.searches as search, searchIndex (`${search.key}:${searchIndex}`)}{@render searchDetail(search)}{/each}</section>{/if}
                      {#if detail.facts.length}
                        <section><h4>Observations read</h4><ul class="facts">
                          {#each detail.facts as fact, factIndex (fact.id ?? `${fact.sourceId}:${factIndex}`)}<li><div class="fact-heading"><strong>{fact.subject}</strong><span class="badge">{fact.kept === null ? "Saved" : fact.kept ? "Kept" : "Rejected"}</span></div><p>{fact.behavior}</p><blockquote>{fact.quote}</blockquote><p class="muted">{label(fact.sourceRole)}, {label(fact.audienceFit)}. Source <code>{fact.sourceId}</code>{fact.id ? `, fact ${fact.id}` : ""}.</p>{#if fact.reason}<p>{fact.reason}</p>{/if}</li>{/each}
                        </ul></section>
                      {/if}
                      {#if detail.candidates.length}<section><h4>Candidates and verdicts</h4>{#each detail.candidates as candidate (candidate.id)}{@render candidateOutcome(candidate)}{/each}</section>{/if}
                      {#if review.success}<section><h4>Idea reviewer decisions</h4><ul class="assessment-list">{#each review.data.assessments as assessment (assessment.candidateId)}<li><strong>{assessment.candidateId}</strong><span class="badge">{label(assessment.decision)}</span><p>{assessment.reason}</p>{#if assessment.matchingSolutionId}<p class="muted">Matching idea: {assessment.matchingSolutionId}</p>{/if}{#if assessment.citedEvidenceIds.length}<p class="muted">Evidence IDs: {assessment.citedEvidenceIds.join(", ")}</p>{/if}</li>{/each}</ul></section>{/if}
                      <details class="raw"><summary>Saved input</summary>{#if detail.inputs === null}<p>Input was not saved for this step.</p>{:else}<pre>{json(detail.inputs)}</pre>{/if}</details>
                      <details class="raw"><summary>Saved output</summary>{#if detail.output === null}<p>Output was not saved for this step.</p>{:else}<pre>{json(detail.output)}</pre>{/if}</details>
                      {#if detail.evidence.length}<details class="raw"><summary>Saved evidence</summary><pre>{json(detail.evidence)}</pre></details>{/if}
                      {#if detail.events.length}<details class="raw"><summary>Progress and interruption messages</summary><ul class="event-list">{#each detail.events as event, eventIndex (eventIndex)}<li><strong>{label(event.type)}</strong><time>{time(event.createdAt)}</time><pre>{json(event.payload)}</pre></li>{/each}</ul></details>{/if}
                      {#if step.prompt}<details class="raw"><summary>Prompt identity</summary><p><code>{step.prompt.filename}</code>, {label(step.prompt.source)}</p><p class="muted">SHA-256 <code>{step.prompt.sha256}</code></p></details>{/if}
                    {/if}
                  </div>
                {/if}
              </article>
            </li>
          {/each}
            </ol>
          </section>
        {/each}
      {/if}
    </section>
  {/if}
</section>

<style>
  .run-trace { display:flex;flex-direction:column;gap:30px;max-width:var(--page-max);margin:0 auto;padding:var(--page-top) var(--page-inline) 60px; }
  .trace-header,.section-heading,.run-identity,.attempt-heading,.fact-heading { display:flex;align-items:center;flex-wrap:wrap;gap:10px 18px; }
  .trace-header,.section-heading { justify-content:space-between; }
  h2 { margin:0;font-size:30px;font-weight:600;letter-spacing:-.025em; }
  h3 { margin:0 0 18px;font-size:16px;font-weight:600; }
  h4 { margin:0 0 14px;font-size:14px;font-weight:600; }
  h5 { margin:0 0 12px;font-size:13px;font-weight:600; }
  p { margin:0;font-size:13px;line-height:1.7;overflow-wrap:anywhere; }
  .trace-header p { margin-top:8px;color:var(--muted); }
  button { border:1px solid var(--border-strong);border-radius:8px;background:transparent;color:var(--text);font-size:13px; }
  button:hover:not(:disabled) { background:var(--surface-2); }
  button:disabled { opacity:.4;cursor:default; }
  .export { min-height:38px;padding:8px 13px; }
  .run-identity,.section-heading > span { font-size:12px;color:var(--muted); }
  .badge { display:inline-block;border:1px solid var(--border-strong);border-radius:5px;padding:3px 7px;font-size:11px;line-height:1.4;font-weight:500;white-space:nowrap; }
  .badge.live { border-color:var(--accent);color:var(--accent-strong); }
  .confirmed { color:var(--success); }
  .section-heading { margin-bottom:18px; }.section-heading h3 { margin:0; }
  .funnel { padding:20px 0;border-block:1px solid var(--border); }
  .funnel-counts { display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:18px;margin:0; }
  .funnel-counts dt { font-size:11px;color:var(--muted); }.funnel-counts dd { margin:5px 0 0;font-size:28px;line-height:1.1;font-weight:600;font-variant-numeric:tabular-nums; }
  .confirmed-count dd { color:var(--success); }
  .run-metrics { display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:22px 18px;margin:0; }
  .run-metrics dt,.inline-metrics dt { color:var(--muted);font-size:12px; }.run-metrics dd { margin:6px 0 0;font-size:16px;font-weight:500;font-variant-numeric:tabular-nums; }
  .mixes { display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:28px; }
  .mix-list { display:flex;flex-direction:column;gap:13px;margin:0; }.mix-list > div { display:grid;grid-template-columns:1fr auto;gap:7px 8px; }
  .mix-list dt,.mix-list dd { margin:0;font-size:12px; }.mix-list dd { font-variant-numeric:tabular-nums; }.mix-list dd span { margin-left:9px;color:var(--muted);font-size:11px; }
  .mix-bar { grid-column:1 / -1;height:4px;background:var(--surface-2);border-radius:3px; }.mix-bar i { display:block;height:100%;background:var(--accent);border-radius:3px; }
  .coverage table { width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed; }.coverage th,.coverage td { padding:11px 7px;border-bottom:1px solid var(--border);text-align:right;overflow-wrap:anywhere; }.coverage th:first-child { text-align:left;width:40%; }.coverage thead th { color:var(--muted);font-weight:400; }.coverage tbody th { font-weight:500; }
  .candidate { border-bottom:1px solid var(--border); }.candidate summary { display:flex;align-items:flex-start;gap:14px;padding:15px 0;cursor:pointer;font-size:13px; }.candidate summary > span:first-child { flex:1;line-height:1.6; }.candidate summary::before { content:"+";color:var(--muted); }.candidate[open] summary::before { content:"−"; }.candidate-body { padding:0 0 18px 24px;display:flex;flex-direction:column;gap:14px; }
  .inline-metrics { display:flex;flex-wrap:wrap;gap:12px 28px;margin:0; }.inline-metrics dd { margin:4px 0 0;font-size:13px; }
  .steps { display:flex;flex-direction:column;gap:14px;padding:0;margin:0;list-style:none; }
  .timeline-group + .timeline-group { margin-top:28px; }.investigator-heading { display:flex;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:16px; }.investigator-heading h4 { margin:0; }
  .step { border:1px solid var(--border);border-radius:10px; }.step-open { border-color:var(--border-strong); }
  .step-toggle { display:flex;align-items:center;gap:14px;width:100%;padding:17px 18px;border:0;text-align:left; }.step-number { color:var(--subtle);font-size:12px;font-variant-numeric:tabular-nums;width:20px;flex:none; }
  .step-heading { flex:1;min-width:0;display:flex;flex-direction:column;gap:5px; }.step-heading strong { font-size:14px;font-weight:500;overflow-wrap:anywhere; }.step-heading > span { font-size:11px;color:var(--muted); }
  .step-state { display:flex;align-items:center;flex-wrap:wrap;justify-content:flex-end;gap:8px;color:var(--muted);font-size:12px; }
  .expand-icon { display:flex;color:var(--subtle); }.expand-icon.rotated { transform:rotate(90deg); }
  .step-metadata { display:flex;flex-wrap:wrap;gap:8px 18px;padding:0 18px 13px 52px;font-size:11px;overflow-wrap:anywhere; }.step-metadata:empty { display:none; }.query-preview { color:var(--muted); }
  .attempts { margin:0;padding:0 18px 12px 52px;list-style:none; }.attempts > li { padding:10px 0;border-top:1px solid var(--border); }.attempt-heading { gap:6px 13px;font-size:11px;color:var(--muted); }.attempt-heading strong { color:var(--text);font-weight:500; }
  .attempt-tokens { display:flex;flex-wrap:wrap;gap:8px 18px;margin:8px 0 0;font-size:11px; }.attempt-tokens > div { display:flex;gap:6px; }.attempt-tokens dt { color:var(--muted); }.attempt-tokens dd { margin:0;font-variant-numeric:tabular-nums; }.attempt-message { color:var(--danger);font-size:12px;margin-top:10px; }
  .step-detail { display:flex;flex-direction:column;gap:22px;padding:20px 18px 22px 52px;border-top:1px solid var(--border);background:var(--surface);border-radius:0 0 10px 10px; }
  .search-detail + .search-detail { margin-top:24px;padding-top:20px;border-top:1px solid var(--border); }.search-context { margin:0 0 16px;display:flex;flex-direction:column;gap:9px; }.search-context > div { display:grid;grid-template-columns:145px 1fr;gap:12px; }.search-context dt { color:var(--muted);font-size:12px; }.search-context dd { margin:0;font-size:12px;line-height:1.6;overflow-wrap:anywhere; }
  .source-list,.facts,.assessment-list,.event-list { padding:0;margin:0;list-style:none; }.source-list li { display:flex;flex-direction:column;gap:4px;padding:12px 0;border-top:1px solid var(--border);font-size:12px; }.source-list strong { font-weight:500; }.source-title { align-self:flex-start;padding:0;border:0;border-radius:0;text-align:left;font-size:12px;font-weight:500;overflow-wrap:anywhere; }.source-title:hover { text-decoration:underline; }.source-url { color:var(--accent);overflow-wrap:anywhere; }.facts li,.assessment-list li { padding:14px 0;border-top:1px solid var(--border); }.facts p,.assessment-list p { margin-top:8px; }.assessment-list li > span { margin-left:10px; }.assessment-list strong,.fact-heading strong { font-size:13px;font-weight:500; }
  blockquote { border-left:2px solid var(--accent);padding:2px 0 2px 15px;margin:12px 0;font-size:13px;line-height:1.7;overflow-wrap:anywhere; }
  .raw { font-size:12px; }.raw summary { cursor:pointer;color:var(--muted);padding:7px 0; }.raw > p { margin-top:8px; }.raw > pre { margin-top:10px; }.event-list li { margin-top:14px; }.event-list time { margin-left:12px;color:var(--muted);font-size:11px; }
  pre { white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;font:11px/1.7 var(--mono);margin:8px 0 0;color:var(--muted); }.muted { color:var(--muted); }code { font:11px var(--mono);overflow-wrap:anywhere; }
  .trace-error { display:flex;align-items:center;flex-wrap:wrap;gap:12px;padding:13px 15px;border:1px solid #df92924a;border-radius:8px;color:var(--danger);font-size:13px; }.trace-error button { padding:7px 10px; }.trace-warning { padding:12px 0;border-bottom:1px solid var(--border);color:var(--muted); }.empty { color:var(--muted);padding:16px 0; }
  @container page (max-width:800px) { .funnel-counts { grid-template-columns:repeat(4,minmax(0,1fr));gap:20px; }.run-metrics { grid-template-columns:repeat(3,minmax(0,1fr)); }.mixes { grid-template-columns:repeat(2,minmax(0,1fr)); } }
  @container page (max-width:560px) { .run-trace { gap:24px; }.run-metrics,.mixes { grid-template-columns:repeat(2,minmax(0,1fr));gap:20px; }.mixes .mix:last-child { grid-column:1 / -1; }.step-toggle { gap:9px;padding:15px 12px; }.step-state { flex-direction:column;align-items:flex-end; }.step-metadata,.attempts { padding-left:41px;padding-right:12px; }.step-detail { padding:18px 12px; }.search-context > div { grid-template-columns:1fr;gap:3px; }.coverage th:first-child { width:32%; }.coverage th,.coverage td { padding-inline:3px;font-size:11px; }.funnel-counts dd { font-size:24px; } }
</style>
