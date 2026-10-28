import { Database } from "bun:sqlite";
import { dlopen, ptr, toArrayBuffer, type Pointer } from "bun:ffi";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBackend } from "../../src/backend/server";
import { openSecrets } from "../../src/cli/credentials";
import { runCli } from "../../src/cli/main";
import { MODEL_PROVIDER, connectedModels, type ModelSession } from "../../src/cli/model";
import { ProviderFailure } from "../../src/providers/structured";

// Synthetic forum threads. The first is read before any prediction; the second only afterwards.
const THREAD = `<!doctype html><html><head><title>Inspection notes &amp; gloves</title><script>var x = "ignored";</script></head>
<body><nav>Home | Forum</nav>
<div class="post"><p><b>meadowkeeper</b></p><p>By the time I&rsquo;ve finished the fourth colony I can&rsquo;t remember what the first one looked like.</p></div>
<div class="post"><p><b>ridgehives</b></p><p>Typing up the dictaphone notes afterwards takes me longer than the inspection itself.</p></div>
</body></html>`;
const LATER_THREAD = `<html><head><title>Record keeping in summer</title></head><body>
<p>hivewright: I keep a notebook in my veil but the pages get sticky with propolis and I give up by August.</p>
<p>hivewright: Last year I requeened the wrong colony because my notes said hive 3 instead of hive 8.</p>
<p>In our club survey, 31 of 40 members said they had lost track of a colony's queen status at least once last season.</p>
<p>HiveNote Pro: voice notes for every hive, synced to the cloud, free for up to five hives.</p>
</body></html>`;

let root: string;
let env: Record<string, string>;
let requests: { url: string; body?: string; headers?: HeadersInit }[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "scraply-cli-"));
  // APPDATA points at an empty folder, so no real saved keys or desktop data can be read.
  env = { APPDATA: join(root, "appdata"), SCRAPLY_DATA_DIR: join(root, "ledger") };
  requests = [];
  stdin = "";
});
// Windows can hold a just-written file for a moment; retry like the backend tests do.
afterEach(async () => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { rmSync(root, { recursive: true, force: true }); return; }
    catch { await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1))); }
  }
});

