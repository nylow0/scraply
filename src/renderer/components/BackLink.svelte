<script lang="ts">
  import Icon from "./Icon.svelte";
  let { destination, onclick }: { destination: string; onclick: () => void } = $props();
</script>

<button class="back" aria-label={`Back to ${destination}`} {onclick}><Icon name="back" size={20} />Back</button>

<style>
  .back { display:inline-flex;align-items:center;gap:10px;min-height:38px;padding:9px 12px;border:0;border-radius:7px;background:transparent;color:var(--muted);font-size:13px;text-align:left;cursor:pointer;transition:background 120ms,color 120ms; }
  .back:hover,.back:focus-visible { color:var(--text);background:var(--surface-2); }
  .back :global(svg) { transition:transform 120ms; }
  .back:hover :global(svg) { transform:translateX(-2px); }
  @media (prefers-reduced-motion:reduce) { .back,.back :global(svg) { transition:none; } }
</style>
