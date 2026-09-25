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
  import { tick, untrack } from "svelte";
  import { modelDisplayName, readResearchDefaults } from "../lib/research-defaults";
  import { discoveryRunProjection } from "../../shared/discovery-projection";
  import { allocateIdeaTargets } from "../../core/opportunity-planning";
  import type { WorkflowLaunchDraft } from "../../shared/workflow-contracts";
  import type { z } from "zod";
  import { PreviewWorkflowResultSchema } from "../../shared/workflow-contracts";
  import ProviderLogo from "./ProviderLogo.svelte";
  import Icon from "./Icon.svelte";

  type WorkflowPreview = z.infer<typeof PreviewWorkflowResultSchema>;

  let { workspace, busy, onSave, onStart, onPreviewWorkflow, onStartWorkflow, onGenerateTitle, onRetry, onOpenSettings } : {
    workspace: WorkspaceState; busy: boolean;
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
  let previewAttempt = $state(0);
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
  let missing = $derived(missingFields());
  // Field errors stay hidden until the first Start attempt, so an empty draft is never shown as wrong.
  let errors = $derived(validationAttempted ? missing : {});
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

  let visiblePreviewIssues = $derived(validationAttempted ? (workflowPreview?.fieldErrors ?? []) : []);
  function previewIssue(path: string): string | null {
    return visiblePreviewIssues.find((issue) => issue.path.join(".") === path)?.message ?? null;
  }
  // Ideas settings live in the run panel, so any preview issue under "ideas" (model or review model) is shown there.
  let ideasPreviewIssue = $derived(visiblePreviewIssues.find((issue) => issue.path[0] === "ideas")?.message ?? null);

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

  type SettingsSection = "research" | "instructions" | "limits";
  let configuration: HTMLDialogElement;
  let setupForm: HTMLFormElement;
  let configurationTrigger: HTMLElement | null = null;
  let settingsSection = $state<SettingsSection>("research");
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
  const fieldSections: Record<string, SettingsSection | "brief" | "business" | "main"> = {
    domain: "brief", knownProblem: "brief", researchMode: "brief",
    targetFamilies: "business", batchSize: "business", maxModelCalls: "business", maxSearches: "business",
    model: "main", reasoning: "main", ideaCount: "main", ideaModel: "main", ideaReasoning: "main",
    maxRunMinutes: "limits", workflowModelLimit: "limits", workflowSearchLimit: "limits", automaticProblemCap: "limits",
  };
  const previewFields: Record<string, string> = {
    "runConfig.model": "model", "runConfig.searchProvider": "searchProvider",
    "runConfig.researchMode": "researchMode", "runConfig.knownProblem": "knownProblem", purpose: "researchMode",
    ideas: "ideaModel", "ideas.model": "ideaModel", "ideas.reviewModel": "ideaModel", "ideas.reasoningEffort": "ideaReasoning",
    "targets.distinctBusinessCount": "targetFamilies", "limits.maxModelCalls": "workflowModelLimit",
    "limits.maxSearches": "workflowSearchLimit", "limits.maxMinutes": "maxRunMinutes",
  };
  let customInstructionCount = $derived([researchInstruction, ideasInstruction, reviewInstruction].filter((value) => value.trim()).length);
  let configurationIssues = $derived(Object.keys(errors).filter((key) => !["domain", "knownProblem"].includes(key)).length
    + visiblePreviewIssues.length + Number(modelChoiceRequired) + Number(reasoningChoiceRequired));
  let blockingMessage = $derived.by(() => {
    if (!providersReady) return connectionsChecking ? "Checking connections…" : connectionNeedsAttention ? "Connect the required providers to start." : modelChoiceRequired ? "Choose an available model to start." : "Choose an available reasoning effort to start.";
    const firstField = Object.keys(missing)[0];
    if (firstField) return firstField === "domain" ? "Add a topic to your brief to start."
      : firstField === "knownProblem" ? "Describe the problem to start." : missing[firstField];
    if (validationAttempted && previewError) return previewError;
    const previewFieldError = visiblePreviewIssues[0];
    if (previewFieldError) return previewFieldError.message;
    if (useWorkflow && !workflowPreview && !previewError) return "Checking the launch plan…";
    return null;
  });

  async function showConfiguration(section: SettingsSection = "research", field?: HTMLElement) {
    settingsSection = section === "research" && researchMode === "known-problem" ? "limits" : section;
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
    if (section === "business") businessTargetOpen = true;
    await tick();
    const field = key ? setupForm.querySelector<HTMLElement>(`[data-field="${key}"]`) : null;
    if (section === "brief" || section === "business" || section === "main") {
      field?.focus();
      field?.scrollIntoView?.({ block: "nearest" });
    } else {
      await showConfiguration(section ?? "research", field ?? (modelChoiceRequired ? modelSelect : undefined));
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
              {#if researchMode === "known-problem"}<label><span>Market or domain (optional)</span><textarea data-field="domain" bind:value={domain} rows="2" placeholder="Market or field"></textarea></label>{/if}
              <label><span>Risk priorities</span><textarea bind:value={riskEvaluationCriteria} maxlength="4000" rows="2" placeholder="What matters most: time, budget, or other limits?"></textarea></label>
              <label><span>{researchMode === "explore-market" ? "Anything else to consider" : "Context"}</span><textarea bind:value={observations} rows="2" placeholder="Useful background"></textarea></label>
              <label><span>Boundaries</span><textarea bind:value={offLimits} rows="2" placeholder="What should solutions avoid? One limit per line."></textarea></label>
        </div>
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
              <label><span>Distinct family target</span><input aria-label="Distinct family target" data-field="targetFamilies" type="number" min="2" max="30" step="1" bind:value={targetFamilies} aria-invalid={Boolean(errors.targetFamilies)} />{#if errors.targetFamilies}<small class="field-error">{errors.targetFamilies}</small>{/if}</label>
              <label><span>Batch size</span><select aria-label="Opportunity batch size" data-field="batchSize" bind:value={batchSize}><option value={4}>4</option><option value={5}>5</option><option value={6}>6</option></select>{#if errors.batchSize}<small class="field-error">{errors.batchSize}</small>{/if}</label>
              {#if !useWorkflow}
                <label><span>Opportunity model-call limit</span><input aria-label="Opportunity model-call limit" data-field="maxModelCalls" type="number" min="1" max="40" step="1" bind:value={maxModelCalls} aria-invalid={Boolean(errors.maxModelCalls)} />{#if errors.maxModelCalls}<small class="field-error">{errors.maxModelCalls}</small>{/if}</label>
                <label><span>Added opportunity search limit</span><input aria-label="Opportunity search limit" data-field="maxSearches" type="number" min="0" max="20" step="1" bind:value={maxSearches} aria-invalid={Boolean(errors.maxSearches)} />{#if errors.maxSearches}<small class="field-error">{errors.maxSearches}</small>{/if}</label>
              {/if}
            </div>
            <p>Similar ideas count as one business. Up to 2 expansion rounds and {Math.min(60, targetFamilies * 2)} candidates.{#if useWorkflow}&nbsp;Work limits cover research, ideas, review, and added searches.{/if}</p>
            <label class="exploratory-toggle"><input type="checkbox" bind:checked={allowExploratoryProblems} /><span><strong>Allow exploratory problem hypotheses</strong><small>Use only after the researched map is exhausted. Scraply labels these permanently and does not invent evidence for them.</small></span></label>
          {/if}
        </section>
      </details>

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
                <span id="vibe-help" class="mode-tooltip glass-dense" role="tooltip" hidden={modeHelp !== "vibe"}>{researchMode === "known-problem" ? "Scraply generates and reviews ideas for your stated problem automatically." : "Scraply researches your brief, selects problems, generates ideas, and reviews them automatically."} Work stops at your saved limits. Review the results when the run ends.</span>
              </span>
            </div>
            <div class="mode-option" class:active={workflowMode === "babysit"}>
              <label><input type="radio" name="workflow-mode" value="babysit" checked={workflowMode === "babysit"} onchange={() => workflowMode = "babysit"} /><strong>Babysit</strong></label>
              <span class="mode-info" role="presentation" onmouseenter={() => modeHelp = "babysit"} onmouseleave={hideModeHelpOnLeave} onfocusin={() => modeHelp = "babysit"} onfocusout={() => modeHelp = null}>
                <button type="button" class="info-button" aria-label="About Babysit" aria-describedby="babysit-help" onclick={() => modeHelp = "babysit"} onkeydown={dismissModeHelp}><Icon name="info" size={16} /></button>
                <span id="babysit-help" class="mode-tooltip glass-dense" role="tooltip" hidden={modeHelp !== "babysit"}>{researchMode === "known-problem" ? "Scraply uses your stated problem, then waits for you to choose the next step." : "Scraply researches your brief, then pauses so you can review the problems and choose which ones become ideas."} You control when idea generation begins.</span>
              </span>
            </div>
          </fieldset>
        {/if}
      <section class="main-settings" aria-label="Main research settings">
        <div class="main-settings-grid">
      <label class="run-setting model-setting"><span>Model</span><select aria-label="Model" data-field="model" bind:this={modelSelect} bind:value={modelKey} onchange={selectModel} disabled={nativeModelOptions.length === 0}>{#if !selectedModelAvailable}<option value={modelKey}>{legacyModelNeedsReplacement && !modelKey ? "Choose an OpenAI model" : workspace.validation.native.connected ? `${modelDisplayName(model)} (unavailable)` : "Sign in to choose"}</option>{/if}{#each gpt6Models as modelId (modelId)}{#if !nativeModelOptions.some((item) => item.modelId === modelId) && model.modelId !== modelId}<option value={`openai-subscription:${modelId}`} disabled>{modelDisplayName({ modelId })} (not in model list)</option>{/if}{/each}{#each nativeModelOptions as item (modelRefKey(item))}<option value={modelRefKey(item)}>{modelDisplayName(item)}</option>{/each}</select>{#if nativeModelOptions.length === 0}<small>Your available models appear here after you sign in.</small>{/if}</label>
      <label class="run-setting"><span>Reasoning</span><select aria-label="Reasoning" data-field="reasoning" title={reasoningDescription} bind:value={reasoningEffort}>{#if !selectedReasoningAvailable}<option value={reasoningEffort}>{reasoningEffort} (unavailable)</option>{/if}{#each (selectedModelOption?.reasoningEfforts ?? []) as effort (effort.id)}<option value={effort.id}>{effort.id.charAt(0).toUpperCase() + effort.id.slice(1)}</option>{/each}</select></label>
      {#if researchMode === "explore-market"}<label class="run-setting"><span>Research depth</span><select aria-label="Research depth" title={depthDescription} bind:value={discoveryDepth}><option value="quick">Quick</option><option value="standard">Standard</option><option value="deep">Deep</option></select></label>{/if}
      <!-- A stated problem has no research depth, so the count takes that grid cell instead of its own row. -->
      <div class="solution-count" class:paired={researchMode === "known-problem"}>
        <label for="solution-count">{researchMode === "known-problem" ? "Solutions" : "Solutions per problem"}</label>
        <div class="count-input">
          <input id="solution-count" aria-label="Solutions per problem" data-field="ideaCount" type="number" bind:value={ideaCount} min="1" max={MAX_IDEA_COUNT} step="1" required aria-invalid={Boolean(errors.ideaCount)} aria-describedby={errors.ideaCount ? "idea-count-error" : undefined} />

        </div>
        {#if errors.ideaCount}<small id="idea-count-error" class="field-error">{errors.ideaCount}</small>{/if}
      </div>
      <!-- Vibe generates and reviews ideas itself, so their model is chosen up front; Babysit picks it when developing problems. -->
      {#if useWorkflow && workflowMode === "vibe"}
        <label class="run-setting"><span>Ideas model</span><select aria-label="Ideas model" data-field="ideaModel" bind:value={ideaModelKey} onchange={selectIdeaModel} aria-invalid={Boolean(errors.ideaModel || ideasPreviewIssue)}>
          {#if !ideaModelAvailable}<option value={ideaModelKey}>{modelDisplayName(ideaModel)} (unavailable)</option>{/if}
          {#each nativeModelOptions as option (modelRefKey(option))}<option value={modelRefKey(option)}>{modelDisplayName(option)}</option>{/each}
        </select></label>
        <label class="run-setting"><span>Ideas reasoning</span><select aria-label="Ideas reasoning" data-field="ideaReasoning" bind:value={ideaReasoningEffort} aria-invalid={Boolean(errors.ideaReasoning)}>
          {#if !ideaReasoningAvailable}<option value={ideaReasoningEffort}>{ideaReasoningEffort} (unavailable)</option>{/if}
          {#each (ideaModelOption?.reasoningEfforts ?? []) as effort (effort.id)}<option value={effort.id}>{effort.id.charAt(0).toUpperCase() + effort.id.slice(1)}</option>{/each}
        </select></label>
        {#if errors.ideaModel || ideasPreviewIssue}<small class="field-error wide" role="alert">{errors.ideaModel ?? ideasPreviewIssue}</small>{/if}
        {#if errors.ideaReasoning}<small class="field-error wide">{errors.ideaReasoning}</small>{/if}
        <small class="wide">Ideas are also reviewed with this model.</small>
      {/if}

        </div>
          {#if modelChoiceRequired}<p class="field-error">{legacyModelNeedsReplacement ? "This project used the removed CLI integration." : "The saved model is unavailable."} Choose an available OpenAI model.</p>{/if}
          {#if reasoningChoiceRequired}<p class="field-error">The saved reasoning effort is unavailable for this model. Choose an available effort to start a new run.</p>{/if}
        {#if customInstructionCount}<p class="override-note">{customInstructionCount} custom {customInstructionCount === 1 ? "instruction" : "instructions"}</p>{/if}
        <button type="button" class="text-action" bind:this={advancedSettingsButton} onclick={() => showConfiguration()}>Advanced settings <Icon name="settings" size={16} /></button>
      </section>
      <div class="launch-content">
        <div class="launch-row">
          <div class="limit-summary">
            <span>Work limits <button type="button" class="text-action" onclick={() => showConfiguration("limits")}>Edit limits</button></span>
            <p>{maxRunMinutes} min{#if useWorkflow}&nbsp;· {workflowModelLimit} {workflowModelLimit === 1 ? "model call" : "model calls"} · {workflowSearchLimit} {workflowSearchLimit === 1 ? "search" : "searches"}{#if workflowMode === "vibe" && researchMode === "explore-market"}&nbsp;· {automaticProblemCap} problems{/if}{/if}</p>
          </div>
          <!-- Stays clickable while the brief is incomplete: the click is what reveals the missing fields. -->
          <button type="submit" class="primary" disabled={locked || !providersReady || (useWorkflow && previewing)}>{locked ? "Starting…" : useWorkflow ? "Start" : (researchMode === "explore-market" ? "Discover problems" : "Generate solutions")}<Icon name="arrow" size={17} /></button>
        </div>
        <div class="launch-status" role="status">
          {#if blockingMessage}<span>{blockingMessage}</span>{:else if useWorkflow}<span>{launchSteps()}.</span>{/if}
          {#if configurationIssues || missing.domain || missing.knownProblem}<button type="button" class="text-action" onclick={revealBlockingField}>{modelChoiceRequired ? "Choose model" : configurationIssues ? "Review settings" : "Edit brief"}</button>{/if}
          {#if validationAttempted && previewError}<button type="button" class="text-action" onclick={() => previewAttempt += 1}>Retry preview</button>{/if}
          {#if saved}<span>Saved</span>{/if}
        </div>
        {#if connectionNeedsAttention}
          <div class="connection-warning">
            {#if modelStatus}<span>{modelStatus}</span>{/if}
            {#if researchMode === "explore-market" && !selectedSearchValidation.valid}<span>{selectedSearchName}: {selectedSearchValidation.error ?? "Connection unavailable"}</span>{/if}
            {#if onOpenSettings}<button type="button" class="text-action" onclick={onOpenSettings}>Open settings</button>{/if}
            <button type="button" class="text-action" disabled={locked || connectionsChecking} onclick={() => onRetry()}>{connectionsChecking ? "Checking…" : "Retry connections"}</button>
          </div>
        {/if}
      </div>
    </aside>
    <dialog bind:this={configuration} class="settings-dialog glass-dense" aria-label="Advanced settings" onclose={restoreConfigurationFocus} onkeydown={(event) => { if (event.key === "Enter" && event.target instanceof HTMLInputElement) event.preventDefault(); }}>
      <header><h2>Advanced settings</h2><button type="button" aria-label="Close advanced settings" onclick={() => configuration.close()}><Icon name="close" /></button></header>
      <nav aria-label="Settings groups">
        {#if researchMode === "explore-market"}<button type="button" aria-pressed={settingsSection === "research"} onclick={() => settingsSection = "research"}>Search</button>{/if}
        <button type="button" aria-pressed={settingsSection === "limits"} onclick={() => settingsSection = "limits"}>Work limits</button>
        {#if useWorkflow}<button type="button" aria-pressed={settingsSection === "instructions"} onclick={() => settingsSection = "instructions"}>Instructions</button>{/if}
      </nav>
      <div class="settings-content">
        {#each visiblePreviewIssues.filter((issue) => issue.path[0] !== "limits" && issue.path[0] !== "ideas") as issue (issue.path.join(".") + issue.code)}<p class="field-error" role="alert">{issue.message}</p>{/each}
        <div class="settings-panels">
        <section class="settings-panel" aria-label="Research configuration" inert={settingsSection !== "research"}>
          <h3>Search</h3>    <div class="run-settings">
      {#if researchMode === "explore-market"}<label class="run-setting search-setting"><span>Search provider</span><div class="provider-select"><ProviderLogo provider={searchProvider} size={17} /><select aria-label="Search provider" data-field="searchProvider" bind:value={searchProvider}><option value="exa">Exa</option><option value="perplexity">Perplexity</option></select></div><small>{selectedSearchName}: {selectedSearchValidation.valid ? "Connected" : selectedSearchValidation.error ?? "Connection unavailable"}</small></label>{/if}
    </div>

      <div class="output-settings">
      {#if researchMode === "explore-market"}<label class="source-coverage"><span>Search coverage</span><select aria-label="Search coverage" bind:value={audienceSourcePolicy} aria-describedby={audienceSourcePolicy === "communities" ? "source-coverage-help" : undefined}><option value="web">Web and communities</option><option value="communities">Communities only</option></select>{#if audienceSourcePolicy === "communities"}<small id="source-coverage-help">Audience evidence from Reddit and Hacker News. Market research still searches all sites.</small>{/if}</label>{/if}

      </div>


        </section>
        <section class="settings-panel" aria-label="Work limits configuration" inert={settingsSection !== "limits"}>
          <h3>Work limits</h3><p class="help">Work stops at these limits. They do not guarantee completion.</p>
          {#if useWorkflow}        <div class="advanced-body limits-grid">
          <label><span>Time limit (minutes)</span><input aria-label="Time limit" data-field="maxRunMinutes" type="number" min="5" max="240" step="1" bind:value={maxRunMinutes} aria-invalid={Boolean(errors.maxRunMinutes)} />{#if errors.maxRunMinutes}<small class="field-error">{errors.maxRunMinutes}</small>{/if}</label>
          <label><span>Maximum model calls</span><input aria-label="Maximum model calls" data-field="workflowModelLimit" type="number" min="1" step="1" bind:value={workflowModelLimit} oninput={() => workflowModelLimitTouched = true} aria-invalid={Boolean(errors.workflowModelLimit || previewIssue("limits.maxModelCalls"))} />{#if errors.workflowModelLimit || previewIssue("limits.maxModelCalls")}<small class="field-error">{errors.workflowModelLimit ?? previewIssue("limits.maxModelCalls")}</small>{/if}</label>
          <label><span>Maximum searches</span><input aria-label="Maximum searches" data-field="workflowSearchLimit" type="number" min="0" step="1" bind:value={workflowSearchLimit} oninput={() => workflowSearchLimitTouched = true} aria-invalid={Boolean(errors.workflowSearchLimit || previewIssue("limits.maxSearches"))} />{#if errors.workflowSearchLimit || previewIssue("limits.maxSearches")}<small class="field-error">{errors.workflowSearchLimit ?? previewIssue("limits.maxSearches")}</small>{/if}</label>
          {#if workflowMode === "vibe" && researchMode === "explore-market"}<label><span>Automatic problem cap</span><input aria-label="Automatic problem cap" data-field="automaticProblemCap" type="number" min="1" max="20" step="1" bind:value={automaticProblemCap} aria-invalid={Boolean(errors.automaticProblemCap)} />{#if errors.automaticProblemCap}<small class="field-error">{errors.automaticProblemCap}</small>{/if}</label>{/if}
        </div>
{:else}<label><span>Time limit (minutes)</span><input type="number" min="5" max="240" bind:value={maxRunMinutes} /></label>{/if}
          {#if workflowPreviewValid && workflowPreview}<p class="help">Minimum required: {workflowPreview.minimumWork.modelCalls} model calls and {workflowPreview.minimumWork.searches} {workflowPreview.minimumWork.searches === 1 ? "search" : "searches"}. Work stops at your saved limits.</p>{/if}
        </section>
        <section class="settings-panel instructions-panel" aria-label="Custom instructions" inert={settingsSection !== "instructions"}>
          <h3>Custom instructions</h3>
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
      <div class="dialog-footer"><span>Changes apply to this research.</span><button type="button" onclick={() => configuration.close()}>Done</button></div>
    </dialog>
  </form>
</section>

<style>
  .scope-page,form { height:100%;min-height:0; }
  /* The launch panel grows a little with the page so its paired selects keep readable labels. */
  /* The brief starts at the header title's edge; the launch panel stays docked at the right edge of the page. */
  form { display:grid;grid-template-columns:minmax(0,1fr) clamp(300px,26cqi,344px); }
  .setup-scroll { flex:1;min-height:0;overflow:auto;scroll-padding-block:24px; }
  .setup-body { width:min(100%,calc(888px + var(--page-gutter)));padding:28px 32px 28px var(--page-gutter);display:grid;gap:24px; }
  .context-fields { display:grid;grid-template-columns:1fr 1fr;gap:20px; }
  .context-fields { padding-top:4px; }
  .context-fields > :last-child:nth-child(odd) { grid-column:1/-1; }
  label { display:grid;gap:8px;min-width:0;font-size:14px; }
  label > span { font-weight:500; }
  input,select,textarea { width:100%;min-width:0;min-height:42px;padding:9px 12px;border:1px solid var(--border-strong);border-radius:7px;color:var(--text);background:var(--surface);font-size:14px; }
  textarea { line-height:1.65; }
  small,.help { color:var(--muted);font-size:13px;font-weight:400;line-height:1.5; }
  label > span > small { margin-left:6px; }
  .field-error { color:var(--danger);font-size:13px; }
  input[aria-invalid="true"],textarea[aria-invalid="true"],select[aria-invalid="true"] { border-color:var(--danger); }
  fieldset { min-width:0;border:0;padding:0;margin:0; }
  .choice-group { display:grid;gap:6px; }
  .choice-group legend { margin-bottom:6px;font-size:13px;color:var(--muted); }
  .choice-group label { display:flex;align-items:center;gap:10px;padding:10px 12px;min-height:42px;border:1px solid transparent;border-radius:7px;cursor:pointer; }
  .choice-group label:hover { background:var(--surface-2); }
  .choice-group label.active { background:rgb(255 255 255 / .06);border-color:rgb(255 255 255 / .16); }
  .choice-group input { appearance:none;flex:none;width:16px;height:16px;min-height:0;margin:0;padding:0;border:1px solid var(--subtle);border-radius:50%;background:transparent; }
  .choice-group input:checked { border:5px solid var(--accent); }
  .choice-group label:has(input:focus-visible) { outline:2px solid var(--accent);outline-offset:2px; }
  .choice-group label > span { display:flex;align-items:baseline;gap:12px;font-size:14px;font-weight:500; }
  .choice-group strong { font-size:14px;font-weight:600;min-width:58px; }
  .mode-picker { grid-template-columns:1fr 1fr; }
  .workflow-mode { gap:4px; }
  .mode-option { position:relative;display:flex;align-items:center;justify-content:space-between;border:1px solid transparent;border-radius:7px; }
  .mode-option.active { background:rgb(255 255 255 / .06);border-color:rgb(255 255 255 / .16); }
  .mode-option label { flex:1;border:0; }
  .mode-info { display:flex;align-items:center;margin-right:6px; }
  .info-button { display:grid;place-items:center;width:32px;min-height:32px;padding:0;border:0;background:transparent;color:var(--muted); }
  .mode-tooltip { position:absolute;z-index:5;right:0;top:100%;width:248px;max-width:calc(100vw - 48px);padding:12px 14px;border-radius:10px;background:#111212;color:var(--text);font-size:13px;line-height:1.6; }
  .mode-tooltip[hidden] { display:none; }
  .brief-panel { display:grid;gap:20px; }
  .main-brief > span { font-size:26px;line-height:1.25;letter-spacing:-.7px;font-weight:600; }
  .main-brief { gap:10px; }
  .main-brief textarea { min-height:132px;padding:10px 14px;font-size:15px; }
  .main-settings { display:grid;gap:10px;padding-top:16px;border-top:1px solid var(--border); }
  .main-settings-grid { display:grid;grid-template-columns:1fr 1fr;gap:12px; }
  .main-settings-grid label,.main-settings-grid .solution-count { font-size:13px;gap:6px; }
  .main-settings-grid .solution-count { grid-column:1/-1;grid-template-columns:1fr 100px;align-items:center; }
  .main-settings-grid .solution-count label { font-size:13px;line-height:1.5; }
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
  summary { display:flex;align-items:center;gap:12px;min-height:40px;cursor:pointer;list-style:none;color:var(--muted);font-size:13px; }
  summary::-webkit-details-marker { display:none; }
  summary::after { content:"";flex:none;width:6px;height:6px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);margin-left:auto;margin-right:4px; }
  details[open] > summary::after { transform:rotate(45deg); }
  summary:hover { color:var(--text); }
  .opportunity-target { display:grid;gap:16px;padding:12px 0 20px; }
  .target-grid,.run-settings,.output-settings,.limits-grid { display:grid;grid-template-columns:1fr 1fr;gap:16px; }
  .target-toggle,.exploratory-toggle { display:flex;gap:10px;align-items:start; }
  .target-toggle input,.exploratory-toggle input { flex:none;width:18px;height:18px;min-height:0;margin-top:2px;accent-color:var(--accent); }
  .target-toggle span,.exploratory-toggle span { display:grid;gap:5px; }
  .opportunity-target p,.saved-purpose-note { color:var(--muted);font-size:13px;line-height:1.6;margin:0; }
  .saved-purpose-note button { border:0;padding:0;color:var(--accent);background:none; }
  /* The run panel floats inside the page as its own glass card. */
  .launch-sidebar { min-height:0;overflow:auto;display:flex;flex-direction:column;gap:18px;margin:12px 12px 12px 0;padding:18px;border-radius:14px;scroll-padding-block:20px; }
  .launch-sidebar > * { flex:none; }
  .launch-content { margin-top:auto;padding-top:10px; }
  .launch-row { display:flex;flex-direction:column;align-items:stretch;gap:12px; }
  .limit-summary > span { display:flex;align-items:center;gap:14px;font-size:14px;font-weight:500; }
  .limit-summary p { margin:1px 0 0;color:var(--muted);font-size:13px;line-height:1.6; }
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
  .settings-dialog nav button[aria-pressed="true"] { color:var(--accent-strong);background:rgb(255 255 255 / .1); }
  .settings-content { overflow:auto;min-height:0;padding:24px;scroll-padding-block:24px; }
  /* Every tab shares one grid cell, so the dialog takes the tallest tab's height and keeps it while switching.
     Inactive tabs stay in layout but are inert and invisible. */
  .settings-panels { display:grid; }
  .settings-panel { grid-area:1/1;min-width:0; }
  .settings-panel[inert] { visibility:hidden; }
  /* The instructions editor stretches to the height the other tabs set; its minimum stays below theirs. */
  .instructions-panel { display:flex;flex-direction:column;gap:12px; }
  .instructions-panel h3 { margin-bottom:4px; }
  .instructions-panel textarea { flex:1;min-height:120px; }
  .instruction-stages { display:flex;align-self:flex-start;gap:2px;padding:3px;border:1px solid var(--border);border-radius:10px; }
  .instruction-stages button { display:flex;align-items:center;gap:6px;padding:5px 12px;border:0;border-radius:7px;background:none;color:var(--muted);font-size:13px; }
  .instruction-stages button:hover:not([aria-pressed="true"]) { color:var(--text); }
  .instruction-stages button[aria-pressed="true"] { color:var(--text);background:rgb(255 255 255 / .1); }
  .filled-dot { width:6px;height:6px;border-radius:50%;background:var(--accent-strong); }
  .settings-panel h3 { margin:0 0 16px;font-size:16px;font-weight:600; }
  .settings-panel .help { margin:0 0 16px; }
  .model-setting,.search-setting { grid-column:1/-1; }
  .advanced-body { display:grid;gap:16px; }
  .output-settings { margin-top:20px;padding-top:20px;border-top:1px solid var(--border); }
  .provider-select { position:relative; }
  .provider-select :global(svg) { position:absolute;left:12px;top:50%;transform:translateY(-50%);pointer-events:none; }
  .provider-select select { padding-left:38px; }
  .solution-count { display:grid;align-content:start;gap:8px; }
  .dialog-footer { display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 24px;border-top:1px solid var(--border);font-size:13px;color:var(--muted); }
  /* Page-width breakpoints follow the page container; the dialog rules below follow the window it floats over. */
  @container page (max-width:840px) {
    form { display:block;overflow:auto; }
    .setup-scroll { overflow:visible; }
    .launch-sidebar { overflow:visible;margin:0 32px 20px var(--page-gutter);padding:24px;display:grid;grid-template-columns:1fr 1fr;gap:24px; }
    .main-settings { border-top:0;padding-top:0; }
    .launch-content { grid-column:1/-1;margin-top:0;padding-top:0; }
  }
  @container page (max-width:560px) {
    .setup-body { padding:20px 16px;gap:20px; }.launch-sidebar { margin:0 12px 12px;padding:20px 16px;grid-template-columns:1fr; }
    .main-brief > span { font-size:24px; }.mode-picker,.context-fields,.target-grid { grid-template-columns:1fr; }
    .launch-row { align-items:stretch;flex-direction:column;gap:10px; }.primary { width:100%; }
  }
  @media(max-width:600px) {
    .run-settings,.output-settings,.limits-grid { grid-template-columns:1fr; }
    .settings-dialog header,.settings-content { padding:16px; }.settings-dialog nav { padding-inline:10px; }.dialog-footer { padding:12px 16px; }
  }
  @media(max-height:600px) { @container page (min-width:841px) { .scope-page,form { height:auto; }.setup-scroll { overflow:visible;flex:none; }.launch-sidebar { position:sticky;top:0;align-self:start;max-height:100dvh; } } }
</style>
