import { z } from "zod";
import { IPC_CHANNELS, NativeLoginLaunchSchema, WorkspaceStateSchema } from "../../shared/ipc";
import { AppSettingsSchema } from "../../shared/app-settings";
import { OPENAI_SUBSCRIPTION_PROVIDER_ID, ModelRefSchema } from "../../shared/schemas";
import { booleanFlag, requirePositional, stringFlag } from "../args";
import { CliError } from "../output";
import type { CommandDefinition } from "../registry";

const provider = { providerId: OPENAI_SUBSCRIPTION_PROVIDER_ID };
const LoginCompleteSchema = z.discriminatedUnion("pending", [
  z.object({ pending: z.literal(true) }).strict(),
  z.object({ pending: z.literal(false), workspace: WorkspaceStateSchema }).strict(),
]);
const loginId = [{ name: "login-id", description: "Login ID returned by login start.", required: true }];
const keyProvider = [{ name: "provider", description: "exa or perplexity.", required: true }];

export const accountCommands: CommandDefinition[] = [
  {
    path: ["login", "start"], description: "Start device login and return its URL and code. --browser explicitly opens browser login.",
    flags: [{ name: "browser", type: "boolean", description: "Use browser login and open its authorization URL on this computer." }],
    channels: [IPC_CHANNELS.NATIVE_LOGIN_START, IPC_CHANNELS.OPEN_EXTERNAL_URL], billing: "free",
    async execute(ctx, args) {
      const browser = booleanFlag(args, "browser");
      const launch = NativeLoginLaunchSchema.parse(await ctx.invoke(IPC_CHANNELS.NATIVE_LOGIN_START, { ...provider, method: browser ? "browser" : "device" }));
      if (browser) await ctx.openExternal(launch.method === "device" ? launch.verificationUrl : launch.authorizationUrl);
      return launch;
    },
  },
  {
    path: ["login", "complete"], description: "Poll a pending login until it completes or the client deadline is reached.", positionals: loginId,
    channels: [IPC_CHANNELS.NATIVE_LOGIN_COMPLETE], billing: "free",
    async execute(ctx, args) {
      const id = requirePositional(args, 0, "scraply login complete <login-id>");
      for (;;) {
        ctx.signal.throwIfAborted();
        const result = LoginCompleteSchema.parse(await ctx.invoke(IPC_CHANNELS.NATIVE_LOGIN_COMPLETE, { loginId: id }));
        if (!result.pending) return result;
        await ctx.sleep(Math.min(1_000, Math.max(1, ctx.deadline - Date.now())));
      }
    },
  },
  {
    path: ["login", "cancel"], description: "Cancel a pending login.", positionals: loginId,
    channels: [IPC_CHANNELS.NATIVE_LOGIN_CANCEL], billing: "free",
    async execute(ctx, args) { return ctx.invoke(IPC_CHANNELS.NATIVE_LOGIN_CANCEL, { ...provider, loginId: requirePositional(args, 0, "scraply login cancel <login-id>") }); },
  },
  {
    path: ["account", "refresh"], description: "Refresh the saved subscription account.",
    channels: [IPC_CHANNELS.NATIVE_ACCOUNT_REFRESH], billing: "free",
    async execute(ctx) { return ctx.invoke(IPC_CHANNELS.NATIVE_ACCOUNT_REFRESH, provider); },
  },
  {
    path: ["logout"], description: "Remove the saved subscription account.", channels: [IPC_CHANNELS.NATIVE_LOGOUT], billing: "free",
    async execute(ctx) { return ctx.invoke(IPC_CHANNELS.NATIVE_LOGOUT, provider); },
  },
  {
    path: ["key", "set"], description: "Privately preview checking and saving a stdin key. --yes approves a fresh proposal. The key is never returned.", positionals: keyProvider,
    flags: [
      { name: "stdin", type: "boolean", required: true, description: "Read the key from standard input." },
      { name: "yes", type: "boolean", description: "Approve this invocation's fresh key-check proposal." },
      { name: "preview-file", type: "string", description: "Unsupported for key writes. Supply stdin and request a fresh proposal." },
    ],
    channels: [IPC_CHANNELS.SAVE_SEARCH_KEY], billing: "paid",
    async execute(ctx, args) {
      const name = z.enum(["exa", "perplexity"]).parse(requirePositional(args, 0, "scraply key set exa --stdin"));
      if (stringFlag(args, "preview-file")) throw new CliError("USAGE", `Saved key proposals are not accepted by this command. Supply the key on stdin for a fresh proposal. Next command: scraply key set ${name} --stdin --yes`, 2);
      if (!booleanFlag(args, "stdin")) throw new CliError("USAGE", "Read the key from stdin. Next command: scraply key set exa --stdin", 2);
      const apiKey = (await ctx.readStdin()).trim();
      if (!apiKey || apiKey.length > 512 || /\s/.test(apiKey)) throw new CliError("USAGE", "stdin must contain one nonempty API key, with no internal whitespace.", 2);
      await ctx.previewAndExecute(IPC_CHANNELS.SAVE_SEARCH_KEY, { provider: name, apiKey }, args);
      return { provider: name, saved: true };
    },
  },
  {
    path: ["key", "remove"], description: "Remove a saved search key.", positionals: keyProvider,
    channels: [IPC_CHANNELS.REMOVE_SEARCH_KEY], billing: "free",
    async execute(ctx, args) {
      const name = z.enum(["exa", "perplexity"]).parse(requirePositional(args, 0, "scraply key remove exa"));
      await ctx.invoke(IPC_CHANNELS.REMOVE_SEARCH_KEY, { provider: name });
      return { provider: name, removed: true };
    },
  },
  {
    path: ["settings", "get"], description: "Read global application settings.", channels: [IPC_CHANNELS.GET_ADVANCED_SETTINGS], billing: "free",
    async execute(ctx) { return ctx.invoke(IPC_CHANNELS.GET_ADVANCED_SETTINGS); },
  },
  {
    path: ["settings", "set"], description: "Update reasoningSummaries=true|false or maxConcurrentModelCalls=1..8.",
    positionals: [{ name: "key=value", description: "Setting assignment.", required: true, multiple: true }],
    channels: [IPC_CHANNELS.GET_ADVANCED_SETTINGS, IPC_CHANNELS.SAVE_ADVANCED_SETTINGS], billing: "free",
    async execute(ctx, args) {
      const current = AppSettingsSchema.parse(await ctx.invoke(IPC_CHANNELS.GET_ADVANCED_SETTINGS));
      for (const assignment of args.positionals) {
        const equals = assignment.indexOf("=");
        const key = assignment.slice(0, equals);
        const value = assignment.slice(equals + 1);
        if (equals < 1) throw new CliError("USAGE", "Expected key=value. Next command: scraply settings set reasoningSummaries=true", 2);
        if (key === "reasoningSummaries" && (value === "true" || value === "false")) current.reasoningSummaries = value === "true";
        else if (key === "maxConcurrentModelCalls" && /^\d+$/.test(value)) current.maxConcurrentModelCalls = Number(value);
        else throw new CliError("USAGE", `Unknown setting or invalid value for ${key}. Next command: scraply settings set reasoningSummaries=true`, 2);
      }
      return ctx.invoke(IPC_CHANNELS.SAVE_ADVANCED_SETTINGS, AppSettingsSchema.parse(current));
    },
  },
  {
    path: ["model", "favorite"], description: "Set a model's favorite status explicitly.",
    positionals: [{ name: "provider:model", description: "Full model reference.", required: true }, { name: "true|false", description: "Whether the model is a favorite.", required: true }],
    channels: [IPC_CHANNELS.SAVE_FAVORITE_MODEL], billing: "free",
    async execute(ctx, args) {
      const reference = requirePositional(args, 0, "scraply model favorite openai-subscription:gpt-6.1-sol true");
      const split = reference.indexOf(":");
      const favorite = z.enum(["true", "false"]).parse(args.positionals[1]);
      const model = ModelRefSchema.parse({ providerId: reference.slice(0, split), modelId: split < 0 ? "" : reference.slice(split + 1) });
      return ctx.invoke(IPC_CHANNELS.SAVE_FAVORITE_MODEL, { model, favorite: favorite === "true" });
    },
  },
];
