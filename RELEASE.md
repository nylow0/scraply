# Scraply release process

Scraply uses three long-lived branch pointers:

- `dev` — integration branch. Feature and fix PRs target `dev`.
- `stage` — current release candidate. It receives no direct commits, fixes, merges, or cherry-picks.
- `master` — production source. It advances only to the exact SHA already accepted on `stage`.

`main` is retired and must not be recreated.

## Local and CI gates

Before promotion, the exact candidate must pass from a clean checkout:

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

Private/personal 0.3 builds are intentionally unsigned and can trigger Windows SmartScreen. The verifier always rejects broken signature states such as `HashMismatch` or `NotTrusted`; it accepts `NotSigned` only when the release explicitly declares the private policy (`SCRAPLY_ALLOW_UNSIGNED=1`, recorded as `signingPolicy: "private-unsigned"`). Making the repository public switches the workflows to requiring valid signatures.

## Promote `dev` to `stage`

Use the full green `origin/dev` SHA. The validator is read-only and prints the exact push command:

```powershell
git fetch --prune origin
$sha = git rev-parse origin/dev
bun scripts/check-promotion.ts stage $sha
```

After explicit approval, run the printed fast-forward push. Do not use the stale local `stage` branch as the source.

When stage CI is green, validate and push an annotated RC tag:

```powershell
bun scripts/check-promotion.ts rc $sha stage-v0.3.0-rc.1
git tag -a stage-v0.3.0-rc.1 $sha -m "Scraply 0.3.0 RC 1"
git push origin refs/tags/stage-v0.3.0-rc.1
```

The tag workflow builds once from that clean SHA in a read-only job, installs and smoke-tests the package, verifies the bundle, and hands it to a separate write-scoped job that only publishes the already-verified bytes as a GitHub prerelease. Install that exact prerelease and manually verify the full workflow, cancellation, restart recovery, links, logs, and deletion.

Failures are fixed on `dev`, then a new exact SHA and RC tag are promoted. Never patch `stage`.

Exactly one release-candidate tag may point at the SHA that is promoted to production. If an RC is superseded, promote a new `dev` SHA rather than adding a second RC tag to the same commit.

## Promote `stage` to production

After the RC is explicitly accepted:

```powershell
$sha = git rev-parse origin/stage
bun scripts/check-promotion.ts master $sha
```

After approval, run the printed fast-forward push and wait for master CI. Verify that `origin/stage` and `origin/master` resolve to the same SHA.

Then validate and push the production tag:

```powershell
bun scripts/check-promotion.ts production $sha v0.3.0
git tag -a v0.3.0 $sha -m "Scraply 0.3.0"
git push origin refs/tags/v0.3.0
```

The production workflow does **not** rebuild. A read-only job requires exactly one `stage-v0.3.0-rc.N` tag on that SHA, confirms it is a published prerelease, downloads its assets, and revalidates the bundle: exact file set, manifest schema, source SHA and ref, clean-tree flag, per-artifact sizes and SHA-256 values, executable identity, signing policy, and `SHA256SUMS.txt`. Only then does a separate write-scoped job publish those verified bytes as the final GitHub Release.

Because GitHub release assets are mutable by default, enable **immutable releases** on the repository so a published prerelease cannot be swapped after acceptance.

## Rollback

A release is mapped to its immutable source SHA in `manifest.json`.

- Application rollback: reinstall a previously accepted GitHub Release and verify its published SHA-256 checksum.
- Source rollback: promote a new fix through `dev -> stage -> master`; do not force-push production branches or move published tags.
- Data rollback: close Scraply and restore a consistent backup of the entire data directory, including SQLite WAL/SHM files if present.

Branch deletion, stale PR closure, and worktree cleanup are separate maintenance operations and must not be combined with release publication.

## Known limitation

Push-triggered CI validates `stage` and `master` after the ref has already moved. It compares the pushed SHA against `github.event.before` to detect non-fast-forward updates, but detection is not prevention. Enable GitHub branch rulesets that block force pushes and deletions on `stage` and `master` as soon as the repository plan allows; until then, promotion depends on following the commands above.
