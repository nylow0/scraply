<script lang="ts">
  import { enhance } from "$app/forms";
  import type { WorkspaceIdea } from "$lib/server/workspace";
  import ScoreAxis from "./ScoreAxis.svelte";

  export let idea: WorkspaceIdea;
  export let parentId: string;
  let pending: "rating" | "dive" | null = null;

  function tracked(kind: "rating" | "dive") {
    return () => {
      pending = kind;
      return async ({ update }: { update: () => Promise<void> }) => {
        await update();
        pending = null;
      };
    };
  }
</script>

<article class="reveal border-t border-[#d9d4ca] py-7 first:border-t-0 first:pt-2">
  <div class="grid gap-7 xl:grid-cols-[minmax(0,1.2fr)_minmax(17rem,.8fr)]">
    <div class="min-w-0">
      <div class="flex items-start justify-between gap-5">
        <div>
          <p class="mb-2 font-mono text-[10px] uppercase tracking-[0.13em] text-[#8b5a31]">{idea.bucket.replaceAll("-", " ")}</p>
          <h3 class="text-balance text-xl font-semibold tracking-[-0.025em] text-[#202322]">{idea.title}</h3>
        </div>
        <span class="shrink-0 border border-[#d4c2b0] bg-[#f2e6da] px-2 py-1 font-mono text-[10px] text-[#75431d]">
          {idea.rating === null ? "UNRATED" : `${Math.round(idea.rating * 5)}/5`}
        </span>
      </div>
      <p class="mt-3 max-w-[68ch] text-[14px] leading-6 text-[#5d615d]">{idea.description}</p>

      <details class="mt-5 border-l border-[#cfc9be] pl-4">
        <summary class="cursor-pointer select-none text-[12px] font-semibold text-[#4f534f]">
          {idea.supportingClaims.length} supporting claim{idea.supportingClaims.length === 1 ? "" : "s"}
        </summary>
        {#if idea.supportingClaims.length > 0}
          <ul class="mt-3 space-y-3">
            {#each idea.supportingClaims as claim}
              <li class="text-[12px] leading-5 text-[#666a66]">
                <span class="mr-2 font-mono text-[10px] text-[#8a8e88]">{claim.verified ? "VERIFIED" : "UNVERIFIED"} · {Math.round(claim.confidence * 100)}</span>
                {claim.text}
              </li>
            {/each}
          </ul>
        {:else}
          <p class="mt-2 text-[12px] text-[#7a7e78]">No claim IDs were attached by the director.</p>
        {/if}
      </details>
    </div>

    <div class="space-y-5 border-l border-[#ded9cf] pl-0 xl:pl-7">
      <div class="space-y-2.5">
        <ScoreAxis label="Relevance" value={idea.scores.relevance} />
        <ScoreAxis label="Novelty" value={idea.scores.novelty} />
        <ScoreAxis label="Demand" value={idea.scores.demand} />
        <ScoreAxis label="Supply" value={idea.scores.supply} />
      </div>

      <form method="POST" action="?/rate" use:enhance={tracked("rating")} class="flex items-center gap-2">
        <input type="hidden" name="ideaId" value={idea.id} />
        <span class="mr-1 text-[11px] font-semibold text-[#60645f]">Rate</span>
        {#each [1, 2, 3, 4, 5] as rating}
          <button
            type="submit"
            name="rating"
            value={rating / 5}
            aria-label={`Rate ${idea.title} ${rating} out of 5`}
            disabled={pending !== null}
            class="h-7 w-7 border text-[11px] font-semibold transition-[transform,opacity,background-color] duration-150 active:translate-y-px disabled:opacity-50"
            class:border-[#a7622a]={Math.round((idea.rating ?? 0) * 5) === rating}
            class:bg-[#a7622a]={Math.round((idea.rating ?? 0) * 5) === rating}
            class:text-white={Math.round((idea.rating ?? 0) * 5) === rating}
            class:border-[#d3cec4]={Math.round((idea.rating ?? 0) * 5) !== rating}
            class:hover:bg-[#e7ded3]={Math.round((idea.rating ?? 0) * 5) !== rating}
          >{rating}</button>
        {/each}
        {#if pending === "rating"}<span class="font-mono text-[10px] text-[#777b76]">SAVING</span>{/if}
      </form>

      <form method="POST" action="?/dive" use:enhance={tracked("dive")}>
        <input type="hidden" name="parentId" value={parentId} />
        <input type="hidden" name="focusTopic" value={idea.id} />
        <button
          type="submit"
          disabled={pending !== null}
          class="group flex w-full items-center justify-between border border-[#bdb7ad] bg-[#f8f6f1] px-3 py-2.5 text-left text-[12px] font-semibold text-[#313431] transition-[transform,opacity,background-color] duration-200 hover:bg-[#ebe5db] active:translate-y-px disabled:opacity-50"
        >
          <span>{pending === "dive" ? "Creating branch" : "Open deeper branch"}</span>
          <svg aria-hidden="true" viewBox="0 0 16 16" class="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M3 8h9M9 4l4 4-4 4" />
          </svg>
        </button>
        <p class="mt-2 text-[10px] leading-4 text-[#7b7f79]">Inherits this idea and ancestor claims. New ideas remain deduplicated across the full tree.</p>
      </form>
    </div>
  </div>
</article>
