import { resolve } from "node:path";

/** Source runs always use a checkout-local profile unless the command names one. */
export function cliDevLaunch(args: readonly string[], root: string, env: NodeJS.ProcessEnv = process.env) {
  const forwarded = args[0] === "--" ? args.slice(1) : [...args];
  const explicitProfile = forwarded.some((arg) => arg === "--data-dir" || arg.startsWith("--data-dir="));
  const dataDir = resolve(root, ".scraply", "cli-dev");
  return {
    args: explicitProfile ? forwarded : ["--data-dir", dataDir, ...forwarded],
    env: {
      ...env,
      // `bun run` may already have loaded .env before this wrapper started.
      EXA_API_KEY: "",
      PERPLEXITY_API_KEY: "",
      SCRAPLY_DATA_DIR: dataDir,
      SCRAPLY_AGENT_PATH: resolve(root, "build/runtime/scraply-agent.exe"),
      SCRAPLY_AGENT_LOCK_PATH: resolve(root, "build/runtime/scraply-agent.lock.json"),
    },
  };
}

if (import.meta.main) {
  const launch = cliDevLaunch(process.argv.slice(2), process.cwd());
  const child = Bun.spawn([process.execPath, "--no-env-file", "run", "src/cli/main.ts", ...launch.args], {
    env: launch.env, stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  process.exitCode = await child.exited;
}
