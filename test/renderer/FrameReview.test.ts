import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import FrameReview from "../../src/renderer/components/FrameReview.svelte";
import { ResearchFrameSchema, type ResearchFrame } from "../../src/shared/research-frame";

function frame(): ResearchFrame {
  return {
    version: 1,
    goal: "Find a useful workflow for freelance bookkeepers.", goalKind: "market-opportunity",
    contextFacts: [
      { fact: "Platforms have matching rules.", sourceIds: ["source-1"] },
      { fact: "Some add-ons charge per client.", sourceIds: ["source-2"] },
    ],
    successCriteria: [{ id: "criterion-1", name: "Observed pain", weight: "must", howJudged: "Find firsthand accounts.", basis: "brief" }],
    constraints: [{ text: "A solo developer can build it.", kind: "team", basis: "brief" }],
    languages: ["en", "de"],
    areas: [
      {
        id: "area-1", name: "Bank matching", whyRelevant: "Avoid repeated work.", affectedPeople: "Freelance bookkeepers",
        venues: [{ name: "Bookkeeping forum", domain: "example.org", kind: "community" }],
        exampleProblems: ["Rules fail when descriptions change."], included: true, priority: 1,
      },
      {
        id: "area-2", name: "Client documents", whyRelevant: "Reduce missing documents.", affectedPeople: "Small accounting firms",
        venues: [{ name: "Practice forum", kind: "community" }], exampleProblems: [], included: true, priority: 2,
      },
    ],
    exclusions: ["Full accounting suites"],
    openQuestions: [{ id: "question-1", question: "Solo freelancers or small firms?", whyItMatters: "Changes who to research.", options: ["Solo freelancers", "Small firms"] }],
  };
}

function props(initialFrame = frame()) {
  return {
    frame: initialFrame,
    sources: [{ id: "source-1", title: "Matching documentation", url: "https://example.org/rules" }],
    onCommit: vi.fn().mockResolvedValue(undefined),
    onRegenerate: vi.fn().mockResolvedValue(undefined),
    onEditBrief: vi.fn().mockResolvedValue(undefined),
    onOpenSource: vi.fn().mockResolvedValue(undefined),
  };
}

