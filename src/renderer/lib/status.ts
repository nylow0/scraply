import type { ThreadStatus } from "../../shared/schemas";

export type StatusTone = "neutral" | "active" | "done" | "muted";

const STATUS_DISPLAY: Record<ThreadStatus, { label: string; tone: StatusTone }> = {
  intake: { label: "Intake", tone: "neutral" },
  "brief-draft": { label: "Brief draft", tone: "neutral" },
  "brief-confirmed": { label: "Brief confirmed", tone: "neutral" },
  configuring: { label: "Configuring run", tone: "neutral" },
  "research-queued": { label: "Research queued", tone: "active" },
  "research-running": { label: "Research running", tone: "active" },
  "research-complete": { label: "Research complete", tone: "done" },
  "ideas-generating": { label: "Generating ideas", tone: "active" },
  "ideas-ready": { label: "Ideas ready", tone: "done" },
  archived: { label: "Archived", tone: "muted" },
};

export function statusLabel(status: ThreadStatus | null | undefined): string {
  if (!status) return "Ready";
  return STATUS_DISPLAY[status]?.label ?? status;
}

export function statusTone(status: ThreadStatus | null | undefined): StatusTone {
  if (!status) return "muted";
  return STATUS_DISPLAY[status]?.tone ?? "neutral";
}

/** Statuses where the thread's own page is the live research progress view. */
export function isResearchStatus(status: ThreadStatus | null | undefined): boolean {
  return (
    status === "research-queued" ||
    status === "research-running" ||
    status === "research-complete" ||
    status === "ideas-generating"
  );
}
