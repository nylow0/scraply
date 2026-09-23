import type { ProblemCandidate } from "../shared/ipc";

export type VibeProblemOrigin = "problem-evidence" | "user-asserted";
export type VibeBriefFit = "direct" | "partial" | "unknown" | "outside";
export type VibeContraryEvidence = "resolved" | "unknown" | "unresolved";

export interface VibeProblemCandidate extends Pick<ProblemCandidate,
  "id" | "statement" | "affected" | "verdict" | "evidenceGap" | "intendedBuyerEvidenceFactorIds"> {
  factors: ReadonlyArray<Pick<ProblemCandidate["factors"][number],
    "id" | "sourceId" | "sourceUrl" | "quote" | "sourceRole" | "audienceFit" | "independentSourceKey" | "supportsDemand">>;
  /** Supplied by an explicit review when available. Unknown fit is never promoted to direct fit. */
  briefFit?: VibeBriefFit | undefined;
  /** Stable identity for the buyer workflow. Without it, only identical statements are grouped. */
  workflowKey?: string | undefined;
  /** A saved evidence assessment may identify a contradiction that still needs investigation. */
  contraryEvidence?: VibeContraryEvidence | undefined;
}

export interface VibeProblemDecision {
  problemId: string;
  selected: boolean;
  origin: VibeProblemOrigin;
  reason: string;
  directObservationCount: number;
  independentSourceCount: number;
  sourceIds: string[];
  /** A buying signal is kept separate from proof that a problem exists. */
  demandSignalFactorIds: string[];
  briefFit: VibeBriefFit;
  contraryEvidence: VibeContraryEvidence;
}

export interface VibeSelectionResult {
  outcome: "selected" | "no-qualifying-problems";
  reason: string;
  selectedProblemIds: string[];
  rejectedProblemIds: string[];
  decisions: VibeProblemDecision[];
}

export interface VibeSelectionInput {
  candidates: readonly VibeProblemCandidate[];
  /** Discovery is the safe default. User assertions need the known-problem path. */
  purpose?: "discovery" | "known-problem";
  maxProblems?: number;
}

interface QualifiedCandidate {
  candidate: VibeProblemCandidate;
  decision: VibeProblemDecision;
  workflowKey: string;
}

/**
 * Chooses saved problems without making a provider call or changing a run. The evidence gate
 * checks the underlying cited observations; a model's "confirmed" verdict cannot pass alone.
 */
