import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "./output";

/**
 * The evidence ledger behind the `scraply` CLI. Rows are append-only: SQLite triggers reject
 * every UPDATE and DELETE, so a correction is a new row (the newest verdict on a claim wins).
 * Every rule an agent might bend under pressure is enforced here, not in the skill text:
 * quotes must be verbatim in a saved source, a need needs firsthand quotes from two speakers,
 * verdict notes cannot carry their own quotations, and nothing is "supported" until a review
 * upholds it. Kills can be reviewed too; an overturned kill reopens the claim.
 */

export const CLAIM_KINDS = ["need", "gap", "mechanism", "feasibility"] as const;
/** firsthand: the speaker describes their own experience. vendor: a seller describes its product. */
export const QUOTE_KINDS = ["firsthand", "vendor", "other"] as const;
export const VERDICT_RESULTS = ["killed", "unclear", "provisional"] as const;
export const REVIEW_RESULTS = ["upheld", "overturned"] as const;
export const NOTE_KINDS = ["constraint", "framing", "prior-art"] as const;
export const MIN_QUOTE_LENGTH = 20;

type ClaimKind = (typeof CLAIM_KINDS)[number];
type QuoteKind = (typeof QUOTE_KINDS)[number];
type VerdictResult = (typeof VERDICT_RESULTS)[number];
type ReviewResult = (typeof REVIEW_RESULTS)[number];
type NoteKind = (typeof NOTE_KINDS)[number];

