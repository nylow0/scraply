# Troubleshooting

## Account, model, and search connection

If the native connection asks you to reconnect, use Scraply's OpenAI account control. A cached model name does not prove that the connected account can run it. Model selectors reflect the live account catalog. A saved but unavailable choice remains visible and blocks a new run until you select an available model and reasoning effort.

If search does not connect, the local workspace remains available. Check that `EXA_API_KEY` or `PERPLEXITY_API_KEY` is present in `.env` for development or in the environment that launches the installed app. Match the key to the provider selected in the project setup, then retry connections. [Provider setup](development.md#provider-setup) explains the development path.

If research cannot start, confirm the setup is saved, the selected model and required search provider are connected, and the project has no active run already in progress. A known-problem development run can work without a search provider when it needs no web research.

## Interrupted or partial work

An interrupted run can resume only when its saved state allows it. A dispatched request whose completion is unknown is not replayed automatically. Keep the partial artifacts and explicitly start a new run if you want another attempt. Provider usage may remain unknown when the provider supplied no accounting; the app does not turn unknown usage into zero.

A run can finish with fewer ideas than requested, including none, when useful alternatives are lacking. A saved partial set or a stopped budget is an outcome to review, not evidence that more ideas exist. [The user guide](user-guide.md) explains the project review path.

If a report is blank or slow, collapse and reopen it to retry the on-demand detail request. Reports are excluded from routine workspace refreshes.

## Startup, data, and packaging

For unexpected startup or process failure, use **Open logs folder** and keep the correlation reference shown by the app. The logs are local, rotated, and sanitized. Do not paste credentials or unredacted customer data into an issue.

Close every Scraply process before copying, restoring, or resetting SQLite files after a crash. See [backup and restore](data-and-privacy.md#backup-restore-and-reset).

For development startup failures, check that Electron was installed with `bunx --no-install install-electron` and that the native stage exists after `bun run prepare:runtime`. Restart the background server after changing a prepared runtime or environment variable. See [development](development.md#first-time-setup). Packaging and installed-app checks are described in [RELEASE.md](../RELEASE.md); report the command and failing diagnostic rather than treating a built installer as a verified release.
