import { fireEvent, render, within } from "@testing-library/svelte";
import { describe, expect, test, vi } from "vitest";
import ProblemCheckpoint from "../../src/renderer/components/ProblemCheckpoint.svelte";
import ResearchArchive from "../../src/renderer/components/ResearchArchive.svelte";

const rejected = [{
  id: "rejected-1",
  statement: "Independent shops cannot compare supplier reliability.",
  reason: "The candidate cited factors from only one source hostname.",
}];

describe("rejected problem evidence", () => {
  test("keeps rejected candidates separate and can reuse one as a user-asserted problem", async () => {
    const view = render(ProblemCheckpoint, {
      problems: [],
      rejectedCandidates: rejected,
      busy: false,
      onCommit: vi.fn(),
      onExport: vi.fn(),
      onOpenSource: vi.fn(),
    });
    const sectionLabel = view.getByText("Failed evidence requirements");
    const details = sectionLabel.closest("details") as HTMLDetailsElement;

    expect(details.open).toBe(false);
    await fireEvent.click(sectionLabel.closest("summary") as HTMLElement);
    const rejectedCard = view.getByText(rejected[0]!.statement).closest("article") as HTMLElement;
    expect(within(rejectedCard).getByText("Not evidence-backed")).toBeTruthy();
    expect(within(rejectedCard).queryByRole("checkbox")).toBeNull();

    await fireEvent.click(within(rejectedCard).getByRole("button", { name: "Use as user-asserted problem" }));
    const textarea = view.getByRole("textbox", { name: "Or state the problem yourself." }) as HTMLTextAreaElement;
    expect(textarea.value).toBe(rejected[0]!.statement);
    expect(document.activeElement).toBe(textarea);
    expect((view.getByRole("button", { name: "Commit selection" }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("keeps rejected candidates visible in the research archive without presenting them as evidence-backed", async () => {
    const view = render(ResearchArchive, {
      problems: [],
      rejectedCandidates: rejected,
      busy: false,
      onExport: vi.fn(),
      onOpenSource: vi.fn(),
    });

    await fireEvent.click(view.getByText("Failed evidence requirements").closest("summary") as HTMLElement);
    expect(view.getByText("The research behind the ideas.")).toBeTruthy();
    expect(view.getByText("Discovery ran, but these candidates did not pass the evidence requirements. The failures remain visible below and in the research export.")).toBeTruthy();
    expect(view.queryByText(/discovery never ran/i)).toBeNull();
    const rejectedCard = view.getByText(rejected[0]!.statement).closest("article") as HTMLElement;
    expect(within(rejectedCard).getByText("Not evidence-backed")).toBeTruthy();
    expect(within(rejectedCard).getByText(rejected[0]!.reason)).toBeTruthy();
  });
});
