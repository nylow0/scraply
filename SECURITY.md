# Security policy

Scraply has no generally supported public release yet. Security fixes target the current `master` code and the next reviewed build. Older local installers and portable builds may need replacement after a fix. [RELEASE.md](RELEASE.md) explains how an accepted build is packaged and promoted.

## Report a vulnerability

Keep vulnerability details out of public issues and pull requests. This repository is private and has no published security mailbox. Collaborators should contact the maintainer through an existing private channel. At public launch, the maintainer plans to enable [GitHub private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately); when **Security → Report a vulnerability** becomes available, use that route. GitHub offers that reporting feature for public repositories.

Include the affected version or source commit, a concise reproduction, expected and observed behavior, and the security impact. Redact tokens, keys, personal data, and private project content. A local fixture or sanitized log excerpt is usually more useful than a full database. Do not test against someone else's account or data.

## What to examine

Scraply's privileged Electron host owns filesystem access, SQLite, encrypted credentials, provider requests, and the native worker. The renderer reaches it through a constrained preload bridge. Remote report links open outside the privileged window. Research pages and model output are untrusted input, even when shown beside saved project data. Search and model requests leave the device for the selected provider; local storage does not remove that boundary. Reports involving IPC, navigation, provider content, credential handling, exports, or package integrity are in scope.

Bundled upstream code and notices live under `runtime/`. Report an upstream-only issue to its owner as well; tell Scraply privately if the bundled version makes the issue reachable here.
