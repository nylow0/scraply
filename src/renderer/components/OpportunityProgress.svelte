<script lang="ts">
  import type {
    OpportunityBudgetExtension,
    OpportunityBudgetExtensionPreview,
    OpportunityExplorationProgress,
  } from "../../shared/opportunity-exploration";

  let {
    progress,
    busy,
    onPause,
    onResume,
    onPreviewExtension,
    onApplyExtension,
  }: {
    progress: OpportunityExplorationProgress;
    busy: boolean;
    onPause: () => Promise<void>;
    onResume: () => Promise<void>;
    onPreviewExtension: (extension: OpportunityBudgetExtension) => Promise<OpportunityBudgetExtensionPreview>;
    onApplyExtension: (preview: OpportunityBudgetExtensionPreview) => Promise<void>;
  } = $props();

  let additionalModelCalls = $state(2);
  let additionalSearches = $state(1);
  let preview = $state<OpportunityBudgetExtensionPreview | null>(null);
  let extensionError = $state<string | null>(null);
  let previewing = $state(false);

  let targetPercent = $derived(Math.min(100, Math.round((progress.counts.acceptedFamilies / progress.config.targetFamilies) * 100)));
  let terminal = $derived(TERMINAL_OPPORTUNITY_STATUSES.includes(progress.status));
  let canExtend = $derived(["useful-partial", "budget-exhausted"].includes(progress.status));
  let nextGap = $derived(progress.gaps.find((gap) => ["named", "search-needed", "ready"].includes(gap.status)) ?? null);

  async function createPreview() {
    extensionError = null;
    previewing = true;
    try {
      preview = await onPreviewExtension({ additionalModelCalls, additionalSearches });
    } catch (error) {
      preview = null;
      extensionError = error instanceof Error ? error.message : "Could not preview this budget extension.";
    } finally {
      previewing = false;
    }
  }
</script>

