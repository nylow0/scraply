import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger, parseId, type FetchedSource, type Ledger } from "../../src/cli/ledger";
import { CliError } from "../../src/cli/output";
import { runCli } from "../../src/cli/main";
import { MODEL_PROVIDER, type ModelSession } from "../../src/cli/model";
import { renderReport } from "../../src/cli/report";
import { advance, advanceUntilBlocked, runPendingScript, type LoopContext } from "../../src/loop/engine";
import { writeConfig, type Step, type Think, type ThinkRequest } from "../../src/loop/think";

// Synthetic pages: two keepers describe the problem on one forum, a vendor page shows what exists.
const PAGES: Record<string, FetchedSource> = {
  "hive record keeping": {
    url: "https://forum.example/notes", title: "Record keeping", via: "exa", kind: "page",
    text: "meadowkeeper: By the fourth colony I cannot remember what the first one looked like.\nridgehives: Typing up my dictaphone notes takes longer than the inspection itself.",
  },
  "hive apps": {
    url: "https://shop.example/hivenote", title: "HiveNote", via: "exa", kind: "page",
    text: "HiveNote records voice notes per hive and costs four dollars a month.",
  },
};

let root: string;
let ledger: Ledger;
let answers: Partial<Record<Step, unknown[]>>;
let runs: string[][];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "scraply-loop-"));
  ledger = openLedger(join(root, "ledger"));
  answers = {};
  runs = [];
});
afterEach(async () => {
  ledger.close();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { rmSync(root, { recursive: true, force: true }); return; }
    catch { await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1))); }
  }
});

/**
 * A stand-in for the model: each step returns its next scripted answer, checked by the step's own schema.
 * Like the worker, it refuses evidence whose IDs repeat.
 */
const think: Think = async <T>(request: ThinkRequest<T>) => {
  const ids = (request.evidence ?? []).map(item => item.id);
  if (new Set(ids).size !== ids.length) throw new Error(`Evidence IDs must be unique: ${ids.join(", ")}`);
  const next = answers[request.step]?.shift();
  if (next === undefined) throw new Error(`No scripted answer for ${request.step}`);
  return request.schema.parse(next);
};

function context(overrides: Partial<LoopContext> = {}): LoopContext {
  return {
    ledger, projectId: 1, think, workDir: join(root, "work"), resultsPerSearch: 5, tools: ["bun"], trust: false, skipQuestions: false, agentFindings: false, notify: () => undefined,
    searchWeb: async query => ({ provider: "exa", sources: PAGES[query] ? [PAGES[query]] : [] }),
    runCommand: async (command, cwd) => {
      runs.push([...command, cwd]);
      return { command: command.join(" "), exitCode: 0, output: "Sanity check passed: the known swarm is detected with 0.92 recall.\nForecaster AUC 0.71 against baseline 0.58 on held-out years.\n[exit code 0]" };
    },
    ...overrides,
  };
}

const step = async (overrides: Partial<LoopContext> = {}) => advance(context(overrides));

