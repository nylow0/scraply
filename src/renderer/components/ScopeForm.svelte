<script lang="ts">
  import type { WorkspaceState } from "../../shared/ipc";
  import {
    DEFAULT_RUN_CONFIG,
    DEFAULT_IDEA_COUNT,
    MAX_IDEAS_PER_PROBLEM,
    modelRefKey,
    sameModelRef,
    type ModelRef,
    type ExplorationPurpose,
    type ResearchMode,
  } from "../../shared/schemas";
  import type { SearchProviderChoice } from "../../providers/search";
  import { tick, untrack } from "svelte";
  import { hasSavedResearchDefaults, modelDisplayName, readResearchDefaults } from "../lib/research-defaults";
  import { preferredModel } from "../../shared/latest-models";
  import ModelPicker from "./ModelPicker.svelte";
  import { framedDiscoveryProjection } from "../../shared/discovery-projection";
  import type { WorkflowLaunchDraft } from "../../shared/workflow-contracts";
  import type { z } from "zod";
  import { PreviewWorkflowResultSchema } from "../../shared/workflow-contracts";
  import SearchProviderSelect from "./SearchProviderSelect.svelte";
  import Icon from "./Icon.svelte";

  type WorkflowPreview = z.infer<typeof PreviewWorkflowResultSchema>;

  let { workspace, busy, frameLanguages, onSave, onStart, onPreviewWorkflow, onStartWorkflow, onGenerateTitle, onRetry, onOpenSettings } : {
    workspace: WorkspaceState; busy: boolean;
    frameLanguages?: string[] | undefined;
    // Names a new thread from its brief when Start is clicked; there is no name field.
    onGenerateTitle?: (context: string) => Promise<string>;
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
  // A saved project keeps its model, and a new one starts on the default saved in Settings. With neither,
  // it starts on the first latest model the account offers (GPT-6.1 Sol when available).
  const startingModel = initial.scope ? initial.runConfig?.model
    : untrack(hasSavedResearchDefaults) ? defaults.model
    : preferredModel(initial.modelOptions.filter((item) => item.providerId === "openai-subscription")) ?? defaults.model;
  let researchMode = $state<ResearchMode>(initial.runConfig?.researchMode ?? "explore-market");
  let purposeOverride = $state<ExplorationPurpose | null>(null);
  // New runs always target x ideas per problem. A saved project keeps its purpose until the user follows the brief instead.
  let explorationPurpose = $derived<ExplorationPurpose>(purposeOverride ?? initial.runConfig?.explorationPurpose ?? "auto");
  const workflowVersion = 2;
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
  let selectedModelOption = $derived(nativeModelOptions.find((item) => modelRefKey(item) === modelKey));
  let selectedModelRef = $state<ModelRef>(initialModel);
  let resolvedModel = $derived(selectedModelOption ?? selectedModelRef);
  let model = $derived<ModelRef>({ providerId: resolvedModel.providerId, modelId: resolvedModel.modelId });
  let initialModelOption = initial.modelOptions.find((item) => sameModelRef(item, initialModel));
  let reasoningEffort = $state((initial.scope ? initial.runConfig?.reasoningEffort : defaults.reasoningEffort)
    ?? initialModelOption?.defaultReasoningEffort
    ?? "");
  let discoveryDepth = $state(initial.scope ? initial.runConfig?.discoveryDepth ?? DEFAULT_RUN_CONFIG.discoveryDepth : defaults.discoveryDepth);
  let searchProvider = $state<SearchProviderChoice>(initial.scope ? initial.runConfig?.searchProvider ?? defaults.searchProvider : defaults.searchProvider);
  let searchProviderTouched = $state(false);
  // A provider saved in Settings stays chosen while it is connected. Without one, a new project uses both when it can.
  const savedSearchProvider = untrack(hasSavedResearchDefaults);
  $effect(() => {
    if (initial.scope || searchProviderTouched) return;
    if (!savedSearchProvider && workspace.validation.exa.valid && workspace.validation.perplexity.valid) { searchProvider = "auto"; return; }
    if (searchProvider === "auto" || workspace.validation[searchProvider].valid) return;
    const available = searchProvider === "exa" ? "perplexity" : "exa";
    if (workspace.validation[available].valid) searchProvider = available;
  });
  let maxRunMinutes = $state(initial.runConfig?.maxRunMinutes ?? DEFAULT_RUN_CONFIG.maxRunMinutes);
  // "babysit" is the stored identifier of the mode users see as Controlled (see WorkflowModeSchema).
  let workflowMode = $state<"babysit" | "vibe">("vibe");
  const initialIdeasModel = defaults.ideasModel ?? initialModel;
  const initialIdeasModelOption = initial.modelOptions.find((item) => sameModelRef(item, initialIdeasModel));
  let ideaModelKey = $state(modelRefKey(initialIdeasModel));
  let ideaModelOption = $derived(nativeModelOptions.find((item) => modelRefKey(item) === ideaModelKey));
  let selectedIdeasModelRef = $state<ModelRef>(initialIdeasModel);
  let ideaModel = $derived<ModelRef>({
    providerId: ideaModelOption?.providerId ?? selectedIdeasModelRef.providerId,
    modelId: ideaModelOption?.modelId ?? selectedIdeasModelRef.modelId,
  });
  let ideaReasoningEffort = $state(defaults.ideasReasoningEffort
    ?? initialIdeasModelOption?.defaultReasoningEffort
    ?? "");
  /** Empty means every qualifying problem is developed. */
  let automaticProblemCap = $state<number | null>(null);
  const initialProjection = untrack(() => framedDiscoveryProjection(discoveryDepth, frameLanguages?.length ?? 3));
  let workflowModelLimit = $state(initialProjection.modelCalls * 2 + 12);
  let workflowSearchLimit = $state(initialProjection.searches + 2);
  let workflowModelLimitTouched = $state(false);
  let workflowSearchLimitTouched = $state(false);
  let discoveryReservation = $derived(researchMode === "known-problem"
    ? { modelCalls: 2, searches: 0 }
    : { modelCalls: framedDiscoveryProjection(discoveryDepth, frameLanguages?.length ?? 3).modelCalls * 2,
      searches: framedDiscoveryProjection(discoveryDepth, frameLanguages?.length ?? 3).searches });
  let researchInstruction = $state("");
  let ideasInstruction = $state("");
  let reviewInstruction = $state("");
  let workflowPreview = $state<WorkflowPreview | null>(null);
  let previewFingerprint = $state<string | null>(null);
  let previewing = $state(false);
  let previewAttempt = $state(0);
  let previewError = $state<string | null>(null);
  let reasoningDescription = $derived(selectedModelOption?.reasoningEfforts.find((item) => item.id === reasoningEffort)?.description ?? "Controls how deeply the model reasons.");
  let validationAttempted = $state(false);
  let submitting = $state(false);
  let draftFingerprint = $derived(JSON.stringify({
    researchMode, title: title.trim(), audience: audience.trim(), domain: domain.trim(), observations: observations.trim(),
    offLimits: offLimits.split("\n").map((item) => item.trim()).filter(Boolean), knownProblem: knownProblem.trim(),
    model, reasoningEffort, discoveryDepth, searchProvider, maxRunMinutes, workflowVersion, explorationPurpose,
    riskEvaluationCriteria: riskEvaluationCriteria.trim(), ideaCount,
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
  let selectedSearchValidation = $derived(searchProvider === "auto"
    ? workspace.validation.perplexity.valid ? workspace.validation.perplexity : workspace.validation.exa
    : workspace.validation[searchProvider]);
  let selectedSearchName = $derived(searchProvider === "auto" ? "Exa or Perplexity" : searchProvider === "exa" ? "Exa" : "Perplexity");
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
  let missing = $derived(missingFields());
  // Field errors stay hidden until the first Start attempt, so an empty draft is never shown as wrong.
  let errors = $derived(validationAttempted ? missing : {});
  let ideaModelAvailable = $derived(Boolean(ideaModelOption) && workspace.models.some((item) => sameModelRef(item, ideaModel)));
  let ideaReasoningAvailable = $derived(ideaModelOption?.reasoningEfforts.some((item) => item.id === ideaReasoningEffort) ?? false);
  let workflowDraft = $derived(buildWorkflowDraft());
  let workflowFingerprint = $derived(JSON.stringify(workflowDraft));

  $effect(() => {
    if (!reasoningEffort && selectedModelOption) reasoningEffort = selectedModelOption.defaultReasoningEffort;
    if (!ideaReasoningEffort && ideaModelOption) ideaReasoningEffort = ideaModelOption.defaultReasoningEffort;
  });

  $effect(() => {
    if (!workflowModelLimitTouched) workflowModelLimit = discoveryReservation.modelCalls + 12;
    if (!workflowSearchLimitTouched) workflowSearchLimit = discoveryReservation.searches + (researchMode === "known-problem" ? 0 : 2);
  });

  $effect(() => {
    const fingerprint = workflowFingerprint;
    const attempt = previewAttempt;
    const draft = workflowDraft;
    workflowPreview = null;
    previewFingerprint = null;
    previewError = null;
    if (!useWorkflow || !onPreviewWorkflow || !providersReady || Object.keys(missing).length > 0
      || (workflowMode === "vibe" && (!ideaModelAvailable || !ideaReasoningAvailable))) return;
    const timer = setTimeout(() => {
      previewing = true;
      void onPreviewWorkflow(draft).then((result) => {
        if (fingerprint !== untrack(() => workflowFingerprint) || attempt !== untrack(() => previewAttempt)) return;
        workflowPreview = result;
        previewFingerprint = fingerprint;
        previewError = null;
      }).catch((cause: unknown) => {
        if (fingerprint !== untrack(() => workflowFingerprint) || attempt !== untrack(() => previewAttempt)) return;
        previewError = cause instanceof Error ? cause.message : "Could not check this launch plan.";
      }).finally(() => {
        if (fingerprint === untrack(() => workflowFingerprint) && attempt === untrack(() => previewAttempt)) previewing = false;
      });
    }, 300);
    return () => clearTimeout(timer);
  });

  function selectModel(key: string) {
    const selected = workspace.modelOptions.find((item) => modelRefKey(item) === key);
    if (selected) selectedModelRef = { providerId: selected.providerId, modelId: selected.modelId };
    reasoningEffort = selected?.defaultReasoningEffort ?? DEFAULT_RUN_CONFIG.reasoningEffort;
  }

  function selectIdeaModel(key: string) {
    const selected = workspace.modelOptions.find((item) => modelRefKey(item) === key);
    if (selected) selectedIdeasModelRef = { providerId: selected.providerId, modelId: selected.modelId };
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
      configVersion: 2, workflowVersion, ideaCount: ideaCount ?? DEFAULT_IDEA_COUNT,
      model, reasoningEffort, discoveryDepth, searchProvider, maxRunMinutes,
      researchMode, knownProblem: knownProblem.trim(), explorationPurpose,
    };
    return {
      contractVersion: 1, frameWorkflowVersion: 1, purpose: researchMode === "known-problem" ? "known-problem" : "discovery",
      mode: workflowMode, brief, scope, runConfig,
      ...(workflowMode === "vibe" ? { ideas: { model: ideaModel, reasoningEffort: ideaReasoningEffort,
        reviewModel: ideaModel, reviewReasoningEffort: ideaReasoningEffort } } : {}),
      targets: {
        kind: "per-problem",
        ideaCount: ideaCount ?? DEFAULT_IDEA_COUNT,
        ...(workflowMode === "vibe" && researchMode === "explore-market" && automaticProblemCap !== null ? { automaticProblemCap } : {}),
      },
      limits: { enforced: false, maxMinutes: maxRunMinutes, maxModelCalls: workflowModelLimit, maxSearches: workflowSearchLimit },
      instructions: { research: researchInstruction.trim(), ideas: ideasInstruction.trim(), review: reviewInstruction.trim() },
    };
  }

  function isValidationPending(error: string | undefined): boolean {
    return error?.startsWith("Checking ") === true || error === "Native runtime is starting";
  }

  // Provider errors usually name the provider already ("Exa key missing"), so the prefix is added only when it would not repeat.
  let searchStatus = $derived.by(() => {
    const status = selectedSearchValidation.valid ? "Connected" : selectedSearchValidation.error ?? "Connection unavailable";
    return status.startsWith(selectedSearchName) ? status : `${selectedSearchName}: ${status}`;
  });

  let visiblePreviewIssues = $derived(validationAttempted ? (workflowPreview?.fieldErrors ?? []) : []);
  // Ideas settings live in the run panel, so any preview issue under "ideas" (model or review model) is shown there.
  let ideasPreviewIssue = $derived(visiblePreviewIssues.find((issue) => issue.path[0] === "ideas")?.message ?? null);

  function missingFields(): Record<string, string> {
    const next: Record<string, string> = {};
    if (!Number.isInteger(ideaCount) || ideaCount === undefined || ideaCount < 1 || ideaCount > MAX_IDEAS_PER_PROBLEM) {
      next.ideaCount = `Choose a whole number from 1 to ${MAX_IDEAS_PER_PROBLEM}.`;
    }
    if (researchMode === "explore-market") {
      if (!domain.trim()) next.domain = "A starting context is required.";
    } else if (!knownProblem.trim()) next.knownProblem = "Problem statement is required.";
    if (useWorkflow) {
      if (workflowMode === "vibe") {
        if (!ideaModelAvailable) next.ideaModel = "Choose an available ideas model.";
        else if (!ideaReasoningAvailable) next.ideaReasoning = "Choose an available reasoning effort for ideas.";
        if (researchMode === "explore-market" && automaticProblemCap !== null
          && (!Number.isInteger(automaticProblemCap) || automaticProblemCap < 1 || automaticProblemCap > 20)) next.automaticProblemCap = "Choose 1 to 20 problems, or leave it empty for all.";
      }
    }
    return next;
  }

  async function saveAndStart() {
    if (locked || !providersReady) return;
    validationAttempted = true;
    if (Object.keys(missing).length > 0) { await revealBlockingField(); return; }
    submitting = true;
    try {
      if (useWorkflow && onPreviewWorkflow && onStartWorkflow) {
        // The title is part of the previewed launch contract, so a new thread is named before the final preview.
        if (!title.trim() && onGenerateTitle) {
          title = await onGenerateTitle([knownProblem, domain, audience, observations].map((value) => value.trim()).filter(Boolean).join("\n"));
        }
        const fingerprint = workflowFingerprint;
        let preview = workflowPreview;
        if (!preview || previewFingerprint !== fingerprint || Date.now() >= Date.parse(preview.expiresAt)) {
          preview = await onPreviewWorkflow(workflowDraft);
          if (fingerprint !== untrack(() => workflowFingerprint)) return;
          workflowPreview = preview;
          previewFingerprint = fingerprint;
        }
        if (preview.type !== "launch" || preview.fieldErrors.length > 0) { await revealBlockingField(); return; }
        await onStartWorkflow(preview);
        return;
      }
      const submittedFingerprint = draftFingerprint;
      await onSave({
        title: title.trim(), audience: audience.trim(), domain: domain.trim(), observations: observations.trim(),
        riskEvaluationCriteria: riskEvaluationCriteria.trim(),
        offLimits: offLimits.split("\n").map((item) => item.trim()).filter(Boolean),
      }, {
        configVersion: 2, workflowVersion, ideaCount, model, reasoningEffort,
        discoveryDepth, searchProvider, maxRunMinutes, researchMode, knownProblem: knownProblem.trim(),
        explorationPurpose,
      });
      savedFingerprint = submittedFingerprint;
      await onStart();
    } catch {
      // App owns the visible error; keep the submit promise handled locally.
    } finally {
      submitting = false;
    }
  }

  type SettingsSection = "instructions" | "limits";
  let configuration: HTMLDialogElement;
  let setupForm: HTMLFormElement;
  let configurationTrigger: HTMLElement | null = null;
  let settingsSection = $state<SettingsSection>("limits");
  let instructionStage = $state<"research" | "ideas" | "review">("research");
  let modeHelp = $state<"vibe" | "babysit" | null>(null);
  let advancedSettingsButton: HTMLButtonElement;

  function hideModeHelpOnLeave(event: MouseEvent) {
    if (!(event.currentTarget as HTMLElement).contains(document.activeElement)) modeHelp = null;
  }

  function dismissModeHelp(event: KeyboardEvent) {
    if (event.key !== "Escape" || !modeHelp) return;
    modeHelp = null;
    event.stopPropagation();
  }

  // The trigger may unmount once its issue is fixed, so fall back to the Advanced settings button.
  function restoreConfigurationFocus() {
    const trigger = configurationTrigger?.isConnected && configurationTrigger !== document.body ? configurationTrigger : advancedSettingsButton;
    trigger?.focus({ preventScroll: true });
  }
  const fieldSections: Record<string, SettingsSection | "brief" | "main"> = {
    domain: "brief", knownProblem: "brief", researchMode: "brief",
    model: "main", reasoning: "main", searchProvider: "main", ideaCount: "main", ideaModel: "main", ideaReasoning: "main",
    maxRunMinutes: "limits", workflowModelLimit: "limits", workflowSearchLimit: "limits", automaticProblemCap: "limits",
  };
  const previewFields: Record<string, string> = {
    "runConfig.model": "model", "runConfig.searchProvider": "searchProvider",
    "runConfig.researchMode": "researchMode", "runConfig.knownProblem": "knownProblem", purpose: "researchMode",
    ideas: "ideaModel", "ideas.model": "ideaModel", "ideas.reviewModel": "ideaModel", "ideas.reasoningEffort": "ideaReasoning",
    "limits.maxModelCalls": "workflowModelLimit",
    "limits.maxSearches": "workflowSearchLimit", "limits.maxMinutes": "maxRunMinutes",
  };
  let customInstructionCount = $derived([researchInstruction, ideasInstruction, reviewInstruction].filter((value) => value.trim()).length);
  let configurationIssues = $derived(Object.keys(errors).filter((key) => !["domain", "knownProblem"].includes(key)).length
    + visiblePreviewIssues.length + Number(modelChoiceRequired) + Number(reasoningChoiceRequired));
  let blockingMessage = $derived.by(() => {
    if (!providersReady) return connectionsChecking ? "Checking connections…" : connectionNeedsAttention ? "Connect the required providers to start." : modelChoiceRequired ? "Choose an available model to start." : "Choose an available reasoning effort to start.";
    const firstField = Object.keys(missing)[0];
    if (firstField) return firstField === "domain" ? null
      : firstField === "knownProblem" ? null : missing[firstField];
    if (validationAttempted && previewError) return previewError;
    const previewFieldError = visiblePreviewIssues[0];
    if (previewFieldError) return previewFieldError.message;
    if (useWorkflow && !workflowPreview && !previewError) return "Checking the launch plan…";
    return null;
  });

  async function showConfiguration(section: SettingsSection = "limits", field?: HTMLElement) {
    settingsSection = section;
    if (!configuration.open) {
      configurationTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      configuration.showModal();
    }
    await tick();
    (field ?? configuration.querySelector<HTMLElement>(".settings-panel:not([inert]) :is(input, select, textarea):not([hidden])"))?.focus();
  }

  // Reveal and focus a blocked field even when its settings or disclosure are closed.
  async function revealBlockingField() {
    validationAttempted = true;
    let key = modelChoiceRequired ? "model" : reasoningChoiceRequired ? "reasoning" : Object.keys(missing)[0];
    const previewField = visiblePreviewIssues[0];
    if (!key && previewField) {
      const issue = previewField.path.join(".");
      key = previewFields[issue];
    }
    const section = key ? fieldSections[key] : undefined;
    await tick();
    const field = key ? setupForm.querySelector<HTMLElement>(`[data-field="${key}"]`) : null;
    if (section === "brief" || section === "main") {
      field?.focus();
      field?.scrollIntoView?.({ block: "nearest" });
    } else {
      await showConfiguration(section ?? "limits", field ?? (modelChoiceRequired ? setupForm.querySelector<HTMLElement>('[data-field="model"]') ?? undefined : undefined));
    }
  }
</script>

<svelte:window onkeydown={dismissModeHelp} />

<section class="scope-page">
  <form bind:this={setupForm} novalidate onsubmit={(event) => { event.preventDefault(); void saveAndStart(); }}>
    <div class="setup-scroll">
      <div class="setup-body">
        <fieldset class="choice-group mode-picker">
          <legend>Starting point</legend>
          <label class:active={researchMode === "explore-market"}><input data-field="researchMode" type="radio" name="research-mode" value="explore-market" checked={researchMode === "explore-market"} onchange={() => researchMode = "explore-market"} /><span>Find problems to solve</span></label>
          <label class:active={researchMode === "known-problem"}><input type="radio" name="research-mode" value="known-problem" checked={researchMode === "known-problem"} onchange={() => researchMode = "known-problem"} /><span>I have a problem to solve</span></label>
        </fieldset>
        <section class="brief-panel" aria-label="Research brief">
          {#if researchMode === "known-problem"}
            <label class="main-brief"><span>What problem do you want to solve?</span><textarea data-field="knownProblem" bind:value={knownProblem} aria-invalid={Boolean(errors.knownProblem)} aria-describedby={errors.knownProblem ? "known-problem-error" : undefined} rows="3" placeholder="Describe the problem."></textarea>{#if errors.knownProblem}<small id="known-problem-error" class="field-error">{errors.knownProblem}</small>{/if}</label>
          {:else}
            <label class="main-brief"><span>What do you want to explore?</span><textarea data-field="domain" bind:value={domain} aria-invalid={Boolean(errors.domain)} aria-describedby={errors.domain ? "domain-error" : undefined} rows="3" placeholder="Your topic or idea"></textarea>{#if errors.domain}<small id="domain-error" class="field-error">{errors.domain}</small>{/if}</label>
          {/if}
          <!-- "Optional" is a visual hint; aria-label keeps each field's name free of it for assistive tech and tests. -->
          <label class="audience-field"><span>Audience <small>Optional</small></span><input aria-label="Audience" bind:value={audience} placeholder={researchMode === "explore-market" ? "Who is this for?" : "Who is affected?"} /></label>
        </section>
        <div class="context-fields">
              {#if researchMode === "known-problem"}<label><span>Market or domain <small>Optional</small></span><textarea aria-label="Market or domain" data-field="domain" bind:value={domain} rows="2" placeholder="Market or field"></textarea></label>{/if}
              <label><span>Risk priorities</span><textarea bind:value={riskEvaluationCriteria} maxlength="4000" rows="2" placeholder="What matters most: time, budget, or other limits?"></textarea></label>
              <label><span>{researchMode === "explore-market" ? "Anything else to consider" : "Context"}</span><textarea bind:value={observations} rows="2" placeholder="Useful background"></textarea></label>
              <label><span>Boundaries</span><textarea bind:value={offLimits} rows="2" placeholder="What should solutions avoid? One limit per line."></textarea></label>
        </div>
        {#if explorationPurpose !== "auto"}
        <p class="saved-purpose-note">This saved project asks for {explorationPurpose === "startup-opportunities" ? "startup opportunities" : "practical solutions"}. <button type="button" onclick={() => purposeOverride = "auto"}>Follow the brief instead</button></p>
      {/if}

      </div>
    </div>
    <aside class="launch-sidebar glass" aria-label="Run setup">
        {#if useWorkflow}
          <fieldset class="choice-group workflow-mode">
            <legend>Run mode</legend>
            <div class="mode-option" class:active={workflowMode === "vibe"}>
              <label><input type="radio" name="workflow-mode" value="vibe" checked={workflowMode === "vibe"} onchange={() => workflowMode = "vibe"} /><strong>Vibe</strong></label>
              <span class="mode-info" role="presentation" onmouseenter={() => modeHelp = "vibe"} onmouseleave={hideModeHelpOnLeave} onfocusin={() => modeHelp = "vibe"} onfocusout={() => modeHelp = null}>
                <button type="button" class="info-button" aria-label="About Vibe" aria-describedby="vibe-help" onclick={() => modeHelp = "vibe"} onkeydown={dismissModeHelp}><Icon name="info" size={16} /></button>
                <span id="vibe-help" class="mode-tooltip glass-dense" role="tooltip" hidden={modeHelp !== "vibe"}>{researchMode === "known-problem" ? "Scraply generates and reviews ideas for your stated problem automatically." : "Scraply researches your brief, selects problems, generates ideas, and reviews them automatically."} You can pause or stop at any time. Review the results when the run ends.</span>
              </span>
            </div>
            <div class="mode-option" class:active={workflowMode === "babysit"}>
              <label><input type="radio" name="workflow-mode" value="babysit" checked={workflowMode === "babysit"} onchange={() => workflowMode = "babysit"} /><strong>Controlled</strong></label>
              <span class="mode-info" role="presentation" onmouseenter={() => modeHelp = "babysit"} onmouseleave={hideModeHelpOnLeave} onfocusin={() => modeHelp = "babysit"} onfocusout={() => modeHelp = null}>
                <button type="button" class="info-button" aria-label="About Controlled" aria-describedby="controlled-help" onclick={() => modeHelp = "babysit"} onkeydown={dismissModeHelp}><Icon name="info" size={16} /></button>
                <span id="controlled-help" class="mode-tooltip glass-dense" role="tooltip" hidden={modeHelp !== "babysit"}>{researchMode === "known-problem" ? "Scraply prepares a frame for your stated problem, then pauses for your review." : "Scraply frames your brief and pauses for approval before research. After research, you choose which problems become ideas."} You control when idea generation begins.</span>
              </span>
            </div>
          </fieldset>
        {/if}
      <section class="main-settings" aria-label="Main research settings">
        <div class="main-settings-grid">
      {#if researchMode === "explore-market"}
        <label class="run-setting search-setting model-setting">
          <span>Search provider</span>
          <SearchProviderSelect bind:value={searchProvider} connected={{ exa: workspace.validation.exa.valid, perplexity: workspace.validation.perplexity.valid }} onchange={() => searchProviderTouched = true} />
          <small>{searchStatus}</small>
          {#each visiblePreviewIssues.filter((issue) => issue.path.join(".") === "runConfig.searchProvider") as issue (issue.code)}<small class="field-error" role="alert">{issue.message}</small>{/each}
        </label>
      {/if}
      <label class="run-setting model-setting"><span>Model</span><ModelPicker label="Model" field="model" options={nativeModelOptions} bind:value={modelKey} onchange={selectModel} disabled={nativeModelOptions.length === 0}
        missingLabel={legacyModelNeedsReplacement && !modelKey ? "Choose an OpenAI model" : workspace.validation.native.connected ? `${modelDisplayName(model)} (unavailable)` : "Sign in to choose"} /></label>
      <label class="run-setting"><span>Reasoning</span><select aria-label="Reasoning" data-field="reasoning" title={reasoningDescription} bind:value={reasoningEffort}>{#if !selectedReasoningAvailable}<option value={reasoningEffort}>{reasoningEffort} (unavailable)</option>{/if}{#each (selectedModelOption?.reasoningEfforts ?? []) as effort (effort.id)}<option value={effort.id}>{effort.id.charAt(0).toUpperCase() + effort.id.slice(1)}</option>{/each}</select></label>
      {#if researchMode === "explore-market"}<label class="run-setting"><span>Research depth</span><select aria-label="Research depth" bind:value={discoveryDepth}><option value="quick">Quick</option><option value="standard">Standard</option><option value="deep">Deep</option></select></label>{/if}
      <!-- A stated problem has no research depth, so the count takes that grid cell instead of its own row. -->
      <div class="solution-count" class:paired={researchMode === "known-problem"}>
        <label for="solution-count">{researchMode === "known-problem" ? "Solutions" : "Solutions per problem"}</label>
        <div class="count-input">
          <input id="solution-count" aria-label="Solutions per problem" data-field="ideaCount" type="number" bind:value={ideaCount} min="1" max={MAX_IDEAS_PER_PROBLEM} step="1" required aria-invalid={Boolean(errors.ideaCount)} aria-describedby={errors.ideaCount ? "idea-count-error" : undefined} />

        </div>
        {#if errors.ideaCount}<small id="idea-count-error" class="field-error">{errors.ideaCount}</small>{/if}
      </div>
      <!-- Vibe generates and reviews ideas itself, so their model is chosen up front; Controlled picks it when developing problems. -->
      {#if useWorkflow && workflowMode === "vibe"}
        <label class="run-setting"><span>Ideas model</span><ModelPicker label="Ideas model" field="ideaModel" options={nativeModelOptions} bind:value={ideaModelKey} onchange={selectIdeaModel}
          invalid={Boolean(errors.ideaModel || ideasPreviewIssue)} missingLabel={`${modelDisplayName(ideaModel)} (unavailable)`} /></label>
        <label class="run-setting"><span>Ideas reasoning</span><select aria-label="Ideas reasoning" data-field="ideaReasoning" bind:value={ideaReasoningEffort} aria-invalid={Boolean(errors.ideaReasoning)}>
          {#if !ideaReasoningAvailable}<option value={ideaReasoningEffort}>{ideaReasoningEffort} (unavailable)</option>{/if}
          {#each (ideaModelOption?.reasoningEfforts ?? []) as effort (effort.id)}<option value={effort.id}>{effort.id.charAt(0).toUpperCase() + effort.id.slice(1)}</option>{/each}
        </select></label>
        {#if errors.ideaModel || ideasPreviewIssue}<small class="field-error wide" role="alert">{errors.ideaModel ?? ideasPreviewIssue}</small>{/if}
        {#if errors.ideaReasoning}<small class="field-error wide">{errors.ideaReasoning}</small>{/if}
      {/if}

        </div>
          {#if modelChoiceRequired}<p class="field-error">{legacyModelNeedsReplacement ? "This project used the removed CLI integration." : "The saved model is unavailable."} Choose an available OpenAI model.</p>{/if}
          {#if reasoningChoiceRequired}<p class="field-error">The saved reasoning effort is unavailable for this model. Choose an available effort to start a new run.</p>{/if}
        {#if customInstructionCount}<p class="override-note">{customInstructionCount} custom {customInstructionCount === 1 ? "instruction" : "instructions"}</p>{/if}
        <button type="button" class="text-action" bind:this={advancedSettingsButton} onclick={() => showConfiguration()}>Advanced settings <Icon name="settings" size={16} /></button>
      </section>
      <div class="launch-content">
        <div class="launch-row">
          <!-- Stays clickable while the brief is incomplete: the click is what reveals the missing fields. -->
          <button type="submit" class="primary" disabled={locked || !providersReady || (useWorkflow && previewing)}>{locked ? "Starting…" : useWorkflow ? "Start" : (researchMode === "explore-market" ? "Discover problems" : "Generate solutions")}<Icon name="arrow" size={17} /></button>
        </div>
        <div class="launch-status" role="status">
          {#if blockingMessage}<span>{blockingMessage}</span>{/if}
          {#if configurationIssues}<button type="button" class="text-action" onclick={revealBlockingField}>{modelChoiceRequired ? "Choose model" : "Review settings"}</button>{/if}
          {#if validationAttempted && previewError}<button type="button" class="text-action" onclick={() => previewAttempt += 1}>Retry preview</button>{/if}
          {#if saved}<span>Saved</span>{/if}
        </div>
        {#if connectionNeedsAttention}
          <div class="connection-warning">
            {#if modelStatus}<span>{modelStatus}</span>{/if}
            {#if researchMode === "explore-market" && !selectedSearchValidation.valid}<span>{searchStatus}</span>{/if}
            {#if onOpenSettings}<button type="button" class="text-action" onclick={onOpenSettings}>Open settings</button>{/if}
            <button type="button" class="text-action" disabled={locked || connectionsChecking} onclick={() => onRetry()}>{connectionsChecking ? "Checking…" : "Retry connections"}</button>
          </div>
        {/if}
      </div>
    </aside>
    <dialog bind:this={configuration} class="settings-dialog glass-dense" aria-label="Advanced settings" onclose={restoreConfigurationFocus} onkeydown={(event) => { if (event.key === "Enter" && event.target instanceof HTMLInputElement) event.preventDefault(); }}>
      <header><h2>Advanced settings</h2><button type="button" aria-label="Close advanced settings" onclick={() => configuration.close()}><Icon name="close" /></button></header>
      <nav aria-label="Settings groups">
        <button type="button" aria-pressed={settingsSection === "limits"} onclick={() => settingsSection = "limits"}>Research scope</button>
        {#if useWorkflow}<button type="button" aria-pressed={settingsSection === "instructions"} onclick={() => settingsSection = "instructions"}>Instructions</button>{/if}
      </nav>
      <div class="settings-content">
        {#each visiblePreviewIssues.filter((issue) => issue.path[0] !== "limits" && issue.path[0] !== "ideas") as issue (issue.path.join(".") + issue.code)}<p class="field-error" role="alert">{issue.message}</p>{/each}
        <div class="settings-panels">
        <section class="settings-panel" aria-label="Research scope configuration" inert={settingsSection !== "limits"}>
          {#if useWorkflow && workflowMode === "vibe" && researchMode === "explore-market"}<label><span>Problems to develop</span><input aria-label="Automatic problem cap" data-field="automaticProblemCap" type="number" min="1" max="20" step="1" placeholder="All qualifying" bind:value={automaticProblemCap} aria-invalid={Boolean(errors.automaticProblemCap)} />{#if errors.automaticProblemCap}<small class="field-error">{errors.automaticProblemCap}</small>{/if}</label>{/if}
        </section>
        <section class="settings-panel instructions-panel" aria-label="Custom instructions" inert={settingsSection !== "instructions"}>
          <!-- One editor per stage keeps this tab as short as the others; the dot marks stages that have text. -->
          <div class="instruction-stages" role="group" aria-label="Instruction stage">
            {#each [["research", "Research", researchInstruction], ["ideas", "Ideas", ideasInstruction], ["review", "Review", reviewInstruction]] as const as [stage, label, value] (stage)}
              <button type="button" aria-pressed={instructionStage === stage} onclick={() => instructionStage = stage}>{label}{#if value.trim()}<span class="filled-dot" aria-hidden="true"></span>{/if}</button>
            {/each}
          </div>
          <textarea aria-label="Research instructions" hidden={instructionStage !== "research"} bind:value={researchInstruction} maxlength="20000" placeholder="Optional context for research"></textarea>
          <textarea aria-label="Ideas instructions" hidden={instructionStage !== "ideas"} bind:value={ideasInstruction} maxlength="20000" placeholder="Optional context for generation"></textarea>
          <textarea aria-label="Review instructions" hidden={instructionStage !== "review"} bind:value={reviewInstruction} maxlength="20000" placeholder="Optional context for review"></textarea>
        </section>
        </div>
      </div>
      <div class="dialog-footer"><button type="button" onclick={() => configuration.close()}>Done</button></div>
    </dialog>
  </form>
</section>

<style>
  .scope-page,form { height:100%;min-height:0; }
  /* The launch panel grows a little with the page so its paired selects keep readable labels. */
  /* The brief is centred in the space beside the launch panel, which stays docked at the page's right edge. */
  form { display:grid;grid-template-columns:minmax(0,1fr) clamp(300px,26cqi,344px); }
  .setup-scroll { flex:1;min-height:0;overflow:auto;scroll-padding-block:24px; }
  .setup-body { width:min(100%,880px);margin-inline:auto;padding:28px 32px;display:grid;gap:24px; }
  .context-fields { display:grid;grid-template-columns:1fr 1fr;gap:20px; }
  .context-fields { padding-top:4px; }
  .context-fields > :last-child:nth-child(odd) { grid-column:1/-1; }
  label { display:grid;gap:8px;min-width:0;font-size:14px; }
  label > span { font-weight:500; }
  input,select,textarea { width:100%;min-width:0;min-height:42px;padding:9px 12px;border:1px solid var(--border-strong);border-radius:7px;color:var(--text);background:var(--surface);font-size:14px; }
  textarea { line-height:1.65; }
  small { color:var(--muted);font-size:13px;font-weight:400;line-height:1.5; }
  label > span > small { margin-left:6px; }
  .field-error { color:var(--danger);font-size:13px; }
  input[aria-invalid="true"],textarea[aria-invalid="true"],select[aria-invalid="true"] { border-color:var(--danger); }
  fieldset { min-width:0;border:0;padding:0;margin:0; }
  .choice-group { display:grid;gap:6px; }
  .choice-group legend { margin-bottom:6px;font-size:13px;color:var(--muted); }
  .choice-group label { display:flex;align-items:center;gap:10px;padding:10px 12px;min-height:42px;border:1px solid transparent;border-radius:7px;cursor:pointer; }
  .choice-group label:hover { background:var(--surface-2); }
  /* A run mode row is its label plus the info button, so hover paints the whole row, matching the selected outline. */
  .mode-option label:hover { background:transparent; }
  .mode-option:hover:not(.active) { background:var(--surface-2); }
  .choice-group label.active { background:rgb(255 255 255 / .06);border-color:rgb(255 255 255 / .16); }
  .choice-group input { appearance:none;flex:none;width:16px;height:16px;min-height:0;margin:0;padding:0;border:1px solid var(--subtle);border-radius:50%;background:transparent; }
  .choice-group input:checked { border:5px solid var(--accent); }
  /* The radio itself is small, so its keyboard ring outlines the whole choice row in the shared ring colour. */
  .choice-group label:has(input:focus-visible) { outline:2px solid var(--focus-ring);outline-offset:2px; }
  .choice-group input:focus-visible { outline:none; }
  .choice-group label > span { display:flex;align-items:baseline;gap:12px;font-size:14px;font-weight:500; }
  .choice-group strong { font-size:14px;font-weight:600;min-width:58px; }
  .mode-picker { grid-template-columns:1fr 1fr; }
  .workflow-mode { gap:4px; }
  .mode-option { position:relative;display:flex;align-items:center;justify-content:space-between;border:1px solid transparent;border-radius:7px; }
  .mode-option.active { background:rgb(255 255 255 / .06);border-color:rgb(255 255 255 / .16); }
  .mode-option label { flex:1;border:0; }
  .mode-info { display:flex;align-items:center;margin-right:6px; }
  .info-button { display:grid;place-items:center;width:32px;min-height:32px;padding:0;border:0;background:transparent;color:var(--muted); }
  .mode-tooltip { position:absolute;z-index:5;right:0;top:calc(100% + 6px);width:248px;max-width:calc(100vw - 48px);padding:12px 14px;border-radius:10px;background:#111212;color:var(--text);font-size:13px;line-height:1.6; }
  .mode-tooltip[hidden] { display:none; }
  .brief-panel { display:grid;gap:20px; }
  .main-brief > span { font-size:26px;line-height:1.25;letter-spacing:-.7px;font-weight:600; }
  .main-brief { gap:10px; }
  .main-brief textarea { min-height:132px;padding:10px 14px;font-size:15px; }
  .main-settings { display:grid;gap:10px;padding-top:16px;border-top:1px solid var(--border); }
  .main-settings-grid { display:grid;grid-template-columns:1fr 1fr;align-items:start;gap:12px; }
  .main-settings-grid label,.main-settings-grid .solution-count { font-size:13px;gap:6px; }
  /* A one- or two-digit count gets a compact field at the row's end instead of a wide box around a single digit. */
  .main-settings-grid .solution-count { grid-column:1/-1;grid-template-columns:1fr 72px;align-items:center; }
  .main-settings-grid .solution-count label { font-size:13px;font-weight:500;line-height:1.5; }
  .main-settings-grid .solution-count .field-error { grid-column:1/-1; }
  .main-settings-grid .solution-count.paired { grid-column:auto;grid-template-columns:1fr;align-items:stretch; }
  .main-settings-grid .wide { grid-column:1/-1; }
  .solution-count.paired .count-input input { width:100%; }
  .main-settings .text-action { justify-self:start; }
  .override-note { margin:0;font-size:13px;color:var(--accent);line-height:1.5; }
  button { min-height:36px;padding:8px 12px;border:1px solid var(--border-strong);border-radius:7px;background:var(--surface);color:var(--text);font-size:14px; }
  button:hover:not(:disabled) { background:var(--surface-2); }
  .text-action { display:inline-flex;align-items:center;justify-content:center;gap:8px;border:0;background:transparent;color:var(--accent-strong);padding:6px 0;min-height:32px;font-size:13px;text-align:left; }
  .text-action:hover:not(:disabled) { background:transparent;text-decoration:underline; }

  .saved-purpose-note { color:var(--muted);font-size:13px;line-height:1.6;margin:0; }
  .saved-purpose-note button { border:0;padding:0;color:var(--accent);background:none; }
  /* The run panel floats inside the page as its own glass card. */
  .launch-sidebar { min-height:0;overflow:auto;display:flex;flex-direction:column;gap:18px;margin:12px 12px 12px 0;padding:18px;border-radius:14px;scroll-padding-block:20px; }
  .launch-sidebar > * { flex:none; }
  .launch-content { margin-top:auto;padding-top:10px; }
  .launch-row { display:flex;flex-direction:column;align-items:stretch;gap:12px; }
  .primary { display:flex;align-items:center;justify-content:center;gap:12px;min-width:154px;min-height:44px;background:var(--accent-strong);border:0;border-radius:10px;color:var(--accent-ink);font-weight:600; }
  .primary:hover:not(:disabled) { background:var(--accent); }
  .launch-status { display:flex;align-items:center;flex-wrap:wrap;gap:4px 12px;margin-top:5px;font-size:13px;color:var(--muted);line-height:1.5; }
  .connection-warning { display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:6px;font-size:13px;color:var(--danger);align-items:center; }
  .settings-dialog { width:min(720px,calc(100vw - 32px));max-height:calc(100dvh - 32px);padding:0;margin:auto;border-radius:var(--panel-radius);color:var(--text); }
  .settings-dialog[open] { display:flex;flex-direction:column; }
  /* The close button is a corner control, so it sits closer to the edge than the content padding. */
  .settings-dialog header { display:flex;align-items:center;justify-content:space-between;padding:20px 14px 12px 24px;gap:16px; }
  .settings-dialog h2 { margin:0;font-size:22px;letter-spacing:-.5px; }
  .settings-dialog header button { width:32px;height:32px;padding:0;border:0;border-radius:8px;background:transparent;display:grid;place-items:center; }
  .settings-dialog nav { display:flex;flex-wrap:wrap;gap:4px;padding:0 24px 12px;border-bottom:1px solid var(--border); }
  .settings-dialog nav button { border:0;background:none;color:var(--muted); }
  .settings-dialog nav button:hover:not([aria-pressed="true"]) { background:none;color:var(--text); }
  .settings-dialog nav button[aria-pressed="true"] { color:var(--text);background:rgb(255 255 255 / .1); }
  .settings-content { overflow:auto;min-height:0;padding:24px;scroll-padding-block:24px; }
  /* Every tab shares one grid cell, so the dialog takes the tallest tab's height and keeps it while switching.
     Inactive tabs stay in layout but are inert and invisible. */
  .settings-panels { display:grid; }
  .settings-panel { grid-area:1/1;min-width:0; }
  .settings-panel[inert] { visibility:hidden; }
  /* The instructions editor stretches to the height the other tabs set; its minimum stays below theirs. */
  .instructions-panel { display:flex;flex-direction:column;gap:12px; }
  .instructions-panel textarea { flex:1;min-height:120px; }
  .instruction-stages { display:flex;align-self:flex-start;gap:2px;padding:3px;border:1px solid var(--border);border-radius:10px; }
  .instruction-stages button { display:flex;align-items:center;gap:6px;padding:5px 12px;border:0;border-radius:7px;background:none;color:var(--muted);font-size:13px; }
  .instruction-stages button:hover:not([aria-pressed="true"]) { color:var(--text); }
  .instruction-stages button[aria-pressed="true"] { color:var(--text);background:rgb(255 255 255 / .1); }
  .filled-dot { width:6px;height:6px;border-radius:50%;background:var(--accent-strong); }
  .model-setting,.search-setting { grid-column:1/-1; }
  .solution-count { display:grid;align-content:start;gap:8px; }
  .dialog-footer { display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 24px;border-top:1px solid var(--border);font-size:13px;color:var(--muted); }
  /* Page-width breakpoints follow the page container; the dialog rules below follow the window it floats over. */
  @container page (max-width:840px) {
    form { display:block;overflow:auto; }
    .setup-scroll { overflow:visible; }
    .launch-sidebar { overflow:visible;margin:0 20px 20px;padding:24px;display:grid;grid-template-columns:1fr 1fr;gap:24px; }
    .main-settings { border-top:0;padding-top:0; }
    .launch-content { grid-column:1/-1;margin-top:0;padding-top:0; }
  }
  @container page (max-width:560px) {
    .setup-body { padding:20px 16px;gap:20px; }.launch-sidebar { margin:0 12px 12px;padding:20px 16px;grid-template-columns:1fr; }
    .main-brief > span { font-size:24px; }.mode-picker,.context-fields { grid-template-columns:1fr; }
    .launch-row { align-items:stretch;flex-direction:column;gap:10px; }.primary { width:100%; }
  }
  @media(max-width:600px) {

    .settings-dialog header,.settings-content { padding:16px; }.settings-dialog nav { padding-inline:10px; }.dialog-footer { padding:12px 16px; }
  }
  @media(max-height:600px) { @container page (min-width:841px) { .scope-page,form { height:auto; }.setup-scroll { overflow:visible;flex:none; }.launch-sidebar { position:sticky;top:0;align-self:start;max-height:100dvh; } } }
</style>
