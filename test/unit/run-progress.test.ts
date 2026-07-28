import { describe, expect, test } from "bun:test";
import { RESEARCH_STREAMS } from "../../src/research/streams";
import {
  countCompletedLanes,
  derivePhase,
  deriveStreamLanes,
  isRunFinished,
  type RunSnapshot,
} from "../../src/renderer/lib/run-progress";
import type { ResearchEvent } from "../../src/shared/ipc";

const IDS = RESEARCH_STREAMS.map((stream) => stream.id);

function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: "run-1",
    status: "running",
    synthesisReportId: null,
    canGeneratePartialIdeas: false,
    missingLenses: [...IDS],
    gaps: [],
    ...overrides,
  };
}

function laneStatus(lanes: ReturnType<typeof deriveStreamLanes>, id: string) {
  return lanes.find((lane) => lane.id === id)?.status;
}

describe("deriveStreamLanes", () => {
  test("shows every stream as queued for a fresh run so nothing is claimed done", () => {
    const lanes = deriveStreamLanes([], snapshot());
    expect(lanes).toHaveLength(6);
    expect(lanes.every((lane) => lane.status === "idle")).toBe(true);
    expect(countCompletedLanes(lanes)).toBe(0);
  });

  test("reports a finished run as complete without any events, because events are lost on restart", () => {
    const lanes = deriveStreamLanes([], snapshot({ status: "completed", missingLenses: [] }));
    expect(countCompletedLanes(lanes)).toBe(6);
  });

  test("marks lenses a finished run never covered as not completed rather than queued", () => {
    const lanes = deriveStreamLanes([], snapshot({ status: "partial", missingLenses: ["analogies", "evaluation"] }));
    expect(countCompletedLanes(lanes)).toBe(4);
    expect(laneStatus(lanes, "analogies")).toBe("incomplete");
    expect(laneStatus(lanes, "evaluation")).toBe("incomplete");
  });

  test("live events win over the snapshot so in-flight progress is not shown as queued", () => {
    const events: ResearchEvent[] = [
      { type: "run-started", runId: "run-1", threadId: "thread-1" },
      { type: "stream-started", runId: "run-1", threadId: "thread-1", streamId: "landscape" },
      { type: "stream-progress", runId: "run-1", threadId: "thread-1", streamId: "landscape", message: "Reading sources" },
      { type: "stream-completed", runId: "run-1", threadId: "thread-1", streamId: "exemplars", reportId: "report-1" },
      { type: "stream-failed", runId: "run-1", threadId: "thread-1", streamId: "resources", error: "Provider timeout" },
    ];
    const lanes = deriveStreamLanes(events, snapshot());
    expect(laneStatus(lanes, "landscape")).toBe("running");
    expect(lanes.find((lane) => lane.id === "landscape")?.detail).toBe("Reading sources");
    expect(laneStatus(lanes, "exemplars")).toBe("completed");
    expect(laneStatus(lanes, "resources")).toBe("failed");
    expect(lanes.find((lane) => lane.id === "resources")?.detail).toBe("Provider timeout");
  });

  test("a follow-up round keeps the stream running and records the round number", () => {
    const events: ResearchEvent[] = [
      { type: "stream-completed", runId: "run-1", threadId: "thread-1", streamId: "landscape", reportId: "report-1" },
      { type: "follow-up-started", runId: "run-1", threadId: "thread-1", streamId: "landscape", round: 2 },
    ];
    const lanes = deriveStreamLanes(events, snapshot());
    expect(laneStatus(lanes, "landscape")).toBe("running");
    expect(lanes.find((lane) => lane.id === "landscape")?.followUpRound).toBe(2);
  });

  test("streams that never started stop reading as queued once the run ends", () => {
    const events: ResearchEvent[] = [
      { type: "run-started", runId: "run-1", threadId: "thread-1" },
      { type: "stream-completed", runId: "run-1", threadId: "thread-1", streamId: "landscape", reportId: "report-1" },
      { type: "run-failed", runId: "run-1", threadId: "thread-1", error: "Budget exhausted" },
    ];
    const lanes = deriveStreamLanes(events, snapshot());
    expect(laneStatus(lanes, "landscape")).toBe("completed");
    expect(laneStatus(lanes, "evaluation")).toBe("incomplete");
  });

  test("a restarted run clears the previous run's ended state", () => {
    const events: ResearchEvent[] = [
      { type: "run-failed", runId: "run-1", threadId: "thread-1", error: "Budget exhausted" },
      { type: "run-started", runId: "run-2", threadId: "thread-1" },
    ];
    const lanes = deriveStreamLanes(events, snapshot());
    expect(lanes.every((lane) => lane.status === "idle")).toBe(true);
  });

  test("a stale completed snapshot cannot mark a live stream as not completed", () => {
    const events: ResearchEvent[] = [
      { type: "run-started", runId: "run-2", threadId: "thread-1" },
      { type: "stream-started", runId: "run-2", threadId: "thread-1", streamId: "landscape" },
    ];
    const lanes = deriveStreamLanes(events, snapshot({ status: "completed", missingLenses: IDS.slice(1) }));
    expect(laneStatus(lanes, "landscape")).toBe("running");
  });
});

describe("derivePhase", () => {
  test("falls back to the persisted run status when no events survived a restart", () => {
    expect(derivePhase([], snapshot({ status: "completed" })).label).toBe("Run complete");
    expect(derivePhase([], snapshot({ status: "partial" })).tone).toBe("done");
    expect(derivePhase([], snapshot({ status: "queued" })).label).toBe("Waiting to start");
    expect(derivePhase([], snapshot({ status: "running" })).tone).toBe("active");
  });

  test("names the failure reason so a failed run is not reported as merely stopped", () => {
    const phase = derivePhase([], snapshot({ status: "failed", gaps: ["Exa quota exceeded"] }));
    expect(phase.tone).toBe("failed");
    expect(phase.label).toContain("Exa quota exceeded");
  });

  test("prefers the newest event over the persisted status", () => {
    const events: ResearchEvent[] = [
      { type: "run-started", runId: "run-1", threadId: "thread-1" },
      { type: "synthesis-started", runId: "run-1", threadId: "thread-1" },
    ];
    expect(derivePhase(events, snapshot({ status: "queued" })).label).toBe("Generating composite synthesis…");
  });

  test("reports coverage as a percentage rather than a raw ratio", () => {
    const events: ResearchEvent[] = [
      { type: "coverage-review-completed", runId: "run-1", threadId: "thread-1", overallCoverage: 0.825 },
    ];
    expect(derivePhase(events, null).label).toBe("Coverage review · 83%");
  });

  test("has a defined phase with no events and no snapshot", () => {
    expect(derivePhase([], null).label).toBe("Waiting for the first update");
  });
});

describe("isRunFinished", () => {
  test("treats only ended statuses as finished so a running run keeps its live view", () => {
    expect(isRunFinished(snapshot({ status: "running" }))).toBe(false);
    expect(isRunFinished(snapshot({ status: "queued" }))).toBe(false);
    expect(isRunFinished(snapshot({ status: "completed" }))).toBe(true);
    expect(isRunFinished(snapshot({ status: "partial" }))).toBe(true);
    expect(isRunFinished(snapshot({ status: "failed" }))).toBe(true);
    expect(isRunFinished(snapshot({ status: "cancelled" }))).toBe(true);
    expect(isRunFinished(null)).toBe(false);
  });
});
