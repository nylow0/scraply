# Scraply

Scraply turns a rough seed (a hunch, a theme, a link) into a business idea that has survived tests against real evidence. It is a command-line tool that a coding agent such as Claude Code or Codex drives through a skill. The agent does the thinking. `scraply` searches the web with Exa or Perplexity, saves what it read, and keeps an append-only evidence ledger that refuses anything the agent cannot back with a quote from a saved page.

It is my personal tool. The source is public, but it is built for my machine and my workflow.

## How a project works

1. The seed is split into claims that could be false (a need, a gap, a mechanism, feasibility), each with the condition that kills it.
2. Before looking, the agent writes how it will test a claim, what it predicts, and when the test stops.
3. It searches, reads pages in full, and saves exact quotes with who said them. A need holds only with firsthand or measured accounts from two different people, and at least one piece of evidence must be new since the prediction.
4. A separate agent reviews every verdict without seeing the author's reasoning. Nothing is supported or killed until it does.
5. Ideas are saved with the claims they rest on, and stand or fall with them. You steer the next variant.

The method is in [skills/scraply/SKILL.md](skills/scraply/SKILL.md); the rules the ledger enforces are in [src/cli/ledger.ts](src/cli/ledger.ts).

## Setup

You need Windows and [Bun](https://bun.sh). In the checkout:

```powershell
bun install --frozen-lockfile
bun link
scraply help
```

Then make the skill available to your agent, for example by linking `skills/scraply` into `~/.claude/skills/`.

- **Search keys.** Set `EXA_API_KEY` or `PERPLEXITY_API_KEY`. Without them, `scraply` reads the keys saved by the desktop app, read-only. `scraply status` shows which providers have a key.
- **Data.** The ledger is `%APPDATA%\scraply\cli\ledger.db`. `--data-dir` or `SCRAPLY_DATA_DIR` points it elsewhere.
- **Exports.** `scraply export --project P1 --out <file>` writes JSON with every source's full text; `--format markdown` writes a readable report.

## The desktop app (being retired)

The Electron app in this repository came first and will be removed. `scraply legacy export` exports every project from its database once, read-only: a snapshot of the database plus each project's research JSON and its ideas as JSON and Markdown, written by the app's own exporters, in `%APPDATA%\scraply\desktop-export`.

The app signs in to an OpenAI subscription through the Codex login. Scraply is an unofficial project and isn't affiliated with or endorsed by OpenAI; that kind of access is not officially supported and can stop working at any time.

## License

Scraply is released under the [MIT License](LICENSE). The native worker in `runtime/` is licensed under Apache 2.0 and builds on pinned OpenAI Codex libraries; see [runtime/UPSTREAM.md](runtime/UPSTREAM.md) for provenance and notices.
