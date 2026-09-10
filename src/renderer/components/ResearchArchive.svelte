<script lang="ts">
  import ResultsToolbar from "./ResultsToolbar.svelte";
  import type { ProblemCandidate, RejectedProblemCandidate } from "../../shared/ipc";

  let {
    problems,
    rejectedCandidates,
    busy,
    onExport,
    onOpenSource,
  }: {
    problems: ProblemCandidate[];
    rejectedCandidates: RejectedProblemCandidate[];
    busy: boolean;
    onExport: () => Promise<void>;
    onOpenSource: (url: string) => Promise<void>;
  } = $props();

  let sourceCount = $derived(new Set(problems.flatMap((problem) => problem.factors.map((factor) => factor.sourceId))).size);
  let factorCount = $derived(new Set(problems.flatMap((problem) => problem.factors.map((factor) => factor.id))).size);
  let evidenceBacked = $derived(factorCount > 0);
  let discoveryRan = $derived(evidenceBacked || rejectedCandidates.length > 0);
  let query = $state("");
  let filteredProblems = $derived(problems.filter((problem) => problem.statement.toLowerCase().includes(query.trim().toLowerCase())));
</script>

<div class="archive" id="workflow-panel-research" role="tabpanel" aria-label="Research" tabindex="0">
  <header>
    <div>
      <p class="eyebrow">Research archive</p>
      <h1>Research</h1>
      <p class="intro">{evidenceBacked
        ? "Open a problem to review its evidence."
        : discoveryRan
          ? "These candidates did not pass the evidence requirements."
          : "User-stated problems. No discovery evidence was gathered."}</p>
    </div>
    <button class="export" disabled={busy} onclick={onExport}>{busy ? "Exporting…" : "Export research JSON"}</button>
  </header>

  <dl class="summary">
    <div><dt>Problems</dt><dd>{problems.length}</dd></div>
    <div><dt>Cited factors</dt><dd>{factorCount}</dd></div>
    <div><dt>Sources</dt><dd>{sourceCount}</dd></div>
  </dl>

  <ResultsToolbar bind:query label="Search problems" count={filteredProblems.length} />
  <div class="problems">
    {#each filteredProblems as problem, index (problem.id)}
      <article class:warning={["insufficient-evidence", "overstated", "attempted-and-failed"].includes(problem.verdict)} style={`--index:${index}`}>
        <details class="problem-disclosure">
          <summary class="disclosure-title" title={problem.statement}><span class="disclosure-label">{problem.statement}</span></summary>
          <div class="disclosure-content">
            <div class="meta">
              <span class="verdict">{problem.verdict}</span>
              {#if problem.selected}<span class="selected">Used for ideas</span>{/if}
              {#if problem.singleHarvestModeWarning}<span>One harvest mode</span>{/if}
            </div>

            <p>{problem.whyItPersists}</p>
            <dl class="problem-data">
              <div><dt>Affected</dt><dd>{problem.affected}</dd></div>
              <div><dt>Scale estimate</dt><dd class="estimated">{problem.scaleEstimate}</dd></div>
            </dl>
            <p class="reason">{problem.verdictReason}</p>
            <details>
              <summary>{problem.factors.length} cited factors</summary>
              {#each problem.factors as factor (factor.id)}
                <blockquote>
                  <p>{factor.subject} — {factor.behavior}</p>
                  <q>{factor.quote}</q>{#if factor.uncertainty}<p>Uncertainty: {factor.uncertainty}</p>{/if}<small class="estimated">Model confidence is uncalibrated.</small>
                  <button disabled={busy} onclick={() => onOpenSource(factor.sourceUrl)}>{factor.sourceTitle}</button>
                </blockquote>
              {/each}
            </details>
          </div>
        </details>
      </article>
    {:else}{#if query}<p class="empty">No problems match "{query}".</p>
    {:else}
      <div class="empty"><h2>No candidates passed the evidence requirements.</h2><p>The rejected candidates remain available below.</p></div>
    {/if}{/each}
  </div>

  {#if rejectedCandidates.length > 0}
    <details class="rejected">
      <summary>Failed evidence requirements <span>{rejectedCandidates.length}</span></summary>
      <div class="rejected-list">
        {#each rejectedCandidates as candidate, index (candidate.id)}
          <article class="rejected-item" style={`--index:${problems.length + index}`}>
            <div class="meta"><span>Not evidence-backed</span></div>
            <h2>{candidate.statement}</h2>
            <p>{candidate.reason}</p>
          </article>
        {/each}
      </div>
    </details>
  {/if}
</div>

<style>
  header { display:flex;align-items:center;justify-content:space-between;gap:24px; }
  .eyebrow { display:none; }
  h1 { font-size:32px;font-weight:650;letter-spacing:-.045em;line-height:1.2;margin:0 0 10px; }
  header p:last-child { font-size:12px;margin:0;color:var(--muted); }
  .export { min-height:36px;padding:9px 12px;border:1px solid var(--border);border-radius:8px;background:transparent;color:var(--text);font-size:11px;white-space:nowrap; }
  .problems { display:grid;gap:10px; }
  article { border:1px solid var(--border);border-radius:13px;background:linear-gradient(120deg,#1b202377,var(--surface));overflow:hidden;box-shadow:inset 0 1px #ffffff04; }
  article:has(> .problem-disclosure[open]) { border-color:var(--border-strong);background:var(--bg); }
  article.warning { border-left:2px solid #b98645; }
  .problem-disclosure { padding:0;border:0; }
  .problem-disclosure > summary { color:var(--text); }
  .problem-disclosure[open] > summary { background:var(--surface-2); }
  .problem-disclosure :global(.disclosure-content) { padding:22px 26px; }
  dl:not(.summary) { display:grid;grid-template-columns:1fr 1fr;gap:20px;padding:18px 20px;border:1px solid var(--border);border-radius:10px;background:var(--surface);margin:18px 0; }
  dt { color:var(--subtle);font-size:11px;font-weight:500; }
  dd { margin:5px 0 0;font-size:13px;line-height:1.6;color:var(--muted); }
  .estimated { text-decoration:underline dotted;text-underline-offset:4px; }
  .reason { padding-top:14px;font-size:12px;border-top:1px solid var(--border);color:var(--muted); }
  details { border-top:1px solid var(--border);padding-top:14px; }
  summary { cursor:pointer;font-size:12px;color:var(--muted); }
  blockquote { margin:14px 0;padding:16px 18px;border:1px solid var(--border);border-left:2px solid #71cfba55;border-radius:0 10px 10px 0;background:var(--surface);font-size:12px;line-height:1.8; }
  blockquote p { color:var(--muted);margin:0 0 8px; }q { display:block;font-size:14px;color:var(--text); }
  blockquote small { display:block;margin-top:9px;color:var(--subtle);font-size:10px; }
  blockquote button { display:block;padding:8px 0 0;border:0;background:transparent;color:var(--accent-strong);font-size:11px; }
  .rejected { margin-top:22px;font-size:12px; }
  .rejected > summary span { margin-left:8px;color:var(--subtle); }
  .rejected-list { display:grid;gap:12px;padding-top:16px; }
  .rejected-item { border-color:#df92922a;padding:20px; }
  h2 { font-size:16px;font-weight:550;line-height:1.5; }.rejected-item p { font-size:12px;color:var(--muted); }
  .empty { padding:32px 20px;color:var(--muted);font-size:13px;border:1px dashed var(--border-strong);border-radius:12px; }.empty h2 { font-size:17px; }
  @media(max-width:800px) { header { flex-direction:column;align-items:start; }dl:not(.summary) { grid-template-columns:1fr; }.problem-disclosure :global(.disclosure-content) { padding:18px; } }

  .archive { max-width:1120px;margin:auto;padding:38px var(--page-inline) 80px; }
  .summary { display:flex;gap:24px;border:0;margin:24px 0 0; }
  .summary > div { display:flex;align-items:center;gap:9px; }
  .summary dt { font-size:11px;color:var(--muted); }
  .summary dd { font:600 11px var(--sans);margin:0;background:var(--surface-2);border:1px solid var(--border);padding:3px 8px;border-radius:6px; }
  .meta { display:flex;flex-wrap:wrap;gap:7px;margin-bottom:16px; }
  .meta span { padding:4px 8px;border:1px solid var(--border-strong);border-radius:6px;color:var(--muted);font-size:10px; }
  .meta .selected { color:var(--accent-strong);border-color:#71cfba40; }
  @media(max-width:700px) { .archive { padding:28px 22px 60px; }.summary { flex-wrap:wrap;gap:12px; } }
</style>
