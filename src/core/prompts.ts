import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PROMPT_STATE_FILE = ".prompt-versions.json";
interface PromptState { version: 1; prompts: Record<string, string> }

// Exact SHA-256 hashes of every bundled prompt blob present in repository history. These let the
// first metadata-aware release upgrade old untouched copies without ever guessing about custom text.
const KNOWN_BUNDLED_PROMPT_HASHES: Readonly<Record<string, readonly string[]>> = {
  "brief-agent.md": ["d8eae68a904c8eb1b0b46efca63bb9ad12a842e75f069b93ea6111258edc620a"],
  "coverage-reviewer.md": ["857ecaa48a091ac75608130a0d17455681d5a03250927573445e323611916947"],
  "factor-harvest.md": ["2500c702d2610dc614c56b804ba034b03499b0b81a08057e705ebbb25415d690"],
  "idea-generator.md": ["e0776356f3b1f65c142b31705b343264fee422eea1d8764fe5829441dab31e89"],
  "mitigations.md": ["39ab561e3bd4bef15fb40b25e46188b01a559ae5571c0f0bcd31c92be8e62f2b"],
  "outcome-judge.md": ["a0a5591fa3fde64faf238ec3b8a13039d06770f50c2030d66e70b1189664e56a"],
  "outcomes.md": ["48d6cdcf4f7658e66e1d1d59ba290f9a164f7fa3cd77f6d55b69ccdac96ea34c"],
  "problem-candidates.md": ["61ced7381fbf0c694a98fd009e233776134d3ad358a4793d88d0d6797617928a"],
  "problem-kill.md": ["3236687f3667b0317e6931e3defdc1be7fa0ebdb0a5edbc4e85ef7d9b3e600a5"],
  "query-plan.md": [
    "dfa6720778a6613e4da48e1e4629fdb0c18fa6b269e47fdaa2451e8f82dd9c47",
    "b2e0a859bbd2ac6b276807a0ee315a5da5cdb881ec8154d1e736c8267c87fd67",
  ],
  "researcher-analogies.md": ["25ae2139156b3ceb92cc3d867f6878e866abcf489b26ba7478aa62578a733691"],
  "researcher-default.md": ["ff10982456732c7855fbb6e8155db65a86d6dd3a1c3bfd4e983f7f83fcae0ca1"],
  "researcher-evaluation.md": ["a8cf24bced57ffbe647530dccf2d9e9b76e44dc7f3845380beb5612f695a6605"],
  "researcher-exemplars.md": ["1eebeadaeae03c45c812bafa67dcf16d941d4c6ca66aa300819806a8b806ddb3"],
  "researcher-landscape.md": ["bb77339c2bf8be096fb10160f059e4f4373ebad24cf57d46c124d3b8f027853b"],
  "researcher-pain-gaps.md": ["013818a938887590eb521854e82b0206561a55d28c6989e6a7d4a3338f4534c0"],
  "researcher-resources.md": ["91b7397cc993724d4bbfdf3300cb96c92fbc892f09efbab2b0e2fdd627099d9e"],
  "risk-score.md": ["115eae154837fce1dec6fa287af25687496d097f83c947a2049ba62b9f412965"],
  "risks.md": ["756e746241325b8741482ebb657cd169b66d071937a93e1160defc6b6dea99ce"],
  "solutions.md": ["810f36678cae032a8a547939beb5d62e710b27c1716849042a7a95cdc47f0bd1"],
  "structured-output-repair.md": ["d8758c978f6e11d75ade106836b4f9742406ea5dbb621e6f2a76a890621cfdef"],
  "synthesis-agent.md": ["c0d8332d7a66b90efca87699a3c6640c67d16e9f447aabf9169469892512595d"],
};

let bundledPromptDir = join(__dirname, "..", "..", "prompts");
let overridePromptDir: string | null = null;

export function configurePromptPaths(options: { bundledDir: string; overrideDir: string }): void {
  bundledPromptDir = options.bundledDir;
  overridePromptDir = options.overrideDir;
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
    const previousBundledHash = state.prompts[entry.name];
    if (!existsSync(target)) {
      copyFileSync(source, target);
      state.prompts[entry.name] = bundledHash;
      continue;
    }

    const overrideHash = fileHash(target);
    if (overrideHash === bundledHash) {
      state.prompts[entry.name] = bundledHash;
    } else if ((previousBundledHash && overrideHash === previousBundledHash)
      || (!previousBundledHash && isKnownBundledPrompt(entry.name, target, overrideHash))) {
      // An untouched managed copy follows bundled upgrades automatically.
      copyFileSync(source, target);
      state.prompts[entry.name] = bundledHash;
    } else {
      // Conflict policy: any divergent override not proven to be a bundled version is a user edit.
      // Keep the last known bundled baseline so a later manual reset can rejoin automatic upgrades.
      state.prompts[entry.name] = previousBundledHash ?? bundledHash;
    }
  }
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function loadPrompt(name: string, fallback: string): string {
  const filename = `${name}.md`;
  const paths = [overridePromptDir ? join(overridePromptDir, filename) : null, join(bundledPromptDir, filename)];

  for (const path of paths) {
    if (!path) continue;
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8").trim();
    if (text) return text;
  }

  return fallback.trim();
}

function readPromptState(path: string): PromptState | null {
  if (!existsSync(path)) return { version: 1, prompts: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown; prompts?: unknown };
    if (typeof parsed.version === "number" && parsed.version !== 1) return null;
    if (parsed.version === 1 && parsed.prompts && typeof parsed.prompts === "object") {
      return { version: 1, prompts: Object.fromEntries(Object.entries(parsed.prompts).filter((entry): entry is [string, string] => typeof entry[1] === "string")) };
    }
  } catch { /* corrupt state is treated as an unversioned legacy installation */ }
  return { version: 1, prompts: {} };
}

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isKnownBundledPrompt(name: string, path: string, rawHash: string): boolean {
  const knownHashes = KNOWN_BUNDLED_PROMPT_HASHES[name];
  if (!knownHashes) return false;
  if (knownHashes.includes(rawHash)) return true;
  const normalizedHash = createHash("sha256").update(readFileSync(path, "utf8").replaceAll("\r\n", "\n")).digest("hex");
  return knownHashes.includes(normalizedHash);
}
