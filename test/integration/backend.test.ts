import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseClient } from "../../src/db/client";
import { ThreadRepository } from "../../src/db/repositories/threads";
import { startBackend } from "../../src/backend/server";

const tempDirs: string[] = [];

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  while (tempDirs.length) {
    try {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    } catch {
      // Windows may keep WAL files locked briefly
    }
  }
});

describe("SQLite persistence", () => {
  test("survives restart with thread and meta probe", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-db-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "scraply.db");

    const db1 = new DatabaseClient(dbPath);
    db1.setMeta("persistence_probe", "phase0");
    const threads1 = new ThreadRepository(db1);
    const thread = threads1.createThread("Restart test");
    threads1.saveIntakeAnswer(thread.id, "goal", "Build a desktop research studio");
    db1.close();

    const db2 = new DatabaseClient(dbPath);
    expect(db2.getMeta("persistence_probe")).toBe("phase0");
    const threads2 = new ThreadRepository(db2);
    expect(threads2.listThreads()).toHaveLength(1);
    expect(threads2.getIntakeAnswers(thread.id)[0]?.answer).toContain("desktop research studio");
    db2.close();
  });
});

describe("Backend health", () => {
  test("starts on localhost with bearer auth", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-backend-"));
    tempDirs.push(dir);
    const handle = await startBackend({
      dataDir: dir,
      dbPath: join(dir, "scraply.db"),
      getSecrets: () => ({ opencodeApiKey: null, exaApiKey: null }),
    }, () => {});

    try {
      const unauthorized = await fetch(`http://127.0.0.1:${handle.port}/health`);
      expect(unauthorized.status).toBe(401);

      const health = await fetch(`http://127.0.0.1:${handle.port}/health`, {
        headers: { authorization: `Bearer ${handle.token}` },
      });
      expect(health.ok).toBe(true);
      const body = await health.json();
      expect(body.ok).toBe(true);
      expect(body.persistenceCheck).toStartWith("ok-");
    } finally {
      await handle.close();
    }
  });

  test("persists favorite models in workspace state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-backend-"));
    tempDirs.push(dir);
    const handle = await startBackend({
      dataDir: dir,
      dbPath: join(dir, "scraply.db"),
      getSecrets: () => ({ opencodeApiKey: null, exaApiKey: null }),
    }, () => {});

    try {
      const save = await fetch(`http://127.0.0.1:${handle.port}/models/favorite`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${handle.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: { provider: "codex", id: "gpt-5.5" }, favorite: true }),
      });
      expect(save.ok).toBe(true);

      const workspace = await fetch(`http://127.0.0.1:${handle.port}/workspace`, {
        headers: { authorization: `Bearer ${handle.token}` },
      });
      const body = await workspace.json() as { modelCatalog: { favorites: Array<{ provider: string; id: string }> } };
      expect(body.modelCatalog.favorites).toContainEqual({ provider: "codex", id: "gpt-5.5" });
    } finally {
      await handle.close();
    }
  });
});
