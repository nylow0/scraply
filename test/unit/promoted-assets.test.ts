import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import packageMetadata from "../../package.json";

const version = packageMetadata.version;
const installerName = `Scraply Setup ${version}.exe`;
const portableName = `Scraply ${version}.exe`;
const approvedSha = "a".repeat(40);
const approvedRef = `v${version}-rc.1`;
const bundles: string[] = [];

interface BundleOverrides {
  manifest?: Record<string, unknown>;
  installerBytes?: string;
  checksums?: string;
}

interface BundleFixture {
  directory: string;
  runtimeLockPath: string;
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(Buffer.from(value)).digest("hex");
}

function createBundle(overrides: BundleOverrides = {}): BundleFixture {
  const dir = mkdtempSync(join(tmpdir(), "scraply-promoted-"));
  bundles.push(dir);
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
  const runtimeFiles = {
    executable: "runtime-bytes",
    LICENSE: "runtime-license",
    "OPENAI-NOTICE": "runtime-openai-notice",
    "UPSTREAM.md": "runtime-upstream",
    checksums: "runtime-checksums",
  };
  const runtimeLock = {
    schemaVersion: 1,
    platform: "windows-x64",
    executable: "scraply-agent.exe",
    version: "0.1.0",
    protocolVersions: ["1.1"],
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
  const manifest = {
    schemaVersion: 2,
    appVersion: version,
    sourceSha: approvedSha,
    sourceRef: approvedRef,
    dirty: false,
    signed: false,
    signingPolicy: "private-unsigned",
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
    ],
    ...overrides.manifest,
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(
    join(dir, "SHA256SUMS.txt"),
    overrides.checksums ?? `${hash("installer-bytes")}  ${installerName}\n${hash(portableBody)}  ${portableName}\n`,
  );
  return { directory: dir, runtimeLockPath };
}

function verify(
  fixture: BundleFixture,
  args: string[] = ["--allow-unsigned"],
): { ok: boolean; message: string } {
  const result = Bun.spawnSync(
    ["bun", "scripts/verify-promoted-assets.ts", fixture.directory, approvedSha, approvedRef, ...args],
    {
      cwd: process.cwd(),
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
    const result = verify(createBundle());
    expect(result.ok).toBe(true);
    expect(result.message).toContain(approvedRef);
  });

  test("rejects substituted bytes of identical length", () => {
    expect("malicious-bytes".length).toBe("installer-bytes".length);
    const tampered = verify(createBundle({ installerBytes: "malicious-bytes" }));
    expect(tampered.ok).toBe(false);
    expect(tampered.message).toContain("hash does not match the manifest");
  });

  test("rejects a manifest that omits or duplicates the published artifacts", () => {
    const omitted = verify(createBundle({ manifest: { artifacts: [] } }));
    expect(omitted.ok).toBe(false);
    expect(omitted.message).toContain("exactly one installer artifact");
  });

  test("rejects candidates built from another commit or a dirty tree", () => {
    expect(verify(createBundle({ manifest: { sourceSha: "b".repeat(40) } })).message)
      .toContain("SHA does not match the approved source SHA");
    expect(verify(createBundle({ manifest: { dirty: true } })).message).toContain("dirty source tree");
    expect(verify(createBundle({ manifest: { sourceRef: "v0.0.1-rc.9" } })).message)
      .toContain("source ref does not match the approved candidate");
  });

  test("rejects a runtime lock from another source commit", () => {
    const fixture = createBundle();
    const lock = JSON.parse(readFileSync(fixture.runtimeLockPath, "utf8")) as {
      sourceCommit: string; archive: { fileName: string };
    };
    lock.sourceCommit = "b".repeat(40);
    lock.archive.fileName = `scraply-agent-0.1.0-windows-x64-${"b".repeat(12)}.zip`;
    writeFileSync(fixture.runtimeLockPath, JSON.stringify(lock));
    expect(verify(fixture).message).toContain("approved Scraply commit");
  });

  test("requires the bundled lock and its exact accepted bytes", () => {
    const fixture = createBundle();
    writeFileSync(fixture.runtimeLockPath, `${readFileSync(fixture.runtimeLockPath, "utf8")}\n`);
    expect(verify(fixture).message).toContain("runtime lock file does not match");
    rmSync(fixture.runtimeLockPath);
    expect(verify(fixture).ok).toBe(false);
  });

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
  });

  test("rejects stale checksums and unsigned bytes outside the private policy", () => {
    expect(verify(createBundle({ checksums: `${hash("stale")}  ${installerName}\n` })).message)
      .toContain("SHA256SUMS.txt does not match");
    expect(verify(createBundle(), []).message).toContain("requires validly signed executables");
  });
});
