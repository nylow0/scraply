<script lang="ts">
  import { tick } from "svelte";
  import ResearchDefaults from "./ResearchDefaults.svelte";
  import ProviderLogo from "./ProviderLogo.svelte";
  import Icon from "./Icon.svelte";
  import OpenAILogo from "./OpenAILogo.svelte";
  import { accountPlanLabel } from "../lib/account-plan";
  import { isArchived } from "../lib/status";
  import type { NativeLoginStartResult, WorkspaceState } from "../../shared/ipc";

  let { workspace, busy, nativeLogin, open = $bindable(false), feedback, onRetry, onConnectNative, onCancelNative, onRefreshNative, onLogoutNative, onOpenData, onOpenLogs, onRestore, onDelete }: {
    workspace: WorkspaceState | null;
    open?: boolean;
    feedback?: { text: string; tone: "error" | "info" } | null;
    busy: boolean;
    nativeLogin: NativeLoginStartResult | null;
    onRetry: () => Promise<void>;
    onConnectNative: (providerId: string, method: "browser" | "device") => Promise<void>;
    onCancelNative: () => Promise<void>;
    onRefreshNative: (providerId: string) => Promise<void>;
    onLogoutNative: (providerId: string) => Promise<void>;
    onOpenData: () => Promise<void>;
    onOpenLogs: () => Promise<void>;
    onRestore: (id: string) => Promise<void>;
    onDelete: (id: string) => Promise<void>;
  } = $props();

  const searchProviders = ["exa", "perplexity"] as const;
  let section = $state<"account" | "defaults" | "connections" | "archive" | "local">("account");
  let heading: HTMLHeadingElement;
  let screen: HTMLElement;
  let archived = $derived(workspace?.threads.filter(isArchived) ?? []);
  let nativeValidationPending = $derived(workspace?.validation.native.error?.startsWith("Checking ")
    || workspace?.validation.native.error === "Native runtime is starting");
  let nativeModelOptions = $derived(workspace?.modelOptions.filter((item) => item.providerId === "openai-subscription") ?? []);

  // Settings covers the whole window, but the workspace stays mounted underneath so leaving preserves drafts and scroll.
  export async function show() { section = "account"; open = true; await tick(); heading.focus(); }
  async function back() { open = false; await tick(); document.getElementById("settings-button")?.focus(); }
  // Keep keyboard focus on the full-window screen and leave on Esc when no picker is open.
  function handleSettingsKeydown(event: KeyboardEvent) {
    if (open && event.key === "Tab") {
      const focusable = Array.from(screen.querySelectorAll<HTMLElement>(
        'button:not([disabled]),select:not([disabled]),input:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])',
      )).filter((element) => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (first && last && (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
      return;
    }
    if (!open || event.key !== "Escape" || event.defaultPrevented || document.querySelector("dialog[open]")) return;
    if (event.target instanceof HTMLOptionElement || (event.target instanceof HTMLSelectElement && event.target.matches(":open"))) return;
    event.preventDefault();
    void back();
  }
  function deleteArchived(id: string, title: string) {
    if (confirm(`Permanently delete "${title}" and all its research? This cannot be undone.`)) void onDelete(id);
  }
</script>

<svelte:window onkeydown={handleSettingsKeydown} />
<section bind:this={screen} class="settings-screen" hidden={!open} data-section={section} aria-labelledby="settings-title">
  <header class="screen-header"><button class="back" onclick={back}><Icon name="back" size={17} />Back</button><h1 bind:this={heading} tabindex="-1" id="settings-title">Settings</h1></header>
  <div class="settings-layout">
    <nav aria-label="Settings sections">
      <button class:active={section === "account"} aria-pressed={section === "account"} onclick={() => section = "account"}><OpenAILogo size={16} />Account</button>
      <button class:active={section === "defaults"} aria-pressed={section === "defaults"} onclick={() => section = "defaults"}><Icon name="brief" size={16} />Research defaults</button>
      <button class:active={section === "connections"} aria-pressed={section === "connections"} onclick={() => section = "connections"}><Icon name="research" size={16} />Connections</button>
      <button class:active={section === "archive"} aria-pressed={section === "archive"} onclick={() => section = "archive"}><Icon name="archive" size={16} />Archived research</button>
      <button class:active={section === "local"} aria-pressed={section === "local"} onclick={() => section = "local"}><Icon name="folder" size={16} />Local files</button>
    </nav>
    <div class="settings-content">
      <header><div><h2>{section === "account" ? "Your account" : section === "defaults" ? "Research defaults" : section === "connections" ? "Search connections" : section === "archive" ? "Archived research" : "Local files"}</h2></div></header>
  <div hidden={section !== "archive"} class="archive-list">
    {#each archived as thread (thread.id)}
      <article><div><strong>{thread.title}</strong><span>{thread.archivedAt ? new Date(thread.archivedAt).toLocaleDateString() : "Archived"}</span></div><button disabled={busy} onclick={() => onRestore(thread.id)} aria-label={`Restore ${thread.title}`}>Restore</button><button class="danger" disabled={busy} onclick={() => deleteArchived(thread.id, thread.title)} aria-label={`Delete ${thread.title}`}>Delete</button></article>
    {:else}<p class="archive-empty">No archived research.</p>{/each}
  </div>
  <div hidden={section !== "defaults"}><ResearchDefaults {workspace} /></div>
  {#if feedback}<p class="feedback" class:error={feedback.tone === "error"} role={feedback.tone === "error" ? "alert" : "status"}>{feedback.text}</p>{/if}
  {#if workspace}
    <div hidden={section !== "account"}>
    <div class="account-emblem"><OpenAILogo size={36} /></div>
    <div class="native-account" class:needs-connection={!workspace.validation.native.connected && !nativeValidationPending} class:checking={nativeValidationPending} aria-label="OpenAI account">
      <div>
        <strong>{workspace.validation.native.connected ? "OpenAI account" : "Connect OpenAI to start research"}</strong>
        {#if !workspace.validation.native.available}
          <span class:account-error={!nativeValidationPending}>{workspace.validation.native.error ?? "OpenAI sign-in is unavailable right now."}</span>
        {:else if !workspace.validation.native.connected}
          {#if workspace.validation.native.error}
            <span class="account-error">{workspace.validation.native.error}</span>
          {:else}
            <span>Continue in your browser to sign in.</span>
          {/if}
        {:else}
          {#each workspace.validation.native.accounts as account (account.providerId)}
            <span>{account.email ?? account.accountId ?? account.providerId}{account.plan ? ` · ${accountPlanLabel(account.plan)}` : ""}</span>
          {/each}
          {#if workspace.validation.native.error}
            <span class="account-error">{workspace.validation.native.error}</span>
          {:else if nativeModelOptions.length === 0}
            <span class="account-error">No compatible models were found. Refresh the account to try again.</span>
          {/if}
        {/if}
      </div>
      {#if nativeLogin}
        <div class="login-progress" role="status">
          {#if nativeLogin.method === "device"}
            <span>Enter this code in the opened browser</span>
            <code>{nativeLogin.userCode}</code>
          {:else}
            <span>Waiting for browser sign-in</span>
          {/if}
          <button type="button" class="secondary" disabled={!onCancelNative} onclick={() => onCancelNative?.()}>Cancel sign-in</button>
        </div>
      {:else if !workspace.validation.native.available}
        <button type="button" class="secondary" disabled={busy || nativeValidationPending} onclick={() => onRetry()}>{nativeValidationPending ? "Checking…" : "Try again"}</button>
      {:else if !workspace.validation.native.connected}
        <div class="account-actions">
          <button type="button" class="primary" disabled={busy || !onConnectNative} onclick={() => onConnectNative?.("openai-subscription", "browser")}>Sign in with OpenAI</button>
          <button type="button" class="secondary" disabled={busy || !onConnectNative} onclick={() => onConnectNative?.("openai-subscription", "device")}>Use device code</button>
        </div>
      {:else}
        <div class="account-actions">
          <button type="button" class="secondary" disabled={busy || !onRefreshNative} onclick={() => onRefreshNative?.(workspace.validation.native.accounts[0]?.providerId ?? "openai-subscription")}>Refresh</button>
          <button type="button" class="secondary" disabled={busy || !onLogoutNative} onclick={() => onLogoutNative?.(workspace.validation.native.accounts[0]?.providerId ?? "openai-subscription")}>Sign out</button>
        </div>
      {/if}
    </div>


    </div>
    <section hidden={section !== "connections"} class="search" aria-labelledby="search-title">
      <h2 id="search-title">Search connections</h2>
      {#each searchProviders as provider (provider)}
        {@const status = workspace.validation[provider]}
        <div class="provider">
          <div class="provider-name"><ProviderLogo provider={provider} size={22} /><strong>{provider === "exa" ? "Exa" : "Perplexity"}</strong></div>
          <span class:ok={status.valid}>{status.valid ? "Connected" : status.error ?? "Not connected"}</span>
        </div>
      {/each}
      <button disabled={busy} onclick={onRetry}>{busy ? "Checking…" : "Retry connections"}</button>
    </section>
  {:else}
    <p role="status">Loading account settings…</p>
  {/if}
  <div hidden={section !== "local"}>
  <section class="local" aria-label="Local files">
    <div><button disabled={busy} onclick={onOpenData}>Open data folder</button><button disabled={busy} onclick={onOpenLogs}>Open logs folder</button></div>
  </section>
  </div>
    </div>
  </div>
</section>

<style>
  .settings-screen { position:fixed;inset:36px 0 0;z-index:20;display:flex;flex-direction:column;background:var(--bg);color:var(--text); }
  .settings-screen[hidden] { display:none; }
  /* Full width: content centred in the space left of the section list, which is a column on the right edge.
     The list stays first in the DOM so keyboard users reach it first. */
  .screen-header { display:flex;align-items:center;gap:14px;padding:12px 24px 12px 32px;border-bottom:1px solid var(--border); }
  .screen-header h1 { margin:0;font-size:20px;font-weight:650;letter-spacing:-.02em; }
  .screen-header h1:focus { outline:none; }
  .back { display:flex;align-items:center;gap:8px;border:0;background:transparent;color:var(--muted);padding:8px 12px 8px 8px; }
  .back:hover:not(:disabled) { color:var(--text);background:var(--surface-2); }
  .settings-layout { display:grid;grid-template-columns:minmax(0,1fr) 260px;min-height:0;flex:1; }
  nav { order:2;display:flex;flex-direction:column;gap:4px;padding:28px 16px;min-height:0;border-left:1px solid var(--border); }
  nav button { display:flex;gap:10px;align-items:center;border:0;border-radius:8px;background:transparent;text-align:left;color:var(--muted);padding:11px 12px;font-size:14px; }
  nav button.active { background:var(--surface-2);color:var(--text); }
  nav button.active :global(svg) { color:var(--accent); }
  .settings-content { order:1;padding:32px 40px;min-width:0;overflow:auto;scrollbar-gutter:stable; }
  .settings-content > * { max-width:720px;margin-inline:auto; }
  .settings-content > header { display:flex;align-items:start;justify-content:space-between;gap:16px;margin-bottom:24px; }
  h2 { margin:0;font-size:24px;font-weight:650;letter-spacing:-.03em; }
  button { padding:10px 14px;border:1px solid var(--border-strong);border-radius:8px;background:var(--surface-2);color:var(--text);font-size:13px; }
  button:hover:not(:disabled) { background:var(--border); }
  .account-emblem { color:var(--text);margin-bottom:24px; }
  .native-account { display:grid;gap:26px; }
  .native-account > div:first-child { display:grid;gap:10px; }
  .native-account strong { font-size:16px;font-weight:600; }
  .native-account span { color:var(--muted);font-size:13px;overflow-wrap:anywhere; }
  .native-account .account-error { color:var(--danger); }
  .account-actions,.login-progress { display:flex;flex-wrap:wrap;align-items:center;gap:8px; }
  .primary { background:var(--accent-strong);color:var(--accent-ink);border-color:transparent; }
  .primary:hover:not(:disabled) { background:var(--accent); }
  .login-progress { border:1px solid var(--border-strong);padding:16px;border-radius:12px;background:var(--surface); }
  .login-progress code { padding:8px 12px;border:1px solid var(--border-strong);border-radius:6px;font:600 17px var(--mono);letter-spacing:.1em; }
  .search > h2 { display:none; }
  .provider { display:flex;align-items:center;justify-content:space-between;gap:20px;padding:22px 0;border-bottom:1px solid var(--border);font-size:13px; }
  .provider:first-of-type { border-top:1px solid var(--border); }
  .provider-name { display:flex;align-items:center;gap:14px;color:var(--text); }
  .provider-name :global(svg) { flex:none; }
  .provider strong { font-weight:600; }.provider span { color:var(--muted);max-width:70%;text-align:right;overflow-wrap:anywhere; }
  .provider .ok { color:var(--success); }.search > button { margin-top:24px; }
  .local > div { display:grid;gap:12px; }.local button { padding:16px;text-align:left;background:var(--surface);border-color:var(--border); }
  .feedback { padding:12px;border:1px solid var(--border);border-radius:8px;color:var(--muted);font-size:13px;overflow-wrap:anywhere; }
  .feedback.error { color:var(--danger); }
  [hidden] { display:none; }
  .archive-list article { display:flex;align-items:center;gap:10px;padding:22px 0;border-bottom:1px solid var(--border); }
  .archive-list article > div { flex:1;min-width:0;display:grid;gap:6px; }
  .archive-list strong { font-size:14px;overflow-wrap:anywhere; }
  .archive-list span,.archive-empty { font-size:13px;color:var(--muted); }
  .danger { color:var(--danger); }
  @media(max-width:720px) { .settings-layout { grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr); }nav { order:0;flex-direction:row;overflow-x:auto;padding:10px 12px;border-left:0;border-bottom:1px solid var(--border); }nav button { flex:none;font-size:13px;padding:9px 10px; }.settings-content { padding:20px 16px;border-left:0; }.screen-header { padding:10px 12px; } }
</style>
