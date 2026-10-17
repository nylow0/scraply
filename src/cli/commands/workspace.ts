import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { z } from "zod";
import { APP_CHANNELS, ExportFileSchema } from "../../shared/cli-contracts";
import { IPC_CHANNELS } from "../../shared/ipc";
import { LaunchSettingsSchema } from "../../shared/launch-settings";
import { launchDraftEstimates } from "../../shared/launch-draft";
import { DEFAULT_IDEA_COUNT, DEFAULT_RUN_CONFIG, ExplorationPurposeSchema, ModelRefSchema, RunConfigSchema } from "../../shared/schemas";
import { ScopeSchema } from "../../shared/structured-output-schemas";
import { booleanFlag, numberFlag, stringFlag, type CommandArguments, type FlagDefinition } from "../args";
import { CliError } from "../output";
import type { CommandDefinition } from "../registry";
import type { CommandContext } from "../context";

const projectFlag: FlagDefinition = { name: "project", type: "string", description: "Project full ID, unique prefix or exact title. Defaults to selected project." };
const yesFlag: FlagDefinition = { name: "yes", type: "boolean", description: "Confirm this invocation's operation." };
const modelFlags: FlagDefinition[] = [
  { name: "model", type: "string", description: "Model as provider:model." },
  { name: "effort", type: "string", description: "Reasoning effort ID." },
];
const inputFlags: FlagDefinition[] = [
  { name: "stdin", type: "boolean", description: "Read one JSON document from stdin." },
  { name: "file", type: "string", description: "Read one JSON document from this file." },
];
const configFlags: FlagDefinition[] = [
  { name: "mode", type: "string", choices: ["vibe", "controlled", "babysit"], description: "Workflow mode. Controlled is stored as babysit." },
  { name: "depth", type: "string", choices: ["quick", "standard", "deep"], description: "Discovery depth." },
  ...modelFlags,
  { name: "ideas-model", type: "string", description: "Ideas model as provider:model." },
  { name: "ideas-effort", type: "string", description: "Ideas reasoning effort." },
  { name: "review-model", type: "string", description: "Independent review model as provider:model." },
  { name: "review-effort", type: "string", description: "Independent review reasoning effort." },
  { name: "idea-count", type: "number", description: "Ideas per target, 1 through 20." },
  { name: "search-provider", type: "string", choices: ["auto", "exa", "perplexity"], description: "Research search provider." },
  { name: "research-mode", type: "string", choices: ["explore-market", "known-problem"], description: "Discovery or known-problem research." },
  { name: "known-problem", type: "string", description: "Known problem text." },
  { name: "exploration-purpose", type: "string", choices: ExplorationPurposeSchema.options, description: "Saved research purpose. Project targets require startup-opportunities." },
  { name: "calls", type: "number", description: "Projected model calls." },
  { name: "searches", type: "number", description: "Projected searches, including zero." },
  { name: "minutes", type: "number", description: "Run allowance in minutes." },
  { name: "target-kind", type: "string", choices: ["per-problem", "project"], description: "Target count scope." },
  { name: "distinct-business-count", type: "number", description: "Distinct business target." },
  { name: "automatic-problem-cap", type: "number", description: "Maximum automatic problems." },
  ...["research", "ideas", "review"].map(name => ({ name: `${name}-instructions`, type: "string" as const, description: `Saved ${name} instructions.` })),
];

function parseModel(value: string) {
  const split = value.indexOf(":");
  return ModelRefSchema.parse({ providerId: value.slice(0, split), modelId: split < 0 ? "" : value.slice(split + 1) });
}

