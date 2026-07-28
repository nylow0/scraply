<script lang="ts">
  import { REQUIRED_INTAKE_QUESTIONS, OPTIONAL_INTAKE_QUESTIONS } from "../../shared/intake";

  type IntakeAnswer = { questionId: string; answer: string; skipped: boolean };

  let {
    submitting,
    error,
    onSubmit,
    onBack,
  }: {
    submitting: boolean;
    error: string | null;
    onSubmit: (answers: IntakeAnswer[]) => void;
    onBack: () => void;
  } = $props();

  let values = $state<Record<string, string>>({});
  const allQuestions = [...REQUIRED_INTAKE_QUESTIONS, ...OPTIONAL_INTAKE_QUESTIONS];
  const questionGroups = [
    {
      title: "Direction",
      description: "Define what you want to discover and what a useful result looks like.",
      questions: REQUIRED_INTAKE_QUESTIONS.slice(0, 5),
      optional: false,
    },
    {
      title: "Boundaries",
      description: "Set the practical limits that should shape every recommendation.",
      questions: REQUIRED_INTAKE_QUESTIONS.slice(5),
      optional: false,
    },
    {
      title: "Optional context",
      description: "Add anything else that could sharpen the research, or leave these blank.",
      questions: OPTIONAL_INTAKE_QUESTIONS,
      optional: true,
    },
  ];

  const missingRequired = $derived(
    REQUIRED_INTAKE_QUESTIONS.filter((question) => !(values[question.id] ?? "").trim()).map((question) => question.id),
  );
  const canSubmit = $derived(missingRequired.length === 0 && !submitting);
  const answeredRequired = $derived(REQUIRED_INTAKE_QUESTIONS.length - missingRequired.length);
  const progress = $derived((answeredRequired / REQUIRED_INTAKE_QUESTIONS.length) * 100);

  function questionNumber(questionId: string) {
    return String(allQuestions.findIndex((question) => question.id === questionId) + 1).padStart(2, "0");
  }

  function submit() {
    if (!canSubmit) return;
    const answers: IntakeAnswer[] = allQuestions.map((question) => {
      const answer = (values[question.id] ?? "").trim();
      return answer
        ? { questionId: question.id, answer, skipped: false }
        : { questionId: question.id, answer: "", skipped: true };
    });
    onSubmit(answers);
  }
</script>

