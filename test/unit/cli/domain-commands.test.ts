import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCommandContext } from "../../../src/cli/context";
import type { CommandArguments } from "../../../src/cli/args";
import { evidence } from "../../../src/cli/commands/evidence";
import { families } from "../../../src/cli/commands/families";
import { ideas } from "../../../src/cli/commands/ideas";
import { workflows } from "../../../src/cli/commands/workflows";
import { CliError } from "../../../src/cli/output";
import {
  APP_CHANNELS, ExecuteOperationRequestSchema, GetProjectResultSchema, ListRunsResultSchema,
  OperationProposalSchema, OperationRequestSchema, ResolveEntityRequestSchema, isBillableOperation, isBoxedOperation,
  type EntityKind, type OperationProposal,
} from "../../../src/shared/cli-contracts";
import { IPC_CHANNELS, WorkspaceStateSchema, type ResearchEvent } from "../../../src/shared/ipc";
import { defaultLaunchSettings, buildSavedLaunchDraft } from "../../../src/shared/launch-settings";
import { DEFAULT_RUN_CONFIG, RunConfigSchema, ThreadSchema } from "../../../src/shared/schemas";
import { OpportunityBudgetExtensionPreviewSchema, DEFAULT_OPPORTUNITY_EXPLORATION_CONFIG } from "../../../src/shared/opportunity-exploration";
import {
  CommandWorkflowRequestSchema, IdeaConversationSchema, PreviewWorkflowRequestSchema, WorkflowDetailSchema,
  WorkflowLaunchContractSchema, WorkflowSummarySchema, type WorkflowTaskSchema,
} from "../../../src/shared/workflow-contracts";
import { RunTraceSchema } from "../../../src/shared/run-trace";
import { ResearchFrameSchema } from "../../../src/shared/research-frame";
import { z } from "zod";

const commands = [...workflows, ...evidence, ...ideas, ...families];
const date = "2026-10-01T12:00:00.000Z";
const expiry = "2099-01-01T00:00:00.000Z";

