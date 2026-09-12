<script lang="ts">
  import "./problem-review.css";
  import ResultsToolbar from "./ResultsToolbar.svelte";
  import type { ProblemCandidate, RejectedProblemCandidate } from "../../shared/ipc";
  import { untrack } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  let { problems, rejectedCandidates, busy, onCommit, onExport, onOpenSource }:{ problems:ProblemCandidate[];rejectedCandidates:RejectedProblemCandidate[];workflowVersion?:1|2|undefined;ideaCount?:number|undefined;busy:boolean;onCommit:(ids:string[],userProblem:string|null)=>Promise<void>;onExport:()=>Promise<void>;onOpenSource:(url:string)=>Promise<void> }=$props();
  const initialProblems=untrack(()=>problems);
  const selected=new SvelteSet(initialProblems.filter((item)=>item.selected).map((item)=>item.id));
  let userProblem=$state("");
  let userProblemTextarea: HTMLTextAreaElement | undefined;
  let projected=$derived((selected.size+(userProblem.trim()?1:0))*3);
  function toggle(id:string){if(selected.has(id))selected.delete(id);else selected.add(id)}
  function useAsUserAsserted(statement:string){userProblem=statement;userProblemTextarea?.focus()}
  let query = $state("");
  let filteredProblems = $derived(problems.filter((problem) => problem.statement.toLowerCase().includes(query.trim().toLowerCase())));
</script>
<section class="checkpoint problem-review">
  <header><div><h1>Choose problems to develop</h1></div><button class="export" disabled={busy} onclick={onExport}>Export research JSON</button></header>
  <details class="evidence-key"><summary>How to read the evidence</summary><p>Plain quotes are source-verified. Dotted text is model-estimated. Amber borders mark weak or adverse verdicts.</p></details>
  <ResultsToolbar bind:query label="Search problems" count={filteredProblems.length} />
  <div class="problems">
    {#each filteredProblems as problem,index (problem.id)}
      <article class:picked={selected.has(problem.id)} class:warning={["insufficient-evidence","overstated","attempted-and-failed"].includes(problem.verdict)} style={`--index:${index}`}>
        <details class="problem-disclosure">
          <summary class="disclosure-title" title={problem.statement}><span class="disclosure-label">{problem.statement}</span>{#if selected.has(problem.id)}<span aria-label="Selected for development">✓</span>{/if}</summary>
          <div class="disclosure-content">
            <label class="pick"><input type="checkbox" checked={selected.has(problem.id)} disabled={busy} onchange={()=>toggle(problem.id)} /><span>Develop this problem</span></label>
            <div class="verdict"><span>{problem.verdict}</span>{#if problem.singleHarvestModeWarning}<span>one harvest mode</span>{/if}</div>
            <p>{problem.whyItPersists}</p>
            <dl><div><dt>Affected</dt><dd>{problem.affected}</dd></div><div><dt>Scale</dt><dd class="estimated">{problem.scaleEstimate}</dd></div></dl>
            <p class="reason">{problem.verdictReason}</p>
              <details><summary>{problem.factors.length} cited factors</summary>{#each problem.factors as factor (factor.id)}<blockquote><p>{factor.subject} — {factor.behavior}</p><q>{factor.quote}</q>{#if factor.uncertainty}<p>Uncertainty: {factor.uncertainty}</p>{/if}<small class="estimated">Model confidence is uncalibrated.</small><button disabled={busy} onclick={()=>onOpenSource(factor.sourceUrl)}>{factor.sourceTitle}</button></blockquote>{/each}</details>
          </div>
        </details>
      </article>
    {:else}{#if query}<p class="empty">No problems match "{query}".</p>{:else}<div class="empty"><h2>No candidates passed the evidence requirements.</h2><p>Review what failed below, state the problem yourself, or edit the scope and run discovery again.</p></div>{/if}{/each}
  </div>
  {#if rejectedCandidates.length > 0}
    <details class="rejected">
      <summary>Failed evidence requirements <span>{rejectedCandidates.length}</span></summary>
      <div class="rejected-list">
        {#each rejectedCandidates as candidate, index (candidate.id)}
          <article class="rejected-item" style={`--index:${problems.length + index}`}>
            <div class="verdict"><span>Not evidence-backed</span></div>
            <h2>{candidate.statement}</h2>
            <p>{candidate.reason}</p>
            <button class="use-rejected" type="button" disabled={busy} onclick={() => useAsUserAsserted(candidate.statement)}>Use as user-asserted problem</button>
          </article>
        {/each}
      </div>
    </details>
  {/if}
  <div class="escape"><label><span>Or state the problem yourself.</span><textarea bind:this={userProblemTextarea} bind:value={userProblem} disabled={busy} rows="3" placeholder="Describe the problem in one direct sentence."></textarea></label></div>
  <footer><p><strong>{selected.size+(userProblem.trim()?1:0)}</strong> problems selected · ~{projected} model calls projected</p><button disabled={busy||(!selected.size&&!userProblem.trim())} onclick={()=>onCommit([...selected],userProblem.trim()||null)}>{busy?"Starting…":"Commit selection"}</button></footer>
</section>
<style>

  .checkpoint { max-width:1120px;margin:auto;padding:38px var(--page-inline) 80px; }
  .evidence-key { margin-top:20px;padding:0;border:0;font-size:13px;color:var(--muted); }
  .evidence-key p { max-width:76ch;margin:10px 0 0; }
  article.picked { border-color:#71cfba60; }
  .pick { display:flex;gap:9px;align-items:center;width:fit-content;padding:10px 14px;border:1px solid #71cfba30;border-radius:8px;background:#71cfba08;font-size:13px;color:var(--accent-strong); }
  .pick input { width:15px;height:15px;accent-color:var(--accent); }
  .verdict { display:flex;gap:8px;margin:14px 0; }
  .verdict span { font-size:13px;border:1px solid var(--border-strong);border-radius:6px;padding:4px 8px;color:var(--muted); }
  .use-rejected { padding:9px 12px;border:1px solid var(--border-strong);border-radius:8px;background:var(--surface-2);color:var(--text);font-size:13px; }
  .escape { margin-top:24px;border:1px solid var(--border);border-radius:13px;padding:20px;background:var(--surface); }
  .escape label { display:grid;gap:12px; }.escape label > span { color:var(--muted);font-size:13px; }
  .escape textarea { font-size:13px;background:var(--bg);border:1px solid var(--border-strong);border-radius:8px;color:var(--text);padding:12px;resize:none; }
  footer { position:sticky;bottom:16px;display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:24px;border:1px solid var(--border-strong);border-radius:13px;padding:16px 20px;box-shadow:0 8px 32px #0005;background:color-mix(in srgb,var(--surface) 94%,transparent);backdrop-filter:blur(16px); }
  footer p { margin:0;color:var(--muted);font-size:13px; }footer strong { display:inline-block;font-size:15px;color:var(--accent-strong);margin-right:5px; }
  footer button { padding:11px 16px;font-size:13px;font-weight:650;border:0;border-radius:9px;background:var(--accent-strong);color:var(--accent-ink); }
  @media(max-width:700px) { footer { flex-direction:column;align-items:stretch; }.checkpoint { padding:28px 22px 60px; } }
</style>
