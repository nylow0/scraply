<script lang="ts">
  import { untrack } from "svelte";
  import type { ProjectBrief } from "../../shared/schemas";
  import { cloneBriefForReview, prepareBriefForSubmission, validateBriefForReview } from "../lib/brief-review";
  import StringListField from "./StringListField.svelte";

  type ListField =
    | "audience"
    | "successCriteria"
    | "hardConstraints"
    | "preferences"
    | "antiGoals"
    | "resources"
    | "evidenceRequirements"
    | "examplesToInspect"
    | "assumptions"
    | "openQuestions"
    | "contradictions";

  let {
    brief,
    onSubmit,
    onCancel,
    submitting = false,
    mode = "confirm",
  }: {
    brief: ProjectBrief;
    onSubmit: (brief: ProjectBrief) => void;
    onCancel?: () => void;
    submitting?: boolean;
    mode?: "confirm" | "save";
  } = $props();

  let draft = $state<ProjectBrief>(cloneBriefForReview(untrack(() => brief)));
  let attempted = $state(false);
  const errors = $derived(validateBriefForReview(draft));
  const errorCount = $derived(Object.keys(errors).length);

  // Background workspace reconciles hand us a new `brief` object on every
  // backend event. Comparing content, not identity, keeps unsaved edits alive
  // and still resyncs when the stored brief genuinely changes.
  let syncedBrief = JSON.stringify(untrack(() => brief));

  $effect(() => {
    const incoming = JSON.stringify(brief);
    if (incoming === syncedBrief) return;
    syncedBrief = incoming;
    draft = cloneBriefForReview(untrack(() => brief));
    attempted = false;
  });

  function updateList(field: ListField, values: string[]) {
    draft[field] = values;
  }

  function submit() {
    attempted = true;
    if (errorCount > 0 || submitting) return;
    onSubmit(prepareBriefForSubmission(draft));
  }
</script>

