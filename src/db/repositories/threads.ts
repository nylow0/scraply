import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "../client";
import {
  MessageSchema,
  ProjectBriefSchema,
  RunConfigSchema,
  ThreadSchema,
  type Message,
  type ProjectBrief,
  type RunConfig,
  type Thread,
} from "../../shared/schemas";

export class ThreadRepository {
  constructor(private readonly db: DatabaseClient) {}

  listThreads(): Thread[] {
    const rows = this.db.db.prepare("SELECT * FROM threads ORDER BY updated_at DESC").all() as Array<Record<string, unknown>>;
    return rows.map((row) => ThreadSchema.parse({
      id: row.id,
      title: row.title,
      status: row.status,
      ...(row.parent_thread_id ? { parentThreadId: row.parent_thread_id } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  createThread(title = "New research"): Thread {
    const now = new Date().toISOString();
    const thread: Thread = {
      id: randomUUID(),
      title,
      status: "intake",
      createdAt: now,
      updatedAt: now,
    };
    this.db.db.prepare(`
      INSERT INTO threads (id, title, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(thread.id, thread.title, thread.status, thread.createdAt, thread.updatedAt);
    return thread;
  }

  updateThreadStatus(threadId: string, status: Thread["status"]): void {
    this.db.db.prepare("UPDATE threads SET status = ?, updated_at = ? WHERE id = ?").run(
      status,
      new Date().toISOString(),
      threadId,
    );
  }

  renameThread(threadId: string, title: string): void {
    this.db.db.prepare("UPDATE threads SET title = ?, updated_at = ? WHERE id = ?").run(
      title,
      new Date().toISOString(),
      threadId,
    );
  }

  deleteThread(threadId: string): void {
    this.db.db.prepare("DELETE FROM threads WHERE id = ?").run(threadId);
  }

  saveIntakeAnswer(threadId: string, questionId: string, answer: string, skipped = false): void {
    this.db.db.prepare(`
      INSERT INTO intake_answers (thread_id, question_id, answer, skipped, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(thread_id, question_id) DO UPDATE SET
        answer = excluded.answer,
        skipped = excluded.skipped,
        updated_at = excluded.updated_at
    `).run(threadId, questionId, answer, skipped ? 1 : 0, new Date().toISOString());
    this.db.db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), threadId);
  }

  getIntakeAnswers(threadId: string): Array<{ questionId: string; answer: string; skipped: boolean }> {
    const rows = this.db.db.prepare("SELECT * FROM intake_answers WHERE thread_id = ?").all(threadId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      questionId: String(row.question_id),
      answer: String(row.answer),
      skipped: Boolean(row.skipped),
    }));
  }

  addMessage(threadId: string, role: Message["role"], content: string, metadata?: Record<string, unknown>): Message {
    const message: Message = {
      id: randomUUID(),
      threadId,
      role,
      content,
      ...(metadata ? { metadata } : {}),
      createdAt: new Date().toISOString(),
    };
    this.db.db.prepare(`
      INSERT INTO messages (id, thread_id, role, content, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      message.id,
      message.threadId,
      message.role,
      message.content,
      metadata ? JSON.stringify(metadata) : null,
      message.createdAt,
    );
    return MessageSchema.parse(message);
  }

  getMessages(threadId: string): Message[] {
    const rows = this.db.db.prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC").all(threadId) as Array<Record<string, unknown>>;
    return rows.map((row) => MessageSchema.parse({
      id: row.id,
      threadId: row.thread_id,
      role: row.role,
      content: row.content,
      ...(row.metadata_json ? { metadata: JSON.parse(String(row.metadata_json)) } : {}),
      createdAt: row.created_at,
    }));
  }

  saveBrief(threadId: string, brief: ProjectBrief, confirmed: boolean): void {
    const versionRow = this.db.db.prepare("SELECT MAX(version) as v FROM briefs WHERE thread_id = ?").get(threadId) as { v: number | null };
    const version = (versionRow.v ?? 0) + 1;
    this.db.db.prepare(`
      INSERT INTO briefs (id, thread_id, version, brief_json, confirmed, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), threadId, version, JSON.stringify(brief), confirmed ? 1 : 0, new Date().toISOString());
    this.updateThreadStatus(threadId, confirmed ? "brief-confirmed" : "brief-draft");
  }

  getLatestBrief(threadId: string): ProjectBrief | null {
    const row = this.db.db.prepare(`
      SELECT brief_json FROM briefs WHERE thread_id = ? ORDER BY version DESC LIMIT 1
    `).get(threadId) as { brief_json: string } | undefined;
    return row ? ProjectBriefSchema.parse(JSON.parse(row.brief_json)) : null;
  }

  saveRunConfig(threadId: string, config: RunConfig, presetName?: string): void {
    this.db.db.prepare(`
      INSERT INTO run_configs (id, thread_id, config_json, preset_name, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(randomUUID(), threadId, JSON.stringify(config), presetName ?? null, new Date().toISOString());
    this.updateThreadStatus(threadId, "configuring");
  }

  getLatestRunConfig(threadId: string): RunConfig | null {
    const row = this.db.db.prepare(`
      SELECT config_json FROM run_configs WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(threadId) as { config_json: string } | undefined;
    return row ? RunConfigSchema.parse(JSON.parse(row.config_json)) : null;
  }

  listPresets(): Array<{ name: string; config: RunConfig }> {
    const rows = this.db.db.prepare(`
      SELECT preset_name, config_json FROM run_configs
      WHERE preset_name IS NOT NULL
      ORDER BY created_at DESC
    `).all() as Array<{ preset_name: string; config_json: string }>;
    const seen = new Set<string>();
    const presets: Array<{ name: string; config: RunConfig }> = [];
    for (const row of rows) {
      if (seen.has(row.preset_name)) continue;
      seen.add(row.preset_name);
      presets.push({ name: row.preset_name, config: RunConfigSchema.parse(JSON.parse(row.config_json)) });
    }
    return presets;
  }
}
