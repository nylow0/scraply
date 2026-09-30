import { DISCOVERY_DEPTHS } from "./discovery-projection";
import type { DiscoveryDepth } from "./schemas";
import type { ResearchGoalKind } from "./research-frame";

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

export function researchSearchAllocation(maxSearches: number, depth: DiscoveryDepth = "quick", pairedFirsthand = true, languageCount = 1): {
  domainQueries: number; audienceQueries: number; candidateLimit: number; modelCalls: number; searchLegs: number;
} {
  const searches = Math.max(0, Math.floor(maxSearches));
  const candidateCap = DISCOVERY_DEPTHS[depth].candidateLimit;
  const legsPerQuestion = pairedFirsthand ? 2 * Math.max(1, Math.min(3, Math.floor(languageCount))) : 1;
  // An explicit allowance must fit even when every planned question asks for firsthand evidence.
  // Preserve two research phases before allocating candidate verdicts from the remaining searches.
  const plannedQueries = Math.min(6, searches < 2 * legsPerQuestion ? Math.floor(searches / legsPerQuestion)
    : Math.max(2, Math.floor((searches - candidateCap) / legsPerQuestion)));
  const domainQueries = Math.ceil(plannedQueries / 2);
  const audienceQueries = Math.floor(plannedQueries / 2);
  const candidateLimit = Math.min(candidateCap, Math.max(0, searches - plannedQueries * legsPerQuestion));
  const domainBatches = domainQueries === 0 ? 0 : Math.max(1, Math.ceil(domainQueries * legsPerQuestion * 4 * 6_000 / 60_000));
  const audienceBatches = audienceQueries === 0 ? 0 : Math.max(1, Math.ceil(audienceQueries * legsPerQuestion * 4 * 6_000 / 30_000));
  return {
    domainQueries, audienceQueries, candidateLimit,
    modelCalls: Number(domainQueries > 0) + Number(audienceQueries > 0) + domainBatches + audienceBatches + 1 + candidateLimit,
    searchLegs: plannedQueries * legsPerQuestion + candidateLimit,
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

/** Follow-up evidence keeps the project's goal instead of assuming a paying buyer. */
export function researchAnglesForGoal(goalKind?: ResearchGoalKind): ResearchAngleProposal[] {
  const contrary = DEFAULT_ANGLES[3]!;
  const alternatives = { name: "Existing approaches and tools", sourceClass: "current-alternative" as const,
    acceptanceCriterion: "Compare existing approaches against the goal and the approved criteria." };
  if (!goalKind || goalKind === "market-opportunity") return [...DEFAULT_ANGLES];
  if (goalKind === "research-question") return [
    { name: "Measured outcomes and datasets", sourceClass: "measured-behavior", acceptanceCriterion: "Find measured results, methods, and datasets that can test the research question." },
    { name: "Practitioner and participant accounts", sourceClass: "firsthand-experience", acceptanceCriterion: "Find attributable accounts from the affected people and implementers." },
    alternatives, contrary,
  ];
  if (goalKind === "competition-entry") return [
    { name: "Problem scale and affected people", sourceClass: "measured-behavior", acceptanceCriterion: "Find evidence of the problem's reach and importance to the affected people." },
    alternatives,
    { name: "Buildability and demonstration", sourceClass: "firsthand-experience", acceptanceCriterion: "Find real attempts, constraints, and measurable tests within the team's resources." }, contrary,
  ];
  return [
    { name: "Affected people's experience", sourceClass: "firsthand-experience", acceptanceCriterion: "Find attributable accounts from the people who would use the proposed change." },
    alternatives,
    { name: "Adoption and sustained outcomes", sourceClass: "measured-behavior", acceptanceCriterion: "Find observed use, maintenance effort, and outcomes over time within the approved constraints." }, contrary,
  ];
}

function sourceClassFor(name: string, goalKind?: ResearchGoalKind): ResearchAngleSourceClass {
  if (/contrary|against|disprov|overstat|already solved|failure/i.test(name)) return "contrary-evidence";
  if (/alternativ|substitut|competitor|current tool|existing/i.test(name)) return "current-alternative";
  if (/buy|paid|payment|purchase/i.test(name)) return "buying-signal";
  if (/adopt/i.test(name)) return goalKind && goalKind !== "market-opportunity" ? "measured-behavior" : "buying-signal";
  if (/measure|usage|observed|quantif/i.test(name)) return "measured-behavior";
  return "firsthand-experience";
}

export function previewResearchAngles(
  kind: ResearchRequestKind, namedAngles: string[] | undefined,
  allowance: { maxSearches: number },
  goalKind?: ResearchGoalKind,
  routing?: { depth?: DiscoveryDepth; languageCount?: number; pairedFirsthand?: boolean },
): { planned: ResearchAngleProposal[]; omitted: ResearchAngleProposal[] } {
  if (kind === "reevaluate") return {
    planned: [{ name: "Saved evidence review", sourceClass: "saved-evidence",
      acceptanceCriterion: "Reassess the selected finding using only its saved sources and factors." }], omitted: [],
  };
  const supplied = [...new Map((namedAngles ?? []).map((raw) => raw.trim()).filter(Boolean)
    .map((name) => [name.toLocaleLowerCase(), name])).values()]
    .map((name): ResearchAngleProposal => ({ name, sourceClass: sourceClassFor(name, goalKind),
      acceptanceCriterion: goalKind && goalKind !== "market-opportunity"
        ? `Find evidence that answers the ${name.toLocaleLowerCase()} angle for the approved goal and affected people.`
        : `Find evidence that answers the ${name.toLocaleLowerCase()} angle for the selected buyer.` }));
  const candidates = supplied.length ? [...supplied] : researchAnglesForGoal(goalKind);
  if (candidates.length < 4 && !candidates.some((angle) => angle.sourceClass === "contrary-evidence")) {
    candidates.push(DEFAULT_ANGLES[3]!);
  }
  const unique = [...new Map(candidates.map((angle) => [angle.name.toLocaleLowerCase(), angle])).values()];
  // Angles describe questions; allocation reserves their worst-case paired search legs first.
  const allocation = researchSearchAllocation(allowance.maxSearches, routing?.depth, routing?.pairedFirsthand, routing?.languageCount);
  const slots = Math.min(4, allocation.domainQueries + allocation.audienceQueries);
  const planned = unique.slice(0, slots);
  if (slots >= 2 && !planned.some((angle) => angle.sourceClass === "contrary-evidence")) {
    const contrary = unique.find((angle) => angle.sourceClass === "contrary-evidence");
    if (contrary) planned[planned.length - 1] = contrary;
  }
  const plannedNames = new Set(planned.map((angle) => angle.name.toLowerCase()));
  return { planned, omitted: unique.filter((angle) => !plannedNames.has(angle.name.toLowerCase())) };
}
