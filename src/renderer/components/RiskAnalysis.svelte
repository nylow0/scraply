<script lang="ts">
  import type { SolutionView } from "../../shared/ipc";
  let { analysis }: { analysis: NonNullable<SolutionView["decisionAnalysis"]> } = $props();
</script>

<article class="risk-analysis"><h3>Risk analysis</h3>
  {#each analysis.risks as risk (risk.riskId)}<div class="finding"><strong>{risk.description}</strong><p>{risk.whyDecisive}</p></div>{/each}
  {#if analysis.proposedResponses.length}<h4>What to try</h4>
    {#each analysis.proposedResponses as response, index (index)}<div class="finding"><p>{response.approach}</p><p class="secondary">Fails if: {response.failsIf}</p></div>{/each}
  {/if}
  <h4>Next experiment</h4><strong>{analysis.experiment.question}</strong><p>{analysis.experiment.method}</p>
</article>

<style>
  .risk-analysis { padding:24px;border:1px solid var(--border);border-radius:10px;background:var(--surface);color:var(--text);font-size:15px;line-height:1.6;max-width:68ch; }
  h3 { margin:0 0 18px;font-size:19px;font-weight:600; }h4 { margin:26px 0 12px;font-size:16px;font-weight:600; }
  strong { font-weight:600; }p { margin:8px 0 0;white-space:pre-wrap; }.secondary { color:var(--muted); }
  .finding + .finding { border-top:1px solid var(--border);padding-top:16px;margin-top:16px; }
</style>
