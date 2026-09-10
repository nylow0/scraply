<script lang="ts">
  import ResearchDefaults from "./ResearchDefaults.svelte";
  import ProviderLogo from "./ProviderLogo.svelte";
  import Icon from "./Icon.svelte";
  import type { NativeLoginStartResult, WorkspaceState } from "../../shared/ipc";

  let { workspace, busy, nativeLogin, open = $bindable(false), feedback, onRetry, onConnectNative, onCancelNative, onRefreshNative, onLogoutNative, onOpenData, onOpenLogs }: {
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
  } = $props();

  const searchProviders = ["exa", "perplexity"] as const;
  let section = $state<"account" | "defaults" | "connections" | "local">("account");
  let dialog: HTMLDialogElement;
  let trigger: HTMLButtonElement;
  let nativeValidationPending = $derived(workspace?.validation.native.error?.startsWith("Checking ")
    || workspace?.validation.native.error === "Native runtime is starting");
  let nativeModelOptions = $derived(workspace?.modelOptions.filter((item) => item.providerId === "openai-subscription") ?? []);
  let connected = $derived(Boolean(workspace?.validation.native.connected));

  // Native modal behavior provides focus containment and Escape dismissal.
  // The setup form stays mounted, so opening settings never discards a draft.
  export function show() { section = "account"; dialog.showModal(); open = true; }
</script>

<button bind:this={trigger} class="settings-trigger" onclick={show} aria-haspopup="dialog" aria-label="Settings">
  <svg viewBox="0 0 24 24" width="19" height="19" fill="none" aria-hidden="true">
    <path d="m9 3-.6 2.2-2 .9-2.1-.6-2 3.5 1.5 1.7v2.6L2.3 15l2 3.5 2.1-.6 2 .9L9 21h4l.6-2.2 2-.9 2.1.6 2-3.5-1.5-1.7v-2.6L19.7 9l-2-3.5-2.1.6-2-.9L13 3Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
    <circle cx="11" cy="12" r="3" stroke="currentColor" stroke-width="1.3"/>
  </svg>
  <span><strong>Settings</strong></span>
  <i class:connected class:pending={nativeValidationPending || Boolean(nativeLogin)} aria-hidden="true"></i>
</button>

<dialog bind:this={dialog} aria-labelledby="settings-title" onclose={() => { open = false; trigger.focus(); }}>
  <div class="settings-layout">
    <nav aria-label="Settings sections">
      <h1 id="settings-title">Settings</h1>
      <button class:active={section === "account"} aria-pressed={section === "account"} onclick={() => section = "account"}><Icon name="command" size={16} />Account</button>
      <button class:active={section === "defaults"} aria-pressed={section === "defaults"} onclick={() => section = "defaults"}><Icon name="brief" size={16} />Research defaults</button>
      <button class:active={section === "connections"} aria-pressed={section === "connections"} onclick={() => section = "connections"}><Icon name="research" size={16} />Connections</button>
      <button class:active={section === "local"} aria-pressed={section === "local"} onclick={() => section = "local"}><Icon name="folder" size={16} />Local files</button>
    </nav>
    <div class="settings-content">
      <header><div><h2>{section === "account" ? "Your account" : section === "defaults" ? "Research defaults" : section === "connections" ? "Search connections" : "Local files & help"}</h2></div><button class="close" aria-label="Close settings" onclick={() => dialog.close()}><Icon name="close" /></button></header>
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
  <details class="guide"><summary>User guide</summary><p>Start from any context and choose discovered problems, or start with a known problem and go directly to solutions.</p></details>
  </div>
    </div>
  </div>
</dialog>

