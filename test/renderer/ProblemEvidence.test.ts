import { fireEvent, render, within } from "@testing-library/svelte";
import { describe, expect, test, vi } from "vitest";
import ProblemCheckpoint from "../../src/renderer/components/ProblemCheckpoint.svelte";
import ResearchArchive from "../../src/renderer/components/ResearchArchive.svelte";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";

const modelOptions = [{
  ...DEFAULT_RUN_CONFIG.model,
  displayName: "GPT-5.6 Sol",
  defaultReasoningEffort: "medium",
  reasoningEfforts: [{ id: "low", description: "Fast" }, { id: "medium", description: "Balanced" }],
}, {
  providerId: "openai-subscription",
  modelId: "gpt-6-astra",
  displayName: "GPT-6 Astra",
  defaultReasoningEffort: "high",
  reasoningEfforts: [{ id: "high", description: "Thorough" }, { id: "xhigh", description: "Deep" }],
}];
const checkpointDefaults = { modelOptions, initialConfig: DEFAULT_RUN_CONFIG };

const rejected = [{
  id: "rejected-1",
  statement: "Independent shops cannot compare supplier reliability.",
  reason: "The candidate cited factors from only one source hostname.",
}];

describe("rejected problem evidence", () => {
  test.each([1, 2] as const)("projects the current three-stage development for saved workflow %s", async (version) => {
    const view = render(ProblemCheckpoint, {
      problems: [], rejectedCandidates: [], workflowVersion: version, busy: false,
      ...checkpointDefaults,
      onCommit: vi.fn(), onExport: vi.fn(), onOpenSource: vi.fn(),
    });
    await fireEvent.input(view.getByRole("textbox", { name: "Or state the problem yourself." }), { target: { value: "A user-asserted problem." } });
    expect(view.getByText(/~3 model calls projected/)).toBeTruthy();
  });

  test("keeps rejected candidates separate and can reuse one as a user-asserted problem", async () => {
    const view = render(ProblemCheckpoint, {
      problems: [],
      rejectedCandidates: rejected,
      ...checkpointDefaults,
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

  test("commits the chosen development model and a supported reasoning effort", async () => {
    const onCommit = vi.fn().mockResolvedValue(undefined);
    const view = render(ProblemCheckpoint, {
      problems: [], rejectedCandidates: [], busy: false, ...checkpointDefaults,
      onCommit, onExport: vi.fn(), onOpenSource: vi.fn(),
    });
    await fireEvent.input(view.getByRole("textbox", { name: "Or state the problem yourself." }), { target: { value: "A user-asserted problem." } });
    await fireEvent.change(view.getByRole("combobox", { name: "Development model" }), { target: { value: "openai-subscription:gpt-6-astra" } });
    expect((view.getByRole("combobox", { name: "Development reasoning" }) as HTMLSelectElement).value).toBe("high");
    await fireEvent.change(view.getByRole("combobox", { name: "Development reasoning" }), { target: { value: "xhigh" } });
    await fireEvent.click(view.getByRole("button", { name: "Commit selection" }));
    expect(onCommit).toHaveBeenCalledWith(
      [], "A user-asserted problem.",
      { providerId: "openai-subscription", modelId: "gpt-6-astra" }, "xhigh",
    );
  });

  test("restores the most recent development choice", () => {
    const view = render(ProblemCheckpoint, {
      problems: [], rejectedCandidates: [], busy: false, modelOptions,
      initialConfig: {
        ...DEFAULT_RUN_CONFIG,
        model: { providerId: "openai-subscription", modelId: "gpt-6-astra" },
        reasoningEffort: "xhigh",
      },
      onCommit: vi.fn(), onExport: vi.fn(), onOpenSource: vi.fn(),
    });
    expect((view.getByRole("combobox", { name: "Development model" }) as HTMLSelectElement).value).toBe("openai-subscription:gpt-6-astra");
    expect((view.getByRole("combobox", { name: "Development reasoning" }) as HTMLSelectElement).value).toBe("xhigh");
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
    expect(view.getByRole("heading", { name: "Research" })).toBeTruthy();
    expect(view.getByText("These candidates did not pass the evidence requirements.")).toBeTruthy();
    expect(view.queryByText(/discovery never ran/i)).toBeNull();
    const rejectedCard = view.getByText(rejected[0]!.statement).closest("article") as HTMLElement;
    expect(within(rejectedCard).getByText("Not evidence-backed")).toBeTruthy();
    expect(within(rejectedCard).getByText(rejected[0]!.reason)).toBeTruthy();
  });
});
