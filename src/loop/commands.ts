import { join } from "node:path";
import { requiredFlag, stringFlag, type CommandArguments } from "../cli/args";
import type { Command, CommandContext } from "../cli/commands";
import { availableProviders, searchKey } from "../cli/credentials";
import { runExperimentCommand } from "../cli/experiment";
import { parseId } from "../cli/ledger";
import { CliError } from "../cli/output";
import { fetchDirect, search } from "../cli/pages";
import { advance, runPendingScript, type LoopContext, type StepResult } from "./engine";
import { ThinkNeeded, agentThinker, headStep, workOrder } from "./think";

const RESULTS_PER_SEARCH = 5;
const RUN_TIMEOUT_MS = 30 * 60_000;
/** Mechanical steps one `next` or `submit` may run before it hands back; a pass has far fewer. */
const MAX_STEPS = 40;

/** Everything one loop step needs: the ledger, search, a place to run experiments, and the agent's answer, if any. */
function loopContext(context: CommandContext, args: CommandArguments, answer?: { order: string; value: unknown }) {
  const projectId = parseId("project", requiredFlag(args, "project"));
  const ledger = context.ledger();
  ledger.requireProject(projectId);
  const provider = availableProviders(context.profileDir, context.env)[0];
  const { think, state } = agentThinker(ledger, projectId, answer);
  const loop: LoopContext = {
    ledger, projectId, notify: context.notify, think,
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
  };
  return { loop, state };
}

/**
 * Run steps until one needs thinking (a work order for the caller), needs the owner, or the pass is done.
 * With an answer, the step it was written for runs first; an answer no step asked for is refused.
 */
async function drive(context: CommandContext, args: CommandArguments, answer?: { order: string; value: unknown }) {
  const { loop, state } = loopContext(context, args, answer);
  const stale = () => new CliError("STALE_ORDER", `${answer!.order} is not the work order P${loop.projectId} is waiting on; the project moved on, or the order is from another project. Run: scraply next --project P${loop.projectId}`);
  // An order names the step log's head when it was issued; refuse a stale one before any search or run happens.
  if (answer && answer.order.split("-")[1] !== String(headStep(loop.ledger, loop.projectId))) throw stale();
  const steps: StepResult[] = [];
  const stop = (result: Record<string, unknown>) => {
    if (answer && !state.used) throw stale();
    return { steps, ...result };
  };
  try {
    while (steps.length < MAX_STEPS) {
      const result = await advance(loop);
      steps.push(result);
      context.notify(`[${result.step}] ${result.did}`);
      if (result.status !== "continue") return stop({ status: result.status, ...(result.next ? { next: result.next } : {}) });
    }
    return stop({ status: "paused", next: `Stopped after ${MAX_STEPS} steps. Run: scraply next --project P${loop.projectId}` });
  } catch (error) {
    if (!(error instanceof ThinkNeeded)) throw error;
    return stop({ status: "think", workOrder: workOrder(error.request, loop.ledger, loop.projectId) });
  }
}

const projectFlag = { name: "project", type: "string", required: true, description: "Project ID." } as const;
const loopFlags = [
  projectFlag,
  { name: "trust", type: "boolean", description: "Run experiment scripts without stopping for the owner to read them first." },
  { name: "skip-questions", type: "boolean", description: "Go on without the owner's answers to the framing questions, using the assumptions the framing stated." },
] as const;

export const loopCommands: readonly Command[] = [
  {
    path: ["next"],
    description: "Run the loop until it needs thinking, the owner, or nothing more. status think returns a work order: do it and answer with scraply submit. needs-you says what the owner must do; done means the pass is finished.",
    flags: [...loopFlags],
    run: (context, args) => drive(context, args),
  },
  {
    path: ["submit"],
    description: "Answer a work order from scraply next with JSON matching its answerSchema. The ledger checks it (quotes verbatim, verdict rules); a refusal says what to fix. The loop then runs on to the next work order or stop.",
    flags: [
      ...loopFlags,
      { name: "order", type: "string", required: true, description: "The work order's order ID." },
      { name: "answer", type: "string", description: "The answer as JSON. Without it, the JSON is read from stdin." },
    ],
    run: async (context, args) => {
      const text = stringFlag(args, "answer") ?? await context.readStdin();
      let value: unknown;
      try { value = JSON.parse(text); }
      catch { throw new CliError("BAD_ANSWER", "The answer is not valid JSON.", 2); }
      return drive(context, args, { order: requiredFlag(args, "order"), value });
    },
  },
  {
    path: ["experiment", "approve"],
    description: "Run the experiment script the loop wrote, once the owner has read it and agreed, and save its output as evidence.",
    flags: [projectFlag, { name: "test", type: "string", required: true, description: "The experiment test." }],
    run: (context, args) => {
      const testId = `T${parseId("test", requiredFlag(args, "test"))}`;
      return runPendingScript(loopContext(context, args).loop, testId);
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
      return { accepted: noteId, next: `Run: scraply next --project P${projectId}` };
    },
  },
];
