# Upstream provenance

## Pin

- Project: `openai/codex`
- Repository: <https://github.com/openai/codex>
- Release tag: `rust-v0.144.4`
- Commit: `8c68d4c87dc54d38861f5114e920c3de2efa5876`
- Commit date: 2026-07-13T21:20:37-07:00
- Retrieved: 2026-08-23
- License: Apache-2.0

The sparse reference checkout is stored at `vendor/openai-codex`. Its Git metadata records the exact pin.

Production code imports only `codex-login`, `codex-api`, and `codex-utils-home-dir`. They supply browser and device login, refresh and logout, credential-directory resolution, and the ChatGPT subscription Responses transport. All upstream types remain private to `scraply-agent-providers`.

The local runtime does not call Codex tasks, prompts, tools, app-server protocol, shell execution, Git behavior, TUI, configuration loading, model fallback catalog, or agent loop. The wider transitive graph comes from the three pinned service-boundary crates and remains a dependency-audit target.

## Update rules

An upstream update must:

1. change the tag and full commit above;
2. compare browser and device login, refresh, logout, credential storage, and ChatGPT bearer/account headers;
3. compare the subscription model and Responses request contracts;
4. run the complete offline workspace and installed-process tests;
5. run live OpenAI login, model discovery, generation, cancellation, expired-session recovery, relaunch, and logout checks;
6. update the license and notice inventory.

No file under `vendor/openai-codex` is patched. Scraply-specific behavior lives in the three local workspace crates.

## License inventory

- `vendor/openai-codex/LICENSE`: upstream Apache License 2.0
- `vendor/openai-codex/NOTICE`: upstream notices
- `LICENSE`: Scraply runtime Apache License 2.0
