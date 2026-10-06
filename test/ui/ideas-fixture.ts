import { SolutionViewSchema, type SolutionView } from "../../src/shared/ipc";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";
import type { IdeaConversation, WorkflowDetail } from "../../src/shared/workflow-contracts";

export const SCHOOL_PROBLEM = "Some school staff lack access to the consumption histories needed to assess energy savings. They need usable historical and operational evidence to distinguish successful conservation from continuing waste, such as equipment left on over weekends.";
export const HISTORY_MECHANISM = "With school approval, obtain one existing meter-export format or manually entered billing history from its authorized holder. Preserve the original file and map each record to its meter, period, unit and source. Check for missing periods, overlaps and inconsistent units without silently filling gaps. Generate a read-only pack containing consumption history, data coverage and links back to source records, excluding account credentials and unnecessary financial details. Explicitly distinguish monthly evidence suitable for broad trends from interval evidence capable of examining weekends. Give the evaluating staff access to the pack and name the person responsible for refreshing it. Limit the one-month prototype to one school and one import format. Test it by asking staff who previously lacked access to retrieve consumption for a specific conservation period and explain whether the records support a comparison. If enabling an existing account provides equally usable evidence, the additional software has not demonstrated value.";
export const fixtureAnalysis: NonNullable<SolutionView["decisionAnalysis"]> = {
  consequences: [{ direction: "positive", description: "Staff can compare conservation periods using the same records.", affects: "School energy reviews", rationale: "A shared history removes the access barrier." }],
  risks: [
    { riskId: "access", description: "The authorized holder cannot share usable consumption records.", whyDecisive: "Without records, the pack cannot answer even a broad savings question." },
    { riskId: "coverage", description: "Monthly totals cannot reveal weekend waste.", whyDecisive: "A broad trend can hide equipment left on for a specific closure period." },
  ],
  proposedResponses: [{ riskIds: ["access"], approach: "Ask the record holder for one approved export before building an importer.", cost: "One staff meeting and one sample export", failsIf: "Sharing permission or usable records remain unavailable." },
    { riskIds: ["coverage"], approach: "Show the coverage of every comparison and use interval records for weekend questions.", cost: "A coverage check for each imported period", failsIf: "Staff treat monthly totals as evidence about individual weekends." }],
  experiment: { question: "Can staff who previously lacked access retrieve a conservation period and judge the comparison?", method: "Give three staff members a read-only pack for one school. Ask each to find a named period and explain which comparison the records support.", cost: "One approved export and a half-day staff session", passCriterion: "All three retrieve the period and identify the coverage limit without help.", failCriterion: "Any staff member cannot retrieve the period or draws a comparison the records cannot support.", inconclusiveCriterion: "The approved export is incomplete." },
  unknowns: ["Whether an existing account provides equally usable evidence."],
};

