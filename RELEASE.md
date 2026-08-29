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

The package contains `release/manifest.json` with its source and artifact metadata, plus `release/SHA256SUMS.txt` with installer and portable hashes.

Private builds may be unsigned only when the workflow explicitly sets `SCRAPLY_ALLOW_UNSIGNED=1`; the manifest then records `signingPolicy: "private-unsigned"`. Reject broken signatures. Public releases require valid signatures.

## Rollback

- Application: reinstall a previous GitHub Release after checking its published SHA-256 hash.
- Source: revert through a short-lived branch and pull request. Never move a published tag or force-push `master`.
- Data: close Scraply and restore a consistent backup of the whole data directory, including SQLite WAL/SHM files when present.
