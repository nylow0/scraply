import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "./output";

/**
 * The evidence ledger behind the `scraply` CLI. Rows are append-only: SQLite triggers reject
 * every UPDATE and DELETE, so a correction is a new row. The newest verdict on a claim wins,
 * and `retract` withdraws a note, quote, claim, test, or idea while keeping it visible.
 * Every rule an agent might bend under pressure is enforced here, not in the skill text:
 * - quotes must be verbatim in a saved page or file, never in a search excerpt;
 * - one passage counts once, and speakers are compared by a normalized key;
 * - a need needs firsthand or measured quotes from two speakers;
 * - a provisional verdict answers a test written before at least one of its quotes was readable;
 * - verdict notes cannot carry their own quotations;
 * - nothing is supported or killed until someone other than the verdict's author reviews it.
 * Who wrote a verdict or review is the caller's claim, recorded so the owner can see it.
 */

export const CLAIM_KINDS = ["need", "gap", "mechanism", "feasibility"] as const;
/**
 * firsthand: the speaker describes their own experience. measured: a count, record, or study
 * result, attributed to whoever measured it. vendor: a seller describes its product.
 * Only firsthand and measured quotes count toward a need.
 */
export const QUOTE_KINDS = ["firsthand", "measured", "vendor", "other"] as const;
export const VERDICT_RESULTS = ["killed", "unclear", "provisional"] as const;
export const REVIEW_RESULTS = ["upheld", "overturned"] as const;
export const NOTE_KINDS = ["constraint", "framing", "prior-art"] as const;
/** owner: material the owner handed over. experiment: output of something the agent ran. */
export const FILE_ORIGINS = ["owner", "experiment"] as const;
export const MIN_QUOTE_LENGTH = 20;
/** Longest text saved for one source; longer pages are cut and marked truncated. */
export const MAX_SOURCE_CHARS = 300_000;
/** `source show` returns a long source in windows of this many characters. */
export const SOURCE_WINDOW = 40_000;
const NEED_EVIDENCE: readonly string[] = ["firsthand", "measured"];
const SCHEMA_VERSION = 1;

type ClaimKind = (typeof CLAIM_KINDS)[number];
type QuoteKind = (typeof QUOTE_KINDS)[number];
type VerdictResult = (typeof VERDICT_RESULTS)[number];
type ReviewResult = (typeof REVIEW_RESULTS)[number];
type NoteKind = (typeof NOTE_KINDS)[number];

const PREFIX = {
  project: "P", note: "N", search: "W", source: "S", quote: "Q", claim: "C", test: "T", verdict: "V", review: "R", idea: "I", retraction: "X",
} as const;
type Entity = keyof typeof PREFIX;
export const RETRACTABLE = ["note", "quote", "claim", "test", "idea"] as const satisfies readonly Entity[];
type Retractable = (typeof RETRACTABLE)[number];

const SCHEMA = `
CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, seed TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE project_events (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
  action TEXT NOT NULL CHECK (action IN ('archive', 'restore')), created_at TEXT NOT NULL);
CREATE TABLE notes (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), kind TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE searches (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), provider TEXT NOT NULL, query TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'empty', 'failed')), error TEXT, created_at TEXT NOT NULL);
CREATE TABLE sources (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), search_id INTEGER REFERENCES searches(id),
  url TEXT NOT NULL, title TEXT, via TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('page', 'excerpt', 'file')),
  status TEXT NOT NULL CHECK (status IN ('ok', 'failed')), error TEXT, text TEXT, truncated INTEGER NOT NULL,
  content_hash TEXT, fetched_at TEXT NOT NULL);
CREATE TABLE quotes (id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL REFERENCES sources(id), text TEXT NOT NULL,
  span_start INTEGER NOT NULL, span_end INTEGER NOT NULL, speaker TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE claims (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), kind TEXT NOT NULL, statement TEXT NOT NULL, kill_if TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE tests (id INTEGER PRIMARY KEY, claim_id INTEGER NOT NULL REFERENCES claims(id), method TEXT NOT NULL, prediction TEXT NOT NULL, stop_when TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE verdicts (id INTEGER PRIMARY KEY, claim_id INTEGER NOT NULL REFERENCES claims(id), test_id INTEGER REFERENCES tests(id),
  result TEXT NOT NULL, note TEXT NOT NULL, author TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE verdict_quotes (verdict_id INTEGER NOT NULL REFERENCES verdicts(id), quote_id INTEGER NOT NULL REFERENCES quotes(id), PRIMARY KEY (verdict_id, quote_id));
CREATE TABLE reviews (id INTEGER PRIMARY KEY, verdict_id INTEGER NOT NULL REFERENCES verdicts(id), result TEXT NOT NULL, note TEXT NOT NULL, reviewer TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE ideas (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), title TEXT NOT NULL, pitch TEXT NOT NULL,
  revises_id INTEGER REFERENCES ideas(id), created_at TEXT NOT NULL);
CREATE TABLE idea_claims (idea_id INTEGER NOT NULL REFERENCES ideas(id), claim_id INTEGER NOT NULL REFERENCES claims(id), PRIMARY KEY (idea_id, claim_id));
CREATE TABLE retractions (id INTEGER PRIMARY KEY, entity TEXT NOT NULL, target_id INTEGER NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (entity, target_id));
`;
const TABLES = [
  "projects", "project_events", "notes", "searches", "sources", "quotes", "claims", "tests", "verdicts", "verdict_quotes", "reviews", "ideas", "idea_claims", "retractions",
];

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

