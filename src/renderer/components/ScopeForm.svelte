<script lang="ts">
  import type { WorkspaceState } from "../../shared/ipc";
  import { DEFAULT_RUN_CONFIG, type ResearchMode } from "../../shared/schemas";
  import { untrack } from "svelte";

  let { workspace, busy, onSave, onStart, onRetry } : {
    workspace: WorkspaceState; busy: boolean;
    onSave: (scope: NonNullable<WorkspaceState["scope"]>, config: NonNullable<WorkspaceState["runConfig"]>) => Promise<void>;
    onStart: () => Promise<void>;
    onRetry: () => Promise<void>;
  } = $props();

  const initial = untrack(() => workspace);
  let researchMode = $state<ResearchMode>(initial.runConfig?.researchMode ?? "explore-market");
  let title = $state(initial.scope?.title ?? "");
  let audience = $state(initial.scope?.audience ?? "");
  let domain = $state(initial.scope?.domain ?? "");
  let observations = $state(initial.scope?.observations ?? "");
  let offLimits = $state(initial.scope?.offLimits.join("\n") ?? "");
  let knownProblem = $state(initial.runConfig?.knownProblem ?? "");
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
  let validationAttempted = $state(false);
  let submitting = $state(false);
  let draftFingerprint = $derived(JSON.stringify({
    researchMode, title: title.trim(), audience: audience.trim(), domain: domain.trim(), observations: observations.trim(),
    offLimits: offLimits.split("\n").map((item) => item.trim()).filter(Boolean), knownProblem: knownProblem.trim(),
    model, reasoningEffort, discoveryDepth, maxRunMinutes,
  }));
  // Only pre-mark as saved when a persisted run config exists and still matches the draft; a model that is no
  // longer offered falls back to the default, and the badge must not claim that fallback was ever saved.
  let savedFingerprint = $state<string | null>(untrack(() => initial.scope
    && initial.runConfig?.model === model
    && initial.runConfig?.reasoningEffort === reasoningEffort
    && initial.runConfig?.discoveryDepth === discoveryDepth
    && initial.runConfig?.maxRunMinutes === maxRunMinutes
    && initial.runConfig?.researchMode === researchMode
    && initial.runConfig?.knownProblem === knownProblem ? draftFingerprint : null));
  let saved = $derived(savedFingerprint === draftFingerprint);
  let codexReady = $derived(workspace.validation.codex.detected && workspace.validation.codex.compatible);
  let providersReady = $derived(codexReady && (researchMode === "known-problem" || workspace.validation.exa.valid));
  let locked = $derived(busy || submitting);
  let errors = $derived(validationAttempted ? missingFields() : {});

  function selectModel(event: Event) {
    const selected = workspace.modelOptions.find((item) => item.id === (event.currentTarget as HTMLSelectElement).value);
    reasoningEffort = selected?.defaultReasoningEffort ?? DEFAULT_RUN_CONFIG.reasoningEffort;
  }

  function missingFields(): Record<string, string> {
    const next: Record<string, string> = {};
    if (!title.trim()) next.title = "Research name is required.";
    if (researchMode === "explore-market") {
      if (!domain.trim()) next.domain = "A starting context is required.";
    } else if (!knownProblem.trim()) next.knownProblem = "Problem statement is required.";
    return next;
  }

  async function saveAndStart() {
    if (locked) return;
    validationAttempted = true;
    if (Object.keys(missingFields()).length > 0) return;
    submitting = true;
    try {
      const submittedFingerprint = draftFingerprint;
      await onSave({
        title: title.trim(), audience: audience.trim(), domain: domain.trim(), observations: observations.trim(),
        offLimits: offLimits.split("\n").map((item) => item.trim()).filter(Boolean),
      }, { model, reasoningEffort, discoveryDepth, maxRunMinutes, researchMode, knownProblem: knownProblem.trim() });
      savedFingerprint = submittedFingerprint;
      await onStart();
    } catch {
      // App owns the visible error; keep the submit promise handled locally.
    } finally {
      submitting = false;
    }
  }
</script>

