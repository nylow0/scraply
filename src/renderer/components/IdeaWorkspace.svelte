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

  function formatScoreLabel(axis: string) {
    return axis
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[-_]+/g, " ")
      .toLowerCase();
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

<section class="ideas" aria-labelledby="idea-workspace-title">
  <header>
    <div>
      <p class="eyebrow">Decision workspace</p>
      <h2 id="idea-workspace-title">Idea workspace</h2>
      <p>Compare the strongest directions, inspect their evidence, and choose what deserves deeper research.</p>
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
              <div><dt>{formatScoreLabel(axis)}</dt><dd>{value}<span>/10</span></dd></div>
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

          <div class="card-footer">
            <div class="rating" aria-label={`Current rating ${ratings[idea.id] ?? "not rated"}`}>
              <span class="rating-label">Your rating</span>
              <div class="rating-buttons">
                {#each [1, 2, 3, 4, 5] as star}
                  <button
                    class:active={ratings[idea.id] === star}
                    disabled={ratingPending[idea.id]}
                    onclick={() => rate(idea.id, star)}
                    aria-label={`Rate ${star}`}
                    aria-pressed={ratings[idea.id] === star}
                  >{star}</button>
                {/each}
              </div>
              {#if ratingPending[idea.id]}
                <span class="saved">Saving…</span>
              {:else if ratingSaved[idea.id] || ratings[idea.id]}
                <span class="saved">Saved: {ratings[idea.id]}/5</span>
              {/if}
            </div>
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
    padding-top: clamp(26px, 3vw, 40px);
  }

  header,
  .row,
  .rating,
  .card-footer {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  header,
  .row {
    justify-content: space-between;
  }

  header h2 {
    margin: 0;
    font-size: clamp(20px, 2vw, 27px);
    letter-spacing: -0.035em;
  }

  h3 {
    margin: 0;
    font-size: 15px;
    line-height: 1.3;
    letter-spacing: -0.015em;
  }

  header > div > p:last-child,
  .card > p {
    margin: 6px 0 0;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.55;
  }

  header > div > p:last-child {
    max-width: 64ch;
  }

  .eyebrow {
    margin: 0 0 8px;
    color: var(--accent-strong);
    font-family: var(--mono);
    font-size: 10px;
    font-weight: 650;
    letter-spacing: 0.09em;
    text-transform: uppercase;
  }

  .grid {
    margin-top: 22px;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px;
  }

  .card {
    display: flex;
    flex-direction: column;
    min-width: 0;
    padding: clamp(16px, 2vw, 20px);
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
    transition:
      transform 180ms var(--ease),
      border-color 180ms var(--ease),
      background-color 180ms var(--ease);
  }

  .card:hover {
    transform: translateY(-2px);
    border-color: var(--border-strong);
    background: color-mix(in srgb, var(--surface) 92%, var(--accent));
  }

  .bucket {
    flex: 0 0 auto;
    padding: 4px 7px;
    border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--border));
    border-radius: 999px;
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    color: var(--accent-strong);
    font: 10px var(--mono);
    white-space: nowrap;
  }

  .scores {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    margin: 16px 0 12px;
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
  }

  .scores div {
    min-width: 0;
    padding: 9px 8px;
  }

  .scores div:not(:nth-child(3n + 1)) {
    border-left: 1px solid var(--border);
  }

  .scores div:nth-child(n + 4) {
    border-top: 1px solid var(--border);
  }

  dt {
    overflow: hidden;
    color: var(--muted);
    font-size: 9px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  dd {
    margin: 3px 0 0;
    font: 600 13px var(--mono);
  }

  dd span {
    color: var(--subtle);
    font-size: 9px;
    font-weight: 400;
  }

  .evidence {
    margin: 0 0 14px;
    color: var(--muted);
    font-size: 12px;
  }

  .evidence summary {
    width: fit-content;
    cursor: pointer;
    transition: color 180ms var(--ease);
  }

  .evidence summary:hover {
    color: var(--text);
  }

  .evidence ul { padding-left: 18px; }
  .evidence li + li { margin-top: 8px; }
  .evidence-link { padding: 0; border: 0; color: var(--accent-strong); background: transparent; text-align: left; }
  blockquote { margin: 4px 0 0; padding-left: 8px; border-left: 2px solid var(--border); }

  .card-footer {
    align-items: flex-end;
    justify-content: space-between;
    margin-top: auto;
    padding-top: 14px;
    border-top: 1px solid var(--border);
  }

  .rating {
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .rating-label {
    flex-basis: 100%;
    color: var(--muted);
    font-size: 10px;
  }

  .rating-buttons {
    display: flex;
    gap: 5px;
  }

  .rating button {
    min-width: 30px;
    padding-inline: 8px;
  }

  .rating button.active { border-color: var(--accent-strong); color: var(--accent-strong); }
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

  @media (max-width: 1180px) {
    .grid {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 680px) {
    header {
      align-items: flex-start;
      flex-direction: column;
    }

    .row {
      align-items: flex-start;
    }

    .card-footer {
      align-items: stretch;
      flex-direction: column;
    }

    .branch {
      width: 100%;
    }
  }
</style>
