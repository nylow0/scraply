import { canonicalJson, sha256 } from "../shared/content-identity";
import { discoveryRunProjection } from "../shared/discovery-projection";
import { modelRefKey, sameModelRef, type ModelOption, type ModelRef } from "../shared/schemas";
import {
  WorkflowLaunchContractSchema, WorkflowLaunchDraftSchema,
  type WorkflowLaunchContract, type WorkflowLaunchDraft,
} from "../shared/workflow-contracts";
import { resolveWorkflowV2Prompt } from "./prompts";
import { allocateIdeaTargets } from "./opportunity-planning";

export interface WorkflowCapabilities {
  modelOptions: ModelOption[];
  nativeConnected: boolean;
  searchReady: { exa: boolean; perplexity: boolean };
}

export interface WorkflowPreview {
  contract: WorkflowLaunchContract;
  previewHash: string;
  capabilityFingerprint: string;
  expiresAt: string;
  minimumWork: { modelCalls: number; searches: number };
  fieldErrors: Array<{ path: string[]; code: string; message: string }>;
}

const PREVIEW_LIFETIME_MS = 10 * 60_000;

/** A preview is deterministic for its contract, catalog, and expiry. Start checks all three. */
export function previewLaunch(draftInput: WorkflowLaunchDraft, capabilities: WorkflowCapabilities, now = new Date()): WorkflowPreview {
  const draft = WorkflowLaunchDraftSchema.parse(draftInput);
  const targets = {
    ...draft.targets,
    automaticProblemCap: draft.targets.automaticProblemCap ?? 3,
  };
  const ideas = draft.ideas ? {
    ...draft.ideas,
    reviewModel: draft.ideas.reviewModel ?? draft.ideas.model,
    reviewReasoningEffort: draft.ideas.reviewReasoningEffort ?? draft.ideas.reasoningEffort,
  } : undefined;
  const normalized = { ...draft, targets, ...(ideas ? { ideas } : {}) };
  const resolvedInstructions = {
    research: resolveInstructions(["query-plan", "factor-harvest", "problem-candidates", "problem-kill"], draft.instructions.research),
    ideas: resolveInstructions(["solutions"], draft.instructions.ideas),
    review: resolveInstructions(["solution-set-review"], draft.instructions.review),
  };
  const contract = WorkflowLaunchContractSchema.parse({
    ...normalized,
    resolvedInstructions,
    instructionHashes: {
      research: sha256(resolvedInstructions.research),
      ideas: sha256(resolvedInstructions.ideas),
      review: sha256(resolvedInstructions.review),
    },
  });
  const fieldErrors: WorkflowPreview["fieldErrors"] = [];
  if (!capabilities.nativeConnected) {
    fieldErrors.push({ path: ["runConfig", "model"], code: "MODEL_UNAVAILABLE", message: "Connect OpenAI before starting." });
  }
  checkModel(capabilities.modelOptions, contract.runConfig.model, contract.runConfig.reasoningEffort, ["runConfig", "model"], fieldErrors);
  if (contract.ideas) {
    checkModel(capabilities.modelOptions, contract.ideas.model, contract.ideas.reasoningEffort, ["ideas", "model"], fieldErrors);
    checkModel(capabilities.modelOptions, contract.ideas.reviewModel ?? contract.ideas.model,
      contract.ideas.reviewReasoningEffort ?? contract.ideas.reasoningEffort, ["ideas", "reviewModel"], fieldErrors);
  } else if (contract.mode === "vibe") {
    fieldErrors.push({ path: ["ideas"], code: "MODEL_UNAVAILABLE", message: "Choose the ideas model before starting Vibe." });
  }
  if (contract.purpose === "discovery" && contract.runConfig.researchMode !== "explore-market") {
    fieldErrors.push({ path: ["runConfig", "researchMode"], code: "INVALID_PURPOSE", message: "Discovery needs the find-problems starting point." });
  }
  if (contract.purpose === "known-problem" && (!contract.runConfig.knownProblem.trim() || contract.runConfig.researchMode !== "known-problem")) {
    fieldErrors.push({ path: ["runConfig", "knownProblem"], code: "INVALID_PURPOSE", message: "Enter a known problem before starting." });
  }
  if (contract.purpose === "discovery" && !capabilities.searchReady[contract.runConfig.searchProvider]) {
    fieldErrors.push({ path: ["runConfig", "searchProvider"], code: "SEARCH_UNAVAILABLE", message: "Connect the selected search provider." });
  }
  if (contract.targets.kind === "project" &&
      (contract.runConfig.explorationPurpose !== "startup-opportunities" || !contract.targets.distinctBusinessCount || contract.targets.distinctBusinessCount > 30)) {
    fieldErrors.push({ path: ["targets", "distinctBusinessCount"], code: "INVALID_TARGET", message: "Choose a startup business-family target from 1 to 30." });
  }
  if (contract.mode === "vibe" && contract.purpose !== "discovery" && contract.purpose !== "known-problem") {
    fieldErrors.push({ path: ["purpose"], code: "INVALID_PURPOSE", message: "Vibe starts with discovery or a known problem." });
  }
  const discovery = contract.purpose === "discovery" ? discoveryRunProjection(contract.runConfig.discoveryDepth) : { modelCalls: 0, searches: 0 };
  const possibleProblems = contract.purpose === "known-problem" ? 1
    : contract.mode === "vibe" ? contract.targets.automaticProblemCap ?? 3 : 1;
  const target = contract.targets.distinctBusinessCount ?? contract.targets.ideaCount;
  const initialBatches = contract.targets.kind === "per-problem"
    ? possibleProblems * Math.ceil(contract.targets.ideaCount / 5)
    : Math.max(...Array.from({ length: possibleProblems }, (_, index) => {
      const problemIds = Array.from({ length: index + 1 }, (_, problem) => `preview-problem-${problem}`);
      return allocateIdeaTargets({ problemIds, target, maxPerProblem: 20 }).allocations
        .reduce((count, allocation) => count + Math.ceil(allocation.quota / 5), 0);
    }));
  // Each discovery stage reserves its schema correction. Every idea batch has
  // a generation reservation and an independent review reservation.
  const minimumWork = { modelCalls: discovery.modelCalls * 2 + initialBatches * 4, searches: discovery.searches };
  if (contract.limits.maxModelCalls < minimumWork.modelCalls) {
    fieldErrors.push({ path: ["limits", "maxModelCalls"], code: "BUDGET_TOO_SMALL", message: `Allow at least ${minimumWork.modelCalls} model calls for research, generation, and review.` });
  }
  if (contract.limits.maxSearches < minimumWork.searches) {
    fieldErrors.push({ path: ["limits", "maxSearches"], code: "BUDGET_TOO_SMALL", message: `Allow at least ${minimumWork.searches} searches for this research depth.` });
  }
  const capabilityFingerprint = fingerprintCapabilities(capabilities);
  const expiresAt = new Date(now.getTime() + PREVIEW_LIFETIME_MS).toISOString();
  return {
    contract, previewHash: launchPreviewHash(contract, capabilityFingerprint, expiresAt),
    capabilityFingerprint, expiresAt, minimumWork, fieldErrors,
  };
}

