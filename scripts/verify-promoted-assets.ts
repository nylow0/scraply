import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { runtimePackageLockSchema } from "./runtime-package";
import { cliArchiveFilename, verifyCliArchive, type VerifyCliOptions } from "./verify-cli-package";

const fileSchema = z.object({ path: z.string(), bytes: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const cliMetadataSchema = z.object({ versionOutput: z.string(), signatureStatus: z.string() }).strict();
const manifestSchema = z.object({
  schemaVersion: z.union([z.literal(2), z.literal(3)]),
  appVersion: z.string(), sourceSha: z.string(), sourceRef: z.string(), dirty: z.boolean(),
  generatedAt: z.string().datetime(), signed: z.boolean(), signingPolicy: z.enum(["unsigned", "signed"]),
  artifacts: z.array(fileSchema.extend({
    name: z.string(),
    executable: z.object({ productName: z.string(), productVersion: z.string(), fileVersion: z.string(), signatureStatus: z.string() }).strict().optional(),
    cli: cliMetadataSchema.optional(),
  }).strict()),
  runtime: z.object({
    platform: z.string(), version: z.string(), protocolVersions: z.array(z.string()), sourceRepository: z.string(), sourceCommit: z.string(), upstreamCommit: z.string(),
    executable: fileSchema.extend({ versionOutput: z.string(), signatureStatus: z.string() }).strict(),
    lock: fileSchema, notices: z.array(fileSchema), checksums: fileSchema,
  }).strict(),
}).strict();

/** Only the published 0.1.1 layout predates CLI. Validate it from its own checkout;
 * newer versions cannot silently omit the sixth asset or reuse schema 2. */
export function releaseBundleLayout(version: string) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid release version.");
  const legacy = version === "0.1.1";
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  if (!legacy && major === 0 && minor === 0 && patch < 2) throw new Error("Unsupported historical release layout.");
  return {
    schemaVersion: legacy ? 2 : 3,
    cli: legacy ? null : cliArchiveFilename(version),
    files: [`Scraply Setup ${version}.exe`, `Scraply ${version}.exe`, "manifest.json", "SHA256SUMS.txt", "scraply-agent.lock.json", ...(legacy ? [] : [cliArchiveFilename(version)])].sort(),
    artifacts: ["installer", "portable", "unpacked", "app-asar", ...(legacy ? [] : ["cli"])].sort(),
  };
}

export async function verifyPromotedAssets(directory: string, expectedSha: string, expectedSourceRef: string, options: {
  root?: string;
  allowUnsigned?: boolean;
  cliChecks?: Pick<VerifyCliOptions, "runVersion" | "runRuntimeVersion" | "inspectSignature" | "machinePaths">;
} = {}) {
  const allowUnsigned = options.allowUnsigned ?? false;
  const root = options.root ?? process.cwd();
  if (!/^[a-f0-9]{40}$/i.test(expectedSha)) throw new Error("Promotion verification requires a full 40-character commit SHA.");

  const expectedVersion = z.object({ version: z.string() }).parse(JSON.parse(readFileSync(join(root, "package.json"), "utf8"))).version;
  const layout = releaseBundleLayout(expectedVersion);
  const runtimeLockPath = join(directory, "scraply-agent.lock.json");
  const runtimeLock = runtimePackageLockSchema.parse(
    JSON.parse(readFileSync(runtimeLockPath, "utf8")),
  );
  const installerName = `Scraply Setup ${expectedVersion}.exe`;
  const portableName = `Scraply ${expectedVersion}.exe`;

  function sha256(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  }

  const expectedFiles = layout.files;
  const actualFiles = readdirSync(directory).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(`The promoted bundle must contain exactly:\n${expectedFiles.join("\n")}\nFound:\n${actualFiles.join("\n")}`);
  }

  const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")));
  if (manifest.schemaVersion !== layout.schemaVersion) throw new Error(`Release ${expectedVersion} requires manifest schema ${layout.schemaVersion}.`);
  if (JSON.stringify(manifest.artifacts.map((artifact) => artifact.name).sort()) !== JSON.stringify(layout.artifacts)) {
    throw new Error("The promoted manifest must contain exactly the expected artifacts.");
  }
  if (manifest.appVersion !== expectedVersion) throw new Error("The promoted manifest version does not match package.json.");
  if (manifest.sourceSha !== expectedSha) throw new Error("The promoted manifest SHA does not match the approved source SHA.");
  if (runtimeLock.sourceRepository !== "https://github.com/nylow0/scraply" || runtimeLock.sourceCommit !== expectedSha) {
    throw new Error("The promoted runtime must originate from the approved Scraply commit.");
  }
  if (manifest.sourceRef !== expectedSourceRef) throw new Error("The promoted manifest source ref does not match the approved candidate.");
  if (manifest.dirty !== false) throw new Error("The promoted manifest was produced from a dirty source tree.");
  if (!Array.isArray(manifest.artifacts)) throw new Error("The promoted manifest has no artifact records.");
  if (!manifest.runtime) throw new Error("The promoted manifest has no runtime record.");
  if (allowUnsigned) {
    if (manifest.signingPolicy !== "unsigned") {
      throw new Error("Unsigned releases must declare the unsigned signing policy.");
    }
  } else if (!manifest.signed || manifest.signingPolicy !== "signed") {
    throw new Error("A signed release requires validly signed executables; pass --allow-unsigned for an unsigned release.");
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
      throw new Error(`The promoted runtime ${field} does not match the bundled runtime lock.`);
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
      throw new Error(`The promoted runtime executable ${field} does not match the bundled runtime lock.`);
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
    throw new Error("The promoted runtime lock file does not match the bundled runtime lock.");
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
    throw new Error("The promoted runtime notices do not match the bundled runtime lock.");
  }

  const expectedRuntimeChecksums = {
    path: `runtime/${runtimeLock.checksums.path}`,
    bytes: runtimeLock.checksums.sizeBytes,
    sha256: runtimeLock.checksums.sha256,
  };
  if (JSON.stringify(manifest.runtime.checksums) !== JSON.stringify(expectedRuntimeChecksums)) {
    throw new Error("The promoted runtime checksums do not match the bundled runtime lock.");
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

  if (layout.cli) {
    const artifact = manifest.artifacts.find((artifact) => artifact.name === "cli")!;
    if (artifact.path !== `release-cli/${layout.cli}` || !artifact.cli || artifact.executable) {
      throw new Error("The manifest CLI archive path or executable metadata is invalid.");
    }
    const path = join(directory, layout.cli);
    if (statSync(path).size !== artifact.bytes || sha256(path) !== artifact.sha256) throw new Error("The promoted CLI archive differs from the manifest.");
    const cli = await verifyCliArchive(path, {
      ...options.cliChecks, root, sourceLockPath: runtimeLockPath, appVersion: expectedVersion, expectedSourceSha: expectedSha, allowUnsigned,
    });
    if (cli.versionOutput !== artifact.cli.versionOutput || cli.signatureStatus !== artifact.cli.signatureStatus
      || cli.runtimeLockSha256 !== sha256(runtimeLockPath)) throw new Error("The promoted CLI metadata or worker lock differs from the manifest.");
    if (manifest.signed && cli.signatureStatus !== "Valid") throw new Error("Signed manifest contains an unsigned CLI.");
    checksumLines.push(`${artifact.sha256}  ${layout.cli}`);
  }

  if (readFileSync(join(directory, "SHA256SUMS.txt"), "utf8") !== `${checksumLines.join("\n")}\n`) {
    throw new Error("SHA256SUMS.txt does not match the verified release assets.");
  }

  console.log(`Verified promoted Scraply ${expectedVersion} assets from ${expectedSourceRef} (${expectedSha}).`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg.startsWith("--") && arg !== "--allow-unsigned")) throw new Error("Unsupported promotion verification flag.");
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const [directory, expectedSha, expectedSourceRef] = positional;
  if (!directory || !expectedSha || !expectedSourceRef || positional.length !== 3) {
    throw new Error("Usage: bun scripts/verify-promoted-assets.ts <directory> <sha> <source-ref> [--allow-unsigned]");
  }
  await verifyPromotedAssets(directory, expectedSha, expectedSourceRef, { allowUnsigned: args.includes("--allow-unsigned") });
}
