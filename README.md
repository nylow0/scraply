# Scraply

Scraply turns a rough seed (a hunch, a product, a research question, a project idea) into an idea that has survived tests against real evidence. It is a command-line tool that thinks with a model on your OpenAI subscription, searches the web with Exa or Perplexity, writes and runs small experiments on public data once you approve them, and keeps everything in an append-only evidence ledger. A coding agent such as Claude Code or Codex can run it for you, or do the thinking itself, through a skill.

It is my personal tool. The source is public, but it is built for my machine and my workflow.

## How a project works

1. The seed is framed the way the best expert in its field would approach it, and a search shows what already exists.
2. It is split into claims that could be false, each with the observation that would kill it.
3. The cheapest decisive claim is tested first, with the test written down before looking: what is predicted, and when the test stops. Claims about people are tested by reading what they say first-hand; claims about how the world behaves, by an experiment with a known-answer sanity check, a control, and held-out data. You read each experiment before it runs.
4. A separate review checks every verdict against the saved evidence. Nothing is supported or killed until it does.
5. What survived, or what a dead claim revealed, becomes the next variant. You choose it.

The method and its reasons are in [prompts/loop/method.md](prompts/loop/method.md); the loop is [src/loop/engine.ts](src/loop/engine.ts); the rules the evidence ledger enforces are in [src/cli/ledger.ts](src/cli/ledger.ts).

## Setup

You need Windows and [Bun](https://bun.sh). In the checkout:

```powershell
bun install --frozen-lockfile
bun link
scraply help
scraply login                         # the OpenAI subscription account that runs the model
Get-Clipboard | scraply key set exa   # or perplexity; keys are read from stdin
scraply models                        # then pick one:
scraply config model <id> --effort high
scraply project new <name> --seed "your seed, in your words"
scraply auto --project P1             # runs until it needs you, then says what it needs
```

The model worker is built from `runtime/` with `bun run prepare:runtime` (Rust's MSVC toolchain and `git submodule update --init --recursive` first).

- **Data.** The ledger is `%APPDATA%\scraply\cli\ledger.db`; `--data-dir` or `SCRAPLY_DATA_DIR` points it elsewhere. Keys and the model account are encrypted in `%APPDATA%\scraply\secrets.bin`. `EXA_API_KEY` and `PERPLEXITY_API_KEY` override the saved keys.
- **Exports.** `scraply export --project P1 --out <file>` writes JSON with every source's full text; `--format markdown` writes a readable report.
- **Agents.** Link `skills/scraply` into your agent's skills folder, for example `~/.claude/skills/`.

## License

Scraply is released under the [MIT License](LICENSE). The worker in `runtime/` is licensed under Apache 2.0 and builds on pinned OpenAI Codex libraries; see [runtime/UPSTREAM.md](runtime/UPSTREAM.md) for provenance and notices. Scraply is an unofficial project and isn't affiliated with or endorsed by OpenAI. It signs in to your own ChatGPT subscription through the Codex login, a kind of access OpenAI does not officially support for third-party tools; it can stop working at any time.
