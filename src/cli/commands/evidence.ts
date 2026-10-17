import { IPC_CHANNELS } from "../../shared/ipc";
import { LaunchSettingsSchema } from "../../shared/launch-settings";
import { ModelRefSchema } from "../../shared/schemas";
import { SourceDetailSchema } from "../../shared/schemas";
import { PreviewWorkflowResultSchema, WorkflowActionSchema } from "../../shared/workflow-contracts";
import { booleanFlag, numberFlag, requirePositional, stringFlag, type CommandArguments, type FlagDefinition } from "../args";
import { CliError } from "../output";
import type { CommandDefinition } from "../registry";
import { approvalFlags, checkNativePreview, modelFlags, projectFlag, requiredFlag, sessionFlags, workflowAction, workflowTarget } from "./workflows";

const legacyFlag: FlagDefinition = { name: "legacy", type: "boolean", description: "Use the older saved research API without replacing its contract." };
const snapshotFlag: FlagDefinition = { name: "snapshot", type: "string", description: "Expected evidence snapshot ID or unique prefix; otherwise use the current workflow snapshot." };
const researchFlags: FlagDefinition[] = [
  ...sessionFlags, ...approvalFlags, ...modelFlags, snapshotFlag, legacyFlag,
  { name: "finding", type: "string", description: "Saved finding ID or unique prefix for redo or reassessment." },
  { name: "request", type: "string", description: "Saved research request ID or unique prefix to revisit." },
  { name: "calls", type: "number", description: "Model-call allowance, defaults to 12 or 1 for reassessment." },
  { name: "searches", type: "number", description: "Search allowance; reassessment requires zero." },
  { name: "minutes", type: "number", description: "Time allowance in minutes, defaults to 10." },
  { name: "angle", type: "string", multiple: true, description: "Research angle; repeat for up to four angles." },
  { name: "instructions", type: "string", description: "Instructions for this request only." },
];

export function repeatedFlag(args: CommandArguments, name: string): string[] {
  const value = args.flags[name];
  return typeof value === "string" ? [value] : Array.isArray(value) ? [...value] : [];
}

export function parseModelReference(value: string) {
  const separator = value.indexOf(":");
  if (separator < 1 || separator === value.length - 1) throw new CliError("USAGE", "Use the exact model as provider:model.", 2);
  return ModelRefSchema.parse({ providerId: value.slice(0, separator), modelId: value.slice(separator + 1) });
}

