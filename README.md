# Scraply

Scraply is a Windows desktop app that finds real problems people have and turns them into business ideas you can check against the evidence.

You describe a topic, an audience, or a problem you already know. Scraply searches the web and online communities, extracts candidate problems with quoted sources, and generates ideas for the problems worth solving. A separate review pass checks each idea for risks and duplicates. Everything stays in a local SQLite database, and you decide what to pursue.

**Status:** in active development in a private repository. There is no public release yet.

## How a project works

1. **Setup.** Write a brief, then choose the model, research depth, search provider, and hard limits on model calls, searches, and time.
2. **Research.** Scraply searches with Exa or Perplexity and returns candidate problems. Every claim links to the excerpt and source behind it. You can ask follow-up questions or re-check a finding; a new result only replaces the current evidence when you apply it.
3. **Ideas.** Scraply generates solutions for the selected problems, reviews their risks, and groups variants so only distinct ideas count toward your target. It stops at your limits and never pads the count.
4. **Develop an idea.** Discuss an idea, rethink it into a new version while the old ones stay readable, or draft a small experiment that tests one assumption with a metric and pass/fail thresholds.

There are two run modes. **Vibe** (the default) runs research, problem selection, idea generation, and review in one pass. **Babysit** stops after research so you pick the problems and the ideas model yourself.

Research exports as JSON. Ideas export as Markdown or JSON.

## What you need

- Windows 10 or 11
- An OpenAI subscription account, connected in the app
- An Exa or Perplexity API key for web research (a run that starts from a known problem can skip search)

The [user guide](docs/user-guide.md) covers projects, models, limits, and partial runs. [Data and privacy](docs/data-and-privacy.md) explains what stays local and what goes to providers. [Troubleshooting](docs/troubleshooting.md) covers startup and account errors.

## How it's built

- **Electron app** with a Svelte 5 and Tailwind renderer (`src/renderer`). The renderer reaches the main process (`src/main`) only through a narrow preload bridge (`src/preload`).
- **TypeScript core** (`src/core`) runs the workflows, research, and budgets. Storage lives in `src/db`, and the search providers in `src/providers`.
- **Rust worker** (`runtime/`) makes each model call and validates the result against a schema. See the [runtime guide](runtime/README.md).
- **Bun** runs the tooling and tests.

## Work on Scraply

Follow the [development guide](docs/development.md) for prerequisites, setup, and verification. For daily work, `bun run dev` starts a background server and prints a browser URL.

Branch from `master` with a `feat/`, `fix/`, `docs/`, or `chore/` prefix and open a pull request back into `master`. [RELEASE.md](RELEASE.md) covers versioning and release gates.

The project is not yet licensed for public reuse. A proposed MIT license awaits maintainer approval in [docs/license-proposal.md](docs/license-proposal.md). Bundled runtime and upstream notices remain in their original locations.
