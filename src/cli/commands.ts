import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { commandUsage, globalFlags, listFlag, requiredFlag, stringFlag, type CommandArguments, type CommandShape } from "./args";
import { availableProviders, openSecrets, searchKey, type SearchProvider } from "./credentials";
import {
  CLAIM_KINDS, FILE_ORIGINS, MAX_SOURCE_CHARS, NOTE_KINDS, QUOTE_KINDS, RETRACTABLE, REVIEW_RESULTS, VERDICT_RESULTS,
  parseAnyId, parseId, type Ledger,
} from "./ledger";
import { desktopDatabasePath, exportDesktopProjects } from "./legacy";
import { MODEL_PROVIDER, connectedModels, findRuntime, type ModelSession } from "./model";
import { CliError } from "./output";
import { fetchDirect, fetchViaExa, search } from "./pages";
import { renderReport } from "./report";

export interface CommandContext {
  ledger: () => Ledger;
  /** The model worker with the saved account restored, started on first use. */
  models: () => Promise<ModelSession>;
  dataDir: string;
  /** The Scraply profile folder (%APPDATA%\scraply): encrypted keys and account, and the desktop app's data. */
  profileDir: string;
  env: Record<string, string | undefined>;
  fetcher: typeof fetch;
  /** Tell the person at the terminal something; never part of the JSON result. */
  notify: (text: string) => void;
  readStdin: () => Promise<string>;
  openUrl: (url: string) => void;
}

export interface Command extends CommandShape {
  description: string;
  run(context: CommandContext, args: CommandArguments): unknown;
}

