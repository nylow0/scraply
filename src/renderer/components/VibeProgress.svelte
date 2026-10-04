<script lang="ts">
  import { untrack } from "svelte";
  import type { z } from "zod";
  import type { WorkflowDetail, WorkflowSummary } from "../../shared/workflow-contracts";
  import { PreviewWorkflowResultSchema } from "../../shared/workflow-contracts";
  import InvestigatorProgress from "./InvestigatorProgress.svelte";
  import type { InvestigatorLane } from "../lib/investigator-progress";

  type WorkflowTask = WorkflowDetail["tasks"][number];
  type BudgetExtension = { additionalModelCalls: number; additionalSearches: number; additionalMinutes: number };
  type WorkflowPreview = z.infer<typeof PreviewWorkflowResultSchema>;

  let {
    detail,
    investigators = [],
    busy,
    onPause,
    onStop,
    onResume,
    onRetryTask,
    onReassessProblems,
    onLoadMoreTasks,
    onPreviewExtension,
    onApplyExtension,
  }: {
    detail: WorkflowDetail;
    investigators?: InvestigatorLane[];
    busy: boolean;
    onPause: () => Promise<void>;
    onStop: () => Promise<void>;
    onResume?: () => Promise<void>;
    onRetryTask?: (taskId: string, expectedTerminalAttemptId: string, acknowledgeUnknownCompletion: boolean) => Promise<void>;
    onReassessProblems?: (taskId: string) => Promise<void>;
    onLoadMoreTasks?: (cursor: string) => Promise<void>;
    onPreviewExtension?: (extension: BudgetExtension) => Promise<WorkflowPreview>;
    onApplyExtension?: (preview: WorkflowPreview) => Promise<void>;
  } = $props();

  let summary = $derived(detail.summary);
  let guided = $derived(summary.limits.enforced === false);
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

  let accepted = $derived(summary.counts.accepted);
  let copied = $state(false);
  // Wall-clock time from start to finish; shown only once the run has ended.
  let timeTaken = $derived(summary.finishedAt
    ? `${Math.max(1, Math.round((Date.parse(summary.finishedAt) - Date.parse(summary.startedAt)) / 60_000))} min` : null);
  // A run that failed, stopped or produced nothing keeps its reason in Run details; a normal ending needs no sentence.
  let problemEnding = $derived(summary.outcome !== null && summary.outcome !== "target-met" && summary.outcome !== "partial");

  async function copySessionId() {
    await navigator.clipboard.writeText(summary.sessionId);
    copied = true;
    setTimeout(() => copied = false, 2_000);
  }
  let visibleTasks = $derived.by(() => {
    const parents = detail.tasks.filter((task) => task.parentItemId === null);
    return parents.length > 0 ? parents : detail.tasks;
  });
  let terminal = $derived(summary.state === "finished");
  let researchFollowUp = $derived(summary.purpose === "research-followup");
  let researchView = $derived(!researchFollowUp && !(summary.ideaTargetReady
    ?? (summary.counts.attempted > 0 || accepted > 0 || detail.tasks.some(task => task.kind === "generate-ideas"))));
  let activity = $derived.by(() => {
    const recent = [...(detail.activity ?? [])].reverse();
    // Transport transitions and older duplicate saves can describe the same action.
    return recent.filter((item, index) => index === 0 || activityText(item) !== activityText(recent[index - 1]!));
  });
  let researchHeading = $derived(terminal ? summary.outcome === "target-met" || summary.outcome === "no-qualifying-ideas" ? "Research finished" : "Research stopped"
    : summary.state === "waiting-for-review" ? "Ready for your review"
      : summary.state === "paused" ? "Research paused" : summary.purpose === "known-problem" ? "Preparing your ideas" : "Researching your brief");
  let canPause = $derived(summary.state === "running");
  let canResume = $derived(summary.state === "paused" && !!onResume
    && (summary.canResume === true || (summary.budget.modelCalls.uncertain === 0 && summary.budget.searches.uncertain === 0))
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
      case "no-qualifying-ideas": return "Research remains saved, but no problem qualified for ideas.";
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

  function activityText(item: NonNullable<WorkflowDetail["activity"]>[number]): string {
    if (!["Model request accepted", "Model request dispatched", "Model call completed", "Waiting for model availability"].includes(item.message)) return item.message;
    const work = item.stage === "searching" ? "Planning search queries"
      : item.stage === "extracting" ? "Reading sources and extracting evidence"
        : item.stage === "synthesizing-problems" ? "Identifying and checking problems"
          : item.stage === "generating-options" ? "Generating and reviewing ideas" : "Processing evidence";
    if (item.message === "Waiting for model availability") return `Queued: ${work.toLowerCase()}`;
    if (item.message === "Model call completed") return `${work} — complete`;
    return work;
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

<section class="vibe-progress" class:terminal class:research-view={researchView} aria-label={summary.mode === "vibe" ? "Vibe run progress" : "Controlled run progress"}>
  {#if !terminal}
  <header class="overview">
    <div class="overview-copy">
      <p class="stage">{researchView ? summary.mode === "vibe" ? "Vibe research" : "Controlled research" : summary.currentStage === "coverage-map"
        ? "Finding coverage gaps" : summary.currentStage === "coverage-search" ? "Checking gap evidence"
          : summary.currentStage ? readable(summary.currentStage) : stateLabel(summary.state)}</p>
      {#if researchView}<h2 class="research-heading">{researchHeading}</h2>{:else if researchFollowUp}<h2 class="research-heading">Research follow-up</h2>{:else}<h2 class="research-heading">Writing and ranking ideas</h2>{/if}
      <p class="current-status">{stateLabel(summary.state)}</p>
    </div>
  </header>

  {#if summary.state === "pause-requested" || summary.state === "stop-requested"}
    <p class="pending-reason" role="status">{stateLabel(summary.state)}. Completed work remains saved.</p>
  {/if}

  <InvestigatorProgress {investigators} />

  {#if researchView}
    <section class="research-activity" aria-label="Research activity">
      {#if activity.length}
        <ol class="activity-log" role="log" aria-label="Recent research activity" aria-live="polite" aria-relevant="additions text">
          {#each activity as item, index (item.id)}
            <li class:latest={index === 0}><span class="activity-dot" aria-hidden="true"></span><p>{activityText(item)}</p><time datetime={item.createdAt}>{new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></li>
          {/each}
        </ol>
      {:else}
        <p class="activity-empty">{summary.state === "waiting-for-review" ? summary.reviewKind === "frame" ? "Review the frame before research starts." : "Choose which problems to develop below." : "Preparing the next research step…"}</p>
      {/if}
    </section>
    {#if canPause || canStop || canResume}
      <div class="research-controls">
        {#if canPause}<button class="pause-button" disabled={busy} onclick={() => void onPause().catch(() => {})}>Pause</button>
        {:else if canResume && onResume}<button class="pause-button" disabled={busy} onclick={() => void onResume().catch(() => {})}>Resume</button>{/if}
        {#if canStop}<button class="stop-button" disabled={busy} onclick={() => void onStop().catch(() => {})}>Stop</button>{/if}
      </div>
    {/if}
  {/if}
  {/if}

  {#if terminal && problemEnding}<p class="terminal-reason" role="status"><strong>{outcomeLabel(summary.outcome)}.</strong> {terminalReason(summary)}</p>{/if}

  <details class="run-details" open={!terminal && !researchView}>
  <summary>Run details</summary>

  {#if !researchView && !researchFollowUp && summary.targetKind === "project"}
    <dl class="family-counts" aria-label="Business family totals">
      <div><dt>Existing families</dt><dd>{summary.counts.existing}</dd></div>
      <div><dt>Added this run</dt><dd>{summary.counts.addedBySession}</dd></div>
      <div><dt>Total families</dt><dd>{summary.counts.total}</dd></div>
    </dl>
    {#if summary.counts.total !== summary.counts.existing + summary.counts.addedBySession}
      <p role="status">Family membership changed after this run started. The total reflects the current grouping.</p>
    {/if}
  {/if}

  {#if guided || terminal}
  <dl class="allowance" aria-label="Work completed">
    <div><dt>Model calls</dt><dd>{summary.budget.modelCalls.spent}</dd></div>
    <div><dt>Searches</dt><dd>{summary.budget.searches.spent}</dd></div>
    {#if timeTaken}<div><dt>Time taken</dt><dd>{timeTaken}</dd></div>{/if}
  </dl>
  {:else}
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
  {/if}

  <p class="session-id"><span>Session ID</span><code>{summary.sessionId}</code><button type="button" onclick={() => void copySessionId()}>{copied ? "Copied" : "Copy"}</button></p>

  {#if !guided && !terminal && onPreviewExtension && onApplyExtension}
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
  {#if !researchView && (canPause || canStop || canResume)}
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
            {#if onReassessProblems && task.canReassessProblems}
              <p>Re-evaluate saved evidence against each problem's affected users. Your original brief and research remain saved.</p>
              <button type="button" class="retry-button" disabled={busy}
                onclick={() => void onReassessProblems(task.id).catch(() => {})}>Re-evaluate problems</button>
            {/if}
            {#if onRetryTask && task.terminalAttemptId && (task.state === "failed" || task.state === "unknown")}
              {#if task.state === "unknown"}
                <label class="retry-acknowledge"><input type="checkbox" bind:checked={acknowledgedUnknown[task.terminalAttemptId]} />I understand this {task.terminalAttemptKind === "search" ? "search" : "request"} may have completed and a retry may repeat its work.</label>
              {/if}
              <button type="button" class="retry-button" disabled={busy || (task.state === "unknown" && !acknowledgedUnknown[task.terminalAttemptId])}
                onclick={() => void onRetryTask(task.id, task.terminalAttemptId!, task.state === "unknown").catch(() => {})}>{task.terminalAttemptKind === "search" ? "Retry search" : "Retry task"}</button>
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
  .vibe-progress.terminal .stage { margin:0; }
  .vibe-progress.terminal .terminal-reason { padding:0;border:0;background:transparent; }
  .run-details { min-width:0; }
  .session-id { display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;margin:16px 0 0;font-size:13px; }
  .session-id span { color:var(--muted); }.session-id code { overflow-wrap:anywhere; }
  .session-id button { padding:5px 10px;border:1px solid var(--border-strong);border-radius:7px;background:transparent;color:var(--text);font-size:12px; }
  .run-details > summary { color:var(--muted);font-size:13px;cursor:pointer; }
  .run-details[open] > summary { margin-bottom:18px; }
  .run-details > dl + dl,.run-details > dl + p { margin-top:16px; }
  .retry-acknowledge { display:flex; align-items:flex-start; gap:8px; margin:12px 0; color:var(--muted); font-size:12px; line-height:1.5; }
  .retry-button { min-height:36px; padding:7px 12px; border:1px solid var(--border-strong); border-radius:7px; background:var(--surface-2); color:var(--text); font-size:12px; }
  .overview { display:flex; align-items:start; justify-content:space-between; gap:18px; }
  .overview-copy { min-width:0; }
  .stage { margin:0 0 9px; color:var(--muted); font-size:13px; line-height:1.4; }
  h2 { display:flex; flex-wrap:wrap; align-items:baseline; gap:0; margin:0; font-size:17px; font-weight:500; line-height:1.2; }
  .research-heading { font-size:21px;font-weight:620;letter-spacing:-.02em; }
  .research-view .research-heading { font-size:clamp(22px,3vw,28px); }
  .research-activity { min-width:0; }
  .activity-log { list-style:none;margin:0;padding:0; }
  .activity-log li { display:grid;grid-template-columns:8px minmax(0,1fr) auto;align-items:baseline;gap:12px;padding:9px 0;color:var(--muted);font-size:13px; }
  .activity-log li.latest { color:var(--text); }
  .activity-log p { margin:0;line-height:1.6;overflow-wrap:anywhere; }
  .activity-dot { width:5px;height:5px;border-radius:50%;background:var(--border-strong);align-self:start;margin-top:8px; }
  .latest .activity-dot { background:var(--accent-strong); }
  .activity-log time { font-size:11px;font-variant-numeric:tabular-nums;color:var(--muted); }
  .activity-empty { color:var(--muted);font-size:13px;margin:0; }
  .research-controls { display:flex;gap:8px; }
  .current-status { margin:9px 0 0; color:var(--text); font-size:13px; }
  dl { margin:0; }
  dt { color:var(--muted); font-size:11px; line-height:1.4; }
  dd { margin:4px 0 0; font-variant-numeric:tabular-nums; }
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
  @container page (max-width:520px) {
    .extension-fields { grid-template-columns:1fr; }
    .overview, .controls { align-items:stretch; flex-direction:column; }
    .allowance { grid-template-columns:repeat(2,minmax(0,1fr)); }
    .control-buttons { width:100%; }
    .control-buttons button { flex:1; }
  }
  @container page (max-width:340px) {
    .allowance { grid-template-columns:1fr; gap:10px; }
    .diagnostics dl { grid-template-columns:1fr; }
  }
</style>
