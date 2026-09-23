import { expect, test } from "bun:test";
import { createScraplyApi } from "../../src/shared/scraply-api";
import { AppError, toErrorPayload } from "../../src/shared/errors";
import { IPC_CHANNELS } from "../../src/shared/ipc";
import { WorkflowActionSchema, WorkflowTaskSchema } from "../../src/shared/workflow-contracts";

test("workflow task detail carries the terminal attempt needed for an explicit retry", () => {
  const task = WorkflowTaskSchema.parse({
    id: "task-1", terminalAttemptId: "attempt-1", parentItemId: null, kind: "research",
    scopeKey: "question-1", state: "unknown", createdAt: "2026-09-23T12:00:00.000Z", finishedAt: null,
  });
  expect(task.terminalAttemptId).toBe("attempt-1");
});

test("workflow commands reject a search allowance for reevaluation", () => {
  const action = {
    type: "request-research", kind: "reevaluate", question: "Check this claim again", targetFindingId: "finding-1", model: { providerId: "openai-subscription", modelId: "gpt-6-sol" },
    reasoningEffort: "medium", allowance: { maxModelCalls: 1, maxSearches: 1, maxMinutes: 5 },
  };
  expect(WorkflowActionSchema.safeParse(action).success).toBe(false);
  expect(WorkflowActionSchema.safeParse({ ...action, allowance: { ...action.allowance, maxSearches: 0 } }).success).toBe(true);
});

test("project generation accepts thirty families while per-problem batches stay at twenty", () => {
  const action = {
    type: "generate-ideas", snapshotId: "snapshot-1", problemIds: ["problem-1"],
    model: { providerId: "openai-subscription", modelId: "gpt-5.6-sol" },
    reasoningEffort: "medium", target: { kind: "project", count: 30 },
  };
  expect(WorkflowActionSchema.safeParse(action).success).toBe(true);
  expect(WorkflowActionSchema.safeParse({ ...action, target: { kind: "project", count: 31 } }).success).toBe(false);
  expect(WorkflowActionSchema.safeParse({ ...action, target: { kind: "per-problem", count: 20 } }).success).toBe(true);
  expect(WorkflowActionSchema.safeParse({ ...action, target: { kind: "per-problem", count: 21 } }).success).toBe(false);
});

test("workflow transport preserves typed conflict recovery across the IPC envelope", async () => {
  const recovery = { currentRevision: 7, sessionId: "session-1" };
  const api = createScraplyApi({
    invoke: async <T>(channel: string): Promise<T> => {
      expect(channel).toBe(IPC_CHANNELS.GET_WORKFLOW);
      return { ok: false, error: { code: "REVISION_CONFLICT", message: "Reload the workflow.", recovery } } as T;
    },
    onBackendEvent: () => () => {},
  });
  try {
    await api.getWorkflow({ sessionId: "session-1" });
    throw new Error("Expected a workflow conflict");
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("REVISION_CONFLICT");
    expect((error as AppError).recovery).toEqual(recovery);
    expect(toErrorPayload(error).error.recovery).toEqual(recovery);
  }
});

test("legacy idea version selection uses the direct command and returns the saved conversation", async () => {
  const payload = { threadId: "thread-1", rootSolutionId: "idea-1", solutionId: "idea-2" };
  const conversation = {
    rootSolutionId: "idea-1", selectedVersionId: "idea-2", defaultModel: null,
    versions: [], branches: [], turns: [], nextCursor: null,
  };
  const api = createScraplyApi({
    invoke: async <T>(channel: string, input?: unknown): Promise<T> => {
      expect(channel).toBe(IPC_CHANNELS.SELECT_IDEA_VERSION);
      expect(input).toEqual(payload);
      return { ok: true, data: conversation } as T;
    },
    onBackendEvent: () => () => {},
  });
  expect(await api.selectIdeaVersion(payload)).toEqual(conversation);
});
