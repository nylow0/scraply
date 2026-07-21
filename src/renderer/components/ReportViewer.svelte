<script lang="ts">
  let {
    reportId,
    title,
  }: {
    reportId: string;
    title: string;
  } = $props();

  type ReportDetail = { id: string; streamId: string | null; title: string; html: string };
  type DetailApi = typeof window.scraply & {
    getReportDetail: (reportId: string) => Promise<ReportDetail>;
    openExternalUrl: (url: string) => Promise<void>;
  };

  let html = $state<string | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);

  async function load() {
    if (html !== null || loading) return;
    loading = true;
    error = null;
    try {
      const detail = await (window.scraply as DetailApi).getReportDetail(reportId);
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
    void (window.scraply as DetailApi).openExternalUrl(anchor.href);
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
    margin: 0 20px 12px;
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    background: var(--surface);
  }

  summary {
    padding: 12px 16px;
    cursor: pointer;
    font-weight: 500;
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
