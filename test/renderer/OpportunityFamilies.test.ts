import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { describe, expect, test, vi } from "vitest";
import OpportunityFamilies from "../../src/renderer/components/OpportunityFamilies.svelte";
import type { OpportunityFamiliesView } from "../../src/shared/opportunity-review";
import { DEFAULT_RUN_CONFIG, type ModelOption } from "../../src/shared/schemas";

const model: ModelOption = {
  providerId: "openai-subscription",
  modelId: "gpt-5.6-sol",
  displayName: "GPT-5.6 Sol",
  defaultReasoningEffort: "medium",
  reasoningEfforts: [
    { id: "low", description: "Fast" },
    { id: "medium", description: "Balanced" },
    { id: "high", description: "Deep" },
  ],
};

describe("OpportunityFamilies", () => {
  test("uses the singular review label for one saved idea", () => {
    const opportunities = {
      ...unreviewedView(),
      rawOptionCount: 1,
      unreviewedOptionIds: ["option-1"],
    };
    const view = render(OpportunityFamilies, {
      opportunities,
      modelOptions: [model],
      initialConfig: DEFAULT_RUN_CONFIG,
      busy: false,
      onReview: vi.fn().mockResolvedValue(undefined),
      onEdit: vi.fn().mockResolvedValue(undefined),
    });

    expect(view.getByRole("button", { name: "Review 1 saved idea" })).toBeTruthy();
  });

  test("enables review when model options arrive after the component mounts", async () => {
    const onReview = vi.fn().mockResolvedValue(undefined);
    const onEdit = vi.fn().mockResolvedValue(undefined);
    const view = render(OpportunityFamilies, {
      opportunities: unreviewedView(),
      modelOptions: [],
      initialConfig: DEFAULT_RUN_CONFIG,
      busy: false,
      onReview,
      onEdit,
    });

    const review = view.getByRole("button", { name: "Review 2 saved ideas" }) as HTMLButtonElement;
    expect(review.disabled).toBe(true);

    await view.rerender({
      opportunities: unreviewedView(),
      modelOptions: [model],
      initialConfig: DEFAULT_RUN_CONFIG,
      busy: false,
      onReview,
      onEdit,
    });
    await waitFor(() => expect(review.disabled).toBe(false));
    expect((view.getByLabelText("Opportunity review model") as HTMLSelectElement).value)
      .toBe("openai-subscription:gpt-5.6-sol");

    await fireEvent.click(review);
    expect(onReview).toHaveBeenCalledWith(
      { providerId: "openai-subscription", modelId: "gpt-5.6-sol" },
      "medium",
      false,
    );
  });

  test("shows duplicate membership and requires a reason before a reversible edit", async () => {
    const onEdit = vi.fn().mockResolvedValue(undefined);
    const view = render(OpportunityFamilies, {
      opportunities: reviewedView(),
      modelOptions: [model],
      initialConfig: DEFAULT_RUN_CONFIG,
      busy: false,
      onReview: vi.fn().mockResolvedValue(undefined),
      onEdit,
    });

    expect(view.getByText("1 accepted family")).toBeTruthy();
    expect(view.getByText("duplicate · discarded")).toBeTruthy();
    const markUncertain = view.getByRole("button", { name: "Mark uncertain" }) as HTMLButtonElement;
    expect(markUncertain.disabled).toBe(true);

    await fireEvent.input(view.getByLabelText("Reason for a grouping change"), {
      target: { value: "The buying trigger may be different." },
    });
    expect(markUncertain.disabled).toBe(false);
    await fireEvent.click(markUncertain);
    expect(onEdit).toHaveBeenCalledWith({
      operation: "mark-uncertain",
      optionId: "option-2",
      reason: "The buying trigger may be different.",
    });
  });

  test("labels an acknowledged retry before it can spend another model call", async () => {
    const onReview = vi.fn().mockResolvedValue(undefined);
    const opportunities = {
      ...unreviewedView(),
      reviewStatus: "blocked" as const,
      reviewError: "A previous opportunity review may have completed before its result was saved.",
    };
    const view = render(OpportunityFamilies, {
      opportunities,
      modelOptions: [model],
      initialConfig: DEFAULT_RUN_CONFIG,
      busy: false,
      onReview,
      onEdit: vi.fn().mockResolvedValue(undefined),
    });

    expect(view.getByText(/another paid model call/)).toBeTruthy();
    const retry = view.getByRole("button", { name: "Start a new review" });
    await fireEvent.click(retry);
    expect(onReview).toHaveBeenCalledWith(
      { providerId: "openai-subscription", modelId: "gpt-5.6-sol" },
      "medium",
      true,
    );
  });
});

function unreviewedView(): OpportunityFamiliesView {
  return {
    rawOptionCount: 2,
    reviewedOptionCount: 0,
    acceptedFamilyCount: 0,
    families: [],
    unresolved: [],
    unreviewedOptionIds: ["option-1", "option-2"],
    lastReviewedAt: null,
    reviewStatus: "not-reviewed",
    reviewError: null,
  };
}

function reviewedView(): OpportunityFamiliesView {
  return {
    rawOptionCount: 2,
    reviewedOptionCount: 2,
    acceptedFamilyCount: 1,
    families: [{
      id: "family-1",
      title: "Enrollment exceptions",
      summary: "Resolve paid cohort access exceptions.",
      representativeOptionId: "option-1",
      active: true,
      createdAt: "2026-09-19T10:00:00.000Z",
      counted: true,
      members: [{
        decisionId: "decision-1",
        optionId: "option-2",
        familyId: "family-1",
        relationship: "duplicate",
        state: "accepted",
        reason: "It addresses the same purchase and workflow.",
        decidedBy: "model",
        decidedAt: "2026-09-19T10:00:00.000Z",
        mechanism: "Cohort transfer desk",
        description: "Handle transfers between paid cohorts.",
        eligibleStartup: true,
        discarded: true,
      }],
    }],
    unresolved: [],
    unreviewedOptionIds: [],
    lastReviewedAt: "2026-09-19T10:00:00.000Z",
    reviewStatus: "completed",
    reviewError: null,
  };
}
