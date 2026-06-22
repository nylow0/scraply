<script lang="ts">
  import type { Idea } from "../../shared/schemas";

  let {
    ideas = [],
    threadId = "",
    reportCount = 0,
    ideaRatings = {},
    onRefresh,
  }: {
    ideas?: Idea[];
    threadId?: string;
    reportCount?: number;
    ideaRatings?: Record<string, number>;
    onRefresh?: () => void;
  } = $props();

  let activeBucket = $state<string>("all");
  let sortBy = $state<"relevance" | "novelty" | "title">("relevance");
  let search = $state("");
  let ratings = $state<Record<string, number>>({});
  let diving = $state<string | null>(null);

  $effect(() => {
    ratings = { ...ideaRatings };
  });

  const bucketLabels: Record<string, string> = {
    "strong-fit": "Strong fit",
    "creative-outlier": "Creative outlier",
    "safe-bet": "Safe bet",
    "needs-evidence": "Needs evidence",
  };

  const axisLabels: Record<string, string> = {
    relevance: "Relevance",
    novelty: "Novelty",
    evidenceStrength: "Evidence",
    feasibility: "Feasibility",
    demand: "Demand",
    saturation: "Saturation",
  };

  const buckets = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const idea of ideas) counts.set(idea.bucket, (counts.get(idea.bucket) ?? 0) + 1);
    return [...counts.entries()];
  });

  const visible = $derived.by(() => {
    let list = activeBucket === "all" ? ideas : ideas.filter((i) => i.bucket === activeBucket);
    const query = search.trim().toLowerCase();
    if (query) {
      list = list.filter(
        (idea) =>
          idea.title.toLowerCase().includes(query) ||
          idea.description.toLowerCase().includes(query),
      );
    }
    return [...list].sort((a, b) => {
      if (sortBy === "title") return a.title.localeCompare(b.title);
      const scoreA = a.scores[sortBy] ?? 0;
      const scoreB = b.scores[sortBy] ?? 0;
      return scoreB - scoreA;
    });
  });

  async function rate(ideaId: string, rating: number) {
    ratings = { ...ratings, [ideaId]: rating };
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
    if (!threadId || diving) return;
    diving = title;
    try {
      await window.scraply.createBranch({ parentThreadId: threadId, ideaTitle: title });
      onRefresh?.();
    } finally {
      diving = null;
    }
  }
</script>