const PREFIX = { project: "P", note: "N", source: "S", quote: "Q", claim: "C", test: "T", verdict: "V", review: "R" } as const;
type Entity = keyof typeof PREFIX;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, seed TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), kind TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), url TEXT NOT NULL, title TEXT,
  via TEXT NOT NULL, query TEXT, status TEXT NOT NULL CHECK (status IN ('ok', 'failed')), error TEXT,
  text TEXT, content_hash TEXT, fetched_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS quotes (id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL REFERENCES sources(id), text TEXT NOT NULL, speaker TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS claims (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), kind TEXT NOT NULL, statement TEXT NOT NULL, kill_if TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tests (id INTEGER PRIMARY KEY, claim_id INTEGER NOT NULL REFERENCES claims(id), method TEXT NOT NULL, prediction TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS verdicts (id INTEGER PRIMARY KEY, claim_id INTEGER NOT NULL REFERENCES claims(id), test_id INTEGER REFERENCES tests(id), result TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS verdict_quotes (verdict_id INTEGER NOT NULL REFERENCES verdicts(id), quote_id INTEGER NOT NULL REFERENCES quotes(id), PRIMARY KEY (verdict_id, quote_id));
CREATE TABLE IF NOT EXISTS reviews (id INTEGER PRIMARY KEY, verdict_id INTEGER NOT NULL REFERENCES verdicts(id), result TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL);
`;
const TABLES = ["projects", "notes", "sources", "quotes", "claims", "tests", "verdicts", "verdict_quotes", "reviews"];

/**
 * Fold text the way a reader compares quotes: ignore case, typographic quote and dash styles,
 * and whitespace runs. `start[i]`/`end[i]` give the original span behind folded code unit `i`.
 */
function fold(text: string) {
  let folded = "";
  const start: number[] = [];
  const end: number[] = [];
  let space = false;
  for (let index = 0; index < text.length;) {
    const char = String.fromCodePoint(text.codePointAt(index)!);
    const next = index + char.length;
    const normal = char.normalize("NFKC")
      .replace(/[‘’‚‛′]/g, "'")
      .replace(/[“”„‟″]/g, "\"")
      .replace(/[‐-―−]/g, "-")
      .toLowerCase();
    if (!normal.trim()) {
      space = folded.length > 0;
    } else {
      if (space) { folded += " "; start.push(index); end.push(index); space = false; }
      for (let unit = 0; unit < normal.length; unit++) { start.push(index); end.push(next); }
      folded += normal;
    }
    index = next;
  }
  return { folded, start, end };
}

/** The source's own wording for a quote, or null when the quote is not in the source. */
export function findVerbatim(sourceText: string, quote: string): string | null {
  const needle = fold(quote).folded;
  const haystack = fold(sourceText);
  const at = needle ? haystack.folded.indexOf(needle) : -1;
  if (at < 0) return null;
  return sourceText.slice(haystack.start[at], haystack.end[at + needle.length - 1]);
}

export function formatId(entity: Entity, id: number): string {
  return `${PREFIX[entity]}${id}`;
}

/** Accept `Q12` or `12`; reject an ID of the wrong kind so `V3` never resolves as a quote. */
export function parseId(entity: Entity, value: string): number {
  const match = /^([A-Za-z]?)(\d+)$/.exec(value.trim());
  if (!match || (match[1] && match[1].toUpperCase() !== PREFIX[entity])) {
    throw new CliError("USAGE", `"${value}" is not a ${entity} ID. Use ${PREFIX[entity]}<number>.`, 2);
  }
  return Number(match[2]);
}

interface ProjectRow { id: number; name: string; seed: string; created_at: string }
interface NoteRow { id: number; kind: string; text: string; created_at: string }
interface SourceRow { id: number; project_id: number; url: string; title: string | null; via: string; query: string | null; status: string; error: string | null; text: string | null; content_hash: string | null; fetched_at: string }
interface QuoteRow { id: number; source_id: number; text: string; speaker: string; kind: string; created_at: string }
interface ClaimRow { id: number; project_id: number; kind: string; statement: string; kill_if: string; created_at: string }
interface TestRow { id: number; claim_id: number; method: string; prediction: string; created_at: string }
interface VerdictRow { id: number; claim_id: number; test_id: number | null; result: string; note: string; created_at: string }
interface ReviewRow { id: number; verdict_id: number; result: string; note: string; created_at: string }

export interface FetchedSource {
  url: string;
  title?: string;
  via: string;
  query?: string;
  text?: string;
  error?: string;
}

export type Ledger = ReturnType<typeof openLedger>;

export function openLedger(dataDir: string, now: () => Date = () => new Date()) {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, "ledger.db"), { strict: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  for (const table of TABLES) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'the ledger is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'the ledger is append-only'); END;`);
  }
  const stamp = () => now().toISOString();

  function insert(sql: string, ...params: (string | number | null)[]): number {
    return Number(db.query(sql).run(...params).lastInsertRowid);
  }
  function one<T>(sql: string, ...params: (string | number)[]): T | null {
    return db.query(sql).get(...params) as T | null;
  }
  function all<T>(sql: string, ...params: (string | number)[]): T[] {
    return db.query(sql).all(...params) as T[];
  }
  function need<T>(row: T | null, entity: Entity, id: number): T {
    if (!row) throw new CliError("NOT_FOUND", `${formatId(entity, id)} does not exist. Run: scraply show --project <id>`);
    return row;
  }
  const project = (id: number) => need(one<ProjectRow>("SELECT * FROM projects WHERE id = ?", id), "project", id);
  const source = (id: number) => need(one<SourceRow>("SELECT * FROM sources WHERE id = ?", id), "source", id);
  const claim = (id: number) => need(one<ClaimRow>("SELECT * FROM claims WHERE id = ?", id), "claim", id);
  const verdict = (id: number) => need(one<VerdictRow>("SELECT * FROM verdicts WHERE id = ?", id), "verdict", id);
  const quoteProject = (quote: QuoteRow) => source(quote.source_id).project_id;

  function sourceView(row: SourceRow) {
    return {
      id: formatId("source", row.id), url: row.url, title: row.title, via: row.via, status: row.status,
      ...(row.error ? { error: row.error } : {}), ...(row.query ? { query: row.query } : {}),
      chars: row.text?.length ?? 0, fetchedAt: row.fetched_at,
    };
  }

  /**
   * A claim's state comes from its newest verdict and that verdict's newest review:
   * provisional needs an upheld review to become supported; any overturned verdict reopens the claim.
   */
  function claimStatus(claimId: number) {
    const latest = one<VerdictRow>("SELECT * FROM verdicts WHERE claim_id = ? ORDER BY id DESC LIMIT 1", claimId);
    if (!latest) return one("SELECT id FROM tests WHERE claim_id = ?", claimId) ? "testing" : "untested";
    const review = one<ReviewRow>("SELECT * FROM reviews WHERE verdict_id = ? ORDER BY id DESC LIMIT 1", latest.id);
    if (review?.result === "overturned") return "overturned";
    if (latest.result !== "provisional") return latest.result;
    return review ? "supported" : "needs-review";
  }

  return {
    close: () => db.close(),

    requireProject(projectId: number) {
      project(projectId);
    },

    createProject(name: string, seed: string) {
      const id = insert("INSERT INTO projects (name, seed, created_at) VALUES (?, ?, ?)", name, seed, stamp());
      return { id: formatId("project", id), name, seed };
    },

    listProjects() {
      return all<ProjectRow>("SELECT * FROM projects ORDER BY id").map(row => ({
        id: formatId("project", row.id), name: row.name, createdAt: row.created_at,
      }));
    },

    addNote(projectId: number, kind: NoteKind, text: string) {
      project(projectId);
      const id = insert("INSERT INTO notes (project_id, kind, text, created_at) VALUES (?, ?, ?, ?)", projectId, kind, text, stamp());
      return { id: formatId("note", id), kind };
    },

    /** Failed fetches are saved too, so a reader can see which evidence was out of reach. */
    saveSource(projectId: number, fetched: FetchedSource) {
      project(projectId);
      const text = fetched.text?.trim() || null;
      const status = text ? "ok" : "failed";
      const id = insert(
        "INSERT INTO sources (project_id, url, title, via, query, status, error, text, content_hash, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        projectId, fetched.url, fetched.title ?? null, fetched.via, fetched.query ?? null, status,
        status === "failed" ? fetched.error ?? "No text was returned." : null,
        text, text ? createHash("sha256").update(text).digest("hex") : null, stamp(),
      );
      return sourceView(source(id));
    },

    readSource(sourceId: number) {
      const row = source(sourceId);
      return { ...sourceView(row), contentHash: row.content_hash, text: row.text };
    },

    addQuote(sourceId: number, text: string, speaker: string, kind: QuoteKind) {
      const row = source(sourceId);
      if (row.status !== "ok" || !row.text) throw new CliError("SOURCE_FAILED", `${formatId("source", sourceId)} has no saved text, so nothing can be quoted from it.`);
      const quote = text.trim();
      if (quote.length < MIN_QUOTE_LENGTH) {
        throw new CliError("QUOTE_TOO_SHORT", `Quotes need at least ${MIN_QUOTE_LENGTH} characters so they keep their meaning. Quote the whole sentence.`);
      }
      // Save the source's own wording, not the caller's retyping of it.
      const original = findVerbatim(row.text, quote);
      if (original === null) {
        throw new CliError("NOT_VERBATIM", `The quote is not in ${formatId("source", sourceId)}. Copy it exactly from: scraply source show ${formatId("source", sourceId)}`);
      }
      const id = insert("INSERT INTO quotes (source_id, text, speaker, kind, created_at) VALUES (?, ?, ?, ?, ?)", sourceId, original, speaker.trim(), kind, stamp());
      return { id: formatId("quote", id), source: formatId("source", sourceId), speaker: speaker.trim(), kind, text: original };
    },

    addClaim(projectId: number, kind: ClaimKind, statement: string, killIf: string) {
      project(projectId);
      const id = insert("INSERT INTO claims (project_id, kind, statement, kill_if, created_at) VALUES (?, ?, ?, ?, ?)", projectId, kind, statement, killIf, stamp());
      return { id: formatId("claim", id), kind, status: "untested" };
    },

    addTest(claimId: number, method: string, prediction: string) {
      claim(claimId);
      const id = insert("INSERT INTO tests (claim_id, method, prediction, created_at) VALUES (?, ?, ?, ?)", claimId, method, prediction, stamp());
      return { id: formatId("test", id), claim: formatId("claim", claimId) };
    },

    addVerdict(claimId: number, result: VerdictResult, quoteIds: number[], note: string, testId?: number) {
      const target = claim(claimId);
      if (/["“”„‟]/.test(note)) {
        throw new CliError("QUOTED_NOTE", "Verdict notes cannot contain quotation marks. Save the words as a quote and cite it with --quote.");
      }
      if (testId !== undefined) {
        const test = need(one<TestRow>("SELECT * FROM tests WHERE id = ?", testId), "test", testId);
        if (test.claim_id !== claimId) throw new CliError("WRONG_TEST", `${formatId("test", testId)} tests ${formatId("claim", test.claim_id)}, not ${formatId("claim", claimId)}.`);
      }
      const quotes = [...new Set(quoteIds)].map(id => need(one<QuoteRow>("SELECT * FROM quotes WHERE id = ?", id), "quote", id));
      for (const quote of quotes) {
        if (quoteProject(quote) !== target.project_id) throw new CliError("WRONG_PROJECT", `${formatId("quote", quote.id)} belongs to another project.`);
      }
      if (result !== "unclear" && !quotes.length) throw new CliError("NO_EVIDENCE", `A ${result} verdict must cite at least one quote.`);
      const speakers = new Set(quotes.filter(quote => quote.kind === "firsthand").map(quote => quote.speaker.toLowerCase()));
      if (result === "provisional" && target.kind === "need" && speakers.size < 2) {
        throw new CliError("ONE_SPEAKER", "A need is supported only by firsthand quotes from at least two different speakers. Cite more firsthand quotes or record unclear.");
      }
      const id = insert("INSERT INTO verdicts (claim_id, test_id, result, note, created_at) VALUES (?, ?, ?, ?, ?)", claimId, testId ?? null, result, note, stamp());
      for (const quote of quotes) insert("INSERT INTO verdict_quotes (verdict_id, quote_id) VALUES (?, ?)", id, quote.id);
      return { id: formatId("verdict", id), claim: formatId("claim", claimId), status: claimStatus(claimId) };
    },

    addReview(verdictId: number, result: ReviewResult, note: string) {
      const row = verdict(verdictId);
      if (row.result === "unclear") throw new CliError("NOT_REVIEWABLE", `${formatId("verdict", verdictId)} is unclear; only provisional and killed verdicts are reviewed.`);
      const id = insert("INSERT INTO reviews (verdict_id, result, note, created_at) VALUES (?, ?, ?, ?)", verdictId, result, note, stamp());
      return { id: formatId("review", id), claim: formatId("claim", row.claim_id), status: claimStatus(row.claim_id) };
    },

    /**
     * The whole project. `forReview` drops every note and review so a fresh reviewer judges
     * the claims against the quotes and sources, not against the author's conclusions.
     */
    show(projectId: number, forReview = false) {
      const row = project(projectId);
      const sources = all<SourceRow>("SELECT * FROM sources WHERE project_id = ? ORDER BY id", projectId);
      // When each URL was first read in this project, so re-fetching an old page never counts as new evidence.
      const firstRead = new Map<string, string>();
      for (const item of sources) if (!firstRead.has(item.url)) firstRead.set(item.url, item.fetched_at);
      const firstReadOf = (sourceId: number) => firstRead.get(sources.find(item => item.id === sourceId)?.url ?? "") ?? "";
      const quotes = all<QuoteRow>("SELECT quotes.* FROM quotes JOIN sources ON sources.id = quotes.source_id WHERE sources.project_id = ? ORDER BY quotes.id", projectId);
      const claims = all<ClaimRow>("SELECT * FROM claims WHERE project_id = ? ORDER BY id", projectId).map(claimRow => {
        const tests = all<TestRow>("SELECT * FROM tests WHERE claim_id = ? ORDER BY id", claimRow.id);
        const verdicts = all<VerdictRow>("SELECT * FROM verdicts WHERE claim_id = ? ORDER BY id", claimRow.id).map(verdictRow => {
          const cited = all<{ quote_id: number }>("SELECT quote_id FROM verdict_quotes WHERE verdict_id = ? ORDER BY quote_id", verdictRow.id).map(item => item.quote_id);
          const test = tests.find(item => item.id === verdictRow.test_id);
          // Quotes from pages first read after the prediction are the ones that could have proved it wrong.
          const fresh = test ? cited.filter(id => {
            const quote = quotes.find(item => item.id === id);
            return quote !== undefined && firstReadOf(quote.source_id) > test.created_at;
          }).length : undefined;
          const reviews = all<ReviewRow>("SELECT * FROM reviews WHERE verdict_id = ? ORDER BY id", verdictRow.id);
          return {
            id: formatId("verdict", verdictRow.id), result: verdictRow.result,
            ...(test ? { test: formatId("test", test.id), quotesFetchedAfterPrediction: fresh } : {}),
            quotes: cited.map(id => formatId("quote", id)),
            ...(forReview ? {} : {
              note: verdictRow.note,
              reviews: reviews.map(review => ({ id: formatId("review", review.id), result: review.result, note: review.note })),
            }),
            decidedAt: verdictRow.created_at,
          };
        });
        return {
          id: formatId("claim", claimRow.id), kind: claimRow.kind, statement: claimRow.statement, killIf: claimRow.kill_if,
          ...(forReview ? {} : { status: claimStatus(claimRow.id) }),
          tests: tests.map(test => ({ id: formatId("test", test.id), method: test.method, prediction: test.prediction, predictedAt: test.created_at })),
          verdicts,
        };
      });
      return {
        project: { id: formatId("project", row.id), name: row.name, seed: row.seed },
        ...(forReview ? {} : { notes: all<NoteRow>("SELECT * FROM notes WHERE project_id = ? ORDER BY id", projectId).map(note => ({ id: formatId("note", note.id), kind: note.kind, text: note.text })) }),
        claims,
        quotes: quotes.map(quote => ({ id: formatId("quote", quote.id), source: formatId("source", quote.source_id), speaker: quote.speaker, kind: quote.kind, text: quote.text })),
        sources: sources.map(sourceView),
      };
    },
  };
}
