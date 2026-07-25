import { readFileSync } from "node:fs";
import { join } from "node:path";

interface PackageMetadata {
  version: string;
}

type PromotionTarget = "stage" | "master" | "rc" | "production";

const [target, candidateSha, detail] = process.argv.slice(2) as [PromotionTarget | undefined, string | undefined, string | undefined];
if (!target || !candidateSha || !["stage", "master", "rc", "production"].includes(target)) {
  throw new Error("Usage: bun scripts/check-promotion.ts <stage|master|rc|production> <full-sha> [tag]");
}
if (!/^[a-f0-9]{40}$/i.test(candidateSha)) throw new Error("Promotion requires a full 40-character commit SHA.");
const previousSha = target === "stage" || target === "master" ? detail : undefined;
const tag = target === "rc" || target === "production" ? detail : undefined;
if (previousSha && !/^(?:0{40}|[a-f0-9]{40})$/i.test(previousSha)) {
  throw new Error("Previous branch state must be a full SHA or the all-zero branch-creation marker.");
}

const root = process.cwd();
const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageMetadata;

function git(args: string[], allowFailure = false): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0 && !allowFailure) {
    throw new Error(new TextDecoder().decode(result.stderr).trim() || `git ${args.join(" ")} failed`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

function remoteSha(branch: "dev" | "stage" | "master", required = true): string | null {
  const expectedRef = `refs/heads/${branch}`;
  const lines = git(["ls-remote", "origin", expectedRef]).split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) {
    if (required) throw new Error(`origin/${branch} does not exist.`);
    return null;
  }
  if (lines.length !== 1) throw new Error(`Expected exactly one remote ref for ${expectedRef}.`);
  const [sha, ref] = lines[0]!.split(/\s+/);
  if (!sha || ref !== expectedRef) throw new Error(`Remote ref lookup did not resolve exactly ${expectedRef}.`);
  return sha;
}

function assertAncestor(ancestor: string, descendant: string, message: string): void {
  const result = Bun.spawnSync(["git", "merge-base", "--is-ancestor", ancestor, descendant], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(message);
}

if (git(["status", "--porcelain", "--untracked-files=normal"])) {
  throw new Error("Promotion checks require a clean Git worktree.");
}
git(["cat-file", "-e", `${candidateSha}^{commit}`]);

const masterSha = remoteSha("master")!;
const stageSha = remoteSha("stage", false);

if (target === "stage") {
  const devSha = remoteSha("dev")!;
  if (candidateSha !== devSha) throw new Error("Stage must move to the current exact origin/dev SHA.");
  assertAncestor(masterSha, candidateSha, "The stage candidate is not a fast-forward from origin/master.");
  const previousStageSha = previousSha === "0".repeat(40) ? null : previousSha ?? stageSha;
  if (previousStageSha) {
    git(["cat-file", "-e", `${previousStageSha}^{commit}`]);
    assertAncestor(previousStageSha, candidateSha, "The stage update is not a fast-forward from its previous SHA.");
  }
  if (previousSha !== undefined && stageSha !== candidateSha) {
    throw new Error("The remote stage ref does not equal the pushed candidate SHA.");
  }
  console.log(`Validated stage candidate ${candidateSha}.`);
  console.log(`git push origin ${candidateSha}:refs/heads/stage`);
} else if (target === "master") {
  if (!stageSha || candidateSha !== stageSha) throw new Error("Master must move to the current exact origin/stage SHA.");
  const previousMasterSha = previousSha ?? masterSha;
  if (previousMasterSha === "0".repeat(40)) throw new Error("The production branch must already exist.");
  git(["cat-file", "-e", `${previousMasterSha}^{commit}`]);
  assertAncestor(previousMasterSha, candidateSha, "The master update is not a fast-forward from its previous SHA.");
  if (previousSha !== undefined && masterSha !== candidateSha) {
    throw new Error("The remote master ref does not equal the pushed candidate SHA.");
  }
  console.log(`Validated production branch candidate ${candidateSha}.`);
  console.log(`git push origin ${candidateSha}:refs/heads/master`);
} else if (target === "rc") {
  if (!tag) throw new Error("RC validation requires a stage-vX.Y.Z-rc.N tag.");
  const match = tag.match(/^stage-v(\d+\.\d+\.\d+)-rc\.(\d+)$/);
  if (!match) throw new Error(`Invalid RC tag: ${tag}`);
  if (match[1] !== metadata.version) throw new Error(`RC tag ${tag} does not match package version ${metadata.version}.`);
  if (!stageSha || candidateSha !== stageSha) throw new Error("RC tags must point to the current exact origin/stage SHA.");
  console.log(`Validated RC tag ${tag} at ${candidateSha}.`);
} else {
  if (!tag) throw new Error("Production validation requires a vX.Y.Z tag.");
  const match = tag.match(/^v(\d+\.\d+\.\d+)$/);
  if (!match) throw new Error(`Invalid production tag: ${tag}`);
  if (match[1] !== metadata.version) throw new Error(`Production tag ${tag} does not match package version ${metadata.version}.`);
  if (!stageSha || candidateSha !== stageSha || candidateSha !== masterSha) {
    throw new Error("Production tags must point to the same exact SHA as origin/stage and origin/master.");
  }
  console.log(`Validated production tag ${tag} at ${candidateSha}.`);
}
