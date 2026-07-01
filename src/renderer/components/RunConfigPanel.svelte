<script lang="ts">
  import type { ModelCatalog, ModelProvider, ModelRef, RunConfig } from "../../shared/schemas";

  let {
    models,
    modelCatalog,
    config,
    presets,
    onSave,
    onFavorite,
  }: {
    models: string[];
    modelCatalog?: ModelCatalog;
    config: RunConfig;
    presets: Array<{ name: string; config: RunConfig }>;
    onSave: (config: RunConfig, presetName?: string) => void;
    onFavorite: (model: ModelRef, favorite: boolean) => void;
  } = $props();

  let draft = $state({ ...config });
  let presetName = $state("");
  let customProvider: ModelProvider = $state("codex");
  let customModel = $state("");

  $effect(() => {
    draft = { ...config };
  });

  function applyPreset(name: string) {
    const preset = presets.find((item) => item.name === name);
    if (preset) draft = { ...preset.config };
  }

  const catalog = $derived(modelCatalog ?? { opencode: models, codex: [], favorites: [] });
  const favoriteKeys = $derived(new Set(catalog.favorites.map((model) => modelKey(model.provider, model.id))));
  const favoriteOptions = $derived(catalog.favorites);

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
    <h3>Favorite models</h3>
    <div class="custom-model">
      <select bind:value={customProvider} aria-label="Custom model provider">
        <option value="codex">Codex</option>
        <option value="opencode">OpenCode</option>
      </select>
      <input bind:value={customModel} placeholder="Add custom model, e.g. gpt-5.5" />
      <button
        class="ghost"
        onclick={() => {
          const id = customModel.trim();
          if (!id) return;
          onFavorite({ provider: customProvider, id }, true);
          customModel = "";
        }}
      >Add favorite</button>
    </div>
    <div class="model-groups">
      {#if favoriteOptions.length}
        <div class="model-group favorites">
          <h4>All favorites</h4>
          {#each favoriteOptions as model}
            {@render ModelRow(model.provider, model.id, true, onFavorite)}
          {/each}
        </div>
      {/if}
      <div class="model-group">
        <h4>Codex</h4>
        {#each catalog.codex as model}
          {@render ModelRow("codex", model, isFavorite("codex", model), onFavorite)}
        {/each}
      </div>
      <div class="model-group">
        <h4>OpenCode</h4>
        {#each catalog.opencode as model}
          {@render ModelRow("opencode", model, isFavorite("opencode", model), onFavorite)}
        {/each}
      </div>
    </div>
  </div>

  <div class="actions">
    <button class="primary" onclick={() => onSave(draft)}>Save configuration</button>
    <input placeholder="Preset name" bind:value={presetName} />
    <button class="ghost" onclick={() => presetName && onSave(draft, presetName)}>Save preset</button>
    {#if presets.length}
      <select onchange={(event) => applyPreset((event.currentTarget as HTMLSelectElement).value)}>
        <option value="">Load preset…</option>
        {#each presets as preset}<option value={preset.name}>{preset.name}</option>{/each}
      </select>
    {/if}
  </div>
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

{#snippet ModelRow(provider: ModelProvider, model: string, favorite: boolean, onFavorite: (model: ModelRef, favorite: boolean) => void)}
  <div class="model-row">
    <span>{model}</span>
    <button
      class:active={favorite}
      title={favorite ? "Remove from favorites" : "Add to favorites"}
      aria-label={favorite ? `Remove ${model} from favorites` : `Add ${model} to favorites`}
      onclick={() => onFavorite({ provider, id: model }, !favorite)}
    >{favorite ? "Favorited" : "Favorite"}</button>
  </div>
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
    margin-top: 14px;
  }

  h3,
  h4 {
    margin: 0;
    font-size: 12px;
  }

  h3 {
    margin-bottom: 8px;
    color: var(--text);
  }

  h4 {
    color: var(--muted);
  }

  .model-groups {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
  }

  .custom-model {
    display: grid;
    grid-template-columns: 140px minmax(0, 1fr) auto;
    gap: 8px;
    margin-bottom: 10px;
  }

  .model-group {
    display: grid;
    align-content: start;
    gap: 6px;
    min-width: 0;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px;
    background: var(--bg);
  }

  .model-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px;
    font-size: 12px;
  }

  .model-row span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .model-row button {
    padding: 5px 8px;
    font-size: 11px;
  }

  .model-row button.active {
    border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
    background: color-mix(in srgb, var(--accent) 18%, var(--surface));
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
