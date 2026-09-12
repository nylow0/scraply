import type { ThreadStatus } from "../../shared/schemas";

export type StatusTone = "neutral" | "active" | "done" | "muted" | "attention";

const STATUS_DISPLAY: Record<ThreadStatus, { label: string; tone: StatusTone }> = {
  configuring: { label: "Draft", tone: "neutral" },
  "discovery-running": { label: "Discovering", tone: "active" },
  "problems-ready": { label: "Problems ready", tone: "done" },
  "development-running": { label: "Developing", tone: "active" },
  "solutions-ready": { label: "Solutions ready", tone: "done" },
  failed: { label: "Needs attention", tone: "attention" },
  archived: { label: "Archived", tone: "muted" },
};

export function statusLabel(status: ThreadStatus | null | undefined): string {
  if (!status) return "Ready";
  return STATUS_DISPLAY[status].label;
}

export function statusTone(status: ThreadStatus | null | undefined): StatusTone {
  if (!status) return "muted";
  return STATUS_DISPLAY[status].tone;
}
