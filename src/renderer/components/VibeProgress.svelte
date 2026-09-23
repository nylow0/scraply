<script lang="ts">
  import { untrack } from "svelte";
  import type { z } from "zod";
  import type { WorkflowDetail, WorkflowSummary } from "../../shared/workflow-contracts";
  import { PreviewWorkflowResultSchema } from "../../shared/workflow-contracts";

  type WorkflowTask = WorkflowDetail["tasks"][number];
  type BudgetExtension = { additionalModelCalls: number; additionalSearches: number; additionalMinutes: number };
  type WorkflowPreview = z.infer<typeof PreviewWorkflowResultSchema>;

  let {
    detail,
    busy,
    onPause,
    onStop,
    onResume,
    onRetryTask,
    onLoadMoreTasks,
    onPreviewExtension,
    onApplyExtension,
  }: {
    detail: WorkflowDetail;
    busy: boolean;
    onPause: () => Promise<void>;
    onStop: () => Promise<void>;
    onResume?: () => Promise<void>;
    onRetryTask?: (taskId: string, expectedTerminalAttemptId: string, acknowledgeUnknownCompletion: boolean) => Promise<void>;
    onLoadMoreTasks?: (cursor: string) => Promise<void>;
    onPreviewExtension?: (extension: BudgetExtension) => Promise<WorkflowPreview>;
    onApplyExtension?: (preview: WorkflowPreview) => Promise<void>;
  } = $props();

  let summary = $derived(detail.summary);
  let acknowledgedUnknown = $state<Record<string, boolean>>({});
  let additionalModelCalls = $state(0);
  let additionalSearches = $state(0);
  let additionalMinutes = $state(0);
  let extensionBusy = $state(false);
  let extensionError = $state<string | null>(null);
  let extensionPreview = $state<WorkflowPreview | null>(null);
  let extensionPreviewFingerprint = $state<string | null>(null);
  let extensionPreviewRevision = $state<number | null>(null);
  let extension = $derived({ additionalModelCalls, additionalSearches, additionalMinutes });
  let extensionFingerprint = $derived(JSON.stringify(extension));
  let extensionValid = $derived(Object.values(extension).every((value) => Number.isSafeInteger(value) && value >= 0)
    && additionalModelCalls + additionalSearches + additionalMinutes > 0);
  let extensionPreviewValid = $derived(extensionPreview?.type === "budget-extension"
    && extensionPreview.fieldErrors.length === 0 && extensionPreviewFingerprint === extensionFingerprint
    && extensionPreviewRevision === summary.revision
    && Date.now() < Date.parse(extensionPreview.expiresAt));

  let target = $derived(summary.counts.requested);
  let targetUnit = $derived(summary.targetKind === "project"
    ? summary.counts.requested === 1 ? "distinct business family" : "distinct business families"
    : summary.counts.requested === 1 ? "distinct idea" : "distinct ideas");
  let accepted = $derived(summary.counts.accepted);
  let targetPercent = $derived(target > 0 ? Math.min(100, Math.round(accepted / target * 100)) : 0);
  let visibleTasks = $derived.by(() => {
    const parents = detail.tasks.filter((task) => task.parentItemId === null);
    return parents.length > 0 ? parents : detail.tasks;
  });
  let terminal = $derived(summary.state === "finished");
  let researchFollowUp = $derived(summary.purpose === "research-followup");
  // Follow-up sessions inherit a snapshot before work starts; only an applied result earns this label.
  let researchUpdated = $derived(researchFollowUp && terminal && summary.researchApplied === true);
  let canPause = $derived(summary.state === "running");
  let canResume = $derived(summary.state === "paused" && !!onResume
    && summary.budget.modelCalls.uncertain === 0 && summary.budget.searches.uncertain === 0
    && !detail.tasks.some((task) => task.state === "unknown"));
  let canStop = $derived(["running", "waiting-for-review", "pause-requested", "paused"].includes(summary.state));

  function remaining(limit: number, spent: number, reserved: number, uncertain: number): number {
    return Math.max(0, limit - spent - reserved - uncertain);
  }

  function remainingTime(milliseconds: number): string {
    if (milliseconds <= 0) return "0 min";
    if (milliseconds < 60_000) return "Under 1 min";
    return `${Math.ceil(milliseconds / 60_000)} min`;
  }

  function readable(value: string): string {
    const words = value.replaceAll("-", " ").trim();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Working";
  }

  function stateLabel(state: WorkflowSummary["state"]): string {
    const labels: Record<WorkflowSummary["state"], string> = {
      running: "Running",
      "waiting-for-review": "Waiting for review",
      "pause-requested": "Finishing current request before pause",
      paused: "Paused",
      "stop-requested": "Stopping current request",
      finished: "Finished",
    };
    return labels[state];
  }

  function outcomeLabel(outcome: WorkflowSummary["outcome"]): string {
    const labels = {
      "target-met": "Target reached",
      partial: "Partial result",
      "no-qualifying-ideas": "No qualifying ideas",
      failed: "Stopped after failure",
      cancelled: "Stopped",
      "needs-attention": "Needs attention",
    } as const;
    return outcome ? labels[outcome] : "Finished";
  }

  function terminalReason(value: WorkflowSummary): string {
    if (value.stopReason?.trim()) return value.stopReason.trim();
    switch (value.outcome) {
      case "target-met": return "The reviewed idea target was reached.";
      case "partial": return "The run ended below its target. Accepted ideas and research remain saved.";
      case "no-qualifying-ideas": return "Research remains saved, but no problem qualified for unattended idea generation.";
      case "failed": return "A stage failed. Accepted work remains saved.";
      case "cancelled": return "The run stopped. Completed work remains saved.";
      case "needs-attention": return "A dispatched result may be unknown. Review saved work before retrying.";
      default: return "This run has ended.";
    }
  }

  function taskTitle(task: WorkflowTask): string {
    if (task.kind === "coverage-map") return "Find coverage gaps";
    if (task.kind === "coverage-search") return "Check gap evidence";
    return task.question?.trim() || readable(task.kind);
  }

  async function previewExtension() {
    if (!onPreviewExtension || !extensionValid || extensionBusy) return;
    extensionBusy = true;
    extensionError = null;
    const fingerprint = extensionFingerprint;
    const revision = summary.revision;
    try {
      const preview = await onPreviewExtension(extension);
      if (fingerprint !== untrack(() => extensionFingerprint) || revision !== untrack(() => summary.revision)) return;
      extensionPreview = preview;
      extensionPreviewFingerprint = fingerprint;
      extensionPreviewRevision = revision;
    } catch (cause) {
      if (fingerprint === untrack(() => extensionFingerprint)) {
        extensionError = cause instanceof Error ? cause.message : "Could not preview the extension.";
      }
    } finally { extensionBusy = false; }
  }

  async function applyExtension() {
    if (!onApplyExtension || !extensionPreview || !extensionPreviewValid || extensionBusy) return;
    if (Date.now() >= Date.parse(extensionPreview.expiresAt)) {
      extensionError = "The preview expired. Preview the allowance again.";
      extensionPreview = null;
      extensionPreviewRevision = null;
      return;
    }
    extensionBusy = true;
    extensionError = null;
    try {
      await onApplyExtension(extensionPreview);
      extensionPreview = null;
      extensionPreviewFingerprint = null;
      extensionPreviewRevision = null;
      additionalModelCalls = 0;
      additionalSearches = 0;
      additionalMinutes = 0;
    } catch (cause) {
      extensionError = cause instanceof Error ? cause.message : "Could not extend the allowance. Preview the latest limits and try again.";
    } finally { extensionBusy = false; }
  }
