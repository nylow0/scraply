# Scraply

Scraply is my own command-line tool for turning a rough seed into an idea that has survived tests against evidence. `scraply` (`src/cli`) runs the seed-and-kill-test loop (`src/loop`): it thinks through the Rust worker in `runtime/` on my OpenAI subscription, searches with Exa or Perplexity, writes experiments I approve before they run, and records everything in an append-only evidence ledger. A coding agent calls it through the skill in `skills/scraply/SKILL.md`: by default the loop's model does the research and the agent writes the findings and variants from it (`auto --agent-findings`), and the agent can also do all the thinking itself.

The method comes from my own experience, written down in `prompts/loop/method.md`: ideas come from my seed plus kill tests against raw evidence, not from generating and ranking ideas. It must work for any kind of seed: a product, a research question, a competition project, or a tool for myself.

The desktop GUI is gone. The older research pipeline in `src/core`, `src/db`, and `src/backend` generates and ranks ideas; the loop replaces it, and its stages are retired once nothing uses them.

Scraply is my personal project. The source is public, but I am its only user: build for me, not for hypothetical users, customers, or installs on other machines. What I tell you in the conversation takes priority over this file.

## Product rules

- **Evidence.** A verdict rests on quotes saved verbatim from pages or outputs Scraply captured. Generated text is never evidence, and model confidence is not calibrated. The ledger's rules live in `src/cli/ledger.ts`; enforce a rule there rather than trusting an instruction.
- **Honest results.** A pass can end with nothing surviving or with an inconclusive result; never pad. Failed fetches and searches stay in the record, and unreported usage is unknown, not zero.
- **Local and private.** Everything stays on my computer, with no telemetry. Keys and the model-account credential live encrypted in `%APPDATA%\scraply\secrets.bin` and never appear in argv, output, or logs; `scraply key set` reads keys from stdin.
- **Nothing changes silently.** Reading a project never starts a model or search request. A saved model or effort that is no longer available stays visible and blocks work until I replace it; never pick another one for me. My default, which the skill applies only when no model is saved, is the newest `sol` model at `high` effort.
- **I steer.** The loop stops for my answers, for every experiment script unless I pass `--trust`, and for my choice of variant. It never runs code I have not seen by default, and never swaps my seed for another idea. Experiments run in their own folder with only the environment variables a program needs to start (`src/cli/experiment.ts`), so my keys and tokens never reach model-written code.
- **One worker.** Model calls go only through a verified `scraply-agent.exe` whose hash and version match its lock file (`src/cli/model.ts` lists where it is looked for). Never substitute another runtime after a failure, and never invoke the Codex CLI.

## Protect my setup

This is my everyday computer, and the CLI shares my real setup.

1. **Credentials.** `secrets.bin` holds my real search keys and model account. Signing out, setting a key, or a credential refresh changes them. For tests, point `APPDATA` at an empty folder under `build/` and set `EXA_API_KEY=` and `PERPLEXITY_API_KEY=` empty, unless the task needs live search or the model; then copy `secrets.bin` and `Local State` aside first. Keep real keys out of logs, output, and messages.
2. **Data.** The ledger in `%APPDATA%\scraply\cli` and the desktop database in `%APPDATA%\scraply\scraply` are my real data. Run the CLI against a throwaway `SCRAPLY_DATA_DIR` under `build/` unless I ask otherwise. Open the desktop database read-only, or copy it with `VACUUM INTO`. Its projects are already exported to `%APPDATA%\scraply\desktop-export`.
3. **Processes.** Never kill `bun` or `scraply-agent` by name; other checkouts may be running them.

## Keep my data out of everything published

The repository and its pull requests are public. Whatever reaches GitHub stays readable through old pull requests even after a history rewrite, and only GitHub Support can remove it. This is the most important rule in this file.

My data is anything that comes from me and not from the product: the titles, seeds, and results of my projects, my accounts and keys, my name, email, and Windows user name, and paths on this computer.

Everything you publish is synthetic, invented for the purpose.

- **Fixtures, evaluation cases, and examples.** Write a made-up case. A real project with the details changed, or one named as an example in a prompt, comment, or doc, still points back to me.
- **Text.** Commit messages, pull request descriptions, docs, and logs call cases by their synthetic names and write local paths with placeholders such as `%APPDATA%`. Account output from the worker (email, plan) stays out of them.

Before pushing, read your whole diff for my data. If you find some already committed or published, stop and tell me before doing anything else.

