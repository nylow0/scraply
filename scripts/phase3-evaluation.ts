import { createHash, randomInt } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

const OriginSchema = z.enum(["generated", "synthetic", "live"]);
const TimingsSchema = z.record(z.number().finite().nonnegative()).optional();
const VariantInputSchema = z.object({
  ideasPath: z.string().min(1),
  ideasMarkdownPath: z.string().min(1),
  researchPath: z.string().min(1),
  origin: OriginSchema,
  timings: TimingsSchema,
}).strict();
const EvaluationInputSchema = z.object({
  schemaVersion: z.literal(1),
  cases: z.array(z.object({
    caseId: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
    variants: z.array(VariantInputSchema).length(2),
  }).strict()).min(3).max(5),
}).strict();

const ResearchExportSchema = z.object({
  schemaVersion: z.literal(1),
  scope: z.object({ title: z.string().min(1) }).passthrough(),
  researchRun: z.object({
    id: z.string().min(1),
    config: z.unknown(),
    usage: z.unknown().optional(),
  }).passthrough(),
  sources: z.array(z.object({ id: z.string().min(1) }).passthrough()),
}).passthrough();
const IdeaSchema = z.object({
  workflowVersion: z.union([z.literal(1), z.literal(2)]),
  problemStatement: z.string().min(1),
  mechanism: z.string().min(1),
  factors: z.array(z.object({ sourceId: z.string().min(1) }).passthrough()),
}).passthrough();
const IdeasExportSchema = z.array(IdeaSchema).min(1);
const NoOptionsExportSchema = z.object({
  kind: z.literal("no-options"), status: z.literal("completed"),
  workflowVersion: z.union([z.literal(1), z.literal(2)]),
  runId: z.string().min(1), discoveryRunId: z.string().min(1), problemId: z.string().min(1),
  problemStatement: z.string().min(1), options: z.tuple([]),
}).passthrough();

const CandidateIdSchema = z.enum(["A", "B"]);
const CandidateReviewSchema = z.object({
  candidateId: CandidateIdSchema,
  unsupportedClaims: z.array(z.string().min(1)),
  usefulDiscoveries: z.array(z.string().min(1)),
  readingDurationMs: z.number().int().positive(),
  correctionDurationMs: z.number().int().nonnegative(),
}).strict();
export const EvaluationReviewsSchema = z.object({
  schemaVersion: z.literal(1),
  packetSha256: z.string().regex(/^[a-f0-9]{64}$/),
  cases: z.array(z.object({
    caseId: z.string().min(1),
    candidates: z.array(CandidateReviewSchema).length(2),
    actionChosen: z.object({
      candidateId: z.enum(["A", "B", "neither"]),
      description: z.string().min(1),
    }).strict(),
    notes: z.string().optional(),
  }).strict()).min(3).max(5),
}).strict();

type CandidateId = z.infer<typeof CandidateIdSchema>;

interface LoadedVariant {
  ideas: z.infer<typeof IdeasExportSchema>;
  noOptions: z.infer<typeof NoOptionsExportSchema> | null;
  workflowVersion: 1 | 2;
  decision: string;
  research: z.infer<typeof ResearchExportSchema>;
  ideasPath: string;
  ideasMarkdownPath: string;
  ideasMarkdown: string;
  researchPath: string;
  origin: z.infer<typeof OriginSchema>;
  timings?: Record<string, number>;
}

function normalizeDecision(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function resolveInputPath(baseDirectory: string, path: string): string {
  return isAbsolute(path) ? path : resolve(baseDirectory, path);
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function jsonSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function loadVariant(input: z.infer<typeof VariantInputSchema>, baseDirectory: string): LoadedVariant {
  const ideasPath = resolveInputPath(baseDirectory, input.ideasPath);
  const ideasMarkdownPath = resolveInputPath(baseDirectory, input.ideasMarkdownPath);
  const researchPath = resolveInputPath(baseDirectory, input.researchPath);
  const rawIdeas = readJson(ideasPath);
  const noOptions = Array.isArray(rawIdeas) ? null : NoOptionsExportSchema.parse(rawIdeas);
  const ideas = noOptions ? [] : IdeasExportSchema.parse(rawIdeas);
  const ideasMarkdown = readFileSync(ideasMarkdownPath, "utf8");
  if (!ideasMarkdown.trim()) throw new Error(`${input.ideasMarkdownPath} is empty`);
  const research = ResearchExportSchema.parse(readJson(researchPath));
  const versions = new Set(ideas.map((idea) => idea.workflowVersion));
  const decisions = new Set(ideas.map((idea) => normalizeDecision(idea.problemStatement)));
  if (!noOptions && versions.size !== 1) throw new Error(`${input.ideasPath} mixes workflow versions`);
  if (!noOptions && decisions.size !== 1) throw new Error(`${input.ideasPath} mixes decisions`);
  if (noOptions && noOptions.discoveryRunId !== research.researchRun.id) throw new Error(`${input.ideasPath} belongs to a different research export`);
  const sourceIds = new Set(research.sources.map(({ id }) => id));
  for (const idea of ideas) {
    for (const factor of idea.factors) {
      if (!sourceIds.has(factor.sourceId)) throw new Error(`${input.ideasPath} cites a source absent from ${input.researchPath}`);
    }
  }
  return { ideas, noOptions, workflowVersion: noOptions?.workflowVersion ?? ideas[0]!.workflowVersion,
    decision: noOptions?.problemStatement ?? ideas[0]!.problemStatement,
    ideasMarkdown, research, ideasPath, ideasMarkdownPath, researchPath, origin: input.origin, ...(input.timings ? { timings: input.timings } : {}) };
}

function blindIdeasMarkdown(markdown: string): string {
  return markdown.replace(/^Workflow: v[12]\. /gm, "");
}

function withoutBlindingMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutBlindingMetadata);
  if (!value || typeof value !== "object") return value;
  const hidden = new Set(["workflowVersion", "runId", "researchRun", "usage", "exportedAt", "detailRevision"]);
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !hidden.has(key))
    .map(([key, child]) => [key, withoutBlindingMetadata(child)]));
}

