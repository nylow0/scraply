import { z } from "zod";
import type { OpportunityExplorationCounts } from "./opportunity-exploration";

const EntityIdSchema = z.string().trim().min(1).max(128);
const ReviewTextSchema = z.string().trim().min(1).max(4_000);
const CompactTextSchema = z.string().trim().min(1).max(2_000);

export const OpportunityRelationshipSchema = z.enum([
  "duplicate",
  "variant",
  "separate-business",
  "uncertain",
]);

export const OpportunityMembershipStateSchema = z.enum(["accepted", "unresolved"]);
export const OpportunityDecisionActorSchema = z.enum(["model", "user"]);

export const OpportunityCandidateSnapshotSchema = z.object({
  optionId: EntityIdSchema,
  runId: EntityIdSchema,
  problemId: EntityIdSchema,
  problemStatement: CompactTextSchema,
  mechanism: CompactTextSchema,
  businessDescription: CompactTextSchema,
  buyer: CompactTextSchema.nullable(),
  payingDecisionMaker: CompactTextSchema.nullable(),
  buyingTrigger: CompactTextSchema.nullable(),
  jobToBeDone: CompactTextSchema.nullable(),
  coreWorkflow: CompactTextSchema.nullable(),
  currentSubstitute: CompactTextSchema.nullable(),
  eligibleStartup: z.boolean(),
}).strict();

export const OpportunityCompactMemberSchema = z.object({
  optionId: EntityIdSchema,
  mechanism: CompactTextSchema,
  businessDescription: CompactTextSchema,
  relationship: OpportunityRelationshipSchema.exclude(["uncertain"]),
  buyer: CompactTextSchema.nullable(),
  buyingTrigger: CompactTextSchema.nullable(),
  coreWorkflow: CompactTextSchema.nullable(),
  currentSubstitute: CompactTextSchema.nullable(),
}).strict();

export const OpportunityCompactFamilySchema = z.object({
  familyId: EntityIdSchema,
  title: CompactTextSchema,
  summary: CompactTextSchema,
  representativeOptionId: EntityIdSchema,
  members: z.array(OpportunityCompactMemberSchema).min(1),
}).strict();

export const OpportunityComparisonTargetSchema = z.union([
  z.object({ kind: z.literal("family"), id: EntityIdSchema }).strict(),
  z.object({ kind: z.literal("candidate"), id: EntityIdSchema }).strict(),
  z.object({ kind: z.literal("unresolved-option"), id: EntityIdSchema }).strict(),
]);

export const OpportunityCandidateAssessmentSchema = z.object({
  candidateOptionId: EntityIdSchema,
  status: z.enum(["reviewable", "uncertain"]),
  reason: ReviewTextSchema,
}).strict();

export const OpportunityComparisonSchema = z.object({
  candidateOptionId: EntityIdSchema,
  target: OpportunityComparisonTargetSchema,
  relationship: OpportunityRelationshipSchema,
  reason: ReviewTextSchema,
  concreteDistinctionOrOverlap: ReviewTextSchema,
}).strict();

export const OpportunityReviewOutputSchema = z.object({
  assessments: z.array(OpportunityCandidateAssessmentSchema),
  comparisons: z.array(OpportunityComparisonSchema),
}).strict();

export const OpportunityReviewCoverageSchema = z.object({
  reviewCallId: EntityIdSchema,
  candidateOptionId: EntityIdSchema,
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("self") }).strict(),
    OpportunityComparisonTargetSchema.options[0],
    OpportunityComparisonTargetSchema.options[1],
    OpportunityComparisonTargetSchema.options[2],
  ]),
  relationship: OpportunityRelationshipSchema.nullable(),
  complete: z.boolean(),
  reason: z.string(),
}).strict();

export const OpportunityMembershipSchema = z.object({
  decisionId: EntityIdSchema,
  optionId: EntityIdSchema,
  familyId: EntityIdSchema.nullable(),
  relationship: OpportunityRelationshipSchema,
  state: OpportunityMembershipStateSchema,
  reason: z.string(),
  decidedBy: OpportunityDecisionActorSchema,
  decidedAt: z.string().datetime(),
  mechanism: z.string(),
  description: z.string(),
  eligibleStartup: z.boolean(),
  discarded: z.boolean(),
}).strict();

export const OpportunityFamilySchema = z.object({
  id: EntityIdSchema,
  title: z.string(),
  summary: z.string(),
  representativeOptionId: EntityIdSchema,
  active: z.boolean(),
  createdAt: z.string().datetime(),
  members: z.array(OpportunityMembershipSchema),
  counted: z.boolean(),
}).strict();

export const OpportunityUnresolvedSchema = z.object({
  membership: OpportunityMembershipSchema,
  suggestedFamilyId: EntityIdSchema.nullable(),
}).strict();

export const OpportunityFamiliesViewSchema = z.object({
  rawOptionCount: z.number().int().nonnegative(),
  reviewedOptionCount: z.number().int().nonnegative(),
  acceptedFamilyCount: z.number().int().nonnegative(),
  families: z.array(OpportunityFamilySchema),
  unresolved: z.array(OpportunityUnresolvedSchema),
  unreviewedOptionIds: z.array(EntityIdSchema),
  lastReviewedAt: z.string().datetime().nullable(),
  reviewStatus: z.enum(["not-reviewed", "running", "completed", "failed", "blocked"]),
  reviewError: z.string().nullable(),
}).strict();

