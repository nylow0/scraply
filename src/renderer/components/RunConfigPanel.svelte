<script lang="ts">
  import type { RunConfig } from "../../shared/schemas";

  let {
    models,
    config,
    presets,
    onSave,
  }: {
    models: string[];
    config: RunConfig;
    presets: Array<{ name: string; config: RunConfig }>;
    onSave: (config: RunConfig, presetName?: string) => void;
  } = $props();

  let draft = $state({ ...config });
  let presetName = $state("");

  $effect(() => {
    draft = { ...config };
  });

  function applyPreset(name: string) {
    const preset = presets.find((item) => item.name === name);
    if (preset) draft = { ...preset.config };
  }
</script>

<section class="panel">
  <h2>Run configuration</h2>
  <div class="grid">
    <label>
      <span>Orchestrator model</span>
      <select bind:value={draft.orchestratorModel}>
        {#each models as model}<option value={model}>{model}</option>{/each}
      </select>
    </label>
    <label>
      <span>Worker model</span>
      <select bind:value={draft.workerModel}>
        {#each models as model}<option value={model}>{model}</option>{/each}
      </select>
    </label>
    <label>
      <span>Idea model</span>
      <select bind:value={draft.ideaModel}>
        {#each models as model}<option value={model}>{model}</option>{/each}
      </select>
    </label>
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

  label {
    display: grid;
    gap: 6px;
    font-size: 12px;
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
</style>
