# Scraply

Scraply turns a rough seed (a hunch, a theme, a link) into an idea that has survived tests against real evidence. It is a command-line tool. `scraply` keeps an append-only evidence ledger, searches the web with Exa or Perplexity, and runs models through a local worker on an OpenAI subscription. A coding agent such as Claude Code or Codex can also drive it step by step through a skill.

It is my personal tool. The source is public, but it is built for my machine and my workflow.

## How a project works

1. The seed is split into claims that could be false, each with the condition that kills it.
2. Before looking, a test is written down: how the claim will be checked, what is predicted, and when the test stops.
3. Evidence is gathered and saved: pages read in full, with exact quotes and who said them. A need holds only with firsthand or measured accounts from two different people, and at least one piece of evidence must be new since the prediction.
4. A separate reviewer checks every verdict without seeing the author's reasoning. Nothing is supported or killed until it does.
5. Ideas are saved with the claims they rest on, and stand or fall with them. You steer the next variant.

The method is in [skills/scraply/SKILL.md](skills/scraply/SKILL.md); the rules the ledger enforces are in [src/cli/ledger.ts](src/cli/ledger.ts).

## Setup

You need Windows and [Bun](https://bun.sh). In the checkout:

```powershell
bun install --frozen-lockfile
bun link
scraply help
scraply login                         # the OpenAI subscription account that runs the model
Get-Clipboard | scraply key set exa   # or perplexity; keys are read from stdin
scraply status
```

The model worker is built from `runtime/` with `bun run prepare:runtime` (Rust's MSVC toolchain and `git submodule update --init --recursive` first).

- **Data.** The ledger is `%APPDATA%\scraply\cli\ledger.db`; `--data-dir` or `SCRAPLY_DATA_DIR` points it elsewhere. Keys and the model account are encrypted in `%APPDATA%\scraply\secrets.bin`. `EXA_API_KEY` and `PERPLEXITY_API_KEY` override the saved keys.
- **Exports.** `scraply export --project P1 --out <file>` writes JSON with every source's full text; `--format markdown` writes a readable report.
- **Agents.** Link `skills/scraply` into your agent's skills folder, for example `~/.claude/skills/`.

## License

Scraply is released under the [MIT License](LICENSE). The worker in `runtime/` is licensed under Apache 2.0 and builds on pinned OpenAI Codex libraries; see [runtime/UPSTREAM.md](runtime/UPSTREAM.md) for provenance and notices. Scraply is an unofficial project and isn't affiliated with or endorsed by OpenAI. It signs in to your own ChatGPT subscription through the Codex login, a kind of access OpenAI does not officially support for third-party tools; it can stop working at any time.
