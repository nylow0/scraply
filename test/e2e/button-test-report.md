# Scraply button test report

Tested on 2026-07-21 with the installed Windows app through Computer Use, using an isolated user-data directory and deterministic local mock backend. No real provider calls or research spend occurred.

## Summary

- Passed: 24 button/control behaviors
- Failed: 4 user-facing actions
- Safely limited: 2 destructive completion paths
- Test-harness fixes made during the pass: fixed-port startup, favorite/preset/export routes, and complete idea-generation responses

## Passed

| Area | Control | Result |
| --- | --- | --- |
| Sidebar | New research | Created and opened a new intake thread |
| Sidebar | User guide / Close | Modal opened and closed |
| Sidebar | Open data folder | Opened the isolated Scraply data directory in Explorer |
| Sidebar | Delete research / Cancel | Native destructive confirmation opened; Cancel dismissed it and preserved the thread |
| Header | Research / Close | Activity drawer opened and closed |
| Intake | Brief questions tab | Switched to questions without losing entered answers |
| Intake | Models & limits tab | Switched to model settings in the same setup workspace |
| Intake | Continue | Advanced from step 1 to step 2 and from step 2 to optional context |
| Intake | Back | Returned to the prior step and retained answers |
| Intake | Review brief | Submitted all 15 answers and produced the project brief |
| Models | Model library | Expanded and exposed the catalog controls |
| Models | All other models | Expanded the unstarred model list |
| Models | Add custom model | Added a mock custom Codex model to favorites |
| Recovery | Resume | Cleared interrupted state and restored completed reports |
| Recovery | Cancel run | Cancelled the isolated interrupted run and returned to a completed state |
| Reports | Market evidence | Expanded and loaded report HTML |
| Reports | Composite synthesis | Expanded and loaded report HTML |
| Ideas | Generate ideas | Generated and rendered the idea workspace |
| Ideas | Supporting evidence | Expanded the source and quote |
| Ideas | Ratings 1–5 | Every rating button saved and updated selection state |
| Ideas | Export JSON | Opened the native Save dialog with `scraply-ideas.json`; dialog was cancelled without writing a file |

## Failed or blocked

| Priority | Control | Result | Likely cause |
| --- | --- | --- | --- |
| P0 | Save settings | Fails with `An object could not be cloned.` | A deep Svelte `$state` proxy is passed directly over Electron IPC from `RunConfigPanel.svelte:249` |
| P0 | Save preset | Same clone failure | Same reactive `draft` object is passed at `RunConfigPanel.svelte:251` |
| P0 | Confirm brief & review cost | Same clone failure, blocking the normal path to run configuration | Reactive brief `draft` is passed directly at `BriefPanel.svelte:32` |
| P1 | Dive deeper | Button focuses and receives pointer/UI Automation activation, but the branch dialog never appears | Local branch state/dialog activation around `IdeaWorkspace.svelte:76` and `IdeaWorkspace.svelte:170` needs debugging |
| Blocked by P0 | Save configuration / Approve & start research | Not reachable through the normal workflow; both also pass the reactive run-config draft at `RunConfigPanel.svelte:243` and `RunConfigPanel.svelte:249` | Expected to share the clone failure until the payload is converted to a plain object |

## Safety-limited paths

- The final **OK** in Delete research was not pressed; only the confirmation and Cancel path were tested.
- Removing a favorite model was not executed because it is a destructive preference action. Adding and rendering favorites was verified.

## UX defects observed

- Non-intake screens still show the empty conversation message “Start a research thread” even when an active brief, reports, or ideas exist (`Conversation.svelte:20`).
- The sticky model-settings action bar can cover the lower model-library controls at shorter window heights.
- Error banners from a previous action remain visible after switching tabs, which makes unrelated screens look broken.

## Recommended fix order

1. Convert brief and run-config drafts to plain serializable objects before IPC (`structuredClone($state.snapshot(draft))` or an equivalent schema-parsed plain payload).
2. Add regression tests that invoke Save settings, Save preset, Confirm brief, and Approve & start research from the installed Electron renderer.
3. Debug `branchIdea` assignment/rendering for Dive deeper and add a dialog-open test.
4. Hide the empty conversation prompt whenever an active thread has brief/report/idea content.
