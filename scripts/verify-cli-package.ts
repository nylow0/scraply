import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import extractZip from "extract-zip";
import { z } from "zod";
import { WORKFLOW_V2_STAGE_REGISTRY } from "../src/core/stages";
import { runtimeLockRelativePath, runtimePackageLockSchema, verifyStagedRuntime, type RuntimePackageLock } from "./runtime-package";

export const cliPromptNames = [...new Set([
  ...Object.values(WORKFLOW_V2_STAGE_REGISTRY).map((stage) => stage.promptFilename),
  "writing-guidance.md",
])].sort();

export function cliArchiveFilename(version: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("CLI packaging requires an app release version.");
  return `scraply-cli-${version}-win-x64.zip`;
}

export function cliPackageFiles(lock: RuntimePackageLock): string[] {
  return [
    "scraply.exe", "LICENSE",
    `runtime/${lock.executable}`, "runtime/scraply-agent.lock.json",
    `runtime/${lock.checksums.path}`,
    ...lock.notices.map((notice) => `runtime/${notice.target}`),
    ...cliPromptNames.map((name) => `prompts/${name}`),
  ].sort();
}

/** Search using local values, but never put those values in an error or manifest. */
export function assertNoMachinePaths(bytes: Buffer, paths: readonly string[]): void {
  for (const path of paths.filter((value) => value.length > 5)) {
    for (const spelling of [path.replaceAll("\\", "/"), path.replaceAll("/", "\\")]) {
      if (["utf8", "utf16le"].some((encoding) => bytes.includes(Buffer.from(spelling, encoding as BufferEncoding)))) {
        throw new Error("CLI package contains a local machine path.");
      }
    }
  }
}

export function cliSignatureStatus(executable: string): string {
  const result = Bun.spawnSync(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference = 'Stop'; (Get-AuthenticodeSignature -LiteralPath $env:SCRAPLY_VERIFY_CLI).Status.ToString()"], {
    env: { ...process.env, PSModulePath: "", SCRAPLY_VERIFY_CLI: executable, EXA_API_KEY: "", PERPLEXITY_API_KEY: "" },
    stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  if (result.exitCode !== 0) throw new Error("Could not inspect the compiled CLI signature.");
  return new TextDecoder().decode(result.stdout).trim();
}

function versionOutput(executable: string): string {
  const result = Bun.spawnSync([executable, "--version", "--json"], {
    env: { ...process.env, EXA_API_KEY: "", PERPLEXITY_API_KEY: "", SCRAPLY_DATA_DIR: join(dirname(executable), ".verification-profile") },
    stdout: "pipe", stderr: "pipe", windowsHide: true, timeout: 10_000,
  });
  if (result.exitCode !== 0 || result.stderr.length > 0) throw new Error("Compiled CLI version check failed.");
  return new TextDecoder().decode(result.stdout).trim();
}

function packageInventory(directory: string, prefix = ""): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("CLI package contains a link.");
    if (stat.isDirectory()) {
      if (prefix || !["runtime", "prompts"].includes(name)) throw new Error(`Unexpected CLI package directory: ${relative}`);
      return packageInventory(path, relative);
    }
    if (!stat.isFile()) throw new Error("CLI package contains a non-file entry.");
    return [relative];
  }).sort();
}

export interface VerifyCliOptions {
  root?: string;
  sourceLockPath?: string;
  expectedSourceSha?: string;
  appVersion?: string;
  allowUnsigned?: boolean;
  runVersion?: (executable: string) => string;
  runRuntimeVersion?: (executable: string) => string;
  inspectSignature?: (executable: string) => string;
  machinePaths?: readonly string[];
}