const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  requests.push({ url, ...(typeof init?.body === "string" ? { body: init.body } : {}), ...(init?.headers ? { headers: init.headers } : {}) });
  const page = url.split("#")[0];
  const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
  if (page === "https://forum.example/thread-1") return html(THREAD);
  if (page === "https://forum.example/thread-2") return html(LATER_THREAD);
  if (page === "https://forum.example/long") return new Response("x".repeat(350_000), { headers: { "content-type": "text/plain" } });
  if (page === "https://forum.example/blocked") return new Response("checking your browser", { status: 202, headers: { "content-type": "text/html" } });
  if (url === "https://api.exa.ai/search") {
    const query = (JSON.parse(String(init?.body)) as { query: string }).query;
    if (query === "broken query") return new Response("upstream error", { status: 500 });
    if (query === "nothing here") return Response.json({ results: [] });
    return Response.json({ results: [{ id: "r1", url: "https://shop.example/hive-app", title: "Hive app pricing", text: "Voice notes for every hive. Free for up to five hives, then a small monthly fee." }] });
  }
  if (url === "https://api.exa.ai/contents") {
    // Exa cuts at the requested length; trailing whitespace is trimmed later and must not hide the cut.
    if (String(init?.body).includes("long-exa")) return Response.json({ results: [{ url: "https://forum.example/long-exa", text: `${"y".repeat(300_000)}\n${"z".repeat(999)}` }] });
    return Response.json({ results: [{ url: "https://forum.example/thread-2", title: "Record keeping in summer", text: "hivewright: I keep a notebook in my veil but the pages get sticky with propolis and I give up by August." }] });
  }
  if (url === "https://api.perplexity.ai/search") {
    return Response.json({ results: [{ title: "Record keeping in summer", url: "https://forum.example/thread-2", snippet: "I keep a notebook in my veil but the pages get sticky with propolis and I give up by August." }] });
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

interface Envelope { exitCode: number; ok: boolean; data?: unknown; error?: { code: string; message: string } }

/** Run one command the way an agent does (piped, so JSON) and return the parsed envelope. */
let stdin = "";
async function scraply(...argv: string[]): Promise<Envelope> {
  let output = "";
  const exitCode = await runCli(argv, { write: text => { output += text; }, notify: () => undefined, readStdin: async () => stdin, isTTY: false, env, fetcher: fakeFetch });
  return { exitCode, ...JSON.parse(output) };
}

/** The common opening: a project whose thread-1 was read before the need claim's test was written. */
async function needClaimWithTest() {
  await scraply("project", "new", "hive-notes", "--seed", "Beekeepers lose track of what they saw in each hive.");
  await scraply("fetch", "https://forum.example/thread-1", "--project", "P1");
  await scraply("claim", "add", "--project", "P1", "--kind", "need", "--statement", "Hobby keepers lose per-hive observations.", "--kill-if", "Fewer than two keepers describe it.");
  await scraply("test", "add", "--claim", "C1", "--method", "Read record-keeping threads.", "--prediction", "At least two keepers describe losing notes.", "--stop-when", "Ten threads read.");
}

describe("scraply CLI", () => {
  test("a need becomes supported only through a prior prediction, new evidence from two speakers, and someone else's review", async () => {
    await needClaimWithTest();
    await scraply("note", "add", "--project", "P1", "--kind", "constraint", "--text", "Two evenings a week and no budget for hardware.");
    await scraply("note", "add", "--project", "P1", "--kind", "framing", "--text", "An inspector would read club forums first.");

    // Straight apostrophes and different case still match the curly ones on the page, and the page's wording is saved.
    expect(await scraply("quote", "add", "--source", "S1", "--speaker", "meadowkeeper", "--kind", "firsthand",
      "--text", "by the time I've finished the fourth colony I can't remember what the first one looked like."))
      .toMatchObject({ data: { id: "Q1", text: "By the time I’ve finished the fourth colony I can’t remember what the first one looked like." } });
    await scraply("quote", "add", "--source", "S1", "--speaker", "ridgehives", "--kind", "firsthand", "--text", "Typing up the dictaphone notes afterwards takes me longer than the inspection itself.");
    expect(await scraply("quote", "add", "--source", "S1", "--speaker", "meadowkeeper", "--kind", "firsthand", "--text", "I lose all my notes because of my gloves every single time."))
      .toMatchObject({ ok: false, exitCode: 1, error: { code: "NOT_VERBATIM" } });

    // Evidence read before the prediction cannot confirm it, even re-read under another URL.
    expect(await scraply("verdict", "add", "--claim", "C1", "--result", "provisional", "--quote", "Q1", "--quote", "Q2", "--by", "author", "--note", "Two keepers say so."))
      .toMatchObject({ error: { code: "NO_TEST" } });
    expect(await scraply("verdict", "add", "--claim", "C1", "--result", "provisional", "--quote", "Q1", "--quote", "Q2", "--test", "T1", "--by", "author", "--note", "Two keepers say so."))
      .toMatchObject({ error: { code: "NOTHING_NEW" } });
    await scraply("fetch", "https://forum.example/thread-1#latest", "--project", "P1");
    await scraply("quote", "add", "--source", "S2", "--speaker", "ridgehives", "--kind", "firsthand", "--text", "Typing up the dictaphone notes afterwards takes me longer than the inspection itself.");
    expect(await scraply("verdict", "add", "--claim", "C1", "--result", "provisional", "--quote", "Q1", "--quote", "Q3", "--test", "T1", "--by", "author", "--note", "Two keepers say so."))
      .toMatchObject({ error: { code: "NOTHING_NEW" } });

    await scraply("fetch", "https://forum.example/thread-2", "--project", "P1");
    await scraply("quote", "add", "--source", "S3", "--speaker", "hivewright", "--kind", "firsthand", "--text", "I keep a notebook in my veil but the pages get sticky with propolis and I give up by August.");
    expect(await scraply("verdict", "add", "--claim", "C1", "--result", "provisional", "--quote", "Q1", "--quote", "Q4", "--test", "T1", "--by", "author", "--note", "Two keepers describe losing notes, one found after the prediction."))
      .toMatchObject({ data: { id: "V1", status: "provisional" } });

    // A fresh reviewer sees the owner's constraints and the evidence, not the author's framing or reasoning.
    const blind = await scraply("show", "--project", "P1", "--for-review");
    expect(blind).toMatchObject({
      data: {
        constraints: [{ id: "N1", text: "Two evenings a week and no budget for hardware." }],
        toReview: ["V1"],
        claims: [{ id: "C1", tests: [{ id: "T1", stopWhen: "Ten threads read." }], verdicts: [{ id: "V1", test: "T1", quotesNewSincePrediction: 1, quotes: ["Q1", "Q4"] }] }],
      },
    });
    for (const hidden of ["club forums", "one found after", "\"by\"", "\"status\":\"provisional\""]) expect(JSON.stringify(blind)).not.toContain(hidden);

    expect(await scraply("review", "add", "--verdict", "V1", "--result", "upheld", "--by", "Author", "--note", "Looks right."))
      .toMatchObject({ error: { code: "SELF_REVIEW" } });
    expect(await scraply("review", "add", "--verdict", "V1", "--result", "upheld", "--by", "reviewer-1", "--note", "Both quotes are firsthand, from different keepers."))
      .toMatchObject({ data: { status: "supported" } });
    expect(await scraply("show", "--project", "P1")).toMatchObject({
      data: { claims: [{ status: "supported", verdicts: [{ id: "V1", by: "author", reviews: [{ result: "upheld", by: "reviewer-1" }] }] }] },
    });
  });

  test("one passage, one speaker under two handles, or a seller's copy cannot make two independent accounts", async () => {
    await needClaimWithTest();
    await scraply("fetch", "https://forum.example/thread-2", "--project", "P1");
    const quote = (speaker: string, kind: string, text: string) => scraply("quote", "add", "--source", "S2", "--speaker", speaker, "--kind", kind, "--text", text);
    await quote("hivewright", "firsthand", "I keep a notebook in my veil but the pages get sticky with propolis and I give up by August.");
    await quote("@HiveWright", "firsthand", "the pages get sticky with propolis and I give up by August.");
    await quote("@HiveWright", "firsthand", "Last year I requeened the wrong colony because my notes said hive 3 instead of hive 8.");
    await quote("HiveNote", "vendor", "HiveNote Pro: voice notes for every hive, synced to the cloud, free for up to five hives.");
    await quote("Example Beekeeping Club", "measured", "In our club survey, 31 of 40 members said they had lost track of a colony's queen status at least once last season.");
    const verdict = (...quotes: string[]) => scraply("verdict", "add", "--claim", "C1", "--result", "provisional", "--test", "T1", "--by", "author",
      "--note", "Keepers lose notes.", ...quotes.flatMap(id => ["--quote", id]));

    expect(await verdict("Q1", "Q2")).toMatchObject({ error: { code: "DUPLICATE_PASSAGE" } });
    expect(await verdict("Q1", "Q3")).toMatchObject({ error: { code: "ONE_SPEAKER" } });
    expect(await verdict("Q1", "Q4")).toMatchObject({ error: { code: "ONE_SPEAKER" } });
    expect(await scraply("verdict", "add", "--claim", "C1", "--result", "provisional", "--test", "T1", "--by", "author", "--quote", "Q1", "--quote", "Q5", "--note", "They say \"give up\"."))
      .toMatchObject({ error: { code: "QUOTED_NOTE" } });
    // A measured account counts toward a need alongside a firsthand one.
    expect(await verdict("Q1", "Q5")).toMatchObject({ data: { status: "provisional" } });
  });

  test("kills wait for review, a review answers only the newest verdict, and an overturn is final", async () => {
    await scraply("project", "new", "gap", "--seed", "Anything.");
    await scraply("claim", "add", "--project", "P1", "--kind", "gap", "--statement", "No app logs hive notes by voice.", "--kill-if", "One app does it.");
    await scraply("fetch", "https://forum.example/thread-2", "--project", "P1");
    await scraply("quote", "add", "--source", "S1", "--speaker", "HiveNote", "--kind", "vendor", "--text", "HiveNote Pro: voice notes for every hive, synced to the cloud");

    expect(await scraply("verdict", "add", "--claim", "C1", "--result", "killed", "--quote", "Q1", "--by", "author", "--note", "An app already does it."))
      .toMatchObject({ data: { id: "V1", status: "kill-pending" } });
    expect(await scraply("show", "--project", "P1", "--for-review")).toMatchObject({ data: { toReview: ["V1"] } });
    expect(await scraply("verdict", "add", "--claim", "C1", "--result", "unclear", "--by", "author", "--note", "Not sure the app is live."))
      .toMatchObject({ data: { id: "V2", status: "unclear" } });
    expect(await scraply("review", "add", "--verdict", "V1", "--result", "upheld", "--by", "reviewer-1", "--note", "x")).toMatchObject({ error: { code: "SUPERSEDED" } });
    expect(await scraply("review", "add", "--verdict", "V2", "--result", "upheld", "--by", "reviewer-1", "--note", "x")).toMatchObject({ error: { code: "NOT_REVIEWABLE" } });

    await scraply("verdict", "add", "--claim", "C1", "--result", "killed", "--quote", "Q1", "--by", "author", "--note", "The app is live.");
    expect(await scraply("review", "add", "--verdict", "V3", "--result", "overturned", "--by", "reviewer-1", "--note", "The page is a pricing teaser, not proof it works."))
      .toMatchObject({ data: { status: "overturned" } });
    expect(await scraply("review", "add", "--verdict", "V3", "--result", "upheld", "--by", "reviewer-2", "--note", "x")).toMatchObject({ error: { code: "ALREADY_OVERTURNED" } });
  });

  test("searches and fetches keep failures, excerpts, and truncation visible", async () => {
    await scraply("project", "new", "sources", "--seed", "Anything.");
    expect(await scraply("search", "hive notes", "--project", "P1")).toMatchObject({ error: { code: "NO_KEY" } });
    expect(requests).toHaveLength(0);

    env.PERPLEXITY_API_KEY = "test-perplexity-key";
    expect(await scraply("search", "hive notes", "--project", "P1", "--provider", "perplexity"))
      .toMatchObject({ data: { search: "W1", status: "ok", sources: [{ id: "S1", kind: "excerpt", via: "perplexity" }] } });
    expect(await scraply("quote", "add", "--source", "S1", "--speaker", "hivewright", "--kind", "firsthand", "--text", "I keep a notebook in my veil but the pages get sticky with propolis."))
      .toMatchObject({ error: { code: "EXCERPT", message: expect.stringContaining("scraply fetch https://forum.example/thread-2 --project P1") } });

    env.EXA_API_KEY = "test-exa-key";
    expect(await scraply("search", "broken query", "--project", "P1")).toMatchObject({ exitCode: 1, error: { code: "SEARCH_FAILED" } });
    expect(await scraply("search", "nothing here", "--project", "P1", "--results", "3")).toMatchObject({ data: { status: "empty", sources: [] } });
    expect(JSON.parse(requests.at(-1)!.body!)).toMatchObject({ query: "nothing here", numResults: 3 });
    expect(await scraply("fetch", "https://forum.example/blocked", "--project", "P1"))
      .toMatchObject({ data: { status: "failed", chars: 0, error: expect.stringContaining("HTTP 202") } });
    expect(await scraply("fetch", "https://forum.example/thread-2", "--project", "P1", "--via", "exa"))
      .toMatchObject({ data: { id: "S3", kind: "page", via: "exa-contents", status: "ok" } });

    expect(await scraply("fetch", "https://forum.example/long", "--project", "P1")).toMatchObject({ data: { id: "S4", chars: 300_000, truncated: true } });
    const first = await scraply("source", "show", "S4");
    expect(first).toMatchObject({ data: { offset: 0, nextOffset: 40_000 } });
    const last = await scraply("source", "show", "S4", "--offset", "280000");
    expect(last.data).toMatchObject({ offset: 280_000 });
    expect(last.data).not.toHaveProperty("nextOffset");

    expect(await scraply("show", "--project", "P1")).toMatchObject({
      data: { searches: [{ id: "W1", status: "ok" }, { id: "W2", status: "failed", error: expect.stringContaining("500") }, { id: "W3", status: "empty" }] },
    });
    // A reviewer judging a kill that rests on finding nothing needs to see where the author looked.
    expect(await scraply("show", "--project", "P1", "--for-review")).toMatchObject({ data: { searches: [{ query: "hive notes", results: 1 }, { status: "failed", results: 0 }, { status: "empty" }] } });
    expect(JSON.stringify(await scraply("status"))).not.toContain("test-exa-key");
  });

  test("retractions, ideas, and exports keep the record honest after corrections", async () => {
    await needClaimWithTest();
    await scraply("fetch", "https://forum.example/thread-2", "--project", "P1");
    await scraply("quote", "add", "--source", "S2", "--speaker", "hivewright", "--kind", "firsthand", "--text", "I keep a notebook in my veil but the pages get sticky with propolis and I give up by August.");
    await scraply("quote", "add", "--source", "S2", "--speaker", "Example Beekeeping Club", "--kind", "measured", "--text", "In our club survey, 31 of 40 members said they had lost track of a colony's queen status at least once last season.");
    await scraply("verdict", "add", "--claim", "C1", "--result", "provisional", "--test", "T1", "--quote", "Q1", "--quote", "Q2", "--by", "author", "--note", "A keeper and a club survey.");
    await scraply("review", "add", "--verdict", "V1", "--result", "upheld", "--by", "reviewer-1", "--note", "Both hold.");
    await scraply("claim", "add", "--project", "P1", "--kind", "feasibility", "--statement", "A phone app can tag notes by hive.", "--kill-if", "Keepers cannot use a phone in gloves.");

    expect(await scraply("idea", "add", "--project", "P1", "--title", "Hive voice log", "--pitch", "Talk while inspecting; notes file themselves by hive.", "--claim", "C1", "--claim", "C2"))
      .toMatchObject({ data: { id: "I1", status: "open" } });

    // Retracting cited evidence leaves the verdict standing in the record but no longer counting.
    expect(await scraply("retract", "Q2", "--reason", "The survey asked about queens, not inspection notes.")).toMatchObject({ data: { retracted: "Q2" } });
    expect(await scraply("retract", "Q2", "--reason", "again")).toMatchObject({ error: { code: "NO_CHANGE" } });
    expect(await scraply("review", "add", "--verdict", "V1", "--result", "upheld", "--by", "reviewer-2", "--note", "x")).toMatchObject({ error: { code: "STALE" } });
    await scraply("idea", "add", "--project", "P1", "--title", "Hive voice log, gloves on", "--pitch", "Same, with a big push-to-talk button.", "--claim", "C1", "--revises", "I1");
    await scraply("retract", "C2", "--reason", "Replaced by a sharper claim.");
    expect(await scraply("test", "add", "--claim", "C2", "--method", "x", "--prediction", "x", "--stop-when", "x")).toMatchObject({ error: { code: "RETRACTED" } });

    expect(await scraply("show", "--project", "P1")).toMatchObject({
      data: {
        claims: [{ id: "C1", status: "stale" }, { id: "C2", status: "retracted", retracted: "Replaced by a sharper claim." }],
        ideas: [
          { id: "I1", status: "open", claims: [{ id: "C1", status: "stale", statusWhenSaved: "supported" }, { id: "C2", status: "retracted", statusWhenSaved: "untested" }] },
          { id: "I2", revises: "I1", claims: [{ id: "C1", statusWhenSaved: "stale" }] },
        ],
        quotes: [{ id: "Q1" }, { id: "Q2", retracted: expect.stringContaining("queens") }],
      },
    });

    const jsonPath = join(root, "out", "hive.json");
    expect(await scraply("export", "--project", "P1", "--out", jsonPath)).toMatchObject({ data: { format: "json", claims: 2, ideas: 2 } });
    const exported = JSON.parse(readFileSync(jsonPath, "utf8")) as { sources: { text: string | null }[]; quotes: { span: number[] }[] };
    expect(exported.sources[1]!.text).toContain("sticky with propolis");
    const [start, end] = exported.quotes[0]!.span as [number, number];
    expect(exported.sources[1]!.text!.slice(start, end)).toBe("I keep a notebook in my veil but the pages get sticky with propolis and I give up by August.");

    const markdownPath = join(root, "out", "hive.md");
    await scraply("export", "--project", "P1", "--out", markdownPath, "--format", "markdown");
    const report = readFileSync(markdownPath, "utf8");
    for (const expected of ["# hive-notes", "### I2: Hive voice log, gloves on (open)", "Revises I1.", "> I keep a notebook in my veil", "(retracted: The survey asked", "upheld** by reviewer-1"]) {
      expect(report).toContain(expected);
    }
  });

  test("files the user hands over become quotable sources, and projects can be archived and restored", async () => {
    await scraply("project", "new", "files", "--seed", "Anything.");
    const notes = join(root, "interview.txt");
    writeFileSync(notes, "Interview with a club secretary.\nWe tried a shared spreadsheet but nobody updates it after the first month.\n");
    expect(await scraply("source", "add", "--project", "P1", "--file", notes, "--title", "Interview notes the user took", "--origin", "owner"))
      .toMatchObject({ data: { id: "S1", kind: "file", via: "owner", url: "file:interview.txt", status: "ok" } });
    expect(await scraply("quote", "add", "--source", "S1", "--speaker", "club secretary", "--kind", "firsthand", "--text", "We tried a shared spreadsheet but nobody updates it after the first month."))
      .toMatchObject({ ok: true });
    expect(await scraply("source", "add", "--project", "P1", "--file", join(root, "missing.txt"), "--title", "x", "--origin", "owner"))
      .toMatchObject({ exitCode: 2, error: { code: "USAGE" } });

    await scraply("project", "new", "second", "--seed", "Anything.");
    expect(await scraply("project", "archive", "P1")).toMatchObject({ data: { archived: true } });
    expect(await scraply("project", "list")).toMatchObject({ data: [{ id: "P2" }] });
    expect(await scraply("project", "list", "--all")).toMatchObject({ data: [{ id: "P1", archived: true }, { id: "P2" }] });
    expect(await scraply("project", "restore", "P1")).toMatchObject({ data: { archived: false } });
    expect(await scraply("project", "restore", "P1")).toMatchObject({ error: { code: "NO_CHANGE" } });
  });

  test("copies, other projects, and withdrawn tests cannot launder evidence, and a kill can rest on searching that found nothing", async () => {
    await needClaimWithTest();
    // The same page saved twice: overlapping quotes from the two copies are one observation.
    await scraply("fetch", "https://forum.example/thread-2", "--project", "P1");
    await scraply("fetch", "https://forum.example/thread-2", "--project", "P1");
    await scraply("quote", "add", "--source", "S2", "--speaker", "observer1", "--kind", "firsthand", "--text", "I keep a notebook in my veil but the pages get sticky with propolis");
    await scraply("quote", "add", "--source", "S3", "--speaker", "observer2", "--kind", "firsthand", "--text", "the pages get sticky with propolis and I give up by August.");
    expect(await scraply("verdict", "add", "--claim", "C1", "--result", "provisional", "--test", "T1", "--quote", "Q1", "--quote", "Q2", "--by", "author", "--note", "Two keepers."))
      .toMatchObject({ error: { code: "DUPLICATE_PASSAGE" } });

    // A page saved in P1 is not new to a test written later in P2.
    await scraply("project", "new", "second", "--seed", "Anything.");
    await scraply("claim", "add", "--project", "P2", "--kind", "gap", "--statement", "No keeper app syncs notes.", "--kill-if", "One app syncs notes.");
    await scraply("test", "add", "--claim", "C2", "--method", "Search app pages.", "--prediction", "None sync.", "--stop-when", "Two searches.");
    await scraply("fetch", "https://forum.example/thread-2", "--project", "P2");
    await scraply("quote", "add", "--source", "S4", "--speaker", "HiveNote", "--kind", "vendor", "--text", "HiveNote Pro: voice notes for every hive, synced to the cloud");
    expect(await scraply("verdict", "add", "--claim", "C2", "--result", "provisional", "--test", "T2", "--quote", "Q3", "--by", "author", "--note", "A vendor page."))
      .toMatchObject({ error: { code: "NOTHING_NEW" } });

    // A kill with no quote must answer a test whose searching is on record.
    expect(await scraply("verdict", "add", "--claim", "C2", "--result", "killed", "--by", "author", "--note", "Nothing found."))
      .toMatchObject({ error: { code: "NO_EVIDENCE" } });
    await scraply("claim", "add", "--project", "P2", "--kind", "need", "--statement", "Keepers ask for synced notes.", "--kill-if", "No keeper asks for it after two searches.");
    await scraply("test", "add", "--claim", "C3", "--method", "Two searches.", "--prediction", "Two keepers ask.", "--stop-when", "Two searches.");
    expect(await scraply("verdict", "add", "--claim", "C3", "--result", "killed", "--test", "T3", "--by", "author", "--note", "Nothing found."))
      .toMatchObject({ error: { code: "NO_EVIDENCE" } });
    env.EXA_API_KEY = "test-exa-key";
    await scraply("search", "nothing here", "--project", "P2");
    expect(await scraply("verdict", "add", "--claim", "C3", "--result", "killed", "--test", "T3", "--by", "author", "--note", "Two searches found no keeper asking."))
      .toMatchObject({ data: { status: "kill-pending" } });
    expect(await scraply("show", "--project", "P2", "--for-review"))
      .toMatchObject({ data: { toReview: ["V1"], claims: [{}, { id: "C3", verdicts: [{ quotes: [], lookedSincePrediction: { searches: 1, fetches: 0 } }] }] } });

    // A withdrawn test leaves its claim untested, and a withdrawn claim takes no reviews.
    await scraply("retract", "T2", "--reason", "Wrong method.");
    await scraply("retract", "C3", "--reason", "Merged into C2.");
    expect(await scraply("show", "--project", "P2")).toMatchObject({ data: { claims: [{ id: "C2", status: "untested" }, { id: "C3", status: "retracted" }] } });
    expect(await scraply("review", "add", "--verdict", "V1", "--result", "upheld", "--by", "reviewer-1", "--note", "x")).toMatchObject({ error: { code: "RETRACTED" } });

    // A page Exa cut at the cap stays marked truncated even after trimming.
    expect(await scraply("fetch", "https://forum.example/long-exa", "--project", "P2", "--via", "exa")).toMatchObject({ data: { chars: 300_000, truncated: true } });
  });

  test("the ledger rejects edits and deletions made behind the CLI's back", async () => {
    await scraply("project", "new", "locked", "--seed", "Anything.");
    await scraply("claim", "add", "--project", "P1", "--kind", "gap", "--statement", "Nothing does this.", "--kill-if", "A product does it.");
    const db = new Database(join(env.SCRAPLY_DATA_DIR!, "ledger.db"));
    try {
      expect(() => db.run("UPDATE claims SET statement = 'rewritten'")).toThrow("append-only");
      expect(() => db.run("DELETE FROM claims")).toThrow("append-only");
    } finally {
      db.close();
    }
  });

  test("help and usage errors tell an agent what to run next", async () => {
    expect(await scraply("source", "show", "S1", "--help")).toMatchObject({ data: { commands: [{ usage: "scraply source show <source>" }] } });
    expect(await scraply("help", "project")).toMatchObject({ data: { commands: [{ usage: expect.stringContaining("project new") }, {}, {}, {}] } });
    expect(await scraply("verdict", "add", "--claim", "V1", "--result", "killed", "--by", "author", "--note", "x"))
      .toMatchObject({ ok: false, exitCode: 2, error: { code: "USAGE" } });
    expect(await scraply("source", "show", "S9007199254740993")).toMatchObject({ exitCode: 2, error: { code: "USAGE" } });
    expect(await scraply("claim", "add", "--project", "P1"))
      .toMatchObject({ error: { message: expect.stringContaining("scraply claim add --project <project> --kind <kind>") } });
  });

  test.skipIf(process.platform !== "win32")("search uses the desktop app's saved key without revealing it", async () => {
    // Write a profile the way Electron safeStorage does: a DPAPI-wrapped AES key, and AES-GCM secrets.
    const profile = join(env.APPDATA!, "scraply");
    mkdirSync(profile, { recursive: true });
    const key = randomBytes(32);
    writeFileSync(join(profile, "Local State"), JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from("DPAPI"), dpapiProtect(key)]).toString("base64") } }));
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const sealed = Buffer.concat([cipher.update(JSON.stringify({ exaApiKey: "saved-exa-key" })), cipher.final()]);
    writeFileSync(join(profile, "secrets.bin"), Buffer.concat([Buffer.from("v10"), nonce, sealed, cipher.getAuthTag()]));

    const status = await scraply("status");
    expect(status).toMatchObject({ data: { searchProviders: ["exa"], desktopDatabase: false } });
    expect(JSON.stringify(status)).not.toContain("saved-exa-key");
    await scraply("project", "new", "keys", "--seed", "Anything.");
    await scraply("search", "hive app pricing", "--project", "P1");
    expect(new Headers(requests[0]!.headers).get("x-api-key")).toBe("saved-exa-key");
  });

  test.skipIf(process.platform !== "win32")("keys piped into key set are saved encrypted and used by search, and models answers signed-out without a worker", async () => {
    expect(await scraply("status")).toMatchObject({ data: { searchProviders: [], modelAccount: "signed-out" } });
    expect(await scraply("models")).toMatchObject({ exitCode: 1, error: { code: "SIGNED_OUT" } });

    stdin = "two words\n";
    expect(await scraply("key", "set", "exa")).toMatchObject({ exitCode: 2, error: { code: "USAGE" } });
    stdin = "piped-exa-key\n";
    expect(await scraply("key", "set", "exa")).toMatchObject({ data: { provider: "exa", saved: true } });
    const saved = readFileSync(join(env.APPDATA!, "scraply", "secrets.bin"));
    expect(saved.subarray(0, 3).toString()).toBe("v10");
    expect(saved.toString("latin1")).not.toContain("piped-exa-key");

    await scraply("project", "new", "keys", "--seed", "Anything.");
    await scraply("search", "hive app pricing", "--project", "P1");
    expect(new Headers(requests[0]!.headers).get("x-api-key")).toBe("piped-exa-key");
    expect(await scraply("key", "remove", "exa")).toMatchObject({ data: { saved: false } });
    expect(await scraply("status")).toMatchObject({ data: { searchProviders: [] } });
  });

  test.skipIf(process.platform !== "win32")("logout deletes the saved account even when the model worker cannot start", async () => {
    const secrets = openSecrets(join(env.APPDATA!, "scraply"));
    const current = secrets.load();
    await secrets.save({ ...current, exaApiKey: "kept-exa-key", providerCredentials: { [MODEL_PROVIDER]: "synthetic-account" } });
    env.SCRAPLY_AGENT_PATH = join(root, "missing", "scraply-agent.exe");
    expect(await scraply("status")).toMatchObject({ data: { modelAccount: "saved" } });
    expect(await scraply("logout")).toMatchObject({ data: { connected: false } });
    expect(openSecrets(join(env.APPDATA!, "scraply")).load()).toMatchObject({ exaApiKey: "kept-exa-key", providerCredentials: {} });
  });

  test.skipIf(process.platform !== "win32")("logout never deletes a sign-in another process saved while it was signing out", async () => {
    const profile = join(env.APPDATA!, "scraply");
    const secrets = openSecrets(profile);
    await secrets.save({ ...secrets.load(), providerCredentials: { [MODEL_PROVIDER]: "account-a" } });
    const other = openSecrets(profile);
    const session = {
      client: { logout: async () => { await other.save({ ...other.load(), providerCredentials: { [MODEL_PROVIDER]: "account-b" } }); } },
      persist: async () => undefined, hasSavedAccount: () => true, close: async () => undefined,
    };
    let output = "";
    await runCli(["logout"], { write: text => { output += text; }, notify: () => undefined, isTTY: false, env, models: async () => session as unknown as ModelSession });
    expect(JSON.parse(output)).toMatchObject({ ok: false, error: { code: "CREDENTIALS_CONFLICT" } });
    expect(openSecrets(profile).load().providerCredentials).toEqual({ [MODEL_PROVIDER]: "account-b" });
  });

  test("only a rejected sign-in asks to sign in again; an outage says to try later without refreshing", async () => {
    let refreshed = 0;
    const session = (failure: ProviderFailure) => ({
      client: {
        listModels: async () => { if (!refreshed) throw failure; return []; },
        refreshAccount: async () => { refreshed += 1; },
        listAccounts: async () => [],
      },
      persist: async () => undefined, hasSavedAccount: () => true, close: async () => undefined,
    }) as unknown as ModelSession;
    await expect(connectedModels(session(new ProviderFailure("unavailable", "Service down", true)))).rejects.toMatchObject({ code: "MODEL_UNREACHABLE" });
    expect(refreshed).toBe(0);
    expect(await connectedModels(session(new ProviderFailure("auth", "Token expired", false)))).toMatchObject({ models: [] });
    expect(refreshed).toBe(1);
  });

  test("legacy export writes every desktop project with the app's own exporters and leaves the database untouched", async () => {
    // The app's layout: its data folder sits inside the Electron profile, %APPDATA%scraplyscraply.
    const data = join(env.APPDATA!, "scraply", "scraply");
    mkdirSync(data, { recursive: true });
    const desktop = await startBackend({
      dataDir: data, dbPath: join(data, "scraply.db"), bundledPromptsDir: join(process.cwd(), "prompts"), promptOverridesDir: join(data, "prompts"),
      appVersion: "test", getSecrets: () => ({ exaApiKey: null }),
      providerValidation: { inspectNative: async () => ({ available: false, connected: false, accounts: [], models: [] }) },
    }, () => undefined);
    await fetch(`http://127.0.0.1:${desktop.port}/threads`, {
      method: "POST", headers: { authorization: `Bearer ${desktop.token}`, "content-type": "application/json" }, body: JSON.stringify({ title: "Synthetic orchard project" }),
    });
    await desktop.close();
    const hash = () => createHash("sha256").update(readFileSync(join(data, "scraply.db"))).digest("hex");
    const before = hash();

    expect(await scraply("status")).toMatchObject({ data: { desktopDatabase: true } });
    const out = join(root, "desktop-export");
    expect(await scraply("legacy", "export", "--out", out)).toMatchObject({ data: { projects: 1, withResearch: 0 } });
    expect(hash()).toBe(before);
    expect(existsSync(join(out, "scraply-snapshot.db"))).toBe(true);
    const index = JSON.parse(readFileSync(join(out, "index.json"), "utf8")) as { folder: string; title: string; problems?: string[] }[];
    expect(index).toMatchObject([{ folder: "001-synthetic-orchard-project", title: "Synthetic orchard project", problems: [expect.stringContaining("research")] }]);
    expect(readdirSync(join(out, index[0]!.folder, "ideas-md"))).toContain("idea-history.md");
    expect(await scraply("legacy", "export", "--out", out)).toMatchObject({ error: { code: "OUT_NOT_EMPTY" } });
  }, 60_000);
});

/** Wrap bytes with the current user's DPAPI key, as Chromium does for its `Local State` key. */
function dpapiProtect(data: Buffer): Buffer {
  const crypt = dlopen("crypt32.dll", { CryptProtectData: { args: ["ptr", "ptr", "ptr", "ptr", "ptr", "u32", "ptr"], returns: "i32" } });
  const kernel = dlopen("kernel32.dll", { LocalFree: { args: ["ptr"], returns: "ptr" } });
  try {
    const input = Buffer.alloc(16);
    input.writeUInt32LE(data.length, 0);
    input.writeBigUInt64LE(BigInt(ptr(data)), 8);
    const output = Buffer.alloc(16);
    if (!crypt.symbols.CryptProtectData(input, null, null, null, null, 1, output)) throw new Error("DPAPI failed");
    const address = Number(output.readBigUInt64LE(8)) as Pointer;
    const copy = Buffer.from(new Uint8Array(toArrayBuffer(address, 0, output.readUInt32LE(0))));
    kernel.symbols.LocalFree(address);
    return copy;
  } finally {
    crypt.close();
    kernel.close();
  }
}
