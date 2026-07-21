<script lang="ts">
  import type { Idea } from "../../shared/schemas";

  let {
    idea,
    pending = false,
    onCancel,
    onSubmit,
  }: {
    idea: Idea;
    pending?: boolean;
    onCancel: () => void;
    onSubmit: (explorationAngle: string, selectedClaimIds: string[]) => void;
  } = $props();

  let explorationAngle = $state("");
  let selectedClaimIds = $state<string[]>([]);

  $effect(() => {
    selectedClaimIds = [...idea.supportingClaimIds];
  });

  function toggleClaim(claimId: string) {
    selectedClaimIds = selectedClaimIds.includes(claimId)
      ? selectedClaimIds.filter((id) => id !== claimId)
      : [...selectedClaimIds, claimId];
  }
</script>

<div class="backdrop" role="presentation" onclick={(event) => event.currentTarget === event.target && onCancel()}>
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
      bind:value={explorationAngle}
      placeholder="Example: Validate demand among solo developers before considering implementation."
    ></textarea>

    <fieldset>
      <legend>Supporting claims</legend>
      {#each idea.supportingClaimIds as claimId (claimId)}
        <label class="claim">
          <input
            type="checkbox"
            checked={selectedClaimIds.includes(claimId)}
            onchange={() => toggleClaim(claimId)}
          />
          <code>{claimId}</code>
        </label>
      {/each}
    </fieldset>

    <footer>
      <button class="ghost" type="button" onclick={onCancel} disabled={pending}>Cancel</button>
      <button
        class="primary"
        type="button"
        disabled={pending || explorationAngle.trim().length < 3 || selectedClaimIds.length === 0}
        onclick={() => onSubmit(explorationAngle.trim(), selectedClaimIds)}
      >
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
  .dialog {
    width: min(620px, 100%);
    max-height: min(760px, calc(100vh - 48px));
    overflow: auto;
    padding: 24px;
    border: 1px solid var(--border);
    border-radius: 18px;
    background: var(--surface);
    box-shadow: 0 24px 80px rgb(0 0 0 / 35%);
  }
  header { margin-bottom: 18px; }
  h3 { margin: 4px 0 8px; font-size: 20px; }
  p { margin: 0; color: var(--muted); line-height: 1.5; }
  .eyebrow { color: var(--accent-strong); font-size: 11px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
  label, legend { font-size: 12px; font-weight: 700; }
  textarea {
    width: 100%;
    box-sizing: border-box;
    margin: 8px 0 18px;
    padding: 12px;
    resize: vertical;
    border: 1px solid var(--border);
    border-radius: 10px;
    color: var(--text);
    background: var(--surface-strong);
    font: inherit;
  }
  fieldset { display: grid; gap: 8px; margin: 0; padding: 14px; border: 1px solid var(--border); border-radius: 10px; }
  .claim { display: flex; align-items: center; gap: 9px; font-weight: 500; }
  code { overflow: hidden; text-overflow: ellipsis; color: var(--muted); }
  footer { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }
  button { min-height: 38px; padding: 0 14px; border: 1px solid var(--border); border-radius: 9px; cursor: pointer; }
  button:disabled { cursor: not-allowed; opacity: .55; }
  .ghost { color: var(--text); background: transparent; }
  .primary { border-color: var(--accent-strong); color: white; background: var(--accent-strong); }
</style>
