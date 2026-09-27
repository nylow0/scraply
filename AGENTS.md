# Scraply

Scraply is a local-first Windows desktop app for finding real problems people have and turning them into business ideas you can check against evidence. It searches the web with Exa or Perplexity, extracts quoted observations, synthesizes candidate problems, generates ideas, and reviews them independently. Everything the user makes lives in SQLite on their own machine.

It is an Electron app with a Svelte 5 renderer, a TypeScript backend, and a small Rust worker that makes every model call.

## What we never compromise on

### 1. Evidence over eloquence

A claim is only as good as the excerpt behind it. Every factor traces to a saved source quote, and generating text never turns it into evidence. Model confidence is not calibration. Results stay honest: a run can finish with a partial set or zero ideas, and that is a real outcome, never something to pad. Unknown stays unknown. Unreported usage is shown as unknown rather than zero, and a request whose completion was lost is never silently replayed.

### 2. Local and private

Projects, sources, and decisions stay on the user's computer. There is no telemetry. Credentials are encrypted with Windows-backed `safeStorage`, and the renderer only ever sees account status and masked key tails. Remote content never gets Electron privileges.

### 3. Bounded spend

Every run carries explicit limits on model calls, searches, and minutes, checked before dispatch. Spend is reserved before a call and settled after it. The user approves the limits; the app never widens them on its own.

### 4. Saved work stays readable

Old projects open and export, including v1 results and older run contracts. A saved run resumes with the prompts it started with. Stored values outlive UI renames: Controlled mode is still stored as `babysit`, because renaming it would rewrite saved projects.

## A note from Dany

I love building complex things as simply as possible. Understand the real constraint, then make the smallest change that makes the correct behavior unsurprising. YAGNI by default, and fight scope creep. Propose bold ideas when they remove work or complexity. Do not keep complexity just because it exists.

The rest of this file is good defaults, not law. What I say in the conversation overrides it. When I ask a question ("why", "should we", "is it"), answer it and wait; do not start editing.

## Glossary

- **you**: the agent reading this file.
- **Dany, we, us**: the maintainer you are working for. "Main branch" means `master`.
- **user**: the person using Scraply.
- **project**: one research workspace. Code calls it a **thread** (`threads`, `threadId`).
- **brief** and **scope**: the setup text, audience, boundaries, and risk criteria the user writes.
- **run**: one launched workflow, stored as a **workflow session** with a `purpose` (`discovery`, `known-problem`, `research-followup`, `idea-turn`), a `mode`, a `state`, and an `outcome` (`src/shared/workflow-contracts.ts`).
- **Vibe** and **Controlled**: run modes. Vibe advances through research, selection, generation, and review on its own. Controlled (`babysit` in code) stops after research for the user's review.
- **stage**: one bounded model step with a prompt file, an output schema, and a deadline. The registry is `src/core/stages.ts`, and the prompts are `prompts/workflow-v2-*.md`.
- **factor**: one quoted observation extracted from a source during factor harvest.
- **problem**: a candidate synthesized from factors, then kept or killed by an independent review. The research view calls a reviewed problem a **finding**.
- **evidence snapshot**: the research that generation uses. A research follow-up only changes it when the user applies the result.
- **idea**: a proposed solution. Code calls it an **option**. A rethink creates a linked **version**.
- **family**: one distinct business. Variants and duplicates join an existing family and do not count toward the target. Code calls this area **opportunity**.
- **focused experiment**: a drafted test of one assumption with a metric, a declared range, and pass/fail thresholds.
- **runtime** or **worker**: the Rust `scraply-agent` process. Its own vocabulary is in [runtime/CONTEXT.md](runtime/CONTEXT.md).

## The ways to hurt yourself

1. **Touching Dany's real accounts.** `bun run dev` shares the installed app's encrypted credentials (`%APPDATA%\scraply\secrets.bin`). Signing out or replacing a key in dev changes Dany's real accounts. For account or key tests, use an isolated profile: a temporary `SCRAPLY_DEV_DATA_DIR`, `SCRAPLY_DEV_SHARED_CREDENTIALS=0`, and empty `EXA_API_KEY=` and `PERPLEXITY_API_KEY=`, because Bun loads `.env` into every `bun` process. Never read, print, or paste a real key.
2. **Spending real money.** Research and generation bill Dany's accounts. Make live provider calls only when the task calls for them, with the smallest limits that prove the point. Prefer the offline UI harness, fixtures, and mock backends.
3. **Writing to live data.** The installed app's projects are Dany's real data. Copy them to test with; never open them read-write. SQLite needs a consistent copy: close the app first, or snapshot with `VACUUM INTO`.
4. **Stopping someone else's server.** Several checkouts may run dev servers at once. Stop only your own, with `bun run dev:stop` from the checkout that started it. Never kill `bun`, `electron`, or `Scraply.exe` by name.
5. **Capturing the screen.** Dany uses this machine while you work. Take screenshots of the app with Playwright `page.screenshot()`, never with a desktop or screen capture.

## Hit every surface

The most common defect is a change that works on the path you tested and is missing everywhere else. Before calling work done, walk this list and say which entries applied:

