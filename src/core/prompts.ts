import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getWorkflowV2Stage, type WorkflowV2StageId } from "./stages";

const PROMPT_STATE_FILE = ".prompt-versions.json";
export interface PromptBaseline { revision: 1; sha256: string }
interface PromptState {
  version: 1;
  prompts: Record<string, string>;
  workflowV2Baselines: Record<string, PromptBaseline>;
}

// Exact SHA-256 hashes of every bundled prompt blob present in repository history. These let the
// first metadata-aware release upgrade old untouched copies without ever guessing about custom text.
const KNOWN_BUNDLED_PROMPT_HASHES: Readonly<Record<string, readonly string[]>> = {
  "brief-agent.md": ["d8eae68a904c8eb1b0b46efca63bb9ad12a842e75f069b93ea6111258edc620a"],
  "coverage-reviewer.md": ["857ecaa48a091ac75608130a0d17455681d5a03250927573445e323611916947"],
  "factor-harvest.md": [
    "2500c702d2610dc614c56b804ba034b03499b0b81a08057e705ebbb25415d690",
    "c5c62b7080d649d4e82eb0505e1c96bab4bbe97cf798db5840af96851a70b3ee",
    "4c378d0eba0b247a4de806bbe24c457e3297e223e9a8f7bd827fc3c5eb33b0fd",
  ],
  "idea-generator.md": ["e0776356f3b1f65c142b31705b343264fee422eea1d8764fe5829441dab31e89"],
  "mitigations.md": [
    "39ab561e3bd4bef15fb40b25e46188b01a559ae5571c0f0bcd31c92be8e62f2b",
    "e098c3eb2a05e8426dca0e3075b8dca10d66420a261a6e3e2b9d13c866342879",
  ],
  "outcome-judge.md": [
    "a0a5591fa3fde64faf238ec3b8a13039d06770f50c2030d66e70b1189664e56a",
    "4cb72dfbc2a978cfed734f535db63be91cdce0285f66fec9caa9142744f54239",
  ],
  "outcomes.md": [
    "48d6cdcf4f7658e66e1d1d59ba290f9a164f7fa3cd77f6d55b69ccdac96ea34c",
    "34cc5bfc541381262e38dd638e385373cbd3e567c2ed1758810f59e96f1fe34b",
  ],
  "problem-candidates.md": [
    "61ced7381fbf0c694a98fd009e233776134d3ad358a4793d88d0d6797617928a",
    "7369fca14e1b358681522586010a7843512b93a6bd234c29619eec47efa60dbf",
  ],
  "problem-kill.md": [
    "3236687f3667b0317e6931e3defdc1be7fa0ebdb0a5edbc4e85ef7d9b3e600a5",
    "bd8aff56ee734f1a5c452257e31ad771e00045e1d20983640a1a8a6af1eda31f",
    "f836beda2dfe41ae6c19fc0a24aa36ed97bc267a3819d7de96fc1e1f544af0df",
  ],
  "query-plan.md": [
    "dfa6720778a6613e4da48e1e4629fdb0c18fa6b269e47fdaa2451e8f82dd9c47",
    "b2e0a859bbd2ac6b276807a0ee315a5da5cdb881ec8154d1e736c8267c87fd67",
    "675549138e1fa24b1fbf5f8a109b985bc20b33fd274f6803941ddb3fa8cb9c17",
  ],
  "researcher-analogies.md": ["25ae2139156b3ceb92cc3d867f6878e866abcf489b26ba7478aa62578a733691"],
  "researcher-default.md": ["ff10982456732c7855fbb6e8155db65a86d6dd3a1c3bfd4e983f7f83fcae0ca1"],
  "researcher-evaluation.md": ["a8cf24bced57ffbe647530dccf2d9e9b76e44dc7f3845380beb5612f695a6605"],
  "researcher-exemplars.md": ["1eebeadaeae03c45c812bafa67dcf16d941d4c6ca66aa300819806a8b806ddb3"],
  "researcher-landscape.md": ["bb77339c2bf8be096fb10160f059e4f4373ebad24cf57d46c124d3b8f027853b"],
  "researcher-pain-gaps.md": ["013818a938887590eb521854e82b0206561a55d28c6989e6a7d4a3338f4534c0"],
  "researcher-resources.md": ["91b7397cc993724d4bbfdf3300cb96c92fbc892f09efbab2b0e2fdd627099d9e"],
  "risk-score.md": [
    "115eae154837fce1dec6fa287af25687496d097f83c947a2049ba62b9f412965",
    "16f084dea84cf902d61260a657bb34f0e7e70dca9a6f1e0e4a89622acd4a84fb",
  ],
  "risks.md": [
    "756e746241325b8741482ebb657cd169b66d071937a93e1160defc6b6dea99ce",
    "a094da6535739274e3334004ff02078bf0da3c3400f7acfeb2fdf80783b84dd7",
  ],
  "solutions.md": [
    "810f36678cae032a8a547939beb5d62e710b27c1716849042a7a95cdc47f0bd1",
    "d1bedf2246ed1ff7e839249e283b5e740cb36e20ae5430d64cc2c414fb02fa67",
  ],
  "structured-output-repair.md": ["d8758c978f6e11d75ade106836b4f9742406ea5dbb621e6f2a76a890621cfdef"],
  "synthesis-agent.md": ["c0d8332d7a66b90efca87699a3c6640c67d16e9f447aabf9169469892512595d"],
};

