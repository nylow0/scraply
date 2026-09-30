import { z } from "zod";
import type { DiscoveryDepth } from "./schemas";
import type { Scope } from "./structured-output-schemas";

const IdSchema = z.string().trim().min(1).max(128);
const ShortTextSchema = z.string().trim().min(1).max(1_000);
const SourceIdsSchema = z.array(IdSchema).min(1).max(20);
const BasisSchema = z.union([z.literal("brief"), SourceIdsSchema]);
// Strict provider schemas require every key. Null means omitted when the frame crosses back into the app.
function optionalFrameField<T extends z.ZodType>(schema: T) {
  return z.preprocess(value => value === null ? undefined : value, schema.optional());
}
const LANGUAGE_CODES = new Set("aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu".split(" "));
const COUNTRY_CODES = new Set("AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split(" "));

export const ResearchGoalKindSchema = z.enum([
  "market-opportunity", "competition-entry", "research-question", "community-or-personal", "process-improvement", "other",
]);
export const ResearchCriterionWeightSchema = z.enum(["must", "high", "normal"]);
export const ResearchCriterionSchema = z.object({
  id: IdSchema,
  name: ShortTextSchema,
  weight: ResearchCriterionWeightSchema,
  howJudged: ShortTextSchema,
  basis: BasisSchema,
}).strict();
export const ResearchConstraintSchema = z.object({
  text: ShortTextSchema,
  kind: z.enum(["eligibility", "time", "team", "resources", "scope"]),
  basis: BasisSchema,
}).strict();
export const ResearchVenueKindSchema = z.enum(["community", "issue-tracker", "social", "official", "publication"]);
export const ResearchVenueSchema = z.object({
  name: z.string().trim().min(1).max(200),
  domain: optionalFrameField(z.string().trim().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i, "Use a domain name without a URL or path.")),
  kind: ResearchVenueKindSchema,
}).strict();
export const ResearchAreaSchema = z.object({
  id: IdSchema,
  name: z.string().trim().min(1).max(200),
  whyRelevant: ShortTextSchema,
  affectedPeople: ShortTextSchema,
  venues: z.array(ResearchVenueSchema).min(1).max(8),
  region: optionalFrameField(z.string().refine(value => COUNTRY_CODES.has(value), "Use an ISO 3166-1 alpha-2 country code.")),
  exampleProblems: z.array(ShortTextSchema).max(5),
  included: z.boolean(),
  priority: z.number().int().min(1).max(12),
}).strict();

export const ResearchFrameSchema = z.object({
  version: optionalFrameField(z.literal(1)),
  goal: z.string().trim().min(1).max(4_000),
  goalKind: ResearchGoalKindSchema,
  contextFacts: z.array(z.object({ fact: ShortTextSchema, sourceIds: SourceIdsSchema }).strict()).max(20),
  successCriteria: z.array(ResearchCriterionSchema).min(1).max(12),
  constraints: z.array(ResearchConstraintSchema).max(20),
  languages: z.array(z.string().refine(value => LANGUAGE_CODES.has(value), "Use an ISO 639-1 language code.")).min(1).max(3),
  areas: z.array(ResearchAreaSchema).max(12),
  exclusions: z.array(ShortTextSchema).max(20),
  openQuestions: z.array(z.object({
    id: IdSchema,
    question: ShortTextSchema,
    whyItMatters: ShortTextSchema,
    options: z.array(z.string().trim().min(1).max(300)).max(8),
    answer: optionalFrameField(z.string().trim().min(1).max(2_000)),
  }).strict()).max(10),
}).strict().superRefine((frame, ctx) => {
  const unique = (values: readonly string[], path: string, label: string) => {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      const normalized = value.normalize("NFKC").toLocaleLowerCase("en");
      if (seen.has(normalized)) ctx.addIssue({ code: "custom", path: [path, index], message: `${label} must be unique.` });
      seen.add(normalized);
    });
  };
  unique(frame.areas.map(area => area.id), "areas", "Area IDs");
  unique(frame.areas.map(area => area.name), "areas", "Area names");
  unique(frame.successCriteria.map(criterion => criterion.id), "successCriteria", "Criterion IDs");
  unique(frame.openQuestions.map(question => question.id), "openQuestions", "Question IDs");
  unique(frame.languages, "languages", "Languages");
  if (!frame.languages.includes("en")) ctx.addIssue({ code: "custom", path: ["languages"], message: "English must be included." });
});

export const FrameSearchPlanSchema = z.object({
  queries: z.array(z.object({
    query: z.string().trim().min(1).max(500),
    reason: ShortTextSchema,
  }).strict()).max(5),
}).strict();

