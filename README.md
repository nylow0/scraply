# Scraply

Scraply is a Windows desktop app that finds real problems people have and turns them into business ideas you can check against the evidence.

You describe a topic, an audience, or a problem you already know. Scraply searches the web and online communities, extracts candidate problems with quoted sources, and generates ideas for the problems worth solving. A separate pass ranks the ideas for each problem against your approved goal. Everything stays in a local SQLite database, and you decide what to pursue.

**Status:** early development. Download the [latest release](https://github.com/nylow0/scraply/releases/latest): the installer or the portable build. Releases are not code-signed yet, so Windows SmartScreen asks for confirmation on first launch (**More info → Run anyway**).

## How a project works

1. **Setup.** Write a brief, then choose the model, research depth, and search provider. Depth guides the breadth and thoroughness of new research; call, search, and time estimates do not stop it.
2. **Research.** Scraply searches with Exa or Perplexity and returns candidate problems. Every claim links to the excerpt and source behind it. You can ask follow-up questions or re-check a finding; a new result only replaces the current evidence when you apply it.
3. **Ideas.** Choose how many ideas to request for each selected problem. Scraply writes and ranks each problem's ideas against your approved goal, and shows when fewer ideas were returned. It never pads the count. You can pause or stop a run. Older saved runs keep their original risk reviews, business-family grouping, and count limits.
4. **Develop an idea.** Discuss an idea, rethink it into a new version while the old ones stay readable, or draft a small experiment that tests one assumption with a metric and pass/fail thresholds.

There are two run modes. **Vibe** (the default) runs research, problem selection, idea generation, and review in one pass. **Controlled** stops after research so you pick the problems and the ideas model yourself.

Research exports as JSON. Ideas export as Markdown or JSON.

## What you need

- Windows 10 or 11
- An OpenAI subscription account, connected in the app
- An Exa or Perplexity API key for web research, pasted in the app (a run that starts from a known problem can skip search)

## How it's built

- **Electron app** with a Svelte 5 and Tailwind renderer (`src/renderer`). The renderer reaches the main process (`src/main`) only through a narrow preload bridge (`src/preload`).
- **TypeScript core** (`src/core`) runs the workflows, research, and budgets. Storage lives in `src/db`, and the search providers in `src/providers`.
- **Rust worker** (`runtime/`) makes each model call and validates the result against a schema.
- **Bun** runs the tooling and tests.

## Contributing

Bug reports and feature requests are welcome in [issues](https://github.com/nylow0/scraply/issues). For code changes, branch from `master` with a `feat/`, `fix/`, `docs/`, or `chore/` prefix and open a pull request back into `master`. The pull request template lists the verification I expect. Agents working in this repository start at [AGENTS.md](AGENTS.md).

## Your OpenAI account

Scraply is an unofficial project and isn't affiliated with or endorsed by OpenAI. When you connect OpenAI, Scraply signs in through the Codex login and uses your own ChatGPT subscription, so your use is covered by [OpenAI's terms](https://openai.com/policies/row-terms-of-use/). OpenAI doesn't officially support this kind of access for third-party apps. It can stop working at any time, and you use it at your own risk. Scraply is free, and I don't run any service or share accounts: every request goes from your computer to your account.

## License

Scraply is released under the [MIT License](LICENSE). The native worker in `runtime/` is licensed under Apache 2.0 and builds on pinned OpenAI Codex libraries; see [runtime/UPSTREAM.md](runtime/UPSTREAM.md) for provenance and notices.
