<script lang="ts">
  import "./problem-review.css";
  import ResultsToolbar from "./ResultsToolbar.svelte";
  import type { ProblemCandidate, RejectedProblemCandidate } from "../../shared/ipc";
  import { DEFAULT_RUN_CONFIG, modelRefKey, type ExplorationPurpose, type ModelOption, type ModelRef, type RunConfig } from "../../shared/schemas";
  import { modelDisplayName } from "../lib/research-defaults";
  import { verdictLabel } from "../lib/status";
  import { untrack } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  let { problems, rejectedCandidates, modelOptions, initialConfig, fixedExplorationPurpose, busy, onCommit, onExport, onOpenSource }:{ problems:ProblemCandidate[];rejectedCandidates:RejectedProblemCandidate[];modelOptions:ModelOption[];initialConfig:RunConfig|null;fixedExplorationPurpose?:ExplorationPurpose|undefined;workflowVersion?:1|2|undefined;ideaCount?:number|undefined;busy:boolean;onCommit:(ids:string[],userProblem:string|null,model:ModelRef,reasoningEffort:string,explorationPurpose:ExplorationPurpose)=>Promise<void>;onExport:()=>Promise<void>;onOpenSource:(url:string)=>Promise<void> }=$props();
  const initialProblems=untrack(()=>problems);
  const selected=new SvelteSet(initialProblems.filter((item)=>item.selected).map((item)=>item.id));
  let userProblem=$state("");
  let userProblemTextarea = $state<HTMLTextAreaElement | undefined>(undefined);
  let matchingUserProblem=$derived(problems.find((problem)=>problem.verdict==="user-asserted"&&problem.statement===userProblem.trim()));
  let manualDevelopment=$derived(userProblem.trim()&&(!matchingUserProblem||(!matchingUserProblem.developmentCompleted&&!selected.has(matchingUserProblem.id)))?1:0);
  let projected=$derived((problems.filter((problem)=>selected.has(problem.id)&&!problem.developmentCompleted).length+manualDevelopment)*3);
  let availableModels=$derived(modelOptions.filter((item)=>item.providerId==="openai-subscription"));
  const savedConfig=untrack(()=>initialConfig);
  const initialModel=untrack(()=>savedConfig?.model??modelOptions.find((item)=>item.providerId==="openai-subscription"));
  let modelKey=$state(initialModel?modelRefKey(initialModel):"");
  const initialModelOption=untrack(()=>modelOptions.find((item)=>modelRefKey(item)===modelKey));
  let selectedModel=$derived(availableModels.find((item)=>modelRefKey(item)===modelKey));
  let reasoningEffort=$state<string>(savedConfig?.reasoningEffort??initialModelOption?.defaultReasoningEffort??DEFAULT_RUN_CONFIG.reasoningEffort);
  let reasoningAvailable=$derived(selectedModel?.reasoningEfforts.some((item)=>item.id===reasoningEffort)??false);
  let selectedPurpose=$derived(fixedExplorationPurpose??savedConfig?.explorationPurpose??DEFAULT_RUN_CONFIG.explorationPurpose);
  let model=$derived<ModelRef>({providerId:selectedModel?.providerId??"",modelId:selectedModel?.modelId??""});
  $effect(()=>{if(!modelKey&&!savedConfig?.model&&availableModels[0]){modelKey=modelRefKey(availableModels[0]);reasoningEffort=availableModels[0].defaultReasoningEffort}});
  function selectModel(){reasoningEffort=selectedModel?.defaultReasoningEffort??DEFAULT_RUN_CONFIG.reasoningEffort}
  function toggle(id:string){if(selected.has(id))selected.delete(id);else selected.add(id)}
  function useAsUserAsserted(statement:string){userProblem=statement;userProblemTextarea?.focus()}
  let query = $state("");
  let filteredProblems = $derived(problems.filter((problem) => problem.statement.toLowerCase().includes(query.trim().toLowerCase())));
  type EvidenceMetadata = {
    sourceRole?: "firsthand"|"measured"|"vendor"|"recommendation"|"illustration"|"unknown";
    audienceFit?: "intended-buyer"|"adjacent"|"general"|"unknown";
    independentSourceKey?: string|null;
    supportsDemand?: boolean;
    demandEvidenceUncertainty?: string;
  };
  function evidenceDetails(factor: ProblemCandidate["factors"][number]): string[] {
    const evidence = factor as typeof factor & EvidenceMetadata;
    return [
      `Source role: ${evidence.sourceRole ?? "unknown"}`,
      `Audience: ${evidence.audienceFit ?? "unknown"}`,
      `Origin: ${evidence.independentSourceKey ? "identified" : "independence unknown"}`,
      evidence.supportsDemand ? "Supports demand" : "Does not establish demand",
    ];
  }
  function evidenceGap(problem: ProblemCandidate): string | null {
    return (problem as ProblemCandidate & { evidenceGap?: string|null }).evidenceGap ?? null;
  }
  function verdictText(problem: ProblemCandidate): string {
    if (problem.verdict !== "confirmed") return verdictLabel(problem.verdict);
    return problem.factors.some((factor) => (factor as typeof factor & EvidenceMetadata).audienceFit === "intended-buyer")
      ? "Confirmed with intended-buyer evidence"
      : "Research marked confirmed; audience fit unassessed";
  }