<form class="setup" onsubmit={(event) => { event.preventDefault(); submit(); }}>
  <div class="head">
    <div>
      <button class="back" type="button" disabled={submitting} onclick={onBack}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M10 6 4 12l6 6M5 12h15"></path>
        </svg>
        <span>Back to smart input</span>
      </button>
      <p class="eyebrow">Research intake</p>
      <h2>Build the research brief</h2>
      <p>Answer the ten required questions, add any optional context, then review the generated brief.</p>
    </div>
    <div class="progress-copy" aria-live="polite">
      <strong>{answeredRequired}/{REQUIRED_INTAKE_QUESTIONS.length}</strong>
      <span>required answered</span>
    </div>
  </div>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  <div class="progress-track" aria-hidden="true">
    <span style={`--progress: ${progress}%`}></span>
  </div>

  <div class="form-body">
    {#each questionGroups as group}
      <section class="question-group" class:optional={group.optional}>
        <header class="group-head">
          <div>
            <h3>{group.title}</h3>
            <p>{group.description}</p>
          </div>
          <span>{group.optional ? "Optional" : "Required"}</span>
        </header>

        <div class="question-grid">
          {#each group.questions as question (question.id)}
            <label class:answered={Boolean((values[question.id] ?? "").trim())}>
              <span class="question-label">
                <small>{questionNumber(question.id)}</small>
                {question.prompt}
              </span>
              <textarea
                bind:value={values[question.id]}
                rows="2"
                disabled={submitting}
                aria-required={!group.optional}
                placeholder={group.optional ? "Optional — leave blank to skip" : "Add the useful specifics…"}
              ></textarea>
            </label>
          {/each}
        </div>
      </section>
    {/each}
  </div>

  <div class="actions">
    <span class="hint">
      {missingRequired.length
        ? `${missingRequired.length} required ${missingRequired.length === 1 ? "answer" : "answers"} remaining`
        : "Ready to review"}
    </span>
    <button class="primary" type="submit" disabled={!canSubmit}>
      {submitting ? "Drafting brief…" : "Review brief"}
    </button>
  </div>
</form>

<style>
  .setup {
    height: 100%;
    min-height: 0;
    overflow-y: auto;
    padding: 28px clamp(24px, 4vw, 52px) 0;
    display: grid;
    gap: 16px;
    align-content: start;
  }

  .head,
  .progress-track,
  .form-body,
  .actions,
  .error {
    width: min(100%, 960px);
  }

  .head {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: 32px;
  }

  .eyebrow {
    margin: 0 0 8px !important;
    color: var(--accent) !important;
    font-family: var(--mono);
    font-size: 10px !important;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  button.back {
    width: fit-content;
    min-height: 44px;
    margin: 0 0 22px;
    padding: 10px 15px 10px 12px;
    display: inline-flex;
    align-items: center;
    gap: 9px;
    border: 1px solid var(--border-strong);
    border-radius: 10px;
    background: var(--surface);
    color: var(--text);
    font-size: 13px;
    font-weight: 700;
    box-shadow: 0 8px 22px color-mix(in srgb, var(--bg) 72%, transparent);
    transition:
      transform 180ms var(--ease),
      border-color 180ms var(--ease),
      background 180ms var(--ease),
      box-shadow 180ms var(--ease);
  }

  button.back svg {
    width: 19px;
    height: 19px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
    color: var(--accent);
  }

  button.back:hover:not(:disabled) {
    transform: translateX(-2px);
    border-color: color-mix(in srgb, var(--accent) 58%, var(--border-strong));
    background: var(--surface-2);
    box-shadow: 0 10px 26px color-mix(in srgb, var(--bg) 64%, transparent);
  }

  button.back:active:not(:disabled) {
    transform: translateX(-1px) scale(0.98);
  }

  button.back:focus-visible {
    outline: 3px solid color-mix(in srgb, var(--accent) 22%, transparent);
    outline-offset: 3px;
  }

  button.back:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .head h2 {
    margin: 0 0 8px;
    font-size: clamp(22px, 2.4vw, 30px);
    font-weight: 650;
    letter-spacing: -0.04em;
    line-height: 1.1;
  }

  .head p,
  .group-head p {
    margin: 0;
    color: var(--muted);
    font-size: 13px;
  }

  .head p {
    max-width: 68ch;
  }

  .progress-copy {
    flex: 0 0 auto;
    display: grid;
    justify-items: end;
    gap: 2px;
    padding-bottom: 2px;
  }

  .progress-copy strong {
    font-family: var(--mono);
    font-size: 14px;
    font-weight: 600;
  }

  .progress-copy span,
  .hint {
    color: var(--muted);
    font-size: 11px;
  }

  .progress-track {
    height: 2px;
    overflow: hidden;
    background: var(--border);
  }

  .progress-track span {
    display: block;
    width: var(--progress);
    height: 100%;
    background: var(--accent);
    transition: width 300ms var(--ease);
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

  .form-body {
    display: grid;
    gap: 34px;
    padding: 8px 0 12px;
  }

  .question-group {
    display: grid;
    gap: 18px;
  }

  .question-group + .question-group {
    padding-top: 28px;
    border-top: 1px solid var(--border);
  }

  .group-head {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: 24px;
  }

  .group-head h3 {
    margin: 0 0 5px;
    font-size: 15px;
    letter-spacing: -0.02em;
  }

  .group-head p {
    font-size: 12px;
  }

  .group-head > span {
    flex: 0 0 auto;
    padding: 4px 7px;
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--subtle);
    font-family: var(--mono);
    font-size: 9px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .question-group:not(.optional) .group-head > span {
    border-color: color-mix(in srgb, var(--accent) 32%, var(--border));
    color: var(--accent);
  }

  .question-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 18px 16px;
  }

  .question-grid label:last-child:nth-child(odd) {
    grid-column: 1 / -1;
  }

  label {
    display: grid;
    gap: 8px;
    align-content: start;
    color: var(--text);
    font-size: 13px;
  }

  .question-label {
    display: grid;
    grid-template-columns: 24px 1fr;
    gap: 8px;
    min-height: 38px;
    align-items: start;
    line-height: 1.4;
  }

  .question-label small {
    padding-top: 2px;
    color: var(--subtle);
    font-family: var(--mono);
    font-size: 10px;
  }

  textarea {
    min-height: 72px;
    padding: 11px 12px;
    resize: vertical;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
    color: var(--text);
    font-family: var(--sans);
    line-height: 1.45;
    transition: border-color 180ms var(--ease), background 180ms var(--ease), box-shadow 180ms var(--ease);
  }

  textarea::placeholder {
    color: var(--subtle);
  }

  textarea:hover:not(:disabled) {
    border-color: var(--border-strong);
  }

  textarea:focus {
    outline: none;
    border-color: color-mix(in srgb, var(--accent) 68%, var(--border));
    background: var(--surface-2);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent);
  }

  textarea:disabled {
    opacity: 0.6;
  }

  .actions {
    position: sticky;
    bottom: 0;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px 0 20px;
    border-top: 1px solid var(--border);
    background: color-mix(in srgb, var(--bg) 92%, transparent);
    backdrop-filter: blur(12px);
  }

  button.primary {
    min-width: 132px;
    margin-left: auto;
    padding: 10px 18px;
    border: 1px solid var(--accent-strong);
    border-radius: 9px;
    background: var(--accent-strong);
    color: var(--accent-ink);
    font-weight: 700;
  }

  button.primary:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  @media (max-width: 840px) {
    .setup {
      padding: 24px 20px 0;
    }

    .question-grid {
      grid-template-columns: 1fr;
    }

    .question-grid label:last-child:nth-child(odd) {
      grid-column: auto;
    }

    .head {
      align-items: start;
    }

    .progress-copy {
      display: none;
    }
  }
</style>
