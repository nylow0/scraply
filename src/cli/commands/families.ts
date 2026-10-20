import { IPC_CHANNELS, EditOpportunityMembershipSchema, ReviewSavedOpportunitiesSchema, RequestFocusedExperimentSchema } from "../../shared/ipc";
import { OpportunityBudgetExtensionPreviewSchema, OpportunityBudgetExtensionSchema } from "../../shared/opportunity-exploration";
import { booleanFlag, numberFlag, requirePositional, stringFlag } from "../args";
import { CliError } from "../output";
import type { CommandDefinition } from "../registry";
import { ideaTarget } from "./ideas";
import { approvalFlags, modelFlags, projectFlag, requiredFlag } from "./workflows";

const ambiguousRetryFlag = { name: "acknowledge-unknown-completion", type: "boolean" as const, description: "Explicitly acknowledge an earlier ambiguous family review; independent of --yes." };

export const families: CommandDefinition[] = [
  { path: ["family", "list"], description: "Read saved family membership, unresolved ideas, and exploration progress.", flags: [projectFlag], channels: [], billing: "free",
    async execute(context, args) {
      const { workspace } = await context.project(stringFlag(args, "project"));
      return { families: workspace.opportunityFamilies ?? null, exploration: workspace.opportunityExploration ?? null, review: workspace.opportunityReviewStatus ?? null };
    },
  },
  { path: ["family", "review"], description: "Preview an independent review of saved business families.", flags: [projectFlag, ...modelFlags, ...approvalFlags, ambiguousRetryFlag], channels: [IPC_CHANNELS.REVIEW_OPPORTUNITIES], billing: "paid",
    async execute(context, args) {
      const project = await context.project(stringFlag(args, "project"));
      const model = await context.model(args, project.workspace);
      const payload = ReviewSavedOpportunitiesSchema.parse({ threadId: project.thread.id, ...model, ...(booleanFlag(args, "acknowledge-unknown-completion") ? { allowAmbiguousRetry: true } : {}) });
      return context.previewAndExecute(IPC_CHANNELS.REVIEW_OPPORTUNITIES, payload, args);
    },
  },
  { path: ["family", "edit"], description: "Edit membership with split, merge-family, move, or mark-uncertain and an explicit reason.",
    positionals: [{ name: "operation", description: "split, merge-family, move, or mark-uncertain.", required: true }, { name: "id", description: "Source family for merge-family; idea for the other operations. IDs support unique prefixes.", required: true }],
    flags: [projectFlag,
      { name: "reason", type: "string", required: true, description: "Reason for the membership change." },
      { name: "target", type: "string", description: "Target family ID or unique prefix for merge-family or move." },
      { name: "relationship", type: "string", choices: ["duplicate", "variant"], description: "Required relationship for move." },
      { name: "title", type: "string", description: "Required new family title for split." },
      { name: "summary", type: "string", description: "Required new family summary for split." },
    ], channels: [IPC_CHANNELS.EDIT_OPPORTUNITY_MEMBERSHIP], variants: ["split", "merge-family", "move", "mark-uncertain"], billing: "free",
    async execute(context, args) {
      const project = await context.project(stringFlag(args, "project"));
      const operation = requirePositional(args, 0, "scraply family edit <split|merge-family|move|mark-uncertain> <id> --reason <reason>");
      const reference = requirePositional(args, 1, `scraply family edit ${operation} <id> --reason <reason>`);
      const reason = requiredFlag(args, "reason", `scraply family edit ${operation} <id> --reason <reason>`);
      const id = (await context.resolve(operation === "merge-family" ? "family" : "idea", reference, project.thread.id)).id;
      let command;
      switch (operation) {
        case "split":
          command = { operation, optionId: id, title: requiredFlag(args, "title", "scraply family edit split <idea> --title <title> --summary <summary> --reason <reason>"), summary: requiredFlag(args, "summary", "scraply family edit split <idea> --title <title> --summary <summary> --reason <reason>"), reason };
          break;
        case "merge-family":
          command = { operation, sourceFamilyId: id, targetFamilyId: (await context.resolve("family", requiredFlag(args, "target", "scraply family edit merge-family <source> --target <family> --reason <reason>"), project.thread.id)).id, reason };
          break;
        case "move":
          command = { operation, optionId: id, targetFamilyId: (await context.resolve("family", requiredFlag(args, "target", "scraply family edit move <idea> --target <family> --relationship <duplicate|variant> --reason <reason>"), project.thread.id)).id, relationship: requiredFlag(args, "relationship", "scraply family edit move <idea> --target <family> --relationship <duplicate|variant> --reason <reason>"), reason };
          break;
        case "mark-uncertain": command = { operation, optionId: id, reason }; break;
        default: throw new CliError("USAGE", "Choose split, merge-family, move, or mark-uncertain.", 2);
      }
      return context.invoke(IPC_CHANNELS.EDIT_OPPORTUNITY_MEMBERSHIP, EditOpportunityMembershipSchema.parse({ threadId: project.thread.id, command }));
    },
  },
  ...(["start", "pause", "resume"] as const).map((verb): CommandDefinition => ({
    path: ["family", "explore", verb], description: `${verb === "start" ? "Start" : verb === "pause" ? "Pause" : "Resume"} saved family exploration${verb === "pause" ? "." : " through a paid proposal."}`,
    flags: [projectFlag, ...(verb === "pause" ? [] : [...modelFlags, ...approvalFlags, ambiguousRetryFlag])],
    channels: [verb === "start" ? IPC_CHANNELS.START_OPPORTUNITY_EXPLORATION : verb === "pause" ? IPC_CHANNELS.PAUSE_OPPORTUNITY_EXPLORATION : IPC_CHANNELS.RESUME_OPPORTUNITY_EXPLORATION], billing: verb === "pause" ? "free" : "paid",
    async execute(context, args) {
      const project = await context.project(stringFlag(args, "project"));
      if (verb === "pause") return context.invoke(IPC_CHANNELS.PAUSE_OPPORTUNITY_EXPLORATION, { threadId: project.thread.id });
      const choices = await context.model(args, project.workspace);
      const payload = ReviewSavedOpportunitiesSchema.parse({ threadId: project.thread.id, ...choices, ...(booleanFlag(args, "acknowledge-unknown-completion") ? { allowAmbiguousRetry: true } : {}) });
      return context.previewAndExecute(verb === "start" ? IPC_CHANNELS.START_OPPORTUNITY_EXPLORATION : IPC_CHANNELS.RESUME_OPPORTUNITY_EXPLORATION, payload, args);
    },
  })),
  ...(["preview", "apply"] as const).map((verb): CommandDefinition => ({
    path: ["family", "extend", verb], description: verb === "preview" ? "Preview the current and proposed exploration allowance." : "Approve the exact exploration extension and resume exploration.",
    flags: [projectFlag, { name: "calls", type: "number", description: "Additional model calls, from 0 to 20." }, { name: "searches", type: "number", description: "Additional searches, from 0 to 10." }, ...(verb === "apply" ? approvalFlags : [])],
    channels: [IPC_CHANNELS.PREVIEW_OPPORTUNITY_EXTENSION, ...(verb === "apply" ? [IPC_CHANNELS.APPLY_OPPORTUNITY_EXTENSION] : [])], billing: verb === "apply" ? "paid" : "free",
    async execute(context, args) {
      const project = await context.project(stringFlag(args, "project"));
      const extension = OpportunityBudgetExtensionSchema.parse({ additionalModelCalls: numberFlag(args, "calls") ?? 0, additionalSearches: numberFlag(args, "searches") ?? 0 });
      const preview = OpportunityBudgetExtensionPreviewSchema.parse(await context.invoke(IPC_CHANNELS.PREVIEW_OPPORTUNITY_EXTENSION, { threadId: project.thread.id, extension }));
      if (verb === "preview") return preview;
      return context.previewAndExecute(IPC_CHANNELS.APPLY_OPPORTUNITY_EXTENSION, { threadId: project.thread.id, preview }, args);
    },
  })),
  { path: ["experiment", "request"], description: "Preview a focused experiment for a saved idea with independent risk review.", positionals: [{ name: "id", description: "Idea ID or unique prefix.", required: true }], flags: [projectFlag, ...approvalFlags], channels: [IPC_CHANNELS.REQUEST_FOCUSED_EXPERIMENT], billing: "paid",
    async execute(context, args) {
      const { project, idea } = await ideaTarget(context, args);
      if (!idea.runId) throw new CliError("INVALID_REFERENCE", "This idea has no saved source run.");
      const payload = RequestFocusedExperimentSchema.parse({ threadId: project.thread.id, runId: idea.runId, solutionId: idea.id });
      return context.previewAndExecute(IPC_CHANNELS.REQUEST_FOCUSED_EXPERIMENT, payload, args);
    },
  },
];
