import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getWorkflowV2Stage, type WorkflowV2StageId } from "./stages";

const PROMPT_STATE_FILE = ".prompt-versions.json";
export const WRITING_GUIDANCE_FILENAME = "writing-guidance.md";

// Search plans and area selection feed tools. The other stages author text shown in the UI or exports.
const MACHINE_ONLY_STAGES = new Set<WorkflowV2StageId>(["frame-search-plan", "query-plan", "area-ranking"]);
export interface PromptBaseline { revision: 1; sha256: string }
interface PromptState {
  version: 1;
  prompts: Record<string, string>;
  workflowV2Baselines: Record<string, PromptBaseline>;
}

// Filenames verified from prompt assets across repository history. Retired overrides,
// including custom text, are archived because their schemas no longer have an active workflow.
const RETIRED_PROMPT_FILENAMES = new Set([
  "brief-agent.md",
  "coverage-reviewer.md",
  "factor-harvest.md",
  "idea-generator.md",
  "mitigations.md",
  "outcome-judge.md",
  "outcomes.md",
  "problem-candidates.md",
  "problem-kill.md",
  "query-plan.md",
  "researcher-analogies.md",
  "researcher-default.md",
  "researcher-evaluation.md",
  "researcher-exemplars.md",
  "researcher-landscape.md",
  "researcher-pain-gaps.md",
  "researcher-resources.md",
  "risk-score.md",
  "risks.md",
  "solutions.md",
  "structured-output-repair.md",
  "synthesis-agent.md",
]);

// SHA-256 of LF-normalized workflow-v2 prompt blobs verified with git cat-file across
// repository history. Only exact bundled copies or recorded baselines may be upgraded.
const KNOWN_BUNDLED_PROMPT_HASHES: Readonly<Record<string, readonly string[]>> = {
  // Installed copies of these two frame prompts predate the current repository history.
  "workflow-v2-frame.md": [
    "0beac3932fb8a0246fa3f9699ddde1f9e337439ef8fe496e4f7245f2806a3021",
    "3061cf6a392930af3a4498b90d5e8a011e9a52de8366b866b81a547729829a16",
  ],
  "workflow-v2-idea-follow-up.md": ["eae66a0630bc8428c961752c71d5e4bc367f944d89d5e5fd60d0adbe4effd101"],
  "workflow-v2-idea-ranking.md": ["73460388c9cae8bf5498e1ed8dc4fe7d9d6841fdf7eff7f37c9c5bb501a1a16c"],
  "workflow-v2-solution-set-review.md": ["c609d924ee01b1d98b47abd309ba76c9df7b7777e56b14a05d57ddf8b9d75e94"],
  "workflow-v2-decision-analysis.md": [
    "a7c7ce65f995d3623afc0c9fd237f9b758004f57468ffee5bbf59c88baa4f809",
    "81c5000a3980c1d62ae39ee8bb903e1912b2c2df9774c159e5cf65edcb1eab14",
    "fa76458e49f6cc06412a074ebf8154d43c47393c7cfca8c00b5adbcae3b5a577",
    "3c91a2bfddfe15ed44c269ac5473baee71e2eff8871a29e49c0a1468a2c5aab6",
  ],
  "workflow-v2-factor-harvest.md": [
    "efcc053f76651f6e4a1224eb9e8c3fde5aafaa23a82b60fcab1ed0dd2da6aa47",
    "6941720a3a26ac9c1735aee1b199ad59a48b8408cdb9470d6c7b1f3aa3646c69",
    "536c204ec64807fee03fc3081493c5117179b167be7f33628804f83c8c566bde",
    "588f17dd8109b298233d50b8af48df72b70d9008e52c6dbb95ce104100baaf0c",
  ],
  "workflow-v2-problem-candidates.md": [
    "7a5241bd9267d036cc1eab7e5de1e8e1f254d8f2997269a3876e346ba3789b37",
    "e2b602664164a3e636e9f13e4c30b99448b1d311dcade7c604c4f3a39cfd97a1",
    "00dfb5dc917bcdceb39c2cde49d97272ecead40782db7677719d6fcb5ea3959f",
  ],
  "workflow-v2-problem-kill.md": [
    "6811a2da833b7a421551f26a58112f2aa539f7f8677a8aa7324edbafb6b1f5b9",
    "2f6544e72b274c5071f73f68138c22397b58879063b37fa056ed4e9a43b2e459",
  ],
  "workflow-v2-query-plan.md": [
    "6d03fa9a298bd13d5384042f3f51b07823a00088bfe6cdb6f2633a14df080830",
    "7f7bbe7092f2b6fa7673157bf691546a1e400f8ab8590427f761f1623449a752",
  ],
  "workflow-v2-risk-evaluation.md": [
    "a538f676335d1c03505f33cdd44bcc64ac6c10eed0fb6d5fc3d27388a0b5102a",
    "d7e627e1e869399c477f22270771e7928a624033e41a4f93e5798d5923cb3fa9",
  ],
  "workflow-v2-solutions.md": [
    "52417751feefb5ffea0600b262682f4fe45799e90db6932ac8dc36ff4b30e094",
    "bb4d7757065eaea489758956b2c7f721004942519df545e47b9ed4c3850b6729",
    "88b1d387578f2f5c016ea4be79b9e04ce3802e56b49ab98337ef896c6f014d45",
    "64878f576f90f8f0330d4d0d9163805a507800117f6b569d860c3e2f13aa21f3",
    "52223213b8401df21b5987957ec7eed9ebdcdf2850c0951781f6c69e7d7cc72a",
    "a6b06cd7d9bed8847568d2de3ec4472142634539883d7fa61e3df4cf544e5dd1",
  ],
};

