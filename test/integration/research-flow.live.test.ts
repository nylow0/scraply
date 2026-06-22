import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startBackend } from "../../src/backend/server";
import { ThreadRepository } from "../../src/db/repositories/threads";
import { DEFAULT_RESEARCHERS, RunConfigSchema } from "../../src/shared/schemas";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/intake";

function loadEnvKeys(): { opencode: string; exa: string } | null {
  const envPath = join(process.cwd(), ".env");
  if (!existsSync(envPath)) return null;
  let opencode = "";
  let exa = "";
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key === "OPENCODE_API_KEY") opencode = value;
    if (key === "EXA_API_KEY") exa = value;
  }
  if (!opencode || !exa) return null;
  return { opencode, exa };
}

describe("research flow live", () => {
  test("validation passes and research starts with .env keys", async () => {
    const keys = loadEnvKeys();
    if (!keys) {
      console.warn("Skipping: .env keys not found");
      return;
    }

    const dir = mkdtempSync(join(tmpdir(), "scraply-research-"));
    const dbPath = join(dir, "scraply.db");
    const handle = await startBackend(
      {
        dataDir: dir,
        dbPath,
        getSecrets: () => ({ opencodeApiKey: keys.opencode, exaApiKey: keys.exa }),
      },
      () => {},
    );

    try {
      const headers = { authorization: `Bearer ${handle.token}`, "content-type": "application/json" };

      const validation = await fetch(`http://127.0.0.1:${handle.port}/validation`, { headers });
      const validationBody = await validation.json();
      expect(validationBody.setupComplete).toBe(true);

      const threadRes = await fetch(`http://127.0.0.1:${handle.port}/threads`, { method: "POST", headers, body: "{}" });
      const threadBody = await threadRes.json();
      const threadId = threadBody.thread.id as string;

      const db = new (await import("../../src/db/client")).DatabaseClient(dbPath);
      const threads = new ThreadRepository(db);
      threads.saveBrief(threadId, {
        projectName: "Test project",
        goal: "Find AI tool ideas",
        theme: "AI tools",
        description: "Testing research start",
        successDefinition: "Research runs",
        desiredOutput: "Ideas",
        successDecider: "Me",
        motivation: "Testing",
        finalDecision: "Pick one idea",
        constraints: [],
        resources: [],
        avoidList: [],
        researchNeeds: "Market landscape",
        deadline: "Flexible",
        availableEffort: "1 hour",
        ideaStylePreference: "Balanced",
        examples: "",
        scoringCriteria: "",
        anythingElse: "",
      }, true);
      threads.saveRunConfig(threadId, RunConfigSchema.parse(DEFAULT_RUN_CONFIG));
      db.close();

      const startRes = await fetch(`http://127.0.0.1:${handle.port}/research/start`, {
        method: "POST",
        headers,
        body: JSON.stringify({ threadId }),
      });
      const startBody = await startRes.json();
      if (!startRes.ok) {
        throw new Error(`Research start failed (${startRes.status}): ${startBody.error ?? JSON.stringify(startBody)}`);
      }
      expect(startBody.runId).toBeTruthy();
      expect(startBody.workspace.threads.find((t: { id: string }) => t.id === threadId)?.status).toBe("research-running");

      await new Promise((resolve) => setTimeout(resolve, 3000));
    } finally {
      await handle.close();
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows may keep WAL files locked briefly
      }
    }
  }, 60000);

  test("launch flow runs a minimal pipeline end to end and produces ideas", async () => {
    const keys = loadEnvKeys();
    if (!keys) {
      console.warn("Skipping: .env keys not found");
      return;
    }

    const dir = mkdtempSync(join(tmpdir(), "scraply-launch-"));
    const dbPath = join(dir, "scraply.db");
    const handle = await startBackend(
      {
        dataDir: dir,
        dbPath,
        getSecrets: () => ({ opencodeApiKey: keys.opencode, exaApiKey: keys.exa }),
      },
      () => {},
    );

    try {
      const headers = { authorization: `Bearer ${handle.token}`, "content-type": "application/json" };

      const threadRes = await fetch(`http://127.0.0.1:${handle.port}/threads`, { method: "POST", headers, body: "{}" });
      const threadId = (await threadRes.json()).thread.id as string;

      // Minimal config: one researcher, small counts — exercises the full OpenCode path cheaply.
      const config = RunConfigSchema.parse({
        ...DEFAULT_RUN_CONFIG,
        researchers: [{ ...DEFAULT_RESEARCHERS[0], enabled: true }],
        ideasRequested: 4,
        batchSize: 4,
        maxFollowUpRounds: 0,
        searchResultsPerStream: 3,
        parallelism: 1,
      });
      const brief = {
        projectName: "Solo founder dev tools",
        theme: "Developer tools for solo founders",
        description: "Looking for a small, buildable tool idea for indie developers.",
        desiredOutput: "A shortlist of strong ideas",
        successDefinition: "I pick one to build",
        finalDecision: "Choose one idea",
        constraints: [],
        resources: [],
        avoidList: [],
        researchNeeds: "Market gaps",
        deadline: "Flexible",
        availableEffort: "Weekends",
        ideaStylePreference: "Balanced",
      };

      const launchRes = await fetch(`http://127.0.0.1:${handle.port}/research/launch`, {
        method: "POST",
        headers,
        body: JSON.stringify({ threadId, brief, config }),
      });
      const launchBody = await launchRes.json();
      if (!launchRes.ok) {
        throw new Error(`Launch failed (${launchRes.status}): ${launchBody.error ?? JSON.stringify(launchBody)}`);
      }
      expect(launchBody.runId).toBeTruthy();

      // Poll until ideas are ready (the engine auto-generates them after synthesis).
      let status = "research-running";
      let ideaCount = 0;
      const deadline = Date.now() + 160000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 4000));
        const ws = await (await fetch(`http://127.0.0.1:${handle.port}/workspace`, { headers })).json();
        status = ws.threads.find((t: { id: string }) => t.id === threadId)?.status ?? status;
        ideaCount = ws.ideas?.length ?? 0;
        if (status === "ideas-ready" || (status === "research-complete" && ideaCount === 0)) break;
      }

      expect(status).toBe("ideas-ready");
      expect(ideaCount).toBeGreaterThan(0);
    } finally {
      await handle.close();
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows may keep WAL files locked briefly
      }
    }
  }, 200000);
});
