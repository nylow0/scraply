import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { listPackage } from "@electron/asar";

interface PackageMetadata {
  version: string;
}

interface ExecutableMetadata {
  productName: string;
  productVersion: string;
  fileVersion: string;
  signatureStatus: string;
}

interface ManifestArtifact {
  name: string;
  path: string;
  bytes: number;
  sha256: string;
  executable?: ExecutableMetadata;
}

interface ReleaseManifest {
  schemaVersion: 1;
  appVersion: string;
  sourceSha: string;
  sourceRef: string;
  dirty: boolean;
  generatedAt: string;
  signed: boolean;
  signingPolicy: "signed" | "private-unsigned";
  artifacts: ManifestArtifact[];
}

const root = process.cwd();
const releaseDir = join(root, "release");
const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageMetadata;
const strict = process.argv.includes("--strict") || process.env.SCRAPLY_RELEASE_STRICT === "1";
const allowUnsigned = process.env.SCRAPLY_ALLOW_UNSIGNED === "1" || !strict;
const artifactPaths = [
  { name: "installer", path: join(releaseDir, `Scraply Setup ${metadata.version}.exe`), executable: true },
  { name: "portable", path: join(releaseDir, `Scraply ${metadata.version}.exe`), executable: true },
  { name: "unpacked", path: join(releaseDir, "win-unpacked", "Scraply.exe"), executable: true },
  { name: "app-asar", path: join(releaseDir, "win-unpacked", "resources", "app.asar"), executable: false },
];

const missingArtifacts = artifactPaths.filter((artifact) => !existsSync(artifact.path));
if (missingArtifacts.length > 0) {
  throw new Error(`Missing package artifacts:\n${missingArtifacts.map((artifact) => artifact.path).join("\n")}`);
}

const rootExecutables = readdirSync(releaseDir)
  .filter((name) => name.toLowerCase().endsWith(".exe"))
  .sort();
const expectedRootExecutables = artifactPaths
  .slice(0, 2)
  .map((artifact) => artifact.path.split(/[\\/]/).at(-1)!)
  .sort();
if (JSON.stringify(rootExecutables) !== JSON.stringify(expectedRootExecutables)) {
  throw new Error(`Unexpected release executables:\n${rootExecutables.join("\n")}`);
}

const archivePath = artifactPaths.find((artifact) => artifact.name === "app-asar")!.path;
const archiveEntries = new Set(listPackage(archivePath, { isPack: false }).map((path) => path.replaceAll("\\", "/")));
const requiredEntries = [
  "/out/main/index.js",
  "/out/main/backend.js",
  "/out/preload/index.js",
  "/out/renderer/index.html",
  "/prompts/query-plan.md",
  "/prompts/factor-harvest.md",
  "/prompts/problem-candidates.md",
  "/prompts/problem-kill.md",
  "/prompts/solutions.md",
  "/prompts/outcomes.md",
  "/prompts/outcome-judge.md",
  "/prompts/risks.md",
  "/prompts/risk-score.md",
  "/prompts/mitigations.md",
  "/package.json",
];
const missingEntries = requiredEntries.filter((path) => !archiveEntries.has(path));
if (missingEntries.length > 0) {
  throw new Error(`Missing app.asar entries:\n${missingEntries.join("\n")}`);
}

const forbiddenFragments = [
  "backend-e2e.js",
  "/test/",
  "/plans/",
  "/skill-src/",
  "/.env",
  "/.scraply/",
  "question-workflow-review-and-deep-research-prompt.md",
];
const forbiddenEntries = [...archiveEntries].filter((entry) => forbiddenFragments.some((fragment) => entry.includes(fragment)));
if (forbiddenEntries.length > 0) {
  throw new Error(`Unexpected app.asar entries:\n${forbiddenEntries.join("\n")}`);
}

