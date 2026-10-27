---
name: scraply
description: Kill-test a rough seed (a hunch, a theme, a friend's link) against raw evidence with the scraply CLI until an idea worth building survives. Use when the user wants to find, choose, or pressure-test an idea, continue a scraply project, or export one.
---

# Scraply

An idea comes from the user's **seed** plus **kill tests**, not from generating a list and ranking it. The user brings the seed and steers. You run the tests. The `scraply` CLI keeps the record honest: it saves what you read, refuses quotes that are not in a saved page, rejects evidence you had already seen when you made your prediction, and never lets you edit an earlier entry.

`scraply help` lists every command and flag; `scraply help <command>` describes one. Output is JSON when piped. Every refusal has a `code` and a `message` that names the next command; follow it rather than working around it. IDs look like `P1` (project), `N` note, `W` search, `S` source, `Q` quote, `C` claim, `T` test, `V` verdict, `R` review, `I` idea. If `scraply` is not on PATH, run `bun link` once in the Scraply checkout. `scraply status` shows which search providers have a key.

## Continuing

To pick up saved work, run `scraply project list`, then `scraply show --project P1`. Read the claim statuses and carry on from the first step that is not done. Starting a project again loses its history.

## The loop

1. **Take the seed as given.** `scraply project new <name> --seed "<the user's words>"`. However rough, the seed is theirs; keep it, and propose variants only in step 9. Ask only for what would change the plan: time, money, access to people or equipment, and what "worth building" means. Save each answer as `note add --kind constraint`; reviewers see constraints.
2. **Frame it like an expert would.** Who knows this field, what would they look at first, and what is the rawest material (firsthand accounts, records, datasets, product docs, pricing pages, public code)? Save that as `note add --kind framing` before you search. Save prior art as `--kind prior-art` once a search has shown you what exists.
3. **Split the seed into claims that could be false.** One idea per claim, each with a `--kill-if`: one measurable condition, such as "fewer than two hobbyists describe it" or "a product under $5 a month already does X".
   - **need:** specific people have this problem now, in their own words.
   - **gap:** what exists does not already solve it.
   - **mechanism:** the approach would actually work.
   - **feasibility:** it can be built and tested with what the user has.
4. **Write the test before you look.** Pick the cheapest decisive claim: the one whose failure kills the most for the least work. `scraply test add --claim C1 --method ... --prediction ... --stop-when ...`. The prediction is a number or threshold where you can; `--stop-when` is the sample size or limit that ends the test. Evidence counts only if it was in nothing you had saved when the test was written, so search after this step, not before.
5. **Gather evidence until the stop condition.** `scraply search "<query>" --project P1` and `scraply fetch <url> --project P1`. Perplexity results are excerpts: fetch the page before you quote it. If a fetch fails, retry with `--via exa`; the failure stays in the record, which is how the user sees what was out of reach. When the user hands you material (interview notes, survey results) or you run an experiment, save it with `scraply source add --file <path> --origin owner|experiment`.
6. **Read every source you will cite in full**, looking for evidence against the claim as hard as for it. `scraply source show S1` returns long sources in windows; repeat with `--offset <nextOffset>` until `nextOffset` is gone. Save exact sentences with `scraply quote add`:
   - The speaker is the person's handle or name, or the organization that measured something. The same person on two pages is one speaker.
   - `firsthand` is someone's own experience; `measured` is a count, record, or study result; `vendor` is a seller describing its product, which shows what exists and never what people need.
   - Quote a sentence that stands on its own. If it answers a question, quote the question too.
7. **Record the verdict** with `scraply verdict add --by author ...`: `killed`, `unclear`, or `provisional` (you think it holds). The note says how the cited quotes bear on the claim and adds no facts of its own; anything you did not save as a quote does not count. To change your mind, add a new verdict, since the newest one wins. To fix a mistaken entry, `scraply retract <id> --reason ...`.
8. **Get an independent review of every provisional or killed verdict.** Start a fresh subagent that did not do the work and give it only this: "Run `scraply show --project P1 --for-review`. For each verdict in `toReview`, read every cited source in full with `scraply source show`, check that each quote's speaker and kind match the source, then try to break the verdict against its claim, kill condition, test, and the constraints. Record `scraply review add --verdict <id> --result upheld|overturned --by reviewer-1 --note ...`." Keep your own reasoning out of the hand-off. A provisional verdict becomes `supported` and a killed one `killed` only when upheld; an overturned verdict stays overturned, and the claim needs new work.
9. **Report and let the user steer.** A pass is done when one claim is killed or every claim has a reviewed verdict. Save each concrete idea that the evidence leaves standing or worth testing with `scraply idea add --claim ...` (use `--revises I1` for a variant). Tell the user briefly which claims are supported, which died, and which are untested, citing quote IDs. Untested is not survived. When a claim dies, propose the next variant of the seed, and add it as a claim only once the user agrees. `scraply export --project P1 --format markdown --out <file>` writes the full report.

## Rules

- Never pad. Zero surviving claims is a valid result.
- Agreement between agents is not evidence.
- Stop when the user says so, or when the next test needs something only the user can provide, such as a landing page, a survey, or a conversation. Then say exactly what that is, and save what they bring back with `source add`.
