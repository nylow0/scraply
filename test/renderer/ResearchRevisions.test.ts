import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { describe, expect, test, vi } from "vitest";
import ResearchRevisions from "../../src/renderer/components/ResearchRevisions.svelte";
import type { ResearchFindingView, ResearchRequestView } from "../../src/shared/research-revisions";

const model = { providerId: "openai-subscription", modelId: "test-model" };
const modelOptions = [{
  ...model, displayName: "Test model", defaultReasoningEffort: "medium",
  reasoningEfforts: [{ id: "medium", description: "Standard" }],
}];
const previous: ResearchFindingView = {
  id: "old", statement: "Small teams struggle", verdict: "confirmed",
  verdictReason: "The saved sources suggested a recurring problem.", evidenceGap: "Buyer fit unknown",
  supportingSources: [{ id: "source-old", title: "Original report", url: "https://example.test/old" }],
  verdictSources: [],
};
const proposed: ResearchFindingView = {
  id: "new", statement: "Larger teams struggle", verdict: "insufficient-evidence",
  verdictReason: "The new reports do not establish small-team demand.", evidenceGap: "Small-team demand unproven",
  supportingSources: [{ id: "source-new", title: "New report", url: "https://example.test/new" }],
  verdictSources: [],
};

function props(requests: ResearchRequestView[] = []) {
  return {
    requests, findings: [previous], activeSnapshotId: "snapshot-1", modelOptions,
    researchModel: model, researchReasoningEffort: "medium", busy: false,
    onRequest: vi.fn().mockResolvedValue(undefined),
    onApply: vi.fn().mockResolvedValue(undefined),
    onKeep: vi.fn().mockResolvedValue(undefined),
    onOpenSource: vi.fn().mockResolvedValue(undefined),
  };
}

