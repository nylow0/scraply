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

<button disabled={busy || assessing} onclick={previewAssessment}>Assess</button>
{#if preview}
  <p>This assessment allows up to {preview.minimumWork.modelCalls} model calls and {preview.minimumWork.searches} searches. It uses the saved candidate and its evidence.</p>
  {#each preview.fieldErrors as error, index (index)}<p role="alert">{error.message}</p>{/each}
  <button disabled={busy || assessing || preview.fieldErrors.length > 0} onclick={assessCandidate}>Assess candidate</button>
{/if}
{#if errorMessage}<p role="alert">{errorMessage}</p>{/if}
