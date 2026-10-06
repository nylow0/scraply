# Scraply runtime

This Rust workspace is part of Scraply. The root [AGENTS.md](../AGENTS.md) applies here too.

- The runtime owns native transport, provider adapters, and bounded generation. Research, search providers, workflow orchestration, and persisted credentials stay in the TypeScript app.
- A protocol change updates `contracts/runtime/`, the app's consumer (`src/providers/runtime.ts`), and both sides' tests in the same pull request.
- `vendor/openai-codex` is a pinned, unpatched upstream submodule. Scraply-specific behavior lives in the local crates; follow [UPSTREAM.md](UPSTREAM.md) to move the pin.
- `nylow0/scraply-agent` is legacy. New runtime work belongs here.