function fixture() {
  const config = RunConfigSchema.parse({ ...DEFAULT_RUN_CONFIG, reasoningEffort: "high", researchMode: "known-problem", knownProblem: "Synthetic workshop inventory approvals take too long." });
  const scope = { title: "Synthetic workshop planning", audience: "Workshop managers", domain: "Inventory approvals", observations: "Managers check inventory manually.", offLimits: [] };
  const thread = ThreadSchema.parse({ id: "project-alpha", title: scope.title, status: "problems-ready", createdAt: date, updatedAt: date });
  const summary = WorkflowSummarySchema.parse({ sessionId: "session-alpha", threadId: thread.id, purpose: "known-problem", mode: "babysit", targetKind: "per-problem", state: "running", outcome: null,
    revision: 7, activeSnapshotId: "snapshot-alpha", selectedProblemIds: ["problem-alpha"],
    counts: { requested: 2, attempted: 0, validated: 0, accepted: 0, duplicate: 0, unresolved: 0, failed: 0, missing: 2, existing: 0, addedBySession: 0, total: 0 },
    limits: { maxMinutes: 30, maxModelCalls: 20, maxSearches: 10 }, budget: { modelCalls: { limit: 20, spent: 1, reserved: 0, uncertain: 0 }, searches: { limit: 10, spent: 0, reserved: 0, uncertain: 0 }, remainingMs: 10000 },
    currentStage: "research", stopReason: null, startedAt: date, finishedAt: null,
  });
  const frame = ResearchFrameSchema.parse({ goal: "Shorten synthetic inventory approval delays", goalKind: "process-improvement", contextFacts: [], successCriteria: [{ id: "approval-time", name: "Faster approvals", weight: "must", howJudged: "Measure approval time", basis: "brief" }], constraints: [], languages: ["en"], areas: [], exclusions: [], openQuestions: [] });
  const researchFrame = { id: "frame-alpha", version: 1, knownProblem: true, draft: frame, approved: frame, sources: [], createdAt: date, approvedAt: date };
  const tasks: z.infer<typeof WorkflowTaskSchema>[] = [{ id: "task-alpha", terminalAttemptId: "attempt-alpha", parentItemId: null, kind: "research", scopeKey: "area-alpha", state: "unknown", createdAt: date, finishedAt: date, canReassessProblems: true }];
  const workspace = WorkspaceStateSchema.parse({
    validation: { exa: { valid: true }, perplexity: { valid: true }, native: { available: true, connected: true, accounts: [] }, setupComplete: true },
    threads: [thread], activeThreadId: thread.id, messages: [], scope, runConfig: config, models: [config.model], modelOptions: [], modelCatalog: { models: [config.model], favorites: [] }, presets: [],
    problemCandidates: [{ id: "problem-alpha", statement: "Synthetic approvals delay orders", whyItPersists: "Manual coordination", affected: "Workshop managers", scaleEstimate: "Unknown", verdict: "confirmed", verdictReason: "Two synthetic accounts", selected: true, factors: [], intendedBuyerEvidenceFactorIds: [], evidenceGap: null, singleHarvestModeWarning: false, developmentCompleted: false }], rejectedProblemCandidates: [],
    solutions: [{ id: "idea-alpha", runId: "research-alpha", problemId: "problem-alpha", problemStatement: "Synthetic approvals delay orders", problemVerdict: "confirmed", factors: [], mechanism: "Shared approval queue", description: "A synthetic approval queue", respectsOffLimits: true, respectsOffLimitsWhy: "Within scope", outcomes: [], risks: [], confirmedCoreOutcomes: 0, unaddressedCatastrophicRisks: 0, workflowVersion: 2, userDecision: "Saved decision", observedResult: "Saved observation", experimentOutcome: "not-run" }],
    latestResearchRun: null, pendingRuns: [], activeWorkflow: summary,
    researchRequests: [{ id: "request-alpha", kind: "new-question", question: "How do approvals work?", status: "completed", resultFindings: [] }],
    researchFindings: [{ id: "finding-alpha", statement: "Synthetic approval delays recur", verdict: "confirmed", verdictReason: "Saved quotes", evidenceGap: null, supportingSources: [], verdictSources: [] }],
  });
  const settings = defaultLaunchSettings(scope, config);
  settings.mode = "babysit";
  const project = GetProjectResultSchema.parse({ thread, workspace, launchSettings: settings, draft: buildSavedLaunchDraft(scope, config, settings), resumableDevelopment: false });
  const conversation = IdeaConversationSchema.parse({ rootSolutionId: "idea-alpha", selectedVersionId: "idea-version", defaultModel: config.model,
    versions: ["idea-alpha", "idea-version"].map((solutionId, index) => ({ solutionId, parentSolutionId: index ? "idea-alpha" : null, versionNumber: index + 1, evidenceSnapshotId: "snapshot-alpha", changeSummary: index ? "Smaller approval workflow" : null, mechanism: "Shared approval queue", description: "Synthetic description", reviewFreshness: "unreviewed", model: { providerId: "saved-provider", modelId: "saved-model" }, reasoningEffort: "saved-effort" })),
    branches: [{ branchId: "branch-alpha", headTurnId: "turn-alpha", turnCount: 1 }], turns: [], nextCursor: null,
  });
  const calls: { channel: string; payload: unknown }[] = [];
  const executed: { channel: string; payload: unknown }[] = [];
  const proposals: OperationProposal[] = [];
  const lines: unknown[] = [];
  const controller = new AbortController();
  let closed = 0;
  let subscribed = 0;
  let readyResolve: () => void = () => {};
  const ready = new Promise<void>(resolve => { readyResolve = resolve; });
  const listeners = new Map<(event: ResearchEvent) => void, { resolve(): void; reject(error: unknown): void }>();
  let legacy = false;
  let readHook: (() => void) | undefined;
  const ids: Record<EntityKind, string[]> = { project: [thread.id], workflow: [summary.sessionId], run: ["research-alpha", "research-beta", "legacy-alpha"], source: ["source-alpha"], idea: ["idea-alpha", "idea-version"], problem: ["problem-alpha"], family: ["family-alpha", "family-beta"], membership: ["membership-alpha"], task: ["task-alpha"], finding: ["finding-alpha", "finding-beta"], request: ["request-alpha"], snapshot: ["snapshot-alpha"], frame: ["frame-alpha"], turn: ["turn-alpha", "turn-earlier"], branch: ["branch-alpha"], attempt: ["attempt-alpha"] };
  function detail(cursor = "0") {
    const offset = Number(cursor);
    return WorkflowDetailSchema.parse({ summary, tasks: tasks.slice(offset, offset + 30), nextCursor: offset + 30 < tasks.length ? String(offset + 30) : null, researchFrame, latestResearchFrame: researchFrame });
  }
  function catalog() {
    return ListRunsResultSchema.parse({ runs: [
      { kind: "workflow", id: summary.sessionId, sessionId: summary.sessionId, threadId: thread.id, threadTitle: thread.title, purpose: summary.purpose, state: summary.state, outcome: summary.outcome, revision: summary.revision, researchRunIds: ["research-alpha", "research-beta"], startedAt: date, finishedAt: null },
      ...["research-alpha", "research-beta", "legacy-alpha"].map(runId => ({ kind: "research", id: runId, runId, threadId: thread.id, threadTitle: thread.title, sessionId: runId.startsWith("legacy") ? null : summary.sessionId, problemId: null, purpose: "discovery", status: legacy ? "completed" : "running", interrupted: false, createdAt: date, updatedAt: date })),
    ] });
  }
  function trace(runId: string) {
    return RunTraceSchema.parse({ runId, threadId: thread.id, sessionId: summary.sessionId, status: "completed", purpose: "discovery", startedAt: date, finishedAt: date, live: false,
      metrics: { factors: 0, totalSources: 0, evidenceMix: {}, audienceFit: {}, sourceMix: {}, qualifyingObservations: 0, qualifyingPerAssessedCandidate: null, candidateFunnel: { total: 0, assessed: 0, confirmed: 0, insufficient: 0, dropped: 0, notAssessed: 0, userAsserted: 0 }, confirmationRate: null, coverage: { kind: "areas", groups: [] }, modelCalls: 1, searches: 0, wallTimeMs: 5, modelTimeMs: 5, interruptionTimeMs: 0, interruptions: 0, ideas: 0, acceptedIdeas: 0 }, steps: [], candidates: [], warnings: ["Usage unknown"] });
  }
  const extension = OpportunityBudgetExtensionPreviewSchema.parse({ current: DEFAULT_OPPORTUNITY_EXPLORATION_CONFIG, proposed: { ...DEFAULT_OPPORTUNITY_EXPLORATION_CONFIG, maxModelCalls: 14, maxSearches: 7 }, nextGap: null, estimatedAdditionalCalls: { modelCalls: 2, searches: 1 }, summary: "Two more synthetic calls" });
  async function operationResult(channel: string, payload: unknown): Promise<unknown> {
    switch (channel) {
      case IPC_CHANNELS.COMMAND_WORKFLOW: return { sessionId: summary.sessionId, revision: summary.revision, summary };
      case IPC_CHANNELS.START_WORKFLOW: return { sessionId: summary.sessionId, revision: summary.revision, summary };
      case IPC_CHANNELS.SUBMIT_IDEA_TURN: return { sessionId: summary.sessionId, revision: summary.revision, summary, turnId: "turn-new" };
      case IPC_CHANNELS.START_RESEARCH: return { workspace, runId: "legacy-alpha" };
      case IPC_CHANNELS.RESUME_RESEARCH: case IPC_CHANNELS.CANCEL_RESEARCH: return { workspace };
      case IPC_CHANNELS.SELECT_IDEA_VERSION: return conversation;
      default:
        if (isBillableOperation(channel, payload) || [IPC_CHANNELS.DISCARD_IDEA, IPC_CHANNELS.SAVE_DECISION, IPC_CHANNELS.EDIT_OPPORTUNITY_MEMBERSHIP, IPC_CHANNELS.PAUSE_OPPORTUNITY_EXPLORATION].includes(channel as typeof IPC_CHANNELS.DISCARD_IDEA)) return workspace;
        throw new Error(`Unexpected fixture operation ${channel}`);
    }
  }
  async function invoke(channel: string, payload: unknown): Promise<unknown> {
    calls.push({ channel, payload });
    let result: unknown;
    if (channel === APP_CHANNELS.PREVIEW_OPERATION) {
      const operation = OperationRequestSchema.parse(payload);
      expect(isBillableOperation(operation.channel, operation.payload)).toBe(true);
      const proposal = OperationProposalSchema.parse({ operation, previewHash: "owner-hash", expiresAt: expiry, capabilityFingerprint: "capability-hash", stateFingerprint: "state-hash", summary: "Synthetic owner proposal", billing: "billable" });
      proposals.push(proposal);
      return proposal;
    }
    if (channel === APP_CHANNELS.EXECUTE_OPERATION) {
      const { proposal } = ExecuteOperationRequestSchema.parse(payload);
      expect(proposals.some(item => JSON.stringify(item) === JSON.stringify(proposal))).toBe(true);
      executed.push(proposal.operation);
      return { channel: proposal.operation.channel, result: await operationResult(proposal.operation.channel, proposal.operation.payload) };
    }
    switch (channel) {
      case IPC_CHANNELS.GET_WORKSPACE: result = workspace; break;
      case APP_CHANNELS.GET_PROJECT: result = project; break;
      case APP_CHANNELS.LIST_RUNS: result = catalog(); break;
      case APP_CHANNELS.RESOLVE_ENTITY: {
        const input = ResolveEntityRequestSchema.parse(payload);
        const exact = ids[input.kind].filter(id => id === input.reference);
        const matches = exact.length ? exact : ids[input.kind].filter(id => id.startsWith(input.reference));
        if (matches.length !== 1) throw new CliError("INVALID_REFERENCE", "Missing or ambiguous synthetic ID.");
        result = { kind: input.kind, id: matches[0], threadId: thread.id, candidates: [] };
        break;
      }
      case IPC_CHANNELS.GET_WORKFLOW: {
        const input = z.object({ sessionId: z.string(), cursor: z.string().optional() }).parse(payload);
        result = detail(input.cursor);
        if (subscribed) { readyResolve(); readHook?.(); }
        break;
      }
      case IPC_CHANNELS.PREVIEW_WORKFLOW: {
        const input = PreviewWorkflowRequestSchema.parse(payload);
        result = { type: input.type, proposal: input.type === "launch" ? WorkflowLaunchContractSchema.parse({ ...input.draft, resolvedInstructions: { research: "saved", ideas: "saved", review: "saved" }, instructionHashes: { research: "a", ideas: "b", review: "c" } }) : input.type === "budget-extension" ? input.extension : { candidateId: input.candidateId, sourceRunId: "research-alpha", depth: "quick", modelCalls: 1, searches: 0 }, previewHash: "native-hash", capabilityFingerprint: "native-capabilities", minimumWork: { modelCalls: 1, searches: 0 }, upperLimits: summary.limits, fieldErrors: [], expiresAt: expiry };
        break;
      }
      case IPC_CHANNELS.GET_IDEA_DETAIL: {
        const input = z.object({ ideaId: z.string() }).parse(payload);
        result = { ...workspace.solutions[0], id: input.ideaId }; break;
      }
      case IPC_CHANNELS.GET_IDEA_CONVERSATION: result = conversation; break;
      case IPC_CHANNELS.GET_SOURCE_DETAIL: result = { id: "source-alpha", researchRunId: "research-alpha", url: "https://example.com/synthetic-source", title: "Synthetic inventory account", text: "Approval took two days.", contentHash: "synthetic-content-hash", retrievedAt: date }; break;
      case IPC_CHANNELS.PREVIEW_OPPORTUNITY_EXTENSION: result = extension; break;
      case IPC_CHANNELS.GET_RUN_TRACE: result = trace(z.object({ runId: z.string() }).parse(payload).runId); break;
      default:
        expect(isBillableOperation(channel, payload)).toBe(false);
        result = await operationResult(channel, payload);
    }
    return isBoxedOperation(channel) ? { ok: true, data: result } : result;
  }
  const context = createCommandContext({ signal: controller.signal, deadline: Infinity, invoke, readStdin: async () => JSON.stringify(frame), write: line => { lines.push(JSON.parse(line) as unknown); }, openExternal: async () => {}, system: async () => null,
    async subscribe(listener) {
      subscribed++;
      let resolveDone: () => void = () => {};
      let rejectDone: (error: unknown) => void = () => {};
      const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
      listeners.set(listener, { resolve: resolveDone, reject: rejectDone });
      let isClosed = false;
      return { done, close() { if (isClosed) return; isClosed = true; closed++; listeners.delete(listener); resolveDone(); } };
    },
  });
  return { context, controller, calls, executed, proposals, project, summary, conversation, tasks, frame, lines, ready,
    get closed() { return closed; }, get subscribed() { return subscribed; },
    completeLegacy() { legacy = true; },
    onRead(hook: () => void) { readHook = hook; },
    publish(event: ResearchEvent) { for (const listener of listeners.keys()) listener(event); },
    disconnect() { for (const subscription of listeners.values()) subscription.reject(new Error("Synthetic stream disconnect")); listeners.clear(); },
  };
}

