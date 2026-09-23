# Contributing

Scraply is currently developed in a private repository. Start with the [product README](README.md), then follow [development](docs/development.md) for setup and verification. Native runtime changes also need the [runtime guide](runtime/README.md).

Create a short-lived `feat/`, `fix/`, `docs/`, or `chore/` branch from the latest `master`. Keep the pull request focused on one behavior or maintenance task. Explain the visible result, the affected workflow you exercised, the checks you ran, and anything you could not verify. Use the [pull request template](.github/pull_request_template.md). `master` is the only long-lived branch; `dev` and `stage` are retired.

For application changes, exercise the affected interaction in the browser or installed app as appropriate, run focused checks, then `bun run check`. Complete the installed build required by [development](docs/development.md#verification-and-handoff). Documentation changes need checked links and commands. [RELEASE.md](RELEASE.md) has the separate release gates. GitHub Actions are currently disabled by policy, so include exact local verification results in the pull request.

Before committing staged files, run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/check-secrets.ps1 -Scope staged
```

The check examines staged paths and content; it does not certify repository history. [Development](docs/development.md#secret-checks) describes the separate history scan.

Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md) for reproducible failures and the [feature request template](.github/ISSUE_TEMPLATE/feature_request.md) for a proposed behavior. Share the smallest redacted example that reproduces an issue. For a vulnerability, follow [SECURITY.md](SECURITY.md) and keep the report private.
