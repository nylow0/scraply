export type ResearchRequestKind = "new-question" | "redo" | "reevaluate";

export interface ResearchRequestDraft {
  kind: ResearchRequestKind;
  question: string;
  targetFindingId?: string | undefined;
  targetRequestId?: string | undefined;
  angles?: string[] | undefined;
  instructions?: string | undefined;
  allowance: { maxModelCalls: number; maxSearches: number; maxMinutes: number };
}

export interface ResearchReplacement {
  oldFindingId: string;
  newFindingId: string;
}

export interface ResearchFindingComparison {
  statementChanged: boolean;
  verdictChanged: boolean;
  addedSourceIds: string[];
  removedSourceIds: string[];
  addedFactorIds: string[];
  removedFactorIds: string[];
  previousGap: string | null;
  proposedGap: string | null;
}

export interface ResearchFindingView {
  id: string;
  statement: string;
  verdict: string;
  verdictReason: string;
  evidenceGap: string | null;
  supportingSources: { id: string; title: string; url: string }[];
  verdictSources: { id: string; title: string; url: string }[];
}

export interface ResearchRequestView {
  id: string;
  kind: ResearchRequestKind;
  question: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  targetFindingId?: string | undefined;
  previousFinding?: ResearchFindingView | undefined;
  resultFindings: ResearchFindingView[];
  angles?: ResearchAngleView[] | undefined;
  archived?: boolean | undefined;
  appliedSnapshotId?: string | undefined;
  reviewDecision?: "kept-current" | undefined;
  error?: string | undefined;
}

export type ResearchAngleSourceClass = "firsthand-experience" | "measured-behavior"
  | "current-alternative" | "buying-signal" | "contrary-evidence" | "saved-evidence";

export interface ResearchAngleView {
  id: string;
  name: string;
  sourceClass: ResearchAngleSourceClass;
  acceptanceCriterion: string;
  status: "planned" | "running" | "completed" | "failed" | "omitted";
  query?: string | undefined;
  sourceCount?: number | undefined;
  sources?: Array<{ title: string; url: string }> | undefined;
  gap?: string | undefined;
}

export interface ResearchAngleProposal {
  name: string;
  sourceClass: ResearchAngleSourceClass;
  acceptanceCriterion: string;
}

export function researchSearchAllocation(maxSearches: number): {
  domainQueries: number; audienceQueries: number; candidateLimit: number; modelCalls: number;
} {
  const searches = Math.max(0, Math.floor(maxSearches));
  const plannedQueries = Math.min(6, searches < 2 ? searches : Math.max(2, searches - 4));
  const domainQueries = Math.ceil(plannedQueries / 2);
  const audienceQueries = Math.floor(plannedQueries / 2);
  const candidateLimit = Math.min(4, Math.max(0, searches - plannedQueries));
  const domainBatches = Math.max(1, Math.ceil(domainQueries * 4 * 6_000 / 60_000));
  const audienceBatches = Math.max(1, Math.ceil(audienceQueries * 4 * 6_000 / 30_000));
  return {
    domainQueries, audienceQueries, candidateLimit,
    modelCalls: 2 + domainBatches + audienceBatches + 1 + candidateLimit,
  };
}

const DEFAULT_ANGLES: ResearchAngleProposal[] = [
  { name: "Firsthand problem reports", sourceClass: "firsthand-experience",
    acceptanceCriterion: "Find an attributable account from someone in the intended buyer group." },
  { name: "Existing alternatives", sourceClass: "current-alternative",
    acceptanceCriterion: "Identify what the intended buyer uses now and where it falls short." },
  { name: "Buying or adoption behavior", sourceClass: "buying-signal",
    acceptanceCriterion: "Find attributable adoption, payment, or purchase-attempt evidence." },
  { name: "Contrary evidence", sourceClass: "contrary-evidence",
    acceptanceCriterion: "Look for evidence that the need is already solved, narrower, or overstated." },
];

function sourceClassFor(name: string): ResearchAngleSourceClass {
  if (/contrary|against|disprov|overstat|already solved|failure/i.test(name)) return "contrary-evidence";
  if (/alternativ|substitut|competitor|current tool|existing/i.test(name)) return "current-alternative";
  if (/buy|paid|payment|purchase|adopt/i.test(name)) return "buying-signal";
  if (/measure|usage|observed|quantif/i.test(name)) return "measured-behavior";
  return "firsthand-experience";
}

export function previewResearchAngles(
  kind: ResearchRequestKind, namedAngles: string[] | undefined,
  allowance: { maxSearches: number },
): { planned: ResearchAngleProposal[]; omitted: ResearchAngleProposal[] } {
  if (kind === "reevaluate") return {
    planned: [{ name: "Saved evidence review", sourceClass: "saved-evidence",
      acceptanceCriterion: "Reassess the selected finding using only its saved sources and factors." }], omitted: [],
  };
  const supplied = [...new Map((namedAngles ?? []).map((raw) => raw.trim()).filter(Boolean)
    .map((name) => [name.toLocaleLowerCase(), name])).values()]
    .map((name): ResearchAngleProposal => ({ name, sourceClass: sourceClassFor(name),
      acceptanceCriterion: `Find evidence that answers the ${name.toLocaleLowerCase()} angle for the selected buyer.` }));
  const candidates = supplied.length ? [...supplied] : [...DEFAULT_ANGLES];
  if (candidates.length < 4 && !candidates.some((angle) => angle.sourceClass === "contrary-evidence")) {
    candidates.push(DEFAULT_ANGLES[3]!);
  }
  const unique = [...new Map(candidates.map((angle) => [angle.name.toLocaleLowerCase(), angle])).values()];
  // A quick discovery can spend four searches testing candidate problems. Reserve those
  // before assigning named angles to its six planned evidence searches.
  const allocation = researchSearchAllocation(allowance.maxSearches);
  const slots = Math.min(4, allocation.domainQueries + allocation.audienceQueries);
  const planned = unique.slice(0, slots);
  if (slots >= 2 && !planned.some((angle) => angle.sourceClass === "contrary-evidence")) {
    const contrary = unique.find((angle) => angle.sourceClass === "contrary-evidence");
    if (contrary) planned[planned.length - 1] = contrary;
  }
  const plannedNames = new Set(planned.map((angle) => angle.name.toLowerCase()));
  return { planned, omitted: unique.filter((angle) => !plannedNames.has(angle.name.toLowerCase())) };
}
