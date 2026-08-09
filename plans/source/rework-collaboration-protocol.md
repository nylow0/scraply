# Scraply Rework — Collaboration Protocol

## Recommendation

Do not ask Codex to implement all of `REWORK.md` in one task. Use one fresh Codex task per phase, keep `REWORK.md` as the source of truth, and do not start the next phase until the current phase has passed its stated success criteria and been committed on `dev`.

The product priority is the readable idea chain:

1. A **problem** must be a clear pattern supported by source-backed factors, not a generic model guess.
2. A **solution** must name a concrete mechanism for changing that problem, not merely restate the desired result.
3. An **idea** is the complete structure around one solution: its problem, positive and negative outcomes, ranked risks, and proposed mitigations.

Everything else is subordinate. Infrastructure work is justified only when it protects this chain, makes it recoverable, or makes its provenance visible. Reports, branching, ratings, composite scores, decorative progress, and speculative personalization must not delay the first honest end-to-end artifact.

The sequence is:

1. Baseline audit against the locked specification
2. Phase −1: isolated runtime fixes
3. Phase 0: additive schema and types
4. Phase 1: headless factor/problem gate
5. Phase 2: headless full-chain validation
6. Phase 3: atomic cutover
7. Final regression and cleanup audit

This is slower than one giant request, but substantially safer. It limits context drift, makes regressions attributable, and preserves the document's compile-safe boundaries.

## Locked product decisions

`REWORK.md`'s product semantics are now locked:

1. `attempted-and-failed` warns and never blocks selection.
2. An edited scope creates a new discovery run on the same thread; the latest run owns the visible checkpoint.
3. Multiple selected problems form a durable, sequential queue represented by their selection rows, with only one development run created at a time.
4. Discovery-depth numbers remain provisional until Phases 1 and 2 produce measurements.
5. Each factor carries one source ID and one verbatim-checked quote directly; no evidence join table is added.
6. Outcomes plus their independent judgments are one atomic stage result. Risks, scores, mitigations, and links are another atomic stage result.

Do not guess or prematurely lock the discovery-depth numbers.

Before implementation, ask Codex for a read-only implementation audit. It should:

- Re-check every load-bearing `file:line` claim against the current repository.
- Identify conflicts between the specification and current code.
- Produce a phase/file/test matrix.
- Run the current baseline checks without modifying code.
- Confirm the branch is `dev` and report unrelated working-tree changes.

Once the audit is accepted, commit the finalized `REWORK.md` and this protocol separately. That gives every later task a stable specification revision to cite.

## Product acceptance questions

Deterministic tests protect schemas, persistence, provenance, resume behavior, and migrations. They cannot decide whether the artifact is worth using. Dany should answer these questions at the two product gates:

### Phase 1: is the problem real and newly discovered?

- Can the problem be stated in one direct sentence without vague market language?
- Do its cited factors actually combine into that problem, rather than merely sharing a topic?
- Does each cited factor show a source and a quote that visibly supports it?
- Did the factor-backed arm reveal at least two problems absent from the scope-only control?
- Are killed or uncertain candidates still visible with understandable reasons?

If the answer is no, stop. Improve factor harvesting, quote normalization, or problem synthesis. Do not build the solution UI around weak problems.

### Phase 2: is the solution a complete idea?

- Does each solution explain a distinct mechanism, not just a different wording?
- Do the outcomes make it obvious what becomes better, what becomes worse, and for whom?
- Does the independent outcome judgment sometimes disagree with the solution authoring call?
- Are the highest risks genuinely capable of invalidating the idea?
- Are mitigations concrete, linked to risks, and honest about when they fail?
- Can Dany understand the entire idea in a few minutes without reading generated report prose?

If the answer is no, fix the responsible stage while the pipeline is still headless. Do not compensate with scores, labels, or prettier presentation.

## Explicitly deferred until the core chain works

- Ratings, taste learning, and cross-run personalization.
- Branching as a first-class feature.
- Reports and stored rendered prose.
- Composite idea scores or automatic build/drop verdicts.
- Additional checkpoints, risk taxonomies, clustering, deduplication systems, and IPC abstraction layers.
- Final discovery-depth values and any USD projection.

These are not backlog promises. They should return only if observed usage demonstrates a real need.

## The task boundary rule

Use a new Codex task for each phase. A fresh task reduces accumulated assumptions and forces the agent to re-read the current files. The repository, `REWORK.md`, tests, and commits carry the state between tasks; chat memory should not be the source of truth.

Within a phase, keep one task open until all success criteria pass. Do not switch agents or start another implementation task against the same files in parallel. Parallel editing would be especially risky around migrations, shared schemas, IPC payloads, and the Phase 3 cutover.

Every implementation request should authorize only one phase. Tell Codex to stop if completing it would require work assigned to a later phase.

