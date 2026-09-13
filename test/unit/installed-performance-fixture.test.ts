import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInstalledPerformanceFixture } from "../../scripts/create-installed-performance-fixture";
import { DatabaseClient } from "../../src/db/client";
import { RunConfigSchema } from "../../src/shared/schemas";
import { WorkflowV2DecisionAnalysisOutputSchema } from "../../src/shared/structured-output-schemas";

const directories: string[] = [];

async function removeDirectory(directory: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeDirectory));
});

describe("installed performance fixture", () => {
  test("creates current v2 results over a substantial, internally consistent saved history", () => {
    const directory = mkdtempSync(join(tmpdir(), "scraply-installed-performance-"));
    directories.push(directory);
    const fixture = createInstalledPerformanceFixture(join(directory, "fixture.db"));
    const client = new DatabaseClient(fixture.databasePath);

    try {
      expect(fixture.workflowCoverage).toBe("representative-v2");
      expect(fixture.expected).toEqual({ projects: 20, researchRuns: 100, sources: 1_000, solutions: 360 });
      expect(fixture.counts).toMatchObject({
        threads: 20,
        messages: 500,
        research_runs: 100,
        sources: 1_000,
        solutions: 360,
      });
      expect(client.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(client.db.prepare(`
        SELECT rr.workflow_version, COUNT(DISTINCT rr.id) AS run_count, COUNT(s.id) AS solution_count
        FROM research_runs rr
        LEFT JOIN solutions s ON s.research_run_id = rr.id
        GROUP BY rr.workflow_version
        ORDER BY rr.workflow_version
      `).all()).toEqual([
        { workflow_version: 1, run_count: 80, solution_count: 300 },
        { workflow_version: 2, run_count: 20, solution_count: 60 },
      ]);
      expect(client.db.prepare("SELECT COUNT(*) AS count FROM solutions WHERE selected_at IS NOT NULL").get())
        .toEqual({ count: 20 });
      expect(client.db.prepare("SELECT COUNT(*) AS count FROM stage_results WHERE stage_id = 'decision-analysis'").get())
        .toEqual({ count: 20 });

      const analyses = client.db.prepare(`
        SELECT da.analysis_json, s.selected_at, rr.workflow_version
        FROM decision_analyses da
        JOIN solutions s ON s.id = da.solution_id
        JOIN research_runs rr ON rr.id = da.research_run_id
      `).all() as Array<{ analysis_json: string; selected_at: string | null; workflow_version: number }>;
      expect(analyses).toHaveLength(20);
      for (const row of analyses) {
        expect(row.workflow_version).toBe(2);
        expect(row.selected_at).not.toBeNull();
        expect(WorkflowV2DecisionAnalysisOutputSchema.parse(JSON.parse(row.analysis_json)).consequences[0]?.description)
          .toContain("Synthetic v2 consequence");
      }

      const configs = client.db.prepare("SELECT workflow_version, config_json FROM research_runs").all() as Array<{
        workflow_version: 1 | 2;
        config_json: string;
      }>;
      for (const row of configs) {
        const config = RunConfigSchema.parse(JSON.parse(row.config_json));
        expect(config.workflowVersion).toBe(row.workflow_version);
        expect(config.model.providerId).toBe(row.workflow_version === 2 ? "openai-subscription" : "legacy-codex-cli");
      }
      const savedConfig = client.db.prepare("SELECT config_json FROM run_configs").get() as { config_json: string };
      expect(RunConfigSchema.parse(JSON.parse(savedConfig.config_json))).toMatchObject({
        workflowVersion: 2,
        model: { providerId: "openai-subscription" },
      });
    } finally {
      client.close();
    }
  }, 30_000);
});
