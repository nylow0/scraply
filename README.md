# Scraply

Scraply is a Windows desktop app that finds real problems people have and turns them into business ideas you can check against the evidence.

You describe a topic, an audience, or a problem you already know. Scraply searches the web and online communities, extracts candidate problems with quoted sources, and generates ideas for the problems worth solving. A separate review pass checks each idea for risks and duplicates. Everything stays in a local SQLite database, and you decide what to pursue.

**Status:** early development. No installer has been published yet, so for now you build Scraply from source with the [development guide](docs/maintainers/development.md).

## How a project works

1. **Setup.** Write a brief, then choose the model, research depth, search provider, and hard limits on model calls, searches, and time.
2. **Research.** Scraply searches with Exa or Perplexity and returns candidate problems. Every claim links to the excerpt and source behind it. You can ask follow-up questions or re-check a finding; a new result only replaces the current evidence when you apply it.
3. **Ideas.** Scraply generates solutions for the selected problems, reviews their risks, and groups variants so only distinct ideas count toward your target. It stops at your limits and never pads the count.
4. **Develop an idea.** Discuss an idea, rethink it into a new version while the old ones stay readable, or draft a small experiment that tests one assumption with a metric and pass/fail thresholds.

There are two run modes. **Vibe** (the default) runs research, problem selection, idea generation, and review in one pass. **Controlled** stops after research so you pick the problems and the ideas model yourself.

Research exports as JSON. Ideas export as Markdown or JSON.

## What you need

- Windows 10 or 11
- An OpenAI subscription account, connected in the app
- An Exa or Perplexity API key for web research, pasted in the app (a run that starts from a known problem can skip search)

## Documentation

**Using Scraply**

- [User guide](docs/user/guide.md): projects, run modes, models, limits, and exploring ideas
- [Data and privacy](docs/user/data-and-privacy.md): what stays on your computer, what goes to providers, backups
- [Troubleshooting](docs/user/troubleshooting.md): accounts, partial runs, startup errors

**Working on Scraply**

- [Development](docs/maintainers/development.md): setup, the dev server, verification
- [Release](docs/maintainers/release.md): versions, packaging, signing, rollback
- [Runtime](runtime/README.md): the native worker that makes model calls

Agents working in this repository start at [AGENTS.md](AGENTS.md).

## How it's built

- **Electron app** with a Svelte 5 and Tailwind renderer (`src/renderer`). The renderer reaches the main process (`src/main`) only through a narrow preload bridge (`src/preload`).
- **TypeScript core** (`src/core`) runs the workflows, research, and budgets. Storage lives in `src/db`, and the search providers in `src/providers`.
- **Rust worker** (`runtime/`) makes each model call and validates the result against a schema.
- **Bun** runs the tooling and tests.

## Contributing

Bug reports and feature requests are welcome in [issues](https://github.com/nylow0/scraply/issues). For code changes, branch from `master` with a `feat/`, `fix/`, `docs/`, or `chore/` prefix and open a pull request back into `master`. The pull request template lists the verification we expect.

## License

Scraply is released under the [MIT License](LICENSE). The native worker in `runtime/` is licensed under Apache 2.0 and builds on pinned OpenAI Codex libraries; see [runtime/UPSTREAM.md](runtime/UPSTREAM.md) for provenance and notices.
