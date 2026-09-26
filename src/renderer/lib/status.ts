import type { ProblemCandidate } from "../../shared/ipc";
import type { Thread, ThreadStatus } from "../../shared/schemas";

const VERDICT_LABELS: Partial<Record<string, string>> = {
  confirmed: "Confirmed",
  overstated: "Overstated",
  "already-solved": "Already solved",
  "insufficient-evidence": "Insufficient evidence",
  "attempted-and-failed": "Earlier attempts failed",
  "user-asserted": "User-stated",
} satisfies Record<ProblemCandidate["verdict"], string>;

// Problem verdicts are stored as codes. Screens show these words; a code this list does not know yet
// (research findings type it as a plain string) still reads as words rather than a hyphenated key.
export function verdictLabel(verdict: string): string {
  return VERDICT_LABELS[verdict] ?? verdict.charAt(0).toUpperCase() + verdict.slice(1).replaceAll("-", " ");
}

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

// Older saved projects can be archived by status alone, without an archive timestamp.
export function isArchived(thread: Pick<Thread, "archivedAt" | "status">): boolean {
  return Boolean(thread.archivedAt) || thread.status === "archived";
}

export function needsAttention(status: ThreadStatus): boolean {
  return status.endsWith("running") || status === "failed";
}

export function statusTone(status: ThreadStatus | null | undefined): StatusTone {
  if (!status) return "muted";
  return STATUS_DISPLAY[status].tone;
}
