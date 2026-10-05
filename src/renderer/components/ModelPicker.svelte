<script lang="ts">
  import { modelRefKey, type ModelOption } from "../../shared/schemas";
  import { splitModels } from "../../shared/latest-models";
  import { modelDisplayName } from "../lib/research-defaults";

  // The one model dropdown, used on every screen so order and grouping cannot drift: latest models on top,
  // everything else the account offers behind a "Legacy models" row. `value` is a modelRefKey. A value the
  // account does not offer shows `missingLabel`, so a saved choice stays visible until the user replaces it.
  // Keyboard: Enter, Space or an arrow opens; arrows, Home and End move; Enter picks; Escape closes.
  let { options, value = $bindable(), label, missingLabel = "Choose a model", disabled = false, invalid = false, field, onchange }: {
    options: ModelOption[];
    value: string;
    label: string;
    missingLabel?: string;
    disabled?: boolean;
    invalid?: boolean;
    /** Sets data-field, which forms use to focus the control that blocks a submit. */
    field?: string;
    onchange?: (key: string) => void;
  } = $props();

  type Row = { kind: "model"; key: string; name: string } | { kind: "legacy" };
  const id = $props.id();
  let open = $state(false);
  let legacyOpen = $state(false);
  let active = $state(0);
  let position = $state("");
  let root = $state<HTMLDivElement>();
  let trigger = $state<HTMLButtonElement>();
  let groups = $derived(splitModels(options));
  let selected = $derived(options.find((item) => modelRefKey(item) === value));
  const row = (item: ModelOption): Row => ({ kind: "model", key: modelRefKey(item), name: modelDisplayName(item) });
  let rows = $derived<Row[]>([
    ...groups.latest.map(row),
    ...(groups.legacy.length > 0 ? [{ kind: "legacy" as const }] : []),
    ...(legacyOpen ? groups.legacy.map(row) : []),
  ]);

  function show() {
    if (disabled || !trigger) return;
    // A selected legacy model starts with its group open, so the current choice is always in view.
    legacyOpen = groups.legacy.some((item) => modelRefKey(item) === value);
    active = Math.max(0, rows.findIndex((item) => item.kind === "model" && item.key === value));
    // The list is placed against the trigger in viewport coordinates; it opens upward near the bottom edge.
    const box = trigger.getBoundingClientRect();
    const below = window.innerHeight - box.bottom;
    position = `left:${box.left}px;min-width:${box.width}px;${below < 260 && box.top > below
      ? `bottom:${window.innerHeight - box.top + 4}px;max-height:${box.top - 12}px` : `top:${box.bottom + 4}px;max-height:${below - 12}px`}`;
    open = true;
  }
  // The list shows in the browser's top layer: glass panels (backdrop-filter) trap and clip fixed children,
  // and a modal dialog covers anything outside it. The test DOM has no top layer and renders the list in place.
  function topLayer(node: HTMLElement) {
    node.showPopover?.();
  }
  function close(refocus = false) {
    open = false;
    if (refocus) trigger?.focus();
  }
  function choose(item: Row | undefined) {
    if (!item) return;
    if (item.kind === "legacy") { legacyOpen = !legacyOpen; return; }
    close(true);
    if (item.key === value) return;
    value = item.key;
    onchange?.(item.key);
  }
  function keydown(event: KeyboardEvent) {
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) { event.preventDefault(); show(); }
      return;
    }
    if (event.key === "Tab") { close(); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End", "Enter", " ", "Escape"].includes(event.key)) return;
    event.preventDefault();
    // Escape closes only the list, not the dialog or panel around it.
    event.stopPropagation();
    if (event.key === "Escape") close(true);
    else if (event.key === "Enter" || event.key === " ") choose(rows[active]);
    else active = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1
      : Math.min(rows.length - 1, Math.max(0, active + (event.key === "ArrowDown" ? 1 : -1)));
  }
</script>

<svelte:window onpointerdown={(event) => { if (open && !root?.contains(event.target as Node)) close(); }} onresize={() => close()} />

<div class="model-picker" bind:this={root}>
  <button bind:this={trigger} type="button" role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={`${id}-list`}
    aria-label={label} aria-activedescendant={open ? `${id}-${active}` : undefined} aria-invalid={invalid || undefined}
    data-field={field} data-value={value} {value} {disabled} onclick={() => open ? close() : show()} onkeydown={keydown}>
    <span class="current">{selected ? modelDisplayName(selected) : missingLabel}</span>
  </button>
  {#if open}
    <!-- Keys are handled on the combobox button, which keeps focus and points at the active row. -->
    <!-- Pickers usually sit inside a <label>, whose default click action would also click the trigger and toggle the list. -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <ul id={`${id}-list`} role="listbox" aria-label={label} style={position} popover="manual" use:topLayer onclick={(event) => event.preventDefault()}>
      {#each rows as item, index (item.kind === "model" ? item.key : "legacy")}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <li id={`${id}-${index}`} role="option" tabindex="-1" data-value={item.kind === "model" ? item.key : undefined} class:active={index === active} class:legacy-row={item.kind === "legacy"}
          aria-selected={item.kind === "model" && item.key === value}
          onpointerenter={() => active = index} onclick={() => choose(item)}>
          {#if item.kind === "legacy"}<span>Legacy models</span><span class="count">{groups.legacy.length}</span>{:else}{item.name}{/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .model-picker { position:relative;min-width:0; }
  button { display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;min-height:38px;padding:8px 12px;border:1px solid var(--border-strong);border-radius:8px;background:var(--bg);color:var(--text);font-size:13px;text-align:left; }
  button::after { content:"";flex:none;width:6px;height:6px;margin-right:2px;border-right:1.5px solid var(--muted);border-bottom:1.5px solid var(--muted);transform:translateY(-2px) rotate(45deg); }
  button:disabled { opacity:.55; }
  button[aria-invalid="true"] { border-color:var(--danger); }
  .current { min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
  ul { position:fixed;inset:auto;margin:0;padding:5px;overflow:auto;list-style:none;border:1px solid var(--border-strong);border-radius:10px;background:#0b0b0b;box-shadow:0 12px 36px #000c; }
  li { display:flex;align-items:center;justify-content:space-between;gap:16px;padding:8px 10px;border-radius:6px;color:var(--text);font-size:13px;white-space:nowrap;cursor:pointer; }
  li.active { background:var(--surface-2); }
  li[aria-selected="true"] { color:var(--accent-strong); }
  .legacy-row { margin-top:4px;border-top:1px solid var(--border);border-radius:0 0 6px 6px;color:var(--muted); }
  .count { color:var(--subtle);font-variant-numeric:tabular-nums; }
</style>
