import { fireEvent, render, waitFor, within } from "@testing-library/svelte";
import { describe, expect, test, vi } from "vitest";
import DecisionOption from "../../src/renderer/components/DecisionOption.svelte";
import type { SolutionView } from "../../src/shared/ipc";

describe("DecisionOption interactions", () => {
  test("shows the short demand test as one priced commitment assumption", async () => {
    const idea = option("short-demand-test");
    idea.startupOpportunity = {
      opportunityType: "startup-opportunity",
      payingCustomerSegment: "Independent operators",
      trigger: "A duplicate filing is found",
      existingSubstitute: "Manual shared-state check",
      gapAssessment: { kind: "hypothesis", description: "Manual checks may be skipped", evidenceIds: [] },
      smallestSellableWorkflow: "Manual duplicate check",
      firstCustomerRoute: "Operator community",
      disconfirmingDemandTest: "Legacy summary",
    };
    idea.focusedDemandTest = {
      schemaVersion: 1,
      assumption: { id: "payment-pilot", category: "payment", testableClaim: "Operators pay for a manual pilot.", decisionImpact: "No commitment stops the build.", selectionReason: "Payment is the remaining unknown." },
      methodSummary: "Offer the same manual pilot to ten eligible operators.",
      disconfirmingObservation: "No operator pays the deposit.",
      paymentTerms: { amount: 250, currency: "USD", commitmentAction: "Pay a refundable deposit." },
    };
    installDetailApi(vi.fn().mockResolvedValue(detail(idea, "", "")));
    const view = render(DecisionOption, handlers(idea));
    await fireEvent.click(view.getByRole("button", { name: "Compare observed delivery windows." }));
    expect(view.getByText("Operators pay for a manual pilot.")).toBeTruthy();
    expect(view.getByText("250 USD. Pay a refundable deposit.")).toBeTruthy();
    expect(view.queryByText("Legacy summary")).toBeNull();
  });

  test("offers explicit focused planning for saved analyses without marking an experiment as run", async () => {
    const idea = option("focused-plan-request");
    installDetailApi(vi.fn().mockResolvedValue(detail(idea, "", "")));
    const onPlanExperiment = vi.fn().mockResolvedValue(undefined);
    const view = render(DecisionOption, { ...handlers(idea), onPlanExperiment });
    await fireEvent.click(view.getByRole("button", { name: "Compare observed delivery windows." }));
    await fireEvent.click(await view.findByRole("button", { name: "Plan a focused experiment" }));
    expect(onPlanExperiment).toHaveBeenCalledWith(idea);
    expect(view.getByText("This creates a reviewed plan. It does not run a customer experiment.")).toBeTruthy();
  });

  test("renders the structured plan and its review state instead of the legacy experiment summary", async () => {
    const idea = option("focused-plan-view");
    const saved = detail(idea, "", "");
    saved.focusedExperiment = focusedExperiment();
    saved.decisionAnalysis = null;
    installDetailApi(vi.fn().mockResolvedValue(saved));
    const view = render(DecisionOption, handlers(idea));
    await fireEvent.click(view.getByRole("button", { name: "Compare observed delivery windows." }));
    const experiment = await view.findByRole("region", { name: "Focused experiment" });
    expect(view.getByText("This is a plan. It has not been run and does not confirm customer demand.")).toBeTruthy();
    expect(view.getByText("additional confirmed contradictions is at least 8 contradictions")).toBeTruthy();
    expect(within(experiment).getByText("Maintains answer keys").closest("li")).not.toBeNull();
    expect(within(experiment).getByText("Revision access").closest("li")).not.toBeNull();
    expect(view.queryByText("Are estimates accurate?")).toBeNull();
  });

  test("links each option's citations separately from the original problem evidence", async () => {
    const idea = option("citation-roles");
    const saved = detail(idea, "", "");
    saved.contrarySources = [{ id: "manual-alternative", title: "Manual checklist", url: "https://example.com/checklist", text: "Existing checklists work." }];
    saved.supportingEvidenceIds = ["manual-alternative"];
    saved.contraryEvidenceIds = [idea.factors[0]!.sourceId];
    installDetailApi(vi.fn().mockResolvedValue(saved));
    const props = handlers(idea);
    const view = render(DecisionOption, props);
    await fireEvent.click(view.getByRole("button", { name: "Compare observed delivery windows." }));
    const supporting = await view.findByRole("region", { name: "Sources supporting this option" });
    await fireEvent.click(within(supporting).getByRole("link", { name: "Manual checklist" }));
    expect(props.onOpenSource).toHaveBeenCalledWith("https://example.com/checklist");
    const contrary = view.getByRole("region", { name: "Sources challenging this option" });
    expect(within(contrary).getByRole("link", { name: "Shop interview" }).getAttribute("href")).toBe("https://example.com/interview");
    expect(view.getByText("We call before quoting.")).toBeTruthy();
  });

  test("keeps edits made before and during a detail refresh", async () => {
    const refresh = deferred<SolutionView>();
    const first = option("draft-refresh-1");
    const getIdeaDetail = vi.fn().mockResolvedValueOnce(detail(first, "Saved decision", "Saved result")).mockReturnValueOnce(refresh.promise);
    installDetailApi(getIdeaDetail);
    const props = handlers(first);
    const view = render(DecisionOption, props);

    await fireEvent.click(view.getByRole("button", { name: "Compare observed delivery windows." }));
    const decision = await view.findByLabelText("Your decision") as HTMLTextAreaElement;
    const observed = view.getByLabelText("Observed test result") as HTMLTextAreaElement;
    await fireEvent.input(decision, { target: { value: "Draft before refresh" } });
    await view.rerender({ ...props, idea: { ...first, detailRevision: "revision-2" } });
    await waitFor(() => expect(getIdeaDetail).toHaveBeenCalledTimes(2));
    expect(view.getByText(/Loading saved details/)).toBeTruthy();
    await fireEvent.input(observed, { target: { value: "Edit during refresh" } });
    refresh.resolve(detail({ ...first, detailRevision: "revision-2" }, "Server changed decision", "Server changed result"));

    await waitFor(() => expect(view.queryByText(/Loading saved details/)).toBeNull());
    expect(decision.value).toBe("Draft before refresh");
    expect(observed.value).toBe("Edit during refresh");

    await fireEvent.click(view.getByRole("button", { name: "Compare observed delivery windows." }));
    await waitFor(() => expect(view.queryByLabelText("Your decision")).toBeNull());
    await fireEvent.click(view.getByRole("button", { name: "Compare observed delivery windows." }));
    expect((await view.findByLabelText("Your decision") as HTMLTextAreaElement).value).toBe("Draft before refresh");
    expect((view.getByLabelText("Observed test result") as HTMLTextAreaElement).value).toBe("Edit during refresh");
  });

  test("keeps edits made while a decision save is pending", async () => {
    const pendingSave = deferred<void>();
    const idea = option("pending-save-1");
    installDetailApi(vi.fn().mockResolvedValue(detail(idea, "", "")));
    let saveCompleted = false;
    const onSave = vi.fn().mockImplementation(async () => { await pendingSave.promise; saveCompleted = true; });
    const view = render(DecisionOption, { ...handlers(idea), onSave });
    await fireEvent.click(view.getByRole("button", { name: "Compare observed delivery windows." }));
    const decision = await view.findByLabelText("Your decision") as HTMLTextAreaElement;
    const outcome = view.getByLabelText("Experiment outcome") as HTMLSelectElement;
    await fireEvent.input(decision, { target: { value: "Submitted draft" } });
    await fireEvent.change(outcome, { target: { value: "pass" } });
    await fireEvent.click(view.getByRole("button", { name: "Save decision and result" }));
    await fireEvent.input(decision, { target: { value: "Newer unsaved draft" } });
    await fireEvent.change(outcome, { target: { value: "inconclusive" } });
    pendingSave.resolve();

    await waitFor(() => expect(saveCompleted).toBe(true));
    expect(onSave).toHaveBeenCalledWith(idea.id, "Submitted draft", "", "pass");
    expect(decision.value).toBe("Newer unsaved draft");
    expect(outcome.value).toBe("inconclusive");
    expect(view.queryByText("Saved", { exact: true })).toBeNull();
  });

  test("binds the follow-up to its option run and shows saved evidence after the cap is used", async () => {
    const available = option("follow-up-available");
    available.canRequestEvidenceFollowUp = true;
    const onEvidenceFollowUp = vi.fn().mockResolvedValue(undefined);
    installDetailApi(vi.fn().mockResolvedValue(detail(available, "", "")));
    const availableView = render(DecisionOption, { ...handlers(available), onEvidenceFollowUp });
    await fireEvent.click(availableView.getByRole("button", { name: "Compare observed delivery windows." }));
    await fireEvent.input(await availableView.findByLabelText("Question"), { target: { value: "Which suppliers publish arrival histories?" } });
    await fireEvent.click(availableView.getByRole("button", { name: "Check evidence" }));
    expect(onEvidenceFollowUp).toHaveBeenCalledWith(available.runId, "Which suppliers publish arrival histories?");

    availableView.unmount();
    const exhausted = option("follow-up-exhausted");
    exhausted.canReassessEvidence = false;
    const exhaustedDetail = detail(exhausted, "", "");
    exhaustedDetail.canReassessEvidence = true;
    exhaustedDetail.evidenceFollowUp = {
      status: "completed",
      question: "Which suppliers publish arrival histories?",
      sources: [],
      factors: [{ ...exhaustedDetail.factors[0]!, id: "follow-up-factor", quote: "Three suppliers publish dated arrival records.", sourceTitle: "Supplier delivery study" }],
      error: null,
      reassessmentStatus: null,
      riskReassessment: null,
      reassessmentAnalysis: null,
      reassessmentError: null,
    };
    installDetailApi(vi.fn().mockResolvedValue(exhaustedDetail));
    const onEvidenceReassessment = vi.fn().mockResolvedValue(undefined);
    const exhaustedView = render(DecisionOption, { ...handlers(exhausted), onEvidenceFollowUp, onEvidenceReassessment });
    await fireEvent.click(exhaustedView.getByRole("button", { name: "Compare observed delivery windows." }));
    expect(await exhaustedView.findByText("Three suppliers publish dated arrival records.")).toBeTruthy();
    expect(exhaustedView.getByRole("link", { name: "Supplier delivery study" })).toBeTruthy();
    expect(exhaustedView.getByText("This option has used its one evidence follow-up.")).toBeTruthy();
    expect(exhaustedView.queryByRole("button", { name: "Check evidence" })).toBeNull();
    await fireEvent.click(exhaustedView.getByRole("button", { name: "Reassess with new evidence" }));
    expect(onEvidenceReassessment).toHaveBeenCalledWith(exhausted.runId);
  });

  test("labels reassessed risk changes without rendering risks twice", async () => {
    const idea = option("risk-reassessment");
    const saved = detail(idea, "", "");
    const existingRisk = {
      riskId: "delivery-variance",
      description: "Existing delivery variance",
      whyDecisive: "Wide variance can make estimates misleading.",
    };
    const newRisk = {
      riskId: "supplier-dependency",
      description: "New supplier dependency",
      whyDecisive: "The follow-up found that one supplier controls the data feed.",
    };
    saved.decisionAnalysis = { ...saved.decisionAnalysis!, risks: [existingRisk] };
    saved.evidenceFollowUp = {
      status: "completed",
      question: "Who controls the delivery data?",
      sources: [],
      factors: [],
      error: null,
      reassessmentStatus: "completed",
      riskReassessment: {
        affectedRisks: [],
        newRisks: [newRisk],
        additionalUnknowns: [],
      },
      reassessmentAnalysis: {
        ...saved.decisionAnalysis,
        risks: [existingRisk, newRisk],
      },
      reassessmentError: null,
    };
    installDetailApi(vi.fn().mockResolvedValue(saved));
    const view = render(DecisionOption, handlers(idea));

    await fireEvent.click(view.getByRole("button", { name: "Compare observed delivery windows." }));
    const summary = await view.findByText("Reassessment with new evidence");
    const reassessment = summary.closest("details");
    expect(reassessment).toBeTruthy();
    const reassessmentView = within(reassessment!);
    expect(view.getAllByText("New risk: New supplier dependency")).toHaveLength(1);
    expect(reassessmentView.getByText("Existing delivery variance")).toBeTruthy();
    expect(reassessmentView.queryByText(/(?:New|Updated|Strengthened|Weakened) risk: Existing delivery variance/)).toBeNull();
  });
});

