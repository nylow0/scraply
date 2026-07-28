<script lang="ts">
  let { onClose }: { onClose: () => void } = $props();

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") onClose();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div
  class="overlay"
  role="presentation"
  onclick={(event) => event.currentTarget === event.target && onClose()}
>
  <div class="guide" role="dialog" aria-modal="true" aria-labelledby="guide-title">
    <header>
      <h2 id="guide-title">Scraply guide</h2>
      <button onclick={onClose}>Close</button>
    </header>
    <ol>
      <li>Validate Exa on first launch, plus Codex or OpenCode as the model provider. Keys stay encrypted locally.</li>
      <li>Start <strong>New research</strong> and describe what you want to decide, create, or improve — one sentence or a full brief.</li>
      <li>Inspect the inferred brief. Assumptions and open questions stay visible instead of being silently filled in.</li>
      <li>Review the run: six fixed streams, models, and hard caps. Nothing is spent before you start it.</li>
      <li>Watch the six streams report live. Partial failures are kept, and an interrupted run can be resumed.</li>
      <li>Generate ideas, rate them, and use <strong>Dive deeper</strong> to branch one idea into focused follow-up research.</li>
    </ol>
    <p class="hint">Press <kbd>Esc</kbd> to close.</p>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: grid;
    place-items: center;
    z-index: 30;
    padding: 20px;
    backdrop-filter: blur(4px);
  }

  .guide {
    width: min(580px, 100%);
    max-height: calc(100vh - 40px);
    overflow: auto;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 22px;
  }

  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    margin-bottom: 16px;
  }

  h2 {
    margin: 0;
    font-size: 16px;
    letter-spacing: -0.02em;
  }

  button {
    flex: 0 0 auto;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text);
    border-radius: 8px;
    padding: 6px 11px;
    font-weight: 650;
  }

  button:hover {
    border-color: var(--border-strong);
    background: var(--surface-2);
  }

  /* Tailwind preflight resets list-style, so the step numbers need restating. */
  ol {
    margin: 0;
    padding-left: 22px;
    color: var(--muted);
    display: grid;
    gap: 10px;
    font-size: 13px;
    line-height: 1.5;
    list-style: decimal outside;
  }

  li::marker {
    color: var(--accent);
    font-family: var(--mono);
    font-size: 11px;
  }

  strong {
    color: var(--text);
  }

  .hint {
    margin: 18px 0 0;
    padding-top: 14px;
    border-top: 1px solid var(--border);
    color: var(--subtle);
    font-size: 11px;
  }

  kbd {
    padding: 1px 5px;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    background: var(--surface-2);
    font-family: var(--mono);
    font-size: 10px;
  }
</style>