function command(path: string) {
  const found = commands.find(item => item.path.join(" ") === path);
  if (!found) throw new Error(`Missing command ${path}`);
  return found;
}

function args(positionals: string[] = [], flags: CommandArguments["flags"] = {}): CommandArguments {
  return { positionals, flags };
}

const paidCases: [string, CommandArguments][] = [
  ["run start", args()], ["run start", args([], { legacy: true })],
  ["run resume", args(["session-alpha"])], ["run resume", args(["legacy-alpha"])],
  ["run frame approve", args(["session-alpha"])], ["run frame regenerate", args(["session-alpha"])],
  ["run extend", args(["session-alpha"], { calls: "2", searches: "1", minutes: "3" })],
  ["run retry", args(["session-alpha"], { task: "task-alpha", "terminal-attempt": "attempt-alpha" })],
  ["problem select", args(["problem-alpha"])], ["problem select", args(["problem-alpha"], { legacy: true })],
  ["problem assess", args(["problem-alpha"])], ["problem reassess", args([], { task: "task-alpha" })],
  ["evidence follow-up", args(["Check synthetic demand"])], ["evidence redo", args([], { finding: "finding-alpha" })],
  ["evidence reassess", args([], { finding: "finding-alpha" })],
  ["evidence follow-up", args(["Check synthetic demand"], { legacy: true, run: "legacy-alpha" })],
  ["evidence reassess", args([], { legacy: true, run: "legacy-alpha" })],
  ["idea select", args(["idea-alpha"])],
  ...(["explain", "explore-directions", "rethink"] as const).map((intent): [string, CommandArguments] => ["idea ask", args(["idea-alpha", "Consider the synthetic approval queue"], { intent })]),
  ["family review", args()], ["family explore start", args()], ["family explore resume", args()],
  ["family extend apply", args([], { calls: "2", searches: "1" })], ["experiment request", args(["idea-alpha"])],
];

