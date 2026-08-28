# Scraply — Rework

**Status:** implemented. The Phase 1 and Phase 2 live gates still require provider credentials and
the human judgments described in Section 11; automated coverage does not substitute for those gates.

**Audience:** Dany, and any AI agent asked to execute this.
**Supersedes:** the current pipeline, not the current infrastructure.

---

## 0. How to use this document

This describes *what Scraply becomes and why*, at a level an engineer or an agent can act on. It
deliberately does not contain implementation code.

Three kinds of statement appear here, and they carry different weight:

- **Requirement** — comes from the owner's vision. Not negotiable. Implementations may change *how*
  it is expressed, never *whether*.
- **Decision** — settled during design review, with the reasoning recorded. Do not re-litigate
  without new information. Section 12 lists what was rejected and why.
- **Open** — genuinely undecided. Section 13. Ask before assuming.

Claims about the current codebase carry `file:line` references. Most were verified during review.
Where something was established by running an experiment rather than by reading code, it is marked
**[probed]**. Anything load-bearing should still be re-checked at implementation time — the repo
moves.

---

## 1. The vision

An idea is not a thought. It is a structure with five parts, and a thing missing any of them is not
an idea yet.

1. **Factors** — problem-causing conditions. Alone, each is mundane: a simple fact about how society
   works, or some common thing that happens. Boring in isolation is *correct*.
2. **Problem** — a pattern across many factors. Clear, obvious, present. It affects a meaningful
   portion of a target audience, or of society.
3. **Solutions** — a problem leads to solutions, and there may be many. This step stays open and
   creative on purpose. No prescriptive algorithm.
4. **Outcomes** — what happens if we solve it this specific way. Predicted, then evaluated. If the
   outcomes are not actually useful, the idea is not good enough — one of the three steps above
   failed, and the failure should be visible.
5. **Risks** — taken seriously. Find as many as possible.
   `Likelihood × Impact = risk rate`. Sort by rate. Mitigate the highest first, then work down.
   Occasionally the risks are high enough that the right move is to drop the idea.

**Requirement.** All five parts, in that order, with L × I driving mitigation order. Everything else
in this document is in service of that.

**The optimization target is idea quality.** Not report quality, not coverage, not throughput. If a
feature does not make the five-part chain better, it does not belong.

---

## 2. What is wrong today

Not "too much structure." The structure exists but **does not survive into the output.** Every
abstraction upstream is flattened into an HTML blob, and the idea generator then reads that blob back
with a regex tag-stripper.

Named defects, all verified:

| Where | What |
|---|---|
| `research-engine.ts:409-417` | Stream reports are a hardcoded HTML template. Line 414 emits the literal constant `"Review gaps between user constraints and current landscape."` on **every report ever generated**, under a heading that says "Opportunities noticed". |
| `research-engine.ts:428` | `coverage = min(1, valid/5*0.7 + sources/3*0.3)` — an invented number that flows into the coverage reviewer, the synthesis, and the UI as though it meant something. Rendered as "Coverage review · 80%" at `run-progress.ts:108`. |
| `streams.ts:3` | `maxHops` and `maxQueriesPerHop` are read **nowhere**. `coverageThreshold` is read once, to pick a cosmetic label. |
| `orchestrator.ts:89,122` | Structured data → HTML → `stripHtml()` → back into a prompt. A lossy round trip for nothing. |
| `ideas.ts:231` | `evidenceStrength` = model self-score × 0.5 + `linkedQuality` × 10 × 0.5, where `linkedQuality` is itself `evidence.ts:148-151`'s `confidence*0.7 + quoteLength/160*0.3`. Fake precision compounded, rendered as "7.35/10" at `IdeaWorkspace.svelte:160-164`. |
| `ideas.ts:21-27` | Five "creative lenses" rotated by `batch % 5`. |
| `streams.ts:56` | Literally `throw` if there are not exactly six streams. A taxonomy hardcoded into a runtime assertion. |

The deeper problem: **ideas are an afterthought.** The app is a report generator with one idea call
bolted on the end. The vision inverts that — the idea is the artifact and research exists to feed it.

**What is genuinely good and must be kept:** the verbatim quote check at `evidence.ts:82-90`, which
verifies that every evidence quote appears literally in the stored source text. That is the only real
anti-hallucination mechanism in the codebase.

---

## 3. Governing principles

These outrank convenience. If an implementation choice violates one, the choice is wrong.

### P1 — The model produces observations. Code produces orderings.

In-code arithmetic buys reproducibility, no hidden drifting weights, and a formula you can read and
edit. **It does not confer objectivity.** Computing in code over model-assigned inputs does not make
the output a measurement.

Two mechanically checkable bans:

- **No formula blends two model-assigned numbers into one value presented as a measurement.** This is
  exactly the `ideas.ts:231` pattern.
- **No threshold comparison against a model-assigned probability.**

**Carve-out:** L × I is permitted. Its product is used *only* as a sort key. It is never displayed as
a magnitude and never compared against a threshold. Without this carve-out the first ban and the
owner's own formula collide.

### P2 — Block only on properties the model does not control.

**[probed]** Structured output is grammar-constrained: schema compliance is *guaranteed*, therefore it
carries **zero information**. Any gate enforced only by schema shape will be satisfied by attachment,
padding, or relabeling — never by refusal.

So: block on retrieved source hostnames, verbatim quote matches, code-assigned provenance. Everything
the model authors is a **displayed signal for the human**, not a gate.

### P3 — Flag, never hide.

This is a single-user local tool. It must never refuse to show its owner something it produced.
Killed problems, ineffective solutions, and ideas carrying serious risks — all visible and labeled
with why. Risk information can change ordering, but never hides an idea or decides for the owner.
A code-level silent drop keyed on one model judgment is exactly the hidden arbitrary logic being
removed.

### P4 — Never persist rendered prose that is later parsed back.

The `orchestrator.ts:89,122` defect. Readable artifacts are rendered *at read time* from the
structured chain. Nothing downstream ever parses a document.

### P5 — Prefer deleting to adding.

The stated complaint is "extra bullshit and bad structure." Every mechanism proposed here had to
survive the question *"what breaks if we just don't?"* Several did not — Section 12.

---

## 4. Domain model

A graph, not a document. Rendered views are generated on demand and never read back.

```
Scope       title, audience (required), domain (required),
            observations, offLimits[]

Factor      subject        — who/what
            behavior       — ONE verb clause
            quote, sourceId
            harvestMode    — 'domain' | 'audience'   ← set in CODE, from which call produced it
            modelConfidence — stored, displayed, never computed with

Problem     statement, whyItPersists (free text, never validated)
            affected, scaleEstimate, scaleBasisFactorId (nullable)
            verdict — confirmed | overstated | already-solved
                    | insufficient-evidence | attempted-and-failed | user-asserted
            verdictReason, verdictSourceIds[]

Solution    problemId, mechanism (free text), description
            respectsOffLimits + why (self-report, surfaced not enforced)

Outcome     solutionId, description, direction (positive|negative), affects
            addressesCore — judged in a SEPARATE call that never sees the solution

Risk        solutionId, description
            likelihood — rare | possible | likely
            impact     — ≤3 days lost | ~2 weeks | ~2 months | project ends
            sortKey    — computed in code from the label pair

ProposedMitigation
            solutionId, riskIds[]
            approach, cost, failsIf (free text, always visible)
```

