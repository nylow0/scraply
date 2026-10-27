import { join } from "node:path";
import { requiredFlag, stringFlag, type CommandArguments } from "../cli/args";
import type { Command, CommandContext } from "../cli/commands";
import { availableProviders, searchKey } from "../cli/credentials";
import { runExperimentCommand } from "../cli/experiment";
import { parseId } from "../cli/ledger";
import { MODEL_PROVIDER, connectedModels } from "../cli/model";
import { CliError } from "../cli/output";
import { fetchDirect, search } from "../cli/pages";
import { advance, advanceUntilBlocked, runPendingScript, type LoopContext } from "./engine";
import { modelThinker, readConfig, writeConfig } from "./think";

const RESULTS_PER_SEARCH = 5;
const RUN_TIMEOUT_MS = 30 * 60_000;

/** Everything one loop step needs: the ledger, the chosen model, search, and a place to run experiments. */
async function loopContext(context: CommandContext, args: CommandArguments): Promise<LoopContext> {
  const projectId = parseId("project", requiredFlag(args, "project"));
  const ledger = context.ledger();
  ledger.requireProject(projectId);
  const config = readConfig(context.dataDir);
  const session = await context.models();
  const { models } = await connectedModels(session);
  const model = models.find(item => item.identity.modelId === config.model);
  // A saved model that is gone blocks work until the owner picks another; never substitute one.
  if (!model) throw new CliError("MODEL_UNAVAILABLE", `${config.model} is no longer available to this account. Pick another: scraply models, then scraply config model <id> --effort <effort>`);
  const provider = availableProviders(context.profileDir, context.env)[0];
  return {
    ledger, projectId, notify: context.notify,
    think: modelThinker(session.client, { providerId: MODEL_PROVIDER, modelId: config.model }, config.effort),
    ...(provider ? {
      searchWeb: async (query: string) => {
        const found = await search(provider, searchKey(provider, context.profileDir, context.env), query, RESULTS_PER_SEARCH, context.fetcher);
        // Perplexity returns excerpts; read the pages themselves so they can be quoted.
        const sources = provider === "exa" ? found : await Promise.all(found.map(item => fetchDirect(item.url, context.fetcher)));
        return { provider, sources };
      },
    } : {}),
    runCommand: (command, cwd) => runExperimentCommand(command, { cwd, timeoutMs: RUN_TIMEOUT_MS, env: context.env, notify: context.notify }),
    workDir: join(context.dataDir, "work", `P${projectId}`), resultsPerSearch: RESULTS_PER_SEARCH,
    tools: [`bun ${Bun.version} (TypeScript, fetch built in)`, ...(Bun.which("uv") ? ["uv (Python: uv run --with <packages> script.py)"] : [])],
    trust: args.flags.trust === true,
    skipQuestions: args.flags["skip-questions"] === true,
    agentFindings: args.flags["agent-findings"] === true,
  };
}

const projectFlag = { name: "project", type: "string", required: true, description: "Project ID." } as const;
const loopFlags = [
  projectFlag,
  { name: "trust", type: "boolean", description: "Run model-written experiment scripts without stopping for you to read them first." },
  { name: "skip-questions", type: "boolean", description: "Go on without answering the framing questions." },
  { name: "agent-findings", type: "boolean", description: "Stop when the pass is finished so you write the findings and variants, instead of Scraply's model." },
] as const;

export const loopCommands: readonly Command[] = [
  {
    path: ["config", "model"],
    description: "Choose the model and reasoning effort the loop thinks with. Scraply never picks one for you.",
    positionals: [{ name: "model", description: "A model ID from: scraply models", required: true }],
    flags: [{ name: "effort", type: "string", required: true, description: "One of the model's efforts from: scraply models" }],
    run: async (context, args) => {
      const { models } = await connectedModels(await context.models());
      const model = models.find(item => item.identity.modelId === args.positionals[0]);
      if (!model) throw new CliError("MODEL_UNAVAILABLE", `${args.positionals[0]} is not available to this account. See: scraply models`);
      const effort = requiredFlag(args, "effort");
      if (model.supportedReasoningEfforts && !model.supportedReasoningEfforts.includes(effort)) {
        throw new CliError("USAGE", `${model.identity.modelId} supports efforts: ${model.supportedReasoningEfforts.join(", ")}.`, 2);
      }
      writeConfig(context.dataDir, { model: model.identity.modelId, effort });
      return { model: model.identity.modelId, effort };
    },
  },
  {
    path: ["next"],
    description: "Run the one step the project needs next: frame, survey, split, design, gather, script, read, verdict, review, or findings.",
    flags: [...loopFlags],
    run: async (context, args) => advance(await loopContext(context, args)),
  },
  {
    path: ["auto"],
    description: "Run steps until one needs you (answers, an experiment to approve, a variant to choose) or the pass is done.",
    flags: [...loopFlags, { name: "max-steps", type: "number", description: "Stop after this many steps (default 40)." }],
    run: async (context, args) => {
      const steps = await advanceUntilBlocked(await loopContext(context, args), Math.max(1, Number(stringFlag(args, "max-steps") ?? 40)));
      const last = steps.at(-1)!;
      if (last.status === "continue") return { steps, status: "paused", next: "Stopped at --max-steps. Run the same auto command again to go on." };
      return { steps, status: last.status, ...(last.next ? { next: last.next } : {}) };
    },
  },
  {
    path: ["experiment", "approve"],
    description: "Run the experiment script the loop wrote, after reading it, and save its output as evidence.",
    flags: [projectFlag, { name: "test", type: "string", required: true, description: "The experiment test." }],
    run: async (context, args) => {
      const testId = `T${parseId("test", requiredFlag(args, "test"))}`;
      return runPendingScript(await loopContext(context, args), testId);
    },
  },
  {
    path: ["variant", "accept"],
    description: "Choose a variant the findings proposed. The next step splits it into its own idea and claims.",
    positionals: [{ name: "note", description: "The variant's note ID.", required: true }],
    flags: [projectFlag],
    run: (context, args) => {
      const projectId = parseId("project", requiredFlag(args, "project"));
      const noteId = `N${parseId("note", args.positionals[0]!)}`;
      const ledger = context.ledger();
      const note = ledger.show(projectId).notes.find(item => item.id === noteId);
      if (!note || note.kind !== "variant" || note.retracted) throw new CliError("NOT_VARIANT", `${noteId} is not a live variant in P${projectId}.`);
      ledger.logStep(projectId, "accept", noteId, null);
      return { accepted: noteId, next: `Run: scraply auto --project P${projectId}, with --agent-findings if you write the findings.` };
    },
  },
];
