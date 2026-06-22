import type { ValidationState, WorkspaceState, ResearchEvent } from "../../shared/ipc";
import { hasOrchestratorFailure } from "./research-ui";

export type AppState = {
  loading: boolean;
  validation: ValidationState | null;
  workspace: WorkspaceState | null;
  error: string | null;
  researchEvents: ResearchEvent[];
  activeRunId: string | null;
  showDrawer: boolean;
  showGuide: boolean;
};

export const initialState: AppState = {
  loading: true,
  validation: null,
  workspace: null,
  error: null,
  researchEvents: [],
  activeRunId: null,
  showDrawer: false,
  showGuide: false,
};

/** Whether the activity log button should show a warning badge. */
export function shouldHighlightActivity(events: ResearchEvent[], showDrawer: boolean): boolean {
  return !showDrawer && hasOrchestratorFailure(events);
}

/** Whether research is actively running (has run id and not terminal). */
export function isRunActive(activeRunId: string | null, events: ResearchEvent[]): boolean {
  if (!activeRunId) return false;
  const terminal = new Set(["run-completed", "run-cancelled", "ideas-generated", "ideas-failed"]);
  return !events.some((e) => terminal.has(e.type));
}
