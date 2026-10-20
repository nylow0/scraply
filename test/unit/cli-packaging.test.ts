import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { cliDevLaunch } from "../../scripts/cli-dev";
import { createCliArchive } from "../../scripts/package-cli";
import { cliTestSuites, parseCliTestArguments, runCliTests } from "../../scripts/test-cli";
import { assertNoMachinePaths, cliArchiveFilename, cliPackageFiles, cliPromptNames, verifyCliArchive, verifyCliDirectory } from "../../scripts/verify-cli-package";
import { releaseBundleLayout, verifyPromotedAssets } from "../../scripts/verify-promoted-assets";
import { type RuntimePackageLock } from "../../scripts/runtime-package";
import { parseSetupArguments, setupCli, updateUserPath, type UserPathRegistry, type UserPathValue } from "../../src/cli/setup";

const roots: string[] = [];
const sourceSha = "a".repeat(40);
const versionEnvelope = JSON.stringify({ ok: true, data: { version: "0.1.2" } });
const checks = {
  runVersion: () => versionEnvelope,
  runRuntimeVersion: () => "scraply-agent 0.1.0",
  inspectSignature: () => "NotSigned",
  allowUnsigned: true,
  expectedSourceSha: sourceSha,
};

function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fakeExecutable(): Buffer {
  const bytes = Buffer.alloc(512);
  bytes.write("MZ"); bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write("PE\0\0", 0x80); bytes.writeUInt16LE(0x8664, 0x84);
  return bytes;
}

function fixture() {
  const build = resolve("build");
  mkdirSync(build, { recursive: true });
  const root = mkdtempSync(join(build, ".cli-packaging-test-"));
  roots.push(root);
  const stage = join(root, "stage");
  const runtime = join(stage, "runtime");
  mkdirSync(runtime, { recursive: true });
  mkdirSync(join(stage, "prompts"));
  mkdirSync(join(root, "prompts"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "0.1.2" }));
  writeFileSync(join(root, "LICENSE"), "Synthetic package license\n");
  copyFileSync(join(root, "LICENSE"), join(stage, "LICENSE"));
  writeFileSync(join(stage, "scraply.exe"), fakeExecutable());
  writeFileSync(join(runtime, "scraply-agent.exe"), fakeExecutable());
  for (const name of cliPromptNames) {
    writeFileSync(join(root, "prompts", name), `Synthetic prompt ${name}\n`);
    copyFileSync(join(root, "prompts", name), join(stage, "prompts", name));
  }
  const notices = ["LICENSE", "OPENAI-NOTICE", "UPSTREAM.md"].map((name) => {
    const path = join(runtime, name);
    writeFileSync(path, `Synthetic runtime notice ${name}\n`);
    return { source: name, target: name, sha256: hash(path), sizeBytes: statSync(path).size };
  });
  const checksumText = ["scraply-agent.exe", ...notices.map((notice) => notice.source)].sort()
    .map((name) => `${hash(join(runtime, name))}  ${name}`).join("\n") + "\n";
  writeFileSync(join(runtime, "SHA256SUMS.txt"), checksumText);
  const lock: RuntimePackageLock = {
    schemaVersion: 1, platform: "windows-x64", executable: "scraply-agent.exe", version: "0.1.0", protocolVersions: ["1.2"],
    sourceRepository: "https://github.com/nylow0/scraply", sourceCommit: sourceSha, upstreamCommit: "b".repeat(40),
    artifactPath: "scraply-agent.exe", sha256: hash(join(runtime, "scraply-agent.exe")), sizeBytes: 512,
    archive: { fileName: `scraply-agent-0.1.0-windows-x64-${sourceSha.slice(0, 12)}.zip`, sha256: "c".repeat(64), sizeBytes: 1 },
    notices,
    checksums: { path: "SHA256SUMS.txt", sha256: hash(join(runtime, "SHA256SUMS.txt")), sizeBytes: Buffer.byteLength(checksumText) },
  };
  const sourceLockPath = join(root, "source.lock.json");
  writeFileSync(sourceLockPath, JSON.stringify(lock));
  copyFileSync(sourceLockPath, join(runtime, "scraply-agent.lock.json"));
  return { root, stage, runtime, lock, options: { ...checks, root, sourceLockPath } };
}

