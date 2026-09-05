import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { runtimePackageLockSchema } from "./runtime-package";

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
  schemaVersion: number;
  appVersion: string;
  sourceSha: string;
  sourceRef: string;
  dirty: boolean;
  signed: boolean;
  signingPolicy: string;
  artifacts: ManifestArtifact[];
  runtime: RuntimeManifest;
}

interface RuntimeFileManifest {
  path: string;
  bytes: number;
  sha256: string;
}

interface RuntimeManifest {
  platform: string;
  version: string;
  protocolVersions: string[];
  sourceRepository: string;
  sourceCommit: string;
  upstreamCommit: string;
  executable: RuntimeFileManifest & {
    versionOutput: string;
    signatureStatus: string;
  };
  lock: RuntimeFileManifest;
  notices: RuntimeFileManifest[];
  checksums: RuntimeFileManifest;
}

const allowUnsigned = process.argv.includes("--allow-unsigned");
const [directory, expectedSha, expectedSourceRef] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
if (!directory || !expectedSha || !expectedSourceRef) {
  throw new Error("Usage: bun scripts/verify-promoted-assets.ts <directory> <sha> <source-ref> [--allow-unsigned]");
}
if (!/^[a-f0-9]{40}$/i.test(expectedSha)) throw new Error("Promotion verification requires a full 40-character commit SHA.");

const expectedVersion = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;
const runtimeLockPath = process.env.SCRAPLY_RUNTIME_LOCK_PATH
  ?? join("runtime-artifacts", "scraply-agent.windows-x64.lock.json");
const runtimeLock = runtimePackageLockSchema.parse(
  JSON.parse(readFileSync(runtimeLockPath, "utf8")),
);
const installerName = `Scraply Setup ${expectedVersion}.exe`;
const portableName = `Scraply ${expectedVersion}.exe`;

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const expectedFiles = [installerName, portableName, "manifest.json", "SHA256SUMS.txt"].sort();
const actualFiles = readdirSync(directory).sort();
if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
  throw new Error(`The promoted bundle must contain exactly:\n${expectedFiles.join("\n")}\nFound:\n${actualFiles.join("\n")}`);
}

const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")) as ReleaseManifest;
if (manifest.schemaVersion !== 2) throw new Error(`Unsupported manifest schema version: ${manifest.schemaVersion}`);
if (manifest.appVersion !== expectedVersion) throw new Error("The promoted manifest version does not match package.json.");
if (manifest.sourceSha !== expectedSha) throw new Error("The promoted manifest SHA does not match the approved source SHA.");
if (manifest.sourceRef !== expectedSourceRef) throw new Error("The promoted manifest source ref does not match the approved candidate.");
if (manifest.dirty !== false) throw new Error("The promoted manifest was produced from a dirty source tree.");
if (!Array.isArray(manifest.artifacts)) throw new Error("The promoted manifest has no artifact records.");
if (!manifest.runtime) throw new Error("The promoted manifest has no runtime record.");
if (allowUnsigned) {
  if (manifest.signingPolicy !== "private-unsigned") {
    throw new Error("Private unsigned releases must declare the private-unsigned signing policy.");
  }
} else if (!manifest.signed || manifest.signingPolicy !== "signed") {
  throw new Error("The public release policy requires validly signed executables.");
}

const expectedRuntime = {
  platform: runtimeLock.platform,
  version: runtimeLock.version,
  protocolVersions: runtimeLock.protocolVersions,
  sourceRepository: runtimeLock.sourceRepository,
  sourceCommit: runtimeLock.sourceCommit,
  upstreamCommit: runtimeLock.upstreamCommit,
};
for (const [field, expected] of Object.entries(expectedRuntime)) {
  const actual = manifest.runtime[field as keyof typeof expectedRuntime];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`The promoted runtime ${field} does not match the tracked runtime lock.`);
  }
}

