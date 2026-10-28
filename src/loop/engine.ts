import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
import { CLAIM_KINDS, QUOTE_KINDS, parseId, type FetchedSource, type Ledger } from "../cli/ledger";
import { CliError } from "../cli/output";
import { headAndTail, type Think } from "./think";

/**
 * The seed-and-kill-test loop. `advance` runs exactly one step and returns what it did and what
 * comes next. The loop keeps no state of its own: it reads the project from the ledger, and the
 * ledger's step log records which steps ran on what, so a project can stop and resume anywhere,
 * and an agent or the owner can do any step by hand in between.
 *
 * frame -> survey -> (owner answers questions) -> split -> for each claim:
 *   design -> desk: gather, read | experiment: script, (owner approves), run, read -> verdict -> review
 * -> findings and variants (by the model, or by the calling agent with `agentFindings`)
 * -> the owner accepts a variant, which splits into new claims, and so on.
 *
 * Every write goes through the ledger, so the model is held to the same rules as anyone else:
 * quotes must be verbatim, support needs new evidence, a need needs two speakers, and a verdict
 * only counts once a separate review call upholds it.
 */

type View = ReturnType<Ledger["show"]>;
type ClaimView = View["claims"][number];
type TestView = ClaimView["tests"][number];

export interface LoopContext {
  ledger: Ledger;
  projectId: number;
  think: Think;
  /** Web search returning page text; absent when no search provider has a key. */
  searchWeb?: (query: string) => Promise<{ provider: string; sources: FetchedSource[] }>;
  runCommand: (command: readonly string[], cwd: string) => Promise<{ command: string; exitCode: number; output: string; truncated?: boolean }>;
  /** This project's folder for experiment files. */
  workDir: string;
  /** Pages each web search returns, so a desk test plans a stop condition the searches can reach. */
  resultsPerSearch: number;
  /** Programs the experiment scripts may use, such as "bun 1.3" or "uv". */
  tools: readonly string[];
  /** Run model-written experiments without stopping for the owner to read them first. */
  trust: boolean;
  /** Go on even though the owner has not answered the framing questions. */
  skipQuestions: boolean;
  /** Stop when the pass is finished so the calling agent writes the findings and variants, instead of the model. */
  agentFindings: boolean;
  notify: (text: string) => void;
}

export interface StepResult {
  step: string;
  did: string;
  status: "continue" | "needs-you" | "done";
  next?: string;
}

const AUTHOR = "scraply-author";
const REVIEWER = "scraply-reviewer";
const MAX_RUNS = 4;
const ATTEMPT_FILE_CHARS = 20_000;
const MAX_TESTS_PER_CLAIM = 2;
const READ_SOURCE_CHARS = 25_000;
const READ_BATCH_CHARS = 75_000;
/** Quotes from earlier work a verdict or the findings see beside their own; older ones beyond it are left out. */
const CONTEXT_QUOTE_BYTES = 500_000;
/** How much of one quote the findings step sees; it cites quotes by ID, so the text is context. */
const FINDINGS_QUOTE_CHARS = 2_000;
/** Each run's output the findings step sees: up to twelve tests stay well under the worker's 2 MiB input. */
const FINDINGS_RUN_CHARS = 40_000;
const SURVEY_SOURCES = 8;
/** Uncited sources the test read, shown in full to its reviewer beside the cited ones. */
const REVIEW_UNCITED_SOURCES = 6;

// A quote is a sentence or two; the ceiling also stops a runaway answer before the worker's output limit does.
const QuoteSchema = z.object({ source: z.string(), text: z.string().max(1_500), speaker: z.string().max(200), kind: z.enum(QUOTE_KINDS) }).strict();
const FrameSchema = z.object({
  framing: z.string().min(1), surveyQueries: z.array(z.string().min(1)).max(3),
  questions: z.array(z.object({ question: z.string().min(1), assumption: z.string().min(1) }).strict()).max(3),
}).strict();
const SurveySchema = z.object({ priorArt: z.string().min(1), quotes: z.array(QuoteSchema).max(20) }).strict();
const SplitSchema = z.object({
  idea: z.object({ title: z.string().min(1), pitch: z.string().min(1) }).strict(),
  claims: z.array(z.object({ kind: z.enum(CLAIM_KINDS), statement: z.string().min(1), killIf: z.string().min(1) }).strict()).max(6),
  reuse: z.array(z.string()),
}).strict();
const DesignSchema = z.object({
  claim: z.string(), why: z.string().min(1), kind: z.enum(["desk", "experiment"]),
  // Empty when the test needs the owner; the engine refuses an empty test otherwise.
  method: z.string(), prediction: z.string(), stopWhen: z.string(),
  queries: z.array(z.string().min(1)).max(5),
  cuts: z.array(z.string().min(1)).max(6),
  sanity: z.string().nullable(), control: z.string().nullable(), holdout: z.string().nullable(),
  needsOwner: z.string().nullable(), setAside: z.string().nullable(),
}).strict();
const ScriptSchema = z.object({
  files: z.array(z.object({ name: z.string().min(1), content: z.string() }).strict()).min(1).max(8),
  command: z.array(z.string().min(1)).min(1),
  explanation: z.string(),
}).strict();
const ReadSchema = z.object({ quotes: z.array(QuoteSchema.extend({ bearing: z.enum(["for", "against", "context"]) }).strict()).max(30) }).strict();
const VerdictSchema = z.object({ result: z.enum(["killed", "unclear", "provisional"]), quotes: z.array(z.string()), note: z.string().min(1) }).strict();
const ReviewSchema = z.object({ result: z.enum(["upheld", "overturned"]), note: z.string().min(1) }).strict();
const FindingsSchema = z.object({
  summary: z.string().min(1),
  findings: z.array(z.object({ text: z.string().min(1), quotes: z.array(z.string()) }).strict()).max(6),
  variants: z.array(z.object({ title: z.string().min(1), pitch: z.string().min(1), why: z.string().min(1) }).strict()).max(3),
}).strict();
const VariantSchema = z.object({ title: z.string(), pitch: z.string(), why: z.string() });
const FindingsLogSchema = z.object({ variants: z.array(VariantSchema.extend({ note: z.string() })) });

/** A variant's title, pitch, and reason, from the findings step that proposed it, or from a variant note written outside the loop. */
function variantFrom(context: LoopContext, note: { id: string; text: string }) {
  for (const entry of context.ledger.steps(context.projectId).filter(item => item.step === "findings")) {
    const parsed = FindingsLogSchema.safeParse(entry.detail);
    const found = parsed.success ? parsed.data.variants.find(item => item.note === note.id) : undefined;
    if (found) return found;
  }
  return { note: note.id, title: note.text.slice(0, 80), pitch: note.text, why: "Written outside the loop; the pitch gives its reasons." };
}

