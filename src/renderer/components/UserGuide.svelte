<script lang="ts">
  let { onClose }: { onClose: () => void } = $props();
</script>

<div class="overlay" role="dialog" aria-modal="true" aria-label="User guide">
  <section class="guide">
    <header>
      <h2>Scraply guide</h2>
      <button onclick={onClose}>Close</button>
    </header>
    <ol>
      <li>Validate OpenCode and Exa on first launch. Keys stay encrypted locally.</li>
      <li>Start <strong>New research</strong> and answer intake questions one at a time.</li>
      <li>Review and confirm the generated brief before any research spend.</li>
      <li>Choose models, caps, and presets, then start six-stream research.</li>
      <li>Watch progress in the Research drawer; partial failures are preserved.</li>
      <li>Generate batched ideas, rate them, and reopen the app anytime to resume.</li>
    </ol>
  </section>
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
  }

  .guide {
    width: min(560px, 100%);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px;
  }

  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
  }

  h2 {
    margin: 0;
    font-size: 16px;
  }

  button {
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text);
    border-radius: 8px;
    padding: 6px 10px;
  }

  ol {
    margin: 0;
    padding-left: 18px;
    color: var(--muted);
    display: grid;
    gap: 10px;
  }

  strong {
    color: var(--text);
  }
</style>