const expectedRuntimeExecutable = {
  path: `runtime/${runtimeLock.executable}`,
  bytes: runtimeLock.sizeBytes,
  sha256: runtimeLock.sha256,
  versionOutput: `scraply-agent ${runtimeLock.version}`,
};
for (const [field, expected] of Object.entries(expectedRuntimeExecutable)) {
  const actual = manifest.runtime.executable[field as keyof typeof expectedRuntimeExecutable];
  if (actual !== expected) {
    throw new Error(`The promoted runtime executable ${field} does not match the tracked runtime lock.`);
  }
}
if (
  manifest.runtime.executable.signatureStatus !== "Valid"
  && !(allowUnsigned && manifest.runtime.executable.signatureStatus === "NotSigned")
) {
  throw new Error(
    `Unacceptable runtime signature status: ${manifest.runtime.executable.signatureStatus}`,
  );
}

const expectedRuntimeLockFile = {
  path: "runtime/scraply-agent.lock.json",
  bytes: statSync(runtimeLockPath).size,
  sha256: sha256(runtimeLockPath),
};
if (JSON.stringify(manifest.runtime.lock) !== JSON.stringify(expectedRuntimeLockFile)) {
  throw new Error("The promoted runtime lock file does not match the tracked runtime lock.");
}

const expectedNotices = runtimeLock.notices
  .map((notice) => ({
    path: `runtime/${notice.target}`,
    bytes: notice.sizeBytes,
    sha256: notice.sha256,
  }))
  .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
const actualNotices = [...manifest.runtime.notices]
  .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
if (JSON.stringify(actualNotices) !== JSON.stringify(expectedNotices)) {
  throw new Error("The promoted runtime notices do not match the tracked runtime lock.");
}

const expectedRuntimeChecksums = {
  path: `runtime/${runtimeLock.checksums.path}`,
  bytes: runtimeLock.checksums.sizeBytes,
  sha256: runtimeLock.checksums.sha256,
};
if (JSON.stringify(manifest.runtime.checksums) !== JSON.stringify(expectedRuntimeChecksums)) {
  throw new Error("The promoted runtime checksums do not match the tracked runtime lock.");
}

const checksumLines: string[] = [];
for (const expected of [{ name: "installer", filename: installerName }, { name: "portable", filename: portableName }]) {
  const matches = manifest.artifacts.filter((artifact) => artifact.name === expected.name);
  if (matches.length !== 1) throw new Error(`The manifest must contain exactly one ${expected.name} artifact.`);
  const artifact = matches[0]!;
  if (artifact.path !== `release/${expected.filename}`) {
    throw new Error(`The manifest ${expected.name} path is not release/${expected.filename}.`);
  }
  if (!Number.isInteger(artifact.bytes) || artifact.bytes <= 0) throw new Error(`Invalid ${expected.name} byte count.`);
  if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error(`Invalid ${expected.name} SHA-256 value.`);
  const executable = artifact.executable;
  if (!executable) throw new Error(`The manifest ${expected.name} is missing executable metadata.`);
  if (
    executable.productName !== "Scraply"
    || executable.fileVersion !== expectedVersion
    || !executable.productVersion.startsWith(expectedVersion)
  ) {
    throw new Error(`The manifest ${expected.name} executable identity does not match Scraply ${expectedVersion}.`);
  }
  if (executable.signatureStatus !== "Valid" && !(allowUnsigned && executable.signatureStatus === "NotSigned")) {
    throw new Error(`Unacceptable ${expected.name} signature status: ${executable.signatureStatus}`);
  }

  const path = join(directory, expected.filename);
  if (statSync(path).size !== artifact.bytes) throw new Error(`The promoted ${expected.name} size does not match the manifest.`);
  if (sha256(path) !== artifact.sha256) throw new Error(`The promoted ${expected.name} hash does not match the manifest.`);
  checksumLines.push(`${artifact.sha256}  ${expected.filename}`);
}

if (readFileSync(join(directory, "SHA256SUMS.txt"), "utf8") !== `${checksumLines.join("\n")}\n`) {
  throw new Error("SHA256SUMS.txt does not match the verified installer and portable executable.");
}

console.log(`Verified promoted Scraply ${expectedVersion} assets from ${expectedSourceRef} (${expectedSha}).`);
