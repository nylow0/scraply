# Scraply Project Instructions

- Use `bun run dev` for routine application work: it starts a background server and returns a browser URL. Follow [README.md: Development](README.md#development) for setup, data profiles, reload behavior, stop/restart, and verification choices. Keep the server running and give Dany its URL and checkout path at handoff; open Electron/DevTools windows only for an explicitly needed desktop check.
- Verify the affected interaction in the browser and run the relevant focused checks. Before handing off application code, run `bun run check`. Report what you exercised, results, and any unverified behavior; compilation or passing unit tests alone is not UI verification. Changes to Electron windows, preload, permissions, dialogs, or desktop integration also require the explicit desktop check described in the README.
- Run `bun run build:installed` only for installer or packaging changes, behavior that depends on the packaged/installed app, release verification, or an explicit request for an installed build. Exercise the affected behavior in the resulting app. Routine UI/backend work, read-only questions, documentation changes, and intermediate investigation do not require packaging or installation.
- For documentation-only work, check instructions against the referenced scripts and links. If a required command fails, report the relevant error output and the verification it blocked.

- `master` is the only long-lived branch and the production branch.
- Create a short-lived branch from the latest `master` for every feature, fix, documentation change, or maintenance task. Use a clear prefix such as `feat/`, `fix/`, `docs/`, or `chore/`.
- Open a pull request from the short-lived branch into `master`. Do not commit directly to `master`.
- `dev` and `stage` are retired. When Dany says "main branch", he means `master`.

- Read and follow `RELEASE.md` before changing versions, release workflows, tags, publishing, signing, or rollback behavior.
- When a change affects the release process, update `RELEASE.md` in the same task.
