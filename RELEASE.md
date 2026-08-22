# Scraply release process

Scraply uses two long-lived branches:

- `dev` — integration branch. Feature and fix PRs target `dev`.
- `master` — production branch. Promote `dev` through a normal pull request into `master`.

`main` is retired and must not be recreated. In this project, “main” means `master`.

## Local and CI gates

Pull requests and pushes to both `dev` and `master` run the same CI gates:

```powershell
bun install --frozen-lockfile
bun audit
bun run check
bun run test:e2e
bun run build:installed
bun run test:e2e:production
bun run test:e2e:portable
bun run test:e2e:installed
```

`test:e2e` exercises the deterministic E2E utility backend. The production and installed suites drive the real packaged executables and additionally boot the shipped production backend, so a broken `out/main/backend.js` cannot pass the gate. The portable target is a self-extracting wrapper that Playwright cannot attach to, so `test:e2e:portable` launches it as an ordinary process and requires it to create its database and log file.

The package verifier writes:

- `release/manifest.json` — version, source SHA/ref, dirty state, signing state, executable metadata, sizes, and hashes.
- `release/SHA256SUMS.txt` — installer and portable SHA-256 hashes.

Private/personal builds are intentionally unsigned and can trigger Windows SmartScreen. The verifier always rejects broken signature states such as `HashMismatch` or `NotTrusted`; it accepts `NotSigned` only when the release explicitly declares the private policy (`SCRAPLY_ALLOW_UNSIGNED=1`, recorded as `signingPolicy: "private-unsigned"`). Making the repository public switches the workflows to requiring valid signatures.

## Promote `dev` to `master`

Open a pull request from `dev` to `master`, wait for CI, review it, and merge it normally. Merge commits are supported; there is no exact-SHA branch-promotion check.

All fixes go back through `dev`. Do not commit release-only fixes directly to `master`.

## Publish a release candidate

After the promoted `master` CI is green, tag the current production commit:

```powershell
git fetch --prune origin
$sha = git rev-parse origin/master
bun scripts/check-promotion.ts rc $sha v0.3.0-rc.1
git tag -a v0.3.0-rc.1 $sha -m "Scraply 0.3.0 RC 1"
git push origin refs/tags/v0.3.0-rc.1
```

The tag workflow builds once from that clean SHA, installs and smoke-tests the package, verifies the bundle, and publishes the verified bytes as a GitHub prerelease. Install that exact prerelease and manually verify the full workflow, cancellation, restart recovery, links, logs, and deletion.

If the candidate fails, fix it on `dev`, promote `dev` to `master` again, and create a new RC tag on the new `master` SHA.

Exactly one release-candidate tag may point at the SHA promoted to production. If an RC is superseded, promote a new commit instead of adding a second RC tag to the same commit.

## Publish production

After the RC is accepted, validate and tag the same `master` SHA:

```powershell
$sha = git rev-parse origin/master
bun scripts/check-promotion.ts production $sha v0.3.0
git tag -a v0.3.0 $sha -m "Scraply 0.3.0"
git push origin refs/tags/v0.3.0
```

The production workflow does **not** rebuild. It requires exactly one `v0.3.0-rc.N` tag on that SHA, confirms it is a published prerelease, downloads its assets, and revalidates the bundle: exact file set, manifest schema, source SHA and ref, clean-tree flag, per-artifact sizes and SHA-256 values, executable identity, signing policy, and `SHA256SUMS.txt`. It then publishes those verified bytes as the final GitHub Release.

Because GitHub release assets are mutable by default, enable **immutable releases** on the repository so a published prerelease cannot be swapped after acceptance.

## Rollback

A release is mapped to its immutable source SHA in `manifest.json`.

- Application rollback: reinstall a previously accepted GitHub Release and verify its published SHA-256 checksum.
- Source rollback: create a fix or revert on `dev`, then promote it through `dev -> master`; do not force-push `master` or move published tags.
- Data rollback: close Scraply and restore a consistent backup of the entire data directory, including SQLite WAL/SHM files if present.

Enable a GitHub ruleset on `master` that requires pull requests and blocks force pushes and deletion. `dev` remains the working integration branch.
