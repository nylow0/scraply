# Scraply project instructions

- Use `bun run dev` for routine application work. It starts a background browser server. Follow [development](docs/development.md) for setup, credentials, reloads, verification choices, and the stop/build/restart sequence. Keep the server running and report its URL and checkout path at handoff.
- Verify affected behavior in the browser and run focused checks. Run `bun run check` before handing off application code. Report the interaction, visible result, checks, and anything unverified. Electron window, preload, permission, dialog, and desktop integration changes also need the explicit desktop check in the development guide.
- After an application change, stop development, run `bun run build:installed` from the checkout root, then restart development for handoff. Skip packaging for documentation-only work and read-only investigation. Report any failure and the verification it blocked.
- For documentation-only work, check referenced commands against scripts and check links.
- The TypeScript app owns research, persistence, credentials, and orchestration. The [native runtime](runtime/AGENTS.md) handles bounded generation and provider transport. Keep contract changes and consumer checks in one pull request.
- `master` is the only long-lived production branch. Create a short-lived `feat/`, `fix/`, `docs/`, or `chore/` branch from the latest `master` for each change and open a pull request into `master`. Remove its worktree after the pull request merges; see [development](docs/development.md). "Main branch" means `master`.
- Read [RELEASE.md](RELEASE.md) before changing versions, release workflows, tags, publishing, signing, or rollback behavior. Update it in the same task when the release process changes.
