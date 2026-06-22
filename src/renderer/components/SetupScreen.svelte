<script lang="ts">
  import type { ValidationState } from "../../shared/ipc";

  let {
    validation,
    opencode = $bindable(""),
    exa = $bindable(""),
    error,
    busy,
    onSave,
    onImportEnv,
  }: {
    validation: ValidationState | null;
    opencode: string;
    exa: string;
    error: string | null;
    busy: "save" | "import" | null;
    onSave: () => void;
    onImportEnv: () => void;
  } = $props();

  const keysReady = $derived(opencode.trim().length > 0 && exa.trim().length > 0);
  const setupReady = $derived(Boolean(validation?.setupComplete));
</script>

<main class="setup">
  <section class="intro" aria-label="About Scraply">
    <div>
      <p class="wordmark">SCRAPLY / LOCAL RESEARCH</p>
      <h1>Research that stays<br />on your machine.</h1>
      <p class="intro-copy">Turn a rough question into a structured brief, six focused research streams, and ideas you can actually compare.</p>
    </div>
    <ol class="flow" aria-label="Scraply workflow">
      <li><span>01</span><strong>Shape the brief</strong><small>Fill in goals, constraints, and success criteria</small></li>
      <li><span>02</span><strong>Run the evidence pass</strong><small>Bounded by your model and spend limits</small></li>
      <li><span>03</span><strong>Build the shortlist</strong><small>Separate scores, sources, and ratings</small></li>
    </ol>
    <p class="privacy">No account. No telemetry. Your keys are encrypted locally.</p>
  </section>

  <section class="card" aria-labelledby="setup-title">
    <p class="eyebrow">First launch</p>
    <h2 id="setup-title">Connect Scraply</h2>
    <p class="lede">Two API keys unlock the app. They stay encrypted on this device and never appear in logs.</p>

    <form
      class="form"
      onsubmit={(e) => {
        e.preventDefault();
        if (keysReady && busy === null) onSave();
      }}
    >
      <label>
        <span>OpenCode API key <small class="key-role">— powers model calls</small></span>
        <input
          type="password"
          bind:value={opencode}
          autocomplete="off"
          aria-label="OpenCode API key"
          placeholder="sk-…"
        />
      </label>
      <label>
        <span>Exa API key <small class="key-role">— powers web search</small></span>
        <input
          type="password"
          bind:value={exa}
          autocomplete="off"
          aria-label="Exa API key"
          placeholder="exa-…"
        />
      </label>

      <details class="help">
        <summary>Where do I get these keys?</summary>
        <ul>
          <li><strong>OpenCode</strong> — sign in at your OpenCode provider and create an API key for chat models.</li>
          <li><strong>Exa</strong> — create an account at <a href="https://exa.ai" target="_blank" rel="noopener noreferrer">exa.ai</a> and copy your API key from the dashboard.</li>
          <li><strong>Codex CLI</strong> — optional. If installed, Scraply can use it for certain workflows; setup works without it.</li>
        </ul>
      </details>

      {#if error}
        <p class="error" role="alert">{error}</p>
      {:else if setupReady}
        <p class="success" role="status">Both keys validated — opening Scraply…</p>
      {:else if !keysReady}
        <p class="hint">Enter both keys, then validate to continue.</p>
      {/if}

      <div class="actions">
        <button type="submit" class="primary" aria-label="Validate API keys and continue" disabled={busy !== null || !keysReady}>
          {busy === "save" ? "Validating…" : "Validate and continue"}
        </button>
        <button type="button" class="ghost" aria-label="Import API keys from local env file" disabled={busy !== null} onclick={onImportEnv}>
          {busy === "import" ? "Importing…" : "Import from .env"}
        </button>
      </div>
      <p class="env-hint">
        Import looks for <code>OPENCODE_API_KEY</code> and <code>EXA_API_KEY</code> in a <code>.env</code> file in your Scraply data folder (or the project root when running from source).
      </p>
    </form>

    {#if validation}
      <div class="checks" aria-label="Provider validation results">
        <div class="check" data-state={validation.opencode.valid ? "ok" : "bad"}>
          <span class="ind" aria-hidden="true">{validation.opencode.valid ? "✓" : "✕"}</span>
          <span><span class="check-name">OpenCode</span> {validation.opencode.valid ? `· ${validation.opencode.modelCount} models` : `· ${validation.opencode.error ?? "invalid"}`}</span>
        </div>
        <div class="check" data-state={validation.exa.valid ? "ok" : "bad"}>
          <span class="ind" aria-hidden="true">{validation.exa.valid ? "✓" : "✕"}</span>
          <span><span class="check-name">Exa</span> {validation.exa.valid ? "· connected" : `· ${validation.exa.error ?? "invalid"}`}</span>
        </div>
        <div class="check" data-state={validation.codex.compatible ? "ok" : validation.codex.detected ? "bad" : "muted"}>
          <span class="ind" aria-hidden="true">{validation.codex.compatible ? "✓" : validation.codex.detected ? "✕" : "○"}</span>
          <span><span class="check-name">Codex</span> {validation.codex.detected ? (validation.codex.compatible ? `· ${validation.codex.version ?? "ready"}` : "· optional, incompatible") : "· not detected (optional)"}</span>
        </div>
      </div>
      {#if validation.opencode.valid && validation.opencode.models.length}
        <p class="models">Models: {validation.opencode.models.slice(0, 8).join(", ")}{validation.opencode.models.length > 8 ? "…" : ""}</p>
      {/if}
    {/if}
  </section>
</main>

<style>
  .setup {
    min-height: 100%;
    display: grid;
    grid-template-columns: minmax(0, 1.1fr) minmax(420px, 0.9fr);
    align-items: stretch;
    padding: 20px;
    gap: 20px;
  }

  .intro {
    position: relative;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    min-height: calc(100dvh - 40px);
    padding: clamp(32px, 6vw, 76px);
    border: 1px solid var(--border);
    border-radius: var(--r-xl);
    background:
      radial-gradient(120% 80% at 0% 0%, color-mix(in srgb, var(--accent) 12%, transparent), transparent 55%),
      linear-gradient(160deg, var(--surface), var(--bg) 90%);
    overflow: hidden;
  }

  .wordmark,
  .privacy {
    margin: 0;
    color: var(--accent-strong);
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.09em;
  }

  .intro h1 {
    max-width: 760px;
    margin: 22px 0 0;
    font-size: clamp(38px, 5vw, 68px);
    font-weight: 540;
    letter-spacing: -0.055em;
    line-height: 0.98;
  }

  .intro-copy {
    max-width: 56ch;
    margin: 24px 0 0;
    color: var(--muted);
    font-size: 16px;
  }

  .flow {
    display: grid;
    gap: 0;
    margin: 56px 0;
    padding: 0;
    list-style: none;
    border-top: 1px solid var(--border);
  }

  .flow li {
    display: grid;
    grid-template-columns: 48px 1fr;
    gap: 2px 14px;
    padding: 16px 0;
    border-bottom: 1px solid var(--border);
  }

  .flow span {
    grid-row: 1 / 3;
    color: var(--accent-strong);
    font-family: var(--mono);
    font-size: 11px;
  }

  .flow strong { font-weight: 560; }
  .flow small { color: var(--muted); font-size: 12px; }

  .privacy { color: var(--muted); letter-spacing: 0; }

  .card {
    width: min(520px, 100%);
    align-self: center;
    justify-self: center;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-xl);
    padding: clamp(24px, 4vw, 40px);
    box-shadow: var(--shadow-lg), var(--shadow-inset);
  }

  .eyebrow {
    margin: 0 0 8px;
    color: var(--accent-strong);
    font-family: var(--mono);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  h2 {
    margin: 0 0 8px;
    font-size: 25px;
    letter-spacing: -0.025em;
  }

  .lede {
    margin: 0 0 20px;
    color: var(--muted);
  }

  .form {
    display: grid;
  }

  label {
    display: grid;
    gap: 6px;
    margin-bottom: 12px;
  }

  label span {
    font-size: 12px;
    color: var(--text-2);
    font-weight: 450;
  }

  .key-role {
    color: var(--muted);
    font-weight: 400;
  }

  input {
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-md);
    color: var(--text);
    padding: 10px 12px;
    transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
  }

  input:focus {
    border-color: var(--accent-border);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 15%, transparent);
  }

  .help {
    margin: 0 0 12px;
    font-size: 13px;
    color: var(--text-2);
  }

  .help summary {
    cursor: pointer;
    color: var(--accent-strong);
    font-weight: 500;
    list-style: none;
  }

  .help summary::-webkit-details-marker { display: none; }

  .help ul {
    margin: 10px 0 0;
    padding-left: 18px;
    color: var(--muted);
    line-height: 1.55;
  }

  .help a {
    color: var(--accent-strong);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .actions {
    display: flex;
    gap: var(--space-2);
    margin-top: var(--space-2);
  }

  button {
    border: 1px solid var(--border-strong);
    background: var(--surface-2);
    color: var(--text);
    border-radius: var(--r-md);
    padding: 10px 16px;
    font-weight: 500;
    transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease),
      transform var(--dur-fast) var(--ease);
  }

  button.primary {
    background: var(--accent-bg);
    border-color: var(--accent-border);
    color: var(--accent-strong);
  }

  button.primary:hover:not(:disabled) { background: var(--accent-bg-hover); }

  button.ghost {
    background: transparent;
    color: var(--text-2);
  }

  button:hover:not(:disabled) { border-color: var(--border-strong); }
  button.ghost:hover:not(:disabled) { background: var(--surface-2); }
  button:active:not(:disabled) { transform: translateY(1px); }
  button:disabled { cursor: not-allowed; opacity: 0.6; }

  button:focus-visible,
  input:focus-visible,
  .help summary:focus-visible {
    outline: 2px solid var(--accent-strong);
    outline-offset: 2px;
  }

  .hint,
  .env-hint {
    margin: var(--space-3) 0 0;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.5;
  }

  .env-hint code {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-2);
  }

  .success {
    color: var(--accent-strong);
    background: var(--accent-faint);
    border: 1px solid var(--accent-border);
    border-radius: var(--r-md);
    padding: 9px 12px;
    margin: var(--space-3) 0 0;
    font-size: 13px;
  }

  .checks {
    margin-top: var(--space-5);
    display: grid;
    gap: var(--space-2);
    padding-top: var(--space-4);
    border-top: 1px solid var(--hairline);
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
  }

  .check {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .ind {
    flex-shrink: 0;
    width: 16px;
    height: 16px;
    display: grid;
    place-items: center;
    border-radius: var(--r-sm);
    font-size: 10px;
    line-height: 1;
    border: 1px solid var(--border);
    color: var(--muted);
  }

  .check-name { color: var(--text-2); }

  .check[data-state="ok"] .ind { color: var(--accent-strong); border-color: var(--accent-border); background: var(--accent-faint); }
  .check[data-state="ok"] .check-name { color: var(--accent-strong); }
  .check[data-state="bad"] .ind { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, var(--border)); }
  .check[data-state="bad"] { color: var(--danger); }

  .error {
    color: var(--danger);
    background: var(--danger-bg);
    border: 1px solid color-mix(in srgb, var(--danger) 35%, var(--border));
    border-radius: var(--r-md);
    padding: 9px 12px;
    margin: var(--space-3) 0 0;
    font-size: 13px;
  }

  .models { color: var(--muted); font-size: 11px; margin-top: var(--space-3); line-height: 1.6; font-family: var(--mono); }

  @media (max-width: 900px) {
    .setup { grid-template-columns: 1fr; padding: 12px; }
    .intro { min-height: auto; padding: 32px; }
    .intro h1 { font-size: clamp(36px, 10vw, 52px); }
    .flow { margin: 40px 0; }
    .card { margin: 20px 0; }
  }

  @media (max-width: 520px) {
    .actions { display: grid; }
    .intro { padding: 24px; }
  }
</style>
