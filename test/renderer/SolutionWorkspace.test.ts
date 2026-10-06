import { fireEvent, render, waitFor, within } from "@testing-library/svelte";
import { describe, expect, test, vi } from "vitest";
import SolutionListItem from "../../src/renderer/components/SolutionListItem.svelte";
import SolutionWorkspace from "../../src/renderer/components/SolutionWorkspace.svelte";
import type { IdeaGroupView, SolutionView, WorkspaceState } from "../../src/shared/ipc";
import { createIdeasFixture } from "../ui/ideas-fixture";
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
  });
});

describe("SolutionWorkspace groups", () => {
  test.each(["list", "idea", "own", "sibling", "other-run", "other-version"] as const)("analysis ownership on %s", async destination => {
    const fixture = createIdeasFixture(new URLSearchParams("analysis=running"), "alpha");
    const owner = fixture.solutions[0]!;
    const other = fixture.solutions[destination === "other-run" ? 8 : 1]!;
    const own = destination === "own" || destination === "other-version";
    const selectedId = own ? owner.id : other.id;
    const saved = { ...fixture.conversation, rootSolutionId: selectedId, selectedVersionId: selectedId,
      versions: [{ ...fixture.conversation.versions[0]!, solutionId: selectedId, description: (own ? owner : other).description }] };
    if (destination === "other-version") {
      saved.selectedVersionId = "newer-version";
      saved.versions.push({ ...saved.versions[0]!, solutionId: "newer-version", parentSolutionId: owner.id, versionNumber: 2 });
    }
    Object.defineProperty(window, "scraply", { configurable: true, value: { getIdeaDetail: vi.fn(async id => fixture.solutions.find(idea => idea.id === id) ?? { ...owner, id, selected: false, decisionAnalysis: null }) } });
    const run: NonNullable<WorkspaceState["latestResearchRun"]> = { runId: owner.runId!, status: "running", stage: "evaluating-risk", problemId: owner.problemId,
      codexCalls: 1, searches: 0, projectedCodexCalls: 5, projectedSearches: 0, lastActivity: null };
    const onStop = vi.fn().mockResolvedValue(undefined);
    const route = destination === "list" ? { kind: "list" as const } : destination === "idea" ? { kind: "idea" as const, ideaId: other.id }
      : { kind: "conversation" as const, ideaId: selectedId };
    const view = render(SolutionWorkspace, { solutions: fixture.solutions, busy: false, route, conversation: saved,
      modelOptions: [], run, onStop, onSelect: vi.fn(), onSubmitIdeaTurn: vi.fn(), onExport: vi.fn(), onOpenSource: vi.fn() });
    const progress = await view.findByRole("status", { name: "Active idea work" });
    expect(view.getAllByRole("status", { name: "Active idea work" })).toHaveLength(1);
    expect(!!progress.closest(".conversation-panel")).toBe(destination === "own");
    expect(progress.textContent?.includes("History access and provenance pack")).toBe(destination !== "own");
    if (route.kind === "conversation") {
      await waitFor(() => expect((view.getByRole("button", { name: "Analyze risks" }) as HTMLButtonElement).disabled).toBe(true));
      expect((view.getByRole("button", { name: "Explain" }) as HTMLButtonElement).disabled).toBe(true);
      expect((view.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
      expect(view.queryByRole("heading", { name: "Risk analysis" })).toBeNull();
      expect(view.container.querySelector(".analysis-error")).toBeNull();
    }
    await fireEvent.click(within(progress).getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledWith(owner.runId);
  });

  test("numbers ideas per problem, separates both saved name formats, and opens the selected row", async () => {
    const ideas = [
      { ...solution(), id: "old", description: "History pack. Share approved consumption records." },
      { ...solution(), id: "new", description: "Weekend log: Record Friday shutdowns." },
      { ...solution(), id: "other", problemId: "other", description: "Closure rota." },
    ];
    const view = render(SolutionWorkspace, { solutions: ideas, busy: false, onExport: vi.fn(), onOpenSource: vi.fn() });
    const rows = view.getAllByRole("button", { name: /^Open idea:/ });
    expect(rows.map(row => row.textContent?.trim())).toEqual([
      "1. History packShare approved consumption records.", "2. Weekend logRecord Friday shutdowns.", "1. Closure rota",
    ]);
    await fireEvent.click(rows[0]!);
    expect(view.getByRole("heading", { level: 1, name: "History pack" })).toBeTruthy();
    expect(within(view.container.querySelector(".idea-detail") as HTMLElement).getByText("Share approved consumption records.")).toBeTruthy();
    await fireEvent.click(view.getByRole("button", { name: "Back to ideas" }));
    expect(view.getAllByRole("button", { name: /^Open idea:/ })).toHaveLength(3);
  });
  const actions = { busy: false, onExport: vi.fn(), onOpenSource: vi.fn() };
  const savedGroup = (problemId: string, requestedIdeaCount: number, returnedIdeaCount: number): IdeaGroupView => ({
    runId: `run-${problemId}`, problemId, problemStatement: `Problem ${problemId}`, requestedIdeaCount, returnedIdeaCount,
  });
  const rankedIdea = (problemId: string, rank: number): SolutionView => ({ ...solution(), id: `${problemId}-${rank}`,
    runId: `run-${problemId}`, problemId, problemStatement: `Problem ${problemId}`, workflowVersion: 2, rank,
    description: `Idea ${problemId}-${rank}: an explanation.`,
  });

  test("shows the saved writer's short count beside its problem and keeps every ranked idea", async () => {
    const ideas = [rankedIdea("short", 2), rankedIdea("complete", 1), rankedIdea("short", 1)];
    ideas[0]!.reviewStatus = "duplicate";
    const props = { ...actions, solutions: ideas, ideaGroups: [savedGroup("short", 3, 2), savedGroup("complete", 1, 1)],
      initialConfig: { ...DEFAULT_RUN_CONFIG, ideaCount: 5 } };
    const view = render(SolutionWorkspace, props);
    const short = view.getByText("2 of 3 ideas returned").closest("details") as HTMLDetailsElement;
    expect(short.open).toBe(true);
    expect(short.querySelector("summary")?.textContent).toContain("Problem short");
    expect([...short.querySelectorAll(".idea-name")].map((row) => row.textContent)).toEqual(["Idea short-1", "Idea short-2"]);
    expect(view.queryByText("1 of 1 idea returned")).toBeNull();
    expect(view.getByRole("heading", { name: "3 ideas" })).toBeTruthy();

    await view.rerender({ ...props, initialConfig: { ...DEFAULT_RUN_CONFIG, ideaCount: 1 } });
    expect(view.getByText("2 of 3 ideas returned")).toBeTruthy();
    await fireEvent.click(within(short).getByRole("button", { name: "Open idea: Idea short-2" }));
    expect(view.getByRole("heading", { name: "Idea short-2" })).toBeTruthy();
    await fireEvent.click(view.getByRole("button", { name: "Back to ideas" }));
    expect(view.getByText("2 of 3 ideas returned")).toBeTruthy();
  });

  test("retains zero-return groups alongside complete and older saved groups", () => {
    const legacy = { ...solution(), id: "legacy", problemId: "legacy", problemStatement: "Legacy problem", runId: "legacy-run" };
    const view = render(SolutionWorkspace, { ...actions,
      solutions: [rankedIdea("complete", 1), legacy], ideaGroups: [savedGroup("complete", 1, 1), savedGroup("empty", 3, 0)],
      initialConfig: { ...DEFAULT_RUN_CONFIG, ideaCount: 5 },
    });
    expect(view.container.querySelectorAll("details.problem-group")).toHaveLength(3);
    const empty = view.getByText("0 of 3 ideas returned").closest("details") as HTMLDetailsElement;
    expect(empty.querySelector("summary")?.textContent).toContain("Problem empty");
    expect(empty.querySelectorAll(".idea-row")).toHaveLength(0);
    expect(view.container.querySelectorAll(".return-count")).toHaveLength(1);
    expect(view.getByRole("heading", { name: "2 ideas" })).toBeTruthy();
  });

  test("keeps a source run's short count separate from other saved runs for the same problem", () => {
    const older = { ...rankedIdea("shared", 3), runId: "older-run" };
    const view = render(SolutionWorkspace, { ...actions,
      solutions: [rankedIdea("shared", 1), rankedIdea("shared", 2), older],
      ideaGroups: [savedGroup("shared", 3, 2), { ...savedGroup("shared", 5, 5), runId: "older-run" }],
    });
    expect(view.getByText("One run returned 2 of 3 ideas")).toBeTruthy();
    expect(view.container.querySelectorAll("details.problem-group")).toHaveLength(1);
    expect(view.getAllByRole("button", { name: /^Open idea:/ })).toHaveLength(3);
    expect(view.container.querySelectorAll(".return-count")).toHaveLength(1);
  });

  test("opens an all-zero saved result without inventing ideas", () => {
    const view = render(SolutionWorkspace, { ...actions, solutions: [], workflowVersion: 2,
      ideaGroups: [savedGroup("empty", 3, 0), savedGroup("another", 1, 0)],
    });
    expect(view.getByText("0 of 3 ideas returned")).toBeTruthy();
    expect(view.getByText("0 of 1 idea returned")).toBeTruthy();
    expect(view.getByRole("heading", { name: "0 ideas" })).toBeTruthy();
    expect(view.container.querySelectorAll(".idea-row")).toHaveLength(0);
  });

  test("uses saved returned counts for a filtered history and excludes metadata for unseen nonempty runs", () => {
    const view = render(SolutionWorkspace, { ...actions, solutions: [rankedIdea("complete", 2)],
      ideaGroups: [savedGroup("complete", 3, 3), savedGroup("unseen", 3, 2)],
    });
    expect(view.container.querySelectorAll("details.problem-group")).toHaveLength(1);
    expect(view.container.querySelectorAll(".return-count")).toHaveLength(0);
    expect(view.queryByText("Problem unseen")).toBeNull();
  });

  test("shows one open group per problem with each idea's short name, best first, and marks weak fits", async () => {
    const idea = (id: string, problemId: string, rank: number, name: string, weakFitReason: string | null = null) => ({ ...solution(), id, problemId,
      problemStatement: `Problem ${problemId}`, workflowVersion: 2 as const, rank, rankReason: `Reason ${rank}`, weakFitReason,
      mechanism: "Collect exports, then compare them line by line.", description: `${name}: a longer explanation of the idea.` });
    const view = render(SolutionWorkspace, { solutions: [
      idea("a3", "a", 3, "Shared checklist", 'fails "Fits a solo founder": needs a sales team'),
      idea("a1", "a", 1, "History access pack"), idea("b1", "b", 1, "Weekend baseline alert"), idea("a2", "a", 2, "Savings checker"),
    ], busy: false, onExport: vi.fn(), onOpenSource: vi.fn() });

    expect(view.getByRole("heading", { level: 1, name: "4 ideas" })).toBeTruthy();
    const groups = [...view.container.querySelectorAll("details.problem-group")] as HTMLDetailsElement[];
    expect(groups.map((group) => [group.querySelector("summary")?.textContent?.trim(), group.open])).toEqual([["Problem: Problem a", true], ["Problem: Problem b", true]]);
    expect([...groups[0]!.querySelectorAll(".idea-name")].map((row) => row.textContent)).toEqual(["History access pack", "Savings checker", "Shared checklist"]);
    const weak = within(groups[0]!).getByRole("button", { name: "Open idea: Shared checklist" });
    expect(within(weak).getByText("Weak fit")).toBeTruthy();
    expect(view.getAllByText("Weak fit")).toHaveLength(1);
    for (const gone of [/Discard/, /^Open idea$/, /Meets all must-haves/, /Criteria fit not assessed/, /Full explanation inside/, /saved order/]) {
      expect(view.queryByText(gone)).toBeNull();
    }

    await fireEvent.click(weak);
    expect(view.getByRole("heading", { level: 1, name: "Shared checklist" })).toBeTruthy();
    expect(view.getByText('fails "Fits a solo founder": needs a sales team')).toBeTruthy();
    expect(view.queryByText(/Ranked 3 for/)).toBeNull();
  });

  test("an older idea without a short name or rank keeps its saved order and shows its first sentence", () => {
    const first = { ...solution(), id: "first", description: "Pool delivery windows by supplier. Shops then compare them." };
    const second = { ...solution(), id: "second", description: "Call suppliers before quoting." };
    const view = render(SolutionWorkspace, { solutions: [first, second], busy: false, onExport: vi.fn(), onOpenSource: vi.fn() });
    expect([...view.container.querySelectorAll(".idea-name")].map((row) => row.textContent)).toEqual(["Pool delivery windows by supplier", "Call suppliers before quoting"]);
  });

  test("keeps business grouping and exports below the groups", async () => {
    const opportunities: OpportunityFamiliesView = {
      rawOptionCount: 1, reviewedOptionCount: 0, acceptedFamilyCount: 0,
      families: [], unresolved: [], unreviewedOptionIds: ["solution-1"],
      lastReviewedAt: null, reviewStatus: "not-reviewed", reviewError: null,
    };
    const onExport = vi.fn();
    const view = render(SolutionWorkspace, {
      solutions: [{ ...solution(), workflowVersion: 2 as const }], busy: false,
      opportunities, modelOptions: [], initialConfig: DEFAULT_RUN_CONFIG,
      onReviewOpportunities: vi.fn().mockResolvedValue(undefined), onEditMembership: vi.fn().mockResolvedValue(undefined),
      onExport, onOpenSource: vi.fn(),
    });
    await fireEvent.click(view.getByText(/Review idea grouping/));
    expect(view.getByRole("button", { name: "Review 1 saved idea" })).toBeTruthy();
    await fireEvent.click(view.getByRole("button", { name: "Export JSON" }));
    expect(onExport).toHaveBeenCalledWith("json");
  });

  test("ranked ideas skip the business grouping review", () => {
    const opportunities: OpportunityFamiliesView = {
      rawOptionCount: 1, reviewedOptionCount: 0, acceptedFamilyCount: 0, families: [], unresolved: [], unreviewedOptionIds: ["solution-1"],
      lastReviewedAt: null, reviewStatus: "not-reviewed", reviewError: null,
    };
    const view = render(SolutionWorkspace, {
      solutions: [{ ...solution(), workflowVersion: 2 as const, rank: 1, rankReason: "Best", weakFitReason: null }], busy: false,
      opportunities, modelOptions: [], initialConfig: { ...DEFAULT_RUN_CONFIG, explorationPurpose: "startup-opportunities" },
      onReviewOpportunities: vi.fn(), onEditMembership: vi.fn(), onExport: vi.fn(), onOpenSource: vi.fn(),
    });
    expect(view.queryByText(/Review idea grouping/)).toBeNull();
  });

  test("says when a run returned no ideas", () => {
    const view = render(SolutionWorkspace, {
      solutions: [], workflowVersion: 2, busy: false,
      onExport: vi.fn(), onOpenSource: vi.fn(),
    });
    expect(view.getByText("No ideas were returned.")).toBeTruthy();
    expect(view.getByRole("heading", { level: 1, name: "0 ideas" })).toBeTruthy();
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
      onExport: vi.fn(), onOpenSource: vi.fn(),
      onOpenConversation, onCloseConversation, onSelectConversationVersion, onSubmitIdeaTurn,
    };
    const view = render(SolutionWorkspace, props);
    await fireEvent.click(view.getByRole("button", { name: `Open idea: ${idea.description.replace(/[.!?]+$/, "")}` }));
    const open = view.getByRole("button", { name: "Explore this idea" });
    await fireEvent.click(open);
    expect(onOpenConversation).toHaveBeenCalledWith(idea.id);
    expect(view.getByRole("button", { name: "Back to idea" })).toBeTruthy();
    expect(view.queryByText("Review applies to this version")).toBeNull();
    await fireEvent.click(view.getByRole("button", { name: /v2 Revised idea/ }));
    expect(onSelectConversationVersion).toHaveBeenCalledWith("solution-2");
    expect(view.queryByText("This version has not been reviewed")).toBeNull();

    await fireEvent.input(view.getByLabelText("Follow-up message"), { target: { value: "Could this work for buyers?" } });
    await fireEvent.click(view.getByRole("button", { name: "Send" }));
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

  test("renders the App-owned route and retains the conversation draft through parent navigation", async () => {
    const idea = { ...solution(), workflowVersion: 2 as const };
    const onNavigate = vi.fn();
    const onBack = vi.fn();
    const props = { solutions: [idea], busy: false, modelOptions, conversation: conversation(),
      onExport: vi.fn(), onOpenSource: vi.fn(), onNavigate, onBack, onSubmitIdeaTurn: vi.fn() };
    const view = render(SolutionWorkspace, { ...props, route: { kind: "list" } });
    await fireEvent.click(view.getByRole("button", { name: `Open idea: ${idea.description.replace(/[.!?]+$/, "")}` }));
    expect(onNavigate).toHaveBeenCalledWith({ kind: "idea", ideaId: idea.id });
    await view.rerender({ ...props, route: { kind: "idea", ideaId: idea.id } });
    await fireEvent.click(view.getByRole("button", { name: "Explore this idea" }));
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "conversation", ideaId: idea.id });
    await view.rerender({ ...props, route: { kind: "conversation", ideaId: idea.id } });
    const input = view.getByLabelText("Follow-up message") as HTMLTextAreaElement;
    await fireEvent.input(input, { target: { value: "Unsent reply" } });
    await fireEvent.click(view.getByRole("button", { name: "Back to idea" }));
    expect(onBack).toHaveBeenCalledWith({ kind: "idea", ideaId: idea.id });
    await view.rerender({ ...props, route: { kind: "idea", ideaId: idea.id } });
    await view.rerender({ ...props, route: { kind: "conversation", ideaId: idea.id } });
    expect(view.getByLabelText("Follow-up message")).toBe(input);
    expect(input.value).toBe("Unsent reply");
    await view.rerender({ ...props, route: { kind: "idea", ideaId: idea.id } });
    await fireEvent.keyDown(window, { key: "Escape" });
    expect(onBack).toHaveBeenLastCalledWith({ kind: "list" });
  });

  test("keeps revised versions in the conversation and returns through Back", async () => {
    const root = { ...solution(), workflowVersion: 2 as const };
    const revised = { ...root, id: "solution-2", mechanism: "Buyer delivery ledger",
      description: "Revised idea", keyAssumption: "Buyers will share delivery observations." };
    Object.defineProperty(window, "scraply", { configurable: true,
      value: { getIdeaDetail: vi.fn().mockResolvedValue(revised) } });
    const view = render(SolutionWorkspace, {
      solutions: [root], busy: false, modelOptions, conversation: conversation(),
      onExport: vi.fn(), onOpenSource: vi.fn(),
      onSelect: vi.fn(), onSave: vi.fn(),
      onOpenConversation: vi.fn().mockResolvedValue(undefined),
      onSubmitIdeaTurn: vi.fn().mockResolvedValue(undefined),
      onSelectConversationVersion: vi.fn().mockResolvedValue(undefined),
    });
    await fireEvent.click(view.getByRole("button", { name: `Open idea: ${root.description.replace(/[.!?]+$/, "")}` }));
    await fireEvent.click(view.getByRole("button", { name: "Explore this idea" }));
    await fireEvent.click(view.getByRole("button", { name: /v2 Revised idea/ }));
    expect(view.queryByRole("button", { name: "View full idea details" })).toBeNull();
    expect(view.getByRole("heading", { name: "Revised idea" })).toBeTruthy();
    await fireEvent.click(view.getByRole("button", { name: "Back to idea" }));
    expect(view.getByRole("heading", { level: 1 })).toBeTruthy();
  });

  test("offers a retry when opening a conversation fails", async () => {
    const idea = { ...solution(), workflowVersion: 2 as const };
    const onOpenConversation = vi.fn().mockRejectedValueOnce(new Error("Conversation could not load.")).mockResolvedValueOnce(undefined);
    const view = render(SolutionWorkspace, {
      solutions: [idea], busy: false, modelOptions, conversation: conversation(),
      onExport: vi.fn(), onOpenSource: vi.fn(),
      onOpenConversation, onSubmitIdeaTurn: vi.fn().mockResolvedValue(undefined),
    });

    await fireEvent.click(view.getByRole("button", { name: `Open idea: ${idea.description.replace(/[.!?]+$/, "")}` }));
    await fireEvent.click(view.getByRole("button", { name: "Explore this idea" }));
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
      onExport: vi.fn(), onOpenSource: vi.fn(),
      onOpenConversation, onSubmitIdeaTurn: vi.fn().mockResolvedValue(undefined),
    });

    await fireEvent.click(view.getByRole("button", { name: `Open idea: ${idea.description.replace(/[.!?]+$/, "")}` }));
    await fireEvent.click(view.getByRole("button", { name: "Explore this idea" }));
    expect(onOpenConversation).toHaveBeenCalledWith("solution-2");
    expect(view.getByLabelText("Idea versions and conversation").closest("[hidden]")).toBeNull();
    expect(view.queryByText("Conversation is unavailable.")).toBeNull();
  });

  test("does not offer new conversation controls for a legacy idea", () => {
    const view = render(SolutionWorkspace, {
      solutions: [solution()], busy: false,
      onExport: vi.fn(), onOpenSource: vi.fn(),
      onOpenConversation: vi.fn().mockResolvedValue(undefined),
    });

    expect(view.queryByRole("button", { name: /Explore idea:/ })).toBeNull();
    expect(view.getByText("Pool observed delivery windows by supplier and part category")).toBeTruthy();
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
