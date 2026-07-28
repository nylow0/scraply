import { RESEARCH_STREAMS } from "../../research/streams";
import type { ResearchEvent, WorkspaceState } from "../../shared/ipc";

export type LaneStatus = "idle" | "running" | "completed" | "failed" | "incomplete";

export type StreamLane = {
  id: string;
  name: string;
  focus: string;
  status: LaneStatus;
  detail: string;
  followUpRound: number;
};

export type RunPhase = {
  label: string;
  tone: "idle" | "active" | "done" | "failed";
};

/** Authoritative run state from the workspace, which survives app restarts. */
export type RunSnapshot = NonNullable<WorkspaceState["latestResearchRun"]>;

const TERMINAL_RUN_STATUSES = ["completed", "partial", "failed", "cancelled"] as const;

const LANE_STATUS_LABEL: Record<LaneStatus, string> = {
  idle: "Queued",
  running: "Researching",
  completed: "Complete",
  failed: "Failed",
  incomplete: "Not completed",
};

export function laneStatusLabel(status: LaneStatus): string {
  return LANE_STATUS_LABEL[status];
}

export function isRunFinished(snapshot: RunSnapshot | null | undefined): boolean {
  return Boolean(snapshot && (TERMINAL_RUN_STATUSES as readonly string[]).includes(snapshot.status));
}

/**
 * Lanes start from the persisted run state so a finished run never renders as
 * "queued", then live events refine them because events are more specific.
 */
export function deriveStreamLanes(events: ResearchEvent[], snapshot?: RunSnapshot | null): StreamLane[] {
  const missing = new Set(snapshot?.missingLenses ?? []);
  const finished = isRunFinished(snapshot);

  const lanes = new Map<string, StreamLane>(
    RESEARCH_STREAMS.map((stream) => {
      let status: LaneStatus = "idle";
      if (snapshot && !missing.has(stream.id)) status = "completed";
      else if (finished) status = "incomplete";
      return [stream.id, { id: stream.id, name: stream.name, focus: stream.focus, status, detail: "", followUpRound: 0 }];
    }),
  );

  let runEnded = false;
  for (const event of events) {
    if (event.type === "run-completed" || event.type === "run-failed" || event.type === "run-cancelled") runEnded = true;
    if (event.type === "run-started" || event.type === "run-resumed") runEnded = false;
    if (!("streamId" in event)) continue;
    const lane = lanes.get(event.streamId);
    if (!lane) continue;
    if (event.type === "stream-started") {
      lane.status = "running";
      lane.detail = "";
      lane.followUpRound = 0;
    }
    if (event.type === "stream-progress") lane.detail = event.message;
    if (event.type === "follow-up-started") {
      lane.status = "running";
      lane.followUpRound = event.round;
    }
    if (event.type === "stream-completed") lane.status = "completed";
    if (event.type === "stream-failed") {
      lane.status = "failed";
      lane.detail = event.error;
    }
  }

  // Once the run has ended, a stream that never started did not just stay
  // queued — it will never run. Streams seen running are left alone so a stale
  // snapshot cannot contradict live events.
  if (runEnded) {
    for (const lane of lanes.values()) {
      if (lane.status === "idle") lane.status = "incomplete";
    }
  }

  return [...lanes.values()];
}

export function derivePhase(events: ResearchEvent[], snapshot?: RunSnapshot | null): RunPhase {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === "run-failed") return { label: `Run failed · ${event.error}`, tone: "failed" };
    if (event.type === "run-cancelled") return { label: "Run cancelled", tone: "idle" };
    if (event.type === "ideas-generated") return { label: "Ideas generated", tone: "done" };
    if (event.type === "run-completed") {
      return event.partial
        ? { label: "Finished with partial results", tone: "done" }
        : { label: "Run complete", tone: "done" };
    }
    if (event.type === "synthesis-completed") return { label: "Synthesis complete", tone: "done" };
    if (event.type === "synthesis-started") return { label: "Generating composite synthesis…", tone: "active" };
    if (event.type === "coverage-review-completed") {
      return { label: `Coverage review · ${Math.round(event.overallCoverage * 100)}%`, tone: "active" };
    }
    if (event.type === "coverage-review-started") return { label: "Reviewing coverage across streams…", tone: "active" };
    if (event.type === "stream-started" || event.type === "stream-progress" || event.type === "follow-up-started") {
      return { label: "Researching the six streams…", tone: "active" };
    }
    if (event.type === "run-resumed") return { label: "Resuming the interrupted run…", tone: "active" };
    if (event.type === "run-started") return { label: "Starting research…", tone: "active" };
  }

  // No live events, so fall back to the persisted run state.
  switch (snapshot?.status) {
    case "completed":
      return { label: "Run complete", tone: "done" };
    case "partial":
      return { label: "Finished with partial results", tone: "done" };
    case "failed":
      return { label: snapshot.gaps[0] ? `Run failed · ${snapshot.gaps[0]}` : "Run failed", tone: "failed" };
    case "cancelled":
      return { label: "Run cancelled", tone: "idle" };
    case "running":
      return { label: "Research in progress", tone: "active" };
    case "queued":
      return { label: "Waiting to start", tone: "idle" };
    default:
      return { label: "Waiting for the first update", tone: "idle" };
  }
}

export function countCompletedLanes(lanes: StreamLane[]): number {
  return lanes.filter((lane) => lane.status === "completed").length;
}
