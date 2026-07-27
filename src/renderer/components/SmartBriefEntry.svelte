<script lang="ts">
  const MAX_LENGTH = 100_000;

  let {
    value,
    submitting,
    error,
    onChange,
    onSubmit,
    onUseGuidedSetup,
  }: {
    value: string;
    submitting: boolean;
    error: string | null;
    onChange: (value: string) => void;
    onSubmit: (value: string) => void;
    onUseGuidedSetup: () => void;
  } = $props();

  const trimmedValue = $derived(value.trim());
  const charactersRemaining = $derived(MAX_LENGTH - value.length);
  const canSubmit = $derived(trimmedValue.length > 0 && charactersRemaining >= 0 && !submitting);

  function submit() {
    if (!canSubmit) return;
    onSubmit(trimmedValue);
  }
</script>

<form class="smart-entry" onsubmit={(event) => { event.preventDefault(); submit(); }}>
  <header class="entry-head">
    <p class="eyebrow">Research intake</p>
    <h2>What are you trying to decide, create, or improve?</h2>
    <p>Write a sentence or paste your full brief. Include the decision, desired output, constraints, or deadline if you already know them.</p>
  </header>

  <div class="entry-layout">
    <div class="input-column">
      <label for="starter-brief">Your brief</label>
      <textarea
        id="starter-brief"
        value={value}
        rows="12"
        maxlength={MAX_LENGTH}
        disabled={submitting}
        aria-describedby="starter-brief-help starter-brief-count"
        aria-invalid={Boolean(error)}
        placeholder="For example: Compare the best ways to launch a small software product for students. I want a ranked shortlist, have six weeks, and need evidence of real demand."
        oninput={(event) => onChange(event.currentTarget.value)}
      ></textarea>

      <div class="input-meta">
        <span id="starter-brief-help">Short prompts and detailed briefs both work.</span>
        <span id="starter-brief-count" class:near-limit={charactersRemaining < 5_000}>
          {value.length.toLocaleString()} / {MAX_LENGTH.toLocaleString()}
        </span>
      </div>

      {#if error}
        <p class="error" role="alert">{error}</p>
      {/if}

      {#if submitting}
        <div class="processing" role="status" aria-live="polite">
          <span aria-hidden="true"></span>
          <div>
            <strong>Interpreting your brief</strong>
            <small>Separating stated facts, assumptions, and missing details.</small>
          </div>
        </div>
      {/if}
    </div>

    <aside aria-label="Useful brief details">
      <p class="aside-label">Useful signals</p>
      <ul>
        <li><strong>Decision</strong><span>What this research should help you choose.</span></li>
        <li><strong>Output</strong><span>Options, a comparison, or a recommendation.</span></li>
        <li><strong>Boundaries</strong><span>Budget, deadline, resources, and hard limits.</span></li>
        <li><strong>Evidence</strong><span>What must be supported and which sources count.</span></li>
      </ul>
      <p class="aside-note">Leave unknown details unknown. You can inspect and edit the inferred brief before research starts.</p>
    </aside>
  </div>

  <footer class="actions">
    <button type="button" class="guided" disabled={submitting} onclick={onUseGuidedSetup}>
      Use guided setup
    </button>
    <button type="submit" class="primary" disabled={!canSubmit}>
      {submitting ? "Building research brief…" : "Build research brief"}
    </button>
  </footer>
</form>

<style>
  .smart-entry {
    height: 100%;
    min-height: 0;
    overflow-y: auto;
    display: grid;
    align-content: start;
    gap: 30px;
    padding: clamp(30px, 6vh, 72px) clamp(24px, 5vw, 68px) 0;
  }

  .smart-entry > * {
    width: min(100%, 1060px);
  }

  .entry-head {
    display: grid;
    gap: 10px;
    max-width: 780px;
  }

  .eyebrow,
  .aside-label {
    margin: 0;
    color: var(--accent);
    font-family: var(--mono);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  h2 {
    max-width: 22ch;
    margin: 0;
    font-size: clamp(28px, 4vw, 46px);
    font-weight: 650;
    letter-spacing: -0.055em;
    line-height: 1.03;
  }

  .entry-head > p:last-child {
    max-width: 68ch;
    margin: 0;
    color: var(--muted);
    font-size: 14px;
    line-height: 1.55;
  }

  .entry-layout {
    display: grid;
    grid-template-columns: minmax(0, 1.7fr) minmax(240px, 0.8fr);
    gap: clamp(28px, 5vw, 64px);
    align-items: start;
  }

  .input-column {
    min-width: 0;
    display: grid;
    gap: 9px;
  }

  label {
    color: var(--text);
    font-size: 12px;
    font-weight: 650;
  }

  textarea {
    width: 100%;
    min-height: 260px;
    resize: vertical;
    padding: 17px 18px;
    border: 1px solid var(--border-strong);
    border-radius: 12px;
    background: var(--surface);
    color: var(--text);
    font-family: var(--sans);
    font-size: 15px;
    line-height: 1.6;
    transition:
      border-color 180ms var(--ease),
      background 180ms var(--ease),
      box-shadow 180ms var(--ease);
  }

  textarea::placeholder {
    color: var(--subtle);
  }

  textarea:hover:not(:disabled) {
    border-color: color-mix(in srgb, var(--accent) 42%, var(--border-strong));
  }

  textarea:focus {
    outline: none;
    border-color: color-mix(in srgb, var(--accent) 72%, var(--border));
    background: var(--surface-2);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent);
  }

  textarea:disabled {
    opacity: 0.68;
  }

  .input-meta {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    color: var(--subtle);
    font-size: 11px;
  }

  .input-meta span:last-child {
    flex: 0 0 auto;
    font-family: var(--mono);
  }

  .input-meta .near-limit {
    color: var(--danger);
  }

  .error {
    margin: 4px 0 0;
    padding: 10px 12px;
    border: 1px solid color-mix(in srgb, var(--danger) 48%, var(--border));
    border-radius: 8px;
    background: color-mix(in srgb, var(--danger) 9%, var(--surface));
    color: var(--danger);
    font-size: 12px;
  }

  .processing {
    display: flex;
    align-items: center;
    gap: 11px;
    min-height: 48px;
    margin-top: 3px;
    color: var(--text);
  }

  .processing > span {
    width: 24px;
    height: 2px;
    overflow: hidden;
    background: var(--border-strong);
  }

  .processing > span::after {
    content: "";
    display: block;
    width: 60%;
    height: 100%;
    background: var(--accent-strong);
    animation: processing-shift 1.1s var(--ease) infinite alternate;
  }

  .processing div {
    display: grid;
    gap: 2px;
  }

  .processing strong {
    font-size: 12px;
  }

  .processing small {
    color: var(--muted);
    font-size: 11px;
  }

  aside {
    display: grid;
    gap: 16px;
    padding-left: clamp(22px, 3vw, 36px);
    border-left: 1px solid var(--border);
  }

  aside ul {
    display: grid;
    gap: 0;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  aside li {
    display: grid;
    gap: 3px;
    padding: 12px 0;
    border-bottom: 1px solid var(--border);
  }

  aside li:first-child {
    padding-top: 0;
  }

  aside strong {
    font-size: 12px;
  }

  aside span,
  .aside-note {
    color: var(--muted);
    font-size: 11px;
    line-height: 1.5;
  }

  .aside-note {
    margin: 0;
  }

  .actions {
    position: sticky;
    bottom: 0;
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    padding: 17px 0 22px;
    border-top: 1px solid var(--border);
    background: color-mix(in srgb, var(--bg) 92%, transparent);
    backdrop-filter: blur(12px);
  }

  button {
    min-height: 40px;
    padding: 9px 15px;
    border: 1px solid var(--border);
    border-radius: 9px;
    background: var(--surface-2);
    color: var(--text);
    font-weight: 650;
  }

  button.guided {
    background: transparent;
    color: var(--muted);
  }

  button.guided:hover:not(:disabled) {
    border-color: var(--border-strong);
    color: var(--text);
  }

  button.primary {
    min-width: 174px;
    border-color: var(--accent-strong);
    background: var(--accent-strong);
    color: var(--accent-ink);
  }

  button:disabled {
    opacity: 0.52;
  }

  @keyframes processing-shift {
    from { transform: translateX(-35%); opacity: 0.5; }
    to { transform: translateX(70%); opacity: 1; }
  }

  @media (max-width: 800px) {
    .smart-entry {
      padding: 30px 20px 0;
    }

    .entry-layout {
      grid-template-columns: 1fr;
    }

    aside {
      padding: 22px 0 0;
      border-top: 1px solid var(--border);
      border-left: 0;
    }

    textarea {
      min-height: 220px;
    }
  }

  @media (max-width: 520px) {
    h2 {
      font-size: 29px;
    }

    .actions {
      display: grid;
      grid-template-columns: 1fr;
    }

    button.primary {
      grid-row: 1;
    }
  }
</style>
