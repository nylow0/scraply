import { randomUUID } from "node:crypto";
import { IPC_CHANNELS, SaveDecisionSchema, SelectOptionSchema, SolutionViewSchema } from "../../shared/ipc";
import { IdeaConversationSchema, IdeaTurnIntentSchema, SelectIdeaVersionRequestSchema, SubmitIdeaTurnRequestSchema } from "../../shared/workflow-contracts";
import { booleanFlag, numberFlag, requirePositional, stringFlag, type CommandArguments } from "../args";
import type { CommandContext } from "../context";
import { CliError } from "../output";
import type { CommandDefinition } from "../registry";
import { approvalFlags, modelFlags, projectFlag, savedOperation, sessionFlags, workflowAction, workflowTarget } from "./workflows";

/** Resolving a historical or discarded idea must not select it or resume its review. */
export async function ideaTarget(context: CommandContext, args: CommandArguments, reference = args.positionals[0]) {
  if (!reference) throw new CliError("USAGE", "Choose an idea. Next command: scraply idea show <idea>", 2);
  const selector = stringFlag(args, "project");
  const addressedProject = selector ? await context.project(selector) : undefined;
  const resolved = await context.resolve("idea", reference, addressedProject?.thread.id);
  const idea = SolutionViewSchema.parse(await context.invoke(IPC_CHANNELS.GET_IDEA_DETAIL, { ideaId: resolved.id }));
  if (!resolved.threadId && !addressedProject) throw new CliError("INVALID_REFERENCE", "The owner did not identify this idea's project.");
  const project = addressedProject ?? await context.project(resolved.threadId);
  return { project, idea };
}

