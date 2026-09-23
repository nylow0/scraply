import { migrateRiskEvaluationSnapshots } from "./migrate-risk-evaluations";
import { migrateSolutionLimit } from "./migrate-solution-limit";
import { FOCUSED_EXPERIMENT_MIGRATION_SQL, FOCUSED_DEMAND_TEST_MIGRATION_SQL } from "./repositories/focused-experiments";
import { OPPORTUNITY_REVIEW_MIGRATION_SQL } from "./repositories/opportunities";
import { OPPORTUNITY_EXPLORATION_MIGRATION_SQL } from "./repositories/opportunity-exploration";
import { OPPORTUNITY_SESSION_MIGRATION_SQL } from "./migrate-opportunity-sessions";
import { MANAGED_COVERAGE_MIGRATION_SQL } from "./migrate-managed-coverage";
import type { DatabaseClient } from "./client";

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
  {
    id: 7,
    sql: `
      CREATE TABLE scopes (
        id TEXT PRIMARY KEY,
        research_run_id TEXT NOT NULL UNIQUE REFERENCES research_runs(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        audience TEXT NOT NULL,
        domain TEXT NOT NULL,
        observations TEXT NOT NULL,
        off_limits_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE factors (
        id TEXT PRIMARY KEY,
        research_run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
        subject TEXT NOT NULL,
        behavior TEXT NOT NULL,
        quote TEXT NOT NULL,
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        harvest_mode TEXT NOT NULL CHECK(harvest_mode IN ('domain', 'audience')),
        model_confidence REAL NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE problems (
        id TEXT PRIMARY KEY,
        discovery_run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
        statement TEXT NOT NULL,
        why_it_persists TEXT NOT NULL,
        affected TEXT NOT NULL,
        scale_estimate TEXT NOT NULL,
        scale_basis_factor_id TEXT REFERENCES factors(id) ON DELETE SET NULL,
        verdict TEXT NOT NULL CHECK(verdict IN (
          'confirmed', 'overstated', 'already-solved', 'insufficient-evidence',
          'attempted-and-failed', 'user-asserted'
        )),
        verdict_reason TEXT NOT NULL,
        verdict_source_ids_json TEXT NOT NULL,
        selected_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE problem_factors (
        problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
        factor_id TEXT NOT NULL REFERENCES factors(id) ON DELETE CASCADE,
        PRIMARY KEY (problem_id, factor_id)
      );

      CREATE TABLE solutions (
        id TEXT PRIMARY KEY,
        problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
        mechanism TEXT NOT NULL,
        description TEXT NOT NULL,
        respects_off_limits INTEGER NOT NULL CHECK(respects_off_limits IN (0, 1)),
        respects_off_limits_why TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE outcomes (
        id TEXT PRIMARY KEY,
        solution_id TEXT NOT NULL REFERENCES solutions(id) ON DELETE CASCADE,
        description TEXT NOT NULL,
        direction TEXT NOT NULL CHECK(direction IN ('positive', 'negative')),
        affects TEXT NOT NULL,
        addresses_core INTEGER NOT NULL CHECK(addresses_core IN (0, 1)),
        created_at TEXT NOT NULL
      );

      CREATE TABLE risks (
        id TEXT PRIMARY KEY,
        solution_id TEXT NOT NULL REFERENCES solutions(id) ON DELETE CASCADE,
        description TEXT NOT NULL,
        likelihood TEXT NOT NULL CHECK(likelihood IN ('rare', 'possible', 'likely')),
        impact TEXT NOT NULL CHECK(impact IN ('≤3 days lost', '~2 weeks', '~2 months', 'project ends')),
        sort_key INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE mitigations (
        id TEXT PRIMARY KEY,
        solution_id TEXT NOT NULL REFERENCES solutions(id) ON DELETE CASCADE,
        approach TEXT NOT NULL,
        cost TEXT NOT NULL,
        fails_if TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE risk_mitigations (
        risk_id TEXT NOT NULL REFERENCES risks(id) ON DELETE CASCADE,
        mitigation_id TEXT NOT NULL REFERENCES mitigations(id) ON DELETE CASCADE,
        PRIMARY KEY (risk_id, mitigation_id)
      );

      ALTER TABLE research_runs
        ADD COLUMN problem_id TEXT REFERENCES problems(id) ON DELETE CASCADE;

      CREATE INDEX idx_factors_run ON factors(research_run_id, created_at);
      CREATE INDEX idx_problems_discovery_order ON problems(discovery_run_id, created_at, id);
      CREATE INDEX idx_problem_factors_factor ON problem_factors(factor_id);
      CREATE INDEX idx_solutions_problem ON solutions(problem_id, created_at);
      CREATE INDEX idx_outcomes_solution ON outcomes(solution_id, created_at);
      CREATE INDEX idx_risks_solution_sort ON risks(solution_id, sort_key DESC, created_at);
      CREATE INDEX idx_mitigations_solution ON mitigations(solution_id, created_at);
      CREATE INDEX idx_risk_mitigations_mitigation ON risk_mitigations(mitigation_id);
      CREATE INDEX idx_research_runs_problem ON research_runs(problem_id, created_at);
    `,
  },
  {
    id: 8,
    sql: `
      ALTER TABLE solutions
        ADD COLUMN research_run_id TEXT REFERENCES research_runs(id) ON DELETE CASCADE;

      UPDATE solutions
      SET research_run_id = (
        SELECT MIN(rr.id)
        FROM research_runs rr
        WHERE rr.problem_id = solutions.problem_id
      )
      WHERE (
        SELECT COUNT(*)
        FROM research_runs rr
        WHERE rr.problem_id = solutions.problem_id
      ) = 1;

      CREATE INDEX idx_solutions_run
        ON solutions(research_run_id, created_at, id);

      CREATE TRIGGER validate_solution_research_run_insert
      BEFORE INSERT ON solutions
      WHEN NEW.research_run_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM research_runs rr
        WHERE rr.id = NEW.research_run_id AND rr.problem_id = NEW.problem_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'solution research run must target its problem');
      END;

      CREATE TRIGGER validate_solution_research_run_update
      BEFORE UPDATE OF research_run_id, problem_id ON solutions
      WHEN NEW.research_run_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM research_runs rr
        WHERE rr.id = NEW.research_run_id AND rr.problem_id = NEW.problem_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'solution research run must target its problem');
      END;
    `,
  },
  {
    // Migration 8 was consumed by the Phase 2 persistence work. The destructive
    // cutover therefore has to be 9 for already-installed development databases.
    id: 9,
    sql: `
      PRAGMA defer_foreign_keys = ON;

      DELETE FROM messages WHERE role = 'report';
      DELETE FROM run_configs;

      ALTER TABLE sources DROP COLUMN originating_stream_run_id;
      ALTER TABLE research_runs DROP COLUMN brief_json;
      ALTER TABLE research_runs DROP COLUMN selected_stream_ids_json;
      ALTER TABLE research_runs DROP COLUMN round;

      DROP TABLE idea_claims;
      DROP TABLE claim_evidence;
      DROP TABLE idea_ratings;
      DROP TABLE rating_history;
      DROP TABLE ratings;
      DROP TABLE branch_contexts;
      DROP TABLE claims;
      DROP TABLE reports;
      DROP TABLE ideas;
      DROP TABLE stream_runs;
      DROP TABLE intake_answers;
      DROP TABLE briefs;

      DELETE FROM research_runs
      WHERE problem_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM scopes WHERE scopes.research_run_id = research_runs.id);

      ALTER TABLE threads DROP COLUMN parent_thread_id;

      UPDATE threads SET status = CASE
        WHEN status = 'archived' THEN 'archived'
        WHEN EXISTS (
          SELECT 1 FROM research_runs rr
          WHERE rr.thread_id = threads.id AND rr.status IN ('queued', 'running')
        ) THEN 'failed'
        ELSE 'configuring'
      END;
    `,
  },
  {
    id: 10,
    sql: `
      UPDATE run_configs
      SET config_json = json_set(config_json, '$.model', 'gpt-5.6-luna')
      WHERE json_extract(config_json, '$.model') = 'gpt-5.2-codex';
    `,
  },
  {
    id: 11,
    sql: `
      UPDATE run_configs
      SET config_json = json_set(config_json, '$.reasoningEffort', 'medium')
      WHERE json_extract(config_json, '$.reasoningEffort') IS NULL;

      UPDATE research_runs
      SET config_json = json_set(config_json, '$.reasoningEffort', 'medium')
      WHERE json_extract(config_json, '$.reasoningEffort') IS NULL;
    `,
  },
  {
    id: 12,
    sql: `
      CREATE UNIQUE INDEX idx_problems_id_discovery_run
        ON problems(id, discovery_run_id);
      CREATE UNIQUE INDEX idx_sources_id_research_run
        ON sources(id, research_run_id);

      CREATE TABLE problem_verdict_sources (
        problem_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        research_run_id TEXT NOT NULL,
        position INTEGER NOT NULL CHECK(position >= 0),
        PRIMARY KEY (problem_id, source_id),
        UNIQUE (problem_id, position),
        FOREIGN KEY (problem_id, research_run_id)
          REFERENCES problems(id, discovery_run_id) ON DELETE CASCADE,
        FOREIGN KEY (source_id, research_run_id)
          REFERENCES sources(id, research_run_id) ON DELETE CASCADE
      );

      INSERT INTO problem_verdict_sources (
        problem_id, source_id, research_run_id, position
      )
      SELECT p.id, s.id, p.discovery_run_id, MIN(CAST(verdict.key AS INTEGER))
      FROM problems p
      JOIN json_each(
        CASE WHEN json_valid(p.verdict_source_ids_json)
          THEN CASE WHEN json_type(p.verdict_source_ids_json) = 'array'
            THEN p.verdict_source_ids_json ELSE '[]' END
          ELSE '[]' END
      ) verdict
      JOIN sources s
        ON s.id = verdict.value AND s.research_run_id = p.discovery_run_id
      WHERE verdict.type = 'text'
      GROUP BY p.id, s.id, p.discovery_run_id;

      UPDATE problems SET verdict_source_ids_json = '[]';

      CREATE TRIGGER require_normalized_problem_verdict_sources_insert
      BEFORE INSERT ON problems
      WHEN NEW.verdict_source_ids_json <> '[]'
      BEGIN
        SELECT RAISE(ABORT, 'problem verdict sources must use problem_verdict_sources');
      END;

      CREATE TRIGGER require_normalized_problem_verdict_sources_update
      BEFORE UPDATE OF verdict_source_ids_json ON problems
      WHEN NEW.verdict_source_ids_json <> '[]'
      BEGIN
        SELECT RAISE(ABORT, 'problem verdict sources must use problem_verdict_sources');
      END;

      CREATE INDEX idx_problem_verdict_sources_run
        ON problem_verdict_sources(research_run_id, problem_id, position);
      CREATE INDEX idx_problem_verdict_sources_source
        ON problem_verdict_sources(source_id);
    `,
  },
  {
    id: 13,
    sql: `
      CREATE UNIQUE INDEX idx_research_runs_id_thread
        ON research_runs(id, thread_id);
      CREATE UNIQUE INDEX idx_research_runs_id_problem
        ON research_runs(id, problem_id);

      DROP TRIGGER IF EXISTS delete_job_events_for_run;
      DROP TRIGGER IF EXISTS delete_job_events_for_thread;

      CREATE TABLE normalized_job_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT REFERENCES research_runs(id) ON DELETE CASCADE,
        thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
        problem_id TEXT REFERENCES problems(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK(
          json_valid(payload_json) AND json_type(payload_json) = 'object'
        ),
        created_at TEXT NOT NULL,
        CHECK(run_id IS NULL OR thread_id IS NOT NULL),
        CHECK(problem_id IS NULL OR run_id IS NOT NULL),
        FOREIGN KEY (run_id, thread_id)
          REFERENCES research_runs(id, thread_id) ON DELETE CASCADE,
        FOREIGN KEY (run_id, problem_id)
          REFERENCES research_runs(id, problem_id) ON DELETE CASCADE
      );

      INSERT INTO normalized_job_events (
        id, run_id, thread_id, problem_id, type, payload_json, created_at
      )
      SELECT
        event.id,
        event.run_id,
        event.thread_id,
        CASE
          WHEN event.run_id IS NOT NULL
            AND json_valid(event.payload_json)
            AND json_type(event.payload_json) = 'object'
            AND json_type(event.payload_json, '$.problemId') = 'text'
            AND EXISTS (
              SELECT 1 FROM research_runs run
              WHERE run.id = event.run_id
                AND run.problem_id = json_extract(event.payload_json, '$.problemId')
            )
          THEN json_extract(event.payload_json, '$.problemId')
          ELSE NULL
        END,
        event.type,
        CASE
          WHEN json_valid(event.payload_json) AND json_type(event.payload_json) = 'object'
          THEN json_remove(event.payload_json, '$.runId', '$.threadId', '$.problemId')
          ELSE '{}'
        END,
        event.created_at
      FROM job_events event
      WHERE (event.run_id IS NULL OR EXISTS (
          SELECT 1 FROM research_runs run WHERE run.id = event.run_id
        ))
        AND (event.thread_id IS NULL OR EXISTS (
          SELECT 1 FROM threads thread WHERE thread.id = event.thread_id
        ))
        AND (event.run_id IS NULL OR event.thread_id IS NOT NULL)
        AND (event.run_id IS NULL OR EXISTS (
          SELECT 1 FROM research_runs run
          WHERE run.id = event.run_id AND run.thread_id = event.thread_id
        ));

      DROP TABLE job_events;
      ALTER TABLE normalized_job_events RENAME TO job_events;

      CREATE INDEX idx_job_events_run ON job_events(run_id, created_at);
      CREATE INDEX idx_job_events_thread ON job_events(thread_id, created_at);

      CREATE TRIGGER validate_job_event_entity_ids_insert
      BEFORE INSERT ON job_events
      WHEN (
        json_type(NEW.payload_json, '$.runId') IS NOT NULL
        AND (
          json_type(NEW.payload_json, '$.runId') <> 'text'
          OR json_extract(NEW.payload_json, '$.runId') IS NOT NEW.run_id
        )
      ) OR (
        json_type(NEW.payload_json, '$.threadId') IS NOT NULL
        AND (
          json_type(NEW.payload_json, '$.threadId') <> 'text'
          OR json_extract(NEW.payload_json, '$.threadId') IS NOT NEW.thread_id
        )
      ) OR (
        json_type(NEW.payload_json, '$.problemId') NOT IN ('null', 'text')
      ) OR (
        json_type(NEW.payload_json, '$.problemId') = 'text'
        AND (
          NEW.run_id IS NULL
          OR (NEW.problem_id IS NOT NULL
            AND NEW.problem_id IS NOT json_extract(NEW.payload_json, '$.problemId'))
          OR NOT EXISTS (
            SELECT 1 FROM research_runs run
            WHERE run.id = NEW.run_id
              AND run.problem_id = json_extract(NEW.payload_json, '$.problemId')
          )
        )
      )
      BEGIN
        SELECT RAISE(ABORT, 'job event payload entity IDs do not match relational columns');
      END;

      CREATE TRIGGER validate_job_event_entity_ids_update
      BEFORE UPDATE OF run_id, thread_id, problem_id, payload_json ON job_events
      WHEN (
        json_type(NEW.payload_json, '$.runId') IS NOT NULL
        AND (
          json_type(NEW.payload_json, '$.runId') <> 'text'
          OR json_extract(NEW.payload_json, '$.runId') IS NOT NEW.run_id
        )
      ) OR (
        json_type(NEW.payload_json, '$.threadId') IS NOT NULL
        AND (
          json_type(NEW.payload_json, '$.threadId') <> 'text'
          OR json_extract(NEW.payload_json, '$.threadId') IS NOT NEW.thread_id
        )
      ) OR (
        json_type(NEW.payload_json, '$.problemId') NOT IN ('null', 'text')
      ) OR (
        json_type(NEW.payload_json, '$.problemId') = 'text'
        AND (
          NEW.run_id IS NULL
          OR (NEW.problem_id IS NOT NULL
            AND NEW.problem_id IS NOT json_extract(NEW.payload_json, '$.problemId'))
          OR NOT EXISTS (
            SELECT 1 FROM research_runs run
            WHERE run.id = NEW.run_id
              AND run.problem_id = json_extract(NEW.payload_json, '$.problemId')
          )
        )
      )
      BEGIN
        SELECT RAISE(ABORT, 'job event payload entity IDs do not match relational columns');
      END;

      CREATE TRIGGER normalize_job_event_payload_insert
      AFTER INSERT ON job_events
      WHEN json_type(NEW.payload_json, '$.runId') IS NOT NULL
        OR json_type(NEW.payload_json, '$.threadId') IS NOT NULL
        OR json_type(NEW.payload_json, '$.problemId') IS NOT NULL
      BEGIN
        UPDATE job_events
        SET problem_id = CASE
              WHEN json_type(NEW.payload_json, '$.problemId') = 'text'
              THEN json_extract(NEW.payload_json, '$.problemId')
              ELSE NEW.problem_id
            END,
            payload_json = json_remove(
              NEW.payload_json, '$.runId', '$.threadId', '$.problemId'
            )
        WHERE id = NEW.id;
      END;

      CREATE TRIGGER normalize_job_event_payload_update
      AFTER UPDATE OF payload_json ON job_events
      WHEN json_type(NEW.payload_json, '$.runId') IS NOT NULL
        OR json_type(NEW.payload_json, '$.threadId') IS NOT NULL
        OR json_type(NEW.payload_json, '$.problemId') IS NOT NULL
      BEGIN
        UPDATE job_events
        SET problem_id = CASE
              WHEN json_type(NEW.payload_json, '$.problemId') = 'text'
              THEN json_extract(NEW.payload_json, '$.problemId')
              ELSE NEW.problem_id
            END,
            payload_json = json_remove(
              NEW.payload_json, '$.runId', '$.threadId', '$.problemId'
            )
        WHERE id = NEW.id;
      END;
    `,
  },
  {
    id: 14,
    sql: `
      CREATE TABLE rejected_problem_candidates (
        id TEXT PRIMARY KEY,
        discovery_run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
        statement TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX idx_rejected_problem_candidates_run
        ON rejected_problem_candidates(discovery_run_id, created_at, id);
    `,
  },
  {
    id: 15,
    sql: `
      UPDATE run_configs
      SET config_json = json_set(
        config_json,
        '$.configVersion', 2,
        '$.model', json_object(
          'providerId', 'legacy-codex-cli',
          'modelId', json_extract(config_json, '$.model')
        )
      )
      WHERE json_type(config_json, '$.model') = 'text';

      UPDATE research_runs
      SET config_json = json_set(
        config_json,
        '$.configVersion', 2,
        '$.model', json_object(
          'providerId', 'legacy-codex-cli',
          'modelId', json_extract(config_json, '$.model')
        )
      )
      WHERE json_type(config_json, '$.model') = 'text';

      UPDATE cost_ledger
      SET provider = 'legacy-codex-cli'
      WHERE provider = 'codex' AND operation = 'structured-completion';

      ALTER TABLE research_runs ADD COLUMN workflow_version INTEGER NOT NULL DEFAULT 1;

      CREATE TABLE generation_attempts (
        id TEXT PRIMARY KEY,
        generation_id TEXT NOT NULL UNIQUE,
        research_run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
        stage_key TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        reasoning_effort TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN (
          'prepared', 'dispatched', 'accepted', 'completed', 'failed', 'cancelled', 'interrupted'
        )),
        request_json TEXT NOT NULL CHECK(json_valid(request_json)),
        wire_request_sha256 TEXT NOT NULL,
        request_sha256 TEXT NOT NULL,
        work_order_sha256 TEXT NOT NULL,
        inputs_sha256 TEXT NOT NULL,
        evidence_sha256 TEXT NOT NULL,
        schema_sha256 TEXT NOT NULL,
        protocol_version TEXT,
        runtime_version TEXT,
        runtime_source_sha TEXT,
        runtime_executable_sha256 TEXT,
        runtime_prompt_id TEXT,
        runtime_prompt_sha256 TEXT,
        terminal_kind TEXT,
        output_json TEXT CHECK(output_json IS NULL OR json_valid(output_json)),
        error_code TEXT,
        error_message TEXT,
        attempt_metadata_json TEXT CHECK(
          attempt_metadata_json IS NULL OR json_valid(attempt_metadata_json)
        ),
        usage_json TEXT CHECK(usage_json IS NULL OR json_valid(usage_json)),
        reported_cost_usd REAL CHECK(reported_cost_usd IS NULL OR reported_cost_usd >= 0),
        accepted_at TEXT,
        terminal_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX idx_generation_attempts_run_stage
        ON generation_attempts(research_run_id, stage_key, created_at);
      CREATE INDEX idx_generation_attempts_status
        ON generation_attempts(status, updated_at);

      ALTER TABLE cost_ledger
        ADD COLUMN generation_attempt_id TEXT REFERENCES generation_attempts(id) ON DELETE SET NULL;
      CREATE UNIQUE INDEX idx_cost_ledger_generation_attempt
        ON cost_ledger(generation_attempt_id)
        WHERE generation_attempt_id IS NOT NULL;
    `,
  },
  {
    id: 16,
    sql: `
      ALTER TABLE solutions ADD COLUMN option_position INTEGER CHECK(
        option_position IS NULL OR option_position BETWEEN 0 AND 2
      );
      ALTER TABLE solutions ADD COLUMN key_assumption TEXT;
      ALTER TABLE solutions ADD COLUMN why_current_approach_may_suffice TEXT;
      ALTER TABLE solutions ADD COLUMN supporting_evidence_ids_json TEXT CHECK(
        supporting_evidence_ids_json IS NULL OR json_valid(supporting_evidence_ids_json)
      );
      ALTER TABLE solutions ADD COLUMN contrary_evidence_ids_json TEXT CHECK(
        contrary_evidence_ids_json IS NULL OR json_valid(contrary_evidence_ids_json)
      );
      ALTER TABLE solutions ADD COLUMN unknowns_json TEXT CHECK(
        unknowns_json IS NULL OR json_valid(unknowns_json)
      );
      ALTER TABLE solutions ADD COLUMN selected_at TEXT;

      CREATE UNIQUE INDEX idx_solutions_id_run
        ON solutions(id, research_run_id);
      CREATE UNIQUE INDEX idx_solutions_one_selected_per_run
        ON solutions(research_run_id)
        WHERE selected_at IS NOT NULL;

      CREATE TABLE stage_results (
        id TEXT PRIMARY KEY,
        research_run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
        stage_id TEXT NOT NULL CHECK(stage_id IN (
          'query-plan', 'factor-harvest', 'problem-candidates',
          'problem-kill', 'solutions', 'decision-analysis'
        )),
        selection_key TEXT NOT NULL DEFAULT '',
        workflow_version INTEGER NOT NULL CHECK(workflow_version = 2),
        stage_revision INTEGER NOT NULL CHECK(stage_revision > 0),
        context_json TEXT NOT NULL CHECK(json_valid(context_json)),
        context_sha256 TEXT NOT NULL,
        output_json TEXT NOT NULL CHECK(json_valid(output_json)),
        output_sha256 TEXT NOT NULL,
        prompt_filename TEXT NOT NULL,
        prompt_source TEXT NOT NULL CHECK(prompt_source IN ('bundled', 'override')),
        prompt_text TEXT NOT NULL,
        prompt_sha256 TEXT NOT NULL,
        current_bundled_prompt_sha256 TEXT NOT NULL,
        override_baseline_revision INTEGER,
        override_baseline_sha256 TEXT,
        schema_json TEXT NOT NULL CHECK(json_valid(schema_json)),
        schema_sha256 TEXT NOT NULL,
        input_json TEXT NOT NULL CHECK(json_valid(input_json)),
        input_sha256 TEXT NOT NULL,
        evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
        evidence_ids_json TEXT NOT NULL CHECK(json_valid(evidence_ids_json)),
        evidence_ids_sha256 TEXT NOT NULL,
        evidence_sha256 TEXT NOT NULL,
        runtime_prompt_id TEXT NOT NULL,
        runtime_prompt_sha256 TEXT NOT NULL,
        effective_request_json TEXT NOT NULL CHECK(json_valid(effective_request_json)),
        effective_request_sha256 TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        UNIQUE(research_run_id, stage_id, selection_key),
        CHECK(
          (override_baseline_revision IS NULL AND override_baseline_sha256 IS NULL)
          OR (override_baseline_revision = 1 AND override_baseline_sha256 IS NOT NULL)
        )
      );

      CREATE INDEX idx_stage_results_run_completed
        ON stage_results(research_run_id, completed_at, stage_id);

      CREATE TRIGGER prevent_stage_result_update
      BEFORE UPDATE ON stage_results
      BEGIN
        SELECT RAISE(ABORT, 'completed stage results are immutable');
      END;

      CREATE TABLE decision_analyses (
        id TEXT PRIMARY KEY,
        research_run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
        solution_id TEXT NOT NULL,
        stage_result_id TEXT NOT NULL UNIQUE REFERENCES stage_results(id) ON DELETE CASCADE,
        analysis_json TEXT NOT NULL CHECK(json_valid(analysis_json)),
        user_decision TEXT,
        observed_result TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(research_run_id, solution_id),
        FOREIGN KEY (solution_id, research_run_id)
          REFERENCES solutions(id, research_run_id) ON DELETE CASCADE
      );

      CREATE INDEX idx_decision_analyses_run_created
        ON decision_analyses(research_run_id, created_at, id);
    `,
  },
  {
    id: 17,
    sql: `
      CREATE TABLE workflow_snapshots (
        research_run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
        snapshot_key TEXT NOT NULL,
        value_json TEXT NOT NULL CHECK(json_valid(value_json)),
        PRIMARY KEY(research_run_id, snapshot_key)
      );
      ALTER TABLE research_runs ADD COLUMN awaiting_selection INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE research_runs ADD COLUMN interrupted INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: 18,
    sql: `
      ALTER TABLE factors ADD COLUMN uncertainty TEXT;

      CREATE TABLE evidence_follow_ups (
        research_run_id TEXT PRIMARY KEY REFERENCES research_runs(id) ON DELETE CASCADE,
        solution_id TEXT NOT NULL REFERENCES solutions(id) ON DELETE CASCADE,
        question TEXT NOT NULL CHECK(length(trim(question)) BETWEEN 1 AND 500),
        status TEXT NOT NULL CHECK(status IN ('requested', 'running', 'completed', 'failed')),
        source_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(source_ids_json)),
        factor_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(factor_ids_json)),
        error_message TEXT,
        requested_at TEXT NOT NULL,
        completed_at TEXT,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    id: 19,
    sql: `ALTER TABLE scopes ADD COLUMN risk_evaluation_criteria TEXT NOT NULL DEFAULT '';`,
  },
  {
    id: 20,
    // Rebuild both tables so dropping the old parent cannot cascade into saved analyses.
    sql: `
      CREATE TABLE stage_results_v20 (
        id TEXT PRIMARY KEY,
        research_run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
        stage_id TEXT NOT NULL CHECK(stage_id IN (
          'query-plan', 'factor-harvest', 'problem-candidates',
          'problem-kill', 'solutions', 'risk-evaluation', 'decision-analysis'
        )),
        selection_key TEXT NOT NULL DEFAULT '',
        workflow_version INTEGER NOT NULL CHECK(workflow_version = 2),
        stage_revision INTEGER NOT NULL CHECK(stage_revision > 0),
        context_json TEXT NOT NULL CHECK(json_valid(context_json)),
        context_sha256 TEXT NOT NULL,
        output_json TEXT NOT NULL CHECK(json_valid(output_json)),
        output_sha256 TEXT NOT NULL,
        prompt_filename TEXT NOT NULL,
        prompt_source TEXT NOT NULL CHECK(prompt_source IN ('bundled', 'override')),
        prompt_text TEXT NOT NULL,
        prompt_sha256 TEXT NOT NULL,
        current_bundled_prompt_sha256 TEXT NOT NULL,
        override_baseline_revision INTEGER,
        override_baseline_sha256 TEXT,
        schema_json TEXT NOT NULL CHECK(json_valid(schema_json)),
        schema_sha256 TEXT NOT NULL,
        input_json TEXT NOT NULL CHECK(json_valid(input_json)),
        input_sha256 TEXT NOT NULL,
        evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
        evidence_ids_json TEXT NOT NULL CHECK(json_valid(evidence_ids_json)),
        evidence_ids_sha256 TEXT NOT NULL,
        evidence_sha256 TEXT NOT NULL,
        runtime_prompt_id TEXT NOT NULL,
        runtime_prompt_sha256 TEXT NOT NULL,
        effective_request_json TEXT NOT NULL CHECK(json_valid(effective_request_json)),
        effective_request_sha256 TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        UNIQUE(research_run_id, stage_id, selection_key),
        CHECK(
          (override_baseline_revision IS NULL AND override_baseline_sha256 IS NULL)
          OR (override_baseline_revision = 1 AND override_baseline_sha256 IS NOT NULL)
        )
      );
      INSERT INTO stage_results_v20 SELECT * FROM stage_results;
      CREATE TABLE decision_analyses_v20 (
        id TEXT PRIMARY KEY,
        research_run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
        solution_id TEXT NOT NULL,
        stage_result_id TEXT NOT NULL UNIQUE REFERENCES stage_results_v20(id) ON DELETE CASCADE,
        analysis_json TEXT NOT NULL CHECK(json_valid(analysis_json)),
        user_decision TEXT,
        observed_result TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(research_run_id, solution_id),
        FOREIGN KEY (solution_id, research_run_id)
          REFERENCES solutions(id, research_run_id) ON DELETE CASCADE
      );
      INSERT INTO decision_analyses_v20 SELECT * FROM decision_analyses;
      DROP TABLE decision_analyses;
      DROP TABLE stage_results;
      ALTER TABLE stage_results_v20 RENAME TO stage_results;
      ALTER TABLE decision_analyses_v20 RENAME TO decision_analyses;
      CREATE INDEX idx_stage_results_run_completed
        ON stage_results(research_run_id, completed_at, stage_id);
      CREATE INDEX idx_decision_analyses_run_created
        ON decision_analyses(research_run_id, created_at, id);
      CREATE TRIGGER prevent_stage_result_update
      BEFORE UPDATE ON stage_results
      BEGIN
        SELECT RAISE(ABORT, 'completed stage results are immutable');
      END;
    `,
    afterSql: migrateRiskEvaluationSnapshots,
  },
  {
    id: 21,
    rebuildReferencedTable: true,
    sql: "",
    afterSql: migrateSolutionLimit,
  },
  { id: 22, sql: "ALTER TABLE threads ADD COLUMN archived_at TEXT;" },
  {
    id: 23,
    sql: `
      ALTER TABLE factors ADD COLUMN source_role TEXT NOT NULL DEFAULT 'unknown'
        CHECK(source_role IN ('firsthand', 'measured', 'vendor', 'recommendation', 'illustration', 'unknown'));
      ALTER TABLE factors ADD COLUMN audience_fit TEXT NOT NULL DEFAULT 'unknown'
        CHECK(audience_fit IN ('intended-buyer', 'adjacent', 'general', 'unknown'));
      ALTER TABLE factors ADD COLUMN independent_source_key TEXT;
      ALTER TABLE factors ADD COLUMN supports_demand INTEGER NOT NULL DEFAULT 0 CHECK(supports_demand IN (0, 1));
      ALTER TABLE factors ADD COLUMN demand_evidence_uncertainty TEXT;
      ALTER TABLE problems ADD COLUMN intended_buyer_evidence_factor_ids_json TEXT NOT NULL DEFAULT '[]'
        CHECK(json_valid(intended_buyer_evidence_factor_ids_json));
      ALTER TABLE problems ADD COLUMN evidence_gap TEXT;
    `,
  },
  {
    id: 24,
    sql: `ALTER TABLE solutions ADD COLUMN startup_opportunity_json TEXT CHECK(startup_opportunity_json IS NULL OR json_valid(startup_opportunity_json));`,
  },
  { id: 25, sql: `
    ALTER TABLE decision_analyses ADD COLUMN experiment_outcome TEXT NOT NULL DEFAULT 'not-run'
      CHECK(experiment_outcome IN ('not-run', 'pass', 'fail', 'inconclusive'));
    ALTER TABLE evidence_follow_ups ADD COLUMN reassessment_status TEXT
      CHECK(reassessment_status IN ('running', 'completed', 'failed'));
    ALTER TABLE evidence_follow_ups ADD COLUMN risk_reassessment_json TEXT CHECK(risk_reassessment_json IS NULL OR json_valid(risk_reassessment_json));
    ALTER TABLE evidence_follow_ups ADD COLUMN reassessment_analysis_json TEXT CHECK(reassessment_analysis_json IS NULL OR json_valid(reassessment_analysis_json));
    ALTER TABLE evidence_follow_ups ADD COLUMN risk_generation_id TEXT;
    ALTER TABLE evidence_follow_ups ADD COLUMN analysis_generation_id TEXT;
    ALTER TABLE evidence_follow_ups ADD COLUMN reassessment_error TEXT;
    ALTER TABLE evidence_follow_ups ADD COLUMN reassessed_at TEXT;
  ` },
  { id: 26, sql: FOCUSED_EXPERIMENT_MIGRATION_SQL },
  { id: 27, sql: OPPORTUNITY_REVIEW_MIGRATION_SQL },
  { id: 28, sql: OPPORTUNITY_EXPLORATION_MIGRATION_SQL },
  { id: 29, sql: FOCUSED_DEMAND_TEST_MIGRATION_SQL },
  {
    id: 30,
    sql: `
      CREATE TABLE workflow_sessions (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        purpose TEXT NOT NULL CHECK(purpose IN (
          'discovery', 'known-problem', 'research-followup', 'idea-turn'
        )),
        mode TEXT NOT NULL CHECK(mode IN ('babysit', 'vibe')),
        contract_json TEXT NOT NULL CHECK(json_valid(contract_json)),
        contract_sha256 TEXT NOT NULL CHECK(length(contract_sha256) = 64),
        state TEXT NOT NULL CHECK(state IN (
          'running', 'waiting-for-review', 'pause-requested', 'stop-requested', 'paused', 'finished'
        )),
        outcome TEXT CHECK(outcome IN (
          'target-met', 'partial', 'no-qualifying-ideas', 'failed', 'cancelled', 'needs-attention'
        )),
        revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
        active_snapshot_id TEXT REFERENCES evidence_snapshots(id) ON DELETE RESTRICT,
        remaining_ms INTEGER NOT NULL CHECK(remaining_ms >= 0),
        additional_model_calls INTEGER NOT NULL DEFAULT 0 CHECK(additional_model_calls >= 0),
        additional_searches INTEGER NOT NULL DEFAULT 0 CHECK(additional_searches >= 0),
        additional_minutes INTEGER NOT NULL DEFAULT 0 CHECK(additional_minutes >= 0),
        running_since TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        CHECK((state = 'finished') = (outcome IS NOT NULL)),
        CHECK((state = 'finished') = (finished_at IS NOT NULL)),
        CHECK((state IN ('running', 'pause-requested', 'stop-requested')) = (running_since IS NOT NULL)),
        UNIQUE(id, thread_id)
      );
      CREATE UNIQUE INDEX idx_workflow_sessions_one_unfinished
        ON workflow_sessions(thread_id) WHERE state != 'finished';
      CREATE INDEX idx_workflow_sessions_history
        ON workflow_sessions(thread_id, started_at DESC, id);
      CREATE TRIGGER prevent_workflow_session_contract_update
      BEFORE UPDATE OF thread_id, purpose, mode, contract_json, contract_sha256 ON workflow_sessions
      BEGIN SELECT RAISE(ABORT, 'workflow launch contract is immutable'); END;

      CREATE TABLE workflow_commands (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        client_command_id TEXT NOT NULL,
        payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256) = 64),
        result_json TEXT NOT NULL CHECK(json_valid(result_json)),
        created_at TEXT NOT NULL,
        UNIQUE(thread_id, client_command_id),
        FOREIGN KEY(session_id, thread_id)
          REFERENCES workflow_sessions(id, thread_id) ON DELETE CASCADE
      );
      CREATE INDEX idx_workflow_commands_session
        ON workflow_commands(session_id, created_at, id);
      CREATE TRIGGER prevent_workflow_command_update BEFORE UPDATE ON workflow_commands
      BEGIN SELECT RAISE(ABORT, 'workflow command receipts are immutable'); END;

      CREATE TABLE workflow_work_items (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES workflow_sessions(id) ON DELETE CASCADE,
        parent_item_id TEXT,
        kind TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
        dependencies_json TEXT NOT NULL CHECK(json_valid(dependencies_json)),
        input_json TEXT NOT NULL CHECK(json_valid(input_json)),
        input_sha256 TEXT NOT NULL CHECK(length(input_sha256) = 64),
        state TEXT NOT NULL CHECK(state IN (
          'planned', 'ready', 'running', 'succeeded', 'failed',
          'cancelled', 'skipped', 'unknown'
        )),
        output_refs_json TEXT CHECK(output_refs_json IS NULL OR json_valid(output_refs_json)),
        error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
        created_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE(session_id, scope_key),
        UNIQUE(id, session_id),
        FOREIGN KEY(parent_item_id, session_id)
          REFERENCES workflow_work_items(id, session_id) ON DELETE RESTRICT,
        CHECK(parent_item_id IS NULL OR parent_item_id != id),
        CHECK((state IN ('succeeded', 'failed', 'cancelled', 'skipped', 'unknown')) = (finished_at IS NOT NULL))
      );
      CREATE INDEX idx_workflow_work_items_session_state
        ON workflow_work_items(session_id, state, ordinal, id);
      CREATE TRIGGER prevent_workflow_work_item_input_update
      BEFORE UPDATE OF session_id, parent_item_id, kind, scope_key, ordinal,
        dependencies_json, input_json, input_sha256 ON workflow_work_items
      BEGIN SELECT RAISE(ABORT, 'admitted work item input is immutable'); END;

      CREATE TABLE workflow_budget_entries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES workflow_sessions(id) ON DELETE CASCADE,
        work_item_id TEXT NOT NULL,
        operation_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('model-call', 'search')),
        reserved_units INTEGER NOT NULL CHECK(reserved_units > 0),
        settled_units INTEGER CHECK(settled_units IS NULL OR settled_units BETWEEN 0 AND reserved_units),
        state TEXT NOT NULL CHECK(state IN ('reserved', 'spent', 'uncertain', 'released')),
        generation_attempt_id TEXT UNIQUE REFERENCES generation_attempts(id) ON DELETE RESTRICT,
        opportunity_attempt_id TEXT UNIQUE REFERENCES opportunity_exploration_attempts(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        settled_at TEXT,
        UNIQUE(session_id, operation_key),
        FOREIGN KEY(work_item_id, session_id)
          REFERENCES workflow_work_items(id, session_id) ON DELETE RESTRICT,
        CHECK(generation_attempt_id IS NULL OR opportunity_attempt_id IS NULL),
        CHECK((state = 'reserved') = (settled_at IS NULL)),
        CHECK((state = 'reserved') = (settled_units IS NULL))
      );
      CREATE INDEX idx_workflow_budget_entries_session
        ON workflow_budget_entries(session_id, state, kind);
      CREATE TRIGGER prevent_workflow_budget_reservation_update
      BEFORE UPDATE OF session_id, work_item_id, operation_key, kind, reserved_units ON workflow_budget_entries
      BEGIN SELECT RAISE(ABORT, 'budget reservation is immutable'); END;

      CREATE TABLE evidence_snapshots (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES workflow_sessions(id) ON DELETE CASCADE,
        parent_snapshot_id TEXT REFERENCES evidence_snapshots(id) ON DELETE RESTRICT,
        materialization_run_id TEXT NOT NULL UNIQUE,
        selection_json TEXT NOT NULL CHECK(json_valid(selection_json)),
        origin_map_json TEXT NOT NULL CHECK(json_valid(origin_map_json)),
        content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
        created_by_command_id TEXT REFERENCES workflow_commands(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        UNIQUE(id, session_id),
        CHECK(parent_snapshot_id IS NULL OR parent_snapshot_id != id)
      );
      CREATE INDEX idx_evidence_snapshots_session
        ON evidence_snapshots(session_id, created_at, id);
      CREATE TRIGGER prevent_evidence_snapshot_update BEFORE UPDATE ON evidence_snapshots
      BEGIN SELECT RAISE(ABORT, 'evidence snapshots are immutable'); END;
      CREATE TRIGGER validate_evidence_snapshot_insert BEFORE INSERT ON evidence_snapshots
      WHEN NOT EXISTS (
        SELECT 1 FROM research_runs rr
        JOIN workflow_sessions ws ON ws.id = NEW.session_id
        WHERE rr.id = NEW.materialization_run_id
          AND rr.thread_id = ws.thread_id
          AND rr.workflow_session_id = ws.id
      ) OR (NEW.parent_snapshot_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM evidence_snapshots parent
        JOIN workflow_sessions source_session ON source_session.id = parent.session_id
        JOIN workflow_sessions target_session ON target_session.id = NEW.session_id
        WHERE parent.id = NEW.parent_snapshot_id
          AND source_session.thread_id = target_session.thread_id
      )) OR (NEW.created_by_command_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workflow_commands wc
        WHERE wc.id = NEW.created_by_command_id AND wc.session_id = NEW.session_id
      ))
      BEGIN SELECT RAISE(ABORT, 'snapshot references must belong to its session'); END;
      CREATE TRIGGER validate_workflow_session_snapshot_update
      BEFORE UPDATE OF active_snapshot_id ON workflow_sessions
      WHEN NEW.active_snapshot_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM evidence_snapshots es
        WHERE es.id = NEW.active_snapshot_id AND es.session_id = NEW.id
      )
      BEGIN SELECT RAISE(ABORT, 'active snapshot must belong to its session'); END;

      CREATE TABLE idea_turns (
        id TEXT PRIMARY KEY,
        root_solution_id TEXT NOT NULL REFERENCES solutions(id) ON DELETE CASCADE,
        branch_id TEXT NOT NULL,
        branch_sequence INTEGER NOT NULL CHECK(branch_sequence > 0),
        parent_turn_id TEXT REFERENCES idea_turns(id) ON DELETE RESTRICT,
        base_solution_id TEXT NOT NULL REFERENCES solutions(id) ON DELETE RESTRICT,
        evidence_snapshot_id TEXT REFERENCES evidence_snapshots(id) ON DELETE RESTRICT,
        session_id TEXT NOT NULL REFERENCES workflow_sessions(id) ON DELETE CASCADE,
        client_message_id TEXT NOT NULL,
        intent TEXT NOT NULL CHECK(intent IN ('explain', 'explore-directions', 'rethink')),
        user_text TEXT NOT NULL,
        context_json TEXT NOT NULL CHECK(json_valid(context_json)),
        context_sha256 TEXT NOT NULL CHECK(length(context_sha256) = 64),
        state TEXT NOT NULL CHECK(state IN ('pending', 'completed', 'failed', 'unknown', 'cancelled')),
        assistant_json TEXT CHECK(assistant_json IS NULL OR json_valid(assistant_json)),
        stage_result_id TEXT UNIQUE REFERENCES stage_results(id) ON DELETE RESTRICT,
        generated_solution_id TEXT UNIQUE REFERENCES solutions(id) ON DELETE RESTRICT,
        error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
        created_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(root_solution_id, client_message_id),
        UNIQUE(branch_id, branch_sequence),
        CHECK((state = 'pending') = (completed_at IS NULL)),
        CHECK(state != 'completed' OR assistant_json IS NOT NULL)
      );
      CREATE INDEX idx_idea_turns_root_branch
        ON idea_turns(root_solution_id, branch_id, branch_sequence);
      CREATE TRIGGER prevent_completed_idea_turn_update
      BEFORE UPDATE ON idea_turns WHEN OLD.state != 'pending'
      BEGIN SELECT RAISE(ABORT, 'terminal idea turns are immutable'); END;
      CREATE TRIGGER prevent_idea_turn_input_update
      BEFORE UPDATE OF root_solution_id, branch_id, branch_sequence, parent_turn_id,
        base_solution_id, evidence_snapshot_id, session_id, client_message_id,
        intent, user_text, context_json, context_sha256 ON idea_turns
      BEGIN SELECT RAISE(ABORT, 'idea turn input is immutable'); END;

      CREATE TABLE solution_lineage (
        solution_id TEXT PRIMARY KEY REFERENCES solutions(id) ON DELETE CASCADE,
        root_solution_id TEXT NOT NULL REFERENCES solutions(id) ON DELETE RESTRICT,
        parent_solution_id TEXT REFERENCES solutions(id) ON DELETE RESTRICT,
        version_number INTEGER NOT NULL CHECK(version_number > 0),
        turn_id TEXT UNIQUE REFERENCES idea_turns(id) ON DELETE RESTRICT,
        evidence_snapshot_id TEXT REFERENCES evidence_snapshots(id) ON DELETE RESTRICT,
        change_summary TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(root_solution_id, version_number),
        CHECK((version_number = 1) = (parent_solution_id IS NULL)),
        CHECK((version_number = 1) = (turn_id IS NULL)),
        CHECK(version_number != 1 OR solution_id = root_solution_id),
        CHECK(parent_solution_id IS NULL OR parent_solution_id != solution_id)
      );
      CREATE INDEX idx_solution_lineage_root
        ON solution_lineage(root_solution_id, version_number);
      CREATE TRIGGER prevent_solution_lineage_update BEFORE UPDATE ON solution_lineage
      BEGIN SELECT RAISE(ABORT, 'solution lineage is immutable'); END;

      ALTER TABLE research_runs ADD COLUMN workflow_session_id TEXT
        REFERENCES workflow_sessions(id) ON DELETE SET NULL;
      ALTER TABLE research_runs ADD COLUMN purpose TEXT
        CHECK(purpose IS NULL OR purpose IN (
          'discovery', 'known-problem', 'idea-batch', 'research-followup',
          'idea-turn', 'materialization', 'research-materialization'
        ));
      ALTER TABLE research_runs ADD COLUMN evidence_snapshot_id TEXT
        REFERENCES evidence_snapshots(id) ON DELETE RESTRICT;
      CREATE INDEX idx_research_runs_workflow_session
        ON research_runs(workflow_session_id, created_at, id);
      CREATE TRIGGER validate_research_run_workflow_insert BEFORE INSERT ON research_runs
      WHEN (NEW.workflow_session_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workflow_sessions ws WHERE ws.id = NEW.workflow_session_id AND ws.thread_id = NEW.thread_id
      )) OR (NEW.evidence_snapshot_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM evidence_snapshots es JOIN workflow_sessions ws ON ws.id = es.session_id
        WHERE es.id = NEW.evidence_snapshot_id AND ws.thread_id = NEW.thread_id
      ))
      BEGIN SELECT RAISE(ABORT, 'research run workflow references must belong to its project'); END;
      CREATE TRIGGER validate_research_run_workflow_update
      BEFORE UPDATE OF workflow_session_id, evidence_snapshot_id, thread_id ON research_runs
      WHEN (NEW.workflow_session_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workflow_sessions ws WHERE ws.id = NEW.workflow_session_id AND ws.thread_id = NEW.thread_id
      )) OR (NEW.evidence_snapshot_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM evidence_snapshots es JOIN workflow_sessions ws ON ws.id = es.session_id
        WHERE es.id = NEW.evidence_snapshot_id AND ws.thread_id = NEW.thread_id
      ))
      BEGIN SELECT RAISE(ABORT, 'research run workflow references must belong to its project'); END;

      ALTER TABLE generation_attempts ADD COLUMN work_item_id TEXT
        REFERENCES workflow_work_items(id) ON DELETE SET NULL;
      ALTER TABLE opportunity_exploration_attempts ADD COLUMN work_item_id TEXT
        REFERENCES workflow_work_items(id) ON DELETE SET NULL;
      CREATE INDEX idx_generation_attempts_work_item ON generation_attempts(work_item_id);
      CREATE INDEX idx_opportunity_attempts_work_item ON opportunity_exploration_attempts(work_item_id);
      CREATE TRIGGER validate_generation_attempt_work_item_insert
      BEFORE INSERT ON generation_attempts WHEN NEW.work_item_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workflow_work_items wi JOIN research_runs rr ON rr.id = NEW.research_run_id
        WHERE wi.id = NEW.work_item_id AND wi.session_id = rr.workflow_session_id
      ) BEGIN SELECT RAISE(ABORT, 'generation attempt work item must belong to its run'); END;
      CREATE TRIGGER validate_generation_attempt_work_item_update
      BEFORE UPDATE OF work_item_id ON generation_attempts WHEN NEW.work_item_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workflow_work_items wi JOIN research_runs rr ON rr.id = NEW.research_run_id
        WHERE wi.id = NEW.work_item_id AND wi.session_id = rr.workflow_session_id
      ) BEGIN SELECT RAISE(ABORT, 'generation attempt work item must belong to its run'); END;
      CREATE TRIGGER validate_opportunity_attempt_work_item_insert
      BEFORE INSERT ON opportunity_exploration_attempts WHEN NEW.work_item_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workflow_work_items wi JOIN workflow_sessions ws ON ws.id = wi.session_id
        WHERE wi.id = NEW.work_item_id AND ws.thread_id = NEW.thread_id
      ) BEGIN SELECT RAISE(ABORT, 'opportunity attempt work item must belong to its project'); END;
      CREATE TRIGGER validate_opportunity_attempt_work_item_update
      BEFORE UPDATE OF work_item_id ON opportunity_exploration_attempts WHEN NEW.work_item_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workflow_work_items wi JOIN workflow_sessions ws ON ws.id = wi.session_id
        WHERE wi.id = NEW.work_item_id AND ws.thread_id = NEW.thread_id
      ) BEGIN SELECT RAISE(ABORT, 'opportunity attempt work item must belong to its project'); END;

      CREATE TABLE workflow_solution_preferences (
        root_solution_id TEXT PRIMARY KEY REFERENCES solutions(id) ON DELETE CASCADE,
        selected_solution_id TEXT NOT NULL REFERENCES solutions(id) ON DELETE RESTRICT,
        updated_at TEXT NOT NULL
      );
      CREATE TRIGGER validate_workflow_solution_preference_insert
      BEFORE INSERT ON workflow_solution_preferences WHEN NOT EXISTS (
        SELECT 1 FROM solution_lineage sl
        WHERE sl.root_solution_id = NEW.root_solution_id AND sl.solution_id = NEW.selected_solution_id
      ) BEGIN SELECT RAISE(ABORT, 'selected version must belong to its root'); END;
      CREATE TRIGGER validate_workflow_solution_preference_update
      BEFORE UPDATE OF selected_solution_id ON workflow_solution_preferences WHEN NOT EXISTS (
        SELECT 1 FROM solution_lineage sl
        WHERE sl.root_solution_id = NEW.root_solution_id AND sl.solution_id = NEW.selected_solution_id
      ) BEGIN SELECT RAISE(ABORT, 'selected version must belong to its root'); END;
    `,
  },
  {
    id: 31,
    sql: `
      CREATE TABLE stage_results_v31 (
        id TEXT PRIMARY KEY,
        research_run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
        stage_id TEXT NOT NULL CHECK(stage_id IN (
          'query-plan', 'factor-harvest', 'problem-candidates',
          'problem-kill', 'solutions', 'risk-evaluation', 'decision-analysis',
          'solution-set-review', 'idea-follow-up'
        )),
        selection_key TEXT NOT NULL DEFAULT '',
        workflow_version INTEGER NOT NULL CHECK(workflow_version = 2),
        stage_revision INTEGER NOT NULL CHECK(stage_revision > 0),
        context_json TEXT NOT NULL CHECK(json_valid(context_json)),
        context_sha256 TEXT NOT NULL,
        output_json TEXT NOT NULL CHECK(json_valid(output_json)),
        output_sha256 TEXT NOT NULL,
        prompt_filename TEXT NOT NULL,
        prompt_source TEXT NOT NULL CHECK(prompt_source IN ('bundled', 'override')),
        prompt_text TEXT NOT NULL,
        prompt_sha256 TEXT NOT NULL,
        current_bundled_prompt_sha256 TEXT NOT NULL,
        override_baseline_revision INTEGER,
        override_baseline_sha256 TEXT,
        schema_json TEXT NOT NULL CHECK(json_valid(schema_json)),
        schema_sha256 TEXT NOT NULL,
        input_json TEXT NOT NULL,
        input_sha256 TEXT NOT NULL,
        evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
        evidence_ids_json TEXT NOT NULL CHECK(json_valid(evidence_ids_json)),
        evidence_ids_sha256 TEXT NOT NULL,
        evidence_sha256 TEXT NOT NULL,
        runtime_prompt_id TEXT NOT NULL,
        runtime_prompt_sha256 TEXT NOT NULL,
        effective_request_json TEXT NOT NULL CHECK(json_valid(effective_request_json)),
        effective_request_sha256 TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        UNIQUE(research_run_id, stage_id, selection_key),
        CHECK(
          (override_baseline_revision IS NULL AND override_baseline_sha256 IS NULL)
          OR (override_baseline_revision = 1 AND override_baseline_sha256 IS NOT NULL)
        )
      );
      INSERT INTO stage_results_v31 SELECT * FROM stage_results;
      CREATE TABLE decision_analyses_v31 (
        id TEXT PRIMARY KEY,
        research_run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
        solution_id TEXT NOT NULL,
        stage_result_id TEXT NOT NULL UNIQUE REFERENCES stage_results_v31(id) ON DELETE CASCADE,
        analysis_json TEXT NOT NULL CHECK(json_valid(analysis_json)),
        user_decision TEXT,
        observed_result TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        experiment_outcome TEXT NOT NULL DEFAULT 'not-run'
          CHECK(experiment_outcome IN ('not-run', 'pass', 'fail', 'inconclusive')),
        UNIQUE(research_run_id, solution_id),
        FOREIGN KEY (solution_id, research_run_id)
          REFERENCES solutions(id, research_run_id) ON DELETE CASCADE
      );
      INSERT INTO decision_analyses_v31 SELECT * FROM decision_analyses;
      DROP TABLE decision_analyses;
      DROP TABLE stage_results;
      ALTER TABLE stage_results_v31 RENAME TO stage_results;
      ALTER TABLE decision_analyses_v31 RENAME TO decision_analyses;
      CREATE INDEX idx_stage_results_run_completed
        ON stage_results(research_run_id, completed_at, stage_id);
      CREATE INDEX idx_decision_analyses_run_created
        ON decision_analyses(research_run_id, created_at, id);
      CREATE TRIGGER prevent_stage_result_update
      BEFORE UPDATE ON stage_results
      BEGIN SELECT RAISE(ABORT, 'completed stage results are immutable'); END;
    `,
    afterSql: (client: DatabaseClient) => {
      if (client.db.prepare("PRAGMA foreign_key_check").all().length > 0) {
        throw new Error("Stage migration would break saved references");
      }
    },
  },
  { id: 32, rebuildReferencedTable: true, sql: OPPORTUNITY_SESSION_MIGRATION_SQL },
  {
    id: 33,
    sql: `
      ALTER TABLE problems ADD COLUMN brief_fit TEXT NOT NULL DEFAULT 'unknown'
        CHECK(brief_fit IN ('direct', 'partial', 'unknown', 'outside'));
      ALTER TABLE problems ADD COLUMN contrary_evidence TEXT NOT NULL DEFAULT 'unknown'
        CHECK(contrary_evidence IN ('resolved', 'unknown', 'unresolved'));
      ALTER TABLE problems ADD COLUMN workflow_key TEXT
        CHECK(workflow_key IS NULL OR (length(trim(workflow_key)) BETWEEN 1 AND 160));
    `,
  },
  { id: 34, rebuildReferencedTable: true, sql: MANAGED_COVERAGE_MIGRATION_SQL },
] as const;
