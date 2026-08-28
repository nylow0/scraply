# Scraply Project Instructions

- After each run, run `bun run build:installed` from the project root.
- If that command fails, report the failure clearly and include the relevant error output.


- `master` is the only long-lived branch and the production branch.
- Create a short-lived branch from the latest `master` for every feature, fix, documentation change, or maintenance task. Use a clear prefix such as `feat/`, `fix/`, `docs/`, or `chore/`.
- Open a pull request from the short-lived branch into `master`. Do not commit directly to `master`.
- `dev` and `stage` are retired. Do not base new work on them or target them with pull requests.
- There is no `main` branch. When Dany says "main branch", he means `master`.

- Read and follow `RELEASE.md` before changing versions, release workflows, promotion rules, tags, publishing, or rollback behavior.
- When a change affects the release process, update `RELEASE.md` in the same task.
