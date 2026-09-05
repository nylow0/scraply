# Scraply

Scraply is a local-first Windows desktop app for evidence-backed research and idea exploration. It runs as an Electron application, stores projects in SQLite on your machine, and keeps sources, claims, reports, ideas, ratings, and research progress tied to the run that created them.

## Requirements

- Windows 10 or 11
- [Bun](https://bun.sh/) for development
- Rust's `stable-x86_64-pc-windows-msvc` toolchain and Visual Studio C++ build tools for native builds
- An Exa or Perplexity API key for web research
- An OpenAI subscription account connected inside Scraply for the bundled native runtime
- An authenticated Codex CLI only if you explicitly select the legacy route during migration

## Development

```powershell
bun install
git submodule update --init --recursive
bun run prepare:runtime
bun run dev
```

Set `EXA_API_KEY`, `PERPLEXITY_API_KEY`, or both in `.env` for development or in the environment that launches the installed app. Each discovery run uses the search provider selected in its setup. Scraply checks configured providers in the background, then stores the keys with Windows-backed encryption after validation. Known-problem development does not require web search.

Connect OpenAI through Scraply's native account controls. The app bundles a pinned `scraply-agent` executable and keeps native credentials separate from neighboring Codex installations. Native failures do not silently switch to the legacy CLI. Live acceptance of the native integration is still in progress.

The native agent source lives in [runtime/](runtime/README.md) and is built with the app. `nylow0/scraply-agent` is legacy; new runtime changes belong in this repository. The public OpenAI Codex submodule preserves the pinned upstream source and notices.

Native OpenAI does not support output-token ceilings. Scraply omits that field for this provider; request deadlines and the runtime output-size limit still apply, but they do not guarantee a token or billing ceiling. Other providers retain the configured token ceiling.

Run the code checks before handing off a change:

```powershell
bun run check
```

When a change affects the desktop workflow, run its packaged E2E check:

```powershell
bun run test:e2e
```

After completing an application change, build and install it for hands-on testing:

```powershell
bun run build:installed
```

`bun run build:installed` cleans and rebuilds the Windows installers, verifies their source/hash manifest, installs the exact package, and verifies the installed executable and ASAR. Release files are written to `release/`.

The branch and release workflow is documented in [RELEASE.md](RELEASE.md). `master` is the only long-lived branch. Every feature, fix, documentation change, and maintenance task uses a short-lived branch and a pull request into `master`.

## Using Scraply

1. Create a research project and choose whether to discover a problem or start from a known problem.
2. Enter the starting context, audience, optional constraints, model, reasoning effort, and (for discovery) research depth and search provider.
3. Submit the setup to discover evidence-backed problem candidates, or generate solutions directly for a known problem.
4. Review discovered problems and their evidence, select the problems worth developing, and inspect the resulting solutions and risks.
5. Export research as JSON or solutions as Markdown/JSON when you need a portable copy.

Provider readiness is checked before a run can start. Native generation attempts retain reported tokens and usage, with unknown usage shown explicitly when the provider does not supply it. Subscription calls do not receive an invented dollar charge. Accountable provider/search spend is reserved conservatively and committed as the run proceeds.

## Local data and credentials

Use **Open data folder** in the app to open the exact active location. On a standard Windows installation, Electron keeps the database under its user-data directory in a `scraply` folder, with the main database named `scraply.db`. SQLite may also create `scraply.db-wal` and `scraply.db-shm` while the app is running.

Credentials are stored separately in `secrets.bin` using Electron's Windows-backed `safeStorage`. Scraply refuses to claim credentials were saved when secure storage is unavailable. Keys are sent only to the selected provider for the operation that needs them.

## Prompt overrides

Research loads the bundled `prompts/*.md` files by default. To customize a prompt, put a deliberately edited file with the same name in the data folder's `prompts` directory. Remove that file to return to the bundled instruction. Missing or empty bundled prompts produce a packaging error; an empty override must be edited or removed before its stage can run.

On upgrade, Scraply backs up old managed copies only when their hashes prove they match a bundled version, then removes those copies from the active override directory. Their exact contents remain under `prompts/bundled-copy-backups/<hash>/`. Custom or unknown text, including retired custom prompts, stays untouched. `.prompt-versions.json` retains known bundled baselines. Each generation's stored request includes the resolved instruction and evidence used for that call.

## Backup, export, and reset

- Export ideas from the idea workspace when you need portable JSON.
- For a full backup, close Scraply completely and copy the entire data folder, including the database and any WAL/SHM files that remain.
- To restore, close Scraply and replace the data folder with a consistent backup from the same app version.
- To reset local research data, close Scraply, back up anything important, and remove the `scraply` data subfolder. The app creates a fresh database on next launch.
- To reset saved provider credentials, close Scraply and remove `secrets.bin` from the Electron user-data directory. The next launch imports configured environment keys again.

Deleting or resetting data is irreversible unless you made a backup first.

## Troubleshooting

- **Search does not connect:** the local workspace remains available. Confirm the selected provider's `EXA_API_KEY` or `PERPLEXITY_API_KEY` exists in `.env` during development or in the installed app's launch environment, then retry connections.
- **Codex validation fails:** confirm `codex` is installed, authenticated, and available in the same Windows user environment that launches Scraply.
- **Native connection requires reconnection:** reconnect OpenAI inside Scraply. Cached model names alone do not establish that an account can run them.
- **Research cannot start:** confirm the setup is saved, the selected model and required search provider are connected, and no active run already exists for the project.
- **A report is blank or slow:** collapse and reopen it to retry the on-demand detail request. Reports are intentionally excluded from routine workspace refreshes.
- **An interrupted run appears after restart:** Resume is available only when the saved state permits it. If a dispatched request has unknown completion, Scraply blocks automatic replay. Keep the partial artifacts and explicitly start a new run if you want another attempt.
- **Database errors after a crash:** close every Scraply process before copying, restoring, or resetting SQLite files.
- **Unexpected startup or process failure:** use **Open logs folder** and keep the correlation reference shown by the app. Logs are local, rotated, and sanitized; Scraply does not upload telemetry.

## Privacy and links

Scraply is a personal local application and does not expose a hosted workspace. Report links open through a restricted external-browser action; remote pages cannot navigate the privileged Electron window or access Scraply IPC.
