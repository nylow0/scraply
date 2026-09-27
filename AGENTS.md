# Scraply

Scraply is a local-first Windows desktop app for finding real problems people have and turning them into business ideas you can check against evidence. It searches the web with Exa or Perplexity, extracts quoted observations, synthesizes candidate problems, generates ideas, and reviews them independently. Everything a user makes lives in SQLite on their own machine.

It is an Electron app with a Svelte 5 renderer, a TypeScript backend, and a small Rust worker that makes every model call.

I maintain Scraply alone. What I tell you in the conversation takes priority over this file.

## Product rules

- **Evidence.** Every factor traces to a saved source quote. Generated text is never evidence, and model confidence is not calibrated.
- **Honest results.** A run can finish with a partial set or zero ideas; never pad the count. Unreported usage shows as unknown, not zero. A request whose completion was lost is never replayed automatically.
- **Local and private.** Projects stay on the user's computer, with no telemetry. Credentials are encrypted with Windows `safeStorage`, and the renderer only sees account status and masked key tails. Remote pages never get Electron privileges.
- **Bounded spend.** Every run has limits on model calls, searches, and minutes, checked before dispatch. Spend is reserved before a call and settled after it. The app never raises a limit without the user's approval.
- **Saved work stays readable.** Old projects, including v1 results and older run contracts, still open and export. A saved run resumes with the prompts it started with. Stored values outlive UI renames: Controlled mode is still stored as `babysit`.

## Terms

The UI and the code sometimes use different names.

| UI | Code | Meaning |
| --- | --- | --- |
| project | `thread` | One research workspace. |
| brief, scope | `brief`, `scope` | The setup text, audience, boundaries, and risk criteria. |
| run | workflow session | One launched workflow with a `purpose`, `mode`, `state`, and `outcome` (`src/shared/workflow-contracts.ts`). |
| Vibe | `vibe` | Runs research, selection, generation, and review on its own. |
| Controlled | `babysit` | Stops after research for the user's review. |
| stage | stage | One bounded model step: a prompt in `prompts/workflow-v2-*.md`, an output schema, and a deadline, registered in `src/core/stages.ts`. |
| factor | factor | One quoted observation extracted from a source. |
| problem, finding | problem candidate | A problem synthesized from factors, then kept or killed by an independent review. |
| evidence snapshot | snapshot | The research generation uses. A follow-up changes it only when the user applies the result. |
| idea | `option` | A proposed solution. A rethink creates a linked version. |
| family | opportunity | One distinct business. Variants and duplicates join a family and do not count toward the target. |
| focused experiment | focused experiment | A test of one assumption with a metric, a declared range, and pass/fail thresholds. |

The Rust worker has its own vocabulary in [runtime/CONTEXT.md](runtime/CONTEXT.md).

## Protect my setup

This is my everyday computer, and dev shares parts of my real setup.

1. **Credentials.** `bun run dev` uses the installed app's encrypted credentials (`%APPDATA%\scraply\secrets.bin`), so signing out or replacing a key in dev changes my real accounts. For account or key tests, use an isolated profile: a temporary `SCRAPLY_DEV_DATA_DIR`, `SCRAPLY_DEV_SHARED_CREDENTIALS=0`, and empty `EXA_API_KEY=` and `PERPLEXITY_API_KEY=` (Bun loads `.env` into every `bun` process). Keep real keys out of logs, output, and messages.
2. **Money.** Research and generation bill my accounts. Make live provider calls only when the task needs them, with the smallest limits that prove the point. Prefer the offline UI harness, fixtures, and mock backends.
3. **Data.** The installed app's projects are my real data. Test on a copy, and open the original read-only. Copy SQLite with the app closed, or snapshot it with `VACUUM INTO`.
4. **Other servers.** Several checkouts may run dev servers at once. Stop only your own, with `bun run dev:stop` from the checkout that started it. Never kill `bun`, `electron`, or `Scraply.exe` by name.
5. **Screenshots.** I use this machine while you work. Capture the app with Playwright `page.screenshot()`, never the desktop.

## Check every path

A change often works on the path you tested and breaks somewhere else. Before calling work done, go through this list and say which entries applied:

