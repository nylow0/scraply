# Scraply

Scraply turns a rough seed (a hunch, a product, a research question, a project idea) into an idea that has survived tests against real evidence. The thinking is done by the model that calls it, such as Claude Code or Codex. Scraply hands that model one step at a time as a work order, searches the web with Exa or Perplexity, runs small experiments on public data once you approve them, and keeps everything in an append-only evidence ledger whose rules the model cannot argue with. The model calls it as an MCP server (`scraply mcp`) or from the shell through a skill.

It is my personal tool. The source is public, but it is built for my machine and my workflow.

## How a project works

1. The seed is framed the way the best expert in its field would approach it, and a search shows what already exists.
2. It is split into claims that could be false, each with the observation that would kill it.
3. The cheapest decisive claim is tested first, with the test written down before looking: what is predicted, and when the test stops. Claims about people are tested by reading what they say first-hand; claims about how the world behaves, by an experiment with a known-answer sanity check, a control, and held-out data. You read each experiment before it runs.
4. A fresh agent that did not do the work reviews every verdict against the saved evidence. Nothing is supported or killed until it does.
5. What survived, or what a dead claim revealed, becomes the next variant. You choose it.

`scraply next` runs the loop until it needs thinking and returns a work order: the method, the step's instructions, its inputs, the sources to read, and the JSON schema of the answer. `scraply submit` hands the answer back; the ledger checks it, and the loop runs on to the next work order or to something only you can do.

The method and its reasons are in [prompts/loop/method.md](prompts/loop/method.md); the loop is [src/loop/engine.ts](src/loop/engine.ts); the rules the evidence ledger enforces are in [src/cli/ledger.ts](src/cli/ledger.ts).

## Setup

You need [Bun](https://bun.sh). In the checkout:

```powershell
bun install --frozen-lockfile
bun link
Get-Clipboard | scraply key set exa   # or perplexity; keys are read from stdin
claude mcp add scraply -- scraply mcp # or point any MCP client at: scraply mcp
```

Then ask the agent to kill-test a seed. From a shell, the same loop is `scraply project new <name> --seed "..."`, `scraply next --project P1`, and `scraply submit --project P1 --order <id> --answer '<json>'`; `scraply help` lists every command.

- **Data.** The ledger is `%APPDATA%\scraply\cli\ledger.db`; `--data-dir` or `SCRAPLY_DATA_DIR` points it elsewhere. Search keys are encrypted in `%APPDATA%\scraply\secrets.bin`. `EXA_API_KEY` and `PERPLEXITY_API_KEY` override the saved keys.
- **Exports.** `scraply export --project P1 --out <file>` writes JSON with every source's full text; `--format markdown` writes a readable report.
- **Agents.** Link `skills/scraply` into your agent's skills folder, for example `~/.claude/skills/`.

## License

Scraply is released under the [MIT License](LICENSE).
