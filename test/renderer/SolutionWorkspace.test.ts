import { fireEvent, render, waitFor, within } from "@testing-library/svelte";
import { describe, expect, test, vi } from "vitest";
import SolutionListItem from "../../src/renderer/components/SolutionListItem.svelte";
import SolutionWorkspace from "../../src/renderer/components/SolutionWorkspace.svelte";
import type { SolutionView } from "../../src/shared/ipc";
import type { IdeaConversation as ConversationView } from "../../src/shared/workflow-contracts";
import type { OpportunityFamiliesView } from "../../src/shared/opportunity-review";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";

describe("SolutionListItem risk summary", () => {
  test("keeps the collapsed title free of risk details and retains the expanded snapshot", () => {
    const idea = solution();
    const view = render(SolutionListItem, { idea, rank: 1, onOpenSource: vi.fn() });
    const summary = view.container.querySelector(".solution-summary");

    expect(summary).not.toBeNull();
    expect(summary?.textContent?.trim()).toBe(idea.description);
    expect(summary?.textContent).not.toContain("Highest risk");
    const preview = within(view.container.querySelector(".expanded-snapshot") as HTMLElement);
    expect(preview.getByText("Highest risk: likely · project ends")).toBeTruthy();
    expect(preview.getByText("The only supplier can leave the market.")).toBeTruthy();
    expect(preview.queryByText("Shops may distrust pooled delivery data.")).toBeNull();
    const metrics = preview.getByLabelText("Solution evaluation snapshot");
    expect(metrics.textContent).toContain("2 project-ending");
    expect(metrics.textContent).toContain("1 unaddressed");
    expect(preview.queryByText(/fatal/i)).toBeNull();

  });

  test("uses API order to break tied risk scores and handles an empty risk list", () => {
    const first = solution();
    first.risks = [
      { ...first.risks[1]!, id: "tie-first", description: "First tied risk.", sortKey: 6 },
      { ...first.risks[0]!, id: "tie-second", description: "Second tied risk.", sortKey: 6 },
    ];
    const tiedView = render(SolutionListItem, { idea: first, rank: 1, onOpenSource: vi.fn() });
    const tiedSummary = within(tiedView.container.querySelector(".expanded-snapshot") as HTMLElement);

    expect(tiedSummary.getByText("First tied risk.")).toBeTruthy();
    expect(tiedSummary.queryByText("Second tied risk.")).toBeNull();

    const noRisks = solution();
    noRisks.risks = [];
    noRisks.unaddressedCatastrophicRisks = 0;
    const emptyView = render(SolutionListItem, { idea: noRisks, rank: 1, onOpenSource: vi.fn() });
    expect(emptyView.getByText("No risks identified")).toBeTruthy();
  });

  test("shows each risk with its response and failure condition without another disclosure", async () => {
    const view = render(SolutionListItem, { idea: solution(), rank: 1, onOpenSource: vi.fn() });
    const solutionSummary = view.container.querySelector(".solution-summary");

    await fireEvent.click(solutionSummary as HTMLElement);
    const riskCategoryLabel = view.getByText("Review all risks and responses");
    await fireEvent.click(riskCategoryLabel.closest("summary") as HTMLElement);

    const risk = view.getByRole("article", { name: "Shops may distrust pooled delivery data." });
    expect(within(risk).getByText("Show the source and age of each observation.")).toBeTruthy();
    expect(within(risk).getByText("Trust still depends on relationships.")).toBeTruthy();
    expect(risk.closest("details")).not.toBeNull();
    expect(risk.querySelector("details")).toBeNull();
  });

  test("keeps the problem evidence with the idea and opens its source through the app", async () => {
    const onOpenSource = vi.fn().mockResolvedValue(undefined);
    const view = render(SolutionListItem, { idea: solution(), rank: 1, onOpenSource });

    await fireEvent.click(view.container.querySelector(".solution-summary") as HTMLElement);
    expect(view.getByText("Supplier reliability ledger")).toBeTruthy();
    await fireEvent.click(view.getByText("Evidence behind this problem").closest("summary") as HTMLElement);
    expect(view.getByText("We call around before promising a date.")).toBeTruthy();
    expect(view.getByText("Specialist part buyers")).toBeTruthy();
    await fireEvent.click(view.getByRole("link", { name: "Repair shop interview" }));
    expect(onOpenSource).toHaveBeenCalledWith("https://example.com/interview");
  });

  test("labels an idea without factors as user-asserted", async () => {
    const idea = solution();
    idea.problemVerdict = "user-asserted";
    idea.factors = [];
    const view = render(SolutionListItem, { idea, rank: 1, onOpenSource: vi.fn() });

    await fireEvent.click(view.container.querySelector(".solution-summary") as HTMLElement);
    await fireEvent.click(view.getByText("Evidence behind this problem").closest("summary") as HTMLElement);
    expect(view.getByText("User-asserted problem")).toBeTruthy();
    expect(view.getByText("This problem was stated directly. Discovery did not gather source-backed factors for it.")).toBeTruthy();
  });
});