/** Steps that ran, by name and target, from the ledger's step log. */
function stepLog(context: LoopContext) {
  const steps = context.ledger.steps(context.projectId);
  return {
    steps,
    last: (step: string, target?: string) => steps.filter(item => item.step === step && (target === undefined || item.target === target)).at(-1),
  };
}

const live = <T extends { retracted?: string }>(items: readonly T[]) => items.filter(item => !item.retracted);
const today = () => new Date().toISOString().slice(0, 10);

/** The files of the script that produced each run of a test, by run source ID. */
function runCode(context: LoopContext, testId: string) {
  const steps = context.ledger.steps(context.projectId);
  const scripts = steps.filter(item => item.step === "script" && item.target === testId);
  return steps.filter(item => item.step === "run" && item.target === testId).map((run, index) => {
    const written = z.object({ dir: z.string(), files: z.array(z.string()) }).safeParse(scripts[index]?.detail);
    const source = z.object({ source: z.string() }).safeParse(run.detail);
    return {
      run: source.success ? source.data.source : null,
      files: written.success ? written.data.files.filter(name => existsSync(`${written.data.dir}/${name}`))
        .map(name => ({ name, content: readFileSync(`${written.data.dir}/${name}`, "utf8").slice(0, ATTEMPT_FILE_CHARS) })) : [],
    };
  });
}

/** A source's whole saved text; the ledger hands it out one window at a time. */
function fullText(context: LoopContext, sourceId: string) {
  let text = "";
  for (let offset: number | undefined = 0; offset !== undefined;) {
    const window = context.ledger.readSource(parseId("source", sourceId), offset);
    text += window.text;
    offset = window.nextOffset;
  }
  return text;
}

/** A run counts only if it exited cleanly and did not report a failed sanity check or setup. */
function runSucceeded(context: LoopContext, run: { id: string; exitCode?: number | null }) {
  if (run.exitCode !== 0) return false;
  return !/sanity check failed|setup failed/i.test(fullText(context, run.id));
}

/** The claim's newest test, if no verdict answers it yet. A verdict that names no test answers every test written before it. */
function openTest(claim: ClaimView): TestView | undefined {
  const test = live(claim.tests).at(-1);
  if (!test) return undefined;
  const answered = claim.verdicts.some(verdict => "test" in verdict ? verdict.test === test.id : verdict.decidedAt >= test.predictedAt);
  return answered ? undefined : test;
}

function currentIdea(view: View) {
  return live(view.ideas).at(-1);
}

function ideaClaims(view: View) {
  const idea = currentIdea(view);
  return idea ? idea.claims.map(link => view.claims.find(claim => claim.id === link.id)!).filter(claim => !claim.retracted) : [];
}

/** Save model-proposed quotes through the ledger. A quote that is not verbatim, or not from an allowed source, is dropped and counted. */
function saveQuotes(context: LoopContext, quotes: readonly z.infer<typeof QuoteSchema>[], allowed: ReadonlySet<string>) {
  const saved: string[] = [];
  let dropped = 0;
  for (const quote of quotes) {
    try {
      // A part of a long run, such as S7.2, is quoted as its run, S7.
      const source = quote.source.trim().toUpperCase().replace(/\.\d+$/, "");
      if (!allowed.has(source)) throw new Error("source not offered");
      saved.push(context.ledger.addQuote(parseId("source", source), quote.text, quote.speaker, quote.kind).id);
    } catch {
      dropped += 1;
    }
  }
  return { saved, dropped };
}

/**
 * Sources as evidence. A page is cut to a size one model call can read in full; an experiment run is given whole,
 * in parts of that size, because its measurements are often printed last. Evidence IDs must be unique, so a part
 * is S7.1, S7.2, and so on; `source` names the saved source either way.
 */
function sourceEvidence(context: LoopContext, sourceIds: readonly string[]) {
  return sourceIds.flatMap(id => {
    const source = context.ledger.readSource(parseId("source", id), 0);
    if (!source.command) return [{ id, source: id, content: { title: source.title, url: source.url, text: source.text.slice(0, READ_SOURCE_CHARS) } }];
    const text = fullText(context, id);
    const parts = Math.max(1, Math.ceil(text.length / READ_SOURCE_CHARS));
    return Array.from({ length: parts }, (_, index) => ({
      id: parts > 1 ? `${id}.${index + 1}` : id, source: id, content: {
        title: source.title, url: source.url, command: source.command, exitCode: source.exitCode,
        ...(parts > 1 ? { part: `${index + 1} of ${parts}` } : {}), text: text.slice(index * READ_SOURCE_CHARS, (index + 1) * READ_SOURCE_CHARS),
      },
    }));
  });
}

function batches<T extends { content: { text: string } }>(items: readonly T[]) {
  const groups: T[][] = [];
  let size = 0;
  for (const item of items) {
    if (!groups.length || size + item.content.text.length > READ_BATCH_CHARS) { groups.push([]); size = 0; }
    groups.at(-1)!.push(item);
    size += item.content.text.length;
  }
  return groups;
}

async function search(context: LoopContext, query: string) {
  if (!context.searchWeb) return null;
  try {
    const found = await context.searchWeb(query);
    return context.ledger.recordSearch(context.projectId, found.provider, query, { sources: found.sources });
  } catch (error) {
    return context.ledger.recordSearch(context.projectId, "web", query, { error: error instanceof Error ? error.message : "The search failed." });
  }
}

/** The newest items whose JSON fits in `maxBytes`, in their original order; the worker takes at most 2 MiB a call. */
function newestWithin<T>(items: readonly T[], maxBytes: number) {
  const kept: T[] = [];
  let size = 0;
  for (const item of [...items].reverse()) {
    size += Buffer.byteLength(JSON.stringify(item));
    if (size > maxBytes) break;
    kept.unshift(item);
  }
  return kept;
}

/** Each of the current idea's claims with its status, as a write-up saw them. */
function claimStatuses(view: View) {
  return Object.fromEntries(ideaClaims(view).map(claim => [claim.id, claim.status]));
}

function ownerSources(view: View) {
  return view.sources.filter(source => source.via === "owner" && source.status === "ok");
}

function constraints(view: View) {
  return live(view.notes).filter(note => note.kind === "constraint").map(note => note.text);
}

// ---- Steps ----