- **Hosts.** Browser dev and the Electron desktop app share handlers, but windows, dialogs, permissions, preload, and window state exist only in Electron. The installed app runs packaged paths and the bundled worker.
- **Run shapes.** Vibe and Controlled; discovery and known-problem (which can run without search); research follow-ups and idea conversations.
- **Search providers.** Exa, Perplexity, and none configured.
- **Saved work.** v1 projects, older run contracts, and interrupted checkpoints. A change to stored data needs a migration and still has to read old rows.
- **Contracts.** Zod schemas in `src/shared` cross every process boundary. A stage change moves its prompt, schema, and package checks together. A runtime protocol change follows [runtime/AGENTS.md](runtime/AGENTS.md).
- **Exports.** Research JSON, and ideas as JSON and Markdown.
- **Reverse states.** A way in needs a way out and a way to see it: pause and resume, apply and keep, archive and restore.
- **Docs.** Check whether the change makes a user guide inaccurate (see [Documentation](#documentation)).

## Dev servers

- First-time setup and every environment variable are in the [development guide](docs/maintainers/development.md).
- `bun run dev` starts a background server and prints its URL. Running it again reuses the server. Keep it running and give Dany the URL and checkout path at handoff.
- `bun run test:ui` serves the real renderer on synthetic data at `http://127.0.0.1:5176`, with no providers. It is the fastest way to reach and screenshot UI states; the development guide lists its query parameters.
- Agent hosts often export `ELECTRON_RUN_AS_NODE=1`, which breaks Electron. Unset it for `dev`, `build:installed`, and e2e runs.
- Run throwaway Playwright scripts with `node`; they hang under `bun`.

## Verifying

- Verify the interaction you changed in the browser and look at the visible result. Compiling and passing unit tests are not UI verification.
- Tests check real workflows and behavior. Skip tests that mirror the implementation or only assert wiring.
- Run focused tests while working, then `bun run check` before handing off application code.
- After an application change, stop dev, run `bun run build:installed` from the checkout root, then restart dev. Skip this for documentation-only work and read-only investigation.
- Changes to Electron windows, preload, permissions, dialogs, or desktop integration also need an explicit `bun run dev:electron` check.
- Read the whole Playwright summary. A failing spec can print just above the "passed" line; search the log for `failed` and `flaky`.
- `bun run build:installed` aborts if `HEAD` moves while it runs. Commit before you start it.
- Report what you exercised, the results, and anything you could not verify.

## Branches and pull requests

- `master` is the only long-lived branch and the production branch. Every change goes through a short-lived `feat/`, `fix/`, `docs/`, or `chore/` branch from the latest `master` and a pull request into `master`.
- Work in a worktree under `.worktrees/`. Remove it after its pull request merges.
- When several of Dany's pull requests are open at once, stack them so one installed build contains all of them. Rebase with `git rebase --update-refs`.
- Commit titles follow conventional commits in plain language: `fix: keep the selected idea after reload`.
- Fill in the pull request template: what changed for the user, and how you verified it.
- UI changes need screenshots. Push them to the never-merged `pr-screenshots` branch and link them from the description.
- Read the [release guide](docs/maintainers/release.md) before touching versions, tags, release workflows, signing, or rollback. Update it in the same pull request when the process changes.

## Documentation

Most code changes need no documentation change. Agents can read the code.

- `docs/user/` helps users get tasks done, in the product's voice: what a feature does, how to start, and anything unintuitive. Leave out implementation details and contributor tooling. A UI tweak needs no documentation entry.
- `docs/maintainers/` holds development, release, and evaluation procedures.
- `runtime/` keeps its own README, vocabulary, and ADRs.
- When behavior changes, rewrite or remove the affected text instead of appending an account of the new behavior. Link to the source instead of copying it.
- Skip file catalogs, field lists, and pull request summaries. Types, tests, and code already record them.
- Comments describe how a function or module is used, and move when the code moves.

## Plans and work artifacts

Keep plans, research notes, acceptance transcripts, and scratch files out of the repository. Put them under the ignored `build/` directory or outside the checkout. The merged pull request is the implementation record; put acceptance evidence in its description.

## How it works

The renderer talks to the main process only through the preload bridge (`window.scraply`). Main owns windows, credentials, and the security policy, and forks the backend as an Electron utility process. The backend is a local HTTP server (`src/backend`) that runs workflows (`src/core`) over SQLite (`src/db`) and the search providers (`src/providers`).

A run starts as an editable launch draft. A preview turns it into an immutable contract with its limits, models, and resolved prompts. The coordinator schedules its stages, reserves spend before each call, and checkpoints each completed stage so the run can resume. Each model call goes to the Rust worker over JSONL on stdin and stdout. The worker validates the output against the stage's schema before returning it.

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

## Taste

- Simple over clever. Choose the smallest model that makes the behavior obvious.
- Inferred types over annotations. `any` is the enemy.
- Keep functions that carry real logic. Call the underlying thing directly instead of adding a one-line wrapper.
- Validate at every boundary with Zod, and fail closed.
- The UI is dark, with a pure black background (`--bg: #000000`). Reuse the tokens in `src/renderer/app.css`.
- `.main-content` in `App.svelte` is the only scroll container. A page with a sticky action bar uses a flex column, not a grid. Tailwind's preflight strips list markers and heading sizes, so restate them where content needs them.
- If a rule here fights the task in front of you, say so plainly and get Dany's sign-off before breaking it.
