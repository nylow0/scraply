<script lang="ts">
  let {
    reportId,
    title,
  }: {
    reportId: string;
    title: string;
  } = $props();

  let html = $state<string | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);

  async function load() {
    if (html !== null || loading) return;
    loading = true;
    error = null;
    try {
      const detail = await window.scraply.getReportDetail(reportId);
      html = detail.html;
    } catch (reason) {
      error = reason instanceof Error ? reason.message : "Failed to load report";
    } finally {
      loading = false;
    }
  }

  function openLink(event: Event) {
    const target = event.target as Element | null;
    const anchor = target?.closest("a[href]") as HTMLAnchorElement | null;
    if (!anchor) return;
    event.preventDefault();
    void window.scraply.openExternalUrl(anchor.href);
  }

  function interceptLinks(node: HTMLElement) {
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Enter") openLink(event);
    };
    node.addEventListener("click", openLink);
    node.addEventListener("keydown", onKeydown);
    return {
      destroy() {
        node.removeEventListener("click", openLink);
        node.removeEventListener("keydown", onKeydown);
      },
    };
  }
</script>

<details
  class="report"
  aria-label={`Report: ${title}`}
  ontoggle={(event) => {
    if (event.currentTarget.open) void load();
  }}
>
  <summary>{title}</summary>
  {#if loading}
    <p class="state">Loading report…</p>
  {:else if error}
    <div class="state error" role="alert">
      <span>{error}</span>
      <button onclick={load}>Retry</button>
    </div>
  {:else if html !== null}
    <div class="body" use:interceptLinks>{@html html}</div>
  {/if}
</details>

<style>
  .report {
    margin: 0;
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
    background: var(--surface-2);
  }

  summary {
    padding: 11px 14px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 650;
    transition:
      background-color 180ms var(--ease),
      color 180ms var(--ease);
  }

  summary:hover {
    color: var(--accent-strong);
    background: color-mix(in srgb, var(--accent) 7%, transparent);
  }

  .report[open] summary {
    border-bottom: 1px solid var(--border);
  }

  .state {
    margin: 0;
    padding: 16px;
    color: var(--muted);
  }

  .state.error {
    display: flex;
    justify-content: space-between;
    align-items: center;
    color: var(--danger);
  }

  /* Report HTML is generated server-side and only these tags survive the
     sanitizer. Tailwind's preflight strips heading sizes, list markers, and
     table borders, so each one is restated here or the report reads as a
     single undifferentiated block of text. */
  .body {
    padding: 16px 18px 20px;
    color: var(--text);
    background: var(--surface);
    font-size: 13px;
    line-height: 1.6;
  }

  .body :global(a) {
    color: var(--accent-strong);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .body :global(h1) {
    margin: 0 0 14px;
    font-size: 17px;
    font-weight: 650;
    letter-spacing: -0.02em;
  }

  .body :global(h2) {
    margin: 22px 0 8px;
    padding-top: 14px;
    border-top: 1px solid var(--border);
    font-size: 14px;
    font-weight: 650;
    letter-spacing: -0.015em;
  }

  /* No separator rule above the report's first heading. */
  .body :global(h2):first-child,
  .body :global(article) > :global(h2):first-child,
  .body :global(section) > :global(h2):first-child {
    margin-top: 0;
    padding-top: 0;
    border-top: 0;
  }

  .body :global(h3),
  .body :global(h4) {
    margin: 16px 0 6px;
    color: var(--accent-strong);
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 650;
    letter-spacing: 0.07em;
    text-transform: uppercase;
  }

  .body :global(p),
  .body :global(li) {
    color: var(--muted);
  }

  .body :global(p) {
    margin: 0 0 10px;
  }

  .body :global(strong) {
    color: var(--text);
    font-weight: 650;
  }

  .body :global(ul),
  .body :global(ol) {
    margin: 0 0 12px;
    padding-left: 20px;
  }

  .body :global(ul) {
    list-style: disc outside;
  }

  .body :global(ol) {
    list-style: decimal outside;
  }

  .body :global(li) {
    margin-bottom: 5px;
  }

  .body :global(li)::marker {
    color: var(--border-strong);
  }

  .body :global(blockquote) {
    margin: 0 0 12px;
    padding-left: 12px;
    border-left: 2px solid color-mix(in srgb, var(--accent) 45%, var(--border));
    color: var(--muted);
  }

  .body :global(code) {
    padding: 1px 5px;
    border-radius: 4px;
    background: var(--surface-2);
    font-family: var(--mono);
    font-size: 12px;
  }

  .body :global(pre) {
    margin: 0 0 12px;
    padding: 12px;
    overflow-x: auto;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
    font-family: var(--mono);
    font-size: 12px;
  }

  .body :global(pre) :global(code) {
    padding: 0;
    background: none;
  }

  /* Wide tables scroll inside the report instead of stretching the page. */
  .body :global(table) {
    display: block;
    max-width: 100%;
    margin: 0 0 12px;
    overflow-x: auto;
    border-collapse: collapse;
    font-size: 12px;
  }

  .body :global(th),
  .body :global(td) {
    padding: 7px 10px;
    border: 1px solid var(--border);
    text-align: left;
    vertical-align: top;
  }

  .body :global(th) {
    background: var(--surface-2);
    color: var(--text);
    font-weight: 650;
  }

  .body :global(td) {
    color: var(--muted);
  }

  .body :global(section) + :global(section) {
    margin-top: 16px;
  }
</style>
