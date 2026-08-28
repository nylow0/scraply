# Scraply Full Code Review

Date: 2026-08-23
Branch: `dev`
Result: complete; no unresolved critical or high-severity findings

## Scope and method

The review covered every tracked source, renderer, database, shared-contract, test, script, workflow, root configuration, runtime prompt, and code-like HTML/SVG/YAML file. Three first-pass subsystem reviewers performed line-by-line reviews, followed by independent adversarial reviews of the resulting runtime and UI/data changes. The final tree was then checked and packaged as a whole.

## Improvements made

- Runtime and provider lifecycle: fixed stale-credential validation races, bounded subprocess output, made abort/timeout handling wait for process exit, terminated Windows process trees, preserved explicit `.cmd` paths, extended Exa timeouts through body parsing, and prevented cleanup failures from masking the original provider error.
- Shutdown and resource safety: tracked active research executions and HTTP handlers, waited for them before closing SQLite, suppressed late cancelled-run events/accounting writes, isolated event subscriber failures, and closed resources on listen/startup failures.
- Security and data boundaries: rejected credential-bearing/non-HTTP source URLs, strengthened embedded-instruction resistance in runtime prompts, handled corrupt preference JSON safely, and kept provider failures typed without leaking unsafe details.
- Persistence correctness: made thread/default-configuration creation atomic, enforced same-run factor/source relationships, prevented post-completion cost reservations, rejected empty known-problem roots, and added invariant/accounting regression coverage.
- Desktop lifecycle and exports: guarded destroyed windows, restored macOS activation behavior, cleared stale window references, and prevented exports from overwriting existing user files.
- Renderer correctness: fixed cross-thread save/progress races, overlapping async workspace operations, unhandled IPC failures, stale component state, rank changes caused by filtering, and conflicting navigation during mutations.
- Accessibility and UI semantics: added roving tab focus with keyboard navigation, connected validation errors to fields, centralized external-link failures, and improved busy/error/success state behavior.
- Tooling and tests: expanded TypeScript coverage to scripts, corrected Phase gate configuration provenance, made the live Exa test report a true skip, removed an unimplemented E2E mock endpoint and two dead tracked probe artifacts, and added focused lifecycle/provider/repository tests.

## Verification

- `bun run check`: passed
- TypeScript: passed
- Svelte diagnostics: 0 errors, 0 warnings
- Core tests: 112 passed, 1 intentional live-provider skip, 0 failed; 525 assertions across 22 files
- Renderer component tests: 4 passed, 0 failed
- Dependency audits: no reported production or full-tree vulnerabilities
- Frozen-lockfile install dry run: passed
- `git diff --check`: passed (Git only reports expected Windows LF-to-CRLF notices)
- `bun run build:installed`: passed
- Package verification: 561 `app.asar` entries and 4 hashed artifacts verified
- Local installation: Scraply 0.3.0.0 updated successfully

## Previously identified low-severity risks — resolved

- Prompt overrides now use hash-versioned metadata. Exact historical bundled copies upgrade automatically, user edits are preserved, CRLF variants are recognized, and unknown future metadata versions cannot be downgraded.
- Verdict-source and job-event entity relationships are normalized behind database foreign keys, composite ownership constraints, compatibility triggers, deterministic legacy backfills, and direct-SQL regression tests.
- Normal CI now exercises Codex through a real hermetic child-process protocol and Exa through a real loopback HTTP server, including success, failure, abort, timeout, cache invalidation, and cleanup paths. The optional credentialed Exa probe remains an intentional live-environment check.
- Svelte component tests now cover stale async responses, overlapping mutations, ARIA/tab state, and keyboard navigation; renderer tests are included in TypeScript's resolved file set.
- ESLint recommended TypeScript/Svelte rules and unused-disable reporting are part of `bun run check`; test discovery automatically includes the complete unit/integration tree.
- GitHub Actions are pinned to verified full commit SHAs using Node-24-native releases with readable version comments.
- The unused SSE endpoint and subscriber infrastructure were removed; the active utility-process event path remains covered.

No documented architectural follow-up remains open from this review.
