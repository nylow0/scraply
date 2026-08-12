<script lang="ts">
  import type { WorkspaceState } from "../../shared/ipc";
  import { DEFAULT_RUN_CONFIG } from "../../shared/schemas";
  import { untrack } from "svelte";

  let { workspace, busy, onSave, onStart, onRetry } : {
    workspace: WorkspaceState; busy: boolean;
    onSave: (scope: NonNullable<WorkspaceState["scope"]>, config: NonNullable<WorkspaceState["runConfig"]>) => Promise<void>;
    onStart: () => Promise<void>;
    onRetry: () => Promise<void>;
  } = $props();

  const initial = untrack(() => workspace);
  let title = $state(initial.scope?.title ?? "");
  let audience = $state(initial.scope?.audience ?? "");
  let domain = $state(initial.scope?.domain ?? "");
  let observations = $state(initial.scope?.observations ?? "");
  let offLimits = $state(initial.scope?.offLimits.join("\n") ?? "");
  let model = $state(initial.runConfig && initial.models.includes(initial.runConfig.model)
    ? initial.runConfig.model
    : initial.models.includes(DEFAULT_RUN_CONFIG.model)
      ? DEFAULT_RUN_CONFIG.model
      : initial.models[0] ?? DEFAULT_RUN_CONFIG.model);
  let initialModelOption = initial.modelOptions.find((item) => item.id === model);
  let reasoningEffort = $state(initial.runConfig?.reasoningEffort
    && initialModelOption?.reasoningEfforts.some((item) => item.id === initial.runConfig?.reasoningEffort)
      ? initial.runConfig.reasoningEffort
      : initialModelOption?.defaultReasoningEffort ?? DEFAULT_RUN_CONFIG.reasoningEffort);
  let selectedModelOption = $derived(workspace.modelOptions.find((item) => item.id === model));
  let discoveryDepth = $state(initial.runConfig?.discoveryDepth ?? DEFAULT_RUN_CONFIG.discoveryDepth);
  let maxRunMinutes = $state(initial.runConfig?.maxRunMinutes ?? DEFAULT_RUN_CONFIG.maxRunMinutes);
  let reasoningDescription = $derived(selectedModelOption?.reasoningEfforts.find((item) => item.id === reasoningEffort)?.description ?? "Controls how deeply the model reasons.");
  let depthDescription = $derived(discoveryDepth === "quick"
    ? "Faster scan with fewer sources."
    : discoveryDepth === "deep"
      ? "Broader search with more cross-checking."
      : "Balanced coverage for most research.");
  let validationError = $state("");
  let draftFingerprint = $derived(JSON.stringify({
    title: title.trim(), audience: audience.trim(), domain: domain.trim(), observations: observations.trim(),
    offLimits: offLimits.split("\n").map((item) => item.trim()).filter(Boolean),
    model, reasoningEffort, discoveryDepth, maxRunMinutes,
  }));
  // Only pre-mark as saved when a persisted run config exists and still matches the draft; otherwise the
  // displayed model would differ from the one the backend would actually run with.
  let savedFingerprint = $state<string | null>(untrack(() => initial.scope
    && initial.runConfig?.model === model
    && initial.runConfig?.reasoningEffort === reasoningEffort
    && initial.runConfig?.discoveryDepth === discoveryDepth
    && initial.runConfig?.maxRunMinutes === maxRunMinutes ? draftFingerprint : null));
  let saved = $derived(savedFingerprint === draftFingerprint);

  function selectModel(event: Event) {
    const selected = workspace.modelOptions.find((item) => item.id === (event.currentTarget as HTMLSelectElement).value);
    reasoningEffort = selected?.defaultReasoningEffort ?? DEFAULT_RUN_CONFIG.reasoningEffort;
  }

  async function save() {
    validationError = "";
    if (!title.trim() || !audience.trim() || !domain.trim()) {
      validationError = "Title, audience, and domain are required.";
      return;
    }
    const submittedFingerprint = draftFingerprint;
    try {
      await onSave({
        title: title.trim(), audience: audience.trim(), domain: domain.trim(), observations: observations.trim(),
        offLimits: offLimits.split("\n").map((item) => item.trim()).filter(Boolean),
      }, { model, reasoningEffort, discoveryDepth, maxRunMinutes });
    } catch {
      return;
    }
    savedFingerprint = submittedFingerprint;
  }
</script>