describe("SolutionWorkspace ordering explanation", () => {
  test("shows opportunity families only for startup opportunities", () => {
    const opportunities: OpportunityFamiliesView = {
      rawOptionCount: 1, reviewedOptionCount: 0, acceptedFamilyCount: 0,
      families: [], unresolved: [], unreviewedOptionIds: ["solution-1"],
      lastReviewedAt: null, reviewStatus: "not-reviewed", reviewError: null,
    };
    const props = {
      solutions: [{ ...solution(), workflowVersion: 2 as const }], busy: false,
      opportunities, modelOptions: [], initialConfig: DEFAULT_RUN_CONFIG,
      onReviewOpportunities: vi.fn().mockResolvedValue(undefined),
      onEditMembership: vi.fn().mockResolvedValue(undefined),
      onExport: vi.fn(), onOpenSource: vi.fn(), onReview: vi.fn(),
    };
    const practical = render(SolutionWorkspace, props);
    expect(practical.queryByText("0 accepted families")).toBeNull();
    expect(practical.queryByRole("button", { name: "Review 1 saved idea" })).toBeNull();
    expect(practical.getByText("Supplier reliability ledger")).toBeTruthy();
    practical.unmount();

    const startup = render(SolutionWorkspace, {
      ...props, initialConfig: { ...DEFAULT_RUN_CONFIG, explorationPurpose: "startup-opportunities" as const },
    });
    expect(startup.getByText("0 accepted families")).toBeTruthy();
    expect(startup.getByRole("button", { name: "Review 1 saved idea" })).toBeTruthy();
  });

  test("explains the ordering rule and names the project-ending risk filter", () => {
    const view = render(SolutionWorkspace, {
      solutions: [solution()],
      busy: false,
      onExport: vi.fn(),
      onOpenSource: vi.fn(),
      onReview: vi.fn(),
    });

    expect(view.getByText(/Solutions are not ranked/)).toBeTruthy();
    expect(view.getByRole("button", { name: "Unaddressed project-ending" })).toBeTruthy();
    expect(view.queryByText("Highest risk", { exact: true })).toBeNull();
    expect(view.queryByText(/catastrophic gaps/i)).toBeNull();
  });

  test("explains a zero-option v2 result without relying on a returned option", () => {
    const view = render(SolutionWorkspace, {
      solutions: [], workflowVersion: 2, busy: false,
      onExport: vi.fn(), onOpenSource: vi.fn(), onReview: vi.fn(),
    });

    expect(view.getByText("No solutions were returned.")).toBeTruthy();
    expect(view.getByText(/zero solutions for the selected problem/)).toBeTruthy();
    expect(view.queryByText("Highest risk")).toBeNull();
    expect(view.queryByText("Evaluation snapshot")).toBeNull();
    expect(view.queryByRole("button", { name: "Show every solution" })).toBeNull();
  });
});

