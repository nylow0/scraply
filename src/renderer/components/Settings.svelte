<script lang="ts">
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
  let dialog: HTMLDialogElement;
  let trigger: HTMLButtonElement;
  let nativeValidationPending = $derived(workspace?.validation.native.error?.startsWith("Checking ")
    || workspace?.validation.native.error === "Native runtime is starting");
  let nativeModelOptions = $derived(workspace?.modelOptions.filter((item) => item.providerId === "openai-subscription") ?? []);
  let connected = $derived(Boolean(workspace?.validation.native.connected));

  // Native modal behavior provides focus containment and Escape dismissal.
  // The setup form stays mounted, so opening settings never discards a draft.
  export function show() { dialog.showModal(); open = true; }
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
  <header>
    <div><h1 id="settings-title">Settings</h1><p>Account and connections</p></div>
    <button class="close" aria-label="Close settings" onclick={() => dialog.close()}>×</button>
  </header>
  {#if feedback}<p class="feedback" class:error={feedback.tone === "error"} role={feedback.tone === "error" ? "alert" : "status"}>{feedback.text}</p>{/if}
  {#if workspace}
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


    <section class="search" aria-labelledby="search-title">
      <h2 id="search-title">Search connections</h2>
      {#each searchProviders as provider (provider)}
        {@const status = workspace.validation[provider]}
        <div class="provider">
          <strong>{provider === "exa" ? "Exa" : "Perplexity"}</strong>
          <span class:ok={status.valid}>{status.valid ? "Connected" : status.error ?? "Not connected"}</span>
        </div>
      {/each}
      <button disabled={busy} onclick={onRetry}>{busy ? "Checking…" : "Retry connections"}</button>
    </section>
  {:else}
    <p role="status">Loading account settings…</p>
  {/if}
  <section class="local" aria-labelledby="local-title">
    <h2 id="local-title">Local files</h2>
    <div><button disabled={busy} onclick={onOpenData}>Open data folder</button><button disabled={busy} onclick={onOpenLogs}>Open logs folder</button></div>
  </section>
  <details class="guide"><summary>User guide</summary><p>Start from any context and choose discovered problems, or start with a known problem and go directly to solutions.</p></details>
</dialog>

<style>
  .settings-trigger { display:flex;align-items:center;gap:11px;width:100%;padding:10px 8px;border:0;border-radius:8px;background:transparent;color:var(--muted);text-align:left; }
  .settings-trigger:hover { background:var(--surface-2);color:var(--text); }
  .settings-trigger > span { display:grid;gap:3px;min-width:0; }
  .settings-trigger strong { color:var(--text);font-size:13px;font-weight:550; }
  .settings-trigger svg { flex-shrink:0; }
  i { width:6px;height:6px;flex-shrink:0;margin-left:auto;border-radius:50%;background:var(--danger); }
  i.connected { background:var(--success); } i.pending { background:var(--subtle); }
  dialog { width:min(540px,calc(100vw - 32px));max-height:calc(100dvh - 48px);margin:auto;padding:28px;border:1px solid var(--border-strong);border-radius:16px;background:var(--bg);color:var(--text);box-shadow:0 24px 80px #0008;overflow-y:auto; }
  dialog::backdrop { background:#0007; }
  header { display:flex;align-items:start;justify-content:space-between;gap:16px;margin-bottom:26px; }
  h1 { margin:0;font-size:22px;font-weight:600;letter-spacing:-.025em; }
  h2 { margin:0 0 16px;font-size:13px;font-weight:600; }
  header p { margin:6px 0 0;font-size:13px;color:var(--muted); }
  button { padding:8px 12px;border:1px solid var(--border-strong);border-radius:7px;background:var(--surface-2);color:var(--text);font-size:12px; }
  button:hover:not(:disabled) { background:var(--border); }
  button:disabled { opacity:.45; }
  .close { padding:0;width:30px;height:30px;font-size:22px;border:0;background:transparent;color:var(--muted); }
  .native-account { display:grid;gap:18px;padding:20px;border:1px solid var(--border);border-radius:10px;background:var(--surface); }
  .native-account > div:first-child { display:grid;gap:6px; }
  .native-account strong { font-size:14px;font-weight:550; }
  .native-account span { color:var(--muted);font-size:12px;overflow-wrap:anywhere; }
  .native-account .account-error { color:var(--danger); }
  .account-actions,.login-progress { display:flex;flex-wrap:wrap;align-items:center;gap:8px; }
  .primary { background:var(--accent-strong);color:var(--accent-ink);border-color:transparent; }
  .primary:hover:not(:disabled) { background:var(--accent); }
  .login-progress code { padding:8px 12px;border:1px solid var(--border-strong);border-radius:6px;font:600 15px var(--mono);letter-spacing:.06em; }
  section { margin-top:24px;padding-top:22px;border-top:1px solid var(--border); }
  .provider { display:flex;align-items:start;justify-content:space-between;gap:20px;margin:14px 0;font-size:12px; }
  .provider strong { font-weight:500; } .provider span { color:var(--muted);max-width:70%;text-align:right;overflow-wrap:anywhere; }
  .provider .ok { color:var(--success); }
  .local > div { display:flex;gap:8px;flex-wrap:wrap; }
  .feedback { padding:12px;border:1px solid var(--border);border-radius:8px;color:var(--muted);font-size:12px;overflow-wrap:anywhere; }
  .feedback.error { color:var(--danger); }
  .guide { margin-top:24px;color:var(--muted);font-size:12px; } .guide summary { cursor:pointer; }
</style>
