import { commandUsage, globalFlags, listFlag, requiredFlag, stringFlag, type CommandArguments, type CommandShape } from "./args";
import { availableProviders, searchKey, type SearchProvider } from "./credentials";
import { CLAIM_KINDS, NOTE_KINDS, QUOTE_KINDS, REVIEW_RESULTS, VERDICT_RESULTS, parseId, type Ledger } from "./ledger";
import { CliError } from "./output";
import { fetchDirect, fetchViaExa, search } from "./pages";

export interface CommandContext {
  ledger: () => Ledger;
  dataDir: string;
  /** The desktop app's profile folder, where saved search keys live. */
  profileDir: string;
  env: Record<string, string | undefined>;
  fetcher: typeof fetch;
}

export interface Command extends CommandShape {
  description: string;
  run(context: CommandContext, args: CommandArguments): unknown;
}

const PREVIEW_CHARS = 300;

function pick<T extends string>(value: string, choices: readonly T[]): T {
  const match = choices.find(choice => choice === value);
  if (!match) throw new CliError("USAGE", `Expected one of: ${choices.join(", ")}.`, 2);
  return match;
}

const project = (args: CommandArguments) => parseId("project", requiredFlag(args, "project"));

export const commands: readonly Command[] = [
  {
    path: ["status"],
    description: "Show the ledger folder and which search providers have a key.",
    run: context => ({ dataDir: context.dataDir, searchProviders: availableProviders(context.profileDir, context.env) }),
  },
  {
    path: ["project", "new"],
    description: "Start a project from the user's seed, in their own words.",
    positionals: [{ name: "name", description: "Short project name.", required: true }],
    flags: [{ name: "seed", type: "string", required: true, description: "The user's seed, verbatim." }],
    run: (context, args) => context.ledger().createProject(args.positionals[0]!, requiredFlag(args, "seed")),
  },
  {
    path: ["project", "list"],
    description: "List projects.",
    run: context => context.ledger().listProjects(),
  },
  {
    path: ["note", "add"],
    description: "Record a constraint, expert framing, or prior art. Notes are context, never evidence.",
    flags: [
      { name: "project", type: "string", required: true, description: "Project ID." },
      { name: "kind", type: "string", required: true, choices: NOTE_KINDS, description: "What the note records." },
      { name: "text", type: "string", required: true, description: "The note." },
    ],
    run: (context, args) => context.ledger().addNote(project(args), pick(requiredFlag(args, "kind"), NOTE_KINDS), requiredFlag(args, "text")),
  },
  {
    path: ["search"],
    description: "Search the web and save every result's full text as a source.",
    positionals: [{ name: "query", description: "The search query.", required: true }],
    flags: [
      { name: "project", type: "string", required: true, description: "Project ID." },
      { name: "provider", type: "string", choices: ["exa", "perplexity"], description: "Defaults to Exa when it has a key." },
      { name: "results", type: "number", description: "Results to save, 1 to 20 (default 5)." },
    ],
    run: async (context, args) => {
      const projectId = project(args);
      context.ledger().requireProject(projectId);
      const requested = stringFlag(args, "provider");
      const provider: SearchProvider | undefined = requested === "exa" || requested === "perplexity" ? requested : availableProviders(context.profileDir, context.env)[0];
      if (!provider) throw new CliError("NO_KEY", "No search provider has a key. Set EXA_API_KEY or PERPLEXITY_API_KEY.");
      const results = Math.min(20, Math.max(1, Math.trunc(Number(stringFlag(args, "results") ?? 5))));
      const found = await search(provider, searchKey(provider, context.profileDir, context.env), args.positionals[0]!, results, context.fetcher);
      return {
        provider,
        sources: found.map(item => ({ ...context.ledger().saveSource(projectId, item), preview: item.text?.slice(0, PREVIEW_CHARS) })),
        next: "Read a source in full with: scraply source show <id>",
      };
    },
  },
  {
    path: ["fetch"],
    description: "Fetch one page and save its text as a source. A failed fetch is saved as failed.",
    positionals: [{ name: "url", description: "Page URL.", required: true }],
    flags: [
      { name: "project", type: "string", required: true, description: "Project ID." },
      { name: "via", type: "string", choices: ["direct", "exa"], description: "direct (default) or exa, which reaches many sites that block scripts." },
    ],
    run: async (context, args) => {
      const projectId = project(args);
      context.ledger().requireProject(projectId);
      const url = args.positionals[0]!;
      if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) throw new CliError("USAGE", "Fetch needs an http or https URL.", 2);
      const page = stringFlag(args, "via") === "exa"
        ? await fetchViaExa(url, searchKey("exa", context.profileDir, context.env), context.fetcher)
        : await fetchDirect(url, context.fetcher);
      return { ...context.ledger().saveSource(projectId, page), preview: page.text?.slice(0, PREVIEW_CHARS) };
    },
  },
  {
    path: ["source", "show"],
    description: "Print a source's full saved text. Read it all before judging a claim.",
    positionals: [{ name: "source", description: "Source ID.", required: true }],
    run: (context, args) => context.ledger().readSource(parseId("source", args.positionals[0]!)),
  },
  {
    path: ["quote", "add"],
    description: "Save a quote. It must appear verbatim in the source's saved text.",
    flags: [
      { name: "source", type: "string", required: true, description: "Source ID." },
      { name: "speaker", type: "string", required: true, description: "Who said it: their handle or name, or the organization." },
      { name: "kind", type: "string", required: true, choices: QUOTE_KINDS, description: "firsthand (their own experience), vendor (a seller about its product), or other." },
      { name: "text", type: "string", required: true, description: "The exact words: a full sentence that stands on its own." },
    ],
    run: (context, args) => context.ledger().addQuote(
      parseId("source", requiredFlag(args, "source")), requiredFlag(args, "text"), requiredFlag(args, "speaker"), pick(requiredFlag(args, "kind"), QUOTE_KINDS),
    ),
  },
  {
    path: ["claim", "add"],
    description: "Add a claim that could be false, with the condition that kills it.",
    flags: [
      { name: "project", type: "string", required: true, description: "Project ID." },
      { name: "kind", type: "string", required: true, choices: CLAIM_KINDS, description: "need, gap, mechanism, or feasibility." },
      { name: "statement", type: "string", required: true, description: "The claim." },
      { name: "kill-if", type: "string", required: true, description: "One measurable condition that would kill it." },
    ],
    run: (context, args) => context.ledger().addClaim(project(args), pick(requiredFlag(args, "kind"), CLAIM_KINDS), requiredFlag(args, "statement"), requiredFlag(args, "kill-if")),
  },
  {
    path: ["test", "add"],
    description: "Write down how a claim will be tested and the predicted outcome, before looking.",
    flags: [
      { name: "claim", type: "string", required: true, description: "Claim ID." },
      { name: "method", type: "string", required: true, description: "What you will look at and how." },
      { name: "prediction", type: "string", required: true, description: "What you expect to find." },
    ],
    run: (context, args) => context.ledger().addTest(parseId("claim", requiredFlag(args, "claim")), requiredFlag(args, "method"), requiredFlag(args, "prediction")),
  },
  {
    path: ["verdict", "add"],
    description: "Record a verdict. The newest verdict on a claim wins; provisional means waiting for review.",
    flags: [
      { name: "claim", type: "string", required: true, description: "Claim ID." },
      { name: "result", type: "string", required: true, choices: VERDICT_RESULTS, description: "killed, unclear, or provisional (supported once a review upholds it)." },
      { name: "note", type: "string", required: true, description: "Why, in your words. No quotation marks: cite quotes instead." },
      { name: "quote", type: "string", multiple: true, description: "A quote ID this verdict rests on. Repeat for each." },
      { name: "test", type: "string", description: "The test this verdict answers." },
    ],
    run: (context, args) => {
      const test = stringFlag(args, "test");
      return context.ledger().addVerdict(
        parseId("claim", requiredFlag(args, "claim")), pick(requiredFlag(args, "result"), VERDICT_RESULTS),
        listFlag(args, "quote").map(id => parseId("quote", id)), requiredFlag(args, "note"),
        test === undefined ? undefined : parseId("test", test),
      );
    },
  },
  {
    path: ["review", "add"],
    description: "Record an independent review of a provisional or killed verdict. Overturned reopens the claim.",
    flags: [
      { name: "verdict", type: "string", required: true, description: "Verdict ID." },
      { name: "result", type: "string", required: true, choices: REVIEW_RESULTS, description: "upheld or overturned." },
      { name: "note", type: "string", required: true, description: "What the review checked and found." },
    ],
    run: (context, args) => context.ledger().addReview(parseId("verdict", requiredFlag(args, "verdict")), pick(requiredFlag(args, "result"), REVIEW_RESULTS), requiredFlag(args, "note")),
  },
  {
    path: ["show"],
    description: "Print a whole project: claims with status, tests, verdicts, quotes, and sources.",
    flags: [
      { name: "project", type: "string", required: true, description: "Project ID." },
      { name: "for-review", type: "boolean", description: "Leave out notes, statuses, and reviews, for a fresh reviewer." },
    ],
    run: (context, args) => context.ledger().show(project(args), args.flags["for-review"] === true),
  },
];

export function describeCommands(prefix: readonly string[]) {
  return {
    commands: commands.filter(command => prefix.every((part, index) => command.path[index] === part)).map(command => ({
      usage: commandUsage(command), description: command.description,
      flags: (command.flags ?? []).map(flag => ({
        name: `--${flag.name}`, ...(flag.required ? { required: true } : {}), ...(flag.multiple ? { repeatable: true } : {}),
        ...(flag.choices ? { choices: flag.choices } : {}), description: flag.description,
      })),
    })),
    globalFlags: globalFlags.map(flag => ({ name: `--${flag.name}`, description: flag.description })),
  };
}
