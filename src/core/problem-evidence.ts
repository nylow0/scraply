import type { ProblemFactorAssessment } from "../shared/structured-output-schemas";

/** Reviews are scoped to one problem; extraction labels and quotes remain immutable. */
export function applyProblemFactorAssessments<T extends { id: string }>(factors: T[], assessments: readonly ProblemFactorAssessment[]): T[] {
  const byId = new Map(assessments.map(assessment => [assessment.factorId, assessment]));
  return factors.map(factor => {
    const assessment = byId.get(factor.id);
    return assessment ? { ...factor, sourceRole: assessment.sourceRole, audienceFit: assessment.audienceFit,
      independentSourceKey: assessment.independentSourceKey } : factor;
  });
}

export const PROBLEM_AUDIENCE_ASSESSMENT_INSTRUCTION = `
Problem audience assessment v1:
The saved scope audience is blank: this is discovery of relevant problems and their affected users, not a request to invent a predefined buyer.
Evaluate briefFit against the saved domain, observations, offLimits, and riskEvaluationCriteria. A blank audience alone is not a missing brief fit.
For this candidate only, assess every supplied supporting factor against candidate.affected and the recurring task in the statement. Return one factorAssessments item per supplied factor, using its exact factorId. Do not add factors, change quotes, or assume their initial unknown/legacy classification means they are unusable.
Independently review sourceRole from the quoted passage and supplied source context: firsthand is an actor's actual account, measured is observed behavior or outcomes, vendor is an offer, recommendation is advice, illustration is hypothetical/catalog information, and unknown is unresolved. A procurement requirement alone does not measure an unresolved failure.
Use audienceFit intended-buyer only for an observation directly about these affected users performing this task; adjacent/general/unknown remain available. This classification establishes problem relevance, not buying intent or willingness to pay.
Use independentSourceKey for the underlying actor, study, or observation origin, not each URL. Syndication, reports of the same study, and pages from the same dataset share a key. Use null when independence cannot be established. Explain each classification briefly in reason.
Use these explicit per-problem assessments for intendedBuyerEvidenceFactorIds and evidenceGap. Confirmed still requires at least two independent firsthand or measured relevant observations and an explanation of material contrary evidence. Keep unsupported causes, missing demand evidence, and unresolved contradictions visible. Never upgrade evidence merely to meet an idea target.
`;