test.each(paidCases)("%s without --yes only previews and never dispatches", async (path, input) => {
  const f = fixture();
  await expect(command(path).execute(f.context, input)).rejects.toMatchObject({ code: "NEEDS_CONFIRMATION", exitCode: 3 });
  expect(f.proposals).toHaveLength(1);
  expect(f.executed).toHaveLength(0);
  expect(f.calls.filter(call => call.channel === APP_CHANNELS.EXECUTE_OPERATION)).toHaveLength(0);
  expect(f.calls.some(call => call.channel === IPC_CHANNELS.COMMAND_WORKFLOW || call.channel === IPC_CHANNELS.START_RESEARCH || call.channel === IPC_CHANNELS.SUBMIT_IDEA_TURN)).toBe(false);
});

test.each(paidCases)("%s with --yes executes the unchanged owner proposal once", async (path, input) => {
  const f = fixture();
  await command(path).execute(f.context, { ...input, flags: { ...input.flags, yes: true } });
  expect(f.proposals).toHaveLength(1);
  expect(f.executed).toHaveLength(1);
  expect(f.executed[0]).toEqual(f.proposals[0]!.operation);
});

test("all 15 workflow actions, family edits and idea intents are discoverable", () => {
  expect(new Set(commands.flatMap(item => item.workflowActions ?? []))).toEqual(new Set(["assess-not-assessed", "approve-frame", "regenerate-frame", "edit-approved-frame", "request-research", "apply-research", "keep-research", "generate-ideas", "pause", "resume", "stop", "retry-task", "reassess-problems", "extend-budget", "select-version"]));
  expect(command("family edit").variants).toEqual(["split", "merge-family", "move", "mark-uncertain"]);
  expect(command("idea ask").variants).toEqual(["explain", "explore-directions", "rethink"]);
});

