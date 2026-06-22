import type { ResearchEvent } from "../../shared/ipc";
import type { Researcher } from "../../shared/schemas";

export type ResearchPhase = "research" | "review" | "synthesis" | "ideas" | "complete" | "cancelled";

export type StreamUiState = {
  status: "pending" | "running" | "completed" | "failed";
  message: string;
};

const STATUS_LABELS: Record<StreamUiState["status"], string> = {
  pending: "Queued",
  running: "Running",
  completed: "Done",
  failed: "Failed",
};

export function streamStatusLabel(status: StreamUiState["status"]): string {
  return STATUS_LABELS[status];
}

export function deriveStreamStates(
  events: ResearchEvent[],
  researchers: Researcher[],
): Map<string, StreamUiState> {
  const map = new Map<string, StreamUiState>();
  for (const r of researchers) map.set(r.id, { status: "pending", message: "Waiting to start" });

  for (const event of events) {
    if (!("streamId" in event) || !map.has(event.streamId)) continue;
    const current = map.get(event.streamId)!;
    if (event.type === "stream-started") map.set(event.streamId, { status: "running", message: "Starting…" });
    else if (event.type === "stream-progress") map.set(event.streamId, { status: "running", message: event.message });
    else if (event.type === "stream-completed") map.set(event.streamId, { status: "completed", message: "Report ready" });
    else if (event.type === "stream-failed") map.set(event.streamId, { status: "failed", message: event.error });
    else if (event.type === "follow-up-started") {
      map.set(event.streamId, { status: "running", message: `Follow-up round ${event.round}` });
    } else map.set(event.streamId, current);
  }
  return map;
}

export function deriveResearchPhase(events: ResearchEvent[]): ResearchPhase {
  for (let i = events.length - 1; i >= 0; i--) {
    const type = events[i]!.type;
    if (type === "run-cancelled") return "cancelled";
    if (type === "ideas-generated" || type === "ideas-failed") return "complete";
    if (type === "run-completed") return "ideas";
    if (type === "synthesis-started" || type === "synthesis-completed" || type === "synthesis-failed") return "synthesis";
    if (type === "coverage-review-started" || type === "coverage-review-completed" || type === "coverage-review-failed") {
      return "review";
    }
  }
  return "research";
}

export function deriveOrchestratorMessage(events: ResearchEvent[]): string {
  for (const event of [...events].reverse()) {
    if (event.type === "ideas-generated") return `${event.ideaCount} ideas generated`;
    if (event.type === "ideas-failed") return `Idea generation failed — ${event.error}`;
    if (event.type === "run-cancelled") return "Research cancelled";
    if (event.type === "synthesis-completed") return "Synthesis complete — compiling reports";
    if (event.type === "synthesis-failed") return `Synthesis failed — ${event.error}`;
    if (event.type === "synthesis-started") return "Generating composite synthesis…";
    if (event.type === "coverage-review-completed") {
      return `Coverage review · ${Math.round(event.overallCoverage * 100)}% overall`;
    }
    if (event.type === "coverage-review-failed") return `Coverage review failed — ${event.error}`;
    if (event.type === "coverage-review-started") return "Reviewing coverage across streams…";
    if (event.type === "run-completed") {
      return event.partial ? "Run finished with partial results" : "Research run complete";
    }
    if (event.type === "run-started") return "Launching research streams…";
    if (event.type === "run-resumed") return "Resuming interrupted research…";
  }
  return events.length > 0 ? "Research in progress" : "Waiting for updates";
}

export function coveragePercent(events: ResearchEvent[]): number | null {
  for (const event of [...events].reverse()) {
    if (event.type === "coverage-review-completed") return Math.round(event.overallCoverage * 100);
  }
  return null;
}

export function countStreamStatuses(states: Map<string, StreamUiState>) {
  let pending = 0;
  let running = 0;
  let completed = 0;
  let failed = 0;
  for (const s of states.values()) {
    if (s.status === "pending") pending++;
    else if (s.status === "running") running++;
    else if (s.status === "completed") completed++;
    else if (s.status === "failed") failed++;
  }
  return { pending, running, completed, failed, total: states.size };
}

export function hasStreamFailures(events: ResearchEvent[]): boolean {
  return events.some((e) => e.type === "stream-failed");
}

export function hasOrchestratorFailure(events: ResearchEvent[]): boolean {
  return events.some(
    (e) =>
      e.type === "stream-failed" ||
      e.type === "coverage-review-failed" ||
      e.type === "synthesis-failed" ||
      e.type === "ideas-failed",
  );
}

export function formatRecentEvent(event: ResearchEvent): string {
  switch (event.type) {
    case "run-started":
      return "Run started";
    case "run-resumed":
      return "Run resumed";
    case "run-completed":
      return event.partial ? "Run completed (partial)" : "Run completed";
    case "run-cancelled":
      return "Run cancelled";
    case "stream-started":
      return `${event.streamId}: started`;
    case "stream-progress":
      return `${event.streamId}: ${event.message}`;
    case "stream-completed":
      return `${event.streamId}: report saved`;
    case "stream-failed":
      return `${event.streamId}: failed — ${event.error}`;
    case "follow-up-started":
      return `${event.streamId}: follow-up round ${event.round}`;
    case "coverage-review-started":
      return "Coverage review started";
    case "coverage-review-completed":
      return `Coverage review · ${Math.round(event.overallCoverage * 100)}%`;
    case "coverage-review-failed":
      return `Coverage review failed — ${event.error}`;
    case "synthesis-started":
      return "Synthesis started";
    case "synthesis-completed":
      return "Synthesis complete";
    case "synthesis-failed":
      return `Synthesis failed — ${event.error}`;
    case "ideas-generated":
      return `${event.ideaCount} ideas generated`;
    case "ideas-failed":
      return `Ideas failed — ${event.error}`;
    default:
      return "Update";
  }
}
