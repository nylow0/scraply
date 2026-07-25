<script lang="ts">
  import type { ValidationState } from "../../shared/ipc";

  let {
    validation,
    error,
    saving = false,
    canImportEnv = false,
    onSave,
    onImportEnv,
    onOpenData,
    onOpenLogs,
  }: {
    validation: ValidationState | null;
    error: string | null;
    saving?: boolean;
    canImportEnv?: boolean;
    onSave: (opencodeApiKey: string, exaApiKey: string) => void;
    onImportEnv: () => void;
    onOpenData: () => void | Promise<void>;
    onOpenLogs: () => void | Promise<void>;
  } = $props();

  let opencodeApiKey = $state("");
  let exaApiKey = $state("");
</script>

<div class="setup">
  <section class="card" aria-labelledby="setup-title">
    <p class="eyebrow">First launch</p>
    <h1 id="setup-title">Connect Scraply</h1>
    <p class="lede">
      Exa is required for research. Use your local Codex login, or add an OpenCode key as the model provider.
      Keys are encrypted on this device and are never shown again.
    </p>

    <label>
      <span>Exa API key <strong>Required</strong></span>
      <input type="password" bind:value={exaApiKey} autocomplete="off" aria-label="Exa API key" />
    </label>
    <label>
      <span>OpenCode API key <small>Optional when Codex is ready</small></span>
      <input type="password" bind:value={opencodeApiKey} autocomplete="off" aria-label="OpenCode API key" />
    </label>

    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}

    <div class="actions">
      <button
        class="primary"
        disabled={saving || !exaApiKey.trim()}
        aria-label="Validate API keys and continue"
        onclick={() => onSave(opencodeApiKey, exaApiKey)}
      >{saving ? "Validating…" : "Validate and continue"}</button>
      {#if canImportEnv}
        <button class="ghost" disabled={saving} onclick={onImportEnv}>Import development .env</button>
      {/if}
      <button class="ghost" onclick={onOpenData}>Open data folder</button>
      <button class="ghost" onclick={onOpenLogs}>Open logs folder</button>
    </div>

    {#if validation}
      <div class="checks" aria-label="Provider validation">
        <div class:ok={validation.exa.valid} class:bad={!validation.exa.valid}>
          Exa {validation.exa.valid ? "· connected" : `· ${validation.exa.error ?? "required"}`}
        </div>
        <div class:ok={validation.codex.compatible} class:bad={validation.codex.detected && !validation.codex.compatible} class:muted={!validation.codex.detected}>
          Codex {validation.codex.detected ? (validation.codex.compatible ? `· ${validation.codex.version ?? "ready"}` : `· ${validation.codex.error ?? "incompatible"}`) : "· not detected"}
        </div>
        <div class:ok={validation.opencode.valid} class:muted={!validation.opencode.valid}>
          OpenCode {validation.opencode.valid ? `· ${validation.opencode.modelCount} models` : `· ${validation.opencode.error ?? "optional"}`}
        </div>
      </div>
    {/if}
  </section>
</div>

<style>
  .setup {
    min-height: 100%;
    display: grid;
    place-items: center;
    padding: 24px;
  }

  .card {
    width: min(560px, 100%);
    padding: 28px;
    border: 1px solid var(--border);
    border-radius: 14px;
    background: var(--surface);
  }

  .eyebrow {
    margin: 0 0 8px;
    color: var(--accent-strong);
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  h1 {
    margin: 0 0 10px;
    font-size: 26px;
    letter-spacing: -0.03em;
  }

  .lede {
    margin: 0 0 22px;
    color: var(--muted);
  }

  label {
    display: grid;
    gap: 7px;
    margin-bottom: 14px;
  }

  label span {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    font-size: 12px;
  }

  label strong {
    color: var(--accent-strong);
    font-size: 10px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  label small {
    color: var(--muted);
  }

  input {
    min-height: 42px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 9px;
    background: var(--bg);
    color: var(--text);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 18px;
  }

  button {
    padding: 10px 14px;
    border: 1px solid var(--border);
    border-radius: 9px;
    background: var(--surface-2);
    color: var(--text);
    font-weight: 650;
  }

  button.primary {
    border-color: var(--accent-strong);
    background: var(--accent-strong);
    color: var(--accent-ink);
  }

  button.ghost {
    background: transparent;
  }

  .checks {
    display: grid;
    gap: 8px;
    margin-top: 22px;
    padding-top: 18px;
    border-top: 1px solid var(--border);
    font-family: var(--mono);
    font-size: 12px;
  }

  .ok { color: var(--success); }
  .bad,
  .error { color: var(--danger); }
  .muted { color: var(--muted); }

  .error {
    margin: 8px 0 0;
  }
</style>