async function frame(context: LoopContext, view: View): Promise<StepResult> {
  const output = await context.think({
    step: "frame", goal: "Frame the owner's seed the way the best expert in its field would.", schema: FrameSchema,
    inputs: { seed: view.project.seed, constraints: constraints(view) },
  });
  context.ledger.addNote(context.projectId, "framing", output.framing);
  for (const item of output.questions) context.ledger.addNote(context.projectId, "question", `${item.question} If unanswered: ${item.assumption}`);
  context.ledger.logStep(context.projectId, "frame", null, { surveyQueries: output.surveyQueries, assumptions: output.questions.map(item => item.assumption) });
  return { step: "frame", did: `Framed the seed${output.questions.length ? ` and asked ${output.questions.length} question(s)` : ""}.`, status: "continue" };
}

async function survey(context: LoopContext, view: View): Promise<StepResult> {
  const framed = z.object({ surveyQueries: z.array(z.string()) }).parse(stepLog(context).last("frame")!.detail);
  const searches = [];
  for (const query of framed.surveyQueries) {
    context.notify(`Searching: ${query}`);
    const result = await search(context, query);
    if (result) searches.push(result);
  }
  const sourceIds = searches.flatMap(item => item.sources.filter(source => source.status === "ok" && source.kind !== "excerpt").map(source => source.id)).slice(0, SURVEY_SOURCES);
  if (!sourceIds.length) {
    context.ledger.logStep(context.projectId, "survey", null, { searches: searches.map(item => item.id), skipped: context.searchWeb ? "no pages found" : "no search key" });
    return { step: "survey", did: context.searchWeb ? "Surveyed what exists; the searches found no readable pages." : "Skipped the survey: no search key is saved.", status: "continue" };
  }
  const output = await context.think({
    step: "survey", goal: "Say what already exists for this seed, from the evidence.", schema: SurveySchema,
    inputs: { seed: view.project.seed, framing: live(view.notes).filter(note => note.kind === "framing").map(note => note.text) },
    evidence: sourceEvidence(context, sourceIds),
  });
  const quotes = saveQuotes(context, output.quotes, new Set(sourceIds));
  context.ledger.addNote(context.projectId, "prior-art", output.priorArt, quotes.saved.map(id => parseId("quote", id)));
  context.ledger.logStep(context.projectId, "survey", null, { searches: searches.map(item => item.id), quotes: quotes.saved, dropped: quotes.dropped });
  return { step: "survey", did: `Surveyed what exists from ${sourceIds.length} page(s); saved ${quotes.saved.length} quote(s).`, status: "continue" };
}

async function split(context: LoopContext, view: View, variant?: { note: string; title: string; pitch: string; why: string }): Promise<StepResult> {
  const previous = variant ? ideaClaims(view) : [];
  const output = await context.think({
    step: "split", goal: variant ? "State the accepted variant and the claims it rests on." : "State the idea and the claims it rests on.", schema: SplitSchema,
    inputs: {
      seed: view.project.seed, constraints: constraints(view),
      framing: live(view.notes).filter(note => note.kind === "framing").map(note => note.text),
      priorArt: live(view.notes).filter(note => note.kind === "prior-art").map(note => note.text),
      ...(variant ? {
        variant: { title: variant.title, pitch: variant.pitch, why: variant.why },
        previousIdea: currentIdea(view),
        previousClaims: previous.map(claim => ({ id: claim.id, kind: claim.kind, statement: claim.statement, killIf: claim.killIf, status: claim.status })),
        findings: live(view.notes).filter(note => note.kind === "finding").map(note => note.text),
      } : {}),
    },
  });
  const reused = output.reuse.map(id => id.trim().toUpperCase()).filter(id => previous.some(claim => claim.id === id));
  const created = output.claims.map(claim => context.ledger.addClaim(context.projectId, claim.kind, claim.statement, claim.killIf).id);
  const claimIds = [...reused, ...created];
  if (!claimIds.length) throw new CliError("MODEL_FAILED", "The split step returned no claims. Run the command again.");
  const idea = context.ledger.addIdea({
    projectId: context.projectId, title: output.idea.title, pitch: output.idea.pitch, claimIds: claimIds.map(id => parseId("claim", id)),
    ...(variant && currentIdea(view) ? { revisesId: parseId("idea", currentIdea(view)!.id) } : {}),
  });
  context.ledger.logStep(context.projectId, "split", variant?.note ?? null, { idea: idea.id, claims: claimIds });
  return { step: "split", did: `Saved ${idea.id} "${output.idea.title}" resting on ${claimIds.length} claim(s).`, status: "continue" };
}

