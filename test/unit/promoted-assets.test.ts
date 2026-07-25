import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import packageMetadata from "../../package.json";

const version = packageMetadata.version;
const installerName = `Scraply Setup ${version}.exe`;
const portableName = `Scraply ${version}.exe`;
const approvedSha = "a".repeat(40);
const approvedRef = `stage-v${version}-rc.1`;
const bundles: string[] = [];

interface BundleOverrides {
  manifest?: Record<string, unknown>;
  installerBytes?: string;
  checksums?: string;
}

function hash(value: string): string {
  return createHash("sha256").update(Buffer.from(value)).digest("hex");
}

function createBundle(overrides: BundleOverrides = {}): string {
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
  const manifest = {
    schemaVersion: 1,
    appVersion: version,
    sourceSha: approvedSha,
    sourceRef: approvedRef,
    dirty: false,
    signed: false,
    signingPolicy: "private-unsigned",
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
  return dir;
}

function verify(dir: string, args: string[] = ["--allow-unsigned"]): { ok: boolean; message: string } {
  const result = Bun.spawnSync(
    ["bun", "scripts/verify-promoted-assets.ts", dir, approvedSha, approvedRef, ...args],
    { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
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
    expect(verify(createBundle({ manifest: { sourceRef: "stage-v0.0.1-rc.9" } })).message)
      .toContain("source ref does not match the approved candidate");
  });

  test("rejects stale checksums and unsigned bytes outside the private policy", () => {
    expect(verify(createBundle({ checksums: `${hash("stale")}  ${installerName}\n` })).message)
      .toContain("SHA256SUMS.txt does not match");
    expect(verify(createBundle(), []).message).toContain("requires validly signed executables");
  });
});
