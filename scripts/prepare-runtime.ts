import { relativeRuntimePath, stageRuntimePackage } from "./runtime-package";

const build = Bun.spawn(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/build-runtime.ps1"], {
  stdout: "inherit", stderr: "inherit", stdin: "inherit",
});
if (await build.exited !== 0) throw new Error("Native runtime source build failed");
const staged = await stageRuntimePackage();
console.log(
  `Prepared ${staged.versionOutput} from ${staged.lock.sourceCommit} at ${relativeRuntimePath(staged.executablePath)}.`,
);
