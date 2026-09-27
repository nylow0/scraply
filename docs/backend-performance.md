# Backend performance

This work starts from `ce6ae26`, the GitHub `master` revision on 2026-09-27. It covers backend execution and preserves research outputs. Renderer performance, UI code, prompts, model selection, provider concurrency, and request budgets are outside the change.

## Acceptance

Each retained optimization must reduce measured work on the actual implementation, preserve output in deterministic comparisons, and pass focused behavior tests. Timings use synthetic local data and are not claims about remote model latency. No finite test suite proves the absence of all regressions.

## Audit coverage

| Area | Review scope |
| --- | --- |
| Persistence | SQLite adapters, migrations, repositories, discovery writes, query plans, export access |
| Core | Discovery and development context, scheduling, checkpoints, revisions, conversations, opportunity work, prompt loading |
| Providers | Search clients, structured generation, native process framing, deadlines, cancellation, accounting |
| Native runtime | Owned Rust transport and generation code, protocol boundaries, upstream integration |
| Backend services | HTTP operations, research and idea exports, usage aggregation |
| Main process | Startup, credential persistence, logging, backend lifecycle |

Credential serialization and atomic writes protect cross-process changes. They remain unchanged. Sparse diagnostic logging does not justify buffering that might lose crash evidence. Provider calls, research stages, retries, and cancellation retain their existing sequencing and limits. The pinned upstream dependency is unchanged.

## Retained changes

- Native response parsing scans each incoming chunk once and grows a bounded buffer geometrically. It no longer copies and rescans the entire accumulated response on every chunk. Completed frames release the buffer, and the 16 MiB limit remains enforced before growth.
- Discovery persistence prepares source inserts and ownership checks once per transaction. SQL, inserted fields, reference validation, checkpoints, and transaction boundaries are unchanged.
- Idea exports group ideas in one pass and calculate each run's usage once per request. The cache expires with the request. Exported ordering and content are unchanged.

## Measurements

The baseline is `ce6ae26`. Final measurements ran sequentially after native compilation finished. These are local synthetic benchmarks on this Windows machine. They exclude external provider response time and do not establish an end-to-end research speedup.

| Operation | Fixture and sample plan | Baseline median | Changed median |
| --- | --- | --- | --- |
| Full runtime frame parse | 256 KiB payload, 8 KiB chunks, 9 samples | 1.15 ms | 0.24 ms |
| Full runtime frame parse | 2 MiB payload, 8 KiB chunks, 9 samples | 38.34 ms | 2.02 ms |
| Full runtime frame parse | 8 MiB payload, 8 KiB chunks, 9 samples | 640.84 ms | 5.59 ms |
| Discovery persistence, Bun SQLite | 80 sources, 400 factors, 40 problems, 5 fresh databases | 12.17 ms | 7.24 ms |
| Discovery persistence, Node SQLite | Same fixture, 5 fresh databases | 10.67 ms | 7.27 ms |
| Idea JSON export, real HTTP route | 500 development runs, 1,000 ideas, two rounds of 8 timed requests after warmup | 63.13 / 66.63 ms | 42.63 / 40.54 ms |

Discovery numbers sum the median factor and problem persistence times. Database creation and migrations are outside the timed interval. Node 24 exercises the same `node:sqlite` adapter used by the installed Electron backend; the browser verification also exercises that adapter in Electron. The runtime benchmark includes JSON decoding, protocol schema validation, and envelope handling. Its large payload is synthetic, not a claim that typical responses are 8 MiB.

The parent reran the full parser comparison and the Node baseline/candidate comparison; those results are in the table. A separate Bun readback took 8.01 ms, and the 500-run idea export took 41.70 ms. Differences between rounds are expected for millisecond workloads.

The export comparison produced identical JSON hashes at both 60 and 500 saved runs. Research-export timestamps alone were omitted when comparing that unchanged route. The discovery relationship digest was identical on both database adapters, and foreign-key checks passed. Existing integration tests cover inserted content, cross-run references, and rollback. Every parser benchmark sample asserts equality of the reconstructed result.

Run the benchmarks from the checkout root:

```powershell
bun test/performance/runtime-framing.bench.ts ce6ae26
bun test/performance/discovery-persistence.bench.ts
bun build ./test/performance/discovery-persistence.bench.ts --target node --format cjs --outfile ./build/discovery-persistence.bench.cjs
node build/discovery-persistence.bench.cjs
$env:SCRAPLY_BENCH_RUNS = "500"
bun test/performance/backend-export.bench.ts
```

The parser benchmark loads its baseline directly from Git. To reproduce the database and export comparisons, run the same benchmark files against the baseline in a separate checkout, then against this branch. Their output includes hashes for comparing results. Do not benchmark during compilation or other CPU-heavy work.

## Rejected changes

Batching development-context source reads reduced a 24-source, 96-factor cold context build from about 1.85 to 1.61 ms. That saves only 0.25 ms once per development run, so the code and its temporary benchmark were removed.

Existing source and factor lookups already use indexes. Global statement caching would add lifecycle and migration concerns without evidence that it is needed. Broader research-export batching was left out because its added complexity was not justified in this pass. Scheduler changes would alter provider order, budgets, or dependent stage inputs. Prompt, credential, and durability changes were rejected for the same-result requirement.

## Verification

Five GPT-6 Sol agents performed the four scoped investigations and an independent regression review. The parent inspected the integrated production diff and exercised the app. No renderer, preload, desktop integration, prompt, migration, dependency, or native Rust source file changed.

Focused checks passed for discovery persistence and rollback, repository ownership invariants, migrations, backend exports, opportunity exports, run usage, and runtime lifecycle. Framing tests cover split UTF-8, multiple frames per chunk, the exact 16 MiB limit, 100,000 tiny fragments, oversized frames, invalid JSON, and restart after failure. The buffer stays bounded and is released after a completed frame.

Headless Chromium exercised the real browser-development app using an isolated synthetic profile with 20 projects and 100 research runs. It downloaded idea JSON with 18 ideas and matching run usage, idea Markdown, and research JSON, switched projects, and confirmed the active project after reload. No page errors or paid provider calls occurred. The app's production native worker started with an isolated credential profile.

`bun run check` passed with exit code 0: lint, TypeScript, Svelte checks with no errors or warnings, 256 unit tests, 231 integration tests, and 136 renderer tests. The two configured skips were the live Exa probe and the optional saved-development-database-copy fixture. No claim is made that these two checks ran.

`bun run build:installed` passed with exit code 0. It ran the normal native formatting, source-budget, 86 Rust tests, Clippy, release compilation, package verification, and installation checks. The installed application code and bundled runtime both record commit `5f9d57271e01dd279efba2f130f8bd7745fc5c1c`, with a clean source state. The installed executable is `%LOCALAPPDATA%/Programs/Scraply/Scraply.exe`, version 0.3.0.

The installed `native v2 research` Playwright scenario passed through discovery, problem selection, solution generation, risk analysis, evidence follow-up, a saved decision and observed result, and reopening the saved research. It runs the installed renderer, preload, and main process against the production TypeScript backend with a fixture native child and fixture search responses. It neither uses a live model nor changes the user's account. The first attempt exposed an existing test assertion for lowercase `overstated`; the application already displays `Overstated`. Only the two test assertions were corrected, then the full scenario passed.

Live paid generation, remote provider latency, the optional real saved-database-copy test, and release acceptance were not verified. The installed build is ready for local testing; this work does not claim a production release was published.