## Required start-of-phase protocol

At the beginning of every phase, ask Codex to:

1. Read `AGENTS.md` and the relevant parts of `REWORK.md` completely.
2. Confirm it is on `dev`.
3. Inspect and preserve unrelated working-tree changes.
4. Re-verify referenced code because line numbers may have moved.
5. State the exact files and tests expected to change.
6. Run the relevant baseline tests before editing.
7. Call out any contradiction or missing decision before making an assumption.

This preflight should be concise. Its purpose is to catch stale assumptions, not to redesign the settled document.

## Required end-of-phase protocol

Codex should not call a phase complete until it has:

- Matched every success criterion in `REWORK.md` with concrete evidence.
- Added or updated tests for the behavior changed in that phase.
- Run the narrow tests first, then the broader checks required by the phase.
- Run `bun run build:installed` from the project root, as required by the project instructions.
- Reviewed the diff for accidental scope expansion, stale concepts, debug code, and unhandled migrations.
- Reported remaining risks and anything intentionally deferred.
- Committed only that phase on `dev`, using one clear phase-level commit, after Dany asks for the commit.

If a check fails, Codex should report the actual error and keep the phase open. It should not weaken or delete a test merely to make the boundary green.

## Phase-by-phase working method

### Phase −1 — isolated runtime fixes

Use one task and one commit. Keep it strictly separate from the new pipeline.

Ask for the aged-resume test first, then the deadline fix. Ask for durable provider-call accounting and reservation release with focused integration coverage. The task is complete only when a two-hour-old run resumes and a resumed run cannot obtain a fresh call budget.

Suggested request:

> Implement only Phase −1 from `REWORK.md` on `dev`. Re-verify every cited location first. Add the aged-resume and durable-call-budget regression tests, make the smallest implementation changes, run the relevant tests and `bun run build:installed`, then report evidence against each Phase −1 success criterion. Do not start Phase 0 and do not commit until I ask.

### Phase 0 — additive schema and types

Use a fresh task and one commit. This phase must produce no behavior change.

Migration 7 must be additive. Test both a fresh database and an existing database containing migrations 1–6. The schema-shape test must cover every schema passed to `structuredCompletion`. New prompts should use new filenames so cached user prompts cannot silently override them later.

Suggested request:

> Implement only Phase 0 from `REWORK.md` on `dev`. Keep Migration 7 purely additive and preserve current app behavior. Add the new schemas, JSON-Schema derivation coverage, schema-shape tests, and new prompt files. Verify fresh and existing database startup, run `bun run check`, relevant migration tests, and `bun run build:installed`. Report evidence and stop before Phase 1. Do not commit until I ask.

### Phase 1 — headless go/no-go gate

This is an experiment, not just a coding milestone. It should have two separate steps inside one task:

1. Implement and test Stages 1–2 and the Markdown output path.
2. Run the live two-arm ablation only after Dany explicitly authorizes provider usage and the prompt-cache wipe.

The wipe of `%APPDATA%/scraply/scraply/prompts` is destructive and outside the repository. Codex should resolve and display the exact directory, ask for approval, and remove only that directory. Preserve the generated Markdown artifacts and the raw metrics needed to audit the result.

Do not proceed based on subjective enthusiasm for the output. The documented pass criteria are binding:

- At least two Arm A problems do not appear in Arm C.
- Every Arm A problem cites at least one factor with a quote that passed the verbatim check.

Also record factor utilization and quote-rejection rates by harvest mode without turning them into invented thresholds.

If the gate fails, stop the rework. Diagnose factor harvest or normalization; do not proceed to Phase 2 and do not compensate with more elaborate prompting.

Suggested request:

> Implement only Phase 1 from `REWORK.md`, headless, on `dev`. Build plain functions and the Markdown gate artifact; add focused tests for normalization, quote verification, provenance gates, stage transactions, and resume/idempotency. Do not add IPC or renderer code. Once local checks and `bun run build:installed` pass, stop and ask me before wiping the prompt cache or spending provider calls. For the live gate, use the same scope for Arms A and C and report the two hard pass criteria plus the recorded non-threshold metrics. Do not start Phase 2.

### Phase 2 — headless full-chain validation

Start only after Dany explicitly accepts the Phase 1 gate result. Use a fresh task and one commit.

Run one selected problem through solutions, outcomes, risks, and mitigations. Preserve the structured rows and render the readable artifact from them; never parse rendered prose back into the pipeline. Test per-subject transactions and resume behavior. Verify that risk changes ordering and presentation but never hides an idea or declares it blocked, high-risk, or viable.

Measure actual per-problem call count. Use that measurement to set honest checkpoint projections and inform discovery-depth defaults; do not invent USD cost.

Suggested request:

