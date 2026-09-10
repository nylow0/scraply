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
  let saved = $state(false);
  let error = $state("");
  let models = $derived.by(() => {
    const choices = new SvelteMap<string, ModelRef & { displayName: string; available: boolean }>();
    for (const modelId of ["gpt-5.6-sol", "gpt-6-astra"]) {
      const model = { providerId: "openai-subscription", modelId };
      choices.set(modelRefKey(model), { ...model, displayName: modelDisplayName(model), available: false });
    }
    for (const model of workspace?.modelOptions ?? []) {
      if (model.providerId === "openai-subscription") {
        choices.set(modelRefKey(model), { ...model, displayName: modelDisplayName(model),
          available: workspace?.models.some((offered) => modelRefKey(offered) === modelRefKey(model)) ?? false });
      }
    }
    if (!choices.has(modelRefKey(initial.model))) {
      choices.set(modelRefKey(initial.model), { ...initial.model, displayName: modelDisplayName(initial.model), available: false });
    }
    return [...choices.values()];
  });
  let selectedModel = $derived(models.find((model) => modelRefKey(model) === modelKey));
  function save() {
    if (!selectedModel) return;
    error = "";
    try {
      saveResearchDefaults({ searchProvider, model: { providerId: selectedModel.providerId, modelId: selectedModel.modelId } });
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
  {#if selectedModel && !selectedModel.available && workspace?.validation.native.connected}<p class="availability" role="status">{selectedModel.displayName} isn't available for this account. You can save it as a default, but research needs an available model.</p>{/if}
  <footer><button type="submit">Save defaults</button>{#if saved}<span role="status">Defaults saved</span>{/if}</footer>
  <p class="scope-note">Applies to new research.</p>
  {#if error}<p role="alert">{error}</p>{/if}
</form>
<style>
  form { display:grid;gap:24px; }
  label { display:grid;gap:10px;min-width:0;font-size:12px; }
  select { width:100%;min-width:0;background:var(--surface);border:1px solid var(--border-strong);border-radius:9px;color:var(--text);padding:12px;font-size:12px; }
  .provider-select { position:relative;color:var(--text); }
  .provider-select :global(svg) { position:absolute;top:50%;left:13px;transform:translateY(-50%);pointer-events:none; }
  .provider-select select { padding-left:42px; }
  footer { display:flex;gap:14px;align-items:center; }
  button { padding:11px 16px;border:0;border-radius:8px;background:var(--accent-strong);color:var(--accent-ink);font-size:12px;font-weight:600; }
  footer span { color:var(--success);font-size:11px; }
  .scope-note { margin:-12px 0 0;color:var(--subtle);font-size:11px; }
  .availability { padding:12px;border:1px solid var(--border);border-radius:8px;color:var(--muted);font-size:11px;line-height:1.7;margin:0; }
  [role="alert"] { color:var(--danger);font-size:12px;margin:0; }
</style>
