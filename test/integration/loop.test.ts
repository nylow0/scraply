import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger, parseId, type FetchedSource, type Ledger } from "../../src/cli/ledger";
import { CliError } from "../../src/cli/output";
import { renderReport } from "../../src/cli/report";
import { advance, runPendingScript, type LoopContext, type StepResult } from "../../src/loop/engine";
import type { Step, Think, ThinkRequest } from "../../src/loop/think";

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

/** A stand-in for the calling agent: each step gets its next scripted answer, checked by the step's own schema. */
const think: Think = async <T>(request: ThinkRequest<T>) => {
  const next = answers[request.step]?.shift();
  if (next === undefined) throw new Error(`No scripted answer for ${request.step}`);
  return request.schema.parse(next);
};

function context(overrides: Partial<LoopContext> = {}): LoopContext {
  return {
    ledger, projectId: 1, think, workDir: join(root, "work"), resultsPerSearch: 5, tools: ["bun"], trust: false, skipQuestions: false, notify: () => undefined,
    searchWeb: async query => ({ provider: "exa", sources: PAGES[query] ? [PAGES[query]] : [] }),
    runCommand: async (command, cwd) => {
      runs.push([...command, cwd]);
      return { command: command.join(" "), exitCode: 0, output: "Sanity check passed: the known swarm is detected with 0.92 recall.\nForecaster AUC 0.71 against baseline 0.58 on held-out years.\n[exit code 0]" };
    },
    ...overrides,
  };
}

const step = async (overrides: Partial<LoopContext> = {}) => advance(context(overrides));

