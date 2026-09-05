import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import extractZip from "extract-zip";
import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const sourceCommitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const semverSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
const archiveMemberSchema = z.string().min(1).refine((path) => (
  !isAbsolute(path)
  && path === basename(path)
  && path !== "."
  && path !== ".."
  && !path.includes("\0")
), "must be a plain archive filename");

const archiveSchema = z.object({
  fileName: archiveMemberSchema,
  sha256: sha256Schema,
  sizeBytes: z.number().int().positive().max(25 * 1024 * 1024),
}).strict();

const noticeSchema = z.object({
  source: archiveMemberSchema,
  target: archiveMemberSchema,
  sha256: sha256Schema,
  sizeBytes: z.number().int().positive().max(1024 * 1024),
}).strict();

const checksumsSchema = z.object({
  path: z.literal("SHA256SUMS.txt"),
  sha256: sha256Schema,
  sizeBytes: z.number().int().positive().max(64 * 1024),
}).strict();

export const runtimePackageLockSchema = z.object({
  schemaVersion: z.literal(1),
  platform: z.literal("windows-x64"),
  executable: z.literal("scraply-agent.exe"),
  version: semverSchema,
  protocolVersions: z.tuple([z.literal("1.1")]),
  sourceRepository: z.literal("https://github.com/nylow0/scraply-agent"),
  sourceCommit: sourceCommitSchema,
  upstreamCommit: sourceCommitSchema,
  artifactPath: z.literal("scraply-agent.exe"),
  sha256: sha256Schema,
  sizeBytes: z.number().int().positive().max(20 * 1024 * 1024),
  archive: archiveSchema,
  notices: z.array(noticeSchema).length(3),
  checksums: checksumsSchema,
}).strict().superRefine((lock, context) => {
  const expectedArchive = `scraply-agent-${lock.version}-windows-x64-${lock.sourceCommit.slice(0, 12)}.zip`;
  if (lock.archive.fileName !== expectedArchive) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["archive", "fileName"],
      message: `must be ${expectedArchive}`,
    });
  }

  const expectedNotices = ["LICENSE", "OPENAI-NOTICE", "UPSTREAM.md"];
  const sources = lock.notices.map((notice) => notice.source).sort();
  const targets = lock.notices.map((notice) => notice.target).sort();
  if (JSON.stringify(sources) !== JSON.stringify(expectedNotices)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["notices"],
      message: `must contain exactly ${expectedNotices.join(", ")}`,
    });
  }
  if (new Set(targets).size !== targets.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["notices"],
      message: "must use unique target filenames",
    });
  }
});

export type RuntimePackageLock = z.infer<typeof runtimePackageLockSchema>;

export const packagedRuntimeLockName = "scraply-agent.lock.json";
export const runtimeLockRelativePath = join(
  "runtime-artifacts",
  "scraply-agent.windows-x64.lock.json",
);
export const runtimeStageRelativePath = join("build", "runtime");

const debugMarkers = [
  "SCRAPLY_AGENT_TEST_FIXTURE",
  "SCRAPLY_AGENT_TEST_BASE_URL",
];

interface ZipEntryMetadata {
  fileName: string;
  uncompressedSize: number;
  externalFileAttributes: number;
}

export interface VerifiedRuntimePackage {
  lock: RuntimePackageLock;
  lockPath: string;
  lockBytes: number;
  lockSha256: string;
  executablePath: string;
  versionOutput: string;
  notices: Array<{
    path: string;
    bytes: number;
    sha256: string;
  }>;
  checksums: {
    path: string;
    bytes: number;
    sha256: string;
  };
}

export interface StageRuntimeOptions {
  root?: string;
  lockPath?: string;
  stageDirectory?: string;
  runVersion?: (executablePath: string) => string;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readLock(path: string): { lock: RuntimePackageLock; contents: string } {
  const contents = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Runtime lock is not valid JSON: ${path}`, { cause: error });
  }
  const result = runtimePackageLockSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "lock"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid runtime lock ${path}:\n${issues}`);
  }
  return { lock: result.data, contents };
}

function assertFile(path: string, description: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`${description} is missing: ${path}`);
  }
}

function assertFileIdentity(
  path: string,
  expectedBytes: number,
  expectedSha256: string,
  description: string,
): void {
  assertFile(path, description);
  const actualBytes = statSync(path).size;
  if (actualBytes !== expectedBytes) {
    throw new Error(`${description} has ${actualBytes} bytes; expected ${expectedBytes}: ${path}`);
  }
  const actualSha256 = sha256(path);
  if (actualSha256 !== expectedSha256) {
    throw new Error(`${description} SHA-256 is ${actualSha256}; expected ${expectedSha256}: ${path}`);
  }
}