test("retry preserves terminal attempt identity and never derives unknown acknowledgment from --yes", async () => {
  const f = fixture();
  await command("run retry").execute(f.context, args(["session-alpha"], { yes: true, task: "task-a", "terminal-attempt": "attempt-a" }));
  const payload = CommandWorkflowRequestSchema.parse(f.executed[0]!.payload);
  expect(payload.expectedRevision).toBe(7);
  expect(payload.clientCommandId.length).toBeGreaterThan(0);
  expect(payload.action).toEqual({ type: "retry-task", taskId: "task-alpha", expectedTerminalAttemptId: "attempt-alpha" });
  const acknowledged = fixture();
  await command("run retry").execute(acknowledged.context, args(["session-alpha"], { yes: true, task: "task-a", "terminal-attempt": "attempt-a", "acknowledge-unknown-completion": true }));
  expect(CommandWorkflowRequestSchema.parse(acknowledged.executed[0]!.payload).action).toMatchObject({ acknowledgeUnknownCompletion: true });
});

test("Controlled approval then selected-problem generation uses the saved snapshot and explicit model", async () => {
  const f = fixture();
  await command("run frame approve").execute(f.context, args(["session-alpha"], { yes: true }));
  expect(CommandWorkflowRequestSchema.parse(f.executed[0]!.payload).action).toEqual({ type: "approve-frame", frameId: "frame-alpha", frame: f.frame });
  f.summary.state = "waiting-for-review";
  await command("problem select").execute(f.context, args(["problem-a"], { yes: true, model: "explicit-provider:explicit-model", effort: "explicit-effort", count: "2", "review-model": "review-provider:review-model", "review-effort": "review-effort" }));
  expect(CommandWorkflowRequestSchema.parse(f.executed[1]!.payload).action).toEqual({ type: "generate-ideas", snapshotId: "snapshot-alpha", problemIds: ["problem-alpha"], model: { providerId: "explicit-provider", modelId: "explicit-model" }, reasoningEffort: "explicit-effort", reviewModel: { providerId: "review-provider", modelId: "review-model" }, reviewReasoningEffort: "review-effort", target: { kind: "per-problem", count: 2 } });
});

test.each([
  [{}, { kind: "project", count: 5 }],
  [{ count: "9" }, { kind: "project", count: 9 }],
  [{ target: "per-problem" }, { kind: "per-problem", count: 1 }],
  [{ target: "per-problem", count: "4" }, { kind: "per-problem", count: 4 }],
] satisfies [CommandArguments["flags"], { kind: "project" | "per-problem"; count: number }][])("problem selection previews the resolved target count with overrides %j", async (flags, expected) => {
  const f = fixture();
  f.summary.state = "waiting-for-review";
  f.project.launchSettings.targets = { kind: "project", ideaCount: 1, distinctBusinessCount: 5 };
  if (!f.project.draft || !f.project.workspace.runConfig) throw new Error("Missing synthetic launch configuration");
  f.project.draft.targets = { kind: "project", ideaCount: 2, distinctBusinessCount: 6 };
  f.project.workspace.runConfig = { ...f.project.workspace.runConfig, ideaCount: 3, explorationPurpose: "startup-opportunities", opportunityExploration: { ...DEFAULT_OPPORTUNITY_EXPLORATION_CONFIG, targetFamilies: 8, maxRawCandidates: 16 } };
  await expect(command("problem select").execute(f.context, args(["problem-a"], flags))).rejects.toMatchObject({ code: "NEEDS_CONFIRMATION", exitCode: 3 });
  expect(CommandWorkflowRequestSchema.parse(f.proposals[0]!.operation.payload).action).toMatchObject({ type: "generate-ideas", target: expected });
  expect(f.project.launchSettings.targets).toEqual({ kind: "project", ideaCount: 1, distinctBusinessCount: 5 });
  expect(f.executed).toHaveLength(0);
  expect(f.calls.some(call => call.channel === APP_CHANNELS.EXECUTE_OPERATION)).toBe(false);
});