describe("FrameReview", () => {
  test("keeps unsaved edits through unchanged polling and replaces them with a regenerated frame", async () => {
    const input = props();
    const view = render(FrameReview, input);
    await fireEvent.input(view.getByLabelText("Goal"), { target: { value: "Keep my draft while reviewing." } });
    await fireEvent.click(view.getByRole("button", { name: "Solo freelancers" }));
    await fireEvent.input(view.getByLabelText("Solo freelancers or small firms?"), { target: { value: "" } });
    await fireEvent.click(view.getAllByText("Edit area")[0]!);
    await fireEvent.input(view.getByLabelText("Venue domain 1.1"), { target: { value: "" } });

    await view.rerender({ ...input, frame: structuredClone(input.frame) });
    expect((view.getByLabelText("Goal") as HTMLTextAreaElement).value).toBe("Keep my draft while reviewing.");
    await fireEvent.click(view.getByRole("button", { name: "Start research with this frame" }));
    const expected = structuredClone(input.frame);
    expected.goal = "Keep my draft while reviewing.";
    delete expected.areas[0]!.venues[0]!.domain;
    await waitFor(() => expect(input.onCommit).toHaveBeenCalledWith(expected));

    const regenerated = { ...input.frame, goal: "A regenerated research goal." };
    await view.rerender({ ...input, frame: regenerated });
    await waitFor(() => expect((view.getByLabelText("Goal") as HTMLTextAreaElement).value).toBe(regenerated.goal));
  });

  test("submits exactly the edited frame without changing the supplied frame", async () => {
    const input = props();
    const original = structuredClone(input.frame);
    const view = render(FrameReview, input);
    await fireEvent.input(view.getByLabelText("Goal"), { target: { value: "Find a product for solo bookkeepers." } });
    await fireEvent.input(view.getByLabelText("Criterion name 1"), { target: { value: "Repeated firsthand pain" } });
    await fireEvent.change(view.getByLabelText("Criterion weight 1"), { target: { value: "high" } });
    await fireEvent.input(view.getByLabelText("How to judge criterion 1"), { target: { value: "Two independent accounts." } });
    await fireEvent.click(view.getByRole("button", { name: "Remove context fact 2" }));
    await fireEvent.click(view.getByRole("button", { name: "Solo freelancers" }));
    await fireEvent.click(view.getAllByText("Edit area")[0]!);
    await fireEvent.input(view.getByLabelText("Affected people 1"), { target: { value: "Solo bookkeepers with 20 clients" } });
    await fireEvent.input(view.getByLabelText("Venue name 1.1"), { target: { value: "Tool issue tracker" } });
    await fireEvent.change(view.getByLabelText("Venue kind 1.1"), { target: { value: "issue-tracker" } });
    await fireEvent.input(view.getByLabelText("Venue domain 1.1"), { target: { value: "github.com" } });
    await fireEvent.click(view.getByLabelText("Include Client documents"));
    await fireEvent.click(view.getByRole("button", { name: "Move Client documents up" }));
    await fireEvent.click(view.getByRole("button", { name: "Remove German" }));
    await fireEvent.input(view.getByLabelText("Language code"), { target: { value: "UK" } });
    await fireEvent.click(view.getByRole("button", { name: "Add language" }));
    await fireEvent.click(view.getByRole("button", { name: "Start research with this frame" }));
    await waitFor(() => expect(input.onCommit).toHaveBeenCalledOnce());

    const expected = frame();
    expected.goal = "Find a product for solo bookkeepers.";
    expected.successCriteria[0] = { ...expected.successCriteria[0]!, name: "Repeated firsthand pain", weight: "high", howJudged: "Two independent accounts." };
    expected.contextFacts.pop();
    expected.openQuestions[0]!.answer = "Solo freelancers";
    expected.areas[0]!.affectedPeople = "Solo bookkeepers with 20 clients";
    expected.areas[0]!.venues = [{ name: "Tool issue tracker", kind: "issue-tracker", domain: "github.com" }];
    expected.areas[1]!.included = false;
    expected.areas.reverse();
    expected.areas.forEach((area, index) => area.priority = index + 1);
    expected.languages = ["en", "uk"];
    expect(input.onCommit).toHaveBeenCalledWith(expected);
    expect(input.frame).toEqual(original);
    expect(input.onRegenerate).not.toHaveBeenCalled();
  });

  test("lets the user add an area and includes its people and venue in the submitted frame", async () => {
    const input = props();
    const view = render(FrameReview, input);
    await fireEvent.click(view.getByRole("button", { name: "Add your own area" }));
    await fireEvent.input(view.getByLabelText("Area name 3"), { target: { value: "Month-end close" } });
    expect((view.getByLabelText("Area name 3").closest("details") as HTMLDetailsElement).open).toBe(true);
    await fireEvent.input(view.getByLabelText("Area relevance 3"), { target: { value: "Close clients' books sooner." } });
    await fireEvent.input(view.getByLabelText("Affected people 3"), { target: { value: "Solo bookkeepers" } });
    await fireEvent.input(view.getByLabelText("Venue name 3.1"), { target: { value: "Accounting community" } });
    await fireEvent.click(view.getByRole("button", { name: "Start research with this frame" }));
    await waitFor(() => expect(input.onCommit).toHaveBeenCalledOnce());
    const submitted = ResearchFrameSchema.parse(input.onCommit.mock.calls[0]?.[0]);
    expect(submitted.areas[2]).toEqual({
      id: expect.any(String), name: "Month-end close", whyRelevant: "Close clients' books sooner.",
      affectedPeople: "Solo bookkeepers", venues: [{ name: "Accounting community", kind: "community" }],
      included: true, priority: 3, exampleProblems: [],
    });
    expect(input.frame.areas).toHaveLength(2);
  });

  test("keeps English, rejects invalid language codes, and caps the frame at three languages", async () => {
    const input = props();
    const view = render(FrameReview, input);
    expect(view.queryByRole("button", { name: "Remove English" })).toBeNull();
    await fireEvent.input(view.getByLabelText("Language code"), { target: { value: "zz" } });
    await fireEvent.click(view.getByRole("button", { name: "Add language" }));
    expect(view.getByRole("alert").textContent).toContain("ISO 639-1");
    await fireEvent.input(view.getByLabelText("Language code"), { target: { value: "uk" } });
    await fireEvent.click(view.getByRole("button", { name: "Add language" }));
    expect((view.getByLabelText("Language code") as HTMLInputElement).disabled).toBe(true);
    await fireEvent.click(view.getByRole("button", { name: "Start research with this frame" }));
    await waitFor(() => expect(input.onCommit).toHaveBeenCalledWith({ ...input.frame, languages: ["en", "de", "uk"] }));
  });

  test("requires a usable frame and at least one included discovery area", async () => {
    const input = props();
    const view = render(FrameReview, input);
    await fireEvent.input(view.getByLabelText("Goal"), { target: { value: "" } });
    await fireEvent.click(view.getByRole("button", { name: "Start research with this frame" }));
    expect(input.onCommit).not.toHaveBeenCalled();
    expect(view.getByRole("alert").textContent).toContain("Goal");
    await fireEvent.input(view.getByLabelText("Goal"), { target: { value: input.frame.goal } });
    await fireEvent.click(view.getByLabelText("Include Bank matching"));
    await fireEvent.click(view.getByLabelText("Include Client documents"));
    await fireEvent.click(view.getByRole("button", { name: "Start research with this frame" }));
    expect(view.getByRole("alert").textContent).toBe("Include at least one area before starting research.");
    expect(input.onCommit).not.toHaveBeenCalled();
  });

  test("submits a known-problem frame without areas and keeps unanswered questions", async () => {
    const initial = frame();
    initial.areas = [];
    const input = props(initial);
    const view = render(FrameReview, { ...input, purpose: "known-problem" });
    expect(view.queryByRole("button", { name: "Add your own area" })).toBeNull();
    await fireEvent.click(view.getByRole("button", { name: "Continue with this frame" }));
    await waitFor(() => expect(input.onCommit).toHaveBeenCalledWith(initial));
  });

  test("regenerates with the edited frame, explains exhausted allowance, and opens the brief", async () => {
    const input = props();
    const view = render(FrameReview, input);
    await fireEvent.input(view.getByLabelText("Goal"), { target: { value: "Research the month-end workflow." } });
    await fireEvent.click(view.getByRole("button", { name: "Regenerate frame (1 call)" }));
    await waitFor(() => expect(input.onRegenerate).toHaveBeenCalledWith({ ...input.frame, goal: "Research the month-end workflow." }));
    await fireEvent.click(view.getByRole("button", { name: "Edit brief" }));
    await waitFor(() => expect(input.onEditBrief).toHaveBeenCalledOnce());
    await view.rerender({ ...input, canRegenerate: false });
    expect((view.getByRole("button", { name: "Regenerate frame (1 call)" }) as HTMLButtonElement).disabled).toBe(true);
    expect(view.getByText("No model-call allowance remains for regeneration.")).toBeTruthy();
    expect(input.onCommit).not.toHaveBeenCalled();
  });

  test("shows a save failure and lets the user retry without losing edits", async () => {
    const input = props();
    input.onCommit.mockRejectedValueOnce(new Error("The run changed. Reload its frame."));
    const view = render(FrameReview, input);
    await fireEvent.input(view.getByLabelText("Goal"), { target: { value: "Keep this edited goal." } });
    await fireEvent.click(view.getByRole("button", { name: "Start research with this frame" }));
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("The run changed"));
    expect((view.getByLabelText("Goal") as HTMLTextAreaElement).value).toBe("Keep this edited goal.");
    await fireEvent.click(view.getByRole("button", { name: "Start research with this frame" }));
    await waitFor(() => expect(input.onCommit).toHaveBeenCalledTimes(2));
    expect(input.onCommit).toHaveBeenLastCalledWith({ ...input.frame, goal: "Keep this edited goal." });
  });
});