function configurationArguments(args: CommandArguments): CommandArguments {
  const flags = { ...args.flags };
  for (const assignment of args.positionals) {
    const equals = assignment.indexOf("=");
    const key = assignment.slice(0, equals);
    if (equals < 1 || !configFlags.some(flag => flag.name === key)) throw new CliError("USAGE", "Expected a supported config key=value. Next command: scraply config set mode=vibe depth=quick", 2);
    if (flags[key] !== undefined) throw new CliError("USAGE", `Configuration key ${key} appears more than once.`, 2);
    flags[key] = assignment.slice(equals + 1);
  }
  if (!configFlags.some(flag => flags[flag.name] !== undefined)) throw new CliError("USAGE", "Choose a configuration value. Next command: scraply config set mode=vibe depth=quick", 2);
  for (const flag of configFlags) {
    const value = flags[flag.name];
    if (flag.type === "number" && typeof value === "string" && !value.trim()) {
      throw new CliError("USAGE", `${flag.name} requires a number. Next command: scraply config set --help`, 2);
    }
  }
  return { flags, positionals: [] };
}

async function saveConfiguration(ctx: CommandContext, original: CommandArguments) {
  if (booleanFlag(original, "stdin") || stringFlag(original, "file")) {
    if (original.positionals.length || configFlags.some(flag => original.flags[flag.name] !== undefined)) throw new CliError("USAGE", "Choose configuration JSON or key/value fields, not both. Next command: scraply config set --stdin", 2);
    const input = z.object({ runConfig: RunConfigSchema.optional(), launchSettings: LaunchSettingsSchema.optional() }).strict()
      .refine(value => value.runConfig !== undefined || value.launchSettings !== undefined, "Provide runConfig or launchSettings.")
      .parse(await ctx.readJson(original));
    const project = await ctx.project(stringFlag(original, "project"));
    const previous = RunConfigSchema.parse(project.workspace.runConfig ?? DEFAULT_RUN_CONFIG);
    let config = input.runConfig ?? previous;
    const settings = input.launchSettings ?? LaunchSettingsSchema.parse(project.launchSettings);
    if (input.runConfig && input.launchSettings) {
      if (config.maxRunMinutes !== settings.limits.maxMinutes ||
          (settings.targets && (config.ideaCount ?? DEFAULT_IDEA_COUNT) !== settings.targets.ideaCount)) {
        throw new CliError("USAGE", "runConfig and launchSettings disagree on idea count or duration. Supply matching values. Next command: scraply config set --stdin", 2);
      }
    } else if (input.runConfig) {
      synchronizeRunChoices(config, settings, config.discoveryDepth !== previous.discoveryDepth || config.researchMode !== previous.researchMode);
    } else {
      // A launch-only JSON edit is explicit too. Keep the shared run fields readable with the same values.
      config = RunConfigSchema.parse({ ...config, maxRunMinutes: settings.limits.maxMinutes,
        ...(settings.targets ? { ideaCount: settings.targets.ideaCount } : {}) });
    }
    ensureProjectTarget(config, settings, Boolean(input.launchSettings?.targets?.kind === "project" && !input.runConfig));
    return persistConfiguration(ctx, project.thread.id, RunConfigSchema.parse(config), LaunchSettingsSchema.parse(settings));
  }
  const args = configurationArguments(original);
  const project = await ctx.project(stringFlag(args, "project"));
  const config = RunConfigSchema.parse(project.workspace.runConfig ?? DEFAULT_RUN_CONFIG);
  const settings = LaunchSettingsSchema.parse(project.launchSettings);
  const model = stringFlag(args, "model");
  const effort = stringFlag(args, "effort");
  const depth = stringFlag(args, "depth");
  const researchMode = stringFlag(args, "research-mode");
  if (model !== undefined) config.model = parseModel(model);
  if (effort !== undefined) config.reasoningEffort = effort;
  if (depth !== undefined) config.discoveryDepth = z.enum(["quick", "standard", "deep"]).parse(depth);
  if (researchMode !== undefined) config.researchMode = z.enum(["explore-market", "known-problem"]).parse(researchMode);
  const knownProblem = stringFlag(args, "known-problem");
  if (knownProblem !== undefined) config.knownProblem = knownProblem;
  const purpose = stringFlag(args, "exploration-purpose");
  if (purpose !== undefined) config.explorationPurpose = ExplorationPurposeSchema.parse(purpose);
  const searchProvider = stringFlag(args, "search-provider");
  if (searchProvider !== undefined) config.searchProvider = z.enum(["auto", "exa", "perplexity"]).parse(searchProvider);
  const ideaCount = numberFlag(args, "idea-count");
  if (ideaCount !== undefined) config.ideaCount = ideaCount;
  const minutes = numberFlag(args, "minutes");
  if (minutes !== undefined) { config.maxRunMinutes = minutes; settings.limits.maxMinutes = minutes; }
  const mode = stringFlag(args, "mode");
  if (mode !== undefined) settings.mode = mode === "controlled" ? "babysit" : z.enum(["vibe", "babysit"]).parse(mode);
  const ideas = settings.ideas ?? { model: config.model, reasoningEffort: config.reasoningEffort };
  const ideasModel = stringFlag(args, "ideas-model");
  const ideasEffort = stringFlag(args, "ideas-effort");
  const reviewModel = stringFlag(args, "review-model");
  const reviewEffort = stringFlag(args, "review-effort");
  if (ideasModel !== undefined) ideas.model = parseModel(ideasModel);
  if (ideasEffort !== undefined) ideas.reasoningEffort = ideasEffort;
  if (reviewModel !== undefined) ideas.reviewModel = parseModel(reviewModel);
  if (reviewEffort !== undefined) ideas.reviewReasoningEffort = reviewEffort;
  settings.ideas = ideas;
  const cap = numberFlag(args, "automatic-problem-cap");
  if (cap !== undefined) settings.automaticProblemCap = cap;
  synchronizeRunChoices(config, settings, depth !== undefined || researchMode !== undefined);
  const calls = numberFlag(args, "calls");
  const searches = numberFlag(args, "searches");
  if (calls !== undefined) settings.limits.maxModelCalls = calls;
  if (searches !== undefined) settings.limits.maxSearches = searches;
  const targetKind = stringFlag(args, "target-kind");
  const businesses = numberFlag(args, "distinct-business-count");
  if (ideaCount !== undefined || targetKind !== undefined || businesses !== undefined || cap !== undefined) {
    settings.targets = {
      ...(project.draft?.targets ?? { kind: "per-problem", ideaCount: config.ideaCount ?? 3 }),
      ...settings.targets,
      ...(ideaCount === undefined ? {} : { ideaCount }),
      ...(targetKind !== undefined ? { kind: z.enum(["per-problem", "project"]).parse(targetKind) } : {}),
      ...(businesses === undefined ? {} : { distinctBusinessCount: businesses }),
      ...(cap === undefined ? {} : { automaticProblemCap: cap }),
    };
  }
  for (const phase of ["research", "ideas", "review"] as const) {
    const instructions = stringFlag(args, `${phase}-instructions`);
    if (instructions !== undefined) settings.instructions[phase] = instructions;
  }
  ensureProjectTarget(config, settings, targetKind === "project" && purpose === undefined);
  const parsedConfig = RunConfigSchema.parse(config);
  const parsedSettings = LaunchSettingsSchema.parse(settings);
  return persistConfiguration(ctx, project.thread.id, parsedConfig, parsedSettings);
}

