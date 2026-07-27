export const MIGRATIONS = [
  {
    id: 1,
    sql: `
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        parent_thread_id TEXT REFERENCES threads(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS intake_answers (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        question_id TEXT NOT NULL,
        answer TEXT NOT NULL,
        skipped INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (thread_id, question_id)
      );

      CREATE TABLE IF NOT EXISTS briefs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        brief_json TEXT NOT NULL,
        confirmed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS run_configs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        config_json TEXT NOT NULL,
        preset_name TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS research_runs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        config_json TEXT NOT NULL,
        spend_estimate REAL NOT NULL DEFAULT 0,
        round INTEGER NOT NULL DEFAULT 0,
        cancelled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS stream_runs (
        id TEXT PRIMARY KEY,
        research_run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
        stream_id TEXT NOT NULL,
        round INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        coverage REAL,
        error TEXT,
        report_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        stream_id TEXT,
        title TEXT NOT NULL,
        html TEXT NOT NULL,
        published_url TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ideas (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        bucket TEXT NOT NULL,
        scores_json TEXT NOT NULL,
        supporting_claim_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ratings (
        idea_id TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
        rating INTEGER NOT NULL,
        notes TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (idea_id, created_at)
      );

      CREATE TABLE IF NOT EXISTS job_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT,
        thread_id TEXT,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_stream_runs_run ON stream_runs(research_run_id);
      CREATE INDEX IF NOT EXISTS idx_job_events_run ON job_events(run_id, created_at);
    `,
  },
  {
    id: 2,
    sql: `
      ALTER TABLE research_runs ADD COLUMN brief_json TEXT;
      ALTER TABLE research_runs ADD COLUMN idempotency_key TEXT;
      ALTER TABLE research_runs ADD COLUMN completion_reason TEXT;
      ALTER TABLE research_runs ADD COLUMN budget_limit REAL NOT NULL DEFAULT 0;
      ALTER TABLE research_runs ADD COLUMN reserved_cost REAL NOT NULL DEFAULT 0;
      ALTER TABLE research_runs ADD COLUMN committed_cost REAL NOT NULL DEFAULT 0;

      ALTER TABLE stream_runs ADD COLUMN lens TEXT;
      ALTER TABLE stream_runs ADD COLUMN planned_query TEXT;
      ALTER TABLE stream_runs ADD COLUMN gap_stop_reason TEXT;
      ALTER TABLE stream_runs ADD COLUMN provider_started_at TEXT;
      ALTER TABLE stream_runs ADD COLUMN provider_finished_at TEXT;

      ALTER TABLE reports ADD COLUMN research_run_id TEXT REFERENCES research_runs(id) ON DELETE CASCADE;
      ALTER TABLE reports ADD COLUMN stream_run_id TEXT REFERENCES stream_runs(id) ON DELETE CASCADE;
      ALTER TABLE reports ADD COLUMN report_kind TEXT NOT NULL DEFAULT 'stream';

      ALTER TABLE ideas ADD COLUMN research_run_id TEXT REFERENCES research_runs(id) ON DELETE CASCADE;
      ALTER TABLE ideas ADD COLUMN synthesis_report_id TEXT REFERENCES reports(id) ON DELETE SET NULL;
      ALTER TABLE ideas ADD COLUMN generation_mode TEXT NOT NULL DEFAULT 'complete';
      ALTER TABLE ideas ADD COLUMN preference_context_version INTEGER NOT NULL DEFAULT 1;

      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        research_run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
        originating_stream_run_id TEXT REFERENCES stream_runs(id) ON DELETE SET NULL,
        provider_source_id TEXT,
        canonical_url TEXT NOT NULL,
        title TEXT NOT NULL,
        retrieved_text TEXT NOT NULL,
        author TEXT,
        published_at TEXT,
        content_hash TEXT NOT NULL,
        retrieved_at TEXT NOT NULL,
        UNIQUE(research_run_id, canonical_url)
      );

      CREATE TABLE IF NOT EXISTS claims (
        id TEXT PRIMARY KEY,
        research_run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
        originating_stream_run_id TEXT REFERENCES stream_runs(id) ON DELETE SET NULL,
        text TEXT NOT NULL,
        confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
        validation_status TEXT NOT NULL,
        validation_reason TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS claim_evidence (
        claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        quote TEXT NOT NULL,
        source_location TEXT,
        evidence_quality REAL NOT NULL CHECK(evidence_quality >= 0 AND evidence_quality <= 1),
        PRIMARY KEY (claim_id, source_id, quote)
      );

      CREATE TABLE IF NOT EXISTS idea_claims (
        idea_id TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
        claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE RESTRICT,
        PRIMARY KEY (idea_id, claim_id)
      );

      CREATE TABLE IF NOT EXISTS idea_ratings (
        idea_id TEXT PRIMARY KEY REFERENCES ideas(id) ON DELETE CASCADE,
        rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
        notes TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rating_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idea_id TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
        rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
        notes TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cost_ledger (
        id TEXT PRIMARY KEY,
        research_run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
        operation TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT,
        reservation_usd REAL NOT NULL CHECK(reservation_usd >= 0),
        committed_usd REAL,
        status TEXT NOT NULL,
        usage_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_research_runs_idempotency
        ON research_runs(thread_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_research_runs_one_active
        ON research_runs(thread_id)
        WHERE status IN ('queued', 'running');
      CREATE INDEX IF NOT EXISTS idx_research_runs_thread_history
        ON research_runs(thread_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_stream_runs_history
        ON stream_runs(research_run_id, stream_id, round);
      CREATE INDEX IF NOT EXISTS idx_sources_run_url
        ON sources(research_run_id, canonical_url);
      CREATE INDEX IF NOT EXISTS idx_sources_run_hash
        ON sources(research_run_id, content_hash);
      CREATE INDEX IF NOT EXISTS idx_claims_run_validation
        ON claims(research_run_id, validation_status);
      CREATE INDEX IF NOT EXISTS idx_claim_evidence_source
        ON claim_evidence(source_id);
      CREATE INDEX IF NOT EXISTS idx_idea_claims_claim
        ON idea_claims(claim_id);
      CREATE INDEX IF NOT EXISTS idx_cost_ledger_run_status
        ON cost_ledger(research_run_id, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_reports_run_kind
        ON reports(research_run_id, report_kind, created_at);
      CREATE INDEX IF NOT EXISTS idx_job_events_thread
        ON job_events(thread_id, created_at);
    `,
  },
  {
    id: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS branch_contexts (
        thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
        parent_thread_id TEXT NOT NULL,
        seed_idea_id TEXT NOT NULL,
        seed_idea_title TEXT NOT NULL,
        exploration_angle TEXT NOT NULL,
        inherited_brief_json TEXT NOT NULL,
        inherited_brief_version INTEGER NOT NULL,
        selected_claim_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_branch_contexts_parent
        ON branch_contexts(parent_thread_id, created_at);
    `,
  },
  {
    id: 4,
    sql: `
      INSERT INTO rating_history (idea_id, rating, notes, created_at)
      SELECT r.idea_id, r.rating, r.notes, r.created_at
      FROM ratings r
      WHERE NOT EXISTS (
        SELECT 1
        FROM rating_history h
        WHERE h.idea_id = r.idea_id
          AND h.rating = r.rating
          AND h.notes IS r.notes
          AND h.created_at = r.created_at
      );

      INSERT INTO idea_ratings (idea_id, rating, notes, updated_at)
      SELECT r.idea_id, r.rating, r.notes, r.created_at
      FROM ratings r
      WHERE r.created_at = (
        SELECT MAX(latest.created_at)
        FROM ratings latest
        WHERE latest.idea_id = r.idea_id
      )
      ON CONFLICT(idea_id) DO UPDATE SET
        rating = excluded.rating,
        notes = excluded.notes,
        updated_at = excluded.updated_at
      WHERE excluded.updated_at > idea_ratings.updated_at;

      CREATE INDEX IF NOT EXISTS idx_rating_history_idea_created
        ON rating_history(idea_id, created_at DESC);
    `,
  },
  {
    id: 5,
    sql: `
      DELETE FROM job_events
      WHERE run_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM research_runs WHERE research_runs.id = job_events.run_id);

      DELETE FROM job_events
      WHERE thread_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM threads WHERE threads.id = job_events.thread_id);

      CREATE TRIGGER IF NOT EXISTS delete_job_events_for_run
      AFTER DELETE ON research_runs
      BEGIN
        DELETE FROM job_events WHERE run_id = OLD.id;
      END;

      CREATE TRIGGER IF NOT EXISTS delete_job_events_for_thread
      AFTER DELETE ON threads
      BEGIN
        DELETE FROM job_events WHERE thread_id = OLD.id;
      END;
    `,
  },
  {
    id: 6,
    sql: `
      ALTER TABLE research_runs ADD COLUMN selected_stream_ids_json TEXT;
    `,
  },
] as const;
