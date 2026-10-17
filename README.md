# Scraply

Scraply is a Windows desktop app and standalone CLI that find real problems people have and turn them into business ideas you can check against the evidence.

You describe a topic, an audience, or a problem you already know. Scraply searches the web and online communities, extracts candidate problems with quoted sources, and generates ideas for the problems worth solving. A separate pass ranks the ideas for each problem against your approved goal. Everything stays in a local SQLite database, and you decide what to pursue.

**Status:** early development. Download the desktop installer or portable build from the [latest release](https://github.com/nylow0/scraply/releases/latest). The CLI zip is included starting with 0.1.2. Releases are not code-signed yet, so Windows SmartScreen asks for confirmation on first launch (**More info → Run anyway**).

## How a project works

1. **Setup.** Write a brief, then choose the model, research depth, and search provider. Depth guides the breadth and thoroughness of new research; call, search, and time estimates do not stop it.
2. **Research.** Scraply searches with Exa or Perplexity and returns candidate problems. Every claim links to the excerpt and source behind it. You can ask follow-up questions or re-check a finding; a new result only replaces the current evidence when you apply it.
3. **Ideas.** Choose how many ideas to request for each selected problem. Scraply writes and ranks each problem's ideas against your approved goal, and shows when fewer ideas were returned. It never pads the count. You can pause or stop a run. Older saved runs keep their original risk reviews, business-family grouping, and count limits.
4. **Develop an idea.** Discuss an idea, rethink it into a new version while the old ones stay readable, or draft a small experiment that tests one assumption with a metric and pass/fail thresholds.

There are two run modes. **Vibe** (the default) runs research, problem selection, idea generation, and review in one pass. **Controlled** stops after research so you pick the problems and the ideas model yourself.

Research exports as JSON. Ideas export as Markdown or JSON.

## What you need

- Windows 10 or 11
- An OpenAI subscription account, connected in the app or CLI
- An Exa or Perplexity API key for web research, saved in the app or CLI (a run that starts from a known problem can skip search)

## CLI

Extract `scraply-cli-<version>-win-x64.zip` into a directory you want to keep. Leave `scraply.exe`, `runtime/`, `prompts/`, and the license files together. Run `.\scraply.exe help --json` for the command contract. The executable includes Bun and needs no desktop installation.

Desktop and CLI share projects and encrypted credentials in `%APPDATA%\scraply`. Either can be installed first. Only one host owns a profile; the other connects to it, and both versions must match. Use `--data-dir <directory>` for a separate profile. Commands return JSON when piped, and commands that spend money require `--yes` after reviewing their preview.

`.\scraply.exe setup` optionally adds its directory to your user PATH without administrator access. Open a new terminal, then use `scraply`. Run `scraply setup --remove` before moving or removing that directory. Removing the CLI leaves your projects and credentials in place.

## How it's built

- **Electron app** with a Svelte 5 and Tailwind renderer (`src/renderer`). The renderer reaches the main process (`src/main`) only through a narrow preload bridge (`src/preload`).
- **TypeScript core** (`src/core`) runs the workflows, research, and budgets. Storage lives in `src/db`, and the search providers in `src/providers`.
- **Rust worker** (`runtime/`) makes each model call and validates the result against a schema.
- **Bun** runs the tooling and tests.
- **Standalone CLI** (`src/cli`) compiles with Bun and uses the same application service, SQLite data, and verified Rust worker as the desktop.

## Contributing

Bug reports and feature requests are welcome in [issues](https://github.com/nylow0/scraply/issues). For code changes, branch from `master` with a `feat/`, `fix/`, `docs/`, or `chore/` prefix and open a pull request back into `master`. The pull request template lists the verification I expect. Agents working in this repository start at [AGENTS.md](AGENTS.md).

## Your OpenAI account

Scraply is an unofficial project and isn't affiliated with or endorsed by OpenAI. When you connect OpenAI, Scraply signs in through the Codex login and uses your own ChatGPT subscription, so your use is covered by [OpenAI's terms](https://openai.com/policies/row-terms-of-use/). OpenAI doesn't officially support this kind of access for third-party apps. It can stop working at any time, and you use it at your own risk. Scraply is free, and I don't run any service or share accounts: every request goes from your computer to your account.

## License

Scraply is released under the [MIT License](LICENSE). The native worker in `runtime/` is licensed under Apache 2.0 and builds on pinned OpenAI Codex libraries; see [runtime/UPSTREAM.md](runtime/UPSTREAM.md) for provenance and notices.
