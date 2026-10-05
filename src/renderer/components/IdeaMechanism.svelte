<script lang="ts">
  import { mechanismSteps } from "../lib/idea-content";
  let { mechanism, heading = "How it works" }: { mechanism: string; heading?: string } = $props();
  let steps = $derived(mechanismSteps(mechanism));
</script>

<section class="mechanism"><h3>{heading}</h3>
  {#if steps}<ol>{#each steps as step, index (index)}<li>{step}</li>{/each}</ol>
  {:else}<p>{mechanism}</p>{/if}
</section>

<style>
  .mechanism { max-width:68ch;margin:28px 0;color:var(--text);font-size:15px;line-height:1.6; }
  h3 { margin:0 0 16px;font-size:17px;font-weight:600;line-height:1.4; }
  ol { list-style:decimal;margin:0;padding-left:26px; }
  li { padding-left:8px; }li + li { margin-top:12px; }li::marker { color:var(--muted);font-variant-numeric:tabular-nums; }
  p { margin:0;white-space:pre-wrap; }
</style>
