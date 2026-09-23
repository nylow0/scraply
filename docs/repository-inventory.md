# Repository document inventory

This maps the Markdown files tracked before the documentation move. It records purpose and ownership; it is not a secret-audit result. Preserve historical records until the maintainer confirms an item is obsolete or private.

| Files | Purpose and owner | Action |
| --- | --- | --- |
| `README.md` | Product entry point, project maintainers | Shorten and link to focused guides. |
| `AGENTS.md`, `CLAUDE.md` | Root agent instructions and Claude pointer, project maintainers | Keep project instructions concise; keep the pointer. |
| `RELEASE.md` | Authoritative branch, package, signing, and promotion policy, release maintainers | Preserve. Update only with a release-process change. |
| `ACCEPTANCE.md` | Acceptance status, project maintainers | Keep as an index; store dated evidence in `docs/acceptance/`. |
| `artifacts/code-review-2026-08-23.md` | Historical code-review record, project maintainers | Preserve as an artifact, not current acceptance. |
| `plans/source/gen-crawler-scrapy-synergy-plan.md` | Historical planning source, project maintainers | Preserve as a historical plan. |
| `plans/source/rework-collaboration-protocol.md` | Historical planning source, project maintainers | Preserve as a historical plan. |
| `plans/source/scraply-intake-v2-implementation.md` | Historical implementation plan, project maintainers | Preserve as a historical plan. |
| `plans/source/scraply-intake-v2-pilot-baseline.md` | Historical pilot baseline, project maintainers | Preserve as a historical plan. |
| `plans/source/scraply-research-idea-engine-plan.md` | Historical research and idea plan, project maintainers | Preserve as a historical plan. |
| `plans/source/scraply-stabilization-performance-roadmap.md` | Historical performance roadmap, project maintainers | Preserve as a historical plan. |
| `prompts/workflow-v2-{decision-analysis,factor-harvest,problem-candidates,problem-kill,query-plan,risk-evaluation,solutions}.md` | Bundled application prompts, workflow owners | Preserve as packaged assets. Update the stage registry and package checks when prompt names change. |
| `runtime/AGENTS.md`, `runtime/CONTEXT.md`, `runtime/README.md`, `runtime/UPSTREAM.md` | Runtime instructions, domain context, build guide, and provenance, runtime owners | Keep scoped under `runtime/`. |
| `runtime/docs/adr/0001-custom-runtime.md`, `runtime/docs/auth-architecture.md`, `runtime/docs/known-limitations.md` | Runtime decision and technical references, runtime owners | Preserve. |
| `skill-src/html-plan/SKILL.md` | Source for the repository's HTML planning skill, skill owner | Preserve; review independently before publishing repository history. |

`runtime/vendor/openai-codex` is a pinned submodule. Its docs, license, and notices belong to the upstream project and should retain their original meaning. `runtime/LICENSE` and bundled third-party notices are legal assets, not project-license substitutes. The security audit covers history and publishable artifacts separately from this document inventory.

This rework also adds `prompts/workflow-v2-solution-set-review.md` and `prompts/workflow-v2-idea-follow-up.md`. They are packaged application prompts and follow the same ownership and verification rules as the seven original workflow prompts.