</script>

<section class="vibe-progress" class:terminal aria-label={summary.mode === "vibe" ? "Vibe run progress" : "Babysit run progress"}>
  <header class="overview">
    <div class="overview-copy">
      <p class="stage">{terminal ? researchFollowUp ? "Research result" : "Run result" : summary.currentStage === "coverage-map"
        ? "Finding coverage gaps" : summary.currentStage === "coverage-search" ? "Checking gap evidence"
          : summary.currentStage ? readable(summary.currentStage) : stateLabel(summary.state)}</p>
      {#if researchFollowUp}<h2 class="research-heading">Research follow-up</h2>{:else}<h2><span class="accepted">{accepted}</span><span class="target"> / {target} {targetUnit}</span></h2>{/if}
      {#if !terminal}<p class="current-status">{stateLabel(summary.state)}</p>{/if}
    </div>
    {#if !researchFollowUp && !terminal && summary.counts.missing > 0}
      <span class="shortfall">{summary.counts.missing} still needed</span>
    {/if}
  </header>

  {#if !researchFollowUp && !terminal}<div class="meter" role="progressbar" aria-label={`Accepted ${targetUnit}`} aria-valuemin="0" aria-valuemax={Math.max(1, target)} aria-valuenow={Math.min(accepted, Math.max(1, target))} aria-valuetext={`${accepted} of ${target} ${targetUnit} accepted`}>
    <span style={`width:${targetPercent}%`}></span>
  </div>{/if}

  {#if terminal}
    <p class="terminal-reason" role="status"><strong>{researchUpdated ? "Research updated" : outcomeLabel(summary.outcome)}.</strong> {terminalReason(summary)}</p>
  {:else if summary.state === "pause-requested" || summary.state === "stop-requested"}
    <p class="pending-reason" role="status">{stateLabel(summary.state)}. Completed work remains saved.</p>
  {/if}

  <details class="run-details" open={!terminal}>
  <summary>Run details</summary>

  {#if !researchFollowUp}<dl class="counts" aria-label="Idea review counts">
    <div><dt>Requested</dt><dd>{summary.counts.requested}</dd></div>
    <div><dt>Validated</dt><dd>{summary.counts.validated}</dd></div>
    <div><dt>Duplicates</dt><dd>{summary.counts.duplicate}</dd></div>
    <div><dt>Missing</dt><dd>{summary.counts.missing}</dd></div>
  </dl>{/if}

  {#if !researchFollowUp && summary.targetKind === "project"}
    <dl class="family-counts" aria-label="Business family totals">
      <div><dt>Existing families</dt><dd>{summary.counts.existing}</dd></div>
      <div><dt>Added this run</dt><dd>{summary.counts.addedBySession}</dd></div>
      <div><dt>Total families</dt><dd>{summary.counts.total}</dd></div>
    </dl>
    {#if summary.counts.total !== summary.counts.existing + summary.counts.addedBySession}
      <p role="status">Family membership changed after this run started. The total reflects the current grouping.</p>
    {/if}
  {/if}

  <dl class="allowance" aria-label="Remaining work allowance">
    <div>
      <dt>Model calls left</dt>
      <dd>{remaining(summary.budget.modelCalls.limit, summary.budget.modelCalls.spent, summary.budget.modelCalls.reserved, summary.budget.modelCalls.uncertain)} <span>of {summary.budget.modelCalls.limit}</span></dd>
    </div>
    <div>
      <dt>Searches left</dt>
      <dd>{remaining(summary.budget.searches.limit, summary.budget.searches.spent, summary.budget.searches.reserved, summary.budget.searches.uncertain)} <span>of {summary.budget.searches.limit}</span></dd>
    </div>
    <div>
      <dt>Time left</dt>
      <dd>{remainingTime(summary.budget.remainingMs)}</dd>
    </div>
  </dl>

  {#if !terminal && onPreviewExtension && onApplyExtension}
    <details class="extension">
      <summary>Extend work allowance</summary>
      <p>Choose additional limits, preview the new total, then apply it to this run.</p>
      <div class="extension-fields">
        <label>Model calls <input aria-label="Additional model calls" type="number" min="0" step="1" bind:value={additionalModelCalls} oninput={() => extensionError = null} /></label>
        <label>Searches <input aria-label="Additional searches" type="number" min="0" step="1" bind:value={additionalSearches} oninput={() => extensionError = null} /></label>
        <label>Minutes <input aria-label="Additional minutes" type="number" min="0" step="1" bind:value={additionalMinutes} oninput={() => extensionError = null} /></label>
      </div>
      <div class="extension-actions">
        <button type="button" disabled={busy || extensionBusy || !extensionValid} onclick={() => void previewExtension()}>Preview extension</button>
        <button type="button" disabled={busy || extensionBusy || !extensionPreviewValid} onclick={() => void applyExtension()}>Apply extension</button>
      </div>
      {#if extensionPreview && extensionPreviewFingerprint === extensionFingerprint && extensionPreviewRevision === summary.revision}
        <p class="extension-preview">New limits: {extensionPreview.upperLimits.maxModelCalls} model calls, {extensionPreview.upperLimits.maxSearches} searches, {extensionPreview.upperLimits.maxMinutes} minutes.</p>
        {#if extensionPreview.fieldErrors.length > 0}<ul class="extension-errors">{#each extensionPreview.fieldErrors as issue (`${issue.path.join(".")}:${issue.code}`)}<li>{issue.message}</li>{/each}</ul>{/if}
      {:else if extensionPreview && extensionPreviewRevision !== summary.revision}
        <p class="extension-preview">The run changed. Preview the allowance again.</p>
      {/if}
      {#if extensionError}<p class="extension-error" role="alert">{extensionError}</p>{/if}
    </details>
  {/if}

  {#if visibleTasks.length > 0}
    <section class="task-section" aria-label="Research and idea tasks">
      <h3>{terminal ? "Saved work" : "Current work"}</h3>
      <ul class="task-list">
        {#each visibleTasks as task (task.id)}
          <li>
            <div>
              <span class="task-name">{taskTitle(task)}</span>
              {#if task.error}<span class="task-error">{task.error}</span>{/if}
            </div>
            <span class:task-problem={task.state === "failed" || task.state === "unknown"} class="task-state">{readable(task.state)}</span>
          </li>
        {/each}
      </ul>
    </section>
  {:else}
    <p class="empty-tasks">Tasks will appear here as the run advances.</p>
  {/if}
  {#if canPause || canStop || canResume}
    <div class="controls">
      <p>{summary.state === "paused" ? canResume ? "Resume uses the saved limits." : "This run is paused. Resolve any uncertain task before resuming." : canPause ? "Pause waits for the current request. Stop requests cancellation and keeps completed work." : "Stop keeps completed work."}</p>
      <div class="control-buttons">
        {#if canPause}
          <button type="button" class="pause-button" disabled={busy} onclick={() => void onPause().catch(() => {})}>Pause</button>
        {:else if canResume && onResume}
          <button type="button" class="pause-button" disabled={busy} onclick={() => void onResume().catch(() => {})}>Resume</button>
        {/if}
        {#if canStop}
          <button type="button" class="stop-button" disabled={busy} onclick={() => void onStop().catch(() => {})}>Stop</button>
        {/if}
      </div>
    </div>
  {/if}

  <details class="diagnostics">
    <summary>Task details <span>{detail.tasks.length}</span></summary>
    {#if detail.tasks.length === 0}
      <p>No task details have been saved yet.</p>
    {:else}
      <ul>
        {#each detail.tasks as task (task.id)}
          <li>
            <strong>{taskTitle(task)}</strong> <span>{readable(task.state)}</span>
            <dl>
              <div><dt>Task ID</dt><dd><code>{task.id}</code></dd></div>
              <div><dt>Scope</dt><dd><code>{task.scopeKey}</code></dd></div>
              {#if task.parentItemId}<div><dt>Parent</dt><dd><code>{task.parentItemId}</code></dd></div>{/if}
              {#if task.error}<div><dt>Error</dt><dd>{task.error}</dd></div>{/if}
            </dl>
            {#if onRetryTask && task.terminalAttemptId && (task.state === "failed" || task.state === "unknown")}
              {#if task.state === "unknown"}
                <label class="retry-acknowledge"><input type="checkbox" bind:checked={acknowledgedUnknown[task.id]} />I understand this request may have completed and a retry may repeat its work.</label>
              {/if}
              <button type="button" class="retry-button" disabled={busy || (task.state === "unknown" && !acknowledgedUnknown[task.id])}
                onclick={() => void onRetryTask(task.id, task.terminalAttemptId!, task.state === "unknown").catch(() => {})}>Retry task</button>
            {/if}
          </li>
        {/each}
      </ul>
      {#if detail.nextCursor && onLoadMoreTasks}
        <button type="button" class="retry-button" disabled={busy} onclick={() => void onLoadMoreTasks(detail.nextCursor!).catch(() => {})}>Load more tasks</button>
      {:else if detail.nextCursor}<p>More saved task history is available.</p>{/if}
    {/if}
  </details>
  </details>
</section>

<style>
  .vibe-progress { display:grid; gap:20px; padding:clamp(16px, 3vw, 26px); border:1px solid var(--border); border-radius:12px; background:#000; color:var(--text); }
  .vibe-progress.terminal { gap:8px;padding:13px 18px; }
  .vibe-progress.terminal .overview { align-items:center; }
  .vibe-progress.terminal .overview-copy { display:flex;align-items:baseline;flex-wrap:wrap;gap:5px 14px; }
  .vibe-progress.terminal .accepted { font-size:23px; }
  .vibe-progress.terminal .stage { margin:0; }
  .vibe-progress.terminal .terminal-reason { padding:0;border:0;background:transparent; }
  .run-details { min-width:0; }
  .run-details > summary { color:var(--muted);font-size:13px;cursor:pointer; }
  .run-details[open] > summary { margin-bottom:18px; }
  .run-details > dl + dl,.run-details > dl + section,.run-details > dl + p { margin-top:16px; }
  .retry-acknowledge { display:flex; align-items:flex-start; gap:8px; margin:12px 0; color:var(--muted); font-size:12px; line-height:1.5; }
  .retry-button { min-height:36px; padding:7px 12px; border:1px solid var(--border-strong); border-radius:7px; background:var(--surface-2); color:var(--text); font-size:12px; }
  .overview { display:flex; align-items:start; justify-content:space-between; gap:18px; }
  .overview-copy { min-width:0; }
  .stage { margin:0 0 9px; color:var(--muted); font-size:13px; line-height:1.4; }
  h2 { display:flex; flex-wrap:wrap; align-items:baseline; gap:0; margin:0; font-size:17px; font-weight:500; line-height:1.2; }
  .research-heading { font-size:21px;font-weight:620;letter-spacing:-.02em; }
  .accepted { font-size:clamp(38px, 6vw, 56px); font-weight:680; letter-spacing:-.05em; font-variant-numeric:tabular-nums; }
  .target { color:var(--muted); }
  .current-status { margin:9px 0 0; color:var(--text); font-size:13px; }
  .shortfall { flex:none; padding:6px 9px; border:1px solid var(--border-strong); border-radius:6px; color:var(--muted); font-size:12px; }
  .meter { height:5px; overflow:hidden; background:var(--surface-2); }
  .meter > span { display:block; height:100%; background:var(--accent-strong); transition:width .25s ease; }
  dl { margin:0; }
  .counts { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); border-top:1px solid var(--border); border-bottom:1px solid var(--border); }
  .counts > div { min-width:0; padding:13px 14px 13px 0; }
  .counts > div + div { padding-left:14px; border-left:1px solid var(--border); }
  dt { color:var(--muted); font-size:11px; line-height:1.4; }
  dd { margin:4px 0 0; font-variant-numeric:tabular-nums; }
  .counts dd { font-size:19px; line-height:1.2; }
  .allowance { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:16px; }
  .allowance > div { min-width:0; }
  .allowance dd { font-size:14px; }
  .allowance dd span { color:var(--muted); font-size:12px; }
  .family-counts { display:flex; flex-wrap:wrap; gap:12px 26px; padding:13px 0; border-bottom:1px solid var(--border); }
  .family-counts dd { color:var(--text); font-size:16px; }
  .extension { padding:13px 15px; border:1px solid var(--border); border-radius:9px; background:var(--surface); }
  .extension summary { width:max-content; max-width:100%; cursor:pointer; color:var(--text); font-size:13px; font-weight:600; }
  .extension p { margin:10px 0 0; color:var(--muted); font-size:12px; line-height:1.5; }
  .extension-fields { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; margin-top:14px; }
  .extension-fields label { display:grid; gap:6px; color:var(--muted); font-size:12px; }
  .extension-fields input { width:100%; min-height:38px; padding:8px 10px; border:1px solid var(--border-strong); border-radius:7px; background:#000; color:var(--text); font:inherit; font-variant-numeric:tabular-nums; }
  .extension-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
  .extension-actions button { border:1px solid var(--border-strong); }
  .extension .extension-preview { color:var(--text); }
  .extension .extension-error, .extension-errors { color:var(--danger); }
  .extension-errors { margin:8px 0 0; padding-left:18px; font-size:12px; }
  .terminal-reason, .pending-reason { margin:0; padding:12px 14px; border-left:2px solid var(--accent-strong); background:var(--surface); font-size:13px; line-height:1.5; }
  .terminal-reason strong { color:var(--text); }
  .task-section { min-width:0; }
  h3 { margin:0 0 8px; font-size:13px; font-weight:650; }
  .task-list, .diagnostics ul { list-style:none; padding:0; margin:0; }
  .task-list li { display:flex; justify-content:space-between; align-items:baseline; gap:16px; padding:11px 0; border-top:1px solid var(--border); font-size:13px; }
  .task-list li > div { display:grid; gap:5px; min-width:0; }
  .task-name, .task-error { overflow-wrap:anywhere; }
  .task-error { color:var(--danger); font-size:12px; }
  .task-state { flex:none; color:var(--muted); font-size:12px; }
  .task-state.task-problem { color:var(--danger); }
  .empty-tasks { margin:0; color:var(--muted); font-size:13px; }
  .controls { display:flex; justify-content:space-between; align-items:center; gap:18px; padding-top:15px; border-top:1px solid var(--border); }
  .controls p { max-width:55ch; margin:0; color:var(--muted); font-size:12px; line-height:1.5; }
  .control-buttons { display:flex; flex:none; flex-wrap:wrap; gap:8px; }
  button { min-height:36px; padding:8px 12px; border-radius:7px; background:var(--surface-2); color:var(--text); font:inherit; font-size:13px; font-weight:600; cursor:pointer; }
  button:focus-visible, summary:focus-visible { outline:2px solid var(--accent-strong); outline-offset:3px; }
  button:disabled { opacity:.5; cursor:not-allowed; }
  .pause-button { border:1px solid var(--border-strong); }
  .stop-button { border:1px solid var(--danger); color:var(--danger); }
  .diagnostics { min-width:0; padding-top:2px; color:var(--muted); font-size:12px; }
  .diagnostics summary { width:max-content; max-width:100%; cursor:pointer; }
  .diagnostics summary span { margin-left:5px; font-variant-numeric:tabular-nums; }
  .diagnostics ul { margin-top:12px; border-top:1px solid var(--border); }
  .diagnostics li { padding:11px 0; border-bottom:1px solid var(--border); overflow-wrap:anywhere; }
  .diagnostics li > strong { color:var(--text); font-weight:550; }
  .diagnostics li > span { margin-left:6px; }
  .diagnostics dl { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:7px 14px; margin-top:7px; }
  .diagnostics dd { margin-top:1px; color:var(--muted); font-size:11px; }
  .diagnostics code { overflow-wrap:anywhere; }
  .diagnostics p { margin:10px 0 0; }
  @media(max-width:600px) {
    .extension-fields { grid-template-columns:1fr; }
    .overview, .controls { align-items:stretch; flex-direction:column; }
    .shortfall { align-self:flex-start; }
    .counts { grid-template-columns:repeat(2,minmax(0,1fr)); }
    .counts > div:nth-child(3) { border-left:0; padding-left:0; border-top:1px solid var(--border); }
    .counts > div:nth-child(4) { border-top:1px solid var(--border); }
    .allowance { grid-template-columns:repeat(2,minmax(0,1fr)); }
    .control-buttons { width:100%; }
    .control-buttons button { flex:1; }
  }
  @media(max-width:380px) {
    .allowance { grid-template-columns:1fr; gap:10px; }
    .diagnostics dl { grid-template-columns:1fr; }
  }
  @media(prefers-reduced-motion:reduce) { .meter > span { transition:none; } }
</style>
