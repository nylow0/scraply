<script lang="ts">
  import type { Snippet } from "svelte";
  import CandidateAssessmentControl from "./CandidateAssessmentControl.svelte";
  import { LEAD_LABELS, type ProblemLead } from "../lib/problem-leads";
  import type { PreviewWorkflowResult } from "../../shared/workflow-contracts";

  // Leads sit behind one "Show N more leads" button under the problems list. Used by the
  // Research tab and by Controlled mode, which adds its own per-lead actions.
  let { leads, busy, onOpenSource, previewCandidateAssessment, onAssessCandidate, actions }: {
    leads: ProblemLead[];
    busy: boolean;
    onOpenSource: (url: string) => Promise<void>;
    previewCandidateAssessment?: ((candidateId: string) => Promise<PreviewWorkflowResult>) | undefined;
    onAssessCandidate?: ((preview: PreviewWorkflowResult) => Promise<void>) | undefined;
    actions?: Snippet<[ProblemLead]>;
  } = $props();
  let open = $state(false);
</script>

{#if leads.length > 0}
  <section class="leads" aria-label="Leads">
    <button class="toggle" type="button" aria-expanded={open} onclick={() => (open = !open)}>
      {open ? "Hide leads" : `Show ${leads.length} more ${leads.length === 1 ? "lead" : "leads"}`}
    </button>
    {#if open}
      <div class="lead-list">
        {#each leads as lead (lead.id)}
          <article class="lead">
            <span class="chip" class:needs-evidence={lead.kind === "needs-evidence"}>{LEAD_LABELS[lead.kind]}</span>
            <h2>{lead.statement}</h2>
            {#if lead.problem}
              <p>{lead.problem.whyItPersists}</p>
              <p class="reason">{lead.problem.verdictReason}</p>
              {#if lead.problem.factors.length > 0}
                <details>
                  <summary>{lead.problem.factors.length} cited {lead.problem.factors.length === 1 ? "factor" : "factors"}</summary>
                  {#each lead.problem.factors as factor (factor.id)}
                    <blockquote>
                      <p>{factor.subject} — {factor.behavior}</p>
                      <q>{factor.quote}</q>
                      <button disabled={busy} onclick={() => onOpenSource(factor.sourceUrl)}>{factor.sourceTitle}</button>
                    </blockquote>
                  {/each}
                </details>
              {/if}
            {:else if lead.candidate.candidate}
              <p>{lead.candidate.candidate.whyItPersists}</p>
              <dl class="problem-data">
                <div><dt>Affected</dt><dd>{lead.candidate.candidate.affected}</dd></div>
                <div><dt>Scale estimate</dt><dd class="estimated">{lead.candidate.candidate.scaleEstimate}</dd></div>
              </dl>
            {/if}
            <!-- An unchecked lead's stored reason describes the run's limits, not the lead, so it stays hidden. -->
            {#if lead.candidate && lead.kind !== "not-checked"}<p class="reason">{lead.candidate.reason}</p>{/if}
            {#if lead.kind === "not-checked" && lead.candidate?.candidate && previewCandidateAssessment && onAssessCandidate}
              <CandidateAssessmentControl candidateId={lead.id} {busy} {previewCandidateAssessment} {onAssessCandidate} />
            {/if}
            {@render actions?.(lead)}
          </article>
        {/each}
      </div>
    {/if}
  </section>
{/if}

<style>
  .leads { margin-top:18px; }
  .toggle { padding:9px 12px;border:1px solid var(--border);border-radius:8px;background:transparent;color:var(--muted);font-size:13px; }
  .toggle:hover { color:var(--text);border-color:var(--border-strong); }
  .lead-list { display:grid;gap:10px;padding-top:14px; }
  .lead { padding:20px; }
  .lead p { font-size:13px;color:var(--muted); }
  .chip { display:inline-block;padding:4px 8px;border:1px solid var(--border-strong);border-radius:6px;color:var(--muted);font-size:12px; }
  .chip.needs-evidence { color:#d9b36c;border-color:#b9864555; }
  h2 { margin:12px 0 0; }
</style>