<style>
  .settings-trigger { display:flex;align-items:center;gap:11px;width:100%;padding:12px 8px;border:0;border-radius:8px;background:transparent;color:var(--muted);text-align:left; }
  .settings-trigger:hover { background:var(--surface-2);color:var(--text); }
  .settings-trigger strong { font-size:12px;font-weight:550; }
  .settings-trigger svg { flex-shrink:0; }
  i { width:5px;height:5px;flex-shrink:0;margin-left:auto;border-radius:50%;background:var(--danger); }
  i.connected { background:var(--success); }i.pending { background:var(--subtle); }
  dialog { width:min(820px,calc(100vw - 40px));max-height:calc(100dvh - 60px);margin:auto;padding:0;border:1px solid var(--border-strong);border-radius:20px;background:var(--bg);color:var(--text);box-shadow:0 32px 120px #000b;overflow:auto; }
  dialog[open] { animation:settings-open 240ms var(--ease); }
  dialog::backdrop { background:#0009;backdrop-filter:blur(7px); }
  .settings-layout { display:grid;grid-template-columns:205px minmax(0,1fr);min-height:490px; }
  nav { display:flex;flex-direction:column;gap:5px;background:var(--surface);padding:30px 16px 20px;border-right:1px solid var(--border); }
  nav h1 { margin:0 12px 28px;font-size:18px;font-weight:650;letter-spacing:-.03em; }
  nav button { display:flex;gap:10px;align-items:center;border:0;background:transparent;text-align:left;color:var(--muted);padding:12px;font-size:12px; }
  nav button.active { background:var(--surface-2);color:var(--text); }
  nav button.active :global(svg) { color:var(--accent); }
  .settings-content { padding:32px;min-width:0; }
  header { display:flex;align-items:start;justify-content:space-between;gap:16px;margin-bottom:30px; }
  h2 { margin:0;font-size:21px;font-weight:650;letter-spacing:-.03em; }
  button { padding:10px 14px;border:1px solid var(--border-strong);border-radius:8px;background:var(--surface-2);color:var(--text);font-size:11px; }
  button:hover:not(:disabled) { background:var(--border); }
  .close { padding:5px;border:0;background:transparent;color:var(--muted); }
  .account-emblem { display:grid;place-items:center;width:54px;height:54px;border:1px solid #71cfba30;border-radius:17px;background:#71cfba0b;color:var(--accent);margin-bottom:20px; }
  .native-account { display:grid;gap:26px; }
  .native-account > div:first-child { display:grid;gap:10px; }
  .native-account strong { font-size:16px;font-weight:600; }
  .native-account span { color:var(--muted);font-size:12px;overflow-wrap:anywhere; }
  .native-account .account-error { color:var(--danger); }
  .account-actions,.login-progress { display:flex;flex-wrap:wrap;align-items:center;gap:8px; }
  .primary { background:var(--accent-strong);color:var(--accent-ink);border-color:transparent; }
  .primary:hover:not(:disabled) { background:var(--accent); }
  .login-progress { border:1px solid var(--border-strong);padding:16px;border-radius:12px;background:var(--surface); }
  .login-progress code { padding:8px 12px;border:1px solid var(--border-strong);border-radius:6px;font:600 17px var(--mono);letter-spacing:.1em; }
  section h2 { font-size:13px;letter-spacing:0;margin-bottom:16px; }
  .search > h2 { display:none; }
  .provider { display:flex;align-items:center;justify-content:space-between;gap:20px;padding:22px 0;border-bottom:1px solid var(--border);font-size:12px; }
  .provider:first-of-type { border-top:1px solid var(--border); }
  .provider-name { display:flex;align-items:center;gap:14px;color:var(--text); }
  .provider-name :global(svg) { flex:none; }
  .provider strong { font-weight:600; }.provider span { color:var(--muted);max-width:70%;text-align:right;overflow-wrap:anywhere; }
  .provider .ok { color:var(--success); }.search > button { margin-top:24px; }
  .local > div { display:grid;gap:12px; }.local button { padding:16px;text-align:left;background:var(--surface);border-color:var(--border); }
  .feedback { padding:12px;border:1px solid var(--border);border-radius:8px;color:var(--muted);font-size:12px;overflow-wrap:anywhere; }
  .feedback.error { color:var(--danger); }
  .guide { margin-top:28px;color:var(--muted);font-size:12px;line-height:1.7; }.guide summary { cursor:pointer; }
  [hidden] { display:none; }
  @keyframes settings-open { from { opacity:0;transform:translateY(12px) scale(.98); }to { opacity:1;transform:none; } }
  @media(max-width:650px) { .settings-layout { grid-template-columns:1fr; }nav { padding:20px;display:flex;flex-direction:row;flex-wrap:wrap;border-right:0;border-bottom:1px solid var(--border); }nav h1 { width:100%;margin:0 0 10px; }.settings-content { padding:24px; } }
</style>
