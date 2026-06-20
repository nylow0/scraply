<script lang="ts">
  import { enhance } from "$app/forms";
  import { navigating } from "$app/stores";
  import IdeaRow from "$lib/components/IdeaRow.svelte";
  import TreeBranch from "$lib/components/TreeBranch.svelte";
  import type { IdeaBucket } from "$lib/server/workspace";
  import type { ActionData, PageData } from "./$types";

  export let data: PageData;
  export let form: ActionData;

  const buckets: Array<{ id: IdeaBucket; label: string; note: string }> = [
    { id: "sweet-spot", label: "Sweet spot", note: "Demand without crowded supply" },
    { id: "creative-outlier", label: "Creative outliers", note: "High-novelty directions" },
    { id: "safe-bet", label: "Safe bets", note: "Grounded, lower-risk options" },
  ];
  let activeBucket: IdeaBucket = "sweet-spot";
  let researchPending = false;
  $: activeBucketMeta = buckets.find((bucket) => bucket.id === activeBucket) ?? buckets[0]!;

  function researchEnhance() {
    researchPending = true;
    return async ({ update }: { update: () => Promise<void> }) => {
      await update();
      researchPending = false;
    };
  }
</script>

<svelte:head>
  <title>Scraply — Research tree</title>
  <meta name="description" content="Private local research and idea workspace" />
</svelte:head>