export function verifyLaunchPreview(input: {
  contract: WorkflowLaunchContract;
  previewHash: string;
  capabilityFingerprint: string;
  previewExpiresAt: string;
}, capabilities: WorkflowCapabilities, now = new Date()): boolean {
  const contract = WorkflowLaunchContractSchema.parse(input.contract);
  const expiry = Date.parse(input.previewExpiresAt);
  if (!Number.isFinite(expiry) || now.getTime() > expiry || expiry - now.getTime() > PREVIEW_LIFETIME_MS) return false;
  const fingerprint = fingerprintCapabilities(capabilities);
  return fingerprint === input.capabilityFingerprint
    && launchPreviewHash(contract, fingerprint, input.previewExpiresAt) === input.previewHash;
}

function checkModel(
  options: ModelOption[], model: ModelRef, effort: string, path: string[], errors: WorkflowPreview["fieldErrors"],
): void {
  const choice = options.find((option) => sameModelRef(option, model));
  if (!choice) {
    errors.push({ path, code: "MODEL_UNAVAILABLE", message: `${model.modelId} is not in the connected account's model list.` });
  } else if (!choice.reasoningEfforts.some((option) => option.id === effort)) {
    errors.push({ path, code: "MODEL_UNAVAILABLE", message: `${effort} reasoning is unavailable for ${model.modelId}.` });
  }
}

function resolveInstructions(stageIds: Array<Parameters<typeof resolveWorkflowV2Prompt>[0]>, extra?: string): string {
  const stageTexts = stageIds.map((id) => {
    const prompt = resolveWorkflowV2Prompt(id);
    return `## ${id} (${prompt.resolvedSha256})\n${prompt.text}`;
  });
  if (extra?.trim()) stageTexts.push(`## Project instruction\n${extra.trim()}`);
  return stageTexts.join("\n\n");
}

function fingerprintCapabilities(capabilities: WorkflowCapabilities): string {
  const options = capabilities.modelOptions.map((option) => ({
    model: modelRefKey(option), defaultEffort: option.defaultReasoningEffort,
    efforts: option.reasoningEfforts.map((effort) => effort.id).sort(),
  })).sort((left, right) => left.model.localeCompare(right.model));
  return sha256(canonicalJson({ options, nativeConnected: capabilities.nativeConnected, searchReady: capabilities.searchReady }));
}

function launchPreviewHash(contract: WorkflowLaunchContract, capabilityFingerprint: string, expiresAt: string): string {
  return sha256(canonicalJson({ contract, capabilityFingerprint, expiresAt }));
}