test.each([
  ["draft distinct-business count", { kind: "project", ideaCount: 2, distinctBusinessCount: 6 }, 6],
  ["legacy family count", { kind: "project", ideaCount: 2 }, 8],
] satisfies [string, { kind: "project"; ideaCount: number; distinctBusinessCount?: number }, number][])("problem selection falls back to the %s before an idea count", async (_source, draftTarget, expected) => {
  const f = fixture();
  f.summary.state = "waiting-for-review";
  if (!f.project.draft || !f.project.workspace.runConfig) throw new Error("Missing synthetic launch configuration");
  f.project.launchSettings.targets = { kind: "project", ideaCount: 1 };
  f.project.draft.targets = draftTarget;
  f.project.workspace.runConfig = { ...f.project.workspace.runConfig, ideaCount: 3, explorationPurpose: "startup-opportunities", opportunityExploration: { ...DEFAULT_OPPORTUNITY_EXPLORATION_CONFIG, targetFamilies: 8, maxRawCandidates: 16 } };
  await expect(command("problem select").execute(f.context, args(["problem-a"]))).rejects.toMatchObject({ code: "NEEDS_CONFIRMATION", exitCode: 3 });
  expect(CommandWorkflowRequestSchema.parse(f.proposals[0]!.operation.payload).action).toMatchObject({ type: "generate-ideas", target: { kind: "project", count: expected } });
  expect(f.executed).toHaveLength(0);
});

test("reevaluation has zero searches, and an explicit nonzero allowance is rejected before admission", async () => {
  const f = fixture();
  await command("evidence reassess").execute(f.context, args([], { finding: "finding-a", yes: true }));
  expect(CommandWorkflowRequestSchema.parse(f.executed[0]!.payload).action).toMatchObject({ type: "request-research", kind: "reevaluate", targetFindingId: "finding-alpha", allowance: { maxModelCalls: 1, maxSearches: 0 } });
  const invalid = fixture();
  await expect(command("evidence reassess").execute(invalid.context, args([], { finding: "finding-a", searches: "1", yes: true }))).rejects.toBeInstanceOf(z.ZodError);
  expect(invalid.proposals).toHaveLength(0);
});

test("apply and keep preserve request, replacement and expected snapshot identities without spending", async () => {
  const f = fixture();
  await command("evidence apply").execute(f.context, args([], { include: ["request-a"], replace: ["finding-alpha=finding-beta"], snapshot: "snapshot-a" }));
  const apply = f.calls.find(call => call.channel === IPC_CHANNELS.COMMAND_WORKFLOW);
  expect(CommandWorkflowRequestSchema.parse(apply?.payload).action).toEqual({ type: "apply-research", baseSnapshotId: "snapshot-alpha", includedRequestIds: ["request-alpha"], replacements: [{ oldFindingId: "finding-alpha", newFindingId: "finding-beta" }] });
  await command("evidence keep").execute(f.context, args(["request-a"], { snapshot: "snapshot-a" }));
  expect(CommandWorkflowRequestSchema.parse(f.calls.filter(call => call.channel === IPC_CHANNELS.COMMAND_WORKFLOW).at(-1)?.payload).action).toEqual({ type: "keep-research", requestId: "request-alpha", baseSnapshotId: "snapshot-alpha" });
  expect(f.proposals).toHaveLength(0);
});

test("idea asks pin the root, base version, branch head, evidence and exact saved model", async () => {
  const f = fixture();
  await command("idea ask").execute(f.context, args(["idea-alpha", "A multiline message\nwith a second line"], { intent: "rethink", yes: true }));
  expect(f.executed[0]!.payload).toMatchObject({ threadId: "project-alpha", rootSolutionId: "idea-alpha", baseSolutionId: "idea-version", branchId: "branch-alpha", expectedHeadTurnId: "turn-alpha", parentTurnId: "turn-alpha", intent: "rethink", text: "A multiline message\nwith a second line", evidenceSnapshotId: "snapshot-alpha", model: { providerId: "saved-provider", modelId: "saved-model" }, reasoningEffort: "saved-effort", allowance: { maxModelCalls: 2, maxMinutes: 2 } });
  const fork = fixture();
  await command("idea ask").execute(fork.context, args(["idea-alpha", "Try another approach"], { intent: "explain", "branch-from-earlier": true, parent: "turn-earlier", yes: true }));
  expect(fork.executed[0]!.payload).toMatchObject({ expectedHeadTurnId: null, parentTurnId: "turn-earlier", branchFromEarlier: true });
  expect(fork.executed[0]!.payload).not.toHaveProperty("branchId");
});

