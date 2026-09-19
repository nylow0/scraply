import { numericOutcomeLabels, numericInconclusiveLabel, type FocusedExperimentRecord } from "../shared/focused-experiment";
import type { OpportunityFamiliesView } from "../shared/opportunity-review";

export function renderFocusedExperiment(record: FocusedExperimentRecord): string {
  const { plan } = record;
  const rules = plan.outcomeRules;
  const numericRules = rules.kind === "numeric-threshold" ? [
    `Pass: ${plan.primaryMetric.name} is ${numericOutcomeLabels(rules).pass} ${plan.primaryMetric.unit}.`,
    `Fail: ${plan.primaryMetric.name} is ${numericOutcomeLabels(rules).fail} ${plan.primaryMetric.unit}.`,
    `Inconclusive: ${numericInconclusiveLabel(rules, plan.primaryMetric.unit)} ${rules.insufficientDataReason}`,
    ...(!rules.metricRange ? ["Legacy numeric plan: metric bounds were not recorded. Thresholds are unchanged; review these rules before running the experiment."] : []),
  ] : [
    `Pass: ${rules.passCriterion}`,
    `Fail: ${rules.failCriterion}`,
    `Inconclusive: ${rules.inconclusiveCriterion}`,
  ];
  return [
    "## Focused experiment", "", `Review status: ${record.status}. This is a plan, not a recorded experiment. Confirm the decision policy before running a customer experiment.`, "",
    `Primary assumption: ${plan.assumption.id} (${plan.assumption.category})`, "", plan.assumption.testableClaim, "",
    `Why this premise: ${plan.assumption.selectionReason}`, "", `Decision impact: ${plan.assumption.decisionImpact}`, "",
    ...(plan.assumptionChangeReason ? [`Previous assumption: ${plan.shortDemandTestAssumptionId}. Change reason: ${plan.assumptionChangeReason}`, ""] : []),
    "### Participants and cases", "", ...plan.participantsAndCases.eligibilityCriteria.map(item => `- ${item}`), "",
    `Sampling: ${plan.participantsAndCases.caseSelection}`, "", `Recruitment: ${plan.participantsAndCases.recruitmentMethod}`, "",
    ...plan.participantsAndCases.exclusions.map(item => `- Exclude: ${item}`), "",
    `Primary metric: ${plan.primaryMetric.name}. Unit: ${plan.primaryMetric.unit}.`, "",
    ...(plan.primaryMetric.numerator ? [`Numerator: ${plan.primaryMetric.numerator}`, ""] : []),
    ...(plan.primaryMetric.denominator ? [`Denominator: ${plan.primaryMetric.denominator}`, ""] : []),
    `Collection: ${plan.primaryMetric.collectionMethod}`, "", `Baseline: ${plan.primaryMetric.comparisonBaseline}`, "",
    `Sample: ${plan.sample.targetObservations} observations; recruitment limit ${plan.sample.recruitmentLimit}; window ${plan.sample.observationWindow.value} ${plan.sample.observationWindow.unit}.`, "",
    plan.sample.feasibilityRationale, "", ...numericRules, "",
    `Minimum usable observations: ${rules.minimumUsableObservations}. ${rules.unusableObservationRule}`, "", `Threshold policy rationale: ${rules.thresholdRationale}`, "",
    `Effort: ${plan.resources.estimatedEffort}. Spending limit: ${plan.resources.spendingLimit.amount} ${plan.resources.spendingLimit.currency}.`, "",
    ...plan.resources.dependencies.map(item => `- Dependency: ${item}`), "",
    ...(plan.paymentTerms ? [`Payment test: ${plan.paymentTerms.amount} ${plan.paymentTerms.currency}; commitment: ${plan.paymentTerms.commitmentAction}`, ""] : []),
    `After pass: ${plan.followOnDecision.pass}`, "", `After fail: ${plan.followOnDecision.fail}`, "", `After inconclusive: ${plan.followOnDecision.inconclusive}`, "",
    `Semantic review: ${record.initialReview.verdict}; corrections: ${record.correctionCount}.`, "",
    ...record.initialReview.issues.map(item => `- Initial review: ${item}`),
    ...(record.finalReview?.issues ?? []).map(item => `- Final review: ${item}`), "",
  ].join("\n");
}

export function renderOpportunityFamilies(view: OpportunityFamiliesView): string {
  return [
    "# Business family review", "",
    `${view.acceptedFamilyCount} distinct startup families from ${view.rawOptionCount} raw options. ${view.unreviewedOptionIds.length} unreviewed options and ${view.unresolved.length} unresolved decisions.`, "",
    "Family membership does not establish demand and does not change the original problem evidence.", "",
    ...view.families.flatMap(family => [
      `## ${family.title}`, "", `Family ID: ${family.id}. Representative: ${family.representativeOptionId}. Counted: ${family.counted ? "yes" : "no"}.`, "", family.summary, "",
      ...family.members.flatMap(member => [`- ${member.optionId}: ${member.description}`, `  Relationship: ${member.relationship}. State: ${member.state}. Reason: ${member.reason}`]), "",
    ]),
    "## Unresolved", "", ...view.unresolved.map(item => `- ${item.membership.optionId}: ${item.membership.reason}`), "",
    "## Unreviewed IDs", "", ...view.unreviewedOptionIds.map(id => `- ${id}`), "",
  ].join("\n");
}
