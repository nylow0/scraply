# Scraply release process

`master` is the production branch. Every release change or rollback fix goes through a short-lived branch and a pull request into `master`.

## Local development versus release verification

Use the [README development workflow](README.md#development) for routine iteration in a browser with the background dev server. After completing an application change, run `bun run build:installed` from the checkout root. Skip it for read-only questions, documentation-only changes, and intermediate investigation. These development rules do not replace the CI or release gates below, and browser testing does not establish that a release package works.

## Publish a release candidate

After the target commit lands on `master` and passes the required checks, either in CI or locally as described below:

```powershell
git fetch --prune origin
$sha = git rev-parse origin/master
bun scripts/check-promotion.ts rc $sha v0.3.0-rc.1
git tag -a v0.3.0-rc.1 $sha -m "Scraply 0.3.0 RC 1"
git push origin refs/tags/v0.3.0-rc.1
```

The RC workflow builds once from that clean SHA, verifies the package, and publishes the verified files as a GitHub prerelease. Install that prerelease and test the affected workflows in the real app.

If the RC fails, fix it through another branch and pull request, then tag the new `master` commit. Only one RC tag may point at a commit.

## Publish production

After accepting the RC, tag the same SHA:

```powershell
$sha = git rev-parse origin/master
bun scripts/check-promotion.ts production $sha v0.3.0
git tag -a v0.3.0 $sha -m "Scraply 0.3.0"
git push origin refs/tags/v0.3.0
```

Production must promote the accepted RC files without rebuilding them. The workflow checks the source SHA, file set, manifest, artifact sizes, SHA-256 hashes, executable identity, and signing policy before publishing the same bytes as the final GitHub Release.

Keep GitHub releases immutable so an accepted RC cannot be replaced.

## Release while GitHub Actions is disabled

CI and Release are manually disabled to avoid consuming Actions minutes. Keep them disabled unless Dany requests otherwise. A push or tag must not be used to start a hosted build.

Run the same gates locally from a clean checkout at the exact current `origin/master` SHA: `bun install --frozen-lockfile`, `bunx --no-install install-electron`, `bun audit --prod`, and `bun run check`. The Electron setup is required by the Windows credential-profile regression test. Then run `bun run build:installed` with `SCRAPLY_RELEASE_STRICT=1`, followed by `bun run test:e2e:portable` and `bun run test:e2e:installed`. For a verified private repository only, set `SCRAPLY_ALLOW_UNSIGNED=1`; public releases still require valid signatures. Record the source SHA and actual results in the release notes.

Collect the same five release files described below into an empty bundle directory. Run `bun scripts/check-promotion.ts rc <sha> <rc-tag>` and `bun scripts/verify-promoted-assets.ts <bundle-directory> <sha> <rc-tag>`; add `--allow-unsigned` to the latter only for the private unsigned policy. Create the RC tag at that SHA and publish those five verified files with `gh release create <rc-tag> --verify-tag --prerelease`, using explicit file paths. Install the published candidate and verify its affected workflows before accepting it.

For production, download the accepted RC's five files into a new directory, run `check-promotion.ts production` and `verify-promoted-assets.ts` against the same SHA and RC tag, then publish those exact files under the production tag with `gh release create --verify-tag`. Do not rebuild or replace the accepted RC assets. Local execution changes where the checks run, not the release, signing, acceptance, or rollback requirements.

## Signing and hashes

The package contains `release/manifest.json` with its source, artifact, and bundled-runtime metadata, plus `release/SHA256SUMS.txt` with installer and portable hashes. Manifest schema 2 records the runtime version, protocol versions, source commit, executable identity, notices, and SHA-256 hashes.

Private builds may be unsigned only when the workflow or local release process explicitly sets `SCRAPLY_ALLOW_UNSIGNED=1`; the manifest then records `signingPolicy: "private-unsigned"`. Reject broken signatures. Public releases require valid signatures for Scraply and the bundled runtime.

## Bundled native runtime

The app package requires exactly the seven prompt filenames in `src/core/stages.ts`; package verification rejects missing stages and superseded Markdown prompts. Legacy v1 generation and its bundled prompts are retired at Dany's request, before release acceptance. Existing v1 results remain readable, and saved v2 runs retain their prompt snapshots. On startup, recognized retired overrides are backed up under `retired-prompt-backups`; proven bundled v2 copies move to `bundled-copy-backups`, while custom v2 overrides remain active. This retirement does not assert that release or human usefulness acceptance has passed.

Scraply packages one tested `scraply-agent` executable at `resources/runtime/scraply-agent.exe`, outside `app.asar`. Native mode requires protocol 1.1. Runtime native protocol 1.0 is explicitly incompatible. Runtime 0.2.0 removes the temporary `app-server` and `exec -` commands.

The runtime source lives in `runtime/` in this repository. The separate `nylow0/scraply-agent` repository is legacy. Initialize the pinned public OpenAI Codex submodule with `git submodule update --init --recursive`. Windows builds require Rust's `stable-x86_64-pc-windows-msvc` toolchain (including rustfmt and clippy) and Visual Studio C++ build tools.

`bun run prepare:runtime` runs the runtime's formatting, source budget, locked Rust tests, strict clippy, and release packaging checks. It generates `build/runtime-artifacts/scraply-agent.windows-x64.lock.json`, recording this Scraply commit, the upstream commit, executable, notices, sizes, and hashes. Generated archives and locks are ignored build outputs. The archive contains only:

- `scraply-agent.exe`
- `LICENSE`
- `OPENAI-NOTICE`
- `UPSTREAM.md`
- `SHA256SUMS.txt`

For an implementation-only local build, set `SCRAPLY_SKIP_RUNTIME_CHECKS=1` before `bun run build:installed`. This skips Rust formatting, source-budget checks, tests, and clippy while still compiling the runtime and verifying package hashes and installed files. It is rejected when `SCRAPLY_RELEASE_STRICT=1` or `CI=true`. Such a build provides no new test or release-acceptance evidence. Leave this setting unset for release verification.

After building, `bun run prepare:runtime` verifies the archive and every member before staging those files plus the lock in `build/runtime`. Verification rejects extra or unsafe archive paths, links, oversized files, non-x64 executables, incorrect version output, hash mismatches, and the debug-only fixture markers. Electron Builder copies the verified stage to application resources. Production never searches `PATH` or substitutes another runtime after failure.

Commit runtime and app changes together. CI and release-candidate builds initialize the submodule and build Rust from the same checkout as the app. The Cargo cache defaults to `build/cargo`. Development builds may use a dirty checkout, which the application manifest records; release builds require a clean checkout and matching app/runtime source commits.

Runtime preparation streams test and build output before checking the packaging process's exit code. If it fails, inspect the failing test or compiler diagnostic in that log; the final packaging error only identifies the failed gate. Both runtime packaging entry points restore the current PowerShell's standard module paths so an inherited PowerShell 7 environment cannot hide Windows PowerShell's hashing and archive cmdlets.

The release bundle contains exactly five files: installer, portable executable, `manifest.json`, `SHA256SUMS.txt`, and `scraply-agent.lock.json`. The last file is copied from `build/runtime` and its hash must match the manifest. Promotion verifies that the runtime came from the approved Scraply commit and publishes these same five files without rebuilding Rust or the app. Historical releases retain their original app/runtime pair for rollback.

## Rollback

- Application: reinstall a previous GitHub Release after checking its published SHA-256 hash. The previous installer restores its pinned app/runtime pair; do not swap only `scraply-agent.exe`.
- Source: revert through a short-lived branch and pull request. Never move a published tag or force-push `master`.
- Data: close Scraply and restore a consistent backup of the whole data directory, including SQLite WAL/SHM files when present.