export const evidence: CommandDefinition[] = [
  { path: ["source", "show"], description: "Read a saved source and its original quoted content.", positionals: [{ name: "id", description: "Source ID or unique prefix.", required: true }], flags: [projectFlag], channels: [IPC_CHANNELS.GET_SOURCE_DETAIL], billing: "free",
    async execute(context, args) {
      const selector = stringFlag(args, "project");
      const project = selector ? await context.project(selector) : undefined;
      const source = await context.resolve("source", requirePositional(args, 0, "scraply source show <source>"), project?.thread.id);
      return SourceDetailSchema.parse(await context.invoke(IPC_CHANNELS.GET_SOURCE_DETAIL, { sourceId: source.id }));
    },
  },
  { path: ["problem", "list"], description: "List selectable problems, rejected candidates, and read-only leads separately.", flags: [projectFlag], channels: [], billing: "free",
    async execute(context, args) {
      const { workspace } = await context.project(stringFlag(args, "project"));
      return { problems: workspace.problemCandidates, rejected: workspace.rejectedProblemCandidates, leads: workspace.problemLeads ?? [], snapshotId: workspace.activeWorkflow?.activeSnapshotId ?? null };
    },
  },
  { path: ["problem", "select"], description: "Generate ideas for selected saved problems after research review. All selections require paid consent.",
    positionals: [{ name: "ids", description: "Saved problem IDs or unique prefixes, separated by spaces.", multiple: true }],
    flags: [...sessionFlags, ...approvalFlags, ...modelFlags, snapshotFlag, legacyFlag,
      { name: "count", type: "number", description: "Ideas per problem or distinct project businesses." },
      { name: "target", type: "string", choices: ["per-problem", "project"], description: "Target kind, otherwise preserve the saved target." },
      { name: "review-model", type: "string", description: "Exact independent review model as provider:model." },
      { name: "review-effort", type: "string", description: "Exact independent review effort." },
      { name: "user-problem", type: "string", description: "Legacy-only explicit problem statement." },
    ], channels: [IPC_CHANNELS.SELECT_PROBLEMS, IPC_CHANNELS.COMMAND_WORKFLOW], workflowActions: ["generate-ideas"], billing: "paid",
    async execute(context, args) {
      const explicitTarget = !booleanFlag(args, "legacy") && stringFlag(args, "run") ? await workflowTarget(context, args) : undefined;
      const project = explicitTarget?.project ?? await context.project(stringFlag(args, "project"));
      const settings = LaunchSettingsSchema.parse(project.launchSettings);
      const saved = settings.ideas;
      const choices = await context.model(args, saved && project.workspace.runConfig ? { ...project.workspace, runConfig: { ...project.workspace.runConfig, model: saved.model, reasoningEffort: saved.reasoningEffort } } : project.workspace);
      const problemIds: string[] = [];
      for (const id of args.positionals.flatMap(value => value.split(",")).filter(Boolean)) problemIds.push((await context.resolve("problem", id, project.thread.id)).id);
      if (booleanFlag(args, "legacy") || (!project.workspace.activeWorkflow && !stringFlag(args, "run"))) {
        return context.previewAndExecute(IPC_CHANNELS.SELECT_PROBLEMS, { threadId: project.thread.id, problemIds, userProblem: stringFlag(args, "user-problem") ?? null, ...choices }, args);
      }
      if (stringFlag(args, "user-problem")) throw new CliError("INVALID_REFERENCE", "Start a new known-problem run to use a new problem statement.");
      const target = explicitTarget ?? await workflowTarget(context, args);
      const snapshot = stringFlag(args, "snapshot");
      const snapshotId = snapshot ? (await context.resolve("snapshot", snapshot, project.thread.id)).id : target.detail.summary.activeSnapshotId;
      if (!snapshotId) throw new CliError("INVALID_REFERENCE", "Review and apply research before selecting problems.");
      const selected = problemIds.length ? problemIds : target.detail.summary.selectedProblemIds;
      const savedTarget = settings.targets;
      const targetKind = stringFlag(args, "target") ?? savedTarget?.kind ?? (project.workspace.runConfig?.opportunityExploration ? "project" : project.draft?.targets.kind ?? "per-problem");
      const ideaCount = savedTarget?.ideaCount ?? project.draft?.targets.ideaCount ?? project.workspace.runConfig?.ideaCount ?? 3;
      const defaultCount = targetKind === "project"
        ? savedTarget?.distinctBusinessCount ?? project.draft?.targets.distinctBusinessCount ?? project.workspace.runConfig?.opportunityExploration?.targetFamilies ?? ideaCount
        : ideaCount;
      const targetCount = numberFlag(args, "count") ?? defaultCount;
      const reviewModel = stringFlag(args, "review-model");
      const reviewEffort = stringFlag(args, "review-effort") ?? saved?.reviewReasoningEffort;
      const action = WorkflowActionSchema.parse({ type: "generate-ideas", snapshotId, problemIds: selected, ...choices,
        ...((reviewModel ? parseModelReference(reviewModel) : saved?.reviewModel) ? { reviewModel: reviewModel ? parseModelReference(reviewModel) : saved?.reviewModel } : {}),
        ...(reviewEffort ? { reviewReasoningEffort: reviewEffort } : {}),
        target: { kind: targetKind, count: targetCount },
      });
      return workflowAction(context, args, target, action);
    },
  },
  { path: ["problem", "assess"], description: "Assess a saved candidate using its native hash and expiry before paid admission.", positionals: [{ name: "id", description: "Unassessed candidate ID or unique prefix.", required: true }], flags: [...sessionFlags, ...approvalFlags],
    channels: [IPC_CHANNELS.PREVIEW_WORKFLOW, IPC_CHANNELS.COMMAND_WORKFLOW], workflowActions: ["assess-not-assessed"], billing: "paid",
    async execute(context, args) {
      const target = await workflowTarget(context, args);
      const candidateId = (await context.resolve("problem", requirePositional(args, 0, "scraply problem assess <candidate> --run <session>"), target.project.thread.id)).id;
      const preview = PreviewWorkflowResultSchema.parse(await context.invoke(IPC_CHANNELS.PREVIEW_WORKFLOW, { type: "candidate-assessment", threadId: target.project.thread.id, sessionId: target.detail.summary.sessionId, expectedRevision: numberFlag(args, "revision") ?? target.detail.summary.revision, candidateId }));
      checkNativePreview(preview);
      return workflowAction(context, args, target, { type: "assess-not-assessed", candidateId, previewHash: preview.previewHash, capabilityFingerprint: preview.capabilityFingerprint, previewExpiresAt: preview.expiresAt });
    },
  },
  { path: ["problem", "reassess"], description: "Retry audience assessment for an eligible saved task.", flags: [...sessionFlags, ...approvalFlags, { name: "task", type: "string", required: true, description: "Eligible task ID or unique prefix." }], channels: [IPC_CHANNELS.COMMAND_WORKFLOW], workflowActions: ["reassess-problems"], billing: "paid",
    async execute(context, args) {
      const target = await workflowTarget(context, args);
      const taskId = (await context.resolve("task", requiredFlag(args, "task", "scraply problem reassess --run <session> --task <task>"), target.project.thread.id)).id;
      return workflowAction(context, args, target, { type: "reassess-problems", taskId });
    },
  },
  ...(["follow-up", "redo", "reassess"] as const).map((verb): CommandDefinition => ({
    path: ["evidence", verb], description: verb === "reassess" ? "Reevaluate a finding's saved evidence with zero searches." : verb === "redo" ? "Request replacement evidence for a saved finding." : "Research a new question without changing the current evidence snapshot.",
    positionals: [{ name: "question", description: "Question to investigate; redo and reassess may use the saved finding statement.", required: verb === "follow-up", multiple: true }], flags: researchFlags,
    channels: [IPC_CHANNELS.COMMAND_WORKFLOW, ...(verb === "follow-up" ? [IPC_CHANNELS.EVIDENCE_FOLLOW_UP] : verb === "reassess" ? [IPC_CHANNELS.EVIDENCE_REASSESSMENT] : [])], workflowActions: ["request-research"], billing: "paid",
    async execute(context, args) {
      if (booleanFlag(args, "legacy")) {
        if (verb === "redo") throw new CliError("USAGE", "Legacy evidence has no redo command. Use evidence follow-up or reassess with --legacy.", 2);
        const selector = stringFlag(args, "project");
        const addressedProject = selector ? await context.project(selector) : undefined;
        const run = await context.resolve("run", requiredFlag(args, "run", `scraply evidence ${verb} --legacy --run <research-run>`), addressedProject?.thread.id);
        const project = addressedProject ?? await context.project(run.threadId);
        return context.previewAndExecute(verb === "follow-up" ? IPC_CHANNELS.EVIDENCE_FOLLOW_UP : IPC_CHANNELS.EVIDENCE_REASSESSMENT, { threadId: project.thread.id, runId: run.id, ...(verb === "follow-up" ? { question: args.positionals.join(" ") } : {}) }, args);
      }
      const target = await workflowTarget(context, args);
      const finding = stringFlag(args, "finding");
      const findingId = finding ? (await context.resolve("finding", finding, target.project.thread.id)).id : undefined;
      const request = stringFlag(args, "request");
      const requestId = request ? (await context.resolve("request", request, target.project.thread.id)).id : undefined;
      const snapshot = stringFlag(args, "snapshot");
      const snapshotId = snapshot ? (await context.resolve("snapshot", snapshot, target.project.thread.id)).id : target.detail.summary.activeSnapshotId;
      const statement = target.project.workspace.researchFindings.find(item => item.id === findingId)?.statement;
      const question = args.positionals.join(" ") || (statement ? `${verb === "redo" ? "Find new evidence about" : "Reevaluate the saved evidence for"}: ${statement}` : "");
      if (!question) throw new CliError("USAGE", `Supply a question and finding. Next command: scraply evidence ${verb} <question> --finding <finding> --run <session>`, 2);
      const choices = await context.model(args, target.project.workspace);
      const angles = repeatedFlag(args, "angle");
      const instructions = stringFlag(args, "instructions");
      const languages = target.detail.latestResearchFrame?.approved?.languages.length ?? target.detail.researchFrame?.approved?.languages.length ?? 1;
      const action = WorkflowActionSchema.parse({ type: "request-research", kind: verb === "follow-up" ? "new-question" : verb === "redo" ? "redo" : "reevaluate", question,
        ...(snapshotId ? { baseSnapshotId: snapshotId } : {}), ...(findingId ? { targetFindingId: findingId } : {}), ...(requestId ? { targetRequestId: requestId } : {}),
        ...choices, allowance: { maxModelCalls: numberFlag(args, "calls") ?? (verb === "reassess" ? 1 : 12), maxSearches: numberFlag(args, "searches") ?? (verb === "reassess" ? 0 : Math.max(10, 4 * languages)), maxMinutes: numberFlag(args, "minutes") ?? 10 },
        ...(angles.length ? { angles } : {}), ...(instructions ? { instructions } : {}),
      });
      return workflowAction(context, args, target, action);
    },
  })),
  { path: ["evidence", "apply"], description: "Apply explicit completed requests and finding replacements to a new evidence snapshot.", flags: [...sessionFlags, snapshotFlag, { name: "include", type: "string", multiple: true, description: "Included request ID or unique prefix; repeat for each request." }, { name: "replace", type: "string", multiple: true, description: "Finding replacement as oldFinding=newFinding; repeat for each pair." }], channels: [IPC_CHANNELS.COMMAND_WORKFLOW], workflowActions: ["apply-research"], billing: "free",
    async execute(context, args) {
      const target = await workflowTarget(context, args);
      const snapshot = stringFlag(args, "snapshot");
      const baseSnapshotId = snapshot ? (await context.resolve("snapshot", snapshot, target.project.thread.id)).id : target.detail.summary.activeSnapshotId;
      const includedRequestIds: string[] = [];
      for (const id of repeatedFlag(args, "include")) includedRequestIds.push((await context.resolve("request", id, target.project.thread.id)).id);
      const replacements: { oldFindingId: string; newFindingId: string }[] = [];
      for (const pair of repeatedFlag(args, "replace")) {
        const parts = pair.split("=");
        if (parts.length !== 2 || !parts[0] || !parts[1]) throw new CliError("USAGE", "Use --replace <old-finding>=<new-finding>.", 2);
        replacements.push({ oldFindingId: (await context.resolve("finding", parts[0], target.project.thread.id)).id, newFindingId: (await context.resolve("finding", parts[1], target.project.thread.id)).id });
      }
      return workflowAction(context, args, target, { type: "apply-research", ...(baseSnapshotId ? { baseSnapshotId } : {}), includedRequestIds, replacements });
    },
  },
  { path: ["evidence", "keep"], description: "Keep the current snapshot and explicitly dismiss one completed request.", positionals: [{ name: "request", description: "Request ID or unique prefix to keep unapplied.", required: true }], flags: [...sessionFlags, snapshotFlag], channels: [IPC_CHANNELS.COMMAND_WORKFLOW], workflowActions: ["keep-research"], billing: "free",
    async execute(context, args) {
      const target = await workflowTarget(context, args);
      const requestId = (await context.resolve("request", requirePositional(args, 0, "scraply evidence keep <request> --run <session>"), target.project.thread.id)).id;
      const snapshot = stringFlag(args, "snapshot");
      const baseSnapshotId = snapshot ? (await context.resolve("snapshot", snapshot, target.project.thread.id)).id : target.detail.summary.activeSnapshotId;
      return workflowAction(context, args, target, { type: "keep-research", requestId, ...(baseSnapshotId ? { baseSnapshotId } : {}) });
    },
  },
];
