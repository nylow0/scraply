<script lang="ts">
  import { REQUIRED_INTAKE_QUESTIONS, OPTIONAL_INTAKE_QUESTIONS } from "../../shared/intake";
  import type { ModelCatalog, ModelRef, RunConfig } from "../../shared/schemas";
  import RunConfigPanel from "./RunConfigPanel.svelte";

  type IntakeAnswer = { questionId: string; answer: string; skipped: boolean };

  let {
    models,
    modelCatalog,
    config,
    presets,
    onFavorite,
    submitting,
    error,
    onLaunch,
  }: {
    models: string[];
    modelCatalog?: ModelCatalog;
    config: RunConfig;
    presets: Array<{ name: string; config: RunConfig }>;
    onFavorite: (model: ModelRef, favorite: boolean) => void;
    submitting: boolean;
    error: string | null;
    onLaunch: (answers: IntakeAnswer[], config: RunConfig) => void;
  } = $props();

  let values = $state<Record<string, string>>({});
  let runConfig = $state<RunConfig>({ ...config });

  const missingRequired = $derived(
    REQUIRED_INTAKE_QUESTIONS.filter((q) => !(values[q.id] ?? "").trim()).map((q) => q.id),
  );
  const canLaunch = $derived(missingRequired.length === 0 && !submitting);

  function launch() {
    if (!canLaunch) return;
    const answers: IntakeAnswer[] = [...REQUIRED_INTAKE_QUESTIONS, ...OPTIONAL_INTAKE_QUESTIONS].map((q) => {
      const value = (values[q.id] ?? "").trim();
      return value ? { questionId: q.id, answer: value, skipped: false } : { questionId: q.id, answer: "", skipped: true };
    });
    onLaunch(answers, runConfig);
  }
</script>

<section class="setup">
  <div class="head">
    <h2>New research</h2>
    <p>Fill in the questions and pick your models, then hit <strong>Start research</strong> — Scraply drafts the brief and launches the run in one go. Optional questions can be left blank.</p>
  </div>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  <div class="questions">
    <p class="group-label">Required</p>
    {#each REQUIRED_INTAKE_QUESTIONS as q (q.id)}
      <label class:missing={missingRequired.includes(q.id)}>
        <span>{q.prompt}</span>
        <textarea bind:value={values[q.id]} rows="2" disabled={submitting}></textarea>
      </label>
    {/each}

    <p class="group-label">Optional</p>
    {#each OPTIONAL_INTAKE_QUESTIONS as q (q.id)}
      <label>
        <span>{q.prompt}</span>
        <textarea bind:value={values[q.id]} rows="2" disabled={submitting} placeholder="Optional — leave blank to skip"></textarea>
      </label>
    {/each}
  </div>

  <div class="config">
    <p class="group-label">Models &amp; research settings</p>
    <RunConfigPanel
      {models}
      {modelCatalog}
      {config}
      presets={presets}
      onFavorite={onFavorite}
      embedded={true}
      onChange={(next) => (runConfig = next)}
    />
  </div>

  <div class="actions">
    {#if missingRequired.length > 0}
      <span class="hint">{missingRequired.length} required {missingRequired.length === 1 ? "question" : "questions"} left</span>
    {/if}
    <button class="primary" onclick={launch} disabled={!canLaunch}>
      {submitting ? "Working… drafting brief & launching" : "Start research"}
    </button>
  </div>
</section>

<style>
  .setup {
    min-height: 0;
    overflow-y: auto;
    padding: 20px;
    display: grid;
    gap: 16px;
    align-content: start;
  }

  .head h2 {
    margin: 0 0 6px;
    font-size: 16px;
  }

  .head p {
    margin: 0;
    color: var(--muted);
    font-size: 13px;
    max-width: 68ch;
  }

  .error {
    margin: 0;
    padding: 10px 12px;
    border: 1px solid color-mix(in srgb, var(--danger) 50%, var(--border));
    border-radius: 8px;
    background: color-mix(in srgb, var(--danger) 16%, var(--surface));
    color: var(--text);
    font-size: 13px;
  }

  .questions {
    display: grid;
    gap: 12px;
    max-width: 760px;
  }

  .group-label {
    margin: 8px 0 0;
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
  }

  label {
    display: grid;
    gap: 6px;
    font-size: 13px;
    color: var(--text);
  }

  label.missing textarea {
    border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
  }

  textarea {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    padding: 8px 10px;
    resize: vertical;
    font-family: var(--sans);
  }

  textarea:disabled {
    opacity: 0.6;
  }

  .config :global(.panel) {
    margin: 8px 0 0;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 12px;
    max-width: 760px;
  }

  .hint {
    color: var(--muted);
    font-size: 12px;
  }

  button.primary {
    margin-left: auto;
    border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border));
    background: color-mix(in srgb, var(--accent) 28%, var(--surface));
    color: var(--text);
    border-radius: 8px;
    padding: 10px 18px;
    font-weight: 600;
  }

  button.primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
