# Scraply runtime

This Rust workspace is part of Scraply. The root [AGENTS.md](../AGENTS.md) applies here too.

- The runtime owns native transport, provider adapters, and bounded generation. Research, search providers, workflow orchestration, and persisted credentials stay in the TypeScript app.
- A protocol change updates `contracts/runtime/`, the app's consumer (`src/providers/runtime.ts`), and both sides' tests in the same pull request.
- `vendor/openai-codex` is a pinned, unpatched upstream submodule. Scraply-specific behavior lives in the local crates; follow [UPSTREAM.md](UPSTREAM.md) to move the pin.
- `nylow0/scraply-agent` is legacy. New runtime work belongs here.

## Vocabulary

| Term | Meaning | Avoid |
| --- | --- | --- |
| runtime | The local process that accepts stage assignments and returns validated model results with accounting. | harness, agent, Codex runtime |
| work order | One bounded assignment for a workflow stage: goal, inputs, required decisions, completion conditions, constraints. | task, job, prompt |
| evidence | Untrusted research material attached to a work order, identified by source IDs Scraply owns. | context, tool output |
| provider | A billing and authentication route to models. | backend, gateway |
| qualified model | A model together with its provider. The same model through two providers is two qualified models. | bare model, fallback model |
| provider account | A user's authenticated relationship with one provider. | account, when the provider is unclear |
| credential session | The in-memory credentials Scraply supplies for the current runtime session. | credential store, auth file |
| generation | One provider call sequence for a work order, with at most one explicitly authorized schema repair. | agent turn, tool loop |

## Decisions that hold

- Scraply owns a provider-neutral runtime contract. The runtime has no tools, research client, Codex task type, fallback router, or bundled model catalog, and OpenAI authentication is one private adapter that must stay removable.
- Model identity is always `{ providerId, modelId }`. The runtime never substitutes another provider or biller.
- Provider discovery fails closed. Cached or Models.dev metadata can describe a model but never marks it runnable.
- Credentials live only in the runtime's memory. They never go in argv, environment variables, repository files, telemetry, or error bodies, and the runtime never reads neighboring credential files. After a login or refresh the runtime returns the credential once, and blocks that provider's model listing and generation until Scraply acknowledges it with `credential.session.persisted`.
- The desktop strips inherited Codex and OpenAI tokens and authentication endpoint overrides before it launches the worker, and a direct launch rejects them. Standalone `login` and `logout` commands are unsupported. The release package contains no `.env` or credential placeholder.
- A dispatched request is never replayed automatically after a stream failure. Unknown accounting is never reported as zero.
- OpenAI generation uses a WebSocket owned by the request, with no local idle cutoff: only an explicit deadline, a transport error, or a provider failure ends it. HTTP/SSE is used only when the upgrade returns HTTP 405 or 426, before a generation is sent.
- `runtime.initialize` is always the first request. Limits are 16 MiB per serialized envelope, 2 MiB of input or output, and 256 KiB per schema.
- `output_limit` is separate from `output_invalid`. A provider token-limit result must not become an automatic schema repair.
- OpenAI subscription requests omit `maxOutputTokens`, because the endpoint rejects it. The adapter rejects an explicit ceiling rather than ignoring it.
- Raw reasoning is never forwarded. Reasoning summaries are bounded to 16 KiB per generation.
- OpenCode Zen and Go stay disabled until official contracts cover authentication, generation, model discovery, structured output, cancellation, usage, and errors.
- The debug fixture seam (`SCRAPLY_AGENT_TEST_FIXTURE`) exists only in debug builds, and packaging rejects a release binary that contains its marker.

## Code and build

- `scraply-agent-cli` owns process lifecycle, the JSONL protocol, request correlation, credential sessions, and login flows. `scraply-agent-core` owns work orders, evidence boundaries, prompt identity, schema validation, cancellation, deadlines, repair policy, and accounting. `scraply-agent-providers` owns the OpenAI subscription and OpenRouter adapters.
- Protocol `1.2` is the only negotiable version. Its app-facing declarations and examples are frozen under `contracts/runtime/v1.2`. The worker accepts at most eight concurrent generations.
- For quick iteration, run `cargo +stable-x86_64-pc-windows-msvc build --workspace` and `test --workspace` from `runtime/`. Cargo alone does not replace the worker the app uses: run `bun run prepare:runtime` from the Scraply root to restage `build/runtime`.
- Packaging enforces at most 6000 nonblank production Rust lines and a 20 MiB binary, and rejects an executable that still contains the builder's user profile path.
- Live OpenAI and OpenRouter account tests need my credentials and are not part of the offline suite. Record a live result separately from the deterministic tests.
- When runtime preparation fails, read the failing test or compiler diagnostic higher in the log. The final packaging error only names the gate.
