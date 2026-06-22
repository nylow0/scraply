<script lang="ts">
  let { onClose }: { onClose: () => void } = $props();

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") onClose();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div
  class="overlay"
  role="presentation"
  onclick={onClose}
  onkeydown={(e) => e.key === "Escape" && onClose()}
>
  <div
    class="guide"
    role="dialog"
    aria-modal="true"
    aria-labelledby="guide-title"
    onclick={(e) => e.stopPropagation()}
    onkeydown={() => {}}
    tabindex="0"
  >
    <header>
      <h2 id="guide-title">How Scraply works</h2>
      <button class="close" aria-label="Close user guide" onclick={onClose}>
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </header>

    <div class="sections">
      <section aria-labelledby="guide-setup">
        <h3 id="guide-setup">Setup</h3>
        <ol>
          <li><span class="num">1</span><span>Enter your <strong>OpenCode</strong> and <strong>Exa</strong> keys on first launch. Keys are encrypted locally — no account required.</span></li>
          <li><span class="num">2</span><span>Or place <code>OPENCODE_API_KEY</code> and <code>EXA_API_KEY</code> in a <code>.env</code> file and use <strong>Import from .env</strong>.</span></li>
        </ol>
      </section>

      <section aria-labelledby="guide-research">
        <h3 id="guide-research">Research</h3>
        <ol start="3">
          <li><span class="num">3</span><span>Click <strong>New research</strong> and fill in the brief and run config on one screen.</span></li>
          <li><span class="num">4</span><span>Test models if you want, set spend caps, then launch six parallel research streams.</span></li>
          <li><span class="num">5</span><span>Watch progress in the activity log. Partial stream failures are kept — you never lose finished reports.</span></li>
          <li><span class="num">6</span><span>When research completes, generate a batched idea shortlist, rate ideas, and export when ready.</span></li>
        </ol>
      </section>

      <section aria-labelledby="guide-recovery">
        <h3 id="guide-recovery">After a crash or close</h3>
        <p class="recovery-copy">
          If research was running when Scraply closed, a banner appears at the top on next launch.
          <strong>Resume</strong> picks up unfinished streams from where they stopped.
          <strong>Cancel run</strong> marks the run done and keeps any reports already saved.
        </p>
      </section>

      <section aria-labelledby="guide-data">
        <h3 id="guide-data">Your data</h3>
        <p class="data-copy">
          Everything lives on this machine in your Scraply data folder — threads, reports, ideas, and encrypted keys.
          Open it anytime from the sidebar. No cloud sync, no telemetry.
        </p>
      </section>
    </div>

    <p class="footer-hint">Press <kbd>Esc</kbd> to close · Reopen from sidebar → How it works</p>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: color-mix(in srgb, var(--bg) 70%, transparent);
    backdrop-filter: blur(4px);
    display: grid;
    place-items: center;
    z-index: 30;
    padding: var(--space-5);
    animation: fade var(--dur) var(--ease);
  }

  @keyframes fade {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .guide {
    width: min(560px, 100%);
    max-height: min(90dvh, 720px);
    overflow-y: auto;
    background: var(--overlay);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-xl);
    padding: var(--space-6);
    box-shadow: var(--shadow-lg), var(--shadow-inset);
    animation: rise var(--dur) var(--ease);
  }

  @keyframes rise {
    from { transform: translateY(8px) scale(0.99); opacity: 0; }
    to { transform: translateY(0) scale(1); opacity: 1; }
  }

  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--space-5);
  }

  h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
  }

  h3 {
    margin: 0 0 var(--space-3);
    font-size: 11px;
    font-family: var(--mono);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--accent-strong);
  }

  .sections {
    display: grid;
    gap: var(--space-5);
  }

  .close {
    display: grid;
    place-items: center;
    border: 1px solid transparent;
    background: transparent;
    color: var(--muted);
    border-radius: var(--r-sm);
    padding: 5px;
    transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
  }

  .close:hover {
    background: var(--surface-2);
    color: var(--text);
    border-color: var(--border);
  }

  .close:focus-visible {
    outline: 2px solid var(--accent-strong);
    outline-offset: 2px;
  }

  ol {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: var(--space-3);
  }

  li {
    display: grid;
    grid-template-columns: 22px 1fr;
    gap: var(--space-3);
    align-items: start;
    color: var(--text-2);
    font-size: 13.5px;
    line-height: 1.55;
  }

  .num {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: 999px;
    border: 1px solid var(--accent-border);
    background: var(--accent-faint);
    color: var(--accent-strong);
    font-family: var(--mono);
    font-size: 11px;
    margin-top: 1px;
  }

  .recovery-copy,
  .data-copy {
    margin: 0;
    color: var(--text-2);
    font-size: 13.5px;
    line-height: 1.55;
  }

  code {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text);
  }

  strong {
    color: var(--text);
    font-weight: 600;
  }

  .footer-hint {
    margin: var(--space-5) 0 0;
    padding-top: var(--space-4);
    border-top: 1px solid var(--hairline);
    color: var(--faint);
    font-size: 12px;
    text-align: center;
  }

  kbd {
    font-family: var(--mono);
    font-size: 11px;
    padding: 1px 5px;
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    background: var(--surface-2);
    color: var(--text-2);
  }
</style>
