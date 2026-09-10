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
  {#if onEdit}<div class="edit-action"><button onclick={onEdit}>Edit setup</button></div>{/if}
  {#if scope && config}
    <div class="fields">
      <div class="primary"><span>Research name</span><strong>{scope.title}</strong></div>
      <div><span>Starting point</span><strong>{config.researchMode === "known-problem" ? "Known problem" : "Problem discovery"}</strong></div>
      {#if config.researchMode === "known-problem"}<div class="wide"><span>Problem statement</span><strong>{config.knownProblem}</strong></div>{/if}
      <div><span>{config.researchMode === "known-problem" ? "Market or domain" : "Starting context"}</span><strong>{scope.domain || "Not specified"}</strong></div>
      <div><span>{config.researchMode === "known-problem" ? "Audience" : "People or groups"}</span><strong>{scope.audience || "Not specified"}</strong></div>
      <div class="wide"><span>Context</span><p>{scope.observations || "No additional context."}</p></div>
      <div class="wide"><span>Evaluate risk against</span><p>{scope.riskEvaluationCriteria || "The research goal and boundaries."}</p></div>
      <div class="wide"><span>Boundaries</span>{#if scope.offLimits.length}<ul>{#each scope.offLimits as item, index (`${item}-${index}`)}<li>{item}</li>{/each}</ul>{:else}<p>No boundaries specified.</p>{/if}</div>
    </div>
    <dl class="run-settings">
      <div><dt>Model</dt><dd>{config.model.modelId}</dd></div>
      <div><dt>Provider</dt><dd>{config.model.providerId}</dd></div>
      <div><dt>Reasoning</dt><dd>{config.reasoningEffort}</dd></div>
      <div><dt>Ideas per problem</dt><dd>{config.ideaCount ?? (config.workflowVersion === 2 ? 3 : "3–5")}</dd></div>
      {#if config.researchMode === "explore-market"}<div><dt>Research depth</dt><dd>{config.discoveryDepth}</dd></div>{/if}
      {#if config.researchMode === "explore-market"}<div><dt>Search provider</dt><dd>{config.searchProvider}</dd></div>{/if}
    </dl>
  {:else}
    <div class="empty"><h2>No setup has been saved.</h2><p>Complete this step to begin the workflow.</p></div>
  {/if}
</div>

<style>
  .setup { max-width:1080px;margin:auto;padding:38px var(--page-inline) 70px; }
  .edit-action { display:flex;justify-content:space-between;align-items:center;gap:24px;margin-bottom:30px; }
  button { border:1px solid var(--border-strong);background:var(--surface);color:var(--text);border-radius:8px;padding:10px 14px;white-space:nowrap;font-size:13px; }
  .fields { display:grid;grid-template-columns:1fr 1fr;border:1px solid var(--border);border-radius:16px;padding:8px 26px;background:linear-gradient(145deg,#1b202355,transparent); }
  .fields > div { padding:22px 0;border-bottom:1px solid var(--border); }
  .fields > div:nth-child(even):not(.wide) { padding-right:24px; }
  .fields > div:last-child { border:0; }.fields .wide,.fields .primary { grid-column:1/-1; }
  .fields span,dt { display:block;margin-bottom:8px;font:500 13px var(--sans);color:var(--subtle); }
  .fields strong { font-size:14px;line-height:1.7;font-weight:550; }.fields .primary strong { font-size:23px;letter-spacing:-.025em;font-weight:600; }
  .fields p,.fields ul { margin:0;color:var(--muted);font-size:13px;line-height:1.8;max-width:76ch; }.fields ul { padding-left:18px; }
  .run-settings { display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px;background:var(--surface);border:1px solid var(--border);border-radius:13px;padding:24px;margin:20px 0 0; }
  dd { margin:0;font-size:13px;color:var(--muted);overflow-wrap:anywhere; }
  .empty { padding:40px 0;color:var(--muted); }.empty h2 { font-size:18px; }
  @media(max-width:700px) { .setup { padding:28px 22px; }.fields { grid-template-columns:1fr;padding:8px 20px; }.fields > div:nth-child(even):not(.wide) { padding-right:0; }.run-settings { grid-template-columns:1fr 1fr; } }
  .setup { max-width:none;width:100%;margin:0;padding:26px var(--page-inline) 56px; }
  .fields { border:0;border-radius:0;background:none;padding:0;grid-template-columns:minmax(0,1fr) minmax(0,2fr);gap:0 40px; }
  .fields > div { min-width:0;padding:20px 0; }.fields > div:nth-child(even):not(.wide) { padding-right:0; }
  .fields .primary { padding-top:0;padding-bottom:24px; }.fields .primary strong { font-size:26px;line-height:1.4;overflow-wrap:anywhere; }
  .fields span,dt { font-size:13px; }.fields strong,.fields p,.fields ul { font-size:14px;max-width:none; }
  .run-settings { border:0;border-radius:0;background:none;padding:24px 0 0;margin:0; }
  @media(max-width:800px) { .fields { grid-template-columns:minmax(0,1fr); } }
</style>
