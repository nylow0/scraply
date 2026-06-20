<script lang="ts">
  import type { Idea } from "../../shared/schemas";

  let {
    ideas = [],
    threadId = "",
    onRefresh,
  }: {
    ideas?: Idea[];
    threadId?: string;
    onRefresh?: () => void;
  } = $props();

  async function rate(ideaId: string, rating: number) {
    await window.scraply.rateIdea({ ideaId, rating });
  }

  async function exportIdeas() {
    if (!threadId) return;
    const payload = await window.scraply.exportIdeas(threadId);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "scraply-ideas.json";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function diveDeeper(title: string) {
    if (!threadId) return;
    await window.scraply.createBranch({ parentThreadId: threadId, ideaTitle: title });
    onRefresh?.();
  }
</script>

<section class="ideas">
  <header>
    <div>
      <h2>Idea workspace</h2>
      <p>Compare, rate, export, and branch into deeper research.</p>
    </div>
    <button class="ghost" onclick={exportIdeas}>Export JSON</button>
  </header>

  {#if ideas.length === 0}
    <p class="muted">Generate ideas from the header once research completes.</p>
  {:else}
    <div class="grid">
      {#each ideas as idea (idea.id)}
        <article class="card">
          <div class="row">
            <h3>{idea.title}</h3>
            <span class="bucket">{idea.bucket}</span>
          </div>
          <p>{idea.description}</p>
          <dl class="scores">
            {#each Object.entries(idea.scores) as [axis, value]}
              <div><dt>{axis}</dt><dd>{value}/10</dd></div>
            {/each}
          </dl>
          <div class="rating">
            {#each [1, 2, 3, 4, 5] as star}
              <button onclick={() => rate(idea.id, star)} aria-label={`Rate ${star}`}>{star}</button>
            {/each}
            <button class="branch" onclick={() => diveDeeper(idea.title)}>Dive deeper</button>
          </div>
        </article>
      {/each}
    </div>
  {/if}
</section>

<style>
  .ideas {
    margin: 0 20px 12px;
    padding: 16px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
  }

  header {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: start;
  }

  header h2 {
    margin: 0 0 4px;
    font-size: 14px;
  }

  header p,
  .muted {
    color: var(--muted);
    margin: 0;
  }

  .grid {
    margin-top: 12px;
    display: grid;
    gap: 10px;
  }

  .card {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px;
    background: var(--surface-2);
  }

  .row {
    display: flex;
    justify-content: space-between;
    gap: 8px;
  }

  h3 {
    margin: 0;
    font-size: 14px;
  }

  .bucket {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--accent-strong);
  }

  .scores {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
    margin: 12px 0 0;
  }

  .scores div {
    display: grid;
    gap: 2px;
  }

  dt {
    color: var(--muted);
    font-size: 11px;
    text-transform: capitalize;
  }

  dd {
    margin: 0;
    font-family: var(--mono);
    font-size: 12px;
  }

  .rating {
    display: flex;
    gap: 6px;
    margin-top: 10px;
    align-items: center;
  }

  .rating button {
    border: 1px solid var(--border);
    background: transparent;
    color: var(--muted);
    border-radius: 6px;
    width: 28px;
    height: 28px;
  }

  .rating button.branch {
    width: auto;
    padding: 0 10px;
    margin-left: auto;
    color: var(--accent-strong);
  }

  button.ghost {
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text);
    border-radius: 8px;
    padding: 8px 12px;
  }
</style>
