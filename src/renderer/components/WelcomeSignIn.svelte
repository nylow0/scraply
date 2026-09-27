<script lang="ts">
  import { onMount, tick } from "svelte";
  import ApiKeyInput from "./ApiKeyInput.svelte";
  import BrandMark from "./BrandMark.svelte";
  import Icon from "./Icon.svelte";
  import ProviderLogo from "./ProviderLogo.svelte";
  import { hasSearchKey, SEARCH_PROVIDERS } from "../lib/search-providers";
  import type { NativeLoginStartResult, ValidationState } from "../../shared/ipc";
  import type { SearchProvider } from "../../shared/schemas";

  // Shown by App while research is missing an account: on first launch, after signing out, when a session is lost,
  // or when no web search key is saved. The "sign-in" step connects OpenAI; App then moves to the "search" step when
  // no key is saved, and unmounts the prompt once both are done or the user picks "Not now".
  let { step, validation, returning, busy, nativeLogin, error, onConnect, onCancel, onSaveSearchKeys, onOpenUrl, onDismiss }: {
    step: "sign-in" | "search";
    validation: ValidationState;
    returning: boolean;
    busy: boolean;
    nativeLogin: NativeLoginStartResult | null;
    error: string | null;
    onConnect: (method: "browser" | "device") => void;
    onCancel: () => void;
    // Resolves with a user-facing reason for each key that was not saved.
    onSaveSearchKeys: (entries: Array<[SearchProvider, string]>) => Promise<Partial<Record<SearchProvider, string>>>;
    onOpenUrl: (url: string) => void;
    onDismiss: () => void;
  } = $props();

  let dialog: HTMLDialogElement;
  let drafts = $state<Record<SearchProvider, string>>({ exa: "", perplexity: "" });
  let keyInputs = $state<Partial<Record<SearchProvider, HTMLInputElement>>>({});
  let keyErrors = $state<Partial<Record<SearchProvider, string>>>({});
  let savingKeys = $state(false);
  let anyKeySaved = $derived(SEARCH_PROVIDERS.some(({ id }) => hasSearchKey(validation[id])));
  let enteredKeys = $derived(SEARCH_PROVIDERS
    .filter(({ id }) => !hasSearchKey(validation[id]) && drafts[id].trim())
    .map(({ id }): [SearchProvider, string] => [id, drafts[id]]));

  onMount(() => dialog.showModal());
  // Signing in swaps this content in place, so focus moves to the first key field instead of a removed button.
  $effect(() => {
    if (step === "search") void tick().then(() => focusFirst(SEARCH_PROVIDERS.map(({ id }) => id)));
  });
  function focusFirst(providers: SearchProvider[]) {
    providers.map((id) => keyInputs[id]).find(Boolean)?.focus();
  }
  async function saveKeys() {
    savingKeys = true;
    keyErrors = {};
    try {
      keyErrors = await onSaveSearchKeys(enteredKeys);
    } finally {
      savingKeys = false;
    }
    await tick();
    focusFirst(SEARCH_PROVIDERS.map(({ id }) => id).filter((id) => keyErrors[id]));
  }
</script>