function commandOutput(command: string[]): string {
  const result = Bun.spawnSync(command, { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr).trim() || `Command failed: ${command.join(" ")}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function executableMetadata(path: string): ExecutableMetadata {
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  env.SCRAPLY_VERIFY_EXE = path;
  // CI runners export PowerShell 7 module paths that break module autoloading in
  // Windows PowerShell 5.1; dropping the variable restores the 5.1 defaults.
  delete env.PSModulePath;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$item = Get-Item -LiteralPath $env:SCRAPLY_VERIFY_EXE",
    "$signature = Get-AuthenticodeSignature -LiteralPath $env:SCRAPLY_VERIFY_EXE",
    "[PSCustomObject]@{ productName = $item.VersionInfo.ProductName; productVersion = $item.VersionInfo.ProductVersion; fileVersion = $item.VersionInfo.FileVersion; signatureStatus = $signature.Status.ToString() } | ConvertTo-Json -Compress",
  ].join("; ");
  const result = Bun.spawnSync(["powershell", "-NoProfile", "-Command", script], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr).trim() || `Failed to inspect ${path}`);
  }
  return JSON.parse(new TextDecoder().decode(result.stdout)) as ExecutableMetadata;
}

const headSha = commandOutput(["git", "rev-parse", "HEAD"]);
const sourceRef = process.env.GITHUB_REF_NAME ?? commandOutput(["git", "branch", "--show-current"]);
const dirty = commandOutput(["git", "status", "--porcelain", "--untracked-files=normal"]).length > 0;
if (!/^[a-f0-9]{40}$/i.test(headSha)) throw new Error(`Invalid source SHA: ${headSha}`);
if (strict && process.env.GITHUB_SHA && process.env.GITHUB_SHA !== headSha) {
  throw new Error(`GITHUB_SHA ${process.env.GITHUB_SHA} does not match checkout HEAD ${headSha}.`);
}
if (strict && dirty) throw new Error("Release verification requires a clean Git worktree.");
const sourceSha = headSha;

const tagVersion = sourceRef.match(/^v(\d+\.\d+\.\d+)(?:-rc\.\d+)?$/)?.[1];
if (strict && tagVersion && tagVersion !== metadata.version) {
  throw new Error(`Tag ${sourceRef} does not match package version ${metadata.version}.`);
}

const artifacts = artifactPaths.map((artifact): ManifestArtifact => {
  const executable = artifact.executable ? executableMetadata(artifact.path) : undefined;
  if (executable && (
    executable.productName !== "Scraply"
    || executable.fileVersion !== metadata.version
    || !executable.productVersion.startsWith(metadata.version)
  )) {
    throw new Error(`Invalid executable metadata for ${artifact.path}: ${JSON.stringify(executable)}`);
  }
  if (executable && !["Valid", "NotSigned"].includes(executable.signatureStatus)) {
    throw new Error(`Invalid Authenticode status for ${artifact.path}: ${executable.signatureStatus}`);
  }
  if (strict && executable?.signatureStatus === "NotSigned" && !allowUnsigned) {
    throw new Error(`Unsigned executable is not allowed by the current release policy: ${artifact.path}`);
  }
  return {
    name: artifact.name,
    path: relative(root, artifact.path).replaceAll("\\", "/"),
    bytes: statSync(artifact.path).size,
    sha256: sha256(artifact.path),
    ...(executable ? { executable } : {}),
  };
});

const publishedArtifacts = artifacts.filter((artifact) => artifact.name === "installer" || artifact.name === "portable");
const manifest: ReleaseManifest = {
  schemaVersion: 1,
  appVersion: metadata.version,
  sourceSha,
  sourceRef,
  dirty,
  generatedAt: new Date().toISOString(),
  signed: publishedArtifacts.every((artifact) => artifact.executable?.signatureStatus === "Valid"),
  signingPolicy: allowUnsigned ? "private-unsigned" : "signed",
  artifacts,
};
const manifestPath = join(releaseDir, "manifest.json");
const checksumsPath = join(releaseDir, "SHA256SUMS.txt");
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
writeFileSync(
  checksumsPath,
  `${publishedArtifacts.map((artifact) => `${artifact.sha256}  ${artifact.path.split("/").at(-1)}`).join("\n")}\n`,
  "utf8",
);

const persisted = JSON.parse(readFileSync(manifestPath, "utf8")) as ReleaseManifest;
for (const artifact of persisted.artifacts) {
  const artifactPath = join(root, ...artifact.path.split("/"));
  if (sha256(artifactPath) !== artifact.sha256) throw new Error(`Artifact hash changed after manifest write: ${artifact.path}`);
}

console.log(
  `Verified Scraply ${metadata.version} package (${archiveEntries.size} app.asar entries, ${artifacts.length} hashed artifacts, ${dirty ? "dirty" : "clean"} source).`,
);
