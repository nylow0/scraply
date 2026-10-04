<script lang="ts">
  import { untrack } from "svelte";
  import { SvelteMap } from "svelte/reactivity";
  import type { WorkspaceState } from "../../shared/ipc";
  import { modelRefKey, type ModelRef } from "../../shared/schemas";
  import type { SearchProviderChoice } from "../../providers/search";
  import { modelDisplayName, readResearchDefaults, saveResearchDefaults } from "../lib/research-defaults";
  import SearchProviderSelect from "./SearchProviderSelect.svelte";

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
  let models = $derived.by(() => {
    const choices = new SvelteMap<string, ModelRef & { displayName: string; available: boolean }>();
    for (const modelId of ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-luna"]) {
      const model = { providerId: "openai-subscription", modelId };
      choices.set(modelRefKey(model), { ...model, displayName: modelDisplayName(model), available: false });
    }
    for (const model of workspace?.modelOptions ?? []) {
      if (model.providerId === "openai-subscription") {
        choices.set(modelRefKey(model), { ...model, displayName: modelDisplayName(model),
          available: workspace?.models.some((offered) => modelRefKey(offered) === modelRefKey(model)) ?? false });
      }
    }
    if (!choices.has(modelRefKey(initial.titleModel))) {
      choices.set(modelRefKey(initial.titleModel), { ...initial.titleModel, displayName: modelDisplayName(initial.titleModel), available: false });
    }
    if (!choices.has(modelRefKey(initial.model))) {
      choices.set(modelRefKey(initial.model), { ...initial.model, displayName: modelDisplayName(initial.model), available: false });
    }
    if (initial.ideasModel && !choices.has(modelRefKey(initial.ideasModel))) {
      choices.set(modelRefKey(initial.ideasModel), { ...initial.ideasModel, displayName: modelDisplayName(initial.ideasModel), available: false });
    }
    return [...choices.values()];
  });
  let titleModel = $derived(models.find((model) => modelRefKey(model) === titleModelKey));
  let selectedModel = $derived(models.find((model) => modelRefKey(model) === modelKey));
  let ideasModel = $derived(models.find((model) => modelRefKey(model) === ideasModelKey));
  function save() {
    if (!selectedModel || !ideasModel || !titleModel) return;
    error = "";
    try {
      saveResearchDefaults({ searchProvider, discoveryDepth,
        model: { providerId: selectedModel.providerId, modelId: selectedModel.modelId },
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ideasModel: { providerId: ideasModel.providerId, modelId: ideasModel.modelId },
        ...(ideasReasoningEffort ? { ideasReasoningEffort } : {}),
        titleModel: { providerId: titleModel.providerId, modelId: titleModel.modelId }, titleReasoningEffort });
      saved = true;
    } catch {
      error = "Could not save defaults on this device. Try again.";
    }
  }
