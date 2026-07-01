<script lang="ts">
  import type { ModelCatalog, ModelProvider, ModelRef, RunConfig } from "../../shared/schemas";

  let {
    models,
    modelCatalog,
    config,
    presets,
    onSave,
    onFavorite,
    embedded = false,
    onChange,
  }: {
    models: string[];
    modelCatalog?: ModelCatalog;
    config: RunConfig;
    presets: Array<{ name: string; config: RunConfig }>;
    onSave?: (config: RunConfig, presetName?: string) => void;
    onFavorite: (model: ModelRef, favorite: boolean) => void;
    embedded?: boolean;
    onChange?: (config: RunConfig) => void;
  } = $props();

  let draft = $state({ ...config });
  let presetName = $state("");
  let customProvider: ModelProvider = $state("codex");
  let customModel = $state("");
  let modelSearch = $state("");

  $effect(() => {
    draft = { ...config };
  });

  $effect(() => {
    onChange?.($state.snapshot(draft) as RunConfig);
  });

  function applyPreset(name: string) {
    const preset = presets.find((item) => item.name === name);
    if (preset) draft = { ...preset.config };
  }

  const catalog = $derived(modelCatalog ?? { opencode: models, codex: [], favorites: [] });
  const favoriteKeys = $derived(new Set(catalog.favorites.map((model) => modelKey(model.provider, model.id))));
  const favoriteOptions = $derived(catalog.favorites);

  const search = $derived(modelSearch.trim().toLowerCase());
  const codexMatches = $derived(catalog.codex.filter((model) => model.toLowerCase().includes(search)));
  const opencodeMatches = $derived(catalog.opencode.filter((model) => model.toLowerCase().includes(search)));

  function modelKey(provider: ModelProvider, id: string) {
    return `${provider}:${id}`;
  }

  function providerModels(provider: ModelProvider) {
    return provider === "codex" ? catalog.codex : catalog.opencode;
  }

  function isFavorite(provider: ModelProvider, id: string) {
    return favoriteKeys.has(modelKey(provider, id));
  }

  function selectModel(field: "orchestratorModel" | "workerModel" | "ideaModel", provider: ModelProvider, model: string) {
    if (field === "orchestratorModel") draft.orchestratorProvider = provider;
    if (field === "ideaModel") draft.ideaProvider = provider;
    draft[field] = model;
  }

  function optionLabel(provider: ModelProvider, model: string) {
    return `${provider === "codex" ? "Codex" : "OpenCode"} / ${model}`;
  }
</script>

