<script lang="ts">
  import { RESEARCH_STREAMS } from "../../research/streams";
  import type { ModelCatalog, ModelRef, ProjectBrief, RunConfig } from "../../shared/schemas";
  import RunConfigPanel from "./RunConfigPanel.svelte";

  let {
    brief,
    config,
    models,
    modelCatalog,
    presets,
    starting,
    onEditBrief,
    onSaveConfig,
    onFavorite,
    onStart,
  }: {
    brief: ProjectBrief;
    config: RunConfig;
    models: string[];
    modelCatalog?: ModelCatalog | undefined;
    presets: Array<{ name: string; config: RunConfig }>;
    starting: boolean;
    onEditBrief: () => void;
    onSaveConfig: (config: RunConfig, presetName?: string) => void;
    onFavorite: (model: ModelRef, favorite: boolean) => void;
    onStart: (config: RunConfig) => void;
  } = $props();

  const uncertaintyCount = $derived(
    brief.assumptions.length + brief.openQuestions.length + brief.contradictions.length,
  );

  function outputLabel(type: ProjectBrief["desiredOutput"]["type"]): string {
    return {
      options: "Options",
      "ranked-shortlist": "Ranked shortlist",
      "decision-memo": "Decision memo",
      "research-brief": "Research brief",
      comparison: "Comparison",
      other: "Other",
    }[type];
  }
</script>