After staging and before every commit, run the secret scan:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/check-secrets.ps1 -Scope staged
```

It covers only the staged patch. `-Scope history` audits history, and belongs in a fresh clone holding the refs that could become public.

## Check every path

Before calling work done, go through this list and say which entries applied:

- **Callers.** Piped output is one JSON envelope on stdout (progress goes to stderr); a terminal gets readable text. An agent following the skill and a person typing commands both work.
- **Accounts.** Search with Exa, Perplexity, or no key; the model signed in, signed out, or with an expired session; the worker present, missing, or failing verification.
- **Saved data.** A ledger change needs a schema version and must say what happens to older ledgers. A change to the backend database keeps its checked pre-migration backup.
- **Contracts.** Zod schemas validate every boundary: CLI input, provider responses, and model output. Runtime protocol changes follow [runtime/AGENTS.md](runtime/AGENTS.md).
- **Docs.** Whether the change makes `README.md`, this file, or the skill inaccurate.

## Setup

Run commands from the checkout you are editing. Scraply is Windows-first. A new checkout or worktree needs `bun install --frozen-lockfile`. Building the worker needs Rust's `stable-x86_64-pc-windows-msvc` toolchain with rustfmt and clippy, the Visual Studio C++ build tools, `git submodule update --init --recursive`, and `bun run prepare:runtime`, which builds, checks, and stages it in `build/runtime`. Without a staged worker, the CLI uses the one the old desktop installer left in `%LOCALAPPDATA%\Programs\scraply\resources\runtime`.

- Merged pull requests never update `master` in the main checkout (the repository root, outside `.worktrees/`). Before running, reviewing, or branching from it, run `git fetch origin` and `git status -sb`, and `git pull --ff-only` when it reports behind.
- Every checkout shares one Cargo cache, `%LOCALAPPDATA%\scraply-build\cargo` (about 9 GB; `CARGO_TARGET_DIR` moves it). Run `prepare:runtime` again only when native source, Cargo dependencies, the pinned submodule, or the runtime protocol changes.
- Removing a worktree that holds the runtime submodule needs `git worktree remove --force`. Confirm `git status` is clean first.
- To debug a backend run, `bun scripts/trace.ts <session ID>` writes its trace read-only to `build/trace/`.

## Verifying

- Write tests that check real workflows and behavior, not ones that mirror the implementation or only assert wiring.
- Run focused tests while working, then `bun run check` before handing off. A few backend workflow tests are timing-sensitive; rerun a failure alone before treating it as real.
- For a CLI change, run `test/integration/cli.test.ts`, then drive the real commands in an isolated profile. For a change to model calls, make a live call on a synthetic seed and look at what came back.
- For a change to the method (the prompts, the loop, or the skill), run `scraply auto` end to end on synthetic seeds of different kinds, read every experiment before approving it, have a fresh agent judge the ideas and the evidence, and report where the loop got stuck or reasoned badly.
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

The only markdown files that belong on GitHub are `README.md`, `AGENTS.md` and `CLAUDE.md` (here and in `runtime/`), the pull request template, the prompts in `prompts/`, the skills in `skills/*/SKILL.md`, and `runtime/UPSTREAM.md`, a license notice. Never commit any other markdown file: no guides, procedures, reports, ADRs, or notes.

- When behavior changes, rewrite or remove the affected text rather than appending to it. Link to source instead of copying it.
- Leave out file catalogs, field lists, and pull request summaries; the code and tests already record them.
- Comments explain how a function or module is used, and move with the code.

## Plans and work artifacts

Keep plans, research notes, transcripts, and scratch files out of the repository: put them under the ignored `build/` directory or outside the checkout. The merged pull request is the implementation record, so verification evidence goes in its description.

## Where code lives

- `src/cli`: the `scraply` commands, the evidence ledger, credentials, and the model session. `skills/scraply`: the skill agents follow.
- `src/loop`: the seed-and-kill-test loop and its model calls. `prompts/loop`: the method and one work order per step.
- `src/providers`: the worker client, Exa, and Perplexity. `runtime/`: the Rust worker; `runtime/vendor/openai-codex` is a read-only pinned submodule.
- `src/core`, `src/db`, `src/backend`, `prompts/workflow-v2-*`: the older research pipeline, its SQLite storage, and its HTTP server. Their code says `thread` for project and `option` for idea.
- `src/shared`: Zod contracts, including the runtime protocol.
- `scripts/`: worker build and packaging checks, the secret scan, and tracing. `test/`: `unit` and `integration`.

## Code style

- Keep solutions simple and build only what the task needs.
- Prefer inferred types, and do not use `any`.
- Call functions directly rather than adding one-line wrappers.
- Validate with Zod at every boundary, and fail closed.
- If a rule here conflicts with the task, tell me before breaking it.
