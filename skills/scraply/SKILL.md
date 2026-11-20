---
name: scraply
description: Kill-test a rough seed (a hunch, a product, a research question, a project idea) against raw evidence and experiments with Scraply until an idea worth doing survives. Use when the user wants to find, choose, or pressure-test an idea, continue a scraply project, or export one.
---

# Scraply

An idea comes from the user's **seed** plus **kill tests**, not from generating a list and ranking it. The seed is split into claims that could be false; the cheapest decisive claim is tested first, against first-hand evidence or an experiment on raw data; an independent review checks every verdict; and what survives, or what a dead claim revealed, becomes the next variant. The user steers.

You do the thinking. Scraply hands you one step at a time as a **work order**, keeps the evidence, and enforces the rules: quotes must be verbatim from a saved source, a need needs two speakers, a verdict counts only once a different reviewer upholds it.

Use the `scraply` MCP tools when they are connected (`next`, `submit`, `source_show`, …). Otherwise run the same commands in a shell: `scraply next --project P1`, piped output is JSON, and `scraply help <command>` describes one. If `scraply` is not on PATH, run `bun link` once in the Scraply checkout. Every refusal has a `code` and a `message` naming what to do; follow it rather than working around it.

## The loop

1. `project new <name> --seed "<the user's words>"`. The seed is theirs; keep their wording. `scraply status` shows whether a search key is saved; without one, only experiments can test claims.
2. `next --project P1` runs everything mechanical (searches, saving, trusted runs) and stops with a `status`:
   - **`think`**: a `workOrder`. Read its `method` and `instructions`, use its `inputs`, and read every listed source in full with `source show <id>` (repeat with `--offset <nextOffset>` until it is gone). Then `submit --project P1 --order <order> --answer <JSON matching answerSchema>`. `submit` returns the next stop, so keep going.
   - **`needs-you`**: only the user can do what `next` names. Questions: ask them, save each answer with `note add --kind constraint`, then `next` again (`--skip-questions` only if they say to go on without answering). An experiment: read the script in the folder named, tell the user what it fetches, runs, and writes, and run `experiment approve` only once they agree (`--trust` on `next` only if they said to trust it). Variants: summarize what survived, what died, and what is unknown, citing quote IDs, and accept the one they pick with `variant accept N# --project P1`.
   - **`done`**: the pass is finished. `export --project P1 --format markdown --out <file>` writes the report.
3. A refused `submit` (`BAD_ANSWER`, a ledger rule such as `ONE_SPEAKER`) changed nothing: fix the answer and submit the same order again. `STALE_ORDER` means the project moved on; run `next`.

To continue later: `project list`, then `next --project P#`. The loop rebuilds its place from the record.

## Independent review

A work order with `independent` set (every review) must not be answered by you if you did any earlier step of the project. Start a fresh subagent, give it the whole work order and how to call Scraply (the MCP tools, or `scraply` with `--data-dir <dataDir from status>`), have it return only the answer JSON, and submit that. Agreement between agents is not evidence; the reviewer's job is to break the verdict.

## Writing findings and variants

The findings work order closes a pass. Hold yourself to its instructions: untested is not survived; each finding cites the quotes it rests on; each variant keeps the seed's core output, names the closest existing product or method and how it would beat it, and says which part rests on this pass's quotes and which on expert judgment still to be tested. When a finding rests on a page the loop fetched but never quoted, save the exact sentences first with `quote add` so it can cite them.

## By hand

Every step has a command too (`search`, `fetch`, `quote add`, `claim add`, `test add`, `experiment run`, `verdict add`, `review add`, `idea add`, `retract`), for work the loop does not cover, such as material the user hands over (`source add --origin owner`). The ledger holds them to the same rules, and `next` picks up from whatever they recorded.

## Rules

- Never pad. Zero surviving claims, or an inconclusive result, is a valid answer.
- Generated text is never evidence; only what Scraply saved, quoted word for word, counts.
- Stop when the user says so, or when the next test needs something only the user can provide. Say exactly what that is, and save what they bring back with `source add`.
