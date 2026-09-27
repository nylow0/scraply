# Data and privacy

Scraply is a local desktop application, not a hosted workspace. Projects, research runs, source snapshots, ideas, analyses, and user decisions live in SQLite on your computer. Open **Open data folder** in the app to find the active location. On a standard Windows installation, the database is under the Electron user-data directory in a `scraply` folder and is named `scraply.db`. SQLite may also create `scraply.db-wal` and `scraply.db-shm` while the app runs.

## What leaves the device

When you start generation or research, Scraply sends the relevant prompt and selected context to the connected model provider. A web-research run sends its planned queries to the selected search provider, Exa or Perplexity, and retrieves search results. Review the project scope and provider choice before starting a paid or sensitive run. Local project storage does not make provider requests local.

Scraply does not upload telemetry. Logs stay local, rotate, and omit credential values. Use **Open logs folder** to find them when troubleshooting. Report links open through a restricted external-browser action; remote pages cannot navigate the privileged Electron window or access Scraply IPC.

## Credentials

The app stores provider credentials separately from research data in `secrets.bin`, using Electron's Windows-backed `safeStorage`. It refuses to claim a credential was saved when secure storage is unavailable. Keys go to the selected provider for the operation that needs them. Saved search keys are write-only: the interface shows only their last four characters, and replacing a key means pasting a new one. The OpenAI account email stays blurred in Settings until you click it. The bundled runtime uses Scraply's OpenAI account connection, separate from other Codex installations.

## Backup, restore, and reset

Before a database upgrade, Scraply saves a checked backup beside `scraply.db` and logs its location. Close Scraply before restoring that backup.

- Close Scraply completely before a full backup. Copy the entire data folder, including any SQLite WAL or SHM files that remain.
- To restore, close Scraply and replace the data folder with a consistent backup from the same app version.
- To reset local research data, close Scraply, back up anything important, and remove the `scraply` data subfolder. The app creates a fresh database on next launch.
- To reset saved provider credentials, close Scraply and remove `secrets.bin` from the Electron user-data directory. The next launch imports configured environment keys again.
- Scraply remembers the window's size, position, and maximized state in `window-state.json` in the Electron user-data directory. Remove it to reopen at the default size. A saved position that no longer reaches a connected display is ignored.

Deleting or resetting data is irreversible without a backup. For a portable copy of selected work, export research as JSON and options or analyses as Markdown or JSON from the app. An export is not a full database backup.

## Prompt overrides and saved runs

To customize a bundled `workflow-v2-*.md` prompt, put a file with the same name and your edited prompt text in the active data folder's `prompts` directory. Remove the override to use the bundled prompt again. An empty or whitespace-only override blocks the affected step; edit or remove it before starting a run.

On upgrade, Scraply moves unchanged copies of old bundled prompts to `prompts/bundled-copy-backups/<hash>/`, so new runs use the current bundle. Custom overrides for active prompts stay in place. It also backs up retired overrides, including your edits, under `prompts/retired-prompt-backups/<hash>/`. Files with unfamiliar names remain untouched.

Reopening a project does not start more work. A saved v2 run resumes with the prompts it started with, even if an override changes. Start a new run to use changed setup or prompts. Existing v1 results remain readable and exportable, but interrupted v1 generation cannot resume.