/** Run steps until one needs the owner, the pass is done, or `maxSteps` ran, as `scraply next` does with answers ready. */
async function advanceUntilBlocked(loop: LoopContext, maxSteps: number) {
  const steps: StepResult[] = [];
  while (steps.length < maxSteps) {
    const result = await advance(loop);
    steps.push(result);
    if (result.status !== "continue") break;
  }
  return steps;
}

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
    expect(await step()).toMatchObject({ step: "survey", did: "Ran 1 survey search(es)." });
    // A quote that is not on the page is dropped with the ledger's reason, so the agent can fix it.
    expect(await step()).toMatchObject({ step: "survey", did: expect.stringMatching(/saved 1 quote.*Dropped 1 quote.*This sentence is not on the page/) });
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
    expect(reviewInputs[0]).toMatchObject({ experimentRuns: [{ run: "S1", exitCode: 0, files: [scriptPath] }] });
    expect(ledger.show(1).claims[0]).toMatchObject({ status: "supported" });
    // The report shows what the experiment declared before running, and each run with its command and exit code.
    const report = renderReport(ledger.exportProject(1));
    for (const line of ["**T1** (experiment)", "Sanity check: Detect a known swarm.", "Held out: 2020-2023.", "S1 run of T1: `bun forecast.ts`, exit code 0"]) expect(report).toContain(line);
  });

  test("a run that exits cleanly but fails its sanity check is a failed run: the agent sees it and writes a fixed script", async () => {
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
    expect(scriptInputs[1]).toMatchObject({ earlierAttempts: [{ run: "S1", exitCode: 0, files: [join(root, "work", "T1", "attempt-1", "a.ts")], outputTail: expect.stringContaining("Sanity check failed") }] });
    expect(existsSync(join(root, "work", "T1", "attempt-2", "a.ts"))).toBe(true);
    expect(ledger.show(1)).toMatchObject({ claims: [{ status: "killed" }], ideas: [{ status: "dead" }], sources: [{ exitCode: 0 }, { exitCode: 0 }] });
    expect(steps.at(-1)).toMatchObject({ status: "needs-you", next: expect.stringContaining("Nothing points to a variant") });
  });

  test("a verdict the ledger refuses goes back to the agent with the reason, nothing is recorded, and a fixed one is reviewed before the claim gets one more test", async () => {
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
        { result: "unclear", quotes: ["Q1"], note: "Only one keeper says so, short of the two the kill condition asks for." },
      ],
      review: [{ result: "upheld", note: "One keeper is not enough either way." }],
    };
    const prompts: unknown[] = [];
    const watched = context({ think: async request => { if (request.step === "verdict") prompts.push(request.inputs); return think(request); } });
    expect((await advanceUntilBlocked(watched, 4)).map(item => item.step)).toEqual(["split", "design", "gather", "read"]);
    await expect(advance(watched)).rejects.toMatchObject({ code: "ONE_SPEAKER" });
    expect(ledger.show(1).claims[0]!.verdicts).toHaveLength(0);
    // The verdict sees what this test gathered, with each quote's bearing, and how much work the test did.
    expect(prompts[0]).toMatchObject({ workDone: { searchesRun: 1, sourcesRead: 1, quotesSaved: 1 }, quotesFromThisTest: [{ id: "Q1", bearing: "for", newSinceTest: true }], earlierQuotes: [] });
    expect((await advanceUntilBlocked(watched, 3)).map(item => item.step)).toEqual(["verdict", "review", "design"]);
    expect(ledger.show(1).claims[0]).toMatchObject({ verdicts: [{ result: "unclear" }], tests: [{ id: "T1" }, { id: "T2", method: "Read club newsletters." }] });
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

  test("a test that needs the owner stops and asks, waits without asking the agent again, and resumes once they provide it", async () => {
    ledger.createProject("gardens", "Gardens struggle to coordinate watering.");
    ledger.logStep(1, "frame", null, { surveyQueries: [] });
    ledger.logStep(1, "survey", null, { skipped: "test" });
    const design = { claim: "C1", why: "Only the garden's own log shows it.", kind: "desk", method: "", prediction: "", stopWhen: "", queries: [], cuts: [], sanity: null, control: null, holdout: null, needsOwner: null, setAside: null };
    answers = {
      split: [{ idea: { title: "Rota", pitch: "Shared rota." }, claims: [{ kind: "need", statement: "Holiday handoffs fail.", killIf: "No missed watering in a season." }], reuse: [] }],
      design: [
        // A desk test with no queries is refused; the second answer says what only the owner can give.
        { ...design, method: "Read.", prediction: "Some.", stopWhen: "One." },
        { ...design, needsOwner: "Last summer's watering log from a garden you can reach.", setAside: null },
        { ...design, kind: "desk", method: "Count missed days in the owner's log.", prediction: "At least three.", stopWhen: "One log read.", queries: ["community garden watering rota missed"] },
      ],
    };
    const calls: string[] = [];
    const counting = context({ think: async request => { calls.push(request.step); return think(request); } });
    await expect(advanceUntilBlocked(counting, 5)).rejects.toMatchObject({ code: "BAD_ANSWER", message: expect.stringContaining("at least one search query") });
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

  test("a script whose program cannot start is a failed run, so the loop asks for a repaired script instead of approval again", async () => {
    ledger.createProject("quakes", "Anything.");
    ledger.logStep(1, "frame", null, { surveyQueries: [] });
    ledger.logStep(1, "survey", null, { skipped: "test" });
    const script = (command: string) => ({ files: [{ name: "a.py", content: "print(1)" }], command: [command, "a.py"], explanation: "Run." });
    answers = {
      split: [{ idea: { title: "Forecaster", pitch: "Odds." }, claims: [{ kind: "mechanism", statement: "It beats the baseline.", killIf: "No lift." }], reuse: [] }],
      design: [{ claim: "C1", why: "Data.", kind: "experiment", method: "Fit.", prediction: "Lift.", stopWhen: "One run.", queries: [], cuts: [], sanity: "Known event.", control: "Baseline.", holdout: "Later years.", needsOwner: null, setAside: null }],
      script: [script("python-missing"), script("uv")],
    };
    const runCommand: LoopContext["runCommand"] = async command => {
      if (command[0] === "python-missing") throw new CliError("RUN_FAILED", "Could not start python-missing: not found. Check that it is installed and on PATH.");
      return { command: command.join(" "), exitCode: 0, output: "Sanity check passed.\n[exit code 0]" };
    };
    const scriptInputs: unknown[] = [];
    const watching: Think = async request => { if (request.step === "script") scriptInputs.push(request.inputs); return think(request); };
    const trusted = context({ trust: true, runCommand, think: watching });
    expect((await advanceUntilBlocked(trusted, 4)).map(item => item.step)).toEqual(["split", "design", "script", "run"]);
    // Nothing ran, so nothing was saved, and a kill cannot rest on it.
    expect(ledger.show(1).sources).toHaveLength(0);
    expect(() => ledger.addVerdict({ claimId: 1, result: "killed", quoteIds: [], note: "It never ran.", author: "agent", testId: 1 })).toThrow("A kill cites quotes");
    expect((await advanceUntilBlocked(trusted, 2)).map(item => item.step)).toEqual(["script", "run"]);
    expect(ledger.show(1).sources).toMatchObject([{ exitCode: 0 }]);
    expect(scriptInputs[1]).toMatchObject({ earlierAttempts: [{ couldNotStart: expect.stringContaining("Could not start python-missing") }] });
  });

  test("a successful run by hand after a failed script is read instead of asking for another script", async () => {
    ledger.createProject("quakes", "Anything.");
    ledger.logStep(1, "frame", null, { surveyQueries: [] });
    ledger.logStep(1, "survey", null, { skipped: "test" });
    answers = {
      split: [{ idea: { title: "Forecaster", pitch: "Odds." }, claims: [{ kind: "mechanism", statement: "It beats the baseline.", killIf: "No lift." }], reuse: [] }],
      design: [{ claim: "C1", why: "Data.", kind: "experiment", method: "Fit.", prediction: "Lift.", stopWhen: "One run.", queries: [], cuts: [], sanity: "Known event.", control: "Baseline.", holdout: "Later years.", needsOwner: null, setAside: null }],
      script: [{ files: [{ name: "a.ts", content: "x" }], command: ["bun", "a.ts"], explanation: "Run." }],
    };
    const runCommand: LoopContext["runCommand"] = async command => ({ command: command.join(" "), exitCode: 1, output: "TypeError: catalog is undefined\n[exit code 1]" });
    expect((await advanceUntilBlocked(context({ trust: true, runCommand }), 4)).map(item => item.step)).toEqual(["split", "design", "script", "run"]);
    // The agent fixes it by hand with scraply experiment run, which saves a run without a loop step.
    await new Promise(resolve => setTimeout(resolve, 5));
    ledger.saveRun(1, { command: "bun fixed.ts", exitCode: 0, output: "Sanity check passed. Lift 0.12 on held-out years.\n[exit code 0]" });
    answers.read = [{ quotes: [] }];
    expect(await step()).toMatchObject({ step: "read", did: expect.stringContaining("Read 1 source") });
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
        { files: [{ name: "leftover.ts", content: "x" }, { name: "../escape.ts", content: "x" }], command: ["bun", "a.ts"], explanation: "Bad." },
        { files: [{ name: "lib/data.ts", content: "export {}" }, { name: "a.ts", content: "import './lib/data.ts'" }], command: ["bun", "a.ts"], explanation: "Good." },
      ],
    };
    await advance(context());
    await advance(context());
    await expect(advance(context())).rejects.toThrow("outside its folder");
    expect(existsSync(join(root, "work", "T1", "escape.ts"))).toBe(false);
    // A refused answer writes nothing, so the next one's folder holds only its own files.
    expect(existsSync(join(root, "work", "T1", "attempt-1", "leftover.ts"))).toBe(false);
    expect(await advance(context())).toMatchObject({ step: "script", status: "needs-you" });
    expect(existsSync(join(root, "work", "T1", "attempt-1", "lib", "data.ts"))).toBe(true);
    expect(existsSync(join(root, "work", "T1", "attempt-1", "leftover.ts"))).toBe(false);
  });

  test("a long run's failed sanity check printed last fails it, and every later step gets the good run as a source to read in full", async () => {
    ledger.createProject("quakes", "Anything.");
    ledger.logStep(1, "frame", null, { surveyQueries: [] });
    ledger.logStep(1, "survey", null, { skipped: "test" });
    const script = { files: [{ name: "a.ts", content: "console.log('x')" }], command: ["bun", "a.ts"], explanation: "Run." };
    answers = {
      split: [{ idea: { title: "Forecaster", pitch: "Odds." }, claims: [{ kind: "mechanism", statement: "It beats the baseline.", killIf: "No lift." }], reuse: [] }],
      design: [{ claim: "C1", why: "Data.", kind: "experiment", method: "Fit.", prediction: "Lift.", stopWhen: "One run.", queries: [], cuts: [], sanity: "Known event.", control: "Baseline.", holdout: "Later years.", needsOwner: null, setAside: null }],
      script: [script, script],
      read: [{ quotes: [{ source: "S2", text: "Forecaster AUC 0.71 against baseline 0.58 on held-out years.", speaker: "T1 run 2", kind: "measured", bearing: "for" }] }],
      verdict: [{ result: "provisional", quotes: ["Q1"], note: "The forecaster beats the baseline on held-out years." }],
      review: [{ result: "upheld", note: "The run reports it." }],
      findings: [{ summary: "The forecaster held.", findings: [], variants: [] }],
    };
    const noise = "row of intermediate output\n".repeat(3_000);
    const outputs = [`${noise}Sanity check failed: the known event was missed.\n[exit code 0]`, `${noise}Forecaster AUC 0.71 against baseline 0.58 on held-out years.\n[exit code 0]`];
    const runCommand: LoopContext["runCommand"] = async command => ({ command: command.join(" "), exitCode: 0, output: outputs.shift()! });
    const asked: Partial<Record<Step, readonly string[] | undefined>> = {};
    const watching: Think = async request => { asked[request.step] = request.sources; return think(request); };
    const steps = await advanceUntilBlocked(context({ trust: true, runCommand, think: watching }), 10);
    // The first run's failure is past the first window, yet it still sends the loop back to write a new script.
    expect(steps.map(item => item.step)).toEqual(["split", "design", "script", "run", "script", "run", "read", "verdict", "review", "findings"]);
    expect(asked).toMatchObject({ read: ["S2"], review: ["S2"], findings: ["S2"] });
    expect(ledger.show(1).claims[0]).toMatchObject({ status: "supported" });
  });

  test("a design for a claim that is not open is refused with the open claims named, never attached to another claim", async () => {
    ledger.createProject("hives", "Anything.");
    ledger.logStep(1, "frame", null, { surveyQueries: [] });
    ledger.logStep(1, "survey", null, { skipped: "test" });
    ledger.addClaim(1, "gap", "Nothing sells this.", "A product sells it.");
    ledger.addClaim(1, "need", "Keepers lose notes.", "Fewer than two describe it.");
    ledger.addIdea({ projectId: 1, title: "Voice log", pitch: "Talk.", claimIds: [1, 2] });
    ledger.logStep(1, "untestable", "C1", { why: "Only the owner's club could say." });
    const desk = { kind: "desk", method: "Read forums.", prediction: "Two.", stopWhen: "One search.", queries: ["hive notes"], cuts: [], sanity: null, control: null, holdout: null, needsOwner: null, setAside: null };
    answers = { design: [{ ...desk, claim: "C1", why: "Price check." }, { ...desk, claim: "C2", why: "Accounts." }] };
    await expect(advance(context())).rejects.toMatchObject({ code: "BAD_ANSWER", message: expect.stringContaining("open claims: C2") });
    expect(ledger.show(1).claims.flatMap(claim => claim.tests)).toHaveLength(0);
    expect(await advance(context())).toMatchObject({ step: "design", did: expect.stringContaining("T1 for C2") });
  });

  test("a request about a claim that is not open is refused, and a request whose claim was settled by hand stops blocking", async () => {
    ledger.createProject("hives", "Anything.");
    ledger.logStep(1, "frame", null, { surveyQueries: [] });
    ledger.logStep(1, "survey", null, { skipped: "test" });
    ledger.addClaim(1, "gap", "Nothing sells this.", "A product sells it.");
    ledger.addClaim(1, "need", "Keepers lose notes.", "Fewer than two describe it.");
    ledger.addIdea({ projectId: 1, title: "Voice log", pitch: "Talk.", claimIds: [1, 2] });
    ledger.logStep(1, "untestable", "C1", { why: "Only the owner's club could say." });
    const blank = { kind: "desk", method: "", prediction: "", stopWhen: "", queries: [], cuts: [], sanity: null, control: null, holdout: null, setAside: null };
    const desk = { ...blank, method: "Read forums.", prediction: "Two.", stopWhen: "One search.", queries: ["hive notes"], needsOwner: null };
    answers = { design: [
      { ...blank, claim: "C1", why: "Needs the club.", needsOwner: "Your club's records." },
      { ...blank, claim: "C2", why: "Needs your notes.", needsOwner: "Your own inspection notes." },
      { ...desk, claim: "C3", why: "No longer blocked." },
    ] };
    // A request about C1, which is set aside, is refused; the one about C2 stops the loop.
    await expect(advance(context())).rejects.toMatchObject({ code: "BAD_ANSWER" });
    expect(await advance(context())).toMatchObject({ step: "design", status: "needs-you", did: expect.stringContaining("inspection notes") });
    // The agent settles C2 by hand by retracting it; the loop stops waiting on its request and designs again.
    ledger.retract("claim", 2, "Folded into a sharper claim.");
    ledger.addClaim(1, "mechanism", "Speech splits by hive.", "Under half the notes name a hive.");
    ledger.addIdea({ projectId: 1, title: "Voice log 2", pitch: "Talk.", claimIds: [1, 3] });
    expect(await advance(context())).toMatchObject({ step: "design", status: "continue", did: expect.stringContaining("for C3") });
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
      if (request.step === "read") evidence.push([...request.sources ?? []]);
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
        // C1 was never asked about, so the agent cannot set it aside on its own say-so.
        { ...blank, claim: "C1", why: "Hard to test.", needsOwner: null, setAside: "Probably untestable." },
        emails,
        // The owner offers the emails and asks a question; the loop asks again instead of giving up on C1.
        { ...emails, needsOwner: "The emails as a text export, with names removed." },
      ],
    };
    await advanceUntilBlocked(context(), 5);
    ledger.addNote(1, "constraint", "I cannot reach any garden for a trial.");
    expect(await advance(context())).toMatchObject({ step: "design", status: "continue", did: expect.stringContaining("Set C2 aside") });
    await expect(advance(context())).rejects.toMatchObject({ code: "BAD_ANSWER", message: expect.stringContaining("setAside is only for") });
    expect(await advance(context())).toMatchObject({ step: "design", status: "needs-you", did: expect.stringContaining("coordination emails") });
    ledger.addNote(1, "constraint", "I can export them; which format do you want?");
    expect(await advance(context())).toMatchObject({ step: "design", status: "needs-you", did: expect.stringContaining("text export") });
    expect(ledger.steps(1).filter(item => item.step === "untestable").map(item => item.target)).toEqual(["C2"]);
  });

  test("the review is marked for an independent agent and gets the program behind the run to read from disk", async () => {
    ledger.createProject("quakes", "Anything.");
    ledger.logStep(1, "frame", null, { surveyQueries: [] });
    ledger.logStep(1, "survey", null, { skipped: "test" });
    const program = `${"// setup and helpers\n".repeat(1_200)}console.log("Forecaster AUC 0.71 against baseline 0.58 on held-out years.");\n`;
    answers = {
      split: [{ idea: { title: "Forecaster", pitch: "Odds." }, claims: [{ kind: "mechanism", statement: "It beats the baseline.", killIf: "No lift." }], reuse: [] }],
      design: [{ claim: "C1", why: "Data.", kind: "experiment", method: "Fit.", prediction: "Lift.", stopWhen: "One run.", queries: [], cuts: [], sanity: "Known event.", control: "Baseline.", holdout: "Later years.", needsOwner: null, setAside: null }],
      script: [{ files: [{ name: "forecast.ts", content: program }], command: ["bun", "forecast.ts"], explanation: "Run." }],
      read: [{ quotes: [{ source: "S1", text: "Forecaster AUC 0.71 against baseline 0.58 on held-out years.", speaker: "T1 run 1", kind: "measured", bearing: "for" }] }],
      verdict: [{ result: "provisional", quotes: ["Q1"], note: "The forecaster beats the baseline on held-out years." }],
      review: [{ result: "overturned", note: "The number is printed as a constant at the end of the program." }],
    };
    const reviews: ThinkRequest<unknown>[] = [];
    const watching: Think = async request => { if (request.step === "review") reviews.push(request); return think(request); };
    const steps = await advanceUntilBlocked(context({ trust: true, think: watching }), 7);
    expect(steps.map(item => item.step)).toEqual(["split", "design", "script", "run", "read", "verdict", "review"]);
    expect(reviews[0]).toMatchObject({ independent: true, sources: ["S1"] });
    const [path] = (reviews[0]!.inputs as { experimentRuns: { files: string[] }[] }).experimentRuns[0]!.files;
    expect(readFileSync(path!, "utf8")).toEndWith(`console.log("Forecaster AUC 0.71 against baseline 0.58 on held-out years.");\n`);
    expect(ledger.show(1).claims[0]).toMatchObject({ status: "overturned" });
  });

  test("a verdict and review recorded by hand after the write-up reopen it, and a new idea gets its own write-up", async () => {
    ledger.createProject("hives", "Anything.");
    ledger.logStep(1, "frame", null, { surveyQueries: [] });
    ledger.logStep(1, "survey", null, { skipped: "test" });
    ledger.addClaim(1, "need", "Keepers lose notes.", "Fewer than two describe it.");
    ledger.addIdea({ projectId: 1, title: "Voice log", pitch: "Talk.", claimIds: [1] });
    ledger.logStep(1, "untestable", "C1", { why: "Only the owner's club could say." });
    const nothing = (summary: string) => ({ summary, findings: [], variants: [] });
    // A finding that cites no saved quote is refused whole: no summary is saved either.
    answers = { findings: [{ summary: "Unsupported.", findings: [{ text: "Keepers hate apps.", quotes: ["Q99"] }], variants: [] }] };
    await expect(step()).rejects.toMatchObject({ code: "BAD_ANSWER", message: expect.stringContaining("Q99") });
    expect(ledger.show(1).notes).toHaveLength(0);
    answers = { findings: [nothing("Nothing could be tested."), nothing("Still unknown; the club records could not be reached."), nothing("The club version is untested too.")] };
    expect(await step()).toMatchObject({ step: "findings", did: expect.stringContaining("0 variant(s)"), next: expect.stringContaining("Nothing points to a variant") });
    expect(await step()).toMatchObject({ step: "steer", status: "done" });
    // The agent then records a verdict and its review by hand; the old write-up no longer describes the record.
    await new Promise(resolve => setTimeout(resolve, 5));
    const verdict = ledger.addVerdict({ claimId: 1, result: "unclear", quoteIds: [], note: "The club records could not be reached.", author: "agent" });
    ledger.addReview({ verdictId: parseId("verdict", verdict.id), result: "upheld", note: "Nothing was found either way.", reviewer: "second-agent" });
    expect(await step()).toMatchObject({ step: "findings", did: expect.stringContaining("Still unknown") });
    expect(await step()).toMatchObject({ step: "steer", status: "done" });
    // A new idea added by hand on the same settled claims gets its own write-up, not the previous idea's.
    ledger.addIdea({ projectId: 1, title: "Voice log for clubs", pitch: "Talk, then share.", claimIds: [1] });
    expect(await step()).toMatchObject({ step: "findings", did: expect.stringContaining("club version") });
  });

  test("a pass an older Scraply handed to the agent closes with the notes the agent wrote, not a second write-up", async () => {
    ledger.createProject("hives", "Anything.");
    ledger.logStep(1, "frame", null, { surveyQueries: [] });
    ledger.logStep(1, "survey", null, { skipped: "test" });
    ledger.addClaim(1, "need", "Keepers lose notes.", "Fewer than two describe it.");
    ledger.addIdea({ projectId: 1, title: "Voice log", pitch: "Talk.", claimIds: [1] });
    ledger.logStep(1, "untestable", "C1", { why: "Only the owner's club could say." });
    // The old --agent-findings handoff, then the agent's notes written by hand.
    ledger.logStep(1, "handoff", "I1", { notes: 0 });
    ledger.addNote(1, "summary", "Nothing could be tested with public evidence.");
    const variant = ledger.addNote(1, "variant", "Club survey: ask the owner's club directly. Why: public evidence was silent.");
    expect(await step()).toMatchObject({ step: "findings", status: "needs-you", next: expect.stringContaining(`<${variant.id}>`) });
    expect(await step()).toMatchObject({ step: "steer", status: "done" });
    expect(ledger.show(1).notes.filter(note => note.kind === "summary")).toHaveLength(1);
  });

  test("retracting evidence after the write-up changes a claim and reopens it", async () => {
    ledger.createProject("hives", "Anything.");
    ledger.logStep(1, "frame", null, { surveyQueries: [] });
    ledger.logStep(1, "survey", null, { skipped: "test" });
    ledger.addClaim(1, "need", "Keepers lose notes.", "Fewer than two describe it.");
    ledger.addIdea({ projectId: 1, title: "Voice log", pitch: "Talk.", claimIds: [1] });
    // The claim has used both of its tests, so a stale claim cannot be tested again in this pass.
    const earlier = ledger.addTest(1, { method: "Search.", prediction: "Two.", stopWhen: "One search." });
    ledger.addVerdict({ claimId: 1, result: "unclear", quoteIds: [], note: "Nothing either way.", author: "agent", testId: parseId("test", earlier.id) });
    const test = ledger.addTest(1, { method: "Read.", prediction: "Two.", stopWhen: "One read." });
    ledger.logStep(1, "design", test.id, { claim: "C1", why: "Test." });
    await new Promise(resolve => setTimeout(resolve, 5));
    const page = ledger.saveSource(1, { url: "https://forum.example/notes", title: "Notes", via: "exa", kind: "page", text: "Typing up my notes takes longer than the inspection itself. By the fourth colony I forget the first." });
    const first = ledger.addQuote(parseId("source", page.id), "Typing up my notes takes longer than the inspection itself.", "ridgehives", "firsthand");
    const second = ledger.addQuote(parseId("source", page.id), "By the fourth colony I forget the first.", "meadowkeeper", "firsthand");
    const verdict = ledger.addVerdict({ claimId: 1, result: "provisional", quoteIds: [parseId("quote", first.id), parseId("quote", second.id)], note: "Two keepers describe it.", author: "agent", testId: parseId("test", test.id) });
    ledger.addReview({ verdictId: parseId("verdict", verdict.id), result: "upheld", note: "Both first-hand.", reviewer: "second-agent" });
    answers = { findings: [{ summary: "The need held.", findings: [], variants: [] }, { summary: "The need is stale again.", findings: [], variants: [] }] };
    expect(await step()).toMatchObject({ step: "findings" });
    expect(await step()).toMatchObject({ step: "steer", status: "done" });
    // A quote the verdict rests on is retracted: the claim goes stale, and the old summary no longer holds.
    ledger.retract("quote", parseId("quote", second.id), "Misattributed.");
    expect(ledger.show(1).claims[0]!.status).toBe("stale");
    expect(await step()).toMatchObject({ step: "findings", did: expect.stringContaining("stale again") });
  });

  test("earlier quotes a verdict sees stay within a size budget, newest kept", async () => {
    ledger.createProject("hives", "Anything.");
    ledger.logStep(1, "frame", null, { surveyQueries: [] });
    ledger.logStep(1, "survey", null, { skipped: "test" });
    // Three long pages with 16 quotes of about 14,000 characters each: more than one call should carry.
    for (let page = 0; page < 3; page += 1) {
      const lines = Array.from({ length: 16 }, (_, line) => `Page ${page} line ${line}: ${"a long first-hand account ".repeat(530)}end.`);
      const source = ledger.saveSource(1, { url: `https://forum.example/${page}`, title: `Thread ${page}`, via: "exa", kind: "page", text: lines.join("\n") });
      for (const line of lines) ledger.addQuote(parseId("source", source.id), line, `keeper-${page}`, "firsthand");
    }
    ledger.addClaim(1, "need", "Keepers lose notes.", "Fewer than two describe it.");
    ledger.addIdea({ projectId: 1, title: "Voice log", pitch: "Talk.", claimIds: [1] });
    const test = ledger.addTest(1, { method: "Read.", prediction: "Two.", stopWhen: "One search.", kind: "desk", plan: { queries: ["hive notes"] } });
    ledger.logStep(1, "design", test.id, { claim: "C1", why: "Test." });
    ledger.logStep(1, "gather", test.id, { searches: [] });
    ledger.logStep(1, "read", test.id, { sources: [], quotes: [], bearings: [] });
    answers = { verdict: [{ result: "unclear", quotes: [], note: "This test found nothing new." }] };
    const inputs: { earlierQuotes: { text: string }[] }[] = [];
    expect(await advance(context({ think: async request => { inputs.push(request.inputs as typeof inputs[number]); return think(request); } }))).toMatchObject({ step: "verdict" });
    const earlier = inputs[0]!.earlierQuotes;
    expect(Buffer.byteLength(JSON.stringify(earlier))).toBeLessThanOrEqual(40_000);
    expect(earlier.length).toBeLessThan(48);
    expect(earlier.at(-1)!.text).toStartWith("Page 2 line 15:");
  }, 60_000);

});
