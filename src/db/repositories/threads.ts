import { randomUUID } from "node:crypto";
import type { Scope } from "../../shared/structured-output-schemas";
import {
  DEFAULT_RUN_CONFIG, MessageSchema, RunConfigSchema, ThreadSchema,
  type Message, type RunConfig, type Thread,
} from "../../shared/schemas";
import { AppError } from "../../shared/errors";
import type { DatabaseClient } from "../client";

export class ThreadRepository {
  constructor(private readonly db: DatabaseClient) {}

  listThreads(): Thread[] {
    return (this.db.db.prepare("SELECT * FROM threads ORDER BY updated_at DESC").all() as Array<Record<string, unknown>>)
      .map((row) => ThreadSchema.parse({ id: row.id, title: row.title, status: row.status, archivedAt: row.archived_at ?? null, createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  recoverStaleDevelopmentStatuses(): void {
    this.db.db.prepare(`
      UPDATE threads AS thread
      SET status = 'solutions-ready', updated_at = ?
      WHERE thread.status = 'development-running'
        AND NOT EXISTS (
          SELECT 1 FROM research_runs AS active
          WHERE active.thread_id = thread.id AND active.status IN ('queued', 'running')
        )
        AND EXISTS (
          SELECT 1 FROM research_runs AS completed
          WHERE completed.thread_id = thread.id AND completed.problem_id IS NOT NULL AND completed.status = 'completed'
        )
        AND NOT EXISTS (
          SELECT 1 FROM problems AS pending
          WHERE pending.selected_at IS NOT NULL
            AND pending.discovery_run_id = (
              SELECT discovery.id FROM research_runs AS discovery
              WHERE discovery.thread_id = thread.id AND discovery.problem_id IS NULL AND discovery.status = 'completed'
              ORDER BY discovery.created_at DESC, discovery.rowid DESC LIMIT 1
            )
            AND NOT EXISTS (SELECT 1 FROM research_runs AS started WHERE started.problem_id = pending.id)
        )
    `).run(new Date().toISOString());
  }

  pendingDevelopmentHandoffs(): Array<{ threadId: string; config: RunConfig }> {
    const rows = this.db.db.prepare(`
      WITH ranked_discovery AS (
        SELECT id, thread_id,
          ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY created_at DESC, rowid DESC) AS position
        FROM research_runs
        WHERE problem_id IS NULL AND status = 'completed'
      )
      SELECT thread.id AS thread_id, previous.config_json
      FROM threads AS thread
      JOIN ranked_discovery AS discovery ON discovery.thread_id = thread.id AND discovery.position = 1
      JOIN research_runs AS previous ON previous.id = (
        SELECT completed.id
        FROM research_runs AS completed
        JOIN problems AS completed_problem ON completed_problem.id = completed.problem_id
        WHERE completed.thread_id = thread.id AND completed.status = 'completed'
          AND completed_problem.discovery_run_id = discovery.id
        ORDER BY completed.created_at DESC, completed.rowid DESC LIMIT 1
      )
      WHERE thread.status = 'development-running'
        AND NOT EXISTS (
          SELECT 1 FROM research_runs AS active
          WHERE active.thread_id = thread.id AND active.status IN ('queued', 'running')
        )
        AND EXISTS (
          SELECT 1 FROM problems AS pending
          WHERE pending.discovery_run_id = discovery.id AND pending.selected_at IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM research_runs AS started WHERE started.problem_id = pending.id)
        )
        AND NOT EXISTS (
          SELECT 1 FROM problems AS unresolved
          WHERE unresolved.discovery_run_id = discovery.id AND unresolved.selected_at IS NOT NULL
            AND EXISTS (SELECT 1 FROM research_runs AS attempted WHERE attempted.problem_id = unresolved.id)
            AND NOT EXISTS (
              SELECT 1 FROM research_runs AS completed
              WHERE completed.problem_id = unresolved.id AND completed.status = 'completed'
            )
        )
      ORDER BY thread.created_at, thread.id
    `).all() as Array<{ thread_id: string; config_json: string }>;
    return rows.map((row) => ({
      threadId: row.thread_id,
      config: RunConfigSchema.parse(JSON.parse(row.config_json)),
    }));
  }

  createThread(title = "New research", config: RunConfig = DEFAULT_RUN_CONFIG): Thread {
    const now = new Date().toISOString();
    const thread = ThreadSchema.parse({ id: randomUUID(), title, status: "configuring", createdAt: now, updatedAt: now });
    this.db.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.db.prepare("INSERT INTO threads (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(thread.id, thread.title, thread.status, now, now);
      this.saveRunConfig(thread.id, config);
      this.db.db.exec("COMMIT");
      return thread;
    } catch (error) {
      this.db.db.exec("ROLLBACK");
      throw error;
    }
  }

  findEmptyDraft(): Thread | null {
    // A saved scope, message, run, or deliberate name makes this a separate project. Reuse an
    // untouched draft without deleting older entries or resetting its model preferences.
    const row = this.db.db.prepare(`
      SELECT t.* FROM threads t
      WHERE t.archived_at IS NULL AND t.status = 'configuring' AND t.title = 'New research'
        AND NOT EXISTS (SELECT 1 FROM settings s WHERE s.key = 'scope:' || t.id)
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id)
        AND NOT EXISTS (SELECT 1 FROM research_runs r WHERE r.thread_id = t.id)
      ORDER BY t.updated_at DESC, t.rowid DESC LIMIT 1
    `).get() as Record<string, unknown> | undefined;
    return row ? ThreadSchema.parse({
      id: row.id, title: row.title, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
    }) : null;
  }

  updateThreadStatus(threadId: string, status: Thread["status"]): void {
    this.db.db.prepare("UPDATE threads SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), threadId);
  }
  renameThread(threadId: string, title: string): void {
    this.db.db.prepare("UPDATE threads SET title = ?, updated_at = ? WHERE id = ?").run(title, new Date().toISOString(), threadId);
  }
  archiveThread(threadId: string, archived: boolean): void {
    this.db.db.prepare("UPDATE threads SET archived_at = ? WHERE id = ?")
      .run(archived ? new Date().toISOString() : null, threadId);
  }
  deleteThread(threadId: string): void { this.db.db.prepare("DELETE FROM threads WHERE id = ?").run(threadId); }

  addMessage(threadId: string, role: Message["role"], content: string, metadata?: Record<string, unknown>): Message {
    const message = MessageSchema.parse({ id: randomUUID(), threadId, role, content, ...(metadata ? { metadata } : {}), createdAt: new Date().toISOString() });
    this.db.db.prepare("INSERT INTO messages (id, thread_id, role, content, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(message.id, threadId, role, content, metadata ? JSON.stringify(metadata) : null, message.createdAt);
    return message;
  }
  getMessages(threadId: string): Message[] {
    return (this.db.db.prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at").all(threadId) as Array<Record<string, unknown>>)
      .map((row) => MessageSchema.parse({ id: row.id, threadId: row.thread_id, role: row.role, content: row.content,
        ...(row.metadata_json ? { metadata: JSON.parse(String(row.metadata_json)) } : {}), createdAt: row.created_at }));
  }

  saveScope(threadId: string, scope: Scope): void {
    const active = this.db.db.prepare(`SELECT id FROM research_runs WHERE thread_id = ? AND problem_id IS NULL AND status IN ('queued','running') LIMIT 1`)
      .get(threadId);
    if (active) throw new AppError("conflict", "The scope cannot change while discovery is running.");
    this.db.setSetting(`scope:${threadId}`, JSON.stringify(scope));
    this.renameThread(threadId, scope.title);
    this.updateThreadStatus(threadId, "configuring");
  }
  getScope(threadId: string): Scope | null {
    const value = this.db.getSetting(`scope:${threadId}`);
    if (!value) return null;
    const { ScopeSchema } = requireStructuredSchemas();
    return ScopeSchema.parse(JSON.parse(value));
  }

  saveRunConfig(threadId: string, config: RunConfig, presetName?: string): void {
    const parsed = RunConfigSchema.parse(config);
    this.db.db.prepare("INSERT INTO run_configs (id, thread_id, config_json, preset_name, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(randomUUID(), threadId, JSON.stringify(parsed), presetName ?? null, new Date().toISOString());
  }
  getLatestRunConfig(threadId: string): RunConfig | null {
    const row = this.db.db.prepare("SELECT config_json FROM run_configs WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(threadId) as { config_json: string } | undefined;
    return row ? RunConfigSchema.parse(JSON.parse(row.config_json)) : null;
  }
  listPresets(): Array<{ name: string; config: RunConfig }> {
    const rows = this.db.db.prepare("SELECT preset_name, config_json FROM run_configs WHERE preset_name IS NOT NULL ORDER BY created_at DESC")
      .all() as Array<{ preset_name: string; config_json: string }>;
    const seen = new Set<string>();
    return rows.flatMap((row) => {
      if (seen.has(row.preset_name)) return [];
      seen.add(row.preset_name);
      return [{ name: row.preset_name, config: RunConfigSchema.parse(JSON.parse(row.config_json)) }];
    });
  }
}

// Kept behind a tiny function to avoid a second copy of the schema while preserving ESM imports.
import { ScopeSchema } from "../../shared/structured-output-schemas";
function requireStructuredSchemas() { return { ScopeSchema }; }
