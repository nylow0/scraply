import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseClient } from "../src/db/client";
import { WorkflowV2DecisionAnalysisOutputSchema } from "../src/shared/structured-output-schemas";

const PROJECT_COUNT = 20;
const RUNS_PER_PROJECT = 5;
const SOURCES_PER_PROJECT = 50;
const DEVELOPMENT_RUNS_PER_PROJECT = RUNS_PER_PROJECT - 1;
const SOLUTIONS_PER_DEVELOPMENT_RUN = 5;
const V2_SOLUTIONS_PER_RUN = 3;
const FIXED_EPOCH_MS = Date.parse("2026-01-01T00:00:00.000Z");

function configJson(workflowVersion: 1 | 2): string {
  const providerId = workflowVersion === 2 ? "openai-subscription" : "legacy-codex-cli";
  return JSON.stringify({
    configVersion: 2, workflowVersion, model: { providerId, modelId: "gpt-5.6-luna" },
    reasoningEffort: "medium", discoveryDepth: "standard", maxRunMinutes: 90,
    searchProvider: "exa", researchMode: "explore-market", knownProblem: "",
  });
}

const LEGACY_CONFIG_JSON = configJson(1);
const CURRENT_CONFIG_JSON = configJson(2);

export interface InstalledPerformanceFixture {
  databasePath: string;
  databaseSha256: string;
  databaseBytes: number;
  schemaMigrationIds: number[];
  schemaVersion: number;
  synthetic: true;
  redacted: true;
  workflowCoverage: "representative-v2";
  counts: Record<string, number>;
  expected: {
    projects: number;
    researchRuns: number;
    sources: number;
    solutions: number;
  };
}

function id(kind: string, ...parts: number[]): string {
  return `${kind}-${parts.map((part) => String(part).padStart(3, "0")).join("-")}`;
}

function timestamp(sequence: number): string {
  return new Date(FIXED_EPOCH_MS + sequence * 1_000).toISOString();
}

