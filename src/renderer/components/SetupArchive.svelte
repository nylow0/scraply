<script lang="ts">
  import type { WorkspaceState } from "../../shared/ipc";

  let {
    workspace,
    onEdit,
  }: {
    workspace: WorkspaceState;
    onEdit?: () => void;
  } = $props();

  let scope = $derived(workspace.scope);
  let config = $derived(workspace.runConfig);
</script>

<div class="setup" id="workflow-panel-setup" role="tabpanel" aria-label="Research setup" tabindex="0">
  <header>
    <div><p class="eyebrow">Saved setup</p><h1>Where this work started.</h1><p>The original scope and run settings remain attached to the workflow.</p></div>
    {#if onEdit}<button onclick={onEdit}>Edit setup</button>{/if}
  </header>
  {#if scope && config}
    <div class="fields">
      <div class="primary"><span>Research name</span><strong>{scope.title}</strong></div>
      <div><span>Starting point</span><strong>{config.researchMode === "known-problem" ? "Known problem" : "Problem discovery"}</strong></div>
      {#if config.researchMode === "known-problem"}<div class="wide"><span>Problem statement</span><strong>{config.knownProblem}</strong></div>{/if}
      <div><span>{config.researchMode === "known-problem" ? "Market or domain" : "Starting context"}</span><strong>{scope.domain || "Not specified"}</strong></div>
      <div><span>{config.researchMode === "known-problem" ? "Audience" : "People or groups"}</span><strong>{scope.audience || "Not specified"}</strong></div>
      <div class="wide"><span>Context</span><p>{scope.observations || "No additional context."}</p></div>
      <div class="wide"><span>Boundaries</span>{#if scope.offLimits.length}<ul>{#each scope.offLimits as item}<li>{item}</li>{/each}</ul>{:else}<p>No boundaries specified.</p>{/if}</div>
    </div>
    <dl class="run-settings">
      <div><dt>Model</dt><dd>{config.model}</dd></div>
      <div><dt>Reasoning</dt><dd>{config.reasoningEffort}</dd></div>
      {#if config.researchMode === "explore-market"}<div><dt>Research depth</dt><dd>{config.discoveryDepth}</dd></div>{/if}
    </dl>
  {:else}
    <div class="empty"><h2>No setup has been saved.</h2><p>Complete this step to begin the workflow.</p></div>
  {/if}
</div>

<style>
  .setup{max-width:920px;margin:0 auto;padding:42px var(--page-inline) 90px}header{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:28px;align-items:end;padding-bottom:30px;border-bottom:1px solid var(--border)}.eyebrow{margin:0;font:600 11px var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--accent-strong)}h1{margin:8px 0;font-size:clamp(30px,4vw,46px);letter-spacing:-.04em;line-height:1.05}header p{margin:0;color:var(--muted)}header button{padding:9px 13px;border:1px solid var(--border-strong);border-radius:8px;background:var(--surface);color:var(--text);font-weight:650}.fields{display:grid;grid-template-columns:1fr 1fr;border-bottom:1px solid var(--border)}.fields>div{min-height:112px;padding:22px 0;border-bottom:1px solid var(--border)}.fields>div:nth-child(even):not(.wide){padding-left:24px;border-left:1px solid var(--border)}.fields .wide,.fields .primary{grid-column:1/-1}.fields span{display:block;margin-bottom:8px;font:600 10px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--subtle)}.fields strong{font-size:16px}.fields p{margin:0;color:var(--muted)}ul{margin:0;padding-left:18px;color:var(--muted)}li+li{margin-top:5px}.run-settings{display:flex;flex-wrap:wrap;gap:36px;margin:0;padding:22px 0}.run-settings div{min-width:150px}dt{font:600 10px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--subtle)}dd{margin:6px 0 0;font:600 12px var(--mono);text-transform:capitalize}.empty{padding:44px 0}.empty h2,.empty p{margin:0}.empty p{margin-top:6px;color:var(--muted)}@media(max-width:700px){.setup{padding:28px 20px 70px}header{grid-template-columns:1fr}.fields{grid-template-columns:1fr}.fields .wide,.fields .primary{grid-column:auto}.fields>div:nth-child(even):not(.wide){padding-left:0;border-left:0}.run-settings{gap:20px}}
</style>