describe("the seed-and-kill-test loop", () => {
  test("a desk pass goes from seed to a reviewed verdict, findings, and an accepted variant, with the owner steering", async () => {
    ledger.createProject("hives", "Beekeepers lose track of what they saw in each hive.");
    answers = {
      frame: [{ framing: "An inspector would read club forums first.", surveyQueries: ["hive apps"], questions: [{ question: "How many hours a week do you have?", assumption: "Two evenings a week." }] }],
      survey: [{ priorArt: "HiveNote (S1) already records voice notes.", quotes: [
        { source: "S1", text: "HiveNote records voice notes per hive and costs four dollars a month.", speaker: "HiveNote", kind: "vendor" },
        { source: "S1", text: "This sentence is not on the page at all.", speaker: "HiveNote", kind: "vendor" },
      ] }],
      split: [{ idea: { title: "Hive voice log", pitch: "Talk while inspecting." }, claims: [{ kind: "need", statement: "Keepers lose per-hive notes.", killIf: "Fewer than two keepers describe it." }], reuse: [] }],
      design: [{ claim: "C1", why: "Cheapest decisive.", kind: "desk", method: "Read forums.", prediction: "Two keepers describe it.", stopWhen: "One search.", queries: ["hive record keeping"], cuts: [], sanity: null, control: null, holdout: null, needsOwner: null, setAside: null }],
      read: [{ quotes: [
        { source: "S2", text: "By the fourth colony I cannot remember what the first one looked like.", speaker: "meadowkeeper", kind: "firsthand", bearing: "for" },
        { source: "S2", text: "Typing up my dictaphone notes takes longer than the inspection itself.", speaker: "ridgehives", kind: "firsthand", bearing: "for" },
      ] }],
      verdict: [{ result: "provisional", quotes: ["Q2", "Q3"], note: "Two keepers describe losing per-hive detail." }],
      review: [{ result: "upheld", note: "Both are firsthand and from different keepers." }],
      findings: [{ summary: "The need held; HiveNote exists.", findings: [{ text: "Transcribing is the real chore.", quotes: ["Q3"] }], variants: [{ title: "Transcription only", pitch: "Turn dictaphone notes into per-hive records.", why: "Q3 names it." }] }],
    };

    expect(await step()).toMatchObject({ step: "frame", status: "continue" });
    expect(await step()).toMatchObject({ step: "survey", did: expect.stringContaining("saved 1 quote") });
    // The owner's answer is needed before claims are split.
    expect(await step()).toMatchObject({ step: "questions", status: "needs-you" });
    ledger.addNote(1, "constraint", "Two evenings a week.");

    const steps = await advanceUntilBlocked(context(), 20);
    expect(steps.map(item => item.step)).toEqual(["split", "design", "gather", "read", "verdict", "review", "findings"]);
    expect(steps.at(-1)).toMatchObject({ status: "needs-you", next: expect.stringContaining("scraply variant accept") });
    const view = ledger.show(1);
    expect(view.claims).toMatchObject([{ id: "C1", status: "supported", verdicts: [{ by: "scraply-author", reviews: [{ by: "scraply-reviewer", result: "upheld" }] }] }]);
    expect(view.ideas).toMatchObject([{ id: "I1", status: "standing" }]);
    expect(view.notes.filter(note => note.kind === "finding")).toMatchObject([{ quotes: ["Q3"] }]);

    // Nothing more to do until the owner steers; accepting a variant splits it into a new idea that revises the old one.
    expect(await step()).toMatchObject({ step: "steer", status: "done" });
    const variant = view.notes.find(note => note.kind === "variant")!;
    ledger.logStep(1, "accept", variant.id, null);
    answers.split = [{ idea: { title: "Transcription only", pitch: "Per-hive records from dictaphone notes." }, claims: [{ kind: "mechanism", statement: "Speech can be split by hive name.", killIf: "Under half the notes name a hive." }], reuse: ["C1"] }];
    expect(await step()).toMatchObject({ step: "split", did: expect.stringContaining("I2") });
    expect(ledger.show(1).ideas.at(-1)).toMatchObject({ id: "I2", revises: "I1", claims: [{ id: "C1", status: "supported" }, { id: "C2", status: "untested" }] });
  });

  test("a read the model fails on is retried one page at a time, and a page it still fails on is left unread and named to the verdict", async () => {
    ledger.createProject("hives", "Beekeepers lose track of what they saw in each hive.");
    ledger.logStep(1, "frame", null, { surveyQueries: [] });
    ledger.logStep(1, "survey", null, { skipped: "test" });
    answers = {
      split: [{ idea: { title: "Hive voice log", pitch: "Talk while inspecting." }, claims: [{ kind: "need", statement: "Keepers lose per-hive notes.", killIf: "Fewer than two keepers describe it." }], reuse: [] }],
      design: [{ claim: "C1", why: "Cheapest decisive.", kind: "desk", method: "Read forums.", prediction: "Two keepers describe it.", stopWhen: "One search.", queries: ["hive pages"], cuts: [], sanity: null, control: null, holdout: null, needsOwner: null, setAside: null }],
      verdict: [{ result: "unclear", quotes: ["Q1"], note: "One keeper describes it; the second page could not be read." }],
    };
    const readCalls: string[][] = [];
    const verdictInputs: unknown[] = [];
    const flaky: Think = async request => {
      if (request.step === "verdict") verdictInputs.push(request.inputs);
      if (request.step !== "read") return think(request);
      const ids = (request.evidence ?? []).map(item => item.id);
      readCalls.push(ids);
      // The whole batch and the second page alone fail the way a runaway answer does; the first page alone reads.
      if (ids.length > 1 || ids[0] === "S2") throw new CliError("MODEL_FAILED", "The read step's model call failed: OpenAI structured output exceeded the size limit.");
      return request.schema.parse({ quotes: [{ source: "S1", text: "By the fourth colony I cannot remember what the first one looked like.", speaker: "meadowkeeper", kind: "firsthand", bearing: "for" }] });
    };
    const searchWeb: LoopContext["searchWeb"] = async () => ({ provider: "exa", sources: [PAGES["hive record keeping"]!, PAGES["hive apps"]!] });
    const steps = await advanceUntilBlocked(context({ think: flaky, searchWeb }), 5);
    expect(steps.map(item => item.step)).toEqual(["split", "design", "gather", "read", "verdict"]);
    expect(readCalls).toEqual([["S1", "S2"], ["S1"], ["S2"]]);
    expect(steps[3]).toMatchObject({ did: expect.stringContaining("saved 1 quote(s); could not read S2") });
    expect(verdictInputs[0]).toMatchObject({ workDone: { sourcesRead: 1, sourcesUnread: ["S2"] } });
  });

  test("a read that fails on every page stops the step instead of reading nothing", async () => {
    ledger.createProject("hives", "Beekeepers lose track of what they saw in each hive.");
    ledger.logStep(1, "frame", null, { surveyQueries: [] });
    ledger.logStep(1, "survey", null, { skipped: "test" });
    answers = {
      split: [{ idea: { title: "Hive voice log", pitch: "Talk while inspecting." }, claims: [{ kind: "need", statement: "Keepers lose per-hive notes.", killIf: "Fewer than two keepers describe it." }], reuse: [] }],
      design: [{ claim: "C1", why: "Cheapest decisive.", kind: "desk", method: "Read forums.", prediction: "Two keepers describe it.", stopWhen: "One search.", queries: ["hive record keeping"], cuts: [], sanity: null, control: null, holdout: null, needsOwner: null, setAside: null }],
    };
    const down: Think = async request => {
      if (request.step === "read") throw new CliError("MODEL_FAILED", "The read step's model call failed: operation timed out.");
      return think(request);
    };
    await expect(advanceUntilBlocked(context({ think: down }), 5)).rejects.toThrow("operation timed out");
    // Nothing was logged, so running again retries the read.
    expect(ledger.steps(1).map(item => item.step)).toEqual(["frame", "survey", "split", "design", "gather"]);
  });

  test("with agent findings, the model researches and the calling agent writes the findings and variants", async () => {
    ledger.createProject("hives", "Beekeepers lose track of what they saw in each hive.");
    ledger.logStep(1, "frame", null, { surveyQueries: [] });
    ledger.logStep(1, "survey", null, { skipped: "test" });
    // No scripted findings answer: a model call for findings would throw.
    answers = {
      split: [{ idea: { title: "Hive voice log", pitch: "Talk while inspecting." }, claims: [{ kind: "need", statement: "Keepers lose per-hive notes.", killIf: "Fewer than two keepers describe it." }], reuse: [] }],
      design: [{ claim: "C1", why: "Cheapest decisive.", kind: "desk", method: "Read forums.", prediction: "Two keepers describe it.", stopWhen: "One search.", queries: ["hive record keeping"], cuts: [], sanity: null, control: null, holdout: null, needsOwner: null, setAside: null }],
      read: [{ quotes: [
        { source: "S1", text: "By the fourth colony I cannot remember what the first one looked like.", speaker: "meadowkeeper", kind: "firsthand", bearing: "for" },
        { source: "S1", text: "Typing up my dictaphone notes takes longer than the inspection itself.", speaker: "ridgehives", kind: "firsthand", bearing: "for" },
      ] }],
      verdict: [{ result: "provisional", quotes: ["Q1", "Q2"], note: "Two keepers describe losing per-hive detail." }],
      review: [{ result: "upheld", note: "Both are firsthand and from different keepers." }],
    };
    const agentFindings = { agentFindings: true };
    const steps = await advanceUntilBlocked(context(agentFindings), 20);
    expect(steps.map(item => item.step)).toEqual(["split", "design", "gather", "read", "verdict", "review", "findings"]);
    expect(steps.at(-1)).toMatchObject({ status: "needs-you", next: expect.stringContaining("--kind variant") });
    // Asking again before the agent wrote anything waits without calling the model.
    expect(await step(agentFindings)).toMatchObject({ step: "findings", status: "needs-you", did: expect.stringContaining("Still waiting") });

    ledger.addNote(1, "finding", "Transcribing is the real chore.", [2]);
    // The report shows the quote a finding cites, so the finding can be checked from the report alone.
    expect(renderReport(ledger.exportProject(1))).toMatch(/finding: Transcribing is the real chore\. \(Q2\)\n\n> Typing up my dictaphone notes takes longer than the inspection itself\.\n> — ridgehives \(firsthand\), Q2/);
    const variant = ledger.addNote(1, "variant", "Dictaphone to hive records: turn spoken notes into per-hive entries. Why: Q2 says typing them up is the chore.");
    expect(await step(agentFindings)).toMatchObject({ step: "findings", status: "needs-you", next: expect.stringContaining(`scraply variant accept <${variant.id}>`) });
    expect(await step(agentFindings)).toMatchObject({ step: "steer", status: "done" });

    // The agent's variant becomes the next idea, as a model-written one would.
    ledger.logStep(1, "accept", variant.id, null);
    const splitInputs: unknown[] = [];
    answers.split = [{ idea: { title: "Dictaphone to hive records", pitch: "Per-hive entries from spoken notes." }, claims: [{ kind: "mechanism", statement: "Speech can be split by hive name.", killIf: "Under half the notes name a hive." }], reuse: ["C1"] }];
    expect(await step({ ...agentFindings, think: async request => { splitInputs.push(request.inputs); return think(request); } })).toMatchObject({ step: "split", did: expect.stringContaining("I2") });
    expect(splitInputs[0]).toMatchObject({ variant: { pitch: expect.stringContaining("Dictaphone to hive records") } });
  });

  test("an experiment waits for the owner to read its script, then its run output is the evidence", async () => {
    ledger.createProject("quakes", "Quakes cluster, so a tiny forecaster beats a baseline.");
    ledger.logStep(1, "frame", null, { surveyQueries: [] });
    ledger.logStep(1, "survey", null, { skipped: "test" });
    answers = {
      split: [{ idea: { title: "Swarm forecaster", pitch: "Weekly M4+ odds per region." }, claims: [{ kind: "mechanism", statement: "Recent activity predicts next week.", killIf: "AUC under 0.6 on held-out years." }], reuse: [] }],
      design: [{ claim: "C1", why: "Free catalog.", kind: "experiment", method: "Fit on 2010-2019.", prediction: "AUC above 0.65.", stopWhen: "One run.", queries: [], cuts: ["by magnitude"], sanity: "Detect a known swarm.", control: "Rate-only baseline.", holdout: "2020-2023.", needsOwner: null, setAside: null }],
      script: [{ files: [{ name: "forecast.ts", content: "console.log('Forecaster AUC 0.71');" }], command: ["bun", "forecast.ts"], explanation: "First attempt." }],
      read: [{ quotes: [{ source: "S1", text: "Forecaster AUC 0.71 against baseline 0.58 on held-out years.", speaker: "T1 run 1", kind: "measured", bearing: "for" }] }],
      verdict: [{ result: "provisional", quotes: ["Q1"], note: "The forecaster beats the baseline on held-out years and the sanity check passed." }],
      review: [{ result: "upheld", note: "Sanity, control, and holdout are all reported." }],
      findings: [{ summary: "The forecaster held on held-out years.", findings: [], variants: [{ title: "Benchmark", pitch: "Compare with the published operational forecast.", why: "Next rung." }] }],
    };
    const before = await advanceUntilBlocked(context(), 10);
    expect(before.map(item => item.step)).toEqual(["split", "design", "script"]);
    expect(before.at(-1)).toMatchObject({ status: "needs-you", next: expect.stringContaining("scraply experiment approve") });
    expect(ledger.show(1).claims[0]!.tests[0]).toMatchObject({ kind: "experiment", sanity: "Detect a known swarm.", control: "Rate-only baseline.", holdout: "2020-2023." });
    const scriptPath = join(root, "work", "T1", "attempt-1", "forecast.ts");
    expect(readFileSync(scriptPath, "utf8")).toContain("Forecaster AUC");
    expect(await step()).toMatchObject({ step: "approve", status: "needs-you" });
    expect(runs).toHaveLength(0);

    expect(await runPendingScript(context(), "T1")).toMatchObject({ step: "run", did: expect.stringContaining("S1") });
    expect(runs[0]!.slice(0, 2)).toEqual(["bun", "forecast.ts"]);
    const reviewInputs: unknown[] = [];
    const after = await advanceUntilBlocked(context({ think: async request => { if (request.step === "review") reviewInputs.push(request.inputs); return think(request); } }), 10);
    expect(after.map(item => item.step)).toEqual(["read", "verdict", "review", "findings"]);
    // The reviewer sees the program behind the cited run, so a printed constant cannot pass as a measurement.
    expect(reviewInputs[0]).toMatchObject({ experimentRuns: [{ run: "S1", exitCode: 0, files: [{ name: "forecast.ts", content: expect.stringContaining("Forecaster AUC") }] }] });
    expect(ledger.show(1).claims[0]).toMatchObject({ status: "supported" });
    // The report shows what the experiment declared before running, and each run with its command and exit code.
    const report = renderReport(ledger.exportProject(1));
    for (const line of ["**T1** (experiment)", "Sanity check: Detect a known swarm.", "Held out: 2020-2023.", "S1 run of T1: `bun forecast.ts`, exit code 0"]) expect(report).toContain(line);
  });

  test("a run that exits cleanly but fails its sanity check is a failed run: the model sees it and writes a fixed script", async () => {
    ledger.createProject("quakes", "Anything.");
    ledger.logStep(1, "frame", null, { surveyQueries: [] });
    ledger.logStep(1, "survey", null, { skipped: "test" });
    let attempt = 0;
    const flaky = context({
      trust: true,
      runCommand: async command => {
        attempt += 1;
        return attempt === 1
          ? { command: command.join(" "), exitCode: 0, output: "Sanity check failed: the known swarm was not flagged.\nTypeError: catalog is undefined\n[exit code 0]" }
          : { command: command.join(" "), exitCode: 0, output: "Sanity check passed and the forecaster scored AUC 0.52, no better than the baseline.\n[exit code 0]" };
      },
    });
    answers = {
      split: [{ idea: { title: "Forecaster", pitch: "Odds." }, claims: [{ kind: "mechanism", statement: "It beats the baseline.", killIf: "AUC under 0.6." }], reuse: [] }],
      design: [{ claim: "C1", why: "Free data.", kind: "experiment", method: "Fit.", prediction: "AUC above 0.65.", stopWhen: "One run.", queries: [], cuts: [], sanity: "Known swarm.", control: "Baseline.", holdout: "2020-2023.", needsOwner: null, setAside: null }],
      script: [
        { files: [{ name: "a.ts", content: "x" }], command: ["bun", "a.ts"], explanation: "First." },
        { files: [{ name: "a.ts", content: "y" }], command: ["bun", "a.ts"], explanation: "Load the catalog before using it." },
      ],
      read: [{ quotes: [{ source: "S2", text: "Sanity check passed and the forecaster scored AUC 0.52, no better than the baseline.", speaker: "T1 run 2", kind: "measured", bearing: "against" }] }],
      verdict: [{ result: "killed", quotes: ["Q1"], note: "The held-out score is below the kill threshold." }],
      review: [{ result: "upheld", note: "The output shows it." }],
      findings: [{ summary: "Dead.", findings: [], variants: [] }],
    };
    const scriptInputs: unknown[] = [];
    const steps = await advanceUntilBlocked({ ...flaky, think: async request => { if (request.step === "script") scriptInputs.push(request.inputs); return think(request); } }, 20);
    expect(steps.map(item => item.step)).toEqual(["split", "design", "script", "run", "script", "run", "read", "verdict", "review", "findings"]);
    // The fix starts from the code that failed and what it printed.
    expect(scriptInputs[1]).toMatchObject({ earlierAttempts: [{ exitCode: 0, files: [{ name: "a.ts", content: "x" }], outputTail: expect.stringContaining("Sanity check failed") }] });
    expect(existsSync(join(root, "work", "T1", "attempt-2", "a.ts"))).toBe(true);
    expect(ledger.show(1)).toMatchObject({ claims: [{ status: "killed" }], ideas: [{ status: "dead" }], sources: [{ exitCode: 0 }, { exitCode: 0 }] });
    expect(steps.at(-1)).toMatchObject({ status: "needs-you", next: expect.stringContaining("Nothing points to a variant") });
  });

  test("a verdict the ledger refuses is asked again with the refusal, recorded as unclear, reviewed, and the claim gets one more test", async () => {
    ledger.createProject("hives", "Anything.");
    ledger.logStep(1, "frame", null, { surveyQueries: [] });
    ledger.logStep(1, "survey", null, { skipped: "test" });
    answers = {
      split: [{ idea: { title: "Log", pitch: "Notes." }, claims: [{ kind: "need", statement: "Keepers lose notes.", killIf: "Fewer than two say so." }], reuse: [] }],
      design: [
        { claim: "C1", why: "Cheap.", kind: "desk", method: "Read.", prediction: "Two say so.", stopWhen: "One search.", queries: ["hive record keeping"], cuts: [], sanity: null, control: null, holdout: null, needsOwner: null, setAside: null },
        { claim: "C1", why: "Retry with another venue.", kind: "desk", method: "Read club newsletters.", prediction: "Two say so.", stopWhen: "One search.", queries: ["hive apps"], cuts: [], sanity: null, control: null, holdout: null, needsOwner: null, setAside: null },
      ],
      read: [{ quotes: [{ source: "S1", text: "By the fourth colony I cannot remember what the first one looked like.", speaker: "meadowkeeper", kind: "firsthand", bearing: "for" }] }],
      verdict: [
        { result: "provisional", quotes: ["Q1"], note: "One keeper says so." },
        { result: "provisional", quotes: ["Q1"], note: "Still one keeper." },
      ],
      review: [{ result: "upheld", note: "One keeper is not enough either way." }],
    };
    const prompts: unknown[] = [];
    const watched = context({ think: async request => { if (request.step === "verdict") prompts.push(request.inputs); return think(request); } });
    const steps = await advanceUntilBlocked(watched, 7);
    expect(steps.map(item => item.step)).toEqual(["split", "design", "gather", "read", "verdict", "review", "design"]);
    // The verdict sees what this test gathered, with each quote's bearing, and how much work the test did.
    expect(prompts[0]).toMatchObject({ workDone: { searchesRun: 1, sourcesRead: 1, quotesSaved: 1 }, quotesFromThisTest: [{ id: "Q1", bearing: "for", newSinceTest: true }], earlierQuotes: [] });
    expect(prompts[1]).toMatchObject({ previousRefusal: expect.stringContaining("ONE_SPEAKER") });
    expect(ledger.show(1).claims[0]).toMatchObject({ verdicts: [{ result: "unclear", note: expect.stringContaining("ONE_SPEAKER") }], tests: [{ id: "T1" }, { id: "T2", method: "Read club newsletters." }] });
  });

  test("skipping the framing questions records the stated assumptions as constraints, so the work never stalls on them", async () => {
    ledger.createProject("quakes", "Quakes cluster.");
    answers = {
      frame: [{ framing: "A seismologist would query the catalog.", surveyQueries: [], questions: [
        { question: "Which region?", assumption: "California, 2015 to 2024." },
        { question: "How much time?", assumption: "A few evenings." },
      ] }],
    };
    await step();
    await step();
    expect(await step()).toMatchObject({ step: "questions", status: "needs-you", next: expect.stringContaining("--skip-questions") });
    answers.split = [{ idea: { title: "Forecaster", pitch: "California weekly odds." }, claims: [{ kind: "mechanism", statement: "Clustering predicts.", killIf: "No lift." }], reuse: [] }];
    const splitInputs: unknown[] = [];
    expect(await step({ skipQuestions: true, think: async request => { splitInputs.push(request.inputs); return think(request); } })).toMatchObject({ step: "split" });
    // The split that runs right after sees the assumptions it must stay within.
    expect(splitInputs[0]).toMatchObject({ constraints: expect.arrayContaining([expect.stringContaining("California, 2015 to 2024.")]) });
    expect(ledger.show(1).notes.filter(note => note.kind === "constraint").map(note => note.text)).toEqual([
      "Assumed, because the owner went on without answering: California, 2015 to 2024.",
      "Assumed, because the owner went on without answering: A few evenings.",
    ]);
  });

  test("a test that needs the owner stops and asks, waits without calling the model, and resumes once they provide it", async () => {
    ledger.createProject("gardens", "Gardens struggle to coordinate watering.");
    ledger.logStep(1, "frame", null, { surveyQueries: [] });
    ledger.logStep(1, "survey", null, { skipped: "test" });
    const design = { claim: "C1", why: "Only the garden's own log shows it.", kind: "desk", method: "", prediction: "", stopWhen: "", queries: [], cuts: [], sanity: null, control: null, holdout: null, needsOwner: null, setAside: null };
    answers = {
      split: [{ idea: { title: "Rota", pitch: "Shared rota." }, claims: [{ kind: "need", statement: "Holiday handoffs fail.", killIf: "No missed watering in a season." }], reuse: [] }],
      design: [
        // A desk test with no queries is refused and asked again; the second answer says what only the owner can give.
        { ...design, method: "Read.", prediction: "Some.", stopWhen: "One." },
        { ...design, needsOwner: "Last summer's watering log from a garden you can reach.", setAside: null },
        { ...design, kind: "desk", method: "Count missed days in the owner's log.", prediction: "At least three.", stopWhen: "One log read.", queries: ["community garden watering rota missed"] },
      ],
    };
    const calls: string[] = [];
    const counting = context({ think: async request => { calls.push(request.step); return think(request); } });
    expect((await advanceUntilBlocked(counting, 5)).at(-1)).toMatchObject({ step: "design", status: "needs-you", did: expect.stringContaining("watering log") });
    expect(calls).toEqual(["split", "design", "design"]);
    expect(ledger.show(1).claims[0]!.tests).toHaveLength(0);

    expect(await advance(counting)).toMatchObject({ status: "needs-you", did: expect.stringContaining("Still waiting") });
    expect(calls).toHaveLength(3);
    ledger.addNote(1, "constraint", "I can get the log from my own garden next week; use public forum posts until then.");
    expect(await advance(counting)).toMatchObject({ step: "design", status: "continue", did: expect.stringContaining("T1") });
  });

  test("a claim that still needs the owner after they said they cannot help is set aside, and the loop tests what it can", async () => {
    ledger.createProject("gardens", "Gardens struggle to coordinate watering.");
    ledger.logStep(1, "frame", null, { surveyQueries: [] });
    ledger.logStep(1, "survey", null, { skipped: "test" });
    const blank = { kind: "desk", method: "", prediction: "", stopWhen: "", queries: [], cuts: [], sanity: null, control: null, holdout: null };
    answers = {
      split: [{ idea: { title: "Rota", pitch: "Shared rota." }, claims: [
        { kind: "need", statement: "Coordinators struggle.", killIf: "Fewer than two describe it." },
        { kind: "mechanism", statement: "A rota cuts missed turns.", killIf: "No drop in a trial." },
      ], reuse: [] }],
      design: [
        { ...blank, claim: "C2", why: "Decisive.", needsOwner: "A garden willing to trial the rota.", setAside: null },
        { ...blank, claim: "C2", why: "Still decisive.", needsOwner: null, setAside: "The owner cannot reach a garden for a trial." },
        { ...blank, claim: "C1", why: "Public accounts can test it.", method: "Read forums.", prediction: "Two describe it.", stopWhen: "One search.", queries: ["hive record keeping"], needsOwner: null, setAside: null },
      ],
    };
    expect((await advanceUntilBlocked(context(), 5)).at(-1)).toMatchObject({ status: "needs-you" });
    ledger.addNote(1, "constraint", "I cannot reach any garden.");
    const steps = await advanceUntilBlocked(context(), 2);
    expect(steps).toMatchObject([
      { step: "design", status: "continue", did: expect.stringContaining("Set C2 aside") },
      { step: "design", status: "continue", did: expect.stringContaining("T1 for C1") },
    ]);
  });

  test("experiment files may live in subfolders but never outside their attempt folder", async () => {
    ledger.createProject("quakes", "Anything.");
    ledger.logStep(1, "frame", null, { surveyQueries: [] });
    ledger.logStep(1, "survey", null, { skipped: "test" });
    const experiment = { claim: "C1", why: "Data.", kind: "experiment", method: "Fit.", prediction: "Lift.", stopWhen: "One run.", queries: [], cuts: [], sanity: "Known event.", control: "Baseline.", holdout: "Later years.", needsOwner: null, setAside: null };
    answers = {
      split: [{ idea: { title: "Forecaster", pitch: "Odds." }, claims: [{ kind: "mechanism", statement: "It beats the baseline.", killIf: "No lift." }], reuse: [] }],
      design: [experiment],
      script: [
        { files: [{ name: "../escape.ts", content: "x" }], command: ["bun", "a.ts"], explanation: "Bad." },
        { files: [{ name: "lib/data.ts", content: "export {}" }, { name: "a.ts", content: "import './lib/data.ts'" }], command: ["bun", "a.ts"], explanation: "Good." },
      ],
    };
    await advance(context());
    await advance(context());
    await expect(advance(context())).rejects.toThrow("outside its folder");
    expect(existsSync(join(root, "work", "T1", "escape.ts"))).toBe(false);
    expect(await advance(context())).toMatchObject({ step: "script", status: "needs-you" });
    expect(existsSync(join(root, "work", "T1", "attempt-1", "lib", "data.ts"))).toBe(true);
  });

  test("a long run is read whole: a failed sanity check printed last fails it, and the measurement at the end reaches the reader", async () => {
    ledger.createProject("quakes", "Anything.");
    ledger.logStep(1, "frame", null, { surveyQueries: [] });
    ledger.logStep(1, "survey", null, { skipped: "test" });
    const script = { files: [{ name: "a.ts", content: "console.log('x')" }], command: ["bun", "a.ts"], explanation: "Run." };
    answers = {
      split: [{ idea: { title: "Forecaster", pitch: "Odds." }, claims: [{ kind: "mechanism", statement: "It beats the baseline.", killIf: "No lift." }], reuse: [] }],
      design: [{ claim: "C1", why: "Data.", kind: "experiment", method: "Fit.", prediction: "Lift.", stopWhen: "One run.", queries: [], cuts: [], sanity: "Known event.", control: "Baseline.", holdout: "Later years.", needsOwner: null, setAside: null }],
      script: [script, script],
      read: [{ quotes: [] }, { quotes: [{ source: "S2.4", text: "Forecaster AUC 0.71 against baseline 0.58 on held-out years.", speaker: "T1 run 2", kind: "measured", bearing: "for" }] }],
      verdict: [{ result: "provisional", quotes: ["Q1"], note: "The forecaster beats the baseline on held-out years." }],
      review: [{ result: "upheld", note: "The run reports it." }],
    };
    const noise = "row of intermediate output\n".repeat(3_000);
    const outputs = [`${noise}Sanity check failed: the known event was missed.\n[exit code 0]`, `${noise}Forecaster AUC 0.71 against baseline 0.58 on held-out years.\n[exit code 0]`];
    const runCommand: LoopContext["runCommand"] = async command => ({ command: command.join(" "), exitCode: 0, output: outputs.shift()! });
    const readEvidence: string[] = [];
    const reading: Think = async request => {
      if (request.step === "read") readEvidence.push(...(request.evidence ?? []).map(item => JSON.stringify(item.content)));
      return think(request);
    };
    const trusted = context({ trust: true, runCommand, think: reading });
    const steps = await advanceUntilBlocked(trusted, 6);
    // The first run's failure is past the first window, yet it still sends the loop back to write a new script.
    expect(steps.map(item => item.step)).toEqual(["split", "design", "script", "run", "script", "run"]);
    expect(await advance(trusted)).toMatchObject({ step: "read", did: expect.stringContaining("saved 1 quote") });
    expect(readEvidence.length).toBeGreaterThan(1);
    expect(readEvidence.at(-1)).toContain("Forecaster AUC 0.71");
    // The review gets every part of the run under its own evidence ID, as the worker requires.
    const reviewEvidence: string[] = [];
    const reviewing = context({ trust: true, runCommand, think: async request => { if (request.step === "review") reviewEvidence.push(...(request.evidence ?? []).map(item => item.id)); return think(request); } });
    expect((await advanceUntilBlocked(reviewing, 2)).map(item => item.step)).toEqual(["verdict", "review"]);
    expect(reviewEvidence).toEqual(["S2.1", "S2.2", "S2.3", "S2.4"]);
    expect(ledger.show(1).claims[0]).toMatchObject({ status: "supported" });

    // The findings step gets the good run cut to its start and end, so many long runs still fit in one call.
    answers.findings = [{ summary: "The forecaster held.", findings: [], variants: [] }];
    const findingsInputs: { experimentOutput: { source: string; text: string }[] }[] = [];
    const summing = context({ think: async request => { if (request.step === "findings") findingsInputs.push(request.inputs as typeof findingsInputs[number]); return think(request); } });
    expect(await advance(summing)).toMatchObject({ step: "findings" });
    const shown = findingsInputs[0]!.experimentOutput;
    expect(shown.map(item => item.source)).toEqual(["S2"]);
    expect(shown[0]!.text.length).toBeLessThan(40_100);
    expect(shown[0]!.text).toContain("characters left out");
    expect(shown[0]!.text).toContain("Forecaster AUC 0.71");
  });

  test("one part of a long run the model cannot read is reported unread, and the parts it read are kept", async () => {
    ledger.createProject("quakes", "Anything.");
    ledger.logStep(1, "frame", null, { surveyQueries: [] });
    ledger.logStep(1, "survey", null, { skipped: "test" });
    answers = {
      split: [{ idea: { title: "Forecaster", pitch: "Odds." }, claims: [{ kind: "mechanism", statement: "It beats the baseline.", killIf: "No lift." }], reuse: [] }],
      design: [{ claim: "C1", why: "Data.", kind: "experiment", method: "Fit.", prediction: "Lift.", stopWhen: "One run.", queries: [], cuts: [], sanity: "Known event.", control: "Baseline.", holdout: "Later years.", needsOwner: null, setAside: null }],
      script: [{ files: [{ name: "a.ts", content: "console.log('x')" }], command: ["bun", "a.ts"], explanation: "Run." }],
      read: [{ quotes: [] }, { quotes: [{ source: "S1.3", text: "Forecaster AUC 0.71 against baseline 0.58 on held-out years.", speaker: "T1 run 1", kind: "measured", bearing: "for" }] }],
    };
    const output = `${"row of intermediate output\n".repeat(2_500)}Forecaster AUC 0.71 against baseline 0.58 on held-out years.\n[exit code 0]`;
    const runCommand: LoopContext["runCommand"] = async command => ({ command: command.join(" "), exitCode: 0, output });
    const flaky: Think = async request => {
      if (request.step === "read" && (request.evidence ?? []).some(item => item.id === "S1.2")) throw new CliError("MODEL_FAILED", "The read step's model call failed: operation timed out.");
      return think(request);
    };
    const steps = await advanceUntilBlocked(context({ trust: true, runCommand, think: flaky }), 5);
    expect(steps.map(item => item.step)).toEqual(["split", "design", "script", "run", "read"]);
    expect(steps.at(-1)).toMatchObject({ did: expect.stringContaining("saved 1 quote(s); could not read S1") });
  });

  test("a design for a claim that is not open is refused and asked again, never attached to another claim", async () => {
    ledger.createProject("hives", "Anything.");
    ledger.logStep(1, "frame", null, { surveyQueries: [] });
    ledger.logStep(1, "survey", null, { skipped: "test" });
    ledger.addClaim(1, "gap", "Nothing sells this.", "A product sells it.");
    ledger.addClaim(1, "need", "Keepers lose notes.", "Fewer than two describe it.");
    ledger.addIdea({ projectId: 1, title: "Voice log", pitch: "Talk.", claimIds: [1, 2] });
    ledger.logStep(1, "untestable", "C1", { why: "Only the owner's club could say." });
    const desk = { kind: "desk", method: "Read forums.", prediction: "Two.", stopWhen: "One search.", queries: ["hive notes"], cuts: [], sanity: null, control: null, holdout: null, needsOwner: null, setAside: null };
    answers = { design: [{ ...desk, claim: "C1", why: "Price check." }, { ...desk, claim: "C2", why: "Accounts." }] };
    const designInputs: unknown[] = [];
    expect(await advance(context({ think: async request => { designInputs.push(request.inputs); return think(request); } })))
      .toMatchObject({ step: "design", did: expect.stringContaining("T1 for C2") });
    expect(designInputs[1]).toMatchObject({ previousRefusal: expect.stringContaining("open claims: C2") });
  });

  test("a verdict answers only the test it names, so a newer test on the claim still runs", async () => {
    ledger.createProject("hives", "Anything.");
    ledger.logStep(1, "frame", null, { surveyQueries: [] });
    ledger.logStep(1, "survey", null, { skipped: "test" });
    const claim = ledger.addClaim(1, "need", "Keepers lose notes.", "Fewer than two describe it.");
    ledger.addIdea({ projectId: 1, title: "Voice log", pitch: "Talk.", claimIds: [1] });
    for (const query of ["first", "second"]) {
      const test = ledger.addTest(1, { method: "Read.", prediction: "Two.", stopWhen: "One search.", kind: "desk", plan: { queries: [query] } });
      ledger.logStep(1, "design", test.id, { claim: claim.id, why: "Test." });
    }
    ledger.addVerdict({ claimId: 1, result: "unclear", quoteIds: [], note: "The first search found nothing either way.", author: "someone", testId: 1 });
    expect(await advance(context())).toMatchObject({ step: "gather", did: expect.stringContaining("T2") });
  });

  test("a test written by hand is handed back to be finished by hand instead of crashing the loop", async () => {
    ledger.createProject("hives", "Anything.");
    ledger.logStep(1, "frame", null, { surveyQueries: [] });
    ledger.logStep(1, "survey", null, { skipped: "test" });
    ledger.addClaim(1, "need", "Keepers lose notes.", "Fewer than two describe it.");
    ledger.addIdea({ projectId: 1, title: "Voice log", pitch: "Talk.", claimIds: [1] });
    ledger.addTest(1, { method: "Read club forums.", prediction: "Two.", stopWhen: "Two threads." });
    expect(await advance(context())).toMatchObject({ step: "test", status: "needs-you", next: expect.stringContaining("verdict add --claim C1 --test T1") });
  });

  test("material the owner hands over reaches the test: a desk test reads it, and an experiment finds it in its folder", async () => {
    ledger.createProject("gardens", "Anything.");
    ledger.logStep(1, "frame", null, { surveyQueries: [] });
    ledger.logStep(1, "survey", null, { skipped: "test" });
    const log = ledger.saveSource(1, { url: "file:log.csv", title: "Last summer's watering log", via: "owner", kind: "file", text: "date,plot,watered\n2025-07-01,4,no\n" });
    const desk = { claim: "C1", why: "The log shows it.", kind: "desk", method: "Count missed days.", prediction: "Three.", stopWhen: "One read.", queries: ["garden watering"], cuts: [], sanity: null, control: null, holdout: null, needsOwner: null, setAside: null };
    answers = {
      split: [{ idea: { title: "Rota", pitch: "Shared rota." }, claims: [
        { kind: "need", statement: "Holiday handoffs fail.", killIf: "No missed days." },
        { kind: "mechanism", statement: "Missed days cluster in August.", killIf: "No clustering." },
      ], reuse: [] }],
      design: [desk, { ...desk, claim: "C2", kind: "experiment", sanity: "A known missed day.", control: "Other months.", holdout: "Second half of the log.", queries: [] }],
      read: [{ quotes: [] }],
      verdict: [{ result: "unclear", quotes: [], note: "The log has one row." }],
      review: [{ result: "upheld", note: "Too little data." }],
      script: [{ files: [{ name: "count.ts", content: "console.log('x')" }], command: ["bun", "count.ts"], explanation: "Count." }],
    };
    const evidence: string[][] = [];
    const scriptInputs: unknown[] = [];
    const watching: Think = async request => {
      if (request.step === "read") evidence.push((request.evidence ?? []).map(item => item.id));
      if (request.step === "script") scriptInputs.push(request.inputs);
      return think(request);
    };
    const steps = await advanceUntilBlocked(context({ think: watching }), 10);
    expect(steps.map(item => item.step)).toEqual(["split", "design", "gather", "read", "verdict", "review", "design", "script"]);
    expect(evidence[0]![0]).toBe(log.id);
    expect(scriptInputs[0]).toMatchObject({ ownerFiles: [{ path: `owner/${log.id}.txt`, title: "Last summer's watering log" }] });
    expect(readFileSync(join(root, "work", "T2", "attempt-1", "owner", `${log.id}.txt`), "utf8")).toContain("2025-07-01,4,no");
  });

  test("only the owner's answer to a claim's own request sets it aside, and a reply that offers help is asked about again", async () => {
    ledger.createProject("gardens", "Gardens struggle to coordinate watering.");
    ledger.logStep(1, "frame", null, { surveyQueries: [] });
    ledger.logStep(1, "survey", null, { skipped: "test" });
    const blank = { kind: "desk", method: "", prediction: "", stopWhen: "", queries: [], cuts: [], sanity: null, control: null, holdout: null };
    const emails = { ...blank, claim: "C1", why: "Only their records show it.", needsOwner: "Your own garden's coordination emails.", setAside: null };
    answers = {
      split: [{ idea: { title: "Rota", pitch: "Shared rota." }, claims: [
        { kind: "need", statement: "Coordinators struggle.", killIf: "Fewer than two describe it." },
        { kind: "mechanism", statement: "A rota cuts missed turns.", killIf: "No drop in a trial." },
      ], reuse: [] }],
      design: [
        { ...blank, claim: "C2", why: "Decisive.", needsOwner: "A garden willing to trial the rota.", setAside: null },
        { ...blank, claim: "C2", why: "Still decisive.", needsOwner: null, setAside: "The owner cannot reach a garden for a trial." },
        // C1 was never asked about, so the model cannot set it aside on its own say-so.
        { ...blank, claim: "C1", why: "Hard to test.", needsOwner: null, setAside: "Probably untestable." },
        emails,
        // The owner offers the emails and asks a question; the loop asks again instead of giving up on C1.
        { ...emails, needsOwner: "The emails as a text export, with names removed." },
      ],
    };
    const designInputs: unknown[] = [];
    const watching = context({ think: async request => { if (request.step === "design") designInputs.push(request.inputs); return think(request); } });
    await advanceUntilBlocked(watching, 5);
    ledger.addNote(1, "constraint", "I cannot reach any garden for a trial.");
    expect(await advanceUntilBlocked(watching, 3)).toMatchObject([
      { step: "design", status: "continue", did: expect.stringContaining("Set C2 aside") },
      { step: "design", status: "needs-you", did: expect.stringContaining("coordination emails") },
    ]);
    expect(designInputs.at(-1)).toMatchObject({ previousRefusal: expect.stringContaining("setAside is only for") });
    ledger.addNote(1, "constraint", "I can export them; which format do you want?");
    expect(await advance(watching)).toMatchObject({ step: "design", status: "needs-you", did: expect.stringContaining("text export") });
    expect(ledger.steps(1).filter(item => item.step === "untestable").map(item => item.target)).toEqual(["C2"]);
  });

  test("with agent findings, a summary alone closes a pass that left nothing to build on", async () => {
    ledger.createProject("hives", "Anything.");
    ledger.logStep(1, "frame", null, { surveyQueries: [] });
    ledger.logStep(1, "survey", null, { skipped: "test" });
    ledger.addClaim(1, "need", "Keepers lose notes.", "Fewer than two describe it.");
    ledger.addIdea({ projectId: 1, title: "Voice log", pitch: "Talk.", claimIds: [1] });
    ledger.logStep(1, "untestable", "C1", { why: "Only the owner's club could say." });
    const agentFindings = context({ agentFindings: true });
    expect(await advance(agentFindings)).toMatchObject({ step: "findings", status: "needs-you", next: expect.stringContaining("--kind summary") });
    ledger.addNote(1, "summary", "Nothing could be tested with public evidence; the need is still unknown.");
    expect(await advance(agentFindings)).toMatchObject({ step: "findings", did: expect.stringContaining("0 finding(s) and 0 variant(s)"), next: expect.stringContaining("Nothing points to a variant") });
    expect(await advance(agentFindings)).toMatchObject({ step: "steer", status: "done" });
  });

  test("a verdict and review recorded by hand after the write-up reopen it instead of calling the pass finished", async () => {
    ledger.createProject("hives", "Anything.");
    ledger.logStep(1, "frame", null, { surveyQueries: [] });
    ledger.logStep(1, "survey", null, { skipped: "test" });
    ledger.addClaim(1, "need", "Keepers lose notes.", "Fewer than two describe it.");
    ledger.addIdea({ projectId: 1, title: "Voice log", pitch: "Talk.", claimIds: [1] });
    ledger.logStep(1, "untestable", "C1", { why: "Only the owner's club could say." });
    const agentFindings = context({ agentFindings: true });
    await advance(agentFindings);
    ledger.addNote(1, "summary", "Nothing could be tested.");
    expect(await advance(agentFindings)).toMatchObject({ step: "findings" });
    expect(await advance(agentFindings)).toMatchObject({ step: "steer", status: "done" });
    // The agent then records a verdict and its review by hand; the old write-up no longer describes the record.
    await new Promise(resolve => setTimeout(resolve, 5));
    const verdict = ledger.addVerdict({ claimId: 1, result: "unclear", quoteIds: [], note: "The club records could not be reached.", author: "agent" });
    ledger.addReview({ verdictId: parseId("verdict", verdict.id), result: "upheld", note: "Nothing was found either way.", reviewer: "second-agent" });
    expect(await advance(agentFindings)).toMatchObject({ step: "findings", status: "needs-you", did: expect.stringContaining("yours to write") });
    ledger.addNote(1, "summary", "Still unknown; the club records could not be reached.");
    expect(await advance(agentFindings)).toMatchObject({ step: "findings", did: expect.stringContaining("0 variant(s)") });
    expect(await advance(agentFindings)).toMatchObject({ step: "steer", status: "done" });
  });

  test("a saved effort the model no longer offers blocks the loop instead of being sent anyway", async () => {
    let output = "";
    const env = { APPDATA: join(root, "appdata"), SCRAPLY_DATA_DIR: join(root, "cli") };
    await runCli(["project", "new", "x", "--seed", "Anything."], { write: () => undefined, notify: () => undefined, isTTY: false, env });
    writeConfig(env.SCRAPLY_DATA_DIR, { model: "synthetic-model", effort: "low" });
    const models = [{ identity: { providerId: MODEL_PROVIDER, modelId: "synthetic-model" }, supportsStructuredOutput: true, supportedReasoningEfforts: ["high"] }];
    const session = { client: { listModels: async () => models, listAccounts: async () => [] }, persist: async () => undefined, hasSavedAccount: () => true, close: async () => undefined };
    const exitCode = await runCli(["next", "--project", "P1"], {
      write: text => { output += text; }, notify: () => undefined, isTTY: false, env, models: async () => session as unknown as ModelSession,
    });
    expect(exitCode).toBe(1);
    expect(JSON.parse(output)).toMatchObject({ error: { code: "MODEL_UNAVAILABLE", message: expect.stringContaining("effort low") } });
  });

  test("next refuses to run without a chosen model, and never picks one", async () => {
    let output = "";
    const env = { APPDATA: join(root, "appdata"), SCRAPLY_DATA_DIR: join(root, "cli") };
    await runCli(["project", "new", "x", "--seed", "Anything."], { write: () => undefined, notify: () => undefined, isTTY: false, env });
    const exitCode = await runCli(["next", "--project", "P1"], { write: text => { output += text; }, notify: () => undefined, isTTY: false, env });
    expect(exitCode).toBe(1);
    expect(JSON.parse(output)).toMatchObject({ error: { code: "NO_MODEL", message: expect.stringContaining("scraply config model") } });
  });
});
