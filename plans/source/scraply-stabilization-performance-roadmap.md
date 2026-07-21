# Scraply Stabilization and Performance Roadmap

## Summary

Turn Scraply into a dependable personal Windows research application before adding more product surface. The roadmap keeps the current Electron architecture, upgrades the six research lenses into an adaptive evidence pipeline, fixes the security and cost-control failures found in the audit, and makes `dev → stage → master` a strict promotion path.

The release is successful when Scraply can safely complete this loop: review a brief, approve a bounded run, gather and persist source-backed claims, synthesize them, generate claim-linked ideas, rate an idea, and open a focused child branch—without duplicate spend, stale state, misleading completion, or remote-content access to Electron privileges.

## Locked Decisions

- Product: Electron-first, local-only, personal Windows application.
- Scope: full stabilization—security, correctness, research quality, cost controls, UX reliability, tests, and measurable runtime performance.
- Research: retain six canonical lenses, but plan targeted queries and follow-ups adaptively per lens.
- Research test model: route planning, extraction, coverage review, synthesis, and idea generation through Codex CLI using the explicit `gpt-5.6-luna` slug. Do not require or call OpenCode during this testing phase.
- Paid work: require brief/config review and enforce a conservative hard cap before every paid call.
- Ideas: require completed synthesis by default; an advanced override may use partial research only when the UI labels the result as partial.
- Data: current local records are test data and may be deleted; no legacy-data migration is required.
- Delivery: work on `dev`; promote the exact passing commit to `stage`; promote `stage` to `master` only after Dany explicitly approves it.

## Phase 0 — Reconcile the Repository Safely

1. Preserve the current dirty `master` work on a named safety branch and commit it without altering its contents. Tag the pre-stabilization state so it is always recoverable.
2. Merge that snapshot into `dev`, which retains the retired `main` branch's unique CI packaging commit. Do not move `stage` or `master` during development.
3. Treat `dev` as the only integration branch. Prohibit direct feature commits to `stage` and `master`.
4. Do not merge the existing `improve/*` branches wholesale. Most contain the large experimental `aa06d22` UI rewrite and are based before current `master`. Port and test only the useful focused changes:
   - OpenCode parsing and research resilience from `7577f4f` and `4efabb5`.
   - Lazy report loading from `41c702a`.
   - HTTP/IPC error handling from `66abf91` and `80c1f83`.
   - Critical-path tests from `8081a43`.
   - Module-boundary cleanup from standalone `adbbc70` after behavior is stable.
5. Keep `master` as the default and production branch. After the first approved `stage → master` promotion, archive the pre-stabilization `master` commit with a tag; do not recreate a `main` branch.

## Phase 1 — Close Security and Correctness Gaps

### Electron boundary

- Deny renderer-created windows and prevent every navigation away from Scraply's packaged renderer origin. Open validated `https:` report links through a narrow main-process `openExternalUrl` IPC method; reject credentials, non-HTTPS schemes, loopback URLs, and malformed URLs.
- Add a deny-by-default session permission handler and validate the sender frame/origin for every IPC handler.
- Remove `getBackend` from the preload API so renderer code never receives the backend bearer token.
- Keep `contextIsolation`, renderer sandboxing, Node integration disabled, and the restrictive CSP. Add automated checks for all of these invariants.
- Upgrade Electron to a currently supported patched version, rerun `bun audit`, and require zero known high-severity production advisories before stage promotion.

### Request and error contracts

- Parse every IPC and backend request with shared Zod schemas, including thread selection/deletion, idea generation/export, and branching.
- Make the main-process HTTP proxy throw a typed error for every non-2xx response. Preserve a safe error code and user-facing message; do not return raw provider or internal exception text.
- Map validation failures to `400`, missing entities to `404`, conflicts such as duplicate active runs to `409`, provider timeouts to `504`, and unexpected failures to `500`.
- Bound backend request bodies and report payloads. Use one shared response envelope for success and typed errors.
- Rebuild cached provider clients immediately when secrets change. If Windows secure storage is unavailable, show a blocking setup error instead of claiming secrets were persisted.
- In Codex test mode, setup is complete when Exa validates and the Codex CLI is authenticated, compatible, and can complete a small schema-constrained Luna probe. OpenCode credentials are optional and must not be validated in the background.