let bundledPromptDir = join(__dirname, "..", "..", "prompts");
let overridePromptDir: string | null = null;

export function configurePromptPaths(options: { bundledDir: string; overrideDir: string | null }): void {
  bundledPromptDir = options.bundledDir;
  overridePromptDir = options.overrideDir;
  if (!overridePromptDir) return;
  mkdirSync(overridePromptDir, { recursive: true });

  if (!existsSync(bundledPromptDir)) return;
  const statePath = join(overridePromptDir, PROMPT_STATE_FILE);
  const state = readPromptState(statePath);
  if (!state) return;
  for (const entry of readdirSync(bundledPromptDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const source = join(bundledPromptDir, entry.name);
    const target = join(overridePromptDir, entry.name);
    const bundledHash = fileHash(source);
    if (entry.name.startsWith("workflow-v2-")) {
      // V2 bundled prompts remain package assets. An override exists only after a user creates it.
      // An exact copy gives us a trustworthy baseline before any later user edit.
      if (existsSync(target) && fileHash(target) === bundledHash && !state.workflowV2Baselines[entry.name]) {
        state.workflowV2Baselines[entry.name] = { revision: 1, sha256: bundledHash };
      }
      continue;
    }
    const previousBundledHash = state.prompts[entry.name];
    if (!existsSync(target)) {
      state.prompts[entry.name] = bundledHash;
      continue;
    }

    const overrideHash = fileHash(target);
    if (overrideHash === bundledHash || (previousBundledHash && overrideHash === previousBundledHash)
      || (!previousBundledHash && isKnownBundledPrompt(entry.name, target, overrideHash))) {
      // Only proven bundled copies leave the active override directory. Keep their exact bytes
      // recoverable, including old line endings; unknown and retired custom files stay untouched.
      const backupDir = join(overridePromptDir, "bundled-copy-backups", overrideHash);
      mkdirSync(backupDir, { recursive: true });
      const backup = join(backupDir, entry.name);
      if (!existsSync(backup)) copyFileSync(target, backup);
      if (fileHash(backup) !== overrideHash) throw new Error(`Prompt backup verification failed: ${entry.name}`);
      unlinkSync(target);
      state.prompts[entry.name] = bundledHash;
    } else {
      // Conflict policy: any divergent override not proven to be a bundled version is a user edit.
      // Keep the last known bundled baseline so a later manual reset can rejoin automatic upgrades.
      // Unknown legacy edits have an unknown baseline, not the current bundled revision.
      if (previousBundledHash) state.prompts[entry.name] = previousBundledHash;
    }
  }
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
  const text = hasOverride ? readFileSync(overridePath, "utf8") : bundledText;
  if (!text.trim()) throw new Error(`Prompt override ${stage.promptFilename} is empty`);
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

export function loadPrompt(name: string): string {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`Invalid prompt name: ${name}`);
  const filename = `${name}.md`;
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

function isKnownBundledPrompt(name: string, path: string, rawHash: string): boolean {
  const knownHashes = KNOWN_BUNDLED_PROMPT_HASHES[name];
  if (!knownHashes) return false;
  if (knownHashes.includes(rawHash)) return true;
  const normalizedHash = createHash("sha256").update(readFileSync(path, "utf8").replaceAll("\r\n", "\n")).digest("hex");
  return knownHashes.includes(normalizedHash);
}
