import { randomUUID } from "node:crypto";
import { z } from "zod";
import { OpportunityExplorationRepository } from "../db/repositories/opportunity-exploration";
import { OpportunityRepository } from "../db/repositories/opportunities";
import type { DatabaseClient } from "../db/client";
import type { StructuredModelClient } from "../providers/structured";
import { canonicalJson } from "../shared/content-identity";
import { deriveJsonSchema } from "../shared/json-schema";
import {
  OpportunityCoverageMapOutputSchema,
  OpportunityExplorationConfigSchema,
  type OpportunityCoverageGap,
  type OpportunityCoverageMapOutput,
  type OpportunityExplorationConfig,
} from "../shared/opportunity-exploration";
import type { ModelRef, ReasoningEffort } from "../shared/schemas";

const PROMPT_VERSION = "opportunity-coverage-managed-v1";
const INSTRUCTION = "Name concrete gaps in the saved startup inventory. A mechanism gap is a workflow gap with a specific different operating method. Name a new buyer or workflow only when the existing problem map is exhausted. Ask for one bounded search query when evidence is required. Return no gap rather than generic 'more ideas'. Exploratory hypotheses are allowed only when the project flag says so.";
const SavedMapInputSchema = z.object({
  round: z.number().int().min(0).max(2),
  explorationConfig: OpportunityExplorationConfigSchema,
  context: z.unknown(),
}).strict();

export interface ManagedCoverageMapInput {
  db: DatabaseClient;
  threadId: string;
  sessionId: string;
  workItemId: string;
  round: 0 | 1 | 2;
  explorationConfig: OpportunityExplorationConfig;
  modelClient?: StructuredModelClient | undefined;
  model: ModelRef;
  reasoningEffort: ReasoningEffort;
  signal: AbortSignal;
  /** The caller records its own reserved model-call dispatch; this helper records the opportunity attempt. */
  onDispatched?: (attemptId: string) => void;
}

export interface ManagedCoverageMapResult {
  attemptId: string;
  gaps: OpportunityCoverageGap[];
  noUsefulGapReason: string | null;
  replayed: boolean;
}

/** One saved coverage-map call per session round. Provider scheduling and budget reservation belong to the caller. */
export async function runManagedCoverageMap(input: ManagedCoverageMapInput): Promise<ManagedCoverageMapResult> {
  input.signal.throwIfAborted();
  const repository = new OpportunityExplorationRepository(input.db);
  const stageKey = `coverage-map:${input.round}`;
  const saved = repository.loadAttempt(input.threadId, stageKey, input.sessionId);
  const savedMapInput = saved ? SavedMapInputSchema.parse(saved.input) : null;
  if (saved) {
    if (canonicalJson(savedInput(input)) !== canonicalJson({
      round: savedMapInput!.round, explorationConfig: savedMapInput!.explorationConfig,
    })) throw new Error("Saved coverage map configuration changed.");
    if (saved.workItemId !== input.workItemId || canonicalJson(saved.model)
      !== canonicalJson({ ...input.model, reasoningEffort: input.reasoningEffort })) {
      throw new Error("Saved coverage map belongs to a different task or model.");
    }
    if (saved.promptVersion !== PROMPT_VERSION || saved.promptText !== INSTRUCTION) {
      throw new Error("Saved coverage map prompt identity changed.");
    }
    if (saved.status === "completed") {
      return materialize(input, saved.attemptId, OpportunityCoverageMapOutputSchema.parse(saved.result), true);
    }
    if (saved.status !== "prepared") {
      throw new Error("Coverage mapping may have completed before its result was saved. It will not be replayed automatically.");
    }
  }
  const modelClient = input.modelClient;
  if (!modelClient) throw new Error("A model client is required for a new or prepared coverage map.");
  const context = savedMapInput ? savedMapInput.context : mapContext(input.db, input.threadId);
  const attempt = saved ? { kind: "prepared" as const, attemptId: saved.attemptId }
    : input.db.immediateTransaction(() => repository.prepareAttempt(input.threadId, {
    stageKey, stageName: "coverage-map",
    input: { ...savedInput(input), context },
    model: { ...input.model, reasoningEffort: input.reasoningEffort },
    promptVersion: PROMPT_VERSION, promptText: INSTRUCTION, workItemId: input.workItemId,
  }, input.sessionId));
  if (attempt.kind === "unknown-dispatch") {
    throw new Error("Coverage mapping may have completed before its result was saved. It will not be replayed automatically.");
  }
  if (attempt.kind === "completed") {
    return materialize(input, attempt.attemptId, OpportunityCoverageMapOutputSchema.parse(attempt.result), true);
  }
  if (attempt.kind !== "prepared") throw new Error("Coverage mapping attempt was not prepared.");
  let dispatched = false;
  try {
    const result = await modelClient.structuredCompletion({
      generationId: randomUUID(), stage: stageKey,
      model: input.model, reasoningEffort: input.reasoningEffort,
      workOrder: {
        stage: stageKey, instruction: INSTRUCTION,
        goal: "Name up to five bounded buyer, workflow, trigger, problem, or evidence gaps, or explain why none remain.",
        inputs: { round: input.round, allowExploratoryProblems: input.explorationConfig.allowExploratoryProblems },
        definitionOfDone: ["Each gap identifies a buyer, workflow, or operating mechanism to investigate.",
          "An evidence request has one bounded search query."],
        constraints: ["Do not invent evidence or request generic ideation."],
      },
      evidence: [{ sourceId: "scraply:opportunity-inventory", content: context }],
      schema: OpportunityCoverageMapOutputSchema,
      jsonSchema: deriveJsonSchema(OpportunityCoverageMapOutputSchema),
      repairPolicy: "disabled", deadlineMs: 120_000, signal: input.signal,
      onDispatched: () => {
        input.db.immediateTransaction(() => repository.markAttemptDispatched(
          input.threadId, attempt.attemptId, "none", input.sessionId));
        dispatched = true;
        input.onDispatched?.(attempt.attemptId);
      },
    });
    const output = OpportunityCoverageMapOutputSchema.parse(result.output);
    validateOutput(output, input.explorationConfig.allowExploratoryProblems);
    return materialize(input, attempt.attemptId, output, false);
  } catch (error) {
    input.db.immediateTransaction(() => repository.failAttempt(
      input.threadId, attempt.attemptId, error instanceof Error ? error.message : String(error), !dispatched, input.sessionId));
    throw error;
  }
}

