import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { describe, expect, test, vi } from "vitest";
import IdeaConversation from "../../src/renderer/components/IdeaConversation.svelte";
import type { IdeaConversation as ConversationView } from "../../src/shared/workflow-contracts";

const modelOptions = [{
  providerId: "test", modelId: "new-model", displayName: "New model", defaultReasoningEffort: "medium",
  reasoningEfforts: [{ id: "medium", description: "Standard" }],
}];

function conversation(): ConversationView {
  return {
    rootSolutionId: "root-1",
    selectedVersionId: "version-2",
    defaultModel: { providerId: "test", modelId: "old-model" },
    versions: [
      { solutionId: "root-1", parentSolutionId: null, versionNumber: 1, evidenceSnapshotId: null,
        changeSummary: null, mechanism: "Review every dependency", description: "Original idea",
        reviewFreshness: "current", model: { providerId: "test", modelId: "old-model" }, reasoningEffort: "medium" },
      { solutionId: "version-2", parentSolutionId: "root-1", versionNumber: 2, evidenceSnapshotId: "snapshot-2",
        changeSummary: "Focus on weekly releases", mechanism: "Review before weekly release", description: "Narrower idea",
        reviewFreshness: "unreviewed", model: { providerId: "test", modelId: "old-model" }, reasoningEffort: "medium" },
    ],
    branches: [{ branchId: "branch-1", headTurnId: "turn-1", turnCount: 1 }],
    turns: [{ id: "turn-1", branchId: "branch-1", branchSequence: 1, parentTurnId: null,
      baseSolutionId: "version-2", intent: "explain", userText: "Why this timing?", state: "failed",
      model: { providerId: "test", modelId: "old-model" }, reasoningEffort: "medium", assistant: null,
      error: "The provider was unavailable.", createdAt: "2026-09-23T10:00:00.000Z", completedAt: "2026-09-23T10:00:01.000Z" }],
    nextCursor: null,
  };
}

describe("IdeaConversation", () => {
  test("requires an explicit model change and sends a rethink against the selected version", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const view = render(IdeaConversation, { conversation: conversation(), modelOptions, onSubmit });
    expect(view.getByText("This version has not been reviewed")).toBeTruthy();
    await fireEvent.click(view.getByRole("button", { name: "Rethink" }));
    await fireEvent.input(view.getByLabelText("Follow-up message"), { target: { value: "Move this into the release checklist." } });
    expect((view.getByRole("button", { name: "Send follow-up" }) as HTMLButtonElement).disabled).toBe(true);
    expect(view.getByText(/model used for this version is unavailable/i)).toBeTruthy();
    await fireEvent.change(view.getByLabelText("Model"), { target: { value: "test:new-model" } });
    await fireEvent.click(view.getByRole("button", { name: "Send follow-up" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      baseSolutionId: "version-2", evidenceSnapshotId: "snapshot-2", intent: "rethink",
      model: { providerId: "test", modelId: "new-model" }, reasoningEffort: "medium",
      allowance: { maxModelCalls: 2, maxMinutes: 2 },
    });
  });

  test("retains a failed turn and restores its text into a new draft", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const view = render(IdeaConversation, { conversation: conversation(), modelOptions, onSubmit });
    expect(view.getByText("The provider was unavailable.")).toBeTruthy();
    await fireEvent.click(view.getByRole("button", { name: "Edit and retry" }));
    expect((view.getByLabelText("Follow-up message") as HTMLTextAreaElement).value).toBe("Why this timing?");
    expect(view.getByText(/failed turn stays in history/i)).toBeTruthy();
    expect(view.getByText("The provider was unavailable.")).toBeTruthy();
    await fireEvent.change(view.getByLabelText("Model"), { target: { value: "test:new-model" } });
    await fireEvent.click(view.getByRole("button", { name: "Send follow-up" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ parentTurnId: null, expectedHeadTurnId: null });
    expect(onSubmit.mock.calls[0]?.[0].branchId).toBeUndefined();
  });
});