function assertWindowsX64Executable(path: string): Buffer {
  const bytes = readFileSync(path);
  if (bytes.length < 0x86 || bytes.subarray(0, 2).toString("ascii") !== "MZ") {
    throw new Error(`Runtime is not a Windows PE executable: ${path}`);
  }
  const peOffset = bytes.readUInt32LE(0x3c);
  if (
    peOffset > bytes.length - 6
    || bytes.subarray(peOffset, peOffset + 4).toString("hex") !== "50450000"
  ) {
    throw new Error(`Runtime has an invalid Windows PE header: ${path}`);
  }
  if (bytes.readUInt16LE(peOffset + 4) !== 0x8664) {
    throw new Error(`Runtime is not a Windows x64 executable: ${path}`);
  }
  return bytes;
}

function assertNoDebugMarkers(bytes: Buffer, path: string): void {
  const present = debugMarkers.filter((marker) => bytes.includes(Buffer.from(marker, "ascii")));
  if (present.length > 0) {
    throw new Error(`Runtime contains debug-only fixture markers (${present.join(", ")}): ${path}`);
  }
}

function defaultRunVersion(executablePath: string): string {
  const result = Bun.spawnSync([executablePath, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const stdout = new TextDecoder().decode(result.stdout).trim();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  if (result.exitCode !== 0) {
    throw new Error(stderr || `Runtime version check exited with code ${result.exitCode}.`);
  }
  if (stderr) throw new Error(`Runtime version check wrote to stderr: ${stderr}`);
  return stdout;
}

function assertVersion(
  executablePath: string,
  version: string,
  runVersion: (executablePath: string) => string,
): string {
  const output = runVersion(executablePath);
  const expected = `scraply-agent ${version}`;
  if (output !== expected) {
    throw new Error(`Runtime version output is ${JSON.stringify(output)}; expected ${JSON.stringify(expected)}.`);
  }
  return output;
}

function expectedArchiveMembers(lock: RuntimePackageLock): Map<string, number> {
  return new Map([
    [lock.artifactPath, lock.sizeBytes],
    ...lock.notices.map((notice): [string, number] => [notice.source, notice.sizeBytes]),
    [lock.checksums.path, lock.checksums.sizeBytes],
  ]);
}

function assertSafeZipEntry(
  entry: ZipEntryMetadata,
  expected: Map<string, number>,
  seen: Set<string>,
): void {
  const normalized = entry.fileName.replaceAll("\\", "/");
  if (
    normalized !== entry.fileName
    || normalized !== basename(normalized)
    || normalized === "."
    || normalized === ".."
    || normalized.includes("\0")
  ) {
    throw new Error(`Runtime archive contains an unsafe path: ${JSON.stringify(entry.fileName)}`);
  }
  if (!expected.has(normalized)) {
    throw new Error(`Runtime archive contains an unexpected entry: ${normalized}`);
  }
  if (seen.has(normalized)) {
    throw new Error(`Runtime archive contains a duplicate entry: ${normalized}`);
  }
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const fileType = unixMode & 0xf000;
  const dosAttributes = entry.externalFileAttributes & 0xffff;
  if (fileType === 0xa000 || (dosAttributes & 0x400) !== 0) {
    throw new Error(`Runtime archive contains a link or reparse point: ${normalized}`);
  }
  if (normalized.endsWith("/") || fileType === 0x4000) {
    throw new Error(`Runtime archive contains a directory entry: ${normalized}`);
  }
  const expectedBytes = expected.get(normalized)!;
  if (entry.uncompressedSize !== expectedBytes) {
    throw new Error(
      `Runtime archive entry ${normalized} declares ${entry.uncompressedSize} bytes; expected ${expectedBytes}.`,
    );
  }
  seen.add(normalized);
}

function expectedChecksumText(lock: RuntimePackageLock): string {
  const entries = [
    { path: lock.artifactPath, sha256: lock.sha256 },
    ...lock.notices.map((notice) => ({ path: notice.source, sha256: notice.sha256 })),
  ].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return `${entries.map((entry) => `${entry.sha256}  ${entry.path}`).join("\n")}\n`;
}

function assertChecksumFile(path: string, lock: RuntimePackageLock): void {
  const actual = readFileSync(path, "utf8").replaceAll("\r\n", "\n");
  const expected = expectedChecksumText(lock);
  if (actual !== expected) {
    throw new Error(`Runtime ${lock.checksums.path} does not match the locked package files.`);
  }
}

function assertSafeStagePath(root: string, stageDirectory: string): void {
  const buildDirectory = resolve(root, "build");
  mkdirSync(buildDirectory, { recursive: true });
  const resolvedStage = resolve(stageDirectory);
  if (dirname(resolvedStage) !== buildDirectory || basename(resolvedStage) !== "runtime") {
    throw new Error(`Runtime stage directory must be exactly ${join(buildDirectory, "runtime")}.`);
  }
}

export async function stageRuntimePackage(
  options: StageRuntimeOptions = {},
): Promise<VerifiedRuntimePackage> {
  const root = resolve(options.root ?? process.cwd());
  const lockPath = resolve(options.lockPath ?? join(root, runtimeLockRelativePath));
  const stageDirectory = resolve(options.stageDirectory ?? join(root, runtimeStageRelativePath));
  const runVersion = options.runVersion ?? defaultRunVersion;
  assertSafeStagePath(root, stageDirectory);
  assertFile(lockPath, "Runtime lock");
  const { lock, contents: lockContents } = readLock(lockPath);
  const archivePath = resolve(dirname(lockPath), lock.archive.fileName);
  assertFileIdentity(archivePath, lock.archive.sizeBytes, lock.archive.sha256, "Runtime archive");

  const buildDirectory = resolve(root, "build");
  const temporaryDirectory = mkdtempSync(join(buildDirectory, ".runtime-stage-"));
  try {
    const expected = expectedArchiveMembers(lock);
    const seen = new Set<string>();
    await extractZip(archivePath, {
      dir: temporaryDirectory,
      onEntry(entry) {
        assertSafeZipEntry(entry, expected, seen);
      },
    });
    const missing = [...expected.keys()].filter((path) => !seen.has(path));
    if (missing.length > 0) {
      throw new Error(`Runtime archive is missing entries:\n${missing.join("\n")}`);
    }

    const executablePath = join(temporaryDirectory, lock.artifactPath);
    assertFileIdentity(executablePath, lock.sizeBytes, lock.sha256, "Runtime executable");
    const executableBytes = assertWindowsX64Executable(executablePath);
    assertNoDebugMarkers(executableBytes, executablePath);
    assertVersion(executablePath, lock.version, runVersion);

    for (const notice of lock.notices) {
      const source = join(temporaryDirectory, notice.source);
      assertFileIdentity(source, notice.sizeBytes, notice.sha256, `Runtime notice ${notice.source}`);
      if (notice.target !== notice.source) {
        renameSync(source, join(temporaryDirectory, notice.target));
      }
    }
    const checksumsPath = join(temporaryDirectory, lock.checksums.path);
    assertFileIdentity(
      checksumsPath,
      lock.checksums.sizeBytes,
      lock.checksums.sha256,
      "Runtime checksums",
    );
    assertChecksumFile(checksumsPath, lock);

    const packagedLockPath = join(temporaryDirectory, packagedRuntimeLockName);
    writeFileSync(packagedLockPath, lockContents, "utf8");
    rmSync(stageDirectory, { recursive: true, force: true });
    renameSync(temporaryDirectory, stageDirectory);
  } catch (error) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }

  return verifyStagedRuntime(stageDirectory, lockPath, runVersion);
}

export function verifyStagedRuntime(
  stageDirectory: string,
  sourceLockPath: string,
  runVersion: (executablePath: string) => string = defaultRunVersion,
): VerifiedRuntimePackage {
  const packagedLockPath = join(stageDirectory, packagedRuntimeLockName);
  assertFile(packagedLockPath, "Packaged runtime lock");
  const sourceLockContents = readFileSync(sourceLockPath, "utf8");
  const packagedLockContents = readFileSync(packagedLockPath, "utf8");
  if (packagedLockContents !== sourceLockContents) {
    throw new Error("Packaged runtime lock differs from the tracked source lock.");
  }
  const { lock } = readLock(packagedLockPath);
  const expectedFiles = [
    lock.executable,
    ...lock.notices.map((notice) => notice.target),
    lock.checksums.path,
    packagedRuntimeLockName,
  ].sort();
  const actualFiles = readdirSync(stageDirectory, { withFileTypes: true })
    .map((entry) => {
      if (!entry.isFile()) throw new Error(`Runtime stage contains a non-file entry: ${entry.name}`);
      return entry.name;
    })
    .sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(
      `Runtime stage must contain exactly:\n${expectedFiles.join("\n")}\nFound:\n${actualFiles.join("\n")}`,
    );
  }

  const executablePath = join(stageDirectory, lock.executable);
  assertFileIdentity(executablePath, lock.sizeBytes, lock.sha256, "Runtime executable");
  const executableBytes = assertWindowsX64Executable(executablePath);
  assertNoDebugMarkers(executableBytes, executablePath);
  const versionOutput = assertVersion(executablePath, lock.version, runVersion);
  const notices = lock.notices.map((notice) => {
    const path = join(stageDirectory, notice.target);
    assertFileIdentity(path, notice.sizeBytes, notice.sha256, `Runtime notice ${notice.target}`);
    return { path: notice.target, bytes: notice.sizeBytes, sha256: notice.sha256 };
  });
  const checksumsPath = join(stageDirectory, lock.checksums.path);
  assertFileIdentity(
    checksumsPath,
    lock.checksums.sizeBytes,
    lock.checksums.sha256,
    "Runtime checksums",
  );
  assertChecksumFile(checksumsPath, lock);
  return {
    lock,
    lockPath: packagedRuntimeLockName,
    lockBytes: statSync(packagedLockPath).size,
    lockSha256: sha256(packagedLockPath),
    executablePath,
    versionOutput,
    notices,
    checksums: {
      path: lock.checksums.path,
      bytes: lock.checksums.sizeBytes,
      sha256: lock.checksums.sha256,
    },
  };
}

export function relativeRuntimePath(path: string): string {
  return relative(process.cwd(), path).replaceAll("\\", "/");
}