async function design(context: LoopContext, view: View, testable: readonly ClaimView[]): Promise<StepResult> {
  let refusal: string | undefined;
  let output: z.infer<typeof DesignSchema> | undefined;
  const blocks = stepLog(context).steps.filter(item => item.step === "blocked");
  /** What the owner was asked for this claim, and the newest constraint note at the time. */
  const requests = (claimId: string) => blocks.filter(item => item.target?.trim().toUpperCase() === claimId)
    .map(item => z.object({ needsOwner: z.string(), notes: z.number() }).parse(item.detail));
  const answered = (claimId: string) => requests(claimId)
    .some(request => live(view.notes).some(note => note.kind === "constraint" && parseId("note", note.id) > request.notes));
  for (let attempt = 0; attempt < 2 && !output; attempt += 1) {
    const proposed = await context.think({
      step: "design", goal: "Pick the cheapest decisive open claim and write its test before looking.", schema: DesignSchema,
      inputs: {
        idea: currentIdea(view), constraints: constraints(view), tools: context.tools, searchAvailable: Boolean(context.searchWeb),
        searchBudget: { maxQueries: 5, resultsPerQuery: context.resultsPerSearch }, today: today(),
        ownerMaterial: ownerSources(view).map(source => ({ id: source.id, title: source.title, chars: source.chars })),
        claims: ideaClaims(view).map(claim => ({
          id: claim.id, kind: claim.kind, statement: claim.statement, killIf: claim.killIf, status: claim.status, open: testable.some(item => item.id === claim.id),
          earlierTests: claim.tests.map(test => ({ kind: test.kind, method: test.method, prediction: test.prediction })),
          verdicts: claim.verdicts.map(verdict => ({ result: verdict.result, note: verdict.note, reviews: verdict.reviews.map(review => ({ result: review.result, note: review.note })) })),
          askedOwner: requests(claim.id).map(item => item.needsOwner),
        })),
        ...(refusal ? { previousRefusal: refusal } : {}),
      },
    });
    // Whatever the answer is, it is about one of the open claims.
    const claimId = proposed.claim.trim().toUpperCase();
    if (!testable.some(item => item.id === claimId)) {
      refusal = `Name one of the open claims: ${testable.map(item => item.id).join(", ")}.`;
      continue;
    }
    if (proposed.setAside) {
      // Only the owner's answer to this claim's own request can set it aside, so a hard claim is never skipped on the model's say-so.
      if (answered(claimId)) {
        context.ledger.logStep(context.projectId, "untestable", claimId, { why: proposed.setAside });
        return { step: "design", status: "continue", did: `Set ${claimId} aside: it cannot be tested with what the owner has (${proposed.setAside}).` };
      }
      refusal = "setAside is only for an open claim whose request (askedOwner) the owner has answered by saying they cannot provide it.";
      continue;
    }
    if (proposed.needsOwner) {
      // The decisive test needs something only the owner can give; say exactly what instead of running a hollow test.
      context.ledger.logStep(context.projectId, "blocked", claimId, {
        needsOwner: proposed.needsOwner,
        notes: Math.max(...live(view.notes).filter(note => note.kind === "constraint").map(note => parseId("note", note.id)), 0),
        files: view.sources.filter(source => source.via === "owner").length,
      });
      return {
        step: "design", status: "needs-you", did: `The next decisive test needs you: ${proposed.needsOwner}`,
        next: `Provide it, as an answer (scraply note add --project ${view.project.id} --kind constraint --text "...") or a file (scraply source add --project ${view.project.id} --file <path> --title "..." --origin owner), then run scraply auto again.`,
      };
    }
    const experiment = proposed.kind === "experiment" && proposed.sanity && proposed.control && proposed.holdout;
    if (!proposed.method.trim() || !proposed.prediction.trim() || !proposed.stopWhen.trim()) refusal = "A test needs a method, a prediction, and a stop condition, or set needsOwner.";
    else if (proposed.kind === "experiment" && !experiment) refusal = "An experiment needs sanity, control, and holdout, each filled in.";
    else if (!experiment && !proposed.queries.length) refusal = "A desk test needs at least one search query. Write queries, design an experiment, or set needsOwner.";
    else if (!experiment && !context.searchWeb) refusal = "No web search is available, so the test must be an experiment, or set needsOwner.";
    else output = proposed;
  }
  if (!output) {
    if (!context.searchWeb) throw new CliError("NO_KEY", "The next test needs web search, and no search provider has a key. Save one with: scraply key set exa");
    throw new CliError("MODEL_FAILED", `The design step could not produce a runnable test (${refusal}). Run the command again.`);
  }
  const claim = testable.find(item => item.id === output.claim.trim().toUpperCase())!;
  const experiment = output.kind === "experiment" && output.sanity && output.control && output.holdout;
  const test = context.ledger.addTest(parseId("claim", claim.id), {
    method: output.method, prediction: output.prediction, stopWhen: output.stopWhen,
    ...(experiment
      ? { kind: "experiment" as const, sanity: output.sanity!, control: output.control!, holdout: output.holdout!, plan: { cuts: output.cuts } }
      : { kind: "desk" as const, plan: { queries: output.queries } }),
  });
  context.ledger.logStep(context.projectId, "design", test.id, { claim: claim.id, why: output.why });
  return { step: "design", did: `Wrote ${test.kind} test ${test.id} for ${claim.id}: ${output.why}`, status: "continue" };
}

async function gather(context: LoopContext, test: TestView): Promise<StepResult> {
  const queries = z.object({ queries: z.array(z.string()) }).parse(test.plan).queries;
  const searches = [];
  for (const query of queries) {
    context.notify(`Searching: ${query}`);
    const result = await search(context, query);
    if (result) searches.push(result.id);
  }
  context.ledger.logStep(context.projectId, "gather", test.id, { searches });
  return { step: "gather", did: `Ran ${searches.length} search(es) for ${test.id}.`, status: "continue" };
}

async function read(context: LoopContext, view: View, claim: ClaimView, test: TestView, sourceIds: readonly string[]): Promise<StepResult> {
  const evidence = sourceEvidence(context, sourceIds);
  const ask = (group: typeof evidence) => context.think({
    step: "read", goal: `Quote everything in these sources that bears on ${claim.id}, for or against.`, schema: ReadSchema,
    inputs: { claim: { id: claim.id, kind: claim.kind, statement: claim.statement, killIf: claim.killIf }, test, idea: currentIdea(view) },
    evidence: group,
  });
  // A batch whose call fails is read again one source at a time, so one page the model cannot answer for
  // never blocks the step; a source that still fails is left unread, and the verdict is told so.
  const answers: { group: typeof evidence; quotes: z.infer<typeof ReadSchema>["quotes"] }[] = [];
  const unread = new Set<string>();
  let failure: CliError | undefined;
  const failed = (group: typeof evidence, error: unknown) => {
    if (!(error instanceof CliError && error.code === "MODEL_FAILED")) throw error;
    context.notify(`Reading ${group.map(item => item.id).join(", ")} failed: ${error.message}`);
    failure = error;
  };
  for (const group of batches(evidence)) {
    try {
      answers.push({ group, quotes: (await ask(group)).quotes });
      continue;
    } catch (error) { failed(group, error); }
    if (group.length === 1) { unread.add(group[0]!.source); continue; }
    for (const item of group) {
      try { answers.push({ group: [item], quotes: (await ask([item])).quotes }); }
      catch (error) { failed([item], error); unread.add(item.source); }
    }
  }
  // Stop only when nothing could be read; a source with any part unread is reported as unread.
  if (failure && !answers.length) throw failure;
  const saved: string[] = [];
  const bearings: { quote: string; bearing: string }[] = [];
  let dropped = 0;
  for (const answer of answers) {
    for (const quote of answer.quotes) {
      const result = saveQuotes(context, [quote], new Set(answer.group.map(item => item.source)));
      saved.push(...result.saved);
      bearings.push(...result.saved.map(id => ({ quote: id, bearing: quote.bearing })));
      dropped += result.dropped;
    }
  }
  context.ledger.logStep(context.projectId, "read", test.id, { sources: sourceIds, quotes: saved, bearings, dropped, unread: [...unread] });
  return {
    step: "read", status: "continue",
    did: `Read ${sourceIds.length - unread.size} source(s) for ${test.id}; saved ${saved.length} quote(s)${dropped ? `, dropped ${dropped} not found word for word` : ""}${unread.size ? `; could not read ${[...unread].join(", ")}` : ""}.`,
  };
}

