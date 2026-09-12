<script lang="ts">
  import Icon from "./Icon.svelte";
  let { canBack, canForward, onBack, onForward, onToggle }: {
    canBack: boolean; canForward: boolean; onBack: () => void; onForward: () => void; onToggle: () => void;
  } = $props();
  function menu(name: "File" | "Edit" | "View" | "Help", event: MouseEvent) {
    const rect = (event.currentTarget as HTMLButtonElement).getBoundingClientRect();
    void window.scraply.showAppMenu({ menu: name, x: Math.round(rect.left), y: Math.round(rect.bottom) });
  }
</script>
<div class="desktop-bar">
  <button aria-label="Toggle sidebar" title="Toggle sidebar (Ctrl+B)" onclick={onToggle}><Icon name="sidebar" size={16} /></button>
  <button aria-label="Go back" title="Back (Alt+Left)" disabled={!canBack} onclick={onBack}><Icon name="back" size={17} /></button>
  <button aria-label="Go forward" title="Forward (Alt+Right)" disabled={!canForward} onclick={onForward}><Icon name="arrow" size={17} /></button>
  {#if !import.meta.env.VITE_SCRAPLY_BROWSER_DEV}<nav aria-label="Application menu">
    {#each ["File", "Edit", "View", "Help"] as name (name)}<button aria-haspopup="menu" onclick={(event) => menu(name as "File" | "Edit" | "View" | "Help", event)}>{name}</button>{/each}
  </nav>{/if}
</div>
<style>
  .desktop-bar { height:36px;display:flex;align-items:center;gap:2px;padding:0 148px 0 8px;background:#000;-webkit-app-region:drag;user-select:none; }
  button,nav { -webkit-app-region:no-drag; }
  button { display:grid;place-items:center;min-width:30px;height:28px;padding:0 8px;background:transparent;color:#999;border:0;border-radius:4px; }
  button:hover:not(:disabled) { color:#eee;background:#202020; }button:disabled { opacity:.35; }
  nav { display:flex;gap:1px;margin-left:10px; }nav button { font:400 13px var(--sans);padding:0 10px; }
</style>
