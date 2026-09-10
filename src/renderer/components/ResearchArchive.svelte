<script lang="ts">
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

  <div class="problems">
    {#each problems as problem, index (problem.id)}
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
    {:else}
      <div class="empty"><h2>No candidates passed the evidence requirements.</h2><p>The rejected candidates remain available below.</p></div>
    {/each}
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
  .archive{max-width:1050px;margin:0 auto;padding:32px var(--page-inline) 100px}header{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:28px;align-items:end;padding-bottom:24px}.eyebrow{margin:0;font:600 11px var(--sans);letter-spacing:0;text-transform:none;color:var(--accent-strong)}h1{font-size:28px;letter-spacing:-.04em;line-height:1.05;margin:8px 0}.intro{max-width:640px;margin:0;color:var(--muted)}.export{min-height:38px;padding:9px 13px;border:1px solid var(--border-strong);border-radius:8px;background:var(--surface);color:var(--text);font-weight:550}.export:active:not(:disabled){transform:scale(.98)}button:disabled{cursor:not-allowed;opacity:.48}.summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin:10px 0 24px;border-block:1px solid var(--border)}.summary>div{padding:16px 4px}.summary>div+div{border-left:1px solid var(--border);padding-left:20px}dt{font:600 10px var(--sans);letter-spacing:0;text-transform:none;color:var(--subtle)}dd{margin:5px 0 0}.summary dd{font:650 22px var(--sans)}.problems{display:grid;gap:14px}article{padding:22px 24px;border:1px solid var(--border);border-left:3px solid var(--border-strong);background:var(--surface)}article.warning{border-left-color:#b98645}.meta{display:flex;flex-wrap:wrap;gap:7px}.meta span{padding:4px 8px;border:1px solid var(--border-strong);border-radius:999px;color:var(--muted);font:600 10px var(--sans);text-transform:none}.meta .selected{border-color:var(--accent);color:var(--accent-strong)}h2{margin:13px 0 7px;font-size:21px;letter-spacing:-.025em}article>p{color:var(--muted)}.problem-data{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:18px 0}.estimated{text-decoration:underline dotted;text-underline-offset:4px}.reason,details{padding-top:14px;border-top:1px solid var(--border)}.reason{font-size:12px}summary{cursor:pointer;color:var(--muted)}blockquote{margin:14px 0;padding-left:16px;border-left:1px solid var(--border-strong)}blockquote p{margin:0 0 6px}q{display:block;color:var(--text)}blockquote button{padding:7px 0;border:0;background:transparent;color:var(--accent-strong)}.rejected{margin-top:24px}.rejected>summary{font-weight:650}.rejected>summary span{margin-left:7px;color:var(--subtle);font:600 10px var(--sans)}.rejected-list{display:grid;gap:12px;padding-top:14px}.rejected-item{border-left-color:var(--danger)}.empty{padding:42px 4px;border-top:1px solid var(--border)}.empty h2,.empty p{margin:0}.empty p{margin-top:6px;color:var(--muted)}@media(max-width:700px){.archive{padding:28px 20px 72px}header{grid-template-columns:1fr;align-items:start}.export{justify-self:start}.summary{grid-template-columns:1fr}.summary>div+div{border-left:0;border-top:1px solid var(--border);padding-left:4px}.problem-data{grid-template-columns:1fr}}

  article:has(> .problem-disclosure) { padding:0;border-radius:10px;overflow:hidden; }
  .problem-disclosure { padding:0;border:0; }
  .problem-disclosure > summary { color:var(--text); }
  .problem-disclosure[open] > summary { background:var(--surface-2); }
  .problem-disclosure :global(.disclosure-content) { padding-top:16px; }
</style>