async function script(context: LoopContext, view: View, claim: ClaimView, test: TestView, runs: readonly View["sources"][number][]): Promise<StepResult> {
  const scripts = stepLog(context).steps.filter(item => item.step === "script" && item.target === test.id);
  const attempt = scripts.length + 1;
  // Each earlier attempt with its own code and what it printed, so a fix starts from the code that failed.
  const earlierAttempts = runs.map((run, index) => {
    const written = z.object({ dir: z.string(), files: z.array(z.string()) }).safeParse(scripts[index]?.detail);
    return {
      command: run.command, exitCode: run.exitCode,
      files: written.success ? written.data.files.filter(name => existsSync(`${written.data.dir}/${name}`))
        .map(name => ({ name, content: readFileSync(`${written.data.dir}/${name}`, "utf8").slice(0, ATTEMPT_FILE_CHARS) })) : [],
      outputTail: context.ledger.readSource(parseId("source", run.id), Math.max(0, run.chars - 6_000)).text,
    };
  });
  // Code that already worked for earlier experiments in this project, so data access is not rediscovered.
  const workingCode = stepLog(context).steps.filter(item => item.step === "run" && item.target !== test.id)
    .filter(item => z.object({ source: z.string() }).safeParse(item.detail).success)
    .map(item => ({ target: item.target, source: z.object({ source: z.string() }).parse(item.detail).source }))
    .filter(item => { const run = view.sources.find(source => source.id === item.source); return run !== undefined && runSucceeded(context, run); })
    .slice(-2)
    .flatMap(item => {
      const scriptStep = stepLog(context).steps.filter(step => step.step === "script" && step.target === item.target).at(-1);
      const written = z.object({ dir: z.string(), files: z.array(z.string()) }).safeParse(scriptStep?.detail);
      return written.success ? written.data.files.filter(name => existsSync(`${written.data.dir}/${name}`))
        .map(name => ({ test: item.target, name, content: readFileSync(`${written.data.dir}/${name}`, "utf8").slice(0, ATTEMPT_FILE_CHARS) })) : [];
    });
  const output = await context.think({
    step: "script", goal: `Write the program that runs experiment ${test.id}.`, schema: ScriptSchema,
    inputs: {
      claim: { id: claim.id, statement: claim.statement, killIf: claim.killIf }, test, constraints: constraints(view), tools: context.tools, today: today(), earlierAttempts, workingCodeFromEarlierTests: workingCode,
      // Files the owner handed over, copied into the attempt folder before the script runs.
      ownerFiles: ownerSources(view).map(source => ({ path: `owner/${source.id}.txt`, title: source.title, chars: source.chars })),
    },
  });
  const dir = join(context.workDir, test.id, `attempt-${attempt}`);
  mkdirSync(join(dir, "owner"), { recursive: true });
  for (const source of ownerSources(view)) writeFileSync(join(dir, "owner", `${source.id}.txt`), fullText(context, source.id));
  // Files stay inside the attempt folder: relative paths only, no climbing out.
  for (const file of output.files) {
    const target = resolve(dir, file.name);
    if (!target.startsWith(`${resolve(dir)}${sep}`)) throw new CliError("MODEL_FAILED", `The script named a file outside its folder (${file.name}). Run the command again.`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
  context.ledger.logStep(context.projectId, "script", test.id, { attempt, dir, command: output.command, files: output.files.map(file => file.name), explanation: output.explanation });
  return context.trust
    ? { step: "script", did: `Wrote attempt ${attempt} for ${test.id} in ${dir}.`, status: "continue" }
    : {
      step: "script", did: `Wrote attempt ${attempt} for ${test.id} in ${dir}: ${output.command.join(" ")}`, status: "needs-you",
      next: `Read the files in ${dir}, then run them with: scraply experiment approve --project ${view.project.id} --test ${test.id}`,
    };
}

/** Run the newest script for an experiment and save its output. Also used by `scraply experiment approve`. */
export async function runPendingScript(context: LoopContext, testId: string): Promise<StepResult> {
  const pending = stepLog(context).last("script", testId);
  if (!pending) throw new CliError("NO_SCRIPT", `${testId} has no script to run yet. Run: scraply next --project P${context.projectId}`);
  const lastRun = stepLog(context).last("run", testId);
  if (lastRun && lastRun.id > pending.id) throw new CliError("ALREADY_RAN", `The newest script for ${testId} already ran. Run: scraply next --project P${context.projectId}`);
  const detail = z.object({ dir: z.string(), command: z.array(z.string()) }).parse(pending.detail);
  // Refuse a test retracted since its script was written before running anything.
  context.ledger.requireExperiment(parseId("test", testId));
  context.notify(`Running in ${detail.dir}: ${detail.command.join(" ")}`);
  const run = await context.runCommand(detail.command, detail.dir);
  const source = context.ledger.saveRun(parseId("test", testId), run);
  context.ledger.logStep(context.projectId, "run", testId, { source: source.id, exitCode: run.exitCode });
  return { step: "run", did: `Ran ${testId} (exit code ${run.exitCode}); output saved as ${source.id}.`, status: "continue" };
}

async function decide(context: LoopContext, view: View, claim: ClaimView, test: TestView): Promise<StepResult> {
  const sources = new Map(view.sources.map(source => [source.id, source]));
  // What this test itself gathered, with each quote's bearing, kept apart from older context.
  const reads = stepLog(context).steps.filter(item => item.step === "read" && item.target === test.id)
    .map(item => z.object({
      sources: z.array(z.string()), bearings: z.array(z.object({ quote: z.string(), bearing: z.string() })).default([]), unread: z.array(z.string()).default([]),
    }).parse(item.detail));
  const bearing = new Map(reads.flatMap(item => item.bearings).map(item => [item.quote, item.bearing]));
  const describe = (quote: View["quotes"][number]) => {
    const source = sources.get(quote.source)!;
    return { id: quote.id, text: quote.text, speaker: quote.speaker, kind: quote.kind, ...(bearing.has(quote.id) ? { bearing: bearing.get(quote.id) } : {}), source: { id: source.id, title: source.title, url: source.url }, newSinceTest: source.fetchedAt > test.predictedAt };
  };
  const quotes = live(view.quotes).filter(quote => bearing.has(quote.id)).map(describe);
  const earlierQuotes = newestWithin(live(view.quotes).filter(quote => !bearing.has(quote.id)).map(describe), CONTEXT_QUOTE_BYTES);
  const searches = view.searches.filter(item => item.at > test.predictedAt);
  const runs = view.sources.filter(source => source.test === test.id).map(source => ({ id: source.id, exitCode: source.exitCode }));
  const unread = new Set(reads.flatMap(item => item.unread));
  const work = {
    searchesRun: searches.length, sourcesRead: new Set(reads.flatMap(item => item.sources).filter(id => !unread.has(id))).size, runs: runs.length, quotesSaved: quotes.length,
    // Pages the model failed to read: absence of evidence in them is not evidence of absence.
    ...(unread.size ? { sourcesUnread: [...unread] } : {}),
  };
  let refusal: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const output = await context.think({
      step: "verdict", goal: `Decide ${claim.id} against its kill condition and ${test.id}'s prediction.`, schema: VerdictSchema,
      inputs: {
        claim: { id: claim.id, kind: claim.kind, statement: claim.statement, killIf: claim.killIf }, test, workDone: work, today: today(),
        quotesFromThisTest: quotes, earlierQuotes, searchesSinceTest: searches, runs, ...(refusal ? { previousRefusal: refusal } : {}),
      },
    });
    try {
      const verdict = context.ledger.addVerdict({
        claimId: parseId("claim", claim.id), result: output.result, note: output.note, author: AUTHOR, testId: parseId("test", test.id),
        quoteIds: output.quotes.map(id => parseId("quote", id)),
      });
      context.ledger.logStep(context.projectId, "verdict", test.id, { verdict: verdict.id, result: output.result });
      return { step: "verdict", did: `${verdict.id}: ${claim.id} is ${verdict.status}.`, status: "continue" };
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      refusal = `${error.code}: ${error.message}`;
      context.notify(`The ledger refused the verdict (${refusal}). Asking again.`);
    }
  }
  const verdict = context.ledger.addVerdict({
    claimId: parseId("claim", claim.id), result: "unclear", author: AUTHOR, testId: parseId("test", test.id), quoteIds: [],
    note: `The proposed verdict was refused twice by the ledger rules, last with ${refusal?.split(":")[0]}. Recorded as unclear.`,
  });
  context.ledger.logStep(context.projectId, "verdict", test.id, { verdict: verdict.id, result: "unclear", refusal });
  return { step: "verdict", did: `${verdict.id}: ${claim.id} is unclear after two refused verdicts.`, status: "continue" };
}

async function review(context: LoopContext, claim: ClaimView): Promise<StepResult> {
  const blind = context.ledger.showForReview(context.projectId);
  const verdictId = blind.toReview.find(id => claim.verdicts.at(-1)?.id === id)!;
  const blindClaim = blind.claims.find(item => item.id === claim.id)!;
  const verdict = blindClaim.verdicts.find(item => item.id === verdictId)!;
  const cited = blind.quotes.filter(quote => verdict.quotes.includes(quote.id));
  // Everything the test read, so a kill that rests on finding nothing can be checked against what was there.
  const read = stepLog(context).steps.filter(item => item.step === "read" && item.target === verdict.test)
    .map(item => z.object({ sources: z.array(z.string()), quotes: z.array(z.string()) }).parse(item.detail));
  const readSources = [...new Set(read.flatMap(item => item.sources))];
  const gathered = blind.quotes.filter(quote => read.some(item => item.quotes.includes(quote.id)) && !verdict.quotes.includes(quote.id));
  const citedSources = [...new Set(cited.map(quote => quote.source))];
  const sourceIds = [...citedSources, ...readSources.filter(id => !citedSources.includes(id)).slice(0, REVIEW_UNCITED_SOURCES)];
  const output = await context.think({
    step: "review", goal: `Try to break verdict ${verdictId} on ${claim.id}.`, schema: ReviewSchema,
    inputs: {
      claim: { id: blindClaim.id, kind: blindClaim.kind, statement: blindClaim.statement, killIf: blindClaim.killIf },
      tests: blindClaim.tests, verdict, citedQuotes: cited, otherQuotesTheTestGathered: gathered, constraints: blind.constraints.map(note => note.text),
      sourcesTheTestRead: blind.sources.filter(source => readSources.includes(source.id)).map(source => ({ id: source.id, title: source.title, url: source.url })),
      ...(verdict.test && blindClaim.tests.find(test => test.id === verdict.test)?.kind === "experiment"
        // Every run with its code and the end of its output, so "it could not run" can be checked too.
        ? {
          experimentRuns: runCode(context, verdict.test).filter(item => item.run).map(item => {
            const run = context.ledger.readSource(parseId("source", item.run!), 0);
            return { ...item, exitCode: run.exitCode, outputTail: fullText(context, item.run!).slice(-4_000) };
          }),
        } : {}),
      searches: blind.searches.filter(item => verdict.test && item.at > (blindClaim.tests.find(test => test.id === verdict.test)?.predictedAt ?? "")),
    },
    evidence: sourceEvidence(context, sourceIds),
  });
  const result = context.ledger.addReview({ verdictId: parseId("verdict", verdictId), result: output.result, note: output.note, reviewer: REVIEWER });
  context.ledger.logStep(context.projectId, "review", verdictId, { result: output.result });
  return { step: "review", did: `Reviewed ${verdictId}: ${output.result}; ${claim.id} is ${result.status}.`, status: "continue" };
}

async function findings(context: LoopContext, view: View): Promise<StepResult> {
  const claims = ideaClaims(view);
  const output = await context.think({
    step: "findings", goal: "Take stock of the pass and propose where the evidence points next.", schema: FindingsSchema,
    inputs: {
      seed: view.project.seed, idea: currentIdea(view), constraints: constraints(view),
      claims: claims.map(claim => {
        const setAside = stepLog(context).steps.filter(item => item.step === "untestable" && item.target === claim.id).at(-1);
        return {
          id: claim.id, kind: claim.kind, statement: claim.statement, killIf: claim.killIf, status: claim.status,
          ...(setAside ? { untestableWithWhatTheOwnerHas: z.object({ why: z.string() }).parse(setAside.detail).why } : {}),
          verdicts: claim.verdicts.map(verdict => ({ result: verdict.result, note: verdict.note, quotes: verdict.quotes })),
        };
      }),
      // One size budget for every quote, so a long project stays within one call: the ones this pass's verdicts cite
      // come last and are kept first, then the newest others; a very long quote is cut to its start and end.
      quotes: (() => {
        const cited = new Set(claims.flatMap(claim => claim.verdicts.flatMap(verdict => verdict.quotes)));
        const brief = (quote: View["quotes"][number]) => ({ id: quote.id, text: headAndTail(quote.text, FINDINGS_QUOTE_CHARS), speaker: quote.speaker, kind: quote.kind });
        const quotes = live(view.quotes);
        return newestWithin([...quotes.filter(quote => !cited.has(quote.id)), ...quotes.filter(quote => cited.has(quote.id))].map(brief), CONTEXT_QUOTE_BYTES);
      })(),
      priorArt: live(view.notes).filter(note => note.kind === "prior-art" || note.kind === "framing").map(note => ({ kind: note.kind, text: note.text })),
      // The newest good run of each of this idea's tests, cut to its start and end so the call stays within the worker's input limit.
      experimentOutput: claims.flatMap(claim => live(claim.tests)).flatMap(test => {
        const run = view.sources.filter(source => source.test === test.id && runSucceeded(context, source)).at(-1);
        return run ? [{ source: run.id, test: test.id, text: headAndTail(fullText(context, run.id), FINDINGS_RUN_CHARS) }] : [];
      }),
    },
  });
  context.ledger.addNote(context.projectId, "summary", output.summary);
  const known = new Set(live(view.quotes).map(quote => quote.id));
  let saved = 0;
  for (const finding of output.findings) {
    const quotes = finding.quotes.map(id => id.trim().toUpperCase()).filter(id => known.has(id));
    if (!quotes.length) continue;
    context.ledger.addNote(context.projectId, "finding", finding.text, quotes.map(id => parseId("quote", id)));
    saved += 1;
  }
  const variants = output.variants.map(variant => ({ ...variant, note: context.ledger.addNote(context.projectId, "variant", `${variant.title}: ${variant.pitch} Why: ${variant.why}`).id }));
  context.ledger.logStep(context.projectId, "findings", currentIdea(view)?.id ?? null, { summary: output.summary, variants, statuses: claimStatuses(view) });
  return {
    step: "findings", did: `${output.summary} Saved ${saved} finding(s) and ${variants.length} variant(s).`, status: "needs-you",
    next: pickVariant(view.project.id, variants.map(item => item.note)),
  };
}

function pickVariant(projectId: string, variantIds: readonly string[]) {
  return variantIds.length
    ? `Pick a variant with: scraply variant accept <${variantIds.join("|")}> --project ${projectId} (read them in: scraply show --project ${projectId}), or stop here.`
    : `Nothing points to a variant. Export the report with: scraply export --project ${projectId} --format markdown --out <file>`;
}

/**
 * The findings step when the calling agent writes the ideas (`--agent-findings`). The first call records which notes
 * exist and asks for summary, finding, and variant notes; a later call that sees new ones closes the pass with them.
 * A summary alone closes a pass that left nothing to build on.
 */
function handOff(context: LoopContext, view: View, lastWorkId: number): StepResult {
  const projectId = view.project.id;
  const handoff = stepLog(context).steps.filter(item => item.step === "handoff" && item.id > lastWorkId).at(-1);
  const ask = {
    step: "findings", status: "needs-you" as const,
    next: `Write the pass up yourself from the record (scraply show --project ${projectId}, and each run's output with scraply source show S#): `
      + `scraply note add --project ${projectId} --kind summary --text "<what survived, what died, what is unknown>", `
      + `findings with scraply note add --project ${projectId} --kind finding --quote Q# --text "...", and up to three variants with `
      + `scraply note add --project ${projectId} --kind variant --text "<title>: <pitch> Why: <what in the evidence points there>". Then run scraply auto --project ${projectId} --agent-findings again.`,
  };
  if (!handoff) {
    const newest = Math.max(0, ...view.notes.map(note => parseId("note", note.id)));
    context.ledger.logStep(context.projectId, "handoff", currentIdea(view)?.id ?? null, { notes: newest });
    return { ...ask, did: "The pass is finished; the findings and variants are yours to write." };
  }
  const since = z.object({ notes: z.number() }).parse(handoff.detail).notes;
  const written = live(view.notes).filter(note => ["summary", "finding", "variant"].includes(note.kind) && parseId("note", note.id) > since);
  if (!written.length) return { ...ask, did: "Still waiting for the summary, findings, and variants." };
  const variants = written.filter(note => note.kind === "variant").map(note => note.id);
  const findingCount = written.filter(note => note.kind === "finding").length;
  context.ledger.logStep(context.projectId, "findings", currentIdea(view)?.id ?? null, { by: "agent", notes: written.map(note => note.id), statuses: claimStatuses(view) });
  return {
    step: "findings", status: "needs-you", did: `Saved ${findingCount} finding(s) and ${variants.length} variant(s) from the calling agent.`,
    next: pickVariant(projectId, variants),
  };
}

// ---- Choosing the next step ----

/** Run the one step the project needs next. */
export async function advance(context: LoopContext): Promise<StepResult> {
  const view = context.ledger.show(context.projectId);
  const log = stepLog(context);
  const projectId = view.project.id;

  if (!log.last("frame")) return frame(context, view);
  if (!log.last("survey")) return survey(context, view);

  const questions = live(view.notes).filter(note => note.kind === "question");
  const lastQuestion = questions.at(-1);
  const answered = !lastQuestion || live(view.notes).some(note => note.kind === "constraint" && parseId("note", note.id) > parseId("note", lastQuestion.id));
  if (!answered) {
    if (!context.skipQuestions) {
      return {
        step: "questions", status: "needs-you", did: `Waiting for answers to: ${questions.map(note => `${note.id} ${note.text}`).join(" ")}`,
        next: `Answer with: scraply note add --project ${projectId} --kind constraint --text "...", then run scraply next again. Or go on without answers: scraply next --project ${projectId} --skip-questions`,
      };
    }
    // Unanswered questions fall back to the assumptions the frame step stated, recorded where every later step and reviewer sees them.
    const assumptions = z.object({ assumptions: z.array(z.string()).default([]) }).parse(log.last("frame")!.detail).assumptions;
    for (const assumption of assumptions.length ? assumptions : ["Make reasonable choices where the owner gave none, and state them."]) {
      context.ledger.addNote(context.projectId, "constraint", `Assumed, because the owner went on without answering: ${assumption}`);
    }
    // Start over from the record, so the step that runs next already sees the assumptions.
    return advance(context);
  }

  // An accepted variant is split into its own idea before anything else.
  const accepted = log.last("accept");
  if (accepted && !log.steps.some(item => item.step === "split" && item.id > accepted.id)) {
    const note = live(view.notes).find(item => item.id === accepted.target);
    if (note) return split(context, view, variantFrom(context, note));
  }
  if (!currentIdea(view)) return split(context, view);

  const claims = ideaClaims(view);
  for (const claim of claims) {
    const test = openTest(claim);
    if (!test) continue;
    // A test written by hand has no search plan or script from the loop, so it is finished by hand.
    if (!log.last("design", test.id)) {
      return {
        step: "test", status: "needs-you", did: `${test.id} on ${claim.id} was written by hand, so the loop has no searches or script for it.`,
        next: `Gather its evidence (scraply search and fetch, or scraply experiment run --test ${test.id} -- <command>), save quotes, and record its verdict with scraply verdict add --claim ${claim.id} --test ${test.id}, then run scraply auto again.`,
      };
    }
    if (test.kind === "desk") {
      const gathered = log.last("gather", test.id);
      if (!gathered) return gather(context, test);
      if (!log.last("read", test.id)) {
        const searches = new Set(z.object({ searches: z.array(z.string()) }).parse(gathered.detail).searches);
        const seen = new Set<string>();
        const sourceIds = view.sources
          .filter(source => source.search && searches.has(source.search) && source.status === "ok" && source.kind !== "excerpt")
          .filter(source => {
            const keys = [source.url.split("#")[0]!.replace(/\/+$/, "").toLowerCase(), context.ledger.readSource(parseId("source", source.id), 0).contentHash ?? source.id];
            if (keys.some(key => seen.has(key))) return false;
            for (const key of keys) seen.add(key);
            return true;
          })
          .map(source => source.id);
        // Material the owner handed over is read by the next desk test, once.
        const readBefore = new Set(log.steps.filter(item => item.step === "read").flatMap(item => z.object({ sources: z.array(z.string()) }).parse(item.detail).sources));
        const ownerIds = ownerSources(view).filter(source => !readBefore.has(source.id)).map(source => source.id);
        return read(context, view, claim, test, [...ownerIds, ...sourceIds]);
      }
      return decide(context, view, claim, test);
    }
    const runs = view.sources.filter(source => source.test === test.id);
    const lastScript = log.last("script", test.id);
    const lastRun = log.last("run", test.id);
    const lastFailed = runs.length > 0 && !runSucceeded(context, runs.at(-1)!);
    if (!lastScript || (lastRun && lastRun.id > lastScript.id && lastFailed && runs.length < MAX_RUNS)) {
      return script(context, view, claim, test, runs);
    }
    if (!lastRun || lastRun.id < lastScript.id) {
      if (!context.trust) {
        return {
          step: "approve", status: "needs-you", did: `The script for ${test.id} is waiting in ${z.object({ dir: z.string() }).parse(lastScript.detail).dir}.`,
          next: `Read it, then run it with: scraply experiment approve --project ${projectId} --test ${test.id}`,
        };
      }
      return runPendingScript(context, test.id);
    }
    const lastRead = log.last("read", test.id);
    const good = runs.filter(run => runSucceeded(context, run));
    if (good.length && (!lastRead || lastRead.id < lastRun.id)) return read(context, view, claim, test, [good.at(-1)!.id]);
    return decide(context, view, claim, test);
  }

  const awaitingReview = claims.find(claim => claim.status === "provisional" || claim.status === "kill-pending"
    || (claim.status === "unclear" && claim.verdicts.at(-1)?.reviews.length === 0));
  if (awaitingReview) return review(context, awaitingReview);

  // An unclear claim gets one more, differently designed test before the pass gives up on it.
  const setAside = new Set(log.steps.filter(item => item.step === "untestable").map(item => item.target));
  const testable = claims.filter(claim => ["untested", "overturned", "stale", "unclear"].includes(claim.status)
    && live(claim.tests).length < MAX_TESTS_PER_CLAIM && !setAside.has(claim.id));
  const dead = claims.some(claim => claim.status === "killed" && claim.kind !== "feasibility");
  if (dead || !testable.length) {
    const lastFindings = log.last("findings");
    let lastWork = log.steps.filter(item => item.step !== "findings" && item.step !== "handoff").at(-1);
    if (lastFindings && (!lastWork || lastFindings.id > lastWork.id)) {
      // Anything recorded by hand since the write-up that changes a claim, such as a verdict, a review, or a retraction,
      // makes it stale: reopen it rather than call the pass finished.
      const written = z.object({ statuses: z.record(z.string()) }).safeParse(lastFindings.detail);
      const now = claimStatuses(view);
      const changed = (written.success && JSON.stringify(written.data.statuses) !== JSON.stringify(now))
        || claims.some(claim => claim.verdicts.some(verdict => verdict.decidedAt > lastFindings.at || verdict.reviews.some(review => review.at > lastFindings.at)));
      if (!changed) {
        return {
          step: "steer", status: "done", did: "This pass is finished.",
          next: `Accept a variant with: scraply variant accept <note>, or export: scraply export --project ${projectId} --format markdown --out <file>`,
        };
      }
      context.ledger.logStep(context.projectId, "reopen", currentIdea(view)?.id ?? null, { after: lastFindings.id });
      lastWork = stepLog(context).steps.at(-1);
    }
    return context.agentFindings ? handOff(context, view, lastWork?.id ?? 0) : findings(context, view);
  }
  const blocked = log.last("blocked");
  const newest = Math.max(...live(view.notes).filter(note => note.kind === "constraint").map(note => parseId("note", note.id)), 0);
  const ownerFiles = view.sources.filter(source => source.via === "owner").length;
  // Wait, without a model call, while the owner has added nothing since the last request and its claim is still open;
  // once they have, or the claim was settled some other way, ask the design again.
  if (blocked && blocked.id === log.steps.at(-1)?.id && testable.some(claim => claim.id === blocked.target?.trim().toUpperCase())) {
    const since = z.object({ notes: z.number(), files: z.number() }).safeParse(blocked.detail);
    if (!since.success || (since.data.notes === newest && since.data.files === ownerFiles)) {
      return {
        step: "design", status: "needs-you", did: `Still waiting: ${z.object({ needsOwner: z.string() }).parse(blocked.detail).needsOwner}`,
        next: `Add it with scraply note add --project ${projectId} --kind constraint or scraply source add --project ${projectId} --origin owner, then run scraply auto again.`,
      };
    }
  }
  return design(context, view, testable);
}

/** Run steps until one needs the owner, the pass is done, or `maxSteps` ran. */
export async function advanceUntilBlocked(context: LoopContext, maxSteps: number) {
  const steps: StepResult[] = [];
  while (steps.length < maxSteps) {
    const result = await advance(context);
    steps.push(result);
    context.notify(`[${result.step}] ${result.did}`);
    if (result.status !== "continue") break;
  }
  return steps;
}