<section class="opportunity-progress" aria-label="Opportunity exploration progress">
  <header>
    <div>
      <p class="eyebrow">Distinct startup families</p>
      <h2>{progress.counts.acceptedFamilies}<span> / {progress.config.targetFamilies}</span></h2>
    </div>
    <span class="status">{statusLabel(progress.status)}</span>
  </header>

  <div class="meter" role="progressbar" aria-label="Accepted opportunity families" aria-valuemin="0" aria-valuemax={progress.config.targetFamilies} aria-valuenow={progress.counts.acceptedFamilies}>
    <span style={`width:${targetPercent}%`}></span>
  </div>

  <dl class="counts">
    <div><dt>Related variants</dt><dd>{progress.counts.variants}</dd></div>
    <div><dt>Duplicates</dt><dd>{progress.counts.duplicates}</dd></div>
    <div><dt>Other useful options</dt><dd>{progress.counts.other}</dd></div>
    <div><dt>Needs review</dt><dd>{progress.counts.unresolved + progress.counts.unreviewed}</dd></div>
    <div><dt>From saved problems</dt><dd>{progress.originCounts.problemEvidence}</dd></div>
    <div><dt>Exploratory hypotheses</dt><dd>{progress.originCounts.exploratoryHypotheses}</dd></div>
  </dl>

  <dl class="budget">
    <div><dt>Model calls</dt><dd>{progress.usage.modelCalls} / {progress.config.maxModelCalls}</dd></div>
    <div><dt>Added searches</dt><dd>{progress.usage.searches} / {progress.config.maxSearches}</dd></div>
    <div><dt>Expansion rounds</dt><dd>{progress.usage.expansionRounds} / {progress.config.maxExpansionRounds}</dd></div>
    <div><dt>Raw candidates</dt><dd>{progress.usage.rawCandidates} / {progress.config.maxRawCandidates}</dd></div>
  </dl>

  {#if nextGap}
    <section class="gap">
      <span>Next named gap</span>
      <strong>{nextGap.name}</strong>
      <p>{nextGap.description}</p>
      {#if nextGap.evidenceNeeded}<small>Evidence needed: {nextGap.evidenceNeeded}</small>{/if}
    </section>
  {/if}

  {#if progress.stopReason}
    <p class="stop-reason"><strong>{terminal ? "Stopped" : "Status"}:</strong> {progress.stopReason}</p>
  {/if}

  <footer>
    {#if progress.status === "paused"}
      <button type="button" disabled={busy} onclick={() => onResume()}>{busy ? "Resuming…" : "Resume exploration"}</button>
    {:else if !terminal}
      <button type="button" class="secondary" disabled={busy} onclick={() => onPause()}>{busy ? "Pausing…" : "Pause"}</button>
    {/if}
  </footer>

  {#if canExtend}
    <section class="extension" aria-label="Budget extension">
      <div><h3>Preview one bounded extension</h3><p>Hard limits stay at two expansion rounds and twice the family target. This preview only adds provider calls for the saved gap.</p></div>
      <div class="extension-inputs">
        <label><span>More model calls</span><input aria-label="Additional opportunity model calls" type="number" min="0" max="20" step="1" bind:value={additionalModelCalls} /></label>
        <label><span>More searches</span><input aria-label="Additional opportunity searches" type="number" min="0" max="10" step="1" bind:value={additionalSearches} /></label>
        <button type="button" class="secondary" disabled={busy || previewing || (additionalModelCalls === 0 && additionalSearches === 0)} onclick={createPreview}>{previewing ? "Checking…" : "Preview extension"}</button>
      </div>
      {#if extensionError}<p class="error" role="alert">{extensionError}</p>{/if}
      {#if preview}
        <div class="preview">
          <p>{preview.summary}</p>
          <small>New limits: {preview.proposed.maxModelCalls} model calls and {preview.proposed.maxSearches} added searches.</small>
          <button type="button" disabled={busy} onclick={() => onApplyExtension(preview!)}>{busy ? "Applying…" : "Apply extension"}</button>
        </div>
      {/if}
    </section>
  {/if}
</section>

<script lang="ts" module>
  import type { OpportunityExplorationStatus } from "../../shared/opportunity-exploration";

  // Exploration has stopped in these states; App also uses them to hide the finished panel while an idea is open.
  export const TERMINAL_OPPORTUNITY_STATUSES: OpportunityExplorationStatus[] = ["target-reached", "useful-partial", "budget-exhausted", "failed"];

  function statusLabel(status: OpportunityExplorationStatus): string {
    const labels: Record<OpportunityExplorationStatus, string> = {
      "mapping-coverage": "Mapping coverage",
      "searching-gap": "Searching one gap",
      "generating-batch": "Generating a batch",
      "reviewing-batch": "Reviewing the batch",
      "target-reached": "Target reached",
      "useful-partial": "Useful partial set",
      "budget-exhausted": "Budget exhausted",
      paused: "Paused",
      failed: "Failed",
    };
    return labels[status];
  }
</script>

<style>
  .opportunity-progress { display:grid;gap:18px;padding:20px;border:1px solid var(--border);border-radius:10px;background:#000; }
  header { display:flex;justify-content:space-between;gap:20px;align-items:start; }
  .eyebrow { margin:0 0 6px;color:var(--muted);font-size:13px; }
  h2 { margin:0;font-size:34px;line-height:1;font-variant-numeric:tabular-nums; }
  h2 span { color:var(--muted);font-size:16px;font-weight:500; }
  .status { padding:5px 8px;border:1px solid var(--border);border-radius:5px;color:var(--muted);font-size:12px; }
  .meter { height:5px;background:var(--surface-2);overflow:hidden; }
  .meter span { display:block;height:100%;background:var(--accent-strong); }
  dl { margin:0; }
  .counts { display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:var(--border); }
  .counts div { padding:12px;background:#050505; }
  .counts dt,.budget dt { color:var(--muted);font-size:12px; }
  .counts dd { margin:5px 0 0;font-size:18px;font-variant-numeric:tabular-nums; }
  .budget { display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px; }
  .budget div { padding-top:10px;border-top:1px solid var(--border); }
  .budget dd { margin:4px 0 0;font-size:13px;font-variant-numeric:tabular-nums; }
  .gap { padding:14px;border:1px solid var(--border);border-radius:8px;background:var(--surface); }
  .gap > span { display:block;color:var(--muted);font-size:12px; }
  .gap strong { display:block;margin-top:6px;font-size:14px; }
  .gap p { margin:6px 0;color:var(--muted);font-size:13px; }
  .gap small { color:var(--subtle);font-size:12px; }
  .stop-reason { margin:0;padding:12px;border-left:2px solid var(--accent);background:var(--surface);font-size:13px;line-height:1.5; }
  footer { display:flex;justify-content:flex-end; }
  /* A finished exploration has no action, so its footer takes no row in the grid. */
  footer:empty { display:none; }
  button { border:1px solid transparent;border-radius:7px;padding:9px 12px;background:var(--accent-strong);color:var(--accent-ink);font-size:13px;font-weight:650; }
  button.secondary { border-color:var(--border-strong);background:var(--surface-2);color:var(--text); }
  button:disabled { opacity:.5; }
  .extension { display:grid;gap:14px;padding-top:18px;border-top:1px solid var(--border); }
  .extension h3 { margin:0;font-size:14px; }
  .extension p { margin:5px 0 0;color:var(--muted);font-size:12px;line-height:1.5; }
  .extension-inputs { display:grid;grid-template-columns:1fr 1fr auto;gap:10px;align-items:end; }
  label { display:grid;gap:6px; }
  label span { color:var(--muted);font-size:12px; }
  input { width:100%;border:1px solid var(--border);border-radius:6px;padding:9px;background:var(--surface);color:var(--text);font-size:13px; }
  .preview { display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center;padding:12px;border:1px solid var(--border-strong);border-radius:8px; }
  .preview p { flex:1 1 280px;margin:0;color:var(--text); }
  .preview small { flex:1 1 100%;color:var(--muted); }
  .error { color:var(--danger) !important; }
  @container page (max-width:600px) { .counts { grid-template-columns:repeat(2,minmax(0,1fr)); }.budget { grid-template-columns:repeat(2,minmax(0,1fr)); }.extension-inputs { grid-template-columns:1fr 1fr; }.extension-inputs button { grid-column:1/-1; } }
</style>