function archive(f: ReturnType<typeof fixture>, extra?: string): string {
  const path = join(f.root, cliArchiveFilename("0.1.2"));
  const result = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::Open($env:TEST_CLI_ARCHIVE, [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($name in ($env:TEST_CLI_FILES | ConvertFrom-Json)) {
    [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, (Join-Path $env:TEST_CLI_STAGE $name), $name)
  }
  if ($env:TEST_CLI_EXTRA) {
    $writer = [IO.StreamWriter]::new($archive.CreateEntry($env:TEST_CLI_EXTRA).Open())
    try { $writer.Write('synthetic unexpected content') } finally { $writer.Dispose() }
  }
} finally { $archive.Dispose() }
`], { env: { ...process.env, EXA_API_KEY: "", PERPLEXITY_API_KEY: "", PSModulePath: "", TEST_CLI_STAGE: f.stage,
    TEST_CLI_ARCHIVE: path, TEST_CLI_FILES: JSON.stringify(cliPackageFiles(f.lock)), TEST_CLI_EXTRA: extra ?? "" }, stdout: "pipe", stderr: "pipe", windowsHide: true });
  if (result.exitCode !== 0) throw new Error("Could not create synthetic CLI archive.");
  return path;
}

/** Shadow the installer launch in an isolated PowerShell process. Even accepted
 * manifests stop before any executable, registry, or installed path is touched. */
function installerBoundary(version: string, schemaVersion: number, options: { tamperInstaller?: boolean; duplicateInstaller?: boolean; manifestVersion?: string } = {}) {
  const f = fixture();
  const scripts = join(f.root, "scripts");
  const release = join(f.root, "release");
  mkdirSync(scripts); mkdirSync(release);
  const script = join(scripts, "install-local.ps1");
  copyFileSync(resolve("scripts/install-local.ps1"), script);
  writeFileSync(join(f.root, "package.json"), JSON.stringify({ version }));
  const name = `Scraply Setup ${version}.exe`;
  const setup = join(release, name);
  writeFileSync(setup, "synthetic installer bytes");
  const installer = { name: "installer", path: `release/${name}`, bytes: statSync(setup).size, sha256: hash(setup) };
  writeFileSync(join(release, "manifest.json"), JSON.stringify({ schemaVersion, appVersion: options.manifestVersion ?? version,
    artifacts: options.duplicateInstaller ? [installer, installer] : [installer] }));
  if (options.tamperInstaller) writeFileSync(setup, "synthetic Installer bytes");
  const result = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `
$ErrorActionPreference = 'Stop'
$global:ScraplyTestInstallerBoundary = $false
function Start-Process { $global:ScraplyTestInstallerBoundary = $true; throw 'Synthetic installer launch blocked' }
try { & $env:TEST_INSTALL_SCRIPT; throw 'Installer did not stop at the synthetic boundary' }
catch { [Console]::Out.Write((@{ reachedInstaller = $global:ScraplyTestInstallerBoundary; message = $_.Exception.Message } | ConvertTo-Json -Compress)) }
`], { env: { ...process.env, EXA_API_KEY: "", PERPLEXITY_API_KEY: "", LOCALAPPDATA: join(f.root, "synthetic-localappdata"), TEST_INSTALL_SCRIPT: script },
    stdout: "pipe", stderr: "pipe", windowsHide: true });
  if (result.exitCode !== 0) throw new Error("Synthetic installer guard process failed.");
  return z.object({ reachedInstaller: z.boolean(), message: z.string() }).strict().parse(JSON.parse(new TextDecoder().decode(result.stdout)));
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("CLI dev launch isolation", () => {
  test("overrides inherited profiles and dotenv keys, keeps arguments and prepared worker paths", () => {
    const root = resolve("build", "synthetic-checkout");
    const launch = cliDevLaunch(["--", "project", "list"], root, { SCRAPLY_DATA_DIR: "synthetic-real-profile", EXA_API_KEY: "synthetic-env-key", PERPLEXITY_API_KEY: "synthetic-env-key" });
    expect(launch.args).toEqual(["--data-dir", join(root, ".scraply", "cli-dev"), "project", "list"]);
    expect(launch.env.SCRAPLY_DATA_DIR).toBe(join(root, ".scraply", "cli-dev"));
    expect(launch.env.EXA_API_KEY).toBe(""); expect(launch.env.PERPLEXITY_API_KEY).toBe("");
    expect(launch.env.SCRAPLY_AGENT_PATH).toBe(join(root, "build", "runtime", "scraply-agent.exe"));
    expect(launch.env.SCRAPLY_AGENT_LOCK_PATH).toBe(join(root, "build", "runtime", "scraply-agent.lock.json"));
  });

  test.each([{ args: ["--data-dir", "synthetic-profile", "status"] }, { args: ["status", "--data-dir=synthetic-profile"] }])("preserves an explicit profile", ({ args }) => {
    expect(cliDevLaunch(args, resolve("build")).args).toEqual([...args]);
  });
});

describe("CLI source and artifact test runner", () => {
  test("selects default or explicit artifacts and forwards test arguments", () => {
    const root = resolve("build", "synthetic-checkout");
    expect(parseCliTestArguments(["--", "--artifact"], root)).toEqual({ artifact: join(root, "release-cli", "scraply-cli-0.1.2-win-x64.zip"), testArgs: [] });
    expect(parseCliTestArguments(["--artifact", "candidate.zip", "--", "--bail"], root)).toEqual({ artifact: join(root, "candidate.zip"), testArgs: ["--bail"] });
    expect(() => parseCliTestArguments(["--artifact", "--artifact"], root)).toThrow("Usage");
  });

  test("source mode removes inherited executable selection and credentials, isolates data, and keeps all suites", async () => {
    const f = fixture();
    await runCliTests(["--bail"], { root: f.root, env: { SCRAPLY_TEST_CLI_EXECUTABLE: "synthetic-stale.exe", EXA_API_KEY: "synthetic-key", PERPLEXITY_API_KEY: "synthetic-key" },
      executeTests: async (command, env) => {
        expect(env.SCRAPLY_TEST_CLI_EXECUTABLE).toBeUndefined();
        expect(env.EXA_API_KEY).toBe(""); expect(env.PERPLEXITY_API_KEY).toBe("");
        expect(env.SCRAPLY_DATA_DIR?.startsWith(join(f.root, "build", ".cli-tests-"))).toBe(true);
        expect(env.SCRAPLY_DEV_SHARED_CREDENTIALS).toBe("0");
        expect(command).toEqual([process.execPath, "--no-env-file", "test", "--timeout", "30000", ...cliTestSuites, "--bail"]);
        return 0;
      } });
  });

  test("strict mode requires an artifact and missing or invalid artifacts never start tests", async () => {
    const f = fixture();
    let calls = 0;
    const executeTests = async () => { calls++; return 0; };
    await expect(runCliTests([], { root: f.root, env: { SCRAPLY_RELEASE_STRICT: "1" }, executeTests })).rejects.toThrow("require the compiled artifact");
    await expect(runCliTests(["--artifact"], { root: f.root, executeTests })).rejects.toThrow("artifact is missing");
    const invalid = join(f.root, "invalid.zip");
    writeFileSync(invalid, "synthetic invalid archive");
    await expect(runCliTests(["--artifact", invalid], { root: f.root, verifyArtifact: (path, options) => verifyCliArchive(path, { ...options, ...f.options }), executeTests })).rejects.toThrow();
    expect(calls).toBe(0);
  });

  test("artifact mode verifies a snapshot, selects its absolute executable for process fixtures, and propagates failure", async () => {
    const f = fixture();
    const artifact = archive(f);
    let selected = "";
    let verified = false;
    const result = await runCliTests(["--artifact", artifact], { root: f.root, env: { SCRAPLY_RELEASE_STRICT: "1", SCRAPLY_ALLOW_UNSIGNED: "1", EXA_API_KEY: "synthetic-key", PERPLEXITY_API_KEY: "synthetic-key" },
      verifyArtifact: async (path, options) => {
        expect(path).not.toBe(artifact);
        expect(readFileSync(path)).toEqual(readFileSync(artifact));
        const validation = await verifyCliArchive(path, { ...options, ...f.options });
        verified = true;
        return validation;
      },
      executeTests: async (_command, env) => {
        expect(verified).toBe(true);
        selected = env.SCRAPLY_TEST_CLI_EXECUTABLE ?? "";
        expect(selected.startsWith(join(f.root, "build", ".cli-tests-"))).toBe(true);
        expect(selected.endsWith(join("package", "scraply.exe"))).toBe(true);
        expect(readFileSync(selected)).toEqual(readFileSync(join(f.stage, "scraply.exe")));
        expect(env.EXA_API_KEY).toBe(""); expect(env.PERPLEXITY_API_KEY).toBe("");
        return 7;
      } });
    expect(result).toBe(7);
    expect(() => readFileSync(selected)).toThrow();
  }, 30_000);
});

describe("user PATH setup with an injected registry", () => {
  test("parses only the setup flag", () => {
    expect(parseSetupArguments([])).toEqual({ remove: false });
    expect(parseSetupArguments(["--remove"])).toEqual({ remove: true });
    expect(() => parseSetupArguments(["--remove", "--remove"])).toThrow("Usage");
    expect(() => parseSetupArguments(["--all-users"])).toThrow("Usage");
  });

  test.each(["REG_SZ", "REG_EXPAND_SZ"] as const)("preserves unrelated entries and registry type %s", (type) => {
    const current = { value: '%SystemRoot%\\System32;"C:\\Tools\\Other";;C:\\Tools\\Scraply-old;', type };
    const added = updateUserPath(current, "C:\\Tools\\Scraply", false);
    expect(added.value).toEqual({ value: `${current.value};C:\\Tools\\Scraply`, type });
    expect(updateUserPath(added.value, "c:/TOOLS/scraply/", true).value).toEqual(current);
    expect(updateUserPath(current, "C:\\Tools\\Scraply", true)).toEqual({ value: current, changed: false });
  });

  test("case, slash, quotes, dot segments, and trailing separators match without duplicates", () => {
    const current = { value: 'C:\\Other;"c:/TOOLS/./Scraply/";C:\\Last', type: "REG_SZ" as const };
    expect(updateUserPath(current, "C:\\Tools\\Scraply", false)).toEqual({ value: current, changed: false });
    expect(updateUserPath(current, "C:\\Tools\\Scraply", true).value).toEqual({ value: "C:\\Other;C:\\Last", type: "REG_SZ" });
    expect(() => updateUserPath(null, "relative", false)).toThrow("absolute");
    expect(() => updateUserPath(null, "C:\\Tools;C:\\Injected", false)).toThrow("separators");
  });

  test("add/remove are idempotent, broadcast only changes, and restore an absent PATH", async () => {
    let stored: UserPathValue | null = null;
    const events: string[] = [];
    const registry: UserPathRegistry = {
      async readPath() { return stored; },
      async writePath(value) { events.push("write"); stored = value; },
      async deletePath() { events.push("delete"); stored = null; },
      async broadcastEnvironmentChange() { events.push("broadcast"); },
    };
    expect((await setupCli({ executablePath: "C:\\Tools\\Scraply\\scraply.exe", registry })).changed).toBe(true);
    expect((await setupCli({ executablePath: "c:/tools/scraply/scraply.exe", registry })).changed).toBe(false);
    expect((await setupCli({ executablePath: "C:\\Tools\\Scraply\\scraply.exe", registry, remove: true })).changed).toBe(true);
    expect((await setupCli({ executablePath: "C:\\Tools\\Scraply\\scraply.exe", registry, remove: true })).changed).toBe(false);
    expect(stored).toBeNull();
    expect(events).toEqual(["write", "broadcast", "delete", "broadcast"]);
    await expect(setupCli({ executablePath: "C:\\Tools\\bun.exe", registry })).rejects.toThrow("extracted scraply.exe");
  });
});

describe("CLI artifact validation", () => {
  test("production ZIP writer creates a valid archive with normalized entry timestamps", async () => {
    const f = fixture();
    const path = join(f.root, "production-writer.zip");
    createCliArchive(f.stage, path, cliPackageFiles(f.lock));
    expect((await verifyCliArchive(path, f.options)).appVersion).toBe("0.1.2");
    const metadata = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($env:TEST_CLI_ARCHIVE)
try { [Console]::Out.Write((@($archive.Entries | ForEach-Object { $_.LastWriteTime.ToString('yyyy-MM-ddTHH:mm:ss') }) -join ',')) }
finally { $archive.Dispose() }
`], { env: { ...process.env, TEST_CLI_ARCHIVE: path, EXA_API_KEY: "", PERPLEXITY_API_KEY: "" }, stdout: "pipe", stderr: "pipe", windowsHide: true });
    expect(metadata.exitCode).toBe(0);
    expect([...new Set(new TextDecoder().decode(metadata.stdout).split(","))]).toEqual(["2000-01-01T00:00:00"]);
  }, 30_000);

  test("validates a synthetic archive with exact worker, prompts, notices, license and version envelope", async () => {
    const f = fixture();
    const result = await verifyCliArchive(archive(f), f.options);
    expect(result.appVersion).toBe("0.1.2");
    expect(result.runtimeLockSha256).toBe(hash(f.options.sourceLockPath));
  }, 30_000);

  test.each([".env", "prompts/retired.md", "../outside.txt", "scraply.exe"])("rejects unexpected, unsafe and duplicate archive entries: %s", async (extra) => {
    const f = fixture();
    await expect(verifyCliArchive(archive(f, extra), f.options)).rejects.toThrow();
  }, 30_000);

  test("rejects changed prompts, missing prompts, superseded prompts and unexpected files", () => {
    const f = fixture();
    const prompt = join(f.stage, "prompts", cliPromptNames[0]!);
    writeFileSync(prompt, "synthetic changed prompt");
    expect(() => verifyCliDirectory(f.stage, f.options)).toThrow("differs from its source");
    rmSync(prompt);
    expect(() => verifyCliDirectory(f.stage, f.options)).toThrow("allowlist");
    copyFileSync(join(f.root, "prompts", cliPromptNames[0]!), prompt);
    writeFileSync(join(f.stage, "prompts", "retired.md"), "synthetic retired prompt");
    expect(() => verifyCliDirectory(f.stage, f.options)).toThrow("allowlist");
  });

  test("rejects worker tampering, a different source lock, and a source mismatch", () => {
    const f = fixture();
    expect(() => verifyCliDirectory(f.stage, { ...f.options, expectedSourceSha: "f".repeat(40) })).toThrow("approved source");
    writeFileSync(join(f.runtime, "scraply-agent.lock.json"), "{}");
    expect(() => verifyCliDirectory(f.stage, f.options)).toThrow("differs");
    copyFileSync(f.options.sourceLockPath, join(f.runtime, "scraply-agent.lock.json"));
    writeFileSync(join(f.runtime, "scraply-agent.exe"), "substituted worker");
    expect(() => verifyCliDirectory(f.stage, f.options)).toThrow("expected");
  });

  test.each(["0.1.2", JSON.stringify({ ok: true, data: { version: "0.1.1" } }), JSON.stringify({ ok: true, data: { version: "0.1.2", extra: true } }), JSON.stringify({ ok: false, data: { version: "0.1.2" } })])("rejects version contract mismatches", (output) => {
    const f = fixture();
    expect(() => verifyCliDirectory(f.stage, { ...f.options, runVersion: () => output })).toThrow("version");
  });

  test("rejects broken signatures even under unsigned policy, and requires signatures under signed policy", () => {
    const f = fixture();
    expect(() => verifyCliDirectory(f.stage, { ...f.options, inspectSignature: () => "HashMismatch" })).toThrow("signature");
    expect(() => verifyCliDirectory(f.stage, { ...f.options, allowUnsigned: false })).toThrow("signature");
    expect(verifyCliDirectory(f.stage, { ...f.options, allowUnsigned: false, inspectSignature: () => "Valid" }).signatureStatus).toBe("Valid");
  });

  test("version cannot create a profile or start a host", () => {
    const f = fixture();
    expect(() => verifyCliDirectory(f.stage, { ...f.options, runVersion: () => {
      mkdirSync(join(f.stage, ".verification-profile"));
      return versionEnvelope;
    } })).toThrow("package directory");
  });

  test("rejects non-x64 executables and machine paths without disclosing those paths", () => {
    const f = fixture();
    const bytes = fakeExecutable(); bytes.writeUInt16LE(0x14c, 0x84);
    writeFileSync(join(f.stage, "scraply.exe"), bytes);
    expect(() => verifyCliDirectory(f.stage, f.options)).toThrow("Windows x64");
    for (const encoding of ["utf8", "utf16le"] as const) {
      expect(() => assertNoMachinePaths(Buffer.from("C:\\SyntheticMachine\\checkout", encoding), ["C:\\SyntheticMachine"])).toThrow("local machine path");
    }
  });
});

