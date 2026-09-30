<script lang="ts">
  import type { PreviewWorkflowResult } from "../../shared/workflow-contracts";

  let { candidateId, busy, previewCandidateAssessment, onAssessCandidate }: {
    candidateId: string; busy: boolean;
    previewCandidateAssessment: (candidateId: string) => Promise<PreviewWorkflowResult>;
    onAssessCandidate: (preview: PreviewWorkflowResult) => Promise<void>;
  } = $props();
  let preview = $state<PreviewWorkflowResult | null>(null);
  let assessing = $state(false);
  let errorMessage = $state<string | null>(null);

  async function previewAssessment() {
    preview = null;
    errorMessage = null;
    assessing = true;
    try { preview = await previewCandidateAssessment(candidateId); }
    catch (error) { errorMessage = error instanceof Error ? error.message : "Could not preview this assessment."; }
    finally { assessing = false; }
  }

  async function assessCandidate() {
    if (!preview) return;
    assessing = true;
    errorMessage = null;
    try { await onAssessCandidate(preview); preview = null; }
    catch (error) { errorMessage = error instanceof Error ? error.message : "Could not start this assessment."; }
    finally { assessing = false; }
  }
</script>

<button class="preview" disabled={busy || assessing} onclick={previewAssessment}>{assessing && !preview ? "Previewing…" : "Assess"}</button>
{#if preview}
  <p>This assessment allows up to {preview.minimumWork.modelCalls} model calls and {preview.minimumWork.searches} searches. It uses the saved candidate and its evidence.</p>
  {#each preview.fieldErrors as error, index (index)}<p role="alert">{error.message}</p>{/each}
  <button class="start" disabled={busy || assessing || preview.fieldErrors.length > 0} onclick={assessCandidate}>{assessing ? "Starting…" : "Assess candidate"}</button>
{/if}
{#if errorMessage}<p role="alert">{errorMessage}</p>{/if}

<style>
  button { margin-top: 12px; padding: 8px 12px; border: 1px solid var(--border); border-radius: 7px; font-size: 0.82rem; font-weight: 600; cursor: pointer; }
  .preview { background: transparent; color: var(--text); }
  .preview:hover:not(:disabled) { background: var(--surface-2); }
  .start { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
  button:disabled { opacity: 0.5; cursor: default; }
  p { margin-top: 10px; color: var(--muted); font-size: 0.82rem; line-height: 1.5; }
  p[role="alert"] { color: var(--danger); }
</style>