<section class="run-review">
  <header class="review-head">
    <div>
      <p class="eyebrow">Review and run</p>
      <h2>Know what Scraply will execute</h2>
      <p>Review the brief, fixed research streams, models, and hard caps before starting an immutable run.</p>
    </div>
    <button class="edit-brief" type="button" disabled={starting} onclick={onEditBrief}>Edit brief</button>
  </header>

  <div class="overview">
    <div class="brief-summary">
      <section class="summary-section">
        <p class="section-label">Objective</p>
        <h3>{brief.title}</h3>
        <p class="primary-copy">{brief.objective}</p>
      </section>

      <section class="summary-section split">
        <div>
          <p class="section-label">Decision or exploratory intent</p>
          <p>{brief.decisionToSupport}</p>
        </div>
        <div>
          <p class="section-label">Output</p>
          <p><strong>{outputLabel(brief.desiredOutput.type)}</strong>{#if brief.desiredOutput.notes} · {brief.desiredOutput.notes}{/if}</p>
        </div>
      </section>

      <section class="summary-section split">
        <div>
          <p class="section-label">Success criteria</p>
          {#if brief.successCriteria.length}
            <ul>{#each brief.successCriteria as item}<li>{item}</li>{/each}</ul>
          {:else}
            <p class="not-provided">Not provided</p>
          {/if}
        </div>
        <div>
          <p class="section-label">Constraints and anti-goals</p>
          {#if brief.hardConstraints.length || brief.antiGoals.length}
            <ul>
              {#each brief.hardConstraints as item}<li>{item}</li>{/each}
              {#each brief.antiGoals as item}<li>{item}</li>{/each}
            </ul>
          {:else}
            <p class="not-provided">Not provided</p>
          {/if}
        </div>
      </section>

      <section class="summary-section split">
        <div>
          <p class="section-label">Evidence requirements</p>
          {#if brief.evidenceRequirements.length}
            <ul>{#each brief.evidenceRequirements as item}<li>{item}</li>{/each}</ul>
          {:else}
            <p class="not-provided">Not provided</p>
          {/if}
        </div>
        <div>
          <p class="section-label">Available resources</p>
          {#if brief.resources.length}
            <ul>{#each brief.resources as item}<li>{item}</li>{/each}</ul>
          {:else}
            <p class="not-provided">Not provided</p>
          {/if}
        </div>
      </section>

      <section class="summary-section uncertainty" aria-label="Unresolved brief details">
        <div class="uncertainty-head">
          <div>
            <p class="section-label">Uncertainty</p>
            <h3>{uncertaintyCount ? `${uncertaintyCount} unresolved ${uncertaintyCount === 1 ? "detail" : "details"}` : "No unresolved details"}</h3>
          </div>
          {#if uncertaintyCount}
            <span>Will be treated as assumptions</span>
          {/if}
        </div>
        {#if uncertaintyCount}
          <div class="uncertainty-grid">
            <div>
              <strong>Assumptions</strong>
              {#if brief.assumptions.length}
                <ul>{#each brief.assumptions as item}<li>{item}</li>{/each}</ul>
              {:else}<p class="not-provided">None recorded</p>{/if}
            </div>
            <div>
              <strong>Open questions</strong>
              {#if brief.openQuestions.length}
                <ul>{#each brief.openQuestions as item}<li>{item}</li>{/each}</ul>
              {:else}<p class="not-provided">None recorded</p>{/if}
            </div>
            {#if brief.contradictions.length}
              <div class="contradictions">
                <strong>Contradictions</strong>
                <ul>{#each brief.contradictions as item}<li>{item}</li>{/each}</ul>
              </div>
            {/if}
          </div>
        {/if}
      </section>
    </div>

    <aside class="execution-summary" aria-label="Saved research execution caps">
      <p class="section-label">Saved execution caps</p>
      <dl>
        <div><dt>Maximum spend</dt><dd>${config.maxSpendUsd.toFixed(2)}</dd></div>
        <div><dt>Runtime limit</dt><dd>{config.maxRunMinutes} min</dd></div>
        <div><dt>Codex calls</dt><dd>{config.maxCodexCalls}</dd></div>
        <div><dt>Exa searches</dt><dd>{config.maxExaSearches}</dd></div>
        <div><dt>Parallel workers</dt><dd>{config.parallelism}</dd></div>
      </dl>
      <p>These are upper limits, not cost or runtime estimates.</p>
    </aside>
  </div>

  <section class="streams" aria-labelledby="streams-heading">
    <header>
      <div>
        <p class="section-label">Research coverage</p>
        <h3 id="streams-heading">Six fixed streams</h3>
        <p>Every stream below runs in this version. They are visible for review and cannot be added, removed, or reordered.</p>
      </div>
      <span class="fixed-badge">Fixed for this version</span>
    </header>
    <ol>
      {#each RESEARCH_STREAMS as stream, index (stream.id)}
        <li>
          <span>{String(index + 1).padStart(2, "0")}</span>
          <div><strong>{stream.name}</strong><p>{stream.focus}</p></div>
        </li>
      {/each}
    </ol>
  </section>

  <details class="settings" open>
    <summary>
      <span>
        <strong>Models and advanced limits</strong>
        <small>{config.orchestratorModel} · {config.workerModel} · {config.ideaModel}</small>
      </span>
      <span class="summary-mark" aria-hidden="true"></span>
    </summary>
    <RunConfigPanel
      {models}
      {modelCatalog}
      {config}
      {presets}
      onSave={onSaveConfig}
      onStart={onStart}
      onFavorite={onFavorite}
      {starting}
      embedded
    />
  </details>
</section>

<style>
  .run-review {
    height: 100%;
    min-height: 0;
    overflow-y: auto;
    display: grid;
    align-content: start;
    gap: 30px;
    padding: 30px clamp(24px, 5vw, 64px) 40px;
  }

  .run-review > * {
    width: min(100%, 1100px);
  }

  .review-head {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: 32px;
  }

  .eyebrow,
  .section-label {
    margin: 0 0 7px;
    color: var(--accent);
    font-family: var(--mono);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.11em;
    text-transform: uppercase;
  }

  h2 {
    margin: 0 0 8px;
    font-size: clamp(25px, 3vw, 36px);
    font-weight: 650;
    letter-spacing: -0.045em;
    line-height: 1.05;
  }

  .review-head > div > p:last-child,
  .streams header p {
    max-width: 68ch;
    margin: 0;
    color: var(--muted);
    font-size: 12px;
  }

  button.edit-brief {
    flex: 0 0 auto;
    min-height: 39px;
    padding: 8px 13px;
    border: 1px solid var(--border);
    border-radius: 9px;
    background: transparent;
    color: var(--text);
    font-weight: 650;
  }

  button.edit-brief:hover:not(:disabled) {
    border-color: var(--border-strong);
    background: var(--surface-2);
  }

  .overview {
    display: grid;
    grid-template-columns: minmax(0, 1.7fr) minmax(220px, 0.65fr);
    gap: clamp(28px, 5vw, 62px);
    align-items: start;
  }

  .brief-summary {
    display: grid;
    border-top: 1px solid var(--border);
  }

  .summary-section {
    padding: 22px 0;
    border-bottom: 1px solid var(--border);
  }

  .summary-section h3,
  .streams h3 {
    margin: 0 0 7px;
    font-size: 15px;
    letter-spacing: -0.02em;
  }

  .summary-section p {
    margin: 0;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.55;
  }

  .summary-section .primary-copy {
    color: var(--text);
    font-size: 14px;
  }

  .split {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 30px;
  }

  ul {
    display: grid;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    color: var(--muted);
    font-size: 12px;
    line-height: 1.45;
  }

  .summary-section li {
    position: relative;
    padding-left: 12px;
  }

  .summary-section li::before {
    content: "";
    position: absolute;
    top: 0.65em;
    left: 0;
    width: 4px;
    height: 1px;
    background: var(--accent);
  }

  .not-provided {
    color: var(--subtle) !important;
    font-style: italic;
  }

  .uncertainty {
    padding-right: 16px;
    padding-left: 16px;
    border-left: 2px solid color-mix(in srgb, var(--accent) 58%, var(--border));
    background: color-mix(in srgb, var(--accent) 5%, transparent);
  }

  .uncertainty-head {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: 16px;
  }

  .uncertainty-head > span,
  .fixed-badge {
    flex: 0 0 auto;
    padding: 4px 7px;
    border: 1px solid color-mix(in srgb, var(--accent) 38%, var(--border));
    border-radius: 999px;
    color: var(--accent-strong);
    font-family: var(--mono);
    font-size: 9px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .uncertainty-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 20px;
    margin-top: 14px;
  }

  .uncertainty-grid strong {
    display: block;
    margin-bottom: 7px;
    font-size: 11px;
  }

  .contradictions {
    grid-column: 1 / -1;
  }

  .execution-summary {
    position: sticky;
    top: 0;
    padding-left: 24px;
    border-left: 1px solid var(--border);
  }

  dl {
    display: grid;
    margin: 0;
  }

  dl div {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 14px;
    padding: 11px 0;
    border-bottom: 1px solid var(--border);
  }

  dt {
    color: var(--muted);
    font-size: 11px;
  }

  dd {
    margin: 0;
    color: var(--text);
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 650;
  }

  .execution-summary > p:last-child {
    margin: 12px 0 0;
    color: var(--subtle);
    font-size: 10px;
    line-height: 1.5;
  }

  .streams {
    padding-top: 26px;
    border-top: 1px solid var(--border);
  }

  .streams > header {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: 24px;
    margin-bottom: 18px;
  }

  .streams ol {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    margin: 0;
    padding: 0;
    border-top: 1px solid var(--border);
    list-style: none;
  }

  .streams li {
    display: grid;
    grid-template-columns: 28px minmax(0, 1fr);
    gap: 10px;
    min-height: 90px;
    padding: 16px 18px 16px 0;
    border-bottom: 1px solid var(--border);
  }

  .streams li:nth-child(odd) {
    padding-right: 28px;
    border-right: 1px solid var(--border);
  }

  .streams li:nth-child(even) {
    padding-left: 28px;
  }

  .streams li > span {
    padding-top: 2px;
    color: var(--subtle);
    font-family: var(--mono);
    font-size: 9px;
  }

  .streams li strong {
    color: var(--text);
    font-size: 12px;
  }

  .streams li p {
    margin: 5px 0 0;
    color: var(--muted);
    font-size: 11px;
    line-height: 1.5;
  }

  .settings {
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
  }

  .settings > summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 17px 0;
    cursor: pointer;
    list-style: none;
  }

  .settings > summary::-webkit-details-marker {
    display: none;
  }

  .settings > summary > span:first-child {
    display: grid;
    gap: 3px;
  }

  .settings > summary strong {
    font-size: 13px;
  }

  .settings > summary small {
    color: var(--muted);
    font-size: 10px;
  }

  .summary-mark {
    width: 8px;
    height: 8px;
    border-right: 1px solid var(--muted);
    border-bottom: 1px solid var(--muted);
    transform: rotate(45deg);
    transition: transform 180ms var(--ease);
  }

  .settings[open] .summary-mark {
    transform: rotate(-135deg);
  }

  @media (max-width: 860px) {
    .run-review {
      padding: 26px 20px 36px;
    }

    .overview {
      grid-template-columns: 1fr;
    }

    .execution-summary {
      position: static;
      padding: 22px 0 0;
      border-top: 1px solid var(--border);
      border-left: 0;
    }
  }

  @media (max-width: 620px) {
    .review-head,
    .streams > header {
      align-items: start;
      flex-direction: column;
    }

    .split,
    .uncertainty-grid,
    .streams ol {
      grid-template-columns: 1fr;
    }

    .streams li:nth-child(odd),
    .streams li:nth-child(even) {
      padding: 15px 0;
      border-right: 0;
    }
  }
</style>
