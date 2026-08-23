<script lang="ts">
  import type { ProblemCandidate } from "../../shared/ipc";

  let {
    problems,
    busy,
    onExport,
    onOpenSource,
  }: {
    problems: ProblemCandidate[];
    busy: boolean;
    onExport: () => Promise<void>;
    onOpenSource: (url: string) => Promise<void>;
  } = $props();

  let sourceCount = $derived(new Set(problems.flatMap((problem) => problem.factors.map((factor) => factor.sourceId))).size);
  let factorCount = $derived(new Set(problems.flatMap((problem) => problem.factors.map((factor) => factor.id))).size);
  // A known-problem run bypasses discovery, so there is a problem to archive but no evidence behind it.
  let evidenceBacked = $derived(factorCount > 0);
</script>

<div class="archive" id="workflow-panel-research" role="tabpanel" aria-label="Research" tabindex="0">
  <header>
    <div>
      <p class="eyebrow">Research archive</p>
      <h1>{evidenceBacked ? "The evidence behind the ideas." : "The problem behind the ideas."}</h1>
      <p class="intro">{evidenceBacked
        ? "This is the persisted discovery output that existed before solution generation began."
        : "This problem was stated directly, so discovery never ran and no evidence was gathered. The export still records the problem and the run settings."}</p>
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
        <div class="meta">
          <span class="verdict">{problem.verdict}</span>
          {#if problem.selected}<span class="selected">Used for ideas</span>{/if}
          {#if problem.singleHarvestModeWarning}<span>One harvest mode</span>{/if}
        </div>
        <h2>{problem.statement}</h2>
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
              <q>{factor.quote}</q>
              <button disabled={busy} onclick={() => onOpenSource(factor.sourceUrl)}>{factor.sourceTitle}</button>
            </blockquote>
          {/each}
        </details>
      </article>
    {:else}
      <div class="empty"><h2>No completed research yet.</h2><p>The archive becomes available as soon as research completes.</p></div>
    {/each}
  </div>
</div>

<style>
  .archive{max-width:1050px;margin:0 auto;padding:42px var(--page-inline) 100px}header{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:28px;align-items:end;padding-bottom:24px}.eyebrow{margin:0;font:600 11px var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--accent-strong)}h1{font-size:clamp(30px,4vw,46px);letter-spacing:-.04em;line-height:1.05;margin:8px 0}.intro{max-width:640px;margin:0;color:var(--muted)}.export{min-height:38px;padding:9px 13px;border:1px solid var(--accent);border-radius:8px;background:var(--accent-strong);color:var(--accent-ink);font-weight:700}.export:active:not(:disabled){transform:scale(.98)}button:disabled{cursor:not-allowed;opacity:.48}.summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin:10px 0 24px;border-block:1px solid var(--border)}.summary>div{padding:16px 4px}.summary>div+div{border-left:1px solid var(--border);padding-left:20px}dt{font:600 10px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--subtle)}dd{margin:5px 0 0}.summary dd{font:650 22px var(--mono)}.problems{display:grid;gap:14px}article{padding:22px 24px;border:1px solid var(--border);border-left:3px solid var(--border-strong);background:var(--surface);animation:enter .4s var(--ease) both;animation-delay:calc(var(--index)*65ms)}article.warning{border-left-color:#b98645}.meta{display:flex;flex-wrap:wrap;gap:7px}.meta span{padding:4px 8px;border:1px solid var(--border-strong);border-radius:999px;color:var(--muted);font:600 10px var(--mono);text-transform:uppercase}.meta .selected{border-color:var(--accent);color:var(--accent-strong)}h2{margin:13px 0 7px;font-size:21px;letter-spacing:-.025em}article>p{color:var(--muted)}.problem-data{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:18px 0}.estimated{text-decoration:underline dotted;text-underline-offset:4px}.reason,details{padding-top:14px;border-top:1px solid var(--border)}.reason{font-size:12px}summary{cursor:pointer;color:var(--muted)}blockquote{margin:14px 0;padding-left:16px;border-left:1px solid var(--border-strong)}blockquote p{margin:0 0 6px}q{display:block;color:var(--text)}blockquote button{padding:7px 0;border:0;background:transparent;color:var(--accent-strong)}.empty{padding:42px 4px;border-top:1px solid var(--border)}.empty h2,.empty p{margin:0}.empty p{margin-top:6px;color:var(--muted)}@keyframes enter{from{opacity:0;transform:translateY(8px)}}@media(max-width:700px){.archive{padding:28px 20px 72px}header{grid-template-columns:1fr;align-items:start}.export{justify-self:start}.summary{grid-template-columns:1fr}.summary>div+div{border-left:0;border-top:1px solid var(--border);padding-left:4px}.problem-data{grid-template-columns:1fr}}
</style>
