# One-release compatibility

Scraply still invokes the 0.1.0 inspection and generation shapes. This repository keeps those shapes as thin adapters while the desktop moves to the `runtime` JSONL protocol.

## `app-server`

The compatibility server accepts only `initialize`, `initialized`, `account/read`, and `model/list`. It delegates account and model work to the fail-closed OpenAI subscription adapter. Model pagination remains bounded to 100 items. Unknown messages fail closed.

## `exec -`

The compatibility command accepts Scraply's existing read-only flags. It splits the exact legacy prompt boundary into a trusted stage instruction and one untrusted `legacy-task-data` evidence item, supplies Scraply's schema to the new core, and writes only locally validated JSON through an atomic replace.

It performs one model call. It has no tool declaration, Exa key, research request, replay loop, provider fallback, or hidden repair. Scraply's current caller-owned schema retry remains outside the runtime until the desktop moves to the explicit `repairPolicy` field.

## Removal condition

Delete `app-server`, `exec -`, their parser types, and their tests after the installed Scraply app completes provider connection, model selection, one full workflow, relaunch, cancellation, and logout through the new runtime protocol.
