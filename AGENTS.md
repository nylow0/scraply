# Scraply

Scraply is a local-first Windows desktop app for finding real problems people have and turning them into business ideas you can check against evidence. It searches the web with Exa or Perplexity, extracts quoted observations, synthesizes candidate problems, generates ideas, and reviews them independently. Everything a user makes lives in SQLite on their own machine.

It is an Electron app with a Svelte 5 renderer, a TypeScript backend, and a small Rust worker that makes every model call.

I maintain Scraply alone. What I tell you in the conversation takes priority over this file.

## Product rules

- **Evidence.** Every factor traces to a saved source quote. Generated text is never evidence, and model confidence is not calibrated.
- **Honest results.** A run can finish with a partial set or zero ideas; never pad the count. Unreported usage shows as unknown, not zero. A request whose completion was lost is never replayed automatically, with two exceptions: a research call the app stopped waiting on at its own time limit, and a model call whose stream dropped, which is started over up to twice after a short pause. Their results are never used, and their usage stays unknown. A third drop ends only its research area, or stops the run for review during ideas.
- **Local and private.** Projects stay on the user's computer, with no telemetry. Credentials are encrypted with Windows `safeStorage`, and the renderer only sees account status and masked key tails. Remote pages never get Electron privileges.
- **Depth-guided work.** New research uses depth to guide breadth and thoroughness; call and search estimates do not stop it. Idea generations wait for provider completion, failure, or user cancellation. Research calls have per-stage time limits (`src/core/workflow-execution.ts`): a timed-out call is retried once, an evidence read stops after 90 seconds and starts over once before splitting its sources, and a failed model answer, including a call whose stream dropped three times, ends only its own area. Preserve usage accounting and older saved count limits.
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
| stage | stage | One model step: a prompt in `prompts/workflow-v2-*.md` and an output schema, registered in `src/core/stages.ts`. |
| factor | factor | One quoted observation extracted from a source. |
| problem, finding | problem candidate | A problem synthesized from factors, then kept or killed by an independent review. |
| evidence snapshot | snapshot | The research generation uses. A follow-up changes it only when the user applies the result. |
| idea | `option` | A proposed solution. A rethink creates a linked version. |
| family | opportunity | One distinct business. Variants and duplicates join a family and do not count toward the target. |
| focused experiment | focused experiment | A test of one assumption with a metric, a declared range, and pass/fail thresholds. |

## Protect my setup

This is my everyday computer, and dev shares parts of my real setup.

1. **Credentials.** `bun run dev` uses the installed app's encrypted credentials (`%APPDATA%\scraply\secrets.bin`), so signing out or replacing a key in dev changes my real accounts. For account or key tests, use an isolated profile: a temporary `SCRAPLY_DEV_DATA_DIR`, `SCRAPLY_DEV_SHARED_CREDENTIALS=0`, and empty `EXA_API_KEY=` and `PERPLEXITY_API_KEY=` (Bun loads `.env` into every `bun` process). Keep real keys out of logs, output, and messages.
2. **Money.** Research and generation bill my accounts. Make live provider calls only when the task needs them, with the smallest limits that prove the point. Prefer the offline UI harness, fixtures, and mock backends.
3. **Data.** The installed app's projects are my real data. Test on a copy, and open the original read-only. Copy SQLite with the app closed, or snapshot it with `VACUUM INTO`.
4. **Other servers.** Several checkouts may run dev servers at once. Stop only your own, with `bun run dev:stop` from the checkout that started it. Never kill `bun`, `electron`, or `Scraply.exe` by name.
5. **Screenshots.** I use this machine while you work. Capture the app with Playwright `page.screenshot()`, never the desktop.

## Keep my data out of everything published

The repository, its pull requests, and every release are public. Whatever reaches GitHub stays readable through old pull requests even after a history rewrite, and only GitHub Support can remove it. This is the most important rule in this file.

My data is anything that comes from me and not from the product: the titles, briefs, and results of my projects, my accounts and keys, my name, email, and Windows user name, and paths on this computer.

Everything you publish is synthetic, invented for the purpose.

- **Fixtures, evaluation cases, and examples.** Write a made-up case. A real project with the details changed, or one named as an example in a prompt, comment, or doc, still points back to me.
- **Screenshots.** Capture them from `bun run test:ui` or an isolated profile. The sidebar lists project titles, so any screen captured in my real profile exposes them.
- **Text.** Commit messages, pull request descriptions, docs, and logs call cases by their synthetic names and write local paths with placeholders such as `%APPDATA%`.
- **Builds.** A release holds only what the package allowlist names, and nothing that identifies the computer that built it.

Before pushing, read your whole diff and look at every image for my data. If you find some already committed or published, stop and tell me before doing anything else.