<section class="scope-page">
  <header>
    <p class="eyebrow">Research setup</p>
    <h1>Choose where the research begins.</h1>
    <p>Give the model whatever starting point you have, or go straight to solutions when the problem is already clear.</p>
  </header>

  <form onsubmit={(event) => { event.preventDefault(); void saveAndStart(); }}>
    <fieldset class="mode-picker">
      <legend>Starting point</legend>
      <label class:active={researchMode === "explore-market"}>
        <input type="radio" name="research-mode" value="explore-market" checked={researchMode === "explore-market"} onchange={() => researchMode = "explore-market"} />
        <span><strong>Discover a problem</strong><small>Start with any context. The model researches it, gathers evidence, and surfaces problems worth solving.</small></span>
      </label>
      <label class:active={researchMode === "known-problem"}>
        <input type="radio" name="research-mode" value="known-problem" checked={researchMode === "known-problem"} onchange={() => researchMode = "known-problem"} />
        <span><strong>Start with a problem</strong><small>Use a problem you already know and generate solutions without web discovery.</small></span>
      </label>
    </fieldset>

    <div class="primary-fields">
      <label><span>Research name</span><input bind:value={title} aria-invalid={Boolean(errors.title)} placeholder={researchMode === "explore-market" ? "Project ideas" : "Solution ideas"} />{#if errors.title}<small class="field-error">{errors.title}</small>{/if}</label>
      {#if researchMode === "known-problem"}
        <label class="problem-field"><span>Problem statement</span><small>State the problem directly. This becomes a user-asserted problem and goes straight to solution development.</small><textarea bind:value={knownProblem} aria-invalid={Boolean(errors.knownProblem)} rows="4" placeholder="Small repair shops cannot reliably predict parts arrival times."></textarea>{#if errors.knownProblem}<small class="field-error">{errors.knownProblem}</small>{/if}</label>
      {/if}
      <label class:discovery-context={researchMode === "explore-market"}><span>{researchMode === "explore-market" ? "What do you want to explore?" : "Market or domain (optional)"}</span>{#if researchMode === "explore-market"}<small>Use whatever starting point you have: a goal, competition, topic, audience, market, rough idea, or something more specific.</small>{/if}<textarea bind:value={domain} aria-invalid={Boolean(errors.domain)} rows={researchMode === "explore-market" ? 4 : 2} placeholder={researchMode === "explore-market" ? "Describe your goal, topic, audience, or starting idea." : "Add any relevant market or domain context."}></textarea>{#if errors.domain}<small class="field-error">{errors.domain}</small>{/if}</label>
      <label><span>{researchMode === "explore-market" ? "People or groups (optional)" : "Audience (optional)"}</span><input bind:value={audience} placeholder={researchMode === "explore-market" ? "Students, local communities, or leave blank" : "Owners of small repair shops"} /></label>
    </div>

    <details class="optional-fields">
      <summary>Context and boundaries <span>Optional</span></summary>
      <div>
        <label><span>{researchMode === "explore-market" ? "Anything else to consider" : "Context"}</span><small>{researchMode === "explore-market" ? "Add useful details without needing to structure them." : "Useful background for solution generation."}</small><textarea bind:value={observations} rows="4" placeholder="Constraints, interests, experience, resources, or early observations"></textarea></label>
        <label><span>Boundaries</span><small>One boundary per line. Applied when solutions are proposed.</small><textarea bind:value={offLimits} rows="4" placeholder={"Marketplace business model\nRequires regulated inventory"}></textarea></label>
      </div>
    </details>

    <div class="run-settings" class:known={researchMode === "known-problem"}>
      <label class="run-setting"><span>Model</span><select bind:value={model} onchange={selectModel}>{#each workspace.modelOptions as item}<option value={item.id}>{item.displayName}</option>{/each}{#if workspace.modelOptions.length === 0}<option value={model}>{model}</option>{/if}</select><small>The model used throughout this research.</small></label>
      <label class="run-setting"><span>Reasoning</span><select bind:value={reasoningEffort}>{#each (selectedModelOption?.reasoningEfforts ?? [{ id: reasoningEffort, description: "" }]) as effort}<option value={effort.id}>{effort.id.charAt(0).toUpperCase() + effort.id.slice(1)}</option>{/each}</select><small>{reasoningDescription}</small></label>
      {#if researchMode === "explore-market"}<label class="run-setting"><span>Research depth</span><select bind:value={discoveryDepth}><option value="quick">Quick</option><option value="standard">Standard</option><option value="deep">Deep</option></select><small>{depthDescription}</small></label>{/if}
    </div>

    {#if !providersReady}
      <div class="connection-warning" role="status">
        <div>
          <strong>Required connection needs attention</strong>
          {#if !codexReady}<span>Codex: {workspace.validation.codex.error ?? "Compatible CLI unavailable"}</span>{/if}
          {#if researchMode === "explore-market" && !workspace.validation.exa.valid}<span>Exa: {workspace.validation.exa.error ?? "Connection unavailable"}</span>{/if}
        </div>
        <button type="button" class="secondary" disabled={locked} onclick={() => onRetry()}>{locked ? "Checking…" : "Retry connections"}</button>
      </div>
    {/if}

    <footer>
      {#if saved}<span>Saved</span>{/if}
      <button type="submit" class="primary" disabled={locked || !providersReady}>{locked ? (researchMode === "explore-market" ? "Starting discovery…" : "Starting development…") : (researchMode === "explore-market" ? "Discover problems" : "Generate solutions")}</button>
    </footer>
  </form>
</section>

<style>
  .scope-page{max-width:920px;margin:0 auto;padding:42px var(--page-inline) 80px}.eyebrow{font:600 11px var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--accent-strong)}h1{font-size:clamp(30px,4vw,48px);letter-spacing:-.045em;line-height:1.02;max-width:720px;margin:10px 0 14px}header>p:last-child{color:var(--muted);max-width:650px;font-size:15px}form{margin-top:36px;border-top:1px solid var(--border)}fieldset{border:0;padding:0;margin:0}legend{padding:22px 0 10px;font-weight:650;font-size:12px}.mode-picker{border-bottom:1px solid var(--border)}.mode-picker label{display:grid;grid-template-columns:18px 1fr;align-items:start;gap:12px;padding:15px 4px;border-top:1px solid var(--border);cursor:pointer;transition:background .25s var(--ease),padding .25s var(--ease)}.mode-picker label.active{padding-left:12px;background:var(--surface)}.mode-picker input{margin-top:3px;accent-color:var(--accent-strong)}.mode-picker label span{display:grid;gap:3px}.mode-picker strong{font-size:13px}.primary-fields{display:grid;grid-template-columns:1fr 1fr;gap:18px;padding:24px 0}.primary-fields .problem-field,.primary-fields .discovery-context{grid-column:1/-1}label{display:grid;align-content:start;gap:7px}label>span{font-weight:650;font-size:12px}small{color:var(--subtle);font-size:11px;line-height:1.45}.field-error{color:var(--danger)}input,textarea,select{width:100%;border:1px solid var(--border-strong);background:var(--surface);color:var(--text);border-radius:8px;padding:11px 12px}input[aria-invalid="true"],textarea[aria-invalid="true"]{border-color:var(--danger)}textarea{resize:vertical}.optional-fields{border-top:1px solid var(--border);padding:18px 0}.optional-fields summary{cursor:pointer;font-weight:650;font-size:12px}.optional-fields summary span{margin-left:7px;color:var(--subtle);font-weight:500}.optional-fields>div{display:grid;grid-template-columns:1fr 1fr;gap:18px;padding-top:18px}.run-settings{display:grid;grid-template-columns:1.2fr 1fr 1fr;align-items:start;gap:24px;padding:26px 0 28px;border-top:1px solid var(--border)}.run-settings.known{grid-template-columns:1.2fr 1fr}.run-setting{grid-template-rows:auto 48px minmax(32px,auto);gap:8px}.run-setting select{height:48px;padding-block:0}.run-setting small{max-width:34ch}.connection-warning{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:16px;border:1px solid color-mix(in srgb,var(--danger) 45%,var(--border));border-radius:8px;background:color-mix(in srgb,var(--danger) 7%,var(--surface))}.connection-warning>div{display:grid;gap:4px}.connection-warning strong{font-size:13px}.connection-warning span{color:var(--muted);font-size:12px}footer{display:flex;justify-content:flex-end;align-items:center;gap:12px;padding-top:24px;border-top:1px solid var(--border)}footer>span{font:500 11px var(--mono);color:var(--subtle)}button{border-radius:8px;padding:11px 16px;font-weight:650;transition:transform .2s var(--ease)}button:active:not(:disabled){transform:scale(.98)}button:disabled{cursor:not-allowed;opacity:.45}.secondary{border:1px solid var(--border-strong);background:transparent;color:var(--text)}.primary{border:1px solid var(--accent);background:var(--accent-strong);color:var(--accent-ink)}@media(max-width:700px){.primary-fields,.optional-fields>div,.run-settings,.run-settings.known{grid-template-columns:1fr}.primary-fields .problem-field,.primary-fields .discovery-context{grid-column:auto}.run-settings{gap:20px}.connection-warning{align-items:stretch;flex-direction:column}.scope-page{padding:28px 20px 64px}}
</style>