describe("SolutionWorkspace idea conversation", () => {
  const modelOptions = [{
    providerId: "test", modelId: "model", displayName: "Test model", defaultReasoningEffort: "medium",
    reasoningEfforts: [{ id: "medium", description: "Standard" }],
  }];

  function conversation(): ConversationView {
    return {
      rootSolutionId: "solution-1", selectedVersionId: "solution-1",
      defaultModel: { providerId: "test", modelId: "model" },
      versions: [
        { solutionId: "solution-1", parentSolutionId: null, versionNumber: 1, evidenceSnapshotId: null,
          changeSummary: null, mechanism: "Supplier reliability ledger", description: "Original idea",
          reviewFreshness: "current", model: { providerId: "test", modelId: "model" }, reasoningEffort: "medium" },
        { solutionId: "solution-2", parentSolutionId: "solution-1", versionNumber: 2, evidenceSnapshotId: null,
          changeSummary: "Narrow the buyer", mechanism: "Buyer delivery ledger", description: "Revised idea",
          reviewFreshness: "unreviewed", model: { providerId: "test", modelId: "model" }, reasoningEffort: "medium" },
      ],
      branches: [], turns: [], nextCursor: null,
    };
  }

  test("opens a v2 idea, switches versions, sends a follow-up, and keeps an unsent draft after Escape", async () => {
    const idea = { ...solution(), workflowVersion: 2 as const };
    const onOpenConversation = vi.fn().mockResolvedValue(undefined);
    const onCloseConversation = vi.fn();
    const onSelectConversationVersion = vi.fn().mockResolvedValue(undefined);
    const onSubmitIdeaTurn = vi.fn().mockResolvedValue(undefined);
    const props = {
      solutions: [idea], busy: false, modelOptions, conversation: conversation(),
      onExport: vi.fn(), onOpenSource: vi.fn(), onReview: vi.fn(),
      onOpenConversation, onCloseConversation, onSelectConversationVersion, onSubmitIdeaTurn,
    };
    const view = render(SolutionWorkspace, props);
    const open = view.getByRole("button", { name: `Explore idea: ${idea.description}` });

    await fireEvent.click(open);
    expect(onOpenConversation).toHaveBeenCalledWith(idea.id);
    expect(view.getByRole("button", { name: "Back to solutions" })).toBeTruthy();
    expect(view.getByText("Review applies to this version")).toBeTruthy();
    await fireEvent.click(view.getByRole("button", { name: /v2 Buyer delivery ledger/ }));
    expect(onSelectConversationVersion).toHaveBeenCalledWith("solution-2");
    expect(view.getByText("This version has not been reviewed")).toBeTruthy();

    await fireEvent.input(view.getByLabelText("Follow-up message"), { target: { value: "Could this work for buyers?" } });
    await fireEvent.click(view.getByRole("button", { name: "Send follow-up" }));
    await waitFor(() => expect(onSubmitIdeaTurn).toHaveBeenCalledOnce());
    expect(onSubmitIdeaTurn.mock.calls[0]?.[0]).toMatchObject({ baseSolutionId: "solution-2", text: "Could this work for buyers?" });
    expect(props.solutions).toHaveLength(1);

    await fireEvent.input(view.getByLabelText("Follow-up message"), { target: { value: "Keep this unsent." } });
    await fireEvent.keyDown(window, { key: "Escape" });
    expect(onCloseConversation).toHaveBeenCalledOnce();
    await waitFor(() => expect(document.activeElement).toBe(open));
    await view.rerender({ ...props, conversation: null });
    await fireEvent.click(open);
    expect((view.getByLabelText("Follow-up message") as HTMLTextAreaElement).value).toBe("Keep this unsent.");
  });

  test("offers a retry when opening a conversation fails", async () => {
    const idea = { ...solution(), workflowVersion: 2 as const };
    const onOpenConversation = vi.fn().mockRejectedValueOnce(new Error("Conversation could not load.")).mockResolvedValueOnce(undefined);
    const view = render(SolutionWorkspace, {
      solutions: [idea], busy: false, modelOptions, conversation: conversation(),
      onExport: vi.fn(), onOpenSource: vi.fn(), onReview: vi.fn(),
      onOpenConversation, onSubmitIdeaTurn: vi.fn().mockResolvedValue(undefined),
    });

    await fireEvent.click(view.getByRole("button", { name: `Explore idea: ${idea.description}` }));
    expect((await view.findByRole("alert")).textContent).toContain("Conversation could not load.");
    await fireEvent.click(view.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(onOpenConversation).toHaveBeenCalledTimes(2));
    expect(view.getByLabelText("Idea versions and conversation")).toBeTruthy();
  });

  test("opens a descendant version through the root conversation", async () => {
    const idea = { ...solution(), id: "solution-2", workflowVersion: 2 as const };
    const onOpenConversation = vi.fn().mockResolvedValue(undefined);
    const view = render(SolutionWorkspace, {
      solutions: [idea], busy: false, modelOptions, conversation: conversation(),
      onExport: vi.fn(), onOpenSource: vi.fn(), onReview: vi.fn(),
      onOpenConversation, onSubmitIdeaTurn: vi.fn().mockResolvedValue(undefined),
    });

    await fireEvent.click(view.getByRole("button", { name: `Explore idea: ${idea.description}` }));
    expect(onOpenConversation).toHaveBeenCalledWith("solution-2");
    expect(view.getByLabelText("Idea versions and conversation").closest("[hidden]")).toBeNull();
    expect(view.queryByText("Conversation is unavailable.")).toBeNull();
  });

  test("does not offer new conversation controls for a legacy idea", () => {
    const view = render(SolutionWorkspace, {
      solutions: [solution()], busy: false,
      onExport: vi.fn(), onOpenSource: vi.fn(), onReview: vi.fn(),
      onOpenConversation: vi.fn().mockResolvedValue(undefined),
    });

    expect(view.queryByRole("button", { name: /Explore idea:/ })).toBeNull();
    expect(view.getByText("Supplier reliability ledger")).toBeTruthy();
  });
});