/** Where a quote sits in the source's own wording, or null when the quote is not in the source. */
export function findVerbatim(sourceText: string, quote: string): { text: string; start: number; end: number } | null {
  const needle = fold(quote).folded;
  const haystack = fold(sourceText);
  const at = needle ? haystack.folded.indexOf(needle) : -1;
  if (at < 0) return null;
  const start = haystack.start[at]!;
  const end = haystack.end[at + needle.length - 1]!;
  return { text: sourceText.slice(start, end), start, end };
}

/** The identity two speaker labels share when they name the same person: `@Meadow_Keeper` is `meadowkeeper`. */
export function speakerKey(speaker: string): string {
  return speaker.normalize("NFKC").toLowerCase().trim().replace(/^(@|\/?u\/)/, "").replace(/[^\p{L}\p{N}]+/gu, "");
}

export function formatId(entity: Entity, id: number): string {
  return `${PREFIX[entity]}${id}`;
}

/** Accept `Q12` or `12`; reject an ID of the wrong kind so `V3` never resolves as a quote. */
export function parseId(entity: Entity, value: string): number {
  const match = /^([A-Za-z]?)(\d+)$/.exec(value.trim());
  const id = Number(match?.[2]);
  if (!match || (match[1] && match[1].toUpperCase() !== PREFIX[entity]) || !Number.isSafeInteger(id) || id < 1) {
    throw new CliError("USAGE", `"${value}" is not a ${entity} ID. Use ${PREFIX[entity]}<number>, such as ${PREFIX[entity]}1.`, 2);
  }
  return id;
}

/** The entity behind a prefixed ID such as `C3`, for commands that accept several kinds. */
export function parseAnyId(value: string, allowed: readonly Entity[]): { entity: Entity; id: number } {
  const entity = allowed.find(item => value.trim().toUpperCase().startsWith(PREFIX[item]));
  if (!entity) throw new CliError("USAGE", `"${value}" must be one of: ${allowed.map(item => `${PREFIX[item]}<number> (${item})`).join(", ")}.`, 2);
  return { entity, id: parseId(entity, value) };
}

interface ProjectRow { id: number; name: string; seed: string; created_at: string }
interface NoteRow { id: number; project_id: number; kind: string; text: string; created_at: string }
interface SearchRow { id: number; project_id: number; provider: string; query: string; status: string; error: string | null; created_at: string }
interface SourceRow {
  id: number; project_id: number; search_id: number | null; url: string; title: string | null; via: string; kind: string;
  status: string; error: string | null; text: string | null; truncated: number; content_hash: string | null; fetched_at: string;
}
interface QuoteRow { id: number; source_id: number; text: string; span_start: number; span_end: number; speaker: string; kind: string; created_at: string }
interface ClaimRow { id: number; project_id: number; kind: string; statement: string; kill_if: string; created_at: string }
interface TestRow { id: number; claim_id: number; method: string; prediction: string; stop_when: string; created_at: string }
interface VerdictRow { id: number; claim_id: number; test_id: number | null; result: string; note: string; author: string; created_at: string }
interface ReviewRow { id: number; verdict_id: number; result: string; note: string; reviewer: string; created_at: string }
interface IdeaRow { id: number; project_id: number; title: string; pitch: string; revises_id: number | null; created_at: string }
interface RetractionRow { id: number; entity: string; target_id: number; reason: string; created_at: string }

