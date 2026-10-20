import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import extractZip from "extract-zip";
import { version } from "../package.json";
import { cliArchiveFilename, verifyCliArchive } from "./verify-cli-package";

export const cliTestSuites = [
  "./test/unit/cli", "./test/integration/cli",
  "./test/integration/cli-host.test.ts", "./test/integration/owner.test.ts",
  "./test/integration/desktop-owner.test.ts", "./test/integration/app-service.test.ts",
  "./test/integration/cli-service.test.ts", "./test/integration/backend-request.test.ts",
  "./test/unit/cli-packaging.test.ts", "./test/unit/promoted-assets.test.ts",
];

export function parseCliTestArguments(args: readonly string[], root: string) {
  const remaining = args[0] === "--" ? args.slice(1) : [...args];
  let artifact: string | null = null;
  if (remaining[0] === "--artifact") {
    remaining.shift();
    artifact = remaining[0] && !remaining[0].startsWith("-")
      ? resolve(root, remaining.shift()!) : join(root, "release-cli", cliArchiveFilename(version));
  }
  if (remaining.includes("--artifact")) throw new Error("Usage: bun run test:cli -- [--artifact [zip]] [-- test flags]");
  if (remaining[0] === "--") remaining.shift();
  return { artifact, testArgs: remaining };
}

/** Artifact mode always verifies its own snapshot and passes that executable to
 * the real CLI process fixtures. Source mode explicitly removes inherited selection. */
export async function runCliTests(args: readonly string[], options: {
  root?: string;
  env?: NodeJS.ProcessEnv;
  verifyArtifact?: typeof verifyCliArchive;
  executeTests?: (command: string[], env: NodeJS.ProcessEnv) => Promise<number>;
} = {}): Promise<number> {
  const root = resolve(options.root ?? process.cwd());
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), EXA_API_KEY: "", PERPLEXITY_API_KEY: "", SCRAPLY_DEV_SHARED_CREDENTIALS: "0" };
  delete env.SCRAPLY_TEST_CLI_EXECUTABLE;
  delete env.ELECTRON_RUN_AS_NODE;
  const parsed = parseCliTestArguments(args, root);
  if (env.SCRAPLY_RELEASE_STRICT === "1" && !parsed.artifact) {
    throw new Error("Strict release CLI tests require the compiled artifact. Run bun run test:cli -- --artifact.");
  }
  if (parsed.artifact && !existsSync(parsed.artifact)) throw new Error("CLI test artifact is missing. Run bun run package:cli first or name an existing zip.");
  mkdirSync(join(root, "build"), { recursive: true });
  const temporary = mkdtempSync(join(root, "build", ".cli-tests-"));
  env.SCRAPLY_DATA_DIR = join(temporary, "profile");
  env.SCRAPLY_DEV_DATA_DIR = join(temporary, "desktop-profile");
  try {
    if (parsed.artifact) {
      const snapshot = join(temporary, "candidate.zip");
      copyFileSync(parsed.artifact, snapshot);
      const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root, stdout: "pipe", stderr: "pipe" });
      const sha = new TextDecoder().decode(revision.stdout).trim();
      if (revision.exitCode !== 0 || !/^[a-f0-9]{40}$/.test(sha)) throw new Error("Could not establish the CLI test artifact source revision.");
      await (options.verifyArtifact ?? verifyCliArchive)(snapshot, {
        root, expectedSourceSha: sha,
        allowUnsigned: env.SCRAPLY_ALLOW_UNSIGNED === "1" || env.SCRAPLY_RELEASE_STRICT !== "1",
      });
      const extracted = join(temporary, "package");
      // This is the same private snapshot that passed the exact archive verifier.
      await extractZip(snapshot, { dir: extracted });
      const executable = join(extracted, "scraply.exe");
      if (!isAbsolute(executable) || !existsSync(executable)) throw new Error("Verified CLI test artifact has no executable.");
      env.SCRAPLY_TEST_CLI_EXECUTABLE = executable;
      console.log("Running CLI tests against the verified release executable.");
    } else {
      console.log("Running CLI tests against source.");
    }
    const command = [process.execPath, "--no-env-file", "test", "--timeout", "30000", ...cliTestSuites, ...parsed.testArgs];
    if (options.executeTests) return await options.executeTests(command, env);
    const child = Bun.spawn(command, { cwd: root, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    return await child.exited;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

if (import.meta.main) process.exitCode = await runCliTests(process.argv.slice(2));
