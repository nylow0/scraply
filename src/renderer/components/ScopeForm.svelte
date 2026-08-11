<script lang="ts">
  import type { WorkspaceState } from "../../shared/ipc";
  import { DEFAULT_RUN_CONFIG } from "../../shared/schemas";
  import { discoveryRunProjection } from "../../shared/discovery-projection";
  import { untrack } from "svelte";

  let { workspace, busy, onSave, onStart } : {
    workspace: WorkspaceState; busy: boolean;
    onSave: (scope: NonNullable<WorkspaceState["scope"]>, config: NonNullable<WorkspaceState["runConfig"]>) => Promise<void>;
    onStart: () => Promise<void>;
  } = $props();

  const initial = untrack(() => workspace);
  let title = $state(initial.scope?.title ?? "");
  let audience = $state(initial.scope?.audience ?? "");
  let domain = $state(initial.scope?.domain ?? "");
  let observations = $state(initial.scope?.observations ?? "");
  let offLimits = $state(initial.scope?.offLimits.join("\n") ?? "");
  let model = $state(initial.runConfig && initial.models.includes(initial.runConfig.model) ? initial.runConfig.model : initial.models[0] ?? initial.runConfig?.model ?? DEFAULT_RUN_CONFIG.model);
  let discoveryDepth = $state(initial.runConfig?.discoveryDepth ?? DEFAULT_RUN_CONFIG.discoveryDepth);
  let maxRunMinutes = $state(initial.runConfig?.maxRunMinutes ?? DEFAULT_RUN_CONFIG.maxRunMinutes);
  let validationError = $state("");
  let projection = $derived(discoveryRunProjection(discoveryDepth));
  let draftFingerprint = $derived(JSON.stringify({
    title: title.trim(), audience: audience.trim(), domain: domain.trim(), observations: observations.trim(),
    offLimits: offLimits.split("\n").map((item) => item.trim()).filter(Boolean),
    model, discoveryDepth, maxRunMinutes,
  }));
  // Only pre-mark as saved when a persisted run config exists and still matches the draft; otherwise the
  // displayed model would differ from the one the backend would actually run with.
  let savedFingerprint = $state<string | null>(untrack(() => initial.scope
    && initial.runConfig?.model === model
    && initial.runConfig?.discoveryDepth === discoveryDepth
    && initial.runConfig?.maxRunMinutes === maxRunMinutes ? draftFingerprint : null));
  let saved = $derived(savedFingerprint === draftFingerprint);

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
      }, { model, discoveryDepth, maxRunMinutes });
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
      <label><span>Model</span><select bind:value={model}>{#each workspace.models as item}<option value={item}>{item}</option>{/each}{#if workspace.models.length === 0}<option value={model}>{model}</option>{/if}</select></label>
      <label><span>Discovery depth</span><select bind:value={discoveryDepth}><option value="quick">Quick</option><option value="standard">Standard</option><option value="deep">Deep</option></select></label>
      <label><span>Hang detector</span><input type="number" min="5" max="240" bind:value={maxRunMinutes} /><small>Minutes per attempt, not a work budget.</small></label>
      <div class="projection"><span>Projected work</span><strong>~{projection.modelCalls} Codex calls · ~{projection.searches} Exa searches</strong><small>Projection, not a cap.</small></div>
    </div>

    {#if validationError}<p class="form-error" role="alert">{validationError}</p>{/if}
    <footer>
      <button type="submit" class="secondary" disabled={busy}>{busy ? "Saving…" : "Save scope"}</button>
      <button type="button" class="primary" disabled={busy || !saved || !workspace.validation.setupComplete} onclick={() => onStart()}>{busy ? "Working…" : "Start discovery"}</button>
    </footer>
  </form>
</section>

<style>
  .scope-page{max-width:1100px;margin:0 auto;padding:42px var(--page-inline) 80px}.eyebrow{font:600 11px var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--accent-strong)}h1{font-size:clamp(30px,4vw,48px);letter-spacing:-.045em;line-height:1.02;max-width:720px;margin:10px 0 14px}header>p:last-child{color:var(--muted);max-width:650px;font-size:15px}form{margin-top:44px;border-top:1px solid var(--border)}.primary-fields{display:grid;grid-template-columns:1.2fr 1fr 1fr;gap:18px;padding:24px 0}.secondary-fields{display:grid;grid-template-columns:1fr 1fr;gap:18px;padding:24px 0;border-top:1px solid var(--border)}label{display:grid;gap:7px}label span,.projection span{font-weight:650;font-size:12px}small{color:var(--subtle);font-size:11px}input,textarea,select{width:100%;border:1px solid var(--border-strong);background:var(--surface);color:var(--text);border-radius:8px;padding:11px 12px}textarea{resize:vertical}.run-settings{display:grid;grid-template-columns:1.2fr .8fr .7fr 1.3fr;gap:18px;padding:24px 0;border-top:1px solid var(--border)}.projection{display:grid;align-content:start;gap:7px;padding:10px 0}.projection strong{font:600 13px var(--mono)}footer{display:flex;justify-content:flex-end;gap:10px;padding-top:24px;border-top:1px solid var(--border)}button{border-radius:8px;padding:11px 16px;font-weight:650}.secondary{border:1px solid var(--border-strong);background:transparent;color:var(--text)}.primary{border:1px solid var(--accent);background:var(--accent-strong);color:var(--accent-ink)}.form-error{color:var(--danger)}@media(max-width:850px){.primary-fields,.secondary-fields,.run-settings{grid-template-columns:1fr}.scope-page{padding:28px 20px 64px}}
</style>