</script>
<form onsubmit={(event) => { event.preventDefault(); save(); }}>
  <label><span>Default search provider</span><SearchProviderSelect label="Default search provider" bind:value={searchProvider} connected={{ exa: workspace?.validation.exa.valid ?? true, perplexity: workspace?.validation.perplexity.valid ?? true }} onchange={() => saved = false} /></label>
  <label><span>Default model</span><select aria-label="Default model" bind:value={modelKey} onchange={() => { saved = false; reasoningEffort = catalogEffort(modelKey) ?? ""; }}>
    {#each models as model (modelRefKey(model))}<option value={modelRefKey(model)}>{model.displayName}{model.available ? "" : workspace?.validation.native.connected ? " (unavailable)" : ""}</option>{/each}
  </select></label>
  <label><span>Default reasoning</span><select aria-label="Default reasoning" bind:value={reasoningEffort} onchange={() => saved = false}>
    {#if reasoningEffort && !researchEfforts.some((effort) => effort.id === reasoningEffort)}<option value={reasoningEffort}>{reasoningEffort} (unavailable)</option>{/if}
    {#each researchEfforts as effort (effort.id)}<option value={effort.id}>{effort.id.charAt(0).toUpperCase() + effort.id.slice(1)}</option>{/each}
  </select></label>
  {#if selectedModel && !selectedModel.available && workspace?.validation.native.connected}<p class="availability" role="status">{selectedModel.displayName} isn't in the current model list. Refresh your account or choose another model.</p>{/if}
  <fieldset>
    <legend>Research titles</legend>
    <p>This model names each research when you start it.</p>
    <label><span>Title model</span><select aria-label="Title model" bind:value={titleModelKey} onchange={() => { saved = false; titleReasoningEffort = workspace?.modelOptions.find((model) => modelRefKey(model) === titleModelKey)?.defaultReasoningEffort ?? titleEfforts[0]?.id ?? "low"; }}>
      {#each models as model (modelRefKey(model))}<option value={modelRefKey(model)}>{model.displayName}{!model.available && workspace?.validation.native.connected ? " (unavailable)" : ""}</option>{/each}
    </select></label>
    <label><span>Title reasoning</span><select aria-label="Title reasoning" bind:value={titleReasoningEffort} onchange={() => saved = false}>
      {#if !titleEfforts.some((effort) => effort.id === titleReasoningEffort)}<option value={titleReasoningEffort}>{titleReasoningEffort} (unavailable)</option>{/if}
      {#each titleEfforts as effort (effort.id)}<option value={effort.id}>{effort.id.charAt(0).toUpperCase() + effort.id.slice(1)}</option>{/each}
    </select></label>
  </fieldset>
  <fieldset>
    <legend>Ideas defaults</legend>
    <p>Used for new idea generation and review. Each setup can override these choices.</p>
    <label><span>Ideas model</span><select aria-label="Default ideas model" bind:value={ideasModelKey} onchange={() => { saved = false; ideasReasoningEffort = catalogEffort(ideasModelKey) ?? ""; }}>
      {#each models as model (modelRefKey(model))}<option value={modelRefKey(model)}>{model.displayName}{!model.available && workspace?.validation.native.connected ? " (unavailable)" : ""}</option>{/each}
    </select></label>
    <label><span>Ideas reasoning</span><select aria-label="Default ideas reasoning" bind:value={ideasReasoningEffort} onchange={() => saved = false}>
      {#if ideasReasoningEffort && !ideasEfforts.some((effort) => effort.id === ideasReasoningEffort)}<option value={ideasReasoningEffort}>{ideasReasoningEffort} (unavailable)</option>{/if}
      {#each ideasEfforts as effort (effort.id)}<option value={effort.id}>{effort.id.charAt(0).toUpperCase() + effort.id.slice(1)}</option>{/each}
    </select></label>
    {#if ideasModel && !ideasModel.available && workspace?.validation.native.connected}<p class="availability" role="status">{ideasModel.displayName} isn't in the current model list. Refresh your account or choose another model.</p>{/if}
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
  label { display:grid;align-content:start;gap:8px;min-width:0;font-size:13px;--search-provider-padding:12px;--search-provider-radius:9px;--search-provider-font-size:13px;--search-provider-option-height:45px; }
  select { width:100%;min-width:0;background:var(--surface);border:1px solid var(--border-strong);border-radius:9px;color:var(--text);padding:12px;font-size:13px; }
  footer { grid-column:1/-1;display:flex;flex-wrap:wrap;gap:14px;align-items:center; }
  button { padding:11px 16px;border:0;border-radius:8px;background:var(--accent-strong);color:var(--accent-ink);font-size:13px;font-weight:600; }
  footer span { color:var(--success);font-size:13px; }
  .availability { grid-column:1/-1;padding:12px;border:1px solid var(--border);border-radius:8px;color:var(--muted);font-size:13px;line-height:1.7;margin:0; }
  [role="alert"] { grid-column:1/-1;color:var(--danger);font-size:13px;margin:0; }
  @media(max-width:800px) { form { grid-template-columns:repeat(2,minmax(0,1fr)); } }
  @media(max-width:600px) { form,fieldset { grid-template-columns:1fr; } }
</style>
