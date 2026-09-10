# Scraply Project Instructions

- Use the Electron development window for routine application work. Before starting or verifying a change, follow [README.md: Development](README.md#development) for setup, runtime configuration, reload behavior, and verification choices.
- Verify the affected interaction in that window and run the relevant focused checks. Before handing off application code, run `bun run check`. Report what you exercised, results, and any unverified behavior; compilation or passing unit tests alone is not UI verification.
- Run `bun run build:installed` only for installer or packaging changes, behavior that depends on the packaged/installed app, release verification, or an explicit request for an installed build. Exercise the affected behavior in the resulting app. Routine UI/backend work, read-only questions, documentation changes, and intermediate investigation do not require packaging or installation.
- For documentation-only work, check instructions against the referenced scripts and links. If a required command fails, report the relevant error output and the verification it blocked.

- `master` is the only long-lived branch and the production branch.
- Create a short-lived branch from the latest `master` for every feature, fix, documentation change, or maintenance task. Use a clear prefix such as `feat/`, `fix/`, `docs/`, or `chore/`.
- Open a pull request from the short-lived branch into `master`. Do not commit directly to `master`.
- `dev` and `stage` are retired. When Dany says "main branch", he means `master`.

- Read and follow `RELEASE.md` before changing versions, release workflows, tags, publishing, signing, or rollback behavior.
- When a change affects the release process, update `RELEASE.md` in the same task.
