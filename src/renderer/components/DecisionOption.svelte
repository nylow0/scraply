<script lang="ts">
  import type { SolutionView } from "../../shared/ipc";
  import { loadIdeaDetail } from "../lib/idea-details";
  let { idea, busy, onSelect, onSave, onOpenSource }: {
    idea: SolutionView; busy: boolean;
    onSelect: (idea: SolutionView) => Promise<void>;
    onSave: (solutionId: string, decision: string, observed: string) => Promise<void>;
    onOpenSource: (url: string) => Promise<void>;
  } = $props();
  let detail = $state<SolutionView | null>(null);
  let error = $state("");
  let loading = $state(false);
  let userDecision = $state("");
  let observedResult = $state("");
  let saved = $state(false);
  let open = $state(false);
  let revision = "";
  let analysis = $derived(detail?.decisionAnalysis);
  $effect(() => {
    if (open && revision !== `${idea.id}:${idea.detailRevision}`) void loadDetail();
  });
  async function loadDetail() {
    const key = `${idea.id}:${idea.detailRevision}`;
    revision = key;
    loading = true;
    error = "";
    try {
      const result = await loadIdeaDetail(idea);
      if (key !== `${idea.id}:${idea.detailRevision}`) return;
      detail = result;
      userDecision = result.userDecision ?? "";
      observedResult = result.observedResult ?? "";
    } catch (cause) { error = cause instanceof Error ? cause.message : "Could not load this option"; }
    finally { loading = false; }
  }
  async function save() {
    saved = false;
    try { await onSave(idea.id, userDecision, observedResult); saved = true; }
    catch (cause) { error = cause instanceof Error ? cause.message : "Could not save your decision"; }
  }
</script>

