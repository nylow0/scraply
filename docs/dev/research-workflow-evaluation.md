# Installed research acceptance

Use a clean, frozen checkout after `bun run build:installed`. The runner verifies the installed executable, app archive, and bundled runtime against that checkout's `release/manifest.json`. Its output records those hashes, the package source commit, and the transport used.

First check the installed transport without creating a project or starting research:

```powershell
bun scripts/eval-research.ts --app-checkout C:\Business\scraply\.worktrees\research-workflow --installed-executable "$env:LOCALAPPDATA\Programs\Scraply\Scraply.exe" --installed-profile "$env:APPDATA\scraply" --matrix acceptance --output build/eval/installed-transport --verify-transport
```

The runner copies `secrets.bin` and `Local State` into the output's disposable `profile` directory. It leaves installed projects and credentials untouched. The real installed app opens that profile, loads its bundled worker, and answers through `window.scraply` over a local pipe managed by Node and Playwright. The transport check reads the app identity and workspace, checks the same profile's database, and closes its own app. It makes no research or generation request.

After the transport check, use a new output directory and replace `--verify-transport` with `--dry-run` to review the matrix and estimates. Removing `--dry-run` launches paid acceptance research using the existing accounts. `--matrix acceptance` runs Standard for all eight briefs and Deep for Science fair and Clinics. `--briefs science-fair,clinics` narrows the matrix. The selected models, reasoning, provider, and idea settings come from `test/eval/briefs`.

Rerun the same command and output to continue observation. The observer reconnects to an app that is still running, reads the saved session, and never resends an admission whose receipt was lost. Paused, interrupted, or review-blocked work needs manual inspection. An observer disconnect leaves its app running; the runner closes it after terminal completion. `--pause-file PATH` stops before the next case when that file exists.

`--report-only` recalculates metrics from the disposable database without opening the installed app or making provider calls. Keep the frozen checkout and its trace reader available. Use a new output directory when changing the package, fixture, matrix, transport, or credential source.

Browser baseline evaluation retains `--runtime-dir` and the local development transport. Installed mode always uses its packaged worker and refuses that runtime override.