<dialog bind:this={dialog} class="welcome glass-dense" aria-labelledby="welcome-title" aria-describedby="welcome-body"
  oncancel={(event) => { event.preventDefault(); if (nativeLogin) onCancel(); onDismiss(); }}>
  <BrandMark size={44} />
  {#if step === "sign-in"}
    <h1 id="welcome-title">{returning ? "Welcome back" : "Welcome to Scraply"}</h1>
    <p id="welcome-body">{returning
      ? "Sign in with your OpenAI account to continue your research."
      : "Scraply uses your OpenAI account to research problems and develop ideas. Your research is saved on this computer."}</p>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if nativeLogin}
      <div class="progress" role="status">
        {#if nativeLogin.method === "device"}
          <span>Enter this code in the browser window that opened</span>
          <code>{nativeLogin.userCode}</code>
        {:else}
          <span><i aria-hidden="true"></i>Finish signing in in your browser</span>
        {/if}
        <button type="button" class="quiet" onclick={onCancel}>Cancel sign-in</button>
      </div>
    {:else}
      <div class="actions">
        <button type="button" class="primary" disabled={busy} onclick={() => onConnect("browser")}>Sign in with OpenAI</button>
        <button type="button" disabled={busy} onclick={() => onConnect("device")}>Use device code</button>
      </div>
      <button type="button" class="quiet" onclick={onDismiss}>Not now</button>
    {/if}
  {:else}
    <p class="connected"><Icon name="check" size={14} />OpenAI connected</p>
    <h1 id="welcome-title">Add web search</h1>
    <p id="welcome-body">Scraply searches the web for evidence when it discovers problems. Add an API key for Exa, Perplexity, or both. Keys are stored encrypted on this computer.</p>
    <form class="keys" onsubmit={(event) => { event.preventDefault(); void saveKeys(); }}>
      {#each SEARCH_PROVIDERS as provider (provider.id)}
        {@const saved = hasSearchKey(validation[provider.id])}
        {@const keyError = keyErrors[provider.id]}
        <div class="key-field">
          <div class="key-label">
            <span><ProviderLogo provider={provider.id} size={16} />{provider.name}</span>
            {#if saved}<span class="saved"><Icon name="check" size={14} />Saved</span>
            {:else}<a href={provider.keyUrl} onclick={(event) => { event.preventDefault(); onOpenUrl(provider.keyUrl); }}>Get a key<Icon name="external" size={12} /></a>{/if}
          </div>
          {#if !saved}
            <ApiKeyInput bind:value={drafts[provider.id]} bind:input={keyInputs[provider.id]} label={`${provider.name} API key`}
              invalid={Boolean(keyError)} describedby={keyError ? `welcome-${provider.id}-error` : undefined} disabled={savingKeys} />
            {#if keyError}<p id={`welcome-${provider.id}-error`} class="field-error" role="alert">{keyError}</p>{/if}
          {/if}
        </div>
      {/each}
      <button type="submit" class="primary" disabled={savingKeys || enteredKeys.length === 0}>{savingKeys ? "Checking keys…" : "Save and continue"}</button>
    </form>
    <button type="button" class="quiet" disabled={savingKeys} onclick={onDismiss}>{anyKeySaved ? "Done" : "Not now"}</button>
  {/if}
</dialog>

<style>
  .welcome { width:min(420px,calc(100vw - 32px));margin:auto;padding:36px 32px 24px;border-radius:22px;color:var(--text); }
  .welcome[open] { display:flex;flex-direction:column;align-items:flex-start;animation:welcome-open 260ms var(--ease); }
  h1 { margin:22px 0 10px;font-size:26px;font-weight:650;letter-spacing:-.035em;line-height:1.15; }
  p { margin:0;color:var(--muted);font-size:14px;line-height:1.6; }
  .error { margin-top:14px;color:var(--danger);font-size:13px;overflow-wrap:anywhere; }
  .actions { display:grid;gap:8px;width:100%;margin-top:28px; }
  button { min-height:42px;padding:10px 16px;border:1px solid var(--border-strong);border-radius:12px;background:var(--surface-2);color:var(--text);font-size:14px;font-weight:500; }
  button:hover:not(:disabled) { background:var(--border); }
  button:disabled { opacity:.5; }
  .primary { border-color:transparent;background:var(--accent-strong);color:var(--accent-ink);font-weight:600; }
  .primary:hover:not(:disabled) { background:var(--accent); }
  .quiet { align-self:center;min-height:36px;margin-top:12px;border:0;background:transparent;color:var(--muted);font-size:13px; }
  .quiet:hover:not(:disabled) { background:transparent;color:var(--text); }
  .progress { display:grid;justify-items:start;gap:12px;width:100%;margin-top:28px;padding:18px;border:1px solid var(--border-strong);border-radius:12px;background:var(--surface);font-size:13px;color:var(--muted); }
  .progress span { display:flex;align-items:center;gap:10px; }
  .progress i { width:7px;height:7px;border-radius:50%;background:var(--accent);animation:pulse 1.2s ease infinite alternate; }
  .progress code { padding:8px 12px;border:1px solid var(--border-strong);border-radius:6px;color:var(--text);font:600 20px var(--mono);letter-spacing:.12em; }
  .progress .quiet { align-self:auto;margin:0;padding:0; }
  /* Search step: a quiet confirmation of the finished sign-in, then one masked field per provider. */
  .connected { display:inline-flex;align-items:center;gap:6px;margin-top:22px;padding:3px 10px 3px 8px;border:1px solid var(--border);border-radius:999px;color:var(--success);font-size:12px;font-weight:500; }
  .connected + h1 { margin-top:14px; }
  .keys { display:grid;gap:18px;width:100%;margin-top:24px; }
  .key-field { display:grid;gap:8px; }
  .key-label { display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:13px; }
  .key-label > span:first-child { display:flex;align-items:center;gap:8px;font-weight:600; }
  .key-label a { display:inline-flex;align-items:center;gap:4px;color:var(--muted);font-size:12px;text-decoration:none; }
  .key-label a:hover { color:var(--text); }
  .saved { display:inline-flex;align-items:center;gap:5px;color:var(--success);font-size:12px; }
  .field-error { color:var(--danger);font-size:12px;line-height:1.5;overflow-wrap:anywhere; }
  .keys .primary { margin-top:4px; }
  @keyframes welcome-open { from { opacity:0;transform:translateY(6px) scale(.98); }to { opacity:1;transform:none; } }
  @keyframes pulse { to { opacity:.3; } }
  @media (prefers-reduced-motion: reduce) { .welcome[open],.progress i { animation:none; } }
</style>
