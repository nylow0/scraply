# Own the Scraply runtime contract

Status: accepted, 2026-08-30

Scraply will own a provider-neutral runtime contract instead of extending Codex's commands, task model, prompt, tools, or protocol. This costs us a migration and direct provider maintenance, but it keeps research, evidence, billing, schemas, and workflow state under Scraply's control. OpenAI authentication is one private adapter and must be removable without changing the core model.

## Decision details

- Model identity is always the pair `{ providerId, modelId }`. The runtime never substitutes another provider or biller.
- Scraply owns persisted credentials and sends session credentials through the private process pipe. The runtime keeps them in memory and never reads neighboring credential files.
- Protocol major version `1` uses correlated JSONL requests. Generation has a separate operation ID for cancellation.
- The prompt contract separates trusted work instructions from untrusted evidence and records a prompt revision plus content hash on every run.
- Provider discovery fails closed. Cached metadata can describe a model but cannot mark it runnable.
- OpenCode Zen and Go remain disabled until official contracts establish authentication, generation, model discovery, structured output, cancellation, usage, and errors. Models.dev metadata and local OpenCode credentials do not satisfy this gate.

## Rejected alternatives

Keeping the Codex app-server contract would reduce the first migration, but it would preserve coding-agent assumptions and make OpenAI the parent architecture. Importing OpenCode would add provider breadth, but would also import its loop, configuration, credential store, and availability assumptions. A generic multi-provider framework has no current Scraply workflow to justify it.

## Consequences

The executable has three code owners: CLI process lifecycle, core contracts and validation, and provider adapters. Exa stays in Scraply's accounted research pipeline. The old `exec` and app-server shapes may exist for one migration release behind an explicit compatibility switch, then must be deleted after installed-workflow parity.
