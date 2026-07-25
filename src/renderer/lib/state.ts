import type { ValidationState, WorkspaceState, ResearchEvent } from "../../shared/ipc";

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