function solution(): SolutionView {
  return {
    id: "solution-1",
    problemId: "problem-1",
    problemStatement: "Repair shops cannot predict specialist part delivery times.",
    problemVerdict: "confirmed",
    factors: [
      {
        id: "factor-1",
        subject: "Specialist part buyers",
        behavior: "Call several suppliers before quoting a delivery date.",
        quote: "We call around before promising a date.",
        sourceId: "source-1",
        sourceTitle: "Repair shop interview",
        sourceUrl: "https://example.com/interview",
        harvestMode: "audience",
        modelConfidence: 0.9,
      },
    ],
    mechanism: "Supplier reliability ledger",
    description: "Pool observed delivery windows by supplier and part category.",
    respectsOffLimits: true,
    respectsOffLimitsWhy: "The idea does not hold inventory.",
    outcomes: [
      {
        id: "outcome-1",
        description: "Shops quote narrower delivery windows.",
        direction: "positive",
        affects: "Scheduling",
        addressesCore: true,
      },
    ],
    risks: [
      {
        id: "risk-2",
        description: "Shops may distrust pooled delivery data.",
        likelihood: "possible",
        impact: "~2 months",
        sortKey: 6,
        mitigations: [
          {
            id: "mitigation-1",
            approach: "Show the source and age of each observation.",
            cost: "One metadata panel",
            failsIf: "Trust still depends on relationships.",
            riskIds: ["risk-2"],
          },
        ],
      },
      {
        id: "risk-3",
        description: "Data imports may need manual cleanup.",
        likelihood: "likely",
        impact: "≤3 days lost",
        sortKey: 3,
        mitigations: [],
      },
      {
        id: "risk-1",
        description: "The only supplier can leave the market.",
        likelihood: "likely",
        impact: "project ends",
        sortKey: 9,
        mitigations: [],
      },
      {
        id: "risk-4",
        description: "A second supplier may stop covering rural areas.",
        likelihood: "possible",
        impact: "project ends",
        sortKey: 8,
        mitigations: [
          {
            id: "mitigation-2",
            approach: "Add regional suppliers before launch.",
            cost: "Two supplier integrations",
            failsIf: "No regional supplier exposes delivery data.",
            riskIds: ["risk-4"],
          },
        ],
      },
    ],
    confirmedCoreOutcomes: 1,
    unaddressedCatastrophicRisks: 1,
  };
}