function handlers(idea: SolutionView) {
  return { idea, busy: false, onSelect: vi.fn(), onSave: vi.fn().mockResolvedValue(undefined), onOpenSource: vi.fn().mockResolvedValue(undefined) };
}

function installDetailApi(getIdeaDetail: (id: string) => Promise<SolutionView>): void {
  Object.defineProperty(window, "scraply", { configurable: true, value: { getIdeaDetail } });
}

function option(id: string): SolutionView {
  return {
    id, problemId: "problem-1", problemStatement: "Delivery dates are uncertain.", problemVerdict: "confirmed",
    workflowVersion: 2, runId: `run-${id}`, selected: true, selectable: false, detailsLoaded: false, detailRevision: "revision-1",
    keyAssumption: "Suppliers expose histories.", whyCurrentApproachMaySuffice: "Manual calls work at low volume.", unknowns: [],
    factors: [{ id: `factor-${id}`, subject: "Repair shops", behavior: "Call suppliers", quote: "We call before quoting.", sourceId: `source-${id}`, sourceTitle: "Shop interview", sourceUrl: "https://example.com/interview", harvestMode: "audience", modelConfidence: 0.8 }],
    mechanism: "Supplier reliability ledger", description: "Compare observed delivery windows.", respectsOffLimits: true, respectsOffLimitsWhy: "No inventory is held.",
    outcomes: [], risks: [], confirmedCoreOutcomes: 0, unaddressedCatastrophicRisks: 0,
  };
}

