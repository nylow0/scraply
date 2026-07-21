<script lang="ts">
  import { untrack } from "svelte";
  import type { ProjectBrief } from "../../shared/schemas";

  let {
    brief,
    onConfirm,
    confirming = false,
  }: {
    brief: ProjectBrief;
    onConfirm: (brief: ProjectBrief) => void;
    confirming?: boolean;
  } = $props();

  let draft = $state({ ...untrack(() => brief) });

  $effect(() => {
    draft = { ...brief };
  });
</script>

<section class="panel">
  <h2>Project brief</h2>
  <div class="grid">
    <label><span>Project name</span><input bind:value={draft.projectName} /></label>
    <label><span>Theme</span><input bind:value={draft.theme} /></label>
    <label class="full"><span>Description</span><textarea bind:value={draft.description} rows="3"></textarea></label>
    <label class="full"><span>Desired output</span><textarea bind:value={draft.desiredOutput} rows="2"></textarea></label>
    <label class="full"><span>Success definition</span><textarea bind:value={draft.successDefinition} rows="2"></textarea></label>
    <label class="full"><span>Final decision</span><textarea bind:value={draft.finalDecision} rows="2"></textarea></label>
  </div>
  <button class="primary" disabled={confirming} onclick={() => onConfirm(draft)}>
    {confirming ? "Confirming…" : "Confirm brief & review cost"}
  </button>
</section>

<style>
  .panel {
    margin: 0 20px 12px;
    padding: 16px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
  }

  h2 {
    margin: 0 0 12px;
    font-size: 14px;
  }

  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }

  .full {
    grid-column: 1 / -1;
  }

  label {
    display: grid;
    gap: 6px;
    font-size: 12px;
    color: var(--muted);
  }

  input,
  textarea {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    padding: 8px 10px;
  }

  button.primary {
    margin-top: 12px;
    border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--border));
    background: color-mix(in srgb, var(--accent) 24%, var(--surface));
    color: var(--text);
    border-radius: 8px;
    padding: 8px 14px;
  }
</style>
