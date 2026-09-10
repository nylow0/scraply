# Scraply

Scraply is a local-first Windows desktop app for evidence-backed research and idea exploration. It runs as an Electron application and stores projects, source snapshots, options, analyses, and user decisions in SQLite on your machine.

## Requirements

- Windows 10 or 11
- [Bun](https://bun.sh/) for development
- Rust's `stable-x86_64-pc-windows-msvc` toolchain and Visual Studio C++ build tools for native builds
- An Exa or Perplexity API key for web research
- An OpenAI subscription account connected inside Scraply for the bundled native runtime

## Development

Run commands from the checkout you are editing. For first-time setup:

```powershell
bun install
bunx --no-install install-electron
git submodule update --init --recursive
bun run prepare:runtime
```

`prepare:runtime` builds, checks, and stages the Rust worker. Reuse that stage for UI and TypeScript backend changes. Run preparation again when the stage is missing or the runtime source, Cargo dependencies, pinned submodule, or runtime build/protocol configuration changes. A new worktree needs its own prepared stage. See [runtime/README.md](runtime/README.md#build) for native development.

Electron 42 downloads its executable on demand. The explicit `install-electron` step is needed because this version of electron-vite reads Electron's installed path directly. Repeat it after removing Electron's executable or replacing dependencies if dev reports `Electron uninstall`. See the [Electron 42 installation change](https://www.electronjs.org/blog/electron-42-0).

For each development terminal session, point Electron at the prepared worker and start the app:

```powershell
$env:SCRAPLY_AGENT_PATH = (Resolve-Path build/runtime/scraply-agent.exe).Path
$env:SCRAPLY_AGENT_LOCK_PATH = (Resolve-Path build/runtime/scraply-agent.lock.json).Path
bun run dev
```

These variables are required for native generation in development; preparation alone does not configure the dev process. Run them in the same terminal as `bun run dev`.

### Daily iteration

`bun run dev` starts Vite and opens an Electron development window with the real preload bridge and backend. Verify changes in that window. The installed Start menu shortcut still runs the last installed build. A normal browser does not supply `window.scraply` and cannot verify the complete app.

Keep the dev process running while editing Svelte, CSS, or other renderer code; Vite updates the UI on save. After main-process, preload, TypeScript backend, startup configuration, or prompt changes, stop it with Ctrl+C and run `bun run dev` again. For automatic main/preload rebuilds and Electron restarts, use `bun run dev --watch`; Rust changes still require runtime preparation and a restart. Stop dev before packaging from the same checkout because those commands replace `out/`.

Dev mode uses real local data and provider accounts. Use **Open data folder** to identify the active data directory before testing persistence or deletion. For isolated manual testing, append `-- --user-data-dir=C:/path/to/scraply-dev-data` to the dev command, choosing a dedicated directory. Keep destructive or paid verification within the task's authorization.

### Verification and handoff

| Change | Local verification |
| --- | --- |
| UI or TypeScript backend | Exercise the affected workflow in the Electron dev window, run focused tests for the change, then `bun run check` before handoff. |
| Native runtime or host/runtime integration | Prepare the changed runtime, restart dev, and exercise the affected real runtime interaction as well as relevant tests and `bun run check`. |
| Installer, packaging, packaged resource paths, or behavior specific to the installed app | Run `bun run build:installed`, exercise the affected behavior in that app, and run the relevant packaged checks described in [RELEASE.md](RELEASE.md). |
| Release verification | Follow [RELEASE.md](RELEASE.md), including its required package and installed-app checks. |
| Documentation or read-only investigation | Check referenced commands and links as needed; no application build or installation. |

For a UI change, verification includes the affected action and its visible result. For persistence changes, reopen the app and confirm the saved state. Report the workflow exercised, checks passed or failed, and any unavailable verification. A dev-server ready message or passing code checks alone does not verify an interaction.

`bun run test:e2e` prepares the runtime and packages an E2E app before running Playwright. Use it when its scenarios cover the change and that packaged coverage is needed; it is not a lightweight dev-server check. The checked-in CI and release gates remain separate from this daily loop.

`bun run build:installed` prepares the runtime, rebuilds the Windows packages, verifies their source/hash manifest, installs the exact package, and verifies the installed executable and ASAR. Use it for the cases above or when Dany explicitly requests an installed build. Release files go to `release/`.

Routine dev runs do not create installers or rebuild Rust. Native preparation uses `build/cargo` for its Cargo cache; see the runtime build instructions before managing that cache. Avoid accumulating extra worktrees just to verify UI edits, since native preparation in each worktree creates another cache.

### Provider setup

Set `EXA_API_KEY`, `PERPLEXITY_API_KEY`, or both in `.env` for development or in the environment that launches the installed app. Each discovery run uses the search provider selected in its setup. Scraply checks configured providers in the background, then stores the keys with Windows-backed encryption after validation. Known-problem development does not require web search.

Connect OpenAI through Scraply's account controls. The app opens OpenAI login in your browser and bundles the `scraply-agent` worker it needs. Scraply keeps these credentials separate from other Codex installations on the computer.

The native agent source lives in [runtime/](runtime/README.md) and is built with the app. `nylow0/scraply-agent` is legacy; new runtime changes belong in this repository. The pinned upstream source supplies OpenAI login and Responses transport libraries. Scraply does not package or invoke the Codex CLI.

Native OpenAI does not support output-token ceilings. Scraply omits that field for this provider; request deadlines and the runtime output-size limit still apply, but they do not guarantee a token or billing ceiling. Other providers retain the configured token ceiling.

The branch and release workflow is documented in [RELEASE.md](RELEASE.md). `master` is the only long-lived branch. Every feature, fix, documentation change, and maintenance task uses a short-lived branch and a pull request into `master`.

## Using Scraply

1. Create a research project and choose whether to discover a problem or start from a known problem.
2. Enter the starting context, audience, optional constraints, and what risks should be evaluated against. Choose 1–20 ideas per problem, a model, reasoning effort, and, for discovery, research depth and search provider. Astra appears in the model selector and is selectable when the connected account's live catalog offers it.
3. Submit the setup to discover evidence-backed problem candidates, or generate solutions directly for a known problem.
4. Review discovered problems and their evidence, then select the problems worth developing. The v2 workflow aims for your requested idea count, default three, and waits for your choice. It may return fewer or no ideas when useful alternatives are lacking.
5. Choose one idea. An independent risk evaluator reviews it against your saved criteria, or the research goal and boundaries if you left the criteria blank. A separate analysis then adds consequences, proposed responses, and an experiment while retaining the risk findings. New v2 runs use three development calls in total. Record your own decision and observed test result separately from the model's judgments.
6. If one decisive fact is still missing, request one evidence follow-up. Scraply runs the exact question once, quote-checks the extracted observations, and keeps the result separate from the original analysis. Completed and failed follow-ups both consume the run's one-question limit.
7. Export research as JSON or options and analyses as Markdown/JSON. Saved v1 projects remain readable and exportable. New research always uses the current workflow, including when started from an old project's setup.

V2 saves run-local prompts, search results, completed stages, and evidence follow-ups. Reopening a project does not generate more work. Continuing a saved v2 run uses its original prompts, even after an override changes. A request whose completion was lost is not automatically replayed. Start a new run when you want changed setup or instructions. Legacy v1 generation and its ten bundled prompts are retired at Dany's request; interrupted v1 runs cannot resume. Saved artifacts and v2 prompt snapshots are preserved.

For the initial three-decision usefulness review, export research JSON plus ideas JSON and Markdown from matching v1 and v2 discovery runs. Start with `bun run evaluate:phase3 -- template <input.json>`; each case contains two `{ ideasPath, ideasMarkdownPath, researchPath, origin, timings? }` variants. Run `bun run evaluate:phase3 -- prepare <input.json> <output-directory>`, then give the reviewer the generated `*-A.md`/`*-B.md` files, `review-packet.json` for source auditing, and a copy of `review-template.json`. Keep `private-mapping.json` separate because it contains workflow identity, provenance (`generated`, `synthetic`, or `live`), original/blinded hashes, run metadata, and optional timings. The preparer removes only the `Workflow: v1.` or `Workflow: v2.` prefix from Markdown; it preserves the selection and problem-evidence assessment, and the different output structure can still reveal a version. After the reviewer records unsupported claims, useful discoveries, reading/correction durations, and the action chosen, run `bun run evaluate:phase3 -- validate <packet.json> <mapping.json> <reviews.json> <result.json>`. Start with three cases and add up to two more when results are mixed. Validation checks complete, untampered records without declaring the Phase 3 gate accepted. Known-problem behavior is tested separately because it does not produce the paired discovery research export this review needs.

Cases default to `comparison: "selected-problem"`, which requires matching problem statements and archived scopes. For independent discovery runs, set `comparison: "research-scope"`: the original nonempty research question and every archived constraint must match, but the selected problems may differ. This compares the whole workflow, including which problem it discovers. Only the cosmetic research title is excluded from the scope check and replaced with the question in the blinded packet. The original exports and their hashes remain in the private mapping.

Provider readiness is checked before a run can start. Native generation attempts retain reported tokens and usage, with unknown usage shown explicitly when the provider does not supply it. Subscription calls do not receive an invented dollar charge. Accountable provider/search spend is reserved conservatively and committed as the run proceeds.

Cancelling while a project is still waiting for the runtime records no provider attempt. A dispatched request whose result was lost remains unknown. Completed runs that propose no options have explicit JSON and Markdown exports, so the usefulness comparison can include that outcome without inventing an idea.

New v2 development runs include recorded experiment observations from earlier completed runs of the same problem in the same project. These remain user reports, with the original mechanism and decision attached. The run snapshots this context; later edits do not rewrite it. At most five recent results and 12,000 characters are included, with an explicit count of omitted results.

Independent risk reviews are saved before final analysis and remain readable if that later call fails. Older runs retain their saved prompts and original stage sequence on resume. Starting a new run adopts the current prompts and independent evaluator. V2 discovery allows two Exa searches at a time, preserves query order, and settles each batch before continuing; Perplexity and model calls remain sequential.

## Local data and credentials

Use **Open data folder** in the app to open the exact active location. On a standard Windows installation, Electron keeps the database under its user-data directory in a `scraply` folder, with the main database named `scraply.db`. SQLite may also create `scraply.db-wal` and `scraply.db-shm` while the app is running.

Credentials are stored separately in `secrets.bin` using Electron's Windows-backed `safeStorage`. Scraply refuses to claim credentials were saved when secure storage is unavailable. Keys are sent only to the selected provider for the operation that needs them.

## Prompt overrides

Research loads seven bundled `prompts/workflow-v2-*.md` files by default. Each prompt uses English Role, Context, Task, Format, and Style / Tone sections. To customize a prompt, put a deliberately edited file with the same name in the data folder's `prompts` directory. Remove that file to return to the bundled instruction. Missing or empty bundled prompts produce a packaging error; an empty override must be edited or removed before its stage can run.

On upgrade, Scraply moves proven bundled copies of v2 prompts to `prompts/bundled-copy-backups/<hash>/`, so new runs use the current bundle. Deliberate custom v2 overrides stay active. Every recognized retired prompt override, including custom text, moves to `prompts/retired-prompt-backups/<hash>/` after its backup is verified. Unknown filenames remain untouched. `.prompt-versions.json` retains known bundled baselines. Each generation's stored request includes the resolved instruction and evidence used for that call.

## Backup, export, and reset

- Export ideas from the idea workspace when you need portable JSON.
- For a full backup, close Scraply completely and copy the entire data folder, including the database and any WAL/SHM files that remain.
- To restore, close Scraply and replace the data folder with a consistent backup from the same app version.
- To reset local research data, close Scraply, back up anything important, and remove the `scraply` data subfolder. The app creates a fresh database on next launch.
- To reset saved provider credentials, close Scraply and remove `secrets.bin` from the Electron user-data directory. The next launch imports configured environment keys again.

Deleting or resetting data is irreversible unless you made a backup first.

## Troubleshooting

- **Search does not connect:** the local workspace remains available. Confirm the selected provider's `EXA_API_KEY` or `PERPLEXITY_API_KEY` exists in `.env` during development or in the installed app's launch environment, then retry connections.
- **Native connection requires reconnection:** reconnect OpenAI inside Scraply. Cached model names alone do not establish that an account can run them.
- **Research cannot start:** confirm the setup is saved, the selected model and required search provider are connected, and no active run already exists for the project.
- **A report is blank or slow:** collapse and reopen it to retry the on-demand detail request. Reports are intentionally excluded from routine workspace refreshes.
- **An interrupted run appears after restart:** Resume is available only when the saved state permits it. If a dispatched request has unknown completion, Scraply blocks automatic replay. Keep the partial artifacts and explicitly start a new run if you want another attempt.
- **Database errors after a crash:** close every Scraply process before copying, restoring, or resetting SQLite files.
- **Unexpected startup or process failure:** use **Open logs folder** and keep the correlation reference shown by the app. Logs are local, rotated, and sanitized; Scraply does not upload telemetry.

## Privacy and links

Scraply is a personal local application and does not expose a hosted workspace. Report links open through a restricted external-browser action; remote pages cannot navigate the privileged Electron window or access Scraply IPC.
