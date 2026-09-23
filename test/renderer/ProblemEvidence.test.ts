import { fireEvent, render, within } from "@testing-library/svelte";
import { describe, expect, test, vi } from "vitest";
import ProblemCheckpoint from "../../src/renderer/components/ProblemCheckpoint.svelte";
import ResearchArchive from "../../src/renderer/components/ResearchArchive.svelte";
import type { ProblemCandidate } from "../../src/shared/ipc";
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

function problemCandidate(id: string, developmentCompleted: boolean, verdict: ProblemCandidate["verdict"] = "confirmed"): ProblemCandidate {
  return {
    id,
    statement: `Problem ${id}`,
    whyItPersists: "The workflow remains fragmented.",
    affected: "Independent teams",
    scaleEstimate: "Many teams",
    verdict,
    verdictReason: "Multiple sources agree.",
    selected: true,
    factors: [],
    intendedBuyerEvidenceFactorIds: [],
    evidenceGap: null,
    singleHarvestModeWarning: false,
    developmentCompleted,
  };
}

const rejected = [{
  id: "rejected-1",
  statement: "Independent shops cannot compare supplier reliability.",
  reason: "The candidate cited factors from only one source hostname.",
}];

describe("rejected problem evidence", () => {
  test("uses the saved output rule for managed work and the brief for automatic work", async () => {
    const managedCommit = vi.fn(async () => {});
    const managed = render(ProblemCheckpoint, {
      problems: [problemCandidate("managed", false)], rejectedCandidates: rejected, busy: false,
      ...checkpointDefaults,
      initialConfig: { ...DEFAULT_RUN_CONFIG, explorationPurpose: "startup-opportunities" },
      fixedExplorationPurpose: "general-solutions",
      onCommit: managedCommit, onExport: vi.fn(), onOpenSource: vi.fn(),
    });
    expect(managed.getByText("This project asks for practical solutions.")).toBeTruthy();
    expect(managed.queryByRole("combobox", { name: "Option type" })).toBeNull();
    expect(managed.queryByRole("textbox", { name: "Or state the problem yourself." })).toBeNull();
    expect(managed.queryByRole("button", { name: "Use as user-asserted problem" })).toBeNull();
    expect(managed.getByText(/Each idea batch reserves up to 4 model calls for generation and review/)).toBeTruthy();
    expect(managed.queryByText(/model calls projected/)).toBeNull();
    await fireEvent.click(managed.getByRole("button", { name: "Generate all selected" }));
    expect(managedCommit).toHaveBeenCalledWith(["managed"], null, DEFAULT_RUN_CONFIG.model, "medium", "general-solutions");

    managed.unmount();
    const legacyCommit = vi.fn(async () => {});
    const legacy = render(ProblemCheckpoint, {
      problems: [problemCandidate("legacy", false)], rejectedCandidates: [], busy: false,
      ...checkpointDefaults, onCommit: legacyCommit, onExport: vi.fn(), onOpenSource: vi.fn(),
    });
    expect(legacy.getByText(/~3 model calls projected/)).toBeTruthy();
    expect(legacy.queryByRole("combobox", { name: "Option type" })).toBeNull();
    expect(legacy.getByText("Ideas will follow your brief and each selected problem.")).toBeTruthy();
    await fireEvent.click(legacy.getByRole("button", { name: "Generate all selected" }));
    expect(legacyCommit).toHaveBeenCalledWith(["legacy"], null, DEFAULT_RUN_CONFIG.model, "medium", "auto");
  });
  test("projects calls only for selected problems that still need development", () => {
    const view = render(ProblemCheckpoint, {
      problems: [problemCandidate("completed", true), problemCandidate("pending", false)],
      rejectedCandidates: [], busy: false, ...checkpointDefaults,
      onCommit: vi.fn(), onExport: vi.fn(), onOpenSource: vi.fn(),
    });

    expect(view.getByText(/~3 model calls projected/)).toBeTruthy();
  });

  test("projects zero calls when every selected problem reuses completed development", () => {
    const view = render(ProblemCheckpoint, {
      problems: [problemCandidate("completed-empty", true)],
      rejectedCandidates: [], busy: false, ...checkpointDefaults,
      onCommit: vi.fn(), onExport: vi.fn(), onOpenSource: vi.fn(),
    });

    expect(view.getByText(/~0 model calls projected/)).toBeTruthy();
  });

  test("does not project another run when manual text matches selected user-asserted development", async () => {
    const completed = problemCandidate("completed-manual", true, "user-asserted");
    completed.statement = "An exact user-asserted problem.";
    const pending = problemCandidate("pending-manual", false, "user-asserted");
    pending.statement = "A pending user-asserted problem.";
    const view = render(ProblemCheckpoint, {
      problems: [completed, pending], rejectedCandidates: [], busy: false, ...checkpointDefaults,
      onCommit: vi.fn(), onExport: vi.fn(), onOpenSource: vi.fn(),
    });
    const textbox = view.getByRole("textbox", { name: "Or state the problem yourself." });

    await fireEvent.input(textbox, { target: { value: completed.statement } });
    expect(view.getByText(/~3 model calls projected/)).toBeTruthy();

    await fireEvent.input(textbox, { target: { value: pending.statement } });
    expect(view.getByText(/~3 model calls projected/)).toBeTruthy();
  });

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
    expect((view.getByRole("button", { name: "Generate all selected" }) as HTMLButtonElement).disabled).toBe(false);
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
    await fireEvent.click(view.getByRole("button", { name: "Generate all selected" }));
    expect(onCommit).toHaveBeenCalledWith(
      [], "A user-asserted problem.",
      { providerId: "openai-subscription", modelId: "gpt-6-astra" }, "xhigh", "auto",
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

  test("requires a new choice when the saved development model is absent", async () => {
    const onCommit = vi.fn().mockResolvedValue(undefined);
    const view = render(ProblemCheckpoint, {
      problems: [], rejectedCandidates: [], busy: false, modelOptions,
      initialConfig: { ...DEFAULT_RUN_CONFIG, model: { providerId: "openai-subscription", modelId: "gpt-6-luna" } },
      onCommit, onExport: vi.fn(), onOpenSource: vi.fn(),
    });
    await fireEvent.input(view.getByRole("textbox", { name: "Or state the problem yourself." }), { target: { value: "A user-asserted problem." } });
    const model = view.getByRole("combobox", { name: "Development model" }) as HTMLSelectElement;
    expect(model.value).toBe("openai-subscription:gpt-6-luna");
    expect(view.getByRole("option", { name: "GPT-6 Luna (unavailable)" })).toBeTruthy();
    const generate = view.getByRole("button", { name: "Generate all selected" }) as HTMLButtonElement;
    expect(generate.disabled).toBe(true);
    await fireEvent.change(model, { target: { value: "openai-subscription:gpt-6-astra" } });
    expect(generate.disabled).toBe(false);
    await fireEvent.click(generate);
    expect(onCommit).toHaveBeenCalledWith([], "A user-asserted problem.", { providerId: "openai-subscription", modelId: "gpt-6-astra" }, "high", "auto");
  });

  test("requires an available reasoning effort before development", async () => {
    const view = render(ProblemCheckpoint, {
      problems: [], rejectedCandidates: [], busy: false, modelOptions,
      initialConfig: { ...DEFAULT_RUN_CONFIG, model: { providerId: "openai-subscription", modelId: "gpt-6-astra" }, reasoningEffort: "medium" },
      onCommit: vi.fn(), onExport: vi.fn(), onOpenSource: vi.fn(),
    });
    await fireEvent.input(view.getByRole("textbox", { name: "Or state the problem yourself." }), { target: { value: "A user-asserted problem." } });
    const reasoning = view.getByRole("combobox", { name: "Development reasoning" }) as HTMLSelectElement;
    expect(reasoning.value).toBe("medium");
    expect((view.getByRole("button", { name: "Generate all selected" }) as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.change(reasoning, { target: { value: "high" } });
    expect((view.getByRole("button", { name: "Generate all selected" }) as HTMLButtonElement).disabled).toBe(false);
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