describe("ResearchRevisions", () => {
  test("shows all sources returned for an archived angle without offering to apply it", async () => {
    const input = props([{
      id: "old-request", kind: "new-question", question: "What do buyers use?", status: "completed",
      archived: true, resultFindings: [], angles: [{
        id: "angle-1", name: "Current alternatives", sourceClass: "current-alternative",
        acceptanceCriterion: "Identify current tools", status: "completed", sourceCount: 1,
        sources: [{ title: "Tool inventory", url: "https://example.test/tool-inventory" }],
      }],
    }]);
    const view = render(ResearchRevisions, input);
    await fireEvent.click(view.getByRole("button", { name: /What do buyers use/ }));
    await fireEvent.click(view.getByRole("button", { name: "Tool inventory" }));
    expect(input.onOpenSource).toHaveBeenCalledWith("https://example.test/tool-inventory");
    expect(view.queryByLabelText("Include")).toBeNull();
  });

  test("saves a reevaluation request with zero searches and leaves current research selected", async () => {
    const input = props();
    const view = render(ResearchRevisions, input);
    await fireEvent.click(view.getByText("Revisit a finding"));
    await fireEvent.click(view.getByRole("button", { name: "Reevaluate saved evidence" }));
    expect((view.getByLabelText("What was wrong or should change?") as HTMLTextAreaElement).value)
      .toContain("Small teams struggle");
    await fireEvent.click(view.getByRole("button", { name: "Start research request" }));
    await waitFor(() => expect(input.onRequest).toHaveBeenCalledOnce());
    expect(input.onRequest.mock.calls[0]?.[0]).toMatchObject({
      kind: "reevaluate", targetFindingId: "old", baseSnapshotId: "snapshot-1",
      allowance: { maxSearches: 0 },
    });
    expect(input.onApply).not.toHaveBeenCalled();
  });

  test("describes a zero-search reevaluation as using saved research", async () => {
    const input = props([{
      id: "reevaluate-1", kind: "reevaluate", question: "Recheck the saved finding", status: "completed",
      targetFindingId: "old", previousFinding: previous, resultFindings: [proposed],
      angles: [{ id: "angle-1", name: "Saved evidence", sourceClass: "firsthand-experience",
        acceptanceCriterion: "Reevaluate existing sources", status: "completed", sourceCount: 0,
        gap: "No saved sources were available" }],
    }]);
    const view = render(ResearchRevisions, input);
    await fireEvent.click(view.getByRole("button", { name: /Recheck the saved finding/ }));
    expect(view.getByText("Uses saved research; no new search.")).toBeTruthy();
    expect(view.queryByText("0 sources returned")).toBeNull();
    expect(view.queryByText("No saved sources were available")).toBeNull();
    expect(view.getByText("New report")).toBeTruthy();
  });

  test("requires an explicit replacement before applying a completed redo", async () => {
    const input = props([{
      id: "request-1", kind: "redo", question: "Redo buyer evidence", status: "completed",
      targetFindingId: "old", previousFinding: previous, resultFindings: [proposed],
    }]);
    const view = render(ResearchRevisions, input);
    await fireEvent.click(view.getByRole("button", { name: /Redo buyer evidence/ }));
    expect(view.getByText("Previous finding")).toBeTruthy();
    expect(view.getByText("New result")).toBeTruthy();
    await fireEvent.click(view.getByLabelText("Include"));
    expect((view.getByRole("button", { name: "Use selected results" }) as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.change(view.getByLabelText("Replace the previous finding with"), { target: { value: "new" } });
    await fireEvent.click(view.getByRole("button", { name: "Use selected results" }));
    await waitFor(() => expect(input.onApply).toHaveBeenCalledOnce());
    expect(input.onApply).toHaveBeenCalledWith("snapshot-1", ["request-1"], [
      { oldFindingId: "old", newFindingId: "new" },
    ]);
  });

  test("explains a completed redo with no qualifying replacement", async () => {
    const input = props([{
      id: "request-empty", kind: "redo", question: "Redo buyer evidence", status: "completed",
      targetFindingId: "old", previousFinding: previous, resultFindings: [],
    }]);
    const view = render(ResearchRevisions, input);
    await fireEvent.click(view.getByRole("button", { name: /Redo buyer evidence/ }));
    expect(view.getByText("New result")).toBeTruthy();
    expect(view.getByText("No finding met the evidence requirements. Current research remains unchanged.")).toBeTruthy();
    expect(view.queryByLabelText("Replace the previous finding with")).toBeNull();
    await fireEvent.click(view.getByRole("button", { name: "Keep current research" }));
    await waitFor(() => expect(input.onKeep).toHaveBeenCalledWith("request-empty", "snapshot-1"));
    expect(view.queryByText("New result")).toBeNull();
  });

  test("reopens a kept-current comparison without offering another review decision", async () => {
    const input = props([{
      id: "request-kept", kind: "redo", question: "Earlier buyer evidence", status: "completed",
      targetFindingId: "old", previousFinding: previous, resultFindings: [],
      reviewDecision: "kept-current",
    }]);
    const view = render(ResearchRevisions, { ...input, readOnly: true });
    expect(view.queryByText(/completed result is ready to review/)).toBeNull();
    await fireEvent.click(view.getByRole("button", { name: /Earlier buyer evidence/ }));
    expect(view.getAllByText("Kept current research").length).toBeGreaterThan(0);
    expect(view.getByText("No finding met the evidence requirements. Current research remains unchanged.")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Keep current research" })).toBeNull();
  });

  test("previews planned and omitted angles with the fixed allowance and saves request instructions", async () => {
    const input = props([{
      id: "earlier", kind: "new-question", question: "Earlier buyer question", status: "completed", resultFindings: [previous],
    }]);
    const view = render(ResearchRevisions, input);
    await fireEvent.click(view.getByRole("button", { name: "Add research" }));
    expect(view.getByText("Planned research angles")).toBeTruthy();
    expect(view.getByText("Firsthand problem reports")).toBeTruthy();
    await fireEvent.click(view.getByText("Angles and work limits"));
    await fireEvent.input(view.getByLabelText("Searches"), { target: { value: "4" } });
    await fireEvent.input(view.getByLabelText("Model calls"), { target: { value: "7" } });
    await waitFor(() => expect(view.getByText("Not covered by this allowance")).toBeTruthy());
    expect(view.getByText("Existing alternatives, Buying or adoption behavior")).toBeTruthy();
    await fireEvent.input(view.getByLabelText("Research question"), { target: { value: "What do buyers try now?" } });
    await fireEvent.change(view.getByLabelText("Focus on a saved request (optional)"), { target: { value: "earlier" } });
    await fireEvent.input(view.getByLabelText(/Instructions for this request/), {
      target: { value: "Prioritize attributable buyer accounts." },
    });
    await fireEvent.click(view.getByRole("button", { name: "Start research request" }));
    await waitFor(() => expect(input.onRequest).toHaveBeenCalledOnce());
    expect(input.onRequest.mock.calls[0]?.[0]).toMatchObject({
      targetRequestId: "earlier", instructions: "Prioritize attributable buyer accounts.",
      allowance: { maxModelCalls: 7, maxSearches: 4, maxMinutes: 10 },
    });
  });
});
