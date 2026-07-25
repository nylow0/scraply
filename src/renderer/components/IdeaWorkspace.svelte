<script lang="ts">
  import type { Idea } from "../../shared/schemas";
  import { toCreateBranchPayload } from "../lib/ipc-payloads";
  import BranchSetupDialog from "./BranchSetupDialog.svelte";

  let {
    ideas = [],
    threadId = "",
    onRefresh,
  }: {
    ideas?: Idea[];
    threadId?: string;
    onRefresh?: () => void;
  } = $props();

  let ratings = $state<Record<string, number>>({});
  let ratingPending = $state<Record<string, boolean>>({});
  let ratingSaved = $state<Record<string, boolean>>({});
  let ideaDetails = $state<Record<string, Idea>>({});
  let detailPending = $state<Record<string, boolean>>({});
  let detailErrors = $state<Record<string, string | null>>({});
  let branchPending = $state<Record<string, boolean>>({});
  let branchIdea = $state<Idea | null>(null);
  let exporting = $state(false);
  let error = $state<string | null>(null);

  $effect(() => {
    const next = { ...ratings };
    let changed = false;
    for (const idea of ideas) {
      if (next[idea.id] === undefined && idea.currentRating) {
        next[idea.id] = idea.currentRating.rating;
        changed = true;
      }
    }
    if (changed) ratings = next;
  });

  async function rate(ideaId: string, rating: number) {
    if (ratingPending[ideaId]) return;
    ratingPending = { ...ratingPending, [ideaId]: true };
    ratingSaved = { ...ratingSaved, [ideaId]: false };
    error = null;
    try {
      const saved = await window.scraply.rateIdea({ ideaId, rating });
      ratings = { ...ratings, [ideaId]: saved.rating };
      ratingSaved = { ...ratingSaved, [ideaId]: true };
    } catch (reason) {
      error = reason instanceof Error ? reason.message : "Failed to save rating";
    } finally {
      ratingPending = { ...ratingPending, [ideaId]: false };
    }
  }

  async function loadIdeaDetail(ideaId: string) {
    if (ideaDetails[ideaId] || detailPending[ideaId]) return;
    detailPending = { ...detailPending, [ideaId]: true };
    detailErrors = { ...detailErrors, [ideaId]: null };
    try {
      const detail = await window.scraply.getIdeaDetail(ideaId);
      ideaDetails = { ...ideaDetails, [ideaId]: detail };
      if (detail.currentRating) ratings = { ...ratings, [ideaId]: detail.currentRating.rating };
    } catch (reason) {
      detailErrors = {
        ...detailErrors,
        [ideaId]: reason instanceof Error ? reason.message : "Failed to load idea evidence",
      };
    } finally {
      detailPending = { ...detailPending, [ideaId]: false };
    }
  }

  async function exportIdeas() {
    if (!threadId || exporting) return;
    exporting = true;
    error = null;
    try {
      const payload = await window.scraply.exportIdeas(threadId);
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "scraply-ideas.json";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      error = reason instanceof Error ? reason.message : "Failed to export ideas";
    } finally {
      exporting = false;
    }
  }

  function diveDeeper(idea: Idea) {
    if (!threadId || branchPending[idea.id]) return;
    branchIdea = idea;
  }

  async function createFocusedBranch(idea: Idea, explorationAngle: string, selectedClaimIds: string[]) {
    if (!threadId || branchPending[idea.id]) return;
    branchPending[idea.id] = true;
    error = null;
    try {
      await window.scraply.createBranch(toCreateBranchPayload({
        parentThreadId: threadId,
        seedIdeaId: idea.id,
        seedIdeaTitle: idea.title,
        explorationAngle,
        selectedClaimIds,
      }));
      branchIdea = null;
      onRefresh?.();
    } catch (reason) {
      error = reason instanceof Error ? reason.message : "Failed to create branch";
    } finally {
      branchPending[idea.id] = false;
    }
  }
</script>

