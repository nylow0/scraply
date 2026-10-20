import { IPC_CHANNELS, ValidationStateSchema } from "../../shared/ipc";
import { APP_CHANNELS } from "../../shared/cli-contracts";
import { booleanFlag, stringFlag } from "../args";
import { CliError } from "../output";
import type { CommandDefinition } from "../registry";

export const systemCommands: CommandDefinition[] = [
  {
    path: ["status"], description: "Read saved account, provider and workspace status without probing providers.",
    channels: [APP_CHANNELS.GET_PROVIDER_STATUS, IPC_CHANNELS.GET_WORKSPACE], billing: "free",
    async execute(ctx) {
      const validation = ValidationStateSchema.parse(await ctx.invoke(APP_CHANNELS.GET_PROVIDER_STATUS));
      const workspace = await ctx.workspace();
      return { validation, activeThreadId: workspace.activeThreadId, projects: workspace.threads, activeWorkflow: workspace.activeWorkflow ?? null, pendingRuns: workspace.pendingRuns };
    },
  },
  {
    path: ["doctor"], description: "Read saved provider status. Explicit --validate or --retry requires paid preview consent.",
    flags: [
      { name: "validate", type: "boolean", description: "Probe configured providers through one paid operation." },
      { name: "retry", type: "boolean", description: "Retry connections through one paid operation." },
      { name: "yes", type: "boolean", description: "Approve this invocation's fresh provider-check proposal." },
      { name: "preview-file", type: "string", description: "Execute a saved proposal for the requested provider check." },
    ],
    channels: [APP_CHANNELS.GET_PROVIDER_STATUS, IPC_CHANNELS.GET_VALIDATION, IPC_CHANNELS.RETRY_CONNECTION], billing: "conditional",
    async execute(ctx, args) {
      const validate = booleanFlag(args, "validate");
      const retry = booleanFlag(args, "retry");
      if (validate && retry) throw new CliError("USAGE", "Choose one provider check. Next command: scraply doctor --validate or scraply doctor --retry", 2);
      if (!validate && !retry && stringFlag(args, "preview-file")) throw new CliError("USAGE", "Choose the operation for this saved proposal. Next command: scraply doctor --validate --preview-file <path> --yes", 2);
      if (retry) await ctx.previewAndExecute(IPC_CHANNELS.RETRY_CONNECTION, {}, args);
      const validation = ValidationStateSchema.parse(validate
        ? await ctx.previewAndExecute(IPC_CHANNELS.GET_VALIDATION, {}, args)
        : await ctx.invoke(APP_CHANNELS.GET_PROVIDER_STATUS));
      return { validation, owner: await ctx.system("host-status", args) };
    },
  },
  {
    path: ["host", "status"], description: "Inspect an existing owner without starting one.", channels: [], billing: "free",
    async execute(ctx, args) { return ctx.system("host-status", args); },
  },
  {
    path: ["host", "stop"], description: "Stop a CLI owner. Active work requires --force for normal pause/cancel first.",
    flags: [{ name: "force", type: "boolean", description: "Pause/cancel active work and await safe shutdown." }], channels: [], billing: "free",
    async execute(ctx, args) { return ctx.system("host-stop", args); },
  },
  {
    path: ["paths"], description: "Return profile, project, logs and runtime paths without starting a host.",
    channels: [IPC_CHANNELS.OPEN_DATA_FOLDER, IPC_CHANNELS.OPEN_LOGS_FOLDER], billing: "free",
    async execute(ctx, args) { return ctx.system("paths", args); },
  },
  {
    path: ["setup"], description: "Add this executable directory to the user's PATH. --remove reverses it without removing data.",
    flags: [{ name: "remove", type: "boolean", description: "Remove this executable directory from the user's PATH." }], channels: [], billing: "free",
    async execute(ctx, args) { return ctx.system("setup", args); },
  },
];
