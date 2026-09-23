import type { WorkflowSession } from "../db/repositories/workflows";

/** Deduct elapsed active time without increasing the saved allowance if the clock moves back. */
export function remainingWorkflowMs(
  session: Pick<WorkflowSession, "remainingMs" | "runningSince">,
  now = Date.now(),
): number {
  const elapsed = session.runningSince ? Math.max(0, now - Date.parse(session.runningSince)) : 0;
  return Math.max(0, session.remainingMs - elapsed);
}