### Run state integrity

- Enforce one active research run per thread with a database constraint plus an idempotency key on the start request.
- A run is `completed` only when its required synthesis exists. Use explicit `partial`, `failed`, and `cancelled` states and preserve the reason.
- Associate every source, claim, report, synthesis, idea batch, and cost entry with a specific `research_run_id`; never infer current-run state from another report on the thread.
- Scope renderer events and progress to `runId` and `threadId`, persist them, and rehydrate progress after restart.

## Phase 2 — Replace the Test Schema with an Evidence Model

Delete the existing local SQLite database, WAL, and SHM files once during development and recreate the schema. The new schema must include:

- `research_runs`: immutable brief/config snapshots, status, idempotency key, timestamps, completion reason, budget limit, reserved cost, and committed cost.
- `stream_runs`: lens, round, planned query, status, coverage, gap/stop reason, and provider timing.
- `sources`: canonical URL, title, retrieved text or bounded excerpt, publication metadata, content hash, and retrieval timestamp.
- `claims`: atomic claim text, confidence, originating stream/run, and validation status.
- `claim_evidence`: claim/source link, exact supporting quote, source location when available, and evidence quality.
- `reports`: run and optional stream association, report kind, sanitized body, and creation timestamp.
- `ideas`: run, synthesis, generation mode (`complete` or `partial`), scores, and preference context version.
- `idea_claims`: many-to-many supporting-claim links; an evidence-informed idea must have at least one valid claim.
- `ratings`: one current user rating per idea plus optional append-only rating history.
- `cost_ledger`: provider operation, model, reservation, committed estimate/actual amount, status, and timestamps.

Keep foreign keys enabled, cascade only genuinely owned records, and add indexes for thread/run history, URL/content deduplication, run events, and idea evidence. Ensure thread deletion also removes related job events and stops an active run before deletion.

## Phase 3 — Build the Adaptive Six-Lens Engine

### Codex GPT-5.6 Luna test route

- Introduce a provider-neutral `StructuredModelClient` used by brief generation, query planning, claim extraction, coverage review, synthesis, and ideas. Move `extractClaims` orchestration out of `OpenCodeClient` so the research engine does not depend on an OpenCode-specific class.
- Add `workerProvider` to `RunConfig`; keep the existing orchestrator and idea provider fields. The testing defaults for all three roles are `provider: "codex"` and `model: "gpt-5.6-luna"`.
- Invoke Luna non-interactively with `codex exec -`, `--model gpt-5.6-luna`, `--sandbox read-only`, `--ephemeral`, `--output-schema`, `--output-last-message`, and an explicit `model_reasoning_effort="medium"` config override. Use the same prompts and strict Zod/JSON Schema contracts as other providers.
- Give every Codex call its own bounded temporary directory, clean it in `finally`, cap captured output, propagate cancellation, and report timeout/auth/rate-limit/schema errors as typed provider failures.
- Keep the OpenCode adapter available behind explicit provider selection, but exclude it from default configuration, setup requirements, automated live tests, and stage acceptance. Add a guard test that fails if Codex test mode sends any request to the OpenCode base URL.
- Establish the Luna baseline at medium effort. After correctness evals pass, compare low effort on extraction and classification only; adopt it per role only when schema validity, evidence accuracy, and completion rate remain within the accepted baseline.

### Planning and search

- Keep Landscape, Exemplars, Pain & Gaps, Resources, Analogies, and Evaluation as stable lenses.
- Before searching, give the planner the complete confirmed brief—not only its theme—and request 1–3 specific queries per relevant lens, expected evidence, and a stop criterion.
- Search with bounded concurrency. Deduplicate normalized URLs and content hashes across all lenses before extraction. Reuse results within a run rather than paying for the same source twice.
- Persist sources before claim extraction. Validate that every returned source ID exists and every evidence quote appears in the stored source text; reject or flag unsupported claims.
- Compute deterministic baseline coverage from valid claims, source diversity, and required brief questions. Use the coverage model only to identify gaps and prioritize follow-up queries.
- Follow up on the returned gap, not the original generic query. Stop a lens when its threshold is met, no new evidence is found, the round limit is reached, the user cancels, or the next operation cannot fit inside the budget.