</script>
<section class="checkpoint problem-review">
  <header><div><h1>Choose problems to develop</h1></div><button class="export" disabled={busy} onclick={onExport}>Export research JSON</button></header>
  <details class="evidence-key"><summary>How to read the evidence</summary><p>Quoted text was matched against the saved search excerpt. This does not verify the original page or establish buyer demand. Dotted text is model-estimated. Amber borders mark weak or adverse verdicts.</p></details>
  <ResultsToolbar bind:query label="Search problems" count={filteredProblems.length} />
  <div class="problems">
    {#each filteredProblems as problem,index (problem.id)}
      <article class:picked={selected.has(problem.id)} class:warning={["insufficient-evidence","overstated","attempted-and-failed"].includes(problem.verdict)} style={`--index:${index}`}>
        <details class="problem-disclosure">
          <summary class="disclosure-title" title={problem.statement}><span class="disclosure-label">{problem.statement}</span>{#if selected.has(problem.id)}<span aria-label="Selected for development">✓</span>{/if}</summary>
          <div class="disclosure-content">
            <label class="pick"><input type="checkbox" checked={selected.has(problem.id)} disabled={busy} onchange={()=>toggle(problem.id)} /><span>Develop this problem</span></label>
            <div class="verdict"><span>{verdictText(problem)}</span>{#if problem.verdict === "confirmed"}<span>Demand not established</span>{/if}{#if problem.singleHarvestModeWarning}<span>One harvest mode</span>{/if}</div>
            <p>{problem.whyItPersists}</p>
            {#if problem.affected || problem.scaleEstimate}<dl>{#if problem.affected}<div><dt>Affected</dt><dd>{problem.affected}</dd></div>{/if}{#if problem.scaleEstimate}<div><dt>Scale</dt><dd class="estimated">{problem.scaleEstimate}</dd></div>{/if}</dl>{/if}
            <p class="reason">{problem.verdictReason}</p>
            {#if evidenceGap(problem)}<p class="evidence-gap">Evidence gap: {evidenceGap(problem)}</p>{/if}
              {#if problem.factors.length === 0}<p class="no-factors">No cited factors</p>{:else}<details><summary>{problem.factors.length} cited {problem.factors.length === 1 ? "factor" : "factors"}</summary>{#each problem.factors as factor (factor.id)}<blockquote><p>{factor.subject} — {factor.behavior}</p><q>{factor.quote}</q><p class="factor-meta">{evidenceDetails(factor).join(" · ")}</p>{#if factor.uncertainty}<p>Uncertainty: {factor.uncertainty}</p>{/if}{#if (factor as typeof factor & EvidenceMetadata).demandEvidenceUncertainty}<p>Demand evidence gap: {(factor as typeof factor & EvidenceMetadata).demandEvidenceUncertainty}</p>{/if}<small class="estimated">Matched against the saved search excerpt. Model confidence is uncalibrated.</small><button disabled={busy} onclick={()=>onOpenSource(factor.sourceUrl)}>{factor.sourceTitle}</button></blockquote>{/each}</details>{/if}
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
            {#if !fixedExplorationPurpose}<button class="use-rejected" type="button" disabled={busy} onclick={() => useAsUserAsserted(candidate.statement)}>Use as user-asserted problem</button>{/if}
          </article>
        {/each}
      </div>
    </details>
  {/if}
  {#if !fixedExplorationPurpose}<div class="escape"><label><span>Or state the problem yourself.</span><textarea bind:this={userProblemTextarea} bind:value={userProblem} disabled={busy} rows="3" placeholder="Describe the problem in one direct sentence."></textarea></label></div>{/if}
  <section class="development-settings" aria-label="Development settings">
    <label><span>Development model</span><select aria-label="Development model" bind:value={modelKey} onchange={selectModel} disabled={busy||availableModels.length===0}>{#if modelKey&&!selectedModel}<option value={modelKey}>{modelDisplayName(savedConfig?.model??DEFAULT_RUN_CONFIG.model)} (unavailable)</option>{/if}{#each availableModels as item (modelRefKey(item))}<option value={modelRefKey(item)}>{modelDisplayName(item)}</option>{/each}</select></label>
    <label><span>Development reasoning</span><select aria-label="Development reasoning" bind:value={reasoningEffort} disabled={busy||!selectedModel}>{#if !reasoningAvailable}<option value={reasoningEffort}>{reasoningEffort} (unavailable)</option>{/if}{#each (selectedModel?.reasoningEfforts??[]) as effort (effort.id)}<option value={effort.id}>{effort.id.charAt(0).toUpperCase()+effort.id.slice(1)}</option>{/each}</select></label>
    <p>{selectedPurpose === "auto" ? "Ideas will follow your brief and each selected problem." : selectedPurpose === "startup-opportunities" ? "This project asks for startup opportunities." : "This project asks for practical solutions."}</p>
    {#if modelKey&&!selectedModel}<p role="status">The saved development model is unavailable. Choose an available model before generating.</p>{:else if selectedModel&&!reasoningAvailable}<p role="status">The saved reasoning effort is unavailable for this model. Choose an available effort before generating.</p>{/if}
  </section>
  <footer>
    {#if fixedExplorationPurpose}
      <p><strong>{selected.size}</strong> problems selected · Each idea batch reserves up to 4 model calls for generation and review. The total number of batches depends on the target and accepted ideas; remaining allowance is shown above.</p>
    {:else}
      <p><strong>{selected.size+(userProblem.trim()?1:0)}</strong> problems selected · ~{projected} model calls projected. Scraply will reuse completed development and generate a batch for each remaining selection. It may return fewer options than requested when the evidence does not support more.</p>
    {/if}
    <button disabled={busy||!selectedModel||!reasoningAvailable||(!selected.size&&!userProblem.trim())} onclick={()=>onCommit([...selected],userProblem.trim()||null,model,reasoningEffort,selectedPurpose)}>{busy?"Starting…":"Generate all selected"}</button>
  </footer>
</section>
<style>

  .checkpoint { max-width:var(--page-max);margin:auto;padding:38px var(--page-inline) 80px; }
  .evidence-key { margin-top:20px;padding:0;border:0;font-size:13px;color:var(--muted); }
  .evidence-key p { max-width:76ch;margin:10px 0 0; }
  article.picked { border-color:#bdbdbd60; }
  .pick { display:flex;gap:9px;align-items:center;width:fit-content;padding:10px 14px;border:1px solid #bdbdbd30;border-radius:8px;background:#bdbdbd08;font-size:13px;color:var(--accent-strong); }
  .pick input { width:15px;height:15px;accent-color:var(--accent); }
  .verdict { display:flex;gap:8px;margin:14px 0; }
  .verdict span { font-size:13px;border:1px solid var(--border-strong);border-radius:6px;padding:4px 8px;color:var(--muted); }
  .factor-meta,.evidence-gap { color:var(--subtle);font-size:12px; }
  .use-rejected { padding:9px 12px;border:1px solid var(--border-strong);border-radius:8px;background:var(--surface-2);color:var(--text);font-size:13px; }
  .escape { margin-top:24px;border:1px solid var(--border);border-radius:13px;padding:20px;background:var(--surface); }
  .escape label { display:grid;gap:12px; }.escape label > span { color:var(--muted);font-size:13px; }
  .escape textarea { font-size:13px;background:var(--bg);border:1px solid var(--border-strong);border-radius:8px;color:var(--text);padding:12px;resize:none; }
  .development-settings { display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:16px;border:1px solid var(--border);border-radius:13px;padding:20px;background:var(--surface); }
  .development-settings label { display:grid;gap:8px;color:var(--muted);font-size:13px; }
  .development-settings select { background:var(--bg);border:1px solid var(--border-strong);border-radius:8px;color:var(--text);padding:10px; }
  .development-settings p { grid-column:1/-1;margin:0;color:var(--muted);font-size:12px; }
  footer { position:sticky;bottom:16px;display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:24px;border:1px solid var(--border-strong);border-radius:13px;padding:16px 20px;box-shadow:0 8px 32px #0005;background:color-mix(in srgb,var(--surface) 94%,transparent);backdrop-filter:blur(16px); }
  footer p { margin:0;color:var(--muted);font-size:13px; }footer strong { display:inline-block;font-size:15px;color:var(--accent-strong);margin-right:5px; }
  footer button { flex:none;white-space:nowrap;padding:11px 16px;font-size:13px;font-weight:650;border:0;border-radius:9px;background:var(--accent-strong);color:var(--accent-ink); }
  @container page (max-width:600px) { footer { flex-direction:column;align-items:stretch; }.checkpoint { padding:28px 22px 60px; }.development-settings { grid-template-columns:1fr; }.development-settings p { grid-column:auto; } }
</style>