export function selectVibeProblems(input: VibeSelectionInput): VibeSelectionResult {
  const maxProblems = input.maxProblems ?? 3;
  if (!Number.isSafeInteger(maxProblems) || maxProblems < 1) {
    throw new Error("Automatic problem cap must be a positive integer.");
  }
  const ids = input.candidates.map((candidate) => candidate.id);
  if (new Set(ids).size !== ids.length) throw new Error("Problem IDs must be unique within a selection.");

  const purpose = input.purpose ?? "discovery";
  const qualified = input.candidates.map((candidate): QualifiedCandidate => {
    const citedIds = new Set(candidate.intendedBuyerEvidenceFactorIds);
    const directFactors = candidate.factors.filter((factor) => citedIds.has(factor.id)
      && factor.audienceFit === "intended-buyer"
      && (factor.sourceRole === "firsthand" || factor.sourceRole === "measured")
      && factor.sourceId.trim().length > 0
      && factor.sourceUrl.trim().length > 0
      && factor.quote.trim().length > 0);
    const identifiedFactors = directFactors.filter((factor) => factor.independentSourceKey?.trim());
    const sourceIds = [...new Set(identifiedFactors.map((factor) => factor.sourceId))].sort();
    const sourceKeys = new Set(identifiedFactors.map((factor) => factor.independentSourceKey!.trim()));
    const demandSignalFactorIds = identifiedFactors.filter((factor) => factor.supportsDemand === true)
      .map((factor) => factor.id).sort();
    const briefFit = candidate.briefFit ?? "unknown";
    const contraryEvidence = candidate.contraryEvidence ?? "unknown";
    const origin: VibeProblemOrigin = candidate.verdict === "user-asserted" ? "user-asserted" : "problem-evidence";
    const knownProblem = purpose === "known-problem" && origin === "user-asserted";
    const eligible = knownProblem || origin === "problem-evidence"
      && candidate.verdict === "confirmed"
      && !candidate.evidenceGap?.trim()
      && contraryEvidence !== "unresolved"
      && briefFit !== "outside"
      && identifiedFactors.length > 0;
    let reason: string;

    if (knownProblem) {
      reason = "The user supplied this known problem. Its origin remains user-asserted; discovery evidence and buyer demand are not implied.";
    } else if (origin === "user-asserted") {
      reason = "A user-asserted problem can only be selected from an explicit known-problem launch.";
    } else if (candidate.verdict !== "confirmed") {
      reason = `The saved evidence verdict is ${candidate.verdict}; the problem does not qualify for unattended generation.`;
    } else if (candidate.evidenceGap?.trim()) {
      reason = `The evidence gap remains open: ${candidate.evidenceGap.trim()}`;
    } else if (contraryEvidence === "unresolved") {
      reason = "Contradictory evidence remains unresolved.";
    } else if (briefFit === "outside") {
      reason = "The saved review places this problem outside the launch brief or intended buyer.";
    } else if (directFactors.length === 0) {
      reason = "No cited firsthand or measured intended-buyer observation has a source and quote. A confirmed label alone is insufficient.";
    } else if (identifiedFactors.length === 0) {
      reason = "The direct observation lacks an independent source key, so its fit and independence cannot be checked.";
    } else {
      const count = sourceKeys.size;
      const fit = briefFit === "unknown" ? "Brief fit was not separately assessed. " : briefFit === "partial" ? "Brief fit is partial. " : "";
      const contradiction = contraryEvidence === "unknown" ? "Contradictions were not separately classified. " : "";
      reason = `${count} independent intended-buyer source${count === 1 ? "" : "s"} support${count === 1 ? "s" : ""} the problem. ${fit}${contradiction}Buyer demand is not established by this selection.`;
    }

    return {
      candidate,
      workflowKey: normalize(candidate.workflowKey?.trim() || candidate.statement),
      decision: {
        problemId: candidate.id,
        selected: eligible,
        origin, reason,
        directObservationCount: directFactors.length,
        independentSourceCount: sourceKeys.size,
        sourceIds, demandSignalFactorIds, briefFit, contraryEvidence,
      },
    };
  });

  const selected: QualifiedCandidate[] = [];
  const workflowKeys = new Set<string>();
  for (const entry of qualified.filter((item) => item.decision.selected).sort(compareCandidates)) {
    if (workflowKeys.has(entry.workflowKey)) {
      entry.decision.selected = false;
      entry.decision.reason = "A stronger selected problem already covers this buyer workflow.";
    } else if (selected.length >= maxProblems) {
      entry.decision.selected = false;
      entry.decision.reason = `The automatic selection cap of ${maxProblems} problem${maxProblems === 1 ? "" : "s"} was reached.`;
    } else {
      selected.push(entry);
      workflowKeys.add(entry.workflowKey);
    }
  }

  const decisions = qualified.map((item) => item.decision);
  const selectedProblemIds = selected.map((item) => item.candidate.id);
  return {
    outcome: selectedProblemIds.length > 0 ? "selected" : "no-qualifying-problems",
    reason: selectedProblemIds.length > 0
      ? `${selectedProblemIds.length} problem${selectedProblemIds.length === 1 ? "" : "s"} selected for unattended idea generation.`
      : "No problem qualified for unattended idea generation. Zero ideas will be generated; keep the saved research available for review.",
    selectedProblemIds,
    rejectedProblemIds: decisions.filter((decision) => !decision.selected).map((decision) => decision.problemId),
    decisions,
  };
}

function compareCandidates(a: QualifiedCandidate, b: QualifiedCandidate): number {
  const fitRank: Record<VibeBriefFit, number> = { direct: 3, partial: 2, unknown: 1, outside: 0 };
  return fitRank[b.decision.briefFit] - fitRank[a.decision.briefFit]
    || b.decision.independentSourceCount - a.decision.independentSourceCount
    || b.decision.directObservationCount - a.decision.directObservationCount
    || a.candidate.id.localeCompare(b.candidate.id);
}

function normalize(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}
