import type { WorkflowDetail } from "../../shared/workflow-contracts";

/** Counts are null until the backend has recorded candidate decisions for this area. */
export type InvestigatorLane = {
  taskId: string;
  areaId: string;
  areaName: string;
  state: WorkflowDetail["tasks"][number]["state"];
  currentStep: string | null;
  confirmedCount: number | null;
  insufficientCount: number | null;
  droppedCount: number | null;
};