function largeText(label: string, seed: number, targetLength = 4_096): string {
  const sentence = `${label} is deterministic synthetic benchmark material ${seed}. It contains no user data, credentials, provider output, or external content. `;
  return sentence.repeat(Math.ceil(targetLength / sentence.length)).slice(0, targetLength);
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function tableCount(client: DatabaseClient, table: string): number {
  const row = client.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

export function createInstalledPerformanceFixture(outputPath: string): InstalledPerformanceFixture {
  const databasePath = resolve(outputPath);
  mkdirSync(dirname(databasePath), { recursive: true });
  const existing = ["", "-wal", "-shm"].map((suffix) => `${databasePath}${suffix}`).filter(existsSync);
  if (existing.length > 0) throw new Error(`Refusing to overwrite existing fixture files: ${existing.join(", ")}`);

  const client = new DatabaseClient(databasePath);
  const db = client.db;
  let sequence = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    const insertThread = db.prepare("INSERT INTO threads (id, title, status, created_at, updated_at) VALUES (?, ?, 'solutions-ready', ?, ?)");
    const insertMessage = db.prepare("INSERT INTO messages (id, thread_id, role, content, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)");
    const insertRunConfig = db.prepare("INSERT INTO run_configs (id, thread_id, config_json, preset_name, created_at) VALUES (?, ?, ?, NULL, ?)");
    const insertRun = db.prepare(`
      INSERT INTO research_runs (
        id, thread_id, status, config_json, spend_estimate, cancelled, created_at, updated_at,
        idempotency_key, completion_reason, budget_limit, reserved_cost, committed_cost, problem_id,
        workflow_version
      ) VALUES (?, ?, 'completed', ?, 0, 0, ?, ?, ?, 'Synthetic benchmark run completed.', 0, 0, 0, ?, ?)
    `);
    const insertScope = db.prepare(`
      INSERT INTO scopes (
        id, research_run_id, title, audience, domain, observations, off_limits_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?)
    `);
    const insertSource = db.prepare(`
      INSERT INTO sources (
        id, research_run_id, provider_source_id, canonical_url, title, retrieved_text,
        author, published_at, content_hash, retrieved_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'Synthetic Fixture', ?, ?, ?)
    `);
    const insertFactor = db.prepare(`
      INSERT INTO factors (
        id, research_run_id, subject, behavior, quote, source_id, harvest_mode, model_confidence,
        uncertainty, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Synthetic v2 uncertainty retained for display.', ?)
    `);
    const insertProblem = db.prepare(`
      INSERT INTO problems (
        id, discovery_run_id, statement, why_it_persists, affected, scale_estimate,
        scale_basis_factor_id, verdict, verdict_reason, verdict_source_ids_json, selected_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, '[]', ?, ?)
    `);
    const insertProblemFactor = db.prepare("INSERT INTO problem_factors (problem_id, factor_id) VALUES (?, ?)");
    const insertVerdictSource = db.prepare(`
      INSERT INTO problem_verdict_sources (problem_id, source_id, research_run_id, position)
      VALUES (?, ?, ?, ?)
    `);
    const insertSolution = db.prepare(`
      INSERT INTO solutions (
        id, problem_id, mechanism, description, respects_off_limits,
        respects_off_limits_why, created_at, research_run_id, option_position,
        key_assumption, why_current_approach_may_suffice, unknowns_json,
        supporting_evidence_ids_json, contrary_evidence_ids_json, selected_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', ?)
    `);
    const insertOutcome = db.prepare(`
      INSERT INTO outcomes (id, solution_id, description, direction, affects, addresses_core, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertRisk = db.prepare(`
      INSERT INTO risks (id, solution_id, description, likelihood, impact, sort_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertMitigation = db.prepare(`
      INSERT INTO mitigations (id, solution_id, approach, cost, fails_if, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertRiskMitigation = db.prepare("INSERT INTO risk_mitigations (risk_id, mitigation_id) VALUES (?, ?)");
    const insertEvent = db.prepare(`
      INSERT INTO job_events (run_id, thread_id, problem_id, type, payload_json, created_at)
      VALUES (?, ?, ?, 'run-progress', ?, ?)
    `);
    const insertStage = db.prepare(`INSERT INTO stage_results (
      id, research_run_id, stage_id, selection_key, workflow_version, stage_revision,
      context_json, context_sha256, output_json, output_sha256, prompt_filename, prompt_source,
      prompt_text, prompt_sha256, current_bundled_prompt_sha256, schema_json, schema_sha256,
      input_json, input_sha256, evidence_json, evidence_ids_json, evidence_ids_sha256,
      evidence_sha256, runtime_prompt_id, runtime_prompt_sha256, effective_request_json,
      effective_request_sha256, completed_at
    ) VALUES (?, ?, 'decision-analysis', ?, 2, 1, ?, ?, ?, ?, 'decision-analysis.md', 'bundled',
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synthetic-runtime', ?, ?, ?, ?)`);
    const insertAnalysis = db.prepare(`INSERT INTO decision_analyses (
      id, research_run_id, solution_id, stage_result_id, analysis_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const emptyJson = "{}";
    const emptyArray = "[]";
    const emptyJsonDigest = digest(emptyJson);
    const promptText = "Synthetic deterministic performance fixture prompt. This fixture is not resume evidence.";
    const promptDigest = digest(promptText);
    const analysis = JSON.stringify(WorkflowV2DecisionAnalysisOutputSchema.parse({
      consequences: [{
        description: largeText("Synthetic v2 consequence", 1, 4_096), direction: "positive",
        affects: "Synthetic operators", rationale: largeText("Synthetic rationale", 1, 2_048),
      }],
      risks: [{
        riskId: "synthetic-v2-risk", description: largeText("Synthetic v2 risk", 1, 4_096),
        whyDecisive: largeText("Synthetic decisive rationale", 1, 2_048),
      }],
      proposedResponses: [{
        riskIds: ["synthetic-v2-risk"], approach: largeText("Synthetic proposed response", 1, 4_096), cost: "One synthetic hour",
        failsIf: "The deterministic fixture condition is false",
      }],
      unknowns: ["Synthetic unresolved question"],
      experiment: {
        question: "Does the synthetic mechanism pass?", method: "Inspect deterministic fixture rows", cost: "One synthetic hour",
        passCriterion: "All expected rows exist", failCriterion: "Any expected row is absent",
        inconclusiveCriterion: "The fixture cannot inspect every expected row",
      },
    }));
    const analysisDigest = digest(analysis);

    for (let project = 0; project < PROJECT_COUNT; project += 1) {
      const threadId = id("project", project);
      const projectTitle = `Synthetic project ${String(project + 1).padStart(2, "0")}`;
      const discoveryRunId = id("run", project, 0);
      const createdAt = timestamp(sequence++);
      insertThread.run(threadId, projectTitle, createdAt, timestamp(100_000 - project));
      insertRunConfig.run(id("config", project), threadId, CURRENT_CONFIG_JSON, createdAt);
      for (let message = 0; message < 25; message += 1) {
        const messageAt = timestamp(sequence++);
        insertMessage.run(
          id("message", project, message),
          threadId,
          message % 2 === 0 ? "user" : "assistant",
          largeText(`Synthetic message ${project}-${message}`, message, 2_048),
          JSON.stringify({ synthetic: true, sequence: message }),
          messageAt,
        );
      }
      const discoveryAt = timestamp(sequence++);
      insertRun.run(
        discoveryRunId,
        threadId,
        LEGACY_CONFIG_JSON,
        discoveryAt,
        discoveryAt,
        id("idempotency", project, 0),
        null,
        1,
      );
      insertScope.run(
        id("scope", project),
        discoveryRunId,
        projectTitle,
        `Synthetic audience ${project}`,
        "Deterministic local performance testing",
        largeText(`Synthetic project observation ${project}`, project, 4_096),
        discoveryAt,
        discoveryAt,
      );

      const sourceIds: string[] = [];
      const factorIds: string[] = [];
      for (let source = 0; source < SOURCES_PER_PROJECT; source += 1) {
        const sourceId = id("source", project, source);
        const sourceAt = timestamp(sequence++);
        const sourceText = largeText(`Synthetic source body ${project}-${source}`, source, 16_384);
        sourceIds.push(sourceId);
        insertSource.run(
          sourceId,
          discoveryRunId,
          id("provider-source", project, source),
          `https://fixture.invalid/projects/${project}/sources/${source}`,
          `Synthetic source ${project}-${source}`,
          sourceText,
          "2026-01-01",
          createHash("sha256").update(sourceText).digest("hex"),
          sourceAt,
        );
        if (source < 20) {
          const factorId = id("factor", project, source);
          factorIds.push(factorId);
          insertFactor.run(
            factorId,
            discoveryRunId,
            `Synthetic subject ${project}-${source}`,
            largeText(`Synthetic observed behavior ${project}-${source}`, source, 1_024),
            largeText(`Synthetic supporting quote ${project}-${source}`, source, 1_024),
            sourceId,
            source % 2 === 0 ? "domain" : "audience",
            0.9,
            sourceAt,
          );
        }
      }

      const problemIds: string[] = [];
      for (let problem = 0; problem < DEVELOPMENT_RUNS_PER_PROJECT; problem += 1) {
        const problemId = id("problem", project, problem);
        const problemAt = timestamp(sequence++);
        const factorId = factorIds[problem * 5]!;
        const sourceId = sourceIds[problem * 5]!;
        problemIds.push(problemId);
        insertProblem.run(
          problemId,
          discoveryRunId,
          `Synthetic problem ${project}-${problem}`,
          largeText(`Synthetic persistence analysis ${project}-${problem}`, problem, 4_096),
          largeText(`Synthetic affected group ${project}-${problem}`, problem, 2_048),
          largeText(`Synthetic scale estimate ${project}-${problem}`, problem, 2_048),
          factorId,
          largeText(`Synthetic verdict analysis ${project}-${problem}`, problem, 4_096),
          problemAt,
          problemAt,
        );
        for (let factorOffset = 0; factorOffset < 5; factorOffset += 1) {
          insertProblemFactor.run(problemId, factorIds[problem * 5 + factorOffset]!);
        }
        insertVerdictSource.run(problemId, sourceId, discoveryRunId, 0);
      }

      for (let development = 0; development < DEVELOPMENT_RUNS_PER_PROJECT; development += 1) {
        const developmentRunId = id("run", project, development + 1);
        const problemId = problemIds[development]!;
        const runAt = timestamp(sequence++);
        const currentWorkflow = development === DEVELOPMENT_RUNS_PER_PROJECT - 1;
        insertRun.run(
          developmentRunId,
          threadId,
          currentWorkflow ? CURRENT_CONFIG_JSON : LEGACY_CONFIG_JSON,
          runAt,
          runAt,
          id("idempotency", project, development + 1),
          problemId,
          currentWorkflow ? 2 : 1,
        );
        insertEvent.run(
          developmentRunId,
          threadId,
          problemId,
          JSON.stringify({ message: `Synthetic development run ${development + 1} complete.` }),
          runAt,
        );
        const solutionCount = currentWorkflow ? V2_SOLUTIONS_PER_RUN : SOLUTIONS_PER_DEVELOPMENT_RUN;
        for (let solution = 0; solution < solutionCount; solution += 1) {
          const solutionId = id("solution", project, development, solution);
          const solutionAt = timestamp(sequence++);
          insertSolution.run(
            solutionId,
            problemId,
            `Synthetic mechanism ${project}-${development}-${solution}`,
            largeText(`Synthetic solution analysis ${project}-${development}-${solution}`, solution, 8_192),
            largeText(`Synthetic scope analysis ${project}-${development}-${solution}`, solution, 4_096),
            solutionAt,
            developmentRunId,
            currentWorkflow ? solution : null,
            currentWorkflow ? "Synthetic v2 assumption" : null,
            currentWorkflow ? "Synthetic current approach may suffice" : null,
            currentWorkflow ? '["Synthetic uncertainty"]' : null,
            currentWorkflow && solution === 0 ? solutionAt : null,
          );
          for (let outcome = 0; outcome < 3; outcome += 1) {
            insertOutcome.run(
              id("outcome", project, development, solution, outcome),
              solutionId,
              largeText(`Synthetic outcome analysis ${project}-${development}-${solution}-${outcome}`, outcome, 4_096),
              outcome === 2 ? "negative" : "positive",
              largeText(`Synthetic affected outcome ${outcome}`, outcome, 2_048),
              outcome === 0 ? 1 : 0,
              solutionAt,
            );
          }
          for (let risk = 0; risk < 3; risk += 1) {
            const riskId = id("risk", project, development, solution, risk);
            const mitigationId = id("mitigation", project, development, solution, risk);
            insertRisk.run(
              riskId,
              solutionId,
              largeText(`Synthetic risk analysis ${project}-${development}-${solution}-${risk}`, risk, 4_096),
              risk === 0 ? "likely" : risk === 1 ? "possible" : "rare",
              risk === 0 ? "project ends" : risk === 1 ? "~2 months" : "≤3 days lost",
              3 - risk,
              solutionAt,
            );
            insertMitigation.run(
              mitigationId,
              solutionId,
              largeText(`Synthetic mitigation analysis ${project}-${development}-${solution}-${risk}`, risk, 4_096),
              largeText(`Synthetic mitigation cost ${risk}`, risk, 1_024),
              largeText(`Synthetic mitigation failure condition ${risk}`, risk, 1_024),
              solutionAt,
            );
            insertRiskMitigation.run(riskId, mitigationId);
          }
        }
        if (currentWorkflow) {
          const solutionId = id("solution", project, development, 0);
          const stageId = id("stage-v2", project);
          const completedAt = timestamp(200_000 + project);
          insertStage.run(stageId, developmentRunId, solutionId, emptyJson, emptyJsonDigest, analysis, analysisDigest,
            promptText, promptDigest, promptDigest, emptyJson, emptyJsonDigest, emptyJson, emptyJsonDigest,
            emptyJson, emptyArray, digest(emptyArray), emptyJsonDigest, emptyJsonDigest, emptyJson, emptyJsonDigest, completedAt);
          insertAnalysis.run(id("analysis-v2", project), developmentRunId, solutionId, stageId, analysis, completedAt, completedAt);
        }
      }
    }

    const activeThreadId = id("project", 0);
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('active_thread_id', ?, ?)")
      .run(activeThreadId, timestamp(sequence++));
    db.prepare("INSERT INTO app_meta (key, value, updated_at) VALUES ('installed_performance_fixture', ?, ?)")
      .run(JSON.stringify({ synthetic: true, redacted: true, projects: PROJECT_COUNT }), timestamp(sequence++));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    client.close();
    throw error;
  }

  const countTables = [
    "threads", "messages", "research_runs", "sources", "factors", "problems",
    "solutions", "outcomes", "risks", "mitigations", "job_events",
  ];
  const counts = Object.fromEntries(countTables.map((table) => [table, tableCount(client, table)]));
  const schemaMigrationIds = (db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as Array<{ id: number }>)
    .map((row) => row.id);
  const expected = {
    projects: PROJECT_COUNT,
    researchRuns: PROJECT_COUNT * RUNS_PER_PROJECT,
    sources: PROJECT_COUNT * SOURCES_PER_PROJECT,
    solutions: PROJECT_COUNT * (
      (DEVELOPMENT_RUNS_PER_PROJECT - 1) * SOLUTIONS_PER_DEVELOPMENT_RUN + V2_SOLUTIONS_PER_RUN
    ),
  };
  if (
    counts.threads !== expected.projects
    || counts.research_runs !== expected.researchRuns
    || counts.sources !== expected.sources
    || counts.solutions !== expected.solutions
  ) {
    client.close();
    throw new Error(`Synthetic fixture count mismatch: ${JSON.stringify({ counts, expected })}`);
  }
  db.prepare("UPDATE schema_migrations SET applied_at = ?").run(timestamp(0));
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  client.close();

  const manifest: InstalledPerformanceFixture = {
    databasePath,
    databaseSha256: sha256(databasePath),
    databaseBytes: statSync(databasePath).size,
    schemaMigrationIds,
    schemaVersion: Math.max(...schemaMigrationIds),
    synthetic: true,
    redacted: true,
    workflowCoverage: "representative-v2",
    counts,
    expected,
  };
  writeFileSync(`${databasePath}.json`, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

if (import.meta.main) {
  const outputPath = process.argv[2];
  if (!outputPath) throw new Error("Usage: bun scripts/create-installed-performance-fixture.ts <output.db>");
  console.log(JSON.stringify(createInstalledPerformanceFixture(outputPath), null, 2));
}