export function createEvaluationArtifacts(
  rawInput: unknown,
  baseDirectory: string,
  flip: () => boolean = () => randomInt(2) === 1,
) {
  const input = EvaluationInputSchema.parse(rawInput);
  if (new Set(input.cases.map(({ caseId }) => caseId)).size !== input.cases.length) throw new Error("Evaluation case IDs must be unique");

  const packetCases: Array<{
    caseId: string;
    decision: string;
    candidates: Array<{ candidateId: CandidateId; readingFile: string; research: unknown; ideas: unknown; noOptions: unknown }>;
  }> = [];
  const mappingCases = [];
  const readingFiles: Array<{ filename: string; content: string }> = [];
  for (const evaluationCase of input.cases) {
    const variants = evaluationCase.variants.map((variant) => loadVariant(variant, baseDirectory));
    const workflows = variants.map((variant) => variant.workflowVersion).sort();
    if (workflows[0] !== 1 || workflows[1] !== 2) throw new Error(`${evaluationCase.caseId} must contain one v1 and one v2 ideas export`);
    const decisions = variants.map((variant) => normalizeDecision(variant.decision));
    if (decisions[0] !== decisions[1]) throw new Error(`${evaluationCase.caseId} variants do not describe the same decision`);
    if (JSON.stringify(variants[0]!.research.scope) !== JSON.stringify(variants[1]!.research.scope)) {
      throw new Error(`${evaluationCase.caseId} variants do not use the same archived scope and constraints`);
    }

    const ordered = flip() ? [variants[1]!, variants[0]!] : variants;
    const candidates = ordered.map((variant, index) => ({
      candidateId: (index === 0 ? "A" : "B") as CandidateId,
      readingFile: `${evaluationCase.caseId}-${index === 0 ? "A" : "B"}.md`,
      research: withoutBlindingMetadata(variant.research),
      ideas: withoutBlindingMetadata(variant.ideas),
      noOptions: withoutBlindingMetadata(variant.noOptions),
    }));
    readingFiles.push(...ordered.map((variant, index) => ({
      filename: `${evaluationCase.caseId}-${index === 0 ? "A" : "B"}.md`,
      content: blindIdeasMarkdown(variant.ideasMarkdown),
    })));
    packetCases.push({ caseId: evaluationCase.caseId, decision: variants[0]!.decision, candidates });
    mappingCases.push({
      caseId: evaluationCase.caseId,
      candidates: ordered.map((variant, index) => ({
        candidateId: (index === 0 ? "A" : "B") as CandidateId,
        packetCandidateSha256: jsonSha256(candidates[index]),
        workflowVersion: variant.workflowVersion,
        origin: variant.origin,
        timings: variant.timings ?? null,
        exportMetadata: { researchRun: variant.research.researchRun },
        ideas: { path: variant.ideasPath, sha256: sha256(variant.ideasPath) },
        ideasMarkdown: {
          path: variant.ideasMarkdownPath,
          sha256: sha256(variant.ideasMarkdownPath),
          blindedSha256: createHash("sha256").update(blindIdeasMarkdown(variant.ideasMarkdown)).digest("hex"),
        },
        research: { path: variant.researchPath, sha256: sha256(variant.researchPath) },
      })),
    });
  }
  const packet = {
    schemaVersion: 1 as const,
    instructions: "Review A and B without opening the private mapping. Record every unsupported claim and useful discovery, time spent reading and correcting, and the action you would choose.",
    cases: packetCases,
  };
  const packetSha256 = jsonSha256(packet);
  return {
    packet,
    mapping: { schemaVersion: 1 as const, packetSha256, gateAccepted: false as const, cases: mappingCases },
    readingFiles,
    reviewTemplate: {
      schemaVersion: 1 as const,
      packetSha256,
      cases: packetCases.map(({ caseId }) => ({
        caseId,
        candidates: (["A", "B"] as const).map((candidateId) => ({
          candidateId, unsupportedClaims: [], usefulDiscoveries: [],
          readingDurationMs: null, correctionDurationMs: null,
        })),
        actionChosen: { candidateId: null, description: "" },
        notes: "",
      })),
    },
  };
}