export const OpportunityReviewExportSchema = z.object({
  schemaVersion: z.literal(1),
  threadId: EntityIdSchema,
  view: OpportunityFamiliesViewSchema,
  reviews: z.array(z.object({
    id: EntityIdSchema,
    batchKey: z.string(),
    batchIndex: z.number().int().nonnegative(),
    chunkIndex: z.number().int().nonnegative(),
    correctionNumber: z.union([z.literal(0), z.literal(1)]),
    correctionOfId: EntityIdSchema.nullable(),
    model: z.object({ providerId: z.string(), modelId: z.string(), reasoningEffort: z.string() }).strict(),
    status: z.enum(["prepared", "dispatched", "accepted", "completed", "failed", "cancelled", "interrupted"]),
    request: z.unknown(),
    requestSha256: z.string(),
    runtimeIdentity: z.unknown().nullable(),
    output: OpportunityReviewOutputSchema.nullable(),
    metadata: z.unknown().nullable(),
    error: z.string().nullable(),
    createdAt: z.string().datetime(),
    terminalAt: z.string().datetime().nullable(),
  }).strict()),
  coverage: z.array(z.object({
    reviewCallId: EntityIdSchema,
    candidateOptionId: EntityIdSchema,
    targetKind: z.enum(["self", "family", "candidate", "unresolved-option"]),
    targetId: z.string(),
    relationship: OpportunityRelationshipSchema.nullable(),
    complete: z.boolean(),
    reason: z.string(),
  }).strict()),
  familyEvents: z.array(z.object({
    id: EntityIdSchema,
    familyId: EntityIdSchema,
    eventType: z.enum(["created", "merged", "reactivated"]),
    relatedFamilyId: EntityIdSchema.nullable(),
    reason: z.string(),
    actor: OpportunityDecisionActorSchema,
    createdAt: z.string().datetime(),
  }).strict()),
  membershipHistory: z.array(z.object({
    id: EntityIdSchema,
    optionId: EntityIdSchema,
    familyId: EntityIdSchema.nullable(),
    relationship: OpportunityRelationshipSchema,
    state: OpportunityMembershipStateSchema,
    reason: z.string(),
    actor: OpportunityDecisionActorSchema,
    reviewCallId: EntityIdSchema.nullable(),
    supersedesId: EntityIdSchema.nullable(),
    createdAt: z.string().datetime(),
  }).strict()),
}).strict();

const HumanReasonSchema = z.string().trim().min(1).max(2_000);
export const OpportunityMembershipEditSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("split"),
    optionId: EntityIdSchema,
    title: z.string().trim().min(1).max(256),
    summary: z.string().trim().min(1).max(2_000),
    reason: HumanReasonSchema,
  }).strict(),
  z.object({
    operation: z.literal("merge-family"),
    sourceFamilyId: EntityIdSchema,
    targetFamilyId: EntityIdSchema,
    reason: HumanReasonSchema,
  }).strict(),
  z.object({
    operation: z.literal("move"),
    optionId: EntityIdSchema,
    targetFamilyId: EntityIdSchema,
    relationship: z.enum(["duplicate", "variant"]),
    reason: HumanReasonSchema,
  }).strict(),
  z.object({
    operation: z.literal("mark-uncertain"),
    optionId: EntityIdSchema,
    reason: HumanReasonSchema,
  }).strict(),
]);

export const OpportunityMembershipCommandSchema = OpportunityMembershipEditSchema;

export type OpportunityRelationship = z.infer<typeof OpportunityRelationshipSchema>;
export type OpportunityMembershipState = z.infer<typeof OpportunityMembershipStateSchema>;
export type OpportunityDecisionActor = z.infer<typeof OpportunityDecisionActorSchema>;
export type OpportunityCandidateSnapshot = z.infer<typeof OpportunityCandidateSnapshotSchema>;
export type OpportunityCompactFamily = z.infer<typeof OpportunityCompactFamilySchema>;
export type OpportunityComparisonTarget = z.infer<typeof OpportunityComparisonTargetSchema>;
export type OpportunityCandidateAssessment = z.infer<typeof OpportunityCandidateAssessmentSchema>;
export type OpportunityComparison = z.infer<typeof OpportunityComparisonSchema>;
export type OpportunityReviewOutput = z.infer<typeof OpportunityReviewOutputSchema>;
export type OpportunityReviewCoverage = z.infer<typeof OpportunityReviewCoverageSchema>;
export type OpportunityMembership = z.infer<typeof OpportunityMembershipSchema>;
export type OpportunityFamily = z.infer<typeof OpportunityFamilySchema>;
export type OpportunityFamiliesView = z.infer<typeof OpportunityFamiliesViewSchema>;
export type OpportunityReviewExport = z.infer<typeof OpportunityReviewExportSchema>;
export type OpportunityMembershipEdit = z.infer<typeof OpportunityMembershipEditSchema>;
export type OpportunityMembershipCommand = OpportunityMembershipEdit;

export function opportunityCounts(view: OpportunityFamiliesView): OpportunityExplorationCounts {
  const acceptedMemberships = view.families.flatMap((family) => family.members)
    .filter((member) => member.state === "accepted" && !member.discarded);
  return {
    acceptedFamilies: view.acceptedFamilyCount,
    variants: acceptedMemberships.filter((member) => member.relationship === "variant").length,
    duplicates: acceptedMemberships.filter((member) => member.relationship === "duplicate").length,
    other: acceptedMemberships.filter((member) => !member.eligibleStartup).length,
    unresolved: view.unresolved.filter((item) => !item.membership.discarded).length,
    unreviewed: view.unreviewedOptionIds.length,
  };
}