**An idea is a Solution row with its Problem, Outcomes, and Risks.** There is no separate `ideas`
table — that would mean two ids for one concept and a synchronization problem leaking into IPC, the
workspace, and every view.

`riskIds[]` is a real many-to-many relationship, persisted through `risk_mitigations`. One proposed
mitigation can address several overlapping risks without being duplicated or making the other risks
look unanswered.

### Notes on specific fields

**Factor decomposition is the atomicity mechanism.** Splitting `text` into `subject` + `behavior`
does what the word "atomic" in a prompt cannot: a model cannot fit a whole problem statement into a
one-verb-clause field without the shape visibly bulging. Enforce the length ceiling in **code**, as
an explicit rejection with a logged reason — never as `maxLength` in a schema (see Section 8).

**A factor carries exactly one verified evidence tuple.** `sourceId` and `quote` live directly on the
factor row; there is no `factor_evidence` join table. If the same observation appears in two sources,
they remain two factors. That keeps provenance mechanical, makes rejection accounting unambiguous,
and lets the stage-2 hostname check operate directly over the factors a problem cites.

**`harvestMode` is provenance, not classification.** It records *where the factor came from*, not
what kind of thing it is. A domain-shaped query can return a Reddit thread. Do not ask the model to
classify — a required enum in a strict-decoded schema is a fill path, not a failure path, so the
model will invent a structural factor rather than decline.

**`whyItPersists` carries the causal claim, as prose a human reads.** Nothing validates it. A
citation count cannot check causality and should never be advertised as doing so.

**`fatal` was deleted.** `impact = 'project ends'` *is* the fatal flag. A separate boolean creates the
incoherent state of `fatal: true` with mid impact.

**`residualLikelihood` was deleted.** It thresholded a model-assigned probability, violating P1 on
the single highest-consequence gate in the design.

---

## 5. The pipeline

### Stage 1 — Harvest factors

Two modes, not six lenses.

- **Domain mode** — how the system works. Queries are domain-level and non-evaluative: *how X is
  reimbursed*, *how X is staffed*, *what X is required to file*. They must never contain the
  audience's pain.
- **Audience mode** — what people do and complain about. This requires source steering that the code
  does not currently support: `exa.ts:42-47` sends only `{query, type:'auto', numResults,
  contents.text}` — no domain filter, no category, no date filter. Add `includeDomains`, `category`,
  and `startPublishedDate` passthrough. Without it, steering toward forums rests entirely on query
  phrasing against a neural search tuned for the opposite, and SEO listicles pass every check the
  system has.

No problem statement exists yet. This is the anti-bias guard, and it is structural rather than
instructional.

**Decision — the harvest is a flat fan-out, not a loop.** Per mode:

1. One **query-planning call**: scope + mode → 6–8 search queries. This replaces the templated
   single query at `research-engine.ts:342-346` (brief context + stream name, `.slice(0, 1500)`).
2. One Exa search per query, `searchResultsPerQuery` results each.
3. **Factor-extraction calls batched by source volume**, not one per query — batch until a call would
   exceed roughly 60k characters of source text. Expect 3–5 per mode.

Roughly 2 planning calls, 12–16 searches, 6–10 extraction calls per discovery run. Print that
projection before the run, not after.

**No follow-up rounds, no coverage threshold, no gap-driven second hop.** `maxHops` and
`maxQueriesPerHop` (`streams.ts:3`) are read nowhere today, and `maxFollowUpRounds` is driven by the
invented coverage number — so nothing is being removed that currently works. More importantly, any
iterative harvest needs a stopping signal, and every available signal is a model-assigned number:
that is `research-engine.ts:428` returning under a new name. A flat fan-out has a cost that can be
stated before it runs. If the pool comes back thin, the fix is *edit scope and rerun* (Section 6),
which is already the only supported path.

**Stages 3–5 perform no retrieval at all.** All search happens in stages 1–2. Development runs are
Codex-only, so `maxExaSearches` is effectively a discovery-run cap.

**Do not tell audience mode "don't look for problems."** It fights the mode's own definition — the
corpus *is* complaints — and produces complaints with the word "problem" removed. Negation is the
weakest form of control. Corpus and schema shape are the strong ones.

`observations` from the scope feeds **stage 1 only**, never stage 2. It is a prior on *evidence*, not
on conclusions, so it steers what gets read without retro-fitting what gets concluded.

Cap the pool at **~80 factors by construction** and shuffle once before stage 2, so ordering is not
retrieval order. Context size is not the constraint — attention over a long homogeneous list is.

### Stage 2 — Find problems, then try to kill them

Pattern-find over the shuffled pool. Then, per candidate, a **targeted search whose job is to kill
it**: is it already solved, is it actually widespread, is it fixing itself, *and has it been tried
before* — shutdown notices, "why we shut down" posts, acquire-and-sunset.

That last one earns its own verdict value. `attempted-and-failed` is the single most expensive false
positive this pipeline can produce, because such a problem is real, verifiable, evidence-backed, and
fatal. A four-value verdict set has no slot for it.

**The only blocking check in the entire pipeline:** a problem must cite factors from **≥2 distinct
source hostnames**. Sources are retrieved, not generated, so this cannot be faked. It is a
corpus-diversity check and should be described as one — it does not verify causality.

Citing only one harvest mode is a **warning, displayed**, not a block.

### Checkpoint — the human picks

See Section 6. This is a run boundary, not a pause.

### Stage 3 — Solutions

3–5 per selected problem, one call. `mechanism` is free text the human reads.

**No duplicate-mechanism rejection.** Mechanism duplication is not a string property: two identical
mechanisms phrased differently score ~0.3–0.4 on Jaccard, and two completely different mechanisms in
the same domain score the same. The signal is absent, not mis-tuned. The only checkable version is a
closed enum of mechanism types — which constrains exactly the stage the vision says must stay open.
Ask for distinct mechanisms in prompt text and let the human judge.

`offLimits` enters here for the first time, as a self-reported boolean plus a one-clause reason.
Weak evidence, but it surfaces near-misses, which is all that is needed.

**Stage 3 takes a problem *statement* plus *optional* factors** — never a required factor bundle.
This matters because of the escape hatch in Section 6.

### Stage 4 — Outcomes

4–8 per solution. At least one must be `direction: negative`, and negatives render as prominently as
positives.

**`addressesCore` is judged in a separate call that sees only the problem statement and the outcome
text — never the solution, never the mechanism.** The question is: *does this outcome, on its own,
mean the problem is less true?* Batched per problem, one call.

This is not ceremony. A single call that authors the solution, its outcomes, *and* the grade is
self-referential; it almost never returns "no," and when it does it is adversely selected onto
indirect solutions — precisely where non-obvious ideas live. Hiding the solution from the judge is
what makes "no" reachable.