let bundledPromptDir = join(__dirname, "..", "..", "prompts");
let overridePromptDir: string | null = null;

export function configurePromptPaths(options: { bundledDir: string; overrideDir: string | null }): void {
  bundledPromptDir = options.bundledDir;
  overridePromptDir = options.overrideDir;
  if (!overridePromptDir) return;
  mkdirSync(overridePromptDir, { recursive: true });

  const statePath = join(overridePromptDir, PROMPT_STATE_FILE);
  const state = readPromptState(statePath);
  // Retirement applies even without package assets or readable version metadata. Every
  // retired file is recoverable, including custom contents that cannot be used by v2.
  for (const entry of readdirSync(overridePromptDir, { withFileTypes: true })) {
    if (!entry.isFile() || !RETIRED_PROMPT_FILENAMES.has(entry.name)) continue;
    archivePromptOverride(overridePromptDir, entry.name, "retired-prompt-backups");
    if (state) {
      delete state.prompts[entry.name];
      delete state.workflowV2Baselines[entry.name];
    }
  }

  const bundledEntries = existsSync(bundledPromptDir)
    ? readdirSync(bundledPromptDir, { withFileTypes: true })
    : [];
  for (const entry of bundledEntries) {
    if (!entry.isFile() || !entry.name.startsWith("workflow-v2-") || !entry.name.endsWith(".md")) continue;
    const source = join(bundledPromptDir, entry.name);
    const target = join(overridePromptDir, entry.name);
    if (!existsSync(target)) continue;
    const bundledHash = fileHash(source);
    const overrideHash = fileHash(target);
    const normalizedOverrideHash = textHash(readFileSync(target, "utf8").replaceAll("\r\n", "\n"));
    const normalizedBundledHash = textHash(readFileSync(source, "utf8").replaceAll("\r\n", "\n"));
    const baselineHash = state?.workflowV2Baselines[entry.name]?.sha256;
    const previousBundledHash = state?.prompts[entry.name];
    if (overrideHash === bundledHash || normalizedOverrideHash === normalizedBundledHash
      || overrideHash === baselineHash || normalizedOverrideHash === baselineHash
      || overrideHash === previousBundledHash || normalizedOverrideHash === previousBundledHash
      || isKnownBundledPrompt(entry.name, target, overrideHash)) {
      archivePromptOverride(overridePromptDir, entry.name, "bundled-copy-backups", overrideHash);
      if (state) {
        delete state.workflowV2Baselines[entry.name];
        state.prompts[entry.name] = bundledHash;
      }
    }
    // A divergent current-v2 override is a deliberate custom prompt. Preserve both
    // its bytes and its original baseline rather than relabeling it as the new bundle.
  }
  // Do not overwrite metadata written by a newer, unsupported state format.
  if (!state) return;
  const temporaryStatePath = `${statePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryStatePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(temporaryStatePath, statePath);
  } finally {
    if (existsSync(temporaryStatePath)) unlinkSync(temporaryStatePath);
  }
}

export class PromptPackagingError extends Error {
  readonly code = "PROMPT_PACKAGING_ERROR";

  constructor(readonly filename: string, detail: string) {
    super(`Required bundled prompt ${filename} ${detail}`);
    this.name = "PromptPackagingError";
  }
}

export class RetiredPromptError extends Error {
  readonly code = "RETIRED_WORKFLOW_PROMPT";

  constructor(readonly filename: string) {
    super(`Prompt ${filename} belongs to a retired workflow. Start a new workflow-v2 run; old results remain available for reading.`);
    this.name = "RetiredPromptError";
  }
}

export interface ResolvedWorkflowV2Prompt {
  stageId: WorkflowV2StageId;
  filename: string;
  revision: 1;
  source: "bundled" | "override";
  currentBundledSha256: string;
  overrideBaseline: PromptBaseline | null;
  resolvedSha256: string;
  text: string;
}

export function resolveWorkflowV2Prompt(stageId: WorkflowV2StageId): ResolvedWorkflowV2Prompt {
  const stage = getWorkflowV2Stage(stageId);
  const bundledPath = join(bundledPromptDir, stage.promptFilename);
  if (!existsSync(bundledPath)) {
    throw new PromptPackagingError(stage.promptFilename, "is missing from the application package");
  }
  const bundledText = readFileSync(bundledPath, "utf8");
  if (!bundledText.trim()) {
    throw new PromptPackagingError(stage.promptFilename, "is empty in the application package");
  }

  const overridePath = overridePromptDir ? join(overridePromptDir, stage.promptFilename) : null;
  const hasOverride = overridePath !== null && existsSync(overridePath);
  const stageText = hasOverride ? readFileSync(overridePath, "utf8") : bundledText;
  if (!stageText.trim()) throw new Error(`Prompt override ${stage.promptFilename} is empty`);
  // Append after override selection, before the run freezes the text and its hash.
  // Bundle baselines continue to describe only the editable stage file.
  const text = MACHINE_ONLY_STAGES.has(stageId) ? stageText : withWritingGuidance(stageText);
  const state = overridePromptDir
    ? readPromptState(join(overridePromptDir, PROMPT_STATE_FILE))
    : null;

  return {
    stageId,
    filename: stage.promptFilename,
    revision: stage.promptRevision,
    source: hasOverride ? "override" : "bundled",
    currentBundledSha256: textHash(bundledText),
    overrideBaseline: hasOverride ? state?.workflowV2Baselines[stage.promptFilename] ?? null : {
      revision: stage.promptRevision,
      sha256: textHash(bundledText),
    },
    resolvedSha256: textHash(text),
    text,
  };
}

export function loadWritingGuidance(): string {
  const path = join(bundledPromptDir, WRITING_GUIDANCE_FILENAME);
  if (!existsSync(path)) throw new PromptPackagingError(WRITING_GUIDANCE_FILENAME, "is missing from the application package");
  const text = readFileSync(path, "utf8").trim();
  if (!text) throw new PromptPackagingError(WRITING_GUIDANCE_FILENAME, "is empty in the application package");
  return text;
}

/** Inline stages pass their run's saved guidance. An empty string preserves older runs. */
export function withWritingGuidance(text: string, guidance = loadWritingGuidance()): string {
  if (!guidance || text.replaceAll("\r\n", "\n").includes(guidance.replaceAll("\r\n", "\n"))) return text;
  return `${text}\n\n${guidance}`;
}

export function loadPrompt(name: string): string {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`Invalid prompt name: ${name}`);
  const filename = `${name}.md`;
  if (RETIRED_PROMPT_FILENAMES.has(filename)) throw new RetiredPromptError(filename);
  const bundledPath = join(bundledPromptDir, filename);
  if (!existsSync(bundledPath) || !readFileSync(bundledPath, "utf8").trim()) {
    throw new Error(`Required bundled prompt is missing or empty: ${filename}. Reinstall Scraply to restore its prompts.`);
  }
  const overridePath = overridePromptDir ? join(overridePromptDir, filename) : null;
  const path = overridePath && existsSync(overridePath) ? overridePath : bundledPath;
  const text = readFileSync(path, "utf8").trim();
  if (!text) throw new Error(`Prompt override is empty: ${filename}. Edit it or remove it to use the bundled prompt.`);
  return text;
}

function readPromptState(path: string): PromptState | null {
  if (!existsSync(path)) return { version: 1, prompts: {}, workflowV2Baselines: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      version?: unknown;
      prompts?: unknown;
      workflowV2Baselines?: unknown;
    };
    if (typeof parsed.version === "number" && parsed.version !== 1) return null;
    if (parsed.version === 1 && parsed.prompts && typeof parsed.prompts === "object") {
      const baselines = parsed.workflowV2Baselines && typeof parsed.workflowV2Baselines === "object"
        ? Object.fromEntries(Object.entries(parsed.workflowV2Baselines).filter(
          (entry): entry is [string, PromptBaseline] => isPromptBaseline(entry[1]),
        ))
        : {};
      return {
        version: 1,
        prompts: Object.fromEntries(Object.entries(parsed.prompts).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        )),
        workflowV2Baselines: baselines,
      };
    }
  } catch { /* corrupt state is treated as an unversioned legacy installation */ }
  return { version: 1, prompts: {}, workflowV2Baselines: {} };
}

function isPromptBaseline(value: unknown): value is PromptBaseline {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { revision?: unknown; sha256?: unknown };
  return candidate.revision === 1
    && typeof candidate.sha256 === "string"
    && /^[a-f0-9]{64}$/.test(candidate.sha256);
}

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function textHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function archivePromptOverride(
  directory: string,
  filename: string,
  category: "retired-prompt-backups" | "bundled-copy-backups",
  expectedHash?: string,
): void {
  const target = join(directory, filename);
  const originalHash = fileHash(target);
  if (expectedHash !== undefined && originalHash !== expectedHash) {
    throw new Error(`Prompt changed during migration: ${filename}`);
  }
  const backupDir = join(directory, category, originalHash);
  mkdirSync(backupDir, { recursive: true });
  const backup = join(backupDir, filename);
  if (!existsSync(backup)) copyFileSync(target, backup);
  if (fileHash(backup) !== originalHash || fileHash(target) !== originalHash) {
    throw new Error(`Prompt backup verification failed: ${filename}`);
  }
  unlinkSync(target);
}

function isKnownBundledPrompt(name: string, path: string, rawHash: string): boolean {
  const knownHashes = KNOWN_BUNDLED_PROMPT_HASHES[name];
  if (!knownHashes) return false;
  if (knownHashes.includes(rawHash)) return true;
  const normalizedHash = createHash("sha256").update(readFileSync(path, "utf8").replaceAll("\r\n", "\n")).digest("hex");
  return knownHashes.includes(normalizedHash);
}
