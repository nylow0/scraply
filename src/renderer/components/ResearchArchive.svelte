<script lang="ts">
  import "./problem-review.css";
  import ResultsToolbar from "./ResultsToolbar.svelte";
  import ProblemLeads from "./ProblemLeads.svelte";
  import { verdictLabel } from "../lib/status";
  import { isProblem, problemLeads } from "../lib/problem-leads";
  import type { ProblemCandidate, RejectedProblemCandidate } from "../../shared/ipc";
  import type { PreviewWorkflowResult } from "../../shared/workflow-contracts";

  let {
    problems: allProblems,
    rejectedCandidates,
    extraLeads = [],
    busy,
    onExport,
    onOpenSource,
    previewCandidateAssessment,
    onAssessCandidate,
  }: {
    problems: ProblemCandidate[];
    rejectedCandidates: RejectedProblemCandidate[];
    extraLeads?: ProblemCandidate[] | undefined;
    busy: boolean;
    onExport: () => Promise<void>;
    onOpenSource: (url: string) => Promise<void>;
    previewCandidateAssessment?: (candidateId: string) => Promise<PreviewWorkflowResult>;
    onAssessCandidate?: (preview: PreviewWorkflowResult) => Promise<void>;
  } = $props();

  let problems = $derived(allProblems.filter(isProblem));
  let leads = $derived(problemLeads(allProblems, rejectedCandidates, extraLeads));
  let sourceCount = $derived(new Set(problems.flatMap((problem) => problem.factors.map((factor) => factor.sourceId))).size);
  let factorCount = $derived(new Set(problems.flatMap((problem) => problem.factors.map((factor) => factor.id))).size);
  let query = $state("");
  let filteredProblems = $derived(problems.filter((problem) => problem.statement.toLowerCase().includes(query.trim().toLowerCase())));
</script>

<div class="archive problem-review" id="workflow-panel-research" role="tabpanel" aria-label="Research" tabindex="0">
  <header>
    <div>
      <h1>Research</h1>
    </div>
  </header>

  <dl class="summary">
    <div><dt>Problems</dt><dd>{problems.length}</dd></div>
    <div><dt>Cited factors</dt><dd>{factorCount}</dd></div>
    <div><dt>Sources</dt><dd>{sourceCount}</dd></div>
  </dl>

  <ResultsToolbar bind:query label="Search problems" count={filteredProblems.length} />
  <div class="problems">
    {#each filteredProblems as problem, index (problem.id)}
      <article style={`--index:${index}`}>
        <details class="problem-disclosure">
          <summary class="disclosure-title" title={problem.statement}><span class="disclosure-label">{problem.statement}</span></summary>
          <div class="disclosure-content">
            <div class="meta">
              {#if problem.verdict !== "confirmed"}<span class="verdict">{verdictLabel(problem.verdict)}</span>{/if}
              {#if problem.selected}<span class="selected">Used for solutions</span>{/if}
              {#if problem.singleHarvestModeWarning}<span>One harvest mode</span>{/if}
              {#if problem.closeRoleEvidence}<span>Evidence from close roles</span>{/if}
            </div>

            <p>{problem.whyItPersists}</p>
            {#if problem.affected || problem.scaleEstimate}
              <dl class="problem-data">
                {#if problem.affected}<div><dt>Affected</dt><dd>{problem.affected}</dd></div>{/if}
                {#if problem.scaleEstimate}<div><dt>Scale estimate</dt><dd class="estimated">{problem.scaleEstimate}</dd></div>{/if}
              </dl>
            {/if}
            <p class="reason">{problem.verdictReason}</p>
            {#if problem.factors.length === 0}<p class="no-factors">No cited factors</p>{:else}
            <details>
              <summary>{problem.factors.length} cited {problem.factors.length === 1 ? "factor" : "factors"}</summary>
              {#each problem.factors as factor (factor.id)}
                <blockquote>
                  <p>{factor.subject} — {factor.behavior}</p>
                  <q>{factor.quote}</q>{#if factor.uncertainty}<p>Uncertainty: {factor.uncertainty}</p>{/if}                  <button disabled={busy} onclick={() => onOpenSource(factor.sourceUrl)}>{factor.sourceTitle}</button>
                </blockquote>
              {/each}
            </details>
            {/if}
          </div>
        </details>
      </article>
    {:else}{#if query}<p class="empty">No problems match "{query}".</p>
    {:else}
      <div class="empty"><h2>No problems yet</h2></div>
    {/if}{/each}
  </div>

  <ProblemLeads {leads} {busy} {onOpenSource} {previewCandidateAssessment} {onAssessCandidate} />
  <div class="export-links"><button class="link-button" disabled={busy} onclick={onExport}>{busy ? "Exporting…" : "Export research JSON"}</button></div>
</div>

<style>

  .archive { max-width:var(--page-max);margin:auto;padding:38px var(--page-inline) 80px; }
  .summary { display:flex;gap:24px;border:0;margin:24px 0 0; }
  .summary > div { display:flex;align-items:center;gap:9px; }
  .summary dt { font-size:13px;color:var(--muted); }
  .summary dd { font:600 13px var(--sans);margin:0;background:var(--surface-2);border:1px solid var(--border);padding:3px 8px;border-radius:6px; }
  .meta { display:flex;flex-wrap:wrap;gap:7px;margin-bottom:16px; }
  .meta span { padding:4px 8px;border:1px solid var(--border-strong);border-radius:6px;color:var(--muted);font-size:13px; }
  .meta .selected { color:var(--accent-strong);border-color:#bdbdbd40; }
  @container page (max-width:600px) { .archive { padding:28px 22px 60px; }.summary { flex-wrap:wrap;gap:12px; } }
  .summary { display:flex;align-items:center;gap:36px;margin:24px 0 8px;padding:18px 0;border-top:1px solid var(--border);border-bottom:1px solid var(--border); }
  .summary > div { display:flex;align-items:baseline;gap:10px; }
  .summary dt { font-size:14px;color:var(--muted); }
  .summary dd { font-size:20px;font-weight:600;background:transparent;border:0;padding:0;color:var(--text); }
  .problems { min-width:0; }.problems article { min-width:0; }
  .problem-disclosure :global(.disclosure-title) { font-size:15px;line-height:1.5; }
</style>
