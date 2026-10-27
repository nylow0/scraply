---
name: scraply
description: Kill-test a rough seed (a hunch, a product, a research question, a project idea) against raw evidence and experiments with the scraply CLI until an idea worth doing survives. Use when the user wants to find, choose, or pressure-test an idea, continue a scraply project, or export one.
---

# Scraply

An idea comes from the user's **seed** plus **kill tests**, not from generating a list and ranking it. The seed is split into claims that could be false; the cheapest decisive claim is tested first, by reading first-hand evidence or by running an experiment on raw data; a separate review checks every verdict; and what survives, or what a dead claim revealed, becomes the next variant. The user steers. The method and its reasons are in `prompts/loop/method.md` in the Scraply checkout.

`scraply help` lists every command; `scraply help <command>` describes one. Output is JSON when piped. Every refusal has a `code` and a `message` naming the next command; follow it rather than working around it. If `scraply` is not on PATH, run `bun link` once in the Scraply checkout.

## Scraply researches, you make the ideas (default)

Scraply's model does the research: framing, prior art, claims, test design, searches, experiments, verdicts, and reviews. You turn what it found into findings and variants.

1. **Setup.** `scraply status`. If `modelAccount` is `signed-out`, ask the user to run `scraply login`. If `model` is null, apply the user's default: the `sol` model with the highest version in `scraply models`, at effort `high`, saved with `scraply config model <id> --effort high`; tell them which one you chose. If `scraply models` lists a newer `sol` than the saved model, or a run refuses with `MODEL_UNAVAILABLE`, tell the user and switch only once they agree.
2. `scraply project new <name> --seed "<the user's words>"`. The seed is theirs; keep their wording.
3. `scraply auto --project P1 --agent-findings`. A model call can take over ten minutes, so give it a long timeout. It runs until it returns a `status` of `needs-you`, `done`, or `paused` (run the same command again), and the `next` field of its output says exactly what is needed. (`scraply next` is a different command: it runs one step.)
   - **A failed step** (`MODEL_FAILED`): run the same command again. If the same step fails twice in a row, stop and tell the user what failed; a lower effort is their call.
   - **Questions:** ask the user, then save each answer with `scraply note add --project P1 --kind constraint --text "..."` and run `auto` again. Use `--skip-questions` only if the user says to go on without answering.
   - **An experiment to approve:** the loop wrote a program into the folder named in `next`. Read it, tell the user what it fetches, what it runs, and where it writes, and run `scraply experiment approve --project P1 --test T#` only once they agree. If the user said to trust the loop, pass `--trust` to `auto` instead.
   - **Findings:** the pass is over and the ideas are yours to make; see [Making the ideas](#making-the-ideas).
   - **A variant to choose:** summarize what survived, what died, and what is still unknown, citing quote IDs, and present your variants. Accept the one the user picks with `scraply variant accept N# --project P1`, then run `auto --agent-findings` again: Scraply splits it into claims and tests them.
4. `scraply export --project P1 --format markdown --out <file>` writes the full report.

To continue later, `scraply project list`, then `scraply auto --project P# --agent-findings`: the loop rebuilds its place from the record. Without `--agent-findings`, Scraply's model writes the findings and variants too; run it that way only when the user asks.

### Making the ideas

Read the whole record first: `scraply show --project P1` for every claim, verdict, review, and quote, and `scraply source show S#` for each experiment run's full output (repeat with `--offset` until `nextOffset` is gone). The work order Scraply's model follows for this step is `prompts/loop/findings.md` in the checkout; hold yourself to it. When a finding or variant rests on a page the loop fetched but never quoted, such as a competitor's product page, save the exact sentences first with `scraply quote add`, so it can cite them.

- **Findings** are what the evidence showed beyond the verdicts: a surviving signal inside a dead claim, a group with a sharper version of the problem, an existing solution's specific failure. Save each with `scraply note add --project P1 --kind finding --quote Q# --text "..."`, citing every quote it rests on.
- **Variants**, one to three, are the next versions of the seed, each stated as the thing itself: the product, or the prediction and what it beats. Each one:
  - keeps the seed's core output, so the user still recognizes their seed;
  - names the closest existing product or method from the prior art and the measurable way it would beat it;
  - follows the evidence: every held-out cut with a positive estimate is taken up by a variant or ruled out in your summary;
  - is the bet the best expert in the field would make, where the surviving signal should be strongest, and says which part rests on this pass's quotes and which on expert judgment still to be tested.

  Save each with `scraply note add --project P1 --kind variant --text "<title>: <pitch, two to four sentences> Why: <the quotes or cuts, and the judgment>"`. A repeat, audit, or benchmark of the same test is the loop's job, not a variant. If nothing survived and no finding points anywhere, save no variant and say so.
- Run `scraply auto --project P1 --agent-findings` once your notes are saved; it closes the pass with them and returns the variants to choose from.

## Do all the thinking yourself

When the user wants you to reason instead of Scraply's model at every step, drive the same record by hand. The ledger enforces the same rules either way.

1. **Frame it like an expert** and save it with `note add --kind framing`. Search for what exists (`scraply search`) and save it as `--kind prior-art`, citing quotes.
2. **Claims:** `scraply claim add --kind need|gap|mechanism|feasibility --statement ... --kill-if ...`. One idea per claim; the kill condition is one specific observation, never a strawman. Save the idea with `scraply idea add --claim ...`.
3. **Test before looking:** `scraply test add --claim C# --method ... --prediction ... --stop-when ...`. Claims about how the world behaves usually need `--kind experiment` with `--sanity` (a known answer the setup must reproduce), `--control` (a placebo, baseline, or the existing method), and `--holdout` (data kept aside for replication).
4. **Gather:** `scraply search` and `scraply fetch <url>` for desk tests (fetch Perplexity results before quoting them); `scraply experiment run --test T# -- <command>` for experiments, so the output is saved by Scraply, not retyped. Material the user hands over goes in with `scraply source add --file <path> --origin owner`.
5. **Read in full** with `scraply source show S#` (repeat with `--offset` until `nextOffset` is gone), looking as hard for evidence against as for it, and save exact sentences with `scraply quote add`: the speaker is the person or organization, and the kind is `firsthand`, `measured`, `vendor`, or `other`.
6. **Verdict:** `scraply verdict add --by author --result killed|unclear|provisional --quote ... --test T# --note ...`. The note uses no quotation marks and no facts beyond the cited quotes.
7. **Review:** start a fresh subagent that did not do the work. Give it the ledger folder from `scraply status` and this: "Pass `--data-dir <folder>` to every scraply command. Run `scraply show --project P1 --for-review`. For each verdict in `toReview`, read every cited source in full, check each quote's speaker and kind, and try to break the verdict against its claim, kill condition, test, and the constraints; for an experiment, check the sanity check, control, and holdout; for a kill that rests on finding nothing, judge from `searches` whether the author looked in the right places. Record `scraply review add --verdict <id> --result upheld|overturned --by reviewer-1 --note ...`."
8. **Findings and variants:** as in [Making the ideas](#making-the-ideas), then let the user choose.

## Rules

- Never pad. Zero surviving claims, or an inconclusive result, is a valid answer.
- Agreement between agents is not evidence.
- Stop when the user says so, or when the next test needs something only the user can provide, such as a survey or a conversation. Say exactly what that is, and save what they bring back with `source add`.
