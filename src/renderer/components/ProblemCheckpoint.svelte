<script lang="ts">
  import type { ProblemCandidate } from "../../shared/ipc";
  import { untrack } from "svelte";
  let { problems, busy, onCommit }:{ problems:ProblemCandidate[];busy:boolean;onCommit:(ids:string[],userProblem:string|null)=>Promise<void> }=$props();
  const initialProblems=untrack(()=>problems);
  let selected=$state(new Set(initialProblems.filter((item)=>item.selected).map((item)=>item.id)));
  let userProblem=$state("");
  let projected=$derived((selected.size+(userProblem.trim()?1:0))*18);
  function toggle(id:string){const next=new Set(selected);next.has(id)?next.delete(id):next.add(id);selected=next}
</script>
<section class="checkpoint">
  <header><p class="eyebrow">Human checkpoint</p><h1>Which problems deserve development?</h1><p>Killed candidates stay selectable. Evidence warnings are visible; nothing is silently hidden.</p></header>
  <div class="legend">Plain quotes are source-verified · dotted text is model-estimated · amber borders mark weak or adverse verdicts</div>
  <div class="problems">
    {#each problems as problem,index (problem.id)}
      <article class:warning={["insufficient-evidence","overstated","attempted-and-failed"].includes(problem.verdict)} style={`--index:${index}`}>
        <label class="pick"><input type="checkbox" checked={selected.has(problem.id)} onchange={()=>toggle(problem.id)} /><span>Develop this problem</span></label>
        <div class="verdict"><span>{problem.verdict}</span>{#if problem.singleHarvestModeWarning}<span>one harvest mode</span>{/if}</div>
        <h2>{problem.statement}</h2><p>{problem.whyItPersists}</p>
        <dl><div><dt>Affected</dt><dd>{problem.affected}</dd></div><div><dt>Scale</dt><dd class="estimated">{problem.scaleEstimate}</dd></div></dl>
        <p class="reason">{problem.verdictReason}</p>
        <details><summary>{problem.factors.length} cited factors</summary>{#each problem.factors as factor}<blockquote><p>{factor.subject} — {factor.behavior}</p><q>{factor.quote}</q><button onclick={()=>window.scraply.openExternalUrl(factor.sourceUrl)}>{factor.sourceTitle}</button></blockquote>{/each}</details>
      </article>
    {:else}<div class="empty"><h2>No candidates survived.</h2><p>State the problem yourself below, or edit the scope and run discovery again.</p></div>{/each}
  </div>
  <div class="escape"><label><span>Or state the problem yourself.</span><textarea bind:value={userProblem} rows="3" placeholder="Describe the problem in one direct sentence."></textarea></label></div>
  <footer><p><strong>{selected.size+(userProblem.trim()?1:0)}</strong> problems selected · ~{projected} Codex calls projected</p><button disabled={busy||(!selected.size&&!userProblem.trim())} onclick={()=>onCommit([...selected],userProblem.trim()||null)}>{busy?"Starting…":"Commit selection"}</button></footer>
</section>
<style>
  .checkpoint{max-width:1050px;margin:0 auto;padding:42px var(--page-inline) 110px}.eyebrow{font:600 11px var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--accent-strong)}h1{font-size:clamp(30px,4vw,46px);letter-spacing:-.04em;margin:9px 0}header>p:last-child,.legend{color:var(--muted)}.legend{margin:28px 0 18px;padding-top:16px;border-top:1px solid var(--border);font-size:12px}.problems{display:grid;gap:14px}article{border:1px solid var(--border);border-left:3px solid var(--border-strong);padding:22px 24px;background:var(--surface);animation:enter .45s var(--ease) both;animation-delay:calc(var(--index)*70ms)}article.warning{border-left-color:#b98645}.pick{display:flex;gap:9px;align-items:center;font-weight:650}.pick input{accent-color:var(--accent-strong)}.verdict{display:flex;gap:8px;margin:14px 0}.verdict span{font:600 10px var(--mono);text-transform:uppercase;border:1px solid var(--border-strong);border-radius:999px;padding:4px 8px;color:var(--muted)}h2{font-size:21px;letter-spacing:-.025em;margin:8px 0}article>p{color:var(--muted)}dl{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:18px 0}dt{font:600 10px var(--mono);text-transform:uppercase;color:var(--subtle)}dd{margin:4px 0}.estimated{text-decoration:underline dotted;text-underline-offset:4px}.reason{font-size:12px}.reason,details{border-top:1px solid var(--border);padding-top:14px}summary{cursor:pointer;color:var(--muted)}blockquote{margin:14px 0;padding-left:16px;border-left:1px solid var(--border-strong)}blockquote p{margin:0 0 6px}q{display:block;color:var(--text)}blockquote button{border:0;background:transparent;color:var(--accent-strong);padding:7px 0}.escape{margin-top:24px;padding:22px 24px;border:1px dashed var(--border-strong)}.escape label{display:grid;gap:10px}.escape textarea{background:var(--bg);border:1px solid var(--border-strong);border-radius:8px;color:var(--text);padding:12px;resize:vertical}footer{position:sticky;bottom:0;margin-top:22px;padding:16px 20px;display:flex;justify-content:space-between;align-items:center;background:color-mix(in srgb,var(--surface) 92%,transparent);backdrop-filter:blur(12px);border:1px solid var(--border-strong)}footer p{margin:0;color:var(--muted)}footer button{padding:11px 16px;border-radius:8px;border:1px solid var(--accent);background:var(--accent-strong);color:var(--accent-ink);font-weight:700}@keyframes enter{from{opacity:0;transform:translateY(8px)}}@media(max-width:700px){.checkpoint{padding:28px 20px 80px}dl{grid-template-columns:1fr}footer{align-items:flex-start;gap:12px;flex-direction:column}}
</style>
