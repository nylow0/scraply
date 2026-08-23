# Releasing Scraply

`dev` is the integration branch and `master` is production. All changes, including release fixes, must reach `master` through a `dev -> master` pull request. The retired `main` branch must not be recreated.

## One-time repository setup

- Enable immutable releases before publishing the first release. It only protects releases created after it is enabled.
- When the repository or GitHub plan supports rulesets, protect `master`: require pull requests and block force pushes and deletion.

## Promote to production

1. Open a pull request from `dev` to `master`.
2. Wait for CI to pass, review it, and merge normally.
3. Wait for CI on the resulting `master` commit to pass.

[`ci.yml`](.github/workflows/ci.yml) is the source of truth for required checks.

## Publish a release candidate

Tag the current `master` commit, replacing the example version:

```powershell
git fetch --prune origin
$sha = git rev-parse origin/master
bun scripts/check-promotion.ts rc $sha v0.3.0-rc.1
git tag -a v0.3.0-rc.1 $sha -m "Scraply 0.3.0 RC 1"
git push origin refs/tags/v0.3.0-rc.1
```

The tag workflow publishes a GitHub prerelease. Install that exact prerelease and manually test the complete user workflow, cancellation, recovery, links, logs, and deletion.

If it fails, fix it on `dev`, promote a new commit, and create a new RC tag. Do not place multiple RC tags on the same commit.

## Publish production

After accepting the RC, tag the same `master` commit:

```powershell
git fetch --prune origin
$sha = git rev-parse origin/master
bun scripts/check-promotion.ts production $sha v0.3.0
git tag -a v0.3.0 $sha -m "Scraply 0.3.0"
git push origin refs/tags/v0.3.0
```

Production reuses and revalidates the accepted RC artifacts; it does not rebuild them. Exactly one RC tag must point to the production commit.

## Rollback

- Application: reinstall an accepted older release and verify its published checksum.
- Source: revert or fix on `dev`, then promote normally. Never force-push `master` or move a published tag.
- Data: close Scraply and restore the complete data-directory backup, including SQLite WAL/SHM files.
