<script lang="ts">
  import { tick } from "svelte";
  import ResearchDefaults from "./ResearchDefaults.svelte";
  import ProviderLogo from "./ProviderLogo.svelte";
  import Icon from "./Icon.svelte";
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
  let dialog: HTMLDialogElement;
  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  });
  let archived = $derived(workspace?.threads.filter((thread) => thread.archivedAt || thread.status === "archived") ?? []);
  let nativeValidationPending = $derived(workspace?.validation.native.error?.startsWith("Checking ")
    || workspace?.validation.native.error === "Native runtime is starting");
  let nativeModelOptions = $derived(workspace?.modelOptions.filter((item) => item.providerId === "openai-subscription") ?? []);

  // The modal keeps the workspace mounted so dismissing it preserves drafts and scroll.
  export async function show() { section = "account"; open = true; await tick(); heading.focus(); }
  async function back() { open = false; await tick(); document.getElementById("settings-button")?.focus(); }
  function deleteArchived(id: string, title: string) {
    if (confirm(`Permanently delete "${title}" and all its research? This cannot be undone.`)) void onDelete(id);
  }
</script>

<dialog bind:this={dialog} class="settings-popup" data-section={section} aria-labelledby="settings-title" closedby="any" onclose={back} oncancel={(event) => { event.preventDefault(); void back(); }}>
  <div class="popup-header"><h1 bind:this={heading} tabindex="-1" id="settings-title">Settings</h1><button class="close" aria-label="Close settings" onclick={back}><Icon name="close" size={18} /></button></div>
  <div class="settings-layout">
    <nav aria-label="Settings sections">
      <button class:active={section === "account"} aria-pressed={section === "account"} onclick={() => section = "account"}><Icon name="command" size={16} />Account</button>
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
    <div class="account-emblem"><Icon name="command" size={25} /></div>
    <div class="native-account" class:needs-connection={!workspace.validation.native.connected && !nativeValidationPending} class:checking={nativeValidationPending} aria-label="OpenAI account">
      <div>
        <strong>{workspace.validation.native.connected ? "OpenAI account" : "Connect OpenAI to start research"}</strong>
        {#if !workspace.validation.native.available}
          <span class:account-error={!nativeValidationPending}>{workspace.validation.native.error ?? "OpenAI sign-in is unavailable right now."}</span>
        {:else if !workspace.validation.native.connected}
          {#if workspace.validation.native.error}
            <span class="account-error">{workspace.validation.native.error}</span>
          {:else}
            <span>Sign in with your OpenAI account. Scraply opens the secure sign-in page in your browser.</span>
          {/if}
        {:else}
          {#each workspace.validation.native.accounts as account (account.providerId)}
            <span>{account.email ?? account.accountId ?? account.providerId}{account.plan ? ` · ${account.plan}` : ""}</span>
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
  <section class="local" aria-labelledby="local-title">
    <h2 id="local-title">Local files</h2>
    <div><button disabled={busy} onclick={onOpenData}>Open data folder</button><button disabled={busy} onclick={onOpenLogs}>Open logs folder</button></div>
  </section>
  </div>
    </div>
  </div>
</dialog>

<style>
  .settings-layout { display:grid;grid-template-columns:170px minmax(0,1fr);min-height:0;flex:1; }
  nav { display:flex;flex-direction:column;gap:5px;background:transparent;padding:12px 8px;min-height:0; }
  nav button { display:flex;gap:10px;align-items:center;border:0;background:transparent;text-align:left;color:var(--muted);padding:12px;font-size:13px; }
  nav button.active { background:var(--surface-2);color:var(--text); }
  nav button.active :global(svg) { color:var(--accent); }
  .settings-content { padding:20px 24px;min-width:0;overflow:auto;scrollbar-gutter:stable;border-left:1px solid var(--border); }
  .settings-content > div { max-width:680px; }
  header { display:flex;align-items:start;justify-content:space-between;gap:16px;margin-bottom:20px; }
  h2 { margin:0;font-size:21px;font-weight:650;letter-spacing:-.03em; }
  button { padding:10px 14px;border:1px solid var(--border-strong);border-radius:8px;background:var(--surface-2);color:var(--text);font-size:13px; }
  button:hover:not(:disabled) { background:var(--border); }
  .account-emblem { display:grid;place-items:center;width:54px;height:54px;border:1px solid #71cfba30;border-radius:17px;background:#71cfba0b;color:var(--accent);margin-bottom:20px; }
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
  .local h2 { font-size:13px;letter-spacing:0;margin-bottom:16px; }
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
  .settings-popup { width:min(740px,calc(100vw - 32px));height:min(420px,calc(100dvh - 110px));max-width:none;max-height:none;margin:auto auto 64px 16px;padding:0;border:1px solid #363d38;border-radius:14px;background:#0d100e;color:var(--text);box-shadow:0 18px 70px #000b;overflow:hidden; }
  .settings-popup[data-section="defaults"] { height:min(620px,calc(100dvh - 110px)); }
  .settings-popup[open] { display:flex;flex-direction:column; }
  .settings-popup::backdrop { background:#0005; }
  .popup-header { margin:0;display:flex;align-items:center;justify-content:space-between;gap:20px;padding:14px 18px;border-bottom:1px solid var(--border); }
  .popup-header h1 { margin:0;font-size:16px;font-weight:600;padding:0; }
  .popup-header .close { display:grid;place-items:center;border:0;background:transparent;padding:6px;color:var(--muted); }
  .close:hover { background:var(--surface-2); }
  @media(max-width:600px) { .settings-layout { grid-template-columns:140px minmax(0,1fr); }.settings-content { padding:18px 16px; }nav button { font-size:13px;padding:10px 6px; } }
</style>