<section class="ideas">
  <header>
    <div class="head-text">
      <h2>Idea workspace</h2>
      <p>
        Compare, rate, export, and branch into deeper research.
        {#if reportCount > 0}
          <button type="button" class="inline-link" onclick={() => document.querySelector(".report")?.scrollIntoView({ behavior: "smooth" })}>
            View {reportCount} research report{reportCount === 1 ? "" : "s"} ↓
          </button>
        {/if}
      </p>
    </div>
    <button class="ghost" onclick={exportIdeas} disabled={ideas.length === 0}>
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M8 2v8M5 7l3 3 3-3" /><path d="M3 13h10" />
      </svg>
      Export JSON
    </button>
  </header>

  {#if ideas.length === 0}
    <div class="empty">
      <p class="empty-title">No ideas yet</p>
      <p class="empty-hint">Generate ideas from the header once research completes.</p>
    </div>
  {:else}
    <div class="toolbar">
      <label class="search">
        <span class="sr-only">Search ideas</span>
        <input type="search" placeholder="Search ideas…" bind:value={search} />
      </label>
      <label class="sort">
        <span>Sort by</span>
        <select bind:value={sortBy}>
          <option value="relevance">Relevance</option>
          <option value="novelty">Novelty</option>
          <option value="title">Title</option>
        </select>
      </label>
    </div>

    <div class="tabs" role="tablist" aria-label="Filter ideas by bucket">
      <button class="tab" class:active={activeBucket === "all"} role="tab" aria-selected={activeBucket === "all"} onclick={() => (activeBucket = "all")}>
        All <span class="tab-count">{ideas.length}</span>
      </button>
      {#each buckets as [bucket, count]}
        <button class="tab" class:active={activeBucket === bucket} role="tab" aria-selected={activeBucket === bucket} onclick={() => (activeBucket = bucket)}>
          {bucketLabels[bucket] ?? bucket} <span class="tab-count">{count}</span>
        </button>
      {/each}
    </div>

    {#if visible.length === 0 && ideas.length > 0}
      <p class="filter-empty">No ideas match your search in this bucket.</p>
    {/if}

    <div class="grid">
      {#if visible.length === 0}
        <div class="empty-filter">
          <p class="empty-title">No ideas in this bucket</p>
          <p class="empty-hint">Try another filter or generate more ideas.</p>
          <button class="tab-reset" onclick={() => (activeBucket = "all")}>Show all ideas</button>
        </div>
      {:else}
        {#each visible as idea (idea.id)}
        <article class="card">
          <div class="card-head">
            <h3>{idea.title}</h3>
            <span class="bucket" data-bucket={idea.bucket}>{bucketLabels[idea.bucket] ?? idea.bucket}</span>
          </div>
          <p class="desc">{idea.description}</p>

          <dl class="scores">
            {#each Object.entries(idea.scores) as [axis, value]}
              <div class="score">
                <dt>{axisLabels[axis] ?? axis}</dt>
                <div class="score-track" aria-hidden="true">
                  <span class="score-fill" style={`width:${(value / 10) * 100}%`}></span>
                </div>
                <dd aria-label={`${axisLabels[axis] ?? axis}: ${value} out of 10`}>{value}<span class="score-max">/10</span></dd>
              </div>
            {/each}
          </dl>

          <div class="card-foot">
            <div class="rating" role="group" aria-label="Rate this idea">
              {#each [1, 2, 3, 4, 5] as star}
                <button
                  class="star"
                  class:filled={(ratings[idea.id] ?? 0) >= star}
                  onclick={() => rate(idea.id, star)}
                  aria-label={`Rate ${star} of 5`}
                  aria-pressed={(ratings[idea.id] ?? 0) === star}
                >
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
                    <path d="M8 1.5l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.3 4.2 13.3l.7-4.3-3.1-3 4.3-.6z" />
                  </svg>
                </button>
              {/each}
            </div>
            <button class="branch" disabled={diving === idea.title} onclick={() => diveDeeper(idea.title)}>
              {diving === idea.title ? "Branching…" : "Dive deeper"}
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M6 3.5L10.5 8 6 12.5" />
              </svg>
            </button>
          </div>
        </article>
        {/each}
      {/if}
    </div>
  {/if}
</section>

<style>
  .ideas {
    margin: 0 var(--space-5) var(--space-3);
    padding: var(--space-5);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    background: var(--surface);
  }

  header {
    display: flex;
    justify-content: space-between;
    gap: var(--space-3);
    align-items: start;
  }

  .head-text h2 {
    margin: 0 0 3px;
    font-size: 15px;
    font-weight: 600;
    color: var(--accent-strong);
  }

  .head-text p {
    color: var(--muted);
    margin: 0;
    font-size: 12.5px;
  }

  .inline-link {
    display: inline;
    border: none;
    background: none;
    padding: 0;
    margin-left: 4px;
    color: var(--accent-strong);
    font-size: inherit;
    font-weight: 500;
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }

  .inline-link:hover {
    color: var(--accent);
  }

  .ghost {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    flex-shrink: 0;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-2);
    border-radius: var(--r-md);
    padding: 7px 12px;
    font-size: 13px;
    font-weight: 500;
    transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease), color var(--dur) var(--ease);
  }

  .ghost:hover:not(:disabled) {
    background: var(--surface-2);
    border-color: var(--border-strong);
    color: var(--text);
  }

  .ghost:disabled { opacity: 0.5; cursor: not-allowed; }

  .empty {
    margin-top: var(--space-4);
    padding: var(--space-6);
    border: 1px dashed var(--border-strong);
    border-radius: var(--r-md);
    text-align: center;
  }

  .empty-title { margin: 0; color: var(--text-2); font-size: 13px; }
  .empty-hint { margin: 4px 0 0; color: var(--muted); font-size: 12px; }

  .empty-filter {
    grid-column: 1 / -1;
    padding: var(--space-6);
    text-align: center;
    border: 1px dashed var(--border-strong);
    border-radius: var(--r-md);
  }

  .tab-reset {
    margin-top: var(--space-3);
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text-2);
    border-radius: var(--r-md);
    padding: 6px 12px;
    font-size: 12.5px;
    font-weight: 500;
  }

  .tab-reset:hover {
    border-color: var(--accent-border);
    color: var(--accent-strong);
    background: var(--accent-faint);
  }

  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    margin-top: var(--space-4);
    padding-bottom: var(--space-4);
    border-bottom: 1px solid var(--hairline);
  }

  .tab {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--muted);
    border-radius: var(--r-sm);
    padding: 5px 10px;
    font-size: 12.5px;
    font-weight: 500;
    transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
  }

  .tab:hover { background: var(--surface-2); color: var(--text); }

  .tab.active {
    background: var(--accent-faint);
    color: var(--accent-strong);
    border-color: var(--accent-border);
  }

  .tab-count {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--faint);
  }

  .tab.active .tab-count { color: var(--accent-strong); }

  .grid {
    margin-top: var(--space-4);
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: var(--space-3);
  }

  .card {
    display: grid;
    align-content: start;
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    padding: var(--space-4);
    background: var(--surface-2);
    transition: border-color var(--dur) var(--ease), transform var(--dur) var(--ease);
  }

  .card:hover {
    border-color: var(--border-strong);
  }

  .card-head {
    display: flex;
    justify-content: space-between;
    gap: var(--space-3);
    align-items: start;
  }

  h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    line-height: 1.35;
    transition: color var(--dur) var(--ease);
  }

  .card:hover h3 {
    color: var(--accent-strong);
  }

  .bucket {
    flex-shrink: 0;
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: var(--muted);
    padding: 3px 8px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--surface);
    white-space: nowrap;
  }

  .bucket[data-bucket="strong-fit"] { color: var(--accent-strong); border-color: var(--accent-border); }
  .bucket[data-bucket="creative-outlier"] { color: #c0a26f; border-color: color-mix(in srgb, #c0a26f 40%, var(--border)); }
  .bucket[data-bucket="needs-evidence"] { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 35%, var(--border)); }

  .desc {
    margin: var(--space-3) 0 0;
    color: var(--text-2);
    font-size: 13px;
    line-height: 1.55;
  }

  .scores {
    display: grid;
    gap: 7px;
    margin: var(--space-4) 0 0;
    padding: var(--space-3) 0 0;
    border-top: 1px solid var(--hairline);
  }

  .score {
    display: grid;
    grid-template-columns: 78px 1fr 38px;
    align-items: center;
    gap: var(--space-2);
  }

  dt {
    color: var(--muted);
    font-size: 11.5px;
  }

  .score-track {
    height: 4px;
    border-radius: 999px;
    background: var(--surface-3);
    overflow: hidden;
  }

  .score-fill {
    display: block;
    height: 100%;
    border-radius: 999px;
    background: var(--accent);
  }

  dd {
    margin: 0;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text);
    text-align: right;
  }

  .score-max {
    color: var(--faint);
    font-size: 10px;
  }

  .card-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    margin-top: var(--space-4);
  }

  .rating {
    display: flex;
    gap: 2px;
  }

  .star {
    display: grid;
    place-items: center;
    border: none;
    background: transparent;
    color: var(--faint);
    padding: 3px;
    border-radius: var(--r-sm);
    transition: color var(--dur) var(--ease), transform var(--dur-fast) var(--ease);
  }

  .star:hover { color: var(--accent); }
  .star:active { transform: scale(0.9); }
  .star.filled { color: var(--accent-strong); }

  .branch {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--accent-strong);
    border-radius: var(--r-sm);
    padding: 5px 8px;
    font-size: 12.5px;
    font-weight: 500;
    transition: background var(--dur) var(--ease);
  }

  .branch:hover { background: var(--accent-faint); }
  .branch svg { transition: transform var(--dur) var(--ease); }
  .branch:hover svg { transform: translateX(2px); }

  .star:focus-visible,
  .branch:focus-visible,
  .tab:focus-visible,
  .ghost:focus-visible {
    outline: 2px solid var(--accent-strong);
    outline-offset: 2px;
  }

  @media (max-width: 640px) {
    .ideas { margin: 0 var(--space-3) var(--space-3); padding: var(--space-4); }
    .grid { grid-template-columns: 1fr; }
  }
</style>
