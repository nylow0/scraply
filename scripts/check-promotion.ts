import { readFileSync } from "node:fs";
import { join } from "node:path";

interface PackageMetadata {
  version: string;
}

type PromotionTarget = "rc" | "production";

const [target, candidateSha, tag] = process.argv.slice(2) as [
  PromotionTarget | undefined,
  string | undefined,
  string | undefined,
];
if (!target || !candidateSha || !["rc", "production"].includes(target)) {
  throw new Error("Usage: bun scripts/check-promotion.ts <rc|production> <full-sha> <tag>");
}
if (!/^[a-f0-9]{40}$/i.test(candidateSha)) {
  throw new Error("Promotion requires a full 40-character commit SHA.");
}
if (!tag) throw new Error("Promotion validation requires a tag.");

const root = process.cwd();
const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageMetadata;

function git(args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr).trim() || `git ${args.join(" ")} failed`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

function remoteMasterSha(): string {
  const expectedRef = "refs/heads/master";
  const lines = git(["ls-remote", "origin", expectedRef]).split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) throw new Error(`Expected exactly one remote ref for ${expectedRef}.`);
  const [sha, ref] = lines[0]!.split(/\s+/);
  if (!sha || ref !== expectedRef) throw new Error(`Remote ref lookup did not resolve exactly ${expectedRef}.`);
  return sha;
}

if (git(["status", "--porcelain", "--untracked-files=normal"])) {
  throw new Error("Promotion checks require a clean Git worktree.");
}
git(["cat-file", "-e", `${candidateSha}^{commit}`]);

const masterSha = remoteMasterSha();
if (candidateSha !== masterSha) {
  throw new Error("Release tags must point to the current exact origin/master SHA.");
}

if (target === "rc") {
  const match = tag.match(/^v(\d+\.\d+\.\d+)-rc\.(\d+)$/);
  if (!match) throw new Error(`Invalid RC tag: ${tag}`);
  if (match[1] !== metadata.version) throw new Error(`RC tag ${tag} does not match package version ${metadata.version}.`);
  console.log(`Validated RC tag ${tag} at production candidate ${candidateSha}.`);
} else {
  const match = tag.match(/^v(\d+\.\d+\.\d+)$/);
  if (!match) throw new Error(`Invalid production tag: ${tag}`);
  if (match[1] !== metadata.version) {
    throw new Error(`Production tag ${tag} does not match package version ${metadata.version}.`);
  }
  console.log(`Validated production tag ${tag} at ${candidateSha}.`);
}
