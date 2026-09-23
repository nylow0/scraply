<script lang="ts">
  import { untrack } from "svelte";
  import { SvelteMap } from "svelte/reactivity";
  import type { WorkspaceState } from "../../shared/ipc";
  import { modelRefKey, type ModelRef, type SearchProvider } from "../../shared/schemas";
  import { modelDisplayName, readResearchDefaults, saveResearchDefaults } from "../lib/research-defaults";
  import ProviderLogo from "./ProviderLogo.svelte";

  let { workspace }: { workspace: WorkspaceState | null } = $props();
  const initial = untrack(readResearchDefaults);
  let searchProvider = $state<SearchProvider>(initial.searchProvider);
  let modelKey = $state(modelRefKey(initial.model));
  let titleModelKey = $state(modelRefKey(initial.titleModel));
  let titleReasoningEffort = $state(initial.titleReasoningEffort);
  let audienceSourcePolicy = $state(initial.audienceSourcePolicy);
  let discoveryDepth = $state(initial.discoveryDepth);
  let titleEfforts = $derived(workspace?.modelOptions.find((model) => modelRefKey(model) === titleModelKey)?.reasoningEfforts ?? [{ id: "low", description: "" }, { id: "medium", description: "" }, { id: "high", description: "" }]);
  let saved = $state(false);
  let error = $state("");
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
    return [...choices.values()];
  });
  let titleModel = $derived(models.find((model) => modelRefKey(model) === titleModelKey));
  let selectedModel = $derived(models.find((model) => modelRefKey(model) === modelKey));
  function save() {
    if (!selectedModel || !titleModel) return;
    error = "";
    try {
      saveResearchDefaults({ searchProvider, audienceSourcePolicy, discoveryDepth, titleModel: { providerId: titleModel.providerId, modelId: titleModel.modelId }, titleReasoningEffort, model: { providerId: selectedModel.providerId, modelId: selectedModel.modelId } });
      saved = true;
    } catch {
      error = "Could not save defaults on this device. Try again.";
    }
  }
</script>
<form onsubmit={(event) => { event.preventDefault(); save(); }}>
  <label><span>Default search provider</span><div class="provider-select"><ProviderLogo provider={searchProvider} size={18} /><select aria-label="Default search provider" bind:value={searchProvider} onchange={() => saved = false}><option value="exa">Exa</option><option value="perplexity">Perplexity</option></select></div></label>
  <label><span>Default model</span><select aria-label="Default model" bind:value={modelKey} onchange={() => saved = false}>
    {#each models as model (modelRefKey(model))}<option value={modelRefKey(model)}>{model.displayName}{model.available ? "" : workspace?.validation.native.connected ? " (unavailable)" : ""}</option>{/each}
  </select></label>
  {#if selectedModel && !selectedModel.available && workspace?.validation.native.connected}<p class="availability" role="status">{selectedModel.displayName} isn't in the current model list. Refresh your account or choose another model.</p>{/if}
  <fieldset>
    <legend>Research titles</legend>
    <p>Blank research names are generated automatically.</p>
    <label><span>Title model</span><select aria-label="Title model" bind:value={titleModelKey} onchange={() => { saved = false; titleReasoningEffort = workspace?.modelOptions.find((model) => modelRefKey(model) === titleModelKey)?.defaultReasoningEffort ?? titleEfforts[0]?.id ?? "low"; }}>
      {#each models as model (modelRefKey(model))}<option value={modelRefKey(model)}>{model.displayName}{!model.available && workspace?.validation.native.connected ? " (unavailable)" : ""}</option>{/each}
    </select></label>
    <label><span>Title reasoning</span><select aria-label="Title reasoning" bind:value={titleReasoningEffort} onchange={() => saved = false}>
      {#if !titleEfforts.some((effort) => effort.id === titleReasoningEffort)}<option value={titleReasoningEffort}>{titleReasoningEffort} (unavailable)</option>{/if}
      {#each titleEfforts as effort (effort.id)}<option value={effort.id}>{effort.id.charAt(0).toUpperCase() + effort.id.slice(1)}</option>{/each}
    </select></label>
  </fieldset>
  <fieldset class="advanced-search">
    <legend>Advanced search defaults</legend>
    <p>Applied to new research. Each setup can override these choices.</p>
    <label><span>Search coverage</span><select aria-label="Default search coverage" bind:value={audienceSourcePolicy} onchange={() => saved = false} aria-describedby="default-coverage-help"><option value="web">Web and communities</option><option value="communities">Communities only</option></select></label>
    <label><span>Research depth</span><select aria-label="Default research depth" bind:value={discoveryDepth} onchange={() => saved = false} aria-describedby="default-depth-help"><option value="quick">Quick</option><option value="standard">Standard</option><option value="deep">Deep</option></select></label>
    <p id="default-coverage-help">Web and communities allows all sites, including forums. Communities only limits audience evidence to Reddit and Hacker News. Market research always searches all sites.</p>
    <p id="default-depth-help">Quick uses fewer searches and sources. Deep explores more sources and cross-checks. Standard balances the two.</p>
  </fieldset>
  <footer><button type="submit">Save defaults</button>{#if saved}<span role="status">Defaults saved</span>{/if}</footer>
  {#if error}<p role="alert">{error}</p>{/if}
</form>
<style>
  fieldset { grid-column:1/-1;margin:0;padding:18px 0 0;border:0;border-top:1px solid var(--border);display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px; }
  legend { float:left;width:100%;font-size:16px;font-weight:600;margin-bottom:6px; }
  fieldset p { grid-column:1/-1;font-size:13px;color:var(--muted);margin:0; }
  form { display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px 12px; }
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
  @media(max-width:600px) { form,fieldset { grid-template-columns:1fr; } }
</style>