**No kill gate.** Zero confirmed `addressesCore` outcomes is a signal displayed to the human and a
sort penalty. Not a silent drop (P3).

**No `first|second` order tag.** A visible two-value tag makes the model relabel first-order outcomes
as second-order to satisfy an implied balance. Second-order effects live in the outcome text. (It
also collides with the SQL keyword `ORDER` as a column name.)

### Stage 5 — Risks

**No mandatory categories and no count floor.** Seven mandatory categories is the six-stream taxonomy
returning under a new name, and a forced count of 15–25 guarantees invented content in irrelevant
categories — a B2C app gets a fabricated regulatory risk every run. Padded risks land mid-scale,
where they displace genuine tail risks from any top-N cut.

Instead, **one prompt with three labeled framings**:

1. What has to go right, and what if it doesn't?
2. **Who loses if this succeeds, and what do they do about it?**
3. What happens if it works, but slowly or only partly?

Framing 2 is the load-bearing addition. Models essentially never generate adversarial second-party
risks unprompted, and that is where the killers live.

Expect 6–12 real risks. A human reads that in under a minute and near-duplicates are self-evident on
sight — which is why no risk-dedupe machinery is needed.

**Enumerate and value in two separate calls.** Generate risk statements with no numbers, then score
the list. This removes the "I rated this 8 because I listed it first" anchoring that cannot be
controlled inside a single JSON array, at a cost of one call.

**Scales are labeled words, not free numbers.** Models choose well among defined labels and badly on
free 0–10 scales — and a free 0–10 scale is precisely the construct being deleted
(`IdeaScoresSchema`, `schemas.ts:180-187`). Impact is anchored in the builder's real currency:

| | ≤3 days | ~2 weeks | ~2 months | project ends |
|---|---|---|---|---|
| **likely** | | | | |
| **possible** | | | | |
| **rare** | | | | |

Code maps labels to numbers and multiplies for the sort key. Present this table in the UI as a
**stipulated, editable ordering** — not as arithmetic that measures risk.

**Known limitation, stated plainly:** correlated risks are double-counted. Fewer, unpadded risks is
the only mitigation, and that is why the count floor is gone.

Then **one proposed-mitigation call that sees the whole ranked list at once**, so overlapping risks
can collapse into a shared response with no clustering machinery. Every proposed mitigation names
the `riskIds[]` it addresses and carries `failsIf` — what would have to be true for it to fail —
rendered beside each linked risk, always visible, never behind a click. Do not try to code-evaluate
whether a `failsIf` is "outside the builder's control."

**Any `project ends` risk is always included in the mitigation request regardless of rank.** That
preserves the tail-risk intent that `fatal` was going to serve. It guarantees an attempt to find a
response, not that the risk has been handled.

### Risk evaluation — information, not a decision

There is **no computed idea verdict** of `blocked`, `high-risk`, or `viable`. Risk analysis answers
what could go wrong, what deserves attention first, and what might reduce it. It cannot decide
whether the upside justifies proceeding for this owner.

Show an explicit risk summary instead:

- highest single risk cell;
- total risks and `project ends` risks;
- `project ends` risks with no proposed mitigation attached;
- proposed mitigations and their `failsIf` conditions.

A `project ends` risk with no proposed mitigation gets the visible flag **unaddressed catastrophic
risk**. This is information, never a filter or an automatic build/drop decision. The existence of a
mitigation row is also not evidence that the risk is solved: it is model-authored proposed prose,
and `failsIf` must remain beside it so the owner can judge it.

A top-N *sum* was rejected: it is gameable by risk-splitting, so it measures padding enthusiasm.
Counting bucket membership is the only arithmetic that is honest on ordinal inputs.

---

## 6. The run model

**Decision — the checkpoint is a run boundary, not a run state.** No `paused` or `awaiting-selection`
status is introduced anywhere.

A paused run cannot be expressed by this runtime. All five of these were verified:

- `idx_research_runs_one_active` (`migrations.ts:230-232`) does not cover such a status.
- `resumeRun` rejects it (`research-engine.ts:95`).
- `listPendingRuns` surfaces it in `ResumeBanner` as "Interrupted research" **with a Cancel button
  that destroys the run** (`research-recovery.ts:36`, `130-132`).
- `cost-ledger.ts:42` rejects the first paid call after it.
- The deadline is anchored to `created_at`, so any pause longer than `maxRunMinutes` hard-fails the
  run on resume (`research-engine.ts:111,489,519-527`).

Servicing that state is five edits to preserve a status whose only meaning is "nothing is happening."

**Instead:**

- A **discovery run** executes stages 1–2, persists problems with verdicts, and reaches a terminal
  status normally.
- Committing a selection stamps `problems.selected_at`. The backend starts a **new development run
  for the first selected problem**, then starts the next selected problem only after the prior run
  completes. Order is the checkpoint display order, made deterministic by `problems.created_at, id`.
- The two kinds are distinguished by `research_runs.problem_id` — `NULL` means discovery. Do not add
  a `kind` column.
- **Development runs are sequential**, one active run per thread. This keeps
  `idx_research_runs_one_active` and `ResearchRunRepository.create`'s conflict guard
  (`research-runs.ts:44-49`) untouched, and it bounds spend: `budget_limit` is per-run
  (`research-runs.ts:58`), so concurrent runs would silently multiply the cap.
- The committed selection is the durable queue. On restart, resume an active run first; if none is
  active and selected problems from the latest discovery run remain without a completed development
  run, start the next one. A failed or cancelled development run stops the queue visibly; continuing
  requires an explicit retry or a changed selection. Never spend provider calls merely because an
  uncommitted checkbox was ticked.

This one decision also fixes, for free: the resume-clock bug, the ledger status gate, the
ResumeBanner destroy-by-misclick hazard, and the "55 Codex calls inside a synchronous IPC handler"
problem — because `SELECT_PROBLEMS` becomes a `startRun` call, which already returns immediately with
events, abort, and a deadline.

**The checkpoint must be reachable purely from persisted thread status** (new `ThreadStatus`
`problems-ready`), never from the transient event stream. `App.svelte:158-159` clears
`researchEvents` on thread switch and `App.svelte:119` drops events for non-active threads — a
candidate list delivered by events vanishes the moment he clicks away. Add `problemCandidates` to
`WorkspaceState`, populated in `workspaceState()` alongside `listIdeas`/`listReports`
(`server.ts:185-187`).

### At the checkpoint

- **Escape hatch:** a text field, *"Or state the problem yourself."* Creates a problem with zero
  factors and verdict `user-asserted`. Not a special class — it uses the same verdict field, so
  nothing downstream needs a null branch. This is why stage 3 takes optional factors.
- **Un-kill:** killed problems are individually re-selectable. The kill search is one LLM call and it
  will sometimes be wrong.
- **Re-enterable and idempotent:** open it, close the app, reopen tomorrow, change the selection,
  then commit.