describe("local installer manifest gate", () => {
  test.each([{ version: "0.1.2", schema: 3 }, { version: "0.1.1", schema: 2 }])("accepts the versioned schema and reaches only the blocked launch", ({ version, schema }) => {
    expect(installerBoundary(version, schema)).toEqual({ reachedInstaller: true, message: "Synthetic installer launch blocked" });
  }, 30_000);

  test.each([{ version: "0.1.2", schema: 2 }, { version: "0.1.2", schema: 4 }, { version: "0.1.1", schema: 3 }])("rejects a stale, unknown, or incorrectly versioned schema before launch", ({ version, schema }) => {
    const result = installerBoundary(version, schema);
    expect(result.reachedInstaller).toBe(false);
    expect(result.message).toContain("requires schema");
  }, 30_000);

  test("still rejects changed installer bytes, duplicate artifacts, and mismatched versions before launch", () => {
    const tampered = installerBoundary("0.1.2", 3, { tamperInstaller: true });
    expect(tampered.reachedInstaller).toBe(false);
    expect(tampered.message).toContain("size or SHA-256 does not match");
    const duplicate = installerBoundary("0.1.2", 3, { duplicateInstaller: true });
    expect(duplicate.reachedInstaller).toBe(false);
    expect(duplicate.message).toContain("exactly one installer");
    const version = installerBoundary("0.1.2", 3, { manifestVersion: "0.1.1" });
    expect(version.reachedInstaller).toBe(false);
    expect(version.message).toContain("does not match package version");
  }, 30_000);
});