- **Hosts.** Browser dev and the Electron app share handlers, but windows, dialogs, permissions, preload, and window state exist only in Electron. The installed app uses packaged paths and the bundled worker.
- **Run types.** Vibe and Controlled; discovery and known-problem (which can run without search); research follow-ups and idea conversations.
- **Search providers.** Exa, Perplexity, and none configured.
- **Saved work.** v1 projects, older run contracts, and interrupted checkpoints. A change to stored data needs a migration and must still read old rows.
- **Contracts.** Zod schemas in `src/shared` cross every process boundary. A stage change updates its prompt, schema, and package checks together. Runtime protocol changes follow [runtime/AGENTS.md](runtime/AGENTS.md).
- **Exports.** Research JSON, and ideas as JSON and Markdown.
- **Undo paths.** Pause needs resume, apply needs keep, archive needs restore, and each state needs to be visible.
- **Docs.** Whether the change makes a user guide inaccurate (see [Documentation](#documentation)).

## Dev servers

- Setup and environment variables are in the [development guide](docs/dev/development.md).
- `bun run dev` starts a background server and prints its URL. Running it again reuses the server. Leave it running and give me the URL and checkout path at handoff.
- `bun run test:ui` serves the real renderer on synthetic data at `http://127.0.0.1:5176`, with no providers. It is the fastest way to reach and screenshot UI states; the development guide lists its query parameters.
- Agent hosts often export `ELECTRON_RUN_AS_NODE=1`, which breaks Electron. Unset it for `dev`, `build:installed`, and e2e runs.
- Run throwaway Playwright scripts with `node`; they hang under `bun`.

## Verifying

- Exercise the interaction you changed in the browser and look at the result. Compiling and passing unit tests are not UI verification.
- Write tests that check real workflows and behavior, not ones that mirror the implementation or only assert wiring.
- Run focused tests while working, then `bun run check` before handing off application code.
- After an application change, stop dev, run `bun run build:installed` from the checkout root, then restart dev. Skip this for documentation-only work and read-only investigation.
- Changes to Electron windows, preload, permissions, dialogs, or desktop integration also need a `bun run dev:electron` check.
- Read the whole Playwright summary. A failing spec can print just above the "passed" line; search the log for `failed` and `flaky`.
- `bun run build:installed` aborts if `HEAD` moves while it runs. Commit before starting it.
- Report what you exercised, the results, and anything you could not verify.

## Branches and pull requests

- `master` is the only long-lived branch and the production branch; "main branch" means `master`. Every change goes through a short-lived `feat/`, `fix/`, `docs/`, or `chore/` branch from the latest `master` and a pull request into `master`.
- Work in a worktree under `.worktrees/`, and remove it after its pull request merges.
- When several of my pull requests are open at once, stack them so one installed build contains all of them. Rebase with `git rebase --update-refs`.
- Commit titles use conventional commits in plain language: `fix: keep the selected idea after reload`.
- Fill in the pull request template: what changed for the user, and how you verified it.
- UI changes need screenshots. Push them to the never-merged `pr-screenshots` branch and link them from the description.
- Read the [release guide](docs/dev/release.md) before touching versions, tags, release workflows, signing, or rollback, and update it in the same pull request when the process changes.

## Documentation

Most code changes need no documentation change.

- `docs/user/` helps users get tasks done: what a feature does, how to start, and anything unintuitive. Keep implementation details and contributor tooling out of it. A UI tweak needs no entry.
- `docs/dev/` holds development, release, and evaluation procedures.
- `runtime/` keeps its own README, vocabulary, and ADRs.
- When behavior changes, rewrite or remove the affected text rather than appending to it. Link to source instead of copying it.
- Leave out file catalogs, field lists, and pull request summaries; the code and tests already record them.
- Comments explain how a function or module is used, and move with the code.

## Plans and work artifacts

Keep plans, research notes, acceptance transcripts, and scratch files out of the repository: put them under the ignored `build/` directory or outside the checkout. The merged pull request is the implementation record, so acceptance evidence goes in its description.

## How it works

The renderer talks to the main process only through the preload bridge (`window.scraply`). Main owns windows, credentials, and the security policy, and forks the backend as an Electron utility process. The backend is a local HTTP server (`src/backend`) that runs workflows (`src/core`) over SQLite (`src/db`) and the search providers (`src/providers`).

A run starts as an editable launch draft. A preview turns it into an immutable contract with its limits, models, and resolved prompts. The coordinator schedules its stages, reserves spend before each call, and checkpoints each completed stage so the run can resume. Each model call goes to the Rust worker over JSONL on stdin and stdout, and the worker validates the output against the stage's schema before returning it.

In browser dev, a windowless Electron host serves the same handlers to a browser tab through a local proxy.

## Where code lives

- `src/renderer`: Svelte 5 UI. `src/preload`: the bridge. `src/main`: Electron shell, credentials, security.
- `src/backend`: the local server. `src/core`: workflows, stages, scheduling, reviews.
- `src/db`: SQLite client, migrations, repositories. `src/providers`: Exa, Perplexity, runtime client.
- `src/shared`: Zod contracts shared across processes.
- `prompts/`: bundled stage prompts, shipped with the app.
- `runtime/`: the Rust worker. `runtime/vendor/openai-codex` is a read-only pinned submodule.
- `scripts/`: dev server, packaging, verification, release checks.
- `test/`: `unit`, `integration`, `renderer`, `e2e`, and the offline `ui` harness.

## Code style

- Keep solutions simple and build only what the task needs.
- Prefer inferred types, and do not use `any`.
- Call functions directly rather than adding one-line wrappers.
- Validate with Zod at every boundary, and fail closed.
- The UI is dark with a pure black background (`--bg: #000000`). Reuse the tokens in `src/renderer/app.css`.
- `.main-content` in `App.svelte` is the only scroll container. A page with a sticky action bar uses a flex column, not a grid. Tailwind's preflight strips list markers and heading sizes, so restate them where content needs them.
- If a rule here conflicts with the task, tell me before breaking it.