- **No "harvest more factors, same run" path.** *Edit scope and rerun* already covers it, and the
  likely failure is that the scope was wrong, not that the harvest was too small.

The two most likely outcomes of a first run are that he rejects everything, or that he already knows
the real problem and the machine missed it. Without the escape hatch, a rejected run is fully wasted
spend.

---

## 7. Interface rules

Stated here so they survive implementation.

**Numbers.** The model emits *words* for likelihood and impact. The L × I product never appears in
the UI — sort key only. No percentage or progress bar whose value derives from a model output. (A bar
filled from count-of-completed-stages is fine.) Delete the 3×2 score grid at
`IdeaWorkspace.svelte:160-164` and its styles at `329-354`, along with `IdeaScoresSchema` and
`IdeaBucketSchema` explicitly — they look like a finished feature and will otherwise survive a
rewrite by accident.

**Order.** Refuse the composite, not the ordering. Sort by count of independently-confirmed
`addressesCore` outcomes, descending. Keep the full risk summary visible on every item and provide a
filter for **unaddressed catastrophic risk**, but do not turn model-estimated risk into an automatic
idea verdict. Print the sort rule above the list in one muted sentence. Refusing a default order
offloads ranking onto the user on every visit.

**Trust — exactly two visual levels plus one legend line.** A dotted underline on any model-estimated
span (scale claims, likelihood/impact words); an amber left border on the container when the verdict
is `insufficient-evidence`, `overstated`, or `attempted-and-failed`. Sourced factors with verbatim
quotes render completely plain — **that plainness is the signal.** If everything is flagged, nothing
is.

**Cost.** A live `N Codex calls · M Exa searches` counter in the topbar against the run's own
**projection** — not against a cap, which no longer exists (Section 10) — and a **call-count**
projection in the checkpoint footer that updates as problems are ticked. Never
USD: Codex reserves $0 (`research-engine.ts:476`) and `providers/codex.ts` has no price handling at
all, so any dollar figure attached to it is invented. A checkpoint only bounds cost if the person at
it can see what each selection costs.

**Progress.** An object tally, not a five-step stepper:
`Factors: 34 (12 domain, 22 audience) · 19 sources`,
`Problem candidates: 9 · verifying 4/9 · killed 2`, plus one muted line with the last search query.
This needs counter events in the `ResearchEvent` union (`ipc.ts:230-252`), not just start/complete
pairs.

**Dead ends** live in collapsed sections at the bottom of the page where the death happened. Never a
separate page.

**Export** defaults to Markdown, one file per problem, with JSON as a secondary button.

**Cancel must stay reachable at every new stage.**

**Preserve from the current App.svelte:** the status-driven page router (`App.svelte:372-382`),
`.main-content` as the single scroll owner, the notices region, and above all the
`event → reconcileSoon()` debounce where backend events merely nudge a workspace refetch rather than
acting as client-side source of truth. That pattern is what makes the app survive restarts and
out-of-order events. Do not replace it with event-sourced client state.

---

## 8. Provider constraints — hard facts

**[probed]** against `codex-cli 0.145.0`. These are not style preferences; violating them produces
HTTP 400s or corrupted data.

1. **At every object level, `required` must equal `Object.keys(properties)`.** A non-required property
   returns HTTP 400 `invalid_json_schema` and no output file is written. Model optionality as
   nullable with an explicit `null`, never as an optional key.

2. **No `minItems` / `maxItems` / `minLength` / `maxLength` / `minimum` / `maximum` anywhere in a
   schema sent to Codex.** They are grammar-enforced, and the grammar will mutilate content to
   satisfy them: `maxLength: 12` emitted the literal corrupted string `"Cherry boeai"`; `maxItems: 3`
   truncated a 9-item request; a numeric range silently clamped an out-of-range value.

   **All counts and lengths live in prompt text and are validated in code after parsing**, with
   explicit rejection and a logged reason. This is why stage 5's "15–25 risks" would not have
   produced compliance — it would have produced padding.

3. **Make Zod the single source of truth and derive the JSON Schema from it.** `strictJsonSchema`
   (`codex.ts:292-302`) already walks the tree setting `additionalProperties: false`, so the deriver
   only emits `type` / `properties` / `required` / `items`.

   The divergence is live today: `schemas.ts:23-28` has `.max(1000)` and `.min(1)` that
   `claim-extraction.ts:4-32` does not ship, so the grammar happily emits `sourceIds: []` and Zod then
   kills the run. Under a sequential pipeline, a schema failure in stage 2 kills every stage after it.

4. **Add a Phase 0 unit test** over every schema passed to `structuredCompletion`, asserting rules 1
   and 2.

5. **One plain retry** of the identical call on `ProviderFailure('schema')`, to cover output
   truncation. Then delete `prompts/structured-output-repair.md` — a repair prompt cannot fix a
   length overrun, and the file is already referenced by nothing.

**Prompt files: every new prompt gets a new filename.** `configurePromptPaths` (`prompts.ts:12-17`)
copies a bundled prompt to `%APPDATA%/scraply/scraply/prompts` only `if (!existsSync(target))`, and
`loadPrompt` prefers the override. Since `AGENTS.md` mandates `bun run build:installed` after every
run, the machine already has the old prompts on disk — **a rewritten bundled file is silently
ignored.** The failure mode is "the new pipeline produces old-style output" at the go/no-go gate: the
worst possible signal and nearly impossible to debug. New filenames prevent it entirely; do not add
hash-recording machinery.

New names: `query-plan.md`, `factor-harvest.md`, `problem-candidates.md`, `problem-kill.md`,
`solutions.md`, `outcomes.md`, `outcome-judge.md`, `risks.md`, `risk-score.md`, `mitigations.md`.
All 12 existing prompt files die. (`researcher-default.md` and `structured-output-repair.md` are
already dead — zero references anywhere in the repo. `intake.ts:193` loads `brief-interpreter`, for
which no file has ever existed; it silently uses the inline fallback.)

**Ten files is not ten copies of one file.** Today six of twelve prompts are `researcher-*` variants
that share ~85% of their text and differ only in topic bullets — the `streams.ts` taxonomy expressed
as copy-paste. Each new file is a genuinely different job, and the two apparent pairs cannot merge:
`risks`/`risk-score` are split to break anchoring, `outcomes`/`outcome-judge` to break
self-reference. **Domain and audience mode share one `factor-harvest.md`** with the mode injected —
do not split it into two files.

### Prompt style rules

Current files are 12–20 lines each, 205 lines total. They are not too long — but roughly a third of
their content cannot affect output. Both of these are mechanically checkable at review time:

- **Delete any line restating what the schema enforces.** Every researcher file ends with *"Every
  claim must cite source IDs and short evidence quotes"* while the schema already requires
  `sourceIds` and `quote`; `idea-generator.md` says *"Score ... from 0 to 10"* against a bounded
  field. Output is grammar-constrained, so these lines are provably inert (P2).
