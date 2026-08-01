# Scraply

Scraply is a local-first Windows desktop app for evidence-backed research and idea exploration. It runs as an Electron application, stores projects in SQLite on your machine, and keeps sources, claims, reports, ideas, ratings, and research progress tied to the run that created them.

## Requirements

- Windows 10 or 11
- [Bun](https://bun.sh/) for development
- An Exa API key for web research
- An authenticated Codex CLI for the default structured-model workflow

## Development

```powershell
bun install
bun run dev
```

Set `EXA_API_KEY` in `.env` for development or in the environment that launches the installed app. Scraply connects automatically and stores the key with Windows-backed encryption after the first successful validation.

Useful checks:

```powershell
bun run check
bun run test:e2e
bun run build:installed
```

`bun run build:installed` cleans and rebuilds the Windows installers, verifies their source/hash manifest, installs the exact package, and verifies the installed executable and ASAR. Release files are written to `release/`.

Branch roles, exact-SHA stage promotion, RC tags, and production GitHub Releases are documented in [RELEASE.md](RELEASE.md). `stage` and `master` are release pointers only; fixes always return to `dev`.

## Using Scraply

1. Create a research project and answer the intake questions.
2. Review and edit the generated brief.
3. Review models, the six planned research lenses, and the conservative maximum cost.
4. Approve the run, watch run-scoped progress, and inspect reports as they become available.
5. Generate ideas after synthesis, inspect their evidence, rate them, export them, or create a focused child branch.

Paid work does not begin during intake or brief editing. The approval screen shows the configured ceiling before research starts. Codex subscription usage is tracked by invocation/limits rather than presented as an invented dollar charge; accountable provider/search spend is reserved conservatively and committed as the run proceeds.

## Local data and credentials

Use **Open data folder** in the app to open the exact active location. On a standard Windows installation, Electron keeps the database under its user-data directory in a `scraply` folder, with the main database named `scraply.db`. SQLite may also create `scraply.db-wal` and `scraply.db-shm` while the app is running.

Credentials are stored separately in `secrets.bin` using Electron's Windows-backed `safeStorage`. Scraply refuses to claim credentials were saved when secure storage is unavailable. Keys are sent only to the selected provider for the operation that needs them.

## Backup, export, and reset

- Export ideas from the idea workspace when you need portable JSON.
- For a full backup, close Scraply completely and copy the entire data folder, including the database and any WAL/SHM files that remain.
- To restore, close Scraply and replace the data folder with a consistent backup from the same app version.
- To reset local research data, close Scraply, back up anything important, and remove the `scraply` data subfolder. The app creates a fresh database on next launch.
- To reset the saved Exa credential, close Scraply and remove `secrets.bin` from the Electron user-data directory. The next launch imports `EXA_API_KEY` again.

Deleting or resetting data is irreversible unless you made a backup first.

## Troubleshooting

- **Exa does not connect:** confirm `EXA_API_KEY` exists in `.env` during development or in the installed app's launch environment, then use **Refresh** on the startup error.
- **Codex validation fails:** confirm `codex` is installed, authenticated, and available in the same Windows user environment that launches Scraply.
- **Research cannot start:** confirm the brief is approved, the configuration is saved, and no active run already exists for the project.
- **A report is blank or slow:** collapse and reopen it to retry the on-demand detail request. Reports are intentionally excluded from routine workspace refreshes.
- **An interrupted run appears after restart:** use Resume to continue it or Cancel to keep completed partial artifacts without scheduling more work.
- **Database errors after a crash:** close every Scraply process before copying, restoring, or resetting SQLite files.
- **Unexpected startup or process failure:** use **Open logs folder** and keep the correlation reference shown by the app. Logs are local, rotated, and sanitized; Scraply does not upload telemetry.

## Privacy and links

Scraply is a personal local application and does not expose a hosted workspace. Report links open through a restricted external-browser action; remote pages cannot navigate the privileged Electron window or access Scraply IPC.
