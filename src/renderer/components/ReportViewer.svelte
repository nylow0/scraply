<script lang="ts">
  let {
    title,
    html,
  }: {
    title: string;
    html: string;
  } = $props();
</script>

<article class="report" aria-label={`Report: ${title}`}>
  <header>{title}</header>
  <div class="body">{@html html}</div>
</article>

<style>
  .report {
    margin: 0 20px 12px;
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    background: var(--surface);
  }

  header {
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    font-weight: 500;
  }

  .body {
    padding: 16px;
    color: var(--text);
  }

  .body :global(a) {
    color: var(--accent-strong);
  }

  .body :global(h2) {
    font-size: 14px;
    margin: 16px 0 8px;
  }

  .body :global(p),
  .body :global(li) {
    color: var(--muted);
  }
</style>
