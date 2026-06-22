<script lang="ts">
  let {
    reportId,
    title,
    defaultCollapsed = false,
  }: {
    reportId: string;
    title: string;
    defaultCollapsed?: boolean;
  } = $props();

  let collapsed = $state(false);
  let copied = $state(false);
  let html = $state<string | null>(null);
  let loadError = $state<string | null>(null);
  let loading = $state(true);

  $effect(() => {
    collapsed = defaultCollapsed;
  });

  $effect(() => {
    const id = reportId;
    loading = true;
    loadError = null;
    html = null;
    void window.scraply
      .getReport(id)
      .then((report) => {
        html = report.html;
        loading = false;
      })
      .catch((error) => {
        loadError = error instanceof Error ? error.message : "Failed to load report";
        loading = false;
      });
  });

  function stripHtml(raw: string): string {
    const doc = new DOMParser().parseFromString(raw, "text/html");
    return (doc.body.textContent ?? "").replace(/\s+\n/g, "\n").trim();
  }

  async function copyText() {
    if (!html) return;
    try {
      await navigator.clipboard.writeText(stripHtml(html));
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  }
</script>

<article class="report" id={`report-${reportId}`} aria-label={`Report: ${title}`}>
  <header>
    <button class="toggle" onclick={() => (collapsed = !collapsed)} aria-expanded={!collapsed}>
      <span class="dot" aria-hidden="true"></span>
      <span class="title">{title}</span>
      <svg class="chevron" class:open={!collapsed} viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
        <path d="M4 6l4 4 4-4" />
      </svg>
    </button>
    <button class="copy" onclick={copyText} disabled={!html || loading} aria-label="Copy report text">
      {copied ? "Copied" : "Copy"}
    </button>
  </header>
  {#if collapsed}
    <p class="collapsed-hint">Collapsed — expand to read the full report.</p>
  {:else if loading}
    <p class="collapsed-hint" role="status">Loading report…</p>
  {:else if loadError}
    <p class="error-hint" role="alert">{loadError}</p>
  {:else if html}
    <div class="body">{@html html}</div>
  {/if}
</article>

<style>
  .report {
    margin: 0 var(--space-5) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    overflow: hidden;
    background: var(--surface);
    scroll-margin-top: var(--space-6);
  }

  header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3) var(--space-2) var(--space-2);
    border-bottom: 1px solid var(--border);
    background: var(--surface-2);
  }

  .toggle {
    flex: 1;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
    border: none;
    background: transparent;
    color: inherit;
    text-align: left;
    padding: var(--space-2);
    border-radius: var(--r-sm);
    font-weight: 600;
    font-size: 13px;
    transition: background var(--dur) var(--ease);
  }

  .toggle:hover {
    background: color-mix(in srgb, var(--surface-3) 70%, transparent);
  }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 999px;
    background: var(--accent-strong);
    flex-shrink: 0;
  }

  .title {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .chevron {
    flex-shrink: 0;
    color: var(--muted);
    transition: transform var(--dur) var(--ease);
  }

  .chevron.open {
    transform: rotate(180deg);
  }

  .copy {
    flex-shrink: 0;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--muted);
    border-radius: var(--r-sm);
    padding: 5px 10px;
    font-size: 11.5px;
    font-weight: 500;
    transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
  }

  .copy:hover:not(:disabled) {
    background: var(--surface-3);
    color: var(--text);
  }

  .copy:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .collapsed-hint {
    margin: 0;
    padding: var(--space-3) var(--space-4);
    color: var(--faint);
    font-size: 12px;
  }

  .error-hint {
    margin: 0;
    padding: var(--space-3) var(--space-4);
    color: var(--danger);
    font-size: 12px;
  }

  .body {
    padding: var(--space-5);
    color: var(--text-2);
    line-height: 1.65;
    font-size: 14px;
  }

  .body :global(a) {
    color: var(--accent-strong);
    text-underline-offset: 2px;
  }

  .body :global(h1),
  .body :global(h2),
  .body :global(h3) {
    color: var(--text);
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  .body :global(h1) { font-size: 18px; margin: var(--space-5) 0 var(--space-3); }
  .body :global(h2) { font-size: 15px; margin: var(--space-5) 0 var(--space-2); }
  .body :global(h3) { font-size: 13.5px; margin: var(--space-4) 0 var(--space-2); }

  .body :global(p),
  .body :global(li) {
    color: var(--text-2);
  }

  .body :global(p) { margin: 0 0 var(--space-3); }
  .body :global(ul),
  .body :global(ol) { margin: 0 0 var(--space-3); padding-left: var(--space-5); }
  .body :global(li) { margin: 0 0 4px; }

  .body :global(:where(h1, h2, h3):first-child) { margin-top: 0; }

  .body :global(code) {
    font-family: var(--mono);
    font-size: 12.5px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    padding: 1px 5px;
  }

  .body :global(pre) {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    padding: var(--space-3);
    overflow: auto;
  }

  .body :global(pre code) {
    background: none;
    border: none;
    padding: 0;
  }

  .body :global(blockquote) {
    margin: 0 0 var(--space-3);
    padding-left: var(--space-3);
    border-left: 2px solid var(--accent-border);
    color: var(--muted);
  }

  .body :global(hr) {
    border: none;
    border-top: 1px solid var(--hairline);
    margin: var(--space-4) 0;
  }

  @media (max-width: 520px) {
    .report { margin: 0 var(--space-3) var(--space-3); }
  }
</style>
