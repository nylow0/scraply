import { relativeRuntimePath, stageRuntimePackage } from "./runtime-package";

const staged = await stageRuntimePackage();
console.log(
  `Prepared ${staged.versionOutput} from ${staged.lock.sourceCommit} at ${relativeRuntimePath(staged.executablePath)}.`,
);
