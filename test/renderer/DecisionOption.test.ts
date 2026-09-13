import { fireEvent, render, waitFor, within } from "@testing-library/svelte";
import { describe, expect, test, vi } from "vitest";
import DecisionOption from "../../src/renderer/components/DecisionOption.svelte";
import type { SolutionView } from "../../src/shared/ipc";

describe("DecisionOption interactions", () => {
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
    await fireEvent.input(decision, { target: { value: "Submitted draft" } });
    await fireEvent.click(view.getByRole("button", { name: "Save decision and result" }));
    await fireEvent.input(decision, { target: { value: "Newer unsaved draft" } });
    pendingSave.resolve();

    await waitFor(() => expect(saveCompleted).toBe(true));
    expect(onSave).toHaveBeenCalledWith(idea.id, "Submitted draft", "", "not-run");
    expect(decision.value).toBe("Newer unsaved draft");
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
    const exhaustedDetail = detail(exhausted, "", "");
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
    const exhaustedView = render(DecisionOption, { ...handlers(exhausted), onEvidenceFollowUp });
    await fireEvent.click(exhaustedView.getByRole("button", { name: "Compare observed delivery windows." }));
    expect(await exhaustedView.findByText("Three suppliers publish dated arrival records.")).toBeTruthy();
    expect(exhaustedView.getByRole("link", { name: "Supplier delivery study" })).toBeTruthy();
    expect(exhaustedView.getByText("This option has used its one evidence follow-up.")).toBeTruthy();
    expect(exhaustedView.queryByRole("button", { name: "Check evidence" })).toBeNull();
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