export function verifyCliDirectory(directory: string, options: VerifyCliOptions = {}) {
  const root = resolve(options.root ?? process.cwd());
  const sourceLock = options.sourceLockPath ?? join(root, runtimeLockRelativePath);
  const runtime = verifyStagedRuntime(join(directory, "runtime"), sourceLock, options.runRuntimeVersion);
  if (options.expectedSourceSha && (
    runtime.lock.sourceRepository !== "https://github.com/nylow0/scraply"
    || runtime.lock.sourceCommit !== options.expectedSourceSha
  )) throw new Error("CLI runtime does not match the approved source commit. Run bun run prepare:runtime.");
  const expected = cliPackageFiles(runtime.lock);
  if (JSON.stringify(packageInventory(directory)) !== JSON.stringify(expected)) {
    throw new Error("CLI package file list does not match the exact allowlist.");
  }
  const localPaths = options.machinePaths ?? [root, process.env.USERPROFILE ?? "", process.env.APPDATA ?? ""];
  for (const name of expected) assertNoMachinePaths(readFileSync(join(directory, name)), localPaths);
  for (const name of ["LICENSE", ...cliPromptNames.map((name) => `prompts/${name}`)]) {
    if (!readFileSync(join(directory, name)).equals(readFileSync(join(root, name)))) {
      throw new Error(`CLI bundled file differs from its source: ${name}`);
    }
  }
  const bytes = readFileSync(join(directory, "scraply.exe"));
  const peOffset = bytes.length >= 0x40 ? bytes.readUInt32LE(0x3c) : -1;
  if (peOffset < 0 || peOffset > bytes.length - 6 || bytes.subarray(0, 2).toString("ascii") !== "MZ"
    || bytes.subarray(peOffset, peOffset + 4).toString("hex") !== "50450000"
    || bytes.readUInt16LE(peOffset + 4) !== 0x8664) throw new Error("CLI is not a Windows x64 executable.");
  const appVersion = options.appVersion ?? z.object({ version: z.string() }).parse(JSON.parse(readFileSync(join(root, "package.json"), "utf8"))).version;
  const output = (options.runVersion ?? versionOutput)(join(directory, "scraply.exe"));
  let version: unknown;
  try { version = JSON.parse(output); } catch { throw new Error("Compiled CLI version must return a JSON success envelope when piped."); }
  const parsedVersion = z.object({ ok: z.literal(true), data: z.object({ version: z.literal(appVersion) }).strict() }).strict().safeParse(version);
  if (!parsedVersion.success) throw new Error("Compiled CLI version does not match the expected package.json version envelope.");
  if (JSON.stringify(packageInventory(directory)) !== JSON.stringify(expected)) throw new Error("Compiled CLI version check changed the extracted package.");
  const signatureStatus = (options.inspectSignature ?? cliSignatureStatus)(join(directory, "scraply.exe"));
  if (signatureStatus !== "Valid" && !(options.allowUnsigned && signatureStatus === "NotSigned")) {
    throw new Error(`Unacceptable compiled CLI signature status: ${signatureStatus}`);
  }
  return { appVersion, versionOutput: output, signatureStatus, runtime };
}

export async function verifyCliArchive(archivePath: string, options: VerifyCliOptions = {}) {
  const root = resolve(options.root ?? process.cwd());
  const lock = runtimePackageLockSchema.parse(JSON.parse(readFileSync(options.sourceLockPath ?? join(root, runtimeLockRelativePath), "utf8")));
  const expected = new Set(cliPackageFiles(lock));
  const seen = new Set<string>();
  mkdirSync(join(root, "build"), { recursive: true });
  const temporary = mkdtempSync(join(root, "build", ".cli-verify-"));
  try {
    await extractZip(resolve(archivePath), { dir: temporary, onEntry(entry) {
      const name = entry.fileName;
      if (!expected.has(name) || name.includes("\\") || seen.has(name)) throw new Error("CLI archive contains an unexpected or duplicate entry.");
      const fileType = (entry.externalFileAttributes >>> 16) & 0xf000;
      if (fileType === 0xa000 || fileType === 0x4000 || (entry.externalFileAttributes & 0x400) !== 0) throw new Error("CLI archive contains a link or directory entry.");
      const maxBytes = name === "scraply.exe" ? 256 * 1024 * 1024 : name === `runtime/${lock.executable}` ? lock.sizeBytes : 1024 * 1024;
      if (entry.uncompressedSize <= 0 || entry.uncompressedSize > maxBytes) throw new Error("CLI archive entry has an invalid size.");
      seen.add(name);
    } });
    if (seen.size !== expected.size) throw new Error("CLI archive is missing required files.");
    const verified = verifyCliDirectory(temporary, options);
    return {
      appVersion: verified.appVersion,
      versionOutput: verified.versionOutput,
      signatureStatus: verified.signatureStatus,
      sha256: createHash("sha256").update(readFileSync(archivePath)).digest("hex"),
      runtimeLockSha256: verified.runtime.lockSha256,
    };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

if (import.meta.main) {
  const root = process.cwd();
  const version = z.object({ version: z.string() }).parse(JSON.parse(readFileSync(join(root, "package.json"), "utf8"))).version;
  const verified = await verifyCliArchive(process.argv[2] ?? join(root, "release-cli", cliArchiveFilename(version)), {
    allowUnsigned: process.env.SCRAPLY_ALLOW_UNSIGNED === "1" || process.env.SCRAPLY_RELEASE_STRICT !== "1",
  });
  console.log(`Verified standalone Scraply ${verified.appVersion} CLI archive.`);
}
