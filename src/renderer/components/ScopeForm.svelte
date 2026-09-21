<script lang="ts">
  import type { WorkspaceState } from "../../shared/ipc";
  import {
    DEFAULT_RUN_CONFIG,
    DEFAULT_IDEA_COUNT,
    MAX_IDEA_COUNT,
    modelRefKey,
    sameModelRef,
    type ModelRef,
    type ExplorationPurpose,
    type ResearchMode,
    type SearchProvider,
  } from "../../shared/schemas";
  import {
    DEFAULT_OPPORTUNITY_EXPLORATION_CONFIG,
    type OpportunityExplorationConfig,
  } from "../../shared/opportunity-exploration";
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
  let explorationPurpose = $state<ExplorationPurpose>(initial.runConfig?.explorationPurpose ?? "general-solutions");
  const initialOpportunityExploration = initial.runConfig?.opportunityExploration;
  let opportunityTargetEnabled = $state(Boolean(initialOpportunityExploration));
  let targetFamilies = $state(initialOpportunityExploration?.targetFamilies ?? DEFAULT_OPPORTUNITY_EXPLORATION_CONFIG.targetFamilies);
  let batchSize = $state(initialOpportunityExploration?.batchSize ?? DEFAULT_OPPORTUNITY_EXPLORATION_CONFIG.batchSize);
  let maxModelCalls = $state(initialOpportunityExploration?.maxModelCalls ?? DEFAULT_OPPORTUNITY_EXPLORATION_CONFIG.maxModelCalls);
  let maxSearches = $state(initialOpportunityExploration?.maxSearches ?? DEFAULT_OPPORTUNITY_EXPLORATION_CONFIG.maxSearches);
  let allowExploratoryProblems = $state(initialOpportunityExploration?.allowExploratoryProblems ?? false);
  let opportunityExploration = $derived<OpportunityExplorationConfig | undefined>(
    explorationPurpose === "startup-opportunities" && opportunityTargetEnabled
      ? {
          targetFamilies,
          batchSize,
          maxExpansionRounds: 2,
          maxRawCandidates: Math.min(60, targetFamilies * 2),
          maxModelCalls,
          maxSearches,
          allowExploratoryProblems,
        }
      : undefined,
  );
  const workflowVersion = 2;
  let audienceSourcePolicy = $state<"web" | "communities">(initial.scope ? initial.runConfig?.audienceSourcePolicy ?? "web" : defaults.audienceSourcePolicy);
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
  let discoveryDepth = $state(initial.scope ? initial.runConfig?.discoveryDepth ?? DEFAULT_RUN_CONFIG.discoveryDepth : defaults.discoveryDepth);
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
    model, reasoningEffort, discoveryDepth, searchProvider, maxRunMinutes, workflowVersion, audienceSourcePolicy, explorationPurpose,
    riskEvaluationCriteria: riskEvaluationCriteria.trim(), ideaCount, opportunityExploration,
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
    if (opportunityExploration) {
      if (!Number.isInteger(targetFamilies) || targetFamilies < 2 || targetFamilies > 30) {
        next.targetFamilies = "Choose a whole number from 2 to 30.";
      }
      if (!Number.isInteger(batchSize) || batchSize < 4 || batchSize > 6) {
        next.batchSize = "Choose a batch size from 4 to 6.";
      }
      if (!Number.isInteger(maxModelCalls) || maxModelCalls < 1 || maxModelCalls > 40) {
        next.maxModelCalls = "Choose a model-call limit from 1 to 40.";
      }
      if (!Number.isInteger(maxSearches) || maxSearches < 0 || maxSearches > 20) {
        next.maxSearches = "Choose a search limit from 0 to 20.";
      }
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
      }, {
        configVersion: 2, workflowVersion, audienceSourcePolicy, ideaCount, model, reasoningEffort,
        discoveryDepth, searchProvider, maxRunMinutes, researchMode, knownProblem: knownProblem.trim(),
        explorationPurpose, ...(opportunityExploration ? { opportunityExploration } : {}),
      });
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
  <form onsubmit={(event) => { event.preventDefault(); void saveAndStart(); }}>
    <div class="brief-column">
      <fieldset class="mode-picker">
        <legend>Starting point</legend>
        <label class:active={researchMode === "explore-market"}>
          <input type="radio" name="research-mode" value="explore-market" checked={researchMode === "explore-market"} onchange={() => researchMode = "explore-market"} />
          <Icon name="research" size={22} /><span><strong>Find problems to solve</strong><small>Research a topic or audience, then choose a problem.</small></span>
        </label>
        <label class:active={researchMode === "known-problem"}>
          <input type="radio" name="research-mode" value="known-problem" checked={researchMode === "known-problem"} onchange={() => researchMode = "known-problem"} />
          <Icon name="ideas" size={22} /><span><strong>I have a problem to solve</strong><small>Describe your problem and go straight to solutions.</small></span>
        </label>
      </fieldset>
      <fieldset class="purpose-picker">
        <legend>What should the options be?</legend>
        <label class:active={explorationPurpose === "general-solutions"}><input type="radio" name="exploration-purpose" value="general-solutions" checked={explorationPurpose === "general-solutions"} onchange={() => explorationPurpose = "general-solutions"} /><span><strong>Practical solutions</strong><small>Include product changes, process improvements, and configurations.</small></span></label>
        <label class:active={explorationPurpose === "startup-opportunities"}><input type="radio" name="exploration-purpose" value="startup-opportunities" checked={explorationPurpose === "startup-opportunities"} onchange={() => explorationPurpose = "startup-opportunities"} /><span><strong>Startup opportunities</strong><small>Require a paying customer, market gap, sellable workflow, and first customer route.</small></span></label>
      </fieldset>
      {#if explorationPurpose === "startup-opportunities"}
        <section class="opportunity-target" aria-label="Distinct opportunity target">
          <label class="target-toggle">
            <input type="checkbox" bind:checked={opportunityTargetEnabled} />
            <span><strong>Build a project-wide set of distinct businesses</strong><small>Review families across problems, then expand only into named gaps while the saved budget remains.</small></span>
          </label>
          {#if opportunityTargetEnabled}
            <div class="target-grid">
              <label><span>Distinct family target</span><input aria-label="Distinct family target" type="number" min="2" max="30" step="1" bind:value={targetFamilies} aria-invalid={Boolean(errors.targetFamilies)} />{#if errors.targetFamilies}<small class="field-error">{errors.targetFamilies}</small>{/if}</label>
              <label><span>Batch size</span><select aria-label="Opportunity batch size" bind:value={batchSize}><option value={4}>4</option><option value={5}>5</option><option value={6}>6</option></select>{#if errors.batchSize}<small class="field-error">{errors.batchSize}</small>{/if}</label>
              <label><span>Model-call limit</span><input aria-label="Opportunity model-call limit" type="number" min="1" max="40" step="1" bind:value={maxModelCalls} aria-invalid={Boolean(errors.maxModelCalls)} />{#if errors.maxModelCalls}<small class="field-error">{errors.maxModelCalls}</small>{/if}</label>
              <label><span>Added search limit</span><input aria-label="Opportunity search limit" type="number" min="0" max="20" step="1" bind:value={maxSearches} aria-invalid={Boolean(errors.maxSearches)} />{#if errors.maxSearches}<small class="field-error">{errors.maxSearches}</small>{/if}</label>
            </div>
            <p>Up to 2 expansion rounds and {Math.min(60, targetFamilies * 2)} raw candidates. Initial batches also respect your solutions-per-problem limit. Each batch is reviewed before the next begins.</p>
            <label class="exploratory-toggle"><input type="checkbox" bind:checked={allowExploratoryProblems} /><span><strong>Allow exploratory problem hypotheses</strong><small>Use only after the researched map is exhausted. Scraply labels these permanently and does not invent evidence for them.</small></span></label>
          {/if}
        </section>
      {/if}
      <section class="brief-panel" aria-label="Research brief">
    <div class="primary-fields">
      <label><span>Research name</span><input bind:value={title} aria-invalid={Boolean(errors.title)} aria-describedby={errors.title ? "title-error" : undefined} placeholder="Give this research a name, or leave blank" />{#if errors.title}<small id="title-error" class="field-error">{errors.title}</small>{/if}</label>
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
        <label><span>Boundaries</span><small>One limit per line.</small><textarea bind:value={offLimits} rows="4" placeholder="What should solutions avoid?"></textarea></label>
      </div>
    </section>


      </section>
    </div>
    <aside class="configuration" aria-label="Run configuration">
      <h2>Run settings</h2>
    <div class="run-settings" class:known={researchMode === "known-problem"}>
      <label class="run-setting model-setting"><span>Model</span><select aria-label="Model" bind:this={modelSelect} bind:value={modelKey} onchange={selectModel} disabled={nativeModelOptions.length === 0}>{#if !selectedModelAvailable}<option value={modelKey}>{legacyModelNeedsReplacement && !modelKey ? "Choose an OpenAI model" : workspace.validation.native.connected ? `${modelDisplayName(model)} (unavailable)` : "Sign in to choose"}</option>{/if}{#if !astraAvailable && model.modelId !== "gpt-6-astra"}<option value="openai-subscription:gpt-6-astra" disabled>GPT-6 Astra (not in model list)</option>{/if}{#each nativeModelOptions as item (modelRefKey(item))}<option value={modelRefKey(item)}>{modelDisplayName(item)}</option>{/each}</select><small>{nativeModelOptions.length === 0 ? "Your available models appear here after you sign in." : "The model used throughout this research, including the independent risk evaluator."}</small></label>
      <label class="run-setting"><span>Reasoning</span><select title={reasoningDescription} bind:value={reasoningEffort}>{#each (selectedModelOption?.reasoningEfforts ?? [{ id: reasoningEffort, description: "" }]) as effort (effort.id)}<option value={effort.id}>{effort.id.charAt(0).toUpperCase() + effort.id.slice(1)}</option>{/each}</select><small>{reasoningDescription}</small></label>
      {#if researchMode === "explore-market"}<label class="run-setting"><span>Research depth</span><select aria-label="Research depth" title={depthDescription} bind:value={discoveryDepth}><option value="quick">Quick</option><option value="standard">Standard</option><option value="deep">Deep</option></select><small>{depthDescription}</small></label>{/if}
      {#if researchMode === "explore-market"}<label class="run-setting search-setting"><span>Search provider</span><div class="provider-select"><ProviderLogo provider={searchProvider} size={17} /><select aria-label="Search provider" bind:value={searchProvider}><option value="exa">Exa</option><option value="perplexity">Perplexity</option></select></div><small>{selectedSearchName}: {selectedSearchValidation.valid ? "Connected" : selectedSearchValidation.error ?? "Connection unavailable"}</small></label>{/if}
    </div>


      <div class="output-settings">
      <div class="solution-count">
        <label for="solution-count">Solutions per problem</label>
        <div class="number-control">
          <input id="solution-count" type="number" bind:value={ideaCount} min="1" max={MAX_IDEA_COUNT} step="1" required aria-invalid={Boolean(errors.ideaCount)} aria-describedby={errors.ideaCount ? "idea-count-error" : undefined} />
          <div class="number-actions">
            <button type="button" aria-label="Fewer solutions per problem" disabled={locked || (ideaCount !== undefined && ideaCount <= 1)} onclick={() => ideaCount = Math.max(1, Math.min(MAX_IDEA_COUNT, Math.ceil(ideaCount ?? DEFAULT_IDEA_COUNT) - 1))}><Icon name="minus" size={16} /></button>
            <button type="button" aria-label="More solutions per problem" disabled={locked || (ideaCount !== undefined && ideaCount >= MAX_IDEA_COUNT)} onclick={() => ideaCount = Math.max(1, Math.min(MAX_IDEA_COUNT, Math.floor(ideaCount ?? DEFAULT_IDEA_COUNT) + 1))}><Icon name="plus" size={16} /></button>
          </div>
        </div>
        {#if errors.ideaCount}<small id="idea-count-error" class="field-error">{errors.ideaCount}</small>{/if}
      </div>
      {#if researchMode === "explore-market"}<label class="source-coverage"><span>Search coverage</span><select aria-label="Search coverage" bind:value={audienceSourcePolicy} aria-describedby="source-coverage-help"><option value="web">Web and communities</option><option value="communities">Communities only</option></select><small id="source-coverage-help">{audienceSourcePolicy === "web" ? "Includes websites, forums, and community discussions." : "Audience evidence from Reddit and Hacker News. Market research still searches all sites."}</small></label>{/if}

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
  .scope-page { max-width:1250px;margin:0 auto;padding:24px var(--page-inline) 48px; }
  form { display:grid;grid-template-columns:minmax(0,1fr) 265px;gap:32px;align-items:start; }
  .brief-column { min-width:0; }
  fieldset { border:0;padding:0;margin:0 0 24px; }
  legend { position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%); }
  .mode-picker { display:grid;grid-template-columns:1fr 1fr;gap:10px; }
  .mode-picker label { position:relative;display:flex;gap:12px;align-items:center;padding:16px 14px;border:1px solid var(--border-strong);border-radius:8px;background:var(--bg);cursor:pointer; }
  .mode-picker label.active { border-color:var(--accent);background:#081610; }
  .mode-picker label > :global(svg) { color:var(--muted);flex:none; }
  .mode-picker label.active > :global(svg) { color:var(--accent-strong); }
  .mode-picker label > span { display:grid;gap:5px;flex:1; }
  .mode-picker small { font-size:12px;font-weight:400;line-height:1.5; }
  .mode-picker input { position:absolute;width:1px;height:1px;padding:0;border:0;clip-path:inset(50%);overflow:hidden; }
  .mode-picker label:focus-within { outline:2px solid var(--accent);outline-offset:3px; }
  .mode-picker strong { font-size:13px;font-weight:650; }
  .purpose-picker { display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:18px; }
  .purpose-picker label { position:relative;display:flex;padding:14px;border:1px solid var(--border);border-radius:8px;background:#000;cursor:pointer; }
  .purpose-picker label.active { border-color:var(--accent);background:#081610; }
  .purpose-picker label > span { display:grid;gap:5px; }
  .purpose-picker strong { color:var(--text);font-size:13px; }
  .purpose-picker small { color:var(--muted);font-size:12px;line-height:1.5; }
  .purpose-picker input { position:absolute;width:1px;height:1px;clip-path:inset(50%); }
  .purpose-picker label:focus-within { outline:2px solid var(--accent);outline-offset:3px; }
  .opportunity-target { margin:-10px 0 24px;padding:16px;border:1px solid var(--border);border-radius:8px;background:#050505; }
  .target-toggle,.exploratory-toggle { position:relative;display:flex;grid-template-columns:auto 1fr;gap:10px;align-items:start; }
  .target-toggle > input,.exploratory-toggle > input { width:16px;height:16px;margin:2px 0 0; }
  .target-toggle > span,.exploratory-toggle > span { display:grid;gap:4px; }
  .target-toggle strong,.exploratory-toggle strong { font-size:13px; }
  .target-toggle small,.exploratory-toggle small { font-size:12px; }
  .target-grid { display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:16px;padding-top:16px;border-top:1px solid var(--border); }
  .target-grid label > span { font-size:12px; }
  .opportunity-target > p { margin:12px 0;color:var(--muted);font-size:12px;line-height:1.5; }
  .exploratory-toggle { padding-top:12px;border-top:1px solid var(--border); }
  .primary-fields { display:grid;gap:20px; }
  label { display:grid;gap:8px;min-width:0; }
  label > span { font-size:13px;font-weight:600; }
  small { color:var(--muted);font-size:13px;line-height:1.5; }
  input,textarea,select { width:100%;min-width:0;border:1px solid var(--border);background:var(--surface);color:var(--text);border-radius:6px;padding:10px 11px;font-size:13px; }
  textarea { resize:none; }
  .discovery-context textarea { min-height:120px; }
  .discovery-context > small { display:none; }
  input[aria-invalid="true"],textarea[aria-invalid="true"] { border-color:var(--danger); }
  .field-error { color:var(--danger); }
  .optional-fields { margin-top:24px;border-top:1px solid var(--border);padding-top:20px; }
  .optional-fields h3 { margin:0;font-size:13px;font-weight:600;color:var(--text); }
  .optional-fields h3 span { font-size:13px;margin-left:5px;color:var(--subtle); }
  .optional-fields > div { display:grid;gap:20px;padding-top:20px; }
  .configuration { position:sticky;top:134px;border-left:1px solid var(--border);padding-left:24px; }
  .configuration h2 { margin:0 0 20px;font-size:14px;font-weight:600; }
  .run-settings { display:grid;grid-template-columns:1fr 1fr;gap:14px 12px; }
  .model-setting,.search-setting { grid-column:1/-1; }
  .output-settings { display:grid;gap:16px; }
  .output-settings label { grid-template-rows:auto auto;align-content:start;gap:7px; }
  .solution-count { display:grid;align-content:start;gap:7px; }
  .solution-count > label { display:block;font-size:13px;font-weight:600; }
  .number-control { position:relative; }
  .number-control input { appearance:textfield;padding-right:80px;font-variant-numeric:tabular-nums; }
  .number-control input::-webkit-inner-spin-button,.number-control input::-webkit-outer-spin-button { appearance:none;margin:0; }
  .number-actions { position:absolute;right:5px;top:50%;transform:translateY(-50%);display:flex;gap:2px; }
  .number-actions button { display:grid;place-items:center;width:30px;height:30px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--muted); }
  .number-actions button:hover:not(:disabled) { background:var(--surface-2);color:var(--text); }
  .number-actions button:disabled { opacity:.3; }
  .run-setting { gap:7px; }
  .provider-select { position:relative;color:var(--text); }
  .provider-select :global(svg) { position:absolute;left:12px;top:50%;transform:translateY(-50%);pointer-events:none; }
  .provider-select select { padding-left:38px; }
  .run-setting small { display:none; }
  .output-settings { border-top:1px solid var(--border);margin-top:18px;padding-top:18px; }
  .output-settings .source-coverage > small { display:block;font-size:12px; }
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
  @media(max-width:1100px) { form { grid-template-columns:minmax(0,1fr) 230px;gap:24px; }.mode-picker label { padding:14px 10px;gap:8px; }.configuration { padding-left:20px; } }
  @media(max-width:950px) { form { grid-template-columns:1fr; }.configuration { position:static;border-left:0;border-top:1px solid var(--border);padding:24px 0 0; }.run-settings,.output-settings { grid-template-columns:1fr 1fr; }.scope-page { padding:24px 22px 48px; } }
  @media(max-width:560px) { .mode-picker,.purpose-picker,.target-grid { grid-template-columns:1fr; }.run-settings,.output-settings { grid-template-columns:1fr; } }
  @media(max-height:760px) { .configuration { position:static; } }
</style>
