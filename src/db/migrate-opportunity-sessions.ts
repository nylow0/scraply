// Keep legacy rows sessionless while new collection rounds can reuse names and ordinals.
export const OPPORTUNITY_SESSION_MIGRATION_SQL = `
  CREATE TABLE opportunity_coverage_gaps_v32 (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES opportunity_explorations(thread_id) ON DELETE CASCADE,
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
  INSERT INTO opportunity_coverage_gaps_v32 (
    id, thread_id, name, description, dimension, evidence_needed, search_query,
    map_exhausted, candidate_origin, status, created_at, updated_at
  ) SELECT id, thread_id, name, description, dimension, evidence_needed, search_query,
    map_exhausted, candidate_origin, status, created_at, updated_at
    FROM opportunity_coverage_gaps;
  DROP TABLE opportunity_coverage_gaps;
  ALTER TABLE opportunity_coverage_gaps_v32 RENAME TO opportunity_coverage_gaps;
  CREATE INDEX idx_opportunity_gaps_thread_status
    ON opportunity_coverage_gaps(thread_id, status, created_at, id);
  CREATE UNIQUE INDEX idx_opportunity_gaps_legacy_name
    ON opportunity_coverage_gaps(thread_id, name) WHERE session_id IS NULL;
  CREATE UNIQUE INDEX idx_opportunity_gaps_session_name
    ON opportunity_coverage_gaps(session_id, name) WHERE session_id IS NOT NULL;

  CREATE TABLE opportunity_exploration_batches_v32 (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES opportunity_explorations(thread_id) ON DELETE CASCADE,
    session_id TEXT,
    ordinal INTEGER NOT NULL CHECK(ordinal > 0),
    coverage_gap_id TEXT REFERENCES opportunity_coverage_gaps(id) ON DELETE RESTRICT,
    requested_candidates INTEGER NOT NULL CHECK(requested_candidates BETWEEN 1 AND 6),
    saved_candidate_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(saved_candidate_ids_json)),
    status TEXT NOT NULL CHECK(status IN (
      'planned', 'generating', 'awaiting-review', 'reviewing', 'reviewed', 'failed', 'unknown-dispatch'
    )),
    accepted_families_before INTEGER NOT NULL CHECK(accepted_families_before >= 0),
    accepted_families_after INTEGER CHECK(accepted_families_after >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(session_id, thread_id) REFERENCES workflow_sessions(id, thread_id) ON DELETE CASCADE
  );
  INSERT INTO opportunity_exploration_batches_v32 (
    id, thread_id, ordinal, coverage_gap_id, requested_candidates,
    saved_candidate_ids_json, status, accepted_families_before,
    accepted_families_after, created_at, updated_at
  ) SELECT id, thread_id, ordinal, coverage_gap_id, requested_candidates,
    saved_candidate_ids_json, status, accepted_families_before,
    accepted_families_after, created_at, updated_at
    FROM opportunity_exploration_batches;
  DROP TABLE opportunity_exploration_batches;
  ALTER TABLE opportunity_exploration_batches_v32 RENAME TO opportunity_exploration_batches;
  CREATE INDEX idx_opportunity_batches_thread_status
    ON opportunity_exploration_batches(thread_id, status, ordinal);
  CREATE UNIQUE INDEX idx_opportunity_batches_legacy_ordinal
    ON opportunity_exploration_batches(thread_id, ordinal) WHERE session_id IS NULL;
  CREATE UNIQUE INDEX idx_opportunity_batches_session_ordinal
    ON opportunity_exploration_batches(session_id, ordinal) WHERE session_id IS NOT NULL;
  CREATE TRIGGER validate_opportunity_batch_gap_insert
  BEFORE INSERT ON opportunity_exploration_batches WHEN NEW.coverage_gap_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM opportunity_coverage_gaps gap WHERE gap.id = NEW.coverage_gap_id
      AND gap.thread_id = NEW.thread_id AND gap.session_id IS NEW.session_id
  ) BEGIN SELECT RAISE(ABORT, 'batch gap must belong to its session'); END;
  CREATE TRIGGER validate_opportunity_batch_gap_update
  BEFORE UPDATE OF coverage_gap_id, session_id ON opportunity_exploration_batches
  WHEN NEW.coverage_gap_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM opportunity_coverage_gaps gap WHERE gap.id = NEW.coverage_gap_id
      AND gap.thread_id = NEW.thread_id AND gap.session_id IS NEW.session_id
  ) BEGIN SELECT RAISE(ABORT, 'batch gap must belong to its session'); END;

  CREATE TABLE opportunity_exploration_attempts_v32 (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES opportunity_explorations(thread_id) ON DELETE CASCADE,
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
  INSERT INTO opportunity_exploration_attempts_v32 (
    id, thread_id, stage_key, stage_name, status, input_json, model_json,
    prompt_version, prompt_text, result_json, error_message, prepared_at,
    dispatched_at, completed_at, updated_at, work_item_id
  ) SELECT id, thread_id, stage_key, stage_name, status, input_json, model_json,
    prompt_version, prompt_text, result_json, error_message, prepared_at,
    dispatched_at, completed_at, updated_at, work_item_id
    FROM opportunity_exploration_attempts;
  DROP TABLE opportunity_exploration_attempts;
  ALTER TABLE opportunity_exploration_attempts_v32 RENAME TO opportunity_exploration_attempts;
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

  ALTER TABLE opportunity_budget_extensions ADD COLUMN session_id TEXT
    REFERENCES workflow_sessions(id) ON DELETE SET NULL;
  CREATE INDEX idx_opportunity_budget_extensions_session
    ON opportunity_budget_extensions(session_id, created_at);
  CREATE TRIGGER validate_opportunity_extension_session_insert
  BEFORE INSERT ON opportunity_budget_extensions WHEN NEW.session_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM workflow_sessions ws WHERE ws.id = NEW.session_id AND ws.thread_id = NEW.thread_id
  ) BEGIN SELECT RAISE(ABORT, 'budget extension session must belong to its project'); END;
  CREATE TRIGGER validate_opportunity_extension_session_update
  BEFORE UPDATE OF session_id ON opportunity_budget_extensions WHEN NEW.session_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM workflow_sessions ws WHERE ws.id = NEW.session_id AND ws.thread_id = NEW.thread_id
  ) BEGIN SELECT RAISE(ABORT, 'budget extension session must belong to its project'); END;
`;
