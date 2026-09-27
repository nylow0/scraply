<script lang="ts">
  import { redactedPlaceholder } from "../lib/redaction";

  // A sensitive value shown as blurred look-alike text. Clicking swaps in the real value; clicking again hides it.
  // While hidden, the accessible name says what the button reveals rather than reading out the placeholder.
  let { value, label }: { value: string; label: string } = $props();
  let revealed = $state(false);
  let placeholder = $derived(redactedPlaceholder(value));
</script>

<button type="button" class="redacted" class:revealed aria-label={revealed ? undefined : `Show ${label}`}
  title={revealed ? `Click to hide ${label}` : `Click to reveal ${label}`} onclick={() => revealed = !revealed}>{revealed ? value : placeholder}</button>

<style>
  /* Monospace in both states, so the placeholder and the real value take the same width and nothing shifts on reveal. */
  .redacted { min-width:0;max-width:100%;margin:0 -3px;padding:0 3px;border:0;border-radius:4px;background:transparent;color:inherit;font:500 12px var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom;filter:blur(4px);user-select:none;transition:filter 160ms var(--ease),color 160ms var(--ease); }
  .redacted:hover { color:var(--text); }
  .redacted.revealed { filter:none;user-select:text; }
  .redacted:not(:disabled):active { transform:none; }
  @media (prefers-reduced-motion: reduce) { .redacted { transition:none; } }
</style>
