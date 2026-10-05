<script lang="ts">
  import type { SearchProviderChoice } from "../../providers/search";
  import ProviderLogo from "./ProviderLogo.svelte";
  import Icon from "./Icon.svelte";

  let { value = $bindable<SearchProviderChoice>("auto"), connected = { exa: true, perplexity: true }, label = "Search provider", onchange }: {
    value?: SearchProviderChoice;
    connected?: { exa: boolean; perplexity: boolean };
    label?: string;
    onchange?: () => void;
  } = $props();

  const hintId = $props.id();
  const names = { auto: "Automatic", exa: "Exa", perplexity: "Perplexity" };
  const automaticHelp = "Scraply chooses Exa or Perplexity for each search based on the source it needs. It can use both during the same research.";
  let choices = $derived([
    { value: "auto" as const, enabled: connected.exa || connected.perplexity, hint: "Connect a search provider in Settings" },
    { value: "exa" as const, enabled: connected.exa, hint: "Connect Exa in Settings" },
    { value: "perplexity" as const, enabled: connected.perplexity, hint: "Connect Perplexity in Settings" },
  ].filter((choice) => choice.value !== "auto" || connected.exa === connected.perplexity)
    .sort((a, b) => Number(b.value === value) - Number(a.value === value) || Number(b.enabled) - Number(a.enabled)));

  $effect(() => {
    // One connected provider makes Automatic redundant, including for a saved choice.
    if (connected.exa !== connected.perplexity) value = connected.exa ? "exa" : "perplexity";
  });

  let help: HTMLSpanElement;
  let helpLeft = $state(0);
  let helpTop = $state(0);
  let helpOpen = $state(false);
  function showHelp(event: MouseEvent | FocusEvent) {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    helpLeft = Math.max(12, Math.min(rect.left, window.innerWidth - 272));
    help.showPopover();
    const height = help.getBoundingClientRect().height;
    helpTop = rect.bottom + 8 + height <= window.innerHeight - 12 ? rect.bottom + 8 : Math.max(12, rect.top - height - 8);
    helpOpen = true;
  }
  function hideHelp(event?: MouseEvent | FocusEvent) {
    if (!helpOpen) return;
    if (event) {
      const trigger = event.currentTarget as HTMLElement;
      if (trigger.matches(":hover") || trigger.contains(document.activeElement)) return;
    }
    help.hidePopover();
    helpOpen = false;
  }
  function dismissHelp(event: KeyboardEvent) {
    if (event.key !== "Escape" || !helpOpen) return;
    hideHelp();
    event.stopPropagation();
  }
</script>

<svelte:window onkeydown={dismissHelp} />

<div class="search-provider-select">
  <select aria-label={label} data-field="searchProvider" bind:value onchange={() => { hideHelp(); onchange?.(); }}>
    {#each choices as choice (choice.value)}
      <option value={choice.value} disabled={!choice.enabled} aria-describedby={!choice.enabled ? `${hintId}-${choice.value}` : choice.value === "auto" ? `${hintId}-help` : undefined}>
        <ProviderLogo provider={choice.value} size={16} />
        <span class="option-name">{names[choice.value]}{#if choice.value === "auto"}<span class="option-info" role="presentation" onmouseenter={showHelp} onmouseleave={hideHelp}><Icon name="info" size={14} /></span>{/if}</span>
        {#if !choice.enabled}<span class="connect-hint" aria-hidden="true">{choice.hint}</span>{/if}
      </option>
    {/each}
  </select>
  <!-- Keep the info button beside the current value without replacing native select behavior. -->
  <span class="selected-provider">
    <span class="selected-name" aria-hidden="true"><ProviderLogo provider={value} size={16} />{names[value]}</span>
    {#if value === "auto"}
      <span class="selected-info" role="presentation" onmouseenter={showHelp} onmouseleave={hideHelp} onfocusin={showHelp} onfocusout={hideHelp}>
        <button type="button" class="info-button" aria-label="About Automatic" aria-describedby={`${hintId}-help`} onclick={showHelp}><Icon name="info" size={14} /></button>
      </span>
    {/if}
  </span>
  {#each choices as choice (choice.value)}<span hidden id={`${hintId}-${choice.value}`}>{choice.hint}</span>{/each}
</div>
<span bind:this={help} id={`${hintId}-help`} class="automatic-tooltip" role="tooltip" popover="manual" style:left={`${helpLeft}px`} style:top={`${helpTop}px`}>{automaticHelp}</span>

<style>
  .search-provider-select { position:relative; }
  select { width:100%;min-width:0;min-height:42px;padding:var(--search-provider-padding,9px 12px);border:1px solid var(--border-strong);border-radius:var(--search-provider-radius,7px);background:var(--surface);color:transparent;font-size:var(--search-provider-font-size,14px); }
  select::picker(select) { color:var(--text); }
  option { display:grid;grid-template-columns:16px minmax(0,1fr) auto;align-items:center;gap:0 8px;min-height:30px;padding:5px 8px;color:var(--text);line-height:18px; }
  option:not(:disabled) { min-height:var(--search-provider-option-height,42px);padding-block:11px;font-size:var(--search-provider-font-size,14px); }
  option:hover,option:focus { background:rgb(255 255 255 / .06); }
  option:checked,option:checked:hover,option:checked:focus { background:rgb(255 255 255 / .12); }
  option:disabled { color:#7a7a7a; }
  option::checkmark { grid-column:3;grid-row:1; }
  .option-name,.selected-name { display:inline-flex;align-items:center;gap:8px; }
  .option-info { display:inline-flex;align-items:center;margin-left:-2px;color:var(--muted); }
  .connect-hint { display:none;grid-column:2/-1;font-size:11px;line-height:14px;color:var(--muted); }
  option:disabled:hover .connect-hint { display:block; }
  .selected-provider { position:absolute;left:12px;top:50%;transform:translateY(-50%);display:inline-flex;align-items:center;gap:4px;pointer-events:none;color:var(--text);font-size:var(--search-provider-font-size,14px); }
  .selected-info { display:inline-flex;pointer-events:auto; }
  .info-button { display:grid;place-items:center;width:22px;min-height:22px;padding:0;border:0;background:transparent;color:var(--muted); }
  .info-button:hover { color:var(--text);background:transparent; }
  .automatic-tooltip { position:fixed;inset:auto;margin:0;width:260px;max-width:calc(100vw - 24px);padding:12px 14px;border:1px solid var(--border);border-radius:10px;background:#111212;color:var(--text);font:400 13px/1.6 var(--sans);box-shadow:0 8px 24px rgb(0 0 0 / .5); }
</style>
