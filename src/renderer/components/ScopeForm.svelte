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
  import { discoveryRunProjection } from "../../shared/discovery-projection";
  import { allocateIdeaTargets } from "../../core/opportunity-planning";
  import type { WorkflowLaunchDraft } from "../../shared/workflow-contracts";
  import type { z } from "zod";
  import { PreviewWorkflowResultSchema } from "../../shared/workflow-contracts";
  import ProviderLogo from "./ProviderLogo.svelte";
  import Icon from "./Icon.svelte";

  type WorkflowPreview = z.infer<typeof PreviewWorkflowResultSchema>;

  let { workspace, busy, onSave, onStart, onPreviewWorkflow, onStartWorkflow, onRetry, onOpenSettings } : {
    workspace: WorkspaceState; busy: boolean;
    onSave: (scope: NonNullable<WorkspaceState["scope"]>, config: NonNullable<WorkspaceState["runConfig"]>) => Promise<void>;
    onStart: () => Promise<void>;
    onPreviewWorkflow?: (draft: WorkflowLaunchDraft) => Promise<WorkflowPreview>;
    onStartWorkflow?: (preview: WorkflowPreview) => Promise<void>;
    onRetry: () => Promise<void>;
    onOpenSettings?: () => void;
  } = $props();
  let useWorkflow = $derived(Boolean(onPreviewWorkflow && onStartWorkflow));

  const initial = untrack(() => workspace);
  const defaults = untrack(readResearchDefaults);
  const startingModel = initial.scope ? initial.runConfig?.model : defaults.model;
  let researchMode = $state<ResearchMode>(initial.runConfig?.researchMode ?? "explore-market");
  const initialOpportunityExploration = initial.runConfig?.opportunityExploration;
  let opportunityTargetEnabled = $state(Boolean(initialOpportunityExploration));
  let businessTargetOpen = $state(Boolean(initialOpportunityExploration));
  let purposeOverride = $state<ExplorationPurpose | null>(null);
  let explorationPurpose = $derived<ExplorationPurpose>(opportunityTargetEnabled
    ? "startup-opportunities" : purposeOverride ?? initial.runConfig?.explorationPurpose ?? "auto");
  let targetFamilies = $state(initialOpportunityExploration?.targetFamilies ?? DEFAULT_OPPORTUNITY_EXPLORATION_CONFIG.targetFamilies);
  let batchSize = $state(initialOpportunityExploration?.batchSize ?? DEFAULT_OPPORTUNITY_EXPLORATION_CONFIG.batchSize);
  let maxModelCalls = $state(initialOpportunityExploration?.maxModelCalls ?? DEFAULT_OPPORTUNITY_EXPLORATION_CONFIG.maxModelCalls);
  let maxSearches = $state(initialOpportunityExploration?.maxSearches ?? DEFAULT_OPPORTUNITY_EXPLORATION_CONFIG.maxSearches);
  let allowExploratoryProblems = $state(initialOpportunityExploration?.allowExploratoryProblems ?? false);
  const workflowVersion = 2;
  let audienceSourcePolicy = $state<"web" | "communities">(initial.scope ? initial.runConfig?.audienceSourcePolicy ?? "web" : defaults.audienceSourcePolicy);
  let title = $state(initial.scope?.title ?? "");
  let audience = $state(initial.scope?.audience ?? "");
  let domain = $state(initial.scope?.domain ?? "");
  let observations = $state(initial.scope?.observations ?? "");
  let riskEvaluationCriteria = $state(initial.scope?.riskEvaluationCriteria ?? "");
  let contextOpen = $state(Boolean(initial.scope?.observations || initial.scope?.riskEvaluationCriteria || initial.scope?.offLimits.length));
  let ideaCount = $state<number | undefined>(initial.runConfig?.ideaCount ?? DEFAULT_IDEA_COUNT);
  let offLimits = $state(initial.scope?.offLimits.join("\n") ?? "");
  let knownProblem = $state(initial.runConfig?.knownProblem ?? "");
  let knownProblemTouched = $state(false);
  let domainTouched = $state(false);
  const legacyModelNeedsReplacement = initial.runConfig?.model.providerId === "legacy-codex-cli";
  let initialModel = startingModel
    ?? (initial.models.some((model) => sameModelRef(model, DEFAULT_RUN_CONFIG.model))
      ? DEFAULT_RUN_CONFIG.model
      : initial.modelOptions.find((item) => item.providerId === "openai-subscription") ?? DEFAULT_RUN_CONFIG.model);
  let modelKey = $state(legacyModelNeedsReplacement ? "" : modelRefKey(initialModel));
  let nativeModelOptions = $derived(workspace.modelOptions.filter((item) => item.providerId === "openai-subscription"));
  const gpt6Models = ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"] as const;
  let selectedModelOption = $derived(nativeModelOptions.find((item) => modelRefKey(item) === modelKey));
  let resolvedModel = $derived(selectedModelOption
    ?? (modelRefKey(initialModel) === modelKey ? initialModel : DEFAULT_RUN_CONFIG.model));
  let model = $derived<ModelRef>({ providerId: resolvedModel.providerId, modelId: resolvedModel.modelId });
  let initialModelOption = initial.modelOptions.find((item) => sameModelRef(item, initialModel));
  let modelSelect: HTMLSelectElement;
  let reasoningEffort = $state(initial.runConfig?.reasoningEffort
    ?? initialModelOption?.defaultReasoningEffort
    ?? DEFAULT_RUN_CONFIG.reasoningEffort);
  let discoveryDepth = $state(initial.scope ? initial.runConfig?.discoveryDepth ?? DEFAULT_RUN_CONFIG.discoveryDepth : defaults.discoveryDepth);
  let searchProvider = $state<SearchProvider>(initial.scope ? initial.runConfig?.searchProvider ?? defaults.searchProvider : defaults.searchProvider);
  let maxRunMinutes = $state(initial.runConfig?.maxRunMinutes ?? DEFAULT_RUN_CONFIG.maxRunMinutes);
  let workflowMode = $state<"babysit" | "vibe">("vibe");
  let ideaModelKey = $state(untrack(() => modelKey));
  let ideaModelOption = $derived(nativeModelOptions.find((item) => modelRefKey(item) === ideaModelKey));
  let ideaModel = $derived<ModelRef>({
    providerId: ideaModelOption?.providerId ?? model.providerId,
    modelId: ideaModelOption?.modelId ?? model.modelId,
  });
  let ideaReasoningEffort = $state(untrack(() => reasoningEffort));
  let automaticProblemCap = $state(3);
  const initialProjection = untrack(() => discoveryRunProjection(discoveryDepth));
  let workflowModelLimit = $state(initialProjection.modelCalls * 2 + 12);
  let workflowSearchLimit = $state(initialProjection.searches + 2);
  let workflowModelLimitTouched = $state(false);
  let workflowSearchLimitTouched = $state(false);
  let discoveryReservation = $derived(researchMode === "known-problem"
    ? { modelCalls: 0, searches: 0 }
    : { modelCalls: discoveryRunProjection(discoveryDepth).modelCalls * 2, searches: discoveryRunProjection(discoveryDepth).searches });
  let projectTargetEnabled = $derived(opportunityTargetEnabled);
  let projectInitialBatchCalls = $derived.by(() => {
    if (!projectTargetEnabled || !Number.isInteger(targetFamilies) || targetFamilies < 2 || targetFamilies > 30) return 0;
    const possibleProblems = researchMode === "known-problem" ? 1 : workflowMode === "vibe" ? automaticProblemCap : 1;
    if (!Number.isInteger(possibleProblems) || possibleProblems < 1 || possibleProblems > 20) return 0;
    return Math.max(...Array.from({ length: possibleProblems }, (_, index) => {
      const problemIds = Array.from({ length: index + 1 }, (_, problem) => `preview-problem-${problem}`);
      return allocateIdeaTargets({ problemIds, target: targetFamilies, maxPerProblem: 20 }).allocations
        .reduce((count, allocation) => count + Math.ceil(allocation.quota / 5), 0);
    })) * 4;
  });
  let opportunityExploration = $derived<OpportunityExplorationConfig | undefined>(projectTargetEnabled
    ? {
        targetFamilies,
        batchSize,
        maxExpansionRounds: 2,
        maxRawCandidates: Math.min(60, targetFamilies * 2),
        maxModelCalls: useWorkflow
          ? Math.min(40, Math.max(1, Number.isFinite(workflowModelLimit) ? workflowModelLimit - discoveryReservation.modelCalls : 1))
          : maxModelCalls,
        maxSearches: useWorkflow
          ? Math.min(20, Math.max(0, Number.isFinite(workflowSearchLimit) ? workflowSearchLimit - discoveryReservation.searches : 0))
          : maxSearches,
        allowExploratoryProblems,
      }
    : undefined);
  let researchInstruction = $state("");
  let ideasInstruction = $state("");
  let reviewInstruction = $state("");
  let workflowPreview = $state<WorkflowPreview | null>(null);
  let previewFingerprint = $state<string | null>(null);
  let previewing = $state(false);
  let previewError = $state<string | null>(null);
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
  // An unavailable saved model remains selected, but it cannot start a new run.
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
  let selectedReasoningAvailable = $derived(selectedModelOption?.reasoningEfforts.some((item) => item.id === reasoningEffort) ?? false);
  let selectedSearchValidation = $derived(workspace.validation[searchProvider]);
  let selectedSearchName = $derived(searchProvider === "exa" ? "Exa" : "Perplexity");
  let nativeValidationPending = $derived(isValidationPending(workspace.validation.native.error));
  let searchValidationPending = $derived(researchMode === "explore-market" && isValidationPending(selectedSearchValidation.error));
  let connectionsChecking = $derived(nativeValidationPending || searchValidationPending);
  let providersReady = $derived(selectedModelReady && selectedModelAvailable && selectedReasoningAvailable && (researchMode === "known-problem" || selectedSearchValidation.valid));
  let modelChoiceRequired = $derived(selectedModelReady && nativeModelOptions.length > 0 && !selectedModelAvailable);
  let reasoningChoiceRequired = $derived(selectedModelReady && selectedModelAvailable && !selectedReasoningAvailable);
  let connectionNeedsAttention = $derived(!selectedModelReady
    || nativeModelOptions.length === 0
    || (researchMode === "explore-market" && !selectedSearchValidation.valid));
  let modelStatus = $derived(!workspace.validation.native.available
      ? workspace.validation.native.error ?? "Native runtime is unavailable"
      : !workspace.validation.native.connected
        ? workspace.validation.native.error ?? "Connect your OpenAI account"
        : workspace.validation.native.error ?? (nativeModelOptions.length === 0 ? "No compatible models are available" : null));
  let locked = $derived(busy || submitting);
  let errors = $derived(validationAttempted || useWorkflow ? missingFields() : {});
  let knownProblemError = $derived(validationAttempted || knownProblemTouched ? errors.knownProblem : undefined);
  let domainError = $derived(validationAttempted || domainTouched ? errors.domain : undefined);
  let ideaModelAvailable = $derived(Boolean(ideaModelOption) && workspace.models.some((item) => sameModelRef(item, ideaModel)));
  let ideaReasoningAvailable = $derived(ideaModelOption?.reasoningEfforts.some((item) => item.id === ideaReasoningEffort) ?? false);
  let workflowDraft = $derived(buildWorkflowDraft());
  let workflowFingerprint = $derived(JSON.stringify(workflowDraft));
  let workflowPreviewValid = $derived(workflowPreview?.type === "launch" && workflowPreview.fieldErrors.length === 0
    && previewFingerprint === workflowFingerprint);

  $effect(() => {
    if (!workflowModelLimitTouched) workflowModelLimit = discoveryReservation.modelCalls
      + (projectTargetEnabled ? Math.max(DEFAULT_OPPORTUNITY_EXPLORATION_CONFIG.maxModelCalls, projectInitialBatchCalls) : 12);
    if (!workflowSearchLimitTouched) workflowSearchLimit = discoveryReservation.searches
      + (projectTargetEnabled ? DEFAULT_OPPORTUNITY_EXPLORATION_CONFIG.maxSearches : researchMode === "known-problem" ? 0 : 2);
  });

  $effect(() => {
    const fingerprint = workflowFingerprint;
    const draft = workflowDraft;
    workflowPreview = null;
    previewFingerprint = null;
    previewError = null;
    if (!useWorkflow || !onPreviewWorkflow || !providersReady || Object.keys(missingFields()).length > 0
      || (workflowMode === "vibe" && (!ideaModelAvailable || !ideaReasoningAvailable))) return;
    const timer = setTimeout(() => {
      previewing = true;
      void onPreviewWorkflow(draft).then((result) => {
        if (fingerprint !== untrack(() => workflowFingerprint)) return;
        workflowPreview = result;
        previewFingerprint = fingerprint;
        previewError = null;
      }).catch((cause: unknown) => {
        if (fingerprint !== untrack(() => workflowFingerprint)) return;
        previewError = cause instanceof Error ? cause.message : "Could not check this launch plan.";
      }).finally(() => {
        if (fingerprint === untrack(() => workflowFingerprint)) previewing = false;
      });
    }, 300);
    return () => clearTimeout(timer);
  });

  function selectModel(event: Event) {
    const selected = workspace.modelOptions.find((item) => modelRefKey(item) === (event.currentTarget as HTMLSelectElement).value);
    reasoningEffort = selected?.defaultReasoningEffort ?? DEFAULT_RUN_CONFIG.reasoningEffort;
  }

  function selectIdeaModel(event: Event) {
    const selected = workspace.modelOptions.find((item) => modelRefKey(item) === (event.currentTarget as HTMLSelectElement).value);
    ideaReasoningEffort = selected?.defaultReasoningEffort ?? DEFAULT_RUN_CONFIG.reasoningEffort;
  }

  function buildWorkflowDraft(): WorkflowLaunchDraft {
    const brief = (researchMode === "known-problem" ? knownProblem : domain).trim();
    const scope = {
      title: title.trim() || brief.slice(0, 80), audience: audience.trim(), domain: domain.trim(),
      observations: observations.trim(), riskEvaluationCriteria: riskEvaluationCriteria.trim(),
      offLimits: offLimits.split("\n").map((item) => item.trim()).filter(Boolean),
    };
    const runConfig: NonNullable<WorkspaceState["runConfig"]> = {
      configVersion: 2, workflowVersion, audienceSourcePolicy, ideaCount: ideaCount ?? DEFAULT_IDEA_COUNT,
      model, reasoningEffort, discoveryDepth, searchProvider, maxRunMinutes,
      researchMode, knownProblem: knownProblem.trim(), explorationPurpose,
      ...(opportunityExploration ? { opportunityExploration } : {}),
    };
    return {
      contractVersion: 1, purpose: researchMode === "known-problem" ? "known-problem" : "discovery",
      mode: workflowMode, brief, scope, runConfig,
      ...(workflowMode === "vibe" ? { ideas: { model: ideaModel, reasoningEffort: ideaReasoningEffort,
        reviewModel: ideaModel, reviewReasoningEffort: ideaReasoningEffort } } : {}),
      targets: {
        kind: opportunityExploration ? "project" : "per-problem",
        ideaCount: ideaCount ?? DEFAULT_IDEA_COUNT,
        ...(opportunityExploration ? { distinctBusinessCount: targetFamilies } : {}),
        ...(workflowMode === "vibe" && researchMode === "explore-market" ? { automaticProblemCap } : {}),
      },
      limits: { maxMinutes: maxRunMinutes, maxModelCalls: workflowModelLimit, maxSearches: workflowSearchLimit },
      instructions: { research: researchInstruction.trim(), ideas: ideasInstruction.trim(), review: reviewInstruction.trim() },
    };
  }

  function isValidationPending(error: string | undefined): boolean {
    return error?.startsWith("Checking ") === true || error === "Native runtime is starting";
  }

  function previewIssue(path: string): string | null {
    return workflowPreview?.fieldErrors.find((issue) => issue.path.join(".") === path)?.message ?? null;
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
    if (useWorkflow) {
      if (!Number.isInteger(maxRunMinutes) || maxRunMinutes < 5 || maxRunMinutes > 240) next.maxRunMinutes = "Choose 5 to 240 minutes.";
      if (!Number.isInteger(workflowModelLimit) || workflowModelLimit < 1) next.workflowModelLimit = "Choose a positive model-call limit.";
      else if (projectTargetEnabled && projectInitialBatchCalls > 0
        && workflowModelLimit < discoveryReservation.modelCalls + projectInitialBatchCalls) {
        next.workflowModelLimit = `Allow at least ${discoveryReservation.modelCalls + projectInitialBatchCalls} model calls for projected research, generation, and review.`;
      }
      if (!Number.isInteger(workflowSearchLimit) || workflowSearchLimit < 0) next.workflowSearchLimit = "Choose zero or more searches.";
      else if (projectTargetEnabled && workflowSearchLimit < discoveryReservation.searches) {
        next.workflowSearchLimit = `Allow at least ${discoveryReservation.searches} ${discoveryReservation.searches === 1 ? "search" : "searches"} for projected research.`;
      }
      if (workflowMode === "vibe") {
        if (!ideaModelAvailable) next.ideaModel = "Choose an available ideas model.";
        else if (!ideaReasoningAvailable) next.ideaReasoning = "Choose an available reasoning effort for ideas.";
        if (researchMode === "explore-market" && (!Number.isInteger(automaticProblemCap) || automaticProblemCap < 1 || automaticProblemCap > 20)) next.automaticProblemCap = "Choose 1 to 20 problems.";
      }
    }
    return next;
  }

  function launchSteps(): string {
    if (researchMode === "known-problem") {
      return workflowMode === "vibe" ? "Use your stated problem, generate, and review" : "Use your stated problem, then wait for your choices";
    }
    return workflowMode === "vibe" ? "Research, select, generate, and review" : "Research, then wait for your selection";
  }

  async function saveAndStart() {
    if (locked || !providersReady) return;
    validationAttempted = true;
    if (Object.keys(missingFields()).length > 0) return;
    submitting = true;
    try {
      if (useWorkflow && onPreviewWorkflow && onStartWorkflow) {
        const fingerprint = workflowFingerprint;
        let preview = workflowPreview;
        if (!preview || previewFingerprint !== fingerprint || Date.now() >= Date.parse(preview.expiresAt)) {
          preview = await onPreviewWorkflow(workflowDraft);
          if (fingerprint !== untrack(() => workflowFingerprint)) return;
          workflowPreview = preview;
          previewFingerprint = fingerprint;
        }
        if (preview.type !== "launch" || preview.fieldErrors.length > 0) return;
        await onStartWorkflow(preview);
        return;
      }
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
      <fieldset class="choice-group mode-picker">
        <legend>Starting point</legend>
        <label class:active={researchMode === "explore-market"}>
          <input type="radio" name="research-mode" value="explore-market" checked={researchMode === "explore-market"} onchange={() => researchMode = "explore-market"} />
          <span><strong>Find problems to solve</strong></span>
        </label>
        <label class:active={researchMode === "known-problem"}>
          <input type="radio" name="research-mode" value="known-problem" checked={researchMode === "known-problem"} onchange={() => researchMode = "known-problem"} />
          <span><strong>I have a problem to solve</strong></span>
        </label>
      </fieldset>
      <section class="brief-panel" aria-label="Research brief">
        <div class="primary-fields">
          {#if researchMode === "known-problem"}
            <label class="main-brief"><span>What problem do you want to solve?</span><textarea bind:value={knownProblem} onblur={() => knownProblemTouched = true} aria-invalid={Boolean(knownProblemError)} aria-describedby={knownProblemError ? "known-problem-error" : undefined} rows="5" placeholder="Describe the problem."></textarea>{#if knownProblemError}<small id="known-problem-error" class="field-error">{knownProblemError}</small>{/if}</label>
          {/if}
          <label class:main-brief={researchMode === "explore-market"}><span>{researchMode === "explore-market" ? "What do you want to explore?" : "Market or domain (optional)"}</span><textarea bind:value={domain} onblur={() => domainTouched = true} aria-invalid={Boolean(domainError)} aria-describedby={domainError ? "domain-error" : undefined} rows={researchMode === "explore-market" ? 5 : 2} placeholder={researchMode === "explore-market" ? "Your topic or idea" : "Market or field"}></textarea>{#if domainError}<small id="domain-error" class="field-error">{domainError}</small>{/if}</label>
          <div class="brief-metadata">
            <label><span>Research name <span class="optional-label">Optional</span></span><input bind:value={title} aria-invalid={Boolean(errors.title)} aria-describedby={errors.title ? "title-error" : undefined} placeholder="Name this research" />{#if errors.title}<small id="title-error" class="field-error">{errors.title}</small>{/if}</label>
            <label><span>{researchMode === "explore-market" ? "People or groups" : "Audience"} <span class="optional-label">Optional</span></span><input bind:value={audience} placeholder={researchMode === "explore-market" ? "Who is this for?" : "Who is affected?"} /></label>
          </div>
        </div>
        <details class="optional-fields" bind:open={contextOpen}>
          <summary>Context and boundaries</summary>
          <div>
            <label><span>Risk priorities</span><textarea bind:value={riskEvaluationCriteria} maxlength="4000" rows="3" placeholder="What matters most: time, budget, or other limits?"></textarea></label>
            <label><span>{researchMode === "explore-market" ? "Anything else to consider" : "Context"}</span><textarea bind:value={observations} rows="3" placeholder="Useful background"></textarea></label>
            <label><span>Boundaries</span><textarea bind:value={offLimits} rows="3" placeholder="What should solutions avoid? One limit per line."></textarea></label>
          </div>
        </details>
      </section>
      {#if !opportunityTargetEnabled && explorationPurpose !== "auto"}
        <p class="saved-purpose-note">This saved project asks for {explorationPurpose === "startup-opportunities" ? "startup opportunities" : "practical solutions"}. <button type="button" onclick={() => purposeOverride = "auto"}>Follow the brief instead</button></p>
      {/if}
      <details class="business-target" bind:open={businessTargetOpen}>
        <summary>Distinct business target {opportunityTargetEnabled ? `· On (${targetFamilies})` : "(optional)"}</summary>
        <section class="opportunity-target" aria-label="Distinct opportunity target">
          <label class="target-toggle">
            <input type="checkbox" checked={opportunityTargetEnabled} onchange={(event) => { opportunityTargetEnabled = event.currentTarget.checked; if (!opportunityTargetEnabled) purposeOverride = "auto"; }} />
            <span><strong>Find distinct businesses across this project</strong></span>
          </label>
          {#if opportunityTargetEnabled}
            <div class="target-grid">
              <label><span>Distinct family target</span><input aria-label="Distinct family target" type="number" min="2" max="30" step="1" bind:value={targetFamilies} aria-invalid={Boolean(errors.targetFamilies)} />{#if errors.targetFamilies}<small class="field-error">{errors.targetFamilies}</small>{/if}</label>
              <label><span>Batch size</span><select aria-label="Opportunity batch size" bind:value={batchSize}><option value={4}>4</option><option value={5}>5</option><option value={6}>6</option></select>{#if errors.batchSize}<small class="field-error">{errors.batchSize}</small>{/if}</label>
              {#if !useWorkflow}
                <label><span>Opportunity model-call limit</span><input aria-label="Opportunity model-call limit" type="number" min="1" max="40" step="1" bind:value={maxModelCalls} aria-invalid={Boolean(errors.maxModelCalls)} />{#if errors.maxModelCalls}<small class="field-error">{errors.maxModelCalls}</small>{/if}</label>
                <label><span>Added opportunity search limit</span><input aria-label="Opportunity search limit" type="number" min="0" max="20" step="1" bind:value={maxSearches} aria-invalid={Boolean(errors.maxSearches)} />{#if errors.maxSearches}<small class="field-error">{errors.maxSearches}</small>{/if}</label>
              {/if}
            </div>
            <p>Similar ideas count as one business. Up to 2 expansion rounds and {Math.min(60, targetFamilies * 2)} candidates.{#if useWorkflow}&nbsp;Work limits cover research, ideas, review, and added searches.{/if}</p>
            <label class="exploratory-toggle"><input type="checkbox" bind:checked={allowExploratoryProblems} /><span><strong>Allow exploratory problem hypotheses</strong><small>Use only after the researched map is exhausted. Scraply labels these permanently and does not invent evidence for them.</small></span></label>
          {/if}
        </section>
      </details>
    </div>
    <aside class="configuration" aria-label="Run configuration">
      {#if useWorkflow}
        <fieldset class="choice-group workflow-mode">
          <legend>Run mode</legend>
          <label class:active={workflowMode === "vibe"}>
            <input type="radio" name="workflow-mode" value="vibe" checked={workflowMode === "vibe"} onchange={() => workflowMode = "vibe"} />
            <span><strong>Vibe</strong><small>Let Scraply research, generate, and review ideas within your limits.</small></span>
          </label>
          <label class:active={workflowMode === "babysit"}>
            <input type="radio" name="workflow-mode" value="babysit" checked={workflowMode === "babysit"} onchange={() => workflowMode = "babysit"} />
            <span><strong>Babysit</strong><small>Review the research and choose what becomes an idea.</small></span>
          </label>
        </fieldset>
      {/if}
      <h2>Run settings</h2>
    <div class="run-settings" class:known={researchMode === "known-problem"}>
      <label class="run-setting model-setting"><span>Model</span><select aria-label="Model" bind:this={modelSelect} bind:value={modelKey} onchange={selectModel} disabled={nativeModelOptions.length === 0}>{#if !selectedModelAvailable}<option value={modelKey}>{legacyModelNeedsReplacement && !modelKey ? "Choose an OpenAI model" : workspace.validation.native.connected ? `${modelDisplayName(model)} (unavailable)` : "Sign in to choose"}</option>{/if}{#each gpt6Models as modelId (modelId)}{#if !nativeModelOptions.some((item) => item.modelId === modelId) && model.modelId !== modelId}<option value={`openai-subscription:${modelId}`} disabled>{modelDisplayName({ modelId })} (not in model list)</option>{/if}{/each}{#each nativeModelOptions as item (modelRefKey(item))}<option value={modelRefKey(item)}>{modelDisplayName(item)}</option>{/each}</select><small>{nativeModelOptions.length === 0 ? "Your available models appear here after you sign in." : "The model used throughout this research, including the independent risk evaluator."}</small></label>
      <label class="run-setting"><span>Reasoning</span><select title={reasoningDescription} bind:value={reasoningEffort}>{#if !selectedReasoningAvailable}<option value={reasoningEffort}>{reasoningEffort} (unavailable)</option>{/if}{#each (selectedModelOption?.reasoningEfforts ?? []) as effort (effort.id)}<option value={effort.id}>{effort.id.charAt(0).toUpperCase() + effort.id.slice(1)}</option>{/each}</select><small>{reasoningDescription}</small></label>
      {#if researchMode === "explore-market"}<label class="run-setting"><span>Research depth</span><select aria-label="Research depth" title={depthDescription} bind:value={discoveryDepth}><option value="quick">Quick</option><option value="standard">Standard</option><option value="deep">Deep</option></select><small>{depthDescription}</small></label>{/if}
      {#if researchMode === "explore-market"}<label class="run-setting search-setting"><span>Search provider</span><div class="provider-select"><ProviderLogo provider={searchProvider} size={17} /><select aria-label="Search provider" bind:value={searchProvider}><option value="exa">Exa</option><option value="perplexity">Perplexity</option></select></div><small>{selectedSearchName}: {selectedSearchValidation.valid ? "Connected" : selectedSearchValidation.error ?? "Connection unavailable"}</small></label>{/if}
    </div>

    {#if useWorkflow && workflowMode === "vibe"}
      <section class="ideas-settings" aria-label="Ideas model settings">
        <h3>Ideas and review</h3>
        <label><span>Ideas model</span><select aria-label="Ideas model" bind:value={ideaModelKey} onchange={selectIdeaModel} aria-invalid={Boolean(errors.ideaModel || previewIssue("ideas.model"))}>
          {#if !ideaModelAvailable}<option value={ideaModelKey}>{modelDisplayName(ideaModel)} (unavailable)</option>{/if}
          {#each nativeModelOptions as option (modelRefKey(option))}<option value={modelRefKey(option)}>{modelDisplayName(option)}</option>{/each}
        </select></label>
        {#if errors.ideaModel || previewIssue("ideas.model")}<small class="field-error">{errors.ideaModel ?? previewIssue("ideas.model")}</small>{/if}
        <label><span>Ideas reasoning</span><select aria-label="Ideas reasoning" bind:value={ideaReasoningEffort} aria-invalid={Boolean(errors.ideaReasoning)}>
          {#if !ideaReasoningAvailable}<option value={ideaReasoningEffort}>{ideaReasoningEffort} (unavailable)</option>{/if}
          {#each (ideaModelOption?.reasoningEfforts ?? []) as effort (effort.id)}<option value={effort.id}>{effort.id.charAt(0).toUpperCase() + effort.id.slice(1)}</option>{/each}
        </select></label>
        {#if errors.ideaReasoning}<small class="field-error">{errors.ideaReasoning}</small>{/if}
      </section>
    {/if}


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
      {#if researchMode === "explore-market"}<label class="source-coverage"><span>Search coverage</span><select aria-label="Search coverage" bind:value={audienceSourcePolicy} aria-describedby={audienceSourcePolicy === "communities" ? "source-coverage-help" : undefined}><option value="web">Web and communities</option><option value="communities">Communities only</option></select>{#if audienceSourcePolicy === "communities"}<small id="source-coverage-help">Audience evidence from Reddit and Hacker News. Market research still searches all sites.</small>{/if}</label>{/if}

      </div>
    {#if useWorkflow}
      <details class="advanced-options">
        <summary>Advanced instructions</summary>
        <div class="advanced-body">
          <label><span>Research instructions</span><textarea bind:value={researchInstruction} maxlength="20000" rows="3" placeholder="Optional context for research"></textarea></label>
          <label><span>Ideas instructions</span><textarea bind:value={ideasInstruction} maxlength="20000" rows="3" placeholder="Optional context for generation"></textarea></label>
          <label><span>Review instructions</span><textarea bind:value={reviewInstruction} maxlength="20000" rows="3" placeholder="Optional context for review"></textarea></label>
        </div>
      </details>
      <details class="advanced-options" open={workflowMode === "vibe"}>
        <summary>Work limits</summary>
        <div class="advanced-body limits-grid">
          <label><span>Time limit (minutes)</span><input aria-label="Time limit" type="number" min="5" max="240" step="1" bind:value={maxRunMinutes} aria-invalid={Boolean(errors.maxRunMinutes)} />{#if errors.maxRunMinutes}<small class="field-error">{errors.maxRunMinutes}</small>{/if}</label>
          <label><span>Maximum model calls</span><input aria-label="Maximum model calls" type="number" min="1" step="1" bind:value={workflowModelLimit} oninput={() => workflowModelLimitTouched = true} aria-invalid={Boolean(errors.workflowModelLimit || previewIssue("limits.maxModelCalls"))} />{#if errors.workflowModelLimit || previewIssue("limits.maxModelCalls")}<small class="field-error">{errors.workflowModelLimit ?? previewIssue("limits.maxModelCalls")}</small>{/if}</label>
          <label><span>Maximum searches</span><input aria-label="Maximum searches" type="number" min="0" step="1" bind:value={workflowSearchLimit} oninput={() => workflowSearchLimitTouched = true} aria-invalid={Boolean(errors.workflowSearchLimit || previewIssue("limits.maxSearches"))} />{#if errors.workflowSearchLimit || previewIssue("limits.maxSearches")}<small class="field-error">{errors.workflowSearchLimit ?? previewIssue("limits.maxSearches")}</small>{/if}</label>
          {#if workflowMode === "vibe" && researchMode === "explore-market"}<label><span>Automatic problem cap</span><input aria-label="Automatic problem cap" type="number" min="1" max="20" step="1" bind:value={automaticProblemCap} aria-invalid={Boolean(errors.automaticProblemCap)} />{#if errors.automaticProblemCap}<small class="field-error">{errors.automaticProblemCap}</small>{/if}</label>{/if}
        </div>
      </details>
      <div class="launch-preview" role="status">
        {#if previewing}<span>Checking the launch plan…</span>
        {:else if previewError}<span class="field-error">{previewError}</span>
        {:else if workflowPreviewValid && workflowPreview}<span>{launchSteps()}. Target: {opportunityExploration ? `${targetFamilies} distinct businesses` : `${ideaCount} ${ideaCount === 1 ? "idea" : "ideas"} per problem`}. Up to {workflowModelLimit} model calls, {workflowSearchLimit} {workflowSearchLimit === 1 ? "search" : "searches"}, and {maxRunMinutes} minutes.</span>
        {:else if !providersReady}<span>Connect the required providers and choose an available research model.</span>
        {:else if missingFields().knownProblem}<span>Describe the problem to check the launch plan.</span>
        {:else if missingFields().domain}<span>Add a starting topic or audience to check the launch plan.</span>
        {:else if Object.keys(missingFields()).length > 0}<span>Check the highlighted settings to continue.</span>
        {:else}<span>Preparing the launch plan…</span>{/if}
        {#if workflowPreview && workflowPreview.fieldErrors.length > 0}
          <ul>{#each workflowPreview.fieldErrors.filter((issue) => !["limits.maxModelCalls", "limits.maxSearches", "ideas.model"].includes(issue.path.join("."))) as issue (`${issue.path.join(".")}:${issue.code}`)}<li>{issue.message}</li>{/each}</ul>
        {:else if workflowPreviewValid && workflowPreview}<small>Minimum required: {workflowPreview.minimumWork.modelCalls} model calls and {workflowPreview.minimumWork.searches} {workflowPreview.minimumWork.searches === 1 ? "search" : "searches"}. Work stops at your saved limits.</small>{/if}
      </div>
    {/if}
    {#if modelChoiceRequired}
      <div class="model-migration">
        <span>{legacyModelNeedsReplacement && !modelKey
          ? "This project used the removed CLI integration. Choose an OpenAI model to start a new run."
          : "The model saved for this project is no longer available. Choose an available OpenAI model to start a new run."}</span>
        <button type="button" class="secondary" onclick={() => { modelSelect.scrollIntoView?.({ block: "center" }); modelSelect.focus(); }}>Choose model</button>
      </div>
    {/if}
    {#if reasoningChoiceRequired}<div class="model-migration" role="status">The saved reasoning effort is unavailable for this model. Choose an available effort to start a new run.</div>{/if}

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
      <button type="submit" class="primary" disabled={locked || !providersReady || (useWorkflow && (!workflowPreviewValid || previewing))}>{locked ? "Starting…" : useWorkflow ? `Start ${workflowMode === "vibe" ? "Vibe" : "Babysit"}` : (researchMode === "explore-market" ? "Discover problems" : "Generate solutions")}</button>
    </footer>

    </aside>
  </form>
</section>

<style>
  .scope-page { max-width:1250px;margin:0 auto;padding:32px var(--page-inline) 48px; }
  form { display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:40px;align-items:start; }
  .brief-column { min-width:0; }
  fieldset { border:0;padding:0;margin:0 0 30px;min-width:0; }
  .choice-group { display:grid;grid-template-columns:1fr 1fr;gap:8px; }
  .choice-group legend { grid-column:1/-1;margin-bottom:12px;color:var(--muted);font-size:12px;font-weight:500; }
  .choice-group label { position:relative;display:flex;align-items:center;gap:10px;min-height:48px;padding:12px;border:1px solid var(--border);border-radius:8px;background:#000;cursor:pointer; }
  .choice-group label:hover { border-color:var(--muted); }
  .choice-group label.active { border-color:#527565;background:#0c1511; }
  .choice-group label > span { display:grid;align-content:center;gap:4px; }
  .choice-group strong { color:var(--text);font-size:13px;font-weight:500;line-height:1.4; }
  .choice-group small { color:var(--muted);font-size:11px;font-weight:400;line-height:1.5; }
  .choice-group input { appearance:none;flex:none;width:14px;height:14px;margin:0;padding:0;border:1px solid var(--border-strong);border-radius:50%;background:#000; }
  .choice-group input:checked { border:4px solid var(--accent); }
  .workflow-mode { grid-template-columns:1fr; }
  .workflow-mode label { align-items:start;gap:10px;padding:14px; }
  .workflow-mode small { font-size:12px; }
  .workflow-mode input { margin-top:2px; }
  .choice-group label:has(input:focus-visible) { outline:2px solid var(--accent);outline-offset:3px; }
  .business-target { margin:0;border-bottom:1px solid var(--border); }
  .saved-purpose-note { margin:-4px 0 18px;color:var(--muted);font-size:12px;line-height:1.5; }
  .saved-purpose-note button { margin-left:4px;padding:0;border:0;background:none;color:var(--accent-strong);font:inherit;text-decoration:underline;cursor:pointer; }
  .business-target summary,.optional-fields summary { display:flex;align-items:center;gap:12px;padding:18px 0;color:var(--muted);font-size:13px;font-weight:500;cursor:pointer;list-style:none; }
  .business-target summary::-webkit-details-marker,.optional-fields summary::-webkit-details-marker { display:none; }
  .business-target summary::after,.optional-fields summary::after { content:"";width:6px;height:6px;border-right:1.5px solid var(--subtle);border-bottom:1.5px solid var(--subtle);transform:rotate(-45deg);margin-left:auto;margin-right:4px; }
  .business-target[open] summary::after,.optional-fields[open] summary::after { transform:rotate(45deg); }
  .business-target summary:hover,.optional-fields summary:hover { color:var(--text); }
  .business-target summary:focus-visible { outline:2px solid var(--accent);outline-offset:3px; }
  .opportunity-target { padding:4px 0 20px; }
  .target-toggle,.exploratory-toggle { position:relative;display:flex;grid-template-columns:auto 1fr;gap:10px;align-items:start; }
  .target-toggle > input,.exploratory-toggle > input { width:16px;height:16px;margin:2px 0 0;accent-color:var(--accent); }
  .target-toggle > span,.exploratory-toggle > span { display:grid;gap:4px; }
  .target-toggle strong,.exploratory-toggle strong { font-size:13px; }
  .exploratory-toggle small { font-size:12px; }
  .target-grid { display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:16px;padding-top:16px;border-top:1px solid var(--border); }
  .target-grid label > span { font-size:12px; }
  .opportunity-target > p { margin:12px 0;color:var(--muted);font-size:12px;line-height:1.5; }
  .exploratory-toggle { padding-top:12px;border-top:1px solid var(--border); }
  .primary-fields { display:grid;gap:24px; }
  .brief-metadata { display:grid;grid-template-columns:1fr 1fr;gap:16px; }
  .optional-label { margin-left:6px;color:var(--subtle);font-size:11px;font-weight:400; }
  label { display:grid;gap:8px;min-width:0; }
  label > span { font-size:12px;font-weight:500; }
  small { color:var(--muted);font-size:13px;line-height:1.5; }
  input,textarea,select { width:100%;min-width:0;border:1px solid var(--border);background:var(--surface);color:var(--text);border-radius:6px;padding:10px 11px;font-size:13px; }
  textarea { resize:none; }
  .main-brief { gap:14px; }
  .main-brief > span { color:var(--text);font-size:22px;font-weight:600;letter-spacing:-.7px;line-height:1.4; }
  .main-brief textarea { min-height:180px;padding:16px;font-size:14px;line-height:1.75; }
  input[aria-invalid="true"],textarea[aria-invalid="true"] { border-color:var(--danger); }
  .field-error { color:var(--danger); }
  .optional-fields { margin-top:30px;border-block:1px solid var(--border); }
  .optional-fields > div { display:grid;gap:20px;padding:4px 0 24px; }
  .configuration { position:sticky;top:134px;min-width:0;border-left:1px solid var(--border);padding-left:28px; }
  .configuration h2 { margin:0 0 16px;font-size:12px;font-weight:500;color:var(--muted); }
  .run-settings { display:grid;grid-template-columns:1fr 1fr;gap:14px 12px; }
  .ideas-settings { display:grid;gap:10px;margin-top:18px;padding-top:18px;border-top:1px solid var(--border); }
  .ideas-settings h3 { margin:0;color:var(--text);font-size:13px; }
  .advanced-options { margin-top:16px;border-top:1px solid var(--border);padding-top:14px; }
  .advanced-options summary { color:var(--text);font-size:13px;font-weight:600;cursor:pointer; }
  .advanced-options summary:focus-visible { outline:2px solid var(--accent);outline-offset:3px; }
  .advanced-body { display:grid;gap:12px;margin-top:15px; }
  .advanced-body label > span { font-size:12px; }
  .launch-preview { display:grid;gap:7px;margin-top:18px;color:var(--muted);font-size:12px;line-height:1.6; }
  .launch-preview small { font-size:11px; }
  .launch-preview ul { margin:0;padding-left:18px;color:var(--danger); }
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
  .primary { min-height:44px;background:var(--accent-strong);border-color:transparent;color:var(--accent-ink);font-size:13px; }
  .primary:hover:not(:disabled) { background:var(--accent); }
  @media(max-width:1100px) { form { grid-template-columns:minmax(0,1fr) 280px;gap:24px; }.configuration { padding-left:20px; }.mode-picker { grid-template-columns:1fr; } }
  @media(max-width:950px) { form { grid-template-columns:1fr; }.configuration { position:static;border-left:0;border-top:1px solid var(--border);padding:24px 0 0; }.run-settings,.output-settings { grid-template-columns:1fr 1fr; }.scope-page { padding:24px 22px 48px; } }
  @media(max-width:560px) { .mode-picker,.target-grid,.brief-metadata { grid-template-columns:1fr; }.run-settings,.output-settings { grid-template-columns:1fr; }.main-brief > span { font-size:20px; } }
  @media(max-height:760px) { .configuration { position:static; } }
</style>