<form class="brief-review" onsubmit={(event) => { event.preventDefault(); submit(); }}>
  <header class="review-head">
    <div>
      <p class="eyebrow">Brief review</p>
      <h2>{mode === "confirm" ? "Inspect the inferred brief" : "Edit the research brief"}</h2>
      <p>Every field below can shape research or ranking. Unknown values stay visible instead of being silently filled in.</p>
    </div>
    <div class="review-state" aria-live="polite">
      <strong>{errorCount === 0 ? "Ready" : `${errorCount} required`}</strong>
      <span>{mode === "confirm" ? "before review and run" : "before saving"}</span>
    </div>
  </header>

  {#if attempted && errorCount > 0}
    <p class="validation-summary" role="alert">
      Complete the objective, decision or exploratory intent, and desired output before continuing.
    </p>
  {/if}

  <div class="sections">
    <section>
      <header class="section-head">
        <span>01</span>
        <div><h3>Goal and decision</h3><p>Define what the work is for and who will use it.</p></div>
      </header>
      <div class="field-grid">
        <label>
          <span>Title</span>
          <input bind:value={draft.title} disabled={submitting} />
        </label>
        <StringListField
          id="audience"
          label="Audience"
          values={draft.audience}
          placeholder="Add an audience"
          disabled={submitting}
          onChange={(values) => updateList("audience", values)}
        />
        <label class="full">
          <span>Objective <small>Required</small></span>
          <textarea
            bind:value={draft.objective}
            rows="3"
            disabled={submitting}
            aria-invalid={attempted && Boolean(errors.objective)}
            aria-describedby={attempted && errors.objective ? "objective-error" : undefined}
          ></textarea>
          {#if attempted && errors.objective}<small id="objective-error" class="field-error">{errors.objective}</small>{/if}
        </label>
        <label class="full">
          <span>Context</span>
          <textarea bind:value={draft.context} rows="4" disabled={submitting} placeholder="Not provided"></textarea>
        </label>
        <label class="full">
          <span>Decision or exploratory intent <small>Required</small></span>
          <textarea
            bind:value={draft.decisionToSupport}
            rows="3"
            disabled={submitting}
            placeholder="State the decision, or explain what should be explored without choosing a winner."
            aria-invalid={attempted && Boolean(errors.decisionToSupport)}
            aria-describedby={attempted && errors.decisionToSupport ? "decision-error" : undefined}
          ></textarea>
          {#if attempted && errors.decisionToSupport}<small id="decision-error" class="field-error">{errors.decisionToSupport}</small>{/if}
        </label>
      </div>
    </section>

    <section>
      <header class="section-head">
        <span>02</span>
        <div><h3>What good looks like</h3><p>Set the output shape and the signals that matter.</p></div>
      </header>
      <div class="field-grid">
        <label>
          <span>Output type <small>Required</small></span>
          <select bind:value={draft.desiredOutput.type} disabled={submitting}>
            <option value="options">Options</option>
            <option value="ranked-shortlist">Ranked shortlist</option>
            <option value="decision-memo">Decision memo</option>
            <option value="research-brief">Research brief</option>
            <option value="comparison">Comparison</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label>
          <span>Idea style</span>
          <select bind:value={draft.ideaStyle} disabled={submitting}>
            <option value="safe">Safe</option>
            <option value="balanced">Balanced</option>
            <option value="bold">Bold</option>
          </select>
        </label>
        <label class="full">
          <span>Output notes {#if draft.desiredOutput.type === "other"}<small>Required for Other</small>{/if}</span>
          <textarea
            bind:value={draft.desiredOutput.notes}
            rows="2"
            disabled={submitting}
            placeholder="Not provided"
            aria-invalid={attempted && Boolean(errors.desiredOutput)}
            aria-describedby={attempted && errors.desiredOutput ? "output-error" : undefined}
          ></textarea>
          {#if attempted && errors.desiredOutput}<small id="output-error" class="field-error">{errors.desiredOutput}</small>{/if}
        </label>
        <StringListField
          id="success-criteria"
          label="Success criteria"
          values={draft.successCriteria}
          placeholder="Add a success criterion"
          disabled={submitting}
          onChange={(values) => updateList("successCriteria", values)}
        />
        <StringListField
          id="preferences"
          label="Preferences"
          values={draft.preferences}
          placeholder="Add a preference"
          disabled={submitting}
          onChange={(values) => updateList("preferences", values)}
        />
      </div>
    </section>

    <section>
      <header class="section-head">
        <span>03</span>
        <div><h3>Boundaries</h3><p>Separate hard limits from preferences and anti-goals.</p></div>
      </header>
      <div class="field-grid">
        <StringListField
          id="hard-constraints"
          label="Hard constraints"
          values={draft.hardConstraints}
          placeholder="Add a hard constraint"
          disabled={submitting}
          onChange={(values) => updateList("hardConstraints", values)}
        />
        <StringListField
          id="anti-goals"
          label="Anti-goals"
          values={draft.antiGoals}
          placeholder="Add something to avoid"
          disabled={submitting}
          onChange={(values) => updateList("antiGoals", values)}
        />
        <label>
          <span>Deadline</span>
          <input
            value={draft.deadline ?? ""}
            disabled={submitting}
            placeholder="Not provided"
            oninput={(event) => (draft.deadline = event.currentTarget.value || null)}
          />
          <small>Leave empty if no deadline exists.</small>
        </label>
        <label>
          <span>Available effort</span>
          <input
            value={draft.availableEffort ?? ""}
            disabled={submitting}
            placeholder="Not provided"
            oninput={(event) => (draft.availableEffort = event.currentTarget.value || null)}
          />
          <small>Leave empty if effort is unknown.</small>
        </label>
      </div>
    </section>

    <section>
      <header class="section-head">
        <span>04</span>
        <div><h3>Research context</h3><p>Record the assets, proof standards, and examples researchers can use.</p></div>
      </header>
      <div class="field-grid">
        <StringListField
          id="resources"
          label="Available resources"
          values={draft.resources}
          placeholder="Add a resource"
          disabled={submitting}
          onChange={(values) => updateList("resources", values)}
        />
        <StringListField
          id="evidence-requirements"
          label="Evidence requirements"
          values={draft.evidenceRequirements}
          placeholder="Add an evidence rule"
          disabled={submitting}
          onChange={(values) => updateList("evidenceRequirements", values)}
        />
        <div class="full">
          <StringListField
            id="examples"
            label="Examples to inspect"
            values={draft.examplesToInspect}
            placeholder="Add an example or anti-example"
            disabled={submitting}
            onChange={(values) => updateList("examplesToInspect", values)}
          />
        </div>
      </div>
    </section>

    <section>
      <header class="section-head">
        <span>05</span>
        <div><h3>Uncertainty</h3><p>Keep model inferences, unresolved conflicts, and missing details explicit.</p></div>
      </header>
      <div class="field-grid">
        <StringListField
          id="assumptions"
          label="Assumptions"
          values={draft.assumptions}
          placeholder="Add an assumption"
          disabled={submitting}
          onChange={(values) => updateList("assumptions", values)}
        />
        <StringListField
          id="open-questions"
          label="Open questions"
          values={draft.openQuestions}
          placeholder="Add an open question"
          disabled={submitting}
          onChange={(values) => updateList("openQuestions", values)}
        />
        <div class="full uncertainty-field">
          <StringListField
            id="contradictions"
            label="Contradictions"
            values={draft.contradictions}
            placeholder="Add an unresolved contradiction"
            disabled={submitting}
            onChange={(values) => updateList("contradictions", values)}
          />
        </div>
      </div>
    </section>
  </div>

  <footer class="actions">
    <span>{errorCount === 0 ? "Required fields complete" : "Required details still missing"}</span>
    {#if onCancel}
      <button type="button" class="ghost" disabled={submitting} onclick={onCancel}>Cancel editing</button>
    {/if}
    <button type="submit" class="primary" disabled={submitting}>
      {submitting
        ? mode === "confirm" ? "Confirming brief…" : "Saving brief…"
        : mode === "confirm" ? "Confirm brief & review run" : "Save brief"}
    </button>
  </footer>
</form>

<style>
  /* Flex column, not grid: a sticky action bar inside a grid item is confined
     to its own grid area and never sticks. */
  .brief-review {
    width: min(100%, var(--page-max));
    min-height: 100%;
    display: flex;
    flex-direction: column;
    gap: 24px;
    padding: var(--page-top) var(--page-inline) 0;
  }

  .review-head {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: 32px;
  }

  .eyebrow {
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
    font-size: clamp(25px, 3vw, 36px);
    font-weight: 650;
    letter-spacing: -0.045em;
    line-height: 1.05;
  }

  .review-head p:last-child {
    max-width: 68ch;
    margin: 0;
    color: var(--muted);
    font-size: 13px;
  }

  .review-state {
    flex: 0 0 auto;
    display: grid;
    justify-items: end;
    gap: 2px;
  }

  .review-state strong {
    color: var(--accent-strong);
    font-family: var(--mono);
    font-size: 12px;
  }

  .review-state span {
    color: var(--subtle);
    font-size: 10px;
  }

  .validation-summary {
    margin: 0;
    padding: 11px 13px;
    border: 1px solid color-mix(in srgb, var(--danger) 45%, var(--border));
    border-radius: 8px;
    background: color-mix(in srgb, var(--danger) 8%, var(--surface));
    color: var(--danger);
    font-size: 12px;
  }

  .sections {
    display: grid;
  }

  section {
    display: grid;
    grid-template-columns: minmax(180px, 0.58fr) minmax(0, 1.42fr);
    gap: clamp(24px, 5vw, 64px);
    padding: 30px 0;
    border-top: 1px solid var(--border);
  }

  .section-head {
    display: grid;
    grid-template-columns: 24px minmax(0, 1fr);
    gap: 9px;
    align-content: start;
  }

  .section-head > span {
    padding-top: 2px;
    color: var(--subtle);
    font-family: var(--mono);
    font-size: 10px;
  }

  h3 {
    margin: 0 0 5px;
    font-size: 14px;
    letter-spacing: -0.02em;
  }

  .section-head p {
    margin: 0;
    color: var(--muted);
    font-size: 11px;
    line-height: 1.5;
  }

  .field-grid {
    min-width: 0;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 22px 18px;
  }

  .full {
    grid-column: 1 / -1;
  }

  label {
    min-width: 0;
    display: grid;
    align-content: start;
    gap: 8px;
    color: var(--text);
    font-size: 12px;
    font-weight: 650;
  }

  label > span {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
  }

  label small {
    color: var(--subtle);
    font-size: 10px;
    font-weight: 500;
  }

  input,
  textarea,
  select {
    width: 100%;
    min-height: 40px;
    padding: 9px 11px;
    border: 1px solid var(--border);
    border-radius: 9px;
    background: var(--surface);
    color: var(--text);
    font-weight: 400;
    line-height: 1.5;
    transition:
      border-color 180ms var(--ease),
      background 180ms var(--ease),
      box-shadow 180ms var(--ease);
  }

  textarea {
    resize: vertical;
  }

  input::placeholder,
  textarea::placeholder {
    color: var(--subtle);
  }

  input:hover:not(:disabled),
  textarea:hover:not(:disabled),
  select:hover:not(:disabled) {
    border-color: var(--border-strong);
  }

  input:focus,
  textarea:focus,
  select:focus {
    outline: none;
    border-color: color-mix(in srgb, var(--accent) 68%, var(--border));
    background: var(--surface-2);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent);
  }

  [aria-invalid="true"] {
    border-color: color-mix(in srgb, var(--danger) 68%, var(--border));
  }

  .field-error {
    color: var(--danger);
    font-size: 11px;
    font-weight: 500;
  }

  .uncertainty-field {
    padding: 14px;
    border-left: 2px solid color-mix(in srgb, var(--accent) 55%, var(--border));
    background: color-mix(in srgb, var(--accent) 5%, transparent);
  }

  .actions {
    position: sticky;
    bottom: 0;
    margin-top: auto;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 9px;
    padding: 17px 0 22px;
    border-top: 1px solid var(--border);
    background: color-mix(in srgb, var(--bg) 92%, transparent);
    backdrop-filter: blur(12px);
  }

  .actions > span {
    margin-right: auto;
    color: var(--subtle);
    font-size: 11px;
  }

  button {
    min-height: 40px;
    padding: 9px 14px;
    border: 1px solid var(--border);
    border-radius: 9px;
    background: var(--surface-2);
    color: var(--text);
    font-weight: 650;
  }

  button.primary {
    min-width: 190px;
    border-color: var(--accent-strong);
    background: var(--accent-strong);
    color: var(--accent-ink);
  }

  button.ghost {
    background: transparent;
    color: var(--muted);
  }

  button:disabled,
  input:disabled,
  textarea:disabled,
  select:disabled {
    opacity: 0.55;
  }

  @media (max-width: 840px) {
    section {
      grid-template-columns: 1fr;
      gap: 20px;
    }
  }

  @media (max-width: 620px) {
    .review-state {
      display: none;
    }

    .field-grid {
      grid-template-columns: 1fr;
    }

    .full {
      grid-column: auto;
    }

    .actions {
      display: grid;
      grid-template-columns: 1fr;
    }

    .actions > span {
      margin: 0;
    }

    button.primary {
      grid-row: 1;
    }
  }
</style>
