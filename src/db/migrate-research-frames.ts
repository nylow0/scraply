import type { DatabaseClient } from "./client";

export const RESEARCH_FRAMES_MIGRATION_SQL = `
  CREATE TABLE research_frames (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    version INTEGER NOT NULL CHECK(version > 0),
    known_problem INTEGER NOT NULL CHECK(known_problem IN (0, 1)),
    draft_json TEXT NOT NULL CHECK(json_valid(draft_json)),
    approved_json TEXT CHECK(approved_json IS NULL OR json_valid(approved_json)),
    sources_json TEXT NOT NULL CHECK(json_valid(sources_json)),
    created_at TEXT NOT NULL,
    approved_at TEXT,
    UNIQUE(thread_id, version),
    CHECK((approved_json IS NULL AND approved_at IS NULL)
      OR (approved_json IS NOT NULL AND approved_at IS NOT NULL))
  );
  CREATE INDEX idx_research_frames_project_version ON research_frames(thread_id, version DESC);
  ALTER TABLE research_runs ADD COLUMN frame_id TEXT REFERENCES research_frames(id);
  CREATE TRIGGER preserve_approved_research_frame BEFORE UPDATE ON research_frames
  WHEN OLD.approved_json IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'approved research frames are immutable'); END;
`;

/** Foreign keys are disabled by the migration runner while the parent table is replaced. */
export function addResearchStageIds(client: DatabaseClient): void {
  const row = client.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'stage_results'")
    .get() as { sql: string } | undefined;
  if (!row) throw new Error("Saved stage results table is missing");
  const stageIds = ["frame-search-plan", "frame", "area-ranking", "evidence-check", "area-gap"];
  const replacement = row.sql
    .replace(/^CREATE TABLE\s+["`\[]?stage_results["`\]]?/i, "CREATE TABLE stage_results_v38")
    .replace(/(stage_id\s+TEXT\s+NOT NULL\s+CHECK\s*\(stage_id\s+IN\s*\()([\s\S]*?)(\)\))/i,
      (_match: string, before: string, existing: string, after: string) =>
        `${before}${existing}, ${stageIds.map((id) => `'${id}'`).join(", ")}${after}`);
  if (replacement === row.sql || !replacement.includes("'frame-search-plan'")) {
    throw new Error("Saved stage results have an unsupported stage constraint");
  }
  client.db.exec(replacement);
  client.db.exec(`
    INSERT INTO stage_results_v38 SELECT * FROM stage_results;
    DROP TABLE stage_results;
    ALTER TABLE stage_results_v38 RENAME TO stage_results;
    CREATE INDEX idx_stage_results_run_completed ON stage_results(research_run_id, completed_at, stage_id);
    CREATE TRIGGER prevent_stage_result_update BEFORE UPDATE ON stage_results
    BEGIN SELECT RAISE(ABORT, 'completed stage results are immutable'); END;
  `);
}

export const RESEARCH_AREAS_MIGRATION_SQL = `
  ALTER TABLE factors ADD COLUMN area_id TEXT;
  ALTER TABLE problems ADD COLUMN area_id TEXT;
  CREATE INDEX idx_factors_run_area ON factors(research_run_id, area_id);
  CREATE INDEX idx_problems_run_area ON problems(discovery_run_id, area_id);
`;
