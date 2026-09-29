# Development

Run commands from the checkout you are editing. Scraply is Windows-first. Native builds need Rust's `stable-x86_64-pc-windows-msvc` toolchain, including rustfmt and clippy, and Visual Studio C++ build tools. [Bun](https://bun.sh/) runs the TypeScript tooling.

## First-time setup

```powershell
bun install --frozen-lockfile
bunx --no-install install-electron
git submodule update --init --recursive
bun run prepare:runtime
```

`prepare:runtime` builds, checks, and stages the Rust worker. Reuse that stage for UI and TypeScript backend changes. Prepare it again when the stage is missing or native source, Cargo dependencies, the pinned submodule, or runtime build or protocol configuration changes. See the [runtime build guide](../../runtime/README.md#build).

Electron 42 downloads its executable on demand. `install-electron` is an explicit setup step because this version of electron-vite reads the installed path directly. Repeat it if development startup reports a missing Electron executable. See the [Electron 42 installation change](https://www.electronjs.org/blog/electron-42-0).

## Daily iteration

```powershell
bun run dev
```

The command starts a background server and prints its browser URL, normally `http://127.0.0.1:5173`. Open the printed URL. It opens no Scraply, DevTools, terminal, or browser window on its own. Running it again reuses the server for this checkout. Leave it running and give the maintainer the URL and checkout path at handoff.

If another project uses port 5173, choose another local UI port from 1024 to 65535 before starting. Keep the same variable set when stopping that server. Stop a running server before changing its port setting:

```powershell
$env:SCRAPLY_BROWSER_UI_PORT = "5174"
bun run dev
# Later, in a shell with the same port setting:
bun run dev:stop
```

The browser uses the real app handlers and backend. A windowless Electron host supplies SQLite, encrypted credentials, and the native worker. The launcher selects prepared files in `build/runtime`. To intentionally reuse another native artifact, set both `SCRAPLY_AGENT_PATH` and `SCRAPLY_AGENT_LOCK_PATH` before starting. Reuse it only when its native code and protocol match this checkout. Release builds prepare their own verified artifact.

Renderer edits update the browser on save. Main-process and TypeScript backend edits rebuild and restart the background host; reload the browser after a host restart. Unsaved form edits can reset during hot reload. Restart after changing startup configuration, environment variables, or prepared native files:

```powershell
bun run dev:stop
bun run dev
```

The server binds only to `127.0.0.1`. If the configured port belongs to another process or checkout, startup fails instead of stopping that process. Use `dev:stop` from the owning checkout with its original `SCRAPLY_BROWSER_UI_PORT` setting. Logs and launch state live in `build/browser-dev/`; the log is replaced on each start. Stop development before packaging from the same checkout because packaging replaces `out/`.

## Data and credentials during development

Browser development stores projects in `.scraply/browser-dev/` and uses the installed app's encrypted credentials at `%APPDATA%/scraply/secrets.bin`. An existing OpenAI login and saved Exa or Perplexity keys are available after startup. Both development and installed Scraply keep Windows `safeStorage` encryption and the existing file format. Credentials stay in the local Electron host; the browser receives account status, not stored tokens or keys.

Electron also needs the installed profile's `Local State` encryption context, selected through `sessionData` before startup. The development `userData` path and project database stay separate. The real Electron credential-profile test covers this distinction.

Login, logout, token refresh, and validated key changes update the shared credential file. Restart the other running instance after changing accounts or keys. Writes merge independent changes and reject stale updates to the same credential. Restart the instance that reports a conflict. Older installed builds lack this protection, so close them during development. No credential migration is needed.

Set `SCRAPLY_DEV_DATA_DIR` before startup to choose another project profile. For disposable account or login tests, also set `SCRAPLY_DEV_SHARED_CREDENTIALS=0`; credentials then stay in that development profile. `SCRAPLY_E2E=1` always uses its own credentials. Packaged apps still respect `--user-data-dir`. Environment and `.env` search keys remain explicit overrides and are saved after validation, so use the isolated option for throwaway keys. Restart development after changing these variables.

**Open data folder** shows the active project data location. Exports download through the browser; account login and folder or link actions use the local host. Keep destructive or paid verification within the task's authorization. Use a disposable isolated profile for logout testing instead of signing out the shared account.

## Desktop checks

For a task that needs an Electron window, stop browser development, configure the two native artifact variables above, then start the desktop session:

```powershell
bun run dev:stop
bun run dev:electron
```

This is an explicit desktop check, not the default preview. The installed Start menu shortcut still runs the last installed build.

## Verification and handoff

For offline setup and navigation checks, run `bun run test:ui` and open `http://127.0.0.1:5176/?history=18&long=1`. This mounts the real renderer with synthetic projects and a local mock transport. It cannot launch research or contact a provider. Use `history=0` or `history=80` for empty and large collections, `active=70` with the large collection to place the current project outside recent history, `progress=guided` for research progress with actual usage, and `connection=offline` for a disconnected search provider. `account=signed-out` opens the welcome sign-in, which succeeds on click, and `search=none` starts without search keys. Saving a search key accepts any key except one containing `invalid`. Reloading resets the fixture. Settings and archive/restore changes last for the current page session.

| Change | Local verification |
| --- | --- |
| UI or TypeScript backend | Exercise the affected workflow in the browser, run focused tests, then `bun run check` before handoff. |
| Native runtime or host/runtime integration | Prepare the changed runtime, restart development, and exercise the affected real runtime interaction, relevant tests, and `bun run check`. |
| Electron window, preload, permissions, dialogs, or desktop integration | Verify the affected interaction in an explicit Electron development session. |
| Installer, packaging, packaged paths, or installed-app behavior | Run `bun run build:installed`, exercise that behavior in the resulting app, and run the relevant packaged checks in the [release guide](release.md). |
| Release verification | Follow the [release guide](release.md), including package and installed-app gates. |
| Documentation or read-only investigation | Check referenced commands and links as needed; no build or installation. |

For UI changes, verify the action and visible result. For persistence changes, restart and confirm the saved state. Report the URL, checkout, workflow exercised, checks passed or failed, and unverified behavior. A server-ready message or passing code checks alone does not verify an interaction.

`bun run test:e2e` prepares the runtime and packages an E2E app before Playwright runs. Use it when its scenarios provide needed packaged coverage; it is not a lightweight browser check. CI and release gates are separate from daily iteration.

After completing an application change, run `bun run build:installed` from the checkout root. It prepares the runtime, rebuilds and verifies Windows packages, installs the exact package, and verifies the installed executable and ASAR. Skip it for read-only questions, documentation-only changes, and intermediate investigation. Stop development before this command, then restart it for handoff. Output goes to `release/`.

Routine development does not create installers or rebuild Rust. Native preparation uses one Cargo cache shared by every checkout: `%LOCALAPPDATA%\scraply-build\cargo`, roughly 9 GB. Set `CARGO_TARGET_DIR` to move it. Deleting that folder reclaims the space; the next preparation rebuilds it from scratch. Avoid preparing identical native code in extra worktrees merely to preview UI edits.

Remove a worktree once its pull request merges, because each one carries its own `node_modules` and build output. Confirm `git status` is clean, then run `git worktree remove <path>`. Git requires `--force` for worktrees that contain the runtime submodule.

## Provider setup

Users add Exa and Perplexity API keys in the app: the welcome prompt asks after OpenAI sign-in, and **Settings → Accounts** adds, replaces, or removes them. Main validates a pasted key with its provider through the backend's `/search-keys/preflight` route before storing it with Windows-backed encryption. A rejected key changes nothing. The renderer only ever receives a key's masked tail (`maskedKey` in validation state). Changes are refused while research runs, because applying a key rebuilds the research engine and would cancel the run.

`EXA_API_KEY` and `PERPLEXITY_API_KEY` in `.env` (development only) or in the launch environment override saved keys on every launch, and are saved after validation. The app refuses to edit an overridden key rather than letting the change revert on the next launch. A discovery run uses its selected search provider. Known-problem development does not require web search.

Connect OpenAI through Scraply's account controls. The app opens OpenAI login in your browser and bundles its `scraply-agent` worker. These credentials stay separate from other Codex installations on the computer. The worker source lives in [runtime/](../../runtime/README.md); `nylow0/scraply-agent` is legacy. Pinned upstream source supplies OpenAI login and Responses transport libraries. Scraply does not package or invoke the Codex CLI.

Research generations wait for provider completion, an actual provider or transport failure, or explicit cancellation. Scraply does not impose a generation deadline or stop a run because its estimated duration elapsed. The runtime still validates responses and bounds input/output size. Native OpenAI does not support output-token ceilings; other providers retain their configured token ceiling.

New workflows use Research depth to guide query planning and evidence collection. Call and search counts are estimates, not dispatch limits. Older saved workflows retain their explicit count limits. Search provider is available in the main setup. Exa uses `auto` search; Perplexity uses its Search API with a 2,000-token page extraction limit. Quick, Standard, and Deep are Scraply workflow settings, not interchangeable provider modes. Perplexity's `web`/`fast` search types and `low`/`medium`/`high` extraction settings are documented in its [Search API reference](https://docs.perplexity.ai/api-reference/search-post); Exa's modes are documented in its [Search reference](https://exa.ai/docs/reference/search).

## Usefulness evaluation

The [Phase 3 evaluation procedure](evaluation.md) compares matching discovery runs in a blinded review. Its results are separate from implementation and release verification.

## Secret checks

Run the local check after staging files and before committing:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/check-secrets.ps1 -Scope staged
```

For a publishable-history audit, use `-Scope history` in a fresh clone after fetching the refs that could become public. The script pins and hash-verifies its Gitleaks download and emits redacted findings. A clean staged check covers only the new patch; a clean history scan covers only the refs included in that clone. Keep the audit scope and inaccessible areas with its report.