test("free source, idea, version and decision reads preserve saved content and dispatch no work", async () => {
  const f = fixture();
  expect(await command("source show").execute(f.context, args(["source-a"]))).toMatchObject({ id: "source-alpha", text: "Approval took two days.", researchRunId: "research-alpha" });
  expect(await command("idea show").execute(f.context, args(["idea-v"]))).toMatchObject({ id: "idea-version", mechanism: "Shared approval queue" });
  await command("idea discard").execute(f.context, args(["idea-alpha"]));
  await command("idea restore").execute(f.context, args(["idea-alpha"]));
  expect(f.calls.filter(call => call.channel === IPC_CHANNELS.DISCARD_IDEA).map(call => call.payload)).toEqual([
    { threadId: "project-alpha", ideaId: "idea-alpha", discarded: true }, { threadId: "project-alpha", ideaId: "idea-alpha", discarded: false },
  ]);
  await command("idea decide").execute(f.context, args(["idea-alpha"], { outcome: "inconclusive" }));
  expect(f.calls.find(call => call.channel === IPC_CHANNELS.SAVE_DECISION)?.payload).toEqual({ threadId: "project-alpha", solutionId: "idea-alpha", userDecision: "Saved decision", observedResult: "Saved observation", experimentOutcome: "inconclusive" });
  await command("idea version select").execute(f.context, args(["idea-alpha", "idea-v"]));
  expect(f.calls.find(call => call.channel === IPC_CHANNELS.SELECT_IDEA_VERSION)?.payload).toEqual({ threadId: "project-alpha", rootSolutionId: "idea-alpha", solutionId: "idea-version" });
  expect(f.executed).toHaveLength(0);
  expect(f.proposals).toHaveLength(0);
  expect(f.calls.some(call => call.channel === IPC_CHANNELS.SELECT_THREAD)).toBe(false);
});

test("family review consent and ambiguous-completion acknowledgment remain separate", async () => {
  const f = fixture();
  await command("family review").execute(f.context, args([], { yes: true }));
  expect(f.executed[0]!.payload).not.toHaveProperty("allowAmbiguousRetry");
  await command("family review").execute(f.context, args([], { yes: true, "acknowledge-unknown-completion": true }));
  expect(f.executed[1]!.payload).toMatchObject({ allowAmbiguousRetry: true });
});

test.each([
  ["split", "idea-alpha", { title: "Separate queue", summary: "A synthetic family", reason: "Different buyer" }],
  ["merge-family", "family-alpha", { target: "family-beta", reason: "Same business" }],
  ["move", "idea-alpha", { target: "family-beta", relationship: "variant", reason: "Same workflow" }],
  ["mark-uncertain", "idea-alpha", { reason: "Insufficient comparison" }],
] satisfies [string, string, CommandArguments["flags"]][])("family edit %s uses the complete real membership schema", async (operation, id, flags) => {
  const f = fixture();
  await command("family edit").execute(f.context, args([operation, id], flags));
  expect(f.calls.some(call => call.channel === IPC_CHANNELS.EDIT_OPPORTUNITY_MEMBERSHIP)).toBe(true);
  expect(f.proposals).toHaveLength(0);
});

