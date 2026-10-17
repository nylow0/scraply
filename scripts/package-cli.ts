import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { runtimeLockRelativePath, runtimeStageRelativePath, verifyStagedRuntime } from "./runtime-package";
import { cliArchiveFilename, cliPackageFiles, cliPromptNames, verifyCliArchive, verifyCliDirectory } from "./verify-cli-package";

function git(root: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error("Could not check the CLI source revision.");
  return new TextDecoder().decode(result.stdout).trim();
}

/** Shared by packaging and synthetic archive tests; never scans outside the allowlist. */
export function createCliArchive(stage: string, archive: string, files: readonly string[]): void {
  const zip = Bun.spawnSync(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::Open($env:SCRAPLY_CLI_ARCHIVE, [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($name in ($env:SCRAPLY_CLI_FILES | ConvertFrom-Json)) {
    $entry = $archive.CreateEntry($name, [IO.Compression.CompressionLevel]::Optimal)
    $entry.LastWriteTime = [DateTimeOffset]::new(2000, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
    $source = [IO.File]::OpenRead((Join-Path $env:SCRAPLY_CLI_STAGE $name))
    try {
      $destination = $entry.Open()
      try { $source.CopyTo($destination) } finally { $destination.Dispose() }
    } finally { $source.Dispose() }
  }
} finally { $archive.Dispose() }
`], { cwd: dirname(stage), env: { ...process.env, PSModulePath: "", SCRAPLY_CLI_ARCHIVE: archive, SCRAPLY_CLI_STAGE: stage, SCRAPLY_CLI_FILES: JSON.stringify(files), EXA_API_KEY: "", PERPLEXITY_API_KEY: "" },
    stdout: "pipe", stderr: "pipe", windowsHide: true });
  if (zip.exitCode !== 0) {
    let detail = new TextDecoder().decode(zip.stderr).trim().split(/\r?\n/)[0] ?? "";
    for (const path of [stage, archive, process.cwd(), process.env.USERPROFILE ?? ""].filter(Boolean)) {
      detail = detail.replaceAll(path, "<local path>");
    }
    throw new Error(`Could not create the CLI release archive.${detail ? ` ${detail}` : ""}`);
  }
}

/** Uses the prepared worker; packaging never downloads or substitutes another runtime. */
export async function packageCli(root = process.cwd()) {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("CLI packaging requires Windows x64.");
  root = resolve(root);
  const version = z.object({ version: z.string() }).parse(JSON.parse(readFileSync(join(root, "package.json"), "utf8"))).version;
  const filename = cliArchiveFilename(version);
  const sourceSha = git(root, ["rev-parse", "HEAD"]);
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error("Invalid CLI source revision.");
  const strict = process.env.SCRAPLY_RELEASE_STRICT === "1";
  if (strict && git(root, ["status", "--porcelain", "--untracked-files=normal"])) throw new Error("Release CLI packaging requires a clean worktree.");
  if (!existsSync(join(root, runtimeLockRelativePath)) || !existsSync(join(root, runtimeStageRelativePath, "scraply-agent.lock.json"))) {
    throw new Error("Prepared CLI runtime is missing. Run bun run prepare:runtime.");
  }
  const runtime = verifyStagedRuntime(join(root, runtimeStageRelativePath), join(root, runtimeLockRelativePath));
  if (runtime.lock.sourceRepository !== "https://github.com/nylow0/scraply" || runtime.lock.sourceCommit !== sourceSha) {
    throw new Error("Prepared CLI runtime does not match HEAD. Run bun run prepare:runtime.");
  }
  if (git(root, ["status", "--porcelain", "--", "runtime", "scripts/build-runtime.ps1", "scripts/runtime-package.ts"])) {
    throw new Error("Native source or runtime build configuration changed since preparation. Commit and prepare the runtime again.");
  }
  if (git(root, ["-C", "runtime/vendor/openai-codex", "rev-parse", "HEAD"]) !== runtime.lock.upstreamCommit
    || git(root, ["-C", "runtime/vendor/openai-codex", "status", "--porcelain"])) {
    throw new Error("Prepared CLI runtime does not match the clean pinned upstream dependency.");
  }
  if (!existsSync(join(root, "src/cli/main.ts"))) throw new Error("CLI entry src/cli/main.ts is missing.");
  const actualPrompts = readdirSync(join(root, "prompts")).sort();
  if (JSON.stringify(actualPrompts) !== JSON.stringify(cliPromptNames)) throw new Error("Source prompts contain missing or superseded files.");
  const build = join(root, "build");
  mkdirSync(build, { recursive: true });
  const temporary = mkdtempSync(join(build, ".cli-package-"));
  const stage = join(temporary, "stage");
  mkdirSync(stage);
  const options = { root, expectedSourceSha: sourceSha, allowUnsigned: process.env.SCRAPLY_ALLOW_UNSIGNED === "1" || !strict };
  try {
    const compile = Bun.spawn([process.execPath, "--no-env-file", "build", "--compile", "--target=bun-windows-x64", "--minify",
      "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", "--no-compile-autoload-tsconfig", "--no-compile-autoload-package-json",
      "--windows-title=Scraply", `--windows-version=${version}`, "--windows-description=Scraply CLI",
      "--outfile", join(stage, "scraply.exe"), "src/cli/main.ts"], {
      cwd: root, env: { ...process.env, EXA_API_KEY: "", PERPLEXITY_API_KEY: "" }, stdout: "inherit", stderr: "inherit",
    });
    if (await compile.exited !== 0) throw new Error("Standalone CLI compilation failed.");
    const files = cliPackageFiles(runtime.lock);
    for (const name of files.filter((name) => name !== "scraply.exe")) {
      const destination = join(stage, name);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(name.startsWith("runtime/") ? join(root, "build", name) : join(root, name), destination);
    }
    verifyCliDirectory(stage, options);
    const archive = join(temporary, filename);
    // Explicit entries keep archives flat at their root and exclude timestamps or
    // local metadata files that recursive wildcard packaging might accidentally add.
    createCliArchive(stage, archive, files);
    await verifyCliArchive(archive, options);
    if (git(root, ["rev-parse", "HEAD"]) !== sourceSha) throw new Error("HEAD changed while packaging the CLI. Build again.");
    const release = join(root, "release-cli");
    mkdirSync(release, { recursive: true });
    const destination = join(release, filename);
    rmSync(destination, { force: true });
    renameSync(archive, destination);
    console.log(`Packaged release-cli/${filename}.`);
    return destination;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

if (import.meta.main) await packageCli();
