<script lang="ts">
  import { onMount } from "svelte";
  import BrandMark from "./BrandMark.svelte";
  import type { NativeLoginStartResult } from "../../shared/ipc";

  // Shown by App while OpenAI is signed out: on first launch, after signing out, or when a session is lost.
  // Mounting opens it; App unmounts it once the account connects or the user picks "Not now".
  let { returning, busy, nativeLogin, error, onConnect, onCancel, onDismiss }: {
    returning: boolean;
    busy: boolean;
    nativeLogin: NativeLoginStartResult | null;
    error: string | null;
    onConnect: (method: "browser" | "device") => void;
    onCancel: () => void;
    onDismiss: () => void;
  } = $props();

  let dialog: HTMLDialogElement;
  onMount(() => dialog.showModal());
</script>

<dialog bind:this={dialog} class="welcome glass-dense" aria-labelledby="welcome-title" aria-describedby="welcome-body"
  oncancel={(event) => { event.preventDefault(); if (!nativeLogin) onDismiss(); }}>
  <BrandMark size={44} />
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
  @keyframes welcome-open { from { opacity:0;transform:translateY(6px) scale(.98); }to { opacity:1;transform:none; } }
  @keyframes pulse { to { opacity:.3; } }
  @media (prefers-reduced-motion: reduce) { .welcome[open],.progress i { animation:none; } }
</style>