export const ideas: CommandDefinition[] = [
  { path: ["idea", "list"], description: "List saved ideas with honest review, discard, and evidence states.", flags: [projectFlag, { name: "discarded", type: "boolean", description: "Include discarded ideas." }], channels: [], billing: "free",
    async execute(context, args) {
      const { workspace } = await context.project(stringFlag(args, "project"));
      return { ideas: workspace.solutions.filter(idea => booleanFlag(args, "discarded") || !idea.discarded), groups: workspace.ideaGroups ?? [], workflow: workspace.activeWorkflow ?? null, usage: workspace.latestResearchRun?.usage ?? null };
    },
  },
  { path: ["idea", "show"], description: "Read complete saved idea content, risks, analysis, and evidence.", positionals: [{ name: "id", description: "Idea ID or unique prefix.", required: true }], flags: [projectFlag], channels: [IPC_CHANNELS.GET_IDEA_DETAIL], billing: "free",
    async execute(context, args) {
      return (await ideaTarget(context, args)).idea;
    },
  },
  { path: ["idea", "select"], description: "Select an idea and resume its paid risk review and analysis.", positionals: [{ name: "id", description: "Idea ID or unique prefix.", required: true }], flags: [projectFlag, ...approvalFlags], channels: [IPC_CHANNELS.SELECT_OPTION], billing: "paid",
    async execute(context, args) {
      const { project, idea } = await ideaTarget(context, args);
      if (!idea.runId) throw new CliError("INVALID_REFERENCE", "This idea has no saved source run.");
      return context.previewAndExecute(IPC_CHANNELS.SELECT_OPTION, SelectOptionSchema.parse({ threadId: project.thread.id, runId: idea.runId, solutionId: idea.id }), args);
    },
  },
  ...(["discard", "restore"] as const).map((verb): CommandDefinition => ({
    path: ["idea", verb], description: verb === "discard" ? "Mark a saved idea discarded." : "Restore a discarded idea.", positionals: [{ name: "id", description: "Idea ID or unique prefix.", required: true }], flags: [projectFlag], channels: [IPC_CHANNELS.DISCARD_IDEA], billing: "free",
    async execute(context, args) {
      const { project, idea } = await ideaTarget(context, args);
      return context.invoke(IPC_CHANNELS.DISCARD_IDEA, { threadId: project.thread.id, ideaId: idea.id, discarded: verb === "discard" });
    },
  })),
  { path: ["idea", "decide"], description: "Save a decision and observed result for an idea with saved analysis.", positionals: [{ name: "id", description: "Idea ID or unique prefix.", required: true }], flags: [projectFlag,
    { name: "decision", type: "string", description: "Your decision; omitted text preserves the saved value." },
    { name: "result", type: "string", description: "Observed result; omitted text preserves the saved value." },
    { name: "outcome", type: "string", choices: ["not-run", "pass", "fail", "inconclusive"], description: "Focused experiment outcome; omitted preserves the saved value." },
  ], channels: [IPC_CHANNELS.SAVE_DECISION], billing: "free",
    async execute(context, args) {
      const { project, idea } = await ideaTarget(context, args);
      const payload = SaveDecisionSchema.parse({ threadId: project.thread.id, solutionId: idea.id, userDecision: stringFlag(args, "decision") ?? idea.userDecision ?? "", observedResult: stringFlag(args, "result") ?? idea.observedResult ?? "", experimentOutcome: stringFlag(args, "outcome") ?? idea.experimentOutcome ?? "not-run" });
      return context.invoke(IPC_CHANNELS.SAVE_DECISION, payload);
    },
  },
  { path: ["idea", "conversation"], description: "Read a saved conversation; --all follows every page without generating a reply.", positionals: [{ name: "id", description: "Idea or version ID or unique prefix.", required: true }], flags: [projectFlag,
    { name: "branch", type: "string", description: "Read one branch ID or unique prefix." }, { name: "cursor", type: "string", description: "Opaque conversation page cursor." }, { name: "all", type: "boolean", description: "Read all remaining conversation pages." },
  ], channels: [IPC_CHANNELS.GET_IDEA_CONVERSATION], billing: "free",
    async execute(context, args) {
      const { project, idea } = await ideaTarget(context, args);
      const branch = stringFlag(args, "branch");
      const branchId = branch ? (await context.resolve("branch", branch, project.thread.id)).id : undefined;
      const cursor = stringFlag(args, "cursor");
      const payload = { ideaId: idea.id, ...(branchId ? { branchId } : {}) };
      const conversation = IdeaConversationSchema.parse(await context.invoke(IPC_CHANNELS.GET_IDEA_CONVERSATION, { ...payload, ...(cursor ? { cursor } : {}) }));
      if (!booleanFlag(args, "all")) return conversation;
      const turns = [...conversation.turns];
      const seen = new Set<string>();
      let nextCursor = conversation.nextCursor;
      while (nextCursor !== null) {
        if (seen.has(nextCursor)) throw new CliError("internal_error", "The owner repeated a conversation cursor.");
        seen.add(nextCursor);
        const page = IdeaConversationSchema.parse(await context.invoke(IPC_CHANNELS.GET_IDEA_CONVERSATION, { ...payload, cursor: nextCursor }));
        turns.push(...page.turns);
        nextCursor = page.nextCursor;
      }
      return { ...conversation, turns, nextCursor: null };
    },
  },
  { path: ["idea", "ask"], description: "Preview explain, explore-directions, or rethink against a saved version and conversation head.",
    positionals: [{ name: "id", description: "Idea ID or unique prefix.", required: true }, { name: "text", description: "Message text.", required: true, multiple: true }],
    flags: [projectFlag, ...approvalFlags, ...modelFlags,
      { name: "intent", type: "string", required: true, choices: ["explain", "explore-directions", "rethink"], description: "Explicit conversation intent; all three can bill." },
      { name: "base", type: "string", description: "Base idea version ID or prefix; otherwise the addressed version or selected root version." },
      { name: "branch", type: "string", description: "Branch ID or prefix; otherwise the latest saved branch." },
      { name: "head", type: "string", description: "Expected branch head turn ID or prefix, or none for an empty branch." },
      { name: "parent", type: "string", description: "Parent turn ID or prefix, or none; defaults to the expected head." },
      { name: "branch-from-earlier", type: "boolean", description: "Create a new branch from an explicitly supplied earlier parent turn." },
      { name: "new-branch", type: "boolean", description: "Start a new branch with no expected head." },
      { name: "snapshot", type: "string", description: "Explicit evidence snapshot ID or prefix; otherwise preserve the base version's snapshot." },
      { name: "client-message-id", type: "string", description: "Stable message ID; generated once when omitted, never automatically replayed." },
      { name: "calls", type: "number", description: "Model calls, from 1 to 2; defaults to 2." },
      { name: "minutes", type: "number", description: "Time allowance from 1 to 30 minutes; defaults to 2." },
    ], channels: [IPC_CHANNELS.GET_IDEA_CONVERSATION, IPC_CHANNELS.SUBMIT_IDEA_TURN], variants: ["explain", "explore-directions", "rethink"], billing: "paid",
    async execute(context, args) {
      const { project, idea } = await ideaTarget(context, args);
      const conversation = IdeaConversationSchema.parse(await context.invoke(IPC_CHANNELS.GET_IDEA_CONVERSATION, { ideaId: idea.id }));
      const baseReference = stringFlag(args, "base");
      const baseSolutionId = baseReference ? (await context.resolve("idea", baseReference, project.thread.id)).id : idea.id === conversation.rootSolutionId ? conversation.selectedVersionId : idea.id;
      const version = conversation.versions.find(item => item.solutionId === baseSolutionId);
      if (!version) throw new CliError("INVALID_REFERENCE", "The base version does not belong to this idea's root.");
      const savedModel = version.model ?? conversation.defaultModel;
      const savedEffort = version.reasoningEffort;
      if (!savedModel && !stringFlag(args, "model")) throw new CliError("USAGE", "This version has no saved model. Next command: scraply idea ask <idea> <text> --intent <intent> --model <provider:model> --effort <effort>", 2);
      if (!savedEffort && !stringFlag(args, "effort")) throw new CliError("USAGE", "This version has no saved effort. Supply --effort <effort>.", 2);
      const choices = await context.model({ ...args, flags: { ...args.flags,
        ...(savedModel && !stringFlag(args, "model") ? { model: `${savedModel.providerId}:${savedModel.modelId}` } : {}),
        ...(savedEffort && !stringFlag(args, "effort") ? { effort: savedEffort } : {}),
      } }, project.workspace);
      const branchReference = stringFlag(args, "branch");
      const requestedBranchId = branchReference ? (await context.resolve("branch", branchReference, project.thread.id)).id : undefined;
      const branch = requestedBranchId ? conversation.branches.find(item => item.branchId === requestedBranchId) : conversation.branches.at(-1);
      if (requestedBranchId && !branch) throw new CliError("INVALID_REFERENCE", "This branch does not belong to the idea's root.");
      const branchFromEarlier = booleanFlag(args, "branch-from-earlier");
      const newBranch = booleanFlag(args, "new-branch") || branchFromEarlier;
      if (newBranch && branchReference) throw new CliError("USAGE", "A new branch cannot also name an existing --branch.", 2);
      const head = stringFlag(args, "head");
      const expectedHeadTurnId = head ? head === "none" ? null : (await context.resolve("turn", head, project.thread.id)).id : newBranch ? null : branch?.headTurnId ?? null;
      const parent = stringFlag(args, "parent");
      if (branchFromEarlier && (!parent || parent === "none")) throw new CliError("USAGE", "Use --branch-from-earlier --parent <earlier-turn>.", 2);
      const parentTurnId = parent ? parent === "none" ? null : (await context.resolve("turn", parent, project.thread.id)).id : expectedHeadTurnId;
      const snapshot = stringFlag(args, "snapshot");
      const evidenceSnapshotId = snapshot ? (await context.resolve("snapshot", snapshot, project.thread.id)).id : version.evidenceSnapshotId;
      const savedInput = await savedOperation(args, IPC_CHANNELS.SUBMIT_IDEA_TURN);
      const saved = savedInput ? SubmitIdeaTurnRequestSchema.parse(savedInput) : undefined;
      const payload = SubmitIdeaTurnRequestSchema.parse({ threadId: project.thread.id, rootSolutionId: conversation.rootSolutionId, baseSolutionId,
        ...(!newBranch && branch ? { branchId: branch.branchId } : {}), expectedHeadTurnId, parentTurnId,
        clientMessageId: stringFlag(args, "client-message-id") ?? saved?.clientMessageId ?? randomUUID(), intent: IdeaTurnIntentSchema.parse(stringFlag(args, "intent")), text: args.positionals.slice(1).join(" "),
        ...(evidenceSnapshotId ? { evidenceSnapshotId } : {}), ...choices,
        allowance: { maxModelCalls: numberFlag(args, "calls") ?? 2, maxMinutes: numberFlag(args, "minutes") ?? 2 }, ...(branchFromEarlier ? { branchFromEarlier: true } : {}),
      });
      return context.previewAndExecute(IPC_CHANNELS.SUBMIT_IDEA_TURN, payload, args);
    },
  },
  { path: ["idea", "version", "select"], description: "Select a saved version without rewriting its evidence. --run uses the workflow action.", positionals: [{ name: "idea", description: "Root idea or any version ID or unique prefix.", required: true }, { name: "version", description: "Version ID or unique prefix to select.", required: true }], flags: sessionFlags,
    channels: [IPC_CHANNELS.SELECT_IDEA_VERSION, IPC_CHANNELS.COMMAND_WORKFLOW], workflowActions: ["select-version"], billing: "free",
    async execute(context, args) {
      const { project, idea } = await ideaTarget(context, args);
      const conversation = IdeaConversationSchema.parse(await context.invoke(IPC_CHANNELS.GET_IDEA_CONVERSATION, { ideaId: idea.id }));
      const solutionId = (await context.resolve("idea", requirePositional(args, 1, "scraply idea version select <idea> <version>"), project.thread.id)).id;
      const payload = SelectIdeaVersionRequestSchema.parse({ threadId: project.thread.id, rootSolutionId: conversation.rootSolutionId, solutionId });
      if (stringFlag(args, "run")) return workflowAction(context, args, await workflowTarget(context, args), { type: "select-version", rootSolutionId: payload.rootSolutionId, solutionId });
      return context.invoke(IPC_CHANNELS.SELECT_IDEA_VERSION, payload);
    },
  },
];
