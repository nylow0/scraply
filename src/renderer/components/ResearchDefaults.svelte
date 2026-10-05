<script lang="ts">
  import { untrack } from "svelte";
  import type { WorkspaceState } from "../../shared/ipc";
  import { modelRefKey, type ModelRef } from "../../shared/schemas";
  import type { SearchProviderChoice } from "../../providers/search";
  import { modelDisplayName, readResearchDefaults, saveResearchDefaults } from "../lib/research-defaults";
  import ProviderLogo from "./ProviderLogo.svelte";
  import ModelPicker from "./ModelPicker.svelte";

  let { workspace }: { workspace: WorkspaceState | null } = $props();
  const initial = untrack(readResearchDefaults);
  let searchProvider = $state<SearchProviderChoice>(initial.searchProvider);
  let modelKey = $state(modelRefKey(initial.model));
  let reasoningEffort = $state(initial.reasoningEffort ?? "");
  let ideasModelKey = $state(modelRefKey(initial.ideasModel ?? initial.model));
  let ideasReasoningEffort = $state(initial.ideasReasoningEffort ?? "");
  let titleModelKey = $state(modelRefKey(initial.titleModel));
  let titleReasoningEffort = $state(initial.titleReasoningEffort);
  let discoveryDepth = $state(initial.discoveryDepth);
  let researchEfforts = $derived(workspace?.modelOptions.find((model) => modelRefKey(model) === modelKey)?.reasoningEfforts ?? []);
  let ideasEfforts = $derived(workspace?.modelOptions.find((model) => modelRefKey(model) === ideasModelKey)?.reasoningEfforts ?? []);
  let titleEfforts = $derived(workspace?.modelOptions.find((model) => modelRefKey(model) === titleModelKey)?.reasoningEfforts ?? [{ id: "low", description: "" }, { id: "medium", description: "" }, { id: "high", description: "" }]);
  let saved = $state(false);
  let error = $state("");
  function catalogEffort(key: string): string | undefined {
    return workspace?.modelOptions.find((model) => modelRefKey(model) === key)?.defaultReasoningEffort;
  }
  $effect(() => {
    if (!workspace) return;
    if (!reasoningEffort) reasoningEffort = catalogEffort(modelKey) ?? "";
    if (!ideasReasoningEffort) ideasReasoningEffort = catalogEffort(ideasModelKey) ?? "";
  });
  // The pickers list what the account offers. A saved default it no longer offers stays selected by name.
  let options = $derived((workspace?.modelOptions ?? []).filter((model) => model.providerId === "openai-subscription"));
  const savedModels: ModelRef[] = [initial.model, initial.titleModel, ...(initial.ideasModel ? [initial.ideasModel] : [])];
  function modelFor(key: string): ModelRef | undefined {
    const model = options.find((item) => modelRefKey(item) === key) ?? savedModels.find((item) => modelRefKey(item) === key);
    return model && { providerId: model.providerId, modelId: model.modelId };
  }
  function offered(key: string): boolean {
    return options.some((item) => modelRefKey(item) === key);
  }
  function missingLabel(key: string): string {
    const model = modelFor(key);
    return model ? `${modelDisplayName(model)}${workspace?.validation.native.connected ? " (unavailable)" : ""}` : "Choose a model";
  }
  let titleModel = $derived(modelFor(titleModelKey));
  let selectedModel = $derived(modelFor(modelKey));
  let ideasModel = $derived(modelFor(ideasModelKey));
  function save() {
    if (!selectedModel || !ideasModel || !titleModel) return;
    error = "";
    try {
      saveResearchDefaults({ searchProvider, discoveryDepth,
        model: selectedModel,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ideasModel,
        ...(ideasReasoningEffort ? { ideasReasoningEffort } : {}),
        titleModel, titleReasoningEffort });
      saved = true;
    } catch {
      error = "Could not save defaults on this device. Try again.";
    }
  }
