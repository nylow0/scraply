# Lean opportunity acceptance — 2026-09-20

Implementation evaluated: `e152842`, [PR #26](https://github.com/nylow0/scraply/pull/26).

This deliberately selected sample does **not** establish comprehensive quality, population error rates, or the original three-scope release gate. Baseline labels are fixed review judgments, not customer evidence. The PR remains a draft.

## Scope and execution

The saved sample comprised three educator options for two fixed grouping comparisons and one developer-tool analysis for an old-experiment review and one focused draft. Expected grouping labels were withheld from the model. Calls used Native OpenAI `gpt-5.6-sol`, medium reasoning, the production grouping/experiment instructions, and production output schemas.

Maximum four calls; no new research, bulk generation, additional agents, transport retries, schema repairs, or automatic correction calls. Saved projects were read-only. This isolated harness tested semantic output; it did not apply family memberships or save an accepted experiment in the app.

| Call | Purpose | Result | Provider attempts | Latency |
|---|---|---|---:|---:|
| 1 | Two grouping comparisons | Both comparisons returned with complete requested IDs | 1 | 16.4 s |
| 2 | Review the saved combined experiment | Needs revision | 1 | 38.9 s |
| 3 | Draft one focused experiment | Saved; schema accepted | 1 | 62.1 s |
| 4 | Independently review the new draft | Reserved; completion unknown; no result recovered | Unknown | Unknown |

**Budget: 4/4 conservatively consumed; 0 remaining.** The acceptance helper's console raised `EPIPE` when its launching shell closed the output pipe. Three results were saved before the helper and its verified child processes were stopped. The fourth reservation counts against the cap regardless of whether the provider completed it. Nothing was retried.

The helper now logs to a file. An offline fault-injection check reproduced the console failure and verified file logging with closed stdout. The corrected live runner was not restarted. This was a temporary acceptance-harness failure; no application source was changed for it.

## Findings

### Grouping: the sampled count decisions are plausible, but the exact duplicate label disagrees

- Known-duplicate baseline: `423b65b4-2134-4235-aff1-3fad5b3ef92c` versus `12664f90-6afb-476c-a33c-59e659b0778a`. The reviewer returned **variant**, not the baseline's **duplicate**. Both relate to one purchase for collecting learner blockers, coordinating human responses, and confirming resolution. Lesson-linked questions versus live setup check-ins make the subtype debatable. This comparison should not add a second independent family, but it is not an exact-label pass.
- Clearly separate baseline: `14936262-8f53-467c-adbf-9ec8c76c5119` versus `423b65b4-2134-4235-aff1-3fad5b3ef92c`. The reviewer returned **separate-business**, matching the baseline. Prepublication repository validation and in-cohort learner support have different triggers, workflows, and standalone value.

On these two comparisons, the reviewer did not treat the overlapping pair as separate or merge the clearly separate pair. This sample is too small to estimate duplicate or incorrect-merge rates; variant-versus-duplicate remains unresolved.

### Old experiment: rejected, but the single-assumption check missed the combined pass condition

Saved developer option: `a6ed8747-be38-42dc-933a-ddcda9a90818`.

The old pass condition required teammate use, team-maintained manual entries, correct reconciliation, and paid continuation. Local review finds that this combines adoption, maintenance/reliability, and payment: a failure would not identify which assumption failed.

The model rejected it for unspecified payment amount/commitment and incomplete outcome rules, while returning `isolatesAssumption: true`. Therefore rejection is demonstrated, but reliable detection of multiple assumptions is **not**. The review also noted convenience and pain-screening bias.

### New draft: one payment assumption, with an invalid failure boundary

The draft measures actual upfront payment of USD 400 for one standardized pilot. Usage and reliability are deferred to later tests, so the primary outcome is more focused than the old combined condition.

However, its rationale says **0% payment fails**, while its numeric rules set `failThreshold: 0`. The app implements failure as strictly below that threshold. Running the saved draft through the existing schema and classifier confirmed:

- Schema validation accepts the draft.
- With five usable offers and 0% conversion, the classifier returns **inconclusive**.
- No nonnegative conversion percentage can satisfy the draft's failure condition.

This is a concrete semantic defect in the generated draft. The unavailable fourth review means this pass cannot establish whether the review stage would catch it before acceptance. The draft was not promoted to an approved app result.

The five-offer sample, 40% pass threshold, and USD 400 price remain proposed decision policies rather than empirical benchmarks. Recruitment screens for reported pain, so any inference would be limited to that selected segment.

## Existing workflow verification reused

For implementation `e152842`, the existing `bun run check` passed lint, both TypeScript projects, and Svelte diagnostics, plus 187 unit, 154 integration, and 65 renderer tests (406 total). The existing opt-in Exa live test was skipped. Installed package/integrity verification and the installed Electron bridge test also passed. Prior browser checks exercised target completion, reversible grouping, persistence, and exports.

These results support workflow mechanics; they do not establish semantic quality. No full suite was rerun for this documentation-only acceptance pass. The only new offline checks inspected the saved numeric boundary and the temporary harness logging failure.

## Remaining uncertainty

- No recovered final semantic review of the new draft.
- Duplicate-versus-variant disagreement and a missed multiple-assumption flag.
- No broad inventory review, matched-run comparison, or cross-scope quality claim.
- No additional calls or fixes under this exhausted budget.

Follow-up should make numeric comparator semantics explicit to generation/review and check the observed impossible-failure case. It should also retain this combined-condition example as a negative control for assumption isolation. Those follow-ups are not implemented or validated by this pass.

Local raw requests, results, the original ledger, and interruption notes remain under `build/lean-acceptance-results/`; they are not committed.
