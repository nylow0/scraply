import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import packageMetadata from "../../package.json";
import { cliArchiveFilename, cliPackageFiles, cliPromptNames } from "../../scripts/verify-cli-package";
import type { RuntimePackageLock } from "../../scripts/runtime-package";

const version = packageMetadata.version;
const installerName = `Scraply Setup ${version}.exe`;
const approvedSha = "a".repeat(40);
const approvedRef = `v${version}-rc.1`;
const bundles: string[] = [];
const fixtureTimeoutMs = 30_000;

interface BundleOverrides {
  version?: string;
  manifest?: Record<string, unknown>;
  installerBytes?: string;
  checksums?: string;
}

interface BundleFixture {
  root: string;
  directory: string;
  runtimeLockPath: string;
  sourceRef: string;
  version: string;
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(Buffer.from(value)).digest("hex");
}

function createBundle(overrides: BundleOverrides = {}): BundleFixture {
  const root = mkdtempSync(join(tmpdir(), "scraply-promoted-"));
  bundles.push(root);
  const dir = join(root, "bundle");
  mkdirSync(dir);
  const version = overrides.version ?? packageMetadata.version;
  const installerName = `Scraply Setup ${version}.exe`;
  const portableName = `Scraply ${version}.exe`;
  const approvedRef = `v${version}-rc.1`;
  const legacy = version === "0.1.1";
  writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
  const installerBody = overrides.installerBytes ?? "installer-bytes";
  const portableBody = "portable-bytes";
  writeFileSync(join(dir, installerName), installerBody);
  writeFileSync(join(dir, portableName), portableBody);

  const executable = {
    productName: "Scraply",
    productVersion: version,
    fileVersion: version,
    signatureStatus: "NotSigned",
  };
  const pe = Buffer.alloc(512);
  pe.write("MZ"); pe.writeUInt32LE(0x80, 0x3c);
  pe.write("PE\0\0", 0x80); pe.writeUInt16LE(0x8664, 0x84);
  const runtimeFiles = {
    executable: pe,
    LICENSE: "runtime-license",
    "OPENAI-NOTICE": "runtime-openai-notice",
    "UPSTREAM.md": "runtime-upstream",
    checksums: "",
  };
  runtimeFiles.checksums = ["LICENSE", "OPENAI-NOTICE", "UPSTREAM.md", "scraply-agent.exe"].map((name) => (
    `${hash(name === "scraply-agent.exe" ? pe : runtimeFiles[name as keyof typeof runtimeFiles])}  ${name}`
  )).join("\n") + "\n";
  const runtimeLock: RuntimePackageLock = {
    schemaVersion: 1,
    platform: "windows-x64",
    executable: "scraply-agent.exe",
    version: "0.1.0",
    protocolVersions: ["1.2"],
    sourceRepository: "https://github.com/nylow0/scraply",
    sourceCommit: approvedSha,
    upstreamCommit: "8c68d4c87dc54d38861f5114e920c3de2efa5876",
    artifactPath: "scraply-agent.exe",
    sha256: hash(runtimeFiles.executable),
    sizeBytes: Buffer.byteLength(runtimeFiles.executable),
    archive: {
      fileName: `scraply-agent-0.1.0-windows-x64-${approvedSha.slice(0, 12)}.zip`,
      sha256: hash("runtime-archive"),
      sizeBytes: Buffer.byteLength("runtime-archive"),
    },
    notices: ["LICENSE", "OPENAI-NOTICE", "UPSTREAM.md"].map((target) => ({
      source: target,
      target,
      sha256: hash(runtimeFiles[target as keyof typeof runtimeFiles]),
      sizeBytes: Buffer.byteLength(runtimeFiles[target as keyof typeof runtimeFiles]),
    })),
    checksums: {
      path: "SHA256SUMS.txt",
      sha256: hash(runtimeFiles.checksums),
      sizeBytes: Buffer.byteLength(runtimeFiles.checksums),
    },
  };
  const runtimeLockPath = join(dir, "scraply-agent.lock.json");
  writeFileSync(runtimeLockPath, `${JSON.stringify(runtimeLock, null, 2)}\n`);
  const runtime = {
    platform: runtimeLock.platform,
    version: runtimeLock.version,
    protocolVersions: runtimeLock.protocolVersions,
    sourceRepository: runtimeLock.sourceRepository,
    sourceCommit: runtimeLock.sourceCommit,
    upstreamCommit: runtimeLock.upstreamCommit,
    executable: {
      path: "runtime/scraply-agent.exe",
      bytes: runtimeLock.sizeBytes,
      sha256: runtimeLock.sha256,
      versionOutput: "scraply-agent 0.1.0",
      signatureStatus: "NotSigned",
    },
    lock: {
      path: "runtime/scraply-agent.lock.json",
      bytes: Buffer.byteLength(readFileSync(runtimeLockPath)),
      sha256: hash(readFileSync(runtimeLockPath)),
    },
    notices: runtimeLock.notices.map((notice) => ({
      path: `runtime/${notice.target}`,
      bytes: notice.sizeBytes,
      sha256: notice.sha256,
    })),
    checksums: {
      path: "runtime/SHA256SUMS.txt",
      bytes: runtimeLock.checksums.sizeBytes,
      sha256: runtimeLock.checksums.sha256,
    },
  };
  const stage = join(root, "cli-source");
  mkdirSync(join(stage, "runtime"), { recursive: true });
  mkdirSync(join(stage, "prompts"));
  mkdirSync(join(root, "prompts"));
  writeFileSync(join(root, "LICENSE"), "Synthetic package license\n");
  copyFileSync(join(root, "LICENSE"), join(stage, "LICENSE"));
  writeFileSync(join(stage, "scraply.exe"), pe);
  writeFileSync(join(stage, "runtime", "scraply-agent.exe"), pe);
  for (const notice of runtimeLock.notices) writeFileSync(join(stage, "runtime", notice.target), runtimeFiles[notice.source as keyof typeof runtimeFiles]);
  writeFileSync(join(stage, "runtime", "SHA256SUMS.txt"), runtimeFiles.checksums);
  copyFileSync(runtimeLockPath, join(stage, "runtime", "scraply-agent.lock.json"));
  for (const name of cliPromptNames) {
    writeFileSync(join(root, "prompts", name), `Synthetic prompt ${name}\n`);
    copyFileSync(join(root, "prompts", name), join(stage, "prompts", name));
  }
  const cliName = cliArchiveFilename(version);
  const cliPath = join(dir, cliName);
  if (!legacy) {
    const zip = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::Open($env:TEST_PROMOTED_ARCHIVE, [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($name in ($env:TEST_PROMOTED_FILES | ConvertFrom-Json)) {
    [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, (Join-Path $env:TEST_PROMOTED_STAGE $name), $name)
  }
} finally { $archive.Dispose() }
`], { env: { ...process.env, EXA_API_KEY: "", PERPLEXITY_API_KEY: "", PSModulePath: "", TEST_PROMOTED_ARCHIVE: cliPath,
      TEST_PROMOTED_STAGE: stage, TEST_PROMOTED_FILES: JSON.stringify(cliPackageFiles(runtimeLock)) }, stdout: "pipe", stderr: "pipe", windowsHide: true });
    if (zip.exitCode !== 0) throw new Error("Could not create synthetic promoted CLI archive.");
  }
  const manifest = {
    schemaVersion: legacy ? 2 : 3,
    appVersion: version,
    sourceSha: approvedSha,
    sourceRef: approvedRef,
    dirty: false,
    generatedAt: new Date(0).toISOString(),
    signed: false,
    signingPolicy: "unsigned",
    runtime,
    artifacts: [
      {
        name: "installer",
        path: `release/${installerName}`,
        bytes: Buffer.byteLength("installer-bytes"),
        sha256: hash("installer-bytes"),
        executable,
      },
      {
        name: "portable",
        path: `release/${portableName}`,
        bytes: Buffer.byteLength(portableBody),
        sha256: hash(portableBody),
        executable,
      },
      ...["unpacked", "app-asar"].map((name) => ({ name, path: `release/${name}`, bytes: 1, sha256: hash("synthetic internal artifact") })),
      ...(legacy ? [] : [{ name: "cli", path: `release-cli/${cliName}`, bytes: statSync(cliPath).size, sha256: hash(readFileSync(cliPath)),
        cli: { versionOutput: JSON.stringify({ ok: true, data: { version } }), signatureStatus: "NotSigned" } }]),
    ],
    ...overrides.manifest,
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(
    join(dir, "SHA256SUMS.txt"),
    overrides.checksums ?? `${hash("installer-bytes")}  ${installerName}\n${hash(portableBody)}  ${portableName}\n${legacy ? "" : `${hash(readFileSync(cliPath))}  ${cliName}\n`}`,
  );
  return { root, directory: dir, runtimeLockPath, version, sourceRef: approvedRef };
}

function verify(
  fixture: BundleFixture,
  args: string[] = ["--allow-unsigned"],
): { ok: boolean; message: string } {
  // Exercise the production verifier with real synthetic archives. Only native
  // execution/signature probes are injected because the PE fixtures are inert.
  const runner = join(fixture.root, "verify.ts");
  writeFileSync(runner, `import { verifyPromotedAssets } from ${JSON.stringify(join(process.cwd(), "scripts/verify-promoted-assets.ts"))};
await verifyPromotedAssets(process.argv[2], process.argv[3], process.argv[4], {
  root: ${JSON.stringify(fixture.root)}, allowUnsigned: process.argv.includes("--allow-unsigned"),
  cliChecks: { runVersion: () => ${JSON.stringify(JSON.stringify({ ok: true, data: { version: fixture.version } }))},
    runRuntimeVersion: () => "scraply-agent 0.1.0", inspectSignature: () => "NotSigned" }
});`);
  const result = Bun.spawnSync(
    [process.execPath, "--no-env-file", runner, fixture.directory, approvedSha, fixture.sourceRef, ...args],
    {
      cwd: process.cwd(),
      env: { ...process.env, EXA_API_KEY: "", PERPLEXITY_API_KEY: "" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return {
    ok: result.exitCode === 0,
    message: new TextDecoder().decode(result.exitCode === 0 ? result.stdout : result.stderr),
  };
}

afterEach(() => {
  while (bundles.length) rmSync(bundles.pop()!, { recursive: true, force: true });
});

describe("promoted release assets", () => {
  test("accepts a bundle whose bytes match the approved candidate", () => {
    const fixture = createBundle();
    expect(readdirSync(fixture.directory)).toHaveLength(6);
    const result = verify(fixture);
    expect(result.ok).toBe(true);
    expect(result.message).toContain(approvedRef);
  }, fixtureTimeoutMs);

  test("rejects substituted bytes of identical length", () => {
    expect("malicious-bytes".length).toBe("installer-bytes".length);
    const tampered = verify(createBundle({ installerBytes: "malicious-bytes" }));
    expect(tampered.ok).toBe(false);
    expect(tampered.message).toContain("hash does not match the manifest");
  }, fixtureTimeoutMs);

  test("rejects a manifest that omits or duplicates the published artifacts", () => {
    const omitted = verify(createBundle({ manifest: { artifacts: [] } }));
    expect(omitted.ok).toBe(false);
    expect(omitted.message).toContain("exactly the expected artifacts");
    const fixture = createBundle();
    const path = join(fixture.directory, "manifest.json");
    const manifest = JSON.parse(readFileSync(path, "utf8")) as { artifacts: unknown[] };
    manifest.artifacts.push(manifest.artifacts[0]);
    writeFileSync(path, JSON.stringify(manifest));
    expect(verify(fixture).message).toContain("exactly the expected artifacts");
  }, fixtureTimeoutMs);

  test("rejects candidates built from another commit or a dirty tree", () => {
    expect(verify(createBundle({ manifest: { sourceSha: "b".repeat(40) } })).message)
      .toContain("SHA does not match the approved source SHA");
    expect(verify(createBundle({ manifest: { dirty: true } })).message).toContain("dirty source tree");
    expect(verify(createBundle({ manifest: { sourceRef: "v0.0.1-rc.9" } })).message)
      .toContain("source ref does not match the approved candidate");
  }, fixtureTimeoutMs);

  test("rejects a runtime lock from another source commit", () => {
    const fixture = createBundle();
    const lock = JSON.parse(readFileSync(fixture.runtimeLockPath, "utf8")) as {
      sourceCommit: string; archive: { fileName: string };
    };
    lock.sourceCommit = "b".repeat(40);
    lock.archive.fileName = `scraply-agent-0.1.0-windows-x64-${"b".repeat(12)}.zip`;
    writeFileSync(fixture.runtimeLockPath, JSON.stringify(lock));
    expect(verify(fixture).message).toContain("approved Scraply commit");
  }, fixtureTimeoutMs);

  test("requires the bundled lock and its exact accepted bytes", () => {
    const fixture = createBundle();
    writeFileSync(fixture.runtimeLockPath, `${readFileSync(fixture.runtimeLockPath, "utf8")}\n`);
    expect(verify(fixture).message).toContain("runtime lock file does not match");
    rmSync(fixture.runtimeLockPath);
    expect(verify(fixture).ok).toBe(false);
  }, fixtureTimeoutMs);

  test("rejects runtime metadata that differs from the bundled lock", () => {
    const fixture = createBundle();
    const manifestPath = join(fixture.directory, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      runtime: { sourceCommit: string };
    };
    manifest.runtime.sourceCommit = "d".repeat(40);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const result = verify(fixture);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("does not match the bundled runtime lock");
  }, fixtureTimeoutMs);

  test("rejects stale checksums and unsigned bytes without the unsigned opt-in", () => {
    expect(verify(createBundle({ checksums: `${hash("stale")}  ${installerName}\n` })).message)
      .toContain("SHA256SUMS.txt does not match");
    expect(verify(createBundle(), []).message).toContain("requires validly signed executables");
  }, fixtureTimeoutMs);

  test("requires the current CLI bytes and schema 3", () => {
    const fixture = createBundle();
    const path = join(fixture.directory, cliArchiveFilename(version));
    const bytes = readFileSync(path);
    bytes[bytes.length - 1] = bytes.at(-1)! ^ 1;
    writeFileSync(path, bytes);
    expect(verify(fixture).message).toContain("CLI archive differs from the manifest");
    rmSync(path);
    expect(verify(fixture).message).toContain("must contain exactly");
    expect(verify(createBundle({ manifest: { schemaVersion: 2 } })).message).toContain("requires manifest schema 3");
  }, fixtureTimeoutMs);

  test("retains immutable 0.1.1 five-file/schema-2 coverage from its own checkout", () => {
    const fixture = createBundle({ version: "0.1.1" });
    const manifest = JSON.parse(readFileSync(join(fixture.directory, "manifest.json"), "utf8")) as { schemaVersion: number };
    expect(readdirSync(fixture.directory)).toHaveLength(5);
    expect(manifest.schemaVersion).toBe(2);
    expect(verify(fixture).ok).toBe(true);
  }, fixtureTimeoutMs);
});
