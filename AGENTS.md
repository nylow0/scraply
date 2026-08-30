# Scraply Project Instructions

- After completing an application change, run `bun run build:installed` from the project root so Dany can test the installed build immediately. Skip it for read-only questions, documentation-only changes, and intermediate investigation. If it fails, report the relevant error output.

- `master` is the only long-lived branch and the production branch.
- Create a short-lived branch from the latest `master` for every feature, fix, documentation change, or maintenance task. Use a clear prefix such as `feat/`, `fix/`, `docs/`, or `chore/`.
- Open a pull request from the short-lived branch into `master`. Do not commit directly to `master`.
- `dev` and `stage` are retired. When Dany says "main branch", he means `master`.

- Read and follow `RELEASE.md` before changing versions, release workflows, tags, publishing, signing, or rollback behavior.
- When a change affects the release process, update `RELEASE.md` in the same task.