/** RunConfig and launch settings share these choices. Keep either editing route consistent. */
function synchronizeRunChoices(config: z.output<typeof RunConfigSchema>, settings: z.output<typeof LaunchSettingsSchema>, recalculateEstimates: boolean) {
  settings.limits.maxMinutes = config.maxRunMinutes;
  if (settings.targets) settings.targets.ideaCount = config.ideaCount ?? DEFAULT_IDEA_COUNT;
  if (recalculateEstimates) {
    const estimates = launchDraftEstimates(config.researchMode, config.discoveryDepth);
    settings.limits.maxModelCalls = estimates.maxModelCalls;
    settings.limits.maxSearches = estimates.maxSearches;
  }
}

function ensureProjectTarget(config: z.output<typeof RunConfigSchema>, settings: z.output<typeof LaunchSettingsSchema>, selectStartupPurpose: boolean) {
  if (settings.targets?.kind !== "project") return;
  if (selectStartupPurpose) config.explorationPurpose = "startup-opportunities";
  const count = settings.targets.distinctBusinessCount;
  if (config.explorationPurpose !== "startup-opportunities" || !count || count > 30) {
    throw new CliError("USAGE", "Project targets need startup-opportunities and a business count from 1 through 30. Next command: scraply config set target-kind=project distinct-business-count=5 exploration-purpose=startup-opportunities", 2);
  }
}