- **Delete negations; change the corpus or the schema instead.** `Avoid: generating ideas`,
  `Avoid overstating`, `Avoid inventing severity`. Negation is the weakest available control — the
  same argument that governs audience mode in Stage 1.

Target ≤12 lines per file. Say what to produce and what the model is looking at; nothing else.

**The prompt file is not the prompt.** `researcher-landscape.md` is 18 lines, but the payload is that
file plus `buildResearcherContext` (14 brief fields, `brief-context.ts:50-67`) plus up to
`5 × pageCharLimit` = 30,000 characters of source text. The file is ~2% of what is sent. Shrinking
prompt files is cosmetic; deleting the five `build*Context` functions is the real reduction, and it
happens automatically when the 20-field brief becomes the 5-field Scope.

---

## 9. Migrations

**Decision — two migrations, not a fresh file.** This is the highest-consequence item in the plan
because it fails *silently*.

`db/client.ts:29-33` does `if (applied.has(migration.id)) continue`. A rewritten `MIGRATIONS` array
starting at id 1 is **skipped entirely** on any existing install — and the owner's database has ids
1–6. The new code would then run every query against the old schema and die with a confusing SQLite
error.

"All data is disposable" is permission to lose data. It is not a mechanism that deletes it.

- **Migration 7 (Phase 0) — additive only.** `CREATE` the new tables alongside the old ones; `ALTER
  research_runs ADD COLUMN problem_id`. No drops. The existing app keeps booting.
- **Migration 9 (Phase 3) — destructive cutover.** Migration 8 was consumed by the Phase 2
  persistence graph. Migration 9 must either begin with
  `PRAGMA defer_foreign_keys = ON;` (this one *does* work inside a transaction; `PRAGMA foreign_keys`
  does not) or order drops children-first — `client.ts:13` enforces foreign keys and migrations run
  inside `BEGIN`/`COMMIT` (`client.ts:35-42`).
  It must also include `DELETE FROM messages WHERE role='report';` — dropping `reports` otherwise
  orphans the message rows written at `research-engine.ts:269-278`, which the renderer reads.

Also: delete `db/client.ts:50-62` (`assertMigrationPreconditions`) as dead code once migration 4
leaves the array, and rewrite the e2e assertion on its error string (`smoke.spec.ts:238-251`).

### Tables

- **New (9):** `scopes`, `factors`, `problems`, `problem_factors`, `solutions`,
  `outcomes`, `risks`, `mitigations`, `risk_mitigations`; plus `research_runs.problem_id`.
- **Dropped (12):** `intake_answers`, `briefs`, `stream_runs`, `claims`, `claim_evidence`,
  `idea_claims`, `ideas`, `reports`, `branch_contexts`, `ratings`, `idea_ratings`, `rating_history`.
- **Modified:** `sources` (drop `originating_stream_run_id` — written at `evidence.ts:50,94` and
  never `SELECT`ed); `research_runs` (drop `brief_json`, `selected_stream_ids_json`, `round`);
  `threads` (status vocabulary).
- **Unchanged:** `app_meta`, `settings`, `messages`, `run_configs`, `job_events` + its two delete
  triggers, `cost_ledger`, `schema_migrations`.

Use `CASCADE` uniformly down the new chain (run → factors; problem → solutions;
solution → outcomes, risks, and mitigations; risks/mitigations → `risk_mitigations`). **Never mix
`RESTRICT` into a cascading path** —
`migrations.ts:192-196` currently has `idea_claims.claim_id ON DELETE RESTRICT` under a cascading
parent, which is a live nondeterministic failure since foreign keys are enforced.

**Factors stay scoped to their run.** `sources` is keyed `UNIQUE(research_run_id, canonical_url)` and
the quote check compares against the *stored* retrieved text — a global cross-run source pool with
refetched content would silently degrade the app's only anti-hallucination check. Development runs
read factors by reference through `problems.discovery_run_id`, which is named for the run kind it is
guaranteed to point at. Every other new table that references a run uses `research_run_id`, matching
`sources`/`claims`/`cost_ledger`.

### Stage idempotency

Derive it from the output rows the pipeline already writes: solutions exist for problem P → stage 3
is done; outcomes exist for solution S → stage 4 is done; risks exist for S → stage 5 is done. A
stage is persisted only after all calls that make its rows complete have returned: stage 4 writes
the outcomes and their independently judged `addressesCore` values in one transaction; stage 5
writes risks, scores, mitigations, and `risk_mitigations` links in one transaction. A crash before
that transaction retries the whole subject rather than mistaking partial rows for completion.
Per-subject failures go to `job_events`, which already exists with its delete triggers
(`migrations.ts:318-328`) and is already how the engine logs `stream-failed`.

**No `run_steps` table.** Zero new tables, and it covers resume, cost avoidance, and "why did stage 4
not run for solution 2." The "re-run stage 5 with a better prompt" case is already served by opening
a new development run against the same `problem_id`.

---

## 10. Blast radius

Corrected against the repo. The initial draft's "keep untouched" list named four things that provably
cannot survive, and roughly thirteen files appeared on no list at all.

### Moved from KEEP to REWRITE

**`src/backend/server.ts`** (812 lines). Imports `generateBriefFromText`/`generateBriefWithModel`
from `core/intake` (line 6) and `DEFAULT_RUN_CONFIG`/`intakeProgress`/`nextIntakeQuestion` from
`shared/intake` (line 44) — both deleted. Delta is ~250 lines, **not** a full rewrite: `authorize`,
`readBody`, `sendJson`/`sendError`, `validateProviders`, `buildModelCatalog`, SSE `/events` and
thread CRUD are untouched.
*Routes that die:* `/intake` (485), `/intake/brief` (514), `/brief/confirm` (539), `/ideas/generate`
(643 — delete the synchronous path, do not port it), `/branch/create` (685-733), `/reports/<id>`
(402-409).
*Shape changes:* `/workspace` (178-204; `getLatestResearchRun` at 307-344 hardcodes the six lens ids
at 326 and invents `canGeneratePartialIdeas` at 338), `/threads`, `/research/start`, `/ideas/export`,
`/ideas/<id>` (231-291 parses `scores_json` + `bucket`).

**`src/main/index.ts` and `src/preload/index.ts`**, scoped to `registerIpc()` (`index.ts:442-491`, 25
handlers) and the `api` object (`preload:22-85`) only. Leave secrets (67-104), backend spawn (106+),
`backendRequest` (340-377), `assertTrustedSender` (431-440), CSP and `security.ts` alone.
*Channels that die:* `SUBMIT_INTAKE`, `START_BRIEF_INTAKE`, `CONFIRM_BRIEF`, `GENERATE_IDEAS`,
`CREATE_BRANCH`, `GET_REPORT_DETAIL`.
*New:* `SAVE_SCOPE`, `SELECT_PROBLEMS`.
*Payload changes:* `GET_WORKSPACE`, `SELECT_THREAD`, `CREATE_THREAD`, `SAVE_RUN_CONFIG`,
`START_RESEARCH`, `EXPORT_IDEAS`, `GET_IDEA_DETAIL`, `BACKEND_EVENT`.