<section class="panel">
  <h2>Run configuration</h2>
  <div class="grid">
    <div class="field">
      <span>Orchestrator model</span>
      <select value={modelKey(draft.orchestratorProvider, draft.orchestratorModel)} onchange={(event) => {
        const [provider, model] = (event.currentTarget as HTMLSelectElement).value.split(":");
        selectModel("orchestratorModel", provider as ModelProvider, model);
      }}>
        {@render ModelOptions(catalog, favoriteOptions, true)}
      </select>
    </div>
    <div class="field">
      <span>Worker model</span>
      <select bind:value={draft.workerModel}>
        {#each favoriteOptions.filter((model) => model.provider === "opencode") as favorite}
          <option value={favorite.id}>Favorite / {favorite.id}</option>
        {/each}
        <optgroup label="OpenCode">
          {#each catalog.opencode as model}<option value={model}>{model}</option>{/each}
        </optgroup>
      </select>
      <small>Researchers stay on OpenCode for now.</small>
    </div>
    <div class="field">
      <span>Idea model</span>
      <select value={modelKey(draft.ideaProvider, draft.ideaModel)} onchange={(event) => {
        const [provider, model] = (event.currentTarget as HTMLSelectElement).value.split(":");
        selectModel("ideaModel", provider as ModelProvider, model);
      }}>
        {@render ModelOptions(catalog, favoriteOptions, true)}
      </select>
    </div>
    <label>
      <span>Ideas requested</span>
      <input type="number" min="1" max="200" bind:value={draft.ideasRequested} />
    </label>
    <label>
      <span>Batch size</span>
      <input type="number" min="1" max="20" bind:value={draft.batchSize} />
    </label>
    <label>
      <span>Max follow-up rounds</span>
      <input type="number" min="0" max="5" bind:value={draft.maxFollowUpRounds} />
    </label>
    <label>
      <span>Search results / stream</span>
      <input type="number" min="1" max="20" bind:value={draft.searchResultsPerStream} />
    </label>
    <label>
      <span>Parallelism</span>
      <input type="number" min="1" max="6" bind:value={draft.parallelism} />
    </label>
    <label>
      <span>Max spend (USD)</span>
      <input type="number" min="0" step="0.1" bind:value={draft.maxSpendUsd} />
    </label>
    <label class="check">
      <input type="checkbox" bind:checked={draft.autoPublishPlans} />
      <span>Auto-publish plans when available</span>
    </label>
  </div>

  <div class="models">
    <div class="models-head">
      <h3>Models</h3>
      <p class="sub">Star the ones you use — favorites appear first in the pickers above.</p>
    </div>

    <div class="fav-bar">
      {#if favoriteOptions.length}
        {#each favoriteOptions as model (modelKey(model.provider, model.id))}
          <span class="chip">
            <span class="chip-star">★</span>
            <span class="chip-name">{optionLabel(model.provider, model.id)}</span>
            <button
              class="chip-x"
              aria-label={`Remove ${model.id} from favorites`}
              title="Remove favorite"
              onclick={() => onFavorite(model, false)}
            >✕</button>
          </span>
        {/each}
      {:else}
        <span class="fav-empty">No favorites yet — star a model below or add your own.</span>
      {/if}
    </div>

    <div class="model-tools">
      <input class="search" bind:value={modelSearch} placeholder="Search models…" aria-label="Search models" />
      <div class="custom-model">
        <select bind:value={customProvider} aria-label="Custom model provider">
          <option value="codex">Codex</option>
          <option value="opencode">OpenCode</option>
        </select>
        <input bind:value={customModel} placeholder="Add your own, e.g. gpt-5.5" />
        <button
          class="ghost"
          onclick={() => {
            const id = customModel.trim();
            if (!id) return;
            onFavorite({ provider: customProvider, id }, true);
            customModel = "";
          }}
        >Add</button>
      </div>
    </div>

    {#if codexMatches.length}
      <p class="prov-label">Codex</p>
      <div class="pill-wrap">
        {#each codexMatches as model (model)}
          {@render ModelPill("codex", model)}
        {/each}
      </div>
    {/if}
    {#if opencodeMatches.length}
      <p class="prov-label">OpenCode</p>
      <div class="pill-wrap">
        {#each opencodeMatches as model (model)}
          {@render ModelPill("opencode", model)}
        {/each}
      </div>
    {/if}
    {#if !codexMatches.length && !opencodeMatches.length}
      <p class="no-match">No models match “{modelSearch}”.</p>
    {/if}
  </div>

  {#if !embedded}
    <div class="actions">
      <button class="primary" onclick={() => onSave?.(draft)}>Save configuration</button>
      <input placeholder="Preset name" bind:value={presetName} />
      <button class="ghost" onclick={() => presetName && onSave?.(draft, presetName)}>Save preset</button>
      {#if presets.length}
        <select onchange={(event) => applyPreset((event.currentTarget as HTMLSelectElement).value)}>
          <option value="">Load preset…</option>
          {#each presets as preset}<option value={preset.name}>{preset.name}</option>{/each}
        </select>
      {/if}
    </div>
  {/if}
</section>

{#snippet ModelOptions(catalog: ModelCatalog, favorites: ModelRef[], allowCodex: boolean)}
  {#if favorites.length}
    <optgroup label="All favorites">
      {#each favorites as favorite}
        <option value={modelKey(favorite.provider, favorite.id)}>{optionLabel(favorite.provider, favorite.id)}</option>
      {/each}
    </optgroup>
  {/if}
  {#if allowCodex && catalog.codex.length}
    <optgroup label="Codex">
      {#each catalog.codex as model}<option value={modelKey("codex", model)}>{model}</option>{/each}
    </optgroup>
  {/if}
  <optgroup label="OpenCode">
    {#each catalog.opencode as model}<option value={modelKey("opencode", model)}>{model}</option>{/each}
  </optgroup>
{/snippet}

{#snippet ModelPill(provider: ModelProvider, model: string)}
  {@const favorite = isFavorite(provider, model)}
  <button
    class="pill"
    class:fav={favorite}
    title={favorite ? "Remove from favorites" : "Add to favorites"}
    aria-label={favorite ? `Remove ${model} from favorites` : `Add ${model} to favorites`}
    aria-pressed={favorite}
    onclick={() => onFavorite({ provider, id: model }, !favorite)}
  >
    <span class="pill-star">{favorite ? "★" : "☆"}</span>
    <span class="pill-name">{model}</span>
  </button>
{/snippet}

<style>
  .panel {
    margin: 0 20px 12px;
    padding: 16px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
  }

  h2 {
    margin: 0 0 12px;
    font-size: 14px;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }

  label,
  .field {
    display: grid;
    gap: 6px;
    font-size: 12px;
    color: var(--muted);
  }

  small {
    color: var(--muted);
  }

  .check {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  input,
  select {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    padding: 8px 10px;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
  }

  .models {
    margin-top: 16px;
    display: grid;
    gap: 10px;
  }

  h3 {
    margin: 0;
    font-size: 13px;
    color: var(--text);
  }

  .models-head .sub {
    margin: 2px 0 0;
    font-size: 12px;
    color: var(--muted);
  }

  .fav-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    min-height: 30px;
    align-items: center;
    padding: 8px;
    border: 1px dashed var(--border);
    border-radius: 10px;
    background: color-mix(in srgb, var(--accent) 6%, var(--bg));
  }

  .fav-empty {
    color: var(--muted);
    font-size: 12px;
    padding: 0 2px;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px 4px 10px;
    border-radius: 999px;
    font-size: 12px;
    border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border));
    background: color-mix(in srgb, var(--accent) 20%, var(--surface));
    color: var(--text);
  }

  .chip-star {
    color: var(--accent-strong);
  }

  .chip-x {
    border: none;
    background: transparent;
    color: var(--muted);
    padding: 2px 4px;
    font-size: 11px;
    line-height: 1;
    border-radius: 999px;
  }

  .chip-x:hover {
    color: var(--danger);
    background: color-mix(in srgb, var(--danger) 18%, transparent);
  }

  .model-tools {
    display: grid;
    grid-template-columns: minmax(160px, 1fr) minmax(0, 2fr);
    gap: 8px;
  }

  .search {
    width: 100%;
  }

  .custom-model {
    display: grid;
    grid-template-columns: 120px minmax(0, 1fr) auto;
    gap: 8px;
  }

  .prov-label {
    margin: 4px 0 0;
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .pill-wrap {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text);
    font-size: 12px;
    transition: border-color 120ms ease, background 120ms ease;
  }

  .pill:hover {
    border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  }

  .pill-star {
    color: var(--muted);
    font-size: 13px;
  }

  .pill.fav {
    border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
    background: color-mix(in srgb, var(--accent) 16%, var(--surface));
  }

  .pill.fav .pill-star {
    color: var(--accent-strong);
  }

  .no-match {
    color: var(--muted);
    font-size: 12px;
    margin: 2px 0;
  }

  button,
  select,
  input {
    border-radius: 8px;
  }

  button {
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text);
    padding: 8px 12px;
  }

  button.primary {
    background: color-mix(in srgb, var(--accent) 24%, var(--surface));
  }

  button.ghost {
    background: transparent;
  }

  @media (max-width: 980px) {
    .model-groups,
    .grid {
      grid-template-columns: 1fr;
    }
  }
</style>