export const ResearchFrameOutputSchema = z.object({ frame: ResearchFrameSchema }).strict();

export const ResearchAreaRankingSchema = z.object({
  areas: z.array(z.object({
    areaId: IdSchema,
    rank: z.number().int().min(1).max(12),
    reason: ShortTextSchema,
    evidenceStrength: z.enum(["none", "weak", "strong"]),
    fit: z.enum(["meets", "partial", "fails", "unknown"]),
  }).strict()).max(12),
}).strict();

export type ResearchGoalKind = z.infer<typeof ResearchGoalKindSchema>;
export type ResearchFrameGoalKind = ResearchGoalKind;
export type ResearchCriterion = z.infer<typeof ResearchCriterionSchema>;
export type ResearchConstraint = z.infer<typeof ResearchConstraintSchema>;
export type ResearchVenue = z.infer<typeof ResearchVenueSchema>;
export type ResearchArea = z.infer<typeof ResearchAreaSchema>;
export type ResearchFrame = z.infer<typeof ResearchFrameSchema>;
export type FrameSearchPlan = z.infer<typeof FrameSearchPlanSchema>;
export type ResearchAreaRanking = z.infer<typeof ResearchAreaRankingSchema>;

/** Use at model and edit boundaries. Source provenance is checked against the saved frame inputs. */
export function parseResearchFrame(value: unknown, context: {
  purpose: "discovery" | "known-problem";
  sourceIds: readonly string[];
}): ResearchFrame {
  const frame = ResearchFrameSchema.parse(value);
  assertResearchFrameSemantics(frame, { sourceIds: context.sourceIds, knownProblem: context.purpose === "known-problem" });
  return frame;
}

export function assertResearchFrameSemantics(frame: ResearchFrame, context: {
  sourceIds: readonly string[];
  knownProblem: boolean;
}): void {
  if (context.knownProblem && frame.areas.length !== 0) throw new Error("Known-problem frames must have no research areas.");
  if (!context.knownProblem && !frame.areas.some(area => area.included)) throw new Error("Discovery frames need at least one included research area.");
  const suppliedIds = new Set(context.sourceIds);
  const references = [
    ...frame.contextFacts.map(fact => fact.sourceIds),
    ...frame.successCriteria.flatMap(criterion => criterion.basis === "brief" ? [] : [criterion.basis]),
    ...frame.constraints.flatMap(constraint => constraint.basis === "brief" ? [] : [constraint.basis]),
  ];
  for (const ids of references) {
    if (new Set(ids).size !== ids.length) throw new Error("Frame source IDs must be unique within each citation.");
    for (const id of ids) if (!suppliedIds.has(id)) throw new Error(`The frame cites an unknown source: ${id}`);
  }
}

/** Hypotheses stay in the frame; they never become observed facts in the scoped brief. */
export function scopeResearchArea(scope: Scope, area: ResearchArea, frame?: ResearchFrame): Scope {
  return {
    ...scope,
    domain: `${area.name}. ${area.whyRelevant}`,
    audience: area.affectedPeople,
    offLimits: [...new Set([...scope.offLimits, ...(frame?.exclusions ?? [])])],
  };
}

/** Mechanical selection uses actual qualifying counts, never the ranker's confidence label. */
export function selectResearchAreas(frame: ResearchFrame, ranking: ResearchAreaRanking,
  qualifyingFactCounts: Readonly<Record<string, number>>, depth: DiscoveryDepth): ResearchArea[] {
  const included = frame.areas.filter(area => area.included);
  const allowedIds = new Set(included.map(area => area.id));
  const ranks = new Map<string, number>();
  const usedRanks = new Set<number>();
  for (const item of ranking.areas) {
    if (!allowedIds.has(item.areaId) || ranks.has(item.areaId) || usedRanks.has(item.rank)) throw new Error("Area ranking must contain each included area once with a unique rank.");
    ranks.set(item.areaId, item.rank);
    usedRanks.add(item.rank);
  }
  if (ranks.size !== included.length) throw new Error("Area ranking is missing an included area.");
  const anyQualifying = included.some(area => (qualifyingFactCounts[area.id] ?? 0) > 0);
  const eligible = anyQualifying ? included.filter(area => (qualifyingFactCounts[area.id] ?? 0) > 0) : included;
  return eligible.sort((left, right) => ranks.get(left.id)! - ranks.get(right.id)!)
    .slice(0, { quick: 1, standard: 2, deep: 4 }[depth]);
}
