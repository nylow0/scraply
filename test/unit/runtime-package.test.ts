import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stageRuntimePackage, type RuntimePackageLock } from "../../scripts/runtime-package";

const roots: string[] = [];
const version = "0.1.0";
const sourceCommit = "a".repeat(40);
const archiveName = `scraply-agent-${version}-windows-x64-${sourceCommit.slice(0, 12)}.zip`;

function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fakeWindowsX64Executable(marker?: string): Buffer {
  const bytes = Buffer.alloc(512);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write("PE\0\0", 0x80, "ascii");
  bytes.writeUInt16LE(0x8664, 0x84);
  if (marker) bytes.write(marker, 0x100, "ascii");
  return bytes;
}

function powershell(script: string, env: Record<string, string>): void {
  const result = Bun.spawnSync(["powershell", "-NoProfile", "-Command", script], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}

interface PackageFixtureOptions {
  executable?: Buffer;
  extraEntry?: string;
  mutateArchiveAfterLock?: boolean;
}

function createPackageFixture(options: PackageFixtureOptions = {}): {
  root: string;
  lockPath: string;
  stageDirectory: string;
} {
  const root = mkdtempSync(join(tmpdir(), "scraply-runtime-package-"));
  roots.push(root);
  const artifactsDirectory = join(root, "runtime-artifacts");
  const sourceDirectory = join(root, "archive-source");
  const stageDirectory = join(root, "build", "runtime");
  mkdirSync(artifactsDirectory, { recursive: true });
  mkdirSync(sourceDirectory, { recursive: true });

  const files = {
    "scraply-agent.exe": options.executable ?? fakeWindowsX64Executable(),
    LICENSE: Buffer.from("Apache-2.0 test license\n"),
    "OPENAI-NOTICE": Buffer.from("Vendored OpenAI notice\n"),
    "UPSTREAM.md": Buffer.from("Pinned upstream test provenance\n"),
  };
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(sourceDirectory, name), contents);
  }
  const checksumText = Object.keys(files)
    .sort()
    .map((name) => `${hash(join(sourceDirectory, name))}  ${name}`)
    .join("\n") + "\n";
  writeFileSync(join(sourceDirectory, "SHA256SUMS.txt"), checksumText);

  const archivePath = join(artifactsDirectory, archiveName);
  powershell(
    "Compress-Archive -CompressionLevel Optimal -Path (Join-Path $env:RUNTIME_SOURCE '*') -DestinationPath $env:RUNTIME_ARCHIVE",
    { RUNTIME_SOURCE: sourceDirectory, RUNTIME_ARCHIVE: archivePath },
  );
  if (options.extraEntry) {
    powershell(
      [
        "Add-Type -AssemblyName System.IO.Compression",
        "Add-Type -AssemblyName System.IO.Compression.FileSystem",
        "$archive = [IO.Compression.ZipFile]::Open($env:RUNTIME_ARCHIVE, [System.IO.Compression.ZipArchiveMode]::Update)",
        "$entry = $archive.CreateEntry($env:RUNTIME_EXTRA)",
        "$writer = [IO.StreamWriter]::new($entry.Open())",
        "$writer.Write('unexpected')",
        "$writer.Dispose()",
        "$archive.Dispose()",
      ].join("; "),
      { RUNTIME_ARCHIVE: archivePath, RUNTIME_EXTRA: options.extraEntry },
    );
  }

  const notices = ["LICENSE", "OPENAI-NOTICE", "UPSTREAM.md"].map((name) => ({
    source: name,
    target: name,
    sha256: hash(join(sourceDirectory, name)),
    sizeBytes: statSync(join(sourceDirectory, name)).size,
  }));
  const lock: RuntimePackageLock = {
    schemaVersion: 1,
    platform: "windows-x64",
    executable: "scraply-agent.exe",
    version,
    protocolVersions: ["1.1"],
    sourceRepository: "https://github.com/nylow0/scraply-agent",
    sourceCommit,
    upstreamCommit: "8c68d4c87dc54d38861f5114e920c3de2efa5876",
    artifactPath: "scraply-agent.exe",
    sha256: hash(join(sourceDirectory, "scraply-agent.exe")),
    sizeBytes: statSync(join(sourceDirectory, "scraply-agent.exe")).size,
    archive: {
      fileName: archiveName,
      sha256: hash(archivePath),
      sizeBytes: statSync(archivePath).size,
    },
    notices,
    checksums: {
      path: "SHA256SUMS.txt",
      sha256: hash(join(sourceDirectory, "SHA256SUMS.txt")),
      sizeBytes: statSync(join(sourceDirectory, "SHA256SUMS.txt")).size,
    },
  };
  const lockPath = join(artifactsDirectory, "scraply-agent.windows-x64.lock.json");
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  if (options.mutateArchiveAfterLock) writeFileSync(archivePath, "substituted archive");
  return { root, lockPath, stageDirectory };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("runtime package staging", () => {
  test("stages only locked runtime files and records the exact runtime version", async () => {
    const fixture = createPackageFixture();
    const staged = await stageRuntimePackage({
      ...fixture,
      runVersion: () => "scraply-agent 0.1.0",
    });

    expect(staged.versionOutput).toBe("scraply-agent 0.1.0");
    expect(staged.lock.sourceCommit).toBe(sourceCommit);
    expect(readdirSync(fixture.stageDirectory).sort()).toEqual([
      "LICENSE",
      "OPENAI-NOTICE",
      "SHA256SUMS.txt",
      "UPSTREAM.md",
      "scraply-agent.exe",
      "scraply-agent.lock.json",
    ]);
  });

  test("rejects archive bytes that differ from the lock", async () => {
    const fixture = createPackageFixture({ mutateArchiveAfterLock: true });
    await expect(stageRuntimePackage({
      ...fixture,
      runVersion: () => "scraply-agent 0.1.0",
    })).rejects.toThrow("Runtime archive has 19 bytes");
  });

  test("rejects unexpected and traversal archive entries", async () => {
    const extra = createPackageFixture({ extraEntry: "debug-fixture.json" });
    await expect(stageRuntimePackage({
      ...extra,
      runVersion: () => "scraply-agent 0.1.0",
    })).rejects.toThrow("unexpected entry");

    const traversal = createPackageFixture({ extraEntry: "../escape.txt" });
    await expect(stageRuntimePackage({
      ...traversal,
      runVersion: () => "scraply-agent 0.1.0",
    })).rejects.toThrow(/unsafe path|invalid relative path/);
  });

  test("rejects release binaries that retain debug fixture seams", async () => {
    const fixture = createPackageFixture({
      executable: fakeWindowsX64Executable("SCRAPLY_AGENT_TEST_FIXTURE"),
    });
    await expect(stageRuntimePackage({
      ...fixture,
      runVersion: () => "scraply-agent 0.1.0",
    })).rejects.toThrow("debug-only fixture markers");
  });

  test("rejects a runtime whose reported version differs from the lock", async () => {
    const fixture = createPackageFixture();
    await expect(stageRuntimePackage({
      ...fixture,
      runVersion: () => "scraply-agent 0.2.0",
    })).rejects.toThrow("expected \"scraply-agent 0.1.0\"");
  });
});
