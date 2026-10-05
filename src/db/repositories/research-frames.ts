import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "../client";
import { canonicalJson } from "../../shared/content-identity";
import { parseResearchFrame, ResearchFrameSchema, type ResearchFrame } from "../../shared/research-frame";
import { SourceSchema, type Source } from "../../shared/schemas";

export interface SavedResearchFrame {
  id: string;
  threadId: string;
  version: number;
  knownProblem: boolean;
  draft: ResearchFrame;
  approved: ResearchFrame | null;
  sources: Source[];
  createdAt: string;
  approvedAt: string | null;
}

interface FrameRow {
  id: string; thread_id: string; version: number; known_problem: number;
  draft_json: string; approved_json: string | null; sources_json: string;
  created_at: string; approved_at: string | null;
}

/** Approval freezes a version. Later runs bind explicitly to the version they were started with. */
export class ResearchFrameRepository {
  constructor(private readonly client: DatabaseClient) {}

  get(id: string): SavedResearchFrame | null {
    const row = this.client.db.prepare("SELECT * FROM research_frames WHERE id = ?").get(id) as FrameRow | undefined;
    return row ? decodeFrame(row) : null;
  }

  forRun(runId: string): SavedResearchFrame | null {
    const row = this.client.db.prepare(`SELECT frame.* FROM research_frames frame
      JOIN research_runs run ON run.frame_id = frame.id WHERE run.id = ?`).get(runId) as FrameRow | undefined;
    return row ? decodeFrame(row) : null;
  }

  latestApproved(threadId: string): SavedResearchFrame | null {
    const row = this.client.db.prepare(`SELECT * FROM research_frames WHERE thread_id = ?
      AND approved_json IS NOT NULL ORDER BY version DESC LIMIT 1`).get(threadId) as FrameRow | undefined;
    return row ? decodeFrame(row) : null;
  }

  createDraft(input: { threadId: string; runId: string; frame: ResearchFrame; sources: Source[]; knownProblem: boolean }): SavedResearchFrame {
    validateFrame(input.frame, input.sources, input.knownProblem);
    return this.client.immediateTransaction(() => {
      const owner = this.client.db.prepare("SELECT frame_id FROM research_runs WHERE id = ? AND thread_id = ?")
        .get(input.runId, input.threadId) as { frame_id: string | null } | undefined;
      if (!owner) throw new Error("The research frame run does not belong to this project");
      if (owner.frame_id) throw new Error("A saved run cannot change its research frame");
      const version = this.client.db.prepare("SELECT coalesce(max(version), 0) + 1 AS version FROM research_frames WHERE thread_id = ?")
        .get(input.threadId) as { version: number };
      const id = randomUUID();
      this.client.db.prepare(`INSERT INTO research_frames
        (id, thread_id, version, known_problem, draft_json, sources_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, input.threadId, version.version, Number(input.knownProblem),
          canonicalJson(input.frame), canonicalJson(input.sources), new Date().toISOString());
      this.client.db.prepare("UPDATE research_runs SET frame_id = ? WHERE id = ?").run(id, input.runId);
      return this.get(id)!;
    });
  }

  approve(id: string, threadId: string, edited: ResearchFrame, options?: { transaction: "existing" }): SavedResearchFrame {
    const mutation = () => {
      const saved = this.get(id);
      if (!saved || saved.threadId !== threadId) throw new Error("The research frame does not belong to this project");
      validateFrame(edited, saved.sources, saved.knownProblem);
      if (saved.approved) {
        if (canonicalJson(edited) !== canonicalJson(saved.approved)) throw new Error("This frame has already been approved. Create a new version to edit it.");
        return saved;
      }
      this.client.db.prepare("UPDATE research_frames SET approved_json = ?, approved_at = ? WHERE id = ?")
        .run(canonicalJson(edited), new Date().toISOString(), id);
      return this.get(id)!;
    };
    if (options?.transaction === "existing") {
      this.client.requireImmediateTransaction();
      return mutation();
    }
    return this.client.immediateTransaction(mutation);
  }

  bindRun(runId: string, threadId: string, frameId: string): void {
    const frame = this.get(frameId);
    if (!frame?.approved || frame.threadId !== threadId) throw new Error("An approved frame for this project is required");
    const run = this.client.db.prepare("SELECT frame_id FROM research_runs WHERE id = ? AND thread_id = ?")
      .get(runId, threadId) as { frame_id: string | null } | undefined;
    if (!run) throw new Error("The research run does not belong to this project");
    if (run.frame_id && run.frame_id !== frameId) throw new Error("A saved run cannot change its research frame");
    this.client.db.prepare("UPDATE research_runs SET frame_id = ? WHERE id = ?").run(frameId, runId);
  }

  /** A project edit becomes the version for future runs; existing run bindings stay frozen. */
  createApprovedVersion(id: string, threadId: string, edited: ResearchFrame, options?: { transaction: "existing" }): SavedResearchFrame {
    const mutation = () => {
      const previous = this.get(id);
      if (!previous?.approved || previous.threadId !== threadId) throw new Error("An approved frame for this project is required");
      validateFrame(edited, previous.sources, previous.knownProblem);
      const next = this.client.db.prepare("SELECT coalesce(max(version), 0) + 1 AS version FROM research_frames WHERE thread_id = ?")
        .get(threadId) as { version: number };
      const nextId = randomUUID();
      const now = new Date().toISOString();
      this.client.db.prepare(`INSERT INTO research_frames
        (id, thread_id, version, known_problem, draft_json, approved_json, sources_json, created_at, approved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(nextId, threadId, next.version, Number(previous.knownProblem),
          canonicalJson(edited), canonicalJson(edited), canonicalJson(previous.sources), now, now);
      return this.get(nextId)!;
    };
    if (options?.transaction === "existing") {
      this.client.requireImmediateTransaction();
      return mutation();
    }
    return this.client.immediateTransaction(mutation);
  }
}

function validateFrame(frame: ResearchFrame, sources: readonly Source[], knownProblem: boolean): void {
  parseResearchFrame(frame, { sourceIds: sources.map((source) => source.id),
    purpose: knownProblem ? "known-problem" : "discovery" });
}

function decodeFrame(row: FrameRow): SavedResearchFrame {
  return {
    id: row.id, threadId: row.thread_id, version: row.version, knownProblem: Boolean(row.known_problem),
    draft: ResearchFrameSchema.parse(JSON.parse(row.draft_json)),
    approved: row.approved_json ? ResearchFrameSchema.parse(JSON.parse(row.approved_json)) : null,
    sources: SourceSchema.array().parse(JSON.parse(row.sources_json)), createdAt: row.created_at, approvedAt: row.approved_at,
  };
}