function detail(summary: SolutionView, userDecision: string, observedResult: string): SolutionView {
  return { ...summary, detailsLoaded: true, userDecision, observedResult, contrarySources: [], decisionAnalysis: {
    consequences: [{ description: "Narrower estimates", direction: "positive", affects: "Scheduling", rationale: "Histories replace guesses" }],
    risks: [], proposedResponses: [], unknowns: [], experiment: { question: "Are estimates accurate?", method: "Track ten deliveries", cost: "One week", passCriterion: "Eight match", failCriterion: "Three miss", inconclusiveCriterion: "Fewer than ten deliveries arrive" },
  } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => { resolve = fulfill; });
  return { promise, resolve };
}

function focusedExperiment() {
  const review = {
    schemaVersion: 1 as const,
    verdict: "approved" as const,
    isolatesAssumption: true,
    measuresBehavior: true,
    controlsComparison: true,
    outcomeRulesCoherent: true,
    rationale: "The plan compares the same cases and partitions every result.",
    issues: [],
    correctionInstruction: null,
  };
  return {
    schemaVersion: 1 as const,
    status: "approved" as const,
    correctionCount: 0 as const,
    initialReview: review,
    finalReview: null,
    plan: {
      schemaVersion: 1 as const,
      assumption: { id: "mechanism-contradictions", category: "mechanism-value" as const, testableClaim: "The checker finds confirmed contradictions missed by normal review.", decisionImpact: "Failure stops the mechanism.", selectionReason: "Mechanism value comes before adoption." },
      shortDemandTestAssumptionId: null,
      assumptionChangeReason: null,
      participantsAndCases: { eligibilityCriteria: ["Maintains answer keys"], caseSelection: "Use the next ten consecutive revisions.", exclusions: [], recruitmentMethod: "Invite the full maintainer roster." },
      primaryMetric: { name: "additional confirmed contradictions", unit: "contradictions", numerator: null, denominator: null, collectionMethod: "Confirm checker-only findings.", comparisonBaseline: "The same revision after normal review." },
      sample: { targetObservations: 10, recruitmentLimit: 15, observationWindow: { value: 3, unit: "weeks" as const }, feasibilityRationale: "Ten revisions normally arrive." },
      outcomeRules: { kind: "numeric-threshold" as const, direction: "higher-is-better" as const, passThreshold: 8, failThreshold: 4, thresholdRationale: "Eight justifies a prototype.", minimumUsableObservations: 10, insufficientDataReason: "Fewer than ten is insufficient.", unusableObservationRule: "Exclude unconfirmed answers." },
      resources: { estimatedEffort: "Three facilitator days.", dependencies: ["Revision access"], spendingLimit: { amount: 500, currency: "USD" } },
      paymentTerms: null,
      followOnDecision: { pass: "Prototype automation.", fail: "Stop the mechanism.", inconclusive: "Recruit missing cases." },
    },
  };
}
