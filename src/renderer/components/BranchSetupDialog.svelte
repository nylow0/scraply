<script lang="ts">
  import { untrack } from "svelte";
  import type { Idea, IdeaEvidence } from "../../shared/schemas";

  let {
    idea,
    evidence = [],
    pending = false,
    onCancel,
    onSubmit,
  }: {
    idea: Idea;
    evidence?: IdeaEvidence[];
    pending?: boolean;
    onCancel: () => void;
    onSubmit: (explorationAngle: string, selectedClaimIds: string[]) => void;
  } = $props();

  let explorationAngle = $state("");
  let selectedClaimIds = $state<string[]>(untrack(() => [...idea.supportingClaimIds]));

  // Reset only when the dialog is pointed at a different idea. Reacting to the
  // array itself would discard the user's checkbox choices on every refresh.
  let syncedIdeaId = untrack(() => idea.id);

  $effect(() => {
    if (idea.id === syncedIdeaId) return;
    syncedIdeaId = idea.id;
    selectedClaimIds = untrack(() => [...idea.supportingClaimIds]);
    explorationAngle = "";
  });

  /** Evidence gives each opaque claim ID a readable source and quote. */
  const claimSources = $derived.by(() => {
    const map = new Map<string, IdeaEvidence>();
    for (const item of evidence) {
      if (!map.has(item.claimId)) map.set(item.claimId, item);
    }
    return map;
  });

  const canSubmit = $derived(!pending && explorationAngle.trim().length >= 3 && selectedClaimIds.length > 0);

  function toggleClaim(claimId: string) {
    selectedClaimIds = selectedClaimIds.includes(claimId)
      ? selectedClaimIds.filter((id) => id !== claimId)
      : [...selectedClaimIds, claimId];
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape" && !pending) onCancel();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="backdrop" role="presentation" onclick={(event) => event.currentTarget === event.target && !pending && onCancel()}>
  <dialog open class="dialog" aria-labelledby="branch-title">
    <header>
      <p class="eyebrow">Focused child branch</p>
      <h3 id="branch-title">Explore “{idea.title}”</h3>
      <p>The confirmed brief will be inherited. Choose one angle and the evidence this branch should carry forward.</p>
    </header>

    <label for="exploration-angle">Exploration angle</label>
    <textarea
      id="exploration-angle"
      rows="4"
      maxlength="1000"
      disabled={pending}
      bind:value={explorationAngle}
      placeholder="Example: Validate demand among solo developers before considering implementation."
    ></textarea>

    <fieldset>
      <legend>Supporting evidence to carry forward</legend>
      {#each idea.supportingClaimIds as claimId (claimId)}
        {@const source = claimSources.get(claimId)}
        <label class="claim">
          <input
            type="checkbox"
            disabled={pending}
            checked={selectedClaimIds.includes(claimId)}
            onchange={() => toggleClaim(claimId)}
          />
          <span class="claim-body">
            <span class="claim-title">{source?.sourceTitle ?? "Untitled source"}</span>
            {#if source?.quote}
              <span class="claim-quote">{source.quote}</span>
            {:else}
              <span class="claim-quote muted">Open the idea's evidence list to load the supporting quote.</span>
            {/if}
          </span>
        </label>
      {:else}
        <p class="no-claims">This idea has no supporting claims, so it cannot seed a focused branch.</p>
      {/each}
    </fieldset>

    <p class="selection-count" aria-live="polite">
      {selectedClaimIds.length} of {idea.supportingClaimIds.length} selected
    </p>

    <footer>
      <button class="ghost" type="button" onclick={onCancel} disabled={pending}>Cancel</button>
      <button class="primary" type="button" disabled={!canSubmit} onclick={() => onSubmit(explorationAngle.trim(), selectedClaimIds)}>
        {pending ? "Creating branch…" : "Create focused branch"}
      </button>
    </footer>
  </dialog>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 30;
    display: grid;
    place-items: center;
    padding: 24px;
    background: rgb(10 12 16 / 62%);
    backdrop-filter: blur(5px);
  }

  /* The UA stylesheet gives an open <dialog> position:absolute and
     inset-inline-start:0, which pins it to the left instead of letting the
     backdrop's grid centre it. */
  .dialog {
    position: static;
    width: min(620px, 100%);
    max-height: min(760px, calc(100vh - 48px));
    margin: 0;
    overflow: auto;
    padding: 24px;
    border: 1px solid var(--border);
    border-radius: 18px;
    color: var(--text);
    background: var(--surface);
    box-shadow: 0 24px 80px rgb(0 0 0 / 35%);
  }

  header { margin-bottom: 18px; }
  h3 { margin: 4px 0 8px; font-size: 19px; letter-spacing: -0.025em; }
  header p { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.5; }

  .eyebrow {
    color: var(--accent-strong);
    font-family: var(--mono);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.09em;
    text-transform: uppercase;
  }

  label,
  legend {
    font-size: 12px;
    font-weight: 700;
  }

  textarea {
    width: 100%;
    margin: 8px 0 18px;
    padding: 12px;
    resize: vertical;
    border: 1px solid var(--border);
    border-radius: 10px;
    color: var(--text);
    background: var(--bg);
    font: inherit;
    line-height: 1.5;
  }

  textarea:focus {
    outline: none;
    border-color: color-mix(in srgb, var(--accent) 68%, var(--border));
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent);
  }

  fieldset {
    display: grid;
    gap: 10px;
    margin: 0;
    padding: 14px;
    border: 1px solid var(--border);
    border-radius: 10px;
  }

  .claim {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: start;
    gap: 10px;
    font-weight: 500;
  }

  .claim input {
    margin: 2px 0 0;
    accent-color: var(--accent-strong);
  }

  .claim-body {
    min-width: 0;
    display: grid;
    gap: 3px;
  }

  .claim-title {
    font-size: 12px;
    font-weight: 650;
    overflow-wrap: anywhere;
  }

  .claim-quote {
    color: var(--muted);
    font-size: 11px;
    font-weight: 400;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }

  .claim-quote.muted {
    color: var(--subtle);
    font-style: italic;
  }

  .no-claims,
  .selection-count {
    margin: 0;
    color: var(--muted);
    font-size: 11px;
  }

  .selection-count {
    margin-top: 9px;
    font-family: var(--mono);
  }

  footer { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }

  button {
    min-height: 38px;
    padding: 0 14px;
    border: 1px solid var(--border);
    border-radius: 9px;
    font-weight: 650;
  }

  button:disabled { cursor: not-allowed; opacity: 0.55; }

  .ghost { color: var(--muted); background: transparent; }
  .ghost:hover:not(:disabled) { border-color: var(--border-strong); color: var(--text); }
  .primary { border-color: var(--accent-strong); color: var(--accent-ink); background: var(--accent-strong); }
</style>