const PREVIEW_CHARS = 300;
/** A file bigger than this is not a text record an agent should quote from. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

function pick<T extends string>(value: string, choices: readonly T[]): T {
  const match = choices.find(choice => choice === value);
  if (!match) throw new CliError("USAGE", `Expected one of: ${choices.join(", ")}.`, 2);
  return match;
}

const project = (args: CommandArguments) => parseId("project", requiredFlag(args, "project"));
const projectFlag = { name: "project", type: "string", required: true, description: "Project ID." } as const;

export const commands: readonly Command[] = [
  {
    path: ["status"],
    description: "Show the ledger folder, which search providers have a key, whether a model account is saved, and whether the model worker and the desktop app's database exist.",
    run: context => {
      let runtime: string;
      try { runtime = findRuntime(context.env)?.executablePath ?? "missing"; }
      catch { runtime = "invalid"; }
      return {
        dataDir: context.dataDir,
        searchProviders: availableProviders(context.profileDir, context.env),
        modelAccount: openSecrets(context.profileDir).load().providerCredentials[MODEL_PROVIDER] ? "saved" : "signed-out",
        runtime,
        desktopDatabase: existsSync(desktopDatabasePath(context.profileDir)),
      };
    },
  },
  {
    path: ["login"],
    description: "Sign in to the OpenAI subscription account that runs the model. Opens the browser and waits up to five minutes.",
    flags: [{ name: "method", type: "string", choices: ["browser", "device"], description: "browser (default) or device, which shows a code to enter at a URL." }],
    run: async (context, args) => {
      const session = await context.models();
      const login = await session.client.startLogin(MODEL_PROVIDER, stringFlag(args, "method") === "device" ? "device" : "browser");
      const url = login.method === "device" ? login.verificationUrl : login.authorizationUrl;
      context.notify(login.method === "device" ? `Open ${url} and enter the code ${login.userCode}.` : `Finish signing in in the browser: ${url}`);
      context.openUrl(url);
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const result = await session.client.completeLogin(login.loginId, session.persist);
        if (result) {
          const { models } = await connectedModels(session);
          return { connected: true, plan: result.account.plan ?? null, models: models.length };
        }
        await new Promise(resolve => setTimeout(resolve, 1_000));
      }
      await session.client.cancelLogin(login.loginId).catch(() => undefined);
      throw new CliError("LOGIN_TIMEOUT", "Sign-in did not finish within five minutes. Run: scraply login");
    },
  },
  {
    path: ["logout"],
    description: "Sign out of the model account and delete its saved credential.",
    run: async context => {
      // The saved credential goes even when the worker is missing or fails; the account is revoked when the worker starts.
      // A sign-in another process saves meanwhile is refused as a conflict, before anything is deleted or revoked.
      const secrets = openSecrets(context.profileDir);
      const current = secrets.load();
      const session = await context.models().catch(() => undefined);
      if (session && session.held(MODEL_PROVIDER) !== current.providerCredentials[MODEL_PROVIDER]) {
        throw new CliError("CREDENTIALS_CONFLICT", "The model account changed in another Scraply process. Run the command again.");
      }
      const providerCredentials = { ...current.providerCredentials };
      delete providerCredentials[MODEL_PROVIDER];
      await secrets.save({ ...current, providerCredentials });
      await session?.client.logout(MODEL_PROVIDER).catch(() => undefined);
      return { connected: false };
    },
  },
  {
    path: ["models"],
    description: "List the models the signed-in account can run, with their reasoning efforts.",
    run: async context => {
      // Answer a signed-out profile without starting the worker.
      if (!openSecrets(context.profileDir).load().providerCredentials[MODEL_PROVIDER]) throw new CliError("SIGNED_OUT", "No model account. Sign in with: scraply login");
      const { account, models } = await connectedModels(await context.models());
      return {
        plan: account?.plan ?? null,
        models: models.map(model => ({
          id: model.identity.modelId, name: model.displayName,
          ...(model.supportedReasoningEfforts ? { efforts: model.supportedReasoningEfforts } : {}),
          ...(model.defaultReasoningEffort ? { defaultEffort: model.defaultReasoningEffort } : {}),
        })),
      };
    },
  },
  {
    path: ["key", "set"],
    description: "Save a search key, read from stdin so it never appears in the command line or shell history: <key> | scraply key set exa",
    positionals: [{ name: "provider", description: "exa or perplexity.", required: true }],
    run: async (context, args) => {
      const provider = pick(args.positionals[0]!, ["exa", "perplexity"] as const);
      const key = (await context.readStdin()).trim();
      if (!key || /\s/.test(key)) throw new CliError("USAGE", "Pipe exactly one key into the command, such as: Get-Clipboard | scraply key set exa", 2);
      const store = openSecrets(context.profileDir);
      const current = store.load();
      await store.save({ ...current, [provider === "exa" ? "exaApiKey" : "perplexityApiKey"]: key });
      return { provider, saved: true };
    },
  },
  {
    path: ["key", "remove"],
    description: "Delete a saved search key.",
    positionals: [{ name: "provider", description: "exa or perplexity.", required: true }],
    run: async (context, args) => {
      const provider = pick(args.positionals[0]!, ["exa", "perplexity"] as const);
      const store = openSecrets(context.profileDir);
      const current = store.load();
      await store.save({ ...current, [provider === "exa" ? "exaApiKey" : "perplexityApiKey"]: null });
      return { provider, saved: false };
    },
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
    description: "List projects. Archived ones are hidden unless --all.",
    flags: [{ name: "all", type: "boolean", description: "Include archived projects." }],
    run: (context, args) => context.ledger().listProjects(args.flags.all === true),
  },
  {
    path: ["project", "archive"],
    description: "Hide a finished or abandoned project from the list. It stays readable and can be restored.",
    positionals: [{ name: "project", description: "Project ID.", required: true }],
    run: (context, args) => context.ledger().setArchived(parseId("project", args.positionals[0]!), true),
  },
  {
    path: ["project", "restore"],
    description: "Bring an archived project back into the list.",
    positionals: [{ name: "project", description: "Project ID.", required: true }],
    run: (context, args) => context.ledger().setArchived(parseId("project", args.positionals[0]!), false),
  },
  {
    path: ["note", "add"],
    description: "Record a constraint from the user, expert framing, or prior art. Notes are context, never evidence.",
    flags: [
      projectFlag,
      { name: "kind", type: "string", required: true, choices: NOTE_KINDS, description: "constraint (from the user; reviewers see it), framing, or prior-art." },
      { name: "text", type: "string", required: true, description: "The note." },
    ],
    run: (context, args) => context.ledger().addNote(project(args), pick(requiredFlag(args, "kind"), NOTE_KINDS), requiredFlag(args, "text")),
  },
  {
    path: ["search"],
    description: "Search the web and save every result as a source. Exa results are pages; Perplexity results are excerpts that must be fetched before quoting. Failed and empty searches are recorded too.",
    positionals: [{ name: "query", description: "The search query.", required: true }],
    flags: [
      projectFlag,
      { name: "provider", type: "string", choices: ["exa", "perplexity"], description: "Defaults to Exa when it has a key." },
      { name: "results", type: "number", description: "Results to save, 1 to 20 (default 5)." },
    ],
    run: async (context, args) => {
      const projectId = project(args);
      context.ledger().requireProject(projectId);
      const requested = stringFlag(args, "provider");
      const provider: SearchProvider | undefined = requested === "exa" || requested === "perplexity" ? requested : availableProviders(context.profileDir, context.env)[0];
      if (!provider) throw new CliError("NO_KEY", "No search provider has a key. Set EXA_API_KEY or PERPLEXITY_API_KEY.");
      const key = searchKey(provider, context.profileDir, context.env);
      const results = Math.min(20, Math.max(1, Math.trunc(Number(stringFlag(args, "results") ?? 5))));
      const query = args.positionals[0]!;
      let found;
      try {
        found = await search(provider, key, query, results, context.fetcher);
      } catch (error) {
        context.ledger().recordSearch(projectId, provider, query, { error: error instanceof Error ? error.message : "The search failed." });
        throw error;
      }
      const saved = context.ledger().recordSearch(projectId, provider, query, { sources: found });
      return {
        search: saved.id, provider, status: saved.status,
        sources: saved.sources.map((source, index) => ({ ...source, preview: found[index]?.text?.slice(0, PREVIEW_CHARS) })),
        next: provider === "perplexity"
          ? "These are excerpts. Fetch a page before quoting it: scraply fetch <url> --project <id>"
          : "Read a source in full with: scraply source show <id>",
      };
    },
  },
  {
    path: ["fetch"],
    description: "Fetch one page and save its text as a source. A failed fetch is saved as failed.",
    positionals: [{ name: "url", description: "Page URL.", required: true }],
    flags: [
      projectFlag,
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
    path: ["source", "add"],
    description: "Save a text file as a source: material the user handed over (interview notes, survey results) or the output of an experiment you ran.",
    flags: [
      projectFlag,
      { name: "file", type: "string", required: true, description: "Path to a UTF-8 text file." },
      { name: "title", type: "string", required: true, description: "What it is and where it came from, such as: Survey results the user collected, 14 replies." },
      { name: "origin", type: "string", required: true, choices: FILE_ORIGINS, description: "owner (the user gave it to you) or experiment (output of something you ran; say what in --title)." },
    ],
    run: (context, args) => {
      const projectId = project(args);
      const path = resolve(requiredFlag(args, "file"));
      if (!existsSync(path) || !statSync(path).isFile()) throw new CliError("USAGE", `${path} is not a file.`, 2);
      if (statSync(path).size > MAX_FILE_BYTES) throw new CliError("USAGE", `${path} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`, 2);
      const text = readFileSync(path, "utf8");
      const origin = pick(requiredFlag(args, "origin"), FILE_ORIGINS);
      return context.ledger().saveSource(projectId, {
        url: `file:${basename(path)}`, title: requiredFlag(args, "title"), via: origin, kind: "file",
        ...(text.length > MAX_SOURCE_CHARS ? { text: text.slice(0, MAX_SOURCE_CHARS), truncated: true } : { text }),
        ...(text.trim() ? {} : { error: "The file is empty." }),
      });
    },
  },
  {
    path: ["source", "show"],
    description: "Print a source's saved text. Long sources come in windows: repeat with --offset <nextOffset> until nextOffset is absent.",
    positionals: [{ name: "source", description: "Source ID.", required: true }],
    flags: [{ name: "offset", type: "number", description: "Character offset to start from (default 0)." }],
    run: (context, args) => context.ledger().readSource(parseId("source", args.positionals[0]!), Number(stringFlag(args, "offset") ?? 0)),
  },
  {
    path: ["quote", "add"],
    description: "Save a quote. It must appear verbatim in a saved page or file; search excerpts cannot be quoted.",
    flags: [
      { name: "source", type: "string", required: true, description: "Source ID." },
      { name: "speaker", type: "string", required: true, description: "Who said or measured it: their handle or name, or the organization. The same person is the same speaker everywhere." },
      { name: "kind", type: "string", required: true, choices: QUOTE_KINDS, description: "firsthand (their own experience), measured (a count, record, or study result), vendor (a seller about its product), or other." },
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
      projectFlag,
      { name: "kind", type: "string", required: true, choices: CLAIM_KINDS, description: "need, gap, mechanism, or feasibility." },
      { name: "statement", type: "string", required: true, description: "The claim." },
      { name: "kill-if", type: "string", required: true, description: "One measurable condition that would kill it." },
    ],
    run: (context, args) => context.ledger().addClaim(project(args), pick(requiredFlag(args, "kind"), CLAIM_KINDS), requiredFlag(args, "statement"), requiredFlag(args, "kill-if")),
  },
  {
    path: ["test", "add"],
    description: "Write down how a claim will be tested, the predicted outcome, and when the test stops, before looking.",
    flags: [
      { name: "claim", type: "string", required: true, description: "Claim ID." },
      { name: "method", type: "string", required: true, description: "What you will look at and how." },
      { name: "prediction", type: "string", required: true, description: "What you expect to find, as a number or threshold where you can." },
      { name: "stop-when", type: "string", required: true, description: "The sample size or limit that ends the test, such as: 15 threads read or 3 searches." },
    ],
    run: (context, args) => context.ledger().addTest(
      parseId("claim", requiredFlag(args, "claim")), requiredFlag(args, "method"), requiredFlag(args, "prediction"), requiredFlag(args, "stop-when"),
    ),
  },
  {
    path: ["verdict", "add"],
    description: "Record a verdict. The newest verdict on a claim wins. Provisional and killed verdicts wait for an independent review.",
    flags: [
      { name: "claim", type: "string", required: true, description: "Claim ID." },
      { name: "result", type: "string", required: true, choices: VERDICT_RESULTS, description: "killed, unclear, or provisional (needs --test and evidence found after it)." },
      { name: "note", type: "string", required: true, description: "Why, in your words. No quotation marks: cite quotes instead." },
      { name: "by", type: "string", required: true, description: "Who wrote this verdict, such as: author. Its reviewer must be someone else." },
      { name: "quote", type: "string", multiple: true, description: "A quote ID this verdict rests on. Repeat for each." },
      { name: "test", type: "string", description: "The test this verdict answers." },
    ],
    run: (context, args) => {
      const test = stringFlag(args, "test");
      return context.ledger().addVerdict({
        claimId: parseId("claim", requiredFlag(args, "claim")), result: pick(requiredFlag(args, "result"), VERDICT_RESULTS),
        quoteIds: listFlag(args, "quote").map(id => parseId("quote", id)), note: requiredFlag(args, "note"), author: requiredFlag(args, "by"),
        ...(test === undefined ? {} : { testId: parseId("test", test) }),
      });
    },
  },
  {
    path: ["review", "add"],
    description: "Record an independent review of the newest provisional or killed verdict on a claim. Overturned reopens the claim.",
    flags: [
      { name: "verdict", type: "string", required: true, description: "Verdict ID, from toReview in: scraply show --project <id> --for-review" },
      { name: "result", type: "string", required: true, choices: REVIEW_RESULTS, description: "upheld or overturned." },
      { name: "note", type: "string", required: true, description: "What the review checked and found." },
      { name: "by", type: "string", required: true, description: "Who reviewed, such as: reviewer-1. Must differ from the verdict's author." },
    ],
    run: (context, args) => context.ledger().addReview({
      verdictId: parseId("verdict", requiredFlag(args, "verdict")), result: pick(requiredFlag(args, "result"), REVIEW_RESULTS),
      note: requiredFlag(args, "note"), reviewer: requiredFlag(args, "by"),
    }),
  },
  {
    path: ["idea", "add"],
    description: "Save an idea: a concrete version of the seed and the claims it rests on. It stands when all of them are supported and dies with any of them.",
    flags: [
      projectFlag,
      { name: "title", type: "string", required: true, description: "Short name." },
      { name: "pitch", type: "string", required: true, description: "Who it is for, what it does, and why now, in a few sentences." },
      { name: "claim", type: "string", required: true, multiple: true, description: "A claim ID it rests on. Repeat for each." },
      { name: "revises", type: "string", description: "The idea this one replaces or varies." },
    ],
    run: (context, args) => {
      const revises = stringFlag(args, "revises");
      return context.ledger().addIdea({
        projectId: project(args), title: requiredFlag(args, "title"), pitch: requiredFlag(args, "pitch"),
        claimIds: listFlag(args, "claim").map(id => parseId("claim", id)),
        ...(revises === undefined ? {} : { revisesId: parseId("idea", revises) }),
      });
    },
  },
  {
    path: ["retract"],
    description: "Withdraw a mistaken note, quote, claim, test, or idea. It stays in the record, marked retracted. Verdicts citing a retracted quote or test become stale.",
    positionals: [{ name: "id", description: "N, Q, C, T, or I ID.", required: true }],
    flags: [{ name: "reason", type: "string", required: true, description: "What was wrong, and what replaces it if anything." }],
    run: (context, args) => {
      const { entity, id } = parseAnyId(args.positionals[0]!, RETRACTABLE);
      const target = RETRACTABLE.find(item => item === entity);
      if (!target) throw new CliError("USAGE", `${args.positionals[0]} cannot be retracted.`, 2);
      return context.ledger().retract(target, id, requiredFlag(args, "reason"));
    },
  },
  {
    path: ["show"],
    description: "Print a whole project: ideas, claims with status, tests, verdicts, reviews, quotes, searches, and sources.",
    flags: [
      projectFlag,
      { name: "for-review", type: "boolean", description: "What a fresh reviewer sees: constraints, claims, tests, the verdicts to review, quotes, and sources, without the author's notes or statuses." },
    ],
    run: (context, args) => args.flags["for-review"] === true ? context.ledger().showForReview(project(args)) : context.ledger().show(project(args)),
  },
  {
    path: ["export"],
    description: "Write a project to a file: JSON with every source's full text, or a Markdown report.",
    flags: [
      projectFlag,
      { name: "out", type: "string", required: true, description: "File to write." },
      { name: "format", type: "string", choices: ["json", "markdown"], description: "json (default) or markdown." },
    ],
    run: (context, args) => {
      const data = context.ledger().exportProject(project(args));
      const format = stringFlag(args, "format") ?? "json";
      const path = resolve(requiredFlag(args, "out"));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, format === "json" ? `${JSON.stringify(data, null, 2)}\n` : renderReport(data));
      return { path, format, claims: data.claims.length, ideas: data.ideas.length, sources: data.sources.length };
    },
  },
  {
    path: ["legacy", "export"],
    description: "Export every project from the desktop app's database once, read-only: a snapshot of the database plus each project's research JSON and ideas as JSON and Markdown.",
    flags: [{ name: "out", type: "string", description: "An empty or new folder (default %APPDATA%\\scraply\\desktop-export)." }],
    run: (context, args) => exportDesktopProjects(context.profileDir, resolve(stringFlag(args, "out") ?? join(context.profileDir, "desktop-export"))),
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