> Implement only Phase 2 from `REWORK.md`, headless, on `dev`, using the accepted Phase 1 implementation. Run one selected problem through Stages 3–5, add transaction/idempotency and structured-rendering tests, and verify all governing principles. Measure the actual call count and produce the complete readable chain. Run relevant tests and `bun run build:installed`; stop before Phase 3 and do not commit until I ask.

### Phase 3 — atomic cutover

This is the highest-risk phase and must remain one landable change, as the document requires. Use a fresh task with no other work happening in the repository.

Codex may organize its work internally by schema/repositories, server/IPC, renderer, and tests, but it must not create intermediate commits that leave the repo uncompilable. Migration 8, old-module deletion, new UI, E2E mock rewrite, E2E flow rewrite, and `package.json` test-script update must land together.

Before editing, require a concrete cutover checklist derived from the current imports and deleted concepts. During implementation, use frequent narrow checks. At the end, require:

- Fresh-install migration verification.
- Existing-install migration verification from a realistic migrations 1–7 database.
- Full typecheck and test suite.
- E2E checkpoint/restart/development-run flow.
- `bun run build:installed`.
- Grep audit for every concept and module the document says to delete.
- Diff audit confirming security, backend process, build, release, and other explicitly untouched areas did not drift.

Suggested request:

> Implement only Phase 3 from `REWORK.md` as one atomic cutover on `dev`. First re-derive the cutover checklist from current imports and tests. Implement Migration 8, delete the old pipeline, land the new UI and IPC/server payloads, rewrite E2E mocks and flows, and update the enumerated test script in the same change. Keep the repository compileable at the final boundary; do not retain compatibility shims unless `REWORK.md` explicitly requires them. Run fresh/existing migration tests, the full check and test suites, E2E, deletion/untouched-area audits, and `bun run build:installed`. Report evidence against every Phase 3 success criterion and do not commit until I ask.

## How Dany should review each phase

Do not review only screenshots or the final summary. Ask for four things:

1. The exact success criteria, copied from the phase and marked pass/fail with evidence.
2. The changed-file list with a one-line reason for each file.
3. The commands run and their exit status.
4. Known limitations and deferred items.

For Phases 1 and 2, personally read the generated Markdown output. Those phases validate product quality that deterministic tests cannot fully establish. For Phase 3, personally exercise the checkpoint, restart, resume, and final idea view on an existing local database before authorizing the commit.

When something looks wrong, ask Codex to diagnose first. Do not immediately ask it to patch symptoms. A failed experimental gate, migration issue, or resume defect can have a different root cause than the visible output.

## Commit and rollback discipline

Keep one accepted commit per documented phase:

- `phase -1: fix resume timing and durable call limits`
- `phase 0: add rework schema and structured types`
- `phase 1: add headless discovery pipeline`
- `phase 2: add headless idea development pipeline`
- `phase 3: cut over to the five-stage pipeline`

Commit messages can vary, but the boundaries should not. Tag or record the commit hash after the Phase 1 gate and before Phase 3. If Phase 3 fails badly, returning to the completed Phase 2 boundary should be straightforward.

Do not mix unrelated cleanup, dependency upgrades, formatting sweeps, or speculative abstractions into these commits. `REWORK.md` explicitly prefers deletion and rejects several tempting abstractions; phase work should honor that constraint.

## What Dany must decide or authorize

Codex can perform most implementation work autonomously, but Dany should retain control over:

- Acceptance or rejection of the Phase 1 go/no-go result.
- Authorization for prompt-cache deletion and paid/live provider calls.
- Selection of the Phase 2 problem.
- Acceptance of the human-readable Phase 2 output.
- The final Phase 3 existing-database smoke test.
- When each phase is committed.

Everything else should be driven by the checked-in specification and tests, not by repeated conversational decisions.

## Failure rules

- If a requirement and current code conflict, stop and surface the conflict.
- If a settled decision merely looks unusual, follow it; do not reopen it without new evidence.
- If an open item affects behavior, ask Dany instead of guessing.
- If Phase 1 fails, do not continue to Phase 2.
- If a migration test fails, do not patch the database manually and call it solved.
- If `bun run build:installed` fails, report the relevant output and leave the phase incomplete.
- If unrelated user changes overlap a required file, stop before overwriting them.
- If a later-phase change appears necessary, report it as a specification conflict rather than silently expanding scope.

## Best overall working pattern

The most reliable relationship is: Dany owns product decisions and accepts empirical gates; Codex owns bounded implementation, verification, and evidence. `REWORK.md`, commits, database fixtures, generated gate artifacts, and tests hold the durable state. Chat is used to authorize the next bounded step, not to store design truth.

The single most important instruction to repeat in every implementation task is:

> Implement only the named phase, prove its success criteria, run `bun run build:installed`, and stop before the next phase.
