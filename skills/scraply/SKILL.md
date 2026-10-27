---
name: scraply
description: Kill-test a rough seed (a hunch, a product, a research question, a project idea) against raw evidence and experiments with the scraply CLI until an idea worth doing survives. Use when the user wants to find, choose, or pressure-test an idea, continue a scraply project, or export one.
---

# Scraply

An idea comes from the user's **seed** plus **kill tests**, not from generating a list and ranking it. The seed is split into claims that could be false; the cheapest decisive claim is tested first, by reading first-hand evidence or by running an experiment on raw data; a separate review checks every verdict; and what survives, or what a dead claim revealed, becomes the next variant. The user steers. The method and its reasons are in `prompts/loop/method.md` in the Scraply checkout.

`scraply help` lists every command; `scraply help <command>` describes one. Output is JSON when piped. Every refusal has a `code` and a `message` naming the next command; follow it rather than working around it. If `scraply` is not on PATH, run `bun link` once in the Scraply checkout. `scraply status` shows the search keys, the model account, and the worker.

## Let the loop think (default)

Scraply's own model does the thinking, step by step, and stops whenever the user is needed.

1. If `scraply status` shows `signed-out`, ask the user to run `scraply login`. If no model is chosen, show them `scraply models` and save their choice with `scraply config model <id> --effort <effort>`. Never pick a model for them.
2. `scraply project new <name> --seed "<the user's words>"`. The seed is theirs; keep their wording.
3. `scraply auto --project P1`. It runs until it returns a `status` of `needs-you` or `done`, and its `next` says exactly what is needed:
   - **Questions:** ask the user, then save each answer with `scraply note add --project P1 --kind constraint --text "..."` and run `auto` again. Use `--skip-questions` only if the user says to go on without answering.
   - **An experiment to approve:** the loop wrote a program into the folder named in `next`. Tell the user what it fetches, what it runs, and where it writes, and run `scraply experiment approve --project P1 --test T#` only once they agree. If the user said to trust the loop, pass `--trust` to `auto` instead.
   - **Findings and variants:** summarize what survived, what died, and what is still unknown, citing quote IDs, and list the variants from `scraply show --project P1`. Accept the one the user picks with `scraply variant accept N# --project P1`, then run `auto` again.
4. `scraply export --project P1 --format markdown --out <file>` writes the full report.

To continue later, `scraply project list`, then `scraply auto --project P#`: the loop rebuilds its place from the record.

## Do the thinking yourself

When the user wants you to reason instead of Scraply's model, drive the same record by hand. The ledger enforces the same rules either way.

1. **Frame it like an expert** and save it with `note add --kind framing`. Search for what exists (`scraply search`) and save it as `--kind prior-art`, citing quotes.
2. **Claims:** `scraply claim add --kind need|gap|mechanism|feasibility --statement ... --kill-if ...`. One idea per claim; the kill condition is one specific observation, never a strawman. Save the idea with `scraply idea add --claim ...`.
3. **Test before looking:** `scraply test add --claim C# --method ... --prediction ... --stop-when ...`. Claims about how the world behaves usually need `--kind experiment` with `--sanity` (a known answer the setup must reproduce), `--control` (a placebo, baseline, or the existing method), and `--holdout` (data kept aside for replication).
4. **Gather:** `scraply search` and `scraply fetch <url>` for desk tests (fetch Perplexity results before quoting them); `scraply experiment run --test T# -- <command>` for experiments, so the output is saved by Scraply, not retyped. Material the user hands over goes in with `scraply source add --file <path> --origin owner`.
5. **Read in full** with `scraply source show S#` (repeat with `--offset` until `nextOffset` is gone), looking as hard for evidence against as for it, and save exact sentences with `scraply quote add`: the speaker is the person or organization, and the kind is `firsthand`, `measured`, `vendor`, or `other`.
6. **Verdict:** `scraply verdict add --by author --result killed|unclear|provisional --quote ... --test T# --note ...`. The note uses no quotation marks and no facts beyond the cited quotes.
7. **Review:** start a fresh subagent that did not do the work. Give it the ledger folder from `scraply status` and this: "Pass `--data-dir <folder>` to every scraply command. Run `scraply show --project P1 --for-review`. For each verdict in `toReview`, read every cited source in full, check each quote's speaker and kind, and try to break the verdict against its claim, kill condition, test, and the constraints; for an experiment, check the sanity check, control, and holdout; for a kill that rests on finding nothing, judge from `searches` whether the author looked in the right places. Record `scraply review add --verdict <id> --result upheld|overturned --by reviewer-1 --note ...`."
8. **Findings:** save what the evidence showed with `note add --kind finding --quote ...`, propose variants with `note add --kind variant`, and let the user choose.

## Rules

- Never pad. Zero surviving claims, or an inconclusive result, is a valid answer.
- Agreement between agents is not evidence.
- Stop when the user says so, or when the next test needs something only the user can provide, such as a survey or a conversation. Say exactly what that is, and save what they bring back with `source add`.