export interface FetchedSource {
  url: string;
  title?: string;
  via: string;
  /** page: a whole page or file; excerpt: a search snippet that must be fetched before quoting. */
  kind: "page" | "excerpt" | "file";
  text?: string;
  truncated?: boolean;
  error?: string;
}

export type ClaimStatus =
  | "untested" | "testing" | "unclear" | "provisional" | "kill-pending" | "supported" | "killed" | "overturned" | "stale" | "retracted";

export type Ledger = ReturnType<typeof openLedger>;

/** Timestamps strictly increase within a process, so "written before" never ties. */
let lastStamp = 0;

export function openLedger(dataDir: string, now: () => Date = () => new Date()) {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, "ledger.db"), { strict: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  const { user_version: version } = db.query("PRAGMA user_version").get() as { user_version: number };
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table'").get()) {
    db.transaction(() => {
      db.exec(SCHEMA);
      for (const table of TABLES) {
        db.exec(`CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'the ledger is append-only'); END;
          CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'the ledger is append-only'); END;`);
      }
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    })();
  } else if (version !== SCHEMA_VERSION) {
    db.close();
    throw new CliError("LEDGER_VERSION", `${join(dataDir, "ledger.db")} was made by a different scraply version (${version}, expected ${SCHEMA_VERSION}). Move it aside or pass --data-dir.`);
  }
  const stamp = () => {
    lastStamp = Math.max(now().getTime(), lastStamp + 1);
    return new Date(lastStamp).toISOString();
  };

  function insert(sql: string, ...params: (string | number | null)[]): number {
    return Number(db.query(sql).run(...params).lastInsertRowid);
  }
  function one<T>(sql: string, ...params: (string | number)[]): T | null {
    return db.query(sql).get(...params) as T | null;
  }
  function all<T>(sql: string, ...params: (string | number)[]): T[] {
    return db.query(sql).all(...params) as T[];
  }
  function row<T>(entity: Entity, table: string, id: number): T {
    const found = one<T>(`SELECT * FROM ${table} WHERE id = ?`, id);
    if (!found) throw new CliError("NOT_FOUND", `${formatId(entity, id)} does not exist. Run: scraply show --project <id>`);
    return found;
  }
  const project = (id: number) => row<ProjectRow>("project", "projects", id);
  const source = (id: number) => row<SourceRow>("source", "sources", id);
  const quote = (id: number) => row<QuoteRow>("quote", "quotes", id);
  const claim = (id: number) => row<ClaimRow>("claim", "claims", id);
  const test = (id: number) => row<TestRow>("test", "tests", id);
  const verdict = (id: number) => row<VerdictRow>("verdict", "verdicts", id);
  const idea = (id: number) => row<IdeaRow>("idea", "ideas", id);

  // `asOf` reads the ledger as it stood at a moment; "￿" sorts after every ISO timestamp.
  const LATEST = "￿";
  function retraction(entity: Retractable, id: number, asOf = LATEST) {
    return one<RetractionRow>("SELECT * FROM retractions WHERE entity = ? AND target_id = ? AND created_at <= ?", entity, id, asOf);
  }
  function requireActive(entity: Retractable, id: number) {
    const found = retraction(entity, id);
    if (found) throw new CliError("RETRACTED", `${formatId(entity, id)} was retracted (${found.reason}).`);
  }
  function archived(projectId: number) {
    return one<{ action: string }>("SELECT action FROM project_events WHERE project_id = ? ORDER BY id DESC LIMIT 1", projectId)?.action === "archive";
  }

  function sourceView(item: SourceRow) {
    return {
      id: formatId("source", item.id), url: item.url, title: item.title, kind: item.kind, via: item.via, status: item.status,
      ...(item.error ? { error: item.error } : {}), ...(item.search_id ? { search: formatId("search", item.search_id) } : {}),
      chars: item.text?.length ?? 0, ...(item.truncated ? { truncated: true } : {}), fetchedAt: item.fetched_at,
    };
  }

  /** A verdict citing a retracted quote or answering a retracted test no longer stands. */
  function verdictStale(item: VerdictRow, asOf = LATEST) {
    if (item.test_id !== null && retraction("test", item.test_id, asOf)) return true;
    return all<{ quote_id: number }>("SELECT quote_id FROM verdict_quotes WHERE verdict_id = ?", item.id)
      .some(cited => retraction("quote", cited.quote_id, asOf));
  }

  /**
   * A claim's state at `asOf`, from its newest verdict and that verdict's reviews. Provisional and
   * killed verdicts wait for review; any overturning review reopens the claim for good.
   */
  function claimStatus(claimId: number, asOf = LATEST): ClaimStatus {
    if (retraction("claim", claimId, asOf)) return "retracted";
    const latest = one<VerdictRow>("SELECT * FROM verdicts WHERE claim_id = ? AND created_at <= ? ORDER BY id DESC LIMIT 1", claimId, asOf);
    if (!latest) return one("SELECT id FROM tests WHERE claim_id = ? AND created_at <= ?", claimId, asOf) ? "testing" : "untested";
    if (verdictStale(latest, asOf)) return "stale";
    if (latest.result === "unclear") return "unclear";
    const reviews = all<ReviewRow>("SELECT * FROM reviews WHERE verdict_id = ? AND created_at <= ?", latest.id, asOf);
    if (reviews.some(review => review.result === "overturned")) return "overturned";
    if (latest.result === "provisional") return reviews.length ? "supported" : "provisional";
    return reviews.length ? "killed" : "kill-pending";
  }

  /** An idea stands when every claim it rests on is supported, and dies with any of them. */
  function ideaStatus(ideaId: number, statuses: readonly ClaimStatus[]) {
    if (retraction("idea", ideaId)) return "retracted";
    if (statuses.includes("killed")) return "dead";
    return statuses.every(status => status === "supported") ? "standing" : "open";
  }

  /**
   * Cited quotes whose passage was in no saved page, file, or excerpt when the test was written.
   * Content, not URL, decides: a mirror or a `#fragment` alias of a page read earlier is not new.
   */
  function newSincePrediction(quotes: readonly QuoteRow[], projectId: number, predictedAt: string) {
    const seen = all<SourceRow>("SELECT * FROM sources WHERE project_id = ? AND status = 'ok' AND fetched_at < ?", projectId, predictedAt)
      .map(item => fold(item.text ?? "").folded);
    return quotes.filter(item => {
      const passage = fold(item.text).folded;
      return !seen.some(text => text.includes(passage));
    });
  }

  function verdictView(item: VerdictRow, projectId: number) {
    const cited = all<QuoteRow>("SELECT quotes.* FROM quotes JOIN verdict_quotes ON verdict_quotes.quote_id = quotes.id WHERE verdict_id = ? ORDER BY quotes.id", item.id);
    const answered = item.test_id === null ? null : test(item.test_id);
    return {
      id: formatId("verdict", item.id), result: item.result,
      ...(answered ? { test: formatId("test", answered.id), quotesNewSincePrediction: newSincePrediction(cited, projectId, answered.created_at).length } : {}),
      quotes: cited.map(quoteRow => formatId("quote", quoteRow.id)),
      note: item.note, by: item.author, ...(verdictStale(item) ? { stale: true } : {}),
      reviews: all<ReviewRow>("SELECT * FROM reviews WHERE verdict_id = ? ORDER BY id", item.id)
        .map(review => ({ id: formatId("review", review.id), result: review.result, by: review.reviewer, note: review.note, at: review.created_at })),
      decidedAt: item.created_at,
    };
  }

  function retractedView(entity: Retractable, id: number) {
    const found = retraction(entity, id);
    return found ? { retracted: found.reason } : {};
  }

  function saveSource(projectId: number, fetched: FetchedSource, searchId: number | null = null) {
    const text = fetched.text?.trim() || null;
    const status = text ? "ok" : "failed";
    const id = insert(
      "INSERT INTO sources (project_id, search_id, url, title, via, kind, status, error, text, truncated, content_hash, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      projectId, searchId, fetched.url, fetched.title ?? null, fetched.via, fetched.kind, status,
      status === "failed" ? fetched.error ?? "No text was returned." : null,
      text, fetched.truncated && text ? 1 : 0, text ? createHash("sha256").update(text).digest("hex") : null, stamp(),
    );
    return sourceView(source(id));
  }

  /** The whole project as the owner and its author see it. */
  function show(projectId: number) {
    const item = project(projectId);
    return {
      project: { id: formatId("project", item.id), name: item.name, seed: item.seed, createdAt: item.created_at, ...(archived(projectId) ? { archived: true } : {}) },
      notes: all<NoteRow>("SELECT * FROM notes WHERE project_id = ? ORDER BY id", projectId)
        .map(note => ({ id: formatId("note", note.id), kind: note.kind, text: note.text, ...retractedView("note", note.id) })),
      ideas: all<IdeaRow>("SELECT * FROM ideas WHERE project_id = ? ORDER BY id", projectId).map(ideaRow => {
        const claimIds = all<{ claim_id: number }>("SELECT claim_id FROM idea_claims WHERE idea_id = ? ORDER BY claim_id", ideaRow.id).map(link => link.claim_id);
        const statuses = claimIds.map(id => claimStatus(id));
        return {
          id: formatId("idea", ideaRow.id), title: ideaRow.title, pitch: ideaRow.pitch, status: ideaStatus(ideaRow.id, statuses),
          ...(ideaRow.revises_id ? { revises: formatId("idea", ideaRow.revises_id) } : {}),
          // Each claim's status now and when the idea was saved, so later evidence never rewrites what it was based on.
          claims: claimIds.map((id, index) => ({ id: formatId("claim", id), status: statuses[index]!, statusWhenSaved: claimStatus(id, ideaRow.created_at) })),
          savedAt: ideaRow.created_at, ...retractedView("idea", ideaRow.id),
        };
      }),
      claims: all<ClaimRow>("SELECT * FROM claims WHERE project_id = ? ORDER BY id", projectId).map(claimRow => ({
        id: formatId("claim", claimRow.id), kind: claimRow.kind, statement: claimRow.statement, killIf: claimRow.kill_if,
        status: claimStatus(claimRow.id), ...retractedView("claim", claimRow.id),
        tests: all<TestRow>("SELECT * FROM tests WHERE claim_id = ? ORDER BY id", claimRow.id).map(testRow => ({
          id: formatId("test", testRow.id), method: testRow.method, prediction: testRow.prediction, stopWhen: testRow.stop_when,
          predictedAt: testRow.created_at, ...retractedView("test", testRow.id),
        })),
        verdicts: all<VerdictRow>("SELECT * FROM verdicts WHERE claim_id = ? ORDER BY id", claimRow.id).map(verdictRow => verdictView(verdictRow, projectId)),
      })),
      quotes: all<QuoteRow>("SELECT quotes.* FROM quotes JOIN sources ON sources.id = quotes.source_id WHERE sources.project_id = ? ORDER BY quotes.id", projectId)
        .map(quoteRow => ({
          id: formatId("quote", quoteRow.id), source: formatId("source", quoteRow.source_id), speaker: quoteRow.speaker, kind: quoteRow.kind,
          text: quoteRow.text, ...retractedView("quote", quoteRow.id),
        })),
      searches: all<SearchRow>("SELECT * FROM searches WHERE project_id = ? ORDER BY id", projectId).map(search => ({
        id: formatId("search", search.id), provider: search.provider, query: search.query, status: search.status,
        ...(search.error ? { error: search.error } : {}), at: search.created_at,
      })),
      sources: all<SourceRow>("SELECT * FROM sources WHERE project_id = ? ORDER BY id", projectId).map(sourceView),
    };
  }

  /**
   * What a fresh reviewer sees: the owner's constraints, the live claims, their tests, the verdicts
   * waiting for review, the quotes, and the sources. It leaves out the author's notes, framing,
   * ideas, statuses, and earlier reviews, so the reviewer judges the evidence itself.
   */
  function showForReview(projectId: number) {
    const full = show(projectId);
    const live = <T extends { retracted?: string }>(items: readonly T[]) => items.filter(entry => !entry.retracted);
    return {
      project: { id: full.project.id, name: full.project.name, seed: full.project.seed },
      constraints: live(full.notes).filter(note => note.kind === "constraint").map(note => ({ id: note.id, text: note.text })),
      toReview: full.claims.flatMap(claim => claim.status === "provisional" || claim.status === "kill-pending" ? [claim.verdicts.at(-1)!.id] : []),
      claims: live(full.claims).map(claim => ({
        id: claim.id, kind: claim.kind, statement: claim.statement, killIf: claim.killIf, tests: live(claim.tests),
        verdicts: claim.verdicts.map(verdict => ({
          id: verdict.id, result: verdict.result, quotes: verdict.quotes, decidedAt: verdict.decidedAt,
          ...(verdict.test ? { test: verdict.test, quotesNewSincePrediction: verdict.quotesNewSincePrediction } : {}),
        })),
      })),
      quotes: live(full.quotes),
      sources: full.sources,
    };
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

    listProjects(includeArchived: boolean) {
      return all<ProjectRow>("SELECT * FROM projects ORDER BY id")
        .map(item => ({ id: formatId("project", item.id), name: item.name, createdAt: item.created_at, ...(archived(item.id) ? { archived: true } : {}) }))
        .filter(item => includeArchived || !item.archived);
    },

    /** Archiving hides a project from `project list`; it stays readable and can be restored. */
    setArchived(projectId: number, archive: boolean) {
      project(projectId);
      if (archived(projectId) === archive) throw new CliError("NO_CHANGE", `${formatId("project", projectId)} is already ${archive ? "archived" : "active"}.`);
      insert("INSERT INTO project_events (project_id, action, created_at) VALUES (?, ?, ?)", projectId, archive ? "archive" : "restore", stamp());
      return { id: formatId("project", projectId), archived: archive };
    },

    addNote(projectId: number, kind: NoteKind, text: string) {
      project(projectId);
      const id = insert("INSERT INTO notes (project_id, kind, text, created_at) VALUES (?, ?, ?, ?)", projectId, kind, text, stamp());
      return { id: formatId("note", id), kind };
    },

    /** Every search attempt is kept, including failed and empty ones, with the sources it returned. */
    recordSearch(projectId: number, provider: string, query: string, outcome: { sources: readonly FetchedSource[] } | { error: string }) {
      project(projectId);
      const failed = "error" in outcome;
      const status = failed ? "failed" : outcome.sources.length ? "ok" : "empty";
      const id = insert("INSERT INTO searches (project_id, provider, query, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        projectId, provider, query, status, failed ? outcome.error : null, stamp());
      return { id: formatId("search", id), status, sources: failed ? [] : outcome.sources.map(item => saveSource(projectId, item, id)) };
    },

    /** Failed fetches are saved too, so a reader can see which evidence was out of reach. */
    saveSource(projectId: number, fetched: FetchedSource) {
      project(projectId);
      return saveSource(projectId, fetched);
    },

    /** One window of a source's text; `nextOffset` is set while more remains. */
    readSource(sourceId: number, offset = 0) {
      const item = source(sourceId);
      const text = item.text ?? "";
      const start = Math.min(Math.max(0, Math.trunc(offset)), text.length);
      const end = Math.min(text.length, start + SOURCE_WINDOW);
      return {
        ...sourceView(item), contentHash: item.content_hash, offset: start,
        ...(end < text.length ? { nextOffset: end } : {}), text: text.slice(start, end),
      };
    },

    addQuote(sourceId: number, text: string, speaker: string, kind: QuoteKind) {
      const item = source(sourceId);
      const id = formatId("source", sourceId);
      if (item.status !== "ok" || !item.text) throw new CliError("SOURCE_FAILED", `${id} has no saved text, so nothing can be quoted from it.`);
      if (item.kind === "excerpt") {
        throw new CliError("EXCERPT", `${id} is a search excerpt, not the page. Fetch the page and quote from that: scraply fetch ${item.url} --project ${formatId("project", item.project_id)}`);
      }
      const passage = text.trim();
      if (passage.length < MIN_QUOTE_LENGTH) {
        throw new CliError("QUOTE_TOO_SHORT", `Quotes need at least ${MIN_QUOTE_LENGTH} characters so they keep their meaning. Quote the whole sentence.`);
      }
      const name = speaker.trim();
      if (!speakerKey(name)) throw new CliError("USAGE", "--speaker needs a name or handle with letters or digits.", 2);
      // Save the source's own wording, not the caller's retyping of it.
      const found = findVerbatim(item.text, passage);
      if (!found) throw new CliError("NOT_VERBATIM", `The quote is not in ${id}. Copy it exactly from: scraply source show ${id}`);
      const quoteId = insert("INSERT INTO quotes (source_id, text, span_start, span_end, speaker, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        sourceId, found.text, found.start, found.end, name, kind, stamp());
      return { id: formatId("quote", quoteId), source: id, speaker: name, kind, text: found.text };
    },

    addClaim(projectId: number, kind: ClaimKind, statement: string, killIf: string) {
      project(projectId);
      const id = insert("INSERT INTO claims (project_id, kind, statement, kill_if, created_at) VALUES (?, ?, ?, ?, ?)", projectId, kind, statement, killIf, stamp());
      return { id: formatId("claim", id), kind, status: "untested" };
    },

    addTest(claimId: number, method: string, prediction: string, stopWhen: string) {
      claim(claimId);
      requireActive("claim", claimId);
      const id = insert("INSERT INTO tests (claim_id, method, prediction, stop_when, created_at) VALUES (?, ?, ?, ?, ?)", claimId, method, prediction, stopWhen, stamp());
      return { id: formatId("test", id), claim: formatId("claim", claimId) };
    },

    addVerdict(input: { claimId: number; result: VerdictResult; quoteIds: readonly number[]; note: string; author: string; testId?: number }) {
      const target = claim(input.claimId);
      const claimId = formatId("claim", input.claimId);
      requireActive("claim", input.claimId);
      if (/["“”„‟«»]/.test(input.note)) {
        throw new CliError("QUOTED_NOTE", "Verdict notes cannot contain quotation marks. Save the words as a quote and cite it with --quote.");
      }
      const answered = input.testId === undefined ? null : test(input.testId);
      if (answered) {
        if (answered.claim_id !== input.claimId) throw new CliError("WRONG_TEST", `${formatId("test", answered.id)} tests ${formatId("claim", answered.claim_id)}, not ${claimId}.`);
        requireActive("test", answered.id);
      }
      const quotes = [...new Set(input.quoteIds)].map(quote);
      for (const item of quotes) {
        if (source(item.source_id).project_id !== target.project_id) throw new CliError("WRONG_PROJECT", `${formatId("quote", item.id)} belongs to another project.`);
        requireActive("quote", item.id);
      }
      // One passage is one observation, however many times or under whatever speakers it was saved.
      quotes.forEach((first, index) => quotes.slice(index + 1).forEach(second => {
        const overlap = first.source_id === second.source_id && first.span_start < second.span_end && second.span_start < first.span_end;
        const [a, b] = [fold(first.text).folded, fold(second.text).folded];
        if (overlap || a.includes(b) || b.includes(a)) {
          throw new CliError("DUPLICATE_PASSAGE", `${formatId("quote", first.id)} and ${formatId("quote", second.id)} are the same passage. Cite it once.`);
        }
      }));
      if (input.result !== "unclear" && !quotes.length) throw new CliError("NO_EVIDENCE", `A ${input.result} verdict must cite at least one quote.`);
      if (input.result === "provisional") {
        if (!answered) {
          throw new CliError("NO_TEST", `A provisional verdict answers a test written before looking. Add one with: scraply test add --claim ${claimId} ..., gather new evidence, then cite it with --test.`);
        }
        if (!newSincePrediction(quotes, target.project_id, answered.created_at).length) {
          throw new CliError("NOTHING_NEW", `Every cited quote was already in a source saved before ${formatId("test", answered.id)} was written, so none of them could have proved its prediction wrong. Cite evidence found after the test, or record unclear.`);
        }
        const speakers = new Set(quotes.filter(item => NEED_EVIDENCE.includes(item.kind)).map(item => speakerKey(item.speaker)));
        if (target.kind === "need" && speakers.size < 2) {
          throw new CliError("ONE_SPEAKER", "A need is supported only by firsthand or measured quotes from at least two different speakers. Cite more, or record unclear.");
        }
      }
      const id = insert("INSERT INTO verdicts (claim_id, test_id, result, note, author, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        input.claimId, answered?.id ?? null, input.result, input.note, input.author.trim(), stamp());
      for (const item of quotes) insert("INSERT INTO verdict_quotes (verdict_id, quote_id) VALUES (?, ?)", id, item.id);
      return { id: formatId("verdict", id), claim: claimId, status: claimStatus(input.claimId) };
    },

    addReview(input: { verdictId: number; result: ReviewResult; note: string; reviewer: string }) {
      const item = verdict(input.verdictId);
      const id = formatId("verdict", item.id);
      if (item.result === "unclear") throw new CliError("NOT_REVIEWABLE", `${id} is unclear; only provisional and killed verdicts are reviewed.`);
      const latest = one<{ id: number }>("SELECT id FROM verdicts WHERE claim_id = ? ORDER BY id DESC LIMIT 1", item.claim_id)!;
      if (latest.id !== item.id) throw new CliError("SUPERSEDED", `${id} was replaced by ${formatId("verdict", latest.id)}. Review that one.`);
      if (verdictStale(item)) throw new CliError("STALE", `${id} cites retracted evidence. The author must record a new verdict first.`);
      if (speakerKey(input.reviewer) === speakerKey(item.author)) {
        throw new CliError("SELF_REVIEW", `${id} was written by ${item.author}. A review must come from a different agent that did not do the work.`);
      }
      if (one("SELECT id FROM reviews WHERE verdict_id = ? AND result = 'overturned'", item.id)) {
        throw new CliError("ALREADY_OVERTURNED", `${id} was overturned. It stays overturned; the author records a new verdict instead.`);
      }
      const reviewId = insert("INSERT INTO reviews (verdict_id, result, note, reviewer, created_at) VALUES (?, ?, ?, ?, ?)",
        item.id, input.result, input.note, input.reviewer.trim(), stamp());
      return { id: formatId("review", reviewId), claim: formatId("claim", item.claim_id), status: claimStatus(item.claim_id) };
    },

    addIdea(input: { projectId: number; title: string; pitch: string; claimIds: readonly number[]; revisesId?: number }) {
      project(input.projectId);
      if (!input.claimIds.length) throw new CliError("USAGE", "An idea rests on at least one claim. Pass --claim for each.", 2);
      for (const id of input.claimIds) {
        if (claim(id).project_id !== input.projectId) throw new CliError("WRONG_PROJECT", `${formatId("claim", id)} belongs to another project.`);
        requireActive("claim", id);
      }
      if (input.revisesId !== undefined && idea(input.revisesId).project_id !== input.projectId) {
        throw new CliError("WRONG_PROJECT", `${formatId("idea", input.revisesId)} belongs to another project.`);
      }
      const id = insert("INSERT INTO ideas (project_id, title, pitch, revises_id, created_at) VALUES (?, ?, ?, ?, ?)",
        input.projectId, input.title, input.pitch, input.revisesId ?? null, stamp());
      for (const claimId of new Set(input.claimIds)) insert("INSERT INTO idea_claims (idea_id, claim_id) VALUES (?, ?)", id, claimId);
      const statuses = [...new Set(input.claimIds)].map(claimId => claimStatus(claimId));
      return { id: formatId("idea", id), status: ideaStatus(id, statuses) };
    },

    /** Withdraw a mistaken entry. It stays in the record, marked with the reason. */
    retract(entity: Retractable, id: number, reason: string) {
      row(entity, `${entity}s`, id);
      if (retraction(entity, id)) throw new CliError("NO_CHANGE", `${formatId(entity, id)} is already retracted.`);
      const retractionId = insert("INSERT INTO retractions (entity, target_id, reason, created_at) VALUES (?, ?, ?, ?)", entity, id, reason, stamp());
      return { id: formatId("retraction", retractionId), retracted: formatId(entity, id) };
    },

    show,
    showForReview,

    /**
     * Everything about a project, with each source's full text and hash and each quote's span in
     * that text, so the export alone is enough to check every quote.
     */
    exportProject(projectId: number) {
      const record = show(projectId);
      return {
        ...record,
        quotes: record.quotes.map(view => {
          const saved = quote(parseId("quote", view.id));
          return { ...view, span: [saved.span_start, saved.span_end] };
        }),
        sources: record.sources.map(view => {
          const saved = source(parseId("source", view.id));
          return { ...view, contentHash: saved.content_hash, text: saved.text };
        }),
        exportedAt: now().toISOString(),
      };
    },
  };
}
