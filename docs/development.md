# Development

Run commands from the checkout you are editing. Scraply is Windows-first. Native builds need Rust's `stable-x86_64-pc-windows-msvc` toolchain, including rustfmt and clippy, and Visual Studio C++ build tools. [Bun](https://bun.sh/) runs the TypeScript tooling.

## First-time setup

```powershell
bun install --frozen-lockfile
bunx --no-install install-electron
git submodule update --init --recursive
bun run prepare:runtime
```

`prepare:runtime` builds, checks, and stages the Rust worker. Reuse that stage for UI and TypeScript backend changes. Prepare it again when the stage is missing or native source, Cargo dependencies, the pinned submodule, or runtime build or protocol configuration changes. See the [runtime build guide](../runtime/README.md#build).

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

| Change | Local verification |
| --- | --- |
| UI or TypeScript backend | Exercise the affected workflow in the browser, run focused tests, then `bun run check` before handoff. |
| Native runtime or host/runtime integration | Prepare the changed runtime, restart development, and exercise the affected real runtime interaction, relevant tests, and `bun run check`. |
| Electron window, preload, permissions, dialogs, or desktop integration | Verify the affected interaction in an explicit Electron development session. |
| Installer, packaging, packaged paths, or installed-app behavior | Run `bun run build:installed`, exercise that behavior in the resulting app, and run the relevant packaged checks in [RELEASE.md](../RELEASE.md). |
| Release verification | Follow [RELEASE.md](../RELEASE.md), including package and installed-app gates. |
| Documentation or read-only investigation | Check referenced commands and links as needed; no build or installation. |

For UI changes, verify the action and visible result. For persistence changes, restart and confirm the saved state. Report the URL, checkout, workflow exercised, checks passed or failed, and unverified behavior. A server-ready message or passing code checks alone does not verify an interaction.

`bun run test:e2e` prepares the runtime and packages an E2E app before Playwright runs. Use it when its scenarios provide needed packaged coverage; it is not a lightweight browser check. CI and release gates are separate from daily iteration.

After completing an application change, run `bun run build:installed` from the checkout root. It prepares the runtime, rebuilds and verifies Windows packages, installs the exact package, and verifies the installed executable and ASAR. Skip it for read-only questions, documentation-only changes, and intermediate investigation. Stop development before this command, then restart it for handoff. Output goes to `release/`.

Routine development does not create installers or rebuild Rust. Native preparation uses `build/cargo` for its Cargo cache. Avoid preparing identical native code in extra worktrees merely to preview UI edits.

## Provider setup

Set `EXA_API_KEY`, `PERPLEXITY_API_KEY`, or both in `.env` for development or in the environment that launches the installed app. A discovery run uses its selected search provider. Scraply checks configured providers in the background, then saves keys with Windows-backed encryption after validation. Known-problem development does not require web search.

Connect OpenAI through Scraply's account controls. The app opens OpenAI login in your browser and bundles its `scraply-agent` worker. These credentials stay separate from other Codex installations on the computer. The worker source lives in [runtime/](../runtime/README.md); `nylow0/scraply-agent` is legacy. Pinned upstream source supplies OpenAI login and Responses transport libraries. Scraply does not package or invoke the Codex CLI.

Native OpenAI does not support output-token ceilings. Scraply omits that field for this provider. Request deadlines and the runtime output-size limit still apply, but they do not guarantee a token or billing ceiling. Other providers retain their configured token ceiling.

## Repository and evaluation notes

`master` is the only long-lived branch. Use a short-lived branch and pull request for every feature, fix, documentation change, or maintenance task. [RELEASE.md](../RELEASE.md) owns release commands and acceptance gates. [ACCEPTANCE.md](../ACCEPTANCE.md) indexes dated acceptance evidence. [The document inventory](repository-inventory.md) records the purpose of existing plans, artifacts, prompts, and runtime guides.

For the initial three-decision usefulness review, follow [the Phase 3 evaluation procedure](evaluation.md). Its outputs and historical claims are separate from implementation and release verification.

## Secret checks

Run the local check after staging files and before committing:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/check-secrets.ps1 -Scope staged
```

For a publishable-history audit, use `-Scope history` in a fresh clone after fetching the refs that could become public. The script pins and hash-verifies its Gitleaks download and emits redacted findings. A clean staged check covers only the new patch; a clean history scan covers only the refs included in that clone. Keep the audit scope and inaccessible areas with its report. [SECURITY.md](../SECURITY.md) gives the private vulnerability route.