<section class="ideas">
  <header>
    <div>
      <h2>Idea workspace</h2>
      <p>Compare, rate, inspect evidence, export, and branch into deeper research.</p>
    </div>
    <button class="ghost" onclick={exportIdeas} disabled={exporting}>
      {exporting ? "Exporting…" : "Export JSON"}
    </button>
  </header>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  {#if ideas.length === 0}
    <p class="muted">Generate ideas from the header once research completes.</p>
  {:else}
    <div class="grid">
      {#each ideas as idea (idea.id)}
        {@const detail = ideaDetails[idea.id] ?? idea}
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

          <details
            class="evidence"
            ontoggle={(event) => {
              if ((event.currentTarget as HTMLDetailsElement).open) void loadIdeaDetail(idea.id);
            }}
          >
            <summary>
              {detail.evidence?.length
                ? `${detail.evidence.length} supporting evidence ${detail.evidence.length === 1 ? "link" : "links"}`
                : "Inspect supporting evidence"}
            </summary>
            {#if detailPending[idea.id]}
              <p>Loading evidence…</p>
            {:else if detailErrors[idea.id]}
              <p class="error" role="alert">{detailErrors[idea.id]}</p>
            {:else if detail.evidence?.length}
              <ul>
                {#each detail.evidence as item (`${item.claimId}:${item.sourceId}`)}
                  <li>
                    <button class="evidence-link" onclick={() => void window.scraply.openExternalUrl(item.url)}>
                      {item.sourceTitle}
                    </button>
                    <blockquote>{item.quote}</blockquote>
                  </li>
                {/each}
              </ul>
            {:else}
              <p>No supporting evidence was found for this idea.</p>
            {/if}
          </details>

          <div class="rating" aria-label={`Current rating ${ratings[idea.id] ?? "not rated"}`}>
            {#each [1, 2, 3, 4, 5] as star}
              <button
                class:active={ratings[idea.id] === star}
                disabled={ratingPending[idea.id]}
                onclick={() => rate(idea.id, star)}
                aria-label={`Rate ${star}`}
                aria-pressed={ratings[idea.id] === star}
              >{star}</button>
            {/each}
            {#if ratingPending[idea.id]}
              <span class="saved">Saving…</span>
            {:else if ratingSaved[idea.id] || ratings[idea.id]}
              <span class="saved">Saved: {ratings[idea.id]}/5</span>
            {/if}
            <button class="branch" disabled={branchPending[idea.id]} onclick={() => diveDeeper(idea)}>
              {branchPending[idea.id] ? "Creating branch…" : "Dive deeper"}
            </button>
          </div>
        </article>
      {/each}
    </div>
  {/if}
</section>

{#if branchIdea}
  <BranchSetupDialog
    idea={branchIdea}
    pending={branchPending[branchIdea.id] ?? false}
    onCancel={() => (branchIdea = null)}
    onSubmit={(angle, claimIds) => createFocusedBranch(branchIdea!, angle, claimIds)}
  />
{/if}

<style>
  .ideas {
    margin: 0 20px 12px;
    padding: 16px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
  }

  header,
  .row,
  .rating {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  header,
  .row {
    justify-content: space-between;
  }

  header h2,
  h3 {
    margin: 0;
    font-size: 14px;
  }

  header p,
  .card > p {
    margin: 4px 0 0;
    color: var(--muted);
    font-size: 12px;
  }

  .grid {
    margin-top: 14px;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 12px;
  }

  .card {
    padding: 14px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg);
  }

  .bucket {
    color: var(--accent-strong);
    font: 11px var(--mono);
  }

  .scores {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
    margin: 12px 0;
  }

  .scores div {
    padding: 6px;
    border-radius: 6px;
    background: var(--surface);
  }

  dt { color: var(--muted); font-size: 10px; }
  dd { margin: 2px 0 0; font: 11px var(--mono); }

  .evidence {
    margin: 10px 0;
    color: var(--muted);
    font-size: 12px;
  }

  .evidence summary { cursor: pointer; }
  .evidence ul { padding-left: 18px; }
  .evidence li + li { margin-top: 8px; }
  .evidence-link { padding: 0; border: 0; color: var(--accent-strong); background: transparent; text-align: left; }
  blockquote { margin: 4px 0 0; padding-left: 8px; border-left: 2px solid var(--border); }

  .rating { flex-wrap: wrap; margin-top: 12px; }
  .rating button { min-width: 32px; }
  .rating button.active { border-color: var(--accent-strong); color: var(--accent-strong); }
  .rating .branch { margin-left: auto; min-width: auto; }
  .saved { color: var(--muted); font-size: 11px; }

  button {
    border: 1px solid var(--border);
    border-radius: 7px;
    padding: 7px 10px;
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
  }

  button:disabled { cursor: wait; opacity: 0.6; }
  .ghost { background: transparent; }
  .error { color: var(--danger); }
  .muted { color: var(--muted); }
</style>