After staging and before every commit, run the secret scan:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/check-secrets.ps1 -Scope staged
```

It covers only the staged patch. `-Scope history` audits history, and belongs in a fresh clone holding the refs that could become public.

## Check every path

A change often works on the path you tested and breaks somewhere else. Before calling work done, go through this list and say which entries applied:

- **Hosts.** Browser dev and the Electron app share handlers, but windows, dialogs, permissions, preload, and window state exist only in Electron. The installed app uses packaged paths and the bundled worker.
- **Run types.** Vibe and Controlled; discovery and known-problem (which can run without search); research follow-ups and idea conversations.
- **Search providers.** Exa, Perplexity, and none configured.
- **Saved work.** v1 projects, older run contracts, and interrupted checkpoints. A change to stored data needs a migration and must still read old rows.
- **Contracts.** Zod schemas in `src/shared` cross every process boundary. A stage change updates its prompt, schema, and package checks together. Runtime protocol changes follow [runtime/AGENTS.md](runtime/AGENTS.md).
- **Prompts.** Package verification rejects a missing stage prompt and a superseded one. A user can override a bundled prompt with a same-named file in the data folder's `prompts` directory; on upgrade the app backs up unchanged old copies and retired overrides, and leaves custom overrides of active prompts in place.
- **Exports.** Research JSON, and ideas as JSON and Markdown.
- **Undo paths.** Pause needs resume, apply needs keep, archive needs restore, and each state needs to be visible.
- **Docs.** Whether the change makes `README.md` or this file inaccurate (see [Documentation](#documentation)).

## Setup

Scraply is Windows-first. Native builds need Rust's `stable-x86_64-pc-windows-msvc` toolchain with rustfmt and clippy, and the Visual Studio C++ build tools. A new checkout or worktree needs:

```powershell
bun install --frozen-lockfile
bunx --no-install install-electron
git submodule update --init --recursive
bun run prepare:runtime
```

- Electron downloads its executable on demand. Run `install-electron` again when dev or a test reports a missing Electron executable.
- `prepare:runtime` builds, checks, and stages the Rust worker in `build/runtime`. Run it again only when the stage is missing or when native source, Cargo dependencies, the pinned submodule, or runtime build or protocol configuration changes.
- Every checkout shares one Cargo cache, `%LOCALAPPDATA%\scraply-build\cargo` (about 9 GB; `CARGO_TARGET_DIR` moves it). To preview UI edits in an extra worktree, reuse a prepared worker by setting both `SCRAPLY_AGENT_PATH` and `SCRAPLY_AGENT_LOCK_PATH` before starting dev, and only when its native code and protocol match that checkout.
- `SCRAPLY_SKIP_RUNTIME_CHECKS=1` before `bun run build:installed` skips the Rust formatting, budget, test, and clippy gates for an implementation-only local build. It gives no test or release evidence, and strict release builds reject it.
- Removing a worktree that holds the runtime submodule needs `git worktree remove --force`. Confirm `git status` is clean first.

## Dev servers

- `bun run dev` starts a background server and prints its URL, normally `http://127.0.0.1:5173`. Running it again reuses the server. Leave it running and give me the URL and checkout path at handoff.
- If the port is taken, startup fails rather than stopping the other process. Set `SCRAPLY_BROWSER_UI_PORT` (1024 to 65535) before starting, and keep it set when you run `dev:stop`.
- Renderer edits update the browser on save. Main-process and backend edits restart the host, so reload the browser. Restart dev after changing environment variables, startup configuration, or the prepared worker.
- Dev keeps its projects in `.scraply/browser-dev/` and its log and launch state in `build/browser-dev/`. After an account or key change, restart any other running Scraply instance.
- `bun run test:ui` serves the real renderer on synthetic data at `http://127.0.0.1:5176`, with no providers. It is the fastest way to reach and screenshot UI states. Query parameters pick the state, for example `?history=18&long=1`, `history=0`, `progress=guided`, `connection=offline`, `account=signed-out`, and `search=none`; `test/ui/main.ts` reads all of them. Reloading resets the fixture.
- `bun run dev:electron` is the desktop check. Stop browser dev first.
- `bun run test:e2e` prepares the runtime and packages an app before Playwright runs. It is not a lightweight browser check.
- Agent hosts often export `ELECTRON_RUN_AS_NODE=1`, which breaks Electron. Unset it for `dev`, `build:installed`, and e2e runs.
- Run throwaway Playwright scripts with `node`; they hang under `bun`.
- To debug a run, write its trace with `bun scripts/trace.ts <session ID>`. The session ID is in the app's Run details. The script opens the database read-only, contacts no provider, and writes `build/trace/<session ID>.json`. It reads the installed app's database by default; pass `--db <path>` for another profile and `--out <directory>` to write elsewhere.

## Verifying