<article class:selected={idea.selected}>
  <header>
    <div><p class="status">{idea.selected ? "Your selected option" : "Option"} · Problem evidence: {idea.problemVerdict}</p>
      <h2>{idea.mechanism}</h2><p>{idea.description}</p></div>
    {#if idea.selectable}<button class="primary" disabled={busy} onclick={() => onSelect(idea)}>Choose and analyze</button>{/if}
  </header>
  <p class="problem">{idea.problemStatement}</p>
  <dl>
    <div><dt>Key assumption</dt><dd>{idea.keyAssumption}</dd></div>
    <div><dt>When the current approach may suffice</dt><dd>{idea.whyCurrentApproachMaySuffice}</dd></div>
    <div><dt>Constraints</dt><dd>{idea.respectsOffLimits ? "" : "Possible conflict. "}{idea.respectsOffLimitsWhy}</dd></div>
  </dl>
  {#if idea.unknowns?.length}<h3>Still uncertain</h3><ul>{#each idea.unknowns as unknown, index (index)}<li>{unknown}</li>{/each}</ul>{/if}
  <details bind:open>
    <summary>{idea.selected ? "Evidence, analysis and your decision" : "Inspect evidence"}</summary>
    {#if loading}<p role="status">Loading saved details…</p>{/if}
    {#if error}<p role="alert">{error}</p><button onclick={loadDetail}>Retry details</button>{/if}
    {#if detail}
      <h3>Supporting observations</h3>
      {#each detail.factors as factor (factor.id)}
        <blockquote>{factor.quote}<footer><a href={factor.sourceUrl} onclick={(event) => { event.preventDefault(); void onOpenSource(factor.sourceUrl); }}>{factor.sourceTitle}</a></footer></blockquote>
      {:else}<p>No source-backed observations. Treat the problem as an assertion to test.</p>{/each}
      <h3>Contrary evidence considered</h3>
      {#each detail.contrarySources ?? [] as source (source.id)}
        <details><summary>{source.title}</summary><a href={source.url} onclick={(event) => { event.preventDefault(); void onOpenSource(source.url); }}>Open source</a><p class="source-text">{source.text}</p></details>
      {:else}<p>No contrary sources were collected. Their absence does not confirm the premise.</p>{/each}
      {#if analysis}
        <h3>Possible consequences</h3><p class="status">Model judgments. These have not been observed.</p>
        {#each analysis.consequences as consequence, index (index)}<div class="finding"><strong>{consequence.direction}: {consequence.description}</strong><p>Affects {consequence.affects}. {consequence.rationale}</p></div>{/each}
        <h3>Decisive risks</h3>
        {#each analysis.risks as risk (risk.riskId)}<div class="finding"><strong>{risk.description}</strong><p>{risk.whyDecisive}</p></div>{:else}<p>No decisive risk identified by the model. This is not a safety guarantee.</p>{/each}
        <h3>Proposed responses, untested</h3>
        {#each analysis.proposedResponses as response, index (index)}<div class="finding"><strong>{response.approach}</strong><p>Addresses: {analysis.risks.filter((risk) => response.riskIds.includes(risk.riskId)).map((risk) => risk.description).join("; ")}</p><p>Cost: {response.cost}</p><p>Fails if: {response.failsIf}</p></div>{/each}
        {#if analysis.unknowns.length}<h3>Open questions</h3><ul>{#each analysis.unknowns as unknown, index (index)}<li>{unknown}</li>{/each}</ul>{/if}
        <section class="experiment"><h3>Next experiment</h3><strong>{analysis.experiment.question}</strong><p>{analysis.experiment.method}</p>
          <dl><div><dt>Cost</dt><dd>{analysis.experiment.cost}</dd></div><div><dt>Pass</dt><dd>{analysis.experiment.passCriterion}</dd></div><div><dt>Fail</dt><dd>{analysis.experiment.failCriterion}</dd></div></dl>
        </section>
        <form onsubmit={(event) => { event.preventDefault(); void save(); }}>
          <h3>Your decision and actual result</h3><p>Keep observations separate from the model's proposals.</p>
          <label>Your decision<textarea rows="3" maxlength="8000" bind:value={userDecision} oninput={() => saved = false}></textarea></label>
          <label>Observed test result<textarea rows="3" maxlength="8000" bind:value={observedResult} oninput={() => saved = false} placeholder="Leave empty until you have an observation."></textarea></label>
          <button disabled={busy}>Save decision and result</button>{#if saved}<span role="status">Saved</span>{/if}
        </form>
      {:else if idea.selected}<p>The analysis has not completed. Saved options remain available.</p>{/if}
    {/if}
  </details>
</article>

<style>
  article { border: 1px solid var(--border); border-radius: 10px; padding: 24px; background: var(--surface); }
  article.selected { border-color: var(--accent-strong); }
  header { display: flex; justify-content: space-between; gap: 24px; align-items: start; }
  h2 { margin: 4px 0 12px; font-size: 23px; }
  h3 { margin: 24px 0 10px; font-size: 16px; }
  p { line-height: 1.55; }
  .status, .problem { color: var(--muted); font-size: 12px; }
  dl { display: grid; gap: 16px; } dt { color: var(--muted); font-size: 12px; margin-bottom: 4px; } dd { margin: 0; }
  button { padding: 10px 14px; border: 1px solid var(--border-strong); border-radius: 7px; background: var(--surface-2); color: var(--text); }
  .primary { border-color: var(--accent-strong); flex-shrink: 0; }
  summary { cursor: pointer; padding: 14px 0; } details { border-top: 1px solid var(--border); margin-top: 18px; }
  blockquote { margin: 16px 0; border-left: 2px solid var(--border-strong); padding-left: 16px; } footer { margin-top: 7px; }
  .finding { border-bottom: 1px solid var(--border); padding: 12px 0; }
  .experiment { border: 1px solid var(--border-strong); border-radius: 8px; padding: 0 20px 20px; margin-top: 24px; }
  label { display: grid; gap: 8px; margin: 16px 0; } textarea { width: 100%; background: var(--surface-2); color: var(--text); border: 1px solid var(--border-strong); border-radius: 6px; padding: 12px; }
  .source-text { white-space: pre-wrap; max-height: 360px; overflow: auto; } form span { margin-left: 12px; }
  @media (max-width: 650px) { header { flex-direction: column; } article { padding: 16px; } }
</style>
