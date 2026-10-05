import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { describe, expect, test, vi } from "vitest";
import IdeaConversation from "../../src/renderer/components/IdeaConversation.svelte";
import type { IdeaConversation as ConversationView } from "../../src/shared/workflow-contracts";
import { pickModel } from "./model-picker";
import { EXPLAIN_IDEA_PROMPT } from "../../src/renderer/lib/idea-content";

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
  test("Explain immediately sends the fixed prompt and displays the action instead of the hidden text", async () => {
    const saved = conversation();
    saved.turns = [];
    saved.versions.forEach(version => { version.model = { providerId: "test", modelId: "new-model" }; });
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const view = render(IdeaConversation, { conversation: saved, modelOptions, onSubmit });
    await fireEvent.click(view.getByRole("button", { name: "Explain" }));
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ intent: "explain", text: EXPLAIN_IDEA_PROMPT, baseSolutionId: "version-2", model: { providerId: "test", modelId: "new-model" }, reasoningEffort: "medium" });
    const turn = conversation().turns[0]!;
    await view.rerender({ conversation: { ...saved, turns: [{ ...turn, intent: "explain", userText: EXPLAIN_IDEA_PROMPT, state: "running", error: null }] }, modelOptions, onSubmit });
    expect(view.getByText("Explain this idea")).toBeTruthy();
    expect(view.queryByText(EXPLAIN_IDEA_PROMPT)).toBeNull();
    for (const caption of ["Selected idea version", "Explore this idea", "Using v1", "Original mechanism", "Assistant", "Uses saved research. Up to two model calls; no new search.", "View full idea details"]) expect(view.queryByText(caption)).toBeNull();
  });
  test("requires an explicit model change and sends a rethink against the selected version", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const view = render(IdeaConversation, { conversation: conversation(), modelOptions, onSubmit });
    expect(view.queryByText("This version has not been reviewed")).toBeNull();
    await fireEvent.click(view.getByRole("button", { name: "Rethink" }));
    await fireEvent.input(view.getByLabelText("Follow-up message"), { target: { value: "Move this into the release checklist." } });
    expect((view.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    expect(view.getByRole("button", { name: "Explain" }).hasAttribute("disabled")).toBe(true);
    await pickModel(view.getByLabelText("Model"), "test:new-model");
    await fireEvent.click(view.getByRole("button", { name: "Send" }));
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
    expect(view.getByText("The provider was unavailable.")).toBeTruthy();
    await pickModel(view.getByLabelText("Model"), "test:new-model");
    await fireEvent.click(view.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ parentTurnId: null, expectedHeadTurnId: null });
    expect(onSubmit.mock.calls[0]?.[0].branchId).toBeUndefined();
  });

  test("keeps the fixed Explain instructions hidden during failed-turn editing and retry", async () => {
    const saved = conversation();
    saved.turns[0]!.userText = EXPLAIN_IDEA_PROMPT;
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const view = render(IdeaConversation, { conversation: saved, modelOptions, onSubmit });
    expect(view.getByText("Explain this idea")).toBeTruthy();
    await fireEvent.click(view.getByRole("button", { name: "Edit and retry" }));
    const input = view.getByLabelText("Follow-up message") as HTMLTextAreaElement;
    expect(input.value).toBe("Explain this idea");
    expect(view.queryByText(EXPLAIN_IDEA_PROMPT)).toBeNull();
    await pickModel(view.getByLabelText("Model"), "test:new-model");
    await fireEvent.click(view.getByRole("button", { name: "Retry", exact: true }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ intent: "explain", text: EXPLAIN_IDEA_PROMPT });
    expect(input.value).toBe("");
  });

  test("keeps saved evidence by default and opts into newer research for a reply", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const view = render(IdeaConversation, {
      conversation: conversation(), modelOptions, onSubmit, activeResearchSnapshotId: "snapshot-3",
    });
    expect(view.getByText("Compare with v1")).toBeTruthy();
    await pickModel(view.getByLabelText("Model"), "test:new-model");
    await fireEvent.input(view.getByLabelText("Follow-up message"), { target: { value: "Explain the saved evidence." } });
    await fireEvent.click(view.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0].evidenceSnapshotId).toBe("snapshot-2");

    await fireEvent.click(view.getByRole("checkbox", { name: /Use newer research/ }));
    await fireEvent.input(view.getByLabelText("Follow-up message"), { target: { value: "Rethink with the newer evidence." } });
    await fireEvent.click(view.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onSubmit.mock.calls[1]?.[0].evidenceSnapshotId).toBe("snapshot-3");
  });
});
