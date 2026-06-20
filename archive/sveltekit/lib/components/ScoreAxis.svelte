<script lang="ts">
  export let label: string;
  export let value: number;
  $: filled = Math.round(value * 5);
</script>

<div class="grid grid-cols-[5.2rem_1fr_2.5rem] items-center gap-3">
  <span class="text-[11px] font-medium text-[#60645f]">{label}</span>
  <span class="grid grid-cols-5 gap-1" aria-label={`${label} ${Math.round(value * 100)} percent`}>
    {#each Array(5) as _, index}
      <span class="h-1.5 rounded-[2px]" class:bg-[#a7622a]={index < filled} class:bg-[#ddd8ce]={index >= filled}></span>
    {/each}
  </span>
  <span class="text-right font-mono text-[11px] text-[#4d514d]">{Math.round(value * 100)}</span>
</div>
