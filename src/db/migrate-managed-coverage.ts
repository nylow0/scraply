// Managed workflow sessions own their coverage map without starting a legacy exploration.
// Legacy sessionless rows retain their exploration parent and deletion behavior.
export const MANAGED_COVERAGE_MIGRATION_SQL = `
  CREATE TABLE opportunity_coverage_gaps_v34 (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    session_id TEXT,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    dimension TEXT NOT NULL CHECK(dimension IN ('buyer', 'workflow', 'trigger', 'problem', 'evidence')),
    evidence_needed TEXT,
    search_query TEXT,
    map_exhausted INTEGER NOT NULL CHECK(map_exhausted IN (0, 1)),
    candidate_origin TEXT NOT NULL CHECK(candidate_origin IN ('evidence-only', 'exploratory-allowed')),
    status TEXT NOT NULL CHECK(status IN ('named', 'search-needed', 'ready', 'covered', 'exhausted')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(session_id, thread_id) REFERENCES workflow_sessions(id, thread_id) ON DELETE CASCADE
  );
  INSERT INTO opportunity_coverage_gaps_v34 SELECT * FROM opportunity_coverage_gaps;
  DROP TABLE opportunity_coverage_gaps;
  ALTER TABLE opportunity_coverage_gaps_v34 RENAME TO opportunity_coverage_gaps;
  CREATE INDEX idx_opportunity_gaps_thread_status
    ON opportunity_coverage_gaps(thread_id, status, created_at, id);
  CREATE UNIQUE INDEX idx_opportunity_gaps_legacy_name
    ON opportunity_coverage_gaps(thread_id, name) WHERE session_id IS NULL;
  CREATE UNIQUE INDEX idx_opportunity_gaps_session_name
    ON opportunity_coverage_gaps(session_id, name) WHERE session_id IS NOT NULL;
  CREATE TRIGGER require_legacy_gap_exploration_insert BEFORE INSERT ON opportunity_coverage_gaps
  WHEN NEW.session_id IS NULL AND NOT EXISTS (
    SELECT 1 FROM opportunity_explorations WHERE thread_id = NEW.thread_id
  ) BEGIN SELECT RAISE(ABORT, 'legacy coverage gap requires exploration'); END;
  CREATE TRIGGER require_legacy_gap_exploration_update BEFORE UPDATE OF thread_id, session_id ON opportunity_coverage_gaps
  WHEN NEW.session_id IS NULL AND NOT EXISTS (
    SELECT 1 FROM opportunity_explorations WHERE thread_id = NEW.thread_id
  ) BEGIN SELECT RAISE(ABORT, 'legacy coverage gap requires exploration'); END;

  CREATE TABLE opportunity_exploration_attempts_v34 (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    session_id TEXT,
    stage_key TEXT NOT NULL,
    stage_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('prepared', 'dispatched', 'completed', 'failed', 'unknown-dispatch')),
    input_json TEXT NOT NULL CHECK(json_valid(input_json)),
    model_json TEXT NOT NULL CHECK(json_valid(model_json)),
    prompt_version TEXT NOT NULL,
    prompt_text TEXT NOT NULL,
    result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
    error_message TEXT,
    prepared_at TEXT NOT NULL,
    dispatched_at TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL,
    work_item_id TEXT REFERENCES workflow_work_items(id) ON DELETE SET NULL,
    FOREIGN KEY(session_id, thread_id) REFERENCES workflow_sessions(id, thread_id) ON DELETE CASCADE
  );
  INSERT INTO opportunity_exploration_attempts_v34 SELECT * FROM opportunity_exploration_attempts;
  DROP TABLE opportunity_exploration_attempts;
  ALTER TABLE opportunity_exploration_attempts_v34 RENAME TO opportunity_exploration_attempts;
  CREATE INDEX idx_opportunity_attempts_thread_status
    ON opportunity_exploration_attempts(thread_id, status, prepared_at);
  CREATE INDEX idx_opportunity_attempts_work_item
    ON opportunity_exploration_attempts(work_item_id);
  CREATE UNIQUE INDEX idx_opportunity_attempts_legacy_stage
    ON opportunity_exploration_attempts(thread_id, stage_key) WHERE session_id IS NULL;
  CREATE UNIQUE INDEX idx_opportunity_attempts_session_stage
    ON opportunity_exploration_attempts(session_id, stage_key) WHERE session_id IS NOT NULL;
  CREATE TRIGGER validate_opportunity_attempt_work_item_insert
  BEFORE INSERT ON opportunity_exploration_attempts WHEN NEW.work_item_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM workflow_work_items wi JOIN workflow_sessions ws ON ws.id = wi.session_id
    WHERE wi.id = NEW.work_item_id AND ws.thread_id = NEW.thread_id
      AND (NEW.session_id IS NULL OR wi.session_id = NEW.session_id)
  ) BEGIN SELECT RAISE(ABORT, 'opportunity attempt work item must belong to its session'); END;
  CREATE TRIGGER validate_opportunity_attempt_work_item_update
  BEFORE UPDATE OF work_item_id, session_id ON opportunity_exploration_attempts
  WHEN NEW.work_item_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM workflow_work_items wi JOIN workflow_sessions ws ON ws.id = wi.session_id
    WHERE wi.id = NEW.work_item_id AND ws.thread_id = NEW.thread_id
      AND (NEW.session_id IS NULL OR wi.session_id = NEW.session_id)
  ) BEGIN SELECT RAISE(ABORT, 'opportunity attempt work item must belong to its session'); END;
  CREATE TRIGGER require_legacy_attempt_exploration_insert BEFORE INSERT ON opportunity_exploration_attempts
  WHEN NEW.session_id IS NULL AND NOT EXISTS (
    SELECT 1 FROM opportunity_explorations WHERE thread_id = NEW.thread_id
  ) BEGIN SELECT RAISE(ABORT, 'legacy coverage attempt requires exploration'); END;
  CREATE TRIGGER require_legacy_attempt_exploration_update BEFORE UPDATE OF thread_id, session_id ON opportunity_exploration_attempts
  WHEN NEW.session_id IS NULL AND NOT EXISTS (
    SELECT 1 FROM opportunity_explorations WHERE thread_id = NEW.thread_id
  ) BEGIN SELECT RAISE(ABORT, 'legacy coverage attempt requires exploration'); END;

  CREATE TRIGGER cascade_legacy_coverage_on_exploration_delete BEFORE DELETE ON opportunity_explorations
  BEGIN
    DELETE FROM opportunity_exploration_batches WHERE thread_id = OLD.thread_id AND session_id IS NULL;
    DELETE FROM opportunity_coverage_gaps WHERE thread_id = OLD.thread_id AND session_id IS NULL;
    DELETE FROM opportunity_exploration_attempts WHERE thread_id = OLD.thread_id AND session_id IS NULL;
  END;
`;
