<script lang="ts">
  import { untrack } from "svelte";
  import {
    RunConfigSchema,
    type ModelCatalog,
    type ModelProvider,
    type ModelRef,
    type RunConfig,
  } from "../../shared/schemas";

  let {
    models,
    modelCatalog,
    config,
    presets,
    onSave,
    onStart,
    onFavorite,
    starting = false,
    setupOnly = false,
    embedded = false,
  }: {
    models: string[];
    modelCatalog?: ModelCatalog | undefined;
    config: RunConfig;
    presets: Array<{ name: string; config: RunConfig }>;
    onSave?: (config: RunConfig, presetName?: string) => void;
    onStart?: (config: RunConfig) => void;
    onFavorite: (model: ModelRef, favorite: boolean) => void;
    starting?: boolean;
    setupOnly?: boolean;
    embedded?: boolean;
  } = $props();

  let draft = $state<RunConfig>({ ...untrack(() => config) });
  let presetName = $state("");
  let customProvider: ModelProvider = $state("codex");
  let customModel = $state("");
  let modelSearch = $state("");
  let modelListOpen = $state(false);

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
  const parsedConfig = $derived(RunConfigSchema.safeParse({ ...draft }));
  const validationMessage = $derived(
    parsedConfig.success ? null : parsedConfig.error.issues[0]?.message ?? "Review the research limits.",
  );

  function modelKey(provider: ModelProvider, id: string) {
    return `${provider}:${id}`;
  }

  function parseModelKey(value: string): { provider: ModelProvider; model: string } {
    const separator = value.indexOf(":");
    if (separator <= 0 || separator === value.length - 1) throw new Error("Invalid model selection");
    return {
      provider: value.slice(0, separator) as ModelProvider,
      model: value.slice(separator + 1),
    };
  }

  function isFavorite(provider: ModelProvider, id: string) {
    return favoriteKeys.has(modelKey(provider, id));
  }

  function selectModel(field: "orchestratorModel" | "workerModel" | "ideaModel", provider: ModelProvider, model: string) {
    if (field === "orchestratorModel") draft.orchestratorProvider = provider;
    if (field === "workerModel") draft.workerProvider = provider;
    if (field === "ideaModel") draft.ideaProvider = provider;
    draft[field] = model;
  }

  function optionLabel(provider: ModelProvider, model: string) {
    return `${provider === "codex" ? "Codex" : "OpenCode"} / ${model}`;
  }

  function saveConfig(name?: string) {
    const parsed = RunConfigSchema.safeParse({ ...draft });
    if (parsed.success) onSave?.(parsed.data, name);
  }

  function startResearch() {
    const parsed = RunConfigSchema.safeParse({ ...draft });
    if (parsed.success) onStart?.(parsed.data);
  }
</script>

