---
name: scraply
description: Turn a rough seed (a hunch, a theme, a friend's link) into a project worth building by testing its claims against raw evidence with the scraply CLI. Use when the user wants to find, choose, or pressure-test an idea.
---

# Scraply

Ideas come from a seed plus kill tests, not from generating a list and ranking it. The user brings the seed and steers. You run the tests. The `scraply` CLI keeps the record honest: it saves what you read, refuses quotes that are not in a saved page, and never lets you edit an earlier entry.

Run `scraply help` for every command and flag. Output is JSON when piped; IDs look like `P1`, `S3`, `Q7`, `C2`, `T1`, `V4`. If `scraply` is not on PATH, run `bun link` once in the Scraply checkout.

## The loop

1. **Take the seed as given.** `scraply project new <name> --seed "<the user's words>"`. However rough the seed, it is theirs. Never swap it for an idea you like better. Ask only for what would change the plan: time, money, access to people or equipment, and what "worth building" means. Save each answer with `scraply note add --project P1 --kind constraint --text "..."`.
2. **Frame it like an expert would.** Who knows this field, what would they look at first, and what is the rawest material (firsthand accounts, records, datasets, product docs, pricing pages, public code)? Save this with `note add --kind framing` before you search. Save prior art with `--kind prior-art` once a search has shown you what exists, not from memory.
3. **Split the seed into claims that could be false.** `scraply claim add --project P1 --kind need|gap|mechanism|feasibility --statement "..." --kill-if "..."`:
   - **need:** specific people have this problem now, in their own words.
   - **gap:** what exists does not already solve it.
   - **mechanism:** the approach would actually work.
   - **feasibility:** it can be built and tested with what the user has.

   One idea per claim; do not bundle. `--kill-if` is one measurable condition, such as "fewer than two hobbyists describe it" or "a product under $5 a month already does X".
4. **Test the cheapest decisive claim first**, the one whose failure kills the most for the least work. Write the test before you look: `scraply test add --claim C1 --method "..." --prediction "..."`. Then gather evidence with `scraply search "<query>" --project P1` and `scraply fetch <url> --project P1`. If a fetch fails, retry with `--via exa`. Failed fetches stay in the ledger, which is how the user sees what was out of reach.
5. **Read every source you will cite in full** with `scraply source show S1`, and look for evidence against the claim, not only for it. Save the exact words with `scraply quote add --source S1 --speaker <who> --kind firsthand|vendor|other --text "..."`.
   - The speaker is the person's handle or name. The same person on two pages is one speaker.
   - `firsthand` is someone describing their own experience. `vendor` is a seller describing its product: evidence of what exists, never of what people need. Only firsthand quotes count toward a need.
   - Quote a sentence that stands on its own. If it answers a question, quote the question too.
6. **Record the verdict**: `scraply verdict add --claim C1 --result killed|unclear|provisional --quote Q1 --quote Q2 --test T1 --note "..."`.
   - `provisional` means you think the claim holds; it becomes `supported` only after a review. A need needs firsthand quotes from two different speakers.
   - Notes explain how the cited quotes support the verdict. They cannot contain quotation marks and must not add facts of their own: anything you did not save as a quote, including search snippets and product names you saw in passing, does not count.
   - A prediction is only tested by evidence you had not seen when you wrote it. `scraply show` reports `quotesFetchedAfterPrediction`; a provisional verdict should have at least one. A claim you wrote after reading its evidence is a new claim, and its test needs new sources.
   - To change your mind, add a new verdict; the newest one wins.
7. **Review every provisional or killed verdict before you report it.** Start a fresh subagent that did not do the work. Give it only the project ID and these instructions: run `scraply show --project P1 --for-review`, read the cited sources in full with `scraply source show`, try to break each provisional and killed verdict, and record `scraply review add --verdict V1 --result upheld|overturned --note "..."`. The review view shows each verdict's result so the reviewer knows what to attack, but leaves out your reasoning on purpose; do not pass it along. An overturned verdict reopens its claim.
8. **Report and let the user steer.** A pass ends when a claim is killed or every claim has a verdict. Tell the user briefly which claims are supported, which died, and which are still untested, citing quote IDs. Untested is not survived. When a claim dies, propose the next variant of the seed to the user; add it as a claim only once they agree. Run `scraply show --project P1` for the full record.

## Rules

- Never pad. Zero surviving claims is a valid result.
- Agreement between agents is not evidence.
- Stop when the user says so, or when the next test needs something only the user can provide, such as a landing page, a survey, or a conversation. Then say exactly what that is.