describe("release layout and promotion", () => {
  test("0.1.1 keeps five assets/schema 2; new versions require six assets/schema 3", () => {
    expect(releaseBundleLayout("0.1.1").files).toHaveLength(5);
    expect(releaseBundleLayout("0.1.1").schemaVersion).toBe(2);
    expect(releaseBundleLayout("0.1.2").files).toHaveLength(6);
    expect(releaseBundleLayout("0.1.2").schemaVersion).toBe(3);
    expect(releaseBundleLayout("1.0.0").cli).toBe("scraply-cli-1.0.0-win-x64.zip");
    expect(() => releaseBundleLayout("0.1.2/../bad")).toThrow();
  });

  test("verifies six synthetic assets together and rejects stale schema, missing CLI, or stale checksums", async () => {
    const f = fixture();
    const directory = join(f.root, "bundle");
    mkdirSync(directory);
    const cliFile = cliArchiveFilename("0.1.2");
    copyFileSync(archive(f), join(directory, cliFile));
    copyFileSync(f.options.sourceLockPath, join(directory, "scraply-agent.lock.json"));
    const executable = { productName: "Scraply", productVersion: "0.1.2", fileVersion: "0.1.2", signatureStatus: "NotSigned" };
    const artifacts = ["installer", "portable"].map((name) => {
      const filename = name === "installer" ? "Scraply Setup 0.1.2.exe" : "Scraply 0.1.2.exe";
      writeFileSync(join(directory, filename), `synthetic ${name}`);
      return { name, path: `release/${filename}`, bytes: statSync(join(directory, filename)).size, sha256: hash(join(directory, filename)), executable };
    });
    const runtime = verifyCliDirectory(f.stage, f.options).runtime;
    const manifest = {
      schemaVersion: 3, appVersion: "0.1.2", sourceSha, sourceRef: "v0.1.2-rc.1", dirty: false, generatedAt: new Date(0).toISOString(), signed: false, signingPolicy: "unsigned",
      artifacts: [...artifacts,
        ...["unpacked", "app-asar"].map((name) => ({ name, path: `release/${name}`, bytes: 1, sha256: "c".repeat(64) })),
        { name: "cli", path: `release-cli/${cliFile}`, bytes: statSync(join(directory, cliFile)).size, sha256: hash(join(directory, cliFile)), cli: { versionOutput: versionEnvelope, signatureStatus: "NotSigned" } }],
      runtime: {
        platform: f.lock.platform, version: f.lock.version, protocolVersions: f.lock.protocolVersions, sourceRepository: f.lock.sourceRepository, sourceCommit: sourceSha, upstreamCommit: f.lock.upstreamCommit,
        executable: { path: "runtime/scraply-agent.exe", bytes: f.lock.sizeBytes, sha256: f.lock.sha256, versionOutput: runtime.versionOutput, signatureStatus: "NotSigned" },
        lock: { path: "runtime/scraply-agent.lock.json", bytes: runtime.lockBytes, sha256: runtime.lockSha256 },
        notices: runtime.notices.map((notice) => ({ ...notice, path: `runtime/${notice.path}` })),
        checksums: { ...runtime.checksums, path: `runtime/${runtime.checksums.path}` },
      },
    };
    const manifestPath = join(directory, "manifest.json");
    const checksumPath = join(directory, "SHA256SUMS.txt");
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const checksumText = [...artifacts.map((artifact) => `${artifact.sha256}  ${artifact.path.slice("release/".length)}`), `${hash(join(directory, cliFile))}  ${cliFile}`].join("\n") + "\n";
    writeFileSync(checksumPath, checksumText);
    const options = { root: f.root, allowUnsigned: true, cliChecks: checks };
    await verifyPromotedAssets(directory, sourceSha, "v0.1.2-rc.1", options);
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, schemaVersion: 2 }));
    await expect(verifyPromotedAssets(directory, sourceSha, "v0.1.2-rc.1", options)).rejects.toThrow("schema 3");
    writeFileSync(manifestPath, JSON.stringify(manifest));
    writeFileSync(checksumPath, checksumText.split("\n").slice(0, 2).join("\n") + "\n");
    await expect(verifyPromotedAssets(directory, sourceSha, "v0.1.2-rc.1", options)).rejects.toThrow("SHA256SUMS");
    rmSync(join(directory, cliFile));
    await expect(verifyPromotedAssets(directory, sourceSha, "v0.1.2-rc.1", options)).rejects.toThrow("exactly");
  }, 30_000);
});
