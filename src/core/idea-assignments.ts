import type { DatabaseClient } from "../db/client";
import type { WorkflowGenerationAngle } from "./development";

interface ProblemContext {
  statement: string;
  affected: string;
  why_it_persists: string;
  workflow_key: string | null;
  contrary_evidence: string;
  evidence_gap: string | null;
}

interface FactorContext {
  id: string;
  subject: string;
  behavior: string;
}

/** Prefer distinct saved observations and constraints; expose sparse context instead of inventing facts. */
export function initialGenerationAngles(db: DatabaseClient, problemId: string, batchCount: number): WorkflowGenerationAngle[] {
  const problem = db.db.prepare(`SELECT statement, affected, why_it_persists, workflow_key,
    contrary_evidence, evidence_gap FROM problems WHERE id = ?`).get(problemId) as ProblemContext | undefined;
  if (!problem) throw new Error("The selected problem is unavailable for idea assignment.");
  const factors = db.db.prepare(`SELECT f.id, f.subject, f.behavior FROM problem_factors pf
    JOIN factors f ON f.id = pf.factor_id WHERE pf.problem_id = ? ORDER BY pf.rowid, f.id`)
    .all(problemId) as FactorContext[];
  const anchors: Array<{ id: string; name: string; angle: string }> = [];
  for (const factor of factors) {
    if (!factor.subject.trim() || !factor.behavior.trim()) continue;
    anchors.push({ id: `factor:${factor.id}`, name: factor.subject.trim(),
      angle: `Address this saved observation for ${problem.affected || "the affected user"}: ${factor.subject}: ${factor.behavior}. Design a mechanism for the selected problem, ${problem.statement}.` });
  }
  if (problem.workflow_key?.trim()) anchors.push({ id: "workflow", name: "Workflow boundary",
    angle: `Change a specific step, handoff, or decision in the saved workflow ${problem.workflow_key}. Show how the mechanism addresses ${problem.statement}.` });
  if (problem.why_it_persists.trim()) anchors.push({ id: "persistence", name: "Persistent blocker",
    angle: `Remove or work around the saved reason this problem persists: ${problem.why_it_persists}. Address ${problem.statement} for ${problem.affected || "the affected user"}.` });
  if (problem.contrary_evidence.trim()) anchors.push({ id: "contrary", name: "Contrary evidence",
    angle: `Find a mechanism that still makes sense in light of this saved contrary evidence: ${problem.contrary_evidence}. Address ${problem.statement} without claiming the contrary evidence is proof of demand.` });
  if (problem.evidence_gap?.trim()) anchors.push({ id: "unknown", name: "Unresolved evidence",
    angle: `Design a testable mechanism for ${problem.statement} while keeping this saved evidence gap explicit: ${problem.evidence_gap}. Do not claim the gap has been resolved.` });
  if (anchors.length === 0) anchors.push({ id: "problem", name: "Selected problem",
    angle: `Address the saved problem ${problem.statement} for ${problem.affected || "the affected user"}. Return fewer ideas if distinct mechanisms are not supported by the saved context.` });
  const unique = [...new Map(anchors.map((anchor) => [anchor.angle.toLocaleLowerCase(), anchor])).values()];
  return Array.from({ length: batchCount }, (_, batch) => {
    const anchor = unique[batch % unique.length]!;
    const repeat = Math.floor(batch / unique.length);
    return {
      gapId: `initial:${problemId}:${anchor.id}:${repeat}`.slice(0, 160),
      name: anchor.name.slice(0, 160),
      angle: (repeat === 0 ? anchor.angle
        : `${anchor.angle} Explore a materially different operating mechanism from earlier batches; return fewer ideas if none remains.`).slice(0, 1_000),
    };
  });
}

export function fillGenerationAngle(db: DatabaseClient, problemId: string, assignmentIndex: number,
  acceptedMechanisms: string[]): WorkflowGenerationAngle {
  const angle = initialGenerationAngles(db, problemId, assignmentIndex + 1)[assignmentIndex]!;
  const comparisons = Array.from({ length: Math.min(3, acceptedMechanisms.length) }, (_, index) =>
    acceptedMechanisms[(assignmentIndex * 3 + index) % acceptedMechanisms.length]!);
  const prior = comparisons.length ? ` Compare against these saved accepted mechanisms: ${comparisons.join("; ")}.` : "";
  return { ...angle, gapId: `${angle.gapId}:fill`.slice(0, 160),
    angle: `${angle.angle}${prior} Return fewer or no ideas when the saved context cannot support a materially different mechanism.`.slice(0, 1_000) };
}
