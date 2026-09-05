# Known limitations

- Live OpenAI and OpenRouter account tests require user credentials and were not run as part of the offline suite.
- The deterministic provider fixture is available only in debug builds. Release binaries remove its environment-variable seams, so a live installed-provider result must be recorded separately from deterministic contract tests.
- Scraply has not yet moved from `app-server` and `exec -` to the persistent runtime protocol. The compatibility paths remain for one release.
- OpenRouter PKCE depends on Scraply to own the callback listener, open the browser, encrypt the returned key, and restore it after relaunch.
- Models.dev enrichment exists in the provider layer, but the desktop must choose and supply the metadata cache location. Metadata never changes availability.
- OpenCode Zen and Go remain disabled because the official direct gateway contract does not cover every required behavior.
- The provider adapters currently return terminal generation output. The runtime protocol supports progress events, but provider token deltas are not forwarded yet.
- The release evaluation corpus for all ten production schemas still needs live model credentials and redacted Scraply fixtures.
