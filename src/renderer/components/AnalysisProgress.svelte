<script lang="ts">
  import type { WorkspaceState } from "../../shared/ipc";
  import Icon from "./Icon.svelte";
  let { run, elapsed = "", stage = "Preparing", busy = false, onStop }: {
    run: NonNullable<WorkspaceState["latestResearchRun"]>; elapsed?: string; stage?: string; busy?: boolean;
    onStop: (runId: string) => Promise<void>;
  } = $props();
</script>

<div class="analysis-progress" role="status" aria-label="Active idea work">
  <Icon name="progress" size={18} /><span>{run.stage === "evaluating-risk" ? "Reviewing risks" : run.stage === "analyzing-option" ? "Analyzing" : stage}</span>
  {#if elapsed}<span class="elapsed">{elapsed}</span>{/if}
  <button disabled={busy} onclick={() => onStop(run.runId)}>Stop</button>
</div>

<style>
  .analysis-progress { display:flex;align-items:center;gap:12px;padding:16px 0;border-bottom:1px solid var(--border);color:var(--text);font-size:15px;line-height:1.6; }
  .elapsed { color:var(--muted);font-size:13px;font-variant-numeric:tabular-nums; }
  button { margin-left:auto;border:1px solid var(--border-strong);border-radius:7px;background:transparent;padding:7px 12px;color:var(--text);font-size:13px;cursor:pointer; }
  button:hover { background:var(--surface-2); }button:disabled { opacity:.5; }
</style>