async function persistConfiguration(ctx: CommandContext, threadId: string, config: z.output<typeof RunConfigSchema>, settings: z.output<typeof LaunchSettingsSchema>) {
  await ctx.invoke(IPC_CHANNELS.SAVE_RUN_CONFIG, { threadId, config });
  await ctx.invoke(APP_CHANNELS.SAVE_LAUNCH_SETTINGS, { threadId, settings });
  const saved = await ctx.project(threadId);
  return { threadId: saved.thread.id, runConfig: saved.workspace.runConfig, launchSettings: saved.launchSettings, draft: saved.draft };
}

const exportBundle = z.object({ files: z.array(ExportFileSchema), filename: z.string().optional() }).strict();

/** Exclusive creation avoids overwriting a previous export or trusting server-provided path components. */
async function writeUniqueExport(directory: string, requestedName: string, content: string): Promise<string> {
  const cleaned = basename(requestedName.replace(/\\/g, "/")).replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^\.+/, "") || "export.json";
  const name = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned) ? `export-${cleaned}` : cleaned;
  const extension = extname(name);
  const stem = name.slice(0, name.length - extension.length);
  for (let suffix = 0; ; suffix += 1) {
    const path = join(directory, suffix ? `${stem}-${suffix + 1}${extension}` : name);
    try { await writeFile(path, content, { encoding: "utf8", flag: "wx" }); return path; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
}

export const workspaceCommands: CommandDefinition[] = [
  {
    path: ["project", "list"], description: "List projects. Archived projects are excluded unless --archived is present.",
    flags: [{ name: "archived", type: "boolean", description: "Include archived projects." }], channels: [APP_CHANNELS.LIST_PROJECTS], billing: "free",
    async execute(ctx, args) { return ctx.invoke(APP_CHANNELS.LIST_PROJECTS, { archived: booleanFlag(args, "archived") }); },
  },
  {
    path: ["project", "create"], description: "Create a project and persist it as the selected default.",
    flags: [{ name: "title", type: "string", description: "Initial project title." }], channels: [IPC_CHANNELS.CREATE_THREAD], billing: "free",
    async execute(ctx, args) { const title = stringFlag(args, "title"); return ctx.invoke(IPC_CHANNELS.CREATE_THREAD, title ? { title } : {}); },
  },
  {
    path: ["project", "show"], description: "Read a project without selecting it.", flags: [projectFlag],
    positionals: [{ name: "project", description: "Full ID, unique prefix or exact title." }], channels: [APP_CHANNELS.GET_PROJECT], billing: "free",
    async execute(ctx, args) { return ctx.project(projectSelector(args)); },
  },
  ...(["select", "archive", "restore", "delete"] as const).map(action => ({
    path: ["project", action], description: action === "select" ? "Persist the default project selection." : `${action[0]!.toUpperCase()}${action.slice(1)} a project.`,
    flags: [projectFlag, ...(action === "delete" ? [yesFlag] : [])],
    positionals: [{ name: "project", description: "Full ID, unique prefix or exact title." }],
    channels: [APP_CHANNELS.GET_PROJECT, action === "select" ? IPC_CHANNELS.SELECT_THREAD : action === "delete" ? IPC_CHANNELS.DELETE_THREAD : IPC_CHANNELS.ARCHIVE_THREAD], billing: "free" as const,
    async execute(ctx: CommandContext, args: CommandArguments) {
      const project = await ctx.project(projectSelector(args));
      if (action === "delete" && !booleanFlag(args, "yes")) throw new CliError("NEEDS_CONFIRMATION", `Delete project ${project.thread.id}? Repeat with --yes to confirm.`, 3, { project: project.thread, nextCommand: `scraply project delete --project ${project.thread.id} --yes` });
      const channel = action === "select" ? IPC_CHANNELS.SELECT_THREAD : action === "delete" ? IPC_CHANNELS.DELETE_THREAD : IPC_CHANNELS.ARCHIVE_THREAD;
      return ctx.invoke(channel, { threadId: project.thread.id, ...(action === "archive" || action === "restore" ? { archived: action === "archive" } : {}) });
    },
  })),
  {
    path: ["project", "title"], description: "Generate and apply a project title with an owner-issued paid proposal.",
    flags: [projectFlag, yesFlag, ...modelFlags, { name: "generate", type: "boolean", required: true, description: "Generate and apply a title." }, { name: "preview-file", type: "string", description: "Execute this saved complete proposal." }],
    channels: [APP_CHANNELS.GET_PROJECT, APP_CHANNELS.GENERATE_PROJECT_TITLE, IPC_CHANNELS.GENERATE_TITLE], billing: "paid",
    async execute(ctx, args) {
      if (!booleanFlag(args, "generate")) throw new CliError("USAGE", "Choose title generation. Next command: scraply project title --generate", 2);
      const project = await ctx.project(stringFlag(args, "project"));
      const model = await ctx.model(args, project.workspace);
      const context = JSON.stringify({ title: project.thread.title, scope: project.workspace.scope }).slice(0, 20_000);
      return ctx.previewAndExecute(APP_CHANNELS.GENERATE_PROJECT_TITLE, { threadId: project.thread.id, context, ...model }, args);
    },
  },
  {
    path: ["brief", "show"], description: "Read a saved brief without selecting its project.", flags: [projectFlag], channels: [APP_CHANNELS.GET_PROJECT], billing: "free",
    async execute(ctx, args) { const project = await ctx.project(stringFlag(args, "project")); return { threadId: project.thread.id, scope: project.workspace.scope }; },
  },
  {
    path: ["brief", "set"], description: "Save a Scope JSON document or update brief fields using flags.",
    flags: [projectFlag, ...inputFlags, ...["title", "audience", "domain", "observations", "risk-criteria"].map(name => ({ name, type: "string" as const, description: `Saved ${name}.` })), { name: "off-limits", type: "string", multiple: true, description: "Boundary text. Repeat for multiple boundaries." }],
    channels: [APP_CHANNELS.GET_PROJECT, IPC_CHANNELS.SAVE_SCOPE], billing: "free",
    async execute(ctx, args) {
      const project = await ctx.project(stringFlag(args, "project"));
      const fields = ["title", "audience", "domain", "observations", "risk-criteria", "off-limits"];
      const json = booleanFlag(args, "stdin") || Boolean(stringFlag(args, "file"));
      if (json && fields.some(name => args.flags[name] !== undefined)) throw new CliError("USAGE", "Choose JSON input or brief flags, not both. Next command: scraply brief set --stdin", 2);
      let scope;
      if (json) scope = ScopeSchema.parse(await ctx.readJson(args));
      else {
        if (!fields.some(name => args.flags[name] !== undefined)) throw new CliError("USAGE", "Provide brief fields or JSON. Next command: scraply brief set --stdin", 2);
        scope = ScopeSchema.parse(project.workspace.scope ?? { title: project.thread.title, audience: "", domain: "", observations: "", offLimits: [] });
        for (const name of ["title", "audience", "domain", "observations"] as const) { const value = stringFlag(args, name); if (value !== undefined) scope[name] = value; }
        const criteria = stringFlag(args, "risk-criteria");
        if (criteria !== undefined) scope.riskEvaluationCriteria = criteria;
        const boundaries = args.flags["off-limits"];
        if (typeof boundaries === "string") scope.offLimits = [boundaries];
        else if (Array.isArray(boundaries)) scope.offLimits = [...boundaries];
      }
      return ctx.invoke(IPC_CHANNELS.SAVE_SCOPE, { threadId: project.thread.id, scope: ScopeSchema.parse(scope) });
    },
  },
  {
    path: ["config", "show"], description: "Read run and launch choices without changing selection.", flags: [projectFlag],
    channels: [APP_CHANNELS.GET_PROJECT, APP_CHANNELS.GET_LAUNCH_SETTINGS], billing: "free",
    async execute(ctx, args) { const project = await ctx.project(stringFlag(args, "project")); return { threadId: project.thread.id, runConfig: project.workspace.runConfig, launchSettings: project.launchSettings, draft: project.draft }; },
  },
  {
    path: ["config", "set"], description: "Persist run and launch choices using --flags, key=value assignments, or full {runConfig,launchSettings} JSON.", flags: [projectFlag, ...configFlags, ...inputFlags],
    positionals: [{ name: "key=value", description: "Saved configuration assignment.", multiple: true }],
    channels: [APP_CHANNELS.GET_PROJECT, IPC_CHANNELS.SAVE_RUN_CONFIG, APP_CHANNELS.SAVE_LAUNCH_SETTINGS], billing: "free", execute: saveConfiguration,
  },
  {
    path: ["export", "research"], description: "Write research JSON to a new file. Existing files are never overwritten.",
    flags: [projectFlag, { name: "out", type: "string", required: true, description: "Destination file path." }], channels: [APP_CHANNELS.GET_PROJECT, IPC_CHANNELS.EXPORT_RESEARCH], billing: "free",
    async execute(ctx, args) {
      const project = await ctx.project(stringFlag(args, "project"));
      const bundle = exportBundle.parse(await ctx.invoke(IPC_CHANNELS.EXPORT_RESEARCH, { threadId: project.thread.id }));
      if (bundle.files.length !== 1) throw new CliError("INVALID_RESPONSE", "The owner returned an invalid research export.");
      const file = resolve(stringFlag(args, "out")!);
      try { await writeFile(file, bundle.files[0]!.content, { encoding: "utf8", flag: "wx" }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new CliError("conflict", "The destination file already exists. Choose another --out path.");
        throw error;
      }
      return { file };
    },
  },
  {
    path: ["export", "ideas"], description: "Write ideas to a directory with safe unique filenames.",
    flags: [projectFlag, { name: "format", type: "string", choices: ["md", "json"], description: "Export format, default md." }, { name: "out", type: "string", required: true, description: "Destination directory." }],
    channels: [APP_CHANNELS.GET_PROJECT, IPC_CHANNELS.EXPORT_IDEAS], billing: "free",
    async execute(ctx, args) {
      const project = await ctx.project(stringFlag(args, "project"));
      const bundle = exportBundle.parse(await ctx.invoke(IPC_CHANNELS.EXPORT_IDEAS, { threadId: project.thread.id, format: stringFlag(args, "format") === "json" ? "json" : "markdown" }));
      const directory = resolve(stringFlag(args, "out")!);
      await mkdir(directory, { recursive: true });
      const files: string[] = [];
      for (const file of bundle.files) files.push(await writeUniqueExport(directory, file.filename, file.content));
      return { directory, files };
    },
  },
];

function projectSelector(args: CommandArguments): string | undefined {
  const flag = stringFlag(args, "project");
  if (flag && args.positionals.length) throw new CliError("USAGE", "Choose a positional project or --project, not both.", 2);
  return flag ?? args.positionals[0];
}
