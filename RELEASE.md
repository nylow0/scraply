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

The checked-in `runtime-artifacts/scraply-agent.windows-x64.lock.json` pins the runtime version, source commit, vendored upstream commit, archive, executable, notices, sizes, and SHA-256 hashes. Its immutable archive name includes the runtime version and the first 12 characters of the source commit. The archive contains only:

- `scraply-agent.exe`
- `LICENSE`
- `OPENAI-NOTICE`
- `UPSTREAM.md`
- `SHA256SUMS.txt`

`bun run prepare:runtime` verifies the archive and every member before staging those files plus the lock in `build/runtime`. Verification rejects extra or unsafe archive paths, links, oversized files, non-x64 executables, incorrect version output, hash mismatches, and the debug-only fixture markers. Electron Builder copies the verified stage to application resources. Production never searches `PATH` or substitutes another runtime after failure.

To update the pin, start from a clean `scraply-agent` commit and run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/import-runtime-package.ps1 -RuntimeRepository ..\scraply-agent
```

The import runs the runtime repository's own package checks, consumes its exact release executable and required notices, then writes the immutable compressed archive and lock. Review and commit both files with the app change. Do not replace an existing version-and-source archive with different bytes. A normal app package or CI run consumes the tracked archive and never rebuilds Rust.

## Rollback

- Application: reinstall a previous GitHub Release after checking its published SHA-256 hash. The previous installer restores its pinned app/runtime pair; do not swap only `scraply-agent.exe`.
- Source: revert through a short-lived branch and pull request. Never move a published tag or force-push `master`.
- Data: close Scraply and restore a consistent backup of the whole data directory, including SQLite WAL/SHM files when present.
