import type { ProblemCandidate, RejectedProblemCandidate } from "../../shared/ipc";

/**
 * The Research tab shows problems (confirmed or stated by the user) in the main list and
 * everything else as leads behind one "Show N more leads" button. Each lead carries one chip.
 */
export type LeadKind = "needs-evidence" | "not-checked" | "ruled-out";

export const LEAD_LABELS: Record<LeadKind, string> = {
  "needs-evidence": "Needs more evidence",
  "not-checked": "Not checked yet",
  "ruled-out": "Ruled out",
};

const LEAD_ORDER: LeadKind[] = ["needs-evidence", "not-checked", "ruled-out"];

/** A lead is either a checked problem that did not qualify, or a saved candidate. */
export type ProblemLead =
  | { kind: LeadKind; id: string; statement: string; problem: ProblemCandidate; candidate?: undefined }
  | { kind: LeadKind; id: string; statement: string; candidate: RejectedProblemCandidate; problem?: undefined };

export function isProblem(problem: ProblemCandidate): boolean {
  return problem.verdict === "confirmed" || problem.verdict === "user-asserted";
}

/**
 * `problems` may mix problems and checked leads (older runs keep both in one list).
 * `extraLeads` are the read-only leads a snapshot left behind in its source runs.
 */
export function problemLeads(problems: ProblemCandidate[], rejected: RejectedProblemCandidate[], extraLeads: ProblemCandidate[] = []): ProblemLead[] {
  const leads: ProblemLead[] = [
    ...[...problems.filter((problem) => !isProblem(problem)), ...extraLeads].map((problem): ProblemLead => ({
      kind: problem.verdict === "insufficient-evidence" ? "needs-evidence" : "ruled-out",
      id: problem.id, statement: problem.statement, problem,
    })),
    ...rejected.map((candidate): ProblemLead => ({
      kind: candidate.disposition === "not-assessed" ? "not-checked" : "ruled-out",
      id: candidate.id, statement: candidate.statement, candidate,
    })),
  ];
  return leads.sort((a, b) => LEAD_ORDER.indexOf(a.kind) - LEAD_ORDER.indexOf(b.kind));
}