At 25 channels, explicit hand-mirroring across `shared/ipc.ts`, `main/index.ts` and
`preload/index.ts` is the right amount of structure. Do not build a channel registry or codegen —
that is exactly the "extra bullshit" being removed.

**`src/core/research-recovery.ts`.** Imports `RESEARCH_STREAMS` (line 4) and `parseAndNormalizeBrief`
(line 5); `parseSelectedStreamIds` (108-120), `loadStoredRunState` (69-106) and `listPendingRuns`
(31-67) are all stream-shaped. About 40 lines survive — move `logJobEvent` (135-146) into
`research-engine.ts` and delete the file rather than keeping a module for one insert.
`listPendingRuns` needs no semantic change under the run-boundary model: its
`WHERE status IN ('queued','running')` already excludes terminal runs.

**`src/db/repositories/evidence.ts`.** Split explicitly:
- **Keep:** `canonicalizeUrl` (136-146) and the sha256 content-hash dedupe.
- **Port:** the quote check (`evidence.ts:84`) to a `FactorRepository` — but **normalize both sides
  first**: NFKC, collapse whitespace runs, fold curly quotes/apostrophes and dash variants to ASCII.
  Source text arrives with only `.trim()` applied (`exa.ts:70`) and models routinely straighten
  typography when copying.
- **Delete:** `evidenceQuality` (148-150), the `evidence_quality` column, and the `ORDER BY` over it
  at `ideas.ts:131-137`. Rename the stored model self-score to `model_confidence` so it reads
  untrusted at every call site; keep its 0–1 check; never compute with it.
- **Surface** the per-harvest-mode rejection count and reasons in the run UI. `PersistedClaims.rejected`
  is computed at `evidence.ts:100` and consumed nowhere except an HTML sentence — the rejection rate
  is invisible today. Under the new design the factor pool is the sole foundation of stages 2–5, so a
  silent rejection rate is a design-killer.

**`src/providers/exa.ts`** — needs the `includeDomains`/`category`/`startPublishedDate` passthrough
described in Stage 1.

### On no list at all — all verified

**Delete:** `shared/run-config-normalizer.ts` (only real content is a dead `"opencode"` branch),
`renderer/lib/run-progress.ts` (imports `RESEARCH_STREAMS`; `deriveStreamLanes` 45-56 is the whole
progress UI), `RunReviewPanel.svelte` (566 — and it, not App.svelte, imports `RunConfigPanel` at
line 4 and renders it at 193), `SmartBriefEntry.svelte` (384 — write `ScopeForm.svelte` fresh; a
5-field form is ~120 lines and reshaping a brief-era shell drags its assumptions along),
`StringListField.svelte` (188), `RunProgressView.svelte`, `RunProgressPanel.svelte` (line 43
hardcodes "Six streams research in parallel."), `ResearchDrawer.svelte`, `core/claim-extraction.ts`,
`core/preferences.ts`, `db/client.ts:50-62`, `scripts/live-codex-ideas-smoke.ts` (not in tsconfig
include — it rots silently and typecheck never catches it).

**Rewrite:** `db/repositories/research-runs.ts` — `finish()` at 79-86 refuses to complete a run
without a `report_kind='synthesis'` row, which alone means **no run in the new pipeline could ever
complete**. `db/repositories/threads.ts` (imports `parseAndNormalizeBrief`, used at
124/138/145/151/182, plus the intake/brief/branch methods). `renderer/lib/ipc-payloads.ts` — reduce,
do not delete: `toRunConfigPayload` and `toFavoriteModelPayload` survive.

### Two features killed explicitly

**Branching.** Delete `branch_contexts`, `BranchSetupDialog.svelte` (254),
`FocusedBranchSetup.svelte`, the `CREATE_BRANCH` channel, `CreateBranchRequestSchema`
(`ipc.ts:154-163`), the `/branch/create` route (`server.ts:685-733`), the "Dive deeper" button, and
the e2e assertions (`smoke.spec.ts:222-230`). Under the two-run model, branching is **free and needs
no feature**: it is another development run against an existing `problem_id` with a different angle.

**Reports.** Drop the `reports` table, `ReportViewer.svelte` (264), `GET_REPORT_DETAIL`, the
`/reports` route (`server.ts:402-409`), the report-library and report-stack sections of App.svelte
(593-617), `core/sanitize.ts`, and the `dompurify` + `jsdom` dependencies. `sanitize.ts` is on the
draft's keep list with exactly two callers — `orchestrator.ts:4` and `research-engine.ts:6` — both of
which the draft deletes. Readable artifacts render at read time (P4).

Together these are ~1000 lines across nine files plus two npm dependencies.

### Ideas, ratings, and taste

**Delete the `ideas` table.** A `solutions` row with its mandatory `problem_id`, outcomes and risks
*is* the idea. Repoint everything at `solution_id`.

**Delete the taste loop entirely for v1:** `core/preferences.ts`, its call site at `ideas.ts:148`, the
1–5 star row at `IdeaWorkspace.svelte:198-216`, and the `ratings` / `idea_ratings` /
`rating_history` tables.

The checkpoint selection record — which problems he picked and which he rejected — is already a
stronger and free taste signal than a retrospective star that `preferences.ts:56-57` itself declares
unreliable below three ratings. Two taste mechanisms with two prompt blocks and two UIs is the
parallel machinery being removed. If a cross-run prior is wanted later, it is one query over
persisted checkpoint selections and zero new UI.

(`preferences.ts` is also broken by omission in the draft: it `SELECT`s `i.bucket` and
`i.scores_json`, both removed.)

### Run config — depth, not budget

**Requirement — the user chooses how much work is done, not how much it costs.** Cost is an
*output* of that choice, displayed. It is never the input.

A spend or call cap is not a control, it is a **failure mode**: it aborts a run partway, leaving a
half-built chain that cost real money and produced nothing usable. Under the flat fan-out
(Stage 1) the work is fully determined before the run starts, so the projection is exact and there is
nothing to cap.

**Discovery depth** — one setting, three levels, which set:

| | queries per mode | `searchResultsPerQuery` | factor pool cap |
|---|---|---|---|
| quick | 3 | 4 | ~30 |
| standard | 6 | 5 | ~80 |
| deep | 10 | 6 | ~150 |

Numbers are the starting point; Phase 1 measures and adjusts them. Show the resulting projection
next to the selector and update it live: *"~8 searches · ~6 Codex calls."*

**Development depth needs no setting.** Per-problem work is near-fixed (3–5 solutions → outcomes →
judge → risks → score → mitigations), so the only dial is **how many problems get ticked at the
checkpoint** — which Section 7 already specifies as a live call-count projection in the checkpoint
footer. The checkpoint *is* the development-run dial. Do not add a second one.

**Surviving `RunConfig` fields:** `model` (one, not three — `ModelProviderSchema` is already
`z.literal('codex')`), `discoveryDepth`, `maxRunMinutes`.