</script>
<form onsubmit={(event) => { event.preventDefault(); save(); }}>
  <label><span>Default search provider</span><div class="provider-select">{#if searchProvider !== "auto"}<ProviderLogo provider={searchProvider} size={18} />{/if}<select aria-label="Default search provider" bind:value={searchProvider} onchange={() => saved = false}><option value="auto">Automatic</option><option value="exa">Exa</option><option value="perplexity">Perplexity</option></select></div></label>
  <label><span>Default model</span><ModelPicker label="Default model" {options} bind:value={modelKey} missingLabel={missingLabel(modelKey)} disabled={options.length === 0}
    onchange={() => { saved = false; reasoningEffort = catalogEffort(modelKey) ?? ""; }} /></label>
  <label><span>Default reasoning</span><select aria-label="Default reasoning" bind:value={reasoningEffort} onchange={() => saved = false}>
    {#if reasoningEffort && !researchEfforts.some((effort) => effort.id === reasoningEffort)}<option value={reasoningEffort}>{reasoningEffort} (unavailable)</option>{/if}
    {#each researchEfforts as effort (effort.id)}<option value={effort.id}>{effort.id.charAt(0).toUpperCase() + effort.id.slice(1)}</option>{/each}
  </select></label>
  {#if selectedModel && !offered(modelKey) && workspace?.validation.native.connected}<p class="availability" role="status">{modelDisplayName(selectedModel)} isn't in the current model list. Refresh your account or choose another model.</p>{/if}
  <fieldset>
    <legend>Research titles</legend>
    <p>This model names each research when you start it.</p>
    <label><span>Title model</span><ModelPicker label="Title model" {options} bind:value={titleModelKey} missingLabel={missingLabel(titleModelKey)} disabled={options.length === 0}
      onchange={() => { saved = false; titleReasoningEffort = catalogEffort(titleModelKey) ?? titleEfforts[0]?.id ?? "low"; }} /></label>
    <label><span>Title reasoning</span><select aria-label="Title reasoning" bind:value={titleReasoningEffort} onchange={() => saved = false}>
      {#if !titleEfforts.some((effort) => effort.id === titleReasoningEffort)}<option value={titleReasoningEffort}>{titleReasoningEffort} (unavailable)</option>{/if}
      {#each titleEfforts as effort (effort.id)}<option value={effort.id}>{effort.id.charAt(0).toUpperCase() + effort.id.slice(1)}</option>{/each}
    </select></label>
  </fieldset>
  <fieldset>
    <legend>Ideas defaults</legend>
    <p>Used for new idea generation and review. Each setup can override these choices.</p>
    <label><span>Ideas model</span><ModelPicker label="Default ideas model" {options} bind:value={ideasModelKey} missingLabel={missingLabel(ideasModelKey)} disabled={options.length === 0}
      onchange={() => { saved = false; ideasReasoningEffort = catalogEffort(ideasModelKey) ?? ""; }} /></label>
    <label><span>Ideas reasoning</span><select aria-label="Default ideas reasoning" bind:value={ideasReasoningEffort} onchange={() => saved = false}>
      {#if ideasReasoningEffort && !ideasEfforts.some((effort) => effort.id === ideasReasoningEffort)}<option value={ideasReasoningEffort}>{ideasReasoningEffort} (unavailable)</option>{/if}
      {#each ideasEfforts as effort (effort.id)}<option value={effort.id}>{effort.id.charAt(0).toUpperCase() + effort.id.slice(1)}</option>{/each}
    </select></label>
    {#if ideasModel && !offered(ideasModelKey) && workspace?.validation.native.connected}<p class="availability" role="status">{modelDisplayName(ideasModel)} isn't in the current model list. Refresh your account or choose another model.</p>{/if}
  </fieldset>
  <fieldset class="advanced-search">
    <legend>Advanced search defaults</legend>
    <p>Applied to new research. Each setup can override these choices.</p>
    <label><span>Research depth</span><select aria-label="Default research depth" bind:value={discoveryDepth} onchange={() => saved = false} aria-describedby="default-depth-help"><option value="quick">Quick</option><option value="standard">Standard</option><option value="deep">Deep</option></select></label>
    <p>Research searches the web and places where affected people share their experiences.</p>
    <p id="default-depth-help">Quick uses fewer searches and sources. Deep explores more sources and cross-checks. Standard balances the two.</p>
  </fieldset>
  <footer><button type="submit">Save defaults</button>{#if saved}<span role="status">Defaults saved</span>{/if}</footer>
  {#if error}<p role="alert">{error}</p>{/if}
</form>
<style>
  fieldset { grid-column:1/-1;margin:0;padding:18px 0 0;border:0;border-top:1px solid var(--border);display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px; }
  legend { float:left;width:100%;font-size:16px;font-weight:600;margin-bottom:6px; }
  fieldset p { grid-column:1/-1;font-size:13px;color:var(--muted);margin:0; }
  form { display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px 12px; }
  label { display:grid;align-content:start;gap:8px;min-width:0;font-size:13px; }
  select { width:100%;min-width:0;background:var(--surface);border:1px solid var(--border-strong);border-radius:9px;color:var(--text);padding:12px;font-size:13px; }
  .provider-select { position:relative;color:var(--text); }
  .provider-select :global(svg) { position:absolute;top:50%;left:13px;transform:translateY(-50%);pointer-events:none; }
  .provider-select select { padding-left:42px; }
  footer { grid-column:1/-1;display:flex;flex-wrap:wrap;gap:14px;align-items:center; }
  button { padding:11px 16px;border:0;border-radius:8px;background:var(--accent-strong);color:var(--accent-ink);font-size:13px;font-weight:600; }
  footer span { color:var(--success);font-size:13px; }
  .availability { grid-column:1/-1;padding:12px;border:1px solid var(--border);border-radius:8px;color:var(--muted);font-size:13px;line-height:1.7;margin:0; }
  [role="alert"] { grid-column:1/-1;color:var(--danger);font-size:13px;margin:0; }
  @media(max-width:800px) { form { grid-template-columns:repeat(2,minmax(0,1fr)); } }
  @media(max-width:600px) { form,fieldset { grid-template-columns:1fr; } }
</style>
