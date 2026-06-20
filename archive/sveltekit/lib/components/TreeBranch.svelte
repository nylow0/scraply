<script lang="ts">
  import type { TreeNodeSummary } from "../../store/tree";

  export let nodes: TreeNodeSummary[];
  export let parentId: string | null = null;
  export let selectedId: string | null = null;

  $: children = nodes.filter((node) => node.parentId === parentId);
</script>

{#each children as node}
  <li class="list-none">
    <a
      href={`?node=${encodeURIComponent(node.id)}`}
      aria-current={node.id === selectedId ? "page" : undefined}
      class="group relative grid grid-cols-[1fr_auto] gap-3 border-l px-3 py-2.5 transition-[transform,opacity,background-color] duration-200 active:translate-y-px"
      class:border-[var(--accent)]={node.id === selectedId}
      class:bg-[#e9e4da]={node.id === selectedId}
      class:border-transparent={node.id !== selectedId}
      class:hover:bg-[#ece8df]={node.id !== selectedId}
    >
      <span class="min-w-0">
        <span class="block truncate text-[13px] font-semibold tracking-[-0.01em] text-[#2a2d2b]">{node.topic}</span>
        <span class="mt-1 block font-mono text-[10px] uppercase tracking-[0.08em] text-[#777b76]">{node.status.replaceAll("-", " ")}</span>
      </span>
      <span class="pt-0.5 text-right font-mono text-[10px] text-[#777b76]">
        D{node.depth}<br />{node.childIds.length} sub
      </span>
    </a>
    {#if node.childIds.length > 0}
      <ul class="ml-3 border-l border-[#d9d4ca] pl-1">
        <svelte:self {nodes} parentId={node.id} {selectedId} />
      </ul>
    {/if}
  </li>
{/each}