**Deleted:** `maxSpendUsd`, `maxCodexCalls`, `maxExaSearches`, `maxFollowUpRounds`,
`searchResultsPerStream`, `parallelism`, `ideasRequested`, `batchSize`, and the two extra provider
fields. `searchResultsPerQuery` is derived from `discoveryDepth`, not configured.

`maxSpendUsd` was already unable to bind: Codex reserves $0 (`research-engine.ts:476`) and
`providers/codex.ts` has no price handling, so a dollar budget structurally cannot constrain the
expensive provider.

**`maxRunMinutes` stays, and stays a hang detector** — never a work budget. Phase −1 already reframes
it as per-attempt. Set it generously; it exists to catch a wedged `codex exec`, not to end a run
early.

**A runaway backstop is not a budget.** Keep a hard call ceiling derived in code at ~3× the run's own
projection, not user-configurable and not shown in settings. Hitting it means a bug — an unbounded
loop or a retry storm — so it should fail loudly with that wording, not report "limit reached." Do
not surface it as a knob; a knob invites tuning it down into the working range, which reintroduces
exactly the mid-run abort this section removes.

`cost_ledger` and `research_runs.budget_limit` stay as an **accounting record** — what a run actually
consumed, readable after the fact. Set `budget_limit` from one constant. Accounting is not
enforcement, and it is the part worth keeping.

Put the new default next to the new `RunConfig` schema in `shared/schemas.ts`.

### Thread status

**Cull, don't extend.** `ThreadStatusSchema` (`schemas.ts:140-151`) becomes: `configuring`,
`discovery-running`, `problems-ready`, `development-running`, `solutions-ready`, `failed`,
`archived`. Drop `intake`, `brief-draft`, `brief-confirmed`, `research-queued`, `ideas-generating` —
three of the current ten are declared and consumed but never written by any code path.

`status.ts:5-16` is a total `Record<ThreadStatus, ...>`, so the compiler forces that file to be
updated. Keep that pattern. `App.svelte`'s router (372-382) falls through to `conversation` for
anything unknown, so the checkpoint page cannot render without its branch.

### Tests

CI-gating — `tsconfig` include covers `test/**/*`, so **every file must compile** for `bun run check`.

**Delete:** `test/unit/{brief-compatibility, brief-context, brief-intake, brief-review, intake,
intake-fixtures, orchestrator, run-config-compatibility, run-progress, preferences}.test.ts`,
`test/fixtures/intake/*` (10 fixtures + loader), `test/helpers/project-brief.ts` (imported by 14 test
files).

**Rewrite:** `test/integration/{backend (738 lines, 17 tests), idea-generation, research-limits,
recovery, evidence-model, migrations}.test.ts`; `test/unit/prompts.test.ts` (only the second
`describe`, `buildIdeaPrompt` at line 46, dies — the first tests `loadPrompt`, which survives);
`test/unit/ipc-payloads.test.ts`; `test/e2e/mock-backend.ts` (323, mocks every HTTP route) and
`test/e2e/smoke.spec.ts` (418, 10 tests — asserts "Inspect the inferred brief" at 154, "6 fixed
streams" at 176, `aria-valuemax="6"` at 188, "Composite synthesis" at 191-192, the migration-4 error
string at 244, and the branch flow at 222-230).

**Update `package.json`'s `test` script** — it enumerates each integration file by path, so a new file
is silently never run otherwise. Drop `dompurify` and `jsdom`.

**Keep, verified clean:** `test/unit/{backend-process, codex, exa, logging, security, setup,
promoted-assets}.test.ts`; `scripts/run-e2e.ts` and `scripts/smoke-portable.ts` contain no UI-text
assertions.

### Genuinely untouched

Verified by grep, zero hits on deleted concepts: `providers/{codex,structured}.ts`,
`db/repositories/cost-ledger.ts` (except adding `release()` and shrinking the status list at line 42),
`db/sqlite.ts`, `main/{logging,security}.ts`, `shared/{errors,logging,backend-process}.ts`,
`electron.vite.config.ts`, `build/`, `release/`, `.github/workflows/`,
`scripts/{check-promotion,verify-package,verify-promoted-assets,run-e2e,smoke-portable}.ts`.

---

## 11. Phases

Five, not four. Each ends at a commit. The repo compiles at every boundary.

### Phase −1 — Two runtime bug fixes, isolated

These are live bugs reachable from `ResumeBanner` today, independent of the restructure. Land them
alone so they are verified in isolation rather than tangled into the rewrite.

1. `resumeRun` sets `startedAt: Date.now()` (`research-engine.ts:111`), and `startedAt` leaves
   `StoredRunState` so the dead field cannot be re-read. `maxRunMinutes` is a **hang detector for the
   current attempt**, not a calendar-lifetime budget. Today any run resumed more than 30 minutes
   after `created_at` fails instantly via a 0 ms deadline timer, and **no test covers `resumeRun` at
   all.** Add a test that resumes a two-hour-old run and asserts it executes.

2. Delete `ActiveRun.codexCalls` and `ActiveRun.exaSearches` (`research-engine.ts:41-42, 112-113,
   471-474, 479-485`) and replace with one shared helper over `cost_ledger` — the query
   `ideas.ts:310-313` already uses. Two counters for one limit, one of them wrong (Rule 5). Codex
   reserves $0 and `providers/codex.ts` has no cost tracking, so `maxCodexCalls` is the **only** real
   bound on the expensive provider — it must be durable or there is effectively no bound.
   Do **not** put the cap inside `cost-ledger.reserve()`; that puts run policy in a cost repository.
   Add `CostLedgerRepository.release(reservationId)` (~12 lines) and call it from `resumeRun` for
   `status='reserved'` rows being re-executed — not for budget leakage (only the $0.05 Exa
   reservation is non-zero) but because orphaned reserved rows inflate the durable count and produce
   false "Codex call limit reached" failures after a crash.

**Success:** the aged-resume test passes, and a resumed run does not get a fresh call budget.

### Phase 0 — Schema and types, purely additive

Migration 7. New Zod schemas with the JSON-Schema deriver and the schema-shape unit test. New prompt
files under new filenames. No behavior change.

**Success:** `bun run check` green; the app opens an existing DB; the schema test passes on every
schema passed to `structuredCompletion`.

### Phase 1 — Stages 1–2, headless. **This is the go/no-go gate.**

Plain functions called from a script that writes a **Markdown file** — problem statement, verdict,
evidence tuple, factor list with quotes — which he reads in an editor. **No IPC channel and no
renderer code.** (The Markdown renderer is also the later export renderer, so the work is not thrown
away.)

**Wipe `%APPDATA%/scraply/scraply/prompts` before the gate run** so the new prompts are the ones
actually used.

**The gate is a two-arm ablation on the same scope:**
- **Arm A** — stage 2 over all harvested factors.
- **Arm C** — stage 2 with scope only, no factors. The control.

**PASS requires both:**
1. At least **2 problems in Arm A do not appear in Arm C**.
2. **Every** problem in Arm A cites at least one factor whose evidence quote passed the verbatim
   check.

