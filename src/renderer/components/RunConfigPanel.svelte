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
  let modelListOpen = $state(false);

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
  const catalogModels = $derived([
    ...catalog.codex.map((id): ModelRef => ({ provider: "codex", id })),
    ...catalog.opencode.map((id): ModelRef => ({ provider: "opencode", id })),
  ]);
  const availableModels = $derived(catalogModels.filter((model) => !isFavorite(model.provider, model.id)));
  const search = $derived(modelSearch.trim().toLowerCase());
  const filteredModels = $derived(availableModels.filter((model) => `${model.provider} ${model.id}`.toLowerCase().includes(search)));
  const codexMatches = $derived(filteredModels.filter((model) => model.provider === "codex"));
  const opencodeMatches = $derived(filteredModels.filter((model) => model.provider === "opencode"));
  const availableCount = $derived(availableModels.length);

  function modelKey(provider: ModelProvider, id: string) {
    return `${provider}:${id}`;
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
      <div>
        <h3>Models</h3>
        <p class="sub">{favoriteOptions.length} starred / {availableCount} in list</p>
      </div>
    </div>

    <div class="starred-strip" aria-label="Starred models">
      {#if favoriteOptions.length}
        {#each favoriteOptions as model (modelKey(model.provider, model.id))}
          <span class="starred-chip">
            <span class="provider-tag">{model.provider === "codex" ? "Codex" : "OpenCode"}</span>
            <span class="chip-name">{model.id}</span>
            <button
              type="button"
              class="starred-remove"
              aria-label={`Remove ${model.id} from favorites`}
              title="Remove favorite"
              onclick={() => onFavorite(model, false)}
            ><span class="remove-mark" aria-hidden="true"></span></button>
          </span>
        {/each}
      {:else}
        <span class="starred-empty">No starred models yet.</span>
      {/if}
    </div>

    <div class="model-tools">
      <label class="search-field">
        <span>Search</span>
        <input class="search" bind:value={modelSearch} placeholder="Search models..." aria-label="Search models" />
      </label>
      <div class="custom-model">
        <span class="tool-label">Custom model</span>
        <div class="custom-row">
          <select bind:value={customProvider} aria-label="Custom model provider">
            <option value="codex">Codex</option>
            <option value="opencode">OpenCode</option>
          </select>
          <input bind:value={customModel} placeholder="Add your own, e.g. gpt-5.5" />
          <button
            type="button"
            class="ghost add-button"
            onclick={() => {
              const id = customModel.trim();
              if (!id) return;
              onFavorite({ provider: customProvider, id }, true);
              customModel = "";
            }}
          >Add</button>
        </div>
      </div>
    </div>

    <div class="model-dropdown">
      <button
        type="button"
        class="dropdown-trigger"
        aria-expanded={modelListOpen}
        aria-controls="unstarred-model-list"
        onclick={() => (modelListOpen = !modelListOpen)}
      >
        <span>
          <strong>All other models</strong>
          <small>{filteredModels.length} shown</small>
        </span>
        <span class="chevron" class:open={modelListOpen} aria-hidden="true"></span>
      </button>

      {#if modelListOpen}
        <div class="dropdown-panel" id="unstarred-model-list">
          {#if codexMatches.length}
            <div class="dropdown-group">
              <p class="prov-label">Codex</p>
              {#each codexMatches as model (modelKey(model.provider, model.id))}
                {@render ModelRow(model)}
              {/each}
            </div>
          {/if}
          {#if opencodeMatches.length}
            <div class="dropdown-group">
              <p class="prov-label">OpenCode</p>
              {#each opencodeMatches as model (modelKey(model.provider, model.id))}
                {@render ModelRow(model)}
              {/each}
            </div>
          {/if}
          {#if !codexMatches.length && !opencodeMatches.length}
            {#if search}
              <p class="no-match">No models match "{modelSearch}".</p>
            {:else}
              <p class="no-match">No unstarred models left.</p>
            {/if}
          {/if}
        </div>
      {/if}
    </div>
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

{#snippet ModelRow(model: ModelRef)}
  <button
    type="button"
    class="model-row"
    title="Add to starred models"
    aria-label={`Add ${model.id} to starred models`}
    onclick={() => onFavorite(model, true)}
  >
    <span class="model-provider">{model.provider === "codex" ? "Codex" : "OpenCode"}</span>
    <span class="model-name">{model.id}</span>
    <span class="model-action">Star</span>
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
    gap: 12px;
    padding-top: 14px;
    border-top: 1px solid var(--border);
  }

  .models-head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 12px;
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

  .starred-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    min-height: 44px;
    align-items: center;
    padding: 10px;
    border: 1px solid color-mix(in srgb, var(--accent) 24%, var(--border));
    border-radius: 10px;
    background: color-mix(in srgb, var(--accent) 8%, var(--bg));
  }

  .starred-empty {
    color: var(--muted);
    font-size: 12px;
    padding: 0 2px;
  }

  .starred-chip {
    display: inline-flex;
    align-items: center;
    max-width: 260px;
    min-width: 0;
    gap: 8px;
    padding: 5px 6px 5px 8px;
    border-radius: 999px;
    font-size: 12px;
    border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border));
    background: color-mix(in srgb, var(--accent) 16%, var(--surface));
    color: var(--text);
  }

  .provider-tag {
    flex: 0 0 auto;
    border-radius: 999px;
    padding: 2px 6px;
    background: color-mix(in srgb, var(--accent) 16%, var(--bg));
    color: var(--accent-strong);
    font-size: 10px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .chip-name,
  .model-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chip-name {
    flex: 1 1 auto;
  }

  .starred-remove {
    flex: 0 0 auto;
    border: none;
    background: transparent;
    color: var(--muted);
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    padding: 0;
    line-height: 1;
    border-radius: 999px;
  }

  .remove-mark {
    position: relative;
    width: 9px;
    height: 9px;
  }

  .remove-mark::before,
  .remove-mark::after {
    content: "";
    position: absolute;
    top: 4px;
    left: 0;
    width: 9px;
    height: 1px;
    border-radius: 999px;
    background: currentColor;
  }

  .remove-mark::before {
    transform: rotate(45deg);
  }

  .remove-mark::after {
    transform: rotate(-45deg);
  }

  .starred-remove:hover {
    color: var(--danger);
    background: color-mix(in srgb, var(--danger) 18%, transparent);
  }

  .model-tools {
    display: grid;
    grid-template-columns: minmax(220px, 0.8fr) minmax(360px, 1.2fr);
    align-items: end;
    gap: 10px;
  }

  .search {
    width: 100%;
  }

  .search-field,
  .custom-model {
    display: grid;
    gap: 6px;
  }

  .tool-label,
  .search-field span {
    font-size: 12px;
    color: var(--muted);
  }

  .custom-row {
    display: grid;
    grid-template-columns: 120px minmax(0, 1fr) auto;
    gap: 8px;
  }

  .add-button {
    white-space: nowrap;
  }

  .model-dropdown {
    display: grid;
    gap: 0;
  }

  .dropdown-trigger {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    text-align: left;
    padding: 10px 12px;
    background: color-mix(in srgb, var(--surface-2) 70%, var(--bg));
    transition: border-color 140ms ease, background 140ms ease, transform 140ms ease;
  }

  .dropdown-trigger:hover {
    border-color: color-mix(in srgb, var(--accent) 42%, var(--border));
    background: color-mix(in srgb, var(--accent) 8%, var(--surface-2));
  }

  .dropdown-trigger strong {
    display: block;
    font-size: 12px;
    font-weight: 600;
  }

  .dropdown-trigger small {
    display: block;
    margin-top: 2px;
    font-size: 11px;
  }

  .chevron {
    width: 8px;
    height: 8px;
    border-right: 1px solid var(--muted);
    border-bottom: 1px solid var(--muted);
    transform: rotate(45deg);
    transition: transform 140ms ease;
  }

  .chevron.open {
    transform: rotate(-135deg);
  }

  .dropdown-panel {
    display: grid;
    gap: 10px;
    max-height: 280px;
    overflow: auto;
    padding: 8px;
    border: 1px solid var(--border);
    border-top: 0;
    border-radius: 0 0 10px 10px;
    background: var(--bg);
  }

  .dropdown-group {
    display: grid;
    gap: 5px;
  }

  .prov-label {
    margin: 2px 4px;
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .model-row {
    width: 100%;
    display: grid;
    grid-template-columns: 92px minmax(0, 1fr) auto;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    text-align: left;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: color-mix(in srgb, var(--surface) 55%, var(--bg));
    color: var(--text);
    font-size: 12px;
    transition: border-color 140ms ease, background 140ms ease, transform 140ms ease;
  }

  .model-row:hover {
    border-color: color-mix(in srgb, var(--accent) 42%, var(--border));
    background: color-mix(in srgb, var(--accent) 7%, var(--surface));
  }

  .model-provider {
    color: var(--muted);
    font-size: 10px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .model-action {
    color: var(--accent-strong);
    font-size: 11px;
    font-weight: 600;
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

  button:focus-visible,
  input:focus-visible,
  select:focus-visible {
    outline: 2px solid var(--accent-strong);
    outline-offset: 2px;
  }

  button:active {
    transform: translateY(1px);
  }

  button.primary {
    background: color-mix(in srgb, var(--accent) 24%, var(--surface));
  }

  button.ghost {
    background: transparent;
  }

  @media (max-width: 980px) {
    .grid,
    .model-tools,
    .custom-row {
      grid-template-columns: 1fr;
    }

    .model-row {
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 4px 8px;
    }

    .model-provider {
      grid-column: 1 / -1;
    }
  }

  @media (max-width: 640px) {
    .panel {
      margin-inline: 12px;
    }

    .starred-chip {
      max-width: 100%;
    }
  }
</style>