export function createIdeasFixture(params = new URLSearchParams(), threadId = "fixture-0") {
  const descriptions = [
    "History access and provenance pack. A programming-project workflow improvement for schools where consumption records exist but the staff evaluating conservation cannot obtain usable copies. The deliverable is a traceable, shareable evidence pack, rather than another energy dashboard.",
    "Prospective closure-period evidence recorder. Record meter readings and equipment checks before and after school closures. Staff can compare the same buildings over several weekends without guessing from monthly bills.",
    "Savings-claim evidence checker. Compare a claimed energy saving with the periods and units in its supporting records. Flag comparisons that cross a meter change or omit part of the school.",
    "Exception-aware operating-schedule auditor. Compare planned shutdowns with actual equipment schedules. Keep exceptions such as sports events and maintenance visible when staff assess weekend use.",
    "Evidence-gated weekend incident tracker. Link a suspected waste incident to a meter interval and a staff observation. Leave cases open when the evidence cannot distinguish waste from an approved activity.",
    "Staff-supervised load-isolation replay. Let authorized staff compare a short equipment shutdown with the surrounding meter readings. A recorded checklist keeps each trial repeatable and avoids switching off essential systems.",
    "Weekend energy log: Caretakers note what was left on each Friday. Monday readings help staff spot repeated waste and decide which equipment needs a closer check.",
    "Meter coverage map: Connect each available export to the rooms and equipment it covers. Staff can see which parts of a savings claim still need evidence.",
    "Shared closure checklist: Give caretakers one record of which rooms should close each Friday. Staff review missed checks together on Monday.",
    "Event-aware shutdown rota: Keep planned evening events beside the shutdown schedule. The caretaker can distinguish a legitimate exception from a missed switch-off.",
    "Automatic building controls: Replace manual checks with remotely managed shutdowns. This requires access to building controls and a specialist installation.",
  ];
  const secondProblem = "Caretakers need a reliable handoff for shutting down unused rooms before weekends, while preserving equipment needed for approved evening events.";
  const minimal = params.has("minimal");
  const solutions = descriptions.map((description, index) => SolutionViewSchema.parse({
    id: `school-idea-${index + 1}`, runId: index < 8 ? "school-run" : "closure-run", workflowVersion: params.get("saved") === "v1" ? 1 : 2,
    detailsLoaded: true, detailRevision: "fixture-idle", problemId: index < 8 ? "school" : "closure",
    problemStatement: index < 8 ? SCHOOL_PROBLEM : secondProblem, problemVerdict: "confirmed", description,
    mechanism: index === 0 ? HISTORY_MECHANISM : "Gather the records with school approval. Compare a named period with its documented baseline. Ask staff to review the result and record any exceptions.",
    rank: params.has("unranked") ? null : index < 8 ? index + 1 : index - 7,
    rankReason: params.has("unranked") ? null : "This addresses the access barrier with one approved export before requiring new equipment or a whole-school deployment.",
    weakFitReason: index === 10 ? "Needs specialist installation and permission to change building controls." : null,
    selected: index === 0 && ["running", "done", "failed"].includes(params.get("analysis") ?? ""), selectable: true,
    respectsOffLimits: true, respectsOffLimitsWhy: "Uses approved records without storing credentials or unnecessary financial details.",
    keyAssumption: "The authorized holder can provide records covering a useful comparison period.",
    whyCurrentApproachMaySuffice: "An existing account may already give staff the same usable records.",
    unknowns: ["Whether the records cover individual weekends or only monthly trends."],
    ...(!minimal ? {
      criteriaFit: [{ criterionId: "access", criterionName: "Usable staff access", mustHave: true, status: "meets", note: "Staff can retrieve the records without access to the original account.", evidenceIds: ["school-source"] }],
      biggerProblem: { statement: SCHOOL_PROBLEM, affected: "School staff evaluating energy conservation", scale: "One school for the prototype", scaleKnown: false, scaleEvidenceIds: [] },
      firstTest: { kind: "process-test", question: fixtureAnalysis.experiment.question, method: fixtureAnalysis.experiment.method, metric: "Successful retrievals with a correct coverage explanation", sample: 3, observationWindow: "one afternoon", cost: fixtureAnalysis.experiment.cost, passCriterion: fixtureAnalysis.experiment.passCriterion, failCriterion: fixtureAnalysis.experiment.failCriterion, inconclusiveCriterion: "A missing export prevents the comparison." },
      startupOpportunity: { opportunityType: "startup-opportunity", payingCustomerSegment: "School operations teams", trigger: "A conservation review needs records staff cannot access", existingSubstitute: "Request an account export from the record holder", gapAssessment: { kind: "hypothesis", description: "Shared access may reduce repeated requests for records.", evidenceIds: ["school-source"] }, smallestSellableWorkflow: "One approved export made readable and shareable", firstCustomerRoute: "Ask one school's operations lead to trial a pack", disconfirmingDemandTest: "Staff retrieve the same evidence from an existing account without help." },
    } : {}),
    factors: [{ id: "school-factor", sourceId: "school-source", subject: "School conservation staff", behavior: "cannot obtain consumption histories", quote: "We can see the bill total, but we cannot get the records for the weeks we are trying to compare.", sourceTitle: "School operations interview", sourceUrl: "https://example.org/school-interview", harvestMode: "domain", modelConfidence: 0.8, sourceRole: "firsthand", audienceFit: "intended-buyer", independentSourceKey: "school-operations" }],
    supportingEvidenceIds: ["school-source"], contraryEvidenceIds: [], contrarySources: [],
    outcomes: [{ id: "retrieval", description: "Staff retrieve the conservation period without requesting another export.", direction: "positive", affects: "Energy reviews", addressesCore: true }],
    risks: [{ id: "access", description: "Staff cannot obtain an approved export.", likelihood: "possible", impact: "~2 weeks", sortKey: 4, mitigations: [{ id: "approval", approach: "Obtain permission before prototyping", cost: "One meeting", failsIf: "The holder cannot share the records", riskIds: ["access"] }] }],
    confirmedCoreOutcomes: 1, unaddressedCatastrophicRisks: 0,
    decisionAnalysis: index === 0 && params.get("analysis") === "done" ? fixtureAnalysis : null,
  }));
  if (params.get("analysis") === "done") solutions[0]!.selectable = false;
  if (params.has("partial")) {
    solutions[0]!.riskEvaluation = { risks: fixtureAnalysis.risks, unknowns: fixtureAnalysis.unknowns };
    solutions[0]!.focusedExperiment = {
      schemaVersion: 1, status: "approved", correctionCount: 0, finalReview: null,
      initialReview: { schemaVersion: 1, verdict: "approved", isolatesAssumption: true, measuresBehavior: true,
        controlsComparison: true, outcomeRulesCoherent: true, rationale: "The same retrieval task checks access and coverage.", issues: [], correctionInstruction: null },
      plan: { schemaVersion: 1,
        assumption: { id: "record-access", category: "mechanism-value", testableClaim: "Staff can retrieve a period and judge what its records support.",
          decisionImpact: "A failed retrieval stops the pack prototype.", selectionReason: "Usable access is the main untested assumption." },
        shortDemandTestAssumptionId: null, assumptionChangeReason: null,
        participantsAndCases: { eligibilityCriteria: ["School staff who previously lacked access"], caseSelection: "Use one approved school export.",
          exclusions: ["The staff member who prepared the pack"], recruitmentMethod: "Invite three staff responsible for conservation reviews." },
        primaryMetric: { name: "correct unassisted retrievals", unit: "retrievals", numerator: null, denominator: null,
          collectionMethod: "Ask each participant to find the same period and explain its coverage.", comparisonBaseline: "The same task with the current account access." },
        sample: { targetObservations: 3, recruitmentLimit: 3, observationWindow: { value: 4, unit: "hours" }, feasibilityRationale: "Three staff can attend one afternoon session." },
        outcomeRules: { kind: "numeric-threshold", direction: "higher-is-better", passThreshold: 3, failThreshold: 2, metricRange: { minimum: 0, maximum: 3 },
          thresholdRationale: "Every participant must retrieve the period correctly.", minimumUsableObservations: 3,
          insufficientDataReason: "Fewer than three attempts cannot decide the result.", unusableObservationRule: "Exclude attempts without a complete export." },
        resources: { estimatedEffort: "One afternoon", dependencies: ["An approved meter export"], spendingLimit: { amount: 0, currency: "USD" } },
        paymentTerms: null, followOnDecision: { pass: "Build the one-format importer.", fail: "Stop and review the access barrier.", inconclusive: "Complete the missing retrievals." },
      },
    };
  }
  const versions: IdeaConversation["versions"] = Array.from({ length: params.get("versions") === "3" ? 3 : 1 }, (_, index) => ({
    solutionId: index ? `school-version-${index + 1}` : solutions[0]!.id, parentSolutionId: index === 2 ? "school-version-2" : index ? solutions[0]!.id : null,
    versionNumber: index + 1, evidenceSnapshotId: "school-snapshot", changeSummary: index === 1 ? "Limit the pack to one approved meter export and add a coverage check." : null,
    description: index ? `School evidence pack ${index + 1}: Give evaluating staff one approved meter export with visible coverage limits.` : solutions[0]!.description,
    mechanism: index === 2 ? "Request a dated export from the authorized holder. Check that its intervals cover the conservation period. Share the comparison with a visible record of missing periods." : index ? "Obtain one approved meter export. Record missing periods and unit changes. Share a read-only comparison with the staff who evaluate conservation." : HISTORY_MECHANISM,
    reviewFreshness: index ? "unreviewed" : "current", model: DEFAULT_RUN_CONFIG.model, reasoningEffort: "medium",
  }));
  const conversation: IdeaConversation = { rootSolutionId: solutions[0]!.id, selectedVersionId: versions.length > 1 ? versions[1]!.solutionId : versions[0]!.solutionId,
    defaultModel: DEFAULT_RUN_CONFIG.model, versions, branches: [], turns: [], nextCursor: null };
  const workflow: WorkflowDetail = { summary: {
    sessionId: "school-session", threadId, purpose: params.get("purpose") === "known-problem" ? "known-problem" : "discovery",
    mode: params.get("mode") === "controlled" ? "babysit" : "vibe", targetKind: "per-problem", state: "finished", outcome: "target-met", revision: 1,
    activeSnapshotId: "school-snapshot", selectedProblemIds: ["school", "closure"], ideaTargetReady: true,
    counts: { requested: 11, attempted: 11, validated: 11, accepted: 11, duplicate: 0, unresolved: 0, failed: 0, missing: 0, existing: 0, addedBySession: 11, total: 11 },
    limits: { maxModelCalls: 30, maxSearches: 12, maxMinutes: 60 }, budget: { modelCalls: { limit: 30, spent: 8, reserved: 0, uncertain: 0 }, searches: { limit: 12, spent: 4, reserved: 0, uncertain: 0 }, remainingMs: 50 * 60_000 },
    currentStage: null, stopReason: null, startedAt: "2026-10-05T10:00:00.000Z", finishedAt: "2026-10-05T10:10:00.000Z",
  }, tasks: [], nextCursor: null };
  return { solutions, conversation, workflow };
}
