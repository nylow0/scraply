<script lang="ts">
  import type { ValidationState } from "../../shared/ipc";

  let {
    validation,
    opencode = $bindable(""),
    exa = $bindable(""),
    error,
    onSave,
    onImportEnv,
  }: {
    validation: ValidationState | null;
    opencode: string;
    exa: string;
    error: string | null;
    onSave: () => void;
    onImportEnv: () => void;
  } = $props();
</script>

<div class="setup">
  <section class="card" aria-labelledby="setup-title">
    <p class="eyebrow">First launch</p>
    <h1 id="setup-title">Connect Scraply</h1>
    <p class="lede">Enter your OpenCode and Exa keys. They stay encrypted locally and never appear in logs.</p>

    <label>
      <span>OpenCode API key</span>
      <input type="password" bind:value={opencode} autocomplete="off" aria-label="OpenCode API key" />
    </label>
    <label>
      <span>Exa API key</span>
      <input type="password" bind:value={exa} autocomplete="off" aria-label="Exa API key" />
    </label>

    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}

    <div class="actions">
      <button class="primary" aria-label="Validate API keys and continue" onclick={onSave}>Validate and continue</button>
      <button class="ghost" aria-label="Import API keys from local env file" onclick={onImportEnv}>Import from .env (dev)</button>
    </div>

    {#if validation}
      <div class="checks">
        <div class:ok={validation.opencode.valid} class:bad={!validation.opencode.valid}>
          OpenCode {validation.opencode.valid ? `· ${validation.opencode.modelCount} models` : `· ${validation.opencode.error ?? "invalid"}`}
        </div>
        <div class:ok={validation.exa.valid} class:bad={!validation.exa.valid}>
          Exa {validation.exa.valid ? "· connected" : `· ${validation.exa.error ?? "invalid"}`}
        </div>
        <div class:ok={validation.codex.compatible} class:muted={!validation.codex.detected}>
          Codex {validation.codex.detected ? (validation.codex.compatible ? `· ${validation.codex.version ?? "ready"}` : "· optional, incompatible") : "· not detected (optional)"}
        </div>
      </div>
      {#if validation.opencode.valid && validation.opencode.models.length}
        <p class="models">Models: {validation.opencode.models.slice(0, 8).join(", ")}{validation.opencode.models.length > 8 ? "…" : ""}</p>
      {/if}
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
    width: min(520px, 100%);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 24px;
  }

  .eyebrow {
    margin: 0 0 8px;
    color: var(--accent-strong);
    font-family: var(--mono);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  h1 {
    margin: 0 0 8px;
    font-size: 24px;
  }

  .lede {
    margin: 0 0 20px;
    color: var(--muted);
  }

  label {
    display: grid;
    gap: 6px;
    margin-bottom: 12px;
  }

  input {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    padding: 10px 12px;
  }

  .actions {
    display: flex;
    gap: 8px;
    margin-top: 16px;
  }

  button {
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text);
    border-radius: 8px;
    padding: 10px 14px;
  }

  button.primary {
    background: color-mix(in srgb, var(--accent) 24%, var(--surface));
  }

  button.ghost {
    background: transparent;
  }

  button:focus-visible,
  input:focus-visible {
    outline: 2px solid var(--accent-strong);
    outline-offset: 2px;
  }

  .checks {
    margin-top: 20px;
    display: grid;
    gap: 8px;
    font-family: var(--mono);
    font-size: 12px;
  }

  .ok { color: var(--accent-strong); }
  .bad { color: var(--danger); }
  .muted { color: var(--muted); }
  .error { color: var(--danger); }
  .models { color: var(--muted); font-size: 12px; margin-top: 12px; }
</style>
