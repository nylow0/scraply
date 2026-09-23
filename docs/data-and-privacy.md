# Data and privacy

Scraply is a local desktop application, not a hosted workspace. Projects, research runs, source snapshots, ideas, analyses, and user decisions live in SQLite on your computer. Open **Open data folder** in the app to find the active location. On a standard Windows installation, the database is under the Electron user-data directory in a `scraply` folder and is named `scraply.db`. SQLite may also create `scraply.db-wal` and `scraply.db-shm` while the app runs.

## What leaves the device

When you start generation or research, Scraply sends the relevant prompt and selected context to the connected model provider. A web-research run sends its planned queries to the selected search provider, Exa or Perplexity, and retrieves search results. Review the project scope and provider choice before starting a paid or sensitive run. Local project storage does not make provider requests local.

Scraply does not upload telemetry. Logs stay local, rotate, and omit credential values. Use **Open logs folder** to find them when troubleshooting. Report links open through a restricted external-browser action; remote pages cannot navigate the privileged Electron window or access Scraply IPC.

## Credentials

The app stores provider credentials separately from research data in `secrets.bin`, using Electron's Windows-backed `safeStorage`. It refuses to claim a credential was saved when secure storage is unavailable. Keys go to the selected provider for the operation that needs them. The bundled runtime uses Scraply's OpenAI account connection, separate from other Codex installations.

Browser development and the installed app share the encrypted credential file unless you choose an isolated development profile. See [development](development.md#data-and-credentials-during-development) before testing login, logout, or throwaway keys.

## Backup, restore, and reset

Before schema upgrades, Scraply saves a checked database backup beside `scraply.db`; it logs the absolute path and records it in `app_meta.last_pre_migration_backup_path`. Close Scraply before restoring that backup.

- Close Scraply completely before a full backup. Copy the entire data folder, including any SQLite WAL or SHM files that remain.
- To restore, close Scraply and replace the data folder with a consistent backup from the same app version.
- To reset local research data, close Scraply, back up anything important, and remove the `scraply` data subfolder. The app creates a fresh database on next launch.
- To reset saved provider credentials, close Scraply and remove `secrets.bin` from the Electron user-data directory. The next launch imports configured environment keys again.

Deleting or resetting data is irreversible without a backup. For a portable copy of selected work, export research as JSON and options or analyses as Markdown or JSON from the app. An export is not a full database backup.

## Prompt overrides and saved runs

Research loads the bundled `prompts/workflow-v2-*.md` files named in `src/core/stages.ts`. To customize a prompt, put a deliberately edited file with the same name in the active data folder's `prompts` directory. Remove the override to return to the bundle. Missing or empty bundled prompts cause a packaging error; edit or remove an empty override before that stage runs.

On upgrade, Scraply moves proven bundled v2 copies to `prompts/bundled-copy-backups/<hash>/`, so new runs use the current bundle. Deliberate custom v2 overrides stay active. It backs up every recognized retired override, including custom text, under `prompts/retired-prompt-backups/<hash>/` after verifying the backup. Unknown filenames remain untouched. `.prompt-versions.json` keeps known bundled baselines.

Each generation stores the resolved instruction and evidence sent for that call. Reopening a project does not start more work. Continuing a saved v2 run uses its original prompt snapshot even if an override changes. Start a new run to use changed setup or instructions. Existing v1 results remain readable and exportable, but interrupted v1 generation cannot resume.
