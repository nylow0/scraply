<script lang="ts">
  import Icon from "./Icon.svelte";
  import BrandMark from "./BrandMark.svelte";
  let { canBack, canForward, onBack, onForward, onToggle, navigationOpen = true, compact = false }: {
    canBack: boolean; canForward: boolean; onBack: () => void; onForward: () => void; onToggle: () => void;
    navigationOpen?: boolean; compact?: boolean;
  } = $props();
</script>
<div class="desktop-bar">
  <div class="brand"><BrandMark size={18} /><span>Scraply</span></div>
  <button id="navigation-toggle" aria-label={compact ? navigationOpen ? "Close navigation" : "Open navigation" : "Toggle sidebar"} aria-expanded={navigationOpen} aria-controls="research-navigation" title="Toggle sidebar (Ctrl+B)" onclick={onToggle}><Icon name="sidebar" size={16} /></button>
  <button aria-label="Go back" title="Back (Alt+Left)" disabled={!canBack} onclick={onBack}><Icon name="back" size={17} /></button>
  <button aria-label="Go forward" title="Forward (Alt+Right)" disabled={!canForward} onclick={onForward}><Icon name="arrow" size={17} /></button>
</div>
<style>
  .desktop-bar { height:36px;display:flex;align-items:center;gap:2px;padding:0 148px 0 14px;background:#000;-webkit-app-region:drag;user-select:none; }
  .brand { display:flex;align-items:center;gap:8px;margin-right:14px;font-size:14px;font-weight:650;letter-spacing:-.02em; }
  .brand :global(svg) { color:var(--accent-strong); }
  button { -webkit-app-region:no-drag;display:grid;place-items:center;min-width:30px;height:28px;padding:0 8px;background:transparent;color:#999;border:0;border-radius:4px; }
  button:hover:not(:disabled) { color:#eee;background:#202020; }button:disabled { opacity:.35; }
</style>
