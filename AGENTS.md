# Scraply

Scraply is my own command-line tool for turning a rough seed into an idea that has survived tests against evidence. `scraply` (`src/cli`) runs the seed-and-kill-test loop (`src/loop`): it searches with Exa or Perplexity, runs experiments I approve before they run, and records everything in an append-only evidence ledger. Scraply never calls a model. The coding agent that calls it does all the thinking: `scraply next` hands it one step as a work order and `scraply submit` takes the answer back through the ledger's rules. The agent calls it as an MCP server (`scraply mcp`, `src/cli/mcp.ts`) or from the shell, following the skill in `skills/scraply/SKILL.md`.

The method comes from my own experience, written down in `prompts/loop/method.md`: ideas come from my seed plus kill tests against raw evidence, not from generating and ranking ideas. It must work for any kind of seed: a product, a research question, a competition project, or a tool for myself.

Scraply is my personal project. The source is public, but I am its only user: build for me, not for hypothetical users, customers, or installs on other machines. What I tell you in the conversation takes priority over this file.

## Product rules

- **Evidence.** A verdict rests on quotes saved verbatim from pages or outputs Scraply captured. Generated text is never evidence, and model confidence is not calibrated. The ledger's rules live in `src/cli/ledger.ts`; enforce a rule there rather than trusting an instruction.
- **Honest results.** A pass can end with nothing surviving or with an inconclusive result; never pad. Failed fetches and searches stay in the record, and unreported usage is unknown, not zero.
- **Local and private.** Everything stays on my computer, with no telemetry. Search keys live encrypted in `%APPDATA%\scraply\secrets.bin` and never appear in argv, output, logs, or MCP tools; `scraply key set` reads keys from stdin and is not served over MCP.
- **Nothing changes silently.** Reading a project never starts a search request. An answer is applied only to the work order it was written for, and a refused answer changes nothing.
- **I steer.** The loop stops for my answers, for every experiment script unless I pass `--trust`, and for my choice of variant. It never runs code I have not seen by default, and never swaps my seed for another idea. Experiments run in their own folder with only the environment variables a program needs to start (`src/cli/experiment.ts`), so my keys and tokens never reach agent-written code.
- **Independent review.** A review work order is marked `independent`: the agent that did the work hands it to a fresh subagent. Inside the loop that is the only safeguard; the ledger's own check refuses a review only when it is signed with the verdict author's name, which matters for reviews recorded by hand.

## Protect my setup

This is my everyday computer, and the CLI shares my real setup.

1. **Credentials.** `secrets.bin` holds my real search keys. Setting or removing a key changes them. For tests, point `APPDATA` at an empty folder under `build/` and set `EXA_API_KEY=` and `PERPLEXITY_API_KEY=` empty, unless the task needs live search; then copy `secrets.bin` and `Local State` aside first. Keep real keys out of logs, output, and messages.
2. **Data.** The ledger in `%APPDATA%\scraply\cli` is my real data, and so is the old desktop database in `%APPDATA%\scraply\scraply` (already exported to `%APPDATA%\scraply\desktop-export`; nothing reads it now). Run the CLI against a throwaway `SCRAPLY_DATA_DIR` under `build/` unless I ask otherwise.
3. **Processes.** Never kill `bun` by name; other checkouts may be running it.

## Keep my data out of everything published

The repository and its pull requests are public. Whatever reaches GitHub stays readable through old pull requests even after a history rewrite, and only GitHub Support can remove it. This is the most important rule in this file.

My data is anything that comes from me and not from the product: the titles, seeds, and results of my projects, my accounts and keys, my name, email, and Windows user name, and paths on this computer.

Everything you publish is synthetic, invented for the purpose.

- **Fixtures, evaluation cases, and examples.** Write a made-up case. A real project with the details changed, or one named as an example in a prompt, comment, or doc, still points back to me.
- **Text.** Commit messages, pull request descriptions, docs, and logs call cases by their synthetic names and write local paths with placeholders such as `%APPDATA%`.

Before pushing, read your whole diff for my data. If you find some already committed or published, stop and tell me before doing anything else.

