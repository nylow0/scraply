# Authentication architecture

Scraply owns persisted credentials. The runtime owns only the active session and private provider login code.

## OpenAI subscription

The OpenAI adapter wraps the pinned browser callback login, device login, token refresh, logout, and ChatGPT subscription transport. It validates that the account uses ChatGPT subscription credentials before model discovery or generation. Live model discovery fails on network, authentication, parse, or empty-catalog errors. There is no bundled fallback.

Upstream OpenAI auth and transport types stay inside `scraply-agent-providers`. The core sees only the Scraply provider interface.

## OpenRouter

Interactive login uses PKCE S256. Scraply supplies a localhost or HTTPS callback URL and opens the returned authorization URL. The runtime keeps the verifier in the pending login object, exchanges the returned code, and sends the resulting credential to Scraply once. Scraply encrypts it with Electron `safeStorage`.

Manual keys and restored keys enter through `credential.session.set`. The runtime stores them in a redacted in-memory session. Logout drops that session.

## Credential rules

- No key or token is accepted through argv or environment variables.
- The desktop strips inherited Codex/OpenAI tokens and authentication endpoint overrides before launching the child. Direct runtime launches reject those settings before initializing the OpenAI adapter. Standalone `login` and `logout` commands are unsupported; account operations use the private JSONL session.
- The runtime does not read OpenCode `auth.json`, neighboring `.env` files, or browser sessions.
- Error values contain stable codes, retryability, safe detail, and an optional bounded provider request ID. They never include response bodies or credentials.
- The release package contains no `.env` file.

The `SCRAPLY_AGENT_TEST_FIXTURE` environment seam exists only in debug builds. The package script rejects a release binary containing that marker.
