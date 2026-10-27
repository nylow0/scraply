import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli/main";

// A synthetic forum thread: two different keepers describe the same chore.
const THREAD = `<!doctype html><html><head><title>Inspection notes &amp; gloves</title><script>var x = "ignored";</script></head>
<body><nav>Home | Forum</nav>
<div class="post"><p><b>meadowkeeper</b></p><p>By the time I&rsquo;ve finished the fourth colony I can&rsquo;t remember what the first one looked like.</p></div>
<div class="post"><p><b>ridgehives</b></p><p>Typing up the dictaphone notes afterwards takes me longer than the inspection itself.</p></div>
</body></html>`;

let root: string;
let env: Record<string, string>;
let requests: { url: string; body?: string }[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "scraply-cli-"));
  // APPDATA points at an empty folder, so no real saved keys can be read.
  env = { APPDATA: join(root, "appdata"), SCRAPLY_DATA_DIR: join(root, "ledger") };
  requests = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));

const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  requests.push({ url, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
  if (url === "https://forum.example/thread-1") return new Response(THREAD, { headers: { "content-type": "text/html; charset=utf-8" } });
  if (url === "https://forum.example/blocked") return new Response("checking your browser", { status: 202, headers: { "content-type": "text/html" } });
  if (url === "https://api.exa.ai/search") {
    return Response.json({ results: [{ id: "r1", url: "https://shop.example/hive-app", title: "Hive app pricing", text: "Voice notes for every hive. Free for up to five hives, then a small monthly fee." }] });
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

/** Run one command the way an agent does (piped, so JSON) and return the parsed envelope. */
async function scraply(...argv: string[]): Promise<{ exitCode: number; ok: boolean; data?: unknown; error?: { code: string; message: string } }> {
  let output = "";
  const exitCode = await runCli(argv, { write: text => { output += text; }, isTTY: false, env, fetcher: fakeFetch });
  return { exitCode, ...JSON.parse(output) };
}

describe("scraply CLI", () => {
  test("a need claim goes from seed to supported only through verbatim quotes, two speakers, and a review", async () => {
    expect(await scraply("project", "new", "hive-notes", "--seed", "Beekeepers lose track of what they saw in each hive."))
      .toMatchObject({ ok: true, data: { id: "P1" } });

    expect(await scraply("fetch", "https://forum.example/thread-1", "--project", "P1"))
      .toMatchObject({ data: { id: "S1", status: "ok", title: "Inspection notes & gloves", via: "direct" } });
    const source = await scraply("source", "show", "S1");
    expect(source).toMatchObject({ data: { text: expect.stringContaining("By the time I’ve finished the fourth colony") } });
    expect(JSON.stringify(source)).not.toContain("ignored");

    // Straight apostrophes and different case still match the curly ones on the page.
    expect(await scraply("quote", "add", "--source", "S1", "--speaker", "meadowkeeper", "--kind", "firsthand",
      "--text", "by the time I've finished the fourth colony I can't remember what the first one looked like."))
      .toMatchObject({ data: { id: "Q1", text: "By the time I’ve finished the fourth colony I can’t remember what the first one looked like." } });
    expect(await scraply("quote", "add", "--source", "S1", "--speaker", "ridgehives", "--kind", "firsthand",
      "--text", "Typing up the dictaphone notes afterwards takes me longer than the inspection itself."))
      .toMatchObject({ data: { id: "Q2" } });

    expect(await scraply("quote", "add", "--source", "S1", "--speaker", "meadowkeeper", "--kind", "firsthand", "--text", "I lose all my notes because of my gloves every single time."))
      .toMatchObject({ ok: false, exitCode: 1, error: { code: "NOT_VERBATIM" } });
    expect(await scraply("quote", "add", "--source", "S1", "--speaker", "ridgehives", "--kind", "firsthand", "--text", "dictaphone notes"))
      .toMatchObject({ error: { code: "QUOTE_TOO_SHORT" } });

    await scraply("claim", "add", "--project", "P1", "--kind", "need", "--statement", "Hobby keepers lose per-hive observations.", "--kill-if", "Fewer than two keepers describe it.");
    expect(await scraply("test", "add", "--claim", "C1", "--method", "Read inspection threads.", "--prediction", "At least two keepers describe forgetting."))
      .toMatchObject({ data: { id: "T1" } });

    expect(await scraply("verdict", "add", "--claim", "C1", "--result", "provisional", "--quote", "Q1", "--note", "One keeper says so."))
      .toMatchObject({ error: { code: "ONE_SPEAKER" } });
    expect(await scraply("verdict", "add", "--claim", "C1", "--result", "provisional", "--quote", "Q1", "--quote", "Q2", "--note", "They say \"can't remember\"."))
      .toMatchObject({ error: { code: "QUOTED_NOTE" } });

    expect(await scraply("verdict", "add", "--claim", "C1", "--result", "provisional", "--quote", "Q1", "--quote", "Q2", "--test", "T1", "--note", "Two keepers describe the problem."))
      .toMatchObject({ data: { id: "V1", claim: "C1", status: "needs-review" } });
    expect(await scraply("review", "add", "--verdict", "V1", "--result", "upheld", "--note", "Both quotes are firsthand and from different people."))
      .toMatchObject({ data: { status: "supported" } });

    // A fresh reviewer sees the evidence without the author's notes or conclusions.
    const blind = await scraply("show", "--project", "P1", "--for-review");
    expect(blind).toMatchObject({
      data: {
        claims: [{ id: "C1", verdicts: [{ id: "V1", result: "provisional", test: "T1", quotesFetchedAfterPrediction: 0, quotes: ["Q1", "Q2"] }] }],
        quotes: [{ speaker: "meadowkeeper" }, { speaker: "ridgehives" }],
      },
    });
    const blindText = JSON.stringify(blind);
    for (const hidden of ["Two keepers describe the problem.", "different people", "needs-review", "supported", "\"notes\""]) expect(blindText).not.toContain(hidden);

    // Corrections are new rows: the newest verdict wins and the old one stays visible.
    await scraply("verdict", "add", "--claim", "C1", "--result", "killed", "--quote", "Q2", "--note", "Keepers already solve it with a free app.");
    expect(await scraply("show", "--project", "P1"))
      .toMatchObject({ data: { claims: [{ status: "killed", verdicts: [{ id: "V1" }, { id: "V2" }] }] } });
  });

  test("a blocked page is saved as a failed source and cannot be quoted", async () => {
    await scraply("project", "new", "blocked", "--seed", "Anything.");
    expect(await scraply("fetch", "https://forum.example/blocked", "--project", "P1"))
      .toMatchObject({ data: { id: "S1", status: "failed", chars: 0, error: expect.stringContaining("HTTP 202") } });
    expect(await scraply("quote", "add", "--source", "S1", "--speaker", "anyone", "--kind", "firsthand", "--text", "checking your browser before you continue"))
      .toMatchObject({ error: { code: "SOURCE_FAILED" } });
    expect(await scraply("show", "--project", "P1")).toMatchObject({ data: { sources: [{ id: "S1", status: "failed" }] } });
  });

  test("search saves each result's full text and reports a missing key clearly", async () => {
    await scraply("project", "new", "pricing", "--seed", "Anything.");
    expect(await scraply("search", "hive app pricing", "--project", "P1")).toMatchObject({ error: { code: "NO_KEY" } });
    expect(requests).toHaveLength(0);

    env.EXA_API_KEY = "test-key";
    expect(await scraply("search", "hive app pricing", "--project", "P1", "--results", "3"))
      .toMatchObject({ data: { provider: "exa", sources: [{ id: "S1", status: "ok", via: "exa", query: "hive app pricing" }] } });
    expect(JSON.parse(requests[0]!.body!)).toMatchObject({ query: "hive app pricing", numResults: 3 });
    expect(await scraply("quote", "add", "--source", "S1", "--speaker", "Hive app", "--kind", "vendor", "--text", "Free for up to five hives, then a small monthly fee."))
      .toMatchObject({ ok: true });
    const status = await scraply("status");
    expect(status).toMatchObject({ data: { searchProviders: ["exa"] } });
    expect(JSON.stringify(status)).not.toContain("test-key");
  });

  test("vendor copy and re-read pages cannot stand in for new firsthand evidence, and a kill can be overturned", async () => {
    env.EXA_API_KEY = "test-key";
    await scraply("project", "new", "rules", "--seed", "Anything.");
    await scraply("fetch", "https://forum.example/thread-1", "--project", "P1");
    await scraply("search", "hive app pricing", "--project", "P1");
    await scraply("quote", "add", "--source", "S1", "--speaker", "meadowkeeper", "--kind", "firsthand",
      "--text", "I can't remember what the first one looked like.");
    await scraply("quote", "add", "--source", "S2", "--speaker", "Hive app", "--kind", "vendor", "--text", "Voice notes for every hive.");

    await scraply("claim", "add", "--project", "P1", "--kind", "need", "--statement", "Keepers forget hives.", "--kill-if", "Fewer than two keepers say so.");
    await scraply("test", "add", "--claim", "C1", "--method", "Forums.", "--prediction", "Two keepers say so.");
    expect(await scraply("verdict", "add", "--claim", "C1", "--result", "provisional", "--quote", "Q1", "--quote", "Q2", "--note", "One keeper and a vendor."))
      .toMatchObject({ error: { code: "ONE_SPEAKER" } });

    // The thread was read before the prediction; reading it again afterwards is not new evidence.
    await scraply("fetch", "https://forum.example/thread-1", "--project", "P1");
    await scraply("quote", "add", "--source", "S3", "--speaker", "ridgehives", "--kind", "firsthand",
      "--text", "Typing up the dictaphone notes afterwards takes me longer than the inspection itself.");
    await scraply("verdict", "add", "--claim", "C1", "--result", "killed", "--quote", "Q3", "--test", "T1", "--note", "Notes are written up later, not forgotten.");
    expect(await scraply("show", "--project", "P1"))
      .toMatchObject({ data: { claims: [{ status: "killed", verdicts: [{ id: "V1", quotesFetchedAfterPrediction: 0 }] }] } });

    expect(await scraply("review", "add", "--verdict", "V1", "--result", "overturned", "--note", "The quote is about writing up, which still loses detail."))
      .toMatchObject({ data: { claim: "C1", status: "overturned" } });
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

  test("usage errors name the next command to run", async () => {
    expect(await scraply("verdict", "add", "--claim", "V1", "--result", "killed", "--note", "x"))
      .toMatchObject({ ok: false, exitCode: 2, error: { code: "USAGE" } });
    expect(await scraply("claim", "add", "--project", "P1"))
      .toMatchObject({ error: { message: expect.stringContaining("scraply claim add --project <project> --kind <kind>") } });
  });
});