test("native proof and stable generated identity survive an explicit saved launch proposal", async () => {
  const f = fixture();
  await expect(command("run start").execute(f.context, args())).rejects.toMatchObject({ exitCode: 3 });
  const proposal = f.proposals[0]!;
  expect(proposal.operation.payload).toMatchObject({ previewHash: "native-hash", capabilityFingerprint: "native-capabilities", previewExpiresAt: expiry });
  const directory = await mkdtemp(join(tmpdir(), "scraply-cli-domain-"));
  try {
    const path = join(directory, "proposal.json");
    await writeFile(path, JSON.stringify(proposal));
    await command("run start").execute(f.context, args([], { yes: true, "preview-file": path }));
    expect(f.executed[0]).toEqual(proposal.operation);
    expect(f.proposals).toHaveLength(1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("run show reads every requested task page and trace resolves actual research IDs", async () => {
  const f = fixture();
  for (let index = 1; index < 65; index++) f.tasks.push({ ...f.tasks[0]!, id: `task-${index}` });
  const detail = WorkflowDetailSchema.parse(await command("run show").execute(f.context, args(["session-alpha"], { all: true })));
  expect(detail.tasks).toHaveLength(65);
  expect(detail.nextCursor).toBeNull();
  await command("run trace").execute(f.context, args(["session-alpha"], { tasks: true }));
  const traces = f.calls.filter(call => call.channel === IPC_CHANNELS.GET_RUN_TRACE).map(call => call.payload);
  expect(traces).toEqual([{ runId: "research-alpha" }, { runId: "research-beta" }]);
  expect(f.calls.some(call => call.channel === IPC_CHANNELS.SELECT_THREAD)).toBe(false);
});

test("legacy cancellation uses a research ID and modern cancellation uses normal workflow stop", async () => {
  const f = fixture();
  await command("run cancel").execute(f.context, args(["research-alpha"]));
  expect(CommandWorkflowRequestSchema.parse(f.calls.find(call => call.channel === IPC_CHANNELS.COMMAND_WORKFLOW)?.payload).action).toEqual({ type: "stop" });
  await command("run cancel").execute(f.context, args(["research-alpha"], { legacy: true }));
  expect(f.calls.find(call => call.channel === IPC_CHANNELS.CANCEL_RESEARCH)?.payload).toEqual({ runId: "research-alpha" });
  expect(f.project.draft?.frameWorkflowVersion).toBe(1);
});

test("watch subscribes before reconciliation, filters session and research IDs, then returns partial outcome", async () => {
  const f = fixture();
  const watching = command("run watch").execute(f.context, args(["session-alpha"]));
  await f.ready;
  f.publish({ type: "app-state-changed", threadId: "project-alpha" });
  f.publish({ type: "run-progress", runId: "unrelated-run", threadId: "project-alpha", message: "Ignore", codexCalls: 1, searches: 0 });
  f.publish({ type: "run-progress", runId: "research-beta", threadId: "project-alpha", message: "Saved progress", codexCalls: 1, searches: 0 });
  f.summary.state = "finished";
  f.summary.outcome = "partial";
  f.publish({ type: "workflow-progress", sessionId: "session-alpha", threadId: "project-alpha", revision: 8, state: "finished", outcome: "partial", changedTaskIds: [], counts: f.summary.counts });
  await watching;
  expect(f.subscribed).toBe(1);
  expect(f.closed).toBe(1);
  expect(f.lines).toEqual([
    { type: "run-progress", runId: "research-beta", threadId: "project-alpha", message: "Saved progress", codexCalls: 1, searches: 0 },
    { type: "workflow-progress", sessionId: "session-alpha", threadId: "project-alpha", revision: 8, state: "finished", outcome: "partial", changedTaskIds: [], counts: f.summary.counts },
    { type: "watch-end", state: "finished", outcome: "partial" },
  ]);
  expect(f.executed).toHaveLength(0);
});

test.each(["paused", "waiting-for-review", "finished"] as const)("watch reconciles a fast %s with honest nullable outcome", async state => {
  const f = fixture();
  f.summary.state = state;
  await command("run watch").execute(f.context, args(["session-alpha"]));
  expect(f.subscribed).toBe(1);
  expect(f.lines).toEqual([{ type: "watch-end", state, outcome: null }]);
  expect(f.closed).toBe(1);
});

test("watch timeout and Ctrl+C close only the stream and leave the run running", async () => {
  for (const reason of [new CliError("CLIENT_TIMEOUT", "Synthetic deadline", 5), new CliError("INTERRUPTED", "Synthetic Ctrl+C", 0)]) {
    const f = fixture();
    const watching = command("run watch").execute(f.context, args(["session-alpha"]));
    const settled = watching.then(() => undefined, error => error as unknown);
    await f.ready;
    f.controller.abort(reason);
    expect(await settled).toBe(reason);
    expect(f.closed).toBe(1);
    expect(f.summary.state).toBe("running");
    expect(f.calls.some(call => call.channel === IPC_CHANNELS.COMMAND_WORKFLOW || call.channel === IPC_CHANNELS.CANCEL_RESEARCH)).toBe(false);
    expect(f.lines.at(-1)).toMatchObject({ type: "watch-end", outcome: null });
  }
});

test("watch reconciles a lost finish on disconnect without replaying a command", async () => {
  const f = fixture();
  const watching = command("run watch").execute(f.context, args(["session-alpha"]));
  await f.ready;
  f.summary.state = "finished";
  f.summary.outcome = "no-qualifying-ideas";
  f.disconnect();
  await watching;
  expect(f.lines.at(-1)).toEqual({ type: "watch-end", state: "finished", outcome: "no-qualifying-ideas" });
  expect(f.executed).toHaveLength(0);
});

test("watch resubscribes before reconciliation after a disconnect and never replays admissions", async () => {
  const f = fixture();
  let finished = false;
  f.onRead(() => {
    if (f.subscribed !== 2 || finished) return;
    finished = true;
    f.summary.state = "finished";
    f.summary.outcome = "target-met";
    f.publish({ type: "workflow-progress", sessionId: "session-alpha", threadId: "project-alpha", revision: 8, state: "finished", outcome: "target-met", changedTaskIds: [], counts: f.summary.counts });
  });
  const watching = command("run watch").execute(f.context, args(["session-alpha"]));
  await f.ready;
  f.disconnect();
  await watching;
  expect(f.subscribed).toBe(2);
  expect(f.closed).toBe(2);
  expect(f.lines.at(-1)).toEqual({ type: "watch-end", state: "finished", outcome: "target-met" });
  expect(f.executed).toHaveLength(0);
});