- Exercise the interaction you changed in the browser and look at the result. Compiling and passing unit tests are not UI verification.
- Write tests that check real workflows and behavior, not ones that mirror the implementation or only assert wiring.
- Run focused tests while working, then `bun run check` before handing off application code.
- After an application change, stop dev, run `bun run build:installed` from the checkout root, then restart dev. Skip this for documentation-only work and read-only investigation.
- Changes to Electron windows, preload, permissions, dialogs, or desktop integration also need a `bun run dev:electron` check.
- After a native runtime change, prepare the runtime again, restart dev, and exercise the real runtime interaction you changed.
- A change to the installer, packaging, or packaged paths is verified in the app that `bun run build:installed` installs, not in dev.
- For a persistence change, restart and confirm the saved state.
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

## Releases

Read this whole section before touching versions, tags, release workflows, signing, or rollback, and update it in the same pull request when the process changes. Browser testing and a local `build:installed` do not show that a release package works.

- **No hosted builds.** GitHub Actions CI and Release are manually disabled to save minutes. Keep them disabled unless I say otherwise, and run every gate locally.
- **Shape.** A release candidate is tagged on a `master` commit, installed, and tested. Production then publishes the accepted candidate's exact files under the final tag without rebuilding. Only one RC tag may point at a commit. If a candidate fails, fix it through a pull request and tag the new `master` commit.
- **Never.** Move a published tag, force-push `master`, or replace the files of a published release.
- **Gates.** From a clean checkout at the exact `origin/master` SHA, run `bun install --frozen-lockfile`, `bunx --no-install install-electron`, `bun audit --prod`, and `bun run check`. Then run `bun run build:installed` with `SCRAPLY_RELEASE_STRICT=1`, `SCRAPLY_ALLOW_UNSIGNED=1`, and `GITHUB_REF_NAME=<rc-tag>`, followed by `bun run test:e2e:portable` and `bun run test:e2e:installed`. The manifest records `GITHUB_REF_NAME` as `sourceRef`, and promotion rejects a bundle whose `sourceRef` is not the RC tag. Put the source SHA and the actual results in the release notes.
- **Bundle.** A release is exactly five files: the installer, the portable executable, `manifest.json`, `SHA256SUMS.txt`, and `scraply-agent.lock.json` (copied from `build/runtime`). Collect them into an empty directory.
- **Publish the candidate.** Run `bun scripts/check-promotion.ts rc <sha> <rc-tag>` and `bun scripts/verify-promoted-assets.ts <bundle-directory> <sha> <rc-tag> --allow-unsigned`. Tag with `git tag -a <rc-tag> <sha> -m "Scraply <version> RC <n>"`, push `refs/tags/<rc-tag>`, and publish the five files with `gh release create <rc-tag> --verify-tag --prerelease`, naming each file path. Install the published candidate and test the affected workflows before accepting it.
- **Publish production.** Download the accepted candidate's five files into a new directory. GitHub stores the executables as `Scraply.Setup.<version>.exe` and `Scraply.<version>.exe`; rename them back to the spaced names that `SHA256SUMS.txt` and the manifest record. Run `bun scripts/check-promotion.ts production <sha> <tag>` and `verify-promoted-assets.ts` against the same SHA and RC tag, tag the same SHA, and publish those files with `gh release create <tag> --verify-tag`.
- **Signing.** Scraply has no code-signing certificate, so releases ship unsigned and the release notes say Windows SmartScreen warns on first launch. Once a certificate exists, drop `SCRAPLY_ALLOW_UNSIGNED` and `--allow-unsigned`. A broken signature is always rejected.
- **Clean source.** A release build needs a clean checkout whose app and runtime come from the same commit, so commit runtime and app changes together.
- **Rollback.** Application: reinstall a previous GitHub Release after checking its published SHA-256 hash, and never swap only `scraply-agent.exe`. Source: revert through a branch and pull request. Data: close Scraply and restore a consistent backup of the whole data directory, including SQLite WAL and SHM files.

## Documentation

The repository has no documentation folder, and you never add one. The only markdown files that belong on GitHub are `README.md`, `AGENTS.md` and `CLAUDE.md` (here and in `runtime/`), the GitHub templates, the bundled prompts in `prompts/`, and `runtime/UPSTREAM.md`, which the build ships as a license notice. Never commit any other markdown file: no guides, procedures, reports, ADRs, or notes.

- When behavior changes, rewrite or remove the affected text rather than appending to it. Link to source instead of copying it.
- Leave out file catalogs, field lists, and pull request summaries; the code and tests already record them.
- Comments explain how a function or module is used, and move with the code.

## Plans and work artifacts

Keep plans, research notes, acceptance transcripts, and scratch files out of the repository: put them under the ignored `build/` directory or outside the checkout. The merged pull request is the implementation record, so acceptance evidence goes in its description.

Markdown files written for local testing and evaluation never go to GitHub: evaluation procedures, acceptance runbooks, and review instructions. Keep them under `build/` as well.

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