export function evaluationInputTemplate(caseCount = 3) {
  return {
    schemaVersion: 1 as const,
    cases: Array.from({ length: caseCount }, (_, index) => ({
      caseId: `decision-${index + 1}`,
      variants: ([1, 2] as const).map((version) => ({
        ideasPath: `decision-${index + 1}-v${version}-ideas.json`,
        ideasMarkdownPath: `decision-${index + 1}-v${version}-ideas.md`,
        researchPath: `decision-${index + 1}-v${version}-research.json`,
        origin: "live" as const,
        timings: { totalMs: 0 },
      })),
    })),
  };
}

export function validateEvaluationReviews(packet: unknown, mapping: unknown, rawReviews: unknown) {
  const packetValue = z.object({
    schemaVersion: z.literal(1),
    cases: z.array(z.object({
      caseId: z.string(),
      candidates: z.array(z.object({ candidateId: CandidateIdSchema }).passthrough()).length(2),
    }).passthrough()).min(3).max(5),
  }).passthrough().parse(packet);
  const mappingValue = z.object({
    schemaVersion: z.literal(1), packetSha256: z.string(), gateAccepted: z.literal(false),
    cases: z.array(z.object({
      caseId: z.string(),
      candidates: z.array(z.object({ candidateId: CandidateIdSchema, packetCandidateSha256: z.string() }).passthrough()).length(2),
    }).passthrough()).min(3).max(5),
  }).passthrough().parse(mapping);
  const reviews = EvaluationReviewsSchema.parse(rawReviews);
  const packetSha256 = jsonSha256(packetValue);
  if (mappingValue.packetSha256 !== packetSha256 || reviews.packetSha256 !== packetSha256) throw new Error("Packet, mapping, and reviews do not share the same packet hash");
  const expected = packetValue.cases.map(({ caseId }) => caseId).sort();
  if (JSON.stringify(mappingValue.cases.map(({ caseId }) => caseId).sort()) !== JSON.stringify(expected)) throw new Error("Private mapping does not match the review packet");
  if (JSON.stringify(reviews.cases.map(({ caseId }) => caseId).sort()) !== JSON.stringify(expected)) throw new Error("Reviews must cover every evaluation case exactly once");
  for (const review of reviews.cases) {
    if (new Set(review.candidates.map(({ candidateId }) => candidateId)).size !== 2) throw new Error(`${review.caseId} must review candidates A and B exactly once`);
  }
  for (const packetCase of packetValue.cases) {
    const mappingCase = mappingValue.cases.find(({ caseId }) => caseId === packetCase.caseId)!;
    for (const candidate of packetCase.candidates) {
      const mapped = mappingCase.candidates.find(({ candidateId }) => candidateId === candidate.candidateId);
      if (!mapped || mapped.packetCandidateSha256 !== jsonSha256(candidate)) throw new Error(`${packetCase.caseId} private A/B mapping does not match the review packet`);
    }
  }
  return { schemaVersion: 1 as const, gateStatus: "review-recorded-not-accepted" as const, packet: packetValue, mapping: mappingValue, reviews };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

function usage(): never {
  throw new Error("Usage: bun scripts/phase3-evaluation.ts template <input.json> | prepare <input.json> <output-directory> | validate <packet.json> <mapping.json> <reviews.json> <result.json>");
}

if (import.meta.main) {
  const [command, ...paths] = process.argv.slice(2);
  if (command === "template" && paths.length === 1) {
    writeJson(resolve(paths[0]!), evaluationInputTemplate());
    console.log(`Wrote a three-case input manifest to ${resolve(paths[0]!)}.`);
  } else if (command === "prepare" && paths.length === 2) {
    const inputPath = resolve(paths[0]!);
    const outputDirectory = resolve(paths[1]!);
    const artifacts = createEvaluationArtifacts(readJson(inputPath), dirname(inputPath));
    writeJson(join(outputDirectory, "review-packet.json"), artifacts.packet);
    writeJson(join(outputDirectory, "private-mapping.json"), artifacts.mapping);
    writeJson(join(outputDirectory, "review-template.json"), artifacts.reviewTemplate);
    for (const file of artifacts.readingFiles) writeFileSync(join(outputDirectory, file.filename), file.content, { encoding: "utf8", flag: "wx" });
    console.log(`Prepared ${artifacts.packet.cases.length} blinded cases in ${outputDirectory}. Keep private-mapping.json from the reviewer.`);
  } else if (command === "validate" && paths.length === 4) {
    const result = validateEvaluationReviews(readJson(resolve(paths[0]!)), readJson(resolve(paths[1]!)), readJson(resolve(paths[2]!)));
    writeJson(resolve(paths[3]!), result);
    console.log(`Recorded complete reviews in ${resolve(paths[3]!)}. This does not accept the Phase 3 gate.`);
  } else usage();
}
