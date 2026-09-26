<script lang="ts">
  import { numericMetricRangeLabel, numericOutcomeLabels, numericInconclusiveLabel, type FocusedExperimentRecord } from "../../shared/focused-experiment";

  let { experiment }: { experiment: FocusedExperimentRecord } = $props();
  let plan = $derived(experiment.plan);
  let review = $derived(experiment.finalReview ?? experiment.initialReview);
  let metricRange = $derived(plan.outcomeRules.kind === "numeric-threshold"
    ? numericMetricRangeLabel(plan.outcomeRules, plan.primaryMetric.unit)
    : null);

  function thresholdLabel(kind: "pass" | "fail"): string {
    const rules = plan.outcomeRules;
    if (rules.kind !== "numeric-threshold") return kind === "pass" ? rules.passCriterion : rules.failCriterion;
    return `${plan.primaryMetric.name} is ${numericOutcomeLabels(rules)[kind]} ${plan.primaryMetric.unit}`;
  }

  function inconclusiveLabel(): string {
    const rules = plan.outcomeRules;
    if (rules.kind === "reviewed-text") return rules.inconclusiveCriterion;
    return numericInconclusiveLabel(rules, plan.primaryMetric.unit);
  }
</script>

<section class="focused-experiment" aria-label="Focused experiment">
  <div class="title-row">
    <div>
      <p class="eyebrow">Focused experiment</p>
      <h3>{plan.assumption.testableClaim}</h3>
    </div>
    <span class:approved={experiment.status === "approved"} class="review-status">
      {experiment.status === "approved" ? "Reviewed" : "Needs revision"}
    </span>
  </div>
  <p class="planning-note">This is a plan. It has not been run and does not confirm customer demand.</p>
  <dl class="assumption-grid">
    <!-- The claim itself is the heading above; the assumption's stored id is an internal key, so only its type is shown. -->
    <div><dt>Assumption type</dt><dd><span class="category">{plan.assumption.category.replaceAll("-", " ")}</span></dd></div>
    <div><dt>Why it changes the decision</dt><dd>{plan.assumption.decisionImpact}</dd></div>
    <div><dt>Why test this first</dt><dd>{plan.assumption.selectionReason}</dd></div>
    {#if plan.assumptionChangeReason}<div><dt>Changed from the short test</dt><dd>{plan.assumptionChangeReason}</dd></div>{/if}
  </dl>

  <div class="section-grid">
    <section>
      <h4>Participants and cases</h4>
      <p>{plan.participantsAndCases.caseSelection}</p>
      <dl>
        <div><dt>Eligible</dt><dd>{#if plan.participantsAndCases.eligibilityCriteria.length > 1}<ul>{#each plan.participantsAndCases.eligibilityCriteria as item, index (index)}<li>{item}</li>{/each}</ul>{:else}{plan.participantsAndCases.eligibilityCriteria[0] ?? "None specified"}{/if}</dd></div>
        <div><dt>Recruitment</dt><dd>{plan.participantsAndCases.recruitmentMethod}</dd></div>
        <div><dt>Exclusions</dt><dd>{#if plan.participantsAndCases.exclusions.length > 1}<ul>{#each plan.participantsAndCases.exclusions as item, index (index)}<li>{item}</li>{/each}</ul>{:else}{plan.participantsAndCases.exclusions[0] ?? "None specified"}{/if}</dd></div>
      </dl>
    </section>
    <section>
      <h4>Primary metric</h4>
      <strong>{plan.primaryMetric.name}</strong>
      <p>{plan.primaryMetric.collectionMethod}</p>
      <dl>
        <div><dt>Unit</dt><dd>{plan.primaryMetric.unit}</dd></div>
        {#if metricRange}<div><dt>Metric range</dt><dd>{metricRange}</dd></div>{/if}
        <div><dt>Baseline</dt><dd>{plan.primaryMetric.comparisonBaseline}</dd></div>
        <div><dt>Sample</dt><dd>{plan.sample.targetObservations} observations, recruit up to {plan.sample.recruitmentLimit}, over {plan.sample.observationWindow.value} {plan.sample.observationWindow.unit}</dd></div>
      </dl>
    </section>
  </div>

  <section class="decision-rules">
    <h4>Decision rules</h4>
    <dl>
      <div><dt>Pass</dt><dd>{thresholdLabel("pass")}</dd></div>
      <div><dt>Fail</dt><dd>{thresholdLabel("fail")}</dd></div>
      <div><dt>Inconclusive</dt><dd>{inconclusiveLabel()}</dd></div>
    </dl>
    <p class="rationale">{plan.outcomeRules.thresholdRationale}</p>
    {#if plan.outcomeRules.kind === "numeric-threshold" && !plan.outcomeRules.metricRange}
      <p role="status">Legacy numeric plan: metric bounds were not recorded. Thresholds are unchanged; review these rules before running the experiment.</p>
    {/if}
  </section>

  <div class="section-grid">
    <section>
      <h4>Cost and dependencies</h4>
      <p>{plan.resources.estimatedEffort}</p>
      <dl>
        <div><dt>Spending limit</dt><dd>{plan.resources.spendingLimit.amount} {plan.resources.spendingLimit.currency}</dd></div>
        <div><dt>Dependencies</dt><dd>{#if plan.resources.dependencies.length > 1}<ul>{#each plan.resources.dependencies as item, index (index)}<li>{item}</li>{/each}</ul>{:else}{plan.resources.dependencies[0] ?? "None"}{/if}</dd></div>
        {#if plan.paymentTerms}<div><dt>Commitment</dt><dd>{plan.paymentTerms.amount} {plan.paymentTerms.currency}. {plan.paymentTerms.commitmentAction}</dd></div>{/if}
      </dl>
    </section>
    <section>
      <h4>What happens next</h4>
      <dl>
        <div><dt>After pass</dt><dd>{plan.followOnDecision.pass}</dd></div>
        <div><dt>After fail</dt><dd>{plan.followOnDecision.fail}</dd></div>
        <div><dt>After inconclusive</dt><dd>{plan.followOnDecision.inconclusive}</dd></div>
      </dl>
    </section>
  </div>

  {#if experiment.status === "needs_revision"}
    <aside role="status">
      <strong>Review did not approve this plan.</strong>
      <p>{review.rationale}</p>
      {#if review.issues.length}<ul>{#each review.issues as issue, index (index)}<li>{issue}</li>{/each}</ul>{/if}
    </aside>
  {/if}
</section>

<style>
  .focused-experiment { border:1px solid #bdbdbd38;border-radius:14px;padding:22px;margin-top:28px;background:var(--surface); }
  .title-row { display:flex;justify-content:space-between;align-items:start;gap:20px; }
  .eyebrow { margin:0 0 8px;color:var(--accent-strong);font-size:13px; }
  h3 { margin:0;max-width:70ch;font-size:16px;line-height:1.6; }
  h4 { margin:0 0 12px;font-size:13px; }
  p,li,dd { color:var(--muted);font-size:13px;line-height:1.7; }
  .planning-note { color:var(--subtle);margin:8px 0 20px; }
  .review-status { flex-shrink:0;border:1px solid #e6a34a66;border-radius:999px;padding:4px 9px;color:#e6a34a;font-size:11px; }
  .review-status.approved { border-color:#bdbdbd66;color:var(--accent-strong); }
  .category { display:inline-block;margin-right:6px;padding:2px 6px;border:1px solid var(--border-strong);border-radius:5px;text-transform:capitalize; }
  .assumption-grid,.section-grid { display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;margin-top:18px; }
  .assumption-grid { padding-top:18px;border-top:1px solid var(--border); }
  .assumption-grid > div:first-child:last-child { grid-column:1/-1; }
  .section-grid > section,.decision-rules,aside { border-top:1px solid var(--border);padding-top:18px; }
  dl { display:grid;gap:12px;margin:0; }
  /* A section's lead paragraph or metric name sits above its details with the same gap the details use. */
  section > p,section > strong { display:block;margin:0 0 12px; }
  section > strong { margin-bottom:4px; }
  .decision-rules { margin-top:18px; }
  dt { color:var(--subtle);font-size:12px;margin-bottom:4px; }
  dd { margin:0; }
  strong { font-size:13px; }
  .rationale { margin:14px 0 0;color:var(--subtle); }
  .decision-rules > p[role="status"] { margin:10px 0 0;color:#e4b46f; }
  aside { margin-top:18px; }
  aside strong { color:#e6a34a; }
  aside p { margin-bottom:0; }
  ul { margin:0;padding-left:18px;list-style:disc; }
  li + li { margin-top:4px; }
  @container page (max-width:700px) { .assumption-grid,.section-grid { grid-template-columns:1fr; }.title-row { flex-direction:column; }.review-status { align-self:start; } }
</style>