### Synthesis and ideas

- Synthesize from persisted claim/evidence records with stable claim IDs. Include uncertainty, conflicting evidence, missing coverage, and the run's cost/completeness summary.
- Generate ideas from the confirmed brief, synthesis, selected high-quality claims, existing ideas, and preference history. Require the model to return supporting claim IDs and reject IDs outside the active run.
- Keep scoring axes independent. Derive evidence strength partly from linked evidence quality instead of accepting a model-only score.
- Block ordinary idea generation until synthesis completes. The advanced partial override must require explicit confirmation, stamp ideas as partial, and show the missing lenses/gaps.
- A child branch stores its parent thread, seed idea, chosen exploration angle, inherited brief snapshot, and selected claim IDs. Open a focused branch setup screen rather than restarting the full intake questionnaire.

### Hard budget and cancellation

- Implement a transactional cost ledger. Reserve a conservative upper-bound estimate before every paid operation: brief generation, query planning, Exa search, extraction, coverage review, follow-up, synthesis, and each idea batch.
- Reject an operation when the reservation would exceed `maxSpendUsd`. Commit actual usage when the provider reports it; otherwise commit the configured conservative estimate and release only unused known reservation.
- Codex CLI subscription usage does not expose a reliable per-call dollar charge to Scraply, so do not present its usage as actual USD. In Luna test mode, enforce hard limits for Codex call count, Exa search count/estimated spend, follow-up rounds, and wall-clock run time; show each limit separately in the approval screen. `maxSpendUsd` remains a hard cap only for providers with accountable monetary usage.
- Persist reservations immediately. After interruption, count uncertain in-flight reservations as spent until reconciled; never reset resumed-run spending to zero.
- Use one `AbortController` per run and pass its signal through provider clients. Cancellation stops scheduling immediately, aborts active search/model requests, prevents late report writes, and settles ledger entries consistently.
- Default timeouts: 10 seconds for validation, 30 seconds for search, and 120 seconds for model work. Timeouts are typed failures eligible for bounded retry only when idempotent.

## Phase 4 — Make the App Fast and Predictable

- Split workspace loading into lightweight summaries and on-demand detail calls. Do not clone or send report HTML, full source text, or long event history during routine refreshes.
- Fetch a report only when expanded; paginate messages, ideas, sources, and events. Cache immutable report/source detail by ID.
- Replace overlapping full refreshes with run-scoped event updates and one debounced reconciliation fetch after bursts.
- Validate provider credentials on setup, secret change, manual refresh, and a bounded TTL—not on every workspace refresh or stream event. A normal app session should perform no redundant Exa validation searches.
- Reuse provider clients, HTTP connections, and deduplicated source results safely. Bound stdout/stderr collection and always remove Codex temporary directories in `finally`.
- Bundle default prompts in packaged resources and copy editable overrides into user data. Stop relying on `process.cwd()` so development and installed behavior match.
- Resolve the three Svelte reactivity warnings and add `svelte-check` to the required `check` command.

Performance acceptance targets on Dany's current Windows machine:

- Warm renderer ready in at most 2 seconds.
- Initial workspace summary below 250 KB for a typical project; report bodies excluded.
- No duplicate provider validation during event-driven refreshes.
- Cancellation prevents new paid calls immediately and aborts active HTTP work within 2 seconds, excluding provider-side work already accepted remotely.
- Opening, rating, or switching among 100 ideas remains responsive without full workspace reloads.

## Phase 5 — Repair the User Workflow and Documentation

