import type { Thread } from "../../shared/schemas";

export type StatusTone = "neutral" | "active" | "success" | "warn";

export function threadStatusLabel(status: Thread["status"]): string {
  const labels: Record<Thread["status"], string> = {
    draft: "Draft",
    intake: "Intake",
    "brief-draft": "Brief draft",
    "brief-confirmed": "Brief confirmed",
    configuring: "Configuring",
    "research-queued": "Queued",
    "research-running": "Researching",
    "research-complete": "Research done",
    "ideas-generating": "Generating ideas",
    "ideas-ready": "Ideas ready",
    archived: "Archived",
  };
  return labels[status] ?? status;
}

export function threadStatusTone(status: Thread["status"]): StatusTone {
  if (status === "research-running" || status === "ideas-generating" || status === "research-queued") return "active";
  if (status === "ideas-ready" || status === "research-complete") return "success";
  if (status === "brief-draft" || status === "intake") return "warn";
  return "neutral";
}