export function loadManagedCoverageGaps(db: DatabaseClient, threadId: string, sessionId: string): OpportunityCoverageGap[] {
  return new OpportunityExplorationRepository(db).listGaps(threadId, sessionId);
}

/** Call from the same transaction that records a reviewed fill batch. */
export function markManagedCoverageGapCovered(db: DatabaseClient, threadId: string, sessionId: string, gapId: string): void {
  db.requireImmediateTransaction();
  const repository = new OpportunityExplorationRepository(db);
  const gap = repository.listGaps(threadId, sessionId).find((candidate) => candidate.id === gapId);
  if (!gap) throw new Error("Coverage gap does not belong to this session or project.");
  repository.saveGap(threadId, { ...gap, status: "covered", updatedAt: new Date().toISOString() }, sessionId);
}

function materialize(input: ManagedCoverageMapInput, attemptId: string, output: OpportunityCoverageMapOutput,
  replayed: boolean): ManagedCoverageMapResult {
  validateOutput(output, input.explorationConfig.allowExploratoryProblems);
  const repository = new OpportunityExplorationRepository(input.db);
  const now = new Date().toISOString();
  input.db.immediateTransaction(() => {
    if (!replayed) repository.completeAttempt(input.threadId, attemptId, output, input.sessionId);
    output.gaps.forEach((gap, index) => {
      const id = `${attemptId}:gap:${index + 1}`;
      if (repository.listGaps(input.threadId, input.sessionId).some((saved) => saved.id === id)) return;
      repository.saveGap(input.threadId, {
        id, ...gap, status: gap.evidenceNeeded ? "search-needed" : "ready",
        createdAt: now, updatedAt: now,
      }, input.sessionId, input.explorationConfig.allowExploratoryProblems);
    });
  });
  const gaps = repository.listGaps(input.threadId, input.sessionId)
    .filter((gap) => gap.id.startsWith(`${attemptId}:gap:`));
  return { attemptId, gaps, noUsefulGapReason: output.noUsefulGapReason, replayed };
}

function validateOutput(output: OpportunityCoverageMapOutput, allowExploratoryProblems: boolean): void {
  const names = new Set<string>();
  for (const gap of output.gaps) {
    if (Boolean(gap.evidenceNeeded) !== Boolean(gap.searchQuery)) {
      throw new Error(`Coverage gap "${gap.name}" needs both an evidence request and a bounded query.`);
    }
    if (gap.candidateOrigin === "exploratory-allowed" && !allowExploratoryProblems) {
      throw new Error(`Coverage gap "${gap.name}" requested exploratory hypotheses without project permission.`);
    }
    const name = gap.name.toLocaleLowerCase();
    if (names.has(name)) throw new Error(`Coverage map repeated the gap "${gap.name}".`);
    names.add(name);
  }
}

function savedInput(input: ManagedCoverageMapInput) {
  return { round: input.round, explorationConfig: input.explorationConfig };
}

function mapContext(db: DatabaseClient, threadId: string) {
  const view = new OpportunityRepository(db).familyView(threadId);
  const families = view.families.filter((family) => family.active).slice(0, 40).map((family) => ({
    id: family.id, title: family.title, summary: family.summary,
    representativeOptionId: family.representativeOptionId, counted: family.counted,
    memberMechanisms: family.members.slice(0, 8).map((member) => member.mechanism),
    omittedMemberCount: Math.max(0, family.members.length - 8),
  }));
  const problems = db.db.prepare(`
    SELECT p.id, p.statement, p.affected, p.verdict, p.evidence_gap, p.workflow_key
    FROM problems p JOIN research_runs run ON run.id = p.discovery_run_id
    WHERE run.thread_id = ? ORDER BY p.created_at DESC, p.id LIMIT 60
  `).all(threadId);
  const scope = db.db.prepare(`
    SELECT s.title, s.audience, s.domain, s.observations, s.off_limits_json
    FROM scopes s JOIN research_runs run ON run.id = s.research_run_id
    WHERE run.thread_id = ? ORDER BY run.created_at DESC LIMIT 1
  `).get(threadId);
  return {
    scope, problems, families,
    omittedFamilyCount: Math.max(0, view.families.filter((family) => family.active).length - families.length),
    acceptedFamilyCount: view.acceptedFamilyCount,
    unresolvedCount: view.unresolved.length,
    unreviewedCount: view.unreviewedOptionIds.length,
  };
}