- Intake ends at an editable brief review. Show config, conservative maximum cost, planned lens count, and the final confirmation before starting research.
- Disable duplicate submissions and show loading state for every paid or destructive action. Preserve the visible workspace when an operation fails.
- Display run-scoped progress, failures, retry/resume actions, spend reserved/committed, and evidence completeness. Restore this view after restart.
- Show the current idea rating, allow changing it, and confirm persistence. Make evidence links inspectable from each idea.
- Remove the dead composer and no-op auto-publish setting unless they gain complete supported behavior in this release.
- Rewrite the README for the Electron/SQLite product. Remove obsolete SvelteKit, CLI, MCP, Google-key, JSON-store, and publishing instructions.
- Remove the obsolete deep-research skill, archived SvelteKit implementation, and stale completion reports from the active tree; Git history remains the archive.
- Add accurate package description/author metadata and document local data location, reset behavior, credentials, costs, backup/export, and troubleshooting.

## Public Interface Changes

- Preload API becomes origin-validated and typed; backend token access is removed. Add narrow methods for report/source detail, external URL opening, and run-scoped actions.
- `startResearch` accepts `threadId`, confirmed brief version/snapshot, config snapshot, and an idempotency key; it returns a run summary with budget reservation.
- `generateIdeas` accepts `runId` and `allowPartial` (default `false`) and returns an idea batch with completeness and claim links.
- Workspace responses return summaries only; report/source/event detail is fetched by ID with pagination.
- Provider clients accept `AbortSignal`, timeout policy, and usage metadata, and expose typed retryable/non-retryable errors.

## Test and Release Gates

### Automated tests

- Unit: URL/navigation policy, IPC sender validation, response parsing, cost reservations, timeout/retry rules, adaptive query planning, source deduplication, quote validation, coverage stopping, idea claim validation, and rating updates.
- Integration: clean database creation, cascades, one-active-run constraint, idempotent start, run-scoped reports, accurate resume spending, cancellation during each provider phase, key rotation, typed errors, partial/failed completion, and thread deletion during a run.
- Electron E2E with deterministic local mock providers: setup → intake → brief review → approved research → synthesis → ideas → rating → focused child branch; also cancellation, restart/resume, provider failure, remote-link blocking, and advanced partial generation.
- Live smoke tests remain explicit/manual and never run in ordinary CI. They verify one bounded real-provider run and record actual versus reserved cost.
- The research live smoke uses Exa plus the authenticated Codex CLI with `gpt-5.6-luna`; it runs successfully with no `OPENCODE_API_KEY` and asserts that no OpenCode endpoint was contacted. Record Codex invocation count, elapsed time, schema-repair count, and Exa usage instead of inventing a Codex dollar cost.
- Packaging gate: typecheck, `svelte-check`, unit/integration tests, E2E, production build, NSIS/portable smoke, vulnerability audit, and `bun run build:installed`.

### Branch promotion

1. Every change lands on `dev` in small, reviewable commits. `dev` must pass the complete automated gate and a clean vulnerability audit.
2. When the stabilization milestone is finished, promote the exact commit with a fast-forward-only `dev → stage` push and tag it `stage-v0.3.0-rc.N`. Do not rebuild from a different source commit.
3. Install the stage artifact and manually verify the complete workflow, cancellation, restart recovery, spend ceiling, external links, and data deletion on Dany's machine.
4. Fix failures on `dev`, rerun all gates, and promote a new exact commit to `stage`; never patch `stage` directly.
5. Only after Dany explicitly approves the tested stage commit, fast-forward `stage → master`, tag `v0.3.0`, and build/install from that same commit. Never recreate or promote to a `main` branch.

## Definition of Done

- No untrusted page can navigate inside the privileged window or access Scraply IPC.
- Research and idea generation share persisted, inspectable evidence with valid claim links.
- The hard budget accounts for every paid step and survives concurrency, cancellation, and restart.
- The default research test path uses Codex GPT-5.6 Luna end-to-end and performs zero OpenCode calls.
- Run status never says complete without the required synthesis.
- The normal workflow cannot skip brief review or accidentally create duplicate runs.
- Branch research inherits explicit context and does not restart generic intake.
- Routine UI updates do not reload report bodies or revalidate providers.
- All automated and manual stage gates pass from one exact commit, and `master` changes only after Dany's approval.
