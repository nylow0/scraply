<script lang="ts">
  import type { WorkspaceState } from "../../shared/ipc";
  import {
    DEFAULT_RUN_CONFIG,
    DEFAULT_IDEA_COUNT,
    MAX_IDEA_COUNT,
    modelRefKey,
    sameModelRef,
    type ModelRef,
    type ResearchMode,
    type SearchProvider,
  } from "../../shared/schemas";
  import { untrack } from "svelte";
  import { modelDisplayName, readResearchDefaults } from "../lib/research-defaults";
  import ProviderLogo from "./ProviderLogo.svelte";
  import Icon from "./Icon.svelte";

  let { workspace, busy, onSave, onStart, onRetry, onOpenSettings } : {
    workspace: WorkspaceState; busy: boolean;
    onSave: (scope: NonNullable<WorkspaceState["scope"]>, config: NonNullable<WorkspaceState["runConfig"]>) => Promise<void>;
    onStart: () => Promise<void>;
    onRetry: () => Promise<void>;
    onOpenSettings?: () => void;
  } = $props();

  const initial = untrack(() => workspace);
  const defaults = untrack(readResearchDefaults);
  const startingModel = initial.scope ? initial.runConfig?.model : defaults.model;
  let researchMode = $state<ResearchMode>(initial.runConfig?.researchMode ?? "explore-market");
  const workflowVersion = 2;
  let audienceSourcePolicy = $state<"web" | "communities">(initial.runConfig?.audienceSourcePolicy ?? "web");
  let title = $state(initial.scope?.title ?? "");
  let audience = $state(initial.scope?.audience ?? "");
  let domain = $state(initial.scope?.domain ?? "");
  let observations = $state(initial.scope?.observations ?? "");
  let riskEvaluationCriteria = $state(initial.scope?.riskEvaluationCriteria ?? "");
  let ideaCount = $state<number | undefined>(initial.runConfig?.ideaCount ?? DEFAULT_IDEA_COUNT);
  let offLimits = $state(initial.scope?.offLimits.join("\n") ?? "");
  let knownProblem = $state(initial.runConfig?.knownProblem ?? "");
  const legacyModelNeedsReplacement = initial.runConfig?.model.providerId === "legacy-codex-cli";
  let initialModel = startingModel
    ?? (initial.models.some((model) => sameModelRef(model, DEFAULT_RUN_CONFIG.model))
      ? DEFAULT_RUN_CONFIG.model
      : initial.modelOptions.find((item) => item.providerId === "openai-subscription") ?? DEFAULT_RUN_CONFIG.model);
  let modelKey = $state(legacyModelNeedsReplacement ? "" : modelRefKey(initialModel));
  let nativeModelOptions = $derived(workspace.modelOptions.filter((item) => item.providerId === "openai-subscription"));
  let astraAvailable = $derived(nativeModelOptions.some((item) => item.modelId === "gpt-6-astra"));
  let selectedModelOption = $derived(nativeModelOptions.find((item) => modelRefKey(item) === modelKey));
  let resolvedModel = $derived(selectedModelOption
    ?? (modelRefKey(initialModel) === modelKey ? initialModel : DEFAULT_RUN_CONFIG.model));
  let model = $derived<ModelRef>({ providerId: resolvedModel.providerId, modelId: resolvedModel.modelId });
  let initialModelOption = initial.modelOptions.find((item) => sameModelRef(item, initialModel));
  let modelSelect: HTMLSelectElement;
  let reasoningEffort = $state(initial.runConfig?.reasoningEffort
    && initialModelOption?.reasoningEfforts.some((item) => item.id === initial.runConfig?.reasoningEffort)
      ? initial.runConfig.reasoningEffort
      : initialModelOption?.defaultReasoningEffort ?? DEFAULT_RUN_CONFIG.reasoningEffort);
  let discoveryDepth = $state(initial.runConfig?.discoveryDepth ?? DEFAULT_RUN_CONFIG.discoveryDepth);
  let searchProvider = $state<SearchProvider>(initial.scope ? initial.runConfig?.searchProvider ?? defaults.searchProvider : defaults.searchProvider);
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
    model, reasoningEffort, discoveryDepth, searchProvider, maxRunMinutes, workflowVersion, audienceSourcePolicy,
    riskEvaluationCriteria: riskEvaluationCriteria.trim(), ideaCount,
  }));
  // Only pre-mark as saved when a persisted run config exists and still matches the draft; a model that is no
  // longer offered falls back to the default, and the badge must not claim that fallback was ever saved.
  let savedFingerprint = $state<string | null>(untrack(() => initial.scope
    && initial.runConfig
    && initial.runConfig.workflowVersion === 2
    && sameModelRef(initial.runConfig.model, model)
    && initial.runConfig?.reasoningEffort === reasoningEffort
    && initial.runConfig?.discoveryDepth === discoveryDepth
    && initial.runConfig?.searchProvider === searchProvider
    && initial.runConfig?.maxRunMinutes === maxRunMinutes
    && initial.runConfig?.researchMode === researchMode
    && initial.runConfig?.knownProblem === knownProblem ? draftFingerprint : null));
  let saved = $derived(savedFingerprint === draftFingerprint);
  let selectedModelReady = $derived(workspace.validation.native.available && workspace.validation.native.connected);
  let selectedModelAvailable = $derived(Boolean(modelKey) && workspace.models.some((item) => item.providerId === "openai-subscription" && sameModelRef(item, model)));
  let selectedSearchValidation = $derived(workspace.validation[searchProvider]);
  let selectedSearchName = $derived(searchProvider === "exa" ? "Exa" : "Perplexity");
  let nativeValidationPending = $derived(isValidationPending(workspace.validation.native.error));
  let searchValidationPending = $derived(researchMode === "explore-market" && isValidationPending(selectedSearchValidation.error));
  let connectionsChecking = $derived(nativeValidationPending || searchValidationPending);
  let providersReady = $derived(selectedModelReady && selectedModelAvailable && (researchMode === "known-problem" || selectedSearchValidation.valid));
  let modelChoiceRequired = $derived(selectedModelReady && nativeModelOptions.length > 0 && !selectedModelAvailable);
  let connectionNeedsAttention = $derived(!selectedModelReady
    || nativeModelOptions.length === 0
    || (researchMode === "explore-market" && !selectedSearchValidation.valid));
  let modelStatus = $derived(!workspace.validation.native.available
      ? workspace.validation.native.error ?? "Native runtime is unavailable"
      : !workspace.validation.native.connected
        ? workspace.validation.native.error ?? "Connect your OpenAI account"
        : workspace.validation.native.error ?? (nativeModelOptions.length === 0 ? "No compatible models are available" : null));
  let locked = $derived(busy || submitting);
  let errors = $derived(validationAttempted ? missingFields() : {});

  function selectModel(event: Event) {
    const selected = workspace.modelOptions.find((item) => modelRefKey(item) === (event.currentTarget as HTMLSelectElement).value);
    reasoningEffort = selected?.defaultReasoningEffort ?? DEFAULT_RUN_CONFIG.reasoningEffort;
  }

  function isValidationPending(error: string | undefined): boolean {
    return error?.startsWith("Checking ") === true || error === "Native runtime is starting";
  }

  function missingFields(): Record<string, string> {
    const next: Record<string, string> = {};
    if (!Number.isInteger(ideaCount) || ideaCount === undefined || ideaCount < 1 || ideaCount > MAX_IDEA_COUNT) {
      next.ideaCount = `Choose a whole number from 1 to ${MAX_IDEA_COUNT}.`;
    }
    if (researchMode === "explore-market") {
      if (!domain.trim()) next.domain = "A starting context is required.";
    } else if (!knownProblem.trim()) next.knownProblem = "Problem statement is required.";
    return next;
  }

  async function saveAndStart() {
    if (locked || !providersReady) return;
    validationAttempted = true;
    if (Object.keys(missingFields()).length > 0) return;
    submitting = true;
    try {
      const submittedFingerprint = draftFingerprint;
      await onSave({
        title: title.trim(), audience: audience.trim(), domain: domain.trim(), observations: observations.trim(),
        riskEvaluationCriteria: riskEvaluationCriteria.trim(),
        offLimits: offLimits.split("\n").map((item) => item.trim()).filter(Boolean),
      }, { configVersion: 2, workflowVersion, audienceSourcePolicy, ideaCount, model, reasoningEffort, discoveryDepth, searchProvider, maxRunMinutes, researchMode, knownProblem: knownProblem.trim() });
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
  <header class="page-heading">
    <h1>Research setup</h1>
  </header>
  <form onsubmit={(event) => { event.preventDefault(); void saveAndStart(); }}>
    <div class="brief-column">
      <fieldset class="mode-picker">
        <legend>Starting point</legend>
        <label class:active={researchMode === "explore-market"}>
          <input type="radio" name="research-mode" value="explore-market" checked={researchMode === "explore-market"} onchange={() => researchMode = "explore-market"} />
          <Icon name="research" size={22} /><span><strong>Discover a problem</strong></span><span class="mode-check"><Icon name="check" size={14} /></span>
        </label>
        <label class:active={researchMode === "known-problem"}>
          <input type="radio" name="research-mode" value="known-problem" checked={researchMode === "known-problem"} onchange={() => researchMode = "known-problem"} />
          <Icon name="ideas" size={22} /><span><strong>Start with a problem</strong></span><span class="mode-check"><Icon name="check" size={14} /></span>
        </label>
      </fieldset>
      <section class="brief-panel" aria-label="Research brief">
        <div class="panel-heading"><Icon name="brief" /><h2>Your brief</h2></div>
    <div class="primary-fields">
      <label><span>Research name</span><input bind:value={title} aria-invalid={Boolean(errors.title)} aria-describedby={errors.title ? "title-error" : undefined} placeholder="Name it, or leave blank" />{#if errors.title}<small id="title-error" class="field-error">{errors.title}</small>{/if}</label>
      {#if researchMode === "known-problem"}
        <label class="problem-field"><span>Problem statement</span><small>Used as your starting premise, without discovery.</small><textarea bind:value={knownProblem} aria-invalid={Boolean(errors.knownProblem)} aria-describedby={errors.knownProblem ? "known-problem-error" : undefined} rows="4" placeholder="Describe the problem."></textarea>{#if errors.knownProblem}<small id="known-problem-error" class="field-error">{errors.knownProblem}</small>{/if}</label>
      {/if}
      <label class:discovery-context={researchMode === "explore-market"}><span>{researchMode === "explore-market" ? "What do you want to explore?" : "Market or domain (optional)"}</span>{#if researchMode === "explore-market"}<small>Use whatever starting point you have: a goal, competition, topic, audience, market, rough idea, or something more specific.</small>{/if}<textarea bind:value={domain} aria-invalid={Boolean(errors.domain)} aria-describedby={errors.domain ? "domain-error" : undefined} rows={researchMode === "explore-market" ? 4 : 2} placeholder={researchMode === "explore-market" ? "Your topic or idea" : "Market or field"}></textarea>{#if errors.domain}<small id="domain-error" class="field-error">{errors.domain}</small>{/if}</label>
      <label><span>{researchMode === "explore-market" ? "People or groups (optional)" : "Audience (optional)"}</span><input bind:value={audience} placeholder={researchMode === "explore-market" ? "Who is this for?" : "Who is affected?"} /></label>
      <label class="problem-field"><span>What should we evaluate risk against?</span><textarea bind:value={riskEvaluationCriteria} maxlength="4000" rows="3" placeholder="What matters most: time, budget, or other limits?"></textarea></label>
    </div>


    <section class="optional-fields" aria-label="Context and boundaries">
      <h3>Context and boundaries <span>Optional</span></h3>
      <div>
        <label><span>{researchMode === "explore-market" ? "Anything else to consider" : "Context"}</span><textarea bind:value={observations} rows="4" placeholder="Useful background"></textarea></label>
        <label><span>Boundaries</span><small>One limit per line.</small><textarea bind:value={offLimits} rows="4" placeholder="What should ideas avoid?"></textarea></label>
      </div>
    </section>


      </section>
    </div>
    <aside class="configuration" aria-label="Run configuration">
      <div class="panel-heading"><Icon name="command" /><h2>Run configuration</h2></div>
    <div class="run-settings" class:known={researchMode === "known-problem"}>
      <label class="run-setting model-setting"><span>Model</span><select aria-label="Model" bind:this={modelSelect} bind:value={modelKey} onchange={selectModel} disabled={nativeModelOptions.length === 0}>{#if !selectedModelAvailable}<option value={modelKey}>{legacyModelNeedsReplacement && !modelKey ? "Choose an OpenAI model" : workspace.validation.native.connected ? `${modelDisplayName(model)} (unavailable)` : "Sign in to choose"}</option>{/if}{#if !astraAvailable && model.modelId !== "gpt-6-astra"}<option value="openai-subscription:gpt-6-astra" disabled>Astra (not in model list)</option>{/if}{#each nativeModelOptions as item (modelRefKey(item))}<option value={modelRefKey(item)}>{modelDisplayName(item)}</option>{/each}</select><small>{nativeModelOptions.length === 0 ? "Your available models appear here after you sign in." : "The model used throughout this research, including the independent risk evaluator."}</small></label>
      <label class="run-setting"><span>Reasoning</span><select title={reasoningDescription} bind:value={reasoningEffort}>{#each (selectedModelOption?.reasoningEfforts ?? [{ id: reasoningEffort, description: "" }]) as effort (effort.id)}<option value={effort.id}>{effort.id.charAt(0).toUpperCase() + effort.id.slice(1)}</option>{/each}</select><small>{reasoningDescription}</small></label>
      {#if researchMode === "explore-market"}<label class="run-setting"><span>Research depth</span><select title={depthDescription} bind:value={discoveryDepth}><option value="quick">Quick</option><option value="standard">Standard</option><option value="deep">Deep</option></select><small>{depthDescription}</small></label>{/if}
      {#if researchMode === "explore-market"}<label class="run-setting search-setting"><span>Search provider</span><div class="provider-select"><ProviderLogo provider={searchProvider} size={17} /><select aria-label="Search provider" bind:value={searchProvider}><option value="exa">Exa</option><option value="perplexity">Perplexity</option></select></div><small>{selectedSearchName}: {selectedSearchValidation.valid ? "Connected" : selectedSearchValidation.error ?? "Connection unavailable"}</small></label>{/if}
    </div>


      <div class="output-settings">
      <label><span>Ideas</span><input aria-label="Ideas to generate" type="number" bind:value={ideaCount} min="1" max={MAX_IDEA_COUNT} step="1" required aria-invalid={Boolean(errors.ideaCount)} aria-describedby={errors.ideaCount ? "idea-count-error" : undefined} /><small>Up to this many ideas per problem.</small>{#if errors.ideaCount}<small id="idea-count-error" class="field-error">{errors.ideaCount}</small>{/if}</label>
      {#if researchMode === "explore-market"}<label><span>Search in</span><select bind:value={audienceSourcePolicy}><option value="web">Web</option><option value="communities">Communities</option></select><small>Choose communities only when they represent the people you want to understand.</small></label>{/if}

      </div>
    {#if modelChoiceRequired}
      <div class="model-migration">
        <span>{legacyModelNeedsReplacement && !modelKey
          ? "This project used the removed CLI integration. Choose an OpenAI model to start a new run."
          : "The model saved for this project is no longer available. Choose an available OpenAI model to start a new run."}</span>
        <button type="button" class="secondary" onclick={() => { modelSelect.scrollIntoView?.({ block: "center" }); modelSelect.focus(); }}>Choose model</button>
      </div>
    {/if}

    {#if connectionNeedsAttention}
      <div class="connection-warning" class:checking={connectionsChecking} role="status">
        <div>
          <strong>{connectionsChecking ? "Checking connections" : "Connect to start"}</strong>
          {#if modelStatus}<span>Model: {modelStatus}</span>{/if}
          {#if researchMode === "explore-market" && !selectedSearchValidation.valid}<span>{selectedSearchName}: {selectedSearchValidation.error ?? "Connection unavailable"}</span>{/if}
        </div>
        {#if onOpenSettings}<button type="button" class="secondary" onclick={onOpenSettings}>Open settings</button>{/if}
        <button type="button" class="secondary" aria-label={connectionsChecking ? "Checking connections" : undefined} disabled={locked || connectionsChecking} onclick={() => onRetry()}>{locked || connectionsChecking ? "Checking…" : "Retry connections"}</button>
      </div>
    {/if}


    <footer>
      {#if saved}<span>Saved</span>{/if}
      <button type="submit" class="primary" disabled={locked || !providersReady}>{locked ? (researchMode === "explore-market" ? "Starting discovery…" : "Starting development…") : (researchMode === "explore-market" ? "Discover problems" : "Generate solutions")}</button>
    </footer>

    </aside>
  </form>
</section>

<style>
  .scope-page { max-width:1250px;margin:0 auto;padding:36px var(--page-inline) 64px; }
  .page-heading { display:flex;align-items:center;gap:16px;margin-bottom:28px; }
  h1 { margin:0;font-size:clamp(24px,2.6vw,32px);line-height:1.2;letter-spacing:-.045em;font-weight:650; }
  form { display:grid;grid-template-columns:minmax(0,1fr) 285px;gap:24px;align-items:start; }
  .brief-column { min-width:0; }
  fieldset { border:0;padding:0;margin:0 0 22px; }
  legend { position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%); }
  .mode-picker { display:grid;grid-template-columns:1fr 1fr;gap:10px; }
  .mode-picker label { position:relative;display:flex;gap:12px;align-items:center;padding:18px 14px;border:1px solid var(--border);border-radius:13px;background:var(--surface);cursor:pointer;transition:background 180ms,border-color 180ms; }
  .mode-picker label.active { border-color:#71cfba60;background:#71cfba0a;box-shadow:inset 0 1px #92ead510; }
  .mode-picker label > :global(svg) { color:var(--muted);flex:none; }
  .mode-picker label.active > :global(svg) { color:var(--accent-strong); }
  .mode-picker label > span:not(.mode-check) { display:grid;gap:5px; }
  .mode-picker input { position:absolute;opacity:0;width:1px;height:1px; }
  .mode-picker label:focus-within { outline:2px solid var(--accent);outline-offset:3px; }
  .mode-picker strong { font-size:13px;font-weight:650; }
  .mode-check { display:none;position:absolute;right:8px;top:8px;color:var(--accent); }
  .active .mode-check { display:block; }
  .brief-panel { padding:24px;border:1px solid var(--border);border-radius:18px;background:linear-gradient(145deg,#1b202355,transparent 65%);box-shadow:inset 0 1px #ffffff04; }
  .panel-heading { display:flex;align-items:center;gap:9px;margin-bottom:20px;color:var(--muted); }
  .panel-heading h2 { margin:0;font-size:13px;color:var(--text);font-weight:650; }
  .primary-fields { display:grid;gap:22px; }
  label { display:grid;gap:8px;min-width:0; }
  label > span { font-size:13px;font-weight:600; }
  small { color:var(--muted);font-size:13px;line-height:1.5; }
  input,textarea,select { width:100%;min-width:0;border:1px solid var(--border);background:#0b0e1099;color:var(--text);border-radius:9px;padding:10px 11px;font-size:13px; }
  textarea { resize:none; }
  .discovery-context textarea { min-height:150px; }
  .discovery-context > small { display:none; }
  input[aria-invalid="true"],textarea[aria-invalid="true"] { border-color:var(--danger); }
  .field-error { color:var(--danger); }
  .optional-fields { margin-top:24px;border-top:1px solid var(--border);padding-top:20px; }
  .optional-fields h3 { margin:0;font-size:13px;font-weight:600;color:var(--text); }
  .optional-fields h3 span { font-size:13px;margin-left:5px;color:var(--subtle); }
  .optional-fields > div { display:grid;gap:20px;padding-top:20px; }
  .configuration { position:sticky;top:150px;border:1px solid var(--border);border-radius:16px;padding:22px;background:var(--surface); }
  .run-settings { display:grid;grid-template-columns:1fr 1fr;gap:14px 12px; }
  .model-setting,.search-setting { grid-column:1/-1; }
  .output-settings { display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px; }
  .output-settings label { grid-template-rows:auto auto;align-content:start;gap:7px; }
  .run-setting { gap:7px; }
  .provider-select { position:relative;color:var(--text); }
  .provider-select :global(svg) { position:absolute;left:12px;top:50%;transform:translateY(-50%);pointer-events:none; }
  .provider-select select { padding-left:38px; }
  .run-setting small { display:none; }
  .output-settings { border-top:1px solid var(--border);margin-top:18px;padding-top:18px; }
  .output-settings label > small { display:none; }
  .connection-warning,.model-migration { display:flex;flex-wrap:wrap;gap:10px;padding:14px;border:1px solid #df929244;border-radius:10px;margin-top:20px;background:#df929208;font-size:13px; }
  .connection-warning > div { display:grid;gap:6px; }
  .connection-warning span,.model-migration { color:var(--muted); }
  .connection-warning strong { font-size:13px;color:var(--text); }
  .connection-warning.checking { border-color:var(--border); }
  button { border:1px solid var(--border-strong);border-radius:8px;padding:9px 12px;background:var(--surface-2);color:var(--text);font-weight:600;font-size:13px; }
  footer { display:grid;gap:8px;margin-top:20px; }
  footer > span { color:var(--success);font-size:13px; }
  .primary { min-height:44px;background:var(--accent-strong);border-color:transparent;color:var(--accent-ink);font-size:13px;box-shadow:0 4px 16px #71cfba12; }
  .primary:hover:not(:disabled) { box-shadow:0 4px 24px #71cfba25;transform:translateY(-1px); }
  @media(max-width:1100px) { form { grid-template-columns:minmax(0,1fr) 250px;gap:16px; }.mode-picker label { padding:16px 10px;gap:8px; }.brief-panel { padding:20px; }.configuration { padding:18px; } }
  @media(max-width:950px) { form { grid-template-columns:1fr; }.configuration { position:static; }.run-settings,.output-settings { grid-template-columns:1fr 1fr; }.scope-page { padding:28px 22px 48px; } }
  @media(max-width:560px) { .page-heading { align-items:start; }.mode-picker { grid-template-columns:1fr; }.run-settings,.output-settings { grid-template-columns:1fr; } }
  @media(max-height:760px) { .configuration { position:static; } }
</style>
