<script lang="ts">
  import { tick } from "svelte";
  import ApiKeyInput from "./ApiKeyInput.svelte";
  import Icon from "./Icon.svelte";
  import { hasSearchKey, type SearchKeyStatus } from "../lib/search-providers";
  import type { SearchProvider } from "../../shared/schemas";

  // The controls under a search provider's row in Settings: the saved key's masked tail with Replace and Remove,
  // or Add key. Keys are write-only, so Replace starts from an empty field. Removing asks once, because providers
  // show a key only when it is created and the user may not have a copy.
  let { provider, name, keyUrl, status, busy, onSave, onRemove, onOpenUrl }: {
    provider: SearchProvider;
    name: string;
    keyUrl: string;
    status: SearchKeyStatus;
    busy: boolean;
    onSave: (apiKey: string) => Promise<void>;
    onRemove: () => Promise<void>;
    onOpenUrl: (url: string) => void;
  } = $props();

  let mode = $state<"idle" | "editing" | "confirm-remove">("idle");
  let draft = $state("");
  let error = $state("");
  let working = $state(false);
  let input = $state<HTMLInputElement>();
  let primaryAction = $state<HTMLButtonElement>();
  let saved = $derived(hasSearchKey(status));
  let keyTail = $derived(status.maskedKey?.replaceAll("•", "") ?? "");
  let errorId = $derived(`${provider}-key-error`);

  async function edit() {
    mode = "editing";
    draft = "";
    error = "";
    await tick();
    input?.focus();
  }
  async function finish() {
    mode = "idle";
    draft = "";
    await tick();
    primaryAction?.focus();
  }
  async function save() {
    working = true;
    error = "";
    try {
      await onSave(draft);
      await finish();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "The key could not be saved.";
      await tick();
      input?.focus();
    } finally {
      working = false;
    }
  }
  async function remove() {
    working = true;
    error = "";
    try { await onRemove(); }
    catch (cause) { error = cause instanceof Error ? cause.message : "The key could not be removed."; }
    finally {
      working = false;
      await finish();
    }
  }
</script>

{#if mode === "editing"}
  <form class="key-form" onsubmit={(event) => { event.preventDefault(); void save(); }}>
    <div class="key-row">
      <ApiKeyInput bind:value={draft} bind:input label={`${name} API key`} invalid={Boolean(error)} describedby={errorId} disabled={working}
        onEscape={() => { error = ""; void finish(); }} />
      <button type="submit" class="primary" disabled={working || !draft.trim()}>{working ? "Checking…" : "Save"}</button>
      <button type="button" disabled={working} onclick={() => { error = ""; void finish(); }}>Cancel</button>
    </div>
    <p id={errorId} class="key-note" class:error={Boolean(error)} role={error ? "alert" : undefined}>
      {#if error}{error}{:else}Scraply checks the key with {name}, then stores it encrypted on this computer.
        <a href={keyUrl} onclick={(event) => { event.preventDefault(); onOpenUrl(keyUrl); }}>Get a {name} key<Icon name="external" size={12} /></a>{/if}
    </p>
  </form>
{:else}
  {#if mode === "confirm-remove"}
    <div class="key-actions" role="group" aria-label={`Remove the saved ${name} key?`}>
      <span>Remove the saved key? {name} searches stop until you add one again.</span>
      <button type="button" class="danger" disabled={working} onclick={remove}>{working ? "Removing…" : "Remove key"}</button>
      <button type="button" disabled={working} onclick={finish}>Keep</button>
    </div>
  {:else if saved}
    <div class="key-actions">
      {#if keyTail}<span class="masked-key"><span class="sr-only">Saved key ending in</span><span aria-hidden="true">••••</span>{keyTail}</span>{/if}
      <button type="button" bind:this={primaryAction} aria-label={`Replace ${name} key`} disabled={busy} onclick={edit}>Replace</button>
      <button type="button" aria-label={`Remove ${name} key`} disabled={busy} onclick={() => { error = ""; mode = "confirm-remove"; }}>Remove</button>
    </div>
  {:else}
    <div class="key-actions">
      <button type="button" bind:this={primaryAction} aria-label={`Add key for ${name}`} disabled={busy} onclick={edit}>Add key</button>
    </div>
  {/if}
  {#if error}<p class="key-note error" role="alert">{error}</p>{/if}
{/if}

<style>
  /* Idle actions match the OpenAI card's compact ghost buttons and sit at the bottom of the card. */
  .key-actions { display:flex;flex-wrap:wrap;align-items:center;gap:2px;margin-top:auto;color:var(--muted);font-size:13px; }
  .key-actions > button:first-child { margin-left:-10px; }
  .key-actions > span { margin-right:8px; }
  .key-actions button { padding:6px 10px;border:0;border-radius:7px;background:transparent;color:var(--muted);font-size:13px; }
  .key-actions button:hover:not(:disabled) { background:var(--surface-2);color:var(--text); }
  .key-actions .danger,.key-actions .danger:hover:not(:disabled) { color:var(--danger); }
  .masked-key { font:12px var(--mono);letter-spacing:.06em; }
  .sr-only { position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap; }
  .key-form { display:grid;gap:8px;margin-top:auto; }
  .key-row { display:flex;flex-wrap:wrap;align-items:center;gap:8px; }
  .key-row > button { flex:none;padding:10px 14px;border:1px solid var(--border-strong);border-radius:8px;background:var(--surface-2);color:var(--text);font-size:13px; }
  .key-row > button:hover:not(:disabled) { background:var(--border); }
  .key-row > .primary { border-color:transparent;background:var(--accent-strong);color:var(--accent-ink);font-weight:600; }
  .key-row > .primary:hover:not(:disabled) { background:var(--accent); }
  .key-note { margin:0;color:var(--muted);font-size:12px;line-height:1.6;overflow-wrap:anywhere; }
  .key-note.error { color:var(--danger); }
  .key-note a { display:inline-flex;align-items:center;gap:4px;color:var(--text);text-decoration:underline;text-decoration-color:var(--border-strong);text-underline-offset:3px; }
  .key-note a:hover { text-decoration-color:currentColor; }
</style>
