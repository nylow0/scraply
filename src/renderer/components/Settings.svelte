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
  let section = $state<"accounts" | "defaults" | "archive" | "local">("accounts");
  let heading: HTMLHeadingElement;
  let screen: HTMLElement;
  let archived = $derived(workspace?.threads.filter(isArchived) ?? []);
  let nativeValidationPending = $derived(workspace?.validation.native.error?.startsWith("Checking ")
    || workspace?.validation.native.error === "Native runtime is starting");
  let nativeModelOptions = $derived(workspace?.modelOptions.filter((item) => item.providerId === "openai-subscription") ?? []);

  // Settings covers the whole window, but the workspace stays mounted underneath so leaving preserves drafts and scroll.
  export async function show() { section = "accounts"; open = true; await tick(); heading.focus(); }
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
  <aside class="settings-panel glass">
    <h1 bind:this={heading} tabindex="-1" id="settings-title">Settings</h1>
    <nav aria-label="Settings sections">
      <button class:active={section === "accounts"} aria-pressed={section === "accounts"} onclick={() => section = "accounts"}><Icon name="account" size={18} />Accounts</button>
      <button class:active={section === "defaults"} aria-pressed={section === "defaults"} onclick={() => section = "defaults"}><Icon name="brief" size={18} />Research defaults</button>
      <button class:active={section === "archive"} aria-pressed={section === "archive"} onclick={() => section = "archive"}><Icon name="archive" size={18} />Archived research</button>
      <button class:active={section === "local"} aria-pressed={section === "local"} onclick={() => section = "local"}><Icon name="folder" size={18} />Local files</button>
    </nav>
    <div class="footer"><button class="back" onclick={back}><Icon name="back" size={20} />Back</button></div>
  </aside>
    <div class="settings-content">
      <header><div><h2>{section === "accounts" ? "Accounts" : section === "defaults" ? "Research defaults" : section === "archive" ? "Archived research" : "Local files"}</h2></div></header>
  <div hidden={section !== "archive"} class="archive-list">
    {#each archived as thread (thread.id)}
      <article><div><strong>{thread.title}</strong><span>{thread.archivedAt ? new Date(thread.archivedAt).toLocaleDateString() : "Archived"}</span></div><button disabled={busy} onclick={() => onRestore(thread.id)} aria-label={`Restore ${thread.title}`}>Restore</button><button class="danger" disabled={busy} onclick={() => deleteArchived(thread.id, thread.title)} aria-label={`Delete ${thread.title}`}>Delete</button></article>
    {:else}<p class="archive-empty">No archived research.</p>{/each}
  </div>
  <div hidden={section !== "defaults"}><ResearchDefaults {workspace} /></div>
  {#if feedback}<p class="feedback" class:error={feedback.tone === "error"} role={feedback.tone === "error" ? "alert" : "status"}>{feedback.text}</p>{/if}
  {#if workspace}
    <!-- Every account Scraply uses, as one list: the OpenAI model account first, then the search providers. -->
    <div hidden={section !== "accounts"} class="accounts">
      <div class="provider native-account" class:needs-connection={!workspace.validation.native.connected && !nativeValidationPending} class:checking={nativeValidationPending} aria-label="OpenAI account">
        <div class="provider-row">
          <div class="provider-name"><OpenAILogo size={22} /><strong>OpenAI</strong></div>
          <div class="provider-status">
            {#if !workspace.validation.native.available}
              <span class:account-error={!nativeValidationPending}>{workspace.validation.native.error ?? "OpenAI sign-in is unavailable right now."}</span>
            {:else if !workspace.validation.native.connected}
              <span class:account-error={Boolean(workspace.validation.native.error)}>{workspace.validation.native.error ?? "Connect OpenAI to start research"}</span>
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
          <div class="account-actions"><button type="button" class="secondary" disabled={busy || nativeValidationPending} onclick={() => onRetry()}>{nativeValidationPending ? "Checking…" : "Try again"}</button></div>
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
      {#each searchProviders as provider (provider)}
        {@const status = workspace.validation[provider]}
        <div class="provider">
          <div class="provider-row">
            <div class="provider-name"><ProviderLogo provider={provider} size={22} /><strong>{provider === "exa" ? "Exa" : "Perplexity"}</strong></div>
            <div class="provider-status"><span class:ok={status.valid}>{status.valid ? "Connected" : status.error ?? "Not connected"}</span></div>
          </div>
        </div>
      {/each}
      <button class="retry" disabled={busy} onclick={onRetry}>{busy ? "Checking…" : "Retry connections"}</button>
    </div>
  {:else}
    <p role="status">Loading account settings…</p>
  {/if}
  <div hidden={section !== "local"}>
  <section class="local" aria-label="Local files">
    <div><button disabled={busy} onclick={onOpenData}>Open data folder</button><button disabled={busy} onclick={onOpenLogs}>Open logs folder</button></div>
  </section>
  </div>
    </div>
</section>

<style>
  /* Settings covers the window with the same floating layout as the research screen: a glass panel on the
     left (title, sections, and Back where the sidebar's Settings button sits) beside a black page panel.
     Panel and row metrics mirror Sidebar.svelte and the settings button in App.svelte so nothing jumps
     when switching between the two screens. */
  .settings-screen { position:fixed;inset:36px 0 0;z-index:20;display:grid;grid-template-columns:var(--sidebar-expanded-width) minmax(0,1fr);gap:10px;padding:2px 10px 10px;background:var(--bg);color:var(--text); }
  .settings-screen[hidden] { display:none; }
  .settings-panel { display:flex;flex-direction:column;gap:6px;padding:12px 10px 8px;border-radius:var(--panel-radius);min-height:0;overflow:auto; }
  .settings-panel h1 { display:flex;align-items:center;min-height:42px;margin:0;padding:10px;font-size:16px;font-weight:650;letter-spacing:-.01em; }
  .settings-panel h1:focus { outline:none; }
  nav { display:flex;flex-direction:column;gap:4px;padding-top:8px; }
  nav button { display:flex;gap:10px;align-items:center;min-height:42px;padding:10px;border:0;border-radius:7px;background:transparent;text-align:left;color:var(--muted);font-size:14px;font-weight:500; }
  nav button :global(svg) { flex:none; }
  nav button:hover:not(:disabled) { background:var(--surface-2);color:var(--text); }
  nav button.active { background:var(--surface-2);color:var(--text); }
  nav button.active :global(svg) { color:var(--accent); }
  .footer { margin-top:auto;padding-top:18px; }
  .back { display:flex;align-items:center;gap:10px;width:100%;min-height:38px;padding:9px 12px;border:0;border-radius:7px;background:transparent;color:var(--muted);font-size:13px;text-align:left;transition:background 180ms ease,color 180ms ease; }
  .back:hover:not(:disabled) { color:var(--text);background:var(--surface-2); }
  /* The column starts on the research page title's left edge and uses its heading type, rather than floating centred. */
  .settings-content { padding:18px 24px 32px;min-width:0;min-height:0;overflow:auto;scrollbar-gutter:stable;border:1px solid var(--glass-edge);border-radius:var(--panel-radius);background:var(--bg);box-shadow:var(--glass-rim); }
  .settings-content > * { max-width:720px; }
  .settings-content > header { display:flex;align-items:start;justify-content:space-between;gap:16px;margin-bottom:24px; }
  h2 { margin:0;font-size:24px;font-weight:600;letter-spacing:-.025em; }
  button { padding:10px 14px;border:1px solid var(--border-strong);border-radius:8px;background:var(--surface-2);color:var(--text);font-size:13px; }
  button:hover:not(:disabled) { background:var(--border); }
  .account-actions,.login-progress { display:flex;flex-wrap:wrap;align-items:center;gap:8px; }
  .primary { background:var(--accent-strong);color:var(--accent-ink);border-color:transparent; }
  .primary:hover:not(:disabled) { background:var(--accent); }
  .login-progress { border:1px solid var(--border-strong);padding:16px;border-radius:12px;background:var(--surface); }
  .login-progress code { padding:8px 12px;border:1px solid var(--border-strong);border-radius:6px;font:600 17px var(--mono);letter-spacing:.1em; }
  /* One row per account: logo and name on the left, status on the right. OpenAI actions sit under its name. */
  .provider { display:grid;gap:16px;padding:22px 0;border-bottom:1px solid var(--border);font-size:13px; }
  .provider:first-child { border-top:1px solid var(--border); }
  .provider-row { display:flex;align-items:center;justify-content:space-between;gap:20px; }
  .provider-name { flex:none;display:flex;align-items:center;gap:14px;color:var(--text); }
  .provider-name :global(svg) { flex:none; }
  .provider strong { font-size:14px;font-weight:600; }
  .provider-status { display:grid;gap:6px;justify-items:end;max-width:70%;min-width:0;text-align:right; }
  .provider-status span { color:var(--muted);overflow-wrap:anywhere; }
  .provider .ok { color:var(--success); }
  .provider .account-error { color:var(--danger); }
  .native-account { gap:10px; }
  .native-account > .login-progress { margin:6px 0 0 36px; }
  /* OpenAI's actions are compact ghost buttons under its status, so the row keeps the list's two-column rhythm.
     The negative margin lines the button text up with the status text above it. */
  .native-account > .account-actions { justify-content:flex-end;gap:2px;margin-right:-10px; }
  .account-actions button { padding:6px 10px;border-color:transparent;border-radius:7px;background:transparent;color:var(--muted); }
  .account-actions button:hover:not(:disabled) { background:var(--surface-2);color:var(--text); }
  .account-actions .primary { background:var(--accent-strong);color:var(--accent-ink); }
  .account-actions .primary:hover:not(:disabled) { background:var(--accent);color:var(--accent-ink); }
  .retry { margin-top:24px; }
  .local > div { display:grid;gap:12px; }.local button { padding:16px;text-align:left;background:var(--surface);border-color:var(--border); }
  .feedback { padding:12px;border:1px solid var(--border);border-radius:8px;color:var(--muted);font-size:13px;overflow-wrap:anywhere; }
  .feedback.error { color:var(--danger); }
  [hidden] { display:none; }
  .archive-list article { display:flex;align-items:center;gap:10px;padding:22px 0;border-bottom:1px solid var(--border); }
  .archive-list article > div { flex:1;min-width:0;display:grid;gap:6px; }
  .archive-list strong { font-size:14px;overflow-wrap:anywhere; }
  .archive-list span,.archive-empty { font-size:13px;color:var(--muted); }
  .danger { color:var(--danger); }
</style>
