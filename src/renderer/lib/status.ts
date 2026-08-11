import type { ThreadStatus } from "../../shared/schemas";

export type StatusTone = "neutral" | "active" | "done" | "muted";

const STATUS_DISPLAY: Record<ThreadStatus, { label: string; tone: StatusTone }> = {
  configuring: { label: "Configure scope", tone: "neutral" },
  "discovery-running": { label: "Discovering", tone: "active" },
  "problems-ready": { label: "Problems ready", tone: "done" },
  "development-running": { label: "Developing", tone: "active" },
  "solutions-ready": { label: "Solutions ready", tone: "done" },
  failed: { label: "Needs attention", tone: "neutral" },
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
  return status === "discovery-running" || status === "development-running";
}
