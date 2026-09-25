<script lang="ts">
  import Icon from "./Icon.svelte";
  let { query = $bindable(""), label, count }: { query?: string; label: string; count: number } = $props();
</script>
<div class="result-toolbar">
  <label><Icon name="search" size={16} /><input bind:value={query} aria-label={label} placeholder={label} />{#if query}<button onclick={() => query = ""} aria-label="Clear filter"><Icon name="close" size={14} /></button>{/if}</label>
  <span>{count} {count === 1 ? "result" : "results"}</span>
</div>
<style>
  .result-toolbar { display:flex;justify-content:space-between;align-items:center;gap:16px;margin:24px 0 14px; }
  label { display:flex;align-items:center;gap:9px;color:var(--subtle);background:var(--surface);border:1px solid var(--border);padding:9px 12px;border-radius:8px;width:min(340px,75%); }
  label:focus-within { border-color:rgb(255 255 255 / .38);box-shadow:0 0 0 3px rgb(255 255 255 / .05); }
  input { width:100%;min-width:0;border:0;background:transparent;color:var(--text);outline:none;font-size:13px; }
  input:focus { box-shadow:none; }
  button { display:grid;place-items:center;border:0;background:transparent;color:var(--muted);padding:0; }
  .result-toolbar > span { color:var(--subtle);font-size:13px; }
</style>