{#if $navigating}
  <div class="route-loader fixed inset-x-0 top-0 z-20 h-0.5 bg-[#a7622a]" aria-label="Loading branch"></div>
  <div class="fixed inset-0 z-10 bg-[#f2efe8]/95 px-4 pt-24 sm:px-6 lg:px-8" aria-hidden="true">
    <div class="skeleton-pulse mx-auto grid max-w-[1436px] gap-6 lg:grid-cols-[17rem_minmax(0,1fr)] xl:grid-cols-[19rem_minmax(0,1fr)]">
      <div class="space-y-3 border-y border-[#d4cfc5] py-5">
        <div class="h-2 w-24 bg-[#d5d0c6]"></div>
        <div class="h-12 bg-[#dfdad0]"></div>
        <div class="h-12 w-[86%] bg-[#dfdad0]"></div>
      </div>
      <div class="space-y-6 border-t border-[#bdb7ad] pt-6">
        <div class="h-3 w-36 bg-[#d5d0c6]"></div>
        <div class="h-9 w-[58%] bg-[#d9d4ca]"></div>
        <div class="h-3 w-[78%] bg-[#dfdad0]"></div>
        <div class="grid grid-cols-2 gap-px bg-[#d4cfc5] sm:grid-cols-4">
          {#each Array(4) as _}<div class="h-20 bg-[#ebe7de]"></div>{/each}
        </div>
      </div>
    </div>
  </div>
{/if}

<main class="mx-auto min-h-[100dvh] max-w-[1500px] px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
  <header class="mb-5 flex items-end justify-between border-b border-[#d4cfc5] pb-5 lg:mb-7">
    <div class="flex items-center gap-4">
      <div class="grid h-9 w-9 place-items-center border border-[#b9b3a9] bg-[#e9e4da]" aria-hidden="true">
        <svg viewBox="0 0 24 24" class="h-5 w-5 text-[#8c4e20]" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M5 5h6v6H5zM13 13h6v6h-6zM11 8h4a2 2 0 0 1 2 2v3M8 11v4a2 2 0 0 0 2 2h3" />
        </svg>
      </div>
      <div>
        <p class="font-mono text-[10px] uppercase tracking-[0.16em] text-[#7d817b]">Private local workspace</p>
        <h1 class="mt-1 text-[22px] font-semibold tracking-[-0.035em] text-[#202322]">Scraply</h1>
      </div>
    </div>
    <div class="hidden text-right sm:block">
      <p class="font-mono text-[10px] uppercase tracking-[0.12em] text-[#7d817b]">Persistent store</p>
      <p class="mt-1 text-[12px] font-medium text-[#4c504c]">Local JSON · no cloud sync</p>
    </div>
  </header>

  {#if form?.message}
    <section
      class="mb-5 grid gap-2 border-l-2 px-4 py-3 text-[13px]"
      class:border-[#a7622a]={form.success || form.warning}
      class:bg-[#eee3d8]={form.success || form.warning}
      class:border-[#9b493d]={!form.success && !form.warning}
      class:bg-[#f0dedb]={!form.success && !form.warning}
      role="status"
    >
      <strong>{form.message}</strong>
      {#if form.detail}<span class="font-mono text-[11px] leading-5 text-[#6f5141]">{form.detail}</span>{/if}
      {#if form.childId}<a class="w-fit border-b border-current font-semibold" href={`?node=${form.childId}`}>Open the new branch</a>{/if}
    </section>
  {/if}

  {#if data.workspaceError}
    <section class="mx-auto mt-20 max-w-2xl border-t-2 border-[#9b493d] py-8">
      <p class="font-mono text-[10px] uppercase tracking-[0.14em] text-[#8b4036]">Store error</p>
      <h2 class="mt-3 text-2xl font-semibold tracking-[-0.03em]">{data.workspaceError.message}</h2>
      <p class="mt-3 text-[14px] leading-6 text-[#626662]">{data.workspaceError.detail}</p>
      <p class="mt-5 text-[12px] text-[#777b76]">Fix the local JSON store or SCRAPLY_STORE_PATH, then reload. Nothing was sent outside this machine.</p>
    </section>
  {:else if data.workspace && !data.workspace.selected}
    <section class="grid min-h-[62vh] items-center gap-10 lg:grid-cols-[1.35fr_.65fr]">
      <div class="max-w-3xl border-t border-[#bdb7ad] pt-8">
        <p class="font-mono text-[10px] uppercase tracking-[0.16em] text-[#8c4e20]">The store is ready</p>
        <h2 class="mt-4 max-w-[18ch] text-balance text-4xl font-semibold leading-[1.02] tracking-[-0.05em] sm:text-5xl">No research branches exist yet.</h2>
        <p class="mt-6 max-w-[60ch] text-[15px] leading-7 text-[#616560]">Create the first research node through the CLI or the deep-research skill. This UI starts working from the same local store immediately; it does not invent sample ideas or hide missing provider setup.</p>
      </div>
      <div class="border-l border-[#d4cfc5] pl-6 lg:pl-8">
        <p class="font-mono text-[10px] uppercase tracking-[0.14em] text-[#7d817b]">Fastest start</p>
        <code class="mt-4 block overflow-x-auto border-y border-[#d4cfc5] py-4 font-mono text-[12px] text-[#414541]">bun start -- research-all --input brief.json</code>
        <p class="mt-4 text-[12px] leading-5 text-[#747873]">Provider keys are required for live research. Browsing and rating remain local once data exists.</p>
      </div>
    </section>
  {:else if data.workspace?.selected}
    {@const selected = data.workspace.selected}
    {@const node = selected.node}
    <div class="grid gap-6 lg:grid-cols-[17rem_minmax(0,1fr)] xl:grid-cols-[19rem_minmax(0,1fr)]">
      <aside class="lg:sticky lg:top-6 lg:self-start">
        <div class="border-y border-[#d4cfc5] py-4">
          <div class="mb-4 flex items-center justify-between px-1">
            <h2 class="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[#656964]">Research tree</h2>
            <span class="font-mono text-[10px] text-[#858983]">{data.workspace.tree.nodes.length} NODE{data.workspace.tree.nodes.length === 1 ? "" : "S"}</span>
          </div>
          <ul class="max-h-[48vh] space-y-0.5 overflow-y-auto pr-1 lg:max-h-[65vh]">
            <TreeBranch nodes={data.workspace.tree.nodes} selectedId={node.id} />
          </ul>
        </div>
        <div class="mt-5 hidden px-1 lg:block">
          <p class="font-mono text-[10px] uppercase tracking-[0.13em] text-[#858983]">Preference signal</p>
          <p class="mt-2 text-[12px] leading-5 text-[#656964]">{selected.preferenceContext.summary}</p>
        </div>
      </aside>

      <section class="min-w-0">
        <nav aria-label="Active branch" class="mb-5 flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-[0.08em] text-[#7d817b]">
          {#each selected.path as item, index}
            {#if index > 0}<span aria-hidden="true" class="text-[#aaa59b]">/</span>{/if}
            <a href={`?node=${item.id}`} class:item-current={item.id === node.id} class="border-b border-transparent hover:border-[#a7622a] hover:text-[#6d3b16]">{item.topic}</a>
          {/each}
        </nav>

        <div class="grid gap-8 border-t border-[#bdb7ad] pt-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(18rem,.6fr)]">
          <div>
            <div class="flex flex-wrap items-center gap-3">
              <span class="border border-[#c9b8a6] bg-[#eee2d5] px-2 py-1 font-mono text-[10px] uppercase tracking-[0.09em] text-[#78451e]">{node.status.replaceAll("-", " ")}</span>
              <span class="font-mono text-[10px] text-[#858983]">NODE {node.id}</span>
            </div>
            <h2 class="mt-4 max-w-[22ch] text-balance text-3xl font-semibold leading-[1.06] tracking-[-0.045em] sm:text-4xl">{node.brief.topic}</h2>
            <p class="mt-5 max-w-[70ch] text-[15px] leading-7 text-[#5e625e]">{node.brief.objective}</p>
            {#if node.brief.audience}<p class="mt-3 text-[12px] text-[#787c77]"><strong class="text-[#4d514d]">Audience</strong> · {node.brief.audience}</p>{/if}
          </div>

          <div class="grid grid-cols-2 border-y border-[#d4cfc5] sm:grid-cols-4 xl:grid-cols-2">
            <div class="border-b border-r border-[#d4cfc5] p-4">
              <p class="font-mono text-[10px] uppercase text-[#858983]">Budget</p>
              <p class="mt-2 font-mono text-lg font-semibold">${node.brief.budgetUsd.toFixed(2)}</p>
            </div>
            <div class="border-b border-[#d4cfc5] p-4 sm:border-r xl:border-r-0">
              <p class="font-mono text-[10px] uppercase text-[#858983]">Spent</p>
              <p class="mt-2 font-mono text-lg font-semibold">${node.spentUsd.toFixed(2)}</p>
            </div>
            <div class="border-r border-[#d4cfc5] p-4 sm:border-r xl:border-b">
              <p class="font-mono text-[10px] uppercase text-[#858983]">Coverage</p>
              <p class="mt-2 font-mono text-lg font-semibold">{Math.round(node.coverage * 100)}%</p>
            </div>
            <div class="p-4 xl:border-b xl:border-[#d4cfc5]">
              <p class="font-mono text-[10px] uppercase text-[#858983]">Depth</p>
              <p class="mt-2 font-mono text-lg font-semibold">{node.depth}</p>
            </div>
          </div>
        </div>

        <div class="mt-9 grid gap-8 xl:grid-cols-[minmax(0,1.15fr)_minmax(18rem,.85fr)]">
          <section class="border-t border-[#d4cfc5] pt-5">
            <div class="flex items-center justify-between gap-4">
              <h3 class="text-[13px] font-semibold uppercase tracking-[0.08em] text-[#4e524e]">Research synthesis</h3>
              {#if node.researchReportLink}
                <a href={node.researchReportLink} target="_blank" rel="noreferrer" class="border-b border-[#a7622a] text-[11px] font-semibold text-[#75431d]">Open report</a>
              {/if}
            </div>
            {#if node.synthesis}
              <p class="mt-4 whitespace-pre-line text-[13px] leading-6 text-[#646864]">{node.synthesis.summary}</p>
              <p class="mt-3 font-mono text-[10px] text-[#8a8e88]">{node.synthesis.model}{node.synthesis.fallback ? " · FALLBACK" : ""}</p>
            {:else}
              <div class="mt-4 border-l border-[#c9c3b8] pl-4">
                <p class="text-[13px] text-[#6d716c]">No synthesis exists for this branch yet.</p>
                {#if node.status === "pending"}
                  <form method="POST" action="?/research" use:enhance={researchEnhance} class="mt-4">
                    <input type="hidden" name="id" value={node.id} />
                    <button disabled={researchPending} class="border border-[#bdb7ad] bg-[#f8f6f1] px-3 py-2 text-[12px] font-semibold transition-[transform,opacity,background-color] hover:bg-[#eae4da] active:translate-y-px disabled:opacity-50">
                      {researchPending ? "Starting research" : "Run research"}
                    </button>
                  </form>
                {/if}
              </div>
            {/if}
            {#if node.researchReportPath}<p class="mt-4 break-all font-mono text-[10px] leading-4 text-[#8a8e88]">{node.researchReportPath}</p>{/if}
          </section>

          <section class="border-t border-[#d4cfc5] pt-5">
            <h3 class="text-[13px] font-semibold uppercase tracking-[0.08em] text-[#4e524e]">Stream status</h3>
            {#if node.streamRuns.length > 0}
              <ul class="mt-3 divide-y divide-[#ddd8ce]">
                {#each node.streamRuns as run}
                  <li class="grid grid-cols-[1fr_auto] gap-3 py-2.5 text-[11px]">
                    <span><strong>{run.stream.name}</strong><span class="ml-2 text-[#7a7e78]">{Math.round(run.coverage * 100)}% coverage</span></span>
                    <span class="font-mono uppercase text-[#777b76]">{run.status}</span>
                    {#if run.error}<span class="col-span-2 text-[#8b4036]">{run.error}</span>{/if}
                  </li>
                {/each}
              </ul>
            {:else}
              <p class="mt-4 text-[12px] leading-5 text-[#747873]">No stream runs have been recorded.</p>
            {/if}
          </section>
        </div>

        {#if node.brief.inheritedContext}
          <details class="mt-9 border-y border-[#d4cfc5] py-4">
            <summary class="cursor-pointer select-none text-[12px] font-semibold text-[#4d514d]">Inherited branch context · {node.brief.inheritedContext.ancestorClaims.length} claims</summary>
            <div class="mt-5 grid gap-6 md:grid-cols-2">
              <div>
                <p class="font-mono text-[10px] uppercase tracking-[0.12em] text-[#858983]">Ancestor summaries</p>
                <ul class="mt-3 space-y-3 text-[12px] leading-5 text-[#666a66]">
                  {#each node.brief.inheritedContext.ancestorSummaries as summary}
                    <li><span class="font-mono text-[10px] text-[#8a8e88]">{summary.nodeId}</span><br />{summary.summary}</li>
                  {/each}
                </ul>
              </div>
              {#if node.brief.inheritedContext.selectedIdea}
                <div class="border-l border-[#d4cfc5] pl-5">
                  <p class="font-mono text-[10px] uppercase tracking-[0.12em] text-[#858983]">Selected idea</p>
                  <p class="mt-3 text-[13px] font-semibold">{node.brief.inheritedContext.selectedIdea.title}</p>
                  <p class="mt-2 text-[12px] leading-5 text-[#666a66]">{node.brief.inheritedContext.selectedIdea.description}</p>
                </div>
              {/if}
            </div>
          </details>
        {/if}

        <section class="mt-11">
          <div class="flex flex-col gap-5 border-t-2 border-[#2f3230] pt-5 md:flex-row md:items-end md:justify-between">
            <div>
              <p class="font-mono text-[10px] uppercase tracking-[0.14em] text-[#8c4e20]">Director output</p>
              <h2 class="mt-2 text-2xl font-semibold tracking-[-0.035em]">Idea field</h2>
            </div>
            <div class="flex max-w-full gap-1 overflow-x-auto pb-1" role="tablist" aria-label="Idea buckets">
              {#each buckets as bucket}
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeBucket === bucket.id}
                  on:click={() => activeBucket = bucket.id}
                  class="shrink-0 border px-3 py-2 text-left transition-[transform,background-color] duration-200 active:translate-y-px"
                  class:border-[#a7622a]={activeBucket === bucket.id}
                  class:bg-[#a7622a]={activeBucket === bucket.id}
                  class:text-white={activeBucket === bucket.id}
                  class:border-[#ccc6bc]={activeBucket !== bucket.id}
                  class:hover:bg-[#e9e3d9]={activeBucket !== bucket.id}
                >
                  <span class="block text-[11px] font-semibold">{bucket.label}</span>
                  <span class="mt-0.5 block font-mono text-[9px] opacity-70">{selected.ideasByBucket[bucket.id].length} IDEAS</span>
                </button>
              {/each}
            </div>
          </div>

          <p class="mt-4 font-mono text-[10px] uppercase tracking-[0.1em] text-[#858983]">{activeBucketMeta.note}</p>
          <div class="mt-5">
            {#if selected.ideasByBucket[activeBucket].length > 0}
              {#each selected.ideasByBucket[activeBucket] as idea}
                <IdeaRow {idea} parentId={node.id} />
              {/each}
            {:else}
              <div class="border-y border-[#d4cfc5] py-12">
                <p class="text-lg font-semibold tracking-[-0.02em]">No {activeBucketMeta.label.toLowerCase()} in this branch.</p>
                <p class="mt-2 max-w-[54ch] text-[13px] leading-6 text-[#6c706c]">This bucket is genuinely empty. Generate another evidence-backed batch through the deep-research skill; Scraply will score and deduplicate it before it appears here.</p>
              </div>
            {/if}
          </div>
        </section>
      </section>
    </div>
  {/if}
</main>
