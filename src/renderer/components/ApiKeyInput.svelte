<script lang="ts">
  import Icon from "./Icon.svelte";

  // Masked field for pasting an API key. The eye button reveals the typed text so a paste can be checked
  // before saving. Saved keys are never loaded back into it; they only exist in the main process.
  // onEscape claims the Escape key (for example to cancel an inline edit) before Settings treats it as "leave".
  let { value = $bindable(""), label, invalid = false, describedby, disabled = false, input = $bindable(), onEscape }: {
    value?: string;
    label: string;
    invalid?: boolean;
    describedby?: string | undefined;
    disabled?: boolean;
    input?: HTMLInputElement | undefined;
    onEscape?: () => void;
  } = $props();
  let shown = $state(false);
</script>

<div class="api-key-input">
  <input bind:this={input} bind:value type={shown ? "text" : "password"} aria-label={label} aria-invalid={invalid}
    aria-describedby={describedby} {disabled} placeholder="Paste API key" autocomplete="off" autocapitalize="off" spellcheck="false"
    onkeydown={(event) => { if (event.key === "Escape" && onEscape) { event.preventDefault(); onEscape(); } }} />
  <button type="button" aria-label="Show key" aria-pressed={shown} {disabled} onclick={() => shown = !shown}><Icon name={shown ? "eye-off" : "eye"} size={16} /></button>
</div>

<style>
  .api-key-input { position:relative;flex:1;min-width:0; }
  input { width:100%;min-width:0;padding:10px 42px 10px 12px;border:1px solid var(--border-strong);border-radius:9px;background:var(--surface);color:var(--text);font:13px var(--mono);letter-spacing:.02em; }
  input::placeholder { color:var(--subtle);font-family:var(--sans);letter-spacing:0; }
  input[aria-invalid="true"] { border-color:var(--danger); }
  button { position:absolute;top:50%;right:5px;display:grid;place-items:center;width:32px;height:32px;padding:0;border:0;border-radius:7px;background:transparent;color:var(--muted);transform:translateY(-50%); }
  button:hover:not(:disabled) { background:var(--surface-2);color:var(--text); }
  button:not(:disabled):active { transform:translateY(-50%); }
</style>
