# Scraply runtime

Scraply runtime is a Windows-first local process for one bounded structured-generation assignment. Scraply owns research, evidence, schemas, workflow state, budgets, and persisted credentials. The runtime compiles the stage prompt, calls the selected provider, validates the returned object, and reports usage.

The core contains no tools, research client, Codex task type, fallback router, or bundled model catalog.

## Code layout

- `scraply-agent-cli` owns process lifecycle, the JSONL protocol, request correlation, credential sessions, and login flows.
- `scraply-agent-core` owns work orders, evidence boundaries, prompt identity, schema validation, cancellation, deadlines, repair policy, accounting, and stable failures.
- `scraply-agent-providers` owns direct OpenAI subscription and OpenRouter adapters. It also has a Models.dev metadata overlay that cannot mark a model runnable.

OpenCode Zen and Go are not enabled. Their official documentation does not yet define a stable direct contract for every authentication, model, generation, streaming, usage, and error behavior the runtime needs.

## Build

This workspace is maintained in `nylow0/scraply` under `runtime/`. It was imported from `nylow0/scraply-agent` commit `5fea3f217e9fea54c0d4f88c6ef51ab001b07520`; that repository is legacy. App and runtime changes now belong in the same pull request.

From the Scraply root, run `git submodule update --init --recursive` once, then `bun run prepare:runtime` to test and package the native executable. Packaging uses `build/cargo` for its Cargo cache and generates the archive and provenance lock under `build/runtime-artifacts`.

For app development, follow the [root README](../README.md#development) to configure Electron with the staged worker and reuse it between UI/backend edits. Rebuild the stage after native changes; Cargo alone does not replace the executable in `build/runtime` that the app uses.

For development, run these commands from `runtime/` with the MSVC toolchain on Windows:

```powershell
cargo +stable-x86_64-pc-windows-msvc build --workspace
cargo +stable-x86_64-pc-windows-msvc test --workspace
```

The executable is `target\debug\scraply-agent.exe` for a normal debug build.

The packaging gate allows at most 6000 nonblank production Rust lines. Phase 1 uses 5601 lines after adding protocol negotiation, bounded envelopes, session credential acknowledgement, refresh recovery, and per-attempt terminal accounting; test-only and debug-only items remain excluded by the existing scanner.

## Runtime protocol

Start one process for the Scraply desktop session:

```powershell
.\target\debug\scraply-agent.exe runtime
```

Requests and responses are one JSON object per line on stdin and stdout. Native protocol version `1.1` is the only negotiable version and supports these operations:

- `runtime.initialize`
- `account.list`
- `account.login.start`
- `account.login.complete`
- `account.login.cancel`
- `account.logout`
- `account.refresh`
- `credential.session.set`
- `credential.session.persisted`
- `model.list`
- `generation.start`
- `generation.cancel`
- `runtime.shutdown`

Every request has a unique string or integer `id`. `runtime.initialize` must be first, and later envelopes must keep the negotiated version. Initialization advertises the exact operations, capabilities, prompt identity, and the 16 MiB serialized-envelope, 2 MiB input/output, and 256 KiB schema limits. A generation also has a `generationId`, which is used by `generation.cancel`.

The `generation.start` payload contains a qualified `{ providerId, modelId }`, trusted `workOrder`, untrusted `evidence`, Scraply's `outputSchema`, a deadline, and the explicit repair policy. The immediate success response accepts the generation and echoes the compiler prompt identity. Later `generation.started`, `generation.completed`, `generation.failed`, or `generation.cancelled` events keep the start request ID. Terminal events retain per-attempt completion, usage, cost, latency, and provider request IDs when known; unknown accounting is never represented as zero.

The frozen app-facing TypeScript declarations and JSON examples live under `contracts/runtime/v1.1`. Protocol `1.0` was an unreleased draft and is rejected.

OpenAI subscription requests must omit `maxOutputTokens`: its endpoint rejects `max_output_tokens` with HTTP 400. The adapter rejects an explicit ceiling locally rather than silently ignoring it. Deadlines and the runtime output-byte limit still apply, but they are not token or billing ceilings. Providers that support token ceilings retain them.

Interactive login completion is polled with a fresh request ID. While the provider network exchange is pending, `account.login.complete` returns retryable `operation_unavailable`; `account.login.cancel` and `runtime.shutdown` remain serviceable and clean up the listener or exchange task.

See [CONTEXT.md](CONTEXT.md) for the project language and [ADR 0001](docs/adr/0001-custom-runtime.md) for the ownership decision.

## Provider accounts

OpenAI subscription supports browser login, device login, refresh, logout, live account-scoped model discovery, and one structured Responses call. It reuses only the pinned OpenAI login and subscription transport code under `vendor/openai-codex`.

OpenRouter supports PKCE S256 with a host-owned callback, manual API key sessions, live structured-output model discovery, strict JSON Schema generation, and exact provider-reported cost. After login or an OpenAI refresh, the runtime returns the credential once so Scraply can encrypt it with Electron `safeStorage`. Protocol 1.1 blocks model listing and generation for that provider until Scraply acknowledges the exact `{ providerId, sessionId, rotationId }` through `credential.session.persisted`. A stale acknowledgement cannot unlock a later rotation. On relaunch, Scraply restores the encrypted value through `credential.session.set`.

Credentials never belong in argv, environment variables, repository files, telemetry, or error bodies. The runtime stores session credentials only in memory. The debug test fixture is compiled out of release builds and packaging checks the binary for its marker.

## Package

The package script runs formatting, the complete locked workspace tests, strict Clippy, a release build, test-seam inspection, the 20 MiB binary budget, and a version smoke test.

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\package.ps1
```

The output is written under `dist\scraply-agent-<version>-windows-x64`. It contains no `.env` or credential placeholder.