Arm overlap is a human product judgment made by reading the paired Markdown artifacts. Do not add a
string-similarity score or model grader to automate it; either would invent the quality metric this
gate exists to test.

Record and read, but do not threshold: factor utilization rate, and the per-harvest-mode
quote-rejection rate.

**If Arm A's problems already appear in Arm C, the harvest changed nothing and stages 1–2 are pure
cost** — the bottom-up premise is wrong, and the fix is more or better factors, not more prompting.
If audience-mode quote rejection is materially worse than domain-mode, fix normalization or narrow
the source set before proceeding; otherwise the pipeline silently becomes structural-only while every
schema check still passes.

Cost: ~2–4 extra Codex calls, run once.

### Phase 2 — Stages 3–5, still headless

Run one selected problem end to end and read the whole chain: solutions with free-text mechanisms,
outcomes with at least one negative and independently-judged `addressesCore`, risks with word-valued
likelihood and impact, and proposed mitigations with linked `riskIds[]` and `failsIf`. Confirm that
the output presents a risk summary without pronouncing the idea `blocked`, `high-risk`, or `viable`.

Measure the **real** per-problem call count here. That number is what the checkpoint footer projects
per ticked problem — it is a projection, not a cap.

**Success:** one complete five-part idea, produced without a schema failure, with a risk list a human
reads in under a minute.

### Phase 3 — Cutover, one landable change

Migration 9 drops the old tables. Delete the old modules **and** land the new UI **and** rewrite
`test/e2e/{mock-backend.ts, smoke.spec.ts}` **and** update `package.json`'s test script — all in the
same commit.

**This cannot be split.** `App.svelte` imports the components being deleted, `run-progress.ts` and
`RunReviewPanel.svelte` import `RESEARCH_STREAMS`, and `.github/workflows/ci.yml` runs
`bun run check` plus `bun run test:e2e` on every PR to `master`. A standalone delete commit leaves the
repo uncompilable and CI red.

**Success:** CI green; a fresh install migrates; an existing install migrates; one full run reaches
the checkpoint, survives an app restart, and completes a development run.

### Why delete last

Not because the old pipeline is a comparison reference — its output (ideas with six scores and a
bucket) is not commensurable with verified problems, so there is no comparison to make. The real
control is Arm C.

It is kept on disk through Phases 1–2 because the installed app stays bootable, and because patterns
worth copying must still compile while the new views are written: `RunProgressView`'s phase line and
persisted-snapshot fallback (`run-progress.ts:118-134`), `ReportViewer`'s lazy details pattern, and
App.svelte's `reconcileSoon` debounce.

---

## 12. Decided and closed

Recorded so they are not reopened mid-implementation.

| Proposal | Why rejected |
|---|---|
| A `run_steps` table for stage idempotency | Output rows plus `job_events` cover resume, cost avoidance, and per-subject failure. Zero new tables. |
| Chunk–cluster–hydrate for the stage-2 factor pool | ~3× heavier than the problem: 6–8 extra calls, a validator, a violation branch, a fallback. Capping at ~80 and shuffling once lands in the same safe zone for two lines. |
| Model-generated risk clustering for dedupe | The problem is manufactured by the 15–25 floor being deleted. 6–12 real risks need no machinery. |
| A frozen golden set of factor/problem/risk outputs in `test/fixtures/` | The cited precedent is fake: `brief-intake.test.ts` feeds each fixture through a stub returning it verbatim, so its 0.9 match assertion cannot fail. Asserting on nondeterministic output needs a quality metric, and inventing one is `research-engine.ts:428` reborn as a test helper. |
| `blocksBuild: boolean` as a primary sort key ahead of L × I | Contradicts the requirement. The time dimension is already in the impact scale. |
| A closed `mechanismVerb` enum | An 8-value taxonomy of change constrains exactly the stage the vision says must stay open. |
| A per-factor `generality` field | Requires the string-similarity matching that provably cannot work here. The ≥2-hostname block already serves the concern, mechanically. |
| Persisting `verdict_inputs_json` with the verdict | Inputs are the per-risk rows, already immutable. Only a threshold constant is volatile. A stored verdict drifts back toward the composite being rejected. |
| A "harvest more factors, excluding seen territory" path | Needs seen-territory tracking, cross-batch dedupe, and re-derivation over a union set — a second pipeline duplicating "edit scope and rerun". |
| A cross-item distribution budget on risk scoring | Not expressible in JSON Schema; degrades to a prompt line plus a validator plus a retry decision. State it as a sentence; do not validate. |
| Streaming factors live during stage 1 | `providers/codex.ts` runs `codex exec` and parses after the process exits — not streaming. The saving is also illusory since the checkpoint already gates stages 3–5. What survives: cancel must stay reachable. |
| A channel registry / IPC codegen | At 25 channels, explicit mirroring is correct. "Adding a channel touches four files" is a description, not a license to abstract. |
| A global cross-run factor/source pool | `sources` is keyed `UNIQUE(research_run_id, canonical_url)` and the quote check compares stored text. Refetched global sources would silently degrade the only anti-hallucination check. |
| An optional `leadsTo` clause on outcomes | Cheap but not clearly right; adds a nullable field. Second-order effects live in the outcome text. Revisit only if Phase 2 output is visibly first-order-only. |
| A projected USD cost at the checkpoint | Codex reserves $0. Any dollar figure is invented — the same false-precision sin. Project call counts. |
| Prompt-file hash recording | The new-filenames rule prevents the scenario entirely. |
| A second human checkpoint after stage 4 | Under per-problem sequential runs, picking 2 of 4 solutions saves ~12 of ~55 development calls (~20%) at the cost of **three** extra interruptions for three problems. Bad trade, and it breaks the requirement that an idea *is* the full five-part structure — unpicked solutions would sit permanently half-analyzed. Adding it later reuses the same run-boundary mechanism, so it stays cheap. |
| Blocking selection for `attempted-and-failed` | It warns only. A failed prior attempt is important evidence, but a new mechanism may still be the idea; blocking would violate P3 and remove the owner's judgment. |
| Creating a new thread when a scope is edited | A rerun stays on the same thread. The checkpoint shows only the latest discovery run; earlier runs remain history. |
| A separate queued-run table for selected problems | The committed `selected_at` rows are the durable queue. One development run is created at a time, preserving the existing one-active-run invariant. |
| A `factor_evidence` join table | Every factor is one observation copied from one verified source quote. Direct `sourceId` and `quote` fields are simpler and make provenance and rejection accounting explicit. |

---

## 13. Deferred measurement

There are no unresolved product semantics. The three discovery-depth levels' numbers remain
provisional by design: the table in Section 10 is a starting point, not a claim. Phase 1 sets
`standard` from what actually produced a usable factor pool; Phase 2 measures the real per-problem
call count so the checkpoint projection is honest.

---

## 14. One-line summary

Stop generating reports. Generate a five-part chain — **factors → problem → solutions → outcomes →
risks** — where the model observes, the code orders, the human chooses at one gate, and the only
thing anything blocks on is evidence the model could not have faked.
