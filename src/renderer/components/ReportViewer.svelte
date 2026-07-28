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

  .body {
    padding: 14px;
    color: var(--text);
    background: var(--surface);
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