<section class="panel" class:setup-only={setupOnly} class:embedded>
  {#if !embedded}
    <header class="panel-head">
      <p class="eyebrow">Research engine</p>
      <h2>Models & research limits</h2>
      <p>Choose who plans, researches, and generates ideas. Set hard limits before anything runs.</p>
    </header>
  {/if}
  <div class="grid">
    <div class="field">
      <span>Orchestrator model</span>
      <select value={modelKey(draft.orchestratorProvider, draft.orchestratorModel)} onchange={(event) => {
        const { provider, model } = parseModelKey((event.currentTarget as HTMLSelectElement).value);
        selectModel("orchestratorModel", provider, model);
      }}>
        {@render ModelOptions(catalog, favoriteOptions)}
      </select>
    </div>
    <div class="field">
      <span>Worker model</span>
      <select value={modelKey(draft.workerProvider, draft.workerModel)} onchange={(event) => {
        const { provider, model } = parseModelKey((event.currentTarget as HTMLSelectElement).value);
        selectModel("workerModel", provider, model);
      }}>
        {@render ModelOptions(catalog, favoriteOptions)}
      </select>
      <small>Used by each parallel research stream.</small>
    </div>
    <div class="field">
      <span>Idea model</span>
      <select value={modelKey(draft.ideaProvider, draft.ideaModel)} onchange={(event) => {
        const { provider, model } = parseModelKey((event.currentTarget as HTMLSelectElement).value);
        selectModel("ideaModel", provider, model);
      }}>
        {@render ModelOptions(catalog, favoriteOptions)}
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
      <span>Page character limit</span>
      <input type="number" min="500" max="20000" step="100" bind:value={draft.pageCharLimit} />
      <small>Maximum retrieved text processed per page.</small>
    </label>
    <label>
      <span>Parallelism</span>
      <input type="number" min="1" max="6" bind:value={draft.parallelism} />
    </label>
    <label>
      <span>Max spend (USD)</span>
      <input type="number" min="0" max="100" step="0.1" bind:value={draft.maxSpendUsd} />
    </label>
    <label>
      <span>Max Codex calls</span>
      <input type="number" min="1" max="500" bind:value={draft.maxCodexCalls} />
    </label>
    <label>
      <span>Max Exa searches</span>
      <input type="number" min="1" max="100" bind:value={draft.maxExaSearches} />
    </label>
    <label>
      <span>Runtime limit (minutes)</span>
      <input type="number" min="1" max="240" bind:value={draft.maxRunMinutes} />
    </label>
  </div>

  <details class="model-library">
    <summary>
      <span><strong>Model library</strong><small>{favoriteOptions.length} starred · {availableCount} available</small></span>
      <span class="summary-mark" aria-hidden="true"></span>
    </summary>
    <div class="models">

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
  </details>

  {#if validationMessage}
    <p class="config-error" role="alert">{validationMessage}</p>
  {/if}

  {#if !setupOnly}<div class="approval" aria-label="Research approval summary">
    <div>
      <strong>Execution caps</strong>
      <p>6 fixed streams · up to ${Number(draft.maxSpendUsd || 0).toFixed(2)} · {draft.maxRunMinutes} min · {draft.ideasRequested} ideas</p>
    </div>
    <button class="primary" onclick={startResearch} disabled={starting || Boolean(validationMessage)}>
      {starting ? "Starting research…" : "Start research"}
    </button>
  </div>{/if}

  {#if onSave}<div class="actions">
      <button class="ghost" disabled={Boolean(validationMessage)} onclick={() => saveConfig()}>{setupOnly ? "Save settings" : "Save configuration"}</button>
      <input placeholder="Preset name" bind:value={presetName} />
      <button class="ghost" disabled={!presetName.trim() || Boolean(validationMessage)} onclick={() => presetName && saveConfig(presetName)}>Save preset</button>
      {#if presets.length}
        <select onchange={(event) => applyPreset((event.currentTarget as HTMLSelectElement).value)}>
          <option value="">Load preset…</option>
          {#each presets as preset}<option value={preset.name}>{preset.name}</option>{/each}
        </select>
      {/if}
    </div>
  {/if}
</section>

{#snippet ModelOptions(catalog: ModelCatalog, favorites: ModelRef[])}
  {#if favorites.length}
    <optgroup label="All favorites">
      {#each favorites as favorite}
        <option value={modelKey(favorite.provider, favorite.id)}>{optionLabel(favorite.provider, favorite.id)}</option>
      {/each}
    </optgroup>
  {/if}
  {#if catalog.codex.length}
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
    height: 100%;
    overflow-y: auto;
    margin: 0;
    padding: 28px clamp(24px, 4vw, 52px) 32px;
    border: 0;
    border-radius: 0;
    background: transparent;
  }

  .panel.embedded {
    height: auto;
    overflow: visible;
    padding: 4px 0 22px;
  }

  .panel > * {
    width: min(100%, 1040px);
  }

  .panel-head {
    margin-bottom: 24px;
  }

  .panel-head .eyebrow {
    margin: 0 0 8px;
    color: var(--accent);
    font-family: var(--mono);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  h2 {
    margin: 0 0 8px;
    font-size: clamp(22px, 2.4vw, 30px);
    font-weight: 650;
    letter-spacing: -0.04em;
    line-height: 1.1;
  }

  .panel-head > p:last-child {
    max-width: 65ch;
    margin: 0;
    color: var(--muted);
    font-size: 13px;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 16px;
    padding-bottom: 24px;
    border-bottom: 1px solid var(--border);
  }

  label,
  .field {
    display: grid;
    gap: 8px;
    font-size: 12px;
    color: var(--text);
  }

  small {
    color: var(--muted);
  }

  input,
  select {
    min-height: 40px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 9px;
    color: var(--text);
    padding: 9px 11px;
    transition: border-color 180ms var(--ease), background 180ms var(--ease), box-shadow 180ms var(--ease);
  }

  input:hover,
  select:hover {
    border-color: var(--border-strong);
  }

  input:focus,
  select:focus {
    outline: none;
    border-color: color-mix(in srgb, var(--accent) 68%, var(--border));
    background: var(--surface-2);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 20px;
    padding-top: 18px;
    border-top: 1px solid var(--border);
  }

  .config-error {
    margin: 16px 0 0;
    padding: 10px 12px;
    border: 1px solid color-mix(in srgb, var(--danger) 45%, var(--border));
    border-radius: 8px;
    background: color-mix(in srgb, var(--danger) 8%, var(--surface));
    color: var(--danger);
    font-size: 11px;
  }

  .setup-only .actions {
    position: sticky;
    bottom: 0;
    z-index: 1;
    padding: 16px 0 20px;
    background: color-mix(in srgb, var(--bg) 92%, transparent);
    backdrop-filter: blur(12px);
  }

  .approval {
    margin-top: 16px;
    padding: 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border));
    border-radius: 10px;
    background: color-mix(in srgb, var(--accent) 10%, var(--bg));
  }

  .approval p {
    margin: 4px 0 0;
    color: var(--muted);
    font-size: 12px;
  }

  .models {
    margin-top: 0;
    display: grid;
    gap: 12px;
    padding-top: 0;
    border-top: 0;
  }

  .model-library {
    margin-top: 20px;
    border: 1px solid var(--border);
    border-radius: 11px;
    background: color-mix(in srgb, var(--surface) 70%, transparent);
  }

  .model-library > summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 13px 14px;
    cursor: pointer;
    list-style: none;
  }

  .model-library > summary::-webkit-details-marker {
    display: none;
  }

  .model-library > summary > span:first-child {
    display: grid;
    gap: 2px;
  }

  .model-library > summary strong {
    font-size: 13px;
  }

  .model-library > summary small {
    font-size: 11px;
  }

  .summary-mark {
    width: 8px;
    height: 8px;
    border-right: 1px solid var(--muted);
    border-bottom: 1px solid var(--muted);
    transform: rotate(45deg);
    transition: transform 180ms var(--ease);
  }

  .model-library[open] .summary-mark {
    transform: rotate(-135deg);
  }

  .model-library .models {
    padding: 14px;
    border-top: 1px solid var(--border);
  }

  .starred-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    min-height: 44px;
    align-items: center;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
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
    border-color: var(--accent-strong);
    background: var(--accent-strong);
    color: var(--accent-ink);
    font-weight: 700;
  }

  button.ghost {
    background: transparent;
  }

  @media (max-width: 980px) {
    .grid,
    .model-tools,
    .custom-row {
      grid-template-columns: repeat(2, minmax(0, 1fr));
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
      padding: 24px 16px;
    }

    .panel.embedded {
      padding: 4px 0 20px;
    }

    .grid,
    .model-tools,
    .custom-row {
      grid-template-columns: 1fr;
    }

    .starred-chip {
      max-width: 100%;
    }
  }
</style>