<section class="scope-page">
  <header>
    <p class="eyebrow">Discovery setup</p>
    <h1>Define what the evidence should cover.</h1>
    <p>The scope steers retrieval. Problems are inferred later, after the sources have been read.</p>
  </header>

  <form onsubmit={(event) => { event.preventDefault(); void save(); }}>
    <div class="primary-fields">
      <label><span>Working title</span><input bind:value={title} placeholder="Independent repair shops" /></label>
      <label><span>Audience</span><input bind:value={audience} placeholder="Owners of 2–10 person repair shops" /></label>
      <label><span>Domain</span><input bind:value={domain} placeholder="Parts sourcing and workshop operations" /></label>
    </div>
    <div class="secondary-fields">
      <label><span>Observations</span><small>Used only to steer evidence collection.</small><textarea bind:value={observations} rows="5" placeholder="What have you noticed already?"></textarea></label>
      <label><span>Off limits</span><small>One boundary per line. Applied when solutions are proposed.</small><textarea bind:value={offLimits} rows="5" placeholder={"Marketplace business model\nRequires regulated inventory"}></textarea></label>
    </div>

    <div class="run-settings">
      <label class="run-setting"><span>Model</span><select bind:value={model} onchange={selectModel}>{#each workspace.modelOptions as item}<option value={item.id}>{item.displayName}</option>{/each}{#if workspace.modelOptions.length === 0}<option value={model}>{model}</option>{/if}</select><small>The model used throughout this research.</small></label>
      <label class="run-setting"><span>Reasoning</span><select bind:value={reasoningEffort}>{#each (selectedModelOption?.reasoningEfforts ?? [{ id: reasoningEffort, description: "" }]) as effort}<option value={effort.id}>{effort.id.charAt(0).toUpperCase() + effort.id.slice(1)}</option>{/each}</select><small>{reasoningDescription}</small></label>
      <label class="run-setting"><span>Research depth</span><select bind:value={discoveryDepth}><option value="quick">Quick</option><option value="standard">Standard</option><option value="deep">Deep</option></select><small>{depthDescription}</small></label>
    </div>

    {#if !workspace.validation.setupComplete}
      <div class="connection-warning" role="status">
        <div>
          <strong>Research connections need attention</strong>
          {#if !workspace.validation.exa.valid}<span>Exa: {workspace.validation.exa.error ?? "Connection unavailable"}</span>{/if}
          {#if !workspace.validation.codex.compatible}<span>Codex: {workspace.validation.codex.error ?? "Compatible CLI unavailable"}</span>{/if}
        </div>
        <button type="button" class="secondary" disabled={busy} onclick={() => onRetry()}>{busy ? "Checking…" : "Retry connections"}</button>
      </div>
    {/if}

    {#if validationError}<p class="form-error" role="alert">{validationError}</p>{/if}
    <footer>
      <button type="submit" class="secondary" disabled={busy}>{busy ? "Saving…" : "Save scope"}</button>
      <button type="button" class="primary" disabled={busy || !saved || !workspace.validation.setupComplete} onclick={() => onStart()}>{busy ? "Working…" : "Start discovery"}</button>
    </footer>
  </form>
</section>

<style>
  .scope-page{max-width:1100px;margin:0 auto;padding:42px var(--page-inline) 80px}.eyebrow{font:600 11px var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--accent-strong)}h1{font-size:clamp(30px,4vw,48px);letter-spacing:-.045em;line-height:1.02;max-width:720px;margin:10px 0 14px}header>p:last-child{color:var(--muted);max-width:650px;font-size:15px}form{margin-top:44px;border-top:1px solid var(--border)}.primary-fields{display:grid;grid-template-columns:1.2fr 1fr 1fr;gap:18px;padding:24px 0}.secondary-fields{display:grid;grid-template-columns:1fr 1fr;gap:18px;padding:24px 0;border-top:1px solid var(--border)}label{display:grid;gap:7px}label span{font-weight:650;font-size:12px}small{color:var(--subtle);font-size:11px;line-height:1.45}input,textarea,select{width:100%;border:1px solid var(--border-strong);background:var(--surface);color:var(--text);border-radius:8px;padding:11px 12px}textarea{resize:vertical}.run-settings{display:grid;grid-template-columns:1.2fr 1fr 1fr;align-items:start;gap:24px;padding:26px 0 28px;border-top:1px solid var(--border)}.run-setting{grid-template-rows:auto 48px minmax(32px,auto);gap:8px}.run-setting select{height:48px;padding-block:0}.run-setting small{max-width:34ch}.connection-warning{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:16px;border:1px solid color-mix(in srgb,var(--danger) 45%,var(--border));border-radius:8px;background:color-mix(in srgb,var(--danger) 7%,var(--surface))}.connection-warning>div{display:grid;gap:4px}.connection-warning strong{font-size:13px}.connection-warning span{color:var(--muted);font-size:12px}footer{display:flex;justify-content:flex-end;gap:10px;padding-top:24px;border-top:1px solid var(--border)}button{border-radius:8px;padding:11px 16px;font-weight:650}button:disabled{cursor:not-allowed;opacity:.45}.secondary{border:1px solid var(--border-strong);background:transparent;color:var(--text)}.primary{border:1px solid var(--accent);background:var(--accent-strong);color:var(--accent-ink)}.form-error{color:var(--danger)}@media(max-width:850px){.primary-fields,.secondary-fields,.run-settings{grid-template-columns:1fr}.run-settings{gap:20px}.connection-warning{align-items:stretch;flex-direction:column}.scope-page{padding:28px 20px 64px}}
</style>
