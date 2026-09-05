# Scraply release process

`master` is the production branch. Every release change or rollback fix goes through a short-lived branch and a pull request into `master`.

## Publish a release candidate

After the target commit lands on `master` and passes CI:

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

## Signing and hashes

The package contains `release/manifest.json` with its source, artifact, and bundled-runtime metadata, plus `release/SHA256SUMS.txt` with installer and portable hashes. Manifest schema 2 records the runtime version, protocol versions, source commit, executable identity, notices, and SHA-256 hashes.

Private builds may be unsigned only when the workflow explicitly sets `SCRAPLY_ALLOW_UNSIGNED=1`; the manifest then records `signingPolicy: "private-unsigned"`. Reject broken signatures. Public releases require valid signatures for Scraply and the bundled runtime.

## Bundled native runtime

Scraply packages one tested `scraply-agent` executable at `resources/runtime/scraply-agent.exe`, outside `app.asar`. Native mode requires protocol 1.1. Runtime native protocol 1.0 is explicitly incompatible; the separate legacy commands remain migration-only behavior.

The runtime source lives in `runtime/` in this repository. The separate `nylow0/scraply-agent` repository is legacy. Initialize the pinned public OpenAI Codex submodule with `git submodule update --init --recursive`. Windows builds require Rust's `stable-x86_64-pc-windows-msvc` toolchain (including rustfmt and clippy) and Visual Studio C++ build tools.

`bun run prepare:runtime` runs the runtime's formatting, source budget, locked Rust tests, strict clippy, app adapter compatibility, and release packaging checks. It generates `build/runtime-artifacts/scraply-agent.windows-x64.lock.json`, recording this Scraply commit, the upstream commit, executable, notices, sizes, and hashes. Generated archives and locks are ignored build outputs. The archive contains only:

- `scraply-agent.exe`
- `LICENSE`
- `OPENAI-NOTICE`
- `UPSTREAM.md`
- `SHA256SUMS.txt`

After building, `bun run prepare:runtime` verifies the archive and every member before staging those files plus the lock in `build/runtime`. Verification rejects extra or unsafe archive paths, links, oversized files, non-x64 executables, incorrect version output, hash mismatches, and the debug-only fixture markers. Electron Builder copies the verified stage to application resources. Production never searches `PATH` or substitutes another runtime after failure.

Commit runtime and app changes together. CI and release-candidate builds initialize the submodule and build Rust from the same checkout as the app. The Cargo cache defaults to `build/cargo`. Development builds may use a dirty checkout, which the application manifest records; release builds require a clean checkout and matching app/runtime source commits.

The release bundle contains exactly five files: installer, portable executable, `manifest.json`, `SHA256SUMS.txt`, and `scraply-agent.lock.json`. The last file is copied from `build/runtime` and its hash must match the manifest. Promotion verifies that the runtime came from the approved Scraply commit and publishes these same five files without rebuilding Rust or the app. Historical releases retain their original app/runtime pair for rollback.

## Rollback

- Application: reinstall a previous GitHub Release after checking its published SHA-256 hash. The previous installer restores its pinned app/runtime pair; do not swap only `scraply-agent.exe`.
- Source: revert through a short-lived branch and pull request. Never move a published tag or force-push `master`.
- Data: close Scraply and restore a consistent backup of the whole data directory, including SQLite WAL/SHM files when present.
