<script lang="ts">
  import type { CriterionFit } from "../../shared/solution-goal-fit";
  let { fit, expanded = false }: { fit?: CriterionFit[] | undefined; expanded?: boolean } = $props();
</script>

<div class="criteria-fit" aria-label="Criteria fit">
  {#if fit}
    {#each fit as entry (entry.criterionId)}
      <span class="criterion" data-fit={entry.status} title={entry.note}>
        {entry.criterionName}{entry.mustHave ? " · must-have" : ""}: {entry.status}
      </span>
      {#if expanded}<p>{entry.note}</p>{/if}
    {:else}<span class="unassessed">No criteria in this frame.</span>{/each}
  {:else}<span class="unassessed">Criteria fit not assessed</span>{/if}
</div>

<style>
  .criteria-fit { display:flex; flex-wrap:wrap; gap:6px; margin:10px 0; }
  .criterion { border:1px solid var(--border-strong); border-radius:6px; padding:4px 7px; font-size:11px; color:var(--muted); }
  .criterion[data-fit="meets"] { color:var(--success); }
  .criterion[data-fit="fails"] { color:var(--danger); }
  .criterion[data-fit="partial"] { color:var(--muted); }
  .unassessed { color:var(--muted); font-size:12px; }
  p { flex-basis:100%; margin:0 0 6px; font-size:13px; color:var(--muted); }
</style>