After staging and before every commit, run the secret scan:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/check-secrets.ps1 -Scope staged
```

It covers only the staged patch. `-Scope history` audits history, and belongs in a fresh clone holding the refs that could become public.

## Check every path

Before calling work done, go through this list and say which entries applied:

- **Callers.** Piped output is one JSON envelope on stdout (progress goes to stderr); a terminal gets readable text; `scraply mcp` serves the same commands as MCP tools. An agent over MCP, an agent in a shell following the skill, and a person typing commands all work.
- **Accounts.** Search with Exa, Perplexity, or no key.
- **Saved data.** A ledger change needs a schema version and must say what happens to older ledgers, including step logs older code wrote.
- **Contracts.** Zod schemas validate every boundary: CLI input, MCP tool arguments, provider responses, and the agent's answers.
- **Docs.** Whether the change makes `README.md`, this file, or the skill inaccurate.

## Setup

Run commands from the checkout you are editing. Scraply is Windows-first. A new checkout or worktree needs `bun install --frozen-lockfile`.

- Merged pull requests never update `master` in the main checkout (the repository root, outside `.worktrees/`). Before running, reviewing, or branching from it, run `git fetch origin` and `git status -sb`, and `git pull --ff-only` when it reports behind.

## Verifying

- Write tests that check real workflows and behavior, not ones that mirror the implementation or only assert wiring.
- Run focused tests while working, then `bun run check` before handing off.
- For a CLI change, run `test/integration/cli.test.ts`, then drive the real commands in an isolated profile. For an MCP change, also connect a real MCP client to `scraply mcp`.
- For a change to the method (the prompts, the loop, or the skill), work a pass end to end with `next` and `submit` on synthetic seeds of different kinds, read every experiment before approving it, have a fresh agent judge the ideas and the evidence, and report where the loop got stuck or the work orders misled you.
- Report what you exercised, the results, and anything you could not verify.

## Branches and pull requests

- `master` is the only long-lived branch. Every change goes through a short-lived `feat/`, `fix/`, `docs/`, or `chore/` branch from the latest `master` and a pull request into `master`.
- Work in a worktree under `.worktrees/`, and remove it after its pull request merges.
- When several of my pull requests are open at once, stack them. Rebase with `git rebase --update-refs`.
- Commit titles use conventional commits in plain language: `fix: keep the selected idea after reload`.
- Fill in the pull request template: what changed, and how you verified it.
- Never force-push `master` or move a published tag. There is no hosted CI; run every check locally.

## Releases

There are none. I run Scraply from this checkout with `bun link`. Old desktop releases stay on GitHub as they are: never replace their files.

## Documentation

The only markdown files that belong on GitHub are `README.md`, `AGENTS.md`, `CLAUDE.md`, the pull request template, the prompts in `prompts/`, and the skills in `skills/*/SKILL.md`. Never commit any other markdown file: no guides, procedures, reports, ADRs, or notes.

- When behavior changes, rewrite or remove the affected text rather than appending to it. Link to source instead of copying it.
- Leave out file catalogs, field lists, and pull request summaries; the code and tests already record them.
- Comments explain how a function or module is used, and move with the code.

## Plans and work artifacts

Keep plans, research notes, transcripts, and scratch files out of the repository: put them under the ignored `build/` directory or outside the checkout. The merged pull request is the implementation record, so verification evidence goes in its description.

## Where code lives

- `src/cli`: the `scraply` commands, the MCP server, the evidence ledger, and credentials. `skills/scraply`: the skill agents follow.
- `src/loop`: the seed-and-kill-test loop (`engine.ts`) and its work orders (`think.ts`). `prompts/loop`: the method and the instructions for each step.
- `src/providers`: Exa and Perplexity. `src/shared`: the source schema and the Zod-to-JSON-Schema converter for work orders.
- `scripts/`: the secret scan. `test/`: `unit` and `integration`.

## Code style

- Keep solutions simple and build only what the task needs.
- Prefer inferred types, and do not use `any`.
- Call functions directly rather than adding one-line wrappers.
- Validate with Zod at every boundary, and fail closed.
- If a rule here conflicts with the task, tell me before breaking it.
